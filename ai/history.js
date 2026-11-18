'use strict';
// Saved Assistant results, per user and device: Ask chats, the last diagnosis, the latest explanation per event.
//
// create({ db, getSettings, now, log }) -> history | null (null when the database has no saved-results store)
//   db: aiChatPut(rec) aiChatGet(id) aiChatList(q) aiChatDel(ids) aiChatSweep(cutoffMs) aiChatPurge() aiChatCounts()
//       (db.js / db_sql.js; records { id, time, userid, nodeid, kind, meta, doc })
//   getSettings() -> Promise<settings> (ai/store.js; settings.history { enabled, retentionDays })
//
//   config()                               -> Promise<{ enabled, retentionDays }>
//   newChatId()                            -> 'ch' + 24 hex
//   list(userid, nodeid)                   -> Promise<{ enabled, retentionDays, chats:[{id,title,updated,count}],
//                                             diagnosis:{generatedAt, window}|null, explains:[{eventId, time}] }>
//   get(userid, nodeid, kind, key)         -> Promise<item|null>   kind 'chat' (key: chat id), 'diagnosis' (key
//                                             ignored), 'explain' (key: the stored event id)
//   remove(userid, nodeid, kind, key)      -> Promise<bool>
//   saveChatTurn({ userid, nodeid, chatId, question, done, steps, endpointName, model, cont }) -> Promise<bool>
//   saveDiagnosis({ userid, nodeid, window, range, done, steps, endpointName, model })       -> Promise<bool>
//   saveExplain({ userid, nodeid, eventId, done, steps, endpointName, model })              -> Promise<bool>
//   sweep() -> Promise<removed>, purge() -> Promise<removed>, counts() -> Promise<{chat, diagnosis, explain, total}>
//
// Every read and delete is scoped to the given user AND device: an id of another user's or another device's item
// answers as "not found" (nothing tells it exists). Items older than the retention are not returned even before the
// sweep removed them. Saving never throws into a turn: failures are logged and resolve false. What is saved is what
// the user saw (restored values, pseudonym markers kept), never the model transcript: no tool results, no system
// prompt. Caps: 50 chats per user and device (oldest pruned), 200 explanations per user and device, 512 KB per item
// (citations and old messages are trimmed first; a turn is never refused for size).

const crypto = require('crypto');
const { sanitize } = require('./store.js');

const DAY = 86400000;
const MAX_CHATS = 50, MAX_EXPLAINS = 200, MAX_DOC = 512 * 1024;
const MAX_CITES = 60, MAX_CITE_MSG = 4000, MAX_TEXT = 200000, MAX_Q = 4000, MAX_STEPS = 64;
const CHAT_ID_RE = /^ch[0-9a-f]{24}$/;
const KINDS = ['chat', 'diagnosis', 'explain'];

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function size(v) { try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch (e) { return Infinity; } }
function clip(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
function hash(parts) { return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 40); }
function okStr(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= (max || 256); }
// "Why did the device restart …" (first question, one line, at most 80 characters)
function titleOf(q) {
    const t = String(q == null ? '' : q).replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 79).trimEnd() + '…' : (t || 'Chat');
}

// a cited stored event as the browser got it, with long strings cut
function trimRec(rec, msgMax) {
    const o = {};
    for (const k of Object.keys(rec)) {
        const v = rec[k];
        if (v == null || typeof v === 'function') continue;
        if (typeof v === 'string') o[k] = v.length > (k === 'Message' ? msgMax : 2000) ? v.slice(0, k === 'Message' ? msgMax : 2000) : v;
        else o[k] = v;
    }
    return o;
}
function citesOf(src, max, msgMax) {
    const out = {};
    if (!isObj(src)) return out;
    let n = 0;
    for (const ref of Object.keys(src)) {
        if (!/^E\d{1,6}$/.test(ref) || !isObj(src[ref])) continue;
        if (n >= max) break;
        out[ref] = trimRec(src[ref], msgMax);
        n++;
    }
    return out;
}
function stepsOf(steps) {
    return (Array.isArray(steps) ? steps : []).slice(0, MAX_STEPS).map(function (s) {
        s = isObj(s) ? s : {};
        return { tool: String(s.tool || '').slice(0, 60), args: clip(typeof s.args === 'string' ? s.args : JSON.stringify(s.args == null ? '' : s.args), 300), status: s.status === 'error' ? 'error' : 'done', items: Number(s.items) || 0, ms: Number(s.ms) || 0 };
    });
}
// the parts of an onAiDone message that are kept
function result(done, steps) {
    done = isObj(done) ? done : {};
    const u = isObj(done.usage) ? done.usage : {};
    return {
        text: clip(done.text, MAX_TEXT), structured: isObj(done.structured) ? done.structured : null,
        cites: citesOf(done.citations, MAX_CITES, MAX_CITE_MSG),
        invalid: (Array.isArray(done.invalidCitations) ? done.invalidCitations : []).filter(function (r) { return typeof r === 'string'; }).slice(0, 40),
        followups: (Array.isArray(done.followups) ? done.followups : []).filter(function (f) { return typeof f === 'string'; }).slice(0, 3).map(function (f) { return f.slice(0, 300); }),
        usage: { in: Number(u.in) || 0, out: Number(u.out) || 0, estimated: u.estimated === true, ms: Number(u.ms) || 0, rounds: Number(u.rounds) || 0 },
        redactionCounts: isObj(done.redactionCounts) ? done.redactionCounts : null,
        steps: stepsOf(steps)
    };
}

// Trim a result (a chat message, a diagnosis, an explanation) until fits() says it fits: shorter cited messages,
// fewer citations, shorter text. Changes r in place.
function shrinkResult(r, fits) {
    const refs = function () { return Object.keys(r.cites || {}); };
    if (fits()) return true;
    for (const k of refs()) r.cites[k] = trimRec(r.cites[k], 500);
    if (fits()) return true;
    while (refs().length > 20) { delete r.cites[refs().pop()]; }
    if (fits()) return true;
    r.cites = {}; r.citesDropped = true;
    if (fits()) return true;
    r.steps = [];
    if (fits()) return true;
    r.text = clip(r.text, 20000);
    if (fits()) return true;
    r.structured = null;
    if (fits()) return true;
    r.text = clip(r.text, 2000);
    return fits();
}
// a chat document: the oldest messages lose their citations first, then their detail, then they are dropped
function fitChat(doc) {
    const fits = function () { return size(doc) <= MAX_DOC - 4096; };
    if (fits()) return;
    const ms = doc.messages;
    for (let i = 0; i < ms.length - 1 && !fits(); i++) { ms[i].cites = {}; ms[i].citesDropped = true; }
    for (let i = 0; i < ms.length - 1 && !fits(); i++) { ms[i].steps = []; ms[i].a = clip(ms[i].a, 2000); ms[i].structured = null; }
    while (ms.length > 1 && !fits()) { ms.shift(); doc.dropped = (doc.dropped || 0) + 1; }
    if (!fits() && ms.length) {
        const m = ms[ms.length - 1];
        const r = { text: m.a, structured: m.structured, cites: m.cites, steps: m.steps };
        shrinkResult(r, function () { m.a = r.text; m.structured = r.structured; m.cites = r.cites; m.steps = r.steps; if (r.citesDropped) m.citesDropped = true; return fits(); });
    }
}

function create(o) {
    o = o || {};
    const db = o.db;
    if (!db || ['aiChatPut', 'aiChatGet', 'aiChatList', 'aiChatDel', 'aiChatSweep', 'aiChatPurge', 'aiChatCounts'].some(function (f) { return typeof db[f] !== 'function'; })) return null;
    const getSettings = typeof o.getSettings === 'function' ? o.getSettings : function () { return Promise.resolve({}); };
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const log = typeof o.log === 'function' ? o.log : function (m) { console.log(m); };
    const chains = new Map();

    function warn(what, e) { try { log('EVENTLOG AI: ' + what + ' (' + (e && e.message ? String(e.message).slice(0, 160) : 'error') + ')'); } catch (e2) { } }
    // writes of one item run one after another (read-modify-write of a chat)
    function serial(id, fn) {
        const prev = chains.get(id) || Promise.resolve();
        const p = prev.then(fn, fn);
        const tail = p.then(function () { }, function () { });
        chains.set(id, tail);
        tail.then(function () { if (chains.get(id) === tail) chains.delete(id); });
        return p;
    }
    async function config() {
        let s = null;
        try { s = await getSettings(); } catch (e) { s = null; }
        const h = s && isObj(s.history) ? s.history : {};
        const days = Number(h.retentionDays);
        return { enabled: h.enabled !== false, retentionDays: days >= 1 && days <= 3650 ? Math.floor(days) : 30 };
    }
    function since(cfg) { return now() - cfg.retentionDays * DAY; }
    function owned(rec, userid, nodeid, kind, cfg) {
        return !!(rec && rec.userid === userid && rec.nodeid === nodeid && rec.kind === kind && Number(rec.time) >= since(cfg));
    }
    function idFor(userid, nodeid, kind, key) {
        if (kind === 'chat') return typeof key === 'string' && CHAT_ID_RE.test(key) ? key : null;
        if (kind === 'diagnosis') return 'dg' + hash(['diagnosis', userid, nodeid]);
        if (kind === 'explain') return okStr(key, 64) ? 'ex' + hash(['explain', userid, nodeid, key]) : null;
        return null;
    }
    function args(userid, nodeid, kind) { return okStr(userid) && okStr(nodeid) && KINDS.indexOf(kind) >= 0; }

    async function put(rec) {
        const r = sanitize(rec, 0);
        return (await db.aiChatPut(r)) === true;
    }
    async function prune(userid, nodeid, kind, keep) {
        try {
            const old = await db.aiChatList({ userid: userid, nodeid: nodeid, kind: kind, skip: keep, limit: 1000 });
            if (old && old.length) await db.aiChatDel(old.map(function (x) { return x.id; }));
        } catch (e) { warn('could not prune saved results', e); }
    }

    async function list(userid, nodeid) {
        const cfg = await config();
        const out = { enabled: cfg.enabled, retentionDays: cfg.retentionDays, chats: [], diagnosis: null, explains: [] };
        if (!cfg.enabled || !okStr(userid) || !okStr(nodeid)) return out;
        const q = { userid: userid, nodeid: nodeid, since: since(cfg) };
        const [chats, diag, ex] = await Promise.all([
            db.aiChatList(Object.assign({ kind: 'chat', limit: MAX_CHATS }, q)),
            db.aiChatList(Object.assign({ kind: 'diagnosis', limit: 1 }, q)),
            db.aiChatList(Object.assign({ kind: 'explain', limit: MAX_EXPLAINS }, q))
        ]);
        out.chats = (chats || []).filter(function (r) { return r.userid === userid && r.nodeid === nodeid; }).map(function (r) {
            const m = isObj(r.meta) ? r.meta : {};
            return { id: r.id, title: String(m.title || 'Chat').slice(0, 120), updated: Number(r.time) || 0, created: Number(m.created) || Number(r.time) || 0, count: Number(m.count) || 0 };
        });
        const d = (diag || []).filter(function (r) { return r.userid === userid && r.nodeid === nodeid; })[0];
        if (d) out.diagnosis = { generatedAt: Number(d.time) || 0, window: isObj(d.meta) && typeof d.meta.window === 'string' ? d.meta.window : null };
        out.explains = (ex || []).filter(function (r) { return r.userid === userid && r.nodeid === nodeid && isObj(r.meta) && okStr(r.meta.eventId, 64); })
            .map(function (r) { return { eventId: r.meta.eventId, time: Number(r.time) || 0 }; });
        return out;
    }

    async function getRec(userid, nodeid, kind, key) {
        if (!args(userid, nodeid, kind)) return null;
        const cfg = await config();
        if (!cfg.enabled) return null;
        const id = idFor(userid, nodeid, kind, key);
        if (!id) return null;
        const rec = await db.aiChatGet(id);
        if (!owned(rec, userid, nodeid, kind, cfg)) return null;
        if (kind === 'explain' && !(isObj(rec.doc) && rec.doc.eventId === key)) return null;
        return rec;
    }
    async function get(userid, nodeid, kind, key) {
        const rec = await getRec(userid, nodeid, kind, key);
        if (!rec) return null;
        return Object.assign({ id: rec.id, updated: Number(rec.time) || 0 }, isObj(rec.doc) ? rec.doc : {});
    }
    async function remove(userid, nodeid, kind, key) {
        if (!args(userid, nodeid, kind)) return false;
        const id = idFor(userid, nodeid, kind, key);
        if (!id) return false;
        return serial(id, async function () {
            const rec = await db.aiChatGet(id);
            // ownership without the retention window: an expired item of one's own can be deleted too
            if (!rec || rec.userid !== userid || rec.nodeid !== nodeid || rec.kind !== kind) return false;
            return (await db.aiChatDel([id])) > 0;
        });
    }

    function newChatId() { return 'ch' + crypto.randomBytes(12).toString('hex'); }

    async function saveChatTurn(c) {
        try {
            if (!c || !args(c.userid, c.nodeid, 'chat') || !CHAT_ID_RE.test(String(c.chatId || ''))) return false;
            const cfg = await config();
            if (!cfg.enabled) return false;
            const id = c.chatId, t = now();
            const ok = await serial(id, async function () {
                let rec = await db.aiChatGet(id);
                // an id that belongs to someone else (or another device) is never written to
                if (rec && (rec.userid !== c.userid || rec.nodeid !== c.nodeid || rec.kind !== 'chat')) return false;
                const doc = rec && isObj(rec.doc) && Array.isArray(rec.doc.messages) ? rec.doc : { title: titleOf(c.question), created: t, messages: [] };
                const r = result(c.done, c.steps);
                const msg = { time: t, q: clip(c.question, MAX_Q), a: r.text, structured: r.structured, steps: r.steps, cites: r.cites, invalid: r.invalid,
                              followups: r.followups, usage: r.usage, redactionCounts: r.redactionCounts, model: String(c.model || '').slice(0, 200), endpointName: String(c.endpointName || '').slice(0, 120) };
                if (c.cont) msg.cont = true;
                doc.messages.push(msg);
                doc.updated = t;
                doc.model = msg.model; doc.endpointName = msg.endpointName;
                fitChat(doc);
                return put({ id: id, time: t, userid: c.userid, nodeid: c.nodeid, kind: 'chat', meta: { title: doc.title, created: doc.created, count: doc.messages.length + (doc.dropped || 0) }, doc: doc });
            });
            if (ok) await prune(c.userid, c.nodeid, 'chat', MAX_CHATS);
            return ok;
        } catch (e) { warn('could not save the chat', e); return false; }
    }
    async function saveSingle(kind, c, extra, meta) {
        try {
            if (!c || !args(c.userid, c.nodeid, kind)) return false;
            const cfg = await config();
            if (!cfg.enabled) return false;
            const id = idFor(c.userid, c.nodeid, kind, c.eventId);
            if (!id) return false;
            const t = now();
            const r = result(c.done, c.steps);
            const doc = Object.assign({ time: t, model: String(c.model || '').slice(0, 200), endpointName: String(c.endpointName || '').slice(0, 120) }, extra, r);
            shrinkResult(doc, function () { return size(doc) <= MAX_DOC - 4096; });
            const ok = await serial(id, function () { return put({ id: id, time: t, userid: c.userid, nodeid: c.nodeid, kind: kind, meta: meta, doc: doc }); });
            if (ok && kind === 'explain') await prune(c.userid, c.nodeid, 'explain', MAX_EXPLAINS);
            return ok;
        } catch (e) { warn('could not save the ' + (kind === 'explain' ? 'explanation' : 'diagnosis'), e); return false; }
    }
    function saveDiagnosis(c) {
        const w = c && typeof c.window === 'string' ? c.window : null;
        const rg = c && isObj(c.range) ? { from: Number(c.range.from) || null, to: Number(c.range.to) || null, restartAt: Number(c.range.restartAt) || null } : null;
        return saveSingle('diagnosis', c, { window: w, range: rg, generatedAt: now() }, { window: w });
    }
    function saveExplain(c) {
        if (!c || !okStr(c.eventId, 64)) return Promise.resolve(false);
        return saveSingle('explain', c, { eventId: c.eventId }, { eventId: c.eventId });
    }

    async function sweep() {
        try { const cfg = await config(); return (await db.aiChatSweep(since(cfg))) || 0; }
        catch (e) { warn('saved results sweep failed', e); return 0; }
    }
    async function purge() { return (await db.aiChatPurge()) || 0; }
    async function counts() {
        const c = await db.aiChatCounts();
        const out = { chat: Number(c && c.chat) || 0, diagnosis: Number(c && c.diagnosis) || 0, explain: Number(c && c.explain) || 0 };
        out.total = out.chat + out.diagnosis + out.explain;
        return out;
    }

    return { config, newChatId, list, get, remove, saveChatTurn, saveDiagnosis, saveExplain, sweep, purge, counts, CHAT_ID_RE };
}

module.exports = { create, titleOf, fitChat, CHAT_ID_RE, MAX_CHATS, MAX_EXPLAINS, MAX_DOC };
