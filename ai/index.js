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
//   with the Assistant available also saved { enabled, retentionDays? } (saved results) and starters [text] (the
//   starter questions for the device's OS, Windows for an unknown OS)
//   when assistant is false for a reason other than 'permission': canManage (full administrator) and, for
//   'noEndpoint', configSetName (the device's config set; null when none was found)
// handle(command, myparent, grandparent) -> Promise (never rejects) for pluginaction aiStart / aiConfirm / aiSend /
//   aiFeedback / aiHistoryList / aiHistoryGet / aiHistoryDelete / aiChatEdit (device rights and the permission were checked by
//   eventlog.js; command._node / _rights are set) and
//   aiStop / aiClose (authorized here by session ownership: same user and same connection).
//   Every failure is answered with onAiError { nodeid, convId|null, reqId, code, message, retryable, phase? } (phase on
//   timeouts: 'connect' = the endpoint was never reached, 'idle', 'total').
//   Saved results (ai/history.js), always for myparent.user._id on the resolved device only:
//   aiHistoryList {}              -> onAiHistory { nodeid, available, enabled, retentionDays, chats:[{id,title,updated,
//                                    created,count}], diagnosis:{generatedAt, window}|null, explains:[{eventId, time}] }
//   aiHistoryGet {kind, id}       -> onAiHistoryItem { nodeid, kind, id, item|null }
//   aiHistoryDelete {kind, id}    -> onAiHistoryDeleted { nodeid, kind, id, ok }
//   aiStart {mode:'ask', chatId}  continues a saved chat in a new session with a recap (an unknown id starts a new chat);
//   onAiStarted / onAiDone of Ask and Diagnose carry the chatId the turn is saved under.
//   A diagnosis is a chat: its first answer is the diagnosis, aiSend continues it with follow-up questions (mode 'ask'
//   from then on, the same model session).
//   aiChatEdit {chatId|convId, index, op:'delete'|'truncate', q?} -> onAiChatEdited { nodeid, chatId|null, convId|null,
//     ok, deleted?, chat? (the saved chat as it is now), count? (messages left in a conversation that is not saved),
//     code? ('busy'|'notFound'|'changed'|'invalid') }: removes message index (op 'delete') or it and every later one
//     ('truncate') of the caller's saved chat on this device, or of the caller's open conversation when results are
//     not saved (the server keeps its messages for the conversation's lifetime). The next question runs in a new
//     model session whose recap is built from the messages left (a saved chat: aiStart with chatId; a conversation:
//     aiSend, the recap goes along); the events they cite keep their refs. Never while a request of that chat runs.
//   aiFeedback {convId, turn, target:'hyp', hid, vote:'wrong'|'reopen'}: a possible cause of a diagnosis marked as
//     wrong or reopened (audited, not counted); anything else is refused.
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
const historyMod = require('./history.js');
const storeMod = require('./store.js');

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
    categories: { deviceSummary: true, network: false, storedEvents: true, meshEvents: false, notes: false, software: false },
    history: { enabled: true, retentionDays: 30 }, starters: { windows: null, linux: null }
};

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function iso(t) { const d = new Date(Number(t)); return isNaN(d.getTime()) ? '' : d.toISOString(); }
function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 200) : null; }
function normSettings(s) {
    s = isObj(s) ? s : {};
    const o = Object.assign({}, DEFAULT_SETTINGS, s);
    for (const k of ['limits', 'quotas', 'redact', 'categories', 'history', 'starters']) o[k] = Object.assign({}, DEFAULT_SETTINGS[k], isObj(s[k]) ? s[k] : {});
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
    // saved results (chats, the last diagnosis, explanations); null when the database has no store for them
    let history = o.history !== undefined ? o.history : null;
    if (o.history === undefined && store && plugin.db) {
        try { history = historyMod.create({ db: plugin.db, getSettings: function () { return store.getSettings(); }, now: now, log: log }); }
        catch (e) { history = null; log('EVENTLOG AI: saved results are unavailable (' + ((e && e.message) || e) + ')'); }
    }
    let admin = o.admin || null;
    if (!admin && store) {
        try {
            admin = require('./admin.js').create({ store: store, history: history, db: plugin.db, netguard: netguard, adapters: adapters, llm: llm, http: http, getProxyAgent: function () { const w = webserver(); return w ? w.httpsProxyAgent : undefined; }, log: log });
        } catch (e) { admin = null; log('EVENTLOG AI: could not create the admin handler (' + ((e && e.message) || e) + ')'); }
    }

    function getAgent(nodeid) { const w = webserver(); return (w && w.wsagents && w.wsagents[nodeid]) || null; }
    const software = o.software || softwareMod.create({ getAgent: getAgent });

    const sessions = sessionMod.create(Object.assign({ now: now, log: log, onClose: onSessionClose }, o.sessionOpts || {}));
    // audit and saved-results retention: shortly after start, then every 6 hours
    const sweepTimers = [];
    if (store && typeof store.sweep === 'function' && o.sweep !== false) {
        const runSweep = function () {
            try { Promise.resolve(store.sweep()).catch(function () { }); } catch (e) { }
            try { if (history) Promise.resolve(history.sweep()).catch(function () { }); } catch (e) { }
        };
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
            let hc = null;
            try { hc = history ? await history.config() : null; } catch (e) { hc = null; }
            out.saved = hc && hc.enabled ? { enabled: true, retentionDays: hc.retentionDays } : { enabled: false };
            out.starters = storeMod.startersFor(g.settings, guessOs(node, await nodeMeta(node._id)));
            out.assistant = true;
            return out;
        } catch (e) {
            log('EVENTLOG AI: access check failed (' + ((e && e.message) || e) + ')');
            out.assistant = false; out.assistantReason = 'unavailable'; out.endpoint = null; out.remaining = null;
            delete out.configSetName; delete out.saved; delete out.starters;
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
        const wasOllama = /^ollama\b/i.test(String(prev.server || ''));
        caps = { tools: null, ctx: Number(prev.ctx) > 0 && !wasOllama ? Number(prev.ctx) : null, numCtx: null, server: prev.server && !wasOllama ? prev.server : null, at: now() };
        // what a connection test found about thinking and the server's defaults is kept (Ollama: read again below)
        if (isObj(prev.thinking)) caps.thinking = prev.thinking;
        if (isObj(prev.genDefaults)) caps.genDefaults = prev.genDefaults;
        try {
            if (ep.format === 'openai-chat' && adapters.ollama) {
                const deps = probeDeps(S);
                const ver = await adapters.ollama.isOllama(epK, deps);
                if (ver) {
                    caps.server = 'ollama';
                    try {
                        const s = await adapters.ollama.show(epK, deps);
                        caps.tools = s.tools; caps.ctx = s.ctx || null; caps.numCtx = s.numCtx || null;
                        if (s.thinking) caps.thinking = s.thinking;
                        if (s.genDefaults) caps.genDefaults = s.genDefaults;
                    } catch (e) { }
                }
            }
        } catch (e) { }
        try { Promise.resolve(store.setCaps(ep.id, caps)).catch(function () { }); } catch (e) { }
        ep.caps = caps;
        return caps;
    }
    // the same numbers the admin page shows under "Applied by the Assistant" (budget.applied)
    function contextFor(S, caps, settings) {
        const a = budget.applied(S.ep, caps, settings.limits);
        return { ctx: a.ctx, maxOutput: a.maxOutput, input: budget.inputBudget(a.ctx, a.maxOutput), notes: a.notes, ollamaNative: a.ollamaNative };
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
    // the browser's time zone (aiStart / aiSend: tz = IANA name, tzOffsetMin = minutes east of UTC); null when neither
    // is usable. An unknown zone name is dropped (Intl throws), the offset alone still says how to convert.
    function tzOf(command) {
        let name = (typeof command.tz === 'string' && command.tz.length <= 64 && /^[A-Za-z_+\-\/0-9]+$/.test(command.tz)) ? command.tz : null;
        if (name) { try { new Intl.DateTimeFormat('en', { timeZone: name }); } catch (e) { name = null; } }
        const off = (typeof command.tzOffsetMin === 'number' && Number.isInteger(command.tzOffsetMin) && command.tzOffsetMin >= -840 && command.tzOffsetMin <= 840) ? command.tzOffsetMin : null;
        return (name || off != null) ? { name: name, offsetMin: off } : null;
    }
    function systemPrompt(S, toolNames) {
        const st = S.settings || {};
        return prompts.system(S.mode, { nonce: S.nonce, deviceName: S.redactor.redact(String((S.node && S.node.name) || 'this device')), os: S.os, tools: toolNames, redacted: !!S.redacted, now: now(), window: S.window || null, tz: S.tz || null },
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
            // a saved chat continued in a new session: its recap comes first (fenced: earlier model output is data)
            const rc = S.recap ? prompts.fence(S.nonce, 'recap', S.recap) + '\n\n' : '';
            if (summary) {
                const dg = await digest.build({ tools: S.tools, mode: 'ask', input: {}, budgetTokens: digestTokens, nonce: S.nonce, now: now });
                text = rc + (dg.text ? 'Data from this device (last 24 hours):\n\n' + dg.text + '\n\n' : '') + 'Question: ' + q;
            } else text = rc + q;
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

    // ---- saved results (ai/history.js) ------------------------------------------------------------------------------
    // after onAiDone: Ask turns go into the chat document, a diagnosis replaces the last one, an explanation the
    // previous one for that event. Saving never affects the turn; a failure is only logged.
    function saveResult(S, done, info) {
        if (!history || !S.historyOn) return;
        const base = { userid: S.userid, nodeid: S.nodeid, done: done, steps: (info && info.steps) || [], endpointName: S.ep.name || '', model: S.ep.model || '' };
        let p = null;
        if (S.mode === 'ask') {
            if (!S.chatId) return;
            p = history.saveChatTurn(Object.assign(base, { chatId: S.chatId, question: S.pendingQ || '', cont: S.contPending === true }));
            S.contPending = false;
        } else if (S.mode === 'diagnose' && S.turn === 1) {
            if (!S.chatId) return;
            p = history.saveChatTurn(Object.assign(base, { chatId: S.chatId, question: historyMod.diagQuestion(S.windowKey), type: 'diagnosis', window: S.windowKey, range: S.window }));
        }
        else if (S.mode === 'explain' && S.turn === 1 && S.event) p = history.saveExplain(Object.assign(base, { eventId: String(S.event._id) }));
        if (p) Promise.resolve(p).then(function (ok) { if (ok === false) log('EVENTLOG AI: the result was not saved'); }, function (e) { log('EVENTLOG AI: saving the result failed (' + ((e && e.message) || e) + ')'); });
    }
    function stripMarks(t) { return String(t == null ? '' : t).replace(/\uE002[a-z]{1,12}\uE003([^\uE002-\uE004]*)\uE004/g, '$1').replace(/[\uE000-\uE00F]/g, ''); }
    function eventLabel(ev) {
        const src = ev.ProviderName != null && ev.ProviderName !== '' ? ev.ProviderName : (ev.Unit || '');
        return [ev.LogName || '', src, ev.Id == null ? '' : String(ev.Id)].filter(Boolean).join(' ') + (Number(ev.tc) > 0 ? ' at ' + iso(ev.tc) : '');
    }
    // A saved chat continued in a new session: the earlier questions and answers (pseudonymized for this session)
    // become the recap of the first message, and the events cited earlier are registered again under their refs, so
    // the model can cite them and the browser's citation chips keep pointing to the same events.
    async function buildRecap(S, prior) {
        const msgs = (Array.isArray(prior.messages) ? prior.messages : []).filter(isObj);
        const byRef = new Map();
        for (let i = msgs.length - 1; i >= 0; i--) {
            const c = isObj(msgs[i].cites) ? msgs[i].cites : {};
            for (const r of Object.keys(c)) if (/^E\d{1,6}$/.test(r) && !byRef.has(r) && isObj(c[r]) && c[r]._id != null && (c[r].nodeid == null || c[r].nodeid === S.nodeid)) byRef.set(r, c[r]);
        }
        const num = function (r) { return Number(r.slice(1)); };
        const refs = Array.from(byRef.keys()).sort(function (a, b) { return num(b) - num(a); }).slice(0, 150).sort(function (a, b) { return num(a) - num(b); });
        const fresh = refs.length ? await dbEventsByIds(S.nodeid, refs.map(function (r) { return String(byRef.get(r)._id); })) : [];
        const freshById = new Map(fresh.map(function (e) { return [String(e._id), e]; }));
        const lines = [];
        for (const r of refs) {
            const st = byRef.get(r);
            const ev = freshById.get(String(st._id)) || st;
            if (S.refs.addAs(ev, r)) { S.refs.mark(r); if (lines.length < 60) lines.push(r + ': ' + clipS(S.redactor.redact(eventLabel(ev)), 160)); }
        }
        S.answers = msgs.map(function (m) { return { q: S.redactor.redact(stripMarks(m.q)), a: S.redactor.redact(stripMarks(savedAnswerText(m))) }; });
        const maxChars = Math.max(2000, Math.floor((S.budget && S.budget.input ? S.budget.input : 8192) * 0.25 * 3));
        const last = msgs.length ? Number(msgs[msgs.length - 1].time) : 0;
        S.recap = engine.recapText(S.answers, {
            intro: 'Recap of this saved chat: the technician\'s earlier questions and your answers' + (last > 0 ? ' (last one at ' + iso(last) + ')' : '') + '. The chat continues now; the device data may have changed since.',
            max: 8, maxChars: maxChars,
            refsLine: lines.length ? 'Events cited earlier (their refs are still valid):\n' + lines.join('\n') : ''
        });
    }
    function clipS(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
    // the recap's text of a saved answer: a diagnosis by its structured parts too
    function savedAnswerText(m) {
        const d = isObj(m.structured) && (Array.isArray(m.structured.hypotheses) || typeof m.structured.summary === 'string') && !('meaning' in m.structured) ? prompts.diagnosisText(m.structured) : '';
        return d ? d + (m.a ? '\n\n' + m.a : '') : m.a;
    }
    // After each answer: what a later recap of this conversation needs (as sent to the model) and the events the
    // answer cited, kept for the conversation's lifetime (the message actions work on it when nothing is saved).
    function logAnswer(S, done) {
        const last = S.answers[S.answers.length - 1];
        if (!last) return;
        if (S.mode === 'ask') last.q = S.redactor.redact(S.pendingQ || '');
        else if (S.mode === 'diagnose') last.q = historyMod.diagQuestion(S.windowKey);
        if (S.mode === 'explain') return;
        S.log.push({ q: S.mode === 'diagnose' ? historyMod.diagQuestion(S.windowKey) : (S.pendingQ || ''), diag: S.mode === 'diagnose', refs: Object.keys((done && done.citations) || {}).filter(function (r) { return /^E\d{1,6}$/.test(r); }) });
        if (S.log.length > 200) S.log.shift();
    }
    // A new model session in the same conversation (an edited, deleted or retried message): the transcript starts
    // over with a recap of the messages left; the refs they cite stay registered and count as seen.
    function resetSession(S) {
        const refs = [];
        S.log.forEach(function (x) { x.refs.forEach(function (r) { if (refs.indexOf(r) < 0 && S.refs.has(r)) refs.push(r); }); });
        S.refs.returned.clear();
        const lines = [];
        refs.slice(-150).forEach(function (r) { S.refs.mark(r); const ev = S.refs.get(r); if (ev && lines.length < 60) lines.push(r + ': ' + clipS(S.redactor.redact(eventLabel(ev)), 160)); });
        S.transcript = { system: S.transcript.system, items: [] };
        S.segment = 0;
        const maxChars = Math.max(2000, Math.floor((S.budget && S.budget.input ? S.budget.input : 8192) * 0.25 * 3));
        S.recap = engine.recapText(S.answers, {
            intro: 'Recap of this chat: the technician\'s earlier questions and your answers. The chat continues now.',
            max: 8, maxChars: maxChars,
            refsLine: lines.length ? 'Events cited earlier (their refs are still valid):\n' + lines.join('\n') : ''
        });
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
            // generation settings (null = the server's default; the adapters send only what is set, Anthropic none)
            for (const k of ['thinking', 'temperature', 'topP', 'topK', 'seed']) epBase[k] = S.ep[k] == null ? null : S.ep[k];
            const lim = S.settings.limits;
            const tmo = Object.assign({ idleMs: 60000, connectMs: 10000, totalMs: (Number(S.ep.timeoutSec) > 0 ? Number(S.ep.timeoutSec) : (Number(lim.timeoutSec) > 0 ? Number(lim.timeoutSec) : 120)) * 1000 }, o.timeouts || {});
            await engine.runTurn(S, text, {
                llm: llm, adapter: adapter, store: store, settings: S.settings, log: log, now: now,
                epCall: function () { return Object.assign({}, epBase, { quirks: S.ep.quirks || null, apiKey: key || null }); },
                net: S.net, tools: S.tools, budget: S.budget, timeouts: tmo, flushMs: o.flushMs,
                send: function (m, obj) { if (m === 'onAiDone' && S.chatId) obj.chatId = S.chatId; return sendS(S, m, obj); },
                onDone: function (done, info) { try { logAnswer(S, done); } catch (e) { } saveResult(S, done, info); },
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
        if (command.chatId != null && (mode !== 'ask' || typeof command.chatId !== 'string' || !historyMod.CHAT_ID_RE.test(command.chatId))) return fail('invalid', 'Unknown chat');

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
        // saved results: a continued chat is loaded for this user and device only; an unknown or foreign id starts a new
        // chat (under a new id) instead of telling whether it exists
        let hcfg = null, prior = null, chatId = null;
        try { hcfg = history ? await history.config() : null; } catch (e) { hcfg = null; }
        const historyOn = !!(hcfg && hcfg.enabled);
        if (mode === 'ask' && historyOn) {
            if (command.chatId) { try { prior = await history.get(userid, nodeid, 'chat', command.chatId); } catch (e) { prior = null; } }
            chatId = prior ? prior.id : history.newChatId();
        } else if (mode === 'diagnose' && historyOn) chatId = history.newChatId();   // a diagnosis is a chat too

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
            nonce: prompts.newNonce(), answers: [], suspicious: new Set(), event: ev, question: question,
            historyOn: historyOn, chatId: chatId, pendingQ: question, contPending: !!prior, windowKey: windowKey, tz: tzOf(command),
            kind: mode === 'diagnose' ? 'diagnosis' : (mode === 'ask' ? (prior && prior.type === 'diagnosis' ? 'diagnosis' : 'chat') : 'explain'), log: []
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
            if (prior) await buildRecap(S, prior);
            const firstText = await compose(S);
            if (S.closed) return;
            sendS(S, 'onAiStarted', { reqId: reqId, mode: mode, endpointName: str(ep.name, 120) || '', model: str(ep.model, 200) || '', network: network, redacted: redacted, toolMode: S.toolMode, notes: S.budget.notes, chatId: chatId, continued: !!prior });
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
        // a diagnosis continues as a chat once its answer is there
        if (S.mode !== 'ask' && !(S.mode === 'diagnose' && S.answers.length)) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'Follow-up questions are only possible in Ask');
        if (S.previewPending) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'Confirm the data preview first');
        if (S.busy) return sendError(myparent, S.nodeid, S.convId, null, 'busy', 'The previous answer is still running', true);
        if (S.turn >= sessions.maxTurns) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'This conversation is at its limit of ' + sessions.maxTurns + ' questions; start a new chat');
        if (typeof command.text !== 'string' || !command.text.trim()) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'Empty question');
        if (command.text.length > MAX_TEXT) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'The question is longer than ' + MAX_TEXT + ' characters');
        if (command.chatId != null && command.chatId !== S.chatId) return sendError(myparent, S.nodeid, S.convId, null, 'invalid', 'Wrong chat');
        if (command._rights != null) S.rights = command._rights;
        if (!rightsAllowDetails(S.rights)) return sendError(myparent, S.nodeid, S.convId, null, 'denied', REASON_MSG.deviceRights);
        const q = await quota(S.userid, S.settings);
        if (!q.ok) return sendError(myparent, S.nodeid, S.convId, null, 'quota', 'Your daily Assistant limit is used up');
        const tz = tzOf(command); if (tz) S.tz = tz;
        if (S.mode === 'diagnose') {   // follow-up questions in a diagnosis chat: the Ask task, the same model session
            S.mode = 'ask';
            S.transcript.system = systemPrompt(S, S.toolMode === 'tools' ? S.tools.names : []);
        }
        S.pendingQ = command.text.trim();
        let text = S.redactor.redact(S.pendingQ);
        // the first question of a continued chat failed: the recap was rolled back with it and goes along again
        if (S.recap && !S.transcript.items.length) text = prompts.fence(S.nonce, 'recap', S.recap) + '\n\n' + text;
        await startTurn(S, text);
    }

    // aiHistoryList / aiHistoryGet / aiHistoryDelete: the saved results of this user on this device (eventlog.js
    // checked the permission and the Details right; checked here again). Never another user's or device's items.
    const HKINDS = ['chat', 'diagnosis', 'explain'];
    async function aiHistory(command, myparent) {
        const act = command.pluginaction, node = command._node;
        const user = myparent && myparent.user;
        if (!node || !user || typeof user._id !== 'string') return sendError(myparent, command.nodeid, null, null, 'denied', 'No access to this device');
        let perm = false;
        try { perm = typeof plugin.hasPerm === 'function' && plugin.hasPerm(user, 'deviceAssistant', node) === true; } catch (e) { perm = false; }
        if (!perm || !rightsAllowDetails(command._rights)) return sendError(myparent, node._id, null, null, 'denied', REASON_MSG[perm ? 'deviceRights' : 'permission']);
        const userid = user._id, nodeid = node._id;
        const kind = HKINDS.indexOf(command.kind) >= 0 ? command.kind : null;
        let key = command.id;
        if (typeof key === 'number' && Number.isFinite(key)) key = String(key);
        if (key != null && (typeof key !== 'string' || key.length > 64)) key = null;
        if (act === 'aiHistoryList') {
            let r = { enabled: false, retentionDays: null, chats: [], diagnosis: null, explains: [] };
            if (history && !closed) { try { r = await history.list(userid, nodeid); } catch (e) { log('EVENTLOG AI: could not list saved results (' + ((e && e.message) || e) + ')'); r.error = true; } }
            return send(myparent, 'onAiHistory', Object.assign({ nodeid: nodeid, available: !!history }, r));
        }
        if (!kind || (kind !== 'diagnosis' && !key)) return sendError(myparent, nodeid, null, null, 'invalid', 'Unknown saved item');
        if (act === 'aiHistoryGet') {
            let item = null;
            if (history && !closed) { try { item = await history.get(userid, nodeid, kind, key); } catch (e) { item = null; log('EVENTLOG AI: could not read a saved result (' + ((e && e.message) || e) + ')'); } }
            return send(myparent, 'onAiHistoryItem', { nodeid: nodeid, kind: kind, id: kind === 'diagnosis' ? null : key, item: item });
        }
        let ok = false;
        if (history && !closed) { try { ok = await history.remove(userid, nodeid, kind, key); } catch (e) { ok = false; log('EVENTLOG AI: could not delete a saved result (' + ((e && e.message) || e) + ')'); } }
        // an open conversation of this chat stops saving into it
        if (ok && kind === 'chat') for (const S of sessions.forUser(userid)) if (S.chatId === key && S.nodeid === nodeid) S.chatId = null;
        return send(myparent, 'onAiHistoryDeleted', { nodeid: nodeid, kind: kind, id: kind === 'diagnosis' ? null : key, ok: ok });
    }

    // aiChatEdit: the message actions (edit, delete, retry) of the caller's chat on this device
    async function aiChatEdit(command, myparent) {
        const node = command._node, user = myparent && myparent.user;
        if (!node || !user || typeof user._id !== 'string') return sendError(myparent, command.nodeid, null, null, 'denied', 'No access to this device');
        let perm = false;
        try { perm = typeof plugin.hasPerm === 'function' && plugin.hasPerm(user, 'deviceAssistant', node) === true; } catch (e) { perm = false; }
        if (!perm || !rightsAllowDetails(command._rights)) return sendError(myparent, node._id, null, null, 'denied', REASON_MSG[perm ? 'deviceRights' : 'permission']);
        const userid = user._id, nodeid = node._id;
        const op = command.op === 'delete' || command.op === 'truncate' ? command.op : null;
        const index = Number.isInteger(command.index) && command.index >= 0 && command.index <= 100000 ? command.index : null;
        const q = typeof command.q === 'string' && command.q.length <= MAX_TEXT + 100 ? command.q : null;
        const chatId = typeof command.chatId === 'string' && historyMod.CHAT_ID_RE.test(command.chatId) ? command.chatId : null;
        const convId = typeof command.convId === 'string' && command.convId.length <= 64 ? command.convId : null;
        const reply = function (o) { return send(myparent, 'onAiChatEdited', Object.assign({ nodeid: nodeid, chatId: chatId, convId: chatId ? null : convId }, o)); };
        if (op == null || index == null || (!chatId && !convId)) return reply({ ok: false, code: 'invalid' });
        if (chatId) {
            if (!history || closed) return reply({ ok: false, code: 'notFound' });
            const mine = sessions.forUser(userid).filter(function (S) { return S.chatId === chatId && S.nodeid === nodeid; });
            if (mine.some(function (S) { return S.busy || S.previewPending; })) return reply({ ok: false, code: 'busy' });
            let r = null;
            try { r = await history.editChat(userid, nodeid, chatId, index, op, q); } catch (e) { r = { ok: false, code: 'invalid' }; }
            if (!r || !r.ok) return reply({ ok: false, code: (r && r.code) || 'invalid' });
            // the next question starts a new model session with a recap of what is left (aiStart with the chat id)
            for (const S of sessions.forUser(userid)) if (S.chatId === chatId && S.nodeid === nodeid) sessions.close(S, 'edited');
            return reply({ ok: true, deleted: r.deleted === true, chat: r.deleted ? null : r.item });
        }
        const S = sessions.owned(convId, myparent);
        if (!S || S.nodeid !== nodeid || S.mode === 'explain') return reply({ ok: false, code: 'notFound' });
        if (S.chatId) return reply({ ok: false, code: 'invalid' });   // a saved chat is changed by its chat id
        if (S.busy || S.previewPending) return reply({ ok: false, code: 'busy' });
        const L = S.log || [];
        if (index >= L.length || L.length !== S.answers.length) return reply({ ok: false, code: 'changed' });
        if (q != null && clipS(L[index].q, MAX_TEXT) !== clipS(q, MAX_TEXT)) return reply({ ok: false, code: 'changed' });
        if ((L[index].diag && index === 0) || L.length === 1) { sessions.close(S, 'deleted'); return reply({ ok: true, deleted: true }); }
        if (op === 'delete') { L.splice(index, 1); S.answers.splice(index, 1); }
        else { L.length = index; S.answers.length = index; }
        resetSession(S);
        return reply({ ok: true, count: L.length });
    }

    function aiFeedback(command, myparent) {
        // only the possible causes of a diagnosis take feedback ("This is wrong" / "Reopen")
        const target = command.target === 'hyp' ? 'hyp' : null;
        const vote = command.vote === 'wrong' || command.vote === 'reopen' ? command.vote : null;
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
                case 'aiHistoryList': case 'aiHistoryGet': case 'aiHistoryDelete': return await aiHistory(command, myparent);
                case 'aiChatEdit': return await aiChatEdit(command, myparent);
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
        store: store, admin: admin, secrets: secrets, sessions: sessions, software: software, history: history,
        accessInfo: accessInfo, handle: handle, onAgentData: onAgentData, close: close,
        _categoriesFor: categoriesFor, CATEGORIES: CATEGORIES
    };
}

module.exports = { create, CATEGORIES, normSettings };
