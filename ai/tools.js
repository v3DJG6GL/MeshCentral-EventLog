'use strict';
// Read-only tools the model may call, bound server-side to ONE device (no tool takes a device id).
//
// create(S, deps) -> toolset {
//   defs                      [{ name, description, parameters }] offered in this conversation
//   names                     [name]
//   has(name)                 offered?
//   run(name, args, internal) -> Promise<{ ok, data | error, items }>  validated + executed, NOT redacted (digest.js)
//   exec(name, args, { capTokens }) -> Promise<{ content, isError, items, bytes, truncated }>
//                             validate -> run -> redact -> budget.fitJson -> prompts.fence (what goes to the model)
//   pack(label, data, maxTokens) -> { text, truncated } redacted + fitted JSON (not fenced; digest.js fences)
//   validate(name, args)      -> error string | null
// }
// S: { nodeid, node, rights, domain, userid, os, osVersion?, histOpts, refs, redactor, nonce, window?, suspicious:Set, softwareCache }
// deps: { db (plugin db), meshDb, getConnectivityState(nodeid), software (ai/software.js), categories, now(),
//         agentOnline(nodeid) -> bool, softwareTimeoutMs }
// categories -> tools: storedEvents: event_facets, event_groups, get_events, get_event, lookup_event_id;
//   deviceSummary (network / notes add to it): get_device_info; meshEvents: get_device_events;
//   software: get_installed_software (only when the rights allow it and the agent is online).

const prompts = require('./prompts.js');
const budget = require('./budget.js');
const groups = require('./groups.js');
const eventref = require('./eventref.js');
const devicedata = require('./devicedata.js');

const DAY = 86400000;
const MAX_AGE_MS = 400 * DAY;
const RIGHT_NOSOFTWARE = 0x00800000;
const RIGHT_ADMIN = 0xFFFFFFFF;
const DB_TIMEOUT_MS = 30000;
const LEVEL_NAMES = { 0: 'info', 1: 'crit', 2: 'err', 3: 'warn', 4: 'info', 5: 'verbose' };
const LEVEL_FILTER = { crit: [1], err: [2], warn: [3], info: [4, 0], verbose: [5] };

// ---- schemas ---------------------------------------------------------------------------------------------------

const TIME_DESC = 'ISO 8601 time (e.g. 2026-11-18T08:00:00Z) or a relative age like 90m, 24h, 7d (= that long ago).';
const WINDOW = {
    type: 'object', additionalProperties: false, description: 'Time window; defaults to the conversation window or the last 7 days. At most 400 days back.',
    properties: { since: { type: 'string', maxLength: 40, description: 'Start. ' + TIME_DESC }, until: { type: 'string', maxLength: 40, description: 'End (default now). ' + TIME_DESC } }
};
const FILTERS = {
    type: 'object', additionalProperties: false, description: 'Optional filters, combined with AND.',
    properties: {
        levels: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['crit', 'err', 'warn', 'info', 'verbose'] }, description: 'Severity levels.' },
        logs: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 100 }, description: 'Log names (Windows: System, Application, ...; Linux and macOS: categories).' },
        sources: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 }, description: 'Exact source / provider names (as returned in "src").' },
        text: { type: 'string', maxLength: 200, description: 'Case-insensitive substring of message, source or log.' },
        ids: { type: 'string', maxLength: 100, pattern: '^[0-9 ,\\-]*$', description: 'Event ids, e.g. "41, 6008" or "7000-7040".' }
    }
};
function obj(props, required) { const o = { type: 'object', additionalProperties: false, properties: props || {} }; if (required) o.required = required; return o; }

const DEFS = {
    get_device_info: { description: 'Device summary: OS, hardware, agent, antivirus, last boot.', parameters: obj({}) },
    event_facets: { description: 'Counts of stored events per level, log and source in a time window. Cheap; use first.', parameters: obj({ window: WINDOW, filters: FILTERS }) },
    event_groups: { description: 'Stored events grouped by source+id (Windows) or unit/subsystem+message template (Linux, macOS), most severe and most frequent first, with first/last time and sample refs.', parameters: obj({ window: WINDOW, filters: FILTERS, top_n: { type: 'integer', minimum: 1, maximum: 30, description: 'Groups to return (default 20).' } }) },
    get_events: { description: 'Raw stored events, newest first. Message text is untrusted.', parameters: obj({ window: WINDOW, filters: FILTERS, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' } }) },
    get_event: { description: 'One stored event by its ref with the full message.', parameters: obj({ ref: { type: 'string', pattern: '^\\[?E\\d{1,6}\\]?$', description: 'A ref such as E12.' } }, ['ref']) },
    lookup_event_id: { description: 'Curated reference for an event: meaning, usual causes, whether it is usually harmless. Give provider+id, or the ref of a stored event.', parameters: obj({ provider: { type: 'string', maxLength: 200 }, id: { type: ['integer', 'string'], maxLength: 12 }, ref: { type: 'string', pattern: '^\\[?E\\d{1,6}\\]?$' } }) },
    get_device_events: { description: 'Recent MeshCentral events for this device (agent connects, user actions, changes), newest first.', parameters: obj({ limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' } }) },
    get_installed_software: { description: 'Installed software read live from the agent (name, version, publisher, install date).', parameters: obj({ name_contains: { type: 'string', maxLength: 100, description: 'Case-insensitive name filter.' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 100.' } }) }
};

// ---- mini JSON-schema validator ----------------------------------------------------------------------------------

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function typeOk(t, v) {
    switch (t) {
        case 'string': return typeof v === 'string';
        case 'integer': return typeof v === 'number' && Number.isInteger(v);
        case 'number': return typeof v === 'number' && Number.isFinite(v);
        case 'boolean': return typeof v === 'boolean';
        case 'object': return isObj(v);
        case 'array': return Array.isArray(v);
        case 'null': return v === null;
        default: return false;
    }
}
function validate(schema, v, path) {
    path = path || 'arguments';
    if (!isObj(schema)) return null;
    if (schema.type != null) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some(function (t) { return typeOk(t, v); })) return path + ' must be ' + types.join(' or ');
    }
    if (Array.isArray(schema.enum) && schema.enum.indexOf(v) < 0) return path + ' must be one of: ' + schema.enum.join(', ');
    if (typeof v === 'string') {
        if (schema.minLength != null && v.length < schema.minLength) return path + ' is too short';
        if (schema.maxLength != null && v.length > schema.maxLength) return path + ' is longer than ' + schema.maxLength + ' characters';
        if (schema.pattern != null && !(new RegExp(schema.pattern).test(v))) return path + ' has an invalid format';
    }
    if (typeof v === 'number') {
        if (schema.minimum != null && v < schema.minimum) return path + ' must be at least ' + schema.minimum;
        if (schema.maximum != null && v > schema.maximum) return path + ' must be at most ' + schema.maximum;
    }
    if (Array.isArray(v)) {
        if (schema.minItems != null && v.length < schema.minItems) return path + ' needs at least ' + schema.minItems + ' items';
        if (schema.maxItems != null && v.length > schema.maxItems) return path + ' has more than ' + schema.maxItems + ' items';
        if (schema.items) for (let i = 0; i < v.length; i++) { const e = validate(schema.items, v[i], path + '[' + i + ']'); if (e) return e; }
    }
    if (isObj(v)) {
        const props = isObj(schema.properties) ? schema.properties : {};
        for (const r of (Array.isArray(schema.required) ? schema.required : [])) if (v[r] === undefined) return path + '.' + r + ' is required';
        for (const k of Object.keys(v)) {
            if (!Object.prototype.hasOwnProperty.call(props, k)) {
                if (schema.additionalProperties === false) return path + ' has an unknown property "' + String(k).slice(0, 40) + '"';
                continue;
            }
            const e = validate(props[k], v[k], path + '.' + k);
            if (e) return e;
        }
    }
    return null;
}
// Models often send null for "not set" and numbers as strings: normalize that much, nothing more.
function normalizeArgs(schema, v) {
    if (!isObj(v) || !isObj(schema) || !isObj(schema.properties)) return v;
    const o = {};
    for (const k of Object.keys(v)) {
        let x = v[k];
        if (x === null) continue;
        const ps = schema.properties[k];
        if (ps && isObj(ps)) {
            const types = Array.isArray(ps.type) ? ps.type : [ps.type];
            if (types.indexOf('integer') >= 0 && types.indexOf('string') < 0 && typeof x === 'string' && /^\s*-?\d{1,9}\s*$/.test(x)) x = Number(x);
            if (ps.type === 'object') x = normalizeArgs(ps, x);
        }
        o[k] = x;
    }
    return o;
}

// ---- helpers ------------------------------------------------------------------------------------------------------

function mapStrings(v, fn, depth) {
    depth = depth || 0;
    if (depth > 16) return v;
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map(function (x) { return mapStrings(x, fn, depth + 1); });
    if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = mapStrings(v[k], fn, depth + 1); return o; }
    return v;
}
function iso(t) { const d = new Date(Number(t)); return isNaN(d.getTime()) ? null : d.toISOString(); }
function parseTime(v, now) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v).trim();
    const m = /^(\d{1,6})\s*(m|min|mins|minutes?|h|hours?|d|days?|w|weeks?)$/i.exec(s);
    if (m) {
        const n = Number(m[1]), u = m[2].charAt(0).toLowerCase();
        return now - n * (u === 'm' ? 60000 : u === 'h' ? 3600000 : u === 'd' ? DAY : 7 * DAY);
    }
    if (/^\d{12,15}$/.test(s)) return Number(s);
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : NaN;
}
function withTimeout(p, ms, what) {
    return new Promise(function (resolve, reject) {
        const t = setTimeout(function () { reject(new Error(what + ' took too long')); }, ms);
        if (typeof t.unref === 'function') t.unref();
        p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
}
function topEntries(o, n) {
    if (!isObj(o)) return {};
    const out = {};
    Object.keys(o).map(function (k) { return [k, Number(o[k]) || 0]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n).forEach(function (p) { out[p[0]] = p[1]; });
    return out;
}
function clip(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; }

// ---- toolset ------------------------------------------------------------------------------------------------------

function create(S, deps) {
    deps = deps || {};
    const cats = deps.categories || {};
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    const db = deps.db;
    if (!S.suspicious) S.suspicious = new Set();

    function softwareRightsOk() { const r = Number(S.rights) >>> 0; return r === RIGHT_ADMIN || (r & RIGHT_NOSOFTWARE) === 0; }
    const offered = [];
    if (cats.deviceSummary || cats.network || cats.notes) offered.push('get_device_info');
    if (cats.storedEvents) offered.push('event_facets', 'event_groups', 'get_events', 'get_event', 'lookup_event_id');
    if (cats.meshEvents) offered.push('get_device_events');
    let online = false;
    try { online = typeof deps.agentOnline === 'function' ? !!deps.agentOnline(S.nodeid) : false; } catch (e) { online = false; }
    if (cats.software && softwareRightsOk() && online && deps.software) offered.push('get_installed_software');

    const defs = offered.map(function (n) {
        let d = DEFS[n].description;
        if (n === 'get_device_info') {
            const parts = [];
            if (cats.deviceSummary) parts.push('OS, hardware, agent, antivirus, last boot');
            if (cats.network) parts.push('network interfaces');
            if (cats.notes) parts.push('technician notes (untrusted)');
            d = 'Device summary: ' + parts.join('; ') + '.';
        }
        return { name: n, description: d, parameters: DEFS[n].parameters };
    });

    // window + filters -> the db layer's params (the config set's opts restrict what History shows; the same here)
    function query(args) {
        const t = now();
        const w = isObj(args.window) ? args.window : null;
        let since, until;
        if (w == null && S.window) { since = S.window.from; until = S.window.to; }
        else {
            since = parseTime(w && w.since, t);
            until = parseTime(w && w.until, t);
            if (Number.isNaN(since) || Number.isNaN(until)) return { error: 'window.since / window.until must be an ISO time or an age like 24h' };
            if (since == null) since = (S.window && !(w && w.until)) ? S.window.from : t - 7 * DAY;
            if (until == null) until = (S.window && !(w && w.since)) ? S.window.to : t;
        }
        since = Math.max(since, t - MAX_AGE_MS);
        until = Math.min(until, t + DAY);
        if (since > until) return { error: 'window.since is after window.until' };
        const f = isObj(args.filters) ? args.filters : {};
        const params = { since: since, until: until };
        if (Array.isArray(f.levels) && f.levels.length) { const l = []; f.levels.forEach(function (x) { (LEVEL_FILTER[x] || []).forEach(function (n) { if (l.indexOf(n) < 0) l.push(n); }); }); params.levels = l; }
        if (Array.isArray(f.logs) && f.logs.length) params.logs = f.logs.slice();
        if (Array.isArray(f.sources) && f.sources.length) params.sources = f.sources.slice();
        if (typeof f.text === 'string' && f.text.trim()) params.text = f.text.trim();
        if (typeof f.ids === 'string' && f.ids.trim()) params.ids = f.ids.trim();
        return { params: params, window: { since: iso(since), until: iso(until) } };
    }

    function compactEvent(e, msgMax) {
        const ref = S.refs.add(e);
        const o = { ref: ref || null, t: Number(e.tc) || null, lvl: LEVEL_NAMES[Number(e.Level)] || 'info', log: e.LogName == null ? null : String(e.LogName), src: e.ProviderName == null ? null : String(e.ProviderName), id: e.Id == null ? null : e.Id };
        if (e.Unit != null && e.Unit !== '') o.unit = String(e.Unit);
        // macOS unified log: os_log subsystem / category and the raw message type (Fault, Error, Default, ..., Panic)
        if (e.Subsystem != null && e.Subsystem !== '') o.subsystem = clip(e.Subsystem, 200);
        if (e.OsCategory != null && e.OsCategory !== '') o.os_category = clip(e.OsCategory, 200);
        if (e.MsgType != null && e.MsgType !== '') o.msg_type = clip(e.MsgType, 20);
        o.msg_untrusted = clip(e.Message, msgMax || 1000);
        if (prompts.suspicious(e.Message)) { o.injection_suspect = true; if (ref) S.suspicious.add(ref); }
        return o;
    }

    function dbCall(fn) { return withTimeout(new Promise(fn), DB_TIMEOUT_MS, 'The event database'); }
    function getEvents(params) {
        return dbCall(function (resolve) { db.getEventsFor(S.nodeid, S.histOpts || {}, params, function (events, total) { resolve({ events: events, total: total || 0 }); }); });
    }
    function scan(params, max) {
        return dbCall(function (resolve) {
            if (typeof db.scanEventsFor === 'function') db.scanEventsFor(S.nodeid, S.histOpts || {}, params, max, function (events, truncated, total) { resolve({ events: events || [], truncated: !!truncated, total: total || 0 }); });
            else db.getEventsFor(S.nodeid, S.histOpts || {}, Object.assign({}, params, { limit: 1000 }), function (events, total) { resolve({ events: events || [], truncated: (total || 0) > (events || []).length, total: total || 0 }); });
        });
    }
    function historyOff() { return S.histOpts && S.histOpts.historyEnabled === false; }

    const RUN = {
        get_device_info: async function () {
            const data = await devicedata.deviceInfo({ meshDb: deps.meshDb, nodeid: S.nodeid, node: S.node, categories: { deviceSummary: !!cats.deviceSummary, network: !!cats.network, notes: !!cats.notes }, getConnectivityState: deps.getConnectivityState, serials: false, osVersion: S.osVersion || null });
            return { ok: true, data: data, items: Object.keys(data).length };
        },
        event_facets: async function (a) {
            if (historyOff()) return { ok: false, error: 'Event history is disabled for this device' };
            const q = query(a); if (q.error) return { ok: false, error: q.error };
            const f = await dbCall(function (resolve) { db.getFacetsQuery(S.nodeid, S.histOpts || {}, q.params, resolve); });
            if (f == null) return { ok: false, error: 'The event database is not available' };
            const levels = {}; let total = 0;
            for (const k of Object.keys(f.level || {})) { const n = Number(f.level[k]) || 0; const name = LEVEL_NAMES[Number(k)] || 'info'; levels[name] = (levels[name] || 0) + n; total += n; }
            const data = { window: q.window, total: total, levels: levels, logs: topEntries(f.log, 30), sources: topEntries(f.source, 40) };
            return { ok: true, data: data, items: total };
        },
        event_groups: async function (a, internal) {
            if (historyOff()) return { ok: false, error: 'Event history is disabled for this device' };
            const q = query(a); if (q.error) return { ok: false, error: q.error };
            const r = await scan(q.params, 5000);
            const nSamples = internal && internal.sampleEvents ? Math.min(5, internal.sampleEvents) : 2;
            const gs = groups.groupEvents(r.events, { top: a.top_n || 20, samples: nSamples, os: S.os });
            const byId = new Map();
            const want = new Set(); gs.forEach(function (g) { g.sampleIds.forEach(function (id) { want.add(String(id)); }); });
            for (const e of r.events) if (want.has(String(e._id))) byId.set(String(e._id), e);
            const out = gs.map(function (g) {
                const o = { count: g.count, first: g.first, last: g.last, lvl: LEVEL_NAMES[g.level] || 'info', log: g.log || null, src: g.src || null, id: g.id === '' ? null : g.id };
                if (g.unit) o.unit = g.unit;
                if (g.subsystem) o.subsystem = g.subsystem;
                o.template_untrusted = g.template;
                if (prompts.suspicious(g.template)) o.injection_suspect = true;
                const samples = g.sampleIds.map(function (id) { return byId.get(String(id)); }).filter(Boolean);
                if (internal && internal.sampleEvents) o.samples = samples.map(function (e) { return compactEvent(e, 400); });
                else o.sample_refs = samples.map(function (e) { const c = compactEvent(e, 10); return c.ref; }).filter(Boolean);
                return o;
            });
            const data = { window: q.window, matched: r.total, scanned: r.events.length, groups: out };
            if (r.truncated) data.scan_truncated = true;
            return { ok: true, data: data, items: out.length };
        },
        get_events: async function (a, internal) {
            if (historyOff()) return { ok: false, error: 'Event history is disabled for this device' };
            const q = query(a); if (q.error) return { ok: false, error: q.error };
            const r = await getEvents(Object.assign({}, q.params, { limit: a.limit || 20 }));
            if (r.events == null) return { ok: false, error: 'Event history is disabled for this device' };
            let list = r.events;
            if (internal && internal.excludeId != null) list = list.filter(function (e) { return String(e._id) !== String(internal.excludeId); });
            const events = list.map(function (e) { return compactEvent(e, 1000); });
            return { ok: true, data: { window: q.window, total: r.total, returned: events.length, events: events }, items: events.length };
        },
        get_event: async function (a) {
            const e = S.refs.get(String(a.ref).replace(/[[\]\s]/g, ''));
            if (!e) return { ok: false, error: 'Unknown ref ' + String(a.ref).slice(0, 12) + '. Use a ref returned by another tool.' };
            const o = compactEvent(e, 4000);
            for (const k of ['Priority', 'Transport', 'Task', 'Opcode', 'Keywords', 'Qualifiers', 'RecordId']) if (e[k] != null && e[k] !== '' && typeof e[k] !== 'object') o[k.toLowerCase()] = e[k];
            if (e.ProcessPath != null && e.ProcessPath !== '' && typeof e.ProcessPath !== 'object') o.process_path = clip(e.ProcessPath, 400);
            return { ok: true, data: o, items: 1 };
        },
        lookup_event_id: async function (a) {
            let r = null;
            if (a.ref) {
                const e = S.refs.get(String(a.ref).replace(/[[\]\s]/g, ''));
                if (!e) return { ok: false, error: 'Unknown ref ' + String(a.ref).slice(0, 12) };
                const mac = S.os === 'macos' || (S.os !== 'linux' && S.os !== 'windows' && (e.Subsystem != null || e.MsgType != null));
                const linux = !mac && (S.os === 'linux' || e.Unit != null || e.Priority != null);
                if (mac) r = eventref.lookupMac(e.Message, e.ProviderName, e.Subsystem);
                else if (linux) r = eventref.lookupLinux(e.Message, e.Unit);
                // provider + id is the Windows reference; on macOS the id is a process id
                if (!mac && (!r || !r.known)) r = eventref.lookup(e.ProviderName, e.Id);
            } else {
                if (a.provider == null || a.id == null) return { ok: false, error: 'Give provider and id, or ref' };
                r = eventref.lookup(a.provider, a.id);
            }
            if (!r || !r.known) return { ok: true, data: { known: false, note: 'Not in the curated reference. If you explain it from general knowledge, say so.' }, items: 0 };
            return { ok: true, data: r, items: 1 };
        },
        get_device_events: async function (a) {
            const list = await devicedata.deviceEvents({ meshDb: deps.meshDb, nodeid: S.nodeid, domain: S.domain, userid: S.userid, rights: S.rights, limit: a.limit || 20 });
            return { ok: true, data: { events: list }, items: list.length };
        },
        get_installed_software: async function (a) {
            if (!softwareRightsOk()) return { ok: false, error: 'Not allowed on this device (No Software restriction)' };
            if (!S.softwareCache) {
                S.softwareCache = deps.software.request(S.nodeid, S.rights, deps.softwareTimeoutMs || 30000);
                S.softwareCache.catch(function () { S.softwareCache = null; });   // retry on the next call
            }
            let list;
            try { list = await S.softwareCache; }
            catch (e) {
                const m = { offline: 'The agent is offline', timeout: 'The agent did not answer in time', denied: 'The agent refused (No Software restriction)', unsupported: 'Not supported on this device' };
                return { ok: false, error: m[e && e.code] || 'Could not read the installed software' };
            }
            const needle = typeof a.name_contains === 'string' ? a.name_contains.trim().toLowerCase() : '';
            const matched = list.filter(function (x) { return !needle || String(x.name).toLowerCase().indexOf(needle) >= 0; })
                .sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
            const items = matched.slice(0, a.limit || 100).map(function (x) { const o = { name: x.name }; if (x.version) o.version = x.version; if (x.publisher) o.publisher = x.publisher; if (x.installDate) o.installDate = x.installDate; return o; });
            return { ok: true, data: { total: list.length, matched: matched.length, returned: items.length, items: items }, items: items.length };
        }
    };

    function has(name) { return offered.indexOf(name) >= 0; }
    function check(name, args) {
        if (!has(name)) return { error: 'Unknown or unavailable tool "' + String(name).slice(0, 40) + '". Available: ' + offered.join(', ') };
        if (args === null) return { error: 'The arguments are not valid JSON' };
        const schema = DEFS[name].parameters;
        const a = normalizeArgs(schema, args === undefined ? {} : args);
        const e = validate(schema, a, 'arguments');
        if (e) return { error: 'Invalid arguments: ' + e };
        return { args: a };
    }

    async function run(name, args, internal) {
        const c = check(name, args);
        if (c.error) return { ok: false, error: c.error, items: 0 };
        // the model only knows pseudonyms: search with the real values
        const real = S.redactor ? mapStrings(c.args, function (s) { return S.redactor.restore(s); }) : c.args;
        try {
            const r = await RUN[name](real, internal || null);
            return r && typeof r === 'object' ? Object.assign({ items: 0 }, r) : { ok: false, error: 'No result', items: 0 };
        } catch (e) {
            return { ok: false, error: 'The tool failed: ' + clip(e && e.message, 120), items: 0 };
        }
    }

    function pack(data, maxTokens) {
        const red = S.redactor ? S.redactor.redactValue(data) : data;
        const fit = budget.fitJson(red, maxTokens);
        if (S.refs && typeof S.refs.markIn === 'function') S.refs.markIn(fit.text);
        return fit;
    }

    async function exec(name, args, o) {
        o = o || {};
        const cap = Number(o.capTokens) > 0 ? Number(o.capTokens) : 2000;
        const r = await run(name, args, null);
        let content, truncated = false;
        if (!r.ok) {
            content = prompts.fence(S.nonce, name, JSON.stringify({ error: S.redactor ? S.redactor.redact(String(r.error)) : String(r.error) }));
        } else {
            const fit = pack(r.data, cap);
            truncated = fit.truncated;
            content = prompts.fence(S.nonce, name, fit.text);
        }
        return { content: content, isError: !r.ok, items: r.items || 0, bytes: Buffer.byteLength(content, 'utf8'), truncated: truncated, error: r.ok ? null : r.error };
    }

    return {
        defs: defs, names: offered.slice(), has: has, run: run, exec: exec, pack: pack,
        validate: function (name, args) { const c = check(name, args); return c.error || null; },
        compactEvent: compactEvent
    };
}

module.exports = { create, validate, normalizeArgs, parseTime, DEFS, LEVEL_NAMES };
