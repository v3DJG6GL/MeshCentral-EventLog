/**
* @description MeshCentral event log plugin: the Assistant on the device tab (Explain, Ask and Diagnose chats, data preview)
* @license Apache-2.0
*/

"use strict";

// Browser code. Every function below is serialized with .toString() into /pluginHandler.js and runs in the
// MeshCentral web UI, so: only function expressions, no references to anything outside the function itself, calls
// between functions through pluginHandler.eventlog.<name>. attach() pushes the names into the plugin's exports.
//
// Rendering rule: text written by the model only ever reaches the page through aiMd() (own marked + DOMPurify
// instances, raw HTML escaped, images turned into links, links shown with their real domain) or aiPlain()/aiEsc()
// (escaped). It never goes into an attribute or an inline handler: those carry only ids we generated (conversation
// ids "c12", citation refs "E3", hypothesis ids checked against /^[\w-]{1,20}$/, numbers).

module.exports.attach = function (obj) {

    // ---- small helpers --------------------------------------------------------------------------------------------
    obj.aiEsc = function (x) {
        return (x == null) ? '' : String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };
    // Plain text for the clipboard or for a question: pseudonym markers become their value, other control marks go.
    obj.aiStripMarks = function (s) {
        return String(s == null ? '' : s).replace(/[a-z]{1,12}([^-]*)/g, '$1').replace(/[-]/g, '');
    };
    // Short text (labels, titles, notes): escaped, pseudonymized values tinted, citation brackets removed.
    obj.aiPlain = function (s) {
        var ph = pluginHandler.eventlog, out = '', last = 0, m;
        var re = /([a-z]{1,12})([^-]*)/g;
        s = String(s == null ? '' : s);
        var txt = function (t) { return ph.aiEsc(t.replace(/[-]/g, '').replace(/\s*\[\s*E\d{1,6}(?:\s*[,;]\s*E\d{1,6})*\s*\]/g, '')).replace(/\[unverified\]/g, '<span class=evlAiUnv>[unverified]</span>'); };
        while ((m = re.exec(s))) { out += txt(s.slice(last, m.index)) + '<mark class=evlPs title="Replaced before sending">' + ph.aiEsc(m[2]) + '</mark>'; last = re.lastIndex; }
        return out + txt(s.slice(last));
    };
    // Preview text (already pseudonymized): escaped, tokens such as HOST_1 tinted.
    obj.aiTint = function (s) {
        var ph = pluginHandler.eventlog;
        return ph.aiEsc(ph.aiStripMarks(s)).replace(/\b(?:USER|HOST|DOMAIN|IP|MAC|EMAIL|SID|SECRET|SERIAL)_\d+\b/g, '<mark class=evlPs>$&</mark>');
    };
    obj.aiNetWord = function (n) {
        return ({ loopback: 'on this server', 'private': 'local', 'public': 'cloud' })[n] || '';
    };
    // { total, list: '3 user names, 1 computer name' } from the server's redaction counts
    obj.aiCounts = function (counts) {
        var names = { users: ['user name', 'user names'], hosts: ['computer name', 'computer names'], domains: ['domain', 'domains'], ips: ['IP address', 'IP addresses'],
                      macs: ['MAC address', 'MAC addresses'], emails: ['email address', 'email addresses'], sids: ['SID', 'SIDs'], secrets: ['secret', 'secrets'], serials: ['serial number', 'serial numbers'] };
        var total = 0, parts = [];
        if (counts && typeof counts == 'object') {
            for (var k in names) { var n = Number(counts[k]) || 0; if (n > 0) { total += n; parts.push(n + ' ' + names[k][n == 1 ? 0 : 1]); } }
        }
        return { total: total, list: parts.join(', ') };
    };
    obj.aiTimeShort = function (ms) {
        try { return new Date(Number(ms)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
    };
    // "14:02" today, "yesterday, 14:02", "18 Nov, 14:02", "18 Nov 2025, 14:02"
    obj.aiWhen = function (ms) {
        var ph = pluginHandler.eventlog, t = Number(ms);
        if (!(t > 0)) return '';
        try {
            var d = new Date(t), n = new Date(), day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
            var diff = Math.round((day(n) - day(d)) / 86400000), time = ph.aiTimeShort(t);
            if (diff == 0) return time;
            if (diff == 1) return 'yesterday, ' + time;
            var o = { day: 'numeric', month: 'short' };
            if (d.getFullYear() != n.getFullYear()) o.year = 'numeric';
            return d.toLocaleDateString([], o) + ', ' + time;
        } catch (e) { return ''; }
    };
    obj.aiBusy = function (c) {
        return !!(c && (c.status == 'starting' || c.status == 'preview' || c.status == 'running' || c.status == 'stopping'));
    };
    obj.aiReqId = function () {
        return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e8).toString(36);
    };
    obj.aiSendMsg = function (pluginaction, o, nodeid) {
        var m = o || {};
        m.action = 'plugin'; m.plugin = 'eventlog'; m.pluginaction = pluginaction;
        m.nodeid = nodeid || ((typeof currentNode != 'undefined' && currentNode) ? currentNode._id : null);
        if (pluginaction == 'aiStart' || pluginaction == 'aiSend') {   // answers give times in the technician's zone
            try { var tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (typeof tz == 'string' && tz) m.tz = tz.slice(0, 64); } catch (e) { }
            try { m.tzOffsetMin = 0 - new Date().getTimezoneOffset(); } catch (e) { }
        }
        try { meshserver.send(m); return true; } catch (e) { return false; }
    };
    obj.aiSay = function (text) {
        var el = Q('evlAiSay');
        if (!el) return;
        el.textContent = '';
        setTimeout(function () { try { var e2 = Q('evlAiSay'); if (e2) e2.textContent = String(text); } catch (e) { } }, 60);
    };
    obj.aiCopyText = function (txt, btn) {
        var fallback = function () {
            var ta = document.createElement('textarea'); ta.value = txt; ta.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } catch (e2) { }
            document.body.removeChild(ta);
        };
        try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(fallback); else fallback(); } catch (e) { fallback(); }
        if (btn && btn.tagName) {
            if (btn._evlOld == null) btn._evlOld = btn.innerHTML;
            btn.innerHTML = 'Copied'; btn.classList.add('ok');
            setTimeout(function () { try { btn.innerHTML = btn._evlOld; btn._evlOld = null; btn.classList.remove('ok'); } catch (e) { } }, 1200);
        }
        pluginHandler.eventlog.aiSay('Copied to the clipboard.');
        return false;
    };

    // ---- state ----------------------------------------------------------------------------------------------------
    // st.ai lives in the tab state (reset on a device change); the conversations of the last 5 devices are stashed in
    // memory so switching back restores them. Nothing of it goes to localStorage (only the panel width does).
    obj.aiNewState = function () {
        var ph = pluginHandler.eventlog;
        var nid = (typeof currentNode != 'undefined' && currentNode) ? currentNode._id : null;
        var s = (ph._aiStash && nid) ? ph._aiStash[nid] : null;
        if (s) { delete ph._aiStash[nid]; ph._aiStashOrder = (ph._aiStashOrder || []).filter(function (x) { return x != nid; }); s.citeVer++; return s; }
        var win = getstore('evl_diag_win', '24h');
        if (['24h', '7d', 'restart'].indexOf(win) < 0) win = '24h';
        // saved: the server's saved results of this user on this device (null until asked for; ai/history.js on the
        // server), hist: the chat list is shown, opening: a chat id being loaded, delAsk: a chat id waiting for the
        // delete confirmation, exReq: saved explanations asked for (event id -> 1)
        // full: the panel takes the whole width (evl_ai_full), diagSetup: the window choice before a diagnosis runs,
        // act: a message action waiting for its inline editor or confirmation { cid, n, kind: 'edit'|'del'|'retry' },
        // pend: a message action sent to the server { cid, n, op, then }
        // genNew: the answer settings { thinking?, temperature? } for a chat not started yet (a chat keeps its own in
        // c.gen), genOpen: the Answer settings popover is open, fuReq: a "Suggest questions" request { reqId, cid, n }
        var full = false;
        try { full = getstore('evl_ai_full', '') == '1'; } catch (e) { }
        return { nodeid: nid, open: false, w: Number(getstore('evl_ai_w', '0')) || 0, convs: {}, chat: null, explainBy: {},
                 focus: null, sel: null, draft: '', diagWin: win, notice: null, reveal: null, peek: null, hyp: {}, citeVer: 0,
                 saved: null, hist: false, opening: null, delAsk: null, exReq: {}, full: full, diagSetup: false, act: null, pend: null,
                 genNew: {}, genOpen: false, fuReq: null };
    };
    obj.aiStashSave = function () {
        var ph = pluginHandler.eventlog, st = ph.st;
        if (st == null || st.ai == null || !st.ai.nodeid) return;
        ph.aiAbortAll();
        ph.aiDlgClose(true);
        var a = st.ai, nid = a.nodeid;
        a.notice = null; a.reveal = null; a.peek = null; a._cm = null;
        // a pending "Suggest questions" is dropped (its reply is for this device only) and the settings popover closes
        if (a.fuReq) { var ft = ph.aiTurnOf(a.convs[a.fuReq.cid], a.fuReq.n); if (ft) ft.fuBusy = null; a.fuReq = null; }
        if (a.genOpen) ph.aiGenClose(false);
        ph._aiStash = ph._aiStash || {};
        ph._aiStashOrder = (ph._aiStashOrder || []).filter(function (x) { return x != nid; });
        ph._aiStashOrder.push(nid);
        ph._aiStash[nid] = a;
        while (ph._aiStashOrder.length > 5) { var old = ph._aiStashOrder.shift(); delete ph._aiStash[old]; }
    };
    // Stop everything still running (device change, permission revoked). Uses the conversation's own device id.
    obj.aiAbortAll = function () {
        var ph = pluginHandler.eventlog, st = ph.st;
        if (st == null || st.ai == null) return;
        var a = st.ai;
        for (var id in a.convs) {
            var c = a.convs[id];
            if (!ph.aiBusy(c)) continue;
            if (c.convId) { ph.aiSendMsg(c.status == 'preview' ? 'aiClose' : 'aiStop', { convId: c.convId }, a.nodeid); if (c.status == 'preview') c.closed = true; }
            else { ph._aiOrphans = ph._aiOrphans || {}; ph._aiOrphans[c.reqId] = 1; }
            var t = c.turns[c.turns.length - 1];
            if (t && t.status == 'running') t.status = 'stopped';
            c.status = 'stopped';
        }
        ph.aiTimersStop();
    };
    obj.aiNewTurn = function (n, q) {
        return { n: n, srvN: null, q: q, status: 'running', steps: [], text: '', live: '', html: '', sHtml: null, structured: null, cites: {}, invalid: [],
                 usage: null, followups: [], error: null, lastSeq: 0, gap: false, segment: 0, round: 0, diag: false, t0: Date.now() };
    };
    // a conversation of the chat panel: an Ask chat, or a diagnosis chat (its first turn is the diagnosis)
    obj.aiIsChat = function (c) {
        return !!(c && (c.mode == 'ask' || c.mode == 'diagnose'));
    };
    // the tool steps of a turn (its steps also hold the notes the model wrote between lookups)
    obj.aiToolSteps = function (t) {
        return (t && t.steps ? t.steps : []).filter(function (x) { return x != null && x.note == null; });
    };
    obj.aiNewConv = function (mode, input, q) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        ph._aiSeq = (ph._aiSeq || 0) + 1;
        var c = { id: 'c' + ph._aiSeq, mode: mode, input: input, reqId: ph.aiReqId(), convId: null, status: 'starting', closed: false, ended: false,
                  info: null, notes: [], preview: null, red: null, last: Date.now(), doneAt: 0, turns: [ph.aiNewTurn(1, q)],
                  gen: (mode == 'explain') ? {} : ph.aiGenClean(a.genNew) };
        if (mode == 'diagnose') c.turns[0].diag = true;
        a.convs[c.id] = c;
        ph.aiPrune();
        return c;
    };
    // Keep at most ~24 conversations per device in memory; the oldest idle Explain results go first.
    obj.aiPrune = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        var ids = Object.keys(a.convs).sort(function (x, y) { return Number(x.slice(1)) - Number(y.slice(1)); });
        for (var i = 0; i < ids.length && Object.keys(a.convs).length > 24; i++) {
            var c = a.convs[ids[i]];
            if (c.id == a.chat || ph.aiBusy(c)) continue;
            ph.aiCloseConv(c);
            for (var k in a.explainBy) { if (a.explainBy[k] == c.id) delete a.explainBy[k]; }
            delete a.convs[c.id];
        }
    };
    obj.aiStartConv = function (c) {
        var ph = pluginHandler.eventlog;
        c.last = Date.now();
        var m = { reqId: c.reqId, mode: c.mode, input: c.input }, g = ph.aiGenOut(c.gen);
        if (g) m.gen = g;
        ph.aiSendMsg('aiStart', m);
        ph.aiDogStart();
    };
    obj.aiCloseConv = function (c) {
        var ph = pluginHandler.eventlog;
        if (c && c.convId && !c.closed) ph.aiSendMsg('aiClose', { convId: c.convId });
        if (c) c.closed = true;
    };
    obj.aiOk = function (m) {
        var ph = pluginHandler.eventlog;
        return (m != null && typeof currentNode != 'undefined' && currentNode != null && m.nodeid == currentNode._id &&
                ph.st != null && ph.st.ai != null && ph.st.ai.nodeid == currentNode._id);
    };
    obj.aiFind = function (m) {
        var a = pluginHandler.eventlog.st.ai, id, c;
        if (m.convId != null) { for (id in a.convs) { c = a.convs[id]; if (c.convId != null && c.convId === m.convId) return c; } }
        if (m.reqId != null) { for (id in a.convs) { c = a.convs[id]; if (c.reqId === m.reqId && (c.convId == null || m.convId == null || c.convId === m.convId)) return c; } }
        return null;
    };
    obj.aiTurn = function (c, n) {
        var ts = c.turns, i;
        if (typeof n == 'number') { for (i = ts.length - 1; i >= 0; i--) { if (ts[i].srvN === n) return ts[i]; } }
        var t = ts[ts.length - 1];
        if (t && t.srvN == null && typeof n == 'number') t.srvN = n;
        return t;
    };
    obj.aiCitesOf = function (c) {
        var out = {};
        if (c) c.turns.forEach(function (t) { for (var r in t.cites) out[r] = 1; });
        return out;
    };
    obj.aiCite = function (c, ref) {
        if (!c || typeof ref != 'string' || !/^E\d{1,6}$/.test(ref)) return null;
        for (var i = c.turns.length - 1; i >= 0; i--) { if (Object.prototype.hasOwnProperty.call(c.turns[i].cites, ref)) return c.turns[i].cites[ref]; }
        return null;
    };

    // ---- watchdog: 90 s without any reply for a running request ends it with a Retry ---------------------------------
    obj.aiDogStart = function () {
        var ph = pluginHandler.eventlog;
        ph.aiTickStart();
        if (ph._aiDog) return;
        ph._aiDog = setInterval(function () { try { pluginHandler.eventlog.aiDog(); } catch (e) { } }, 5000);
    };
    obj.aiDog = function () {
        var ph = pluginHandler.eventlog, st = ph.st, any = false, now = Date.now();
        if (st == null || st.ai == null) { clearInterval(ph._aiDog); ph._aiDog = null; ph.aiTimersStop(); return; }
        for (var id in st.ai.convs) {
            var c = st.ai.convs[id];
            if (c.status != 'starting' && c.status != 'running' && c.status != 'stopping') continue;
            any = true;
            if (now - c.last < 90000) continue;
            if (c.convId) ph.aiSendMsg('aiStop', { convId: c.convId }, st.ai.nodeid);
            else { ph._aiOrphans = ph._aiOrphans || {}; ph._aiOrphans[c.reqId] = 1; }
            var t = c.turns[c.turns.length - 1];
            t.status = 'error'; t.error = { code: 'noReply', message: '', retryable: true };
            c.status = 'error';
            ph.aiRefresh(c);
            ph.aiSay(ph.aiErrText('noReply'));
        }
        if (!any) { clearInterval(ph._aiDog); ph._aiDog = null; }
    };

    // ---- server replies -------------------------------------------------------------------------------------------
    obj.onAiStarted = function (server, m) {
        var ph = pluginHandler.eventlog;
        var cidOk = (m && typeof m.convId == 'string' && /^[\w-]{1,80}$/.test(m.convId));
        if (m && m.reqId != null && ph._aiOrphans && ph._aiOrphans[m.reqId]) {   // started after the user left or stopped it
            delete ph._aiOrphans[m.reqId];
            if (cidOk) ph.aiSendMsg('aiClose', { convId: m.convId }, m.nodeid);
            return;
        }
        if (!ph.aiOk(m) || !cidOk) return;
        var c = ph.aiFind({ reqId: m.reqId });
        if (!c || (c.convId != null && c.convId !== m.convId)) return;
        c.convId = m.convId;
        if (c.status == 'stopped' || c.closed) { ph.aiCloseConv(c); return; }
        c.info = { endpointName: String(m.endpointName || '').slice(0, 120), model: String(m.model || '').slice(0, 200), network: m.network, redacted: m.redacted === true, toolMode: m.toolMode };
        c.notes = Array.isArray(m.notes) ? m.notes.filter(function (x) { return typeof x == 'string'; }).slice(0, 4).map(function (x) { return x.slice(0, 400); }) : [];
        if (ph.aiIsChat(c) && 'chatId' in m) c.chatId = (typeof m.chatId == 'string' && /^ch[0-9a-f]{24}$/.test(m.chatId)) ? m.chatId : null;
        c.last = Date.now();
        if (c.status == 'starting') c.status = 'running';
        ph.aiRefresh(c);
    };
    obj.onAiPreview = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m) || m.convId == null) return;
        var c = ph.aiFind({ convId: m.convId });
        if (!c || c.closed) return;
        var cats = Array.isArray(m.categories) ? m.categories : [];
        c.preview = {
            readable: (Array.isArray(m.readable) ? m.readable : []).slice(0, 40).map(function (x) { return { label: String((x && x.label) || ''), text: String((x && x.text) || '').slice(0, 400000) }; }),
            raw: (typeof m.raw == 'string') ? m.raw.slice(0, 600000) : JSON.stringify(m.raw == null ? '' : m.raw, null, 2).slice(0, 600000),
            categories: cats.filter(function (k) { return k && typeof k.id == 'string' && /^[\w-]{1,40}$/.test(k.id); }).slice(0, 20)
                            .map(function (k) { return { id: k.id, label: String(k.label || k.id), on: k.on !== false, count: (typeof k.count == 'number') ? k.count : null }; }),
            redactionCounts: m.redactionCounts || null
        };
        c.status = 'preview'; c.last = Date.now();
        ph.aiRefresh(c);
        ph.aiDlgOpen(c.id);
    };
    obj.onAiStep = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var c = ph.aiFind(m); if (!c || !ph.aiBusy(c)) return;
        var t = ph.aiTurn(c, m.turn), i = Number(m.i);
        if (!t || !(i >= 0 && i < 128) || Math.floor(i) !== i) return;
        t.steps[i] = { tool: String(m.tool || '').slice(0, 60), args: m.args, status: String(m.status || ''), items: Number(m.items) || 0, ms: Number(m.ms) || 0 };
        t.ph = 'step';
        c.last = Date.now();
        if (c.status == 'starting') c.status = 'running';
        ph.aiSchedule(c, t);
    };
    // What the model wrote in a round that also called tools: a note in the steps ("Model: I'll start with…"); the
    // text streamed for that round leaves the answer.
    obj.onAiNote = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var c = ph.aiFind(m); if (!c || !ph.aiBusy(c)) return;
        var t = ph.aiTurn(c, m.turn), i = Number(m.i), round = Number(m.round);
        if (!t || t.status != 'running' || !(i >= 0 && i < 128) || Math.floor(i) !== i) return;
        t.steps[i] = { note: String(m.text == null ? '' : m.text).slice(0, 2000) };
        if (!(round >= 0) || round >= (t.round || 0)) { t.text = ''; t.live = ''; t.gap = false; }
        t.ph = 'step';
        c.last = Date.now();
        if (c.status == 'starting') c.status = 'running';
        ph.aiSchedule(c, t);
    };
    // The model is reasoning: a count of reasoning characters for model call `round` of the turn, never the text.
    obj.onAiThinking = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var c = ph.aiFind(m); if (!c || !ph.aiBusy(c)) return;
        var t = ph.aiTurn(c, m.turn), round = Number(m.round), chars = Number(m.chars);
        if (!t || t.status != 'running' || !(round >= 0 && round < 1000) || Math.floor(round) !== round) return;
        chars = (chars >= 0 && chars < 1e9) ? Math.floor(chars) : 0;
        if (t.think && t.think.round > round) return;   // an older model call
        t.think = { round: round, chars: chars };
        t.ph = 'think';
        c.last = Date.now();
        if (c.status == 'starting') c.status = 'running';
        ph.aiSchedule(c, t);
    };
    // "1.2k characters" (a number only; the reasoning itself is never shown)
    obj.aiThinkCount = function (n) {
        n = Math.floor(Number(n) || 0);
        if (n <= 0) return '';
        if (n < 1000) return n + ' characters';
        var k = n / 1000;
        return (k < 10 ? (Math.floor(k * 10) / 10).toFixed(1) : String(Math.floor(k))) + 'k characters';
    };
    obj.onAiDelta = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var c = ph.aiFind(m); if (!c || !ph.aiBusy(c)) return;
        var t = ph.aiTurn(c, m.turn), seq = Number(m.seq), round = Number(m.round);
        if (!t || t.status != 'running' || !(seq > t.lastSeq)) return;
        // each model call (round) writes afresh: an earlier round's text was a note between lookups
        if (round > 0 && round < 1e6 && round !== t.round) { if (t.round) { t.text = ''; t.gap = false; } t.round = round; }
        if (seq !== t.lastSeq + 1) t.gap = true;   // a lost chunk: keep what we have, the final text replaces it
        else if (!t.gap && t.text.length < 400000) t.text += String(m.text == null ? '' : m.text);
        if (m.text != null && String(m.text) !== '') t.ph = 'write';
        t.lastSeq = seq;
        c.last = Date.now();
        if (c.status == 'starting') c.status = 'running';
        ph.aiSchedule(c, t);
    };
    obj.onAiDone = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var c = ph.aiFind(m); if (!c) return;
        var a = ph.st.ai, t = ph.aiTurn(c, m.turn);
        if (!t || t.status == 'done') return;
        t.cites = ph.aiCitesIn(m.citations);
        t.text = String(m.text == null ? '' : m.text).slice(0, 400000);
        t.structured = (m.structured && typeof m.structured == 'object') ? m.structured : null;
        t.invalid = Array.isArray(m.invalidCitations) ? m.invalidCitations : [];
        t.usage = (m.usage && typeof m.usage == 'object') ? m.usage : null;
        t.followups = (Array.isArray(m.followups) ? m.followups : []).filter(function (f) { return typeof f == 'string' && f.trim(); }).slice(0, 3).map(function (f) { return f.slice(0, 200); });
        t.segment = Number(m.segment) || 0;
        t.status = 'done'; t.live = ''; t.sHtml = null;
        if (m.redactionCounts) c.red = m.redactionCounts;
        c.status = 'done'; c.doneAt = Date.now(); c.last = Date.now();
        if (ph.aiIsChat(c) && typeof m.chatId == 'string' && /^ch[0-9a-f]{24}$/.test(m.chatId)) c.chatId = m.chatId;
        t.html = ph.aiMd(t.text, c);
        ph.aiHistoryTouch(c, t);
        a.focus = c.id; a.citeVer++;
        ph.aiRefresh(c, true);
        ph.aiSay(t.diag ? 'The diagnosis is ready.' : (c.mode == 'explain' ? 'The explanation is ready.' : 'The answer is ready.'));
    };
    obj.onAiError = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var fr = ph.st.ai.fuReq;   // a "Suggest questions" request: only its button shows the failure
        if (m.scope == 'followups' || (fr && m.reqId != null && m.reqId === fr.reqId)) { ph.aiFuFail(m); return; }
        var c = ph.aiFind(m); if (!c) return;
        var code = String(m.code || 'internal'), msg = String(m.message || '');
        // an idle conversation closed by the server (expired, or evicted for a newer one)
        if (code == 'aborted' && /expired|evicted|make room/i.test(msg)) {
            c.closed = true; c.ended = true;
            if (!ph.aiBusy(c)) { ph.aiRefresh(c); return; }
        }
        var t = ph.aiTurn(c, m.turn);
        if (!t) return;
        if (t.status == 'done' && !ph.aiBusy(c)) return;
        ph.aiDlgClose(true, c.id);
        if (code == 'aborted' && t.status == 'stopped') { c.status = 'stopped'; ph.aiRefresh(c); return; }
        t.status = (code == 'aborted') ? 'stopped' : 'error';
        t.error = { code: code, message: msg.slice(0, 300), retryable: m.retryable === true, phase: typeof m.phase == 'string' ? m.phase : null };
        if (t.text) t.live = ph.aiMd(ph.aiVisible(t.text), c, { streaming: true });
        c.status = (code == 'aborted') ? 'stopped' : 'error';
        if (c.convId == null || code == 'invalid' && /no longer open/i.test(msg)) c.closed = (c.convId != null);
        if (code == 'denied') { try { ph.elRequestAccess(true); } catch (e) { } }
        ph.aiRefresh(c);
        if (code != 'aborted') ph.aiSay(ph.aiErrText(code, t.error.phase));
    };

    // ---- saved results (chats incl. diagnoses, explanations; kept on the server per user and device) ------------
    // citations as the server sent them ({ E3: stored event }) -> { E3: { rec, ev, id } }
    obj.aiCitesIn = function (src) {
        var ph = pluginHandler.eventlog, cs = {};
        src = (src && typeof src == 'object') ? src : {};
        for (var r in src) {
            if (!/^E\d{1,6}$/.test(r)) continue;
            var v = src[r], rec = (v && v.rec && typeof v.rec == 'object') ? v.rec : v;
            if (!rec || typeof rec != 'object') continue;
            var ev = ph.elNormalize(rec);
            if (!ev) continue;
            cs[r] = { rec: rec, ev: ev, id: (rec._id != null) ? String(rec._id) : null };
        }
        return cs;
    };
    // Ask the server once per device for what is saved (after onAccess granted the Assistant).
    obj.aiHistoryInit = function () {
        var ph = pluginHandler.eventlog, st = ph.st, acc = ph.elAccess || {};
        if (st == null || st.ai == null || !ph.elCan('assistant') || st.ai.saved != null) return;
        var h = (acc.saved && typeof acc.saved == 'object') ? acc.saved : {};
        if (h.enabled !== true) { st.ai.saved = { loaded: true, enabled: false, retentionDays: null, chats: [], explains: {} }; return; }
        st.ai.saved = { loaded: false, enabled: true, retentionDays: Number(h.retentionDays) || null, chats: [], explains: {} };
        ph.aiSendMsg('aiHistoryList', {}, st.ai.nodeid);
    };
    obj.aiHistoryGet = function (kind, id) {
        var ph = pluginHandler.eventlog;
        ph.aiSendMsg('aiHistoryGet', { kind: kind, id: id == null ? null : id }, ph.st.ai.nodeid);
    };
    obj.onAiHistory = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var a = ph.st.ai, isId = function (x) { return typeof x == 'string' && /^ch[0-9a-f]{24}$/.test(x); };
        var sv = { loaded: true, enabled: m.enabled === true, retentionDays: Number(m.retentionDays) || null, chats: [], explains: {} };
        (Array.isArray(m.chats) ? m.chats : []).slice(0, 50).forEach(function (x) {
            if (!x || !isId(x.id)) return;
            var e = { id: x.id, title: String(x.title || 'Chat').slice(0, 120), updated: Number(x.updated) || 0, count: Math.max(0, Math.floor(Number(x.count) || 0)) };
            if (x.type == 'diagnosis') { e.type = 'diagnosis'; e.window = (['24h', '7d', 'restart'].indexOf(x.window) >= 0) ? x.window : null; }
            sv.chats.push(e);
        });
        (Array.isArray(m.explains) ? m.explains : []).slice(0, 200).forEach(function (x) { if (x && typeof x.eventId == 'string' && x.eventId.length <= 64) sv.explains[x.eventId] = Number(x.time) || 0; });
        a.saved = sv;
        if (sv.enabled) {
            // after a reload: the most recent chat (or diagnosis) comes back into the panel
            var cur = a.convs[a.chat];
            if (!cur && !a.opening && sv.chats.length) { a.opening = sv.chats[0].id; a.openAuto = true; ph.aiHistoryGet('chat', sv.chats[0].id); }
        }
        if (a.open) ph.aiRenderPanel();
        if (Object.keys(sv.explains).length) ph.elUpdate();
    };
    // A conversation object for a saved item, shown like a finished one (no server conversation behind it).
    // kind 'chat' (an Ask chat, or a diagnosis chat: item.type 'diagnosis') or 'explain'
    obj.aiConvFromSaved = function (kind, item) {
        var ph = pluginHandler.eventlog, a = ph.st.ai;
        var isDiag = (kind == 'chat' && item.type == 'diagnosis');
        var mode = (kind == 'chat') ? (isDiag ? 'diagnose' : 'ask') : 'explain';
        var msgs = (kind == 'chat') ? (Array.isArray(item.messages) ? item.messages : []) : [item];
        ph._aiSeq = (ph._aiSeq || 0) + 1;
        var lastMsg = msgs[msgs.length - 1] || {};
        var c = { id: 'c' + ph._aiSeq, mode: mode, input: {}, reqId: null, convId: null, status: 'done', closed: true, ended: false, restored: true,
                  info: { endpointName: String(lastMsg.endpointName || item.endpointName || '').slice(0, 120), model: String(lastMsg.model || item.model || '').slice(0, 200), network: null, redacted: null },
                  notes: [], preview: null, red: (lastMsg.redactionCounts && typeof lastMsg.redactionCounts == 'object') ? lastMsg.redactionCounts : null,
                  last: Date.now(), doneAt: Number(item.updated || item.time) || 0, turns: [] };
        // the message actions address messages by their index in the saved chat
        c.msgOff = Math.max(0, msgs.length - 200);
        if (isDiag && c.msgOff) c.msgOff = 0;   // (never more than 200 messages in practice; the diagnosis must stay first)
        msgs.slice(c.msgOff, c.msgOff + 200).forEach(function (x, i) {
            if (!x || typeof x != 'object') return;
            var q = (kind == 'chat') ? String(x.q || '') : '';
            var t = ph.aiNewTurn(i + 1, q);
            t.srvN = -1; t.status = 'done'; t.restored = true; t.at = Number(x.time) || 0; t.cont = (x.cont === true && i > 0);
            t.diag = (isDiag && i == 0);
            t.text = String((kind == 'chat' ? x.a : x.text) || '').slice(0, 400000);
            t.structured = (x.structured && typeof x.structured == 'object') ? x.structured : null;
            t.cites = ph.aiCitesIn(x.cites);
            t.invalid = Array.isArray(x.invalid) ? x.invalid : [];
            t.usage = (x.usage && typeof x.usage == 'object') ? x.usage : null;
            t.followups = (Array.isArray(x.followups) ? x.followups : []).filter(function (f) { return typeof f == 'string' && f.trim(); }).slice(0, 3).map(function (f) { return f.slice(0, 200); });
            t.steps = (Array.isArray(x.steps) ? x.steps : []).slice(0, 128).map(function (s) {
                if (s && typeof s.note == 'string') return { note: s.note.slice(0, 2000) };
                var args = s && s.args; if (typeof args == 'string') { try { args = JSON.parse(args); } catch (e) { } }
                return { tool: String((s && s.tool) || '').slice(0, 60), args: args, status: (s && s.status == 'error') ? 'error' : 'done', items: Number(s && s.items) || 0, ms: Number(s && s.ms) || 0 };
            });
            c.turns.push(t);
        });
        if (!c.turns.length) return null;
        c.turns.forEach(function (t) { t.html = ph.aiMd(t.text, c); });
        if (kind == 'chat') { c.chatId = item.id; c.created = Number(item.created) || c.turns[0].at; c.gen = ph.aiGenClean(item.gen); }
        else c.gen = {};
        if (isDiag) { c.win = (['24h', '7d', 'restart'].indexOf(item.window) >= 0) ? item.window : '24h'; c.input = { window: c.win }; c.turns[0].q = 'Diagnose ' + ph.aiWinText(c.win); }
        if (kind == 'explain') {
            c.input = { eventId: String(item.eventId) }; c.doneAt = Number(item.time) || c.doneAt;
            for (var k in ph.byKey) { var e = ph.byKey[k]; if (e._raw && e._raw._id != null && String(e._raw._id) == c.input.eventId) { c.evLabel = e.source + ' ' + e.id; break; } }
            c.turns[0].q = 'Explain this event: ' + (c.evLabel || 'stored event');
        }
        a.convs[c.id] = c;
        return c;
    };
    obj.onAiHistoryItem = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var a = ph.st.ai, sv = a.saved || { chats: [], explains: {} }, item = (m.item && typeof m.item == 'object') ? m.item : null, c;
        if (m.kind == 'chat') {
            var want = a.opening, auto = a.openAuto;
            if (typeof m.id != 'string' || m.id !== want) return;   // not (or no longer) the chat asked for
            a.opening = null; a.openAuto = false;
            if (!item) {
                sv.chats = sv.chats.filter(function (x) { return x.id !== m.id; });
                if (!auto) ph.aiSay('This chat is no longer saved.');
                if (a.open) ph.aiRenderPanel();
                return;
            }
            var cur = a.convs[a.chat];
            if (auto && cur) return;               // the user started something else meanwhile
            if (cur && ph.aiBusy(cur)) return;
            c = ph.aiConvFromSaved('chat', Object.assign({}, item, { id: m.id }));
            if (!c) return;
            if (ph.aiIsChat(cur)) { ph.aiCloseConv(cur); delete a.convs[cur.id]; }
            a.chat = c.id; a.hist = false; a.diagSetup = false; a.act = null; a.focus = c.id; a.sel = null; a.peek = null; a.citeVer++;
            ph.aiRenderPanel();
            ph.elUpdate();
            if (!auto) { ph.aiSay(c.mode == 'diagnose' ? 'Opened the saved diagnosis.' : 'Opened the saved chat.'); var ta = Q('evlAiIn'); if (ta) ta.focus(); }
            return;
        }
        if (m.kind == 'explain' && typeof m.id == 'string') {
            if (!item) { delete sv.explains[m.id]; a.exReq[m.id] = 'gone'; }
            else if (!a.convs[a.explainBy[m.id]]) {
                c = ph.aiConvFromSaved('explain', Object.assign({}, item, { eventId: m.id }));
                if (c) a.explainBy[m.id] = c.id;
            }
            ph.elUpdate();
        }
    };
    obj.onAiHistoryDeleted = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m) || m.kind != 'chat' || typeof m.id != 'string') return;
        var a = ph.st.ai, sv = a.saved;
        if (sv) sv.chats = sv.chats.filter(function (x) { return x.id !== m.id; });
        if (m.ok !== true) { ph.aiSay('The chat could not be deleted.'); if (a.open) ph.aiRenderPanel(); return; }
        for (var id in a.convs) {
            var c = a.convs[id];
            if (!ph.aiIsChat(c) || c.chatId !== m.id || ph.aiBusy(c)) continue;
            ph.aiCloseConv(c);
            if (a.chat == c.id) { a.chat = null; if (a.focus == c.id) { a.focus = null; a.sel = null; } a.citeVer++; }
            delete a.convs[id];
        }
        if (a.open) ph.aiRenderPanel();
        ph.elUpdate();
        ph.aiSay('Chat deleted.');
        var f = document.querySelector('#evlAiLog .evlAiHistRow button.evlAiHistOpen') || Q('evlAiHistBtn');
        if (f) f.focus();
    };
    // A finished answer is saved by the server: keep the local list in step without asking again.
    obj.aiHistoryTouch = function (c, t) {
        var ph = pluginHandler.eventlog, a = ph.st.ai, sv = a.saved, now = Date.now();
        if (!sv || !sv.enabled || !sv.loaded) return;
        if (ph.aiIsChat(c) && c.chatId) {
            var e = null;
            sv.chats = sv.chats.filter(function (x) { if (x.id === c.chatId) { e = x; return false; } return true; });
            if (!e) {
                var q = String(c.turns[0].q || '').replace(/\s+/g, ' ').trim();
                if (c.mode == 'diagnose') q = ph.aiDiagTitle(c);
                e = { id: c.chatId, title: q.length > 80 ? q.slice(0, 79) + '…' : (q || 'Chat'), updated: now, count: 0 };
                if (c.mode == 'diagnose') { e.type = 'diagnosis'; e.window = c.win || '24h'; }
            }
            e.updated = now; e.count = Math.max(e.count + 1, c.turns.filter(function (x) { return x.status == 'done'; }).length);
            sv.chats.unshift(e);
            if (sv.chats.length > 50) sv.chats.length = 50;
            if (a.open) QH('evlAiHd', ph.aiHeadHtml(a.convs[a.chat] || null));
        } else if (c.mode == 'explain' && c.input && c.input.eventId) sv.explains[c.input.eventId] = now;
    };
    obj.aiHistoryToggle = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        a.hist = !a.hist; a.delAsk = null;
        ph.aiRenderPanel();
        var f = a.hist ? (document.querySelector('#evlAiLog .evlAiHistRow.cur button.evlAiHistOpen') || document.querySelector('#evlAiLog button.evlAiHistOpen')) : Q('evlAiIn');
        if (!f) f = Q('evlAiHistBtn');
        if (f) f.focus();
        return false;
    };
    // The chat list, newest first, grouped by day.
    obj.aiHistoryHtml = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, sv = a.saved || { chats: [] }, esc = ph.aiEsc, cur = a.convs[a.chat];
        var h = '<div class=evlAiHist>';
        if (!sv.loaded) return h + '<p class=evlAiMuted>Loading your chats…</p></div>';
        if (!sv.chats.length) h += '<p class=evlAiMuted>No saved chats for this device yet. Ask a question or run a diagnosis and it appears here.</p>';
        var day = function (t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
        var today = day(Date.now()), lastDay = null, open = false;
        sv.chats.forEach(function (x) {
            var d = day(x.updated);
            if (d !== lastDay) {
                if (open) h += '</ul>';
                var diff = Math.round((today - d) / 86400000);
                var lab = diff <= 0 ? 'Today' : (diff == 1 ? 'Yesterday' : new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }));
                h += '<h3 class=evlAiHistDay>' + esc(lab) + '</h3><ul class=evlAiHistL>';
                lastDay = d; open = true;
            }
            var isCur = !!(cur && cur.chatId === x.id), busy = isCur && ph.aiBusy(cur), n = x.count, dg = (x.type == 'diagnosis');
            if (dg) n = Math.max(0, n - 1);   // the diagnosis itself is not a question
            var meta = ph.aiTimeShort(x.updated) + (n ? ', ' + n + (n == 1 ? (dg ? ' follow-up question' : ' question') : (dg ? ' follow-up questions' : ' questions')) : '');
            var mk = dg ? '<span class=evlAiDgMark>' + esc(ph.aiWinShort(x.window)) + '</span>' : '';
            h += '<li class="evlAiHistRow' + (isCur ? ' cur' : '') + '">';
            if (a.delAsk === x.id) {
                h += '<div class=evlAiHistAsk role=group aria-label="Delete this chat?"><span>Delete “' + esc(x.title) + '”? This cannot be undone.</span>' +
                     '<button class="evlBtn mini evlAiDanger" onclick="return pluginHandler.eventlog.aiHistoryDelYes(\'' + x.id + '\')">Delete</button>' +
                     '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiHistoryDelNo()">Keep</button></div>';
            } else {
                h += '<button class="evlAiHistOpen" onclick="return pluginHandler.eventlog.aiHistoryOpen(\'' + x.id + '\')"' + (isCur ? ' aria-current=true' : '') + '>' +
                     '<span class=t>' + esc(x.title) + '</span><span class=m>' + mk + esc(meta) + (isCur ? ' (open)' : '') + '</span></button>' +
                     '<button class="evlBtn mini evlAiHistDel" aria-label="Delete chat “' + esc(x.title) + '”" title="' + (busy ? 'Wait until the answer is finished' : 'Delete this chat') + '"' + (busy ? ' disabled' : '') +
                     ' onclick="return pluginHandler.eventlog.aiHistoryDel(\'' + x.id + '\')"><svg width=12 height=12 viewBox="0 0 16 16" fill=none stroke=currentColor stroke-width=1.8 aria-hidden=true><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button>';
            }
            h += '</li>';
        });
        if (open) h += '</ul>';
        h += '<p class=evlAiHistNote>' + esc(ph.aiSavedNote()) + '</p>';
        return h + '</div>';
    };
    // "Diagnosis · 24 h": the marker of a diagnosis chat in the list
    obj.aiWinShort = function (w) {
        return 'Diagnosis \u00b7 ' + (({ '24h': '24 h', '7d': '7 days', restart: 'restart' })[w] || '24 h');
    };
    // the list title of a diagnosis chat before the server's list has it: the first sentence of its summary
    obj.aiDiagTitle = function (c) {
        var ph = pluginHandler.eventlog, t0 = c && c.turns[0], s = t0 && t0.structured ? String(t0.structured.summary || '') : '';
        s = ph.aiStripMarks(s).replace(/\s*\[\s*E\d{1,6}(?:\s*[,;]\s*E\d{1,6})*\s*\]/g, '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
        var m = /^(.{12,}?[.!?])(\s|$)/.exec(s);
        if (m) s = m[1];
        return s || ('Diagnosis of ' + ph.aiWinText(c && c.win));
    };
    obj.aiSavedNote = function () {
        var sv = pluginHandler.eventlog.elState().ai.saved, n = sv && sv.retentionDays;
        return 'Chats are saved for ' + (n ? n + (n == 1 ? ' day' : ' days') : 'a while') + ' and visible only to you.';
    };
    obj.aiHistoryOpen = function (id) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, cur = a.convs[a.chat];
        if (typeof id != 'string' || !/^ch[0-9a-f]{24}$/.test(id)) return false;
        if (cur && cur.chatId === id) { a.hist = false; ph.aiRenderPanel(); var ta = Q('evlAiIn'); if (ta) ta.focus(); return false; }
        if (cur && ph.aiBusy(cur)) { ph.aiSay('Wait until the answer is finished, or stop it first.'); return false; }
        a.opening = id; a.openAuto = false; a.hist = false;
        ph.aiHistoryGet('chat', id);
        ph.aiRenderPanel();
        return false;
    };
    obj.aiHistoryDel = function (id) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        a.delAsk = id;
        ph.aiRenderPanel();
        var b = document.querySelector('#evlAiLog .evlAiHistAsk .evlAiDanger'); if (b) b.focus();
        return false;
    };
    obj.aiHistoryDelYes = function (id) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (typeof id != 'string' || !/^ch[0-9a-f]{24}$/.test(id)) return false;
        a.delAsk = null;
        ph.aiSendMsg('aiHistoryDelete', { kind: 'chat', id: id }, a.nodeid);
        return false;
    };
    obj.aiHistoryDelNo = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        a.delAsk = null;
        ph.aiRenderPanel();
        var f = document.querySelector('#evlAiLog button.evlAiHistOpen'); if (f) f.focus();
        return false;
    };

    // Re-render whatever shows this conversation.
    obj.aiRefresh = function (c, done) {
        var ph = pluginHandler.eventlog, st = ph.st;
        if (st == null || st.ai == null || !Q('evlWrap')) return;
        var a = st.ai;
        if (a.chat == c.id) ph.aiRenderPanel();
        if (c.mode == 'explain' || (done && a.focus == c.id)) ph.elUpdate();
        else ph.aiApplySel();
        ph.aiBtnSync();
        ph.aiTick();
    };
    // Streaming: re-render at most every 120 ms (300 ms for long answers), only the parts that changed.
    obj.aiSchedule = function (c, t) {
        var ph = pluginHandler.eventlog, key = c.id + '-' + t.n;
        ph._aiT = ph._aiT || {};
        if (ph._aiT[key]) return;
        ph._aiT[key] = setTimeout(function () {
            var p = pluginHandler.eventlog; delete p._aiT[key];
            try { p.aiFlush(c.id, t.n); } catch (e) { }
        }, t.text.length > 8192 ? 300 : 120);
    };
    obj.aiFlush = function (cid, n) {
        var ph = pluginHandler.eventlog, st = ph.st;
        if (st == null || st.ai == null) return;
        var c = st.ai.convs[cid]; if (!c) return;
        var t = null; c.turns.forEach(function (x) { if (x.n == n) t = x; });
        if (!t || t.status != 'running') return;
        t.live = t.text ? ph.aiMd(ph.aiVisible(t.text), c, { streaming: true, caret: true }) : '';
        var log = Q('evlAiLog'), stick = log ? (log.scrollHeight - log.scrollTop - log.clientHeight < 48) : false;
        var nodes = document.querySelectorAll('#pluginEventLog [data-t="' + cid + '-' + n + '"]');
        for (var i = 0; i < nodes.length; i++) {
            var p = nodes[i].getAttribute('data-p');
            if (p == 'a') nodes[i].innerHTML = t.live || ph.aiWaitHtml(c, t);
            else if (p == 's') nodes[i].outerHTML = ph.aiStepsHtml(c, t);
            else if (p == 'l') nodes[i].outerHTML = ph.aiLiveHtml(c, t);
        }
        ph.aiAnnounce(c, t);
        if (log && stick && st.ai.chat == cid) log.scrollTop = log.scrollHeight;
        var lb = Q('evlAiLog'); if (lb) lb.setAttribute('aria-busy', ph.aiBusy(st.ai.convs[st.ai.chat]) ? 'true' : 'false');
    };
    // While streaming, hide the machine-readable blocks the model appends (and a tag still being typed).
    obj.aiVisible = function (text) {
        text = String(text == null ? '' : text);
        var m = /<\s*\/?\s*(?:diagnosis|explain|followups)\b/i.exec(text);
        if (m) text = text.slice(0, m.index);
        text = text.replace(/<\s*\/?\s*[a-z]{0,10}$/i, '');
        text = text.replace(/(^|\n)[ \t]*`{3,}[\w-]*[ \t]*\n?[ \t]*$/, '$1');
        return text;
    };

    // ---- Markdown rendering ---------------------------------------------------------------------------------------
    // Own marked and DOMPurify instances: MeshCentral installs a global DOMPurify hook for its notes.
    obj.aiMdInit = function () {
        var ph = pluginHandler.eventlog;
        if (ph._aiMd !== undefined) return ph._aiMd;
        ph._aiMd = null;
        try {
            if (typeof marked == 'undefined' || marked == null || typeof marked.Marked != 'function' || typeof DOMPurify != 'function') return null;
            var esc = function (x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
            var md = new marked.Marked({ gfm: true, breaks: true, async: false });
            md.use({ renderer: {
                // raw HTML from the model is shown as text, block and inline
                html: function (tok) {
                    var t = (tok && typeof tok == 'object') ? (tok.text != null ? tok.text : tok.raw) : tok;
                    var e = esc(t);
                    return (tok && tok.block) ? '<p>' + e.replace(/\n+$/, '').replace(/\n/g, '<br>') + '</p>\n' : e;
                },
                // images are never loaded: a link to them instead, with the domain shown
                image: function (tok) {
                    var href = (tok && typeof tok == 'object') ? tok.href : tok, text = (tok && typeof tok == 'object') ? tok.text : '', u = null;
                    try { if (/^https?:\/\//i.test(String(href || ''))) u = new URL(String(href)); } catch (e) { u = null; }
                    if (u == null || (u.protocol != 'http:' && u.protocol != 'https:')) return esc(text || '');
                    return '<a href="' + esc(u.href) + '">Image from ' + esc(u.hostname) + ' (opens in new tab)</a>';
                },
                // code blocks: the kind (command or other code) travels in a title we remove again after sanitizing
                code: function (tok) {
                    var text = (tok && typeof tok == 'object') ? tok.text : tok, lang = String((tok && tok.lang) || '').split(/\s/)[0].toLowerCase();
                    var cmd = ['powershell', 'pwsh', 'ps', 'ps1', 'bash', 'sh', 'shell', 'zsh', 'cmd', 'bat', 'batch', 'console', 'terminal'].indexOf(lang) >= 0;
                    return '<pre title="' + (cmd ? 'evl-cmd' : 'evl-code') + '"><code>' + esc(String(text == null ? '' : text).replace(/\n$/, '')) + '\n</code></pre>\n';
                }
            } });
            var pur = DOMPurify(window);
            pur.addHook('afterSanitizeAttributes', function (node) {
                if (!node || node.nodeName != 'A') return;
                var href = node.getAttribute('href') || '', u = null;
                if (/^https?:\/\//i.test(href)) { try { u = new URL(href); } catch (e) { u = null; } }
                if (u == null || (u.protocol != 'http:' && u.protocol != 'https:')) { node.removeAttribute('href'); node.removeAttribute('title'); return; }
                node.setAttribute('href', u.href);
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer');
                node.setAttribute('title', u.href);
                var host = u.hostname;
                if (host && String(node.textContent || '').toLowerCase().indexOf(host.toLowerCase()) < 0) node.appendChild(node.ownerDocument.createTextNode(' (' + host + ')'));
            });
            var cfg = {
                ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr', 'span'],
                ALLOWED_ATTR: ['href', 'title', 'start', 'align'],
                ALLOWED_URI_REGEXP: /^https?:\/\//i,
                ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
                RETURN_DOM_FRAGMENT: true
            };
            ph._aiMd = { md: md, pur: pur, cfg: cfg };
        } catch (e) { ph._aiMd = null; }
        return ph._aiMd;
    };
    // Model text -> safe HTML. c (optional) gives the conversation whose citations become chips.
    // opts: { inline, streaming }
    obj.aiMd = function (text, c, opts) {
        var ph = pluginHandler.eventlog;
        opts = opts || {};
        text = String(text == null ? '' : text);
        if (text.length > 400000) text = text.slice(0, 400000);
        // pseudonymized values -> numbered placeholders, so Markdown cannot reinterpret them; stray marks dropped
        var vals = [], src = '', last = 0, m, re = /([a-z]{1,12})([^-]{0,400}?)/g;
        while ((m = re.exec(text))) { src += text.slice(last, m.index).replace(/[-]/g, ''); vals.push(m[2]); src += '' + (vals.length - 1) + ''; last = re.lastIndex; }
        src += text.slice(last).replace(/[-]/g, '');
        var cites = ph.aiCitesOf(c), cid = c ? c.id : '';
        var lib = ph.aiMdInit();
        if (lib) {
            try {
                var html = opts.inline ? lib.md.parseInline(src) : lib.md.parse(src);
                var frag = lib.pur.sanitize(html, lib.cfg);
                ph.aiMdPost(frag, vals, cites, cid, opts.streaming === true);
                var div = document.createElement('div');
                div.appendChild(frag);
                if (opts.caret === true) ph.aiCaret(div);
                return div.innerHTML;
            } catch (e) { }
        }
        var fb = ph.aiMdFallback(src, vals, cites, cid, opts.streaming === true);
        return (opts.caret === true) ? fb.replace(/<\/p>$/, '<span class=evlAiCaret aria-hidden=true></span></p>') : fb;
    };
    obj.aiChipHtml = function (cid, ref, cls, label) {
        return '<button type=button class="evlCite' + (cls ? ' ' + cls : '') + '" data-c=' + cid + ' data-r=' + ref + ' aria-label="' + (label || ('Show cited event ' + ref)) + '"' +
               ' onclick="event.stopPropagation();return pluginHandler.eventlog.aiGotoCite(\'' + cid + '\',\'' + ref + '\')">' + ref + '</button>';
    };
    // Without marked/DOMPurify: escaped text with line breaks, still with tinted values and chips.
    obj.aiMdFallback = function (src, vals, cites, cid, streaming) {
        var ph = pluginHandler.eventlog;
        var h = ph.aiEsc(src).replace(/\r?\n/g, '<br>');
        h = h.replace(/(\d+)/g, function (x, i) { return '<mark class=evlPs title="Replaced before sending">' + ph.aiEsc(vals[Number(i)] || '') + '</mark>'; });
        h = h.replace(/\[unverified\]/g, '<span class=evlAiUnv>[unverified]</span>');
        h = h.replace(/\[\s*(E\d{1,6}(?:\s*[,;]\s*E\d{1,6})*)\s*\]/g, function (x, g) {
            var out = [];
            g.split(/\s*[,;]\s*/).forEach(function (r) {
                var mm = /^E0*(\d{1,6})$/.exec(r); if (!mm) return; r = 'E' + mm[1];
                if (cites[r] && /^c\d+$/.test(cid)) out.push(ph.aiChipHtml(cid, r));
                else if (streaming) out.push('<span class=evlCitePend>' + r + '</span>');
            });
            return out.join(' ');
        });
        return '<p>' + h + '</p>';
    };
    // After sanitizing: hrefless links unwrapped, values tinted, [E3] -> chips (valid refs only, not in code or links),
    // code blocks with a Copy button (and the read-only note for commands), tables in a scroll box.
    obj.aiMdPost = function (root, vals, cites, cid, streaming) {
        var ph = pluginHandler.eventlog, doc = root.ownerDocument || document, i;
        var as = root.querySelectorAll('a');
        for (i = 0; i < as.length; i++) {
            if (as[i].getAttribute('href')) continue;
            var pa = as[i].parentNode; while (as[i].firstChild) pa.insertBefore(as[i].firstChild, as[i]); pa.removeChild(as[i]);
        }
        var walker = doc.createTreeWalker(root, 4, null), texts = [], n;
        while ((n = walker.nextNode())) { if (/[\[]/.test(n.nodeValue)) texts.push(n); }
        var okCid = /^c\d+$/.test(cid);
        texts.forEach(function (node) {
            var s = node.nodeValue, par = node.parentNode;
            var inCode = !!(par && par.closest && par.closest('code,pre')), inA = !!(par && par.closest && par.closest('a'));
            var re = /(\d+)|\[\s*(E\d{1,6}(?:\s*[,;]\s*E\d{1,6})*)\s*\]|\[unverified\]/g, m, last = 0, frag = doc.createDocumentFragment(), changed = false;
            while ((m = re.exec(s))) {
                if (m[2] != null && (inCode || inA)) continue;
                changed = true;
                if (m.index > last) frag.appendChild(doc.createTextNode(s.slice(last, m.index)));
                last = re.lastIndex;
                if (m[1] != null) {
                    var mk = doc.createElement('mark'); mk.className = 'evlPs'; mk.setAttribute('title', 'Replaced before sending'); mk.textContent = vals[Number(m[1])] || ''; frag.appendChild(mk);
                } else if (m[2] != null) {
                    var refs = m[2].split(/\s*[,;]\s*/), first = true;
                    refs.forEach(function (r) {
                        var mm = /^E0*(\d{1,6})$/.exec(r); if (!mm) return; r = 'E' + mm[1];
                        var el = null;
                        if (cites[r] && okCid) {
                            el = doc.createElement('button'); el.type = 'button'; el.className = 'evlCite';
                            el.setAttribute('data-c', cid); el.setAttribute('data-r', r); el.setAttribute('aria-label', 'Show cited event ' + r);
                            el.setAttribute('onclick', "event.stopPropagation();return pluginHandler.eventlog.aiGotoCite('" + cid + "','" + r + "')");
                        } else if (streaming) { el = doc.createElement('span'); el.className = 'evlCitePend'; }
                        if (el == null) return;
                        el.textContent = r;
                        if (!first) frag.appendChild(doc.createTextNode(' '));
                        frag.appendChild(el); first = false;
                    });
                } else {
                    var u = doc.createElement('span'); u.className = 'evlAiUnv'; u.textContent = '[unverified]'; frag.appendChild(u);
                }
            }
            if (!changed) return;
            if (last < s.length) frag.appendChild(doc.createTextNode(s.slice(last)));
            par.replaceChild(frag, node);
        });
        var pres = root.querySelectorAll('pre');
        for (i = 0; i < pres.length; i++) {
            var pre = pres[i], cmd = (pre.getAttribute('title') == 'evl-cmd');
            pre.removeAttribute('title');
            var w = doc.createElement('div'); w.className = 'evlAiCodeW';
            var bar = doc.createElement('div'); bar.className = 'evlAiCodeBar';
            var lab = doc.createElement('span'); lab.textContent = cmd ? 'Command' : 'Code'; bar.appendChild(lab);
            var b = doc.createElement('button'); b.type = 'button'; b.className = 'evlBtn mini'; b.textContent = 'Copy';
            b.setAttribute('aria-label', cmd ? 'Copy the command' : 'Copy the code');
            b.setAttribute('onclick', 'return pluginHandler.eventlog.aiCopyCode(this)'); bar.appendChild(b);
            pre.parentNode.insertBefore(w, pre); w.appendChild(bar); w.appendChild(pre);
            if (cmd) { var note = doc.createElement('p'); note.className = 'evlAiCmdNote'; note.textContent = 'Run it yourself in Terminal; the assistant can only read.'; w.parentNode.insertBefore(note, w.nextSibling); }
        }
        var tbls = root.querySelectorAll('table');
        for (i = 0; i < tbls.length; i++) {
            var tw = doc.createElement('div'); tw.className = 'evlAiTbl';
            tbls[i].parentNode.insertBefore(tw, tbls[i]); tw.appendChild(tbls[i]);
        }
        return root;
    };
    obj.aiCopyCode = function (btn) {
        var ph = pluginHandler.eventlog, w = btn && btn.closest ? btn.closest('.evlAiCodeW') : null, pre = w ? w.querySelector('pre') : null;
        if (!pre) return false;
        return ph.aiCopyText(ph.aiStripMarks(pre.textContent).replace(/\n$/, ''), btn);
    };

    // ---- shared pieces --------------------------------------------------------------------------------------------
    // Why the Assistant is not offered on this device, as one plain sentence ('' when it is, or when the user lacks
    // the permission: those users see nothing about the Assistant). a = the onAccess answer.
    obj.aiUnavailText = function (a) {
        if (a == null || a.assistant === true) return '';
        var r = a.assistantReason, admin = (a.canManage === true), path = 'My Server \u2192 Plugins \u2192 Event Log \u2192 ';
        if (r == 'noEndpoint') {
            var set = (typeof a.configSetName == 'string' && a.configSetName) ? ' (' + a.configSetName + ')' : '';
            return 'Assistant: no endpoint is assigned to this device\'s config set' + set + '.' + (admin ? ' Assign one in ' + path + 'Config Sets.' : '');
        }
        if (r == 'disabled') return 'Assistant: turned off in the plugin settings.' + (admin ? ' Turn it on in ' + path + 'Assistant.' : '');
        if (r == 'deviceRights') return 'Assistant: needs the Details right on this device.';
        if (r == 'unavailable' || r == 'error') return 'Assistant: not available on this server (see the server log).';
        return '';
    };
    // phase: for 'timeout', where it happened (connect = the endpoint was never reached)
    obj.aiErrText = function (code, phase) {
        if (code == 'timeout' && phase == 'connect') return 'Could not connect to the endpoint. Try again; if it keeps failing, an administrator needs to check the endpoint address.';
        return ({
            denied: 'You do not have access to the Assistant on this device any more.',
            quota: 'You reached today\'s limit for the Assistant.',
            busy: 'Another question of yours is still running. Wait for it to finish, then try again.',
            noEndpoint: 'No assistant endpoint is assigned to this device\'s config set.',
            auth: 'The endpoint refused the API key. An administrator needs to check it in the plugin\'s Assistant settings.',
            model: 'The endpoint cannot run this request with the configured model. An administrator needs to check the endpoint.',
            rateLimit: 'The endpoint is limiting requests right now. Try again in a minute.',
            overloaded: 'The endpoint is overloaded. Try again in a minute.',
            timeout: 'The endpoint took too long to answer. Try again.',
            noReply: 'No reply from the server for 90 seconds. Try again.',
            network: 'The server could not reach the endpoint. Try again; if it keeps failing, an administrator needs to check the endpoint address.',
            blocked: 'The endpoint address is blocked by the plugin\'s network rules. An administrator needs to check it.',
            contextFull: 'The conversation no longer fits into the model\'s context. Start a new chat.',
            refusal: 'The model declined to answer. Rephrase the question and try again.',
            aborted: 'Stopped.',
            badResponse: 'The endpoint sent an answer the plugin could not read. Try again.',
            invalid: 'The server did not accept this request.',
            unavailable: 'The Assistant is not available on this server right now. An administrator can check the MeshCentral log.',
            internal: 'Something went wrong on the server. Try again.'
        })[code] || 'The request failed. Try again.';
    };
    obj.aiErrHtml = function (c, t) {
        var ph = pluginHandler.eventlog, e = t.error || {}, code = e.code || 'internal', esc = ph.aiEsc;
        var h = '<div class=evlAiErr role=alert><p>' + esc(ph.aiErrText(code, e.phase)) + '</p>';
        if (e.message && (['model', 'badResponse', 'blocked', 'network', 'auth', 'invalid', 'refusal'].indexOf(code) >= 0 || (code == 'timeout' && e.phase == 'connect'))) h += '<p class=evlAiMuted>' + esc(e.message) + '</p>';
        h += '<div class=evlAiActs>';
        var transient = ['timeout', 'noReply', 'network', 'overloaded', 'rateLimit', 'badResponse', 'internal', 'busy'];
        if (e.retryable || transient.indexOf(code) >= 0) h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiRetry(\'' + c.id + '\')">Try again</button>';
        if ((code == 'contextFull' || code == 'invalid') && c.mode == 'ask') h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiNewChat()">New chat</button>';
        if (code == 'denied') h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.elRecheckAccess()">Check access again</button>';
        return h + '</div></div>';
    };
    obj.aiArgsShort = function (args) {
        if (args == null) return '';
        if (typeof args != 'object') return String(args).slice(0, 80);
        var parts = [], val = function (v) { return Array.isArray(v) ? v.slice(0, 3).join('|') : String(v); };
        for (var k in args) {
            var v = args[k];
            if (v == null || v === '') continue;
            if (typeof v == 'object' && !Array.isArray(v)) { for (var k2 in v) { if (v[k2] != null && v[k2] !== '' && typeof v[k2] != 'object') parts.push(k2 + ': ' + v[k2]); else if (Array.isArray(v[k2])) parts.push(k2 + ': ' + val(v[k2])); } }
            else if (k == 'window' || k == 'ref' || k == 'provider') parts.push(val(v));
            else parts.push(k + ': ' + val(v));
        }
        var s = parts.join(', ');
        return s.length > 80 ? s.slice(0, 79) + '…' : s;
    };
    obj.aiStepResult = function (s) {
        if (s.status == 'running') return 'running';
        if (s.status == 'error') return 'failed';
        var noun = ({ event_facets: 'events', get_events: 'events', get_event: 'event', get_device_events: 'device events', event_groups: 'groups', get_installed_software: 'apps' })[s.tool];
        if (s.tool == 'lookup_event_id') return s.items ? 'reference' : 'no reference';
        if (noun && s.items >= 0) return s.items + ' ' + noun;
        return 'done';
    };
    obj.aiUsageText = function (t) {
        var n = pluginHandler.eventlog.aiToolSteps(t).length, u = t.usage || {}, parts = [];
        parts.push(n ? (n + (n == 1 ? ' step' : ' steps')) : 'No tools used');
        var ms = Number(u.ms) || 0;
        if (ms > 0) { var s = ms / 1000; parts.push(s < 10 ? s.toFixed(1) + ' s' : (s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s')); }
        var tok = (Number(u['in']) || 0) + (Number(u.out) || 0);
        if (tok > 0) parts.push((u.estimated ? 'about ' : '') + (tok < 1000 ? tok : (tok / 1000).toFixed(1) + 'k') + ' tokens');
        return parts.join(', ');
    };
    obj.aiStepsHtml = function (c, t) {
        var ph = pluginHandler.eventlog, esc = ph.aiEsc, key = c.id + '-' + t.n;
        var all = t.steps.filter(function (x) { return x != null; }), steps = ph.aiToolSteps(t);
        if (!all.length) return '<div data-t=' + key + ' data-p=s hidden></div>';
        var running = (t.status == 'running');
        var open = (t.stepsOpen != null) ? t.stepsOpen : running;
        var h = '<details class=evlAiSteps data-t=' + key + ' data-p=s' + (open ? ' open' : '') + '><summary onclick="return pluginHandler.eventlog.aiStepsClick(\'' + c.id + '\',' + t.n + ',this)">' +
                (running ? (steps.length ? steps.length + (steps.length == 1 ? ' step' : ' steps') + ' so far' : 'Getting started') : esc(ph.aiUsageText(t))) + '</summary><div class=evlAiStepL>';
        var k = 0;
        t.steps.forEach(function (s) {
            if (s == null) return;
            // what the model wrote between its lookups (model text: escaped, never Markdown here)
            if (s.note != null) { h += '<div class="evlAiStep note"><span class=n aria-hidden=true></span><span class=t><b>Model:</b> ' + ph.aiPlain(s.note) + '</span></div>'; return; }
            var r = ph.aiStepResult(s);
            h += '<div class=evlAiStep><span class=n>' + (++k) + '</span><code>' + esc(s.tool) + '(' + esc(ph.aiArgsShort(s.args)) + ')</code><span class="r' + (s.status == 'error' ? ' err' : '') + '">' + esc(r) + '</span></div>';
        });
        return h + '</div></details>';
    };
    obj.aiStepsClick = function (cid, n, el) {
        var a = pluginHandler.eventlog.elState().ai, c = a.convs[cid];
        if (c) c.turns.forEach(function (t) { if (t.n == n) t.stepsOpen = !(el && el.parentNode && el.parentNode.open); });
        return true;
    };
    // The answer area before any text: empty (the status line below it says what is going on); the review note
    // has its own box.
    obj.aiWaitHtml = function (c, t) {
        return '';
    };

    // ---- running state: activity strip, status line, elapsed time, streaming caret, toolbar dot -------------------
    // A tool call in plain words, with a short summary of its arguments ("counting events (24h, level: warning)").
    obj.aiToolWords = function (tool, args) {
        var ph = pluginHandler.eventlog, a = (args && typeof args == 'object') ? args : {};
        var w = ({ get_device_info: 'reading device details', event_facets: 'counting events', event_groups: 'grouping events', get_events: 'reading events',
                   get_event: 'reading one event', get_device_events: 'reading MeshCentral device events', get_installed_software: 'asking the agent for installed software' })[tool];
        if (tool == 'lookup_event_id') {
            var id = (a.id != null && typeof a.id != 'object') ? String(a.id).slice(0, 12) : '';
            var pr = (typeof a.provider == 'string') ? ph.aiStripMarks(a.provider).slice(0, 40) : '';
            return 'looking up event' + (id ? ' ' + id : '') + (pr ? ' (' + pr + ')' : '');
        }
        if (!w) return 'using ' + String(tool || 'a tool').replace(/_/g, ' ').slice(0, 40);
        if (tool == 'get_device_info' || tool == 'get_event' || tool == 'get_installed_software') return w;
        var x = ph.aiStripMarks(ph.aiArgsShort(args));
        if (x.length > 48) x = x.slice(0, 47) + '…';
        return w + (x ? ' (' + x + ')' : '');
    };
    // What a running turn is doing right now: { key, text, step, clock } or null when it is not running.
    obj.aiPhase = function (c, t) {
        var ph = pluginHandler.eventlog;
        if (!c || !t || t.status != 'running' || !ph.aiBusy(c)) return null;
        if (c.status == 'preview') return { key: 'review', text: 'Waiting for your review', step: '', clock: false };
        if (c.status == 'stopping') return { key: 'stop', text: 'Stopping…', step: '', clock: true };
        if (t.ph == 'write') return { key: 'write', text: ({ explain: 'Writing the explanation…', diagnose: 'Writing the diagnosis…' })[c.mode] || 'Writing the answer…', step: '', clock: true };
        if (t.ph == 'think') return { key: 'think' + ((t.think && t.think.round) || 0), text: 'Thinking…', count: ph.aiThinkCount(t.think && t.think.chars), step: '', clock: true };
        var ts = ph.aiToolSteps(t), n = ts.length, s = n ? ts[n - 1] : null;
        if (s) return { key: 'step' + n, text: ph.aiToolWords(s.tool, s.args), step: 'Step ' + n, clock: true };
        return { key: 'prep', text: 'Preparing…', step: '', clock: true };
    };
    obj.aiElapsed = function (ms) {
        var s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)), m = Math.floor(s / 60);
        if (m >= 60) return Math.floor(m / 60) + ':' + ('0' + (m % 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2);
        return m + ':' + ('0' + (s % 60)).slice(-2);
    };
    // The status line under a running answer. Visual only: phase changes reach screen readers through aiAnnounce.
    obj.aiLiveHtml = function (c, t) {
        var ph = pluginHandler.eventlog, esc = ph.aiEsc, key = c.id + '-' + t.n, p = ph.aiPhase(c, t);
        if (!p) return '<div data-t=' + key + ' data-p=l hidden></div>';
        var t0 = Number(t.t0) || Date.now();
        return '<div class=evlAiLive data-t=' + key + ' data-p=l aria-hidden=true><span class=evlAiLiveT>' + (p.step ? '<b>' + p.step + ':</b> ' : '') + esc(p.text) +
               (p.count ? ' <span class=evlAiThinkN>(' + esc(p.count) + ')</span>' : '') + '</span>' +
               (p.clock ? '<span class=evlAiClock data-t0=' + t0 + '>' + ph.aiElapsed(Date.now() - t0) + '</span>' : '') + '</div>';
    };
    // The thin progress strip. The sweep starts at the phase it would have reached since t0, so re-rendering
    // the surrounding view does not make it jump back to the start.
    obj.aiStripHtml = function (c, t) {
        var ph = pluginHandler.eventlog, on = !!(c && t && t.status == 'running' && ph.aiBusy(c) && c.status != 'preview');
        if (!on) return '<div class=evlAiStrip aria-hidden=true></div>';
        var d = (Date.now() - (Number(t.t0) || Date.now())) % 1800;
        return '<div class="evlAiStrip on" aria-hidden=true><i style="animation-delay:-' + Math.max(0, Math.floor(d)) + 'ms"></i></div>';
    };
    // The Stop button while the model works: a turning arc around the stop mark and the elapsed time (ticked by aiTick);
    // its accessible name stays "Stop". cls: extra classes ('mini' in the Explain box).
    obj.aiStopInner = function (t) {
        var ph = pluginHandler.eventlog, t0 = Number(t && t.t0) || Date.now();
        return '<svg class=evlAiRing width=16 height=16 viewBox="0 0 16 16" aria-hidden=true><circle class=trk cx=8 cy=8 r=6.5 /><circle class=arc cx=8 cy=8 r=6.5 /><rect x=5.6 y=5.6 width=4.8 height=4.8 rx=0.8 /></svg>' +
               '<span class=evlAiStopL>Stop</span><span class="evlAiClock evlAiStopT" data-t0=' + t0 + ' aria-hidden=true>' + ph.aiElapsed(Date.now() - t0) + '</span>';
    };
    // Streaming caret: after the last text of the answer so far (not after a command's note).
    obj.aiCaret = function (root) {
        var el = root, k;
        for (;;) {
            k = el.lastElementChild;
            if (k && k.classList && k.classList.contains('evlAiCmdNote')) k = k.previousElementSibling;
            if (!k || !/^(P|H[1-6]|LI|TD|TH|BLOCKQUOTE|UL|OL|TABLE|THEAD|TBODY|TR|DIV|PRE)$/.test(k.nodeName)) break;
            el = k;
            if (k.nodeName == 'PRE') { el = k.querySelector('code') || k; break; }
        }
        var c = (root.ownerDocument || document).createElement('span');
        c.className = 'evlAiCaret'; c.setAttribute('aria-hidden', 'true');
        el.appendChild(c);
        return root;
    };
    // Screen readers hear phase changes (a new step, thinking, writing started), at most one every 2.5 s, never the
    // clock or the thinking counter.
    obj.aiAnnounce = function (c, t) {
        var ph = pluginHandler.eventlog, p = ph.aiPhase(c, t), now = Date.now();
        if (!p || p.key == 'prep' || p.key == 'review' || t._said == p.key) return;
        if (now - (ph._aiSaidAt || 0) < 2500) return;
        t._said = p.key; ph._aiSaidAt = now;
        ph.aiSay((p.step ? p.step + ': ' : '') + p.text.replace(/…$/, '.'));
    };
    // One 1 s interval for every visible elapsed-time counter; it ends itself when nothing runs any more.
    obj.aiTickStart = function () {
        var ph = pluginHandler.eventlog;
        if (ph._aiTick) return;
        ph._aiTick = setInterval(function () { try { pluginHandler.eventlog.aiTick(); } catch (e) { } }, 1000);
    };
    obj.aiTick = function () {
        var ph = pluginHandler.eventlog, st = ph.st, any = false, now = Date.now();
        if (st != null && st.ai != null) { for (var id in st.ai.convs) { if (ph.aiBusy(st.ai.convs[id])) { any = true; break; } } }
        if (!any) { ph.aiTimersStop(); return; }
        var ks = document.querySelectorAll('#pluginEventLog .evlAiClock[data-t0]');
        for (var i = 0; i < ks.length; i++) ks[i].textContent = ph.aiElapsed(now - Number(ks[i].getAttribute('data-t0')));
    };
    // Clock and watchdog off (nothing runs any more, device change, permission revoked).
    obj.aiTimersStop = function () {
        var ph = pluginHandler.eventlog;
        if (ph._aiTick) { clearInterval(ph._aiTick); ph._aiTick = null; }
        var st = ph.st, busy = false;
        if (st != null && st.ai != null) { for (var id in st.ai.convs) { if (ph.aiBusy(st.ai.convs[id])) busy = true; } }
        if (!busy && ph._aiDog) { clearInterval(ph._aiDog); ph._aiDog = null; }
    };
    // The toolbar button shows a dot while an Ask answer runs in the closed panel.
    obj.aiBtnSync = function () {
        var ph = pluginHandler.eventlog, st = ph.st, btn = Q('evlAiBtn');
        if (!btn || st == null || st.ai == null) return;
        var a = st.ai, c = a.convs[a.chat], run = !a.open && ph.aiBusy(c) && c.status != 'preview', rev = !a.open && c != null && c.status == 'preview';
        btn.classList.toggle('busy', run || rev);
        if (run || rev) { var l = 'Ask about this device (' + (rev ? 'waiting for your review' : 'answering…') + ')'; btn.setAttribute('aria-label', l); btn.setAttribute('title', l); }
        else { btn.removeAttribute('aria-label'); btn.removeAttribute('title'); }
    };
    // "qwen3:14b on gpu-01.lan (local, personal values replaced)"
    obj.aiInfoLine = function (c, short) {
        var ph = pluginHandler.eventlog, acc = (ph.elAccess && ph.elAccess.endpoint) || {}, info = (c && c.info) || {};
        var model = info.model || acc.model || '', name = info.endpointName || acc.name || '', net = ph.aiNetWord(info.network || acc.network);
        // before the first question: the server's effective state for this endpoint (forced | on | off)
        var red = (info.redacted != null && c && c.info) ? info.redacted : (acc.redaction ? acc.redaction != 'off' : acc.redactionForced === true);
        var cnt = ph.aiCounts(c && c.red), rep;
        if (cnt.total > 0) rep = cnt.total + (cnt.total == 1 ? ' value replaced' : ' values replaced');
        else if (c && c.red) rep = 'nothing replaced';
        else rep = red ? 'personal values replaced' : 'nothing replaced';
        if (!model && !name) return '';
        var s = (model || 'Model') + (name ? (short ? ' via ' : ' on ') + name : '');
        var extra = [net, short ? '' : rep].filter(function (x) { return x; });
        return s + (extra.length ? ' (' + extra.join(', ') + ')' : '');
    };
    obj.aiNotesHtml = function (c) {
        var ph = pluginHandler.eventlog;
        if (!c || !c.notes || !c.notes.length) return '';
        return c.notes.map(function (n) { return '<p class=evlAiNoteLine>' + ph.aiEsc(n) + '</p>'; }).join('');
    };
    // plain-text rendition of a finished turn (clipboard)
    obj.aiTurnText = function (c, t) {
        var ph = pluginHandler.eventlog, s = t.structured, x = ph.aiStripMarks, out = [];
        if (s && c.mode == 'explain' && t.n == 1) {
            if (s.meaning) out.push('What it means\n' + x(s.meaning));
            if (s.onDevice) out.push('On this device\n' + x(s.onDevice));
            if (s.harmless && (s.harmless.text || s.harmless.verdict)) out.push('Is it usually harmless?\n' + ph.aiVerdict(s.harmless.verdict) + (s.harmless.text ? ' ' + x(s.harmless.text) : ''));
            if (s.checkNext && s.checkNext.length) out.push('Check next\n' + s.checkNext.map(function (z) { return '- ' + x(z); }).join('\n'));
            return out.join('\n\n');
        }
        if (s && t.diag) {
            if (s.summary) out.push(x(s.summary));
            if (s.hypotheses && s.hypotheses.length) out.push('Possible causes\n' + s.hypotheses.map(function (h) { return '- ' + ph.aiStatusWord(h.status) + ': ' + x(h.title) + (h.why ? ' ' + x(h.why) : ''); }).join('\n'));
            if (s.nextSteps && s.nextSteps.length) out.push('Next steps\n' + s.nextSteps.map(function (n, i) { return (i + 1) + '. ' + x(n.text) + (n.command ? '\n   ' + x(n.command.text) : ''); }).join('\n'));
            return out.join('\n\n');
        }
        return x(t.text);
    };
    obj.aiCopyTurn = function (cid, n, btn) {
        var ph = pluginHandler.eventlog, c = ph.elState().ai.convs[cid], t = null;
        if (c) c.turns.forEach(function (x) { if (x.n == n) t = x; });
        if (!t) return false;
        return ph.aiCopyText(ph.aiTurnText(c, t), btn);
    };
    // "This is wrong" / "Reopen" on a possible cause of a diagnosis: changes how it is shown and tells the server
    obj.aiVote = function (cid, n, target, vote, hid) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[cid], t = null;
        if (c) c.turns.forEach(function (x) { if (x.n == n) t = x; });
        if (!c || !t || !c.convId || target != 'hyp' || (vote != 'wrong' && vote != 'reopen')) return false;
        if (typeof hid != 'string' || !/^[\w-]{1,20}$/.test(hid)) return false;
        if (a.hyp[cid + ':' + hid] == vote) return false;
        a.hyp[cid + ':' + hid] = vote;
        t.sHtml = null;
        ph.aiSendMsg('aiFeedback', { convId: c.convId, turn: (t.srvN != null && t.srvN > 0) ? t.srvN : t.n, target: 'hyp', hid: hid, vote: vote });
        ph.aiRefresh(c);
        ph.aiSay(vote == 'wrong' ? 'Marked as wrong.' : 'Reopened.');
        return false;
    };
    obj.aiRetry = function (cid) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[cid];
        if (!c || ph.aiBusy(c)) return false;
        var t = c.turns[c.turns.length - 1], later = ph.aiIsChat(c) && !t.diag && c.turns.length > 1;
        if (later && c.convId && !c.closed && c.turns[0].status == 'done') {
            c.turns[c.turns.length - 1] = ph.aiNewTurn(t.n, t.q);
            c.status = 'running'; c.last = Date.now();
            ph.aiSendMsg('aiSend', { convId: c.convId, text: t.q });
            ph.aiDogStart();
        } else if (later && c.chatId) {
            c.turns.pop(); a.chat = c.id; ph.aiAsk(t.q); return false;   // the saved chat continues with this question
        } else if (later) {
            a.chat = null; ph.aiAsk(t.q); return false;
        } else {
            ph.aiCloseConv(c);
            c.convId = null; c.closed = false; c.ended = false; c.restored = false; c.reqId = ph.aiReqId(); c.info = null; c.notes = []; c.preview = null; c.red = null;
            if (c.mode == 'diagnose') c.chatId = null;   // a new diagnosis: a new chat
            c.turns = [ph.aiNewTurn(1, c.turns[0].q)]; c.turns[0].diag = (c.mode == 'diagnose'); c.status = 'starting';
            ph.aiStartConv(c);
        }
        ph.aiRefresh(c);
        return false;
    };
    obj.aiStop = function (cid) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[cid];
        if (!c || !ph.aiBusy(c)) return false;
        if (c.convId) { ph.aiSendMsg(c.status == 'preview' ? 'aiClose' : 'aiStop', { convId: c.convId }); if (c.status == 'preview') c.closed = true; }
        else { ph._aiOrphans = ph._aiOrphans || {}; ph._aiOrphans[c.reqId] = 1; c.closed = true; }
        ph.aiDlgClose(true, cid);
        var t = c.turns[c.turns.length - 1];
        t.status = 'stopped';
        t.live = t.text ? ph.aiMd(ph.aiVisible(t.text), c, { streaming: true }) : '';
        c.status = 'stopped';
        ph.aiRefresh(c);
        ph.aiSay('Stopped.');
        return false;
    };

    // ---- citations <-> table rows ---------------------------------------------------------------------------------
    // Rows cited by the conversation in focus (the last one answered or picked), for the gutter column.
    obj.aiCiteMap = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, fid = a.focus || a.chat;
        if (a._cm && a._cm.v == a.citeVer && a._cm.f == fid) return a._cm;
        var cm = { v: a.citeVer, f: fid, cid: fid, byKey: {}, bySig: {}, byId: {}, refs: {}, n: 0 };
        var push = function (map, k, r) { if (k == null) return; if (!map[k]) map[k] = []; if (map[k].indexOf(r) < 0) map[k].push(r); };
        var c = fid ? a.convs[fid] : null;
        if (c) c.turns.forEach(function (t) {
            for (var r in t.cites) { var ci = t.cites[r]; cm.refs[r] = ci; push(cm.byKey, ci.ev.key, r); push(cm.bySig, ci.ev.sig, r); push(cm.byId, ci.id, r); cm.n++; }
        });
        a._cm = cm;
        return cm;
    };
    obj.aiRecId = function (ev) { return (ev && ev._raw && ev._raw._id != null) ? String(ev._raw._id) : null; };
    // The citations that belong to a displayed row: its own event or, when folded, any of its occurrences (matched by
    // key or record id, then by signature and time), ordered by E-number. Each { ref, ci, n, ev }: n is the position
    // of the cited occurrence in the group (1 = the row's own event, 0 = same event text but not among the loaded
    // events), ev the loaded occurrence (null when n == 0).
    obj.aiRowCites = function (r, cm) {
        var ph = pluginHandler.eventlog, ev = r.ev, cand = [], out = [];
        var add = function (l) { if (l) l.forEach(function (x) { if (cand.indexOf(x) < 0) cand.push(x); }); };
        add(cm.byKey[ev.key]);
        var id = ph.aiRecId(ev); if (id != null) add(cm.byId[id]);
        if (r.count > 1) add(cm.bySig[ev.sig]);
        var evs = (r.evs && r.evs.length) ? r.evs : [ev];
        cand.forEach(function (ref) {
            var ci = cm.refs[ref], n = 0;
            if (!ci) return;
            for (var i = 0; i < evs.length && !n; i++) { var e = evs[i]; if (e.key == ci.ev.key || (ci.id != null && ph.aiRecId(e) == ci.id)) n = i + 1; }
            for (var j = 0; j < evs.length && !n; j++) { if (evs[j].sig == ci.ev.sig && evs[j].time == ci.ev.time) n = j + 1; }
            out.push({ ref: ref, ci: ci, n: n, ev: n ? evs[n - 1] : null });
        });
        out.sort(function (x, y) { return Number(x.ref.slice(1)) - Number(y.ref.slice(1)); });
        return out;
    };
    // width (px) of the gutter for a row's chips: up to three, then a "+N" chip
    obj.aiGutterW = function (l) {
        var w = 12;
        (l || []).slice(0, 3).forEach(function (x) { w += 16 + 7 * x.ref.length; });
        if (l && l.length > 3) w += 16 + 7 * String(l.length - 3).length + 7;
        return w;
    };
    obj.aiGutterTd = function (r, cm, l) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        l = l || ph.aiRowCites(r, cm);
        if (!l.length || !/^c\d+$/.test(cm.cid)) return '<td class=evlCCite></td>';
        var h = '<td class=evlCCite>';
        l.slice(0, 3).forEach(function (x) {
            var inner = (x.n != 1), lab = !inner ? 'Cited as ' + x.ref : (x.n ? 'Cited as ' + x.ref + ', occurrence ' + x.n + ' of ' + r.count : 'Cited as ' + x.ref + ', an occurrence inside this group of ' + r.count);
            h += '<button type=button class="evlCite' + (inner ? ' in' : '') + (a.sel == x.ref ? ' sel' : '') + '" data-c=' + cm.cid + ' data-r=' + x.ref +
                 ' aria-label="' + lab + '" title="' + lab + '"' +
                 ' onclick="event.stopPropagation();return pluginHandler.eventlog.aiGutter(\'' + cm.cid + '\',\'' + x.ref + '\',\'' + r.ev.key + '\')">' + x.ref + '</button>';
        });
        if (l.length > 3) {
            var rest = l.slice(3).map(function (x) { return x.ref; }).join(', ');
            h += '<button type=button class="evlCite more" title="Also cited: ' + rest + '" aria-label="' + (l.length - 3) + ' more citations in this row: ' + rest + '"' +
                 ' onclick="event.stopPropagation();return pluginHandler.eventlog.aiGutterMore(\'' + r.ev.key + '\')">+' + (l.length - 3) + '</button>';
        }
        return h + '</td>';
    };
    obj.aiApplySel = function () {
        var a = pluginHandler.eventlog.elState().ai, f = a.focus || a.chat;
        var nodes = document.querySelectorAll('#pluginEventLog .evlCite[data-r]');
        for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('sel', !!a.sel && nodes[i].getAttribute('data-r') == a.sel && nodes[i].getAttribute('data-c') == f);
    };
    // Gutter chip: highlight the ref in the answer that cited it; one further down a folded group also opens that
    // occurrence in the details.
    obj.aiGutter = function (cid, ref, key) {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai;
        a.sel = ref; a.focus = cid;
        if (key != null && st.fold) {
            var r = ph.elRowFor(key), x = null;
            if (r && r.count > 1) ph.aiRowCites(r, ph.aiCiteMap()).forEach(function (y) { if (y.ref == ref) x = y; });
            if (x && x.n != 1) { ph.aiOccShow(r, cid, ref); ph.aiFlashRow(key); }
            else if (a.occ && a.occ.key == key) { a.occ = null; ph.elUpdate(); }
        }
        ph.aiApplySel();
        var log = Q('evlAiLog'), chip = log ? log.querySelector('.evlCite[data-c="' + cid + '"][data-r="' + ref + '"]') : null;
        if (chip) { var r1 = chip.getBoundingClientRect(), r0 = log.getBoundingClientRect(); if (r1.top < r0.top || r1.bottom > r0.bottom) log.scrollTop += (r1.top - r0.top) - log.clientHeight / 3; }
        return false;
    };
    // "+N" in the gutter: open the row; its details list every cited occurrence with its chip
    obj.aiGutterMore = function (key) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (st.layout == 'viewer') st.selected = key; else st.expanded[key] = true;
        st.ai.occ = null;
        ph.elUpdate();
        return false;
    };
    // ---- a cited occurrence inside a folded group -----------------------------------------------------------------
    // a.occ = { key: the group's row, cid, ref }: the details of that row show the cited occurrence instead of the top
    obj.aiOccShow = function (r, cid, ref) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.ai.occ = { key: r.ev.key, cid: cid, ref: ref };
        if (st.layout == 'viewer') st.selected = r.ev.key; else st.expanded[r.ev.key] = true;
        ph.elUpdate();
    };
    // the occurrence to show for a folded row: { ref, cid, n, ev, loaded } or null (show the row's own event)
    obj.aiOccOf = function (r) {
        var ph = pluginHandler.eventlog, st = ph.elState(), o = st.ai ? st.ai.occ : null;
        if (!o || !r || !st.fold || r.count < 2 || o.key != r.ev.key) return null;
        var cm = ph.aiCiteMap();
        if (cm.cid != o.cid) return null;
        var x = null;
        ph.aiRowCites(r, cm).forEach(function (y) { if (y.ref == o.ref) x = y; });
        if (!x || x.n == 1) return null;
        return { ref: x.ref, cid: o.cid, n: x.n, ev: x.ev || x.ci.ev, loaded: !!x.ev };
    };
    obj.aiOccBarHtml = function (r, o) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var back = (st.sort.key == 'time' && st.sort.dir == 1) ? 'Show the oldest occurrence' : 'Show the newest occurrence';
        var where = o.n ? 'Occurrence ' + o.n + ' of ' + r.count : 'Cited occurrence, not among the loaded events';
        return '<div class=evlOccBar role=note><span class="evlCite static" aria-label="Cited as ' + o.ref + '">' + o.ref + '</span>' +
               '<span>' + where + ', recorded <span class=evlMono>' + ph.elFmtTime(o.ev.time) + '</span></span>' +
               '<button class=evlLinkBtn onclick="event.stopPropagation();return pluginHandler.eventlog.aiOccClear()">' + back + '</button></div>';
    };
    obj.aiOccClear = function () {
        var ph = pluginHandler.eventlog;
        ph.elState().ai.occ = null;
        ph.elUpdate();
        return false;
    };
    // the "Seen"/"Occurrences" times of a folded row: the first max, plus any cited one further down; cited times
    // carry their chip, the one shown in the details is marked
    obj.aiOccTimesHtml = function (r, max, sep, o) {
        var ph = pluginHandler.eventlog, cm = ph.aiCiteMap(), evs = (r.evs && r.evs.length) ? r.evs : null;
        if (!evs) return r.times.slice(0, max).map(function (t) { return ph.elFmtTime(t, true); }).join(sep) + (r.times.length > max ? '&hellip;' : '');
        var by = {}, cid = /^c\d+$/.test(String(cm.cid)) ? cm.cid : null;
        if (cid && cm.n) ph.aiRowCites(r, cm).forEach(function (x) { if (x.n) (by[x.n] = by[x.n] || []).push(x.ref); });
        var parts = [], gap = false;
        evs.forEach(function (e, i) {
            var n = i + 1, refs = by[n];
            if (n > max && !refs) { gap = true; return; }
            var t = ph.elFmtTime(e.time, true);
            var h = (gap ? '&hellip; ' : '') + '<span class="evlOcc' + (refs ? ' cited' : '') + (o && o.n == n ? ' cur' : '') + '"' + (o && o.n == n ? ' aria-current=true' : '') + '><span class=t>' + t + '</span>';
            if (refs) refs.forEach(function (ref) { h += ' ' + ph.aiChipHtml(cid, ref, n == 1 ? '' : 'in', 'Show occurrence ' + n + ', cited as ' + ref); });
            parts.push(h + '</span>');
            gap = false;
        });
        return parts.join(sep) + (gap ? '&hellip;' : '');
    };
    // Answer chip: find the cited event in the table, select it, flash it and scroll it into view.
    obj.aiGotoCite = function (cid, ref) {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai, c = a.convs[cid];
        if (!/^E\d{1,6}$/.test(String(ref))) return false;
        var ci = ph.aiCite(c, ref);
        if (!ci) return false;
        if (a.focus != cid) a.citeVer++;
        a.focus = cid; a.sel = ref; a.notice = null; a.peek = null;
        // no event list at all (the Assistant permission only): the cited event in a small card
        if (!ph.elCan('live') && !ph.elCan('history')) { a.peek = { cid: cid, ref: ref, where: 'panel' }; ph.aiRenderPeek(); ph.aiApplySel(); return false; }
        // full width: back beside the table, so the row can be shown
        if (a.full) { a.full = false; ph.aiRenderPanel(); }
        ph.aiReveal(cid, ref, 0);
        return false;
    };
    obj.aiReveal = function (cid, ref, attempt) {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai, c = a.convs[cid], ci = ph.aiCite(c, ref);
        if (!ci) return;
        var ev = ci.ev;
        var same = function (e) { return e.key == ev.key || (ci.id != null && e._raw && e._raw._id != null && String(e._raw._id) == ci.id); };
        var fr = ph.elFiltered();
        var rows = st.fold ? ph.elFold(fr.rows) : fr.rows.map(function (e) { return { ev: e, count: 1, times: [e.time] }; });
        if (st.view == 'live' && rows.length > st.show) rows = rows.slice(0, st.show);
        var hit = null;
        for (var i = 0; i < rows.length && !hit; i++) { if (same(rows[i].ev)) hit = rows[i]; }
        if (!hit && st.fold) { for (var j = 0; j < rows.length && !hit; j++) { if (rows[j].ev.sig == ev.sig && rows[j].count > 1) hit = rows[j]; } }
        if (hit) {
            a.occ = null;
            if (st.fold && hit.count > 1 && !same(hit.ev)) a.occ = { key: hit.ev.key, cid: cid, ref: ref };   // shown in the details
            if (st.layout == 'viewer') st.selected = hit.ev.key; else st.expanded[hit.ev.key] = true;
            ph.elUpdate();
            ph.aiFlashRow(hit.ev.key);
            ph.aiSay('Showing cited event ' + ref + '.');
            return;
        }
        var evs = (st.view == 'live') ? st.live.events : st.hist.events, loaded = false;
        for (var k = 0; k < evs.length && !loaded; k++) { if (same(evs[k])) loaded = true; }
        if (loaded) { a.notice = { cid: cid, ref: ref, kind: 'hidden' }; ph.elUpdate(); return; }
        if (st.view == 'live') {
            if (ph.elCan('history')) { st.view = 'history'; ph.elRenderShell(); ph.aiReveal(cid, ref, attempt); return; }
            a.peek = { cid: cid, ref: ref, where: 'panel' }; ph.aiRenderPeek(); return;
        }
        if (attempt == 0 && ci.id != null) { a.reveal = { cid: cid, ref: ref, id: ci.id, attempt: 1 }; ph.elLoadHistory(true, ci.id); return; }
        a.notice = { cid: cid, ref: ref, kind: (attempt >= 2) ? 'gone' : 'missing' };
        ph.elUpdate();
    };
    obj.aiAfterLoad = function (m) {
        var ph = pluginHandler.eventlog, st = ph.st;
        if (st == null || st.ai == null || st.ai.reveal == null) return;
        var r = st.ai.reveal;
        if (m.aroundId != null && String(m.aroundId) != String(r.id)) return;
        st.ai.reveal = null;
        ph.aiReveal(r.cid, r.ref, r.attempt);
    };
    obj.aiFlashRow = function (key) {
        var tr = Q('evlR_' + key);
        if (!tr) return;
        var sc = tr.closest ? tr.closest('.evlScroll, .evlVList') : null;
        if (sc) {
            var r1 = tr.getBoundingClientRect(), r0 = sc.getBoundingClientRect();
            if (r1.top < r0.top + 30 || r1.bottom > r0.bottom) sc.scrollTop += (r1.top - r0.top) - Math.max(40, sc.clientHeight / 3);
            try { var rs = sc.getBoundingClientRect(); if (rs.top < 0 || rs.top > window.innerHeight - 60) sc.scrollIntoView({ block: 'nearest' }); } catch (e) { }
        }
        tr.classList.remove('evlFlash'); void tr.offsetWidth; tr.classList.add('evlFlash');
        setTimeout(function () { try { tr.classList.remove('evlFlash'); } catch (e) { } }, 1700);
    };
    obj.aiNoticeHtml = function () {
        var ph = pluginHandler.eventlog, st = ph.elState(), n = st.ai.notice;
        if (!n || !/^E\d{1,6}$/.test(n.ref)) return '';
        var t;
        if (n.kind == 'hidden') t = n.ref + ' is hidden by the current filters.';
        else if (n.kind == 'missing') t = n.ref + ' is not among the stored events that match the current filters.';
        else t = n.ref + ' was not found in the stored events. Retention may have removed it.';
        return '<div class=evlAiNote role=status><span>' + t + '</span>' +
               (n.kind != 'gone' ? '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiShowAnyway()">Show anyway</button>' : '') +
               '<button class="evlBtn mini" aria-label="Dismiss" onclick="return pluginHandler.eventlog.aiNoteClose()">&#10005;</button></div>';
    };
    obj.aiNoteClose = function () {
        var ph = pluginHandler.eventlog;
        ph.elState().ai.notice = null;
        ph.elUpdate();
        return false;
    };
    obj.aiShowAnyway = function () {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai, n = a.notice;
        if (!n) return false;
        a.notice = null;
        st.filters = { levels: null, logs: null, sources: null, ids: '', text: '' };
        var e1 = Q('evlIdIn'); if (e1) e1.value = '';
        var e2 = Q('evlTxtIn'); if (e2) e2.value = '';
        st.range = 'all'; var rs = Q('evlRangeSel'); if (rs) rs.value = 'all';
        st.hist.recIds = null;
        var ci = ph.aiCite(a.convs[n.cid], n.ref);
        if (st.view == 'history' && ci && ci.id != null) {
            a.reveal = { cid: n.cid, ref: n.ref, id: ci.id, attempt: 2 };
            ph.elUpdate();
            ph.elLoadHistory(true, ci.id);
        } else { ph.elUpdate(); ph.aiReveal(n.cid, n.ref, 2); }
        return false;
    };
    // "Open these N events in History": the History view shows exactly the cited events until a filter changes.
    obj.aiOpenCited = function (cid) {
        var ph = pluginHandler.eventlog, st = ph.elState(), c = st.ai.convs[cid], ids = [];
        if (!c || !ph.elCan('history')) return false;
        c.turns.forEach(function (t) { for (var r in t.cites) { var id = t.cites[r].id; if (id != null && ids.indexOf(id) < 0) ids.push(id); } });
        if (!ids.length) return false;
        st.hist.recIds = ids.slice(0, 200);
        st.ai.focus = cid; st.ai.citeVer++; st.ai.full = false;   // the events show beside the panel
        st.view = 'history';
        ph.elRenderShell();
        ph.elLoadHistory(true);
        return false;
    };
    // Users without an event list (Assistant permission only) see the cited event in a small card instead.
    obj.aiPeekHtml = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, p = a.peek, esc = ph.aiEsc;
        if (!p) return '';
        var ci = ph.aiCite(a.convs[p.cid], p.ref);
        if (!ci) return '';
        var ev = ci.ev;
        return '<div class=evlAiPeek role=region aria-label="Cited event ' + p.ref + '"><div class=evlAiPeekH><span class="evlCite static">' + p.ref + '</span>' +
               '<span class=evlMono>' + esc(ph.elFmtTime(ev.time)) + '</span><span class="evlLv ' + ev.levelCls + '"><i></i>' + esc(ev.levelName) + '</span><span>' + esc(ev.source) + ' ' + esc(ev.id) + '</span>' +
               '<button class="evlBtn mini" aria-label="Close the cited event" onclick="return pluginHandler.eventlog.aiPeekClose()">&#10005;</button></div>' +
               '<div class=evlAiPeekM>' + esc(ev.message) + '</div></div>';
    };
    obj.aiRenderPeek = function () {
        var ph = pluginHandler.eventlog, p1 = Q('evlAiPeekSlot');
        if (p1) p1.innerHTML = ph.aiPeekHtml();
        ph.aiApplySel();
    };
    obj.aiPeekClose = function () {
        var ph = pluginHandler.eventlog;
        ph.elState().ai.peek = null;
        ph.aiRenderPeek();
        return false;
    };

    // ---- Ask panel ------------------------------------------------------------------------------------------------
    obj.aiLayout = function () {
        var ph = pluginHandler.eventlog, st = ph.elState(), main = Q('evlMain'), wrap = Q('evlWrap');
        if (!main || !wrap) return;
        var w = wrap.clientWidth, lim = (st.layout == 'viewer') ? 1150 : 900;
        var was = main.classList.contains('evlStack');
        var stack = (w > 0) ? (was ? (w < lim + 24) : (w < lim)) : was;   // a little hysteresis: no flip-flop at the edge
        main.classList.toggle('evlStack', stack);
        // full width: the panel takes the table's place (the toolbar stays); stacked it is full width anyway; without
        // an event list (the Assistant permission only) it always is
        var only = ph.aiOnly(), pe = Q('evlAi'), open = !!(pe && !pe.hidden);
        main.classList.toggle('evlAiOnly', only);
        main.classList.toggle('evlAiFull', open && (only || (!!st.ai.full && !stack)));
        main.style.setProperty('--evl-ai-w', (st.ai.w || 400) + 'px');
        if (stack != was) ph.elFitHeight();
        ph.aiFitPanel();
    };
    // the Assistant is all this user has on this device: no event table, the panel is the page
    obj.aiOnly = function () {
        var ph = pluginHandler.eventlog;
        return ph.elCan('assistant') && !ph.elCan('live') && !ph.elCan('history');
    };
    // Full width <-> docked beside the table (remembered per browser); Esc in the panel docks it again.
    obj.aiFullToggle = function (on) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        a.full = (on == null) ? !a.full : !!on;
        try { putstore('evl_ai_full', a.full ? '1' : ''); } catch (e) { }
        ph.aiRenderPanel();
        ph.elFitHeight();
        var b = Q('evlAiFullBtn'); if (b) b.focus();
        ph.aiSay(a.full ? 'The assistant uses the full width.' : 'The assistant is docked beside the table.');
        return false;
    };
    obj.aiPanelKey = function (ev) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (ev.key != 'Escape' || ev.defaultPrevented || !a.full || ph.aiOnly()) return true;
        var main = Q('evlMain');
        if (main && main.classList.contains('evlStack')) return true;
        ev.preventDefault();
        ph.aiFullToggle(false);
        return false;
    };
    // ---- Ask panel height -----------------------------------------------------------------------------------------
    // The panel's height does not follow the event table: by default it fits the window (docked: from its top edge to
    // the bottom of the visible page; stacked below the table: the visible height), at least AI_MIN_H. A height set
    // with the grip at its bottom edge is kept per browser (evl_ai_h; empty = automatic) but never grows past the fit.
    // The table's own fit (elFitAvail) only measures its column, so the two never feed into each other.
    obj.aiUserH = function () {
        var ph = pluginHandler.eventlog;
        if (typeof ph._aiH != 'number') { var v = 0; try { v = Number(getstore('evl_ai_h', '')) || 0; } catch (e) { } ph._aiH = (v >= 360) ? Math.round(v) : 0; }
        return ph._aiH;
    };
    obj.aiSetUserH = function (h) {
        var ph = pluginHandler.eventlog;
        ph._aiH = h ? Math.max(360, Math.round(h)) : 0;
        try { putstore('evl_ai_h', ph._aiH ? String(ph._aiH) : ''); } catch (e) { }
        ph.aiFitPanel();
    };
    // the automatic (fit to window) height in px; 0 = unknown (tab hidden)
    obj.aiFitH = function () {
        var ph = pluginHandler.eventlog, main = Q('evlMain'), MIN = 360;
        if (!main || !main.offsetParent) return 0;
        var vb = ph.elViewBox();
        if (main.classList.contains('evlStack')) return Math.max(MIN, Math.floor(vb.bottom - vb.top - 24));
        // docked: the panel's top is the row's top (the panel itself may be sticky in Diagnosis, so measure the row),
        // taken as if the page were scrolled to the top; 6 px below like the table, so both end on the same line
        var top = main.getBoundingClientRect().top + vb.scroll;
        return Math.max(MIN, Math.floor(vb.bottom - top - 6));
    };
    obj.aiFitPanel = function () {
        var ph = pluginHandler.eventlog, el = Q('evlAi');
        if (!el || el.hidden || ph._aiDrag) return;   // while the grip is dragged, the pointer alone sets the height
        var fit = ph.aiFitH(), uh = ph.aiUserH();
        if (!fit) return;   // hidden tab: keep the last height, the ResizeObserver comes back when it is shown
        var h = uh ? Math.min(uh, fit) : fit;
        ph.aiApplyH(h);
        var g = Q('evlAiHGrip');
        if (g) {
            g.setAttribute('aria-valuemin', '360'); g.setAttribute('aria-valuemax', String(fit)); g.setAttribute('aria-valuenow', String(h));
            g.setAttribute('aria-valuetext', h + ' pixels' + (uh ? '' : ', fits the window'));
        }
        var rb = Q('evlAiHReset'); if (rb) rb.hidden = !uh;
    };
    // set the height and keep the conversation pinned to its end if it was there (streaming keeps following)
    obj.aiApplyH = function (h) {
        var el = Q('evlAi'), log = Q('evlAiLog');
        if (!el || el.style.height == h + 'px') return;
        var stick = log ? (log.scrollHeight - log.scrollTop - log.clientHeight < 48) : false;
        el.style.height = h + 'px';
        if (stick && log) log.scrollTop = log.scrollHeight;
    };
    // Dragging: the bottom edge follows the pointer, measured from the panel's top where it is now (the page may scroll
    // meanwhile) and keeping where the grip was grabbed; nothing else sets the height until the pointer is released
    // (layout and resize callbacks would put the stored height back mid-drag). Stored on release.
    obj.aiHGripDown = function (ev) {
        var ph = pluginHandler.eventlog, el = Q('evlAi'), g = ev.currentTarget || ev.target;
        if (!el || (ev.button != null && ev.button > 0)) return false;
        ev.preventDefault();
        try { g.setPointerCapture(ev.pointerId); } catch (e) { }
        g.classList.add('active');
        var r0 = el.getBoundingClientRect(), grab = r0.bottom - ev.clientY, h = 0;
        ph._aiDrag = true;
        var mv = function (e) {
            var fit = ph.aiFitH() || 1e6, top = el.getBoundingClientRect().top;
            h = Math.round(Math.max(360, Math.min(fit, e.clientY - top + grab)));
            ph.aiApplyH(h);
        };
        var up = function () {
            g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
            g.classList.remove('active');
            ph._aiDrag = false;
            var fit = ph.aiFitH() || 1e6;
            if (h) ph.aiSetUserH(h >= fit ? 0 : h);   // dragged all the way down: back to the automatic height
            else ph.aiFitPanel();
        };
        g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
        return false;
    };
    obj.aiHGripKey = function (ev) {
        var ph = pluginHandler.eventlog, el = Q('evlAi');
        var d = { ArrowUp: -24, ArrowDown: 24, PageUp: -120, PageDown: 120 }[ev.key];
        if (!el || (d == null && ev.key != 'Home' && ev.key != 'End')) return true;
        ev.preventDefault();
        if (ph._aiDrag) return false;
        var fit = ph.aiFitH() || 1e6, cur = Number(String(el.style.height).replace('px', '')) || Math.round(el.getBoundingClientRect().height) || fit;
        if (ev.key == 'Home') ph.aiSetUserH(360);
        else if (ev.key == 'End') ph.aiSetUserH(0);
        else { var h = Math.max(360, Math.min(fit, cur + d)); ph.aiSetUserH(h >= fit ? 0 : h); }
        return false;
    };
    obj.aiHGripReset = function () {
        var ph = pluginHandler.eventlog, rb = Q('evlAiHReset'), back = (rb && document.activeElement === rb);
        ph.aiSetUserH(0);
        if (back) { var g = Q('evlAiHGrip'); if (g) g.focus(); }   // the Reset height button hides itself
        ph.aiSay('The assistant panel fits the window again.');
        return false;
    };
    obj.aiSplitDown = function (ev) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, panel = Q('evlAi'), main = Q('evlMain'), g = ev.currentTarget || ev.target;
        if (!panel || !main || main.classList.contains('evlStack')) return false;
        ev.preventDefault();
        try { g.setPointerCapture(ev.pointerId); } catch (e) { }
        g.classList.add('active');
        var x0 = ev.clientX, w0 = panel.getBoundingClientRect().width, mw = main.getBoundingClientRect().width, w = 0;
        var mv = function (e) { w = Math.round(Math.max(300, Math.min(Math.min(760, mw - 380), w0 - (e.clientX - x0)))); main.style.setProperty('--evl-ai-w', w + 'px'); };
        var up = function () {
            g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
            g.classList.remove('active');
            if (w) { a.w = w; putstore('evl_ai_w', String(w)); }
            ph.elFitHeight();
        };
        g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
        return false;
    };
    obj.aiSplitKey = function (ev) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, panel = Q('evlAi');
        if (!panel || (ev.key != 'ArrowLeft' && ev.key != 'ArrowRight')) return true;
        var w = Math.round(panel.getBoundingClientRect().width) + (ev.key == 'ArrowLeft' ? 24 : -24);
        a.w = Math.max(300, Math.min(760, w)); putstore('evl_ai_w', String(a.w));
        ph.aiLayout();
        ev.preventDefault();
        return false;
    };
    obj.aiSplitReset = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        a.w = 0; putstore('evl_ai_w', '0');
        ph.aiLayout(); ph.elFitHeight();
        return false;
    };
    obj.aiToggle = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (!ph.elCan('assistant')) return false;
        a.open = ph.aiOnly() ? true : !a.open;
        if (a.open) a.diagSetup = false;
        ph.aiRenderPanel();
        setTimeout(function () { try { var el = Q(pluginHandler.eventlog.elState().ai.open ? 'evlAiIn' : 'evlAiBtn'); if (el) el.focus(); } catch (e) { } }, 0);
        return false;
    };
    obj.aiClosePanel = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (ph.aiOnly()) return false;   // the panel is all there is
        a.open = false; a.diagSetup = false;
        ph.aiRenderPanel();
        var b = Q('evlAiBtn'); if (b) b.focus();
        return false;
    };
    // svg icons of the panel (16 px, stroke = currentColor)
    obj.aiIcon = function (name) {
        var d = ({
            copy: '<rect x=5.5 y=5.5 width=8 height=8 rx=1.5 /><path d="M10.5 3.2H4.2a1 1 0 0 0-1 1v6.3"/>',
            edit: '<path d="M3 13l.7-2.8 7.1-7.1a1.4 1.4 0 0 1 2 2l-7.1 7.1zM9.6 4.3l2 2"/>',
            del: '<path d="M2.8 4.5h10.4M6.3 4.5V2.8h3.4v1.7M4.3 4.5l.7 8.7h6l.7-8.7M6.8 7v4M9.2 7v4"/>',
            retry: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v3.4H9.6"/>',
            full: '<path d="M9.5 2.5h4v4M13.5 2.5L9.2 6.8M6.5 13.5h-4v-4M2.5 13.5l4.3-4.3"/>',
            dock: '<rect x=2 y=3 width=12 height=10 rx=1.2 /><path d="M9.2 3v10M3.8 6h3.5M3.8 8.5h3.5"/>',
            diag: '<path d="M1.5 8.5h2.8l1.6-4.2 2.8 8 1.7-5 1 1.2h3.1"/>',
            sliders: '<path d="M2.5 4.5h5.6M11.9 4.5h1.6M2.5 11.5h1.6M7.9 11.5h5.6"/><circle cx=10 cy=4.5 r=1.9 /><circle cx=6 cy=11.5 r=1.9 />',
            chev: '<path d="M6 3.5l4.5 4.5L6 12.5"/>',
            x: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>'
        })[name] || '';
        return '<svg width=14 height=14 viewBox="0 0 16 16" fill=none stroke=currentColor stroke-width=1.6 stroke-linecap=round stroke-linejoin=round aria-hidden=true>' + d + '</svg>';
    };
    obj.aiRenderPanel = function () {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai, el = Q('evlAi');
        if (ph.aiOnly()) a.open = true;
        var btn = Q('evlAiBtn');
        if (btn) { btn.setAttribute('aria-expanded', a.open ? 'true' : 'false'); btn.classList.toggle('on', a.open && !a.diagSetup); }
        var db = Q('evlAiDiagBtn'); if (db) db.classList.toggle('on', a.open && a.diagSetup);
        ph.aiBtnSync();
        if (!el) return;
        if (!a.open || !ph.elCan('assistant')) {
            if (!el.hidden) { el.hidden = true; el.innerHTML = ''; }
            ph.aiLayout();
            return;
        }
        el.hidden = false;
        if (!Q('evlAiLog')) {
            el.innerHTML = '<div class=evlAiIn onkeydown="return pluginHandler.eventlog.aiPanelKey(event)">' +
                '<div class=evlAiSplit role=separator tabindex=0 aria-orientation=vertical aria-label="Resize the assistant panel" title="Drag to resize, double-click to reset"' +
                ' onpointerdown="return pluginHandler.eventlog.aiSplitDown(event)" ondblclick="return pluginHandler.eventlog.aiSplitReset()" onkeydown="return pluginHandler.eventlog.aiSplitKey(event)"></div>' +
                '<div class=evlAiHd id=evlAiHd></div><div class=evlAiPopSlot id=evlAiPopSlot></div><div class=evlAiStripSlot id=evlAiStripSlot></div>' +
                '<div class=evlAiLog id=evlAiLog role=log aria-live=polite aria-busy=false aria-label="Conversation"></div>' +
                '<div class=evlAiFt id=evlAiFt></div>' +
                '<div class=evlAiHGrip id=evlAiHGrip role=separator tabindex=0 aria-orientation=horizontal aria-controls=evlAi aria-label="Height of the assistant panel" aria-valuemin=360' +
                ' title="Drag to change the height, double-click to fit the window again"' +
                ' onpointerdown="return pluginHandler.eventlog.aiHGripDown(event)" ondblclick="return pluginHandler.eventlog.aiHGripReset()" onkeydown="return pluginHandler.eventlog.aiHGripKey(event)"></div></div>';
        }
        var c = a.convs[a.chat] || null;
        QH('evlAiHd', ph.aiHeadHtml(c));
        QH('evlAiStripSlot', ph.aiStripHtml(c, c ? c.turns[c.turns.length - 1] : null));
        var log = Q('evlAiLog');
        if (a.hist || a.opening || a.diagSetup) {   // the chat list, a saved chat being loaded, or the diagnosis window choice
            log.setAttribute('aria-busy', a.opening ? 'true' : 'false');
            log.setAttribute('aria-label', a.hist ? 'Saved chats' : (a.diagSetup ? 'Diagnose this device' : 'Conversation'));
            log.innerHTML = a.hist ? ph.aiHistoryHtml() : (a.diagSetup ? ph.aiDiagSetupHtml() : '<p class=evlAiMuted>Opening the saved chat…</p>');
            var mode = a.hist ? 'hist' : (a.diagSetup ? 'setup' : 'open');
            if (log._evlConv != mode) log.scrollTop = 0;
            log._evlConv = mode;
            ph.aiRenderComposer(); ph.aiLayout(); ph.aiGenSync();
            return;
        }
        log.setAttribute('aria-label', 'Conversation');
        var lt = c ? c.turns[c.turns.length - 1] : null, sig = c ? c.id + ':' + c.turns.length : '';
        var stick = (log.scrollHeight - log.scrollTop - log.clientHeight < 48) || log._evlConv != sig;
        var justDone = (lt != null && lt.status == 'done' && log._evlDone != sig);   // a finished answer: show it from its start
        var top = log.scrollTop;
        log.setAttribute('aria-busy', ph.aiBusy(c) ? 'true' : 'false');
        log.innerHTML = ph.aiLogHtml(c);
        ph.aiFuTitles(log);
        var turns = log.querySelectorAll('.evlAiTurn'), lastEl = turns.length ? turns[turns.length - 1] : null;
        if (a.act) log.scrollTop = top;   // an inline editor or confirmation: stay where the user is
        else if (justDone && lastEl && log._evlConv == sig) log.scrollTop = Math.max(0, lastEl.offsetTop - 8);
        else log.scrollTop = stick ? log.scrollHeight : top;
        log._evlConv = sig;
        if (lt != null && lt.status == 'done') log._evlDone = sig;
        ph.aiRenderComposer();
        ph.aiApplySel();
        ph.aiLayout();
        ph.aiGenSync();
    };
    obj.aiHeadHtml = function (c) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, sv = a.saved, only = ph.aiOnly();
        if (a.diagSetup) c = null;   // the window choice is about a new diagnosis, not the chat shown before
        var line = ph.aiInfoLine(c);
        var hb = '';
        if (sv && sv.enabled) {
            var n = sv.chats.length;
            hb = '<button id=evlAiHistBtn class="evlBtn mini evlAiHistBtn' + (a.hist ? ' on' : '') + '" aria-expanded=' + (a.hist ? 'true' : 'false') + ' aria-controls=evlAiLog' +
                 ' aria-label="' + (a.hist ? 'Back to the chat' : 'Saved chats' + (n ? ' (' + n + ')' : '')) + '" onclick="return pluginHandler.eventlog.aiHistoryToggle()">' +
                 '<svg width=13 height=13 viewBox="0 0 16 16" fill=none stroke=currentColor stroke-width=1.6 aria-hidden=true><path d="M2.5 4h11M2.5 8h11M2.5 12h7"/></svg><span class=evlAiHistL>Chats</span>' +
                 (n ? '<span class=evlAiN>' + n + '</span>' : '') + '</button>';
        }
        var title = a.hist ? 'Saved chats' : (a.diagSetup ? 'Diagnose' : (c && c.mode == 'diagnose' ? 'Diagnosis' : 'Ask'));
        // full width <-> docked beside the table (not offered stacked below the table, nor without a table)
        var fb = only ? '' : '<button id=evlAiFullBtn class="evlBtn mini evlAiIco evlAiFullBtn" aria-pressed=' + (a.full ? 'true' : 'false') + ' aria-label="Full width"' +
                 ' title="' + (a.full ? 'Dock beside the table (Esc)' : 'Full width') + '" onclick="return pluginHandler.eventlog.aiFullToggle()">' + ph.aiIcon(a.full ? 'dock' : 'full') + '</button>';
        // Answer settings (thinking, temperature) of this chat: the button, and what is changed from the endpoint's
        var gi = a.hist ? null : ph.aiGenInfo(), gb = '', tag = '';
        if (gi) {
            tag = ph.aiGenTag(ph.aiGenGet());
            gb = '<button id=evlAiGenBtn type=button class="evlBtn mini evlAiIco evlAiGenBtn' + (tag ? ' set' : '') + '" aria-haspopup=dialog aria-expanded=' + (a.genOpen ? 'true' : 'false') + ' aria-controls=evlAiGenPop' +
                 ' aria-label="Answer settings' + (tag ? ' (' + ph.aiEsc(tag) + ')' : '') + '" title="Answer settings" onclick="return pluginHandler.eventlog.aiGenToggle()">' + ph.aiIcon('sliders') + '</button>';
        }
        return '<div class=evlAiTitle><h2>' + title + '</h2>' + (line && !a.hist ? '<div class=evlAiSub>' + ph.aiEsc(line) + '</div>' : '') +
               (tag ? '<div class=evlAiGenTag>' + ph.aiIcon('sliders') + '<span>' + ph.aiEsc(tag) + '</span></div>' : '') + (a.hist ? '' : ph.aiNotesHtml(c)) + '</div>' + hb + gb +
               '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiNewChat()"' + (c || a.hist || a.diagSetup ? '' : ' disabled') + '>New chat</button>' + fb +
               (only ? '' : '<button class="evlBtn mini evlAiX" aria-label="Close the assistant" title="Close" onclick="return pluginHandler.eventlog.aiClosePanel()">' + ph.aiIcon('x') + '</button>');
    };
    // the starter questions the server chose for this device's OS (admin-editable), else the built-in Windows list
    obj.aiStarters = function () {
        var acc = pluginHandler.eventlog.elAccess || {};
        if (Array.isArray(acc.starters)) return acc.starters.filter(function (x) { return typeof x == 'string' && x.trim(); }).slice(0, 12).map(function (x) { return x.slice(0, 200); });
        return ['Why did this device restart recently?', 'What changed in the last 24 hours?', 'Are there signs of disk or hardware problems?'];
    };
    obj.aiIntroHtml = function () {
        var ph = pluginHandler.eventlog, acc = ph.elAccess || {};
        if (acc.assistantReason == 'noEndpoint') return '<div class=evlAiIntro><p>' + ph.aiEsc(ph.aiErrText('noEndpoint')) + ' An administrator can assign one in the plugin\'s Config Sets.</p></div>';
        var h = '<div class=evlAiIntro><p>Ask about this device in plain words. The assistant reads its stored events and device details. Answers point to the events they rely on, marked like <span class="evlCite static">E1</span>; select one to find it in the table.</p>';
        var st = ph.aiStarters();
        h += '<div class=evlAiFollow role=group aria-label="Example questions">';
        st.forEach(function (s, i) { h += '<button class=evlBtn onclick="return pluginHandler.eventlog.aiStarter(' + i + ')">' + ph.aiEsc(s) + '</button>'; });
        h += '</div>';
        h += '<div class=evlAiDgEntry><button id=evlAiDgEntry class="evlBtn evlAiDgGo" onclick="return pluginHandler.eventlog.aiDiagOpen()">' + ph.aiIcon('diag') + 'Diagnose this device</button>' +
             '<span>Sorts out what happened in a time window you choose and suggests likely causes.</span></div>';
        var sv = ph.elState().ai.saved;
        if (sv && sv.enabled) {
            var n = sv.chats.length;
            h += '<p class=evlAiHistNote>' + ph.aiEsc(ph.aiSavedNote()) + (n ? ' <button class=evlLinkBtn onclick="return pluginHandler.eventlog.aiHistoryToggle()">Open an earlier chat (' + n + ')</button>' : '') + '</p>';
        }
        return h + '</div>';
    };
    obj.aiStarter = function (i) {
        var ph = pluginHandler.eventlog, s = ph.aiStarters()[i];
        if (s) ph.aiAsk(s);
        return false;
    };
    obj.aiLogHtml = function (c) {
        var ph = pluginHandler.eventlog;
        if (!c) return ph.aiIntroHtml();
        var h = '';
        if (c.restored && c.created) h += '<p class=evlAiSaved>' + (c.mode == 'diagnose' ? 'Saved diagnosis from ' + ph.aiEsc(ph.aiWhen(c.created)) + '. A question continues it; the assistant gets a recap of the diagnosis and the answers so far.'
                                                                                         : 'Saved chat from ' + ph.aiEsc(ph.aiWhen(c.created)) + '. A new question continues it; the assistant gets a recap of the answers so far.') + '</p>';
        c.turns.forEach(function (t, i) { h += ph.aiTurnHtml(c, t, i == c.turns.length - 1); });
        if (c.ended && !ph.aiBusy(c) && !c.chatId) h += '<div class=evlAiNoteBox>This conversation ended on the server after a while without questions. <button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiNewChat()">New chat</button></div>';
        return h;
    };
    obj.aiTurnHtml = function (c, t, isLast) {
        var ph = pluginHandler.eventlog, esc = ph.aiEsc, key = c.id + '-' + t.n, a = ph.elState().ai;
        var busy = ph.aiBusy(c) || !!(a.pend && a.pend.cid == c.id), act = (a.act && a.act.cid == c.id && a.act.n == t.n) ? a.act.kind : null;
        var h = '<div class="evlAiTurn' + (isLast ? ' last' : '') + (act ? ' act' : '') + '" data-n=' + t.n + '>';
        if (t.cont) h += '<div class=evlAiSeg>Continued' + (t.at ? ' ' + esc(ph.aiWhen(t.at)) : '') + ' with a recap of the answers above</div>';
        if (t.segment && isLast && t.status == 'done') h += '<div class=evlAiSeg>Earlier answers were summarized to fit the model\'s context</div>';
        if (act == 'edit') h += ph.aiEditHtml(c, t);
        else h += '<div class=evlAiQW><div class="evlAiQ' + (t.diag ? ' dg' : '') + '">' + (t.diag ? ph.aiIcon('diag') : '') + esc(t.q).replace(/\n/g, '<br>') + '</div>' + ph.aiQActsHtml(c, t, busy) + '</div>';
        if (act == 'del') h += ph.aiConfirmHtml(c, t, 'del');
        if (c.status == 'preview' && isLast) h += '<div class=evlAiNoteBox>Waiting for you to review what is sent. <button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiDlgOpen(\'' + c.id + '\')">Review</button></div>';
        if (!(t.diag && t.status == 'done')) h += ph.aiStepsHtml(c, t);   // a finished diagnosis has them in its footer
        if (t.status == 'done') h += ph.aiDoneBody(c, t, 'panel');
        else if (t.status == 'running') h += '<div class="evlAiA evlAiMd" data-t=' + key + ' data-p=a>' + (t.live || ph.aiWaitHtml(c, t)) + '</div>' + ph.aiLiveHtml(c, t);
        else if (t.live) h += '<div class="evlAiA evlAiMd">' + t.live + '</div>';
        if (t.status == 'stopped') h += '<p class=evlAiMuted>Stopped.</p>';
        if (t.status == 'cancelled') h += '<p class=evlAiMuted>Cancelled. Nothing was sent to the model.</p>';
        if (t.status == 'error') h += ph.aiErrHtml(c, t);
        if (t.status == 'done') {
            h += ph.aiAActsHtml(c, t, busy);
            if (act == 'retry') h += ph.aiConfirmHtml(c, t, 'retry');
            if (isLast && ph.aiIsChat(c) && (!c.closed || c.chatId)) h += ph.aiFuHtml(c, t);
        }
        return h + '</div>';
    };
    obj.aiDoneBody = function (c, t, surface) {
        var ph = pluginHandler.eventlog;
        if (c.mode == 'explain' && t.n == 1 && t.structured) return '<div class=evlAiA>' + ph.aiExplainBody(c, t) + '</div>';
        if (t.diag) return ph.aiDiagCard(c, t);
        if (!t.text.trim()) return '<p class=evlAiMuted>The model returned an empty answer.</p>';
        return '<div class="evlAiA evlAiMd">' + t.html + '</div>';
    };

    // ---- message actions: copy, edit, delete (questions); copy, retry (answers) ----------------------------------------
    // Edit, delete and retry change the chat on the server (aiChatEdit); the next question then runs in a new model
    // session with a recap of what is left. A question that never got an answer is only removed here.
    obj.aiCanEdit = function (c, t) {
        return !!(c && t && pluginHandler.eventlog.aiIsChat(c) && t.status == 'done' && (c.chatId || (c.convId && !c.closed)));
    };
    obj.aiLaterN = function (c, t) {
        var i = c.turns.indexOf(t);
        return i < 0 ? 0 : c.turns.length - 1 - i;
    };
    // the message's index in the chat as the server holds it: the answered turns before it (saved chats: + the offset
    // of the messages loaded)
    obj.aiMsgIndex = function (c, t) {
        var n = 0;
        for (var i = 0; i < c.turns.length && c.turns[i] !== t; i++) { if (c.turns[i].status == 'done') n++; }
        return (c.chatId ? (c.msgOff || 0) : 0) + n;
    };
    obj.aiActBtn = function (cid, n, kind, icon, label, dis) {
        var wait = 'Wait until the answer is finished or stop it';
        return '<button type=button class="evlBtn mini evlAiIco" data-act=' + kind + ' aria-label="' + label + '" title="' + (dis ? wait : label) + '"' + (dis ? ' disabled' : '') +
               ' onclick="return pluginHandler.eventlog.aiMsgAct(\'' + cid + '\',' + n + ',\'' + kind + '\',this)">' + pluginHandler.eventlog.aiIcon(icon) + '</button>';
    };
    obj.aiQActsHtml = function (c, t, busy) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiIsChat(c)) return '';
        var can = ph.aiCanEdit(c, t), local = (t.status != 'done' && t.status != 'running' && c.status != 'preview');
        var h = '<div class="evlAiMsgActs q" role=group aria-label="Question actions">' + ph.aiActBtn(c.id, t.n, 'copyq', 'copy', t.diag ? 'Copy' : 'Copy the question', false);
        if (can && !t.diag) h += ph.aiActBtn(c.id, t.n, 'edit', 'edit', 'Edit the question', busy);
        if (can || local) h += ph.aiActBtn(c.id, t.n, 'del', 'del', t.diag ? 'Delete the diagnosis' : 'Delete the question and its answer', busy && !local);
        return h + '</div>';
    };
    obj.aiAActsHtml = function (c, t, busy) {
        var ph = pluginHandler.eventlog;
        var h = '<div class="evlAiMsgActs a" role=group aria-label="Answer actions">' + ph.aiActBtn(c.id, t.n, 'copya', 'copy', t.diag ? 'Copy the diagnosis' : 'Copy the answer', false);
        if (ph.aiCanEdit(c, t)) h += ph.aiActBtn(c.id, t.n, 'retry', 'retry', t.diag ? 'Run the diagnosis again' : 'Retry: ask the same question again', busy);
        return h + '</div>';
    };
    obj.aiEditHtml = function (c, t) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, later = ph.aiLaterN(c, t), v = (a.actDraft != null) ? a.actDraft : t.q;
        return '<div class="evlAiQW edit" role=group aria-label="Edit the question"><label class=evlSr for=evlAiEd>Edit the question</label>' +
               '<textarea id=evlAiEd class=evlAiEdIn rows=3 maxlength=4000 oninput="pluginHandler.eventlog.elState().ai.actDraft=String(this.value).slice(0,4000)" onkeydown="return pluginHandler.eventlog.aiEditKey(event,\'' + c.id + '\',' + t.n + ')">' + ph.aiEsc(v) + '</textarea>' +
               '<p class=evlAiEdNote>' + (later ? 'Sending replaces its answer and removes the ' + (later == 1 ? 'later message' : later + ' later messages') + '.' : 'Sending replaces its answer.') + '</p>' +
               '<div class=evlAiActs><button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiMsgCancel()">Cancel</button>' +
               '<button class="evlBtn mini on" onclick="return pluginHandler.eventlog.aiEditSave(\'' + c.id + '\',' + t.n + ')">Save &amp; send</button></div></div>';
    };
    obj.aiConfirmHtml = function (c, t, kind) {
        var ph = pluginHandler.eventlog, later = ph.aiLaterN(c, t), txt, yes;
        var n = later == 1 ? 'the later message' : 'the ' + later + ' later messages';
        if (kind == 'del') {
            txt = t.diag ? (later ? 'Delete this diagnosis and its ' + (later == 1 ? 'follow-up question' : later + ' follow-up questions') + '? The whole chat goes.' : 'Delete this diagnosis?')
                         : (t.status == 'done' ? 'Delete this question and its answer?' : 'Delete this question?');
            yes = 'Delete';
        } else {
            txt = t.diag ? 'Run the diagnosis again and remove ' + (later == 1 ? 'the follow-up question' : 'the ' + later + ' follow-up questions') + '?' : 'Retry and remove ' + n + '?';
            yes = 'Retry';
        }
        return '<div class=evlAiConfirm role=group aria-label="' + ph.aiEsc(txt) + '"><span>' + ph.aiEsc(txt) + '</span>' +
               '<button class="evlBtn mini' + (kind == 'del' ? ' evlAiDanger' : ' on') + '" data-yes=1 onclick="return pluginHandler.eventlog.aiMsgYes(\'' + c.id + '\',' + t.n + ')">' + yes + '</button>' +
               '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiMsgCancel()">Keep</button></div>';
    };
    obj.aiTurnOf = function (c, n) {
        var t = null;
        if (c) c.turns.forEach(function (x) { if (x.n == n) t = x; });
        return t;
    };
    obj.aiMsgAct = function (cid, n, kind, btn) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[cid], t = ph.aiTurnOf(c, n);
        if (!c || !t) return false;
        if (kind == 'copyq') return ph.aiCopyText(String(t.q), btn);
        if (kind == 'copya') return ph.aiCopyText(ph.aiTurnText(c, t), btn);
        if (ph.aiBusy(c) || (a.pend && a.pend.cid == cid)) { if (!(kind == 'del' && t.status != 'done' && t.status != 'running')) { ph.aiSay('Wait until the answer is finished or stop it.'); return false; } }
        if (kind == 'retry' && !ph.aiLaterN(c, t)) return ph.aiMsgRun(c, t, 'retry');
        a.act = { cid: cid, n: n, kind: kind }; a.actDraft = (kind == 'edit') ? String(t.q) : null;
        ph.aiRenderPanel();
        if (kind == 'edit') { var ta = Q('evlAiEd'); if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { } } }
        else { var y = document.querySelector('#evlAiLog .evlAiConfirm [data-yes]'); if (y) y.focus(); }
        return false;
    };
    obj.aiMsgCancel = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, x = a.act;
        a.act = null; a.actDraft = null;
        ph.aiRenderPanel();
        if (x) { var b = document.querySelector('#evlAiLog .evlAiTurn[data-n="' + x.n + '"] [data-act=' + (x.kind == 'retry' ? 'retry' : x.kind) + ']'); if (b) b.focus(); }
        return false;
    };
    obj.aiMsgYes = function (cid, n) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, x = a.act, c = a.convs[cid], t = ph.aiTurnOf(c, n);
        if (!x || x.cid != cid || x.n != n || !t) return false;
        a.act = null;
        return ph.aiMsgRun(c, t, x.kind == 'del' ? 'delete' : 'retry');
    };
    obj.aiEditSave = function (cid, n) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[cid], t = ph.aiTurnOf(c, n), ta = Q('evlAiEd');
        var text = String((ta ? ta.value : a.actDraft) || '').trim().slice(0, 4000);
        if (!c || !t) return false;
        if (!text) { if (ta) ta.focus(); return false; }
        a.act = null; a.actDraft = null;
        return ph.aiMsgRun(c, t, 'edit', text);
    };
    obj.aiEditKey = function (ev, cid, n) {
        var ph = pluginHandler.eventlog;
        if (ev.key == 'Escape') { ev.preventDefault(); if (ev.stopPropagation) ev.stopPropagation(); ph.aiMsgCancel(); return false; }
        if (ev.key == 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); ph.aiEditSave(cid, n); return false; }
        return true;
    };
    // remove turn t (op 'delete') or t and every later one ('truncate') here; the conversation goes when nothing is left
    obj.aiTurnsCut = function (c, t, op) {
        var a = pluginHandler.eventlog.elState().ai, i = c.turns.indexOf(t);
        if (i < 0) return;
        if (op == 'delete') c.turns.splice(i, 1); else c.turns.length = i;
        c.turns.forEach(function (x) { x.sHtml = null; });
        if (!c.turns.length) { pluginHandler.eventlog.aiCloseConv(c); delete a.convs[c.id]; if (a.chat == c.id) a.chat = null; }
        if (a.focus == c.id) a.sel = null;
        a.citeVer++;
    };
    // kind: 'delete' | 'retry' | 'edit' (text: the edited question)
    obj.aiMsgRun = function (c, t, kind, text) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        var op = (kind == 'delete') ? 'delete' : 'truncate';
        var then = (kind == 'edit') ? { text: text } : (kind == 'retry' ? (t.diag ? { diag: c.win || '24h' } : { text: String(t.q) }) : null);
        if (!ph.aiCanEdit(c, t)) {   // a question the server never answered: only here
            if (ph.aiBusy(c) && t === c.turns[c.turns.length - 1]) return false;
            ph.aiTurnsCut(c, t, op);
            if (then && then.text) ph.aiAsk(then.text);
            else { ph.aiRenderPanel(); ph.elUpdate(); ph.aiSay('Question deleted.'); }
            return false;
        }
        var m = { index: ph.aiMsgIndex(c, t), op: op, q: String(t.q).trim() };
        if (c.chatId) m.chatId = c.chatId; else m.convId = c.convId;
        a.pend = { cid: c.id, n: t.n, op: op, then: then, chatId: c.chatId || null, convId: c.chatId ? null : c.convId };
        ph.aiSendMsg('aiChatEdit', m);
        ph.aiRenderPanel();
        return false;
    };
    obj.onAiChatEdited = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var a = ph.st.ai, p = a.pend;
        if (!p || (m.chatId || null) !== p.chatId || (!p.chatId && m.convId !== p.convId)) return;
        a.pend = null;
        var c = a.convs[p.cid], t = ph.aiTurnOf(c, p.n), sv = a.saved;
        if (m.ok !== true) {
            var code = String(m.code || '');
            ph.aiSay(code == 'busy' ? 'Wait until the answer is finished or stop it.' : (code == 'changed' ? 'This chat changed meanwhile; it is shown again as it is saved.' : (code == 'notFound' ? 'This chat is no longer available.' : 'The chat could not be changed.')));
            if (code == 'changed' && p.chatId && c && !ph.aiBusy(c)) { a.opening = p.chatId; a.openAuto = false; ph.aiHistoryGet('chat', p.chatId); }
            ph.aiRenderPanel();
            return;
        }
        if (m.deleted === true) {
            if (sv && p.chatId) sv.chats = sv.chats.filter(function (x) { return x.id !== p.chatId; });
            if (c) { ph.aiCloseConv(c); delete a.convs[c.id]; if (a.chat == c.id) a.chat = null; if (a.focus == c.id) { a.focus = null; a.sel = null; } }
            a.citeVer++;
        } else if (m.chat && typeof m.chat == 'object' && p.chatId) {
            // the saved chat as the server holds it now: the next question continues it in a new session with a recap
            var nc = ph.aiConvFromSaved('chat', Object.assign({}, m.chat, { id: p.chatId }));
            if (nc && c) nc.gen = ph.aiGenClean(c.gen);   // the settings as the user has them now
            if (c) { ph.aiCloseConv(c); delete a.convs[c.id]; }
            if (nc && a.chat == p.cid) { a.chat = nc.id; if (a.focus == p.cid) a.focus = nc.id; }
            if (sv) sv.chats.forEach(function (x) { if (x.id === p.chatId) x.count = nc ? nc.turns.length : x.count; });
            a.citeVer++;
        } else if (c && t) ph.aiTurnsCut(c, t, p.op);   // a conversation that is not saved: the server reset its session
        if (p.then && p.then.diag) { ph.aiDiagnose(p.then.diag); return; }
        if (p.then && p.then.text) { ph.aiAsk(p.then.text); ph.elUpdate(); return; }
        ph.aiRenderPanel();
        ph.elUpdate();
        ph.aiSay('Deleted.');
        var f = Q('evlAiIn'); if (f) f.focus();
    };

    obj.aiRenderComposer = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.chat], busy = ph.aiBusy(c), ft = Q('evlAiFt');
        if (!ft) return;
        if (!Q('evlAiIn')) {
            var acc = ph.elAccess || {}, name = (typeof currentNode != 'undefined' && currentNode) ? currentNode.name : 'this device';
            ft.innerHTML = '<div id=evlAiPeekSlot></div><label for=evlAiIn class=evlAiLbl>Ask about ' + ph.aiEsc(name) + '</label>' +
                '<div class=evlAiRow><textarea id=evlAiIn rows=2 maxlength=4000 onkeydown="return pluginHandler.eventlog.aiKey(event)" oninput="pluginHandler.eventlog.aiDraft(this)"></textarea>' +
                '<button id=evlAiSend class="evlBtn on" onclick="return pluginHandler.eventlog.aiSubmit()">Send</button></div>' +
                '<div class=evlAiDisc><span>Answers can be wrong. Check the cited events before acting.' + ((function (r) { var q = (typeof r == 'number') ? r : ((r != null && typeof r.questions == 'number') ? r.questions : null); return (q != null && q <= 10) ? ' ' + q + ' questions left today.' : ''; })(acc.remaining)) + '</span>' +
                '<button id=evlAiHReset class=evlLinkBtn hidden title="Fit the panel to the window again" onclick="return pluginHandler.eventlog.aiHGripReset()">Reset panel height</button></div>';
            Q('evlAiIn').value = a.draft || '';
        }
        var b = Q('evlAiSend'), lt = (c && busy) ? c.turns[c.turns.length - 1] : null, want = lt ? 'stop:' + lt.t0 : 'send';
        if (b._evlState !== want) {   // not rebuilt while it stays the same: the arc keeps turning smoothly
            b._evlState = want;
            b.innerHTML = lt ? ph.aiStopInner(lt) : 'Send';
            b.classList.toggle('on', !lt);
            b.classList.toggle('evlAiStop', !!lt);
            b.setAttribute('aria-label', lt ? 'Stop' : 'Send the question');
        }
        ph.aiRenderPeek();
    };
    obj.aiKey = function (ev) {
        if (ev.key == 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); pluginHandler.eventlog.aiSubmit(); return false; }
        return true;
    };
    obj.aiDraft = function (el) {
        pluginHandler.eventlog.elState().ai.draft = String(el.value || '').slice(0, 4000);
    };
    obj.aiSubmit = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.chat];
        if (ph.aiBusy(c)) { ph.aiStop(c.id); return false; }
        var ta = Q('evlAiIn'), text = String((ta ? ta.value : a.draft) || '').trim();
        if (!text) { if (ta) ta.focus(); return false; }
        ph.aiAsk(text);
        return false;
    };
    obj.aiAsk = function (text) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (!ph.elCan('assistant')) return false;
        text = String(text).slice(0, 4000);
        var c = a.convs[a.chat];
        if (c && a.pend && a.pend.cid == c.id) { ph.aiSay('Wait until the chat is updated.'); return false; }
        a.draft = '';
        var ta = Q('evlAiIn'); if (ta) ta.value = '';
        a.hist = false; a.delAsk = null; a.diagSetup = false; a.act = null;
        // a diagnosis chat takes questions once its diagnosis is there
        var chat = ph.aiIsChat(c) && !(c.mode == 'diagnose' && c.turns[0].status != 'done');
        if (chat && c.convId && !c.closed && !ph.aiBusy(c) && c.status != 'cancelled') {
            var last = c.turns[c.turns.length - 1];
            c.turns.push(ph.aiNewTurn((last ? last.n : 0) + 1, text));
            c.status = 'running'; c.last = Date.now();
            var sm = { convId: c.convId, text: text }, sg = ph.aiGenOut(c.gen);
            if (sg) sm.gen = sg;
            ph.aiSendMsg('aiSend', sm);
            ph.aiDogStart();
        } else if (chat && c.chatId && !ph.aiBusy(c) && c.turns.length) {
            // a saved chat (or one whose server conversation ended): a new conversation continues it with a recap
            var lt = c.turns[c.turns.length - 1];
            c.turns.forEach(function (x) { x.srvN = -1; });
            var nt = ph.aiNewTurn((lt ? lt.n : 0) + 1, text);
            nt.cont = true; nt.at = Date.now();
            c.turns.push(nt);
            c.convId = null; c.closed = false; c.ended = false; c.reqId = ph.aiReqId(); c.status = 'starting'; c.preview = null;
            c.last = Date.now();
            var cm = { reqId: c.reqId, mode: 'ask', input: { text: text }, chatId: c.chatId }, cg = ph.aiGenOut(c.gen);
            if (cg) cm.gen = cg;
            ph.aiSendMsg('aiStart', cm);
            ph.aiDogStart();
        } else {
            if (ph.aiIsChat(c)) ph.aiCloseConv(c);
            c = ph.aiNewConv('ask', { text: text }, text);
            a.chat = c.id;
            ph.aiStartConv(c);
        }
        a.open = true;
        ph.aiRenderPanel();
        return false;
    };
    obj.aiFollow = function (cid, n, idx) {
        var ph = pluginHandler.eventlog, c = ph.elState().ai.convs[cid], f = null;
        if (c) c.turns.forEach(function (t) { if (t.n == n) f = t.followups[idx]; });
        if (typeof f == 'string' && f.trim()) ph.aiAsk(ph.aiStripMarks(f));
        return false;
    };

    // ---- suggested follow-up questions: a compact, collapsible row under the last answer ------------------------------
    // Collapsed by default (remembered per browser: evl_ai_fu). "Suggest questions" asks the server for new ones
    // (aiFollowups: one short request without tools); t.fuShow opens the new ones for that answer only.
    obj.aiFuOpen = function () {
        var ph = pluginHandler.eventlog;
        if (typeof ph._aiFu != 'boolean') { var v = ''; try { v = getstore('evl_ai_fu', ''); } catch (e) { } ph._aiFu = (v == '1'); }
        return ph._aiFu;
    };
    obj.aiFuHtml = function (c, t) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, esc = ph.aiEsc, list = t.followups || [], n = list.length, busy = !!t.fuBusy;
        var open = n > 0 && (t.fuShow != null ? t.fuShow : ph.aiFuOpen()), lid = 'evlAiFuL' + c.id + '-' + t.n;
        var wait = ph.aiBusy(c) || !!(a.pend && a.pend.cid == c.id);
        var h = '<div class="evlAiFu' + (open ? ' open' : '') + '" data-n=' + t.n + '><div class=evlAiFuBar>';
        if (n) h += '<button type=button class=evlAiFuTg data-fu=tg aria-expanded=' + (open ? 'true' : 'false') + ' aria-controls=' + lid +
                    ' onclick="return pluginHandler.eventlog.aiFuToggle(\'' + c.id + '\',' + t.n + ')">' + ph.aiIcon('chev') + 'Suggested questions <span class=n>(' + n + ')</span></button>';
        else h += '<span class=evlAiFuNone>No suggested questions</span>';
        h += '<button type=button class=evlAiFuRe data-fu=re' + (busy ? ' aria-disabled=true aria-busy=true' : '') + (wait && !busy ? ' disabled' : '') +
             ' title="' + (busy ? 'Suggesting questions' : (wait ? 'Wait until the answer is finished' : 'Ask the model for new follow-up questions')) + '"' +
             ' onclick="return pluginHandler.eventlog.aiFuGen(\'' + c.id + '\',' + t.n + ')">' +
             (busy ? '<svg class=evlAiRing width=12 height=12 viewBox="0 0 16 16" aria-hidden=true><circle class=trk cx=8 cy=8 r=6.5 /><circle class=arc cx=8 cy=8 r=6.5 /></svg>Suggesting…' : ph.aiIcon('retry') + 'Suggest questions') + '</button></div>';
        if (open) {
            h += '<div class=evlAiFuL id=' + lid + ' role=group aria-label="Suggested follow-up questions">';
            list.forEach(function (f, i) { h += '<button type=button class=evlAiFuChip data-i=' + i + ' onclick="return pluginHandler.eventlog.aiFollow(\'' + c.id + '\',' + t.n + ',' + i + ')">' + esc(ph.aiStripMarks(f)) + '</button>'; });
            h += '</div>';
        }
        if (t.fuErr) h += '<p class=evlAiFuErr>' + esc(t.fuErr) + '</p>';
        return h + '</div>';
    };
    // the full text of a shortened chip as its tooltip (set as a property: model text never goes into the markup's attributes)
    obj.aiFuTitles = function (root) {
        var l = root ? root.querySelectorAll('.evlAiFuChip') : [];
        for (var i = 0; i < l.length; i++) l[i].title = l[i].textContent;
    };
    obj.aiFuFocus = function (n, which) {
        var b = document.querySelector('#evlAiLog .evlAiFu[data-n="' + n + '"] [data-fu=' + which + ']');
        if (b) b.focus();
    };
    obj.aiFuToggle = function (cid, n) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[cid], t = ph.aiTurnOf(c, n);
        if (!c || !t) return false;
        var open = !(t.fuShow != null ? t.fuShow : ph.aiFuOpen());
        ph._aiFu = open;
        try { putstore('evl_ai_fu', open ? '1' : ''); } catch (e) { }
        c.turns.forEach(function (x) { x.fuShow = null; });
        ph.aiRenderPanel();
        ph.aiFuFocus(n, 'tg');
        return false;
    };
    obj.aiFuGen = function (cid, n) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[cid], t = ph.aiTurnOf(c, n);
        if (!c || !t || t.fuBusy) return false;
        if (ph.aiBusy(c) || (a.pend && a.pend.cid == cid)) { ph.aiSay('Wait until the answer is finished.'); return false; }
        var m = { reqId: 'fu' + ph.aiReqId() };
        if (c.convId && !c.closed) m.convId = c.convId;
        if (c.chatId) m.chatId = c.chatId;
        if (!m.convId && !m.chatId) return false;
        if (a.fuReq) { var o = ph.aiTurnOf(a.convs[a.fuReq.cid], a.fuReq.n); if (o) o.fuBusy = null; }
        a.fuReq = { reqId: m.reqId, cid: cid, n: n };
        t.fuBusy = m.reqId; t.fuErr = null;
        clearTimeout(ph._aiFuT);
        ph._aiFuT = setTimeout(function () { try { var p = pluginHandler.eventlog, r = p.st && p.st.ai && p.st.ai.fuReq; if (r && r.reqId === m.reqId) p.aiFuFail({ reqId: m.reqId, code: 'noReply' }); } catch (e) { } }, 90000);
        ph.aiSendMsg('aiFollowups', m);
        ph.aiRenderPanel();
        ph.aiFuFocus(n, 're');
        ph.aiSay('Suggesting questions…');
        return false;
    };
    obj.onAiFollowups = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var a = ph.st.ai, fr = a.fuReq;
        if (!fr || m.reqId !== fr.reqId) return;
        a.fuReq = null; clearTimeout(ph._aiFuT);
        var c = a.convs[fr.cid], t = ph.aiTurnOf(c, fr.n);
        if (!c || !t) return;
        var back = !document.activeElement || document.activeElement === document.body || !!(document.activeElement.closest && document.activeElement.closest('.evlAiFu'));
        t.followups = (Array.isArray(m.followups) ? m.followups : []).filter(function (f) { return typeof f == 'string' && f.trim(); }).slice(0, 3).map(function (f) { return f.slice(0, 200); });
        t.fuBusy = null; t.fuErr = null;
        t.fuShow = t.followups.length ? true : null;
        if (a.open && a.chat == c.id) ph.aiRenderPanel();
        if (back) ph.aiFuFocus(fr.n, 're');
        var k = t.followups.length;
        ph.aiSay(k ? (k == 1 ? '1 suggested question.' : k + ' suggested questions.') : 'No suggested questions.');
    };
    obj.aiFuFail = function (m) {
        var ph = pluginHandler.eventlog, a = ph.st.ai, fr = a.fuReq;
        if (!fr || (m.reqId != null && m.reqId !== fr.reqId)) return;
        a.fuReq = null; clearTimeout(ph._aiFuT);
        var c = a.convs[fr.cid], t = ph.aiTurnOf(c, fr.n), code = String(m.code || 'internal');
        if (code == 'denied') { try { ph.elRequestAccess(true); } catch (e) { } }
        if (!c || !t) return;
        t.fuBusy = null;
        t.fuErr = 'No new questions: ' + ph.aiErrText(code, m.phase);
        if (a.open && a.chat == c.id) ph.aiRenderPanel();
        ph.aiSay(t.fuErr);
    };

    // ---- answer settings per chat: thinking level and temperature (on top of the endpoint's) -------------------------
    // The server says what this endpoint takes (onAccess chatGen); a chat keeps its settings (c.gen, saved with it), a
    // chat not started yet uses a.genNew; New chat starts again with the endpoint's.
    obj.aiGenInfo = function () {
        var g = (pluginHandler.eventlog.elAccess || {}).chatGen;
        if (!g || typeof g != 'object' || g.enabled !== true) return null;
        var lv = Array.isArray(g.thinkingLevels) ? g.thinkingLevels.filter(function (x) { return ['off', 'low', 'medium', 'high'].indexOf(x) >= 0; }) : null;
        if (lv && !lv.length) lv = null;
        if (!lv && g.temperature !== true) return null;
        var num = function (v) { return (typeof v == 'number' && isFinite(v)) ? v : null; };
        return { levels: lv, verified: g.thinkingVerified === true, temperature: g.temperature === true,
                 epThinking: (['off', 'low', 'medium', 'high'].indexOf(g.endpointThinking) >= 0) ? g.endpointThinking : null, epTemperature: num(g.endpointTemperature) };
    };
    // { thinking?, temperature? } kept only where this endpoint takes them
    obj.aiGenClean = function (g) {
        var info = pluginHandler.eventlog.aiGenInfo(), o = {};
        if (!g || typeof g != 'object' || !info) return o;
        if (info.levels && info.levels.indexOf(g.thinking) >= 0) o.thinking = g.thinking;
        if (info.temperature && typeof g.temperature == 'number' && isFinite(g.temperature) && g.temperature >= 0 && g.temperature <= 2) o.temperature = Math.round(g.temperature * 100) / 100;
        return o;
    };
    // what aiStart / aiSend carry (null: nothing to send, the server keeps the chat's or the endpoint's)
    obj.aiGenOut = function (g) {
        var ph = pluginHandler.eventlog;
        return ph.aiGenInfo() ? ph.aiGenClean(g) : null;
    };
    obj.aiGenGet = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.chat];
        if (a.diagSetup || !ph.aiIsChat(c)) return a.genNew || {};
        if (!c.gen) c.gen = {};
        return c.gen;
    };
    obj.aiGenSet = function (k, v) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.chat];
        var g = (a.diagSetup || !ph.aiIsChat(c)) ? (a.genNew = a.genNew || {}) : (c.gen = c.gen || {});
        if (v == null) delete g[k]; else g[k] = v;
        QH('evlAiHd', ph.aiHeadHtml(c || null));
    };
    obj.aiGenWord = function (l) {
        return ({ off: 'off', low: 'low', medium: 'medium', high: 'high' })[l] || '';
    };
    // "Thinking: high · temperature 0.7": what this chat changes ('' = the endpoint's settings)
    obj.aiGenTag = function (g) {
        var ph = pluginHandler.eventlog, info = ph.aiGenInfo(), p = [];
        if (!info || !g) return '';
        g = ph.aiGenClean(g);
        if (g.thinking) p.push('Thinking: ' + ph.aiGenWord(g.thinking));
        if (g.temperature != null) p.push((p.length ? 'temperature ' : 'Temperature ') + g.temperature);
        return p.join(' · ');
    };
    obj.aiGenToggle = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (a.genOpen) { ph.aiGenClose(true); return false; }
        if (!ph.aiGenInfo()) return false;
        a.genOpen = true;
        ph.aiGenRender();
        var b = Q('evlAiGenBtn'); if (b) b.setAttribute('aria-expanded', 'true');
        if (!ph._aiGenDoc) {
            ph._aiGenDoc = function (ev) { try { pluginHandler.eventlog.aiGenOutside(ev); } catch (e) { } };
            document.addEventListener('pointerdown', ph._aiGenDoc, true);
        }
        var f = document.querySelector('#evlAiGenPop [aria-pressed=true]:not([disabled])') || document.querySelector('#evlAiGenPop button:not([disabled]), #evlAiGenPop input');
        if (f) f.focus();
        return false;
    };
    // back: focus returns to the Answer settings button
    obj.aiGenClose = function (back) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        a.genOpen = false;
        if (ph._aiGenDoc) { document.removeEventListener('pointerdown', ph._aiGenDoc, true); ph._aiGenDoc = null; }
        var s = Q('evlAiPopSlot'); if (s) s.innerHTML = '';
        var b = Q('evlAiGenBtn');
        if (b) { b.setAttribute('aria-expanded', 'false'); if (back) b.focus(); }
        return false;
    };
    obj.aiGenOutside = function (ev) {
        var ph = pluginHandler.eventlog, t = ev && ev.target;
        if (!t || !t.closest) return;
        if (t.closest('#evlAiGenPop') || t.closest('#evlAiGenBtn')) return;
        ph.aiGenClose(false);
    };
    obj.aiGenKey = function (ev) {
        var ph = pluginHandler.eventlog;
        if (ev.key == 'Escape') { ev.preventDefault(); if (ev.stopPropagation) ev.stopPropagation(); ph.aiGenClose(true); return false; }
        return true;
    };
    // focus leaving the popover (Tab past its last control) closes it
    obj.aiGenBlur = function (ev) {
        var ph = pluginHandler.eventlog, to = ev && ev.relatedTarget;
        if (!to || !to.closest) return;
        if (to.closest('#evlAiGenPop') || to.closest('#evlAiGenBtn')) return;
        ph.aiGenClose(false);
    };
    obj.aiGenHtml = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, info = ph.aiGenInfo(), esc = ph.aiEsc;
        if (!info) return '';
        var c = a.convs[a.chat], g = ph.aiGenClean(ph.aiGenGet()), forChat = !a.diagSetup && ph.aiIsChat(c);
        var h = '<div id=evlAiGenPop class=evlAiPop role=dialog aria-modal=false aria-labelledby=evlAiGenH aria-describedby=evlAiGenSub' +
                ' onkeydown="return pluginHandler.eventlog.aiGenKey(event)" onfocusout="pluginHandler.eventlog.aiGenBlur(event)">' +
                '<div class=evlAiPopHd><h3 id=evlAiGenH>Answer settings</h3><button type=button class="evlBtn mini evlAiIco evlAiX" data-k=x aria-label="Close the answer settings" title="Close (Esc)" onclick="return pluginHandler.eventlog.aiGenClose(true)">' + ph.aiIcon('x') + '</button></div>' +
                '<p class=evlAiPopSub id=evlAiGenSub>' + (forChat ? 'For this chat.' : 'For the chat you start next.') + ' New chats start with the endpoint\'s settings.</p>';
        if (info.levels) {
            var cur = g.thinking || '';
            h += '<div class=evlAiGenF><span class=evlAiGenL id=evlAiGenThL>Thinking</span><div class=evlAiGenSeg role=group aria-labelledby=evlAiGenThL>';
            [['', 'Endpoint default'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].forEach(function (x) {
                var ok = (x[0] === '' || info.levels.indexOf(x[0]) >= 0), on = (cur === x[0]);
                h += '<button type=button data-k="th' + (x[0] || 'def') + '" aria-pressed=' + (on ? 'true' : 'false') + (ok ? '' : ' disabled title="This endpoint does not take this level"') +
                     (x[0] === '' ? ' aria-label="Endpoint default"' : '') + ' onclick="return pluginHandler.eventlog.aiGenThink(\'' + x[0] + '\')">' +
                     (x[0] === '' ? '<span class=lg>Endpoint default</span><span class=sm>Default</span>' : x[1]) + '</button>';
            });
            h += '</div><p class=evlAiGenHint>' + esc(info.epThinking ? 'Endpoint default: ' + ph.aiGenWord(info.epThinking) + '.' : 'Endpoint default: the server\'s own setting.') +
                 (info.verified ? '' : ' <span class=evlAiGenWarn>Not verified for this endpoint: a level may have no effect, or the server may refuse it.</span>') + '</p></div>';
        }
        if (info.temperature) {
            var tv = g.temperature, shown = (tv != null) ? tv : (info.epTemperature != null ? info.epTemperature : 1);
            h += '<div class=evlAiGenF><div class=evlAiGenTH><label for=evlAiGenT class=evlAiGenL>Temperature</label><output id=evlAiGenTV for=evlAiGenT' + (tv != null ? '' : ' class=def') + '>' + (tv != null ? tv.toFixed(2) : 'Endpoint default') + '</output></div>' +
                 '<input type=range id=evlAiGenT data-k=temp min=0 max=2 step=0.05 value="' + shown + '" aria-valuetext="' + (tv != null ? tv.toFixed(2) : 'Endpoint default') + '"' +
                 ' oninput="pluginHandler.eventlog.aiGenTemp(this,false)" onchange="pluginHandler.eventlog.aiGenTemp(this,true)">' +
                 '<div class=evlAiGenScale aria-hidden=true><span>0 predictable</span><span>1</span><span>2 varied</span></div>' +
                 '<p class=evlAiGenHint>' + esc(info.epTemperature != null ? 'Endpoint default: ' + info.epTemperature + '.' : 'Endpoint default: the server\'s own setting.') +
                 (tv != null ? ' <button type=button class=evlLinkBtn data-k=treset onclick="return pluginHandler.eventlog.aiGenTempReset()">Use the endpoint default</button>' : '') + '</p></div>';
        }
        h += '<div class=evlAiPopFt><span>' + (ph.aiBusy(c) && forChat ? 'Applies from the next question.' : 'Applies to the next answers.') + '</span>' +
             '<button type=button class="evlBtn mini on" data-k=done onclick="return pluginHandler.eventlog.aiGenClose(true)">Done</button></div>';
        return h + '</div>';
    };
    // render the popover (keeping the focus on the control with data-k = focusKey)
    obj.aiGenRender = function (focusKey) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, s = Q('evlAiPopSlot');
        if (!s) return;
        if (!a.genOpen) { s.innerHTML = ''; return; }
        s.innerHTML = ph.aiGenHtml();
        ph.aiGenPlace();
        if (focusKey) { var f = document.querySelector('#evlAiGenPop [data-k="' + focusKey + '"]'); if (f && !f.disabled) f.focus(); else { f = document.querySelector('#evlAiGenPop [aria-pressed=true]'); if (f) f.focus(); } }
    };
    // below the header, its right edge under the settings button's, inside the panel and the visible window
    obj.aiGenPlace = function () {
        var p = Q('evlAiGenPop'), hd = Q('evlAiHd'), b = Q('evlAiGenBtn'), box = p && p.offsetParent;
        if (!p || !hd) return;
        p.style.top = (hd.offsetTop + hd.offsetHeight - 2) + 'px';
        if (!b || !box) return;
        var br = b.getBoundingClientRect(), xr = box.getBoundingClientRect(), w = p.offsetWidth;
        if (!w || !xr.width) return;
        var vw = (window.innerWidth || document.documentElement.clientWidth || 0);
        var left = Math.round(br.right - xr.left - w + 8);
        if (vw > 0) left = Math.min(left, Math.round(vw - xr.left - w - 8));
        left = Math.max(8, Math.min(left, Math.round(xr.width - w - 8)));
        p.style.left = left + 'px'; p.style.right = 'auto';
    };
    // after the panel was rendered: closed when it cannot be offered now, else kept where it is (and placed again)
    obj.aiGenSync = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (!a.genOpen) return;
        if (a.hist || !ph.aiGenInfo()) { ph.aiGenClose(false); return; }
        if (!Q('evlAiGenPop')) ph.aiGenRender(); else ph.aiGenPlace();
    };
    obj.aiGenThink = function (l) {
        var ph = pluginHandler.eventlog, info = ph.aiGenInfo();
        if (!info || !info.levels) return false;
        if (l !== '' && info.levels.indexOf(l) < 0) return false;
        ph.aiGenSet('thinking', l === '' ? null : l);
        ph.aiGenRender('th' + (l || 'def'));
        ph.aiSay(l === '' ? 'Thinking: endpoint default.' : 'Thinking: ' + ph.aiGenWord(l) + '.');
        return false;
    };
    // the slider: the readout follows while it moves; commit (change) re-renders with "Use the endpoint default"
    obj.aiGenTemp = function (el, commit) {
        var ph = pluginHandler.eventlog, v = Math.round(Number(el.value) * 100) / 100;
        if (!(v >= 0 && v <= 2)) return;
        ph.aiGenSet('temperature', v);
        var o = Q('evlAiGenTV'); if (o) { o.textContent = v.toFixed(2); o.classList.remove('def'); }
        el.setAttribute('aria-valuetext', v.toFixed(2));
        if (commit) ph.aiGenRender('temp');
    };
    obj.aiGenTempReset = function () {
        var ph = pluginHandler.eventlog;
        ph.aiGenSet('temperature', null);
        ph.aiGenRender('temp');
        ph.aiSay('Temperature: endpoint default.');
        return false;
    };
    obj.aiNewChat = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.chat];
        if (ph.aiIsChat(c)) { if (ph.aiBusy(c)) ph.aiStop(c.id); ph.aiCloseConv(c); delete a.convs[c.id]; }
        if (c && a.focus == c.id) { a.focus = null; a.sel = null; }
        a.chat = null; a.peek = null; a.citeVer++; a.hist = false; a.delAsk = null; a.opening = null; a.diagSetup = false; a.act = null; a.pend = null;
        a.genNew = {}; a.fuReq = null;   // a new chat starts with the endpoint's answer settings
        if (a.genOpen) ph.aiGenClose(false);
        a.open = true;
        ph.aiRenderPanel();
        ph.elUpdate();
        var ta = Q('evlAiIn'); if (ta) ta.focus();
        return false;
    };
    // Put a question into the composer without sending it (the user reviews and sends).
    obj.aiPrefill = function (text) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.chat];
        if (c && !ph.aiIsChat(c)) a.chat = null;
        a.draft = String(text).slice(0, 4000);
        a.open = true; a.diagSetup = false; a.hist = false;
        ph.aiRenderPanel();
        var ta = Q('evlAiIn');
        if (ta) { ta.value = a.draft; ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { } }
        return false;
    };

    // ---- Explain --------------------------------------------------------------------------------------------------
    obj.aiExplainConv = function (ev) {
        var a = pluginHandler.eventlog.elState().ai;
        if (!ev || !ev._raw || ev._raw._id == null) return null;
        var cid = a.explainBy[String(ev._raw._id)];
        return cid ? (a.convs[cid] || null) : null;
    };
    // History rows only: Live events have no stored id.
    obj.aiExplainBtn = function (ev) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (!ph.elCan('assistant') || st.view != 'history' || !ev || !ev._raw || ev._raw._id == null) return '';
        var c = ph.aiExplainConv(ev);
        if (c && c.status != 'cancelled' && c.status != 'stopped') return '';
        if (!c && ph.aiExplainSaved(ev)) return '';   // the saved explanation is shown (or loading) instead
        return '<button class="evlBtn mini evlAiGo" onclick="event.stopPropagation();return pluginHandler.eventlog.aiExplain(\'' + ev.key + '\')">Explain this event</button>';
    };
    // a saved explanation of this event that is not loaded yet: the event id, else null
    obj.aiExplainSaved = function (ev) {
        var a = pluginHandler.eventlog.elState().ai, sv = a.saved;
        if (!sv || !sv.enabled || !ev || !ev._raw || ev._raw._id == null) return null;
        var id = String(ev._raw._id);
        return (sv.explains && sv.explains[id] && a.exReq[id] !== 'gone') ? id : null;
    };
    obj.aiExplain = function (key) {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai, ev = ph.byKey[key];
        if (!ph.elCan('assistant') || !ev || !ev._raw || ev._raw._id == null) return false;
        var id = String(ev._raw._id);
        if (id.length > 64) return false;
        var old = a.convs[a.explainBy[id]];
        if (old && ph.aiBusy(old)) return false;
        for (var k in a.convs) { var o = a.convs[k]; if (o.mode == 'explain' && !ph.aiBusy(o)) ph.aiCloseConv(o); }   // one open Explain session at a time
        var c = ph.aiNewConv('explain', { eventId: id }, 'Explain this event: ' + ev.source + ' ' + ev.id);
        c.evLabel = ev.source + ' ' + ev.id;
        a.explainBy[id] = c.id;
        ph.aiStartConv(c);
        ph.elUpdate();
        return false;
    };
    obj.aiVerdict = function (v) {
        return ({ usually: 'Usually harmless.', sometimes: 'Sometimes harmless.', rarely: 'Rarely harmless.' })[v] || 'Hard to say.';
    };
    obj.aiExplainBody = function (c, t) {
        var ph = pluginHandler.eventlog, s = t.structured;
        if (!s) return '<div class="evlAiA evlAiMd">' + t.html + '</div>';
        if (t.sHtml) return t.sHtml;
        var md = function (x) { return ph.aiMd(x, c); };
        var h = '';
        if (s.meaning) h += '<h4>What it means</h4><div class=evlAiMd>' + md(s.meaning) + '</div>';
        if (s.onDevice) h += '<h4>On this device</h4><div class=evlAiMd>' + md(s.onDevice) + '</div>';
        if (s.harmless) h += '<h4>Is it usually harmless?</h4><div class=evlAiMd>' + md('**' + ph.aiVerdict(s.harmless.verdict) + '** ' + (s.harmless.text || '')) + '</div>';
        if (Array.isArray(s.checkNext) && s.checkNext.length) {
            h += '<h4>Check next</h4><ul class="evlAiMd evlAiChk">';
            s.checkNext.forEach(function (x) { h += '<li>' + md(x) + '</li>'; });
            h += '</ul>';
        }
        if (t.text && t.text.trim()) h += '<details class=evlAiMore><summary>More from the assistant</summary><div class=evlAiMd>' + t.html + '</div></details>';
        t.sHtml = h;
        return h;
    };
    obj.aiExplainMeta = function (c) {
        var ph = pluginHandler.eventlog, line = ph.aiInfoLine(c, true), cnt = ph.aiCounts(c.red), red;
        if (cnt.total > 0) red = cnt.total + (cnt.total == 1 ? ' value' : ' values') + ' replaced before sending: ' + cnt.list + '.';
        else if (c.red) red = 'Nothing replaced before sending.';
        else red = (c.info && c.info.redacted) ? 'Values are replaced before sending.' : '';
        return (c.restored && c.doneAt ? 'Explained ' + ph.aiWhen(c.doneAt) + '. ' : '') + (line ? line + '. ' : '') + red;
    };
    obj.aiExplainHtml = function (ev) {
        var ph = pluginHandler.eventlog, c = ph.aiExplainConv(ev), esc = ph.aiEsc;
        if (!c) {
            var sid = ph.aiExplainSaved(ev), a = ph.elState().ai;
            if (!sid || ph.elState().view != 'history') return '';
            if (!a.exReq[sid]) { a.exReq[sid] = 1; ph.aiHistoryGet('explain', sid); }
            return '<section class=evlAiEx aria-label="Explanation" aria-busy=true onclick="event.stopPropagation()"><div class=evlAiExHd><h3>Explain this event</h3></div><p class=evlAiMuted>Loading the saved explanation…</p></section>';
        }
        var t = c.turns[0], key = c.id + '-' + t.n, busy = ph.aiBusy(c);
        var h = '<section class=evlAiEx aria-label="Explanation" onclick="event.stopPropagation()">' + ph.aiStripHtml(c, t) + '<div class=evlAiExHd><h3>Explain this event</h3>';
        if (busy) h += '<button class="evlBtn mini evlAiStop" aria-label="Stop" onclick="return pluginHandler.eventlog.aiStop(\'' + c.id + '\')">' + ph.aiStopInner(t) + '</button>';
        else if (t.status == 'done') h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiExplainContinue(\'' + c.id + '\')">Continue in Ask</button>' +
                                        '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiCopyTurn(\'' + c.id + '\',1,this)">Copy</button>' +
                                        (c.restored ? '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiRetry(\'' + c.id + '\')">Explain again</button>' : '');
        else h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiRetry(\'' + c.id + '\')">Explain again</button>';
        h += '</div>';
        var meta = ph.aiExplainMeta(c);
        if (meta) h += '<div class=evlAiMuted>' + esc(meta) + '</div>';
        h += ph.aiNotesHtml(c);
        if (c.status == 'preview') h += '<div class=evlAiNoteBox>Waiting for you to review what is sent. <button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiDlgOpen(\'' + c.id + '\')">Review</button></div>';
        if (t.status == 'done') {
            h += ph.aiExplainBody(c, t);
            var ref = t.steps.some(function (s) { return s && s.tool == 'lookup_event_id' && s.items > 0; });
            h += '<div class=evlAiExFt><span class=evlAiMuted>' + (ref ? 'Based on the built-in reference for ' + esc(c.evLabel || 'this event') + ' and this device’s events.' : 'Based on this device’s events.') +
                 ' Answers can be wrong.</span></div>';
        } else {
            h += ph.aiStepsHtml(c, t);
            if (t.status == 'running') h += '<div class="evlAiA evlAiMd" data-t=' + key + ' data-p=a>' + (t.live || ph.aiWaitHtml(c, t)) + '</div>' + ph.aiLiveHtml(c, t);
            else if (t.live) h += '<div class="evlAiA evlAiMd">' + t.live + '</div>';
            if (t.status == 'error') h += ph.aiErrHtml(c, t);
            if (t.status == 'stopped') h += '<p class=evlAiMuted>Stopped.</p>';
            if (t.status == 'cancelled') h += '<p class=evlAiMuted>Cancelled. Nothing was sent to the model.</p>';
        }
        return h + '</section>';
    };
    // Follow-up questions run in Ask (an Explain session takes none): open the panel with a question to edit.
    obj.aiExplainContinue = function (cid) {
        var ph = pluginHandler.eventlog, c = ph.elState().ai.convs[cid];
        if (!c) return false;
        var ev = null;
        for (var k in ph.byKey) { var e = ph.byKey[k]; if (e._raw && e._raw._id != null && c.input && String(e._raw._id) == c.input.eventId) { ev = e; break; } }
        var when = ev ? ' at ' + ph.elFmtTime(ev.time) : '';
        return ph.aiPrefill('About the ' + (c.evLabel || 'event') + ' event' + when + ': ');
    };

    // ---- Diagnosis: a chat whose first answer is the diagnosis -------------------------------------------------------
    obj.aiWinText = function (w) {
        return ({ '24h': 'the last 24 hours', '7d': 'the last 7 days', restart: 'around the last restart' })[w] || 'the last 24 hours';
    };
    obj.aiSetWin = function (v) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (['24h', '7d', 'restart'].indexOf(v) < 0) return false;
        a.diagWin = v; putstore('evl_diag_win', v);
        return true;
    };
    // Toolbar "Diagnose" and the entry in the empty panel: the panel in full width with the window choice; nothing
    // runs before the Diagnose button (each run uses the model).
    obj.aiDiagOpen = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (!ph.elCan('assistant')) return false;
        a.open = true; a.full = true; a.diagSetup = true; a.hist = false; a.act = null;
        ph.aiRenderPanel();
        ph.elFitHeight();
        setTimeout(function () { try { var r = document.querySelector('#evlAiLog .evlDgWin input:checked') || document.querySelector('#evlAiLog .evlDgWin input'); if (r) r.focus(); } catch (e) { } }, 0);
        return false;
    };
    obj.aiDiagCancel = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        a.diagSetup = false;
        ph.aiRenderPanel();
        var f = Q('evlAiIn'); if (f) f.focus();
        return false;
    };
    obj.aiDiagSetupHtml = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, acc = ph.elAccess || {}, esc = ph.aiEsc, cur = a.convs[a.chat];
        var opts = [['24h', 'Last 24 hours', 'Everything stored since yesterday at this time.'], ['7d', 'Last 7 days', 'For problems that come and go.'],
                    ['restart', 'Around the last restart', 'From 6 hours before the most recent restart to 1 hour after it.']];
        var h = '<section class=evlDgSetup aria-labelledby=evlDgSetupT><h3 id=evlDgSetupT>Diagnose this device</h3>' +
                '<p>The assistant reads the events stored for this device in the window you choose, sorts out what happened and suggests likely causes, with the events it relied on. The result opens as a chat: ask follow-up questions about it.</p>' +
                '<fieldset class=evlDgWin><legend>Time window</legend><div class=evlDgOpts>';
        opts.forEach(function (o) {
            h += '<label class=evlDgOpt><input type=radio name=evlDgWin value=' + o[0] + (a.diagWin == o[0] ? ' checked' : '') + ' onchange="return pluginHandler.eventlog.aiSetWin(this.value)">' +
                 '<span><b>' + o[1] + '</b><small>' + o[2] + '</small></span></label>';
        });
        h += '</div></fieldset>';
        if (acc.assistantReason == 'noEndpoint') h += '<p>' + esc(ph.aiErrText('noEndpoint')) + '</p>';
        var busy = ph.aiBusy(cur);
        h += '<div class=evlAiActs><button id=evlDgRun class="evlBtn on evlDgRun" onclick="return pluginHandler.eventlog.aiDiagnose()"' + (busy ? ' disabled title="Wait until the answer is finished or stop it"' : '') + '>' + ph.aiIcon('diag') + 'Diagnose</button>' +
             '<button class=evlBtn onclick="return pluginHandler.eventlog.aiDiagCancel()">Cancel</button></div>';
        if (cur && ph.aiIsChat(cur) && !cur.chatId) h += '<p class=evlAiMuted>The current chat is not saved and closes when the diagnosis starts.</p>';
        return h + '</section>';
    };
    // Start a diagnosis chat for window w (default: the one chosen).
    obj.aiDiagnose = function (w) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (!ph.elCan('assistant')) return false;
        if (['24h', '7d', 'restart'].indexOf(w) < 0) w = a.diagWin;
        var cur = a.convs[a.chat];
        if (cur && ph.aiBusy(cur)) { ph.aiSay('Wait until the answer is finished, or stop it first.'); return false; }
        if (ph.aiIsChat(cur)) { ph.aiCloseConv(cur); delete a.convs[cur.id]; }
        var c = ph.aiNewConv('diagnose', { window: w }, 'Diagnose ' + ph.aiWinText(w));
        c.win = w;
        a.chat = c.id; a.diagSetup = false; a.hist = false; a.act = null; a.open = true; a.focus = c.id; a.sel = null; a.peek = null; a.citeVer++;
        ph.aiStartConv(c);
        ph.aiRenderPanel();
        ph.elUpdate();
        ph.aiSay('Diagnosis started.');
        return false;
    };
    obj.aiStatusWord = function (s) {
        return ({ likely: 'Likely', possible: 'Possible', ruled_out: 'Ruled out' })[s] || 'Possible';
    };
    // asText: plain refs ("E1, E4") for the visually hidden timeline table, which must not hold focusable controls
    obj.aiChips = function (c, refs, asText) {
        var ph = pluginHandler.eventlog, out = [];
        (Array.isArray(refs) ? refs : []).forEach(function (r) { if (typeof r == 'string' && /^E\d{1,6}$/.test(r) && ph.aiCite(c, r) && out.indexOf(r) < 0) out.push(r); });
        if (asText) return out.join(', ');
        return out.map(function (r) { return ph.aiChipHtml(c.id, r); }).join(' ');
    };
    // The diagnosis as the first answer of its chat: summary, timeline, possible causes, next steps, evidence, what is
    // not explained, the steps. Laid out for the chat's width (one column when docked, two in full width).
    obj.aiDiagCard = function (c, t) {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai, s = t.structured, esc = ph.aiEsc;
        if (t.sHtml) return t.sHtml;
        var md = function (x) { return ph.aiMd(x, c); };
        var title = (c.win == 'restart') ? 'What happened around the last restart' : 'What happened in ' + ph.aiWinText(c.win);
        var when = t.at || c.doneAt, line = ph.aiInfoLine(c, true).replace(/ \([^)]*\)$/, '');
        var h = '<article class=evlDgCard aria-label="Diagnosis"><header class=evlDgHd><h3>' + esc(title) + '</h3>' +
                '<p class=evlDgMeta>' + (when ? 'Generated ' + esc(ph.aiWhen(when)) : 'Generated now') + (line ? ' by ' + esc(line) : '') + '</p>';
        if (!s) {
            h += '<div class="evlAiMd evlDgSum">' + (t.text.trim() ? t.html : '<p>The model returned an empty answer.</p>') + '</div></header>';
            h += '<footer class=evlDgFoot>' + ph.aiStepsHtml(c, t) + '</footer></article>';
            t.sHtml = h;
            return h;
        }
        if (s.summary) h += '<div class="evlAiMd evlDgSum">' + md(s.summary) + '</div>';
        h += '</header><div class=evlDgBody>';
        if (Array.isArray(s.lanes) && s.lanes.some(function (l) { return l && Array.isArray(l.markers) && l.markers.length; })) h += ph.aiTimelineHtml(c, s);
        h += '<div class=evlDgCols><section class=evlDgMain aria-label="Possible causes and next steps">';
        var hyps = Array.isArray(s.hypotheses) ? s.hypotheses : [];
        if (hyps.length) {
            h += '<h4>Possible causes</h4>';
            hyps.forEach(function (hy) {
                var hid = (typeof hy.id == 'string' && /^[\w-]{1,20}$/.test(hy.id)) ? hy.id : null;
                var fb = hid ? a.hyp[c.id + ':' + hid] : null, status = (['likely', 'possible', 'ruled_out'].indexOf(hy.status) >= 0) ? hy.status : 'possible';
                var word = ph.aiStatusWord(status), cls = status;
                if (fb == 'wrong') { word = 'Marked wrong'; cls = 'wrong'; }
                else if (fb == 'reopen' && status == 'ruled_out') { word = 'Reopened'; cls = 'possible'; }
                var conf = (typeof hy.confidence == 'number') ? 'about ' + Math.round(hy.confidence * 20) * 5 + '%' : '';
                h += '<div class=evlHyp><div class=evlHypSt><div class="st ' + cls + '">' + word + '</div>' + (conf && cls != 'wrong' ? '<div class=conf>' + conf + '</div>' : '') + '</div><div class=evlHypBody>';
                h += '<p class=evlHypT>' + ph.aiPlain(hy.title) + '</p>';
                if (hy.why) h += '<div class=evlAiMd>' + md(hy.why) + '</div>';
                var ev1 = ph.aiChips(c, hy.evidence), ev2 = ph.aiChips(c, hy.against);
                if (ev1) h += '<div class=evlHypEv><span>Evidence</span> ' + ev1 + '</div>';
                if (ev2) h += '<div class=evlHypEv><span>Speaks against it</span> ' + ev2 + '</div>';
                if (hy.confirm) h += '<div class="evlAiMd evlAiMuted"><p>Would confirm it: ' + ph.aiPlain(hy.confirm) + '</p></div>';
                if (hid) {
                    h += '<div class=evlAiActs>';
                    if (cls != 'wrong' && status != 'ruled_out') h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiAskAbout(\'' + c.id + '\',\'' + hid + '\')">Ask about this</button>';
                    if (!c.convId) { }   // a saved diagnosis: no conversation to give feedback to
                    else if (cls == 'wrong' || (status == 'ruled_out' && fb != 'reopen')) h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiVote(\'' + c.id + '\',1,\'hyp\',\'reopen\',\'' + hid + '\')">Reopen</button>';
                    else h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiVote(\'' + c.id + '\',1,\'hyp\',\'wrong\',\'' + hid + '\')">This is wrong</button>';
                    h += '</div>';
                }
                h += '</div></div>';
            });
        }
        var steps = Array.isArray(s.nextSteps) ? s.nextSteps : [], anyCmd = false;
        if (steps.length) {
            h += '<h4>Next steps</h4><ol class=evlNext>';
            steps.forEach(function (n, i) {
                h += '<li>' + (n.text ? '<div class=evlAiMd>' + md(n.text) + '</div>' : '');
                if (n.command && n.command.text) {
                    anyCmd = true;
                    var sh = ({ powershell: 'PowerShell', cmd: 'Command Prompt', bash: 'Shell' })[n.command.shell] || 'Command';
                    h += '<div class=evlAiCodeW><div class=evlAiCodeBar><span>' + sh + '</span><button class="evlBtn mini" aria-label="Copy the command of step ' + (i + 1) + '" onclick="return pluginHandler.eventlog.aiCopyCmd(\'' + c.id + '\',' + i + ',this)">Copy</button></div>' +
                         '<pre><code>' + esc(ph.aiStripMarks(n.command.text)) + '</code></pre></div>';
                }
                h += '</li>';
            });
            h += '</ol>';
            if (anyCmd) h += '<p class=evlAiCmdNote>Commands are suggestions. Run them yourself in Terminal; the assistant can only read.</p>';
        }
        if (t.text && t.text.trim()) h += '<details class=evlAiMore><summary>More from the assistant</summary><div class=evlAiMd>' + t.html + '</div></details>';
        h += '</section><aside class=evlDgSide aria-label="Evidence">';
        var evid = (Array.isArray(s.evidence) ? s.evidence : []).filter(function (e) { return e && ph.aiCite(c, e.cite); });
        if (!evid.length) { var all = ph.aiCitesOf(c); evid = Object.keys(all).sort(function (x, y) { return Number(x.slice(1)) - Number(y.slice(1)); }).map(function (r) { return { cite: r, note: '' }; }); }
        if (evid.length) {
            h += '<h4>Evidence</h4>';
            evid.forEach(function (e) {
                var ev = ph.aiCite(c, e.cite).ev;
                h += '<div class=evlEv>' + ph.aiChipHtml(c.id, e.cite) + '<div><div><span class=evlMono>' + esc(ph.elFmtTime(ev.time)) + '</span> ' + esc(ev.source) + ' ' + esc(ev.id) + '</div>' +
                     '<div class=m>' + (e.note ? ph.aiPlain(e.note) : esc(String(ev.message || '').slice(0, 180))) + '</div></div></div>';
            });
            var nIds = 0, seen = {};
            c.turns.forEach(function (tt) { for (var r in tt.cites) { var id = tt.cites[r].id; if (id != null && !seen[id]) { seen[id] = 1; nIds++; } } });
            if (nIds && ph.elCan('history')) h += '<p><button class=evlLinkBtn onclick="return pluginHandler.eventlog.aiOpenCited(\'' + c.id + '\')">Open ' + (nIds == 1 ? 'this event' : 'these ' + nIds + ' events') + ' in History</button></p>';
        }
        var unx = Array.isArray(s.unexplained) ? s.unexplained : [];
        if (unx.length) {
            h += '<h4>Not explained</h4><ul class=evlUnx>';
            unx.forEach(function (u) { var ch = ph.aiChips(c, u.cites); h += '<li><div class=evlAiMd>' + md(u.text || '') + '</div>' + (ch ? '<div class=evlHypEv>' + ch + '</div>' : '') + '</li>'; });
            h += '</ul>';
        }
        h += '</aside></div></div><footer class=evlDgFoot>' + ph.aiStepsHtml(c, t) + '</footer></article>';
        t.sHtml = h;
        return h;
    };
    obj.aiTlRange = function (s) {
        var from = (s.window && typeof s.window.from == 'number') ? s.window.from : null, to = (s.window && typeof s.window.to == 'number') ? s.window.to : null, ts = [];
        s.lanes.forEach(function (l) { (l.markers || []).forEach(function (m) { if (typeof m.t == 'number') ts.push(m.t); if (typeof m.t2 == 'number') ts.push(m.t2); }); });
        if (from == null) from = ts.length ? Math.min.apply(null, ts) : Date.now() - 86400000;
        if (to == null) to = ts.length ? Math.max.apply(null, ts) : Date.now();
        if (!(to > from)) { from -= 1800000; to += 1800000; }
        return { from: from, to: to };
    };
    // Markers of one lane as drawn: points closer than 0.8 % of the window merge into one.
    obj.aiLaneClusters = function (lane, from, to) {
        var span = to - from, out = [], rank = { crit: 4, err: 3, warn: 2, info: 1 };
        (lane.markers || []).filter(function (m) { return m && typeof m.t == 'number'; }).slice().sort(function (x, y) { return x.t - y.t; }).forEach(function (m) {
            var p = Math.max(0, Math.min(100, (m.t - from) / span * 100)), p2 = (typeof m.t2 == 'number' && m.t2 > m.t) ? Math.max(0, Math.min(100, (m.t2 - from) / span * 100)) : null;
            var last = out[out.length - 1], cites = Array.isArray(m.cites) ? m.cites : [];
            if (last && !last.range && p2 == null && p - last.pl < 0.8) {
                last.n++; last.items.push(m); last.pl = p;
                if ((rank[m.level] || 1) > (rank[last.level] || 1)) last.level = m.level;
                cites.forEach(function (r) { if (last.cites.indexOf(r) < 0) last.cites.push(r); });
                return;
            }
            out.push({ p: p, pl: p, p2: p2, range: p2 != null, level: rank[m.level] ? m.level : 'info', items: [m], cites: cites.slice(), n: 1 });
        });
        return out;
    };
    obj.aiTimelineHtml = function (c, s) {
        var ph = pluginHandler.eventlog, esc = ph.aiEsc, rg = ph.aiTlRange(s), span = rg.to - rg.from;
        var fmt = function (t) {
            var d = new Date(t);
            if (span <= 36 * 3600000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        };
        var h = '<div class=evlTl aria-hidden=true><div class=evlTlIn><div class="evlLane evlAxis"><span></span><div class=evlTrk>';
        [0, 25, 50, 75, 100].forEach(function (p) {
            var t = rg.from + span * p / 100, lab = (p == 100 && Math.abs(Date.now() - rg.to) < 600000) ? 'now' : fmt(t);
            h += '<span class="evlTick' + (p == 0 ? ' first' : (p == 100 ? ' last' : '')) + '" style="left:' + p + '%">' + esc(lab) + '</span>';
        });
        h += '</div></div>';
        var sr = '<table class=evlSr><caption>Timeline</caption><thead><tr><th>Lane</th><th>Time</th><th>What</th><th>Events</th></tr></thead><tbody>';
        s.lanes.forEach(function (lane, li) {
            if (!lane || !Array.isArray(lane.markers) || !lane.markers.length) return;
            h += '<div class=evlLane><span class=lbl>' + ph.aiPlain(lane.label) + '</span><div class=evlTrk>';
            ph.aiLaneClusters(lane, rg.from, rg.to).forEach(function (k) {
                var style = 'left:' + k.p.toFixed(2) + '%' + (k.range ? ';width:' + Math.max(0.6, k.p2 - k.p).toFixed(2) + '%' : '');
                var cite = null; k.cites.forEach(function (r) { if (!cite && typeof r == 'string' && /^E\d{1,6}$/.test(r) && ph.aiCite(c, r)) cite = r; });
                var m0 = k.items[0];
                h += '<span class="evlMk ' + k.level + (k.range ? ' rg' : ' pt') + (k.n > 1 ? ' many' : '') + (cite ? ' go' : '') + '" style="' + style + '"' +
                     (cite ? ' onclick="return pluginHandler.eventlog.aiGotoCite(\'' + c.id + '\',\'' + cite + '\')"' : '') + '><span class=tip>' +
                     esc(ph.aiTimeShort(m0.t)) + ' ' + ph.aiPlain(m0.label) + (k.n > 1 ? ' and ' + (k.n - 1) + ' more' : '') + '</span></span>';
            });
            h += '</div></div>';
            lane.markers.forEach(function (m) {
                if (!m || typeof m.t != 'number') return;
                sr += '<tr><td>' + ph.aiPlain(lane.label) + '</td><td>' + esc(ph.elFmtTime(m.t)) + (typeof m.t2 == 'number' && m.t2 > m.t ? ' to ' + esc(ph.elFmtTime(m.t2)) : '') + '</td><td>' + ph.aiPlain(m.label) + '</td><td>' + ph.aiChips(c, m.cites, true) + '</td></tr>';
            });
        });
        return h + '</div></div>' + sr + '</tbody></table>';
    };
    obj.aiAskAbout = function (cid, hid) {
        var ph = pluginHandler.eventlog, c = ph.elState().ai.convs[cid], hy = null;
        if (!c || !c.turns[0].structured) return false;
        (c.turns[0].structured.hypotheses || []).forEach(function (x) { if (x.id === hid) hy = x; });
        if (!hy) return false;
        return ph.aiPrefill('The diagnosis says: "' + ph.aiStripMarks(hy.title) + '". How sure is that, and how can I confirm it?');
    };
    obj.aiCopyCmd = function (cid, idx, btn) {
        var ph = pluginHandler.eventlog, c = ph.elState().ai.convs[cid];
        var s = c && c.turns[0].structured, n = s && Array.isArray(s.nextSteps) ? s.nextSteps[idx] : null;
        if (!n || !n.command) return false;
        return ph.aiCopyText(ph.aiStripMarks(n.command.text), btn);
    };

    // ---- data preview dialog (cloud endpoints) --------------------------------------------------------------------
    obj.aiDlgOpen = function (cid) {
        var ph = pluginHandler.eventlog, st = ph.st;
        if (st == null || st.ai == null) return false;
        var c = st.ai.convs[cid];
        if (!c || !c.preview || c.status != 'preview') return false;
        var d = ph._aiDlg;
        if (!d || d.cid != cid) {
            var cats = {};
            c.preview.categories.forEach(function (k) { cats[k.id] = k.on; });
            var ret = document.activeElement;
            if (d) ret = d.ret;
            ph._aiDlg = d = { cid: cid, tab: 'readable', cats: cats, remember: false, ret: ret };
        }
        ph.aiInjectStyles();
        var el = document.getElementById('evlAiDlg');
        if (!el) { el = document.createElement('div'); el.id = 'evlAiDlg'; document.body.appendChild(el); }
        el.innerHTML = ph.aiDlgHtml(c, d);
        setTimeout(function () { try { var f = document.querySelector('#evlAiDlg input[type=checkbox]') || document.querySelector('#evlAiDlg .evlBtn'); if (f) f.focus(); } catch (e) { } }, 0);
        return false;
    };
    obj.aiDlgHtml = function (c, d) {
        var ph = pluginHandler.eventlog, esc = ph.aiEsc, info = c.info || {}, p = c.preview;
        var name = info.endpointName || 'the endpoint', outside = (info.network == 'public');
        var h = '<div class=evlDlgBack></div><div class=evlDlgBox role=dialog aria-modal=true aria-labelledby=evlAiDlgT aria-describedby=evlAiDlgD tabindex=-1 onkeydown="return pluginHandler.eventlog.aiDlgKey(event)">';
        h += '<div class=evlDlgHd><h2 id=evlAiDlgT>Review what is sent to ' + esc(info.model || 'the model') + '</h2><p id=evlAiDlgD>' +
             (outside ? 'This endpoint (' + esc(name) + ') is outside your network.' : 'This endpoint (' + esc(name) + ') is in your network.') +
             (info.redacted ? ' Values marked <mark class=evlPs>like this</mark> are replaced before sending. You still see the real values in the answer.' : ' Values are sent as they are.') + '</p></div>';
        h += '<div class=evlDlgBody><section class=evlDlgInc aria-labelledby=evlAiDlgI><h3 id=evlAiDlgI>Include</h3>';
        if (!p.categories.length) h += '<p class=evlAiMuted>Nothing to choose for this request.</p>';
        p.categories.forEach(function (k, i) {
            // the server can only leave out what it planned to send: a category that is off stays off
            h += '<label class="evlInc' + (k.on ? '' : ' dis') + '"><input type=checkbox' + (d.cats[k.id] ? ' checked' : '') + (k.on ? '' : ' disabled') + ' onchange="pluginHandler.eventlog.aiDlgCat(' + i + ',this.checked)"><span>' + esc(k.label) +
                 (k.on ? (k.count != null ? '<small>' + k.count + (k.count == 1 ? ' item' : ' items') + '</small>' : '') : '<small>Not included for this question</small>') + '</span></label>';
        });
        h += '<h3>Never sent</h3><p class=evlAiMuted>Stored RDP and SSH credentials, BitLocker recovery keys, Intel AMT passwords, invitation codes and location data.</p></section>';
        h += '<section class=evlDlgPrev aria-labelledby=evlAiDlgP><div class=evlDlgPrevHd><h3 id=evlAiDlgP>Preview</h3><div class=evlSeg role=group aria-label="Preview format">' +
             '<button id=evlAiDlgTR class="' + (d.tab == 'readable' ? 'on' : '') + '" aria-pressed=' + (d.tab == 'readable') + ' onclick="return pluginHandler.eventlog.aiDlgTab(\'readable\')">Readable</button>' +
             '<button id=evlAiDlgTW class="' + (d.tab == 'raw' ? 'on' : '') + '" aria-pressed=' + (d.tab == 'raw') + ' onclick="return pluginHandler.eventlog.aiDlgTab(\'raw\')">Raw request</button></div></div>' +
             '<div id=evlAiDlgPv class=evlDlgPv tabindex=0 role=region aria-label="Preview of the request">' + ph.aiDlgPvHtml(c, d) + '</div>';
        var cnt = ph.aiCounts(p.redactionCounts);
        if (cnt.total > 0) h += '<div class=evlDlgRed>' + cnt.total + (cnt.total == 1 ? ' value' : ' values') + ' replaced: ' + esc(cnt.list) + '.</div>';
        else if (info.redacted) h += '<div class=evlDlgRed>Nothing needed replacing so far. Events the model reads later are replaced the same way.</div>';
        h += '</section></div>';
        // the server only honours "remember" when the admin chose to ask once per endpoint
        var once = ((ph.elAccess && ph.elAccess.endpoint) || {}).previewPolicy == 'once';
        h += '<div class=evlDlgFt>' + (once ? '<label class=evlDlgRem><input type=checkbox' + (d.remember ? ' checked' : '') + ' onchange="pluginHandler.eventlog.aiDlgRem(this.checked)"> Do not ask again for this endpoint</label>' : '<span class=evlDlgRem></span>') +
             '<button class=evlBtn onclick="return pluginHandler.eventlog.aiDlgCancel()">Cancel</button><button class="evlBtn on" onclick="return pluginHandler.eventlog.aiDlgSend()">Send and ask</button></div></div>';
        return h;
    };
    obj.aiDlgPvHtml = function (c, d) {
        var ph = pluginHandler.eventlog, esc = ph.aiEsc, p = c.preview;
        if (d.tab == 'raw') return '<pre class=evlMono>' + ph.aiTint(p.raw) + '</pre>';
        return p.readable.map(function (x) { return '<div class=evlPvSec><h4>' + esc(x.label) + '</h4><pre class=evlMono>' + ph.aiTint(x.text) + '</pre></div>'; }).join('');
    };
    obj.aiDlgTab = function (t) {
        var ph = pluginHandler.eventlog, d = ph._aiDlg, st = ph.st;
        if (!d || !st || !st.ai.convs[d.cid] || (t != 'readable' && t != 'raw')) return false;
        d.tab = t;
        var pv = document.getElementById('evlAiDlgPv'); if (pv) { pv.innerHTML = ph.aiDlgPvHtml(st.ai.convs[d.cid], d); pv.scrollTop = 0; }
        [['evlAiDlgTR', 'readable'], ['evlAiDlgTW', 'raw']].forEach(function (x) { var b = document.getElementById(x[0]); if (b) { b.classList.toggle('on', t == x[1]); b.setAttribute('aria-pressed', t == x[1] ? 'true' : 'false'); } });
        return false;
    };
    obj.aiDlgCat = function (i, on) {
        var ph = pluginHandler.eventlog, d = ph._aiDlg, st = ph.st, c = (d && st) ? st.ai.convs[d.cid] : null;
        if (!c || !c.preview.categories[i] || !c.preview.categories[i].on) return;
        d.cats[c.preview.categories[i].id] = !!on;
    };
    obj.aiDlgRem = function (on) {
        var d = pluginHandler.eventlog._aiDlg;
        if (d) d.remember = !!on;
    };
    obj.aiDlgKey = function (ev) {
        var ph = pluginHandler.eventlog;
        if (ev.key == 'Escape') { ev.preventDefault(); ph.aiDlgCancel(); return false; }
        if (ev.key != 'Tab') return true;
        var box = document.querySelector('#evlAiDlg .evlDlgBox'); if (!box) return true;
        var f = Array.prototype.filter.call(box.querySelectorAll('button, input, [tabindex="0"]'), function (x) { return !x.disabled && x.offsetParent !== null; });
        if (!f.length) return true;
        var i = f.indexOf(document.activeElement);
        if (ev.shiftKey && (i <= 0)) { f[f.length - 1].focus(); ev.preventDefault(); return false; }
        if (!ev.shiftKey && (i == f.length - 1 || i < 0)) { f[0].focus(); ev.preventDefault(); return false; }
        return true;
    };
    obj.aiDlgCancel = function () {
        var ph = pluginHandler.eventlog, d = ph._aiDlg, st = ph.st, c = (d && st && st.ai) ? st.ai.convs[d.cid] : null;
        if (c && c.status == 'preview') {
            ph.aiCloseConv(c);
            c.turns[c.turns.length - 1].status = 'cancelled';
            c.status = 'cancelled';
        }
        ph.aiDlgClose();
        if (c) { ph.aiRefresh(c); ph.aiSay('Cancelled. Nothing was sent to the model.'); }
        return false;
    };
    obj.aiDlgSend = function () {
        var ph = pluginHandler.eventlog, d = ph._aiDlg, st = ph.st, c = (d && st && st.ai) ? st.ai.convs[d.cid] : null;
        if (!c || c.status != 'preview' || !c.convId) { ph.aiDlgClose(); return false; }
        var ids = c.preview.categories.filter(function (k) { return d.cats[k.id]; }).map(function (k) { return k.id; });
        ph.aiSendMsg('aiConfirm', { convId: c.convId, categories: ids, remember: d.remember === true });
        c.status = 'running'; c.last = Date.now();
        ph.aiDogStart();
        ph.aiDlgClose();
        ph.aiRefresh(c);
        return false;
    };
    // quiet: no focus restore (device change); onlyCid: close only if the dialog belongs to that conversation
    obj.aiDlgClose = function (quiet, onlyCid) {
        var ph = pluginHandler.eventlog, d = ph._aiDlg;
        if (onlyCid != null && (!d || d.cid != onlyCid)) return;
        var el = document.getElementById('evlAiDlg');
        if (el && el.parentNode) el.parentNode.removeChild(el);
        ph._aiDlg = null;
        if (quiet === true || !d) return;
        try {
            if (d.ret && d.ret.focus && document.body.contains(d.ret)) d.ret.focus();
            else { var f = Q('evlAiIn') || Q('evlAiBtn'); if (f) f.focus(); }
        } catch (e) { }
    };

    // ---- styles ---------------------------------------------------------------------------------------------------
    obj.aiInjectStyles = function () {
        if (document.getElementById('evlAiStyles')) return;
        var css = `
#pluginEventLog [hidden], #evlAiDlg [hidden] { display:none !important; }
#pluginEventLog .evlSr, #evlAiDlg .evlSr { position:absolute !important; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
#pluginEventLog .evlMain { display:flex; align-items:flex-start; position:relative; }
#pluginEventLog .evlCol { flex:1 1 0; min-width:0; align-self:flex-start; }
#pluginEventLog .evlAiBtn { margin-left:auto; display:inline-flex; align-items:center; gap:6px; }
#pluginEventLog .evlAiWhy { margin-left:auto; color:var(--evl-muted); font-size:12px; }
#pluginEventLog .evlAi { flex:0 0 var(--evl-ai-w, 400px); max-width:60%; align-self:flex-start; position:relative; height:min(82vh, 780px); min-height:360px; box-sizing:border-box; margin-left:10px; border:1px solid var(--evl-line); border-radius:3px; background:var(--evl-panel); }
#pluginEventLog .evlAiIn { position:absolute; top:0; right:0; bottom:0; left:0; display:flex; flex-direction:column; min-height:0; }
#pluginEventLog .evlMain.evlStack { flex-direction:column; align-items:stretch; }
#pluginEventLog .evlMain.evlStack .evlCol { align-self:stretch; }
#pluginEventLog .evlMain.evlStack .evlAi { flex:none; align-self:stretch; max-width:none; margin:10px 0 0; }
/* full width: the panel takes the table's place (the toolbar stays); the conversation keeps a readable measure */
#pluginEventLog .evlMain.evlAiFull:not(.evlStack) .evlCol, #pluginEventLog .evlMain.evlAiOnly .evlCol { display:none; }
#pluginEventLog .evlMain.evlAiFull:not(.evlStack) .evlAi, #pluginEventLog .evlMain.evlAiOnly .evlAi { flex:1 1 auto; max-width:none; margin-left:0; }
#pluginEventLog .evlMain.evlAiOnly.evlStack .evlAi { margin-top:0; }
#pluginEventLog .evlAiFull .evlAiSplit, #pluginEventLog .evlAiOnly .evlAiSplit, #pluginEventLog .evlStack .evlAiFullBtn { display:none; }
#pluginEventLog .evlAiFull .evlAiLog, #pluginEventLog .evlAiFull .evlAiFt { padding-left:max(13px, calc((100% - 1040px) / 2)); padding-right:max(13px, calc((100% - 1040px) / 2)); }
#pluginEventLog .evlAiIco { display:inline-flex; align-items:center; justify-content:center; padding:3px 5px; min-width:26px; }
#pluginEventLog .evlAiIco svg { margin:0; }
#pluginEventLog .evlAiFullBtn[aria-pressed=true] { color:var(--evl-acc); }
#pluginEventLog .evlAiHGrip { flex:none; position:relative; height:9px; cursor:row-resize; touch-action:none; user-select:none; background:var(--evl-bg); border-top:1px solid var(--evl-line2); border-radius:0 0 3px 3px; outline:none; }
#pluginEventLog .evlAiHGrip::after { content:""; position:absolute; left:50%; top:3px; width:34px; height:1px; margin-left:-17px; background:var(--evl-line); box-shadow:0 2px 0 var(--evl-line); }
#pluginEventLog .evlAiHGrip:hover, #pluginEventLog .evlAiHGrip.active, #pluginEventLog .evlAiHGrip:focus-visible { background:var(--evl-sel); }
#pluginEventLog .evlAiHGrip:hover::after, #pluginEventLog .evlAiHGrip.active::after, #pluginEventLog .evlAiHGrip:focus-visible::after { background:var(--evl-acc); box-shadow:0 2px 0 var(--evl-acc); }
#pluginEventLog .evlAiHGrip:focus-visible { box-shadow:inset 0 0 0 2px var(--evl-acc); }
#pluginEventLog .evlAiSplit { position:absolute; left:-7px; top:0; bottom:0; width:11px; cursor:col-resize; z-index:2; touch-action:none; outline:none; }
#pluginEventLog .evlAiSplit:hover, #pluginEventLog .evlAiSplit.active, #pluginEventLog .evlAiSplit:focus-visible { background:linear-gradient(to right, transparent 5px, var(--evl-acc) 5px, var(--evl-acc) 7px, transparent 7px); }
#pluginEventLog .evlStack .evlAiSplit { display:none; }
#pluginEventLog .evlAiHd { flex:none; display:flex; flex-wrap:wrap; align-items:flex-start; gap:6px; padding:9px 10px 9px 13px; border-bottom:1px solid var(--evl-line2); }
#pluginEventLog .evlAiTitle { flex:1 1 0; min-width:0; }
/* a narrow panel puts the buttons on a line of their own instead of squeezing the title (Chats: icon and count) */
#pluginEventLog .evlAi { container:evlai / inline-size; }
@container evlai (max-width: 440px) { #pluginEventLog .evlAiTitle { flex-basis:100%; } }
@container evlai (max-width: 330px) { #pluginEventLog .evlAiHistBtn .evlAiHistL { display:none; } }
#pluginEventLog .evlAiHd h2 { margin:0; font-size:15px; font-weight:bold; color:var(--evl-ink); line-height:1.3; }
#pluginEventLog .evlAiSub { font-size:12px; color:var(--evl-muted); overflow-wrap:anywhere; }
#pluginEventLog .evlAiNoteLine { font-size:12px; color:var(--evl-warn); margin:4px 0 0; line-height:1.4; }
#pluginEventLog .evlAiHd .evlBtn { white-space:nowrap; flex:none; }
#pluginEventLog .evlAiX { display:inline-flex; align-items:center; padding:3px 6px; }
#pluginEventLog .evlAiLog { position:relative; flex:1 1 auto; overflow-y:auto; padding:12px 13px; display:flex; flex-direction:column; gap:14px; min-height:0; overscroll-behavior:contain; }
#pluginEventLog .evlAiTurn { display:flex; flex-direction:column; gap:9px; }
#pluginEventLog .evlAiQW { align-self:flex-end; max-width:88%; display:flex; flex-direction:column; align-items:flex-end; gap:2px; min-width:0; }
#pluginEventLog .evlAiQ { background:var(--evl-bubble); border:1px solid var(--evl-bubble-line); border-radius:6px; padding:7px 10px; line-height:1.45; overflow-wrap:anywhere; max-width:100%; box-sizing:border-box; }
#pluginEventLog .evlAiQ.dg { display:inline-flex; align-items:center; gap:6px; font-weight:bold; }
#pluginEventLog .evlAiQ.dg svg { color:var(--evl-acc); flex:none; }
/* message actions: on hover or focus; always on touch screens, stacked and narrow */
#pluginEventLog .evlAiMsgActs { display:flex; gap:2px; opacity:0; transition:opacity .12s ease-out; }
#pluginEventLog .evlAiMsgActs .evlBtn.evlAiIco { border-color:transparent; background:transparent; color:var(--evl-muted); min-height:24px; }
#pluginEventLog .evlAiMsgActs .evlBtn.evlAiIco:hover:not([disabled]) { border-color:var(--evl-line); color:var(--evl-ink); background:var(--evl-hover); }
#pluginEventLog .evlAiMsgActs .evlBtn.evlAiIco[data-act=del]:hover:not([disabled]) { color:var(--evl-err); border-color:var(--evl-err); }
#pluginEventLog .evlAiMsgActs .evlBtn.ok { color:var(--evl-ok); opacity:1; }
#pluginEventLog .evlAiTurn:hover .evlAiMsgActs, #pluginEventLog .evlAiMsgActs:focus-within, #pluginEventLog .evlAiTurn.last .evlAiMsgActs.a, #pluginEventLog .evlAiTurn.act .evlAiMsgActs { opacity:1; }
#pluginEventLog .evlStack .evlAiMsgActs { opacity:1; }
@media (hover: none), (max-width: 700px) { #pluginEventLog .evlAiMsgActs { opacity:1; } }
#pluginEventLog .evlAiMsgActs.a { margin-top:-4px; }
#pluginEventLog .evlAiQW.edit { align-self:stretch; max-width:none; align-items:stretch; gap:6px; }
#pluginEventLog .evlAiEdIn { font:inherit; border:1px solid var(--evl-acc); background:var(--evl-input); color:var(--evl-ink); border-radius:6px; padding:7px 10px; line-height:1.45; resize:vertical; min-height:60px; max-height:260px; box-sizing:border-box; width:100%; }
#pluginEventLog .evlAiEdIn:focus-visible { outline:2px solid var(--evl-acc); outline-offset:1px; }
#pluginEventLog .evlAiEdNote { margin:0; font-size:12px; color:var(--evl-muted); }
#pluginEventLog .evlAiQW.edit .evlAiActs { justify-content:flex-end; }
#pluginEventLog .evlAiConfirm { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; padding:7px 10px; background:var(--evl-alt); border-left:3px solid var(--evl-err); border-radius:0 3px 3px 0; font-size:12px; }
#pluginEventLog .evlAiConfirm span { flex:1 1 220px; line-height:1.4; }
/* Stop with progress: a turning arc around the stop mark and the elapsed time */
#pluginEventLog .evlBtn.evlAiStop { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; font-variant-numeric:tabular-nums; }
#pluginEventLog .evlAiRow .evlBtn.evlAiStop { min-width:0; padding-left:9px; padding-right:10px; }
#pluginEventLog .evlAiRing { flex:none; margin:0 !important; vertical-align:middle; }
#pluginEventLog .evlAiRing circle { fill:none; stroke-width:1.8; }
#pluginEventLog .evlAiRing .trk { stroke:var(--evl-line); }
#pluginEventLog .evlAiRing .arc { stroke:var(--evl-acc); stroke-linecap:round; stroke-dasharray:11 30; transform-origin:8px 8px; animation:evlSpin 1.1s linear infinite; }
#pluginEventLog .evlAiRing rect { fill:currentColor; }
#pluginEventLog .evlAiStopT { padding-left:6px; border-left:1px solid var(--evl-line); font-size:11px; color:var(--evl-muted); }
@keyframes evlSpin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #pluginEventLog .evlAiRing .arc { animation:none; stroke-dasharray:22 19; } }
/* the steps list: notes the model wrote between its lookups */
#pluginEventLog .evlAiStep.note { grid-template-columns:16px minmax(0,1fr); color:var(--evl-muted); }
#pluginEventLog .evlAiStep.note .t { line-height:1.4; overflow-wrap:anywhere; }
#pluginEventLog .evlAiStep.note b { font-weight:normal; color:var(--evl-ink); }
#pluginEventLog .evlAiStep.note .n::before { content:""; display:block; width:5px; height:5px; margin:5px auto 0; border-radius:50%; border:1px solid var(--evl-muted); }
#pluginEventLog .evlAiSeg { align-self:stretch; text-align:center; font-size:11px; color:var(--evl-muted); border-top:1px dashed var(--evl-line); padding-top:4px; }
#pluginEventLog .evlAiIntro p { margin:0 0 10px; line-height:1.5; color:var(--evl-ink); }
#pluginEventLog .evlAiFollow { display:flex; flex-wrap:wrap; gap:6px; }
#pluginEventLog .evlAiFollow .evlBtn { text-align:left; white-space:normal; line-height:1.35; }
#pluginEventLog .evlAiActs { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
/* suggested follow-up questions: one quiet line under the last answer; the chips wear the question bubble's colours
   (each one becomes the technician's next question) */
#pluginEventLog .evlAiFu { display:flex; flex-direction:column; gap:6px; margin-top:-3px; font-size:12px; }
#pluginEventLog .evlAiFuBar { display:flex; align-items:center; gap:2px 10px; flex-wrap:wrap; min-height:24px; }
#pluginEventLog .evlAiFuTg, #pluginEventLog .evlAiFuRe { display:inline-flex; align-items:center; gap:5px; border:1px solid transparent; background:none; color:var(--evl-muted); font:inherit; font-size:12px; padding:2px 6px; border-radius:3px; cursor:pointer; min-height:24px; white-space:nowrap; }
#pluginEventLog .evlAiFuTg { margin-left:-6px; }
#pluginEventLog .evlAiFuRe { margin-left:auto; margin-right:-6px; }
#pluginEventLog .evlAiFuTg:hover, #pluginEventLog .evlAiFuRe:hover:not([disabled]):not([aria-disabled=true]) { color:var(--evl-ink); background:var(--evl-hover); }
#pluginEventLog .evlAiFuTg svg, #pluginEventLog .evlAiFuRe svg { margin:0; flex:none; }
#pluginEventLog .evlAiFuTg svg { width:12px; height:12px; transition:transform .12s ease-out; }
#pluginEventLog .evlAiFuTg[aria-expanded=true] svg { transform:rotate(90deg); }
#pluginEventLog .evlAiFuTg[aria-expanded=true] { color:var(--evl-ink); }
#pluginEventLog .evlAiFuTg .n { font-variant-numeric:tabular-nums; color:var(--evl-muted); }
#pluginEventLog .evlAiFuRe svg { width:13px; height:13px; }
#pluginEventLog .evlAiFuRe[aria-disabled=true] { cursor:progress; color:var(--evl-ink); }
#pluginEventLog .evlAiFuRe[disabled] { opacity:.5; cursor:default; }
#pluginEventLog .evlAiFuNone { color:var(--evl-muted); }
#pluginEventLog .evlAiFuL { display:flex; flex-wrap:wrap; gap:5px; max-height:88px; overflow-y:auto; padding:1px; margin:-1px; }
#pluginEventLog .evlAiFuChip { flex:0 1 auto; max-width:100%; min-width:0; box-sizing:border-box; height:26px; padding:0 11px; border:1px solid var(--evl-bubble-line); border-radius:13px; background:var(--evl-bubble); color:var(--evl-ink); font:inherit; font-size:12px; line-height:24px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; text-align:left; }
#pluginEventLog .evlAiFuChip:hover { border-color:var(--evl-acc); }
#pluginEventLog .evlAiFuChip:active { background:var(--evl-sel); }
#pluginEventLog .evlAiFuChip:focus-visible, #pluginEventLog .evlAiFuTg:focus-visible, #pluginEventLog .evlAiFuRe:focus-visible { outline:2px solid var(--evl-acc); outline-offset:1px; }
#pluginEventLog .evlAiFuErr { margin:0; color:var(--evl-err); line-height:1.4; }
@media (prefers-reduced-motion: reduce) { #pluginEventLog .evlAiFuTg svg { transition:none; } }
/* answer settings: the header button, what the chat changes, and the popover below the header */
#pluginEventLog .evlBtn.evlAiGenBtn.set { color:var(--evl-acc); border-color:var(--evl-acc); }
#pluginEventLog .evlBtn.evlAiGenBtn[aria-expanded=true] { background:var(--evl-sel); border-color:var(--evl-acc); }
#pluginEventLog .evlAiGenTag { display:flex; align-items:center; gap:4px; margin-top:2px; font-size:11.5px; color:var(--evl-acc); font-variant-numeric:tabular-nums; }
#pluginEventLog .evlAiGenTag svg { width:12px; height:12px; flex:none; margin:0; }
#pluginEventLog .evlAiPop { position:absolute; right:8px; z-index:8; width:min(320px, calc(100% - 16px)); box-sizing:border-box; container:evlpop / inline-size;
  background:var(--evl-bg); color:var(--evl-ink); border:1px solid var(--evl-line); border-top:2px solid var(--evl-acc); border-radius:2px 2px 4px 4px; box-shadow:0 10px 28px rgba(16,24,23,.18), 0 1px 3px rgba(16,24,23,.08); padding:8px 12px 10px; font-size:12px; }
body.night #pluginEventLog .evlAiPop { box-shadow:0 10px 28px rgba(0,0,0,.75); border-color:var(--evl-bline); border-top-color:var(--evl-acc); }
#pluginEventLog .evlAiPopHd { display:flex; align-items:center; gap:6px; }
#pluginEventLog .evlAiPopHd h3 { flex:1 1 auto; margin:0; font-size:13px; font-weight:bold; color:var(--evl-ink); }
#pluginEventLog .evlAiPopHd .evlAiX { margin-right:-6px; border-color:transparent; background:none; color:var(--evl-muted); }
#pluginEventLog .evlAiPopHd .evlAiX:hover { color:var(--evl-ink); border-color:var(--evl-line); }
#pluginEventLog .evlAiPopSub { margin:1px 0 9px; color:var(--evl-muted); line-height:1.4; }
#pluginEventLog .evlAiGenF { padding:9px 0 10px; border-top:1px solid var(--evl-line2); }
#pluginEventLog .evlAiGenL { display:block; margin:0 0 6px; font-size:12px; font-weight:bold; color:var(--evl-ink); }
#pluginEventLog .evlAiGenSeg { display:flex; border:1px solid var(--evl-bline); border-radius:3px; overflow:hidden; }
#pluginEventLog .evlAiGenSeg button { flex:1 1 auto; min-width:0; min-height:28px; border:0; border-left:1px solid var(--evl-line2); background:var(--evl-input); color:var(--evl-ink); font:inherit; font-size:12px; padding:3px 6px; cursor:pointer; white-space:nowrap; }
#pluginEventLog .evlAiGenSeg button:first-child { border-left:0; }
#pluginEventLog .evlAiGenSeg button:hover:not([disabled]):not([aria-pressed=true]) { background:var(--evl-hover); }
#pluginEventLog .evlAiGenSeg button[aria-pressed=true] { background:var(--evl-acc); color:var(--evl-acc-ink); font-weight:bold; }
#pluginEventLog .evlAiGenSeg button[disabled] { color:var(--evl-muted); opacity:.5; cursor:not-allowed; text-decoration:line-through; }
#pluginEventLog .evlAiGenSeg button:focus-visible { outline:2px solid var(--evl-acc); outline-offset:-3px; }
#pluginEventLog .evlAiGenSeg .sm { display:none; }
@container evlpop (max-width: 282px) { #pluginEventLog .evlAiGenSeg .lg { display:none; } #pluginEventLog .evlAiGenSeg .sm { display:inline; } }
#pluginEventLog .evlAiGenHint { margin:6px 0 0; font-size:11.5px; color:var(--evl-muted); line-height:1.4; }
#pluginEventLog .evlAiGenWarn { color:var(--evl-warn); }
#pluginEventLog .evlAiGenHint .evlLinkBtn { font-size:11.5px; }
#pluginEventLog .evlAiGenTH { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
#pluginEventLog .evlAiGenTH .evlAiGenL { margin:0; }
#pluginEventLog .evlAiGenTH output { font-variant-numeric:tabular-nums; font-weight:bold; color:var(--evl-acc); }
#pluginEventLog .evlAiGenTH output.def { font-weight:normal; color:var(--evl-muted); }
#pluginEventLog #evlAiGenT { display:block; width:100%; margin:6px 0 1px; accent-color:var(--evl-acc); cursor:pointer; }
#pluginEventLog #evlAiGenT:focus-visible { outline:2px solid var(--evl-acc); outline-offset:1px; border-radius:3px; }
#pluginEventLog .evlAiGenScale { display:grid; grid-template-columns:1fr auto 1fr; font-size:10.5px; color:var(--evl-muted); font-variant-numeric:tabular-nums; }
#pluginEventLog .evlAiGenScale span:last-child { text-align:right; }
#pluginEventLog .evlAiPopFt { display:flex; align-items:center; gap:8px; padding-top:9px; border-top:1px solid var(--evl-line2); }
#pluginEventLog .evlAiPopFt span { flex:1 1 auto; color:var(--evl-muted); line-height:1.35; }
#pluginEventLog .evlBtn[aria-pressed=true] { background:var(--evl-sel); border-color:var(--evl-acc); }
#pluginEventLog .evlBtn[disabled] { opacity:.5; cursor:default; }
#pluginEventLog .evlBtn svg { vertical-align:-2px; margin-right:4px; }
#pluginEventLog .evlLinkBtn { border:0; background:none; padding:0; font:inherit; color:var(--evl-acc); text-decoration:underline; cursor:pointer; }
#pluginEventLog .evlLinkBtn:focus-visible, #pluginEventLog .evlAiX:focus-visible { outline:2px solid var(--evl-acc); outline-offset:1px; }
#pluginEventLog .evlAiMuted { color:var(--evl-muted); font-size:12px; margin:0; line-height:1.45; }
#pluginEventLog .evlAiWait { color:var(--evl-muted); margin:0; }
#pluginEventLog .evlAiNoteBox { border:1px solid var(--evl-line2); background:var(--evl-alt); border-radius:3px; padding:7px 10px; font-size:12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
#pluginEventLog .evlAiHistBtn { display:inline-flex; align-items:center; gap:2px; }
#pluginEventLog .evlBtn.evlAiHistBtn.on, #pluginEventLog .evlBtn.evlAiHistBtn.on:hover { background:var(--evl-sel); border-color:var(--evl-acc); color:var(--evl-ink); filter:none; }
#pluginEventLog .evlAiN { display:inline-block; min-width:16px; margin-left:5px; padding:0 4px; border-radius:8px; background:var(--evl-acc); color:var(--evl-acc-ink); font-size:10px; line-height:15px; text-align:center; font-variant-numeric:tabular-nums; font-weight:bold; }
#pluginEventLog .evlAiHist { display:flex; flex-direction:column; }
#pluginEventLog .evlAiHistDay { margin:12px 0 2px; font-size:12px; font-weight:bold; color:var(--evl-muted); }
#pluginEventLog .evlAiHistDay:first-child { margin-top:0; }
#pluginEventLog .evlAiHistL { list-style:none; margin:0; padding:0; border-top:1px solid var(--evl-line2); }
#pluginEventLog .evlAiHistRow { display:flex; align-items:stretch; border-bottom:1px solid var(--evl-line2); position:relative; }
#pluginEventLog .evlAiHistRow.cur::before { content:''; position:absolute; left:0; top:4px; bottom:4px; width:3px; border-radius:2px; background:var(--evl-acc); }
#pluginEventLog .evlAiHistOpen { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; text-align:left; border:0; background:none; color:var(--evl-ink); font:inherit; padding:7px 8px 7px 11px; cursor:pointer; }
#pluginEventLog .evlAiHistOpen:hover { background:var(--evl-hover); }
#pluginEventLog .evlAiHistOpen:focus-visible { outline:2px solid var(--evl-acc); outline-offset:-2px; }
#pluginEventLog .evlAiHistOpen .t { line-height:1.35; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow-wrap:anywhere; }
#pluginEventLog .evlAiHistRow.cur .evlAiHistOpen .t { font-weight:bold; }
#pluginEventLog .evlAiHistOpen .m { font-size:11px; color:var(--evl-muted); font-variant-numeric:tabular-nums; }
#pluginEventLog .evlAiDgMark { display:inline-block; margin-right:6px; padding:0 5px; border:1px solid var(--evl-acc); border-radius:3px; color:var(--evl-acc); font-size:10.5px; line-height:15px; font-weight:bold; white-space:nowrap; }
#pluginEventLog .evlAiDgEntry { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; margin-top:12px; padding-top:12px; border-top:1px dashed var(--evl-line); }
#pluginEventLog .evlAiDgEntry span { flex:1 1 200px; font-size:12px; color:var(--evl-muted); line-height:1.4; }
#pluginEventLog .evlAiDgGo, #pluginEventLog .evlAiDgBtn, #pluginEventLog .evlDgRun { display:inline-flex; align-items:center; gap:6px; }
#pluginEventLog .evlAiDgGo svg, #pluginEventLog .evlAiDgBtn svg, #pluginEventLog .evlDgRun svg { margin:0; }
#pluginEventLog .evlAiDgGo svg { color:var(--evl-acc); }
#pluginEventLog .evlAiHistDel { align-self:center; flex:none; margin:0 4px; padding:4px 5px; display:inline-flex; color:var(--evl-muted); }
#pluginEventLog .evlAiHistDel:hover:not([disabled]), #pluginEventLog .evlAiHistDel:focus-visible { color:var(--evl-err); border-color:var(--evl-err); }
#pluginEventLog .evlAiHistDel svg { margin:0; }
#pluginEventLog .evlAiHistAsk { flex:1 1 auto; display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:7px 8px 7px 11px; background:var(--evl-alt); border-left:3px solid var(--evl-err); font-size:12px; }
#pluginEventLog .evlAiHistAsk span { flex:1 1 100%; overflow-wrap:anywhere; }
#pluginEventLog .evlBtn.evlAiDanger { color:var(--evl-err); border-color:var(--evl-err); font-weight:bold; }
#pluginEventLog .evlAiHistNote { font-size:11px; color:var(--evl-muted); margin:12px 0 0; line-height:1.45; }
#pluginEventLog .evlAiIntro .evlAiHistNote { margin-top:14px; }
#pluginEventLog .evlAiSaved { margin:0; font-size:12px; color:var(--evl-muted); line-height:1.45; padding-bottom:8px; border-bottom:1px dashed var(--evl-line); }
#pluginEventLog .evlAiErr { border-left:3px solid var(--evl-err); background:var(--evl-alt); padding:7px 10px; border-radius:0 3px 3px 0; }
#pluginEventLog .evlAiErr p { margin:0 0 6px; line-height:1.45; }
#pluginEventLog details.evlAiSteps { border:1px solid var(--evl-line2); border-radius:4px; background:var(--evl-bg); padding:3px 9px; font-size:12px; }
#pluginEventLog details.evlAiSteps summary { cursor:pointer; color:var(--evl-muted); min-height:24px; line-height:24px; }
#pluginEventLog details.evlAiSteps summary:focus-visible { outline:2px solid var(--evl-acc); outline-offset:1px; }
#pluginEventLog .evlAiStepL { padding:2px 0 4px; }
#pluginEventLog .evlAiStep { display:grid; grid-template-columns:16px minmax(0,1fr) auto; gap:2px 8px; padding:2px 0; align-items:baseline; }
#pluginEventLog .evlAiStep .n, #pluginEventLog .evlAiStep .r { color:var(--evl-muted); }
#pluginEventLog .evlAiStep .r.err { color:var(--evl-err); }
#pluginEventLog .evlAiStep code { font-family:Consolas,"DejaVu Sans Mono",monospace; font-size:11px; background:none; color:var(--evl-ink); padding:0; overflow-wrap:anywhere; }
#pluginEventLog .evlAiFt { flex:none; border-top:1px solid var(--evl-line2); padding:9px 12px 8px; background:var(--evl-bg); }
#pluginEventLog .evlAiLbl { display:block; font-size:12px; color:var(--evl-muted); margin:0 0 4px; font-weight:normal; }
#pluginEventLog .evlAiRow { display:flex; gap:8px; align-items:flex-end; }
#pluginEventLog .evlAiRow textarea { flex:1 1 auto; min-width:0; font:inherit; border:1px solid var(--evl-line); background:var(--evl-input); color:var(--evl-ink); border-radius:3px; padding:6px 8px; resize:vertical; min-height:42px; max-height:220px; box-sizing:border-box; }
#pluginEventLog .evlAiRow textarea:focus-visible { outline:2px solid var(--evl-acc); outline-offset:-1px; }
#pluginEventLog .evlAiRow .evlBtn { min-height:42px; min-width:66px; }
#pluginEventLog .evlAiDisc { font-size:11px; color:var(--evl-muted); margin-top:6px; line-height:1.4; display:flex; align-items:baseline; gap:10px; }
#pluginEventLog .evlAiDisc > span { flex:1 1 auto; min-width:0; }
#pluginEventLog .evlAiDisc .evlLinkBtn { flex:none; color:var(--evl-muted); white-space:nowrap; }
#pluginEventLog .evlAiDisc .evlLinkBtn:hover, #pluginEventLog .evlAiDisc .evlLinkBtn:focus-visible { color:var(--evl-acc); }
#pluginEventLog .evlAiPeek { border:1px solid var(--evl-acc); border-radius:3px; background:var(--evl-bg); margin:0 0 8px; font-size:12px; }
#pluginEventLog .evlAiPeekH { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:5px 6px 5px 8px; border-bottom:1px solid var(--evl-line2); }
#pluginEventLog .evlAiPeekH .evlBtn { margin-left:auto; }
#pluginEventLog .evlAiPeekM { padding:6px 8px; white-space:pre-wrap; max-height:150px; overflow:auto; overflow-wrap:anywhere; line-height:1.4; }
#pluginEventLog .evlAiUnv { color:var(--evl-muted); font-size:11px; }
/* running state: progress strip, status line with elapsed time, streaming caret, dot on the Ask button */
#pluginEventLog .evlAiStripSlot { position:relative; height:0; z-index:1; }
#pluginEventLog .evlAiStrip { position:relative; height:2px; overflow:hidden; pointer-events:none; flex:none; }
#pluginEventLog .evlAiStripSlot .evlAiStrip { position:absolute; left:0; right:0; top:-1px; }
#pluginEventLog .evlAiEx { position:relative; }
#pluginEventLog .evlAiEx > .evlAiStrip { position:absolute; top:-1px; left:-1px; right:-1px; border-radius:3px 3px 0 0; }
#pluginEventLog .evlAiStrip.on { background:var(--evl-line2); }
#pluginEventLog .evlAiStrip i { position:absolute; top:0; bottom:0; left:0; width:100%; background:linear-gradient(90deg, transparent 0, transparent 20%, var(--evl-acc) 34%, var(--evl-acc) 54%, transparent 64%, transparent 100%); transform:translateX(-64%); animation:evlSweep 1.8s cubic-bezier(.5,0,.3,1) infinite; }
@keyframes evlSweep { from { transform:translateX(-64%); } to { transform:translateX(82%); } }
#pluginEventLog .evlAiA:empty { display:none; }
#pluginEventLog .evlAiLive { display:flex; align-items:baseline; gap:12px; font-size:12px; line-height:1.4; color:var(--evl-muted); border-left:2px solid var(--evl-acc); padding:1px 0 1px 8px; }
#pluginEventLog .evlAiEx .evlAiLive { margin-top:9px; }
#pluginEventLog .evlAiLiveT { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
#pluginEventLog .evlAiLiveT b { color:var(--evl-ink); font-weight:bold; }
#pluginEventLog .evlAiThinkN { font-variant-numeric:tabular-nums; white-space:nowrap; }
#pluginEventLog .evlAiClock { flex:none; font-family:Consolas,"DejaVu Sans Mono",monospace; font-size:11px; font-variant-numeric:tabular-nums; }
#pluginEventLog .evlAiCaret { display:inline-block; width:.48em; height:1.05em; margin-left:2px; vertical-align:-.17em; background:var(--evl-acc); border-radius:1px; animation:evlBlink 1.06s steps(1) infinite; }
@keyframes evlBlink { 50% { opacity:0; } }
#pluginEventLog .evlAiBtn { position:relative; }
#pluginEventLog .evlAiDot { display:none; position:absolute; top:-4px; right:-4px; width:8px; height:8px; border-radius:50%; background:var(--evl-acc); box-shadow:0 0 0 2px var(--evl-bg); }
#pluginEventLog .evlAiBtn.busy .evlAiDot { display:block; }
#pluginEventLog .evlAiDot::after { content:""; position:absolute; top:0; right:0; bottom:0; left:0; border-radius:50%; background:var(--evl-acc); animation:evlPulse 1.8s ease-out infinite; }
@keyframes evlPulse { 0% { transform:scale(1); opacity:.55; } 70%, 100% { transform:scale(2.6); opacity:0; } }
@media (prefers-reduced-motion: reduce) {
  #pluginEventLog .evlAiStrip i { animation:none; transform:none; background:repeating-linear-gradient(90deg, var(--evl-acc) 0 8px, transparent 8px 12px); opacity:.8; }
  #pluginEventLog .evlAiCaret { animation:none; }
  #pluginEventLog .evlAiDot::after { animation:none; display:none; }
}
/* model text: Markdown, with MeshCentral's Bootstrap defaults (default3) reset */
#pluginEventLog .evlAiMd { line-height:1.5; overflow-wrap:anywhere; color:var(--evl-ink); }
#pluginEventLog .evlAiMd p, #pluginEventLog .evlAiMd ul, #pluginEventLog .evlAiMd ol, #pluginEventLog .evlAiMd blockquote { margin:0 0 8px; }
#pluginEventLog .evlAiMd > :last-child, #pluginEventLog .evlAiMd li > :last-child { margin-bottom:0; }
#pluginEventLog .evlAiMd ul, #pluginEventLog .evlAiMd ol { padding-left:20px; }
#pluginEventLog .evlAiMd li { margin:0 0 3px; }
#pluginEventLog .evlAiMd h1, #pluginEventLog .evlAiMd h2, #pluginEventLog .evlAiMd h3, #pluginEventLog .evlAiMd h4, #pluginEventLog .evlAiMd h5, #pluginEventLog .evlAiMd h6 { font-family:inherit; font-size:13px; font-weight:bold; line-height:1.35; margin:12px 0 4px; color:var(--evl-ink); text-transform:none; letter-spacing:0; }
#pluginEventLog .evlAiMd h1, #pluginEventLog .evlAiMd h2 { font-size:14px; }
#pluginEventLog .evlAiMd > h1:first-child, #pluginEventLog .evlAiMd > h2:first-child, #pluginEventLog .evlAiMd > h3:first-child, #pluginEventLog .evlAiMd > h4:first-child { margin-top:0; }
#pluginEventLog .evlAiMd strong { font-weight:bold; }
#pluginEventLog .evlAiMd a { color:var(--evl-acc); text-decoration:underline; background:none; }
#pluginEventLog .evlAiMd a:hover { text-decoration-thickness:2px; }
#pluginEventLog .evlAiMd code { font-family:Consolas,"DejaVu Sans Mono",monospace; font-size:12px; background:var(--evl-code); border:1px solid var(--evl-code-line); border-radius:3px; padding:0 4px; color:var(--evl-ink); white-space:pre-wrap; }
#pluginEventLog .evlAiMd blockquote { border-left:3px solid var(--evl-line); padding:0 0 0 10px; color:var(--evl-muted); font-size:inherit; }
#pluginEventLog .evlAiMd hr { border:0; border-top:1px solid var(--evl-line2); margin:10px 0; }
#pluginEventLog mark.evlPs, #evlAiDlg mark.evlPs { background:var(--evl-ps-bg); color:var(--evl-ps-ink); border-radius:3px; padding:0 3px; font:inherit; }
#pluginEventLog .evlAiTbl { overflow-x:auto; margin:0 0 8px; max-width:100%; }
#pluginEventLog .evlAiTbl table { border-collapse:collapse; font-size:12px; }
#pluginEventLog .evlAiTbl th, #pluginEventLog .evlAiTbl td { border:1px solid var(--evl-line2); padding:3px 7px; text-align:left; vertical-align:top; }
#pluginEventLog .evlAiTbl th { background:var(--evl-alt); font-weight:bold; }
#pluginEventLog .evlAiCodeW { border:1px solid var(--evl-code-line); border-radius:3px; background:var(--evl-code); margin:4px 0 8px; }
#pluginEventLog .evlAiCodeBar { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:2px 3px 2px 9px; border-bottom:1px solid var(--evl-code-line); font-size:11px; color:var(--evl-muted); }
#pluginEventLog .evlAiCodeW pre { margin:0; border:0; background:none; padding:7px 10px; font-family:Consolas,"DejaVu Sans Mono",monospace; font-size:12px; line-height:1.45; white-space:pre-wrap; word-break:break-word; color:var(--evl-ink); max-height:320px; overflow:auto; border-radius:0; }
#pluginEventLog .evlAiCodeW pre code { border:0; padding:0; background:none; font-size:inherit; white-space:inherit; }
#pluginEventLog .evlAiCmdNote { font-size:12px; color:var(--evl-muted); margin:-3px 0 8px; }
/* citation chips: the link between an answer and the rows it relies on */
#pluginEventLog .evlCite, #pluginEventLog .evlCitePend { display:inline-block; font-family:Consolas,"DejaVu Sans Mono",monospace; font-size:11px; font-weight:bold; line-height:16px; border:1px solid var(--evl-acc); color:var(--evl-acc); background:var(--evl-bg); border-radius:3px; padding:0 5px; margin:0 1px; vertical-align:1px; cursor:pointer; }
#pluginEventLog .evlCite:hover { background:var(--evl-hover); }
#pluginEventLog .evlCite.sel { background:var(--evl-acc); color:var(--evl-acc-ink); }
#pluginEventLog .evlCite.in { border-style:dashed; }
#pluginEventLog .evlCite.static { cursor:default; }
#pluginEventLog .evlCite:focus-visible { outline:2px solid var(--evl-acc); outline-offset:1px; }
#pluginEventLog .evlCitePend { border-color:var(--evl-line); color:var(--evl-muted); border-style:dashed; cursor:default; }
#pluginEventLog .evlCiteMore { font-size:11px; color:var(--evl-muted); margin-left:2px; }
#pluginEventLog td.evlCCite { white-space:nowrap; }
#pluginEventLog .evlCite.more { border-color:var(--evl-line); color:var(--evl-muted); font-weight:normal; }
#pluginEventLog .evlCite.more:hover, #pluginEventLog .evlCite.more:focus-visible { border-color:var(--evl-acc); color:var(--evl-acc); }
#pluginEventLog .evlOccBar { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; margin:0 0 8px; padding:6px 10px; border-left:3px solid var(--evl-acc); background:var(--evl-alt); font-size:12px; color:var(--evl-ink); }
#pluginEventLog .evlDTabs + .evlOccBar { margin:8px 13px 0; }
#pluginEventLog .evlOccBar .evlLinkBtn { margin-left:auto; }
#pluginEventLog .evlKv dd.evlOccDd, #pluginEventLog .evlOccDd { white-space:normal; overflow:visible; line-height:1.7; }
#pluginEventLog .evlOcc { white-space:nowrap; }
#pluginEventLog .evlOcc.cited { color:var(--evl-ink); }
#pluginEventLog .evlOcc.cur .t { font-weight:bold; color:var(--evl-acc); box-shadow:inset 0 -2px 0 var(--evl-acc); }
#pluginEventLog table.evlLog th.evlCCite, #pluginEventLog table.evlLog td.evlCCite { padding-left:6px; padding-right:2px; overflow:visible; cursor:default; }
#pluginEventLog table.evlLog tr.evlFlash td { animation:evlFlash 1.5s ease-out 1; }
#pluginEventLog table.evlLog tr.evlFlash td:first-child { box-shadow:inset 3px 0 0 var(--evl-acc); }
@keyframes evlFlash { 0%, 25% { background:var(--evl-acc); color:var(--evl-acc-ink); } 100% { background:var(--evl-sel); } }
@media (prefers-reduced-motion: reduce) { #pluginEventLog table.evlLog tr.evlFlash td { animation:none; } }
#pluginEventLog .evlAiNote { flex-basis:100%; display:flex; align-items:center; gap:8px; flex-wrap:wrap; border:1px solid var(--evl-acc); border-radius:3px; background:var(--evl-bg); padding:4px 6px 4px 10px; font-size:12px; }
/* Explain */
#pluginEventLog .evlAiEx { margin-top:12px; padding:11px 14px 12px; background:var(--evl-panel); border:1px solid var(--evl-line2); border-radius:3px; max-width:min(110ch, 100%); min-width:0; box-sizing:border-box; overflow-wrap:anywhere; cursor:auto; white-space:normal; }
#pluginEventLog .evlAiExHd { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:2px; }
#pluginEventLog .evlAiExHd h3 { margin:0; font-size:14px; font-weight:bold; flex:1 1 auto; color:var(--evl-ink); }
#pluginEventLog .evlAiEx h4, #pluginEventLog .evlAiTurn h4 { font-size:13px; font-weight:bold; margin:12px 0 3px; color:var(--evl-ink); }
#pluginEventLog .evlAiEx .evlAiA, #pluginEventLog .evlAiEx details.evlAiSteps { margin-top:9px; }
#pluginEventLog .evlAiVerdict { font-weight:bold; }
#pluginEventLog .evlAiExFt { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:12px; padding-top:9px; border-top:1px solid var(--evl-line2); }
#pluginEventLog .evlAiExFt .evlAiMuted { flex:1 1 240px; }
#pluginEventLog details.evlAiMore { margin-top:10px; font-size:12px; }
#pluginEventLog details.evlAiMore summary { cursor:pointer; color:var(--evl-muted); }
#pluginEventLog .evlDBody.evlDBodyEx { grid-template-columns:minmax(0,1fr) minmax(0,1.4fr); }
#pluginEventLog .evlDBodyEx .evlKv { margin-top:10px; }
#pluginEventLog .evlDBodyEx .evlAiEx { margin-top:0; }
#pluginEventLog tr.evlExpand td > .evlAiEx { max-width:min(110ch, calc(100cqw - 44px)); }
/* Diagnosis: the window choice, and the diagnosis as the first answer of its chat */
/* the setup card keeps the conversation's left edge; its own width decides between one row of windows and a column */
#pluginEventLog .evlDgSetup { border:1px solid var(--evl-line2); border-radius:4px; background:var(--evl-bg); padding:12px 14px 14px; width:100%; max-width:820px; box-sizing:border-box; align-self:flex-start; container:evldgset / inline-size; }
#pluginEventLog .evlDgSetup h3 { margin:0 0 6px; font-size:15px; font-weight:bold; color:var(--evl-ink); }
#pluginEventLog .evlDgSetup p { margin:0 0 10px; line-height:1.5; max-width:76ch; }
#pluginEventLog .evlDgWin { display:block; border:0; margin:0 0 12px; padding:0; min-width:0; }
/* float:none: Bootstrap (MeshCentral's modern UI) floats legends, which would take them out of their place above the options */
#pluginEventLog .evlDgWin legend { float:none; display:block; width:auto; padding:0; margin:0 0 6px; font-size:12px; line-height:1.4; font-weight:bold; color:var(--evl-muted); border:0; }
#pluginEventLog .evlDgOpts { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:6px; }
@container evldgset (max-width: 560px) { #pluginEventLog .evlDgOpts { grid-template-columns:minmax(0, 1fr); } }
#pluginEventLog .evlDgOpt { display:flex; gap:8px; align-items:flex-start; margin:0; padding:8px 10px; border:1px solid var(--evl-line); border-radius:4px; cursor:pointer; font-weight:normal; background:var(--evl-input); }
#pluginEventLog .evlDgOpt:hover { border-color:var(--evl-acc); }
#pluginEventLog .evlDgOpt:has(input:checked) { border-color:var(--evl-acc); background:var(--evl-sel); box-shadow:inset 0 0 0 1px var(--evl-acc); }
#pluginEventLog .evlDgOpt input { margin:2px 0 0; accent-color:var(--evl-acc); flex:none; }
#pluginEventLog .evlDgOpt input:focus-visible { outline:2px solid var(--evl-acc); outline-offset:2px; }
#pluginEventLog .evlDgOpt span { display:flex; flex-direction:column; gap:2px; line-height:1.35; }
#pluginEventLog .evlDgOpt small { font-size:11px; color:var(--evl-muted); }
#pluginEventLog .evlDgCard { container:evldg / inline-size; border:1px solid var(--evl-line2); border-radius:4px; background:var(--evl-bg); min-width:0; }
#pluginEventLog .evlDgHd { padding:11px 13px 4px; }
#pluginEventLog .evlDgHd h3 { margin:0; font-size:15px; font-weight:bold; line-height:1.35; color:var(--evl-ink); }
#pluginEventLog .evlDgMeta { margin:2px 0 8px; font-size:11px; color:var(--evl-muted); }
#pluginEventLog .evlDgSum { font-size:13.5px; max-width:76ch; margin:0 0 8px; }
#pluginEventLog .evlDgBody { padding:0 13px 4px; }
#pluginEventLog .evlDgBody h4 { font-size:13px; font-weight:bold; margin:16px 0 4px; color:var(--evl-ink); }
#pluginEventLog .evlDgFoot { padding:8px 13px 11px; border-top:1px solid var(--evl-line2); background:var(--evl-panel); border-radius:0 0 4px 4px; }
#pluginEventLog .evlDgCard .evlAiCmdNote { margin-top:0; }
#pluginEventLog .evlTl { overflow-x:auto; border:1px solid var(--evl-line2); border-radius:4px; padding:6px 12px 2px; }
#pluginEventLog .evlTlIn { min-width:0; }
#pluginEventLog .evlLane { display:grid; grid-template-columns:150px minmax(0,1fr); align-items:center; min-height:30px; border-bottom:1px solid var(--evl-line2); font-size:12px; }
#pluginEventLog .evlLane:last-child { border-bottom:0; }
#pluginEventLog .evlLane.evlAxis { min-height:18px; border-bottom:0; }
#pluginEventLog .evlLane .lbl { padding-right:10px; overflow-wrap:anywhere; line-height:1.3; }
#pluginEventLog .evlTrk { position:relative; height:30px; }
#pluginEventLog .evlTrk::before { content:""; position:absolute; left:0; right:0; top:50%; border-top:1px dotted var(--evl-line); }
#pluginEventLog .evlAxis .evlTrk { height:18px; }
#pluginEventLog .evlAxis .evlTrk::before { display:none; }
#pluginEventLog .evlTick { position:absolute; top:1px; font-size:11px; color:var(--evl-muted); transform:translateX(-50%); white-space:nowrap; }
#pluginEventLog .evlTick.first { transform:none; }
#pluginEventLog .evlTick.last { transform:translateX(-100%); }
#pluginEventLog .evlMk { position:absolute; top:7px; height:16px; border-radius:2px; background:currentColor; color:var(--evl-info); }
#pluginEventLog .evlMk.pt { width:6px; transform:translateX(-50%); }
#pluginEventLog .evlMk.rg { min-width:4px; opacity:.75; }
#pluginEventLog .evlMk.crit { color:var(--evl-crit); }
#pluginEventLog .evlMk.crit.pt { width:5px; }
#pluginEventLog .evlMk.err { color:var(--evl-err); }
#pluginEventLog .evlMk.warn { color:var(--evl-warn); }
#pluginEventLog .evlMk.warn.pt { width:9px; }
#pluginEventLog .evlMk.many { box-shadow:2px 0 0 0 var(--evl-bg), 4px 0 0 0 currentColor; }
#pluginEventLog .evlMk.go { cursor:pointer; }
#pluginEventLog .evlMk .tip { display:none; position:absolute; top:calc(100% + 3px); left:50%; transform:translateX(-50%); background:var(--evl-ink); color:var(--evl-bg); font-size:11px; padding:2px 7px; border-radius:3px; white-space:nowrap; z-index:5; pointer-events:none; }
#pluginEventLog .evlMk .tip mark.evlPs { background:transparent; color:inherit; text-decoration:underline dotted; }
#pluginEventLog .evlMk:hover .tip { display:block; }
#pluginEventLog .evlMk:hover { filter:brightness(1.15); }
#pluginEventLog .evlDgCols { display:flex; flex-wrap:wrap; gap:0 28px; }
#pluginEventLog .evlDgMain { flex:999 1 480px; min-width:0; }
#pluginEventLog .evlDgSide { flex:1 1 260px; min-width:0; }
#pluginEventLog .evlHyp { display:grid; grid-template-columns:100px minmax(0,1fr); gap:6px 16px; padding:10px 0; border-bottom:1px solid var(--evl-line2); }
#pluginEventLog .evlHypSt .st { font-weight:bold; font-size:13px; }
#pluginEventLog .evlHypSt .st.likely { color:var(--evl-crit); }
#pluginEventLog .evlHypSt .st.possible { color:var(--evl-warn); }
#pluginEventLog .evlHypSt .st.ruled_out, #pluginEventLog .evlHypSt .st.wrong { color:var(--evl-muted); text-decoration:line-through; }
#pluginEventLog .evlHypSt .conf { font-size:12px; color:var(--evl-muted); }
#pluginEventLog .evlHypBody { display:flex; flex-direction:column; gap:6px; min-width:0; }
#pluginEventLog .evlHypT { margin:0; font-weight:bold; line-height:1.45; }
#pluginEventLog .evlHypEv { font-size:12px; color:var(--evl-muted); }
#pluginEventLog .evlHypEv span:first-child { margin-right:3px; }
#pluginEventLog ol.evlNext { padding-left:20px; margin:0; }
#pluginEventLog ol.evlNext li { margin-bottom:10px; line-height:1.5; }
#pluginEventLog ul.evlUnx { padding-left:18px; margin:0; }
#pluginEventLog ul.evlUnx li { margin-bottom:8px; }
#pluginEventLog .evlEv { display:grid; grid-template-columns:40px minmax(0,1fr); gap:2px 8px; padding:7px 0; border-bottom:1px solid var(--evl-line2); font-size:12px; align-items:start; }
#pluginEventLog .evlEv .evlCite { justify-self:start; }
#pluginEventLog .evlEv .m { color:var(--evl-muted); line-height:1.4; overflow-wrap:anywhere; }
/* the chat's width, not the window's: docked (about 400 px) the timeline puts each lane's label above its track */
@container evldg (max-width: 560px) {
  #pluginEventLog .evlLane { grid-template-columns:minmax(0,1fr); align-items:stretch; }
  #pluginEventLog .evlLane .lbl { padding:5px 0 0; font-size:11px; color:var(--evl-muted); }
  #pluginEventLog .evlLane.evlAxis > span:first-child { display:none; }
  #pluginEventLog .evlTl { padding:4px 10px 2px; }
  #pluginEventLog .evlHyp { grid-template-columns:minmax(0,1fr); gap:4px; }
  #pluginEventLog .evlHypSt { display:flex; gap:8px; align-items:baseline; }
}
@media (max-width: 1000px) { #pluginEventLog .evlDBody.evlDBodyEx { grid-template-columns:minmax(0,1fr); } }
/* data preview dialog: appended to <body>, so it carries its own tokens */
#evlAiDlg {
  --evl-ink:#1c1c1c; --evl-muted:#5a6360; --evl-line:#c9c9c9; --evl-line2:#e6e6e6; --evl-bg:#fff; --evl-alt:#f4f6f5; --evl-hover:#e9f0f1; --evl-sel:#dbe9eb;
  --evl-input:#fff; --evl-acc:#1F6F78; --evl-acc-ink:#fff; --evl-ok:#1e8a4c; --evl-bline:#c9c9c9; --evl-ps-bg:#F3E8D2; --evl-ps-ink:#6B4E16; --evl-panel:#fafbfa; --evl-code:#f4f6f5;
  position:fixed; top:0; right:0; bottom:0; left:0; z-index:100000; display:flex; align-items:flex-start; justify-content:center; padding:40px 16px; box-sizing:border-box; overflow:auto; font-size:13px; color:var(--evl-ink);
}
body.night #evlAiDlg {
  --evl-ink:#bbbbbb; --evl-muted:#8b9591; --evl-line:#333; --evl-line2:#222; --evl-bg:#000; --evl-alt:#0d1110; --evl-hover:#18201f; --evl-sel:#18302f;
  --evl-input:#111; --evl-acc:#5fb3bb; --evl-acc-ink:#000; --evl-ok:#3dbf7a; --evl-bline:#4a5250; --evl-ps-bg:#3a2e17; --evl-ps-ink:#f0d9a8; --evl-panel:#070a0a; --evl-code:#0d1110;
}
#evlAiDlg .evlDlgBack { position:fixed; top:0; right:0; bottom:0; left:0; background:rgba(16,24,23,.55); }
#evlAiDlg .evlDlgBox { position:relative; background:var(--evl-bg); width:100%; max-width:1080px; border:1px solid var(--evl-line); border-radius:6px; display:flex; flex-direction:column; max-height:calc(100vh - 80px); outline:none; }
#evlAiDlg .evlDlgHd { padding:16px 20px 12px; border-bottom:1px solid var(--evl-line2); }
#evlAiDlg h2 { margin:0; font-size:18px; font-weight:bold; color:var(--evl-ink); }
#evlAiDlg .evlDlgInc h3 + p, #evlAiDlg .evlDlgInc h3:not(:first-child) { margin-top:16px; }
#evlAiDlg h3 { margin:4px 0 4px; font-size:14px; font-weight:bold; color:var(--evl-ink); }
#evlAiDlg h4 { margin:10px 0 2px; font-size:12px; font-weight:bold; color:var(--evl-muted); }
#evlAiDlg .evlDlgHd p { margin:6px 0 0; color:var(--evl-muted); line-height:1.5; max-width:80ch; }
#evlAiDlg .evlDlgBody { display:flex; flex-wrap:wrap; flex:1 1 auto; min-height:0; overflow:auto; }
#evlAiDlg .evlDlgInc { flex:1 1 300px; min-width:0; padding:10px 20px 14px; border-right:1px solid var(--evl-line2); }
#evlAiDlg .evlDlgPrev { flex:1.6 1 440px; min-width:0; padding:10px 20px 14px; background:var(--evl-panel); }
#evlAiDlg .evlDlgPrevHd { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 8px; }
#evlAiDlg .evlDlgPrevHd h3 { flex:1 1 auto; margin:0; }
#evlAiDlg .evlDlgPv { max-height:46vh; overflow:auto; border:1px solid var(--evl-line2); border-radius:3px; background:var(--evl-bg); padding:6px 10px 10px; }
#evlAiDlg .evlDlgPv:focus-visible { outline:2px solid var(--evl-acc); outline-offset:1px; }
#evlAiDlg .evlDlgPv pre { margin:0; font-family:Consolas,"DejaVu Sans Mono",monospace; font-size:12px; line-height:1.6; white-space:pre-wrap; word-break:break-word; color:var(--evl-ink); background:none; border:0; padding:0; }
#evlAiDlg .evlDlgRed { margin-top:10px; background:var(--evl-ps-bg); color:var(--evl-ps-ink); border-radius:3px; padding:7px 10px; line-height:1.45; }
#evlAiDlg .evlInc { display:flex; gap:10px; align-items:flex-start; padding:7px 0; border-bottom:1px solid var(--evl-line2); line-height:1.4; cursor:pointer; font-weight:normal; margin:0; }
#evlAiDlg .evlInc.dis { color:var(--evl-muted); cursor:default; }
#evlAiDlg .evlInc small { display:block; color:var(--evl-muted); font-size:12px; }
#evlAiDlg input[type=checkbox] { width:16px; height:16px; margin:1px 0 0; accent-color:var(--evl-acc); flex:none; }
#evlAiDlg .evlAiMuted { color:var(--evl-muted); line-height:1.5; margin:0; }
#evlAiDlg .evlDlgFt { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:11px 20px; border-top:1px solid var(--evl-line2); }
#evlAiDlg .evlDlgRem { display:inline-flex; gap:8px; align-items:center; flex:1 1 auto; min-height:34px; font-weight:normal; margin:0; }
#evlAiDlg .evlBtn { border:1px solid var(--evl-bline); background:var(--evl-input); color:var(--evl-ink); border-radius:3px; padding:6px 13px; cursor:pointer; font:inherit; min-height:34px; }
#evlAiDlg .evlBtn:hover { background:var(--evl-hover); border-color:var(--evl-acc); }
#evlAiDlg .evlBtn.on, #evlAiDlg .evlBtn.on:hover, #evlAiDlg .evlBtn.on:active { background:var(--evl-acc); color:var(--evl-acc-ink); border-color:var(--evl-acc); }
#evlAiDlg .evlBtn.on:hover { filter:brightness(1.08); }
#evlAiDlg .evlSeg { display:inline-flex; border:1px solid var(--evl-bline); border-radius:3px; overflow:hidden; }
#evlAiDlg .evlSeg button { border:0; background:var(--evl-input); color:var(--evl-muted); padding:4px 11px; cursor:pointer; font:inherit; font-size:12px; }
#evlAiDlg .evlSeg button.on { background:var(--evl-acc); color:var(--evl-acc-ink); font-weight:bold; }
#evlAiDlg .evlBtn:focus-visible, #evlAiDlg .evlSeg button:focus-visible, #evlAiDlg input:focus-visible { outline:2px solid var(--evl-acc); outline-offset:1px; }
@media (max-width: 720px) { #evlAiDlg { padding:12px 8px; } #evlAiDlg .evlDlgInc { border-right:0; border-bottom:1px solid var(--evl-line2); } }
`;
        var s = document.createElement('style');
        s.id = 'evlAiStyles';
        s.appendChild(document.createTextNode(css));
        document.head.appendChild(s);
    };

    // ---- exports --------------------------------------------------------------------------------------------------
    var NAMES = [
        'aiEsc', 'aiStripMarks', 'aiPlain', 'aiTint', 'aiNetWord', 'aiCounts', 'aiTimeShort', 'aiWhen', 'aiBusy', 'aiReqId', 'aiSendMsg', 'aiSay', 'aiCopyText',
        'aiNewState', 'aiStashSave', 'aiAbortAll', 'aiNewTurn', 'aiIsChat', 'aiToolSteps', 'aiNewConv', 'aiPrune', 'aiStartConv', 'aiCloseConv', 'aiOk', 'aiFind', 'aiTurn', 'aiCitesOf', 'aiCite',
        'aiDogStart', 'aiDog',
        'onAiStarted', 'onAiPreview', 'onAiStep', 'onAiNote', 'onAiThinking', 'onAiDelta', 'onAiDone', 'onAiError',
        'aiCitesIn', 'aiHistoryInit', 'aiHistoryGet', 'onAiHistory', 'aiConvFromSaved', 'onAiHistoryItem', 'onAiHistoryDeleted', 'aiHistoryTouch',
        'aiHistoryToggle', 'aiHistoryHtml', 'aiWinShort', 'aiDiagTitle', 'aiSavedNote', 'aiHistoryOpen', 'aiHistoryDel', 'aiHistoryDelYes', 'aiHistoryDelNo',
        'aiRefresh', 'aiSchedule', 'aiFlush', 'aiVisible',
        'aiMdInit', 'aiMd', 'aiChipHtml', 'aiMdFallback', 'aiMdPost', 'aiCopyCode',
        'aiUnavailText', 'aiErrText', 'aiErrHtml', 'aiArgsShort', 'aiStepResult', 'aiUsageText', 'aiStepsHtml', 'aiStepsClick', 'aiWaitHtml', 'aiInfoLine', 'aiNotesHtml',
        'aiToolWords', 'aiThinkCount', 'aiPhase', 'aiElapsed', 'aiLiveHtml', 'aiStripHtml', 'aiStopInner', 'aiCaret', 'aiAnnounce', 'aiTickStart', 'aiTick', 'aiTimersStop', 'aiBtnSync',
        'aiTurnText', 'aiCopyTurn', 'aiVote', 'aiRetry', 'aiStop',
        'aiCiteMap', 'aiRecId', 'aiRowCites', 'aiGutterW', 'aiGutterTd', 'aiApplySel', 'aiGutter', 'aiGutterMore',
        'aiOccShow', 'aiOccOf', 'aiOccBarHtml', 'aiOccClear', 'aiOccTimesHtml', 'aiGotoCite', 'aiReveal', 'aiAfterLoad', 'aiFlashRow', 'aiNoticeHtml', 'aiNoteClose', 'aiShowAnyway',
        'aiOpenCited', 'aiPeekHtml', 'aiRenderPeek', 'aiPeekClose',
        'aiLayout', 'aiOnly', 'aiFullToggle', 'aiPanelKey', 'aiUserH', 'aiSetUserH', 'aiFitH', 'aiFitPanel', 'aiApplyH', 'aiHGripDown', 'aiHGripKey', 'aiHGripReset', 'aiSplitDown', 'aiSplitKey', 'aiSplitReset', 'aiToggle', 'aiClosePanel', 'aiIcon', 'aiRenderPanel', 'aiHeadHtml', 'aiStarters', 'aiIntroHtml', 'aiStarter', 'aiLogHtml',
        'aiTurnHtml', 'aiDoneBody',
        'aiCanEdit', 'aiLaterN', 'aiMsgIndex', 'aiActBtn', 'aiQActsHtml', 'aiAActsHtml', 'aiEditHtml', 'aiConfirmHtml', 'aiTurnOf', 'aiMsgAct', 'aiMsgCancel', 'aiMsgYes',
        'aiEditSave', 'aiEditKey', 'aiTurnsCut', 'aiMsgRun', 'onAiChatEdited',
        'aiRenderComposer', 'aiKey', 'aiDraft', 'aiSubmit', 'aiAsk', 'aiFollow', 'aiNewChat', 'aiPrefill',
        'aiFuOpen', 'aiFuHtml', 'aiFuTitles', 'aiFuFocus', 'aiFuToggle', 'aiFuGen', 'onAiFollowups', 'aiFuFail',
        'aiGenInfo', 'aiGenClean', 'aiGenOut', 'aiGenGet', 'aiGenSet', 'aiGenWord', 'aiGenTag', 'aiGenToggle', 'aiGenClose', 'aiGenOutside', 'aiGenKey', 'aiGenBlur',
        'aiGenHtml', 'aiGenRender', 'aiGenPlace', 'aiGenSync', 'aiGenThink', 'aiGenTemp', 'aiGenTempReset',
        'aiExplainConv', 'aiExplainBtn', 'aiExplainSaved', 'aiExplain', 'aiVerdict', 'aiExplainBody', 'aiExplainMeta', 'aiExplainHtml', 'aiExplainContinue',
        'aiWinText', 'aiSetWin', 'aiDiagOpen', 'aiDiagCancel', 'aiDiagSetupHtml', 'aiDiagnose', 'aiStatusWord', 'aiChips', 'aiDiagCard', 'aiTlRange', 'aiLaneClusters', 'aiTimelineHtml',
        'aiAskAbout', 'aiCopyCmd',
        'aiDlgOpen', 'aiDlgHtml', 'aiDlgPvHtml', 'aiDlgTab', 'aiDlgCat', 'aiDlgRem', 'aiDlgKey', 'aiDlgCancel', 'aiDlgSend', 'aiDlgClose',
        'aiInjectStyles'
    ];
    NAMES.forEach(function (n) {
        if (typeof obj[n] == 'function') { if (obj.exports.indexOf(n) < 0) obj.exports.push(n); }
        else console.log('EVENTLOG: missing UI function ' + n);
    });
};
