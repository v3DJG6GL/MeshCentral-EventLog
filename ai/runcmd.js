'use strict';
// Runs one command the Assistant suggested (and the technician confirmed) on a device through the agent.
//
// create({ getAgent(nodeid) -> agent|null, now?() -> ms, randomHex?(bytes) -> hex, maxOutput=65536, stuckMs=600000 }) -> {
//   run(nodeid, { platform:'windows'|'linux'|'macos', shell, text, runAsUser }, timeoutMs=120000)
//       -> Promise<{ output, truncated, ms }>
//       rejects Error.code 'badRequest' | 'unsupported' | 'busy' | 'offline' | 'timeout' | 'aborted'
//   onAgentData(command, agentObj) -> bool   true when the message was ours (reply, late reply or our console text)
//   busy(nodeid) -> bool                       a run of ours is pending there, or timed out and may still run
//   close()                                    rejects every pending run ('aborted')
//   pendingCount() -> number
// }
// shell: the code fence name (prompts.SHELLS: powershell|pwsh|ps|ps1, cmd|bat|batch, bash|sh|shell|zsh|console).
// Windows takes cmd / PowerShell, Linux and macOS take /bin/sh. runAsUser (Windows only, else forced 0): 0 = the agent
// (SYSTEM), 1 = the logged-in user if there is one (else the agent). The agent's 2 (user only) is refused: with nobody
// logged in the agent drops the run without a reply.
//
// The agent command is MeshCentral's own { action:'runcommands', type, cmds, runAsUser, reply:true, responseid, sessionid }
// (type 1 = cmd.exe, 2 = powershell -noprofile -nologo -command -, 3 = /bin/sh). The agent pipes cmds + an exit line
// into the shell's stdin and answers { action:'msg', type:'runcommands', result, sessionid, responseid } when the
// shell exits. MeshCentral routes that reply to user sessions only, so a sessionid of the form 'eventlogai:<16 hex>'
// (no user session has it) reaches only the plugin hook (hook_processAgentData). A reply is accepted only from the
// agent of the device the run went to.
// The agent runs one command at a time and refuses a second one with only a console message ("Run commands can't
// execute, already busy"), so this module allows one run per device; after a timeout the device stays busy until
// the late reply arrives or stuckMs passes (the shell may still be running there). A refusal console message from the
// same agent shortly after the send fails the run as 'busy' right away (onAgentData returns false for it: it is not
// addressed to us and stays routed as usual).

const crypto = require('crypto');
const SHELLS = require('./prompts.js').SHELLS;

const PREFIX = 'eventlogai:';
const MAX_TEXT = 8000;
const TYPES = { cmd: 1, powershell: 2, bash: 3 };
const PLATFORM_SHELLS = { windows: ['cmd', 'powershell'], linux: ['bash'], macos: ['bash'] };
const BUSY_TEXT = 'already busy';
const BUSY_WINDOW = 5000;   // ms after the send in which a refusal console message is taken as ours

function mkErr(code, message) { const e = new Error(message); e.code = code; return e; }

function normShell(s) {
    const k = String(s == null ? '' : s).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SHELLS, k) ? SHELLS[k] : null;
}

// The cmds string for the agent's stdin.
// - PowerShell: the raw host of 'powershell -command -' reads stdin line by line and collects a multi-line construct
//   (if/else, function, here-string) until a blank line, so a script ending with a block swallows the exit line and
//   waits forever, and a blank line inside a block submits it half-finished. The script goes as ONE self-decoding line
//   instead (base64 of its UTF-8 bytes, so non-ASCII survives stdin's code page), with UTF-8 output and no progress
//   records. Approach as in MeshCentral-QuickCommands qcCmds.
// - cmd: echo off hides the prompt and the echoed lines; code page 65001 so UTF-8 text and output survive.
// - sh: no carriage returns.
function buildCmds(shell, text) {
    if (shell === 'powershell') {
        const b64 = Buffer.from(text, 'utf8').toString('base64');
        return "$ProgressPreference='SilentlyContinue';try{[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false}catch{};" +
            "iex([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "')))\r\n";
    }
    if (shell === 'cmd') return '@echo off\r\nchcp 65001>nul 2>&1\r\n' + text.replace(/\r?\n/g, '\r\n') + '\r\n';
    return text.replace(/\r/g, '') + '\n';
}

// Agent output as plain text: no ANSI escapes or other control characters, \n line ends, at most max characters.
function cleanOutput(result, shell, max) {
    let s = typeof result === 'string' ? result : '';
    s = s.replace(/^﻿/, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')            // OSC (window titles, links)
        .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')               // CSI (colours, cursor moves)
        .replace(/\x1b[()*+][0-~]/g, '')                                // character set selection
        .replace(/\x1b[@-Z\\-_]/g, '')                                   // other two-byte escapes
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    // cmd.exe prints its banner and the first prompt with the echoed "@echo off" before echo is off
    if (shell === 'cmd') s = s.replace(/^(?:[^\n]*\n){0,4}?[^\n]*>@echo off[ \t]*\n/, '');
    let truncated = false;
    if (s.length > max) {
        let n = max;
        const c = s.charCodeAt(n - 1);
        if (c >= 0xD800 && c <= 0xDBFF) n--;                             // do not split a surrogate pair
        s = s.slice(0, n);
        truncated = true;
    }
    return { output: s, truncated: truncated };
}

// -> { shell, type, cmds, runAsUser } or throws badRequest / unsupported
function prepare(req) {
    if (req == null || typeof req !== 'object') throw mkErr('badRequest', 'No command');
    const text = typeof req.text === 'string' ? req.text.trim() : '';
    if (!text) throw mkErr('badRequest', 'The command is empty');
    if (text.length > MAX_TEXT) throw mkErr('badRequest', 'The command is too long (at most ' + MAX_TEXT + ' characters)');
    if (text.indexOf('\u0000') !== -1) throw mkErr('badRequest', 'The command contains a NUL character');
    let rau = req.runAsUser == null ? 0 : req.runAsUser;
    if (rau !== 0 && rau !== 1) throw mkErr('badRequest', 'Run as must be 0 (agent) or 1 (logged-in user)');
    const shell = normShell(req.shell);
    if (!shell) throw mkErr('unsupported', 'Unknown shell');
    const allowed = Object.prototype.hasOwnProperty.call(PLATFORM_SHELLS, req.platform) ? PLATFORM_SHELLS[req.platform] : null;
    if (!allowed) throw mkErr('unsupported', 'Commands cannot run on this kind of device');
    if (allowed.indexOf(shell) === -1) throw mkErr('unsupported', 'A ' + shell + ' command cannot run on ' + (req.platform === 'windows' ? 'Windows' : (req.platform === 'macos' ? 'macOS' : 'Linux')));
    if (req.platform !== 'windows') rau = 0;
    return { shell: shell, type: TYPES[shell], cmds: buildCmds(shell, text), runAsUser: rau };
}

function create(opts) {
    opts = opts || {};
    const getAgent = typeof opts.getAgent === 'function' ? opts.getAgent : function () { return null; };
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const randomHex = typeof opts.randomHex === 'function' ? opts.randomHex : function (n) { return crypto.randomBytes(n).toString('hex'); };
    const maxOutput = Number(opts.maxOutput) > 0 ? Math.floor(Number(opts.maxOutput)) : 65536;
    const stuckMs = Number(opts.stuckMs) >= 0 && opts.stuckMs != null ? Number(opts.stuckMs) : 600000;
    const pending = new Map();   // sessionid -> { nodeid, shell, start, resolve, reject, timer }
    const nodes = new Map();     // nodeid -> { sid, until }   until 0 = pending; else timed out, busy until then

    function busy(nodeid) {
        const n = nodes.get(nodeid);
        if (!n) return false;
        if (n.until && n.until <= now()) { nodes.delete(nodeid); return false; }
        return true;
    }

    function finish(sid, err, val) {
        const p = pending.get(sid);
        if (!p) return;
        pending.delete(sid);
        clearTimeout(p.timer);
        const n = nodes.get(p.nodeid);
        if (n && n.sid === sid) {
            if (err && err.code === 'timeout' && stuckMs > 0) n.until = now() + stuckMs;
            else nodes.delete(p.nodeid);
        }
        if (err) p.reject(err); else p.resolve(val);
    }

    function run(nodeid, req, timeoutMs) {
        return new Promise(function (resolve, reject) {
            let prep;
            try {
                if (typeof nodeid !== 'string' || !nodeid) throw mkErr('badRequest', 'No device');
                prep = prepare(req);
            } catch (e) { reject(e); return; }
            if (busy(nodeid)) { reject(mkErr('busy', 'Another command is still running on this device')); return; }
            let agent = null;
            try { agent = getAgent(nodeid); } catch (e) { agent = null; }
            if (agent == null || typeof agent.send !== 'function') { reject(mkErr('offline', 'The agent is offline')); return; }
            const sid = PREFIX + String(randomHex(8));
            const ms = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 3600000) : 120000;
            const timer = setTimeout(function () { finish(sid, mkErr('timeout', 'The command did not finish in time; it may still be running on the device')); }, ms);
            if (typeof timer.unref === 'function') timer.unref();
            pending.set(sid, { nodeid: nodeid, shell: prep.shell, start: now(), resolve: resolve, reject: reject, timer: timer });
            nodes.set(nodeid, { sid: sid, until: 0 });
            try {
                agent.send(JSON.stringify({ action: 'runcommands', type: prep.type, cmds: prep.cmds, runAsUser: prep.runAsUser, reply: true, responseid: sid, sessionid: sid }));
            } catch (e) { finish(sid, mkErr('offline', 'Could not reach the agent')); }
        });
    }

    function onAgentData(command, agentObj) {
        try {
            if (command == null || typeof command !== 'object' || command.action !== 'msg') return false;
            const sid = command.sessionid;
            const ours = typeof sid === 'string' && sid.indexOf(PREFIX) === 0;
            const from = agentObj == null ? null : agentObj.dbNodeKey;
            if (command.type === 'runcommands') {
                if (!ours) return false;
                if (command.responseid != null && command.responseid !== sid) return true;
                const p = pending.get(sid);
                if (!p) {                                                     // late reply after a timeout: device free again
                    const n = from != null ? nodes.get(from) : null;
                    if (n && n.sid === sid) nodes.delete(from);
                    return true;
                }
                if (from == null || from !== p.nodeid) return true;            // another device cannot answer for this one
                const out = cleanOutput(command.result, p.shell, maxOutput);
                finish(sid, null, { output: out.output, truncated: out.truncated, ms: Math.max(0, now() - p.start) });
                return true;
            }
            if (command.type === 'console') {
                const busyText = typeof command.value === 'string' && command.value.indexOf(BUSY_TEXT) !== -1 && /run commands/i.test(command.value);
                if (ours) {
                    const p = pending.get(sid);
                    if (!p) return false;                                     // not one of ours (e.g. the software inventory's)
                    if (busyText && from === p.nodeid) finish(sid, mkErr('busy', 'The agent is busy with another command'));
                    return true;
                }
                if (busyText && from != null) {                               // the refusal goes out without our session id
                    const n = nodes.get(from), p = n ? pending.get(n.sid) : null;
                    if (p && now() - p.start <= BUSY_WINDOW) finish(n.sid, mkErr('busy', 'The agent is busy with another command'));
                }
                return false;
            }
            return false;
        } catch (e) { return false; }
    }

    function close() {
        for (const sid of Array.from(pending.keys())) finish(sid, mkErr('aborted', 'Aborted'));
        nodes.clear();
    }

    return { run: run, onAgentData: onAgentData, close: close, busy: busy, pendingCount: function () { return pending.size; } };
}

module.exports = { create, buildCmds, cleanOutput, normShell, prepare, PREFIX, MAX_TEXT, TYPES };
