'use strict';
// Ollama native API helpers (capability and context detection). The chat itself goes through
// openai_chat.js: OpenAI-compatible /v1/chat/completions, or native /api/chat when ep.ollamaNative is set
// (the only way to pass options.num_ctx; Ollama's default context can be as small as 4096 on small GPUs).
//
// isOllama(ep, deps) -> Promise<string|null>   server version, or null when this is not Ollama (never rejects)
// show(ep, deps)     -> Promise<{ capabilities:[], tools: bool|null, ctx: number|null, numCtx: number|null, family }>
//                       ctx = model_info['<arch>.context_length'] (model maximum), numCtx = num_ctx set in the Modelfile
// tags(ep, deps)     -> Promise<[{ id, size, family, parameterSize }]>

const C = require('./common.js');

function root(ep) { return C.ollamaRoot(ep && ep.baseUrl); }
function authHeaders(ep) { return ep && ep.apiKey ? { authorization: 'Bearer ' + ep.apiKey } : {}; }

async function isOllama(ep, deps) {
    try {
        const r = await C.getJson(deps, { url: root(ep) + '/api/version', method: 'GET', headers: authHeaders(ep), totalTimeoutMs: 8000 });
        return C.isObj(r.json) && typeof r.json.version === 'string' ? r.json.version : null;
    } catch (e) { return null; }
}

async function show(ep, deps) {
    const r = await C.getJson(deps, { url: root(ep) + '/api/show', method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(ep)), body: { model: ep.model } });
    const j = C.isObj(r.json) ? r.json : {};
    const caps = Array.isArray(j.capabilities) ? j.capabilities.filter(function (c) { return typeof c === 'string'; }) : null;
    const mi = C.isObj(j.model_info) ? j.model_info : {};
    const arch = typeof mi['general.architecture'] === 'string' ? mi['general.architecture'] : null;
    let ctx = arch ? C.num(mi[arch + '.context_length']) : null;
    if (!ctx) for (const k of Object.keys(mi)) if (/\.context_length$/.test(k)) { ctx = C.num(mi[k]); if (ctx) break; }
    let numCtx = null;
    if (typeof j.parameters === 'string') { const m = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(j.parameters); if (m) numCtx = C.num(m[1]); }
    const details = C.isObj(j.details) ? j.details : {};
    return { capabilities: caps || [], tools: caps ? caps.indexOf('tools') >= 0 : null, ctx: ctx, numCtx: numCtx, family: details.family || arch || null };
}

async function tags(ep, deps) {
    const r = await C.getJson(deps, { url: root(ep) + '/api/tags', method: 'GET', headers: authHeaders(ep) });
    const list = C.isObj(r.json) && Array.isArray(r.json.models) ? r.json.models : [];
    return list.filter(function (m) { return C.isObj(m) && typeof (m.name || m.model) === 'string'; }).map(function (m) {
        const d = C.isObj(m.details) ? m.details : {};
        return { id: m.name || m.model, size: C.num(m.size), family: d.family || null, parameterSize: d.parameter_size || null };
    });
}

module.exports = { isOllama, show, tags, root };
