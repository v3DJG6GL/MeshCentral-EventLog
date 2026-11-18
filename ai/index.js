'use strict';
// Assistant facade for eventlog.js.
//
// create({ plugin, log, ...overrides }) -> { store, admin, secrets, sessions, accessInfo, handle, onAgentData, close }
//   plugin: the eventlog.js plugin object. Used: plugin.db (getEventsFor, scanEventsFor, getFacetsQuery,
//     getEventsByIds, getNodeMeta, getConfigFor), plugin.meshServer (.db Get / GetNodeEvents*WithLimit,
//     .webserver.wsagents / .httpsProxyAgent read lazily, GetConnectivityState, getConfigFilePath,
//     loginCookieEncryptionKey), plugin.hasPerm(user, key, node), plugin.safeSend(myparent, obj),
//     plugin.reauthorize(myparent, grandparent, nodeid) -> Promise<{ ok, node, rights, reason }>
//     (falls back to plugin.resolveNodeRights + hasPerm + Details right when reauthorize is missing).
//   overrides (tests): store, admin, secrets, netguard, llm, adapters, http, software, now, sessionOpts,
//     flushMs, softwareTimeoutMs, timeouts
//
// accessInfo(myparent, node, rights) -> Promise<{ assistant, assistantReason, endpoint, categories, remaining }> (never rejects)
//   when assistant is false for a reason other than 'permission': canManage (full administrator) and, for
//   'noEndpoint', configSetName (the device's config set; null when none was found)
// handle(command, myparent, grandparent) -> Promise (never rejects) for pluginaction aiStart / aiConfirm / aiSend /
//   aiFeedback (device rights and the permission were checked by eventlog.js; command._node / _rights are set) and
//   aiStop / aiClose (authorized here by session ownership: same user and same connection).
//   Every failure is answered with onAiError { nodeid, convId|null, reqId, code, message, retryable, phase? } (phase on
//   timeouts: 'connect' = the endpoint was never reached, 'idle', 'total').
// onAgentData(command, agentObj) -> bool   agent 'software' replies for get_installed_software
// close()                                   aborts every conversation (plugin reload / shutdown)

const crypto = require('crypto');
const sessionMod = require('./session.js');
const engine = require('./engine.js');
const toolsMod = require('./tools.js');
const digest = require('./digest.js');
const devicedata = require('./devicedata.js');
const softwareMod = require('./software.js');
const prompts = require('./prompts.js');
const budget = require('./budget.js');
const redactMod = require('./redact.js');

const RIGHT_DETAILS = 0x00100000;
const RIGHT_NOSOFTWARE = 0x00800000;
const RIGHT_ADMIN = 0xFFFFFFFF;
const HOUR = 3600000, DAY = 86400000;
const CAPS_MAX_AGE = DAY;
const MAX_TEXT = 4000;
const CATEGORIES = {
    deviceSummary: 'Device summary (OS, hardware, agent, antivirus, last boot)',
    network: 'Network interfaces and addresses',
    storedEvents: 'Stored event log entries',
    meshEvents: 'MeshCentral events for this device',
    notes: 'Device notes',
    software: 'Installed software (read live from the agent)'
};
const CAT_IDS = Object.keys(CATEGORIES);
const DEFAULT_SETTINGS = {
    enabled: false,
    limits: { maxRounds: 15, maxCalls: null, maxOutputTokens: 2048, timeoutSec: 120, maxSentKB: null },
    quotas: { perUserQuestions: 100, perUserTokens: 3000000 },
    retentionDays: 90, storeTranscripts: false, previewPolicy: 'every',
    redact: { users: true, hosts: true, domains: true, ips: true, macs: true, emails: true, sids: true, paths: true, secrets: true, serials: true },
    categories: { deviceSummary: true, network: false, storedEvents: true, meshEvents: false, notes: false, software: false }
};

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function iso(t) { const d = new Date(Number(t)); return isNaN(d.getTime()) ? '' : d.toISOString(); }
function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 200) : null; }
function normSettings(s) {
    s = isObj(s) ? s : {};
    const o = Object.assign({}, DEFAULT_SETTINGS, s);
    for (const k of ['limits', 'quotas', 'redact', 'categories']) o[k] = Object.assign({}, DEFAULT_SETTINGS[k], isObj(s[k]) ? s[k] : {});
    if (['every', 'once', 'never'].indexOf(o.previewPolicy) < 0) o.previewPolicy = 'every';
    o.enabled = o.enabled === true;
    return o;
}
function nullRedactor() {
    const s = function (x) { return x == null ? '' : String(x); };
    return { redact: s, redactValue: function (v) { return v; }, restore: s, restorer: function () { return { push: s, flush: function () { return ''; } }; }, counts: function () { return {}; }, total: function () { return 0; }, enabled: {} };
}
function guessOs(node, meta) {
    if (meta && (meta.os === 'linux' || meta.os === 'windows')) return meta.os;
    const d = String((node && node.osdesc) || '');
    if (/windows/i.test(d)) return 'windows';
    if (/linux|ubuntu|debian|centos|fedora|red hat|rhel|suse|alpine|arch|mint|raspbian|rocky|alma/i.test(d)) return 'linux';
    return null;
}
function utcMidnight(t) { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }

function create(o) {
    o = o || {};
    const plugin = o.plugin || {};
    const log = typeof o.log === 'function' ? o.log : function (m) { console.log(m); };
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const netguard = o.netguard || require('./netguard.js');
    const llm = o.llm || require('./llm.js');
    const adapters = o.adapters || require('./adapters/index.js');
    const http = o.http || require('./http.js');
    const ms = function () { return plugin.meshServer || {}; };
    const meshDb = function () { return ms().db || null; };
    const webserver = function () { return ms().webserver || null; };
    let closed = false;

    // ---- secrets / store / admin -----------------------------------------------------------------------------
    let secrets = o.secrets !== undefined ? o.secrets : null;
    if (o.secrets === undefined) {
        try {
            const keyFile = typeof ms().getConfigFilePath === 'function' ? ms().getConfigFilePath('plugin-eventlog-ai.key') : null;
            let fb = ms().loginCookieEncryptionKey;
            if (Buffer.isBuffer(fb)) fb = fb.toString('hex');
            secrets = require('./secrets.js').create({ keyFile: keyFile, fallbackSecret: typeof fb === 'string' && fb ? fb : null, log: log });
        } catch (e) { secrets = null; log('EVENTLOG AI: no usable key storage; the Assistant is unavailable'); }
    }
    let store = o.store || null;
    if (!store && secrets) {
        try { store = require('./store.js').create({ db: plugin.db, secrets: secrets, netguard: netguard, log: log }); }
        catch (e) { store = null; log('EVENTLOG AI: could not create the settings store (' + ((e && e.message) || e) + ')'); }
    }
    let admin = o.admin || null;
    if (!admin && store) {
        try {
            admin = require('./admin.js').create({ store: store, db: plugin.db, netguard: netguard, adapters: adapters, llm: llm, http: http, getProxyAgent: function () { const w = webserver(); return w ? w.httpsProxyAgent : undefined; }, log: log });
        } catch (e) { admin = null; log('EVENTLOG AI: could not create the admin handler (' + ((e && e.message) || e) + ')'); }
    }

    function getAgent(nodeid) { const w = webserver(); return (w && w.wsagents && w.wsagents[nodeid]) || null; }
    const software = o.software || softwareMod.create({ getAgent: getAgent });

    const sessions = sessionMod.create(Object.assign({ now: now, log: log, onClose: onSessionClose }, o.sessionOpts || {}));
    // audit retention: shortly after start, then every 6 hours
    const sweepTimers = [];
    if (store && typeof store.sweep === 'function' && o.sweep !== false) {
        const runSweep = function () { try { Promise.resolve(store.sweep()).catch(function () { }); } catch (e) { } };
        const t1 = setTimeout(runSweep, 5 * 60000), t2 = setInterval(runSweep, 6 * HOUR);
        try { t1.unref(); t2.unref(); } catch (e) { }
        sweepTimers.push(t1, t2);
    }
    const mem = new Map();        // userid -> { day, questions, tokens } counted in this process
    const inflight = new Map();   // userid -> running turns

    // ---- sending ------------------------------------------------------------------------------------------------
    function send(myparent, method, obj) {
        try { return plugin.safeSend(myparent, Object.assign({ method: method }, obj)) === true; } catch (e) { return false; }
    }
    function sendS(S, method, obj) { return send(S.myparent, method, Object.assign({ nodeid: S.nodeid, convId: S.convId }, obj)); }
    function sendError(myparent, nodeid, convId, reqId, code, message, retryable) {
        send(myparent, 'onAiError', { nodeid: nodeid || null, convId: convId || null, reqId: reqId == null ? null : reqId, code: code, message: message || code, retryable: !!retryable });
    }
    function onSessionClose(S, reason) {
        if (!S.busy && (reason === 'expired' || reason === 'evicted')) {
            sendS(S, 'onAiError', { reqId: null, code: 'aborted', message: reason === 'expired' ? 'The conversation expired' : 'The conversation was closed to make room for a new one', retryable: false });
        }
    }

    // ---- access ---------------------------------------------------------------------------------------------------
    function rightsAllowSoftware(rights) { const r = Number(rights) >>> 0; return r === RIGHT_ADMIN || (r & RIGHT_NOSOFTWARE) === 0; }
    function rightsAllowDetails(rights) { const r = Number(rights) >>> 0; return r === RIGHT_ADMIN || (r & RIGHT_DETAILS) !== 0; }
    function categoriesFor(settings, rights, requested) {
        const c = {};
        for (const id of CAT_IDS) c[id] = settings.categories[id] === true;
        if (!rightsAllowSoftware(rights)) c.software = false;
        if (Array.isArray(requested)) { for (const id of CAT_IDS) c[id] = c[id] && requested.indexOf(id) >= 0; }
        else if (isObj(requested)) { for (const id of CAT_IDS) if (requested[id] === false) c[id] = false; }
        return c;
    }
    function getConfig(node) {
        try { return Promise.resolve(plugin.db.getConfigFor(node._id, node.meshid)).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); }
    }
    async function gate(myparent, node, rights) {
        const user = myparent && myparent.user;
        let perm = false;
        try { perm = typeof plugin.hasPerm === 'function' && plugin.hasPerm(user, 'deviceAssistant', node) === true; } catch (e) { perm = false; }
        if (!perm) return { ok: false, reason: 'permission' };
        if (!rightsAllowDetails(rights)) return { ok: false, reason: 'deviceRights' };
        if (!store || closed) return { ok: false, reason: 'unavailable' };
        const settings = normSettings(await store.getSettings());
        if (!settings.enabled) return { ok: false, reason: 'disabled', settings: settings };
        const cfg = await getConfig(node);
        const epId = cfg && typeof cfg.aiEndpointId === 'string' ? cfg.aiEndpointId : '';
        const ep = epId ? await store.getEndpoint(epId) : null;
        if (!ep) return { ok: false, reason: 'noEndpoint', settings: settings, cfg: cfg };
        return { ok: true, settings: settings, ep: ep, cfg: cfg };
    }
    async function quota(userid, settings) {
        const t = now(), day = utcMidnight(t);
        let u = null;
        try { u = await store.usage(userid, day); } catch (e) { u = null; }
        u = isObj(u) ? u : { questions: 0, tokens: 0 };
        const m = mem.get(userid);
        const mq = m && m.day === day ? m.questions : 0, mt = m && m.day === day ? m.tokens : 0;
        const usedQ = Math.max(Number(u.questions) || 0, mq) + (inflight.get(userid) || 0);
        const usedT = Math.max(Number(u.tokens) || 0, mt);
        const ql = Number(settings.quotas.perUserQuestions) > 0 ? Number(settings.quotas.perUserQuestions) : null;
        const tl = Number(settings.quotas.perUserTokens) > 0 ? Number(settings.quotas.perUserTokens) : null;
        const remaining = (ql == null && tl == null) ? null : { questions: ql == null ? null : Math.max(0, ql - usedQ), tokens: tl == null ? null : Math.max(0, tl - usedT) };
        const ok = remaining == null || ((remaining.questions == null || remaining.questions > 0) && (remaining.tokens == null || remaining.tokens > 0));
        return { ok: ok, remaining: remaining };
    }
    function countUsage(userid, tokens) {
        const day = utcMidnight(now());
        let m = mem.get(userid);
        if (!m || m.day !== day) { m = { day: day, questions: 0, tokens: 0 }; mem.set(userid, m); }
        m.questions++; m.tokens += Math.max(0, Number(tokens) || 0);
    }
    async function networkOf(ep) {
        try { const c = await netguard.check(ep.baseUrl, { allowLinkLocal: !!ep.allowLinkLocal }); return c; } catch (e) { return { ok: false, error: 'check failed' }; }
    }

    // the redaction categories in effect for an endpoint on `network`: everything outside the private networks,
    // otherwise the admin's toggles
    function redactionFor(network, rt) {
        rt = rt || {};
        if (network !== 'loopback' && network !== 'private') return { secrets: true, emails: true, sids: true, macs: true, ips: true, users: true, paths: true, hosts: true, serials: true };
        return { secrets: !!rt.secrets, emails: !!rt.emails, sids: !!rt.sids, macs: !!rt.macs, ips: !!rt.ips, users: !!rt.users, paths: !!rt.paths, hosts: !!(rt.hosts || rt.domains), serials: !!rt.serials };
    }
    function anyOn(enabled) { return Object.keys(enabled).some(function (k) { return enabled[k]; }); }

    function isFullAdmin(myparent) {
        try { return typeof plugin.isFullAdmin === 'function' && plugin.isFullAdmin(myparent) === true; } catch (e) { return false; }
    }
    // the name shown for the device's config set ('Default' for the default set), null when none was found
    function configSetName(cfg) {
        if (!isObj(cfg)) return null;
        return str(cfg.name, 120) || (cfg.default === true ? 'Default' : null);
    }
    async function accessInfo(myparent, node, rights) {
        const out = { assistant: false, assistantReason: null, endpoint: null, categories: {}, remaining: null };
        try {
            const g = await gate(myparent, node, rights);
            if (g.settings) out.categories = categoriesFor(g.settings, rights, null);
            if (!g.ok) {
                out.assistantReason = g.reason;
                if (g.reason === 'permission') return out;   // nothing more for users without the permission
                if (isFullAdmin(myparent)) out.canManage = true;
                if (g.reason === 'noEndpoint') out.configSetName = configSetName(g.cfg);
                return out;
            }
            const c = await networkOf(g.ep);
            const network = c.ok ? c.network : null;
            const forced = network !== 'loopback' && network !== 'private';
            out.endpoint = {
                name: str(g.ep.name, 120) || '', model: str(g.ep.model, 200) || '', network: network,
                redactionForced: forced, redaction: forced ? 'forced' : (anyOn(redactionFor(network, g.settings.redact)) ? 'on' : 'off'),
                previewPolicy: g.settings.previewPolicy, toolMode: g.ep.toolMode || 'auto'
            };
            const q = await quota(myparent.user._id, g.settings);
            out.remaining = q.remaining;
            out.assistant = true;
            return out;
        } catch (e) {
            log('EVENTLOG AI: access check failed (' + ((e && e.message) || e) + ')');
            out.assistant = false; out.assistantReason = 'unavailable'; out.endpoint = null; out.remaining = null;
            delete out.configSetName;
            return out;
        }
    }

    // ---- authorization during a turn -----------------------------------------------------------------------------
    async function authorize(S) {
        try {
            if (closed || S.closed) return { ok: false, reason: 'closed' };
            if (typeof plugin.reauthorize === 'function') {
                const r = await plugin.reauthorize(S.myparent, S.grandparent, S.nodeid);
                if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || 'denied' };
                if (r.node) S.node = r.node;
                if (r.rights != null) S.rights = r.rights;
                return { ok: true };
            }
            if (typeof plugin.resolveNodeRights !== 'function') return { ok: false, reason: 'no rights check' };
            const nr = await new Promise(function (resolve) { plugin.resolveNodeRights(S.myparent, S.grandparent, S.nodeid, function (node, rights) { resolve({ node: node, rights: rights }); }); });
            if (nr.node == null || !plugin.hasPerm(S.myparent.user, 'deviceAssistant', nr.node) || !rightsAllowDetails(nr.rights)) return { ok: false, reason: 'denied' };
            S.node = nr.node; S.rights = nr.rights;
            return { ok: true };
        } catch (e) { return { ok: false, reason: 'error' }; }
    }

    // ---- endpoint capabilities and context --------------------------------------------------------------------------
    function probeDeps(S) {
        return {
            request: function (opts, onChunk) {
                const https = /^https:/i.test(String(opts && opts.url));
                return http.request(Object.assign({}, opts, { lookup: S.net.lookup || undefined, agent: https && S.net.agent ? S.net.agent : undefined }), onChunk);
            }
        };
    }
    async function resolveCaps(S, key) {
        const ep = S.ep;
        let caps = isObj(ep.caps) ? ep.caps : null;
        const fresh = caps && Number(caps.at) > now() - CAPS_MAX_AGE;
        if (fresh) return caps;
        const epK = { baseUrl: ep.baseUrl, model: ep.model, apiKey: key || null };
        // non-Ollama servers: tool support is assumed (a refusal switches to summary mode once); a context size an
        // earlier connection test detected is kept
        const prev = caps || {};
        caps = { tools: null, ctx: Number(prev.ctx) > 0 && prev.server !== 'ollama' ? Number(prev.ctx) : null, numCtx: null, server: prev.server && prev.server !== 'ollama' ? prev.server : null, at: now() };
        try {
            if (ep.format === 'openai-chat' && adapters.ollama) {
                const deps = probeDeps(S);
                const ver = await adapters.ollama.isOllama(epK, deps);
                if (ver) {
                    caps.server = 'ollama';
                    try { const s = await adapters.ollama.show(epK, deps); caps.tools = s.tools; caps.ctx = s.ctx || null; caps.numCtx = s.numCtx || null; } catch (e) { }
                }
            }
        } catch (e) { }
        try { Promise.resolve(store.setCaps(ep.id, caps)).catch(function () { }); } catch (e) { }
        ep.caps = caps;
        return caps;
    }
    function contextFor(S, caps, settings) {
        const ep = S.ep, notes = [];
        const isOllama = caps && caps.server === 'ollama';
        let ctx;
        if (Number(ep.contextTokens) > 0) ctx = Number(ep.contextTokens);
        else if (isOllama && Number(ep.numCtx) > 0) ctx = Number(ep.numCtx);
        else if (isOllama) {
            ctx = Number(caps.numCtx) > 0 ? Number(caps.numCtx) : Math.min(Number(caps.ctx) || 4096, 4096);
            notes.push('Ollama runs this model with its default context (about ' + ctx + ' tokens). Set a context size for the endpoint to give the model more room.');
        } else ctx = (caps && Number(caps.ctx) > 0) ? Number(caps.ctx) : 8192;
        let maxOutput = Number(ep.maxOutputTokens) > 0 ? Number(ep.maxOutputTokens) : (Number(settings.limits.maxOutputTokens) > 0 ? Number(settings.limits.maxOutputTokens) : 2048);
        maxOutput = Math.max(256, Math.min(maxOutput, Math.floor(ctx / 2)));
        const ollamaNative = !!(isOllama && Number(ep.numCtx) > 0 && ep.format === 'openai-chat');
        return { ctx: ctx, maxOutput: maxOutput, input: budget.inputBudget(ctx, maxOutput), notes: notes, ollamaNative: ollamaNative };
    }

    // ---- composing ----------------------------------------------------------------------------------------------------
    function dbGetEvents(nodeid, opts, params) {
        return new Promise(function (resolve) {
            try { plugin.db.getEventsFor(nodeid, opts || {}, params, function (events) { resolve(Array.isArray(events) ? events : []); }); } catch (e) { resolve([]); }
        });
    }
    function dbEventsByIds(nodeid, ids) {
        return new Promise(function (resolve) {
            try { plugin.db.getEventsByIds(nodeid, ids, function (events) { resolve(Array.isArray(events) ? events : []); }); } catch (e) { resolve([]); }
        });
    }
    function nodeMeta(nodeid) {
        return new Promise(function (resolve) {
            try { if (typeof plugin.db.getNodeMeta !== 'function') return resolve(null); plugin.db.getNodeMeta(nodeid, function (m) { resolve(m || null); }); } catch (e) { resolve(null); }
        });
    }
    async function restartWindow(S) {
        const t = now();
        const all = [0, 1, 2, 3, 4, 5];
        let found = null;
        const q = S.os === 'linux'
            ? { limit: 1, levels: all, text: 'Linux version', since: t - 400 * DAY }
            : { limit: 1, levels: all, ids: '41, 6005, 6008, 6009, 12, 1074', sources: ['Microsoft-Windows-Kernel-Power', 'EventLog', 'Microsoft-Windows-Kernel-General', 'User32'], since: t - 400 * DAY };
        const ev = await dbGetEvents(S.nodeid, S.histOpts, q);
        if (ev.length && Number(ev[0].tc) > 0) found = Number(ev[0].tc);
        const lb = Number(S.node && S.node.lastbootuptime);
        if (lb > t - 400 * DAY && lb <= t && (!found || lb > found)) found = lb;
        if (!found) return { from: t - DAY, to: t, restartAt: null };
        return { from: found - 6 * HOUR, to: Math.min(found + HOUR, t), restartAt: found };
    }
    function systemPrompt(S, toolNames) {
        const st = S.settings || {};
        return prompts.system(S.mode, { nonce: S.nonce, deviceName: S.redactor.redact(String((S.node && S.node.name) || 'this device')), os: S.os, tools: toolNames, redacted: !!S.redacted, now: now(), window: S.window || null },
            { prompts: isObj(st.prompts) ? st.prompts : null, extraInstructions: st.extraInstructions, endpointExtra: S.ep && S.ep.extraInstructions });
    }
    async function compose(S) {
        const summary = S.toolMode === 'summary';
        const digestTokens = Math.floor(S.budget.input * 0.5);
        const cap = engine.capTokens(S.budget.input);
        let text = '';
        if (S.mode === 'explain') {
            const ref = S.refs.add(S.event);
            S.refs.mark(ref);
            S.digestInput = { ref: ref, event: S.event };
            text = 'Explain the stored event [' + ref + '] from this device.' + (summary || !S.tools.names.length ? '' : ' Use the tools if related events or device data would help.');
            if (summary && S.tools.has('get_event')) {
                const dg = await digest.build({ tools: S.tools, mode: 'explain', input: S.digestInput, budgetTokens: digestTokens, nonce: S.nonce, now: now });
                if (dg.text) text += '\n\n' + dg.text;
            } else {
                // the event the technician picked is always the subject, even with the stored events category off
                const fit = S.tools.pack(S.tools.compactEvent(S.event, 4000), cap);
                text += '\n\n' + prompts.fence(S.nonce, 'event', fit.text);
                if (summary) {
                    const dg = await digest.build({ tools: S.tools, mode: 'explain', input: S.digestInput, budgetTokens: digestTokens, nonce: S.nonce, now: now });
                    if (dg.text) text += '\n\n' + dg.text;
                }
            }
        } else if (S.mode === 'diagnose') {
            S.digestInput = { window: S.window };
            text = 'Diagnose this device for the time window ' + iso(S.window.from) + ' to ' + iso(S.window.to) +
                (S.window.restartAt ? ' (around the most recent restart, at ' + iso(S.window.restartAt) + ')' : '') +
                '. Find errors, crashes, restarts, service, disk and hardware problems, and how they relate.';
            if (summary) {
                const dg = await digest.build({ tools: S.tools, mode: 'diagnose', input: S.digestInput, budgetTokens: digestTokens, nonce: S.nonce, now: now });
                if (dg.text) text += '\n\n' + dg.text;
            }
        } else {
            S.digestInput = {};
            const q = S.redactor.redact(S.question);
            if (summary) {
                const dg = await digest.build({ tools: S.tools, mode: 'ask', input: {}, budgetTokens: digestTokens, nonce: S.nonce, now: now });
                text = (dg.text ? 'Data from this device (last 24 hours):\n\n' + dg.text + '\n\n' : '') + 'Question: ' + q;
            } else text = q;
        }
        return text;
    }
    function buildTools(S) {
        S.tools = toolsMod.create(S, {
            db: plugin.db, meshDb: meshDb(), categories: S.categories, now: now, software: software,
            softwareTimeoutMs: o.softwareTimeoutMs,
            getConnectivityState: function (nodeid) { const m = ms(); return typeof m.GetConnectivityState === 'function' ? m.GetConnectivityState(nodeid) : undefined; },
            agentOnline: function (nodeid) { return getAgent(nodeid) != null; }
        });
        S.transcript.system = systemPrompt(S, S.toolMode === 'tools' ? S.tools.names : []);
    }
    function preview(S, firstText) {
        const defs = S.toolMode === 'tools' ? S.tools.defs : [];
        const readable = [
            { label: 'Instructions to the model', text: S.transcript.system },
            { label: 'First message', text: firstText },
            { label: 'Tools the model may call', text: defs.length ? defs.map(function (d) { return d.name + ': ' + d.description; }).join('\n') : 'None (the data is included in the first message)' }
        ];
        const raw = JSON.stringify({ system: S.transcript.system, messages: [{ role: 'user', content: firstText }], tools: defs }, null, 2);
        const allowed = categoriesFor(S.settings, S.rights, null);
        return {
            readable: readable, raw: raw,
            categories: CAT_IDS.filter(function (id) { return allowed[id]; }).map(function (id) { return { id: id, label: CATEGORIES[id], on: !!S.categories[id] }; }),
            redactionCounts: S.redactor.counts()
        };
    }

    // ---- running a turn ------------------------------------------------------------------------------------------------
    async function startTurn(S, text) {
        if (!sessions.acquire(S)) { sendS(S, 'onAiError', { reqId: S.turn === 0 ? S.reqId : null, code: 'busy', message: 'Another question is still running', retryable: true }); return; }
        const uid = S.userid;
        inflight.set(uid, (inflight.get(uid) || 0) + 1);
        try {
            let key = null;
            // S.ep is the session's copy without the stored key: read the key from the stored endpoint per turn
            try { const cur = await store.getEndpoint(S.ep.id); key = await store.resolveKey(cur || S.ep); } catch (e) { key = null; }
            const adapter = adapters.get(S.ep.format);
            if (!adapter) { sendS(S, 'onAiError', { reqId: S.reqId, code: 'model', message: 'Unknown API format', retryable: false }); return; }
            const epBase = { id: S.ep.id, baseUrl: S.ep.baseUrl, model: S.ep.model, maxOutputTokens: S.budget.maxOutput, numCtx: Number(S.ep.numCtx) > 0 ? Number(S.ep.numCtx) : null, ollamaNative: S.budget.ollamaNative, quirks: S.ep.quirks || null, format: S.ep.format };
            const lim = S.settings.limits;
            const tmo = Object.assign({ idleMs: 60000, connectMs: 10000, totalMs: (Number(S.ep.timeoutSec) > 0 ? Number(S.ep.timeoutSec) : (Number(lim.timeoutSec) > 0 ? Number(lim.timeoutSec) : 120)) * 1000 }, o.timeouts || {});
            await engine.runTurn(S, text, {
                llm: llm, adapter: adapter, store: store, settings: S.settings, log: log, now: now,
                epCall: function () { return Object.assign({}, epBase, { quirks: S.ep.quirks || null, apiKey: key || null }); },
                net: S.net, tools: S.tools, budget: S.budget, timeouts: tmo, flushMs: o.flushMs,
                send: function (m, obj) { return sendS(S, m, obj); },
                authorize: function () { return authorize(S); },
                closeSession: function (reason) { sessions.close(S, reason); },
                getEventsByIds: function (ids) { return dbEventsByIds(S.nodeid, ids); },
                buildDigest: function (tokens) { return digest.build({ tools: S.tools, mode: S.mode, input: S.digestInput, budgetTokens: tokens, nonce: S.nonce, now: now }); },
                systemPrompt: function (names) { return systemPrompt(S, names); },
                onToolsUnsupported: function () {
                    const caps = Object.assign({}, S.ep.caps || {}, { tools: false, at: now() });
                    S.ep.caps = caps;
                    try { Promise.resolve(store.setCaps(S.ep.id, caps)).catch(function () { }); } catch (e) { }
                }
            });
            key = null;
            const lt = S.lastTurn || {};
            countUsage(uid, (lt.tokensIn || 0) + (lt.tokensOut || 0));
        } catch (e) {
            log('EVENTLOG AI: turn error (' + ((e && e.message) || e) + ')');
            sendS(S, 'onAiError', { reqId: S.reqId, code: 'internal', message: 'Internal error', retryable: false });
        } finally {
            const n = (inflight.get(uid) || 1) - 1;
            if (n > 0) inflight.set(uid, n); else inflight.delete(uid);
            sessions.release(S);
        }
    }

    // ---- actions ---------------------------------------------------------------------------------------------------------
    const REASON_CODE = { permission: 'denied', deviceRights: 'denied', disabled: 'denied', noEndpoint: 'noEndpoint', unavailable: 'internal' };
    const REASON_MSG = {
        permission: 'You do not have the Event Log: Assistant permission for this device', deviceRights: 'The Assistant needs the Details right on this device',
        disabled: 'The Assistant is turned off', noEndpoint: 'No Assistant endpoint is assigned to this device', unavailable: 'The Assistant is not available on this server'
    };

    async function aiStart(command, myparent, grandparent) {
        const reqId = typeof command.reqId === 'string' || typeof command.reqId === 'number' ? String(command.reqId).slice(0, 64) : null;
        const node = command._node, rights = command._rights;
        const nodeid = node && node._id;
        const fail = function (code, msg, retry) { sendError(myparent, nodeid || command.nodeid, null, reqId, code, msg, retry); };
        if (!node || !myparent || !myparent.user) return fail('denied', 'No access to this device');
        const mode = command.mode;
        if (mode !== 'explain' && mode !== 'diagnose' && mode !== 'ask') return fail('invalid', 'Unknown mode');
        const input = isObj(command.input) ? command.input : {};
        let question = null, eventId = null, windowKey = null;
        if (mode === 'explain') { if (typeof input.eventId !== 'string' && typeof input.eventId !== 'number') return fail('invalid', 'No event given'); eventId = String(input.eventId); if (!eventId || eventId.length > 64) return fail('invalid', 'Bad event id'); }
        else if (mode === 'diagnose') { windowKey = input.window == null ? '24h' : input.window; if (['24h', '7d', 'restart'].indexOf(windowKey) < 0) return fail('invalid', 'Unknown time window'); }
        else { if (typeof input.text !== 'string' || !input.text.trim()) return fail('invalid', 'Empty question'); if (input.text.length > MAX_TEXT) return fail('invalid', 'The question is longer than ' + MAX_TEXT + ' characters'); question = input.text.trim(); }

        const g = await gate(myparent, node, rights);
        if (!g.ok) return fail(REASON_CODE[g.reason] || 'denied', REASON_MSG[g.reason] || 'Not available');
        const settings = g.settings, ep = g.ep;
        const userid = myparent.user._id;
        const q = await quota(userid, settings);
        if (!q.ok) return fail('quota', 'Your daily Assistant limit is used up');
        if (!sessions.canBusy(userid)) return fail('busy', 'Too many questions are running; try again shortly', true);
        const check = await networkOf(ep);
        if (!check.ok) return fail('blocked', 'The endpoint address is not allowed (' + String(check.error || 'blocked').slice(0, 200) + ')');
        const network = check.network;

        let ev = null;
        if (mode === 'explain') {
            const list = await dbEventsByIds(nodeid, [eventId]);
            ev = list.find(function (e) { return String(e._id) === eventId; }) || null;
            if (!ev) return fail('invalid', 'The event was not found for this device');
        }
        const meta = await nodeMeta(nodeid);
        const os = guessOs(node, meta);
        let histOpts = g.cfg ? Object.assign({}, g.cfg) : {};
        if (os === 'linux' && histOpts.historyLogs != null) delete histOpts.historyLogs;
        const si = await devicedata.getDoc(meshDb(), 'si' + nodeid);

        const enabled = redactionFor(network, settings.redact);
        const redacted = anyOn(enabled);
        const redactor = redacted ? redactMod.create({ seeds: devicedata.seeds(node, si), enabled: enabled }) : nullRedactor();

        const https = /^https:/i.test(String(ep.baseUrl));
        const net = { lookup: check.lookup || undefined, agent: (https && network === 'public') ? (function () { const w = webserver(); return w ? w.httpsProxyAgent : undefined; })() : undefined, network: network };
        const epSafe = Object.assign({}, ep); delete epSafe.key; delete epSafe.apiKey;

        const opened = sessions.open({
            userid: userid, username: myparent.user.name || null, ws: myparent.ws, myparent: myparent, grandparent: grandparent,
            domain: (myparent.domain && myparent.domain.id) || node.domain || '', nodeid: nodeid, meshid: node.meshid, node: node, rights: rights,
            mode: mode, ep: epSafe, net: net, redactor: redactor, redacted: redacted, settings: settings, reqId: reqId, os: os, histOpts: histOpts,
            nonce: prompts.newNonce(), answers: [], suspicious: new Set(), event: ev, question: question
        });
        if (!opened.ok) return fail('busy', 'Too many conversations are open', true);
        const S = opened.S;
        try {
            const caps = await resolveCaps(S, await Promise.resolve(store.resolveKey(ep)).catch(function () { return null; }));
            S.toolModeAuto = !(ep.toolMode === 'summary' || ep.toolMode === 'tools');
            S.toolMode = ep.toolMode === 'summary' ? 'summary' : (ep.toolMode === 'tools' ? 'tools' : (caps && caps.tools === false ? 'summary' : 'tools'));
            S.budget = contextFor(S, caps, settings);
            S.categories = categoriesFor(settings, rights, command.categories);
            if (mode === 'diagnose') {
                if (windowKey === 'restart') S.window = await restartWindow(S);
                else { const t = now(); S.window = { from: t - (windowKey === '7d' ? 7 * DAY : DAY), to: t, restartAt: null }; }
            }
            buildTools(S);
            const firstText = await compose(S);
            if (S.closed) return;
            sendS(S, 'onAiStarted', { reqId: reqId, mode: mode, endpointName: str(ep.name, 120) || '', model: str(ep.model, 200) || '', network: network, redacted: redacted, toolMode: S.toolMode, notes: S.budget.notes });
            let needPreview = false;
            if (network === 'public' && settings.previewPolicy !== 'never') {
                if (settings.previewPolicy === 'every') needPreview = true;
                else { let ack = false; try { ack = (await store.getAck(userid, ep.id)) === true; } catch (e) { ack = false; } needPreview = !ack; }
            }
            if (needPreview) {
                S.previewPending = { text: firstText };
                sendS(S, 'onAiPreview', preview(S, firstText));
                return;
            }
            await startTurn(S, firstText);
        } catch (e) {
            log('EVENTLOG AI: could not start (' + ((e && e.message) || e) + ')');
            sendS(S, 'onAiError', { reqId: reqId, code: 'internal', message: 'Internal error', retryable: false });
            sessions.close(S, 'error');
        }
    }

    async function aiConfirm(command, myparent) {
        const S = sessions.owned(command.convId, myparent);
        if (!S || !S.previewPending) return sendError(myparent, command.nodeid, null, null, 'invalid', 'Nothing to confirm');
        if (command._node == null || command._node._id !== S.nodeid) return sendError(myparent, command.nodeid, S.convId, S.reqId, 'denied', 'Wrong device');
        S.rights = command._rights != null ? command._rights : S.rights;
        const pending = S.previewPending;
        S.previewPending = null;
        let text = null;
        const cur = S.categories;
        const next = categoriesFor(S.settings, S.rights, command.categories != null ? command.categories : null);
        for (const id of CAT_IDS) next[id] = next[id] && cur[id];
        const changed = CAT_IDS.some(function (id) { return next[id] !== cur[id]; });
        if (changed) { S.categories = next; buildTools(S); text = await compose(S); }
        else text = pending.text;
        if (command.remember === true) { try { await store.setAck(S.userid, S.ep.id); } catch (e) { } }
        const q = await quota(S.userid, S.settings);
        if (!q.ok) { sendS(S, 'onAiError', { reqId: S.reqId, code: 'quota', message: 'Your daily Assistant limit is used up', retryable: false }); return; }
        await startTurn(S, text);
    }

    async function aiSend(command, myparent) {
        const S = sessions.owned(command.convId, myparent);
        if (!S) return sendError(myparent, command.nodeid, command.convId, null, 'invalid', 'This conversation is no longer open');
        if (command._node == null || command._node._id !== S.nodeid) return sendError(myparent, command.nodeid, S.convId, null, 'denied', 'Wrong device');
        if (S.mode !== 'ask') return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'Follow-up questions are only possible in Ask');
        if (S.previewPending) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'Confirm the data preview first');
        if (S.busy) return sendError(myparent, S.nodeid, S.convId, null, 'busy', 'The previous answer is still running', true);
        if (S.turn >= sessions.maxTurns) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'This conversation is at its limit of ' + sessions.maxTurns + ' questions; start a new chat');
        if (typeof command.text !== 'string' || !command.text.trim()) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'Empty question');
        if (command.text.length > MAX_TEXT) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'The question is longer than ' + MAX_TEXT + ' characters');
        if (command._rights != null) S.rights = command._rights;
        if (!rightsAllowDetails(S.rights)) return sendError(myparent, S.nodeid, S.convId, null, 'denied', REASON_MSG.deviceRights);
        const q = await quota(S.userid, S.settings);
        if (!q.ok) return sendError(myparent, S.nodeid, S.convId, null, 'quota', 'Your daily Assistant limit is used up');
        await startTurn(S, S.redactor.redact(command.text.trim()));
    }

    function aiFeedback(command, myparent) {
        const target = ['answer', 'explain', 'hyp'].indexOf(command.target) >= 0 ? command.target : null;
        const vote = typeof command.vote === 'string' ? command.vote.replace(/[^\w-]/g, '').slice(0, 20) : (typeof command.vote === 'number' ? String(Math.max(-1, Math.min(1, Math.round(command.vote)))) : null);
        if (!target || !vote || !command._node) return sendError(myparent, command.nodeid, command.convId || null, null, 'invalid', 'Bad feedback');
        const rec = {
            time: now(), kind: 'feedback', userid: myparent.user._id, username: myparent.user.name || null, nodeid: command._node._id,
            convId: typeof command.convId === 'string' ? command.convId.slice(0, 64) : null, turn: Math.max(0, Math.floor(Number(command.turn) || 0)),
            target: target, hid: typeof command.hid === 'string' ? command.hid.replace(/[^\w-]/g, '').slice(0, 20) : null, vote: vote, counted: false
        };
        try { return Promise.resolve(store && store.auditAdd(rec)).catch(function () { }); } catch (e) { }
    }

    function aiStop(command, myparent) {
        const S = sessions.owned(command.convId, myparent);
        if (S && S.busy && typeof S.abort === 'function') S.abort('stopped');
    }
    function aiClose(command, myparent) {
        const S = sessions.owned(command.convId, myparent);
        if (S) sessions.close(S, 'closed');
    }

    async function handle(command, myparent, grandparent) {
        try {
            if (command == null || myparent == null) return;
            if (closed) return sendError(myparent, command.nodeid, command.convId || null, command.reqId || null, 'internal', 'The Assistant is restarting', true);
            switch (command.pluginaction) {
                case 'aiStart': return await aiStart(command, myparent, grandparent);
                case 'aiConfirm': return await aiConfirm(command, myparent);
                case 'aiSend': return await aiSend(command, myparent);
                case 'aiFeedback': return await aiFeedback(command, myparent);
                case 'aiStop': return aiStop(command, myparent);
                case 'aiClose': return aiClose(command, myparent);
                default: return;
            }
        } catch (e) {
            try { log('EVENTLOG AI: ' + String(command && command.pluginaction).slice(0, 20) + ' failed (' + ((e && e.message) || e) + ')'); } catch (e2) { }
            sendError(myparent, command && command.nodeid, command && typeof command.convId === 'string' ? command.convId : null, command && command.reqId, 'internal', 'Internal error', false);
        }
    }

    function onAgentData(command, agentObj) { try { return software.onAgentData(command, agentObj); } catch (e) { return false; } }

    function close() {
        closed = true;
        try { sessions.closeAll('reload'); } catch (e) { }
        try { sessions.stop(); } catch (e) { }
        try { software.close(); } catch (e) { }
        for (const t of sweepTimers) { try { clearTimeout(t); clearInterval(t); } catch (e) { } }
    }

    return {
        store: store, admin: admin, secrets: secrets, sessions: sessions, software: software,
        accessInfo: accessInfo, handle: handle, onAgentData: onAgentData, close: close,
        _categoriesFor: categoriesFor, CATEGORIES: CATEGORIES
    };
}

module.exports = { create, CATEGORIES, normSettings };
