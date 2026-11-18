/**
* @description MeshCentral event log plugin: the Assistant on the device tab (Explain, Diagnosis, Ask, data preview)
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
        return { nodeid: nid, open: false, w: Number(getstore('evl_ai_w', '0')) || 0, convs: {}, chat: null, diag: null, explainBy: {},
                 focus: null, sel: null, draft: '', diagWin: win, notice: null, reveal: null, peek: null, hyp: {}, citeVer: 0 };
    };
    obj.aiStashSave = function () {
        var ph = pluginHandler.eventlog, st = ph.st;
        if (st == null || st.ai == null || !st.ai.nodeid) return;
        ph.aiAbortAll();
        ph.aiDlgClose(true);
        var a = st.ai, nid = a.nodeid;
        a.notice = null; a.reveal = null; a.peek = null; a._cm = null;
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
    };
    obj.aiNewTurn = function (n, q) {
        return { n: n, srvN: null, q: q, status: 'running', steps: [], text: '', live: '', html: '', sHtml: null, structured: null, cites: {}, invalid: [],
                 usage: null, followups: [], error: null, vote: null, lastSeq: 0, gap: false, segment: 0, t0: Date.now() };
    };
    obj.aiNewConv = function (mode, input, q) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        ph._aiSeq = (ph._aiSeq || 0) + 1;
        var c = { id: 'c' + ph._aiSeq, mode: mode, input: input, reqId: ph.aiReqId(), convId: null, status: 'starting', closed: false, ended: false,
                  info: null, notes: [], preview: null, red: null, last: Date.now(), doneAt: 0, turns: [ph.aiNewTurn(1, q)] };
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
            if (c.id == a.chat || c.id == a.diag || ph.aiBusy(c)) continue;
            ph.aiCloseConv(c);
            for (var k in a.explainBy) { if (a.explainBy[k] == c.id) delete a.explainBy[k]; }
            delete a.convs[c.id];
        }
    };
    obj.aiStartConv = function (c) {
        var ph = pluginHandler.eventlog;
        c.last = Date.now();
        ph.aiSendMsg('aiStart', { reqId: c.reqId, mode: c.mode, input: c.input });
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
        if (ph._aiDog) return;
        ph._aiDog = setInterval(function () { try { pluginHandler.eventlog.aiDog(); } catch (e) { } }, 5000);
    };
    obj.aiDog = function () {
        var ph = pluginHandler.eventlog, st = ph.st, any = false, now = Date.now();
        if (st == null || st.ai == null) { clearInterval(ph._aiDog); ph._aiDog = null; return; }
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
        if (!t || !(i >= 0 && i < 64) || Math.floor(i) !== i) return;
        t.steps[i] = { tool: String(m.tool || '').slice(0, 60), args: m.args, status: String(m.status || ''), items: Number(m.items) || 0, ms: Number(m.ms) || 0 };
        c.last = Date.now();
        if (c.status == 'starting') c.status = 'running';
        ph.aiSchedule(c, t);
    };
    obj.onAiDelta = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
        var c = ph.aiFind(m); if (!c || !ph.aiBusy(c)) return;
        var t = ph.aiTurn(c, m.turn), seq = Number(m.seq);
        if (!t || t.status != 'running' || !(seq > t.lastSeq)) return;
        if (seq !== t.lastSeq + 1) t.gap = true;   // a lost chunk: keep what we have, the final text replaces it
        else if (!t.gap && t.text.length < 400000) t.text += String(m.text == null ? '' : m.text);
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
        var cs = {}, src = (m.citations && typeof m.citations == 'object') ? m.citations : {};
        for (var r in src) {
            if (!/^E\d{1,6}$/.test(r)) continue;
            var v = src[r], rec = (v && v.rec && typeof v.rec == 'object') ? v.rec : v;
            if (!rec || typeof rec != 'object') continue;
            var ev = ph.elNormalize(rec);
            if (!ev) continue;
            cs[r] = { rec: rec, ev: ev, id: (rec._id != null) ? String(rec._id) : null };
        }
        t.cites = cs;
        t.text = String(m.text == null ? '' : m.text).slice(0, 400000);
        t.structured = (m.structured && typeof m.structured == 'object') ? m.structured : null;
        t.invalid = Array.isArray(m.invalidCitations) ? m.invalidCitations : [];
        t.usage = (m.usage && typeof m.usage == 'object') ? m.usage : null;
        t.followups = (Array.isArray(m.followups) ? m.followups : []).filter(function (f) { return typeof f == 'string' && f.trim(); }).slice(0, 3).map(function (f) { return f.slice(0, 200); });
        t.segment = Number(m.segment) || 0;
        t.status = 'done'; t.live = ''; t.sHtml = null;
        if (m.redactionCounts) c.red = m.redactionCounts;
        c.status = 'done'; c.doneAt = Date.now(); c.last = Date.now();
        t.html = ph.aiMd(t.text, c);
        a.focus = c.id; a.citeVer++;
        ph.aiRefresh(c, true);
        ph.aiSay(c.mode == 'diagnose' ? 'The diagnosis is ready.' : (c.mode == 'explain' ? 'The explanation is ready.' : 'The answer is ready.'));
    };
    obj.onAiError = function (server, m) {
        var ph = pluginHandler.eventlog;
        if (!ph.aiOk(m)) return;
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
        t.error = { code: code, message: msg.slice(0, 300), retryable: m.retryable === true };
        if (t.text) t.live = ph.aiMd(ph.aiVisible(t.text), c, { streaming: true });
        c.status = (code == 'aborted') ? 'stopped' : 'error';
        if (c.convId == null || code == 'invalid' && /no longer open/i.test(msg)) c.closed = (c.convId != null);
        if (code == 'denied') { try { ph.elRequestAccess(true); } catch (e) { } }
        ph.aiRefresh(c);
        if (code != 'aborted') ph.aiSay(ph.aiErrText(code));
    };

    // Re-render whatever shows this conversation.
    obj.aiRefresh = function (c, done) {
        var ph = pluginHandler.eventlog, st = ph.st;
        if (st == null || st.ai == null || !Q('evlWrap')) return;
        var a = st.ai;
        if (a.chat == c.id) ph.aiRenderPanel();
        if (a.diag == c.id) ph.aiRenderDiag();
        if (st.view != 'diag' && (c.mode == 'explain' || (done && a.focus == c.id))) ph.elUpdate();
        else ph.aiApplySel();
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
        t.live = t.text ? ph.aiMd(ph.aiVisible(t.text), c, { streaming: true }) : '';
        var log = Q('evlAiLog'), stick = log ? (log.scrollHeight - log.scrollTop - log.clientHeight < 48) : false;
        var nodes = document.querySelectorAll('#pluginEventLog [data-t="' + cid + '-' + n + '"]');
        for (var i = 0; i < nodes.length; i++) {
            var p = nodes[i].getAttribute('data-p');
            if (p == 'a') nodes[i].innerHTML = t.live || ph.aiWaitHtml(c, t);
            else if (p == 's') nodes[i].outerHTML = ph.aiStepsHtml(c, t);
        }
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
                return div.innerHTML;
            } catch (e) { }
        }
        return ph.aiMdFallback(src, vals, cites, cid, opts.streaming === true);
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
    obj.aiErrText = function (code) {
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
        var h = '<div class=evlAiErr role=alert><p>' + esc(ph.aiErrText(code)) + '</p>';
        if (e.message && ['model', 'badResponse', 'blocked', 'network', 'auth', 'invalid', 'refusal'].indexOf(code) >= 0) h += '<p class=evlAiMuted>' + esc(e.message) + '</p>';
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
        var n = t.steps.filter(function (x) { return x != null; }).length, u = t.usage || {}, parts = [];
        parts.push(n ? (n + (n == 1 ? ' step' : ' steps')) : 'No tools used');
        var ms = Number(u.ms) || 0;
        if (ms > 0) { var s = ms / 1000; parts.push(s < 10 ? s.toFixed(1) + ' s' : (s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s')); }
        var tok = (Number(u['in']) || 0) + (Number(u.out) || 0);
        if (tok > 0) parts.push((u.estimated ? 'about ' : '') + (tok < 1000 ? tok : (tok / 1000).toFixed(1) + 'k') + ' tokens');
        return parts.join(', ');
    };
    obj.aiStepsHtml = function (c, t) {
        var ph = pluginHandler.eventlog, esc = ph.aiEsc, key = c.id + '-' + t.n;
        var steps = t.steps.filter(function (x) { return x != null; });
        if (!steps.length) return '<div data-t=' + key + ' data-p=s hidden></div>';
        var running = (t.status == 'running');
        var open = (t.stepsOpen != null) ? t.stepsOpen : running;
        var h = '<details class=evlAiSteps data-t=' + key + ' data-p=s' + (open ? ' open' : '') + '><summary onclick="return pluginHandler.eventlog.aiStepsClick(\'' + c.id + '\',' + t.n + ',this)">' +
                (running ? 'Reading data, step ' + steps.length : esc(ph.aiUsageText(t))) + '</summary><div class=evlAiStepL>';
        t.steps.forEach(function (s, i) {
            if (s == null) return;
            var r = ph.aiStepResult(s);
            h += '<div class=evlAiStep><span class=n>' + (i + 1) + '</span><code>' + esc(s.tool) + '(' + esc(ph.aiArgsShort(s.args)) + ')</code><span class="r' + (s.status == 'error' ? ' err' : '') + '">' + esc(r) + '</span></div>';
        });
        return h + '</div></details>';
    };
    obj.aiStepsClick = function (cid, n, el) {
        var a = pluginHandler.eventlog.elState().ai, c = a.convs[cid];
        if (c) c.turns.forEach(function (t) { if (t.n == n) t.stepsOpen = !(el && el.parentNode && el.parentNode.open); });
        return true;
    };
    obj.aiWaitHtml = function (c, t) {
        var txt;
        if (c.status == 'preview') txt = 'Waiting for you to review what is sent.';
        else if (t.steps.length && t.steps[t.steps.length - 1] && t.steps[t.steps.length - 1].status == 'running') txt = 'Reading this device’s data…';
        else if (c.mode == 'explain') txt = 'Writing the explanation…';
        else if (c.mode == 'diagnose') txt = 'Working through the events…';
        else if (c.status == 'starting') txt = 'Sending the question…';
        else txt = 'Writing the answer…';
        return '<p class=evlAiWait>' + txt + '</p>';
    };
    // "qwen3:14b on gpu-01.lan (local, nothing replaced)"
    obj.aiInfoLine = function (c, short) {
        var ph = pluginHandler.eventlog, acc = (ph.elAccess && ph.elAccess.endpoint) || {}, info = (c && c.info) || {};
        var model = info.model || acc.model || '', name = info.endpointName || acc.name || '', net = ph.aiNetWord(info.network || acc.network);
        var red = (info.redacted != null && c && c.info) ? info.redacted : (acc.redactionForced === true);
        var cnt = ph.aiCounts(c && c.red), rep;
        if (cnt.total > 0) rep = cnt.total + (cnt.total == 1 ? ' value replaced' : ' values replaced');
        else if (c && c.red) rep = 'nothing replaced';
        else rep = red ? 'values are replaced before sending' : 'nothing replaced';
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
    obj.aiVoteHtml = function (c, t, target) {
        var mk = function (vote, label, path, aria) {
            return '<button class="evlBtn mini" aria-pressed=' + (t.vote == vote ? 'true' : 'false') + ' aria-label="' + aria + '" onclick="return pluginHandler.eventlog.aiVote(\'' + c.id + '\',' + t.n + ',\'' + target + '\',\'' + vote + '\')">' +
                   '<svg width=13 height=13 viewBox="0 0 16 16" fill=none stroke=currentColor stroke-width=1.7 aria-hidden=true><path d="' + path + '"/></svg>' + label + '</button>';
        };
        return mk('up', 'Helpful', 'M3 8.5l3.2 3.2L13 5', 'This helped') + mk('down', 'Not helpful', 'M4 4l8 8M12 4l-8 8', 'This did not help');
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
        if (s && c.mode == 'diagnose' && t.n == 1) {
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
    obj.aiVote = function (cid, n, target, vote, hid) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[cid], t = null;
        if (c) c.turns.forEach(function (x) { if (x.n == n) t = x; });
        if (!c || !t || !c.convId) return false;
        if (['up', 'down', 'wrong', 'reopen'].indexOf(vote) < 0 || ['answer', 'explain', 'hyp'].indexOf(target) < 0) return false;
        var m = { convId: c.convId, turn: (t.srvN != null) ? t.srvN : t.n, target: target, vote: vote };
        if (target == 'hyp') {
            if (typeof hid != 'string' || !/^[\w-]{1,20}$/.test(hid)) return false;
            if (a.hyp[cid + ':' + hid] == vote) return false;
            a.hyp[cid + ':' + hid] = vote; m.hid = hid;
        } else {
            if (t.vote == vote) return false;
            t.vote = vote;
        }
        t.sHtml = null;
        ph.aiSendMsg('aiFeedback', m);
        ph.aiRefresh(c);
        ph.aiSay(vote == 'wrong' ? 'Marked as wrong. Thanks for the feedback.' : (vote == 'reopen' ? 'Reopened.' : 'Thanks for the feedback.'));
        return false;
    };
    obj.aiRetry = function (cid) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[cid];
        if (!c || ph.aiBusy(c)) return false;
        var t = c.turns[c.turns.length - 1];
        if (c.mode == 'ask' && t.n > 1 && c.convId && !c.closed) {
            c.turns[c.turns.length - 1] = ph.aiNewTurn(t.n, t.q);
            c.status = 'running'; c.last = Date.now();
            ph.aiSendMsg('aiSend', { convId: c.convId, text: t.q });
            ph.aiDogStart();
        } else if (c.mode == 'ask' && t.n > 1) {
            a.chat = null; ph.aiAsk(t.q); return false;
        } else {
            ph.aiCloseConv(c);
            c.convId = null; c.closed = false; c.ended = false; c.reqId = ph.aiReqId(); c.info = null; c.notes = []; c.preview = null; c.red = null;
            c.turns = [ph.aiNewTurn(1, c.turns[0].q)]; c.status = 'starting';
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
        var cm = { v: a.citeVer, f: fid, cid: fid, byKey: {}, bySig: {}, byId: {}, n: 0 };
        var push = function (map, k, r) { if (k == null) return; if (!map[k]) map[k] = []; if (map[k].indexOf(r) < 0) map[k].push(r); };
        var c = fid ? a.convs[fid] : null;
        if (c) c.turns.forEach(function (t) {
            for (var r in t.cites) { var ci = t.cites[r]; push(cm.byKey, ci.ev.key, r); push(cm.bySig, ci.ev.sig, r); push(cm.byId, ci.id, r); cm.n++; }
        });
        a._cm = cm;
        return cm;
    };
    obj.aiRowRefs = function (r, cm) {
        var ev = r.ev, id = (ev._raw && ev._raw._id != null) ? String(ev._raw._id) : null;
        var refs = cm.byKey[ev.key] || (id != null ? cm.byId[id] : null) || null, inside = false;
        if (!refs && r.count > 1 && cm.bySig[ev.sig]) { refs = cm.bySig[ev.sig]; inside = true; }
        return refs ? { refs: refs, inside: inside } : null;
    };
    obj.aiGutterTd = function (r, cm) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, x = ph.aiRowRefs(r, cm);
        if (!x || !/^c\d+$/.test(cm.cid)) return '<td class=evlCCite></td>';
        var ref = x.refs[0];
        var lab = x.inside ? ('Cited as ' + ref + '. The cited occurrence is inside this group of ' + r.count) : ('Cited as ' + ref);
        return '<td class=evlCCite><button type=button class="evlCite' + (x.inside ? ' in' : '') + (a.sel == ref ? ' sel' : '') + '" data-c=' + cm.cid + ' data-r=' + ref +
               ' aria-label="' + lab + '" title="' + (x.inside ? 'Cited occurrence inside &times;' + r.count : 'Cited as ' + ref) + '"' +
               ' onclick="event.stopPropagation();return pluginHandler.eventlog.aiGutter(\'' + cm.cid + '\',\'' + ref + '\')">' + ref + '</button>' +
               (x.refs.length > 1 ? '<span class=evlCiteMore>+' + (x.refs.length - 1) + '</span>' : '') + '</td>';
    };
    obj.aiApplySel = function () {
        var a = pluginHandler.eventlog.elState().ai, f = a.focus || a.chat;
        var nodes = document.querySelectorAll('#pluginEventLog .evlCite[data-r]');
        for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('sel', !!a.sel && nodes[i].getAttribute('data-r') == a.sel && nodes[i].getAttribute('data-c') == f);
    };
    // Gutter chip: highlight the ref in the answer that cited it.
    obj.aiGutter = function (cid, ref) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        a.sel = ref; a.focus = cid;
        ph.aiApplySel();
        var log = Q('evlAiLog'), chip = log ? log.querySelector('.evlCite[data-c="' + cid + '"][data-r="' + ref + '"]') : null;
        if (chip) { var r1 = chip.getBoundingClientRect(), r0 = log.getBoundingClientRect(); if (r1.top < r0.top || r1.bottom > r0.bottom) log.scrollTop += (r1.top - r0.top) - log.clientHeight / 3; }
        return false;
    };
    // Answer chip: find the cited event in the table, select it, flash it and scroll it into view.
    obj.aiGotoCite = function (cid, ref) {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai, c = a.convs[cid];
        if (!/^E\d{1,6}$/.test(String(ref))) return false;
        var ci = ph.aiCite(c, ref);
        if (!ci) return false;
        if (a.focus != cid) a.citeVer++;
        a.focus = cid; a.sel = ref; a.notice = null; a.peek = null;
        if (st.view == 'diag' || (!ph.elCan('live') && !ph.elCan('history'))) {
            if (!ph.elCan('history')) { a.peek = { cid: cid, ref: ref, where: (st.view == 'diag' && a.diag == cid) ? 'diag' : 'panel' }; ph.aiRenderPeek(); ph.aiApplySel(); return false; }
            st.view = 'history';
            ph.elRenderShell();
        }
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
        st.ai.focus = cid; st.ai.citeVer++;
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
        var ph = pluginHandler.eventlog, a = ph.elState().ai, h = ph.aiPeekHtml();
        var p1 = Q('evlAiPeekSlot'), p2 = Q('evlDiagPeekSlot');
        var where = a.peek ? a.peek.where : null;
        if (where == 'diag' && !p2) where = 'panel';
        if (where == 'panel' && !p1 && p2) where = 'diag';
        if (p1) p1.innerHTML = (where == 'panel') ? h : '';
        if (p2) p2.innerHTML = (where == 'diag') ? h : '';
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
        var w = wrap.clientWidth, lim = (st.layout == 'viewer' && st.view != 'diag') ? 1150 : 900;
        var was = main.classList.contains('evlStack');
        var stack = (w > 0) ? (was ? (w < lim + 24) : (w < lim)) : was;   // a little hysteresis: no flip-flop at the edge
        main.classList.toggle('evlStack', stack);
        main.classList.toggle('evlDiagOn', st.view == 'diag');
        main.style.setProperty('--evl-ai-w', (st.ai.w || 400) + 'px');
        if (stack != was) ph.elFitHeight();
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
        a.open = !a.open;
        ph.aiRenderPanel();
        setTimeout(function () { try { var el = Q(pluginHandler.eventlog.elState().ai.open ? 'evlAiIn' : 'evlAiBtn'); if (el) el.focus(); } catch (e) { } }, 0);
        return false;
    };
    obj.aiClosePanel = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        a.open = false;
        ph.aiRenderPanel();
        var b = Q('evlAiBtn'); if (b) b.focus();
        return false;
    };
    obj.aiRenderPanel = function () {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai, el = Q('evlAi');
        var btn = Q('evlAiBtn');
        if (btn) { btn.setAttribute('aria-expanded', a.open ? 'true' : 'false'); btn.classList.toggle('on', a.open); }
        if (!el) return;
        if (!a.open || !ph.elCan('assistant')) {
            if (!el.hidden) { el.hidden = true; el.innerHTML = ''; }
            ph.aiLayout();
            return;
        }
        el.hidden = false;
        if (!Q('evlAiLog')) {
            el.innerHTML = '<div class=evlAiIn>' +
                '<div class=evlAiSplit role=separator tabindex=0 aria-orientation=vertical aria-label="Resize the assistant panel" title="Drag to resize, double-click to reset"' +
                ' onpointerdown="return pluginHandler.eventlog.aiSplitDown(event)" ondblclick="return pluginHandler.eventlog.aiSplitReset()" onkeydown="return pluginHandler.eventlog.aiSplitKey(event)"></div>' +
                '<div class=evlAiHd id=evlAiHd></div>' +
                '<div class=evlAiLog id=evlAiLog role=log aria-live=polite aria-busy=false aria-label="Conversation"></div>' +
                '<div class=evlAiFt id=evlAiFt></div></div>';
        }
        var c = a.convs[a.chat] || null;
        QH('evlAiHd', ph.aiHeadHtml(c));
        var log = Q('evlAiLog'), lt = c ? c.turns[c.turns.length - 1] : null, sig = c ? c.id + ':' + c.turns.length : '';
        var stick = (log.scrollHeight - log.scrollTop - log.clientHeight < 48) || log._evlConv != sig;
        var justDone = (lt != null && lt.status == 'done' && log._evlDone != sig);   // a finished answer: show it from its start
        var top = log.scrollTop;
        log.setAttribute('aria-busy', ph.aiBusy(c) ? 'true' : 'false');
        log.innerHTML = ph.aiLogHtml(c);
        var turns = log.querySelectorAll('.evlAiTurn'), lastEl = turns.length ? turns[turns.length - 1] : null;
        if (justDone && lastEl && log._evlConv == sig) log.scrollTop = Math.max(0, lastEl.offsetTop - 8);
        else log.scrollTop = stick ? log.scrollHeight : top;
        log._evlConv = sig;
        if (lt != null && lt.status == 'done') log._evlDone = sig;
        ph.aiRenderComposer();
        ph.aiApplySel();
        ph.aiLayout();
    };
    obj.aiHeadHtml = function (c) {
        var ph = pluginHandler.eventlog, line = ph.aiInfoLine(c);
        return '<div class=evlAiTitle><h2>Ask</h2>' + (line ? '<div class=evlAiSub>' + ph.aiEsc(line) + '</div>' : '') + ph.aiNotesHtml(c) + '</div>' +
               '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiNewChat()"' + (c ? '' : ' disabled') + '>New chat</button>' +
               '<button class="evlBtn mini evlAiX" aria-label="Close the assistant" title="Close" onclick="return pluginHandler.eventlog.aiClosePanel()">' +
               '<svg width=13 height=13 viewBox="0 0 16 16" fill=none stroke=currentColor stroke-width=1.8 aria-hidden=true><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button>';
    };
    obj.aiStarters = function () {
        return ['Why did this device restart recently?', 'What changed in the last 24 hours?', 'Are there signs of disk or hardware problems?'];
    };
    obj.aiIntroHtml = function () {
        var ph = pluginHandler.eventlog, acc = ph.elAccess || {};
        if (acc.assistantReason == 'noEndpoint') return '<div class=evlAiIntro><p>' + ph.aiEsc(ph.aiErrText('noEndpoint')) + ' An administrator can assign one in the plugin\'s Config Sets.</p></div>';
        var h = '<div class=evlAiIntro><p>Ask about this device in plain words. The assistant reads its stored events and device details. Answers point to the events they rely on, marked like <span class="evlCite static">E1</span>; select one to find it in the table.</p><div class=evlAiFollow>';
        ph.aiStarters().forEach(function (s, i) { h += '<button class=evlBtn onclick="return pluginHandler.eventlog.aiStarter(' + i + ')">' + ph.aiEsc(s) + '</button>'; });
        return h + '</div></div>';
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
        c.turns.forEach(function (t, i) { h += ph.aiTurnHtml(c, t, i == c.turns.length - 1); });
        if (c.ended && !ph.aiBusy(c)) h += '<div class=evlAiNoteBox>This conversation ended on the server after a while without questions. <button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiNewChat()">New chat</button></div>';
        return h;
    };
    obj.aiTurnHtml = function (c, t, isLast) {
        var ph = pluginHandler.eventlog, esc = ph.aiEsc, key = c.id + '-' + t.n;
        var h = '<div class=evlAiTurn>';
        if (t.segment && isLast && t.status == 'done') h += '<div class=evlAiSeg>Earlier answers were summarized to fit the model\'s context</div>';
        h += '<div class=evlAiQ>' + esc(t.q).replace(/\n/g, '<br>') + '</div>';
        if (c.status == 'preview' && isLast) h += '<div class=evlAiNoteBox>Waiting for you to review what is sent. <button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiDlgOpen(\'' + c.id + '\')">Review</button></div>';
        h += ph.aiStepsHtml(c, t);
        if (t.status == 'done') h += ph.aiDoneBody(c, t, 'panel');
        else if (t.status == 'running') h += '<div class="evlAiA evlAiMd" data-t=' + key + ' data-p=a>' + (t.live || ph.aiWaitHtml(c, t)) + '</div>';
        else if (t.live) h += '<div class="evlAiA evlAiMd">' + t.live + '</div>';
        if (t.status == 'stopped') h += '<p class=evlAiMuted>Stopped.</p>';
        if (t.status == 'cancelled') h += '<p class=evlAiMuted>Cancelled. Nothing was sent to the model.</p>';
        if (t.status == 'error') h += ph.aiErrHtml(c, t);
        if (t.status == 'done') {
            h += '<div class=evlAiActs><button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiCopyTurn(\'' + c.id + '\',' + t.n + ',this)">Copy</button>';
            if (!(c.mode == 'diagnose' && t.n == 1)) h += ph.aiVoteHtml(c, t, (c.mode == 'explain' && t.n == 1) ? 'explain' : 'answer');
            h += '</div>';
            if (isLast && t.followups.length && c.mode == 'ask' && !c.closed) {
                h += '<div class=evlAiFollow role=group aria-label="Suggested follow-up questions">';
                t.followups.forEach(function (f, i) { h += '<button class=evlBtn onclick="return pluginHandler.eventlog.aiFollow(\'' + c.id + '\',' + t.n + ',' + i + ')">' + esc(ph.aiStripMarks(f)) + '</button>'; });
                h += '</div>';
            }
        }
        return h + '</div>';
    };
    obj.aiDoneBody = function (c, t, surface) {
        var ph = pluginHandler.eventlog;
        if (c.mode == 'explain' && t.n == 1 && t.structured) return '<div class=evlAiA>' + ph.aiExplainBody(c, t) + '</div>';
        if (c.mode == 'diagnose' && t.n == 1 && t.structured) {
            return '<div class="evlAiA evlAiMd">' + ph.aiMd(t.structured.summary || '', c) + '</div>' +
                   (surface == 'panel' ? '<p><button class=evlLinkBtn onclick="return pluginHandler.eventlog.elSetView(\'diag\')">Open the full diagnosis</button></p>' : '');
        }
        if (!t.text.trim()) return '<p class=evlAiMuted>The model returned an empty answer.</p>';
        return '<div class="evlAiA evlAiMd">' + t.html + '</div>';
    };
    obj.aiRenderComposer = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.chat], busy = ph.aiBusy(c), ft = Q('evlAiFt');
        if (!ft) return;
        if (!Q('evlAiIn')) {
            var acc = ph.elAccess || {}, name = (typeof currentNode != 'undefined' && currentNode) ? currentNode.name : 'this device';
            ft.innerHTML = '<div id=evlAiPeekSlot></div><label for=evlAiIn class=evlAiLbl>Ask about ' + ph.aiEsc(name) + '</label>' +
                '<div class=evlAiRow><textarea id=evlAiIn rows=2 maxlength=4000 onkeydown="return pluginHandler.eventlog.aiKey(event)" oninput="pluginHandler.eventlog.aiDraft(this)"></textarea>' +
                '<button id=evlAiSend class="evlBtn on" onclick="return pluginHandler.eventlog.aiSubmit()">Send</button></div>' +
                '<div class=evlAiDisc>Answers can be wrong. Check the cited events before acting.' + ((function (r) { var q = (typeof r == 'number') ? r : ((r != null && typeof r.questions == 'number') ? r.questions : null); return (q != null && q <= 10) ? ' ' + q + ' questions left today.' : ''; })(acc.remaining)) + '</div>';
            Q('evlAiIn').value = a.draft || '';
        }
        var b = Q('evlAiSend');
        b.textContent = busy ? 'Stop' : 'Send';
        b.classList.toggle('on', !busy);
        b.setAttribute('aria-label', busy ? 'Stop the answer' : 'Send the question');
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
        a.draft = '';
        var ta = Q('evlAiIn'); if (ta) ta.value = '';
        var c = a.convs[a.chat];
        if (c && c.mode == 'ask' && c.convId && !c.closed && !ph.aiBusy(c) && c.status != 'cancelled') {
            var last = c.turns[c.turns.length - 1];
            c.turns.push(ph.aiNewTurn((last ? last.n : 0) + 1, text));
            c.status = 'running'; c.last = Date.now();
            ph.aiSendMsg('aiSend', { convId: c.convId, text: text });
            ph.aiDogStart();
        } else {
            if (c && c.mode == 'ask') ph.aiCloseConv(c);
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
    obj.aiNewChat = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.chat];
        if (c && c.mode == 'ask') { if (ph.aiBusy(c)) ph.aiStop(c.id); ph.aiCloseConv(c); delete a.convs[c.id]; }
        if (c && a.focus == c.id) { a.focus = null; a.sel = null; }
        a.chat = null; a.peek = null; a.citeVer++;
        a.open = true;
        ph.aiRenderPanel();
        if (ph.elState().view != 'diag') ph.elUpdate();
        var ta = Q('evlAiIn'); if (ta) ta.focus();
        return false;
    };
    // Put a question into the composer without sending it (the user reviews and sends).
    obj.aiPrefill = function (text) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.chat];
        if (c && c.mode != 'ask') a.chat = null;
        a.draft = String(text).slice(0, 4000);
        a.open = true;
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
        return '<button class="evlBtn mini evlAiGo" onclick="event.stopPropagation();return pluginHandler.eventlog.aiExplain(\'' + ev.key + '\')">Explain this event</button>';
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
        return (line ? line + '. ' : '') + red;
    };
    obj.aiExplainHtml = function (ev) {
        var ph = pluginHandler.eventlog, c = ph.aiExplainConv(ev), esc = ph.aiEsc;
        if (!c) return '';
        var t = c.turns[0], key = c.id + '-' + t.n, busy = ph.aiBusy(c);
        var h = '<section class=evlAiEx aria-label="Explanation" onclick="event.stopPropagation()"><div class=evlAiExHd><h3>Explain this event</h3>';
        if (busy) h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiStop(\'' + c.id + '\')">Stop</button>';
        else if (t.status == 'done') h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiExplainContinue(\'' + c.id + '\')">Continue in Ask</button>' +
                                        '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiCopyTurn(\'' + c.id + '\',1,this)">Copy</button>';
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
                 ' Answers can be wrong.</span>' + ph.aiVoteHtml(c, t, 'explain') + '</div>';
        } else {
            h += ph.aiStepsHtml(c, t);
            if (t.status == 'running') h += '<div class="evlAiA evlAiMd" data-t=' + key + ' data-p=a>' + (t.live || ph.aiWaitHtml(c, t)) + '</div>';
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

    // ---- Diagnosis ------------------------------------------------------------------------------------------------
    obj.aiWinText = function (w) {
        return ({ '24h': 'the last 24 hours', '7d': 'the last 7 days', restart: 'around the last restart' })[w] || 'the last 24 hours';
    };
    obj.aiSetWin = function (v) {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (['24h', '7d', 'restart'].indexOf(v) < 0) return false;
        a.diagWin = v; putstore('evl_diag_win', v);
        ph.aiRenderDiag();
        return false;
    };
    obj.aiDiagnose = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai;
        if (!ph.elCan('assistant')) return false;
        var old = a.convs[a.diag];
        if (old && ph.aiBusy(old)) return false;
        if (old) ph.aiCloseConv(old);
        var w = a.diagWin;
        var c = ph.aiNewConv('diagnose', { window: w }, 'Diagnose ' + ph.aiWinText(w));
        c.win = w;
        a.diag = c.id;
        ph.aiStartConv(c);
        ph.aiRenderDiag();
        ph.aiSay('Diagnosis started.');
        return false;
    };
    obj.aiDiagTbHtml = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.diag], esc = ph.aiEsc;
        if (ph.aiBusy(c)) return '<button class=evlBtn onclick="return pluginHandler.eventlog.aiStop(\'' + c.id + '\')">Stop</button><span class=evlLbl>' + (c.status == 'preview' ? 'Waiting for your review' : 'Diagnosing…') + '</span>';
        var done = (c && c.status == 'done');
        var h = '<button class="evlBtn on" onclick="return pluginHandler.eventlog.aiDiagnose()">' + (done ? 'Diagnose again' : 'Diagnose') + '</button>';
        if (done) { var line = ph.aiInfoLine(c, true).replace(/ \([^)]*\)$/, ''); h += '<span class=evlLbl>Generated ' + esc(ph.aiTimeShort(c.doneAt)) + (line ? ' by ' + esc(line) : '') + '</span>'; }
        return h;
    };
    obj.aiRenderDiag = function () {
        var ph = pluginHandler.eventlog, st = ph.elState(), el = Q('evlDiag');
        var tb = Q('evlDiagTb'); if (tb) tb.innerHTML = ph.aiDiagTbHtml();
        if (!el) return;
        var on = (st.view == 'diag');
        el.hidden = !on;
        var b = Q('evlBody'); if (b) b.hidden = on;
        var ch = Q('evlChips'); if (ch) ch.hidden = on;
        if (!on) { if (el.innerHTML) el.innerHTML = ''; return; }
        el.innerHTML = ph.aiDiagHtml();
        ph.aiRenderPeek();
        ph.aiApplySel();
        ph.aiLayout();
    };
    obj.aiDiagHtml = function () {
        var ph = pluginHandler.eventlog, a = ph.elState().ai, c = a.convs[a.diag], esc = ph.aiEsc, acc = ph.elAccess || {};
        if (!c) {
            var line = ph.aiInfoLine(null);
            return '<div class=evlDiagEmpty><h2>Diagnose this device</h2>' +
                   '<p>The assistant reads the events stored for this device in the chosen window, sorts out what happened and suggests likely causes, with the events it relied on. It runs only when you start it, because each run uses the model.</p>' +
                   (acc.assistantReason == 'noEndpoint' ? '<p>' + esc(ph.aiErrText('noEndpoint')) + '</p>' : (line ? '<p class=evlAiMuted>' + esc(line) + '</p>' : '')) +
                   '<p><button class="evlBtn on" onclick="return pluginHandler.eventlog.aiDiagnose()">Diagnose ' + esc(ph.aiWinText(a.diagWin)) + '</button></p></div>';
        }
        var t = c.turns[0], key = c.id + '-' + t.n;
        if (t.status == 'done') return ph.aiDiagDone(c, t);
        var h = '<div class=evlDiagRun><h2>' + (t.status == 'error' ? 'The diagnosis did not finish' : 'Diagnosing ' + esc(ph.aiWinText(c.win))) + '</h2>' + ph.aiNotesHtml(c);
        if (c.status == 'preview') h += '<div class=evlAiNoteBox>Waiting for you to review what is sent. <button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiDlgOpen(\'' + c.id + '\')">Review</button></div>';
        h += ph.aiStepsHtml(c, t);
        if (t.status == 'running') h += '<div class="evlAiA evlAiMd evlDiagStream" data-t=' + key + ' data-p=a>' + (t.live || ph.aiWaitHtml(c, t)) + '</div>';
        else if (t.live) h += '<div class="evlAiA evlAiMd evlDiagStream">' + t.live + '</div>';
        if (t.status == 'error') h += ph.aiErrHtml(c, t);
        if (t.status == 'stopped') h += '<p class=evlAiMuted>Stopped. Start it again with Diagnose.</p>';
        if (t.status == 'cancelled') h += '<p class=evlAiMuted>Cancelled. Nothing was sent to the model.</p>';
        return h + '</div>';
    };
    obj.aiStatusWord = function (s) {
        return ({ likely: 'Likely', possible: 'Possible', ruled_out: 'Ruled out' })[s] || 'Possible';
    };
    obj.aiChips = function (c, refs) {
        var ph = pluginHandler.eventlog, out = [];
        (Array.isArray(refs) ? refs : []).forEach(function (r) { if (typeof r == 'string' && /^E\d{1,6}$/.test(r) && ph.aiCite(c, r) && out.indexOf(r) < 0) out.push(r); });
        return out.map(function (r) { return ph.aiChipHtml(c.id, r); }).join(' ');
    };
    obj.aiDiagDone = function (c, t) {
        var ph = pluginHandler.eventlog, st = ph.elState(), a = st.ai, s = t.structured, esc = ph.aiEsc;
        if (t.sHtml) return t.sHtml;
        var md = function (x) { return ph.aiMd(x, c); };
        var title = (c.win == 'restart') ? 'What happened around the last restart' : 'What happened in ' + ph.aiWinText(c.win);
        var h = '<div class=evlDiagHead><h2>' + title + '</h2>';
        if (!s) {
            h += '<div class="evlAiMd evlDiagSum">' + (t.text.trim() ? t.html : '<p>The model returned an empty answer.</p>') + '</div></div>';
            h += '<div class=evlDiagFoot>' + ph.aiStepsHtml(c, t) + '</div>';
            t.sHtml = h;
            return h;
        }
        if (s.summary) h += '<div class="evlAiMd evlDiagSum">' + md(s.summary) + '</div>';
        h += '</div>';
        if (Array.isArray(s.lanes) && s.lanes.some(function (l) { return l && Array.isArray(l.markers) && l.markers.length; })) h += ph.aiTimelineHtml(c, s);
        h += '<div class=evlDiagCols><section class=evlDiagMain aria-label="Possible causes and next steps">';
        var hyps = Array.isArray(s.hypotheses) ? s.hypotheses : [];
        if (hyps.length) {
            h += '<h3>Possible causes</h3>';
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
                if (hid && c.convId) {
                    h += '<div class=evlAiActs>';
                    if (cls != 'wrong' && status != 'ruled_out') h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiAskAbout(\'' + c.id + '\',\'' + hid + '\')">Ask about this</button>';
                    if (cls == 'wrong' || (status == 'ruled_out' && fb != 'reopen')) h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiVote(\'' + c.id + '\',1,\'hyp\',\'reopen\',\'' + hid + '\')">Reopen</button>';
                    else h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.aiVote(\'' + c.id + '\',1,\'hyp\',\'wrong\',\'' + hid + '\')">This is wrong</button>';
                    h += '</div>';
                }
                h += '</div></div>';
            });
        }
        var steps = Array.isArray(s.nextSteps) ? s.nextSteps : [], anyCmd = false;
        if (steps.length) {
            h += '<h3>Next steps</h3><ol class=evlNext>';
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
        h += '</section><aside class=evlDiagSide aria-label="Evidence">';
        var evid = (Array.isArray(s.evidence) ? s.evidence : []).filter(function (e) { return e && ph.aiCite(c, e.cite); });
        if (!evid.length) { var all = ph.aiCitesOf(c); evid = Object.keys(all).sort(function (x, y) { return Number(x.slice(1)) - Number(y.slice(1)); }).map(function (r) { return { cite: r, note: '' }; }); }
        h += '<div id=evlDiagPeekSlot></div>';
        if (evid.length) {
            h += '<h3>Evidence</h3>';
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
            h += '<h3>Not explained</h3><ul class=evlUnx>';
            unx.forEach(function (u) { var ch = ph.aiChips(c, u.cites); h += '<li><div class=evlAiMd>' + md(u.text || '') + '</div>' + (ch ? '<div class=evlHypEv>' + ch + '</div>' : '') + '</li>'; });
            h += '</ul>';
        }
        h += '<div class=evlDiagFoot>' + ph.aiStepsHtml(c, t) + '</div></aside></div>';
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
                sr += '<tr><td>' + ph.aiPlain(lane.label) + '</td><td>' + esc(ph.elFmtTime(m.t)) + (typeof m.t2 == 'number' && m.t2 > m.t ? ' to ' + esc(ph.elFmtTime(m.t2)) : '') + '</td><td>' + ph.aiPlain(m.label) + '</td><td>' + ph.aiChips(c, m.cites) + '</td></tr>';
            });
        });
        return h + '</div></div>' + sr + '</tbody></table>';
    };
    obj.aiAskAbout = function (cid, hid) {
        var ph = pluginHandler.eventlog, c = ph.elState().ai.convs[cid], hy = null;
        if (!c || !c.turns[0].structured) return false;
        (c.turns[0].structured.hypotheses || []).forEach(function (x) { if (x.id === hid) hy = x; });
        if (!hy) return false;
        return ph.aiPrefill('The diagnosis of ' + ph.aiWinText(c.win) + ' says: "' + ph.aiStripMarks(hy.title) + '". How sure is that, and how can I confirm it?');
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
        h += '<div class=evlDlgFt><label class=evlDlgRem><input type=checkbox' + (d.remember ? ' checked' : '') + ' onchange="pluginHandler.eventlog.aiDlgRem(this.checked)"> Do not ask again for this endpoint</label>' +
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
#pluginEventLog .evlAi { flex:0 0 var(--evl-ai-w, 400px); max-width:60%; align-self:stretch; position:relative; min-height:440px; margin-left:10px; border:1px solid var(--evl-line); border-radius:3px; background:var(--evl-panel); }
#pluginEventLog .evlAiIn { position:absolute; top:0; right:0; bottom:0; left:0; display:flex; flex-direction:column; min-height:0; }
#pluginEventLog .evlMain.evlStack { flex-direction:column; align-items:stretch; }
#pluginEventLog .evlMain.evlStack .evlCol { align-self:stretch; }
#pluginEventLog .evlMain.evlStack .evlAi { flex:none; max-width:none; margin:10px 0 0; height:min(75vh, 680px); min-height:360px; }
#pluginEventLog .evlMain.evlDiagOn:not(.evlStack) .evlAi { align-self:flex-start; position:sticky; top:0; height:min(82vh, 780px); }
#pluginEventLog .evlAiSplit { position:absolute; left:-7px; top:0; bottom:0; width:11px; cursor:col-resize; z-index:2; touch-action:none; outline:none; }
#pluginEventLog .evlAiSplit:hover, #pluginEventLog .evlAiSplit.active, #pluginEventLog .evlAiSplit:focus-visible { background:linear-gradient(to right, transparent 5px, var(--evl-acc) 5px, var(--evl-acc) 7px, transparent 7px); }
#pluginEventLog .evlStack .evlAiSplit { display:none; }
#pluginEventLog .evlAiHd { display:flex; align-items:flex-start; gap:6px; padding:9px 10px 9px 13px; border-bottom:1px solid var(--evl-line2); }
#pluginEventLog .evlAiTitle { flex:1 1 auto; min-width:0; }
#pluginEventLog .evlAiHd h2 { margin:0; font-size:15px; font-weight:bold; color:var(--evl-ink); line-height:1.3; }
#pluginEventLog .evlAiSub { font-size:12px; color:var(--evl-muted); overflow-wrap:anywhere; }
#pluginEventLog .evlAiNoteLine { font-size:12px; color:var(--evl-warn); margin:4px 0 0; line-height:1.4; }
#pluginEventLog .evlAiHd .evlBtn { white-space:nowrap; flex:none; }
#pluginEventLog .evlAiX { display:inline-flex; align-items:center; padding:3px 6px; }
#pluginEventLog .evlAiLog { position:relative; flex:1 1 auto; overflow-y:auto; padding:12px 13px; display:flex; flex-direction:column; gap:14px; min-height:0; overscroll-behavior:contain; }
#pluginEventLog .evlAiTurn { display:flex; flex-direction:column; gap:9px; }
#pluginEventLog .evlAiQ { align-self:flex-end; max-width:88%; background:var(--evl-bubble); border:1px solid var(--evl-bubble-line); border-radius:6px; padding:7px 10px; line-height:1.45; overflow-wrap:anywhere; }
#pluginEventLog .evlAiSeg { align-self:stretch; text-align:center; font-size:11px; color:var(--evl-muted); border-top:1px dashed var(--evl-line); padding-top:4px; }
#pluginEventLog .evlAiIntro p { margin:0 0 10px; line-height:1.5; color:var(--evl-ink); }
#pluginEventLog .evlAiFollow { display:flex; flex-wrap:wrap; gap:6px; }
#pluginEventLog .evlAiFollow .evlBtn { text-align:left; white-space:normal; line-height:1.35; }
#pluginEventLog .evlAiActs { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
#pluginEventLog .evlBtn[aria-pressed=true] { background:var(--evl-sel); border-color:var(--evl-acc); }
#pluginEventLog .evlBtn[disabled] { opacity:.5; cursor:default; }
#pluginEventLog .evlBtn svg { vertical-align:-2px; margin-right:4px; }
#pluginEventLog .evlLinkBtn { border:0; background:none; padding:0; font:inherit; color:var(--evl-acc); text-decoration:underline; cursor:pointer; }
#pluginEventLog .evlLinkBtn:focus-visible, #pluginEventLog .evlAiX:focus-visible { outline:2px solid var(--evl-acc); outline-offset:1px; }
#pluginEventLog .evlAiMuted { color:var(--evl-muted); font-size:12px; margin:0; line-height:1.45; }
#pluginEventLog .evlAiWait { color:var(--evl-muted); margin:0; }
#pluginEventLog .evlAiNoteBox { border:1px solid var(--evl-line2); background:var(--evl-alt); border-radius:3px; padding:7px 10px; font-size:12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
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
#pluginEventLog .evlAiFt { border-top:1px solid var(--evl-line2); padding:9px 12px 10px; background:var(--evl-bg); border-radius:0 0 3px 3px; }
#pluginEventLog .evlAiLbl { display:block; font-size:12px; color:var(--evl-muted); margin:0 0 4px; font-weight:normal; }
#pluginEventLog .evlAiRow { display:flex; gap:8px; align-items:flex-end; }
#pluginEventLog .evlAiRow textarea { flex:1 1 auto; min-width:0; font:inherit; border:1px solid var(--evl-line); background:var(--evl-input); color:var(--evl-ink); border-radius:3px; padding:6px 8px; resize:vertical; min-height:42px; max-height:220px; box-sizing:border-box; }
#pluginEventLog .evlAiRow textarea:focus-visible { outline:2px solid var(--evl-acc); outline-offset:-1px; }
#pluginEventLog .evlAiRow .evlBtn { min-height:42px; min-width:66px; }
#pluginEventLog .evlAiDisc { font-size:11px; color:var(--evl-muted); margin-top:6px; line-height:1.4; }
#pluginEventLog .evlAiPeek { border:1px solid var(--evl-acc); border-radius:3px; background:var(--evl-bg); margin:0 0 8px; font-size:12px; }
#pluginEventLog .evlAiPeekH { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:5px 6px 5px 8px; border-bottom:1px solid var(--evl-line2); }
#pluginEventLog .evlAiPeekH .evlBtn { margin-left:auto; }
#pluginEventLog .evlAiPeekM { padding:6px 8px; white-space:pre-wrap; max-height:150px; overflow:auto; overflow-wrap:anywhere; line-height:1.4; }
#pluginEventLog .evlAiUnv { color:var(--evl-muted); font-size:11px; }
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
#pluginEventLog table.evlLog th.evlCCite, #pluginEventLog table.evlLog td.evlCCite { padding-left:6px; padding-right:2px; overflow:visible; cursor:default; }
#pluginEventLog table.evlLog tr.evlFlash td { animation:evlFlash 1.5s ease-out 1; }
#pluginEventLog table.evlLog tr.evlFlash td:first-child { box-shadow:inset 3px 0 0 var(--evl-acc); }
@keyframes evlFlash { 0%, 25% { background:var(--evl-acc); color:var(--evl-acc-ink); } 100% { background:var(--evl-sel); } }
@media (prefers-reduced-motion: reduce) { #pluginEventLog table.evlLog tr.evlFlash td { animation:none; } }
#pluginEventLog .evlAiNote { flex-basis:100%; display:flex; align-items:center; gap:8px; flex-wrap:wrap; border:1px solid var(--evl-acc); border-radius:3px; background:var(--evl-bg); padding:4px 6px 4px 10px; font-size:12px; }
/* Explain */
#pluginEventLog .evlAiEx { margin-top:12px; padding:11px 14px 12px; background:var(--evl-panel); border:1px solid var(--evl-line2); border-radius:3px; max-width:110ch; cursor:auto; white-space:normal; }
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
/* Diagnosis */
#pluginEventLog .evlDiag { padding:2px 2px 14px; }
#pluginEventLog .evlDiag h2 { font-size:18px; font-weight:bold; margin:8px 0 4px; color:var(--evl-ink); }
#pluginEventLog .evlDiag h3 { font-size:15px; font-weight:bold; margin:18px 0 6px; color:var(--evl-ink); }
#pluginEventLog .evlDiagTb { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; }
#pluginEventLog .evlDiagEmpty { max-width:76ch; padding:8px 0; }
#pluginEventLog .evlDiagEmpty p, #pluginEventLog .evlDiagRun > p { line-height:1.5; margin:0 0 10px; }
#pluginEventLog .evlDiagRun { max-width:90ch; display:flex; flex-direction:column; gap:10px; }
#pluginEventLog .evlDiagSum { font-size:14px; max-width:76ch; margin:0 0 12px; }
#pluginEventLog .evlTl { overflow-x:auto; border:1px solid var(--evl-line2); border-radius:4px; padding:6px 12px 2px; }
#pluginEventLog .evlTlIn { min-width:640px; }
#pluginEventLog .evlLane { display:grid; grid-template-columns:180px minmax(0,1fr); align-items:center; min-height:30px; border-bottom:1px solid var(--evl-line2); font-size:12px; }
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
#pluginEventLog .evlDiagCols { display:flex; flex-wrap:wrap; gap:0 28px; }
#pluginEventLog .evlDiagMain { flex:999 1 520px; min-width:0; }
#pluginEventLog .evlDiagSide { flex:1 1 300px; min-width:0; }
#pluginEventLog .evlHyp { display:grid; grid-template-columns:110px minmax(0,1fr); gap:6px 18px; padding:12px 0; border-bottom:1px solid var(--evl-line2); }
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
#pluginEventLog .evlDiagFoot { margin-top:18px; }
@media (max-width: 640px) {
  #pluginEventLog .evlHyp { grid-template-columns:1fr; }
  #pluginEventLog .evlLane { grid-template-columns:120px minmax(0,1fr); }
}
@media (max-width: 1000px) { #pluginEventLog .evlDBody.evlDBodyEx { grid-template-columns:1fr; } }
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
#evlAiDlg .evlBtn.on { background:var(--evl-acc); color:var(--evl-acc-ink); border-color:var(--evl-acc); }
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
        'aiEsc', 'aiStripMarks', 'aiPlain', 'aiTint', 'aiNetWord', 'aiCounts', 'aiTimeShort', 'aiBusy', 'aiReqId', 'aiSendMsg', 'aiSay', 'aiCopyText',
        'aiNewState', 'aiStashSave', 'aiAbortAll', 'aiNewTurn', 'aiNewConv', 'aiPrune', 'aiStartConv', 'aiCloseConv', 'aiOk', 'aiFind', 'aiTurn', 'aiCitesOf', 'aiCite',
        'aiDogStart', 'aiDog',
        'onAiStarted', 'onAiPreview', 'onAiStep', 'onAiDelta', 'onAiDone', 'onAiError',
        'aiRefresh', 'aiSchedule', 'aiFlush', 'aiVisible',
        'aiMdInit', 'aiMd', 'aiChipHtml', 'aiMdFallback', 'aiMdPost', 'aiCopyCode',
        'aiErrText', 'aiErrHtml', 'aiArgsShort', 'aiStepResult', 'aiUsageText', 'aiStepsHtml', 'aiStepsClick', 'aiWaitHtml', 'aiInfoLine', 'aiNotesHtml', 'aiVoteHtml',
        'aiTurnText', 'aiCopyTurn', 'aiVote', 'aiRetry', 'aiStop',
        'aiCiteMap', 'aiRowRefs', 'aiGutterTd', 'aiApplySel', 'aiGutter', 'aiGotoCite', 'aiReveal', 'aiAfterLoad', 'aiFlashRow', 'aiNoticeHtml', 'aiNoteClose', 'aiShowAnyway',
        'aiOpenCited', 'aiPeekHtml', 'aiRenderPeek', 'aiPeekClose',
        'aiLayout', 'aiSplitDown', 'aiSplitKey', 'aiSplitReset', 'aiToggle', 'aiClosePanel', 'aiRenderPanel', 'aiHeadHtml', 'aiStarters', 'aiIntroHtml', 'aiStarter', 'aiLogHtml',
        'aiTurnHtml', 'aiDoneBody', 'aiRenderComposer', 'aiKey', 'aiDraft', 'aiSubmit', 'aiAsk', 'aiFollow', 'aiNewChat', 'aiPrefill',
        'aiExplainConv', 'aiExplainBtn', 'aiExplain', 'aiVerdict', 'aiExplainBody', 'aiExplainMeta', 'aiExplainHtml', 'aiExplainContinue',
        'aiWinText', 'aiSetWin', 'aiDiagnose', 'aiDiagTbHtml', 'aiRenderDiag', 'aiDiagHtml', 'aiStatusWord', 'aiChips', 'aiDiagDone', 'aiTlRange', 'aiLaneClusters', 'aiTimelineHtml',
        'aiAskAbout', 'aiCopyCmd',
        'aiDlgOpen', 'aiDlgHtml', 'aiDlgPvHtml', 'aiDlgTab', 'aiDlgCat', 'aiDlgRem', 'aiDlgKey', 'aiDlgCancel', 'aiDlgSend', 'aiDlgClose',
        'aiInjectStyles'
    ];
    NAMES.forEach(function (n) {
        if (typeof obj[n] == 'function') { if (obj.exports.indexOf(n) < 0) obj.exports.push(n); }
        else console.log('EVENTLOG: missing UI function ' + n);
    });
};
