'use strict';
// Saved Assistant results, per user and device: chats (Ask chats and diagnoses, which are chats too: their first
// answer is the diagnosis, follow-up questions continue them) and the latest explanation per event.
//
// create({ db, getSettings, now, log }) -> history | null (null when the database has no saved-results store)
//   db: aiChatPut(rec) aiChatGet(id) aiChatList(q) aiChatDel(ids) aiChatSweep(cutoffMs) aiChatPurge() aiChatCounts()
//       (db.js / db_sql.js; records { id, time, userid, nodeid, kind, meta, doc })
//   getSettings() -> Promise<settings> (ai/store.js; settings.history { enabled, retentionDays })
//
//   config()                               -> Promise<{ enabled, retentionDays }>
//   newChatId()                            -> 'ch' + 24 hex
//   list(userid, nodeid)                   -> Promise<{ enabled, retentionDays, chats:[{id,title,updated,created,count,
//                                             type?:'diagnosis', window?}], diagnosis:null, explains:[{eventId, time}] }>
//                                             (a diagnosis saved by an earlier version, kind 'diagnosis', is turned
//                                             into a diagnosis chat first: lazy migration, once per item)
//   get(userid, nodeid, kind, key)         -> Promise<item|null>   kind 'chat' (key: chat id), 'diagnosis' (key
//                                             ignored; only items not migrated yet), 'explain' (key: the stored event id)
//   remove(userid, nodeid, kind, key)      -> Promise<bool>
//   saveChatTurn({ userid, nodeid, chatId, question, done, steps, endpointName, model, cont, type, window, range })
//                                          -> Promise<bool>   type 'diagnosis' (with window '24h'|'7d'|'restart' and
//                                             range) on the first message of a diagnosis chat
//   editChat(userid, nodeid, chatId, index, op, q) -> Promise<{ ok, code?, deleted?, item? }>   op 'delete' removes
//                                             message index (question and answer), 'truncate' it and every later one;
//                                             q (optional) must equal that message's question (the chat did not change
//                                             meanwhile). Deleting the diagnosis (message 0 of a diagnosis chat) or the
//                                             last message deletes the chat (deleted: true). code: 'notFound',
//                                             'invalid', 'changed'
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
const MAX_CITES = 60, MAX_CITE_MSG = 4000, MAX_TEXT = 200000, MAX_Q = 4000, MAX_STEPS = 96;
const WINDOWS = ['24h', '7d', 'restart'];
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

function stripMarks(t) { return String(t == null ? '' : t).replace(/\uE002[a-z]{1,12}\uE003([^\uE002-\uE004]*)\uE004/g, '$1').replace(/[\uE000-\uE00F]/g, ''); }
// the question shown for a diagnosis: "Diagnose the last 24 hours"
function diagQuestion(w) { return 'Diagnose ' + ({ '24h': 'the last 24 hours', '7d': 'the last 7 days', restart: 'around the last restart' }[w] || 'the last 24 hours'); }
// the title of a diagnosis chat: the first sentence of its summary, else "Diagnosis of the last 24 hours"
function diagTitle(summary, w) {
    let t = stripMarks(summary).replace(/\s*\[\s*E\d{1,6}(?:\s*[,;]\s*E\d{1,6})*\s*\]/g, '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
    const m = /^(.{12,}?[.!?])(\s|$)/.exec(t);
    if (m) t = m[1];
    return t ? titleOf(t) : 'Diagnosis of ' + diagQuestion(w).slice(9);
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
// tool steps, and the notes the model wrote between its lookups ({ note })
function stepsOf(steps) {
    return (Array.isArray(steps) ? steps : []).slice(0, MAX_STEPS).map(function (s) {
        s = isObj(s) ? s : {};
        if (typeof s.note === 'string') return { note: clip(s.note, 2000) };
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
    // a diagnosis chat keeps its diagnosis (message 0) as long as there is anything else to drop
    while (ms.length > 1 && !fits()) {
        const keepFirst = doc.type === 'diagnosis' && ms.length > 2;
        ms.splice(keepFirst ? 1 : 0, 1);
        if (!keepFirst && doc.type === 'diagnosis') { delete doc.type; delete doc.window; }
        doc.dropped = (doc.dropped || 0) + 1;
    }
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
        await migrate(userid, nodeid, q);
        const [chats, ex] = await Promise.all([
            db.aiChatList(Object.assign({ kind: 'chat', limit: MAX_CHATS }, q)),
            db.aiChatList(Object.assign({ kind: 'explain', limit: MAX_EXPLAINS }, q))
        ]);
        out.chats = (chats || []).filter(function (r) { return r.userid === userid && r.nodeid === nodeid; }).map(function (r) {
            const m = isObj(r.meta) ? r.meta : {};
            const o = { id: r.id, title: String(m.title || 'Chat').slice(0, 120), updated: Number(r.time) || 0, created: Number(m.created) || Number(r.time) || 0, count: Number(m.count) || 0 };
            if (m.type === 'diagnosis') { o.type = 'diagnosis'; o.window = WINDOWS.indexOf(m.window) >= 0 ? m.window : null; }
            return o;
        });
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

    // A diagnosis saved before diagnoses were chats (kind 'diagnosis', one per user and device) becomes a diagnosis
    // chat with that one message, under an id derived from the old one (two lists at once migrate it once).
    function chatMeta(doc) {
        const m = { title: doc.title, created: doc.created, count: doc.messages.length + (doc.dropped || 0) };
        if (doc.type === 'diagnosis') { m.type = 'diagnosis'; m.window = doc.window || null; }
        return m;
    }
    async function migrate(userid, nodeid, q) {
        let old = [];
        try { old = await db.aiChatList(Object.assign({ kind: 'diagnosis', limit: 20 }, q)); } catch (e) { warn('could not list earlier diagnoses', e); return; }
        for (const r of old || []) {
            if (!r || r.userid !== userid || r.nodeid !== nodeid || typeof r.id !== 'string') continue;
            const id = 'ch' + hash(['migrated diagnosis', r.id]).slice(0, 24);
            try {
                await serial(id, async function () {
                    const full = await db.aiChatGet(r.id);
                    if (!full || full.userid !== userid || full.nodeid !== nodeid || full.kind !== 'diagnosis') return;
                    if (!(await db.aiChatGet(id))) {
                        const d = isObj(full.doc) ? full.doc : {};
                        const w = WINDOWS.indexOf(d.window) >= 0 ? d.window : (isObj(full.meta) && WINDOWS.indexOf(full.meta.window) >= 0 ? full.meta.window : '24h');
                        const t = Number(d.generatedAt) || Number(full.time) || now();
                        const st = isObj(d.structured) ? d.structured : null;
                        const msg = { time: t, q: diagQuestion(w), a: typeof d.text === 'string' ? d.text : '', structured: st, steps: stepsOf(d.steps), cites: isObj(d.cites) ? d.cites : {},
                                      invalid: Array.isArray(d.invalid) ? d.invalid : [], followups: [], usage: isObj(d.usage) ? d.usage : {}, redactionCounts: isObj(d.redactionCounts) ? d.redactionCounts : null,
                                      model: String(d.model || '').slice(0, 200), endpointName: String(d.endpointName || '').slice(0, 120) };
                        if (d.citesDropped) msg.citesDropped = true;
                        const doc = { type: 'diagnosis', title: diagTitle(st && st.summary, w), created: t, updated: t, window: w, range: isObj(d.range) ? d.range : null, messages: [msg], model: msg.model, endpointName: msg.endpointName };
                        if (!(await put({ id: id, time: Number(full.time) || t, userid: userid, nodeid: nodeid, kind: 'chat', meta: chatMeta(doc), doc: doc }))) return;
                    }
                    await db.aiChatDel([r.id]);
                });
            } catch (e) { warn('could not move an earlier diagnosis into the chats', e); }
        }
    }

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
                const isDiag = c.type === 'diagnosis';
                const doc = rec && isObj(rec.doc) && Array.isArray(rec.doc.messages) ? rec.doc : { title: titleOf(c.question), created: t, messages: [] };
                const r = result(c.done, c.steps);
                if (!rec && isDiag) {
                    doc.type = 'diagnosis'; doc.window = WINDOWS.indexOf(c.window) >= 0 ? c.window : '24h';
                    doc.range = isObj(c.range) ? { from: Number(c.range.from) || null, to: Number(c.range.to) || null, restartAt: Number(c.range.restartAt) || null } : null;
                    doc.title = diagTitle(r.structured && r.structured.summary, doc.window);
                }
                const msg = { time: t, q: clip(c.question, MAX_Q), a: r.text, structured: r.structured, steps: r.steps, cites: r.cites, invalid: r.invalid,
                              followups: r.followups, usage: r.usage, redactionCounts: r.redactionCounts, model: String(c.model || '').slice(0, 200), endpointName: String(c.endpointName || '').slice(0, 120) };
                if (c.cont) msg.cont = true;
                doc.messages.push(msg);
                doc.updated = t;
                doc.model = msg.model; doc.endpointName = msg.endpointName;
                fitChat(doc);
                return put({ id: id, time: t, userid: c.userid, nodeid: c.nodeid, kind: 'chat', meta: chatMeta(doc), doc: doc });
            });
            if (ok) await prune(c.userid, c.nodeid, 'chat', MAX_CHATS);
            return ok;
        } catch (e) { warn('could not save the chat', e); return false; }
    }
    // Edit a saved chat (the browser's message actions): the server holds the messages, a new model session with a
    // recap of what is left follows. Only the owner's chat on that device, within the retention.
    async function editChat(userid, nodeid, chatId, index, op, q) {
        try {
            if (!args(userid, nodeid, 'chat') || typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) return { ok: false, code: 'notFound' };
            if (op !== 'delete' && op !== 'truncate') return { ok: false, code: 'invalid' };
            if (!Number.isInteger(index) || index < 0 || index > 100000) return { ok: false, code: 'invalid' };
            const cfg = await config();
            if (!cfg.enabled) return { ok: false, code: 'notFound' };
            return await serial(chatId, async function () {
                const rec = await db.aiChatGet(chatId);
                if (!owned(rec, userid, nodeid, 'chat', cfg) || !isObj(rec.doc) || !Array.isArray(rec.doc.messages)) return { ok: false, code: 'notFound' };
                const doc = rec.doc, ms = doc.messages;
                if (index >= ms.length) return { ok: false, code: 'changed' };
                if (typeof q === 'string' && clip(ms[index] && ms[index].q, MAX_Q) !== clip(q, MAX_Q)) return { ok: false, code: 'changed' };
                if ((doc.type === 'diagnosis' && index === 0) || (ms.length === 1 && index === 0)) {
                    await db.aiChatDel([chatId]);
                    return { ok: true, deleted: true };
                }
                if (op === 'delete') ms.splice(index, 1); else ms.length = index;
                if (!ms.length) { await db.aiChatDel([chatId]); return { ok: true, deleted: true }; }
                const t = now();
                doc.updated = t;
                if (!(await put({ id: chatId, time: t, userid: userid, nodeid: nodeid, kind: 'chat', meta: chatMeta(doc), doc: doc }))) return { ok: false, code: 'invalid' };
                return { ok: true, item: Object.assign({ id: chatId, updated: t }, doc) };
            });
        } catch (e) { warn('could not change the chat', e); return { ok: false, code: 'invalid' }; }
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
        } catch (e) { warn('could not save the explanation', e); return false; }
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

    return { config, newChatId, list, get, remove, saveChatTurn, editChat, saveExplain, sweep, purge, counts, CHAT_ID_RE };
}

module.exports = { create, titleOf, diagQuestion, diagTitle, fitChat, CHAT_ID_RE, MAX_CHATS, MAX_EXPLAINS, MAX_DOC };
