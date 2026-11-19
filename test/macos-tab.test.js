'use strict';
// macOS and Android in eventlog.js: platform detection, the device tab (labels, View selector, detail fields,
// status hints, the Android note) and the server side (collection filters, cursor echo, History query).
//
// The DOM tests need jsdom and MeshCentral's marked/purify scripts (see test/ui-ai.test.js) and are skipped
// without them:  EVL_JSDOM=/path/to/node_modules/jsdom  EVL_MC_SCRIPTS=/path/to/meshcentral/public/scripts
var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var F = require('./fakes.js');

function loadPlugin() { return F.loadPlugin(F.makePluginHandler({})); }

// run a browser function against a given currentNode (it reads the page's global)
function platformOf(p, node) { return new Function('currentNode', 'return (' + p.elPlatform.toString() + ')();')(node); }

test('elPlatform: agent architecture ids', function () {
    var p = loadPlugin();
    var cases = { 1: 'windows', 3: 'windows', 10004: 'windows', 6: 'linux', 13: 'linux', 45: 'linux',
        11: 'macos', 16: 'macos', 29: 'macos', 10005: 'macos', 12: 'android', 14: 'android' };
    Object.keys(cases).forEach(function (id) {
        assert.strictEqual(platformOf(p, { agent: { id: Number(id) }, osdesc: 'Ubuntu 24.04 LTS' }), cases[id], 'agent id ' + id);
    });
    // the id decides, not the description
    assert.strictEqual(platformOf(p, { agent: { id: 16 }, osdesc: 'Windows 11' }), 'macos');
    assert.strictEqual(platformOf(p, { agent: { id: 12 }, osdesc: 'Linux' }), 'android');
    assert.strictEqual(platformOf(p, null), null);
});

test('elPlatform: osdesc fallbacks when the id is unknown or missing', function () {
    var p = loadPlugin();
    var cases = [
        ['Windows 11 Pro', 'windows'], ['macOS 14.5', 'macos'], ['Mac OS X 10.13.6', 'macos'], ['OS X El Capitan', 'macos'],
        ['MacOS Sonoma', 'macos'], ['Darwin 23.5.0', 'macos'], ['Android 14', 'android'], ['android 9 (Pixel 3)', 'android'],
        ['Ubuntu 24.04.2 LTS', null], ['', null]
    ];
    cases.forEach(function (c) {
        assert.strictEqual(platformOf(p, { agent: { id: 999 }, osdesc: c[0] }), c[1], c[0]);
        assert.strictEqual(platformOf(p, { osdesc: c[0] }), c[1], c[0] + ' (no agent)');
    });
});

test('elIsNix, elLxViews, elMacFields', function () {
    var p = loadPlugin();
    assert.strictEqual(p.elIsNix('linux'), true);
    assert.strictEqual(p.elIsNix('macos'), true);
    assert.strictEqual(p.elIsNix('windows'), false);
    assert.strictEqual(p.elIsNix('android'), false);
    assert.strictEqual(p.elIsNix(null), false);
    assert.deepStrictEqual(p.elLxViews('macos').map(function (o) { return o[0]; }), ['', 'kernel', 'auth', 'install', 'crash', 'boot']);
    assert.deepStrictEqual(p.elLxViews('linux').map(function (o) { return o[0]; }), ['', 'kernel', 'auth', 'audit', 'boot']);
    assert.deepStrictEqual(p.elMacFields({ subsystem: 'com.apple.TCC', oscat: 'access', ppath: '/usr/libexec/tccd', msgtype: 'Error' }),
        [['Subsystem', 'com.apple.TCC', false], ['os_log category', 'access', false], ['Process path', '/usr/libexec/tccd', true], ['Log type', 'Error', false]]);
    assert.deepStrictEqual(p.elMacFields({ log: 'Crash', ppath: '/Library/Logs/DiagnosticReports/x.ips', msgtype: 'Crash' }),
        [['Report file', '/Library/Logs/DiagnosticReports/x.ips', true], ['Log type', 'Crash', false]]);
    assert.deepStrictEqual(p.elMacFields({ unit: 'ssh.service', pri: 6 }), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Server side
test('applyCollectionFilters: categories apply to Linux and macOS, not Windows', function () {
    var p = loadPlugin();
    var evs = [{ LogName: 'Install', ProviderName: 'installd' }, { LogName: 'Crash', ProviderName: 'Safari' }, { LogName: 'Kernel', ProviderName: 'kernel' }, { LogName: 'System', ProviderName: 'Disk' }];
    var cfg = { historyCategories: 'Install,Crash', historyCategoriesMode: 'include' };
    var names = function (os) { return p.applyCollectionFilters(evs, cfg, os).map(function (e) { return e.LogName; }); };
    assert.deepStrictEqual(names('macos'), ['Install', 'Crash']);
    assert.deepStrictEqual(names('linux'), ['Install', 'Crash']);
    assert.deepStrictEqual(names('windows'), ['Install', 'Crash', 'Kernel', 'System']);
    assert.deepStrictEqual(names(undefined), ['Install', 'Crash', 'Kernel', 'System']);
    var ex = p.applyCollectionFilters(evs, { historyCategories: 'Crash', historyCategoriesMode: 'exclude', historySources: 'kernel', historySourcesMode: 'exclude' }, 'macos');
    assert.deepStrictEqual(ex.map(function (e) { return e.LogName; }), ['Install', 'System']);
});

function gatherSetup(cfg) {
    var ph = F.makePluginHandler({});
    var plugin = F.loadPlugin(ph);
    var store = { meta: [], added: [] };
    ph.eventlog_db = {
        setNodeMeta: function (n, m) { store.meta.push({ nodeid: n, meta: m }); return Promise.resolve(); },
        addEventsFor: function (n, evs) { store.added.push({ nodeid: n, events: evs }); return Promise.resolve({ count: evs.length }); }
    };
    plugin.nodeConfig = function () { return Promise.resolve(cfg || null); };
    return { plugin: plugin, store: store, gp: F.makeWebserver(F.makeNodes(), {}) };
}
function macBatch(t) {
    return [
        { LogName: 'Install', Level: 4, MsgType: 'Default', TimeCreated: '/Date(' + t + ')/', ProviderName: 'softwareupdated', Subsystem: 'com.apple.SoftwareUpdate', OsCategory: 'scan', ProcessPath: '/System/Library/softwareupdated', Id: '412', Message: 'Scan done' },
        { LogName: 'Application', Level: 2, MsgType: 'Error', TimeCreated: '/Date(' + (t - 1000) + ')/', ProviderName: 'GrÃ¼n', Subsystem: 'de.example.grÃ¼n', OsCategory: '', ProcessPath: '/Applications/GrÃ¼n.app/Contents/MacOS/GrÃ¼n', Id: '77', Message: 'oops' }
    ];
}

test('gatherlogs from a macOS agent: meta stored, categories applied, text repaired, cursor echoed', async function () {
    var s = gatherSetup({ historyCategories: 'Install', historyCategoriesMode: 'exclude' });
    var agent = F.makeAgent('node/d/nA', 'mesh/d/A');
    var T = 1763500000000;
    var caps = { log: true, ndjson: true, osver: '14.5', crashDir: false };
    s.plugin.serveraction({ pluginaction: 'gatherlogs', os: 'macos', caps: caps, cursor: '1763500000000000:1|c1763400000', data: JSON.stringify(macBatch(T)) }, agent, s.gp);
    await F.settle();
    assert.deepStrictEqual(s.store.meta, [{ nodeid: 'node/d/nA', meta: { os: 'macos', caps: caps } }]);
    assert.strictEqual(s.store.added.length, 1);
    var stored = s.store.added[0].events;
    assert.deepStrictEqual(stored.map(function (e) { return e.LogName; }), ['Application'], 'the Install category is excluded by the config set');
    assert.strictEqual(stored[0].ProviderName, 'Grün');
    assert.strictEqual(stored[0].Subsystem, 'de.example.grün');
    assert.strictEqual(stored[0].ProcessPath, '/Applications/Grün.app/Contents/MacOS/Grün');
    assert.strictEqual(stored[0].MsgType, 'Error');
    var acks = agent.sent.filter(function (m) { return m.pluginaction == 'setLVDOC'; });
    assert.strictEqual(acks.length, 1);
    assert.strictEqual(acks[0].value, String(T), 'the newest time of the batch as received');
    assert.strictEqual(acks[0].cursor, '1763500000000000:1|c1763400000');
});

test('gatherlogs: the cursor is echoed for Linux and macOS only', async function () {
    var T = 1763500000000;
    for (var os of ['linux', 'macos', 'windows', undefined]) {
        var s = gatherSetup(null);
        var agent = F.makeAgent('node/d/nA', 'mesh/d/A');
        s.plugin.serveraction({ pluginaction: 'gatherlogs', os: os, cursor: 'c-' + os, data: JSON.stringify(macBatch(T)) }, agent, s.gp);
        await F.settle();
        var ack = agent.sent.filter(function (m) { return m.pluginaction == 'setLVDOC'; })[0];
        assert.ok(ack, 'acked for ' + os);
        if (os == 'linux' || os == 'macos') assert.strictEqual(ack.cursor, 'c-' + os);
        else assert.ok(!('cursor' in ack), 'no cursor for ' + os);
    }
});

test('getNodeHistory: the Windows historyLogs filter is dropped for Linux and macOS nodes', async function () {
    for (var os of ['macos', 'linux', 'windows']) {
        var plugin = loadPlugin(), seen = null;
        plugin.db = {
            getNodeMeta: function (n, cb) { cb({ os: os, caps: {} }); },
            getConfigFor: function () { return Promise.resolve({ historyLogs: 'Application,System', historySources: '' }); },
            getEventsFor: function (n, opts, q, cb) { seen = opts; cb([], 0); },
            getStatsFor: function (n, cb) { cb({ count: 0, last: null }); },
            getFacetsFor: function (n, since, cb) { cb(null); }
        };
        var me = F.makeSession({ _id: 'user/d/root', name: 'root', siteadmin: 0xFFFFFFFF });
        plugin._serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nA', meshid: 'mesh/d/A' }, me, F.makeWebserver(F.makeNodes(), {}));
        await F.settle();
        assert.ok(seen, 'queried for ' + os);
        if (os == 'windows') assert.strictEqual(seen.historyLogs, 'Application,System');
        else assert.ok(!('historyLogs' in seen), 'historyLogs dropped for ' + os);
        var reply = me.sent.filter(function (m) { return m.method == 'onLoadHistory'; })[0];
        assert.strictEqual(reply.meta.os, os);
    }
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

var NODE = 'node/d/m1', WINDOWS = [];
test.afterEach(function () { while (WINDOWS.length) { try { WINDOWS.pop().close(); } catch (e) { } } });
function makeDom(node) {
    var plugin = loadPlugin();
    var dom = new JSDOM_MOD.JSDOM('<!doctype html><html><head></head><body><div id="p19ph-pluginEventLog" class="on"></div><div id="pluginEventLog"></div></body></html>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://mesh.example/' });
    var w = dom.window;
    w.eval(fs.readFileSync(path.join(SCRIPTS, 'marked.js'), 'utf8')); w.eval(fs.readFileSync(path.join(SCRIPTS, 'purify.js'), 'utf8'));
    w.eval('var sent = [], store = {}, tabs = [], redirects = 0;' +
        'function Q(x) { return document.getElementById(x); }' +
        'function QH(x, h) { var e = Q(x); if (e) e.innerHTML = h; }' +
        'function EscapeHtml(x) { if (typeof x == "string") return x.replace(/&/g, "&amp;").replace(/>/g, "&gt;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\'/g, "&apos;"); if (typeof x == "boolean") return x; if (typeof x == "number") return x; }' +
        'function getstore(k, d) { return (k in store) ? store[k] : d; }' +
        'function putstore(k, v) { store[k] = v; }' +
        'function CreateAgentRedirect() { redirects++; return { Start: function () { }, Stop: function () { } }; }' +
        'var meshserver = { send: function (m) { sent.push(JSON.parse(JSON.stringify(m))); } };' +
        'var currentNode = ' + JSON.stringify(Object.assign({ _id: NODE, name: 'MBP-07', meshid: 'mesh/d/A', conn: 0 }, node)) + ';' +
        'var pluginHandler = { eventlog: {}, registerPluginTab: function (t) { tabs.push(t); } };');
    var src = '';
    plugin.exports.forEach(function (n) { src += 'pluginHandler.eventlog.' + n + ' = ' + plugin[n].toString() + ';\n'; });
    w.eval(src);
    w.ph = w.pluginHandler.eventlog;
    WINDOWS.push(w);
    return w;
}
function plain(x) { return JSON.parse(JSON.stringify(x)); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var MAC = { agent: { id: 29 }, osdesc: 'macOS 14.5' };
var TM = Date.now() - 600000;
var MREC = [
    { _id: 'm1', nodeid: NODE, tc: TM, Level: 2, MsgType: 'Error', TimeCreated: [String(TM)], LogName: 'Auth', ProviderName: 'tccd', Subsystem: 'com.apple.TCC', OsCategory: 'access', ProcessPath: '/System/Library/PrivateFrameworks/TCC.framework/Support/tccd', Id: '311', Message: 'Refusing authorization request' },
    { _id: 'm2', nodeid: NODE, tc: TM - 60000, Level: 2, MsgType: 'Crash', TimeCreated: [String(TM - 60000)], LogName: 'Crash', ProviderName: 'Safari', Subsystem: '', OsCategory: '', ProcessPath: '/Library/Logs/DiagnosticReports/Safari-2026-11-19-101500.ips', Id: '', Message: '{"app_name":"Safari","bug_type":"309"}' },
    { _id: 'm3', nodeid: NODE, tc: TM - 120000, Level: 4, MsgType: 'Default', TimeCreated: [String(TM - 120000)], LogName: 'Install', ProviderName: 'installd', Subsystem: 'com.apple.install', OsCategory: 'pkg', ProcessPath: '/System/Library/PrivateFrameworks/PackageKit.framework/Resources/installd', Id: '120', Message: 'Installed "Pages" (14.1)' }
];

test('Android: the tab is registered with the note only, nothing is requested', { skip: SKIP }, async function () {
    for (var node of [{ agent: { id: 14 }, osdesc: 'Android 14', conn: 1 }, { agent: { id: 12 }, conn: 1 }, { osdesc: 'Android 13 (Pixel 7)', conn: 1 }]) {
        var w = makeDom(node), ph = w.ph;
        assert.strictEqual(ph.elPlatform(), 'android');
        assert.strictEqual(ph.elIsSupported(), false);
        assert.deepStrictEqual(plain(ph.registerPluginTab()), { tabTitle: 'Event Log', tabId: 'pluginEventLog' });
        ph.onDeviceRefreshEnd(NODE);
        ph.goPageStart(19);
        ph.elEnsureLive();
        ph.elEnsureShell();
        await sleep(10);
        var note = w.document.getElementById('evlAndroid');
        assert.ok(note, 'the note is shown');
        assert.ok(/Event logs are not available on Android devices/.test(note.textContent));
        assert.ok(/READ_LOGS permission \(granted over adb or root\)/.test(note.textContent));
        assert.strictEqual(w.document.getElementById('evlWrap'), null, 'no Live / History / Assistant');
        assert.strictEqual(w.document.querySelectorAll('#pluginEventLog button').length, 0);
        assert.deepStrictEqual(plain(w.sent), [], 'no checkAccess, no history request');
        assert.strictEqual(w.redirects, 0, 'no agent tunnel');
        assert.strictEqual(w.tabs.length, 1);
        assert.strictEqual(w.tabs[0].tabId, 'pluginEventLog');
    }
});

test('macOS: labels, View selector, status hints, no Warning chip', { skip: SKIP }, function () {
    var w = makeDom(MAC), ph = w.ph, doc = w.document;
    assert.strictEqual(ph.elPlatform(), 'macos');
    assert.strictEqual(ph.elIsSupported(), true);
    ph.onAccess(null, { nodeid: NODE, live: true, history: true, assistant: false, assistantReason: 'permission' });
    var opts = Array.prototype.map.call(doc.querySelectorAll('#evlLxSel option'), function (o) { return [o.value, o.textContent]; });
    assert.deepStrictEqual(opts, [['', 'All'], ['kernel', 'Kernel'], ['auth', 'Security (auth)'], ['install', 'Software install'], ['crash', 'Crash reports'], ['boot', 'This boot']]);
    assert.ok(/unified log/.test(doc.getElementById('evlLxSel').getAttribute('title')));
    ph.onLoadHistory(null, { nodeid: NODE, events: MREC, total: 3, skip: 0, stored: 3, meta: { os: 'macos', caps: { log: true, ndjson: false, osver: '10.14.6', crashDir: false } } });
    ph.elSetView('history');
    var heads = Array.prototype.map.call(doc.querySelectorAll('#evlBody th'), function (th) { return th.textContent; }).join('|');
    assert.ok(/Category/.test(heads) && /PID/.test(heads), heads);
    assert.ok(!/Event ID/.test(heads));
    var status = doc.getElementById('evlStatus').textContent;
    assert.ok(/macOS support is new/.test(status), status);
    assert.ok(/10\.14\.6\) is too old/.test(status), status);
    assert.ok(/Crash reports cannot be read/.test(status), status);
    var chips = doc.getElementById('evlChips').textContent;
    assert.ok(!/Warning/.test(chips), 'no Warning chip on macOS: ' + chips);
    assert.ok(/Critical/.test(chips) && /Error/.test(chips) && /Info/.test(chips));
    assert.ok(/no Warning level/.test(doc.querySelector('#evlChips .evlLbl').getAttribute('title')));
    // the log tool missing wins over the NDJSON hint
    ph.onLoadHistory(null, { nodeid: NODE, events: MREC, total: 3, skip: 0, stored: 3, meta: { os: 'macos', caps: { log: false, ndjson: false, crashDir: true } } });
    status = doc.getElementById('evlStatus').textContent;
    assert.ok(/log tool \(\/usr\/bin\/log\) was not found/.test(status), status);
    assert.ok(!/too old/.test(status) && !/Crash reports cannot/.test(status), status);
});

test('macOS: detail pane, JSON and Copy show the unified log fields', { skip: SKIP }, function () {
    var w = makeDom(MAC), ph = w.ph, doc = w.document;
    ph.onAccess(null, { nodeid: NODE, live: false, history: true, assistant: false, assistantReason: 'permission' });
    ph.onLoadHistory(null, { nodeid: NODE, events: MREC, total: 3, skip: 0, stored: 3 });
    ph.elSetLayout('viewer');
    var key = ph.st.hist.events.filter(function (e) { return e.source == 'tccd'; })[0].key;
    ph.st.selected = key; ph.elUpdate();
    var kv = doc.querySelector('#evlDetails .evlKv').textContent;
    ['Category', 'Auth', 'PID', '311', 'Subsystem', 'com.apple.TCC', 'os_log category', 'access', 'Process path', '/System/Library/PrivateFrameworks/TCC.framework/Support/tccd', 'Log type', 'Error'].forEach(function (t) {
        assert.ok(kv.indexOf(t) >= 0, t + ' in ' + kv);
    });
    assert.ok(!/Unit|Priority/.test(kv), 'no journald fields: ' + kv);
    var txt = ph.elDetailsText(key);
    assert.ok(/^Category:\s+Auth$/m.test(txt), txt);
    assert.ok(/^PID:\s+311$/m.test(txt), txt);
    assert.ok(/^Subsystem:\s+com\.apple\.TCC$/m.test(txt), txt);
    assert.ok(/^os_log category: access$/m.test(txt), txt);
    assert.ok(/^Process path:\s+\/System\/Library\/PrivateFrameworks\/TCC\.framework\/Support\/tccd$/m.test(txt), txt);
    assert.ok(/^Log type:\s+Error$/m.test(txt), txt);
    var raw = plain(ph.elRawOf(ph.byKey[key]));
    assert.strictEqual(raw.Subsystem, 'com.apple.TCC');
    assert.strictEqual(raw.OsCategory, 'access');
    assert.strictEqual(raw.MsgType, 'Error');
    ph.st.dtab = 'json'; ph.elUpdate();
    assert.ok(/"ProcessPath": "\/System\/Library\/PrivateFrameworks\/TCC\.framework\/Support\/tccd"/.test(doc.querySelector('#evlDetails pre').textContent));
    // a crash report: the path is the report file
    var ck = ph.st.hist.events.filter(function (e) { return e.log == 'Crash'; })[0].key;
    ph.st.selected = ck; ph.st.dtab = 'general'; ph.elUpdate();
    kv = doc.querySelector('#evlDetails .evlKv').textContent;
    assert.ok(/Report file\/Library\/Logs\/DiagnosticReports\/Safari-2026-11-19-101500\.ips/.test(kv), kv);
    // Table layout: the expanded row lists the same fields
    ph.elSetLayout('ledger');
    var html = ph.elRenderDetailHtml({ ev: ph.byKey[key], count: 1, times: [ph.byKey[key].time] });
    assert.ok(/Subsystem <b>com\.apple\.TCC<\/b>/.test(html) && /os_log category <b>access<\/b>/.test(html) && /Log type <b>Error<\/b>/.test(html), html);
});

test('macOS: the View selector filters by category and is pushed down to the agent in Live view', { skip: SKIP }, function () {
    var w = makeDom(MAC), ph = w.ph;
    ph.onAccess(null, { nodeid: NODE, live: true, history: true, assistant: false, assistantReason: 'permission' });
    var cmds = [];
    ph.livelog = { State: 3, sendText: function (c) { cmds.push(JSON.parse(JSON.stringify(c))); }, Stop: function () { } };
    ph.elSelCat('install');
    assert.deepStrictEqual(plain(ph.st.filters.logs), { Install: 1 });
    assert.strictEqual(cmds[cmds.length - 1].pluginaction, 'getlivelogs');
    assert.strictEqual(cmds[cmds.length - 1].lsel, 'install');
    ph.elSelCat('crash');
    assert.deepStrictEqual(plain(ph.st.filters.logs), { Crash: 1 });
    assert.strictEqual(cmds[cmds.length - 1].lsel, 'crash');
    ph.elSelCat('boot');
    assert.strictEqual(ph.st.filters.logs, null);
    assert.strictEqual(cmds[cmds.length - 1].lsel, 'boot');
    ph.elSelCat('');
    assert.ok(!('lsel' in cmds[cmds.length - 1]));
    // Live events from the agent, with the config set's Live categories
    ph.st.cfg = { liveCategories: 'Install,Crash', liveCategoriesMode: 'exclude' };
    ph.fe_on_message(null, JSON.stringify({ uid: 1, os: 'macos', caps: { log: true, ndjson: true, crashDir: true }, data: [
        { LogName: 'Install', Level: 4, MsgType: 'Info', TimeCreated: '/Date(' + TM + ')/', ProviderName: 'installd', Subsystem: '', OsCategory: '', ProcessPath: '/usr/libexec/installd', Id: '1', Message: 'a' },
        { LogName: 'Kernel', Level: 1, MsgType: 'Fault', TimeCreated: '/Date(' + TM + ')/', ProviderName: 'kernel', Subsystem: '', OsCategory: '', ProcessPath: '/kernel', Id: '0', Message: 'b' }
    ] }));
    assert.deepStrictEqual(plain(ph.st.live.events.map(function (e) { return e.log; })), ['Kernel']);
    assert.deepStrictEqual(plain(ph.st.meta), { os: 'macos', caps: { log: true, ndjson: true, crashDir: true } });
});

test('Linux keeps its own View selector; Windows has none', { skip: SKIP }, function () {
    var w = makeDom({ agent: { id: 6 }, osdesc: 'Ubuntu 24.04 LTS' }), ph = w.ph, doc = w.document;
    ph.onAccess(null, { nodeid: NODE, live: false, history: true, assistant: false, assistantReason: 'permission' });
    assert.deepStrictEqual(Array.prototype.map.call(doc.querySelectorAll('#evlLxSel option'), function (o) { return o.value; }), ['', 'kernel', 'auth', 'audit', 'boot']);
    ph.onLoadHistory(null, { nodeid: NODE, events: [], total: 0, skip: 0, stored: 0 });
    assert.ok(!/macOS/.test(doc.getElementById('evlStatus').textContent));
    var w2 = makeDom({ agent: { id: 3 }, osdesc: 'Windows 11' });
    w2.ph.onAccess(null, { nodeid: NODE, live: false, history: true, assistant: false, assistantReason: 'permission' });
    assert.strictEqual(w2.document.getElementById('evlLxSel'), null);
});
