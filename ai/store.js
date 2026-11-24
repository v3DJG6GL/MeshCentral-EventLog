'use strict';
// Assistant settings store: endpoints, settings, preview acknowledgements and the audit log, over obj.db.
//
// create({ db, secrets, netguard, log }) -> store
//   db:       aiPutDoc(id,type,doc) aiGetDoc(id) aiDocs(type) aiDelDoc(id) aiAuditAdd(rec) aiAuditQuery(q)
//             aiAuditSweep(cutoffMs) getAllConfigSets()        (db.js / db_sql.js)
//   secrets:  ai/secrets.js instance          netguard: { check(url, opts) } (ai/netguard.js)
//
// Endpoints (settings store, id 'aiEndpoint:<12 hex>', type 'aiEndpoint'):
//   { id, name, format, preset, baseUrl, model, key, contextTokens, numCtx, maxOutputTokens, timeoutSec, toolMode,
//     allowLinkLocal, extraInstructions (<= 4000 chars, '' = none), thinking, thinkingMap, temperature, topP, topK, seed,
//     userModels, network, caps, capsByModel, quirks, lastTest, updated }
//   Generation settings, null = the server's default (only set values are sent): thinking 'off'|'low'|'medium'|'high'|'max',
//   temperature 0..2, topP 0..1 (both rounded to 2 decimals and clamped), topK 1..1000 and seed 0..2^31-1 (whole
//   numbers; topK clamped, a seed outside the range is refused). The Anthropic format takes none of them (all null);
//   the Responses API has no top-k or seed (null). caps (from Test connection) may carry
//   thinking { supported, levels, serverDefault, verified, detail } and genDefaults { temperature, topP, topK, seed
//   (-1 random), maxTokens (-1 until done) }.
//   thinkingMap (the endpoint's model): null = the default map { off:'none', low:'low', medium:'medium', high:'high',
//   max:null }, else { off, low, medium, high, max } with values 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max',
//   a whole number 1..100 or null (the level is not offered); what a thinking level sends (adapters/common.js).
//   A thinking setting whose level the map does not offer is refused. A map equal to the default is stored as null.
//   userModels { enabled (false), models: [{ id, thinkingMap }] } (at most 30, ids checked like model, duplicates and
//   the endpoint's own model dropped): the models users may pick per chat; the endpoint's model is the default and
//   always allowed. capsByModel [{ model, caps }]: what Test connection / a conversation found for a listed model (an
//   array: model ids may contain dots, which the database refuses as keys); caps belongs to the endpoint's model.
//   Anthropic: no thinking maps (null).
//   key: null | { v, iv, ct, tag, last4 } (AES-GCM, AAD = endpoint id) | { env: 'VAR' }
//   listEndpoints() -> Promise<[ep]> (sorted by name)      getEndpoint(id) -> Promise<ep|null>
//   saveEndpoint(input, { keyAction:'keep'|'set'|'remove', key }) -> Promise<ep>
//       rejects Error{code:'invalid'|'notFound', message (shown to the admin)}; a non-fatal note (DNS lookup
//       failed, so network is null) is attached as the non-enumerable property ep.warning.
//       keyAction 'keep' keeps the stored key even when the address (host) changes: the admin edits both fields
//       in one form and re-entering a key for every address fix would only invite pasting keys around. A change
//       of address, model or format clears quirks/lastTest (they described the old target), a change of address the
//       preview acknowledgements for the endpoint (users confirm again what is sent where). A change of address or
//       format drops caps and capsByModel; otherwise the caps found per model stay with the models still in use (a
//       listed model that becomes the endpoint's model takes its caps along), the others are dropped.
//   deleteEndpoint(id) -> Promise<true>  rejects Error{code:'inUse', sets:[names]} while a config set uses it
//   publicEndpoint(ep) -> copy without `key`, plus hasKey and keyHint ('…abcd' | 'env:VAR' | '')
//   resolveKey(ep) -> plaintext | null (never throws)
//   setCaps(id, caps, model?) (model other than the endpoint's: into capsByModel, only for a listed model) /
//   setQuirks(id, quirks) (merged) / setLastTest(id, r) -> Promise<ep|null>
//   setNetwork(id, network) -> Promise<ep|null> (the verdict of a later address check of the saved endpoint)
//   validateEndpoint(input, opts?) -> fields (sync syntax check, throws Error{code:'invalid'}), used for drafts too;
//       opts.draft: the name is optional (Test connection / Fetch models), opts.noModel: the model is optional too
//   keySource() -> secrets.source
// Settings (id 'aiSettings'): getSettings() -> defaults merged with the stored document (cached);
//   saveSettings(input) -> Promise<settings>: known fields only, numbers clamped, enums checked; fields missing
//   from input keep their current value. Quotas of 0 mean "no limit". limits.maxCalls and limits.maxSentKB may be
//   null (or '') for "automatic": 3 x maxRounds tool calls, and about 3 bytes per context token (at least 400 KB).
//   prompts { base, ask, explain, diagnose: null (factory default) | text <= 20000 chars, edited { part: {at, by,
//   factoryHash} } } ('' or the factory text itself -> null; edited entries of factory parts are dropped) and
//   extraInstructions (<= 4000 chars). mergeSettings(base, input) is the same merge without saving.
//   history { enabled (default true), retentionDays 1..3650 (default 30) }: saved chats, diagnoses and explanations
//   (ai/history.js). starters { windows, linux, macos }: null (factory list, STARTERS) | up to 12 one-line texts of at
//   most 200 characters (the factory list itself -> null; a stored document without a list, e.g. from before macOS
//   support, gets null = the factory list); startersFor(settings, os) picks a device's list.
//   chatGen { enabled (default true) }: users may change thinking and temperature per chat (ai/index.js).
//   The stored document also carries sv (SETTINGS_VERSION, server-side only); an older document is migrated once
//   on load (old defaults -> new defaults) and saved again; a failed save is logged and does not fail the load.
// Pure helpers: allowedModels(ep) -> [ids] (the endpoint's model, then the list when userModels.enabled),
//   isAllowedModel(ep, id), modelThinkingMap(ep, model) -> map|null, capsFor(ep, model) -> caps|null.
// Acknowledgements: getAck(userid, epId) -> Promise<bool>, setAck(userid, epId) -> Promise<bool>.
// Audit: auditAdd(rec) -> Promise<bool> (never rejects; adds time; userid/nodeid copied from user/node strings;
//   keys with '.' or a leading '$' dropped, steps[*].args stringified; transcript dropped unless
//   settings.storeTranscripts and capped at 256 KB), auditQuery(q), usage(userid, sinceMs) ->
//   Promise<{questions, tokens}> (never rejects; zeros + log on a database error), sweep() -> Promise<removed>.

const crypto = require('crypto');
const prompts = require('./prompts.js');
const C = require('./adapters/common.js');

const FORMATS = ['openai-chat', 'openai-responses', 'anthropic'];
const PRESETS = ['ollama', 'vllm', 'lmstudio', 'llamacpp', 'localai', 'custom'];
const TOOL_MODES = ['auto', 'tools', 'summary'];
const PREVIEW = ['every', 'once', 'never'];
const ID_RE = /^aiEndpoint:[0-9a-f]{12}$/;
const INT_FIELDS = {
    contextTokens: { min: 1024, max: 4194304, label: 'Context size' },
    numCtx: { min: 1024, max: 4194304, label: 'Ollama context' },
    maxOutputTokens: { min: 64, max: 128000, label: 'Maximum answer length' },
    timeoutSec: { min: 10, max: 900, label: 'Timeout' }
};
const MAX_TRANSCRIPT = 256 * 1024;
const THINKING = C.THINK_LEVELS;
const MAX_USER_MODELS = 30;
const GEN_FIELDS = ['thinking', 'temperature', 'topP', 'topK', 'seed'];
const SEED_MAX = 2147483647;

const DEFAULTS = {
    enabled: true,
    limits: { maxRounds: 15, maxCalls: null, maxOutputTokens: 2048, timeoutSec: 120, maxSentKB: null },
    quotas: { perUserQuestions: 100, perUserTokens: 3000000 },
    retentionDays: 90,
    storeTranscripts: false,
    previewPolicy: 'every',
    redact: { users: true, hosts: true, domains: true, ips: true, macs: true, emails: true, sids: true, paths: true, secrets: true, serials: false },
    categories: { deviceSummary: true, network: true, storedEvents: true, meshEvents: true, notes: false, software: false },
    // system prompt templates per part (null = factory default, ai/prompts.js FACTORY); edited[part] = { at, by, factoryHash }
    prompts: { base: null, ask: null, explain: null, diagnose: null, edited: {} },
    extraInstructions: '',
    // saved results (chats, the last diagnosis, explanations) per user and device, ai/history.js
    history: { enabled: true, retentionDays: 30 },
    // starter questions of an empty Ask panel per device OS (null = the factory list, STARTERS)
    starters: { windows: null, linux: null, macos: null },
    // users may change thinking and temperature per chat (on top of the endpoint's generation settings)
    chatGen: { enabled: true }
};
// Factory starter questions (the buttons of an empty Ask panel); a device of unknown OS gets the Windows list, an
// Android device none (no event logs there).
const STARTERS = {
    windows: ['Why did this device restart recently?', 'What changed in the last 24 hours?', 'Are there signs of disk or hardware problems?'],
    linux: ['Why did this device restart recently?', 'Which services failed in the last 24 hours?', 'Are there signs of disk, memory or hardware problems?'],
    macos: ['Why did this Mac restart recently? Was there a kernel panic?', 'Which apps crashed in the last 7 days?', 'Did any software update or installation fail recently?', 'Were there failed logins or authentication errors?']
};
const STARTER_OS = ['windows', 'linux', 'macos'];
const MAX_STARTERS = 12, MAX_STARTER_LEN = 200;
const PROMPT_PARTS = prompts.PARTS;
const MAX_TEMPLATE = prompts.MAX_TEMPLATE, MAX_EXTRA = prompts.MAX_EXTRA;
const RANGES = {
    limits: { maxRounds: [1, 50], maxCalls: [1, 200], maxOutputTokens: [64, 128000], timeoutSec: [10, 900], maxSentKB: [16, 8192] },
    quotas: { perUserQuestions: [0, 100000], perUserTokens: [0, 1000000000] },
    retentionDays: [1, 3650],
    historyDays: [1, 3650]
};
// limits where null means "automatic" (the engine derives the value: maxCalls 3 x maxRounds, maxSentKB from the context)
const NULLABLE = { limits: { maxCalls: true, maxSentKB: true } };

// Version of the stored settings document (field sv, written by the server only; not part of the settings
// object). Documents without sv (or older) are migrated once on load: values still equal to an earlier default
// become the current default, any other value is kept.
const SETTINGS_VERSION = 2;
const OLD_DEFAULTS = [
    { grp: 'quotas', key: 'perUserQuestions', from: 40, to: 100 },
    { grp: 'quotas', key: 'perUserTokens', from: 300000, to: 3000000 },
    { grp: 'limits', key: 'maxRounds', from: 8, to: 15 },
    { grp: 'limits', key: 'maxSentKB', from: 400, to: null }
];
// rewrites an unversioned stored document in place; returns true when it needs to be saved again
function migrateSettings(d) {
    if (!isObj(d) || (typeof d.sv === 'number' && d.sv >= SETTINGS_VERSION)) return false;
    for (const m of OLD_DEFAULTS) if (isObj(d[m.grp]) && d[m.grp][m.key] === m.from) d[m.grp][m.key] = m.to;
    return true;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }
function invalid(message, code) { const e = new Error(message); e.code = code || 'invalid'; return e; }

function clampInt(v, range, fallback) {
    if (v === '' || v == null || typeof v === 'boolean') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(range[1], Math.max(range[0], Math.round(n)));
}

// a template part from the admin page: null for the factory default ('', blank or the factory text itself),
// undefined for a value that is not a string (ignored), else the text (line breaks normalized, capped)
function normTemplate(part, v) {
    if (v === null) return null;
    if (typeof v !== 'string') return undefined;
    const t = v.replace(/\r\n?/g, '\n');
    if (t.trim() === '' || t === prompts.FACTORY[part]) return null;
    return t.length > MAX_TEMPLATE ? t.slice(0, MAX_TEMPLATE) : t;
}
function normExtra(v) {
    if (typeof v !== 'string') return undefined;
    const t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    return t.length > MAX_EXTRA ? t.slice(0, MAX_EXTRA) : t;
}
// a starter list from the admin page: null for the factory list (null, or the factory list itself), undefined for a
// value that is not an array (ignored), else up to 12 distinct one-line texts of at most 200 characters
function normStarters(os, v) {
    if (v === null) return null;
    if (!Array.isArray(v)) return undefined;
    const out = [];
    for (const x of v) {
        if (typeof x !== 'string') continue;
        let t = x.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (t.length > MAX_STARTER_LEN) t = t.slice(0, MAX_STARTER_LEN).trim();
        if (out.indexOf(t) < 0) out.push(t);
        if (out.length >= MAX_STARTERS) break;
    }
    const f = STARTERS[os];
    if (out.length === f.length && out.every(function (t, i) { return t === f[i]; })) return null;
    return out;
}
// the starter questions for a device: the saved list for its OS, else the factory list (unknown OS: Windows;
// Android: none)
function startersFor(settings, os) {
    if (os === 'android') return [];
    const k = STARTER_OS.indexOf(os) >= 0 ? os : 'windows';
    const v = settings && isObj(settings.starters) ? settings.starters[k] : null;
    return Array.isArray(v) ? v.slice(0, MAX_STARTERS) : STARTERS[k].slice();
}
function normEdited(e) {
    const out = {};
    if (!isObj(e)) return out;
    for (const p of PROMPT_PARTS) {
        const x = e[p];
        if (!isObj(x)) continue;
        out[p] = {
            at: Number.isFinite(Number(x.at)) && Number(x.at) > 0 ? Number(x.at) : Date.now(),
            by: String(x.by == null ? '' : x.by).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120),
            factoryHash: typeof x.factoryHash === 'string' && /^[0-9a-f]{64}$/.test(x.factoryHash) ? x.factoryHash : null
        };
    }
    return out;
}

// Settings merge (pure): base settings + input -> new settings. Known fields only, numbers clamped, enums checked,
// fields missing from input keep their base value.
function mergeSettings(base, input) {
    const s = clone(base);
    if (!isObj(s.prompts)) s.prompts = clone(DEFAULTS.prompts);
    for (const p of PROMPT_PARTS) if (typeof s.prompts[p] !== 'string') s.prompts[p] = null;
    s.prompts.edited = normEdited(s.prompts.edited);
    if (typeof s.extraInstructions !== 'string') s.extraInstructions = '';
    s.history = Object.assign({}, DEFAULTS.history, isObj(s.history) ? s.history : {});
    s.history.enabled = s.history.enabled !== false;
    s.history.retentionDays = clampInt(s.history.retentionDays, RANGES.historyDays, DEFAULTS.history.retentionDays);
    const st0 = isObj(s.starters) ? s.starters : {};
    s.starters = {};
    for (const os of STARTER_OS) { const v = normStarters(os, st0[os]); s.starters[os] = v === undefined ? null : v; }
    s.chatGen = { enabled: !(isObj(s.chatGen) && s.chatGen.enabled === false) };
    if (!isObj(input)) return s;
    if (typeof input.enabled === 'boolean') s.enabled = input.enabled;
    if (typeof input.storeTranscripts === 'boolean') s.storeTranscripts = input.storeTranscripts;
    if (PREVIEW.indexOf(input.previewPolicy) >= 0) s.previewPolicy = input.previewPolicy;
    s.retentionDays = clampInt(input.retentionDays, RANGES.retentionDays, s.retentionDays);
    for (const grp of ['limits', 'quotas']) {
        if (!isObj(input[grp])) continue;
        for (const k of Object.keys(DEFAULTS[grp])) {
            const v = input[grp][k];
            if (NULLABLE[grp] && NULLABLE[grp][k] && (v === null || v === '')) s[grp][k] = null;
            else s[grp][k] = clampInt(v, RANGES[grp][k], s[grp][k]);
        }
    }
    for (const grp of ['redact', 'categories']) {
        if (!isObj(input[grp])) continue;
        for (const k of Object.keys(DEFAULTS[grp])) if (typeof input[grp][k] === 'boolean') s[grp][k] = input[grp][k];
    }
    if (isObj(input.prompts)) {
        for (const p of PROMPT_PARTS) { const v = normTemplate(p, input.prompts[p]); if (v !== undefined) s.prompts[p] = v; }
        if (isObj(input.prompts.edited)) s.prompts.edited = normEdited(input.prompts.edited);
    }
    for (const p of PROMPT_PARTS) if (s.prompts[p] == null) delete s.prompts.edited[p];
    const ex = normExtra(input.extraInstructions);
    if (ex !== undefined) s.extraInstructions = ex;
    if (isObj(input.history)) {
        if (typeof input.history.enabled === 'boolean') s.history.enabled = input.history.enabled;
        s.history.retentionDays = clampInt(input.history.retentionDays, RANGES.historyDays, s.history.retentionDays);
    }
    if (isObj(input.starters)) {
        for (const os of STARTER_OS) { const v = normStarters(os, input.starters[os]); if (v !== undefined) s.starters[os] = v; }
    }
    if (isObj(input.chatGen) && typeof input.chatGen.enabled === 'boolean') s.chatGen.enabled = input.chatGen.enabled;
    return s;
}

// Syntax-only endpoint validation (no DNS). Throws Error{code:'invalid'}.
// opts.draft: name optional (a draft is only tested or asked for its models, never stored); opts.noModel: model optional.
function validateEndpoint(input, opts) {
    opts = opts || {};
    if (!isObj(input)) throw invalid('Missing endpoint data');
    const out = {};
    const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (opts.draft !== true && (!name || name.length > 64)) throw invalid('Name must be 1 to 64 characters');
    out.name = name.slice(0, 64);
    const format = input.format == null || input.format === '' ? 'openai-chat' : input.format;
    if (FORMATS.indexOf(format) < 0) throw invalid('Unknown API format');
    out.format = format;
    out.preset = PRESETS.indexOf(input.preset) >= 0 ? input.preset : 'custom';

    const raw = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
    if (!raw) throw invalid('Address is required');
    if (raw.length > 2048) throw invalid('Address is too long');
    let u;
    try { u = new URL(raw); } catch (e) { throw invalid('Address is not a valid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalid('Only http:// and https:// addresses are allowed');
    if (u.username || u.password) throw invalid('User name or password in the address is not allowed; use the API key field');
    if (!u.hostname) throw invalid('Address has no host name');
    if (u.search || u.hash || /[?#]/.test(raw)) throw invalid('The address must not contain a query string or fragment');
    out.baseUrl = (u.origin + u.pathname).replace(/\/+$/, '');

    const model = typeof input.model === 'string' ? input.model.trim() : '';
    if (!model && opts.noModel !== true) throw invalid('Model is required');
    if (model && badModelId(model)) throw invalid('Model must be at most 200 characters without control characters');
    out.model = model;
    out.userModels = validateUserModels(input.userModels, model, format);

    for (const k of Object.keys(INT_FIELDS)) {
        const f = INT_FIELDS[k], v = input[k];
        if (v == null || v === '') { out[k] = k === 'timeoutSec' ? 120 : null; continue; }
        const n = typeof v === 'boolean' ? NaN : Number(v);
        if (!Number.isInteger(n) || n < f.min || n > f.max) throw invalid(f.label + ' must be a whole number from ' + f.min + ' to ' + f.max);
        out[k] = n;
    }
    out.toolMode = TOOL_MODES.indexOf(input.toolMode) >= 0 ? input.toolMode : 'auto';
    out.allowLinkLocal = input.allowLinkLocal === true;
    const ex = input.extraInstructions == null ? '' : normExtra(input.extraInstructions);
    if (ex === undefined) throw invalid('Model-specific instructions must be text');
    if (typeof input.extraInstructions === 'string' && input.extraInstructions.trim().length > MAX_EXTRA) throw invalid('Model-specific instructions must be at most ' + MAX_EXTRA + ' characters');
    out.extraInstructions = ex;
    Object.assign(out, validateGen(input, format));
    return out;
}

function badModelId(id) { return !id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id); }
// a thinking map from the admin page (see the header): null for the default map; numbers may come as text ('50')
function validateThinkingMap(m) {
    if (m == null || m === '') return null;
    if (!isObj(m)) throw invalid('The thinking map must list a value per level');
    const out = {};
    for (const l of THINKING) {
        let v = m[l];
        if (v === undefined) { out[l] = C.DEFAULT_THINKING_MAP[l]; continue; }
        if (v === null || v === '') { out[l] = null; continue; }
        if (typeof v === 'string') v = /^\s*\d+\s*$/.test(v) ? Number(v) : v.trim().toLowerCase();
        if (!C.isThinkValue(v)) throw invalid('Thinking values must be none, minimal, low, medium, high, xhigh, max or a whole number from 1 to 100');
        out[l] = v;
    }
    return THINKING.every(function (l) { return out[l] === C.DEFAULT_THINKING_MAP[l]; }) ? null : out;
}
// the models users may choose (see the header)
function validateUserModels(u, model, format) {
    if (u == null) return { enabled: false, models: [] };
    if (!isObj(u)) throw invalid('The model list is not valid');
    const list = u.models == null ? [] : u.models;
    if (!Array.isArray(list)) throw invalid('The model list is not valid');
    const out = [], seen = new Set([model]);
    for (const x of list) {
        const e = typeof x === 'string' ? { id: x } : x;
        if (!isObj(e)) throw invalid('Each listed model needs a name');
        const id = typeof e.id === 'string' ? e.id.trim() : '';
        if (badModelId(id)) throw invalid('Listed model names must be 1 to 200 characters without control characters');
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id: id, thinkingMap: format === 'anthropic' ? null : validateThinkingMap(e.thinkingMap) });
    }
    if (out.length > MAX_USER_MODELS) throw invalid('At most ' + MAX_USER_MODELS + ' models can be listed');
    return { enabled: u.enabled === true, models: out };
}

// the generation settings of an endpoint form (see the header); throws Error{code:'invalid'} for values that are not numbers
function validateGen(input, format) {
    const out = { thinking: null, thinkingMap: null, temperature: null, topP: null, topK: null, seed: null };
    const numIn = function (k, label) {
        const v = input[k];
        if (v == null || v === '') return null;
        const n = typeof v === 'boolean' ? NaN : Number(v);
        if (!Number.isFinite(n)) throw invalid(label + ' must be a number');
        return n;
    };
    const t = input.thinking;
    if (t != null && t !== '' && THINKING.indexOf(t) < 0) throw invalid('Thinking must be off, low, medium, high or max');
    out.thinking = t == null || t === '' ? null : t;
    out.thinkingMap = validateThinkingMap(input.thinkingMap);
    if (out.thinking && format !== 'anthropic' && C.thinkingMap(out.thinkingMap)[out.thinking] == null) throw invalid('Thinking ' + out.thinking + ' is not offered by the thinking map; give it a value there or pick another level');
    const r2 = function (n) { return Math.round(n * 100) / 100; };
    let n = numIn('temperature', 'Temperature');
    if (n != null) out.temperature = r2(Math.min(2, Math.max(0, n)));
    n = numIn('topP', 'Top-p');
    if (n != null) out.topP = r2(Math.min(1, Math.max(0, n)));
    n = numIn('topK', 'Top-k');
    if (n != null) out.topK = Math.min(1000, Math.max(1, Math.round(n)));
    n = numIn('seed', 'Seed');
    if (n != null) {
        if (!Number.isInteger(n) || n < 0 || n > SEED_MAX) throw invalid('Seed must be a whole number from 0 to ' + SEED_MAX);
        out.seed = n;
    }
    if (format === 'anthropic') { for (const k of GEN_FIELDS) out[k] = null; out.thinkingMap = null; }
    else if (format === 'openai-responses') { out.topK = null; out.seed = null; }
    return out;
}

// ---- models users may choose (pure) ----
function listedModels(ep) {
    const u = ep && isObj(ep.userModels) && Array.isArray(ep.userModels.models) ? ep.userModels.models : [];
    return u.filter(function (m) { return isObj(m) && typeof m.id === 'string' && m.id; }).map(function (m) { return m.id; });
}
function allowedModels(ep) {
    if (!ep || typeof ep.model !== 'string') return [];
    const out = [ep.model];
    if (isObj(ep.userModels) && ep.userModels.enabled === true) for (const id of listedModels(ep)) if (out.indexOf(id) < 0) out.push(id);
    return out;
}
function isAllowedModel(ep, id) { return typeof id === 'string' && allowedModels(ep).indexOf(id) >= 0; }
function modelThinkingMap(ep, model) {
    if (!ep) return null;
    if (model == null || model === ep.model) return isObj(ep.thinkingMap) ? ep.thinkingMap : null;
    const m = (isObj(ep.userModels) && Array.isArray(ep.userModels.models) ? ep.userModels.models : []).find(function (x) { return isObj(x) && x.id === model; });
    return m && isObj(m.thinkingMap) ? m.thinkingMap : null;
}
function capsFor(ep, model) {
    if (!ep) return null;
    if (model == null || model === ep.model) return isObj(ep.caps) ? ep.caps : null;
    const e = (Array.isArray(ep.capsByModel) ? ep.capsByModel : []).find(function (x) { return isObj(x) && x.model === model; });
    return e && isObj(e.caps) ? e.caps : null;
}

function isDnsError(msg) { return /^DNS lookup|did not resolve/i.test(String(msg || '')); }

// Audit record sanitizer: NeDB refuses keys containing '.' or starting with '$'.
function sanitize(v, depth) {
    if (v == null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'bigint') return String(v);
    if (typeof v !== 'object') return undefined;            // functions, symbols
    if (depth > 12) return '[nested]';
    if (v instanceof Date) return v.getTime();
    if (Array.isArray(v)) return v.map(function (x) { const s = sanitize(x, depth + 1); return s === undefined ? null : s; });
    const o = {};
    for (const k of Object.keys(v)) {
        if (k.indexOf('.') >= 0 || k.charAt(0) === '$' || k === '__proto__') continue;
        const s = sanitize(v[k], depth + 1);
        if (s !== undefined) o[k] = s;
    }
    return o;
}

function create(opts) {
    opts = opts || {};
    const db = opts.db, secrets = opts.secrets, netguard = opts.netguard;
    const log = opts.log || function (m) { console.log(m); };
    let settingsCache = null, settingsLoading = null;
    let chain = Promise.resolve();

    function warn(m) { try { log('EVENTLOG AI: ' + m); } catch (e) { } }
    // endpoint document writes run one after another (read-modify-write without lost updates)
    function serial(fn) {
        const p = chain.then(fn, fn);
        chain = p.then(function () { }, function () { });
        return p;
    }

    function normDoc(d) {
        if (!isObj(d)) return null;
        const ep = Object.assign({}, d);
        ep.id = typeof d.id === 'string' ? d.id : String(d._id);
        delete ep._id; delete ep.type;
        return ep;
    }

    async function listEndpoints() {
        const docs = await db.aiDocs('aiEndpoint');
        return (docs || []).map(normDoc).filter(function (e) { return e && ID_RE.test(e.id); })
            .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    }
    async function getEndpoint(id) {
        if (typeof id !== 'string' || !ID_RE.test(id)) return null;
        const d = await db.aiGetDoc(id);
        return d ? normDoc(d) : null;
    }
    function putEndpoint(ep) {
        const d = Object.assign({}, ep);
        return db.aiPutDoc(ep.id, 'aiEndpoint', d).then(function () { return ep; });
    }

    function computeKey(id, keyAction, key, existing) {
        switch (keyAction == null ? 'keep' : keyAction) {
            case 'keep': return existing ? (existing.key || null) : null;
            case 'remove': return null;
            case 'set': {
                const k = typeof key === 'string' ? key.trim() : '';
                if (!k) throw invalid('Enter an API key, or keep or remove the stored one');
                if (/^env:/i.test(k)) {
                    const name = secrets.parseEnvRef(k);
                    if (!name) throw invalid('Environment variable names use A-Z, 0-9 and _ (for example env:LLM_API_KEY)');
                    return { env: name };
                }
                if (k.length > 8192) throw invalid('The API key is too long');
                if (/[\s\u0000-\u001f\u007f]/.test(k)) throw invalid('The API key must not contain spaces or line breaks');
                return secrets.encrypt(k, id);
            }
            default: throw invalid('Unknown key action');
        }
    }

    async function clearAcks(epId) {
        try {
            const acks = await db.aiDocs('aiAck');
            for (const a of acks || []) if (a && a.epId === epId) await db.aiDelDoc(String(a._id));
        } catch (e) { warn('could not clear acknowledgements (' + (e && e.message ? String(e.message).slice(0, 120) : 'error') + ')'); }
    }

    async function saveEndpoint(input, kopts) {
        kopts = kopts || {};
        const f = validateEndpoint(input);
        const wantId = input.id == null || input.id === '' ? null : input.id;
        if (wantId != null && (typeof wantId !== 'string' || !ID_RE.test(wantId))) throw invalid('Endpoint not found', 'notFound');
        if (['keep', 'set', 'remove', undefined, null].indexOf(kopts.keyAction) < 0) throw invalid('Unknown key action');

        // address check outside the write queue (DNS can take seconds)
        let network = null, warning = null;
        const chk = await netguard.check(f.baseUrl, { allowLinkLocal: f.allowLinkLocal });
        if (chk && chk.ok) network = chk.network;
        else if (chk && isDnsError(chk.error)) warning = chk.error + '; the address was saved but could not be checked yet';
        else throw invalid((chk && chk.error) || 'Address is not allowed');

        return serial(async function () {
            const existing = wantId ? await getEndpoint(wantId) : null;
            if (wantId && !existing) throw invalid('Endpoint not found', 'notFound');
            const all = await listEndpoints();
            const lname = f.name.toLowerCase();
            if (all.some(function (e) { return e.id !== wantId && String(e.name).toLowerCase() === lname; })) throw invalid('Another endpoint already uses this name');
            const id = existing ? existing.id : 'aiEndpoint:' + crypto.randomBytes(6).toString('hex');
            const key = computeKey(id, kopts.keyAction, kopts.key, existing);
            const addr = existing && (existing.baseUrl !== f.baseUrl || existing.format !== f.format);
            const target = existing && (addr || existing.model !== f.model);
            const keep = existing && !target;
            // caps found per model stay with the models still in use; a new address or format drops them all
            const pool = new Map();
            if (existing && !addr) {
                for (const e of Array.isArray(existing.capsByModel) ? existing.capsByModel : []) if (isObj(e) && typeof e.model === 'string' && isObj(e.caps)) pool.set(e.model, e.caps);
                if (isObj(existing.caps)) pool.set(existing.model, existing.caps);
            }
            const ep = Object.assign({ id: id }, f, {
                key: key, network: network,
                caps: pool.get(f.model) || null,
                capsByModel: f.userModels.models.filter(function (m) { return pool.has(m.id); }).map(function (m) { return { model: m.id, caps: pool.get(m.id) }; }),
                quirks: keep ? (existing.quirks || null) : null,
                lastTest: keep ? (existing.lastTest || null) : null,
                updated: Date.now()
            });
            await putEndpoint(ep);
            if (existing && existing.baseUrl !== f.baseUrl) await clearAcks(id);
            if (warning) Object.defineProperty(ep, 'warning', { value: warning, enumerable: false });
            return ep;
        });
    }

    function deleteEndpoint(id) {
        return serial(async function () {
            const ep = await getEndpoint(id);
            if (!ep) throw invalid('Endpoint not found', 'notFound');
            const sets = await db.getAllConfigSets();
            const names = (sets || []).filter(function (s) { return s && s.aiEndpointId === id; })
                .map(function (s) { return s.name ? String(s.name) : (s.default === true ? 'Default' : 'Unnamed'); });
            if (names.length) {
                const e = invalid('This endpoint is used by ' + (names.length === 1 ? 'the configuration set ' : 'the configuration sets ') + names.join(', ') + '; choose another endpoint there first', 'inUse');
                e.sets = names;
                throw e;
            }
            await db.aiDelDoc(id);
            await clearAcks(id);
            return true;
        });
    }

    function publicEndpoint(ep) {
        if (!isObj(ep)) return null;
        const o = {};
        for (const k of Object.keys(ep)) if (k !== 'key' && k !== '_id' && k !== 'type') o[k] = ep[k];
        const k = ep.key;
        if (typeof o.extraInstructions !== 'string') o.extraInstructions = '';
        for (const g of GEN_FIELDS) if (o[g] === undefined) o[g] = null;   // endpoints saved before these settings existed
        if (o.thinkingMap === undefined) o.thinkingMap = null;
        if (!isObj(o.userModels)) o.userModels = { enabled: false, models: [] };
        if (!Array.isArray(o.capsByModel)) o.capsByModel = [];
        o.hasKey = !!(k && (k.env || k.ct));
        o.keyHint = !k ? '' : (typeof k.env === 'string' ? 'env:' + k.env : (k.last4 ? '…' + k.last4 : ''));
        return o;
    }

    function resolveKey(ep) {
        try { return ep && ep.key ? secrets.resolve(ep.key, ep.id) : null; } catch (e) { return null; }
    }

    function patch(id, fn) {
        return serial(async function () {
            const ep = await getEndpoint(id);
            if (!ep) return null;
            fn(ep);
            return putEndpoint(ep);
        });
    }
    function setCaps(id, caps, model) {
        return patch(id, function (ep) {
            const c = isObj(caps) ? sanitize(caps, 0) : null;
            if (model == null || model === ep.model) { ep.caps = c; return; }
            if (listedModels(ep).indexOf(model) < 0) return;
            const list = (Array.isArray(ep.capsByModel) ? ep.capsByModel : []).filter(function (e) { return isObj(e) && e.model !== model; });
            if (c) list.push({ model: model, caps: c });
            ep.capsByModel = list;
        });
    }
    function setNetwork(id, network) { return patch(id, function (ep) { if (['loopback', 'private', 'public'].indexOf(network) >= 0) ep.network = network; }); }
    function setQuirks(id, quirks) { return patch(id, function (ep) { ep.quirks = Object.assign({}, ep.quirks || {}, isObj(quirks) ? sanitize(quirks, 0) : {}); }); }
    function setLastTest(id, r) {
        return patch(id, function (ep) {
            ep.lastTest = isObj(r) ? { ok: r.ok === true, at: Number(r.at) || Date.now(), ms: Number(r.ms) || 0, detail: String(r.detail == null ? '' : r.detail).slice(0, 300) } : null;
        });
    }

    // ---- settings ----
    function putSettings(s) { return db.aiPutDoc('aiSettings', 'aiSettings', Object.assign({}, s, { sv: SETTINGS_VERSION })); }
    async function loadSettings() {
        let d = null;
        try { d = await db.aiGetDoc('aiSettings'); }
        catch (e) { warn('could not read settings (' + (e && e.message ? String(e.message).slice(0, 120) : 'error') + '); using defaults'); return null; }
        const migrated = migrateSettings(d);
        const s = mergeSettings(DEFAULTS, d);
        if (migrated) {
            try { await putSettings(s); }
            catch (e) { warn('could not save the migrated settings (' + (e && e.message ? String(e.message).slice(0, 120) : 'error') + ')'); }
        }
        return s;
    }
    async function getSettings() {
        if (!settingsCache) {
            // one load at a time, so a migration is written once even when several callers start together
            if (!settingsLoading) settingsLoading = loadSettings().finally(function () { settingsLoading = null; });
            const s = await settingsLoading;
            if (!s) return clone(DEFAULTS);
            if (!settingsCache) settingsCache = s;
        }
        return clone(settingsCache);
    }
    async function saveSettings(input) {
        const cur = await getSettings();
        const s = mergeSettings(cur, input);
        settingsCache = null;
        await putSettings(s);
        settingsCache = s;
        return clone(s);
    }

    // ---- acknowledgements ----
    function ackId(userid, epId) { return 'aiAck:' + userid + ':' + epId; }
    function ackArgs(userid, epId) { return typeof userid === 'string' && userid && userid.length <= 256 && typeof epId === 'string' && ID_RE.test(epId); }
    async function getAck(userid, epId) {
        if (!ackArgs(userid, epId)) return false;
        try { return !!(await db.aiGetDoc(ackId(userid, epId))); } catch (e) { return false; }
    }
    async function setAck(userid, epId) {
        if (!ackArgs(userid, epId)) return false;
        await db.aiPutDoc(ackId(userid, epId), 'aiAck', { userid: userid, epId: epId, extra: userid, time: Date.now() });
        return true;
    }

    // ---- audit ----
    async function auditAdd(rec) {
        try {
            if (!isObj(rec)) return false;
            const pre = Object.assign({}, rec);
            // tool arguments come from the model: keep them as text (any key is fine inside a string)
            if (Array.isArray(pre.steps)) pre.steps = pre.steps.map(function (s) {
                if (!isObj(s)) return s;
                const o = Object.assign({}, s);
                if (o.args != null && typeof o.args !== 'string') { try { o.args = JSON.stringify(o.args); } catch (e) { o.args = ''; } }
                if (typeof o.args === 'string' && o.args.length > 2000) o.args = o.args.slice(0, 2000) + '\u2026';
                return o;
            });
            const r = sanitize(pre, 0);
            delete r._id;
            if (!(Number(r.time) > 0)) r.time = Date.now();
            if (r.userid == null && typeof r.user === 'string') r.userid = r.user;
            if (r.nodeid == null && typeof r.node === 'string') r.nodeid = r.node;
            if (r.transcript != null) {
                const st = await getSettings();
                let size = 0;
                try { size = JSON.stringify(r.transcript).length; } catch (e) { size = Infinity; }
                if (!st.storeTranscripts) delete r.transcript;
                else if (size > MAX_TRANSCRIPT) { delete r.transcript; r.transcriptDropped = 'too large'; }
            }
            return (await db.aiAuditAdd(r)) !== false;
        } catch (e) {
            warn('audit write failed (' + (e && e.message ? String(e.message).slice(0, 120) : 'error') + ')');
            return false;
        }
    }
    function auditQuery(q) { return db.aiAuditQuery(q || {}); }
    async function usage(userid, sinceMs) {
        const out = { questions: 0, tokens: 0 };
        if (typeof userid !== 'string' || !userid) return out;
        try {
            const PAGE = 5000;
            for (let skip = 0, page = 0; page < 40; page++, skip += PAGE) {
                const r = await db.aiAuditQuery({ userid: userid, since: Number(sinceMs) || 0, skip: skip, limit: PAGE });
                const rows = (r && r.rows) || [];
                for (const x of rows) {
                    if (x.counted !== false) out.questions++;
                    let tin = Number(x.tokensIn), tout = Number(x.tokensOut);
                    if (!Number.isFinite(tin) && isObj(x.tokens)) tin = Number(x.tokens.in);
                    if (!Number.isFinite(tout) && isObj(x.tokens)) tout = Number(x.tokens.out);
                    out.tokens += (Number.isFinite(tin) && tin > 0 ? tin : 0) + (Number.isFinite(tout) && tout > 0 ? tout : 0);
                }
                if (rows.length < PAGE) break;
            }
        } catch (e) { warn('usage query failed (' + (e && e.message ? String(e.message).slice(0, 120) : 'error') + ')'); }
        return out;
    }
    async function sweep() {
        try {
            const st = await getSettings();
            return (await db.aiAuditSweep(Date.now() - st.retentionDays * 86400000)) || 0;
        } catch (e) { warn('audit sweep failed (' + (e && e.message ? String(e.message).slice(0, 120) : 'error') + ')'); return 0; }
    }

    return {
        listEndpoints, getEndpoint, saveEndpoint, deleteEndpoint, publicEndpoint, resolveKey, setCaps, setNetwork, setQuirks, setLastTest,
        validateEndpoint, keySource: function () { return secrets && secrets.source; },
        getSettings, saveSettings, mergeSettings, getAck, setAck, auditAdd, auditQuery, usage, sweep
    };
}

module.exports = { create, validateEndpoint, sanitize, mergeSettings, startersFor, allowedModels, isAllowedModel, listedModels, modelThinkingMap, capsFor, MAX_USER_MODELS, DEFAULTS, STARTERS, STARTER_OS, SETTINGS_VERSION, FORMATS, PRESETS, TOOL_MODES, ID_RE };
