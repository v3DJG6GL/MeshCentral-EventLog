'use strict';
// Ollama native API helpers (capability and context detection). The chat itself goes through
// openai_chat.js: OpenAI-compatible /v1/chat/completions, or native /api/chat when ep.ollamaNative is set
// (the only way to pass options.num_ctx; Ollama's default context can be as small as 4096 on small GPUs).
//
// isOllama(ep, deps) -> Promise<string|null>   server version, or null when this is not Ollama (never rejects)
// show(ep, deps)     -> Promise<{ capabilities:[], tools: bool|null, ctx: number|null, numCtx: number|null, family,
//                                 thinking: { supported, levels, serverDefault, verified, detail } | null,
//                                 genDefaults: { temperature, topP, topK, seed, maxTokens } }>
//                       ctx = model_info['<arch>.context_length'] (model maximum), numCtx = num_ctx set in the Modelfile;
//                       thinking from capabilities ('thinking'); genDefaults = the Modelfile PARAMETERs over Ollama's
//                       documented defaults (temperature 0.8, top_p 0.9, top_k 40, random seed, num_predict until done)
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
    const thinks = caps ? caps.indexOf('thinking') >= 0 : null;
    const thinking = caps ? { supported: thinks, levels: thinks ? C.THINK_LEVELS.slice() : [], serverDefault: null, verified: false, detail: 'reported by Ollama' } : null;
    return { capabilities: caps || [], tools: caps ? caps.indexOf('tools') >= 0 : null, ctx: ctx, numCtx: numCtx, family: details.family || arch || null, thinking: thinking, genDefaults: modelfileDefaults(j.parameters) };
}

const OLLAMA_DEFAULTS = { temperature: 0.8, topP: 0.9, topK: 40, seed: -1, maxTokens: -1 };
// "temperature 0.6\ntop_p 0.95\n..." (the parameters of /api/show; a raw Modelfile's "PARAMETER x y" lines work too)
function modelfileDefaults(text) {
    const out = Object.assign({}, OLLAMA_DEFAULTS);
    if (typeof text !== 'string') return out;
    const map = { temperature: 'temperature', top_p: 'topP', top_k: 'topK', seed: 'seed', num_predict: 'maxTokens' };
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(?:PARAMETER\s+)?([a-z_]+)\s+("?)(-?\d+(?:\.\d+)?)\2\s*$/i.exec(line);
        if (!m || !map[m[1].toLowerCase()]) continue;
        const k = map[m[1].toLowerCase()], n = Number(m[3]);
        if (!Number.isFinite(n)) continue;
        out[k] = (k === 'seed' && n < 0) || (k === 'maxTokens' && n < 0) ? -1 : n;
    }
    return out;
}

async function tags(ep, deps) {
    const r = await C.getJson(deps, { url: root(ep) + '/api/tags', method: 'GET', headers: authHeaders(ep) });
    const list = C.isObj(r.json) && Array.isArray(r.json.models) ? r.json.models : [];
    return list.filter(function (m) { return C.isObj(m) && typeof (m.name || m.model) === 'string'; }).map(function (m) {
        const d = C.isObj(m.details) ? m.details : {};
        return { id: m.name || m.model, size: C.num(m.size), family: d.family || null, parameterSize: d.parameter_size || null };
    });
}

module.exports = { isOllama, show, tags, root, modelfileDefaults, OLLAMA_DEFAULTS };
