'use strict';
// Browser code of the device tab (eventlog.js browser functions + ui_ai.js).
//
// Always: every exported name is a function whose source parses on its own (MeshCentral serializes each with
// .toString() into /pluginHandler.js; one bad name breaks that file for all plugins), plus pure helpers.
//
// DOM tests need jsdom and MeshCentral's marked/purify scripts, neither of which is a dependency of the plugin.
// They run when both can be found and are skipped otherwise:
//   EVL_JSDOM=/path/to/node_modules/jsdom   (or jsdom resolvable from here)
//   EVL_MC_SCRIPTS=/path/to/meshcentral/public/scripts   (or node_modules/meshcentral/public/scripts)
var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var F = require('./fakes.js');

function loadPlugin() { return F.loadPlugin(F.makePluginHandler({})); }

test('every exported name is a function whose source parses standalone', function () {
    var p = loadPlugin();
    var seen = {};
    p.exports.forEach(function (n) {
        assert.strictEqual(typeof p[n], 'function', n + ' is listed in exports but is not a function');
        assert.ok(!seen[n], n + ' is exported twice'); seen[n] = 1;
        assert.doesNotThrow(function () { new Function('return (' + p[n].toString() + ')'); }, n + ' does not parse standalone');
    });
    ['aiMd', 'onAiStarted', 'onAiPreview', 'onAiStep', 'onAiDelta', 'onAiDone', 'onAiError', 'aiInjectStyles', 'aiDlgOpen', 'aiGotoCite'].forEach(function (n) {
        assert.ok(p.exports.indexOf(n) >= 0, n + ' is exported');
    });
});

test('browser functions use no method shorthand, classes or arrow functions at the top', function () {
    var p = loadPlugin();
    p.exports.forEach(function (n) {
        var src = p[n].toString();
        assert.ok(/^function\s*\(/.test(src), n + ' must be a plain function expression');
    });
});

test('aiVisible hides machine-readable blocks while streaming, also a tag still being typed', function () {
    var p = loadPlugin();
    assert.strictEqual(p.aiVisible('Answer text.\n<diagnosis>{"v":1'), 'Answer text.\n');
    assert.strictEqual(p.aiVisible('Answer.\n\n<follo'), 'Answer.\n\n');
    assert.strictEqual(p.aiVisible('Answer.\n```json\n<explain>{}'), 'Answer.\n');
    assert.strictEqual(p.aiVisible('Plain < 5 and done'), 'Plain < 5 and done');
    assert.strictEqual(p.aiVisible('Text <'), 'Text ');
});

test('pure helpers: counts, args, markers, timeline clusters', function () {
    var p = loadPlugin();
    assert.deepStrictEqual(p.aiCounts({ users: 3, hosts: 1, ips: 9, sids: 0 }), { total: 13, list: '3 user names, 1 computer name, 9 IP addresses' });
    assert.strictEqual(p.aiArgsShort({ window: '24h', filters: { level: 'warning' } }), '24h, level: warning');
    assert.strictEqual(p.aiStripMarks('host hostPC01 ok'), 'host PC01 ok');
    var lane = { markers: [{ t: 1000, level: 'warn', cites: ['E1'] }, { t: 1004, level: 'crit', cites: ['E2'] }, { t: 5000, level: 'info', cites: [] }, { t: 6000, t2: 7000, level: 'err', cites: [] }] };
    var k = p.aiLaneClusters(lane, 0, 10000);
    assert.strictEqual(k.length, 3);
    assert.strictEqual(k[0].n, 2);
    assert.strictEqual(k[0].level, 'crit');
    assert.deepStrictEqual(k[0].cites, ['E1', 'E2']);
    assert.strictEqual(k[2].range, true);
});

// ---------------------------------------------------------------------------------------------------------------
// DOM tests
function findJsdom() {
    var c = [process.env.EVL_JSDOM, 'jsdom'];
    for (var i = 0; i < c.length; i++) { if (!c[i]) continue; try { return require(c[i]); } catch (e) { } }
    return null;
}
function findScripts() {
    var c = [process.env.EVL_MC_SCRIPTS, path.join(__dirname, '..', '..', '..', 'node_modules', 'meshcentral', 'public', 'scripts'), path.join(__dirname, '..', 'node_modules', 'meshcentral', 'public', 'scripts')];
    for (var i = 0; i < c.length; i++) {
        if (c[i] && fs.existsSync(path.join(c[i], 'marked.js')) && fs.existsSync(path.join(c[i], 'purify.js'))) return c[i];
    }
    return null;
}
var JSDOM_MOD = findJsdom(), SCRIPTS = findScripts();
var SKIP = (JSDOM_MOD && SCRIPTS) ? false : 'jsdom or MeshCentral\'s marked/purify scripts not found (set EVL_JSDOM and EVL_MC_SCRIPTS)';

var NODE = 'node/d/n1', WINDOWS = [];
test.afterEach(function () { while (WINDOWS.length) { try { WINDOWS.pop().close(); } catch (e) { } } });
function makeDom(opts) {
    opts = opts || {};
    var plugin = loadPlugin();
    var dom = new JSDOM_MOD.JSDOM('<!doctype html><html><head></head><body><div id="p19ph-pluginEventLog" class="on"></div><div id="pluginEventLog"></div></body></html>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://mesh.example/' });
    var w = dom.window;
    if (!opts.noLibs) { w.eval(fs.readFileSync(path.join(SCRIPTS, 'marked.js'), 'utf8')); w.eval(fs.readFileSync(path.join(SCRIPTS, 'purify.js'), 'utf8')); }
    w.eval('var sent = [], store = {};' +
        'function Q(x) { return document.getElementById(x); }' +
        'function QH(x, h) { var e = Q(x); if (e) e.innerHTML = h; }' +
        'function EscapeHtml(x) { if (typeof x == "string") return x.replace(/&/g, "&amp;").replace(/>/g, "&gt;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\'/g, "&apos;"); if (typeof x == "boolean") return x; if (typeof x == "number") return x; }' +
        'function getstore(k, d) { return (k in store) ? store[k] : d; }' +
        'function putstore(k, v) { store[k] = v; }' +
        'var meshserver = { send: function (m) { sent.push(JSON.parse(JSON.stringify(m))); } };' +
        'var currentNode = { _id: "' + NODE + '", name: "FIN-LT-0142", meshid: "mesh/d/A", agent: { id: 3 }, conn: 1, osdesc: "Windows 11" };' +
        'var pluginHandler = { eventlog: {}, registerPluginTab: function () { } };');
    // exactly what MeshCentral's prepExports does: one assignment per exported name, from .toString()
    var src = '';
    plugin.exports.forEach(function (n) { src += 'pluginHandler.eventlog.' + n + ' = ' + plugin[n].toString() + ';\n'; });
    w.eval(src);
    w.ph = w.pluginHandler.eventlog;
    WINDOWS.push(w);
    return w;
}
function plain(x) { return JSON.parse(JSON.stringify(x)); }   // objects from the jsdom realm
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function sentOf(w, act) { return w.sent.filter(function (m) { return m.pluginaction == act; }); }
function conv(cites) { return { id: 'c1', turns: [{ cites: cites || {} }] }; }
var T1 = Date.now() - 3600000, T2 = Date.now() - 7200000;
var REC = { _id: 'abc123', nodeid: NODE, tc: T1, Level: 3, TimeCreated: [String(T1)], LogName: 'System', ProviderName: 'stornvme', Id: 129, Message: 'Reset to device, \\Device\\RaidPort0, was issued.' };
var REC2 = { _id: 'abc124', nodeid: NODE, tc: T2, Level: 1, TimeCreated: [String(T2)], LogName: 'System', ProviderName: 'Kernel-Power', Id: 41, Message: 'The system has rebooted without cleanly shutting down first.' };

function grant(w, a) {
    w.ph.onAccess(null, Object.assign({ nodeid: NODE, live: false, history: true, assistant: true, endpoint: { name: 'gpu-01.lan', model: 'qwen3:14b', network: 'private', redactionForced: false } }, a || {}));
}
function loadHistory(w, recs) {
    w.ph.onLoadHistory(null, { nodeid: NODE, events: recs || [REC, REC2], total: (recs || [REC, REC2]).length, skip: 0, stored: 2 });
}

test('rendering: raw HTML from the model is shown as text, never as elements', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph;
    var html = ph.aiMd('Hello <script>alert(1)</script> and <img src=x onerror=alert(2)>\n\n<div onclick="x()">block</div>', conv());
    var d = w.document.createElement('div'); d.innerHTML = html;
    assert.strictEqual(d.querySelectorAll('script,img,div').length, 0);
    assert.ok(d.textContent.indexOf('<script>alert(1)</script>') >= 0);
    assert.ok(d.textContent.indexOf('<img src=x onerror=alert(2)>') >= 0);
    assert.ok(!/onerror|onclick/i.test(Array.prototype.map.call(d.querySelectorAll('*'), function (e) { return Array.prototype.map.call(e.attributes, function (a) { return a.name; }).join(' '); }).join(' ')));
});

test('rendering: images become links with the domain, never <img>; reference-style too', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph;
    var d = w.document.createElement('div');
    d.innerHTML = ph.aiMd('![x](http://evil.example/?d=1)\n\n![y][r]\n\n[r]: https://other.example/p.png\n\n![z](javascript:alert(1))', conv());
    assert.strictEqual(d.querySelectorAll('img').length, 0);
    var as = d.querySelectorAll('a');
    assert.strictEqual(as.length, 2);
    assert.strictEqual(as[0].getAttribute('href'), 'http://evil.example/?d=1');
    assert.ok(as[0].textContent.indexOf('Image from evil.example (opens in new tab)') === 0);
    assert.strictEqual(as[0].getAttribute('target'), '_blank');
    assert.strictEqual(as[0].getAttribute('rel'), 'noopener noreferrer');
    assert.strictEqual(as[1].getAttribute('href'), 'https://other.example/p.png');
    assert.ok(d.textContent.indexOf('z') >= 0);
});

test('rendering: links get target/rel/title and the real host; other schemes are neutralized', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph;
    var d = w.document.createElement('div');
    d.innerHTML = ph.aiMd('[a](javascript:alert(1)) [b](data:text/html,x) [docs](https://learn.example.com/x?y=1) [https://learn.example.com](https://learn.example.com/) [trick](https://good.example@evil.example/)', conv());
    var as = d.querySelectorAll('a');
    assert.strictEqual(as.length, 3);
    as.forEach(function (a) { assert.ok(/^https:\/\//.test(a.getAttribute('href'))); assert.strictEqual(a.getAttribute('target'), '_blank'); assert.strictEqual(a.getAttribute('rel'), 'noopener noreferrer'); assert.strictEqual(a.getAttribute('title'), a.href); });
    assert.strictEqual(as[0].textContent, 'docs (learn.example.com)');
    assert.strictEqual(as[1].textContent, 'https://learn.example.com');   // host already in the text
    assert.strictEqual(as[2].textContent, 'trick (evil.example)');      // the real host, not the userinfo
    assert.ok(d.textContent.indexOf('a ') === 0 || d.textContent.indexOf('a') === 0);
    assert.ok(!/javascript:|data:/.test(d.innerHTML));
});

test('rendering: pseudonym markers become <mark>, citations become chips only when valid', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph;
    var ev = ph.elNormalize(REC);
    var c = conv({ E3: { rec: REC, ev: ev, id: 'abc123' } });
    var d = w.document.createElement('div');
    d.innerHTML = ph.aiMd('The host hostPC_01*x* restarted [E3] and [E9]. See [E3, E9]. Code: `[E3]` [unverified]', c);
    var marks = d.querySelectorAll('mark.evlPs');
    assert.strictEqual(marks.length, 1);
    assert.strictEqual(marks[0].textContent, 'PC_01*x*');
    assert.strictEqual(marks[0].getAttribute('title'), 'Replaced before sending');
    var chips = d.querySelectorAll('button.evlCite');
    assert.strictEqual(chips.length, 2);
    chips.forEach(function (b) { assert.strictEqual(b.textContent, 'E3'); assert.strictEqual(b.getAttribute('data-r'), 'E3'); assert.ok(/aiGotoCite\('c1','E3'\)/.test(b.getAttribute('onclick'))); });
    assert.ok(d.textContent.indexOf('E9') < 0);
    assert.strictEqual(d.querySelector('code').textContent, '[E3]');   // left alone inside code
    assert.ok(d.querySelector('.evlAiUnv'));
});

test('rendering: command blocks get Copy and the read-only note; tables scroll; no model text in attributes', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph;
    var d = w.document.createElement('div');
    d.innerHTML = ph.aiMd('```powershell\nGet-PhysicalDisk | Get-StorageReliabilityCounter\n```\n\n```json\n{"a":1}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |', conv());
    var wraps = d.querySelectorAll('.evlAiCodeW');
    assert.strictEqual(wraps.length, 2);
    assert.ok(wraps[0].querySelector('button').getAttribute('onclick').indexOf('aiCopyCode(this)') >= 0);
    assert.strictEqual(d.querySelectorAll('.evlAiCmdNote').length, 1);
    assert.ok(d.querySelector('.evlAiCmdNote').textContent.indexOf('assistant can only read') >= 0);
    assert.strictEqual(d.querySelectorAll('pre[title]').length, 0);
    assert.ok(d.querySelector('.evlAiTbl > table'));
});

test('rendering: without marked/DOMPurify the text is escaped with line breaks', { skip: SKIP }, function () {
    var w = makeDom({ noLibs: true }), ph = w.ph;
    var ev = ph.elNormalize(REC);
    var html = ph.aiMd('a <b>x</b>\nline [E3] userbob', conv({ E3: { rec: REC, ev: ev, id: 'abc123' } }));
    var d = w.document.createElement('div'); d.innerHTML = html;
    assert.strictEqual(d.querySelectorAll('b').length, 0);
    assert.ok(d.querySelector('br'));
    assert.ok(d.querySelector('button.evlCite'));
    assert.strictEqual(d.querySelector('mark').textContent, 'bob');
});

test('shell: views by permission, Diagnosis only with the Assistant, Ask toggle', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w);
    await sleep(5);
    assert.ok(doc.getElementById('evlMain') && doc.getElementById('evlCol') && doc.getElementById('evlAi'));
    assert.strictEqual(doc.getElementById('evlVLive').hidden, true);
    assert.strictEqual(doc.getElementById('evlVDiag').hidden, false);
    assert.strictEqual(sentOf(w, 'getNodeHistory').length, 1);
    var btn = doc.getElementById('evlAiBtn');
    assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
    ph.aiToggle();
    assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(doc.getElementById('evlAi').hidden, false);
    assert.strictEqual(doc.getElementById('evlAiLog').getAttribute('role'), 'log');
    assert.ok(doc.querySelector('label[for=evlAiIn]').textContent.indexOf('FIN-LT-0142') >= 0);
    assert.ok(doc.getElementById('evlAiStyles'));
    // Assistant only: Diagnosis is the view, no event table
    var w2 = makeDom(); grant(w2, { history: false });
    assert.strictEqual(w2.ph.st.view, 'diag');
    assert.strictEqual(w2.document.getElementById('evlBody').hidden, true);
    assert.ok(w2.document.querySelector('.evlDiagEmpty'));
    assert.strictEqual(sentOf(w2, 'aiStart').length, 0);   // never runs by itself
    // no Assistant: no Diagnosis, no Ask
    var w3 = makeDom(); grant(w3, { assistant: false });
    assert.strictEqual(w3.document.getElementById('evlVDiag').hidden, true);
    assert.strictEqual(w3.document.getElementById('evlAiBtn'), null);
});

test('aiUnavailText: one plain sentence per reason, admin hint only with canManage, nothing for the permission', function () {
    var p = loadPlugin(), t = p.aiUnavailText;
    assert.strictEqual(t({ assistant: false, assistantReason: 'noEndpoint', configSetName: 'Default' }), 'Assistant: no endpoint is assigned to this device\'s config set (Default).');
    assert.strictEqual(t({ assistant: false, assistantReason: 'noEndpoint', configSetName: null }), 'Assistant: no endpoint is assigned to this device\'s config set.');
    assert.strictEqual(t({ assistant: false, assistantReason: 'noEndpoint', configSetName: 'Servers', canManage: true }),
        'Assistant: no endpoint is assigned to this device\'s config set (Servers). Assign one in My Server \u2192 Plugins \u2192 Event Log \u2192 Config Sets.');
    assert.strictEqual(t({ assistant: false, assistantReason: 'disabled' }), 'Assistant: turned off in the plugin settings.');
    assert.ok(/Turn it on in My Server .* Assistant\.$/.test(t({ assistant: false, assistantReason: 'disabled', canManage: true })));
    assert.strictEqual(t({ assistant: false, assistantReason: 'deviceRights', canManage: true }), 'Assistant: needs the Details right on this device.');
    assert.strictEqual(t({ assistant: false, assistantReason: 'unavailable' }), 'Assistant: not available on this server (see the server log).');
    assert.strictEqual(t({ assistant: false, assistantReason: 'error' }), 'Assistant: not available on this server (see the server log).');
    assert.strictEqual(t({ assistant: false, assistantReason: 'permission', canManage: true, configSetName: 'X' }), '');
    assert.strictEqual(t({ assistant: false }), '');
    assert.strictEqual(t({ assistant: true, assistantReason: 'noEndpoint' }), '');
    assert.strictEqual(t(null), '');
});

test('shell: a note says why the Assistant is not offered; none without the permission', { skip: SKIP }, async function () {
    function note(a) {
        var w = makeDom(); grant(w, Object.assign({ assistant: false, endpoint: null }, a));
        assert.strictEqual(w.document.getElementById('evlAiBtn'), null);
        var n = w.document.getElementById('evlAiWhy');
        if (n) { assert.strictEqual(n.getAttribute('role'), 'note'); assert.ok(n.closest('#evlToolbar')); }
        return n ? n.textContent : null;
    }
    assert.strictEqual(note({ assistantReason: 'noEndpoint', configSetName: 'Default' }), 'Assistant: no endpoint is assigned to this device\'s config set (Default).');
    assert.ok(/Assign one in My Server \u2192 Plugins \u2192 Event Log \u2192 Config Sets\.$/.test(note({ assistantReason: 'noEndpoint', configSetName: 'Default', canManage: true })));
    assert.strictEqual(note({ assistantReason: 'disabled' }), 'Assistant: turned off in the plugin settings.');
    assert.strictEqual(note({ assistantReason: 'deviceRights' }), 'Assistant: needs the Details right on this device.');
    assert.strictEqual(note({ assistantReason: 'unavailable' }), 'Assistant: not available on this server (see the server log).');
    assert.strictEqual(note({ assistantReason: 'error' }), 'Assistant: not available on this server (see the server log).');
    assert.strictEqual(note({ assistantReason: 'permission' }), null);
    assert.strictEqual(note({ assistantReason: 'permission', canManage: true, configSetName: 'Default' }), null);
    // escaped: a config set name is shown as text
    assert.strictEqual(note({ assistantReason: 'noEndpoint', configSetName: '<b>x</b>' }), 'Assistant: no endpoint is assigned to this device\'s config set (<b>x</b>).');
    // the reason changes while the tab is open: the note follows
    var w = makeDom(); grant(w, { assistant: false, endpoint: null, assistantReason: 'disabled' });
    grant(w, { assistant: false, endpoint: null, assistantReason: 'noEndpoint', configSetName: 'Default' });
    assert.ok(/config set \(Default\)/.test(w.document.getElementById('evlAiWhy').textContent));
    // the Assistant is the only permitted view but not available: the notice says why instead of "no permission"
    var w2 = makeDom(); grant(w2, { history: false, assistant: false, endpoint: null, assistantReason: 'noEndpoint', configSetName: 'Default' });
    var ntc = w2.document.getElementById('evlNotice');
    assert.ok(ntc && /no endpoint is assigned/.test(ntc.textContent) && !/do not have permission/.test(ntc.textContent));
    assert.strictEqual(ntc.getAttribute('role'), 'note');
    var w3 = makeDom(); grant(w3, { history: false, assistant: false, endpoint: null, assistantReason: 'permission' });
    assert.ok(/do not have permission/.test(w3.document.getElementById('evlNotice').textContent));
});

test('Ask: start, steps, streaming, done with citations -> gutter chip, chip jumps to the row; stale replies dropped', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    ph.aiAsk('Why did it restart?');
    var start = sentOf(w, 'aiStart')[0];
    assert.strictEqual(start.mode, 'ask');
    assert.deepStrictEqual(plain(start.input), { text: 'Why did it restart?' });
    assert.strictEqual(start.nodeid, NODE);
    assert.strictEqual(doc.getElementById('evlAiSend').textContent, 'Stop');
    ph.onAiStarted(null, { nodeid: 'node/d/other', reqId: start.reqId, convId: 'x1' });   // another device: dropped
    assert.strictEqual(ph.st.ai.convs[ph.st.ai.chat].convId, null);
    ph.onAiStarted(null, { nodeid: NODE, reqId: start.reqId, convId: 'cv1', mode: 'ask', endpointName: 'gpu-01.lan', model: 'qwen3:14b', network: 'private', redacted: false, notes: ['Small context'] });
    assert.ok(doc.getElementById('evlAiHd').textContent.indexOf('qwen3:14b on gpu-01.lan (local') >= 0);
    assert.ok(doc.getElementById('evlAiHd').textContent.indexOf('Small context') >= 0);
    ph.onAiStep(null, { nodeid: NODE, convId: 'cv1', turn: 1, i: 0, tool: 'event_facets', args: { window: '24h' }, status: 'running' });
    ph.onAiDelta(null, { nodeid: NODE, convId: 'cv1', turn: 1, seq: 1, text: 'The drive **stalls** <scr' });
    ph.onAiDelta(null, { nodeid: NODE, convId: 'cvX', turn: 1, seq: 2, text: 'ignored' });   // unknown conversation
    await sleep(200);
    var ans = doc.querySelector('#evlAiLog [data-p=a]');
    assert.ok(ans.innerHTML.indexOf('<strong>stalls</strong>') >= 0);
    assert.ok(ans.textContent.indexOf('<scr') < 0);
    assert.ok(doc.querySelector('#evlAiLog details.evlAiSteps'));
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv1', turn: 1, text: 'The drive stalls [E1].', structured: null, citations: { E1: REC }, invalidCitations: [], redactionCounts: {}, usage: { 'in': 14000, out: 800, ms: 6100, rounds: 2 }, followups: ['Widen to 7 days'] });
    assert.strictEqual(doc.getElementById('evlAiSend').textContent, 'Send');
    var chip = doc.querySelector('#evlAiLog button.evlCite[data-r=E1]');
    assert.ok(chip);
    var gut = doc.querySelector('#evlBody td.evlCCite button.evlCite');
    assert.ok(gut, 'the cited row shows a chip in the gutter');
    assert.strictEqual(gut.closest('tr').id, 'evlR_' + ph.elNormalize(REC).key);
    assert.ok(doc.querySelector('.evlAiFollow button'));
    assert.ok(doc.querySelector('#evlAiLog details.evlAiSteps summary').textContent.indexOf('1 step, 6.1 s, 14.8k tokens') >= 0);
    ph.aiGotoCite(ph.st.ai.chat, 'E1');
    var key = ph.elNormalize(REC).key;
    assert.strictEqual(ph.st.expanded[key], true);
    assert.ok(doc.getElementById('evlR_' + key).classList.contains('evlFlash'));
    // follow-up goes through aiSend on the same conversation
    ph.aiFollow(ph.st.ai.chat, 1, 0);
    var s = sentOf(w, 'aiSend')[0];
    assert.deepStrictEqual([s.convId, s.text], ['cv1', 'Widen to 7 days']);
    // Stop while streaming
    ph.aiSubmit();
    assert.strictEqual(sentOf(w, 'aiStop')[0].convId, 'cv1');
});

test('citation not loaded: page around it is requested, then the row is revealed', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph;
    grant(w); loadHistory(w, [REC2]);
    ph.aiAsk('q');
    var st0 = sentOf(w, 'aiStart')[0];
    ph.onAiStarted(null, { nodeid: NODE, reqId: st0.reqId, convId: 'cv2' });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv2', turn: 1, text: 'See [E2].', citations: { E2: REC }, usage: {} });
    ph.aiGotoCite(ph.st.ai.chat, 'E2');
    var req = sentOf(w, 'getNodeHistory').pop();
    assert.strictEqual(req.aroundId, 'abc123');
    w.ph.onLoadHistory(null, { nodeid: NODE, events: [REC, REC2], total: 300, skip: 100, aroundId: 'abc123' });
    assert.strictEqual(ph.st.hist.base, 100);
    assert.strictEqual(ph.st.expanded[ph.elNormalize(REC).key], true);
    // hidden by a filter: notice with Show anyway
    ph.st.filters.text = 'nothing matches';
    ph.aiGotoCite(ph.st.ai.chat, 'E2');
    assert.ok(w.document.querySelector('.evlAiNote'));
    // "Open these events in History": recIds, cleared by a filter change
    ph.aiOpenCited(ph.st.ai.chat);
    assert.deepStrictEqual(plain(sentOf(w, 'getNodeHistory').pop().recIds), ['abc123']);
    ph.elHistRefilter();
    assert.strictEqual(ph.st.hist.recIds, null);
});

test('Explain: History rows only, sections render from structured, feedback', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    var key = ph.elNormalize(REC).key;
    ph.elRowClick(key);
    var btn = Array.prototype.filter.call(doc.querySelectorAll('#evlBody button'), function (b) { return b.textContent == 'Explain this event'; })[0];
    assert.ok(btn);
    ph.aiExplain(key);
    var s = sentOf(w, 'aiStart')[0];
    assert.deepStrictEqual([s.mode, s.input.eventId], ['explain', 'abc123']);
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cv3', model: 'm', endpointName: 'e', network: 'public', redacted: true });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv3', turn: 1, text: '', citations: {}, usage: {}, redactionCounts: { hosts: 1 },
        structured: { meaning: 'The driver reset the drive.', onDevice: 'Nine resets on hostPC01.', harmless: { verdict: 'rarely', text: 'Bursts are not.' }, checkNext: ['Run `powercfg`'] } });
    var ex = doc.querySelector('#evlBody .evlAiEx');
    assert.ok(ex);
    ['What it means', 'On this device', 'Is it usually harmless?', 'Check next'].forEach(function (h) { assert.ok(ex.textContent.indexOf(h) >= 0, h); });
    assert.ok(ex.querySelector('mark.evlPs'));
    assert.ok(ex.textContent.indexOf('1 value replaced before sending: 1 computer name.') >= 0);
    var help = Array.prototype.filter.call(ex.querySelectorAll('button'), function (b) { return /Helpful/.test(b.textContent) && !/Not/.test(b.textContent); })[0];
    assert.strictEqual(help.getAttribute('aria-pressed'), 'false');
    ph.aiVote(ph.st.ai.explainBy.abc123, 1, 'explain', 'up');
    var fb = sentOf(w, 'aiFeedback')[0];
    assert.deepStrictEqual([fb.convId, fb.target, fb.vote], ['cv3', 'explain', 'up']);
    // a Live event (no stored id) offers no Explain
    assert.strictEqual(ph.aiExplainBtn(ph.elNormalize({ Level: 2, TimeCreated: ['1'], LogName: 'x', ProviderName: 'y', Id: 1, Message: 'm' })), '');
});

test('Diagnosis: structured result with timeline, causes, next steps, evidence', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    ph.elSetView('diag');
    assert.strictEqual(sentOf(w, 'aiStart').length, 0);
    ph.aiSetWin('7d');
    ph.aiDiagnose();
    var s = sentOf(w, 'aiStart')[0];
    assert.deepStrictEqual([s.mode, s.input.window], ['diagnose', '7d']);
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cv4', model: 'm', endpointName: 'e', network: 'private' });
    ph.onAiDelta(null, { nodeid: NODE, convId: 'cv4', turn: 1, seq: 1, text: 'Looking. <diagnosis>{"v":1,' });
    await sleep(200);
    assert.ok(doc.querySelector('#evlDiag [data-p=a]').textContent.indexOf('diagnosis') < 0);
    var t0 = 1763400000000;
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv4', turn: 1, text: '', citations: { E1: REC, E2: REC2 }, usage: { 'in': 20000, out: 1400, ms: 38000 },
        structured: { v: 1, window: { from: t0, to: t0 + 86400000 }, summary: 'Two restarts after drive stalls [E1].',
            lanes: [{ id: 'l1', label: 'Unexpected restarts', markers: [{ t: t0 + 60000, level: 'crit', label: 'Kernel-Power 41', cites: ['E2'] }] }],
            hypotheses: [{ id: 'h1', title: 'The drive stalls', status: 'likely', confidence: 0.7, why: 'Resets before each restart [E1].', evidence: ['E1'], against: [], confirm: 'Rising media errors' },
                         { id: 'h2', title: 'Overheating', status: 'ruled_out', confidence: null, why: 'No thermal events.', evidence: [], against: [], confirm: '' }],
            nextSteps: [{ text: 'Read the counters.', command: { shell: 'powershell', text: 'Get-PhysicalDisk' } }],
            evidence: [{ cite: 'E1', note: 'Reset to device' }], unexplained: [{ text: 'DNS timeouts', cites: [] }] } });
    var dg = doc.getElementById('evlDiag');
    assert.ok(dg.textContent.indexOf('What happened in the last 7 days') >= 0);
    assert.ok(dg.querySelector('.evlMk.crit'));
    assert.ok(dg.querySelector('table.evlSr').textContent.indexOf('E2') >= 0, 'screen-reader table carries the cites');
    assert.strictEqual(dg.querySelectorAll('table.evlSr button, table.evlSr [tabindex]').length, 0, 'no focusable controls in the visually hidden table');
    assert.ok(dg.textContent.indexOf('about 70%') >= 0);
    assert.ok(dg.textContent.indexOf('Ruled out') >= 0);
    assert.ok(dg.textContent.indexOf('Open these 2 events in History') >= 0);
    assert.ok(doc.getElementById('evlDiagTb').textContent.indexOf('Diagnose again') >= 0);
    ph.aiVote(ph.st.ai.diag, 1, 'hyp', 'wrong', 'h1');
    assert.deepStrictEqual(plain(sentOf(w, 'aiFeedback').map(function (f) { return [f.target, f.hid, f.vote]; })), [['hyp', 'h1', 'wrong']]);
    assert.ok(doc.getElementById('evlDiag').textContent.indexOf('Marked wrong') >= 0);
    // live ticks do not rebuild the Diagnosis view
    var before = doc.getElementById('evlDiag').firstChild;
    ph.elUpdate();
    assert.strictEqual(doc.getElementById('evlDiag').firstChild, before);
    // chip in Diagnosis jumps to History
    ph.aiGotoCite(ph.st.ai.diag, 'E1');
    assert.strictEqual(ph.st.view, 'history');
});

test('preview dialog: under <body>, modal, categories, Esc cancels, Send confirms', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w, { endpoint: { name: 'api.example', model: 'claude', network: 'public', redactionForced: true, redaction: 'forced', previewPolicy: 'once' } }); loadHistory(w);
    ph.aiAsk('q1');
    var s = sentOf(w, 'aiStart')[0];
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cv5', model: 'claude', endpointName: 'api.example', network: 'public', redacted: true });
    ph.onAiPreview(null, { nodeid: NODE, convId: 'cv5', readable: [{ label: 'First message', text: 'Device HOST_1 <b>x</b>' }], raw: '{"a":"HOST_1"}',
        categories: [{ id: 'deviceSummary', label: 'Device summary', on: true }, { id: 'notes', label: 'Device notes', on: true }], redactionCounts: { hosts: 1 } });
    var dlg = doc.getElementById('evlAiDlg');
    assert.ok(dlg && dlg.parentNode === doc.body);
    var box = dlg.querySelector('[role=dialog]');
    assert.strictEqual(box.getAttribute('aria-modal'), 'true');
    assert.strictEqual(dlg.querySelector('.evlDlgPv mark.evlPs').textContent, 'HOST_1');
    assert.strictEqual(dlg.querySelectorAll('b').length, 0);
    assert.ok(dlg.textContent.indexOf('1 value replaced: 1 computer name.') >= 0);
    assert.ok(dlg.textContent.indexOf('Do not ask again for this endpoint') >= 0, 'previewPolicy once: "do not ask again" offered');
    ph.aiDlgTab('raw');
    assert.ok(doc.getElementById('evlAiDlgPv').textContent.indexOf('{"a":"HOST_1"}') >= 0);
    ph.aiDlgCat(1, false);
    ph.aiDlgRem(true);
    ph.aiDlgSend();
    var cf = sentOf(w, 'aiConfirm')[0];
    assert.deepStrictEqual(plain([cf.convId, cf.categories, cf.remember]), ['cv5', ['deviceSummary'], true]);
    assert.strictEqual(doc.getElementById('evlAiDlg'), null);
    // second conversation (the admin now wants a review every time): Escape cancels and closes the session
    grant(w, { endpoint: { name: 'api.example', model: 'claude', network: 'public', redactionForced: true, redaction: 'forced', previewPolicy: 'every' } });
    ph.aiNewChat();
    ph.aiAsk('q2');
    var s2 = sentOf(w, 'aiStart')[1];
    ph.onAiStarted(null, { nodeid: NODE, reqId: s2.reqId, convId: 'cv6', network: 'public', redacted: true });
    ph.onAiPreview(null, { nodeid: NODE, convId: 'cv6', readable: [], raw: '', categories: [] });
    assert.ok(doc.getElementById('evlAiDlg').textContent.indexOf('Do not ask again') < 0, 'previewPolicy every: the server would ignore it, so it is not offered');
    ph.aiDlgKey({ key: 'Escape', preventDefault: function () { } });
    assert.ok(sentOf(w, 'aiClose').some(function (m) { return m.convId == 'cv6'; }));
    assert.strictEqual(doc.getElementById('evlAiDlg'), null);
    assert.ok(doc.getElementById('evlAiLog').textContent.indexOf('Nothing was sent to the model') >= 0);
});

test('errors: plain direction, denied asks for access again, watchdog after 90 s', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    ph.aiAsk('q');
    var s = sentOf(w, 'aiStart')[0];
    ph.onAiError(null, { nodeid: NODE, convId: null, reqId: s.reqId, code: 'quota', message: 'x', retryable: false });
    assert.ok(doc.getElementById('evlAiLog').textContent.indexOf('You reached today\'s limit for the Assistant.') >= 0);
    ph.aiNewChat(); ph.aiAsk('q');
    var s2 = sentOf(w, 'aiStart')[1];
    var n0 = sentOf(w, 'checkAccess').length;
    ph.onAccessDenied(null, { nodeid: NODE, act: 'aiStart', reqId: s2.reqId, reason: 'missing permission' });
    assert.ok(sentOf(w, 'checkAccess').length > n0);
    assert.ok(doc.getElementById('evlAiLog').textContent.indexOf('do not have access') >= 0);
    ph.aiNewChat(); ph.aiAsk('q3');
    var c = ph.st.ai.convs[ph.st.ai.chat];
    c.last = Date.now() - 91000;
    ph.aiDog();
    assert.strictEqual(c.status, 'error');
    assert.ok(doc.getElementById('evlAiLog').textContent.indexOf('No reply from the server for 90 seconds') >= 0);
    w.clearInterval(ph._aiDog);
});

test('Ask header before the first question shows the effective redaction state', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph;
    var ep = function (x) { return { endpoint: Object.assign({ name: 'gpu-01.lan', model: 'qwen3:14b', network: 'private', redactionForced: false }, x) }; };
    grant(w, ep({ redaction: 'on' }));
    assert.strictEqual(ph.aiInfoLine(null), 'qwen3:14b on gpu-01.lan (local, personal values replaced)');
    grant(w, ep({ redaction: 'off' }));
    assert.strictEqual(ph.aiInfoLine(null), 'qwen3:14b on gpu-01.lan (local, nothing replaced)');
    grant(w, ep({ network: 'public', redactionForced: true, redaction: 'forced' }));
    assert.strictEqual(ph.aiInfoLine(null), 'qwen3:14b on gpu-01.lan (cloud, personal values replaced)');
    grant(w, ep({}));   // a server without the field: only the forced state is known
    assert.strictEqual(ph.aiInfoLine(null), 'qwen3:14b on gpu-01.lan (local, nothing replaced)');
});

test('errors: a connect timeout says the endpoint could not be reached, other timeouts that it was slow', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    ph.aiAsk('q');
    var s = sentOf(w, 'aiStart')[0];
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cv9', network: 'public', redacted: true });
    ph.onAiError(null, { nodeid: NODE, convId: 'cv9', turn: 1, code: 'timeout', phase: 'connect', message: 'Could not connect within 10 s', retryable: false });
    var log = doc.getElementById('evlAiLog').textContent;
    assert.ok(log.indexOf('Could not connect to the endpoint.') >= 0);
    assert.ok(log.indexOf('Could not connect within 10 s') >= 0);
    assert.ok(log.indexOf('took too long') < 0);
    assert.ok(ph.aiErrText('timeout', 'idle').indexOf('took too long') >= 0);
});

test('device change stops running requests and restores the chat on return', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph;
    grant(w); loadHistory(w);
    ph.livelognode = w.currentNode;
    ph.aiAsk('q');
    var s = sentOf(w, 'aiStart')[0];
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cv7' });
    w.eval('currentNode = { _id: "node/d/n2", name: "other", meshid: "mesh/d/A", agent: { id: 3 } };');
    ph.onDeviceRefreshEnd('node/d/n2');
    assert.ok(sentOf(w, 'aiStop').some(function (m) { return m.convId == 'cv7' && m.nodeid == NODE; }));
    assert.ok(ph.st == null || ph.st.ai.chat == null);
    w.eval('currentNode = { _id: "' + NODE + '", name: "FIN-LT-0142", meshid: "mesh/d/A", agent: { id: 3 } };');
    ph.onDeviceRefreshEnd(NODE);
    assert.ok(ph.st.ai.chat != null);
    assert.strictEqual(ph.st.ai.convs[ph.st.ai.chat].turns[0].q, 'q');
    if (ph._aiDog) w.clearInterval(ph._aiDog);
});

test('aiToolWords: tool calls in plain words with a short argument summary', { skip: SKIP }, function () {
    var p = makeDom().ph;
    assert.strictEqual(p.aiToolWords('get_device_info', {}), 'reading device details');
    assert.strictEqual(p.aiToolWords('event_facets', { window: '24h', filters: { level: 'warning' } }), 'counting events (24h, level: warning)');
    assert.strictEqual(p.aiToolWords('lookup_event_id', { provider: 'BugCheck', id: 1001 }), 'looking up event 1001 (BugCheck)');
    assert.strictEqual(p.aiToolWords('get_installed_software', { x: 1 }), 'asking the agent for installed software');
    assert.strictEqual(p.aiToolWords('get_device_events', {}), 'reading MeshCentral device events');
    assert.strictEqual(p.aiToolWords('new_tool', {}), 'using new tool');
    assert.strictEqual(p.aiElapsed(0), '0:00');
    assert.strictEqual(p.aiElapsed(83500), '1:23');
    assert.strictEqual(p.aiElapsed(3723000), '1:02:03');
});

test('running state: strip, status line phases, elapsed time, caret; everything settles on done and stop', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    var live = function () { var e = doc.querySelector('#evlAiLog .evlAiLive'); return e ? e.textContent : null; };
    ph.aiAsk('Why did it restart?');
    var s = sentOf(w, 'aiStart')[0];
    assert.ok(doc.querySelector('#evlAiStripSlot .evlAiStrip.on'), 'the strip runs while the request is pending');
    assert.ok(/^Preparing…0:0\d$/.test(live()), live());
    assert.ok(ph._aiTick, 'the elapsed-time counter runs');
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cv1', mode: 'ask', model: 'qwen3:14b', endpointName: 'gpu-01.lan', network: 'private' });
    assert.ok(live().indexOf('Preparing…') == 0);
    ph.onAiStep(null, { nodeid: NODE, convId: 'cv1', turn: 1, i: 0, tool: 'get_device_info', args: {}, status: 'done', items: 1 });
    ph.onAiStep(null, { nodeid: NODE, convId: 'cv1', turn: 1, i: 1, tool: 'event_facets', args: { window: '24h' }, status: 'running' });
    await sleep(200);
    assert.ok(live().indexOf('Step 2: counting events (24h)') == 0, live());
    assert.strictEqual(doc.getElementById('evlAiSay').textContent, 'Step 2: counting events (24h)', 'the phase change is announced');
    // the counter moves once a second
    var c = ph.st.ai.convs[ph.st.ai.chat];
    c.turns[0].t0 = Date.now() - 65000;
    doc.querySelector('#evlAiLog .evlAiClock').setAttribute('data-t0', String(c.turns[0].t0));
    await sleep(1100);
    assert.ok(/^1:0[56]$/.test(doc.querySelector('#evlAiLog .evlAiClock').textContent), 'the counter was updated by the tick');
    ph.onAiDelta(null, { nodeid: NODE, convId: 'cv1', turn: 1, seq: 1, text: 'The drive **stalls**' });
    await sleep(200);
    assert.ok(live().indexOf('Writing the answer…') == 0, live());
    var caret = doc.querySelector('#evlAiLog [data-p=a] .evlAiCaret');
    assert.ok(caret, 'a caret follows the streaming text');
    assert.strictEqual(caret.parentNode.nodeName, 'P');
    assert.strictEqual(doc.getElementById('evlAiSay').textContent, 'Step 2: counting events (24h)', 'announcements are throttled');
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv1', turn: 1, text: 'The drive stalls.', citations: {}, usage: {} });
    assert.strictEqual(doc.querySelector('#evlAiLog .evlAiLive'), null);
    assert.strictEqual(doc.querySelector('#evlAiLog .evlAiCaret'), null);
    assert.strictEqual(doc.querySelector('#pluginEventLog .evlAiStrip.on'), null);
    assert.ok(!ph._aiTick && !ph._aiDog, 'no timer left after done');
    // Stop: the same
    ph.aiAsk('And now?');
    assert.ok(ph._aiTick && ph._aiDog);
    ph.onAiDelta(null, { nodeid: NODE, convId: 'cv1', turn: 2, seq: 1, text: 'Partial' });
    await sleep(200);
    ph.aiSubmit();
    assert.strictEqual(doc.querySelector('#evlAiLog .evlAiLive'), null);
    assert.strictEqual(doc.querySelector('#evlAiLog .evlAiCaret'), null, 'no caret on a stopped answer');
    assert.strictEqual(doc.querySelector('#pluginEventLog .evlAiStrip.on'), null);
    assert.ok(!ph._aiTick && !ph._aiDog, 'no timer left after stop');
    // New chat while running
    ph.aiAsk('Third');
    assert.ok(ph._aiTick);
    ph.aiNewChat();
    assert.ok(!ph._aiTick && !ph._aiDog, 'no timer left after New chat');
});

test('running state: dot on the Ask button while the panel is closed; Explain and Diagnosis show strip and status', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    ph.aiAsk('q');
    var s = sentOf(w, 'aiStart')[0], btn = doc.getElementById('evlAiBtn');
    assert.ok(!btn.classList.contains('busy'), 'no dot while the panel is open');
    ph.aiClosePanel();
    btn = doc.getElementById('evlAiBtn');
    assert.ok(btn.classList.contains('busy'));
    assert.ok(btn.querySelector('.evlAiDot'));
    assert.strictEqual(btn.getAttribute('aria-label'), 'Ask about this device (answering…)');
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cv1' });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv1', turn: 1, text: 'Done.', citations: {}, usage: {} });
    assert.ok(!btn.classList.contains('busy'));
    assert.strictEqual(btn.getAttribute('aria-label'), null);
    // Explain
    var key = ph.elNormalize(REC).key;
    ph.st.expanded[key] = true; ph.elUpdate();
    ph.aiExplain(key);
    var ex = doc.querySelector('.evlAiEx');
    assert.ok(ex.querySelector('.evlAiStrip.on'));
    assert.ok(ex.querySelector('.evlAiLive').textContent.indexOf('Preparing…') == 0);
    var s2 = sentOf(w, 'aiStart')[1];
    ph.onAiStarted(null, { nodeid: NODE, reqId: s2.reqId, convId: 'cv2' });
    ph.onAiStep(null, { nodeid: NODE, convId: 'cv2', turn: 1, i: 0, tool: 'lookup_event_id', args: { provider: 'stornvme', id: 129 }, status: 'running' });
    await sleep(200);
    assert.ok(doc.querySelector('.evlAiEx .evlAiLive').textContent.indexOf('Step 1: looking up event 129 (stornvme)') == 0);
    ph.onAiError(null, { nodeid: NODE, convId: 'cv2', turn: 1, code: 'timeout', message: '' });
    assert.strictEqual(doc.querySelector('.evlAiEx .evlAiStrip.on'), null);
    assert.strictEqual(doc.querySelector('.evlAiEx .evlAiLive'), null);
    assert.ok(!ph._aiTick && !ph._aiDog, 'no timer left after an error');
    // Diagnosis, ended by the watchdog
    ph.elSetView('diag'); ph.aiDiagnose();
    assert.ok(doc.querySelector('#evlDiag .evlAiStrip.on'));
    assert.ok(doc.querySelector('#evlDiag .evlAiLive').textContent.indexOf('Preparing…') == 0);
    ph.st.ai.convs[ph.st.ai.diag].last = Date.now() - 91000;
    ph.aiDog();
    assert.strictEqual(doc.querySelector('#evlDiag .evlAiStrip.on'), null);
    assert.ok(!ph._aiTick && !ph._aiDog, 'no timer left after the watchdog ended it');
});

test('aiThinkCount: a short character count', function () {
    var p = loadPlugin();
    assert.strictEqual(p.aiThinkCount(0), '');
    assert.strictEqual(p.aiThinkCount(340), '340 characters');
    assert.strictEqual(p.aiThinkCount(1234), '1.2k characters');
    assert.strictEqual(p.aiThinkCount(1299), '1.2k characters');
    assert.strictEqual(p.aiThinkCount(15600), '15k characters');
});

test('running state: "Thinking…" with a growing counter between steps and before writing; announced once per phase', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    ph.aiAsk('Why did it crash?');
    var s = sentOf(w, 'aiStart')[0];
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cv1', mode: 'ask', model: 'qwen3:14b', endpointName: 'gpu-01.lan', network: 'private' });
    var live = function () { var l = doc.querySelector('#evlAiLog .evlAiLive'); return l ? l.textContent : ''; };
    var say = function () { return doc.getElementById('evlAiSay').textContent; };
    ph._aiSaidAt = 0;
    ph.onAiThinking(null, { nodeid: NODE, convId: 'cv1', turn: 1, round: 1, chars: 0 });
    await sleep(200);
    assert.ok(/^Thinking…0:0\d$/.test(live()), live());
    assert.strictEqual(say(), 'Thinking.');
    ph.onAiThinking(null, { nodeid: NODE, convId: 'cv1', turn: 1, round: 1, chars: 1234 });
    await sleep(200);
    assert.ok(live().indexOf('Thinking… (1.2k characters)') == 0, live());
    ph._aiSaidAt = 0;   // past the 2.5 s throttle: the counter alone is never announced again
    doc.getElementById('evlAiSay').textContent = '';
    ph.onAiThinking(null, { nodeid: NODE, convId: 'cv1', turn: 1, round: 1, chars: 2500 });
    await sleep(200);
    assert.ok(live().indexOf('Thinking… (2.5k characters)') == 0, live());
    assert.strictEqual(say(), '', 'one announcement per thinking phase');
    // a step, then the next model call thinks again
    ph.onAiStep(null, { nodeid: NODE, convId: 'cv1', turn: 1, i: 0, tool: 'event_facets', args: { window: '24h' }, status: 'running' });
    await sleep(200);
    assert.ok(live().indexOf('Step 1: counting events (24h)') == 0, live());
    ph.onAiThinking(null, { nodeid: NODE, convId: 'cv1', turn: 1, round: 2, chars: 80 });
    await sleep(200);
    assert.ok(live().indexOf('Thinking… (80 characters)') == 0, live());
    ph.onAiThinking(null, { nodeid: NODE, convId: 'cv1', turn: 1, round: 1, chars: 9000 });   // late, from the earlier call
    await sleep(200);
    assert.ok(live().indexOf('Thinking… (80 characters)') == 0, 'an older call is ignored');
    ph._aiSaidAt = 0;
    ph.onAiDelta(null, { nodeid: NODE, convId: 'cv1', turn: 1, seq: 1, text: 'The disk' });
    await sleep(200);
    assert.ok(live().indexOf('Writing the answer…') == 0, live());
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv1', turn: 1, text: 'The disk.', citations: {}, usage: {} });
    assert.strictEqual(doc.querySelector('#evlAiLog .evlAiLive'), null);
    // bad messages are ignored
    ph.aiAsk('Again?');
    ph.onAiThinking(null, { nodeid: NODE, convId: 'cv1', turn: 2, round: -1, chars: 5 });
    ph.onAiThinking(null, { nodeid: NODE, convId: 'other', turn: 2, round: 1, chars: 5 });
    await sleep(200);
    assert.ok(live().indexOf('Thinking') < 0, live());
});
