'use strict';
// Anthropic Messages API (anthropic-version 2026-10-21).
// - temperature / top_p / top_k are never sent (400 on this API version), and thinking cannot be set: the
//   endpoint's generation settings are ignored for this format. Thinking blocks stream as {t:'thinking'} counts.
// - tool_choice: only {type:'none'} is sent (when tools are offered and opts.toolChoice is 'none');
//   'auto' is the default and is left out. Forced 'any'/'tool' are rejected by current models and never used.
// - assistant turns are replayed from raw content blocks unchanged (thinking blocks with signatures,
//   redacted_thinking), so history stays append-only.
// - all tool results of one round go into one user message as tool_result blocks.
// Adapter interface: see ai/adapters/index.js.

const C = require('./common.js');
const { createSseParser } = require('../sse.js');

const FORMAT = 'anthropic';
const VERSION = '2026-10-21';
const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const DEFAULT_MAX_TOKENS = 8192;
const PROBE_TOOL = { name: 'get_time', description: 'Returns the current time.', parameters: { type: 'object', properties: {}, additionalProperties: false } };

function base(ep) { return C.trimSlash(ep && ep.baseUrl) || DEFAULT_BASE; }
function headersFor(ep, stream) {
    const h = { 'content-type': 'application/json', 'anthropic-version': VERSION, accept: stream ? 'text/event-stream' : 'application/json' };
    if (ep && ep.apiKey) h['x-api-key'] = ep.apiKey;
    return h;
}

function pushMsg(msgs, role, blocks) {
    if (!blocks.length) return;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content = last.content.concat(blocks);   // keep strict alternation
    else msgs.push({ role: role, content: blocks });
}

function buildMessages(transcript) {
    const msgs = [];
    const items = transcript && Array.isArray(transcript.items) ? transcript.items : [];
    for (const it of items) {
        if (!it) continue;
        if (it.role === 'user') pushMsg(msgs, 'user', [{ type: 'text', text: String(it.text == null || it.text === '' ? ' ' : it.text) }]);
        else if (it.role === 'assistant') {
            const raw = C.rawFor(it, FORMAT);
            if (raw) { pushMsg(msgs, 'assistant', raw.slice()); continue; }
            const blocks = [];
            if (it.text) blocks.push({ type: 'text', text: String(it.text) });
            for (const c of (Array.isArray(it.calls) ? it.calls : [])) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: C.argsToObject(c) });
            pushMsg(msgs, 'assistant', blocks);
        } else if (it.role === 'tool') {
            const blocks = (Array.isArray(it.results) ? it.results : []).map(function (r) {
                const b = { type: 'tool_result', tool_use_id: r.callId, content: String(r.content == null ? '' : r.content) };
                if (r.isError) b.is_error = true;
                return b;
            });
            pushMsg(msgs, 'user', blocks);
        }
    }
    // tool_result blocks must come first in a user message
    for (const m of msgs) if (m.role === 'user' && m.content.length > 1) {
        const tr = m.content.filter(function (b) { return b.type === 'tool_result'; });
        if (tr.length && tr.length < m.content.length) m.content = tr.concat(m.content.filter(function (b) { return b.type !== 'tool_result'; }));
    }
    return msgs;
}

function buildRequest(ep, transcript, tools, opts) {
    opts = opts || {};
    tools = Array.isArray(tools) ? tools : [];
    const stream = opts.stream !== false;
    const url = base(ep) + '/messages';
    const body = { model: ep.model, max_tokens: C.num(opts.maxOutputTokens) || C.num(ep.maxOutputTokens) || DEFAULT_MAX_TOKENS, messages: buildMessages(transcript), stream: stream };
    if (transcript && transcript.system) body.system = String(transcript.system);
    if (tools.length) {
        body.tools = tools.map(function (t) { return { name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } }; });
        if (opts.toolChoice === 'none') body.tool_choice = { type: 'none' };
    }
    return { url: url, path: C.pathOf(url), headers: headersFor(ep, stream), body: body };
}

function mapStop(r) {
    switch (r) {
        case 'tool_use': return 'tools';
        case 'max_tokens': case 'model_context_window_exceeded': return 'length';
        case 'refusal': return 'refusal';
        default: return 'end';                 // end_turn, stop_sequence, pause_turn
    }
}

function errEvent(e) {
    e = C.isObj(e) ? e : {};
    return { t: 'error', message: String(e.message || 'The server reported an error').slice(0, 300), code: C.streamErrorCode(e.type, e.message) };
}

function finalizeBlock(b, emit) {
    if (!C.isObj(b)) return;
    if (b.type === 'tool_use') {
        const text = b._partial != null && b._partial !== '' ? b._partial : (C.isObj(b.input) && Object.keys(b.input).length ? JSON.stringify(b.input) : '{}');
        delete b._partial;
        const v = C.safeJson(text);
        b.input = C.isObj(v) ? v : {};
        emit({ t: 'raw', x: b });
        emit({ t: 'call', id: String(b.id || C.synthId('toolu_')), name: String(b.name || ''), argsText: text });
        return;
    }
    delete b._partial;
    emit({ t: 'raw', x: b });
}

function createParser(emit) {
    const blocks = [];
    let inTok = 0, outTok = null, stopReason = null, stopped = false, failed = false, seen = false, sawStart = false;
    function finish() {
        if (stopped) return;
        stopped = true;
        for (let i = 0; i < blocks.length; i++) if (blocks[i]) { const b = blocks[i]; blocks[i] = null; finalizeBlock(b, emit); }   // blocks never stopped
        emit({ t: 'usage', in: inTok, out: outTok || 0 });
        emit({ t: 'stop', reason: mapStop(stopReason) });
    }
    const sse = createSseParser(function (ev) {
        if (ev.event === 'done' || stopped || failed) return;
        const j = C.safeJson(ev.data);
        if (!C.isObj(j)) { emit({ t: 'malformed' }); return; }
        seen = true;
        const type = j.type || ev.event;
        switch (type) {
            case 'message_start': {
                sawStart = true;
                const u = C.isObj(j.message) && C.isObj(j.message.usage) ? j.message.usage : {};
                inTok = (C.num(u.input_tokens) || 0) + (C.num(u.cache_creation_input_tokens) || 0) + (C.num(u.cache_read_input_tokens) || 0);
                if (C.num(u.output_tokens)) outTok = C.num(u.output_tokens);
                break;
            }
            case 'content_block_start': {
                const cb = C.isObj(j.content_block) ? Object.assign({}, j.content_block) : null;
                if (!cb || !Number.isInteger(j.index)) { emit({ t: 'malformed' }); break; }
                if (cb.type === 'tool_use') cb._partial = '';
                if (cb.type === 'thinking' || cb.type === 'redacted_thinking') emit({ t: 'thinking', n: typeof cb.thinking === 'string' ? cb.thinking.length : 0 });
                if (cb.type === 'text' && typeof cb.text === 'string' && cb.text) emit({ t: 'text', d: cb.text });
                blocks[j.index] = cb;
                break;
            }
            case 'content_block_delta': {
                const b = blocks[j.index], d = j.delta;
                if (!C.isObj(b) || !C.isObj(d)) { emit({ t: 'malformed' }); break; }
                if (d.type === 'text_delta' && typeof d.text === 'string') { b.text = (b.text || '') + d.text; if (d.text) emit({ t: 'text', d: d.text }); }
                else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') b._partial = (b._partial || '') + d.partial_json;
                else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') { b.thinking = (b.thinking || '') + d.thinking; if (d.thinking) emit({ t: 'thinking', n: d.thinking.length }); }
                else if (d.type === 'signature_delta' && typeof d.signature === 'string') b.signature = (b.signature || '') + d.signature;
                else if (d.type === 'citations_delta' && d.citation) { if (!Array.isArray(b.citations)) b.citations = []; b.citations.push(d.citation); }
                break;
            }
            case 'content_block_stop': {
                const b = blocks[j.index];
                if (!C.isObj(b)) { emit({ t: 'malformed' }); break; }
                blocks[j.index] = null;
                finalizeBlock(b, emit);
                break;
            }
            case 'message_delta': {
                if (C.isObj(j.delta) && j.delta.stop_reason) stopReason = j.delta.stop_reason;
                const u = C.isObj(j.usage) ? j.usage : {};
                if (C.num(u.output_tokens)) outTok = C.num(u.output_tokens);
                if (C.num(u.input_tokens)) inTok = C.num(u.input_tokens) + (C.num(u.cache_creation_input_tokens) || 0) + (C.num(u.cache_read_input_tokens) || 0);
                break;
            }
            case 'message_stop': finish(); break;
            case 'ping': break;
            case 'error': failed = true; emit(errEvent(j.error)); break;
            default: break;
        }
    });
    return {
        push: function (t) { sse.push(t); },
        end: function () {
            sse.end();
            if (stopped || failed || !seen) return;
            if (stopReason) finish();             // message_delta arrived; message_stop missing is tolerable
            else if (sawStart) emit({ t: 'error', code: 'network', message: 'The response stream ended before the model finished' });
        }
    };
}

function parseNonStream(json, emit) {
    if (!C.isObj(json)) { emit({ t: 'malformed' }); return; }
    if (json.type === 'error' || (json.error && !json.content)) { emit(errEvent(json.error)); return; }
    for (const b0 of (Array.isArray(json.content) ? json.content : [])) {
        if (!C.isObj(b0)) continue;
        const b = Object.assign({}, b0);
        if (b.type === 'text' && b.text) emit({ t: 'text', d: String(b.text) });
        finalizeBlock(b, emit);
    }
    const u = C.isObj(json.usage) ? json.usage : {};
    emit({ t: 'usage', in: (C.num(u.input_tokens) || 0) + (C.num(u.cache_creation_input_tokens) || 0) + (C.num(u.cache_read_input_tokens) || 0), out: C.num(u.output_tokens) || 0 });
    emit({ t: 'stop', reason: mapStop(json.stop_reason) });
}

function classifyError(status, headers, bodyText) {
    const c = C.classifyHttpError(status, headers, bodyText);
    const t = c.providerType;
    if (c.toolsUnsupported) return c;
    if (t === 'authentication_error' || t === 'permission_error') { c.code = 'auth'; c.retryable = false; }
    else if (t === 'not_found_error') { c.code = /model/i.test(c.message || '') ? 'model' : 'badRequest'; c.retryable = false; }
    else if (t === 'rate_limit_error') { c.code = 'rateLimit'; c.retryable = true; }
    else if (t === 'overloaded_error') { c.code = 'overloaded'; c.retryable = true; }
    else if (t === 'request_too_large') { c.code = 'contextFull'; c.contextFull = true; c.retryable = false; }
    else if (t === 'api_error' && status >= 500 && c.code !== 'overloaded') { c.code = 'server'; }
    return c;
}

async function listModels(ep, deps) {
    const out = [];
    let after = null;
    for (let page = 0; page < 5; page++) {
        const r = await C.getJson(deps, { url: base(ep) + '/models?limit=1000' + (after ? '&after_id=' + encodeURIComponent(after) : ''), method: 'GET', headers: headersFor(ep, false) }, classifyError);
        const data = C.isObj(r.json) && Array.isArray(r.json.data) ? r.json.data : [];
        for (const m of data) if (C.isObj(m) && typeof m.id === 'string') {
            const o = { id: m.id, tools: true };
            if (C.num(m.max_input_tokens)) o.ctx = C.num(m.max_input_tokens);
            if (C.num(m.max_tokens)) o.maxOutput = C.num(m.max_tokens);
            out.push(o);
        }
        if (!(r.json && r.json.has_more && r.json.last_id)) break;
        after = r.json.last_id;
    }
    return out;
}

// what /v1/models/{id} says about thinking (capabilities, when the server lists them); it cannot be set here
function thinkingOf(m) {
    const c = C.isObj(m) && C.isObj(m.capabilities) ? m.capabilities : null;
    let v = c ? (c.thinking != null ? c.thinking : c.extended_thinking) : null;
    if (C.isObj(v)) v = v.supported;
    const sup = v === true ? true : v === false ? false : null;
    return { supported: sup, levels: null, serverDefault: null, verified: false, fixed: true, detail: 'set by the model; this API version takes no thinking setting' };
}

async function probe(ep, deps) {
    const out = { ok: false, tools: null, ctx: null, server: null, detail: '' };
    const notes = [];
    try {
        try {
            const r = await C.getJson(deps, { url: base(ep) + '/models/' + encodeURIComponent(ep.model), method: 'GET', headers: headersFor(ep, false) }, classifyError);
            if (C.isObj(r.json)) {
                if (C.num(r.json.max_input_tokens)) out.ctx = C.num(r.json.max_input_tokens);
                out.thinking = thinkingOf(r.json);
                out.ok = true; out.tools = true; out.server = 'anthropic';
                notes.push('model found' + (out.ctx ? ', context ' + out.ctx + ' tokens' : ''));
                out.detail = notes.join('; ');
                return out;
            }
        } catch (e) {
            if (e.code === 'auth') { out.code = 'auth'; out.detail = 'Authentication failed: ' + e.message; return out; }
            // compatible servers often lack /models/{id}: fall through to a tiny request
        }
        const req = buildRequest(Object.assign({}, ep, { maxOutputTokens: 16 }), { system: '', items: [{ role: 'user', text: 'Reply with OK.' }] }, [PROBE_TOOL], { stream: false, toolChoice: 'auto' });
        const res = await C.call(deps, { url: req.url, method: 'POST', headers: req.headers, body: req.body, totalTimeoutMs: 90000, idleTimeoutMs: 90000 });
        if (res.status < 400) { out.ok = true; out.tools = true; out.thinking = thinkingOf(null); notes.push('request with a tool definition accepted'); }
        else {
            const c = classifyError(res.status, res.headers, res.bodyText);
            if (c.toolsUnsupported) { out.ok = true; out.tools = false; notes.push('the model does not support tool calling'); }
            else { out.code = c.code; notes.push(c.message); }
        }
        out.detail = notes.join('; ');
        return out;
    } catch (e) {
        out.code = e.code || 'network';
        out.detail = e.message || 'Connection failed';
        return out;
    }
}

module.exports = { format: FORMAT, version: VERSION, buildRequest, createParser, parseNonStream, classifyError, listModels, probe, _buildMessages: buildMessages };
