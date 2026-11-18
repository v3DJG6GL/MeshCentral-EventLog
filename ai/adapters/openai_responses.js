'use strict';
// OpenAI Responses API (stateless: store:false, reasoning items replayed with their encrypted_content).
// Adapter interface: see ai/adapters/index.js.

const C = require('./common.js');
const { createSseParser } = require('../sse.js');
const chat = require('./openai_chat.js');

const FORMAT = 'openai-responses';
const PROBE_TOOL = { name: 'get_time', description: 'Returns the current time.', parameters: { type: 'object', properties: {}, additionalProperties: false } };
const RAW_TYPES = { reasoning: 1, function_call: 1, message: 1 };

function authHeaders(ep) { return ep && ep.apiKey ? { authorization: 'Bearer ' + ep.apiKey } : {}; }

function buildInput(transcript) {
    const input = [];
    const items = transcript && Array.isArray(transcript.items) ? transcript.items : [];
    for (const it of items) {
        if (!it) continue;
        if (it.role === 'user') input.push({ role: 'user', content: String(it.text == null ? '' : it.text) });
        else if (it.role === 'assistant') {
            const raw = C.rawFor(it, FORMAT);
            if (raw) { for (const x of raw) input.push(x); continue; }
            if (it.text) input.push({ role: 'assistant', content: String(it.text) });
            for (const c of (Array.isArray(it.calls) ? it.calls : [])) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: C.argsToText(c) });
        } else if (it.role === 'tool') {
            for (const r of (Array.isArray(it.results) ? it.results : [])) input.push({ type: 'function_call_output', call_id: r.callId, output: C.resultText(r) });
        }
    }
    return input;
}

function buildRequest(ep, transcript, tools, opts) {
    opts = opts || {};
    tools = Array.isArray(tools) ? tools : [];
    const stream = opts.stream !== false;
    const url = C.joinUrl(ep.baseUrl, '/responses');
    const body = { model: ep.model, input: buildInput(transcript), store: false, include: ['reasoning.encrypted_content'], stream: stream };
    if (transcript && transcript.system) body.instructions = String(transcript.system);
    const mt = C.num(opts.maxOutputTokens) || C.num(ep.maxOutputTokens);
    if (mt) body.max_output_tokens = mt;
    if (tools.length) {
        // strict defaults to true in the Responses API, which would reject schemas with optional properties
        body.tools = tools.map(function (t) { return { type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, strict: false }; });
        if (opts.toolChoice === 'none') body.tool_choice = 'none';
    }
    return { url: url, path: C.pathOf(url), headers: Object.assign({ 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' }, authHeaders(ep)), body: body };
}

function usageOf(resp) {
    const u = C.isObj(resp) && C.isObj(resp.usage) ? resp.usage : null;
    return u ? { t: 'usage', in: C.num(u.input_tokens) || 0, out: C.num(u.output_tokens) || 0 } : null;
}
function failMessage(resp, fallback) {
    const e = C.isObj(resp) && C.isObj(resp.error) ? resp.error : null;
    return { t: 'error', message: String((e && e.message) || fallback).slice(0, 300), code: C.streamErrorCode(e && (e.code || e.type), e && e.message) };
}

function makeState(emit) {
    const st = { calls: 0, text: false, refusal: false, itemsDone: 0, stopped: false, seen: false };
    st.item = function (item, allowText) {
        if (!C.isObj(item)) return;
        if (RAW_TYPES[item.type]) emit({ t: 'raw', x: item });
        if (item.type === 'function_call') {
            if (!item.name) { emit({ t: 'malformed', message: 'function call without a name' }); return; }
            emit({ t: 'call', id: String(item.call_id || item.id || C.synthId('call_')), name: item.name, argsText: typeof item.arguments === 'string' && item.arguments ? item.arguments : '{}' });
            st.calls++;
        } else if (item.type === 'message' && allowText && Array.isArray(item.content)) {
            for (const p of item.content) {
                if (C.isObj(p) && p.type === 'output_text' && p.text) { emit({ t: 'text', d: String(p.text) }); st.text = true; }
                if (C.isObj(p) && p.type === 'refusal' && p.refusal) { emit({ t: 'text', d: String(p.refusal) }); st.text = true; st.refusal = true; }
            }
        }
    };
    st.finish = function (resp, kind) {
        if (st.stopped) return;
        if (st.itemsDone === 0 && C.isObj(resp) && Array.isArray(resp.output)) for (const it of resp.output) st.item(it, !st.text);
        const u = usageOf(resp);
        if (u) emit(u);
        st.stopped = true;
        if (kind === 'incomplete') {
            const r = C.isObj(resp) && C.isObj(resp.incomplete_details) ? resp.incomplete_details.reason : null;
            emit({ t: 'stop', reason: r === 'content_filter' ? 'refusal' : 'length' });
        } else emit({ t: 'stop', reason: st.calls ? 'tools' : st.refusal ? 'refusal' : 'end' });
    };
    return st;
}

function createParser(emit) {
    const st = makeState(emit);
    let failed = false;
    const sse = createSseParser(function (ev) {
        if (ev.event === 'done' || st.stopped || failed) return;
        const j = C.safeJson(ev.data);
        if (!C.isObj(j)) { emit({ t: 'malformed' }); return; }
        st.seen = true;
        const type = j.type || ev.event;
        switch (type) {
            case 'response.output_text.delta':
                if (typeof j.delta === 'string' && j.delta) { emit({ t: 'text', d: j.delta }); st.text = true; }
                break;
            case 'response.refusal.delta':
                if (typeof j.delta === 'string' && j.delta) { emit({ t: 'text', d: j.delta }); st.text = true; st.refusal = true; }
                break;
            case 'response.output_item.done':
                st.itemsDone++;
                st.item(j.item, false);
                break;
            case 'response.completed':
                st.finish(j.response, 'completed');
                break;
            case 'response.incomplete':
                st.finish(j.response, 'incomplete');
                break;
            case 'response.failed':
                failed = true;
                emit(failMessage(j.response, 'The model failed to answer'));
                break;
            case 'error':
                failed = true;
                emit({ t: 'error', message: String(j.message || (C.isObj(j.error) && j.error.message) || 'The server reported an error').slice(0, 300), code: C.streamErrorCode(j.code || (C.isObj(j.error) && (j.error.code || j.error.type)), j.message) });
                break;
            default: break;                                    // created, in_progress, *.added, *.delta for arguments/reasoning ...
        }
    });
    return {
        push: function (t) { sse.push(t); },
        end: function () {
            sse.end();
            if (!st.stopped && !failed && st.seen) emit({ t: 'error', code: 'network', message: 'The response stream ended before the model finished' });
        }
    };
}

function parseNonStream(json, emit) {
    if (!C.isObj(json)) { emit({ t: 'malformed' }); return; }
    if (json.error && !json.output) { emit(failMessage(json, 'The server reported an error')); return; }
    const st = makeState(emit);
    if (json.status === 'failed') { emit(failMessage(json, 'The model failed to answer')); return; }
    st.finish(json, json.status === 'incomplete' ? 'incomplete' : 'completed');
}

function classifyError(status, headers, bodyText) { return C.classifyHttpError(status, headers, bodyText); }

function listModels(ep, deps) { return chat.listModels(ep, deps); }

async function probe(ep, deps) {
    const out = { ok: false, tools: null, ctx: null, server: null, detail: '' };
    const notes = [];
    try {
        try {
            await C.getJson(deps, { url: C.joinUrl(ep.baseUrl, '/models/' + encodeURIComponent(ep.model)), method: 'GET', headers: authHeaders(ep) }, classifyError);
        } catch (e) {
            if (e.code === 'auth') { out.code = 'auth'; out.detail = 'Authentication failed: ' + e.message; return out; }
            if (e.code === 'model') { out.code = 'model'; out.detail = 'Model "' + ep.model + '" was not found: ' + e.message; return out; }
            notes.push('model details unavailable');
        }
        const req = buildRequest(Object.assign({}, ep, { maxOutputTokens: 16 }), { system: '', items: [{ role: 'user', text: 'Reply with OK.' }] }, [PROBE_TOOL], { stream: false, toolChoice: 'auto' });
        const res = await C.call(deps, { url: req.url, method: 'POST', headers: req.headers, body: req.body, totalTimeoutMs: 90000, idleTimeoutMs: 90000 });
        if (res.status < 400) { out.ok = true; out.tools = true; notes.unshift('request with a tool definition accepted'); }
        else {
            const c = classifyError(res.status, res.headers, res.bodyText);
            if (c.toolsUnsupported) { out.ok = true; out.tools = false; notes.unshift('the model does not support tool calling'); }
            else { out.code = c.code; notes.unshift(c.message); }
        }
        out.detail = notes.join('; ');
        return out;
    } catch (e) {
        out.code = e.code || 'network';
        out.detail = e.message || 'Connection failed';
        return out;
    }
}

module.exports = { format: FORMAT, buildRequest, createParser, parseNonStream, classifyError, listModels, probe, _buildInput: buildInput };
