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

test('shell: views by permission, Diagnose only with the Assistant, Ask toggle', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w);
    await sleep(5);
    assert.ok(doc.getElementById('evlMain') && doc.getElementById('evlCol') && doc.getElementById('evlAi'));
    assert.strictEqual(doc.getElementById('evlVLive').hidden, true);
    assert.strictEqual(doc.getElementById('evlVDiag'), null, 'no Diagnosis view any more');
    assert.strictEqual(doc.getElementById('evlDiag'), null);
    assert.ok(doc.getElementById('evlAiDiagBtn'), 'a Diagnose button next to Ask');
    assert.strictEqual(sentOf(w, 'getNodeHistory').length, 1);
    var btn = doc.getElementById('evlAiBtn');
    assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
    ph.aiToggle();
    assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(doc.getElementById('evlAi').hidden, false);
    assert.strictEqual(doc.getElementById('evlAiLog').getAttribute('role'), 'log');
    assert.ok(doc.querySelector('label[for=evlAiIn]').textContent.indexOf('FIN-LT-0142') >= 0);
    assert.ok(doc.getElementById('evlAiStyles'));
    // Assistant only: no event table, the panel is the page (open, full width, cannot be closed)
    var w2 = makeDom(); grant(w2, { history: false });
    var d2 = w2.document;
    assert.strictEqual(w2.ph.st.view, 'ai');
    assert.strictEqual(d2.getElementById('evlBody').hidden, true);
    assert.strictEqual(d2.getElementById('evlAi').hidden, false);
    assert.ok(d2.getElementById('evlMain').classList.contains('evlAiOnly'));
    assert.ok(d2.querySelector('#evlAiLog .evlAiIntro #evlAiDgEntry'), 'Diagnose this device next to the starter questions');
    assert.strictEqual(d2.querySelector('#evlAiHd .evlAiX'), null, 'no Close');
    assert.strictEqual(d2.getElementById('evlAiFullBtn'), null, 'no full-width toggle: there is no table');
    assert.strictEqual(d2.getElementById('evlAiBtn'), null);
    assert.ok(d2.getElementById('evlAiDiagBtn'));
    assert.strictEqual(d2.getElementById('evlVHist'), null, 'no view switch without a view');
    w2.ph.aiClosePanel();
    assert.strictEqual(d2.getElementById('evlAi').hidden, false);
    assert.strictEqual(sentOf(w2, 'aiStart').length, 0);   // never runs by itself
    // no Assistant: no Diagnose, no Ask
    var w3 = makeDom(); grant(w3, { assistant: false });
    assert.strictEqual(w3.document.getElementById('evlAiDiagBtn'), null);
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
    assert.strictEqual(doc.getElementById('evlAiSend').getAttribute('aria-label'), 'Stop');
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

test('Explain: History rows only, sections render from structured, no Helpful buttons', { skip: SKIP }, async function () {
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
    assert.ok(!/Helpful|Not helpful/.test(ex.textContent), 'no Helpful / Not helpful any more');
    ph.aiVote(ph.st.ai.explainBy.abc123, 1, 'explain', 'up');
    assert.strictEqual(sentOf(w, 'aiFeedback').length, 0, 'up/down votes are not sent');
    // a Live event (no stored id) offers no Explain
    assert.strictEqual(ph.aiExplainBtn(ph.elNormalize({ Level: 2, TimeCreated: ['1'], LogName: 'x', ProviderName: 'y', Id: 1, Message: 'm' })), '');
});

var DCH = 'ch' + 'd4'.repeat(12);
var DT0 = 1763400000000;
function diagStructured() {
    return { v: 1, window: { from: DT0, to: DT0 + 86400000 }, summary: 'Two restarts after drive stalls [E1].',
        lanes: [{ id: 'l1', label: 'Unexpected restarts', markers: [{ t: DT0 + 60000, level: 'crit', label: 'Kernel-Power 41', cites: ['E2'] }] }],
        hypotheses: [{ id: 'h1', title: 'The drive stalls', status: 'likely', confidence: 0.7, why: 'Resets before each restart [E1].', evidence: ['E1'], against: [], confirm: 'Rising media errors' },
                     { id: 'h2', title: 'Overheating', status: 'ruled_out', confidence: null, why: 'No thermal events.', evidence: [], against: [], confirm: '' }],
        nextSteps: [{ text: 'Read the counters.', command: { shell: 'powershell', text: 'Get-PhysicalDisk' } }],
        evidence: [{ cite: 'E1', note: 'Reset to device' }], unexplained: [{ text: 'DNS timeouts', cites: [] }] };
}
// Diagnose from the toolbar: the panel in full width with the window choice, then a diagnosis chat
function runDiagnosis(w, win) {
    var ph = w.ph;
    ph.aiDiagOpen();
    if (win) { ph.aiSetWin(win); ph.aiRenderPanel(); }
    ph.aiDiagnose();
    var s = sentOf(w, 'aiStart').pop();
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cv4', model: 'm', endpointName: 'e', network: 'private', mode: 'diagnose', chatId: DCH });
    return s;
}

test('Diagnose: the toolbar button opens the window choice in full width; the diagnosis is the first answer of a chat, follow-ups continue it', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    assert.strictEqual(ph.st.ai.open, false);
    ph.aiDiagOpen();
    assert.strictEqual(sentOf(w, 'aiStart').length, 0, 'nothing runs before Diagnose');
    assert.strictEqual(doc.getElementById('evlAi').hidden, false);
    assert.ok(doc.getElementById('evlMain').classList.contains('evlAiFull'), 'opens in full width');
    assert.strictEqual(doc.getElementById('evlAiFullBtn').getAttribute('aria-pressed'), 'true');
    var radios = doc.querySelectorAll('#evlAiLog .evlDgWin input[type=radio]');
    assert.deepStrictEqual(Array.prototype.map.call(radios, function (r) { return r.value; }), ['24h', '7d', 'restart']);
    assert.strictEqual(doc.querySelector('#evlAiHd h2').textContent, 'Diagnose');
    ph.aiDiagCancel();
    assert.strictEqual(doc.querySelector('#evlAiLog .evlDgSetup'), null);
    var s = runDiagnosis(w, '7d');
    assert.deepStrictEqual([s.mode, s.input.window], ['diagnose', '7d']);
    assert.strictEqual(w.store.evl_diag_win, '7d');
    var c = ph.st.ai.convs[ph.st.ai.chat];
    assert.deepStrictEqual([c.mode, c.chatId, c.turns[0].diag, c.turns[0].q], ['diagnose', DCH, true, 'Diagnose the last 7 days']);
    ph.onAiDelta(null, { nodeid: NODE, convId: 'cv4', turn: 1, seq: 1, round: 1, text: 'I will look at the restarts first.' });
    await sleep(200);
    assert.match(doc.querySelector('#evlAiLog [data-p=a]').textContent, /I will look at the restarts first/, 'streamed live');
    // that round called tools: its text becomes a note in the steps and leaves the answer
    ph.onAiNote(null, { nodeid: NODE, convId: 'cv4', turn: 1, i: 0, round: 1, text: 'I will look at the restarts first.' });
    ph.onAiStep(null, { nodeid: NODE, convId: 'cv4', turn: 1, i: 1, tool: 'get_events', args: { limit: 5 }, status: 'done', items: 5 });
    await sleep(200);
    assert.strictEqual(doc.querySelector('#evlAiLog [data-p=a]').textContent, '');
    assert.match(doc.querySelector('#evlAiLog details.evlAiSteps .evlAiStep.note').textContent, /Model: I will look at the restarts first\./);
    assert.match(doc.querySelector('#evlAiLog details.evlAiSteps summary').textContent, /^1 step so far/);
    ph.onAiDelta(null, { nodeid: NODE, convId: 'cv4', turn: 1, seq: 2, round: 2, text: 'Looking. <diagnosis>{"v":1,' });
    await sleep(200);
    assert.ok(doc.querySelector('#evlAiLog [data-p=a]').textContent.indexOf('diagnosis') < 0);
    assert.ok(doc.querySelector('#evlAiLog [data-p=a]').textContent.indexOf('restarts first') < 0, 'the earlier round is not in the answer');
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv4', turn: 1, text: '', citations: { E1: REC, E2: REC2 }, usage: { 'in': 20000, out: 1400, ms: 38000 }, structured: diagStructured(), chatId: DCH });
    var card = doc.querySelector('#evlAiLog .evlAiTurn .evlDgCard');
    assert.ok(card, 'the diagnosis card is in the conversation');
    assert.ok(card.textContent.indexOf('What happened in the last 7 days') >= 0);
    assert.ok(card.querySelector('.evlMk.crit'));
    assert.ok(card.querySelector('table.evlSr').textContent.indexOf('E2') >= 0, 'screen-reader table carries the cites');
    assert.strictEqual(card.querySelectorAll('table.evlSr button, table.evlSr [tabindex]').length, 0, 'no focusable controls in the visually hidden table');
    assert.ok(card.textContent.indexOf('about 70%') >= 0);
    assert.ok(card.textContent.indexOf('Ruled out') >= 0);
    assert.ok(card.querySelector('ol.evlNext .evlAiCodeW button'), 'numbered next steps with Copy');
    assert.ok(card.textContent.indexOf('Open these 2 events in History') >= 0);
    assert.ok(card.textContent.indexOf('DNS timeouts') >= 0, 'not explained');
    assert.ok(card.querySelector('.evlDgFoot details.evlAiSteps'), 'the steps in its footer');
    assert.strictEqual(doc.querySelectorAll('#evlAiLog .evlAiTurn > details.evlAiSteps').length, 0, 'not twice');
    assert.ok(/This is wrong/.test(card.textContent) && /Ask about this/.test(card.textContent));
    ph.aiVote(c.id, 1, 'hyp', 'wrong', 'h1');
    assert.deepStrictEqual(plain(sentOf(w, 'aiFeedback').map(function (f) { return [f.target, f.hid, f.vote]; })), [['hyp', 'h1', 'wrong']]);
    assert.ok(doc.getElementById('evlAiLog').textContent.indexOf('Marked wrong') >= 0);
    assert.strictEqual(doc.querySelector('#evlAiHd h2').textContent, 'Diagnosis');
    // the chat list knows it as a diagnosis
    // "Ask about this" puts a question about that cause into the composer of the same chat
    ph.aiAskAbout(c.id, 'h1');
    assert.match(doc.getElementById('evlAiIn').value, /The diagnosis says: "The drive stalls"/);
    assert.strictEqual(ph.st.ai.chat, c.id);
    // a follow-up question continues the same conversation (aiSend)
    ph.aiAsk('Is the drive failing?');
    var f = sentOf(w, 'aiSend').pop();
    assert.deepStrictEqual([f.convId, f.text], ['cv4', 'Is the drive failing?']);
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv4', turn: 2, text: 'Likely, see [E1].', citations: { E1: REC }, usage: {}, chatId: DCH });
    assert.strictEqual(doc.querySelectorAll('#evlAiLog .evlAiTurn').length, 2);
    assert.ok(doc.querySelector('#evlAiLog .evlDgCard'), 'the card stays above');
    // a chip in the card jumps to the row: full width docks first
    ph.aiGotoCite(c.id, 'E1');
    assert.strictEqual(ph.st.ai.full, false);
    assert.ok(!doc.getElementById('evlMain').classList.contains('evlAiFull'));
    assert.strictEqual(ph.st.expanded[ph.elNormalize(REC).key], true);
    assert.ok(doc.getElementById('evlR_' + ph.elNormalize(REC).key).classList.contains('evlFlash'));
});

test('Diagnosis card: laid out for the chat width (container query), timeline without a minimum width', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    ph.aiInjectStyles();
    var css = doc.getElementById('evlAiStyles').textContent;
    assert.match(css, /\.evlDgCard \{ container:evldg \/ inline-size;/);
    assert.match(css, /@container evldg \(max-width: 560px\) \{[\s\S]*\.evlLane \{ grid-template-columns:minmax\(0,1fr\);/);
    assert.match(css, /\.evlTlIn \{ min-width:0; \}/, 'no horizontal scroll forced at 420 px');
    assert.ok(!/evlDiag/.test(css), 'the old Diagnosis view styles are gone');
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

test('running state: dot on the Ask button while the panel is closed; Explain and a diagnosis show strip and status', { skip: SKIP }, async function () {
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
    // a diagnosis (in the panel), ended by the watchdog
    ph.aiDiagOpen(); ph.aiDiagnose();
    assert.ok(doc.querySelector('#evlAiStripSlot .evlAiStrip.on'));
    assert.ok(doc.querySelector('#evlAiLog .evlAiLive').textContent.indexOf('Preparing…') == 0);
    assert.strictEqual(doc.getElementById('evlAiSend').getAttribute('aria-label'), 'Stop');
    ph.st.ai.convs[ph.st.ai.chat].last = Date.now() - 91000;
    ph.aiDog();
    assert.strictEqual(doc.querySelector('#pluginEventLog .evlAiStrip.on'), null);
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

// ---- saved results --------------------------------------------------------------------------------------------
var CH1 = 'ch' + 'a1'.repeat(12), CH2 = 'ch' + 'b2'.repeat(12);
function grantSaved(w, extra) { grant(w, Object.assign({ saved: { enabled: true, retentionDays: 30 } }, extra || {})); }
function chatItem() {
    var t = Date.now() - 600000;
    return { id: CH1, title: 'Why did it restart?', created: t, updated: t + 60000, endpointName: 'gpu-01.lan', model: 'qwen3:14b', messages: [
        { time: t, q: 'Why did it restart?', a: 'The drive stalled on \uE002host\uE003PC01\uE004 [E1].', cites: { E1: REC }, steps: [{ tool: 'get_events', args: '{"limit":5}', status: 'done', items: 5, ms: 3 }], followups: [], usage: { 'in': 100, out: 20 }, model: 'qwen3:14b', endpointName: 'gpu-01.lan', redactionCounts: { hosts: 1 } },
        { time: t + 60000, q: 'And the power?', a: 'A Kernel-Power 41 followed [E2].', cites: { E2: REC2 }, steps: [], followups: ['Is the PSU failing?'], usage: { 'in': 100, out: 20 }, model: 'qwen3:14b', endpointName: 'gpu-01.lan' }
    ] };
}

test('saved chats: the latest comes back after a reload, is listed, continues with its chat id, and can be deleted', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grantSaved(w); loadHistory(w);
    assert.strictEqual(sentOf(w, 'aiHistoryList').length, 1, 'asked once after access was granted');
    grantSaved(w);
    assert.strictEqual(sentOf(w, 'aiHistoryList').length, 1, 'not again on a repeated access check');
    ph.onAiHistory(null, { nodeid: 'node/d/other', enabled: true, chats: [{ id: CH2, title: 'x', updated: 1, count: 1 }] });   // another device: ignored
    assert.strictEqual(ph.st.ai.saved.loaded, false);
    ph.onAiHistory(null, { nodeid: NODE, enabled: true, retentionDays: 30, chats: [{ id: CH1, title: 'Why did it restart?', updated: Date.now() - 540000, count: 2 }, { id: CH2, title: 'Older <b>chat</b>', updated: Date.now() - 3 * 86400000, count: 1 }, { id: 'bad id', title: 'x' }], diagnosis: null, explains: [] });
    var get = sentOf(w, 'aiHistoryGet');
    assert.deepStrictEqual(plain(get.map(function (m) { return m.kind + ':' + m.id; })), ['chat:' + CH1], 'the most recent chat is restored');
    ph.onAiHistoryItem(null, { nodeid: NODE, kind: 'chat', id: CH1, item: chatItem() });
    ph.aiToggle();
    var log = doc.getElementById('evlAiLog');
    assert.match(log.textContent, /Saved chat from \d/);
    assert.deepStrictEqual(Array.prototype.map.call(log.querySelectorAll('.evlAiQ'), function (e) { return e.textContent; }), ['Why did it restart?', 'And the power?']);
    assert.ok(log.querySelector('.evlCite[data-r=E1]') && log.querySelector('.evlCite[data-r=E2]'), 'citation chips of the saved answers');
    assert.ok(log.querySelector('mark.evlPs'), 'restored values stay marked');
    assert.ok(!/Helpful/.test(log.textContent), 'no feedback buttons for a saved answer');
    assert.ok(Array.prototype.some.call(log.querySelectorAll('.evlAiFollow button'), function (b) { return b.textContent == 'Is the PSU failing?'; }), 'follow-ups of the last answer');
    var hb = doc.getElementById('evlAiHistBtn');
    assert.ok(hb && /Chats\s*2/.test(hb.textContent));
    // the gutter shows the saved citations, a chip finds the row
    ph.aiGotoCite(ph.st.ai.chat, 'E1');
    assert.strictEqual(ph.st.ai.sel, 'E1');
    // continue: a new conversation for the same chat
    ph.aiAsk('Did it happen again?');
    var st = sentOf(w, 'aiStart').pop();
    assert.deepStrictEqual([st.mode, st.chatId, st.input.text], ['ask', CH1, 'Did it happen again?']);
    var c = ph.st.ai.convs[ph.st.ai.chat];
    assert.strictEqual(c.turns.length, 3);
    ph.onAiStarted(null, { nodeid: NODE, reqId: st.reqId, convId: 'cvC', chatId: CH1, continued: true, model: 'qwen3:14b', endpointName: 'gpu-01.lan', network: 'private' });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvC', turn: 1, text: 'Yes, again [E1].', citations: { E1: REC }, invalidCitations: [], usage: {}, followups: [], chatId: CH1 });
    assert.deepStrictEqual(plain(c.turns.map(function (t) { return t.status; })), ['done', 'done', 'done']);
    assert.strictEqual(c.turns[0].text, 'The drive stalled on \uE002host\uE003PC01\uE004 [E1].', 'earlier turns untouched');
    assert.match(log.textContent, /Continued .* with a recap of the answers above/);
    assert.strictEqual(ph.st.ai.saved.chats[0].id, CH1);
    assert.strictEqual(ph.st.ai.saved.chats[0].count, 3);
    // the list: grouped by day, the open chat marked, titles escaped
    ph.aiHistoryToggle();
    assert.strictEqual(doc.querySelector('#evlAiHd h2').textContent, 'Saved chats');
    var rows = log.querySelectorAll('.evlAiHistRow');
    assert.strictEqual(rows.length, 2);
    assert.ok(rows[0].classList.contains('cur'));
    assert.strictEqual(log.querySelectorAll('.evlAiHistDay')[0].textContent, 'Today');
    assert.ok(log.innerHTML.indexOf('<b>chat</b>') < 0 && log.textContent.indexOf('Older <b>chat</b>') >= 0);
    assert.ok(log.textContent.indexOf('Chats are saved for 30 days and visible only to you.') >= 0);
    // open the other one: asked from the server, shown when it arrives
    ph.aiHistoryOpen(CH2);
    assert.strictEqual(sentOf(w, 'aiHistoryGet').pop().id, CH2);
    assert.match(log.textContent, /Opening the saved chat/);
    ph.onAiHistoryItem(null, { nodeid: NODE, kind: 'chat', id: CH2, item: null });   // gone meanwhile
    assert.strictEqual(ph.st.ai.saved.chats.length, 1);
    // delete with an inline confirmation
    ph.aiHistoryToggle();
    ph.aiHistoryDel(CH1);
    assert.ok(log.querySelector('.evlAiHistAsk'));
    assert.strictEqual(sentOf(w, 'aiHistoryDelete').length, 0, 'nothing before the confirmation');
    ph.aiHistoryDelNo();
    assert.strictEqual(log.querySelector('.evlAiHistAsk'), null);
    ph.aiHistoryDel(CH1); ph.aiHistoryDelYes(CH1);
    assert.deepStrictEqual(plain(sentOf(w, 'aiHistoryDelete').pop()).id, CH1);
    ph.onAiHistoryDeleted(null, { nodeid: NODE, kind: 'chat', id: CH1, ok: true });
    assert.strictEqual(ph.st.ai.chat, null, 'the open chat is gone too');
    assert.strictEqual(ph.st.ai.saved.chats.length, 0);
    assert.match(log.textContent, /No saved chats for this device yet/);
});

test('saved chats: a new chat started before the restore arrives is kept; saving off shows no list', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph;
    grantSaved(w); loadHistory(w);
    ph.onAiHistory(null, { nodeid: NODE, enabled: true, retentionDays: 7, chats: [{ id: CH1, title: 'x', updated: Date.now(), count: 2 }] });
    ph.aiAsk('Fresh question');
    ph.onAiHistoryItem(null, { nodeid: NODE, kind: 'chat', id: CH1, item: chatItem() });
    assert.strictEqual(ph.st.ai.convs[ph.st.ai.chat].turns[0].q, 'Fresh question');
    var w2 = makeDom();
    grant(w2, { saved: { enabled: false } }); loadHistory(w2);
    assert.strictEqual(sentOf(w2, 'aiHistoryList').length, 0);
    w2.ph.aiToggle();
    assert.strictEqual(w2.document.getElementById('evlAiHistBtn'), null);
    assert.ok(w2.document.getElementById('evlAiLog').textContent.indexOf('saved for') < 0);
});

test('saved diagnoses are chats: listed with a marker (also one moved from an earlier version), restored as a card, continued, run again; saved explanation', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document, T = Date.now() - 2 * 86400000;
    grantSaved(w); loadHistory(w);
    ph.onAiHistory(null, { nodeid: NODE, enabled: true, retentionDays: 30, chats: [
        { id: CH1, title: 'Two restarts after drive stalls.', updated: Date.now() - 1000, count: 2, type: 'diagnosis', window: '7d' },
        { id: CH2, title: 'Why did it restart?', updated: Date.now() - 5000, count: 1 },
        { id: 'ch' + 'c3'.repeat(12), title: 'Old summary.', updated: T, count: 1, type: 'diagnosis', window: 'restart' }], explains: [{ eventId: 'abc123', time: T }] });
    assert.deepStrictEqual(plain(sentOf(w, 'aiHistoryGet').map(function (m) { return m.kind + ':' + m.id; })), ['chat:' + CH1], 'the latest chat (a diagnosis) comes back');
    ph.aiToggle();
    ph.aiHistoryToggle();
    var rows = doc.querySelectorAll('#evlAiLog .evlAiHistRow');
    assert.strictEqual(rows.length, 3, 'every diagnosis is kept');
    assert.deepStrictEqual(Array.prototype.map.call(rows, function (r) { var m = r.querySelector('.evlAiDgMark'); return m ? m.textContent : null; }), ['Diagnosis · 7 days', null, 'Diagnosis · restart']);
    assert.match(rows[0].textContent, /1 follow-up question/);
    ph.aiHistoryToggle();
    ph.onAiHistoryItem(null, { nodeid: NODE, kind: 'chat', id: CH1, item: { id: CH1, type: 'diagnosis', window: '7d', title: 'x', created: T, updated: T, messages: [
        { time: T, q: 'Diagnose the last 7 days', a: '', model: 'qwen3:14b', endpointName: 'gpu-01.lan', cites: { E1: REC },
          steps: [{ note: 'I will look at the disk first.' }, { tool: 'get_events', args: '{"limit":5}', status: 'done', items: 5, ms: 3 }],
          structured: { v: 1, summary: 'Saved summary [E1].', hypotheses: [{ id: 'h1', title: 'The drive stalls', status: 'likely', why: 'Resets [E1].', evidence: ['E1'], against: [] }], nextSteps: [] } },
        { time: T + 1000, q: 'Is it the cable?', a: 'Unlikely [E1].', cites: { E1: REC }, steps: [] }] } });
    var log = doc.getElementById('evlAiLog');
    var card = log.querySelector('.evlDgCard');
    assert.ok(card && card.textContent.indexOf('Saved summary') >= 0 && card.textContent.indexOf('What happened in the last 7 days') >= 0);
    assert.match(card.querySelector('.evlDgMeta').textContent, /Generated .*\d/);
    assert.match(log.textContent, /Saved diagnosis from/);
    assert.ok(card.querySelector('.evlCite[data-r=E1]'));
    assert.ok(!/This is wrong/.test(card.textContent) && /Ask about this/.test(card.textContent), 'no feedback on a saved diagnosis, asking about it works');
    var note = card.querySelector('.evlAiStep.note');
    assert.ok(note && /Model: I will look at the disk first\./.test(note.textContent), 'saved notes in the steps');
    assert.match(card.querySelector('.evlDgFoot summary').textContent, /^1 step/, 'notes are not counted as steps');
    assert.strictEqual(doc.querySelector('#evlAiHd h2').textContent, 'Diagnosis');
    // a question continues the saved diagnosis chat in a new session with a recap
    ph.aiAsk('Did it happen again?');
    var st = sentOf(w, 'aiStart').pop();
    assert.deepStrictEqual([st.mode, st.chatId, st.input.text], ['ask', CH1, 'Did it happen again?']);
    ph.onAiStarted(null, { nodeid: NODE, reqId: st.reqId, convId: 'cvS', chatId: CH1, continued: true });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvS', turn: 1, text: 'No.', citations: {}, usage: {}, chatId: CH1 });
    var c = ph.st.ai.convs[ph.st.ai.chat];
    assert.deepStrictEqual([c.mode, c.turns.length, c.turns[0].diag], ['diagnose', 3, true]);
    // run it again (retry on the diagnosis): confirm, the chat is replaced by a new diagnosis of the same window
    ph.aiMsgAct(c.id, 1, 'retry');
    assert.match(log.querySelector('.evlAiConfirm').textContent, /Run the diagnosis again and remove the 2 follow-up questions\?/);
    ph.aiMsgYes(c.id, 1);
    var ed = sentOf(w, 'aiChatEdit').pop();
    assert.deepStrictEqual(plain([ed.chatId, ed.index, ed.op, ed.q]), [CH1, 0, 'truncate', 'Diagnose the last 7 days']);
    ph.onAiChatEdited(null, { nodeid: NODE, chatId: CH1, ok: true, deleted: true, chat: null });
    var nd = sentOf(w, 'aiStart').pop();
    assert.deepStrictEqual([nd.mode, nd.input.window, nd.chatId], ['diagnose', '7d', undefined]);
    assert.ok(ph.st.ai.saved.chats.every(function (x) { return x.id !== CH1; }));
    // explanation: loaded when its row is opened, instead of the Explain button
    var key = ph.elNormalize(REC).key;
    ph.elRowClick(key);
    assert.ok(sentOf(w, 'aiHistoryGet').some(function (m) { return m.kind == 'explain' && m.id == 'abc123'; }));
    assert.match(doc.getElementById('evlBody').textContent, /Loading the saved explanation/);
    assert.ok(!Array.prototype.some.call(doc.querySelectorAll('#evlBody button'), function (b) { return b.textContent == 'Explain this event'; }));
    ph.onAiHistoryItem(null, { nodeid: NODE, kind: 'explain', id: 'abc123', item: { eventId: 'abc123', time: T, text: '', model: 'qwen3:14b', endpointName: 'gpu-01.lan', cites: {}, structured: { meaning: 'The driver reset the drive.', checkNext: ['Check cables'] } } });
    var ex = doc.querySelector('#evlBody .evlAiEx');
    assert.ok(ex.textContent.indexOf('The driver reset the drive.') >= 0);
    assert.match(ex.textContent, /Explained .*\d/);
    assert.ok(Array.prototype.filter.call(ex.querySelectorAll('button'), function (b) { return b.textContent == 'Explain again'; })[0]);
    ph.aiRetry(ph.st.ai.explainBy.abc123);   // what the button runs (inline handlers do not run in this jsdom)
    var st2 = sentOf(w, 'aiStart').pop();
    assert.deepStrictEqual([st2.mode, st2.input.eventId], ['explain', 'abc123']);
});

test('starter questions: the list the server chose for the device; none when the list is empty', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph;
    grant(w, { starters: ['Is journald healthy?', 'Which units failed?'] });
    ph.aiToggle();
    var b = w.document.querySelectorAll('#evlAiLog .evlAiFollow button');
    assert.deepStrictEqual(Array.prototype.map.call(b, function (x) { return x.textContent; }), ['Is journald healthy?', 'Which units failed?']);
    ph.aiStarter(1);
    assert.strictEqual(sentOf(w, 'aiStart').pop().input.text, 'Which units failed?');
    var w2 = makeDom(); grant(w2, { starters: [] }); w2.ph.aiToggle();
    assert.strictEqual(w2.document.querySelectorAll('#evlAiLog .evlAiFollow button').length, 0);
    var w3 = makeDom(); grant(w3); w3.ph.aiToggle();
    assert.strictEqual(w3.document.querySelectorAll('#evlAiLog .evlAiFollow button')[0].textContent, 'Why did this device restart recently?', 'an older server: the built-in list');
});

// layout mocks: jsdom has no layout, so give the row a top, the window a height and the panel its inline height
function mockLayout(w, o) {
    o = o || {};
    Object.defineProperty(w, 'innerHeight', { value: o.vh || 1350, configurable: true });
    Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get: function () { return this.parentNode; }, configurable: true });
    w.HTMLElement.prototype.getBoundingClientRect = function () {
        var top = (this.id == 'evlMain' || this.id == 'evlAi') ? (o.top || 120) : 0, h = parseFloat(this.style.height) || 0;
        return { top: top, bottom: top + h, left: 0, right: 0, width: 0, height: h, x: 0, y: top };
    };
    if (o.width) Object.defineProperty(w.document.getElementById('evlWrap'), 'clientWidth', { value: o.width, configurable: true });
}
function key(k) { return { key: k, preventDefault: function () { } }; }

test('Ask panel height: fits the window, not the table; the grip sets it, it persists and survives a rebuild; double-click resets', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    await sleep(5);
    mockLayout(w, { vh: 1350, top: 120 });
    ph.aiToggle();
    var panel = doc.getElementById('evlAi'), g = doc.getElementById('evlAiHGrip');
    assert.strictEqual(panel.style.height, (1350 - 120 - 6) + 'px');   // from its top edge to the bottom of the window
    assert.strictEqual(g.getAttribute('role'), 'separator');
    assert.strictEqual(g.getAttribute('aria-orientation'), 'horizontal');
    assert.strictEqual(g.getAttribute('tabindex'), '0');
    assert.strictEqual(g.getAttribute('aria-valuenow'), '1224');
    assert.strictEqual(doc.getElementById('evlAiHReset').hidden, true);
    // the window grows: so does the panel
    Object.defineProperty(w, 'innerHeight', { value: 1000, configurable: true });
    ph.aiLayout();
    assert.strictEqual(panel.style.height, '874px');
    // keyboard: up 24, page up 120, home = minimum, end = fit
    ph.aiHGripKey(key('ArrowUp'));
    assert.strictEqual(panel.style.height, '850px');
    assert.strictEqual(w.store.evl_ai_h, '850');
    ph.aiHGripKey(key('PageUp'));
    assert.strictEqual(panel.style.height, '730px');
    assert.strictEqual(w.store.evl_ai_h, '730');
    assert.strictEqual(doc.getElementById('evlAiHReset').hidden, false);
    ph.aiHGripKey(key('Home'));
    assert.strictEqual(panel.style.height, '360px');
    ph.aiHGripKey(key('PageDown'));
    assert.strictEqual(w.store.evl_ai_h, '480');
    assert.strictEqual(ph.aiHGripKey(key('a')), true);   // other keys pass through
    // a manual height never grows past the window
    Object.defineProperty(w, 'innerHeight', { value: 500, configurable: true });
    ph.aiLayout();
    assert.strictEqual(panel.style.height, '374px');
    Object.defineProperty(w, 'innerHeight', { value: 1000, configurable: true });
    ph.aiLayout();
    assert.strictEqual(panel.style.height, '480px');
    // MeshCentral rebuilds the tab: the height comes back
    w.QH('pluginEventLog', '');
    ph.elEnsureShell();
    assert.strictEqual(doc.getElementById('evlAi').style.height, '480px');
    assert.strictEqual(doc.getElementById('evlAiHGrip').getAttribute('aria-valuenow'), '480');
    // a new page load reads it from the store
    var w2 = makeDom(); w2.store.evl_ai_h = '600'; grant(w2); loadHistory(w2); await sleep(5);
    mockLayout(w2, { vh: 1000, top: 120 }); w2.ph.aiToggle();
    assert.strictEqual(w2.document.getElementById('evlAi').style.height, '600px');
    // double-click on the grip (and the Reset height button) returns to the automatic height
    ph.aiHGripReset();
    assert.strictEqual(w.store.evl_ai_h, '');
    assert.strictEqual(doc.getElementById('evlAi').style.height, '874px');
    assert.strictEqual(doc.getElementById('evlAiHReset').hidden, true);
    // End also means automatic
    ph.aiHGripKey(key('ArrowUp')); assert.strictEqual(w.store.evl_ai_h, '850');
    ph.aiHGripKey(key('End')); assert.strictEqual(w.store.evl_ai_h, '');
});

test('Ask panel height: stacked below the table it takes the visible height, at least 360 px', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    await sleep(5);
    mockLayout(w, { vh: 900, top: 700, width: 600 });
    ph.aiToggle();
    assert.ok(doc.getElementById('evlMain').classList.contains('evlStack'));
    assert.strictEqual(doc.getElementById('evlAi').style.height, (900 - 24) + 'px');   // its own top does not matter
    ph.aiHGripKey(key('PageUp'));
    assert.strictEqual(doc.getElementById('evlAi').style.height, '756px');
    assert.strictEqual(w.store.evl_ai_h, '756');
    Object.defineProperty(w, 'innerHeight', { value: 300, configurable: true });
    ph.aiHGripReset();
    assert.strictEqual(doc.getElementById('evlAi').style.height, '360px');   // small window: the minimum, the page scrolls
});

// three occurrences of one event (same text, different times) and one other event
function occRec(n, t) { return Object.assign({}, REC, { _id: 'occ' + n, tc: t, TimeCreated: [String(t)] }); }
var TO = Date.now() - 600000, OCC = [occRec(1, TO), occRec(2, TO - 60000), occRec(3, TO - 120000)];
function citeFolded(w, cites) {
    var ph = w.ph;
    ph.aiAsk('What about the resets?');
    var s = sentOf(w, 'aiStart').pop();
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cvF' });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvF', turn: 1, text: 'Resets ' + Object.keys(cites).map(function (r) { return '[' + r + ']'; }).join(' ') + '.', citations: cites, usage: {} });
    return ph.st.ai.chat;
}

test('Fold repeats: every cited occurrence of a folded row gets its chip; a chip further down opens exactly that occurrence', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w, OCC.concat([REC2]));
    assert.strictEqual(ph.st.fold, true);
    var cid = citeFolded(w, { E57: OCC[0], E59: OCC[1], E60: OCC[2], E58: REC2 });
    var top = ph.elNormalize(OCC[0]).key, k2 = ph.elNormalize(OCC[1]).key;
    var chips = function (key) { return Array.prototype.map.call(doc.querySelectorAll('#evlR_' + key + ' td.evlCCite button.evlCite'), function (b) { return b.textContent; }); };
    assert.deepStrictEqual(chips(top), ['E57', 'E59', 'E60']);   // in E-number order, one row for the group
    assert.strictEqual(doc.getElementById('evlR_' + k2), null);
    assert.deepStrictEqual(chips(ph.elNormalize(REC2).key), ['E58']);
    assert.ok(doc.querySelector('#evlR_' + top + ' button[data-r=E59]').classList.contains('in'));
    assert.ok(!doc.querySelector('#evlR_' + top + ' button[data-r=E57]').classList.contains('in'));
    // Table layout: the answer chip expands the group and marks the cited occurrence
    ph.aiGotoCite(cid, 'E59');
    assert.strictEqual(ph.st.expanded[top], true);
    var exp = doc.querySelector('tr.evlExpand');
    assert.ok(exp.querySelector('.evlOccBar').textContent.indexOf('Occurrence 2 of 3') >= 0);
    assert.ok(exp.querySelector('.evlOcc.cur button[data-r=E59]'), 'the cited time is marked and carries its chip');
    assert.strictEqual(exp.querySelectorAll('.evlOccDd button.evlCite').length, 3);
    // Viewer: the details show the cited record itself, with a way back to the group's own event
    ph.elSetLayout('viewer');
    ph.aiGotoCite(cid, 'E60');
    assert.strictEqual(ph.st.selected, top);
    var det = doc.getElementById('evlDetails');
    assert.ok(det.querySelector('.evlOccBar').textContent.indexOf('Occurrence 3 of 3') >= 0);
    assert.ok(det.textContent.indexOf(ph.elFmtTime(ph.elNormalize(OCC[2]).time)) >= 0);
    assert.ok(det.querySelector('dd.evlOccDd .evlOcc.cur button[data-r=E60]'));
    ph.elSetDTab('json');
    assert.ok(doc.querySelector('#evlDetails pre.evlRaw').textContent.indexOf('"occ3"') >= 0, 'Details (JSON) is the cited record');
    ph.elSetDTab('general');
    ph.aiOccClear();
    assert.strictEqual(doc.querySelector('#evlDetails .evlOccBar'), null);
    // the gutter chip of an inner occurrence opens it too; the top chip shows the row's own event
    ph.aiGutter(cid, 'E59', top);
    assert.ok(doc.querySelector('#evlDetails .evlOccBar').textContent.indexOf('Occurrence 2 of 3') >= 0);
    ph.aiGutter(cid, 'E57', top);
    assert.strictEqual(doc.querySelector('#evlDetails .evlOccBar'), null);
    // a click on the row itself also goes back to its own event
    ph.aiGotoCite(cid, 'E59'); ph.elRowClick(top);
    assert.strictEqual(doc.querySelector('#evlDetails .evlOccBar'), null);
});

test('Fold repeats: more than three citations in a row show three chips and "+N"; saved chats after a reload too', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    var recs = [0, 1, 2, 3, 4].map(function (i) { return occRec(10 + i, TO - i * 1000); });
    grantSaved(w); loadHistory(w, recs);
    // a saved chat as the server sends it after a reload ({ ref: stored record })
    var cites = {}; recs.forEach(function (r, i) { cites['E' + (i + 1)] = r; });
    ph.onAiHistory(null, { nodeid: NODE, enabled: true, retentionDays: 30, chats: [{ id: CH1, title: 'Resets', updated: Date.now() - 1000, count: 1 }], diagnosis: null, explains: [] });
    ph.onAiHistoryItem(null, { nodeid: NODE, kind: 'chat', id: CH1, item: { id: CH1, title: 'Resets', created: TO, updated: TO, messages: [{ time: TO, q: 'Resets?', a: 'See [E1] [E2] [E3] [E4] [E5].', cites: cites, steps: [], followups: [] }] } });
    assert.ok(ph.st.ai.convs[ph.st.ai.chat].restored);
    var top = ph.elNormalize(recs[0]).key;
    var td = doc.querySelector('#evlR_' + top + ' td.evlCCite');
    var btns = Array.prototype.map.call(td.querySelectorAll('button'), function (b) { return b.textContent; });
    assert.deepStrictEqual(btns, ['E1', 'E2', 'E3', '+2']);
    assert.strictEqual(td.querySelector('button.more').getAttribute('title'), 'Also cited: E4, E5');
    var th = doc.querySelector('th.evlCCite');
    assert.ok(parseInt(th.style.width, 10) > 52, 'the gutter widens for the chips');
    ph.aiGutterMore(top);
    assert.strictEqual(doc.querySelectorAll('tr.evlExpand .evlOccDd button.evlCite').length, 5);
    ph.aiGotoCite(ph.st.ai.chat, 'E4');
    assert.ok(doc.querySelector('tr.evlExpand .evlOccBar').textContent.indexOf('Occurrence 4 of 5') >= 0);
});

test('aiStart and aiSend carry the browser\'s time zone', { skip: SKIP }, function () {
    var w = makeDom(), ph = w.ph;
    grant(w); loadHistory(w);
    ph.aiAsk('q');
    var s = sentOf(w, 'aiStart')[0];
    assert.strictEqual(s.tz, w.Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.strictEqual(s.tzOffsetMin, 0 - new w.Date().getTimezoneOffset());
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cvT' });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvT', turn: 1, text: 'ok', citations: {}, usage: {} });
    ph.aiAsk('again');
    var m = sentOf(w, 'aiSend')[0];
    assert.ok(typeof m.tz == 'string' && typeof m.tzOffsetMin == 'number');
    assert.strictEqual(sentOf(w, 'aiHistoryList').concat(sentOf(w, 'getNodeHistory')).some(function (x) { return x.tz != null; }), false, 'only the two that start answers');
});

// ---- full width, message actions, Stop, scrolling, height grip (v0.4.2) -----------------------------------------
function savedChat(w, id, qs) {
    var ph = w.ph, t = Date.now() - 600000;
    ph.onAiHistory(null, { nodeid: NODE, enabled: true, retentionDays: 30, chats: [{ id: id, title: qs[0], updated: t, count: qs.length }], explains: [] });
    ph.onAiHistoryItem(null, { nodeid: NODE, kind: 'chat', id: id, item: { id: id, title: qs[0], created: t, updated: t, messages: qs.map(function (q, i) {
        return { time: t + i, q: q, a: 'Answer to ' + q + ' [E1].', cites: { E1: REC }, steps: [], followups: [] };
    }) } });
    return ph.st.ai.convs[ph.st.ai.chat];
}
function actBtn(doc, n, kind) { return doc.querySelector('#evlAiLog .evlAiTurn[data-n="' + n + '"] [data-act=' + kind + ']'); }

test('full width: the toggle hides the table column, is remembered, Esc docks again; hidden when stacked', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    await sleep(5);
    mockLayout(w, { vh: 1000, top: 120, width: 1400 });
    ph.aiToggle();
    var main = doc.getElementById('evlMain'), b = doc.getElementById('evlAiFullBtn');
    assert.strictEqual(b.getAttribute('aria-pressed'), 'false');
    assert.strictEqual(b.getAttribute('aria-label'), 'Full width');
    assert.ok(!main.classList.contains('evlAiFull'));
    ph.aiFullToggle();
    assert.ok(main.classList.contains('evlAiFull'));
    assert.strictEqual(doc.getElementById('evlAiFullBtn').getAttribute('aria-pressed'), 'true');
    assert.strictEqual(doc.getElementById('evlAiFullBtn').getAttribute('title'), 'Dock beside the table (Esc)');
    assert.strictEqual(w.store.evl_ai_full, '1');
    assert.ok(doc.getElementById('evlToolbar').querySelector('#evlTxtIn'), 'the filter toolbar stays');
    var css = doc.getElementById('evlAiStyles').textContent;
    assert.match(css, /\.evlMain\.evlAiFull:not\(\.evlStack\) \.evlCol, #pluginEventLog \.evlMain\.evlAiOnly \.evlCol \{ display:none; \}/);
    assert.match(css, /\.evlStack \.evlAiFullBtn \{ display:none; \}|\.evlStack \.evlAiFullBtn/);
    assert.strictEqual(doc.getElementById('evlAi').style.height, (1000 - 120 - 6) + 'px', 'the height fit is the same in full width');
    // Esc inside the panel docks it; an Esc already taken (inline editor) does not
    var ev = { key: 'Escape', defaultPrevented: true, preventDefault: function () { } };
    assert.strictEqual(ph.aiPanelKey(ev), true);
    assert.ok(main.classList.contains('evlAiFull'));
    ph.aiPanelKey({ key: 'Escape', defaultPrevented: false, preventDefault: function () { } });
    assert.ok(!main.classList.contains('evlAiFull'));
    assert.strictEqual(w.store.evl_ai_full, '');
    // remembered: a new page load opens full width
    var w2 = makeDom(); w2.store.evl_ai_full = '1'; grant(w2); loadHistory(w2); await sleep(5);
    mockLayout(w2, { vh: 1000, top: 120, width: 1400 }); w2.ph.aiToggle();
    assert.ok(w2.document.getElementById('evlMain').classList.contains('evlAiFull'));
    // stacked (narrow): already full width, the table stays above, no toggle
    var w3 = makeDom(); w3.store.evl_ai_full = '1'; grant(w3); loadHistory(w3); await sleep(5);
    mockLayout(w3, { vh: 900, top: 700, width: 600 }); w3.ph.aiToggle();
    var m3 = w3.document.getElementById('evlMain');
    assert.ok(m3.classList.contains('evlStack') && !m3.classList.contains('evlAiFull'));
});

test('message actions: copy, edit, delete on questions; copy, retry on answers; disabled while a request runs', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grantSaved(w); loadHistory(w);
    var c = savedChat(w, CH1, ['Why did it restart?', 'And the power?']);
    ph.aiToggle();
    ['copyq', 'edit', 'del'].forEach(function (k) { var b = actBtn(doc, 1, k); assert.ok(b && !b.disabled, k); assert.ok(b.getAttribute('aria-label') && b.getAttribute('title'), k + ' has a label'); });
    ['copya', 'retry'].forEach(function (k) { assert.ok(actBtn(doc, 2, k), k); });
    assert.strictEqual(actBtn(doc, 1, 'edit').getAttribute('aria-label'), 'Edit the question');
    // while an answer runs: edit, delete and retry are disabled with a reason
    ph.aiAsk('Third?');
    var run = ph.st.ai.convs[ph.st.ai.chat];
    ['edit', 'del'].forEach(function (k) { var b = actBtn(doc, 1, k); assert.ok(b.disabled, k); assert.strictEqual(b.getAttribute('title'), 'Wait until the answer is finished or stop it'); });
    assert.ok(actBtn(doc, 2, 'retry').disabled);
    assert.ok(!actBtn(doc, 1, 'copyq').disabled, 'copy stays');
    ph.aiMsgAct(run.id, 1, 'edit');
    assert.strictEqual(doc.getElementById('evlAiEd'), null, 'no editor while running');
    var st = sentOf(w, 'aiStart').pop();
    ph.onAiStarted(null, { nodeid: NODE, reqId: st.reqId, convId: 'cvM', chatId: CH1, continued: true });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvM', turn: 1, text: 'Third answer.', citations: {}, usage: {}, chatId: CH1 });
    c = ph.st.ai.convs[ph.st.ai.chat];
    assert.strictEqual(c.turns.length, 3);
    // edit the second question: inline editor, Save & send truncates on the server, then asks the edited question
    ph.aiMsgAct(c.id, 2, 'edit');
    var ed = doc.getElementById('evlAiEd');
    assert.ok(ed && ed.value == 'And the power?');
    assert.match(doc.querySelector('#evlAiLog .evlAiQW.edit').textContent, /removes the later message/);
    ed.value = 'And the power supply?';
    ph.aiEditKey({ key: 'Enter', shiftKey: false, preventDefault: function () { } }, c.id, 2);
    var m = sentOf(w, 'aiChatEdit').pop();
    assert.deepStrictEqual(plain([m.chatId, m.index, m.op, m.q]), [CH1, 1, 'truncate', 'And the power?']);
    assert.ok(actBtn(doc, 1, 'del').disabled, 'disabled until the server answered');
    var item = { id: CH1, title: 'Why did it restart?', created: Date.now() - 600000, updated: Date.now(), messages: [{ time: 1, q: 'Why did it restart?', a: 'Answer [E1].', cites: { E1: REC }, steps: [] }] };
    ph.onAiChatEdited(null, { nodeid: NODE, chatId: CH1, ok: true, deleted: false, chat: item });
    var next = sentOf(w, 'aiStart').pop();
    assert.deepStrictEqual([next.mode, next.chatId, next.input.text], ['ask', CH1, 'And the power supply?'], 'a new session with a recap of what is left');
    c = ph.st.ai.convs[ph.st.ai.chat];
    assert.deepStrictEqual(plain(c.turns.map(function (t) { return t.q; })), ['Why did it restart?', 'And the power supply?']);
    ph.onAiStarted(null, { nodeid: NODE, reqId: next.reqId, convId: 'cvN', chatId: CH1, continued: true });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvN', turn: 1, text: 'PSU fine [E1].', citations: { E1: REC }, usage: {}, chatId: CH1 });
    // Esc in the editor cancels without docking the panel
    ph.aiMsgAct(c.id, 1, 'edit');
    ph.aiEditKey({ key: 'Escape', preventDefault: function () { }, stopPropagation: function () { } }, c.id, 1);
    assert.strictEqual(doc.getElementById('evlAiEd'), null);
    // delete the first question: inline confirmation, then the server removes it; nothing is asked
    var nStart = sentOf(w, 'aiStart').length;
    ph.aiMsgAct(c.id, 1, 'del');
    assert.match(doc.querySelector('#evlAiLog .evlAiConfirm').textContent, /Delete this question and its answer\?/);
    assert.strictEqual(sentOf(w, 'aiChatEdit').length, 1, 'nothing before the confirmation');
    ph.aiMsgYes(c.id, 1);
    m = sentOf(w, 'aiChatEdit').pop();
    assert.deepStrictEqual(plain([m.index, m.op, m.q]), [0, 'delete', 'Why did it restart?']);
    ph.onAiChatEdited(null, { nodeid: NODE, chatId: CH1, ok: true, chat: { id: CH1, title: 'x', created: 1, updated: 2, messages: [{ time: 2, q: 'And the power supply?', a: 'PSU fine [E1].', cites: { E1: REC }, steps: [] }] } });
    assert.strictEqual(sentOf(w, 'aiStart').length, nStart);
    c = ph.st.ai.convs[ph.st.ai.chat];
    assert.deepStrictEqual(plain(c.turns.map(function (t) { return t.q; })), ['And the power supply?']);
    assert.ok(doc.querySelector('#evlAiLog .evlCite[data-r=E1]'), 'its citation still works');
    // retry the last answer (nothing after it): no confirmation
    ph.aiMsgAct(c.id, c.turns[0].n, 'retry');
    m = sentOf(w, 'aiChatEdit').pop();
    assert.deepStrictEqual(plain([m.index, m.op]), [0, 'truncate']);
    ph.onAiChatEdited(null, { nodeid: NODE, chatId: CH1, ok: true, deleted: true, chat: null });
    var r = sentOf(w, 'aiStart').pop();
    assert.deepStrictEqual([r.mode, r.chatId, r.input.text], ['ask', undefined, 'And the power supply?'], 'the only message: a new chat asks it again');
    // a refused edit says why
    ph.onAiStarted(null, { nodeid: NODE, reqId: r.reqId, convId: 'cvR', chatId: CH2 });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvR', turn: 1, text: 'ok', citations: {}, usage: {}, chatId: CH2 });
    c = ph.st.ai.convs[ph.st.ai.chat];
    ph.aiMsgAct(c.id, c.turns[0].n, 'del'); ph.aiMsgYes(c.id, c.turns[0].n);
    ph.onAiChatEdited(null, { nodeid: NODE, chatId: CH2, ok: false, code: 'busy' });
    await sleep(80);
    assert.strictEqual(doc.getElementById('evlAiSay').textContent, 'Wait until the answer is finished or stop it.');
    assert.strictEqual(ph.st.ai.convs[ph.st.ai.chat].turns.length, 1, 'nothing removed');
});

test('message actions without saving: the conversation\'s own messages; retry with later messages asks first', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w, { saved: { enabled: false } }); loadHistory(w);
    ph.aiAsk('one');
    var s = sentOf(w, 'aiStart')[0];
    ph.onAiStarted(null, { nodeid: NODE, reqId: s.reqId, convId: 'cvL', chatId: null });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvL', turn: 1, text: 'A1', citations: {}, usage: {} });
    ph.aiAsk('two');
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvL', turn: 2, text: 'A2', citations: {}, usage: {} });
    ph.aiAsk('three');
    ph.onAiError(null, { nodeid: NODE, convId: 'cvL', turn: 3, code: 'timeout', message: '' });
    var c = ph.st.ai.convs[ph.st.ai.chat];
    // the failed question is only removed here
    assert.ok(actBtn(doc, 3, 'del') && !actBtn(doc, 3, 'edit'));
    ph.aiMsgAct(c.id, 3, 'del'); ph.aiMsgYes(c.id, 3);
    assert.strictEqual(sentOf(w, 'aiChatEdit').length, 0);
    assert.strictEqual(c.turns.length, 2);
    // retry the first answer: one later message, so it asks first
    ph.aiMsgAct(c.id, 1, 'retry');
    assert.match(doc.querySelector('#evlAiLog .evlAiConfirm').textContent, /Retry and remove the later message\?/);
    ph.aiMsgYes(c.id, 1);
    var m = sentOf(w, 'aiChatEdit').pop();
    assert.deepStrictEqual(plain([m.convId, m.index, m.op, m.q]), ['cvL', 0, 'truncate', 'one']);
    assert.strictEqual(m.chatId, undefined, 'not saved: by conversation');
    ph.onAiChatEdited(null, { nodeid: NODE, convId: 'cvL', chatId: null, ok: true, count: 0, deleted: true });
    var st = sentOf(w, 'aiStart').pop();
    assert.deepStrictEqual([st.mode, st.input.text], ['ask', 'one'], 'nothing left: a new conversation');
    ph.onAiStarted(null, { nodeid: NODE, reqId: st.reqId, convId: 'cvL2', chatId: null });
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvL2', turn: 1, text: 'A1b', citations: {}, usage: {} });
    ph.aiAsk('two');
    ph.onAiDone(null, { nodeid: NODE, convId: 'cvL2', turn: 2, text: 'A2b', citations: {}, usage: {} });
    c = ph.st.ai.convs[ph.st.ai.chat];
    ph.aiMsgAct(c.id, 2, 'retry');   // the last answer
    m = sentOf(w, 'aiChatEdit').pop();
    assert.deepStrictEqual(plain([m.convId, m.index, m.op]), ['cvL2', 1, 'truncate']);
    ph.onAiChatEdited(null, { nodeid: NODE, convId: 'cvL2', chatId: null, ok: true, count: 1 });
    var sd = sentOf(w, 'aiSend').pop();
    assert.deepStrictEqual([sd.convId, sd.text], ['cvL2', 'two'], 'the same conversation; the server sends the recap along');
    assert.deepStrictEqual(plain(c.turns.map(function (t) { return t.q + ':' + t.status; })), ['one:done', 'two:running']);
});

test('Stop shows that the model works: a turning arc and the elapsed time; its name stays "Stop"; also in the Explain box', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    ph.aiAsk('q');
    var b = doc.getElementById('evlAiSend');
    assert.strictEqual(b.getAttribute('aria-label'), 'Stop');
    assert.ok(b.querySelector('svg.evlAiRing .arc'), 'the arc');
    var clk = b.querySelector('.evlAiClock');
    assert.ok(clk && /^0:0\d$/.test(clk.textContent) && clk.getAttribute('aria-hidden') == 'true');
    clk.setAttribute('data-t0', String(Date.now() - 23000));
    await sleep(1100);
    assert.strictEqual(b.querySelector('.evlAiClock').textContent.slice(0, 3), '0:2', 'ticks with the other clocks');
    var arc = b.querySelector('.arc');
    ph.aiRenderPanel();
    assert.strictEqual(doc.getElementById('evlAiSend').querySelector('.arc'), arc, 'not rebuilt on a re-render (the arc keeps turning)');
    var css = doc.getElementById('evlAiStyles').textContent;
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ #pluginEventLog \.evlAiRing \.arc \{ animation:none;/);
    ph.aiSubmit();   // stop
    assert.strictEqual(doc.getElementById('evlAiSend').textContent, 'Send');
    assert.strictEqual(doc.getElementById('evlAiSend').getAttribute('aria-label'), 'Send the question');
    // Explain
    var key = ph.elNormalize(REC).key;
    ph.st.expanded[key] = true; ph.elUpdate();
    ph.aiExplain(key);
    var xs = doc.querySelector('.evlAiEx .evlAiStop');
    assert.ok(xs && xs.getAttribute('aria-label') == 'Stop' && xs.querySelector('.evlAiRing') && xs.querySelector('.evlAiClock'));
});

test('scrolling: the conversation (diagnosis card, chat list) scrolls inside the window-fitted panel, docked, full width and stacked', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    grant(w); loadHistory(w);
    await sleep(5);
    mockLayout(w, { vh: 900, top: 120, width: 1400 });
    runDiagnosis(w);
    ph.onAiDone(null, { nodeid: NODE, convId: 'cv4', turn: 1, text: 'x'.repeat(4000), citations: { E1: REC, E2: REC2 }, usage: {}, structured: diagStructured(), chatId: DCH });
    var panel = doc.getElementById('evlAi'), log = doc.getElementById('evlAiLog');
    assert.ok(log.querySelector('.evlDgCard'), 'the card is in the scrolling log');
    assert.strictEqual(panel.style.height, (900 - 120 - 6) + 'px', 'full width: fitted to the window, not to the content');
    var css = doc.getElementById('evlAiStyles').textContent;
    assert.match(css, /\.evlAiLog \{ position:relative; flex:1 1 auto; overflow-y:auto;[^}]*min-height:0;/);
    assert.match(css, /\.evlAiIn \{ position:absolute; top:0; right:0; bottom:0; left:0; display:flex; flex-direction:column; min-height:0; \}/);
    assert.ok(!/position:sticky/.test(css), 'no sticky panel any more');
    ph.aiFullToggle(false);
    assert.strictEqual(panel.style.height, (900 - 120 - 6) + 'px', 'docked: the same fit');
    ph.aiHistoryToggle();
    assert.ok(log.querySelector('.evlAiHist'), 'the chat list is in the same scrolling log');
    var w2 = makeDom(); grant(w2); loadHistory(w2); await sleep(5);
    mockLayout(w2, { vh: 900, top: 700, width: 600 });
    runDiagnosis(w2);
    assert.strictEqual(w2.document.getElementById('evlAi').style.height, (900 - 24) + 'px', 'stacked: the visible height');
});

test('Ask panel height: dragging follows the pointer; layout callbacks during the drag never put the stored height back', { skip: SKIP }, async function () {
    var w = makeDom(), ph = w.ph, doc = w.document;
    w.store.evl_ai_h = '550';
    grant(w); loadHistory(w);
    await sleep(5);
    mockLayout(w, { vh: 1200, top: 120 });
    ph.aiToggle();
    var panel = doc.getElementById('evlAi'), g = doc.getElementById('evlAiHGrip');
    assert.strictEqual(panel.style.height, '550px');
    panel.style.height = '880px';   // where the panel is when the drag starts (e.g. a drag in another tab stored 550)
    var y = 120 + 880 - 4;          // the grip, 4 px above the bottom edge
    ph.aiHGripDown({ currentTarget: g, clientY: y, button: 0, pointerId: 1, preventDefault: function () { } });
    var seen = [];
    for (var i = 1; i <= 4; i++) {
        g.dispatchEvent(new w.MouseEvent('pointermove', { clientY: y + 5 * i }));
        ph.aiLayout();                 // what the ResizeObserver does when the panel's height changes
        ph.aiFitPanel();
        seen.push(panel.style.height);
    }
    assert.deepStrictEqual(seen, ['885px', '890px', '895px', '900px'], 'follows the pointer, never snaps back to 550');
    ph.aiHGripKey(key('ArrowUp'));   // keys do nothing mid-drag
    assert.strictEqual(panel.style.height, '900px');
    g.dispatchEvent(new w.MouseEvent('pointerup', { clientY: y + 20 }));
    assert.strictEqual(w.store.evl_ai_h, '900', 'stored on release');
    ph.aiLayout();
    assert.strictEqual(panel.style.height, '900px');
    // the two reset links say which height they reset
    assert.strictEqual(doc.getElementById('evlAiHReset').textContent, 'Reset panel height');
    ph.st.heights[ph.st.layout] = 300; ph.elRenderStatus();
    assert.match(doc.getElementById('evlStatus').textContent, /Reset table height/);
});
