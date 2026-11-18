'use strict';
// Installed software inventory for the Assistant, read live from the agent.
//
// create({ getAgent(nodeid) -> agent|null, maxItems=5000 }) -> {
//   request(nodeid, rights, timeoutMs=30000) -> Promise<[{ name, version, publisher, installDate }]>
//       rejects Error.code 'offline' | 'timeout' | 'denied' | 'unsupported' | 'badResponse'
//   onAgentData(command, agentObj) -> bool   true when the message was a reply to one of our requests
//   close()                                   rejects every pending request ('aborted')
// }
// The agent command is MeshCentral's own { action:'software', type:'installedapps', rights, sessionid }; the agent
// enforces rights == ADMIN || !(rights & NOSOFTWARE) itself. Its reply is routed by MeshCentral to user sessions only,
// so a sessionid of the form 'eventlogai:<16 hex>' (no user session has it) reaches only the plugin hook
// (hook_processAgentData). A reply is accepted only from the agent of the device it was requested from.

const crypto = require('crypto');

const PREFIX = 'eventlogai:';

function mkErr(code, message) { const e = new Error(message); e.code = code; return e; }

function pick(o, names) {
    for (const n of names) {
        const v = o[n];
        if (v != null && v !== '') return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : null);
    }
    return null;
}
function clip(s, n) { return s == null ? null : (s.length > n ? s.slice(0, n) : s); }

// Agent answers differ per OS (win-info installedApps, linux-info packages, mac-info apps): be tolerant.
function normalize(value, maxItems) {
    let v = value;
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (e) { throw mkErr('badResponse', 'The agent sent an unreadable software list'); }
    }
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        if (v.success === false || typeof v.error === 'string') {
            const msg = String(v.error || '');
            if (/denied/i.test(msg)) throw mkErr('denied', 'The agent refused the software inventory (No Software restriction)');
            throw mkErr('unsupported', 'The agent cannot list installed software on this device' + (msg ? ' (' + clip(msg, 120) + ')' : ''));
        }
        const inner = Array.isArray(v.apps) ? v.apps : (Array.isArray(v.packages) ? v.packages : (Array.isArray(v.value) ? v.value : (Array.isArray(v.data) ? v.data : null)));
        if (inner) v = inner;
    }
    if (!Array.isArray(v)) throw mkErr('badResponse', 'The agent sent an unexpected software list');
    const out = [];
    for (const it of v) {
        if (out.length >= maxItems) break;
        if (it == null || typeof it !== 'object') continue;
        const name = pick(it, ['name', 'Name', 'DisplayName', 'displayName', 'package', 'Package']);
        if (!name) continue;
        out.push({
            name: clip(name, 200),
            version: clip(pick(it, ['version', 'Version', 'DisplayVersion', 'displayVersion']), 80),
            publisher: clip(pick(it, ['publisher', 'Publisher', 'vendor', 'Vendor', 'maintainer', 'Maintainer']), 120),
            installDate: clip(pick(it, ['installDate', 'InstallDate', 'installdate', 'date', 'Date']), 40)
        });
    }
    return out;
}

function create(opts) {
    opts = opts || {};
    const getAgent = typeof opts.getAgent === 'function' ? opts.getAgent : function () { return null; };
    const maxItems = Number(opts.maxItems) > 0 ? Number(opts.maxItems) : 5000;
    const pending = new Map();   // sessionid -> { nodeid, resolve, reject, timer }

    function finish(sid, err, val) {
        const p = pending.get(sid);
        if (!p) return;
        pending.delete(sid);
        clearTimeout(p.timer);
        if (err) p.reject(err); else p.resolve(val);
    }

    function request(nodeid, rights, timeoutMs) {
        return new Promise(function (resolve, reject) {
            let agent = null;
            try { agent = getAgent(nodeid); } catch (e) { agent = null; }
            if (agent == null || typeof agent.send !== 'function') { reject(mkErr('offline', 'The agent is offline')); return; }
            const sid = PREFIX + crypto.randomBytes(8).toString('hex');
            const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
            const timer = setTimeout(function () { finish(sid, mkErr('timeout', 'The agent did not send the software list in time')); }, ms);
            if (typeof timer.unref === 'function') timer.unref();
            pending.set(sid, { nodeid: nodeid, resolve: resolve, reject: reject, timer: timer });
            try {
                agent.send(JSON.stringify({ action: 'software', type: 'installedapps', rights: (Number(rights) >>> 0), sessionid: sid }));
            } catch (e) { finish(sid, mkErr('offline', 'Could not reach the agent')); }
        });
    }

    function onAgentData(command, agentObj) {
        try {
            if (command == null || command.action !== 'software' || typeof command.sessionid !== 'string' || command.sessionid.indexOf(PREFIX) !== 0) return false;
            const p = pending.get(command.sessionid);
            if (!p) return true;                                         // ours, but late or unknown: drop
            if (agentObj == null || agentObj.dbNodeKey !== p.nodeid) return true;   // another device cannot answer for this one
            let list;
            try { list = normalize(command.value, maxItems); } catch (e) { finish(command.sessionid, e.code ? e : mkErr('badResponse', 'Bad software list')); return true; }
            finish(command.sessionid, null, list);
            return true;
        } catch (e) { return false; }
    }

    function close() { for (const sid of Array.from(pending.keys())) finish(sid, mkErr('aborted', 'Aborted')); }

    return { request: request, onAgentData: onAgentData, close: close, pendingCount: function () { return pending.size; } };
}

module.exports = { create, normalize, PREFIX };
