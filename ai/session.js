'use strict';
// Assistant conversations ("sessions"), held in memory only.
//
// create({ now, ttlMs, maxOpenPerUser, maxBusyPerUser, maxBusyGlobal, maxTurns, sweepMs, onClose(S, reason), log })
//   -> {
//     open(fields)              -> { ok:true, S } | { ok:false, code:'busy' }   evicts the user's oldest idle session
//                                  when the user already has maxOpenPerUser open; binds ws 'close' once per ws
//     get(convId)               -> S | null
//     owned(convId, myparent)   -> S | null   only for the same user._id AND the same ws
//     canBusy(userid)           -> bool       a new turn may start for this user (per user and global caps)
//     acquire(S)                -> bool       marks the session busy (caps checked); release(S) undoes it
//     release(S)
//     close(S|convId, reason)   aborts an in-flight turn (S.abort(reason)) and forgets the session
//     closeWs(ws, reason), closeAll(reason), sweep(), stop(), size(), forUser(userid)
//   }
// A session: { convId, userid, username, ws, myparent, grandparent, domain, nodeid, meshid, node, rights, mode,
//   ep (no key), net, redactor, refs, transcript, busy, abort, turn, usage, ratio, segment, createdAt, lastActive,
//   previewPending, closed, ... } - the caller adds what else it needs.
//
// createRefs() -> registry of the stored events shown to the model, with conversation-local refs E1..En:
//   add(dbEvent) -> 'E<n>' (stable per stored id), addAs(dbEvent, ref) -> ref|null (a given ref), get(ref) -> dbEvent|null, idOf(ref) -> stored id|null,
//   mark(ref) marks it as returned to the model, markIn(jsonText) marks every assigned ref that appears as a quoted
//   JSON string ("E12") in what was actually sent (items cut by budget.fitJson stay unmarked),
//   returned (Set of refs the model has actually seen), size()

const crypto = require('crypto');

const DEFAULTS = { ttlMs: 30 * 60 * 1000, maxOpenPerUser: 3, maxBusyPerUser: 1, maxBusyGlobal: 6, maxTurns: 20, sweepMs: 60 * 1000 };
const MAX_REFS = 5000;
const MAX_REF_MSG = 8000;

function newConvId() { return crypto.randomBytes(16).toString('hex'); }

function createRefs() {
    const byId = new Map();     // stored id -> ref
    const byRef = new Map();    // ref -> event copy
    const returned = new Set();
    let n = 0;
    function copy(ev) {
        const o = {};
        for (const k of Object.keys(ev)) {
            const v = ev[k];
            if (v == null || typeof v === 'function') continue;
            if (k === 'Message' && typeof v === 'string' && v.length > MAX_REF_MSG) o[k] = v.slice(0, MAX_REF_MSG);
            else o[k] = v;
        }
        return o;
    }
    return {
        returned: returned,
        add: function (ev) {
            if (ev == null || typeof ev !== 'object' || ev._id == null) return null;
            const id = String(ev._id);
            let ref = byId.get(id);
            if (ref) return ref;
            if (n >= MAX_REFS) return null;
            ref = 'E' + (++n);
            byId.set(id, ref);
            byRef.set(ref, copy(ev));
            return ref;
        },
        // registers an event under a given ref (a saved chat continued in a new session keeps its refs); null when
        // the ref or the event is already registered otherwise; later add() calls continue after the highest ref
        addAs: function (ev, ref) {
            const m = /^E(\d{1,6})$/.exec(String(ref || ''));
            if (!m || ev == null || typeof ev !== 'object' || ev._id == null) return null;
            const r = 'E' + Number(m[1]), id = String(ev._id);
            if (byRef.has(r)) return byRef.get(r)._id != null && String(byRef.get(r)._id) === id ? r : null;
            if (byId.has(id) || byRef.size >= MAX_REFS) return null;
            byId.set(id, r);
            byRef.set(r, copy(ev));
            if (Number(m[1]) > n) n = Number(m[1]);
            return r;
        },
        get: function (ref) { return byRef.get(String(ref || '').toUpperCase().replace(/^E0+(?=\d)/, 'E')) || null; },
        idOf: function (ref) { const e = this.get(ref); return e ? String(e._id) : null; },
        has: function (ref) { return byRef.has(ref); },
        mark: function (ref) { if (byRef.has(ref)) returned.add(ref); },
        markIn: function (text) {
            if (typeof text !== 'string' || !text) return;
            const re = /"E(\d{1,6})"/g;      // quoted JSON values only: free text that merely mentions E5 does not count
            let m;
            while ((m = re.exec(text))) { const r = 'E' + Number(m[1]); if (byRef.has(r)) returned.add(r); }
        },
        size: function () { return n; }
    };
}

function create(opts) {
    opts = opts || {};
    const cfg = Object.assign({}, DEFAULTS);
    for (const k of Object.keys(DEFAULTS)) if (Number(opts[k]) > 0) cfg[k] = Number(opts[k]);
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const log = typeof opts.log === 'function' ? opts.log : function () { };
    const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    const sessions = new Map();
    const boundWs = new WeakSet();
    let busyGlobal = 0;

    let timer = setInterval(function () { try { sweep(); } catch (e) { } }, cfg.sweepMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    function forUser(userid) { const out = []; for (const S of sessions.values()) if (S.userid === userid) out.push(S); return out; }
    function busyFor(userid) { let n = 0; for (const S of sessions.values()) if (S.userid === userid && S.busy) n++; return n; }

    function close(x, reason) {
        const S = typeof x === 'string' ? sessions.get(x) : x;
        if (S == null || S.closed) return false;
        S.closed = true;
        S.closeReason = reason || 'closed';
        sessions.delete(S.convId);
        if (S.busy && typeof S.abort === 'function') { try { S.abort(S.closeReason); } catch (e) { } }
        if (S.previewTimer) { clearTimeout(S.previewTimer); S.previewTimer = null; }
        if (onClose) { try { onClose(S, S.closeReason); } catch (e) { log('EVENTLOG AI: session close handler failed'); } }
        return true;
    }

    function bindWs(ws) {
        if (ws == null || typeof ws !== 'object' || boundWs.has(ws)) return;
        const fn = function () { closeWs(ws, 'closed'); };
        try {
            if (typeof ws.once === 'function') { ws.once('close', fn); boundWs.add(ws); }
            else if (typeof ws.on === 'function') { ws.on('close', fn); boundWs.add(ws); }
        } catch (e) { }
    }

    function open(fields) {
        fields = fields || {};
        const userid = fields.userid;
        const mine = forUser(userid);
        if (mine.length >= cfg.maxOpenPerUser) {
            const idle = mine.filter(function (S) { return !S.busy; }).sort(function (a, b) { return a.lastActive - b.lastActive; });
            if (!idle.length) return { ok: false, code: 'busy' };
            while (forUser(userid).length >= cfg.maxOpenPerUser && idle.length) close(idle.shift(), 'evicted');
        }
        const t = now();
        const S = Object.assign({
            convId: newConvId(), busy: false, abort: null, turn: 0, ratio: 1, segment: 0, createdAt: t, lastActive: t,
            previewPending: null, closed: false, usage: { in: 0, out: 0 }, refs: createRefs(), transcript: { system: '', items: [] }
        }, fields);
        while (sessions.has(S.convId)) S.convId = newConvId();
        sessions.set(S.convId, S);
        bindWs(S.ws);
        return { ok: true, S: S };
    }

    function canBusy(userid) { return busyGlobal < cfg.maxBusyGlobal && busyFor(userid) < cfg.maxBusyPerUser; }
    function acquire(S) {
        if (S == null || S.closed || S.busy) return false;
        if (!canBusy(S.userid)) return false;
        S.busy = true; busyGlobal++;
        S.lastActive = now();
        return true;
    }
    function release(S) {
        if (S == null || !S.busy) return;
        S.busy = false; S.abort = null;
        busyGlobal = Math.max(0, busyGlobal - 1);
        S.lastActive = now();
    }

    function owned(convId, myparent) {
        if (typeof convId !== 'string' || myparent == null || myparent.user == null) return null;
        const S = sessions.get(convId);
        if (S == null || S.closed) return null;
        if (S.userid !== myparent.user._id || S.ws !== myparent.ws) return null;
        return S;
    }

    function closeWs(ws, reason) { for (const S of Array.from(sessions.values())) if (S.ws === ws) close(S, reason); }
    function closeAll(reason) { for (const S of Array.from(sessions.values())) close(S, reason); }
    function sweep() {
        const t = now();
        for (const S of Array.from(sessions.values())) if (t - S.lastActive > cfg.ttlMs) close(S, 'expired');
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    return {
        open: open, get: function (id) { return sessions.get(id) || null; }, owned: owned, canBusy: canBusy, acquire: acquire, release: release,
        close: close, closeWs: closeWs, closeAll: closeAll, sweep: sweep, stop: stop, forUser: forUser,
        size: function () { return sessions.size; }, busyCount: function () { return busyGlobal; }, maxTurns: cfg.maxTurns, config: cfg
    };
}

module.exports = { create, createRefs, newConvId, DEFAULTS };
