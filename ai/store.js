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
//     allowLinkLocal, network, caps, quirks, lastTest, updated }
//   key: null | { v, iv, ct, tag, last4 } (AES-GCM, AAD = endpoint id) | { env: 'VAR' }
//   listEndpoints() -> Promise<[ep]> (sorted by name)      getEndpoint(id) -> Promise<ep|null>
//   saveEndpoint(input, { keyAction:'keep'|'set'|'remove', key }) -> Promise<ep>
//       rejects Error{code:'invalid'|'notFound', message (shown to the admin)}; a non-fatal note (DNS lookup
//       failed, so network is null) is attached as the non-enumerable property ep.warning.
//       keyAction 'keep' keeps the stored key even when the address (host) changes: the admin edits both fields
//       in one form and re-entering a key for every address fix would only invite pasting keys around. A change
//       of address, model or format clears caps/quirks/lastTest (they described the old target) and the
//       preview acknowledgements for the endpoint (users confirm again what is sent where).
//   deleteEndpoint(id) -> Promise<true>  rejects Error{code:'inUse', sets:[names]} while a config set uses it
//   publicEndpoint(ep) -> copy without `key`, plus hasKey and keyHint ('…abcd' | 'env:VAR' | '')
//   resolveKey(ep) -> plaintext | null (never throws)
//   setCaps(id, caps) / setQuirks(id, quirks) (merged) / setLastTest(id, r) -> Promise<ep|null>
//   validateEndpoint(input) -> fields (sync syntax check, throws Error{code:'invalid'}), used for drafts too
//   keySource() -> secrets.source
// Settings (id 'aiSettings'): getSettings() -> defaults merged with the stored document (cached);
//   saveSettings(input) -> Promise<settings>: known fields only, numbers clamped, enums checked; fields missing
//   from input keep their current value. Quotas of 0 mean "no limit".
// Acknowledgements: getAck(userid, epId) -> Promise<bool>, setAck(userid, epId) -> Promise<bool>.
// Audit: auditAdd(rec) -> Promise<bool> (never rejects; adds time; userid/nodeid copied from user/node strings;
//   keys with '.' or a leading '$' dropped, steps[*].args stringified; transcript dropped unless
//   settings.storeTranscripts and capped at 256 KB), auditQuery(q), usage(userid, sinceMs) ->
//   Promise<{questions, tokens}> (never rejects; zeros + log on a database error), sweep() -> Promise<removed>.

const crypto = require('crypto');

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

const DEFAULTS = {
    enabled: true,
    limits: { maxRounds: 8, maxOutputTokens: 2048, timeoutSec: 120, maxSentKB: 400 },
    quotas: { perUserQuestions: 40, perUserTokens: 300000 },
    retentionDays: 90,
    storeTranscripts: false,
    previewPolicy: 'every',
    redact: { users: true, hosts: true, domains: true, ips: true, macs: true, emails: true, sids: true, paths: true, secrets: true, serials: false },
    categories: { deviceSummary: true, network: true, storedEvents: true, meshEvents: true, notes: false, software: false }
};
const RANGES = {
    limits: { maxRounds: [1, 30], maxOutputTokens: [64, 128000], timeoutSec: [10, 900], maxSentKB: [16, 8192] },
    quotas: { perUserQuestions: [0, 100000], perUserTokens: [0, 1000000000] },
    retentionDays: [1, 3650]
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }
function invalid(message, code) { const e = new Error(message); e.code = code || 'invalid'; return e; }

function clampInt(v, range, fallback) {
    if (v === '' || v == null || typeof v === 'boolean') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(range[1], Math.max(range[0], Math.round(n)));
}

// Syntax-only endpoint validation (no DNS). Throws Error{code:'invalid'}.
function validateEndpoint(input) {
    if (!isObj(input)) throw invalid('Missing endpoint data');
    const out = {};
    const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (!name || name.length > 64) throw invalid('Name must be 1 to 64 characters');
    out.name = name;
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
    if (!model) throw invalid('Model is required');
    if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw invalid('Model must be at most 200 characters without control characters');
    out.model = model;

    for (const k of Object.keys(INT_FIELDS)) {
        const f = INT_FIELDS[k], v = input[k];
        if (v == null || v === '') { out[k] = k === 'timeoutSec' ? 120 : null; continue; }
        const n = typeof v === 'boolean' ? NaN : Number(v);
        if (!Number.isInteger(n) || n < f.min || n > f.max) throw invalid(f.label + ' must be a whole number from ' + f.min + ' to ' + f.max);
        out[k] = n;
    }
    out.toolMode = TOOL_MODES.indexOf(input.toolMode) >= 0 ? input.toolMode : 'auto';
    out.allowLinkLocal = input.allowLinkLocal === true;
    return out;
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
    let settingsCache = null;
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
            const target = existing && (existing.baseUrl !== f.baseUrl || existing.model !== f.model || existing.format !== f.format);
            const keep = existing && !target;
            const ep = Object.assign({ id: id }, f, {
                key: key, network: network,
                caps: keep ? (existing.caps || null) : null,
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
    function setCaps(id, caps) { return patch(id, function (ep) { ep.caps = isObj(caps) ? sanitize(caps, 0) : null; }); }
    function setQuirks(id, quirks) { return patch(id, function (ep) { ep.quirks = Object.assign({}, ep.quirks || {}, isObj(quirks) ? sanitize(quirks, 0) : {}); }); }
    function setLastTest(id, r) {
        return patch(id, function (ep) {
            ep.lastTest = isObj(r) ? { ok: r.ok === true, at: Number(r.at) || Date.now(), ms: Number(r.ms) || 0, detail: String(r.detail == null ? '' : r.detail).slice(0, 300) } : null;
        });
    }

    // ---- settings ----
    function mergeSettings(base, input) {
        const s = clone(base);
        if (!isObj(input)) return s;
        if (typeof input.enabled === 'boolean') s.enabled = input.enabled;
        if (typeof input.storeTranscripts === 'boolean') s.storeTranscripts = input.storeTranscripts;
        if (PREVIEW.indexOf(input.previewPolicy) >= 0) s.previewPolicy = input.previewPolicy;
        s.retentionDays = clampInt(input.retentionDays, RANGES.retentionDays, s.retentionDays);
        for (const grp of ['limits', 'quotas']) {
            if (!isObj(input[grp])) continue;
            for (const k of Object.keys(DEFAULTS[grp])) s[grp][k] = clampInt(input[grp][k], RANGES[grp][k], s[grp][k]);
        }
        for (const grp of ['redact', 'categories']) {
            if (!isObj(input[grp])) continue;
            for (const k of Object.keys(DEFAULTS[grp])) if (typeof input[grp][k] === 'boolean') s[grp][k] = input[grp][k];
        }
        return s;
    }
    async function getSettings() {
        if (!settingsCache) {
            let d = null;
            try { d = await db.aiGetDoc('aiSettings'); }
            catch (e) { warn('could not read settings (' + (e && e.message ? String(e.message).slice(0, 120) : 'error') + '); using defaults'); return clone(DEFAULTS); }
            settingsCache = mergeSettings(DEFAULTS, d);
        }
        return clone(settingsCache);
    }
    async function saveSettings(input) {
        const cur = await getSettings();
        const s = mergeSettings(cur, input);
        settingsCache = null;
        await db.aiPutDoc('aiSettings', 'aiSettings', s);
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
        listEndpoints, getEndpoint, saveEndpoint, deleteEndpoint, publicEndpoint, resolveKey, setCaps, setQuirks, setLastTest,
        validateEndpoint, keySource: function () { return secrets && secrets.source; },
        getSettings, saveSettings, getAck, setAck, auditAdd, auditQuery, usage, sweep
    };
}

module.exports = { create, validateEndpoint, sanitize, DEFAULTS, FORMATS, PRESETS, TOOL_MODES, ID_RE };
