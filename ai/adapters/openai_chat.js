'use strict';
// OpenAI-compatible Chat Completions (OpenAI, vLLM, llama.cpp server, LM Studio, LocalAI, Ollama /v1 ...)
// plus the Ollama native /api/chat variant (ep.ollamaNative: NDJSON stream, options.num_ctx).
// Adapter interface: see ai/adapters/index.js.

const C = require('./common.js');
const { createSseParser } = require('../sse.js');
const { createNdjsonParser } = require('../ndjson.js');
const ollama = require('./ollama.js');

const FORMAT = 'openai-chat';
const PROBE_TOOL = { name: 'get_time', description: 'Returns the current time.', parameters: { type: 'object', properties: {}, additionalProperties: false } };

function authHeaders(ep) { return ep && ep.apiKey ? { authorization: 'Bearer ' + ep.apiKey } : {}; }
function maxOut(ep, opts) { return C.num(opts && opts.maxOutputTokens) || C.num(ep && ep.maxOutputTokens); }

function chatTools(tools) {
    return tools.map(function (t) { return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }; });
}

function buildMessages(transcript, native) {
    const out = [];
    if (transcript && transcript.system) out.push({ role: 'system', content: String(transcript.system) });
    const items = transcript && Array.isArray(transcript.items) ? transcript.items : [];
    for (const it of items) {
        if (!it) continue;
        if (it.role === 'user') out.push({ role: 'user', content: String(it.text == null ? '' : it.text) });
        else if (it.role === 'assistant') {
            const calls = Array.isArray(it.calls) ? it.calls : [];
            const m = { role: 'assistant', content: it.text ? String(it.text) : (calls.length && !native ? null : '') };
            if (calls.length) {
                m.tool_calls = calls.map(function (c) {
                    return native
                        ? { function: { name: c.name, arguments: C.argsToObject(c) } }
                        : { id: c.id, type: 'function', function: { name: c.name, arguments: C.argsToText(c) } };
                });
            }
            out.push(m);
        } else if (it.role === 'tool') {
            for (const r of (Array.isArray(it.results) ? it.results : [])) {
                out.push(native ? { role: 'tool', tool_name: r.name, content: C.resultText(r) } : { role: 'tool', tool_call_id: r.callId, content: C.resultText(r) });
            }
        }
    }
    return out;
}

function buildRequest(ep, transcript, tools, opts) {
    opts = opts || {};
    tools = Array.isArray(tools) ? tools : [];
    const stream = opts.stream !== false;
    const mt = maxOut(ep, opts);
    if (ep && ep.ollamaNative) {
        const url = C.ollamaRoot(ep.baseUrl) + '/api/chat';
        const body = { model: ep.model, messages: buildMessages(transcript, true), stream: stream };
        // Ollama has no tool_choice: 'none' is expressed by not offering the tools.
        if (tools.length && opts.toolChoice !== 'none') body.tools = chatTools(tools);
        const options = {};
        if (C.num(ep.numCtx)) options.num_ctx = C.num(ep.numCtx);
        if (mt) options.num_predict = mt;
        if (Object.keys(options).length) body.options = options;
        return { url: url, path: C.pathOf(url), headers: Object.assign({ 'content-type': 'application/json', accept: 'application/x-ndjson' }, authHeaders(ep)), body: body };
    }
    const url = C.joinUrl(ep.baseUrl, '/chat/completions');
    const body = { model: ep.model, messages: buildMessages(transcript, false), stream: stream };
    const quirks = C.isObj(ep.quirks) ? ep.quirks : {};
    if (stream && !quirks.noStreamOptions) body.stream_options = { include_usage: true };
    if (mt) body[quirks.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = mt;
    if (tools.length) {
        body.tools = chatTools(tools);
        if (opts.toolChoice === 'none') body.tool_choice = 'none';
    }
    return { url: url, path: C.pathOf(url), headers: Object.assign({ 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' }, authHeaders(ep)), body: body };
}

function mapFinish(reason, hasCalls) {
    if (reason === 'tool_calls' || reason === 'function_call') return 'tools';
    if (reason === 'length') return 'length';
    if (reason === 'content_filter') return 'refusal';
    return hasCalls ? 'tools' : 'end';
}

function errEvent(j) {
    const e = j.error;
    const msg = typeof e === 'string' ? e : (C.isObj(e) && e.message) || 'The server reported an error';
    const type = C.isObj(e) ? (e.type || e.code) : null;
    return { t: 'error', message: String(msg).slice(0, 300), code: C.streamErrorCode(type, msg) };
}

function sseParser(emit) {
    const calls = new Map();            // key -> { id, name, args }
    let lastKey = null, finish = null, usage = null, refusal = false, finalized = false, seen = false;

    function finalize() {
        if (finalized) return;
        finalized = true;
        if (!seen) return;                 // nothing parseable arrived: no stop event (llm.js reports badResponse)
        let n = 0;
        for (const c of calls.values()) {
            if (!c.name) { emit({ t: 'malformed', message: 'tool call without a name' }); continue; }
            emit({ t: 'call', id: c.id || C.synthId('call_'), name: c.name, argsText: c.args || '{}' });
            n++;
        }
        if (usage) emit({ t: 'usage', in: C.num(usage.prompt_tokens) || 0, out: C.num(usage.completion_tokens) || 0 });
        emit({ t: 'stop', reason: refusal && !finish ? 'refusal' : mapFinish(finish, n > 0) });
    }

    function addCall(tc) {
        if (!C.isObj(tc)) return;
        let key;
        if (Number.isInteger(tc.index)) key = 'i' + tc.index;
        else if (tc.id) { key = null; for (const [k, v] of calls) if (v.id === tc.id) key = k; if (!key) key = 'd' + tc.id; }
        else key = lastKey || 'i0';
        let c = calls.get(key);
        if (!c) { c = { id: null, name: '', args: '' }; calls.set(key, c); }
        lastKey = key;
        if (tc.id && !c.id) c.id = String(tc.id);
        const fn = C.isObj(tc.function) ? tc.function : {};
        if (typeof fn.name === 'string' && fn.name && !c.name) c.name = fn.name;
        if (typeof fn.arguments === 'string') c.args += fn.arguments;
        else if (C.isObj(fn.arguments)) c.args = JSON.stringify(fn.arguments);
    }

    const sse = createSseParser(function (ev) {
        if (finalized) return;
        if (ev.event === 'done') { seen = true; finalize(); return; }
        const j = C.safeJson(ev.data);
        if (!C.isObj(j)) { emit({ t: 'malformed' }); return; }
        seen = true;
        if (j.error) { emit(errEvent(j)); return; }
        if (C.isObj(j.usage)) usage = j.usage;
        const ch = Array.isArray(j.choices) ? j.choices[0] : null;
        if (!C.isObj(ch)) return;
        const d = C.isObj(ch.delta) ? ch.delta : C.isObj(ch.message) ? ch.message : {};
        if (typeof d.content === 'string' && d.content) emit({ t: 'text', d: d.content });
        if (typeof d.refusal === 'string' && d.refusal) { refusal = true; emit({ t: 'text', d: d.refusal }); }
        // reasoning_content / reasoning are dropped on purpose
        if (Array.isArray(d.tool_calls)) d.tool_calls.forEach(addCall);
        else if (C.isObj(d.function_call)) addCall({ index: 0, function: d.function_call });
        if (ch.finish_reason) finish = ch.finish_reason;
    });
    return { push: function (t) { sse.push(t); }, end: function () { sse.end(); finalize(); } };
}

function ndjsonParser(emit) {
    const calls = [];
    let finalized = false, doneReason = null, usage = null, seen = false;
    function finalize() {
        if (finalized) return;
        finalized = true;
        if (!seen) return;
        for (const c of calls) emit(c);
        if (usage) emit({ t: 'usage', in: usage.in, out: usage.out });
        emit({ t: 'stop', reason: doneReason === 'length' ? 'length' : calls.length ? 'tools' : 'end' });
    }
    const nd = createNdjsonParser(function (o) {
        if (finalized) return;
        if (!C.isObj(o)) { emit({ t: 'malformed' }); return; }
        seen = true;
        if (o.error) { emit(errEvent(o)); return; }
        const m = C.isObj(o.message) ? o.message : {};
        if (typeof m.content === 'string' && m.content) emit({ t: 'text', d: m.content });
        if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) {
            const fn = C.isObj(tc) && C.isObj(tc.function) ? tc.function : null;
            if (!fn || typeof fn.name !== 'string' || !fn.name) { emit({ t: 'malformed', message: 'tool call without a name' }); continue; }
            const a = fn.arguments;
            calls.push({ t: 'call', id: (tc.id && String(tc.id)) || C.synthId('call_'), name: fn.name, argsText: typeof a === 'string' ? a : JSON.stringify(C.isObj(a) ? a : {}) });
        }
        if (o.done) {
            doneReason = o.done_reason || null;
            if (o.prompt_eval_count != null || o.eval_count != null) usage = { in: C.num(o.prompt_eval_count) || 0, out: C.num(o.eval_count) || 0 };
            finalize();
        }
    }, function () { emit({ t: 'malformed' }); });
    return { push: function (t) { nd.push(t); }, end: function () { nd.end(); finalize(); } };
}

function createParser(emit, ep) { return ep && ep.ollamaNative ? ndjsonParser(emit) : sseParser(emit); }

// A server that ignored stream:true and answered with one JSON document.
function parseNonStream(json, emit, ep) {
    if (!C.isObj(json)) { emit({ t: 'malformed' }); return; }
    if (json.error) { emit(errEvent(json)); return; }
    if (ep && ep.ollamaNative || (C.isObj(json.message) && !json.choices)) {
        const p = ndjsonParser(emit); p.push(JSON.stringify(Object.assign({}, json, { done: true })) + '\n'); p.end(); return;
    }
    const ch = Array.isArray(json.choices) ? json.choices[0] : null;
    const m = C.isObj(ch) && C.isObj(ch.message) ? ch.message : {};
    if (typeof m.content === 'string' && m.content) emit({ t: 'text', d: m.content });
    if (typeof m.refusal === 'string' && m.refusal) emit({ t: 'text', d: m.refusal });
    let n = 0;
    for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
        const fn = C.isObj(tc) && C.isObj(tc.function) ? tc.function : null;
        if (!fn || !fn.name) { emit({ t: 'malformed' }); continue; }
        emit({ t: 'call', id: (tc.id && String(tc.id)) || C.synthId('call_'), name: fn.name, argsText: typeof fn.arguments === 'string' ? (fn.arguments || '{}') : JSON.stringify(C.isObj(fn.arguments) ? fn.arguments : {}) });
        n++;
    }
    if (C.isObj(json.usage)) emit({ t: 'usage', in: C.num(json.usage.prompt_tokens) || 0, out: C.num(json.usage.completion_tokens) || 0 });
    emit({ t: 'stop', reason: m.refusal && !(ch && ch.finish_reason) ? 'refusal' : mapFinish(ch && ch.finish_reason, n > 0) });
}

function classifyError(status, headers, bodyText) { return C.classifyHttpError(status, headers, bodyText); }

async function listModels(ep, deps) {
    const r = await C.getJson(deps, { url: C.joinUrl(ep.baseUrl, '/models'), method: 'GET', headers: authHeaders(ep) }, classifyError);
    const data = C.isObj(r.json) && Array.isArray(r.json.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
    return data.filter(function (m) { return C.isObj(m) && typeof m.id === 'string'; }).map(function (m) {
        const o = { id: m.id };
        const meta = C.isObj(m.meta) ? m.meta : null; // llama.cpp-style servers: meta.n_ctx (runtime) or meta.n_ctx_train (llama-server)
        const ctx = C.num(m.max_model_len) || C.num(m.context_length) || C.num(m.max_context_length) || (C.isObj(m.top_provider) && C.num(m.top_provider.context_length)) || (meta && (C.num(meta.n_ctx) || C.num(meta.n_ctx_train)));
        if (ctx) o.ctx = ctx;
        if (m.owned_by) o.owner = String(m.owned_by);
        return o;
    });
}

async function probe(ep, deps) {
    const out = { ok: false, tools: null, ctx: null, server: null, detail: '' };
    const notes = [];
    try {
        const ver = await ollama.isOllama(ep, deps);
        if (ver) {
            out.server = 'ollama ' + ver;
            try {
                const s = await ollama.show(ep, deps);
                out.tools = s.tools; out.ctx = s.ctx;
                out.ollama = { version: ver, capabilities: s.capabilities, modelCtx: s.ctx, numCtx: s.numCtx };
            } catch (e) {
                out.code = e.code === 'badRequest' || e.code === 'model' ? 'model' : e.code;
                out.detail = out.code === 'model' ? 'Model "' + ep.model + '" was not found on this Ollama server' : 'Model details unavailable: ' + e.message;
                return out;
            }
            try { await listModels(ep, deps); }
            catch (e) { if (e.code === 'badRequest') notes.push('the OpenAI-compatible API was not found; the address should end in /v1'); }
            out.ok = true;
            notes.unshift('Ollama ' + ver + (out.tools === true ? ', tool calling supported' : out.tools === false ? ', no tool calling' : '') + (out.ctx ? ', model context ' + out.ctx + ' tokens' : ''));
            if (!C.num(ep.numCtx)) notes.push('Ollama uses its own default context unless a context size is set for this endpoint');
            out.detail = notes.join('; ');
            return out;
        }

        let models = null;
        try { models = await listModels(ep, deps); }
        catch (e) { if (e.code === 'auth') { out.code = 'auth'; out.detail = 'Authentication failed: ' + e.message; return out; } notes.push('model list unavailable'); }
        if (models) {
            const m = models.find(function (x) { return x.id === ep.model; });
            if (m && m.ctx) out.ctx = m.ctx;
            if (m && m.owner === 'vllm') out.server = 'vllm';
            if (!m && models.length) notes.push('model "' + ep.model + '" is not in the server\'s model list');
        }
        try {
            const p = await C.getJson(deps, { url: C.ollamaRoot(ep.baseUrl) + '/props', method: 'GET', headers: authHeaders(ep), totalTimeoutMs: 8000 });
            const g = C.isObj(p.json) && C.isObj(p.json.default_generation_settings) ? p.json.default_generation_settings : null;
            const nctx = C.num(g && g.n_ctx) || C.num(p.json && p.json.n_ctx);
            if (nctx) out.ctx = out.ctx || nctx;
            // Other servers answer /props in the same shape; only llama-server's build_info ("b<build>-<commit>") names it.
            const bi = C.isObj(p.json) && typeof p.json.build_info === 'string' ? p.json.build_info : '';
            if (/^b\d+-[0-9a-f]+/i.test(bi)) out.server = out.server || 'llama.cpp';
        } catch (e) { }

        const req = buildRequest(Object.assign({}, ep, { ollamaNative: false, maxOutputTokens: 16 }), { system: '', items: [{ role: 'user', text: 'Reply with OK.' }] }, [PROBE_TOOL], { stream: false, toolChoice: 'auto' });
        const res = await C.call(deps, { url: req.url, method: 'POST', headers: req.headers, body: req.body, totalTimeoutMs: 90000, idleTimeoutMs: 90000 });
        if (res.status < 400) { out.ok = true; out.tools = true; notes.unshift('chat request with a tool definition accepted'); }
        else {
            const c = classifyError(res.status, res.headers, res.bodyText);
            if (c.toolsUnsupported) { out.ok = true; out.tools = false; notes.unshift('the server or model does not support tool calling'); }
            else { out.code = c.code; notes.unshift(c.message); }
        }
        if (out.ctx) notes.push('context ' + out.ctx + ' tokens');
        out.detail = notes.join('; ');
        return out;
    } catch (e) {
        out.code = e.code || 'network';
        out.detail = e.message || 'Connection failed';
        return out;
    }
}

// A 400 that rejects a request field some servers/models do not accept -> the quirk that fixes it, or null.
//   useMaxCompletionTokens: OpenAI reasoning models want max_completion_tokens instead of max_tokens
//   noStreamOptions:        some OpenAI-compatible servers reject stream_options
// Only fields that were actually sent qualify, so a quirk can never be learned twice for one request shape.
const RE_REJECT = '(?:unsupported|unknown|unrecognized|unexpected|extra|not (?:supported|allowed|permitted)|invalid (?:parameter|field|argument))';
const RE_MAXTOK = new RegExp(RE_REJECT + "[^\\n.]{0,60}\\bmax_tokens\\b|\\bmax_tokens\\b[^\\n.]{0,60}" + RE_REJECT + "|\\bmax_tokens\\b[\\s\\S]{0,200}\\bmax_completion_tokens\\b", 'i');
function detectQuirk(status, bodyText, sentBody, ep) {
    if (status !== 400 || !C.isObj(sentBody) || (ep && ep.ollamaNative)) return null;
    const em = C.errorMessage(bodyText);
    const text = (em.message || '') + '\n' + String(bodyText || '').slice(0, 65536);
    if ('max_tokens' in sentBody && RE_MAXTOK.test(text)) return 'useMaxCompletionTokens';
    if ('stream_options' in sentBody && /\bstream_options\b/.test(text)) return 'noStreamOptions';
    return null;
}

module.exports = { format: FORMAT, buildRequest, createParser, parseNonStream, classifyError, detectQuirk, listModels, probe, _buildMessages: buildMessages };
