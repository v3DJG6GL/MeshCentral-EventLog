'use strict';
// Helpers shared by the API format adapters.

let idCounter = 0;
function synthId(prefix) { idCounter = (idCounter + 1) % 1e9; return (prefix || 'call_') + idCounter; }

function trimSlash(s) { return String(s == null ? '' : s).trim().replace(/\/+$/, ''); }
function joinUrl(base, path) { return trimSlash(base) + (path.charAt(0) === '/' ? path : '/' + path); }
// Ollama's native API lives at the server root; the OpenAI-compatible one under /v1.
function ollamaRoot(base) { return trimSlash(base).replace(/\/v1$/i, ''); }

function pathOf(url) { try { const u = new URL(url); return u.pathname + u.search; } catch (e) { return url; } }

function safeJson(text) { try { return JSON.parse(text); } catch (e) { return undefined; } }
function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }

// Parse tool arguments: plain object or null.
function parseArgs(argsText) {
    if (argsText == null || argsText === '') return {};
    const v = safeJson(argsText);
    return isObj(v) ? v : null;
}
function argsToText(call) {
    if (call.argsText != null && call.argsText !== '') return String(call.argsText);
    return JSON.stringify(isObj(call.args) ? call.args : {});
}
function argsToObject(call) {
    if (isObj(call.args)) return call.args;
    const v = parseArgs(call.argsText);
    return v || {};
}
function resultText(r) {
    const c = r.content == null ? '' : String(r.content);
    return r.isError && !/^error\b/i.test(c) ? 'Error: ' + c : c;
}
function rawFor(item, format) {
    const raw = item && item.raw;
    return raw && raw.format === format && Array.isArray(raw.items) && raw.items.length ? raw.items : null;
}

// Retry-After: seconds or HTTP date; retry-after-ms (OpenAI) wins.
function retryAfterMs(headers) {
    if (!headers) return null;
    const ms = headers['retry-after-ms'];
    if (ms != null && /^\d+(\.\d+)?$/.test(String(ms).trim())) return Math.round(Number(ms));
    const ra = headers['retry-after'];
    if (ra == null) return null;
    const s = String(ra).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
    const t = Date.parse(s);
    return isNaN(t) ? null : Math.max(0, t - Date.now());
}

function errorMessage(bodyText) {
    const j = safeJson(bodyText);
    let m = null, type = null, code = null;
    if (isObj(j)) {
        const e = j.error;
        if (typeof e === 'string') m = e;
        else if (isObj(e)) { m = e.message || null; type = e.type || null; code = e.code || null; }
        if (!m && typeof j.message === 'string') m = j.message;
        if (!m && typeof j.detail === 'string') m = j.detail;
        if (!type && typeof j.type === 'string' && j.type !== 'error') type = j.type;
    } else if (typeof bodyText === 'string' && bodyText && !/^\s*</.test(bodyText)) m = bodyText;
    if (m) m = String(m).replace(/\s+/g, ' ').trim().slice(0, 300);
    return { message: m, type: type, code: code == null ? null : String(code) };
}

const RE_TOOLS = /does not support tools|tools? (?:is |are )?not supported|tool[_ ]?choice[^.]*(?:not supported|unsupported)|"auto" tool choice requires|tool use is not supported|unsupported (?:parameter|field|argument)s?:? *['"]?tools?\b|function calling is not (?:supported|enabled)/i;
const RE_CTX = /context[_ ]length|context window|maximum context|context size|prompt is too long|too many tokens|exceeds? the (?:available )?context|n_ctx|input is too long|maximum input length|reduce the length/i;

// Generic HTTP error classification; adapters refine with provider error types.
function classifyHttpError(status, headers, bodyText) {
    const em = errorMessage(bodyText);
    const text = (em.message || '') + '\n' + String(bodyText || '').slice(0, 65536);   // message un-escaped + raw body
    const toolsUnsupported = status >= 400 && status < 600 && RE_TOOLS.test(text);
    const contextFull = status === 413 || (status >= 400 && status < 500 && (em.code === 'context_length_exceeded' || RE_CTX.test(text)));
    const ra = retryAfterMs(headers);
    let code, retryable = false;
    if (status === 401 || status === 403) code = 'auth';
    else if (status === 404) code = /model/i.test(text) ? 'model' : 'badRequest';
    else if (status === 429) { code = 'rateLimit'; retryable = !/insufficient_quota|billing|quota exceeded|credit balance/i.test(text); }
    else if (status === 529 || status === 503) { code = 'overloaded'; retryable = true; }
    else if (status === 502 || status === 504) { code = 'server'; retryable = true; }
    else if (status >= 500) code = 'server';
    else if (status >= 400) code = 'badRequest';
    else code = 'badResponse';
    if (toolsUnsupported) { code = 'toolsUnsupported'; retryable = false; }
    else if (contextFull) { code = 'contextFull'; retryable = false; }
    let message = em.message;
    if (!message) message = code === 'badRequest' && status === 404 ? 'Not found (check the address and API path)' : 'HTTP ' + status;
    return { code: code, retryable: retryable, retryAfterMs: ra, toolsUnsupported: toolsUnsupported, contextFull: contextFull, message: message, status: status, providerType: em.type, providerCode: em.code };
}

// Map an in-stream provider error type/code to our codes.
function streamErrorCode(type, msg) {
    const t = String(type || '').toLowerCase();
    if (/overloaded/.test(t)) return 'overloaded';
    if (/rate_limit|ratelimit|rate-limit/.test(t)) return 'rateLimit';
    if (/context_length|context_window/.test(t) || RE_CTX.test(String(msg || ''))) return 'contextFull';
    if (/auth|permission/.test(t)) return 'auth';
    if (/invalid_request|bad_request/.test(t)) return 'badRequest';
    return 'server';
}

function mkErr(code, message, extra) {
    const e = new Error(message);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
}

// deps.request(opts) returns { promise } (ai/http.js request) or a promise; resolve to the http result.
async function call(deps, o) {
    if (!deps || typeof deps.request !== 'function') throw mkErr('network', 'No request function');
    const r = deps.request(Object.assign({ totalTimeoutMs: 20000, idleTimeoutMs: 20000 }, o));
    return await (r && r.promise ? r.promise : r);
}
// GET/POST expecting JSON; throws Error{code, status, message} classified with `classify` on HTTP errors.
async function getJson(deps, o, classify) {
    const res = await call(deps, o);
    if (res.status >= 400) {
        const c = (classify || classifyHttpError)(res.status, res.headers, res.bodyText);
        throw mkErr(c.code, c.message, { status: res.status, retryable: c.retryable, toolsUnsupported: c.toolsUnsupported, contextFull: c.contextFull });
    }
    const json = safeJson(res.bodyText);
    if (json === undefined) throw mkErr('badResponse', 'The server did not answer with JSON', { status: res.status });
    return { status: res.status, headers: res.headers, json: json };
}

function num(x) { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }

// ---- generation settings (ep.thinking / temperature / topP / topK / seed; null = the server's default) ----------
const THINK_LEVELS = ['off', 'low', 'medium', 'high'];
function genOf(ep) {
    ep = ep || {};
    const f = function (v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; };
    return {
        thinking: THINK_LEVELS.indexOf(ep.thinking) >= 0 ? ep.thinking : null,
        temperature: f(ep.temperature), topP: f(ep.topP), topK: f(ep.topK), seed: f(ep.seed)
    };
}
// OpenAI-style effort for a level: off -> 'none'
function effortOf(level) { return level === 'off' ? 'none' : level; }

// A 400 that names a generation setting the request carried -> { field, label, param, message } or null.
// sent: [{ field, label, param, names? }] for the settings actually in the request (param: the name in the request
// body; names: other words an error may use for it).
const RE_GEN_REJECT = /unsupported|unknown|unrecognized|unexpected|not (?:supported|allowed|permitted)|invalid|does not support|cannot be|must be|out of range|only (?:the )?default|extra (?:inputs?|fields?)/i;
function rejectedSetting(status, bodyText, sent) {
    if ((status !== 400 && status !== 422) || !Array.isArray(sent) || !sent.length) return null;
    const em = errorMessage(bodyText);
    const text = (em.message || '') + '\n' + String(bodyText || '').slice(0, 65536);
    if (!RE_GEN_REJECT.test(text)) return null;
    for (const s of sent) {
        for (const name of [s.param].concat(s.names || [])) {
            const re = new RegExp('(?:^|[^a-z_])' + name.replace(/[.]/g, '\\.') + '(?![a-z_])', 'i');
            if (re.test(text)) return { field: s.field, label: s.label, param: s.param, message: em.message || ('HTTP ' + status) };
        }
    }
    return null;
}
const GEN_LABELS = { thinking: 'Thinking', temperature: 'Temperature', topP: 'Top-p', topK: 'Top-k', seed: 'Seed' };

// Server defaults from a llama.cpp-style /props document (llama-server, Strata): default_generation_settings.params
// (older builds: the fields directly) -> { temperature, topP, topK, seed (-1 = random), maxTokens (-1 = until done) }
function propsDefaults(json) {
    const g = isObj(json) && isObj(json.default_generation_settings) ? json.default_generation_settings : null;
    if (!g) return null;
    const p = isObj(g.params) ? g.params : g;
    const fin = function (v) { const n = Number(v); return v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(n) ? n : null; };
    let seed = fin(p.seed);
    if (seed != null && (seed < 0 || seed >= 4294967295)) seed = -1;           // LLAMA_DEFAULT_SEED: a random seed per request
    let maxTokens = fin(p.n_predict != null ? p.n_predict : p.max_tokens);
    if (maxTokens != null && maxTokens < 0) maxTokens = -1;
    const out = { temperature: fin(p.temperature), topP: fin(p.top_p), topK: fin(p.top_k), seed: seed, maxTokens: maxTokens };
    return Object.keys(out).some(function (k) { return out[k] != null; }) ? out : null;
}
// The reasoning effort a /props document names as the default, or null (most servers do not expose it).
function propsEffort(json) {
    if (!isObj(json)) return null;
    const g = isObj(json.default_generation_settings) ? json.default_generation_settings : {};
    const p = isObj(g.params) ? g.params : {};
    const kw = isObj(p.chat_template_kwargs) ? p.chat_template_kwargs : isObj(json.chat_template_kwargs) ? json.chat_template_kwargs : {};
    for (const v of [p.reasoning_effort, g.reasoning_effort, json.reasoning_effort, kw.reasoning_effort]) {
        const s = typeof v === 'string' ? v.toLowerCase() : '';
        if (s === 'none' || s === 'minimal') return 'off';
        if (THINK_LEVELS.indexOf(s) >= 0) return s;
    }
    return null;
}

// Splits <think>…</think> at the start of a model's text off the answer: onText gets the answer, onThink(chars)
// how many reasoning characters went by (0 when the block opens). Only a block at the very start (after optional
// whitespace) counts, so an answer that talks about the tag later is left alone. Tags split across chunks work.
function thinkSplitter(onText, onThink) {
    const OPEN = '<think>', CLOSE = '</think>';
    let state = 'start', buf = '';
    function push(d) {
        if (typeof d !== 'string' || !d) return;
        if (state === 'text') { onText(d); return; }
        buf += d;
        for (;;) {
            if (state === 'start') {
                const t = buf.replace(/^\s+/, '');
                if (t === '' || (t.length < OPEN.length && OPEN.indexOf(t) === 0)) return;
                if (t.indexOf(OPEN) === 0) { state = 'think'; buf = t.slice(OPEN.length); onThink(0); continue; }
                state = 'text'; const out = buf; buf = ''; onText(out); return;
            }
            if (state === 'think') {
                const i = buf.indexOf(CLOSE);
                if (i >= 0) { if (i) onThink(i); buf = buf.slice(i + CLOSE.length); state = 'after'; continue; }
                let keep = 0;
                for (let k = Math.min(CLOSE.length - 1, buf.length); k > 0; k--) if (CLOSE.indexOf(buf.slice(-k)) === 0) { keep = k; break; }
                const n = buf.length - keep;
                if (n) onThink(n);
                buf = buf.slice(n);
                return;
            }
            // after </think>: the answer starts at its first non-blank character
            const t = buf.replace(/^\s+/, '');
            buf = '';
            if (t) { state = 'text'; onText(t); }
            return;
        }
    }
    function end() {
        if (state === 'start' && buf) onText(buf);
        else if (state === 'think' && buf) onThink(buf.length);
        buf = '';
    }
    return { push: push, end: end };
}

module.exports = {
    synthId, trimSlash, joinUrl, ollamaRoot, pathOf, safeJson, isObj, parseArgs, argsToText, argsToObject, resultText, rawFor,
    retryAfterMs, errorMessage, classifyHttpError, streamErrorCode, mkErr, call, getJson, num, RE_TOOLS, RE_CTX,
    THINK_LEVELS, GEN_LABELS, genOf, effortOf, rejectedSetting, propsDefaults, propsEffort, thinkSplitter
};
