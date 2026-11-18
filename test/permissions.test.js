'use strict';
var test = require('node:test');
var assert = require('node:assert');
var F = require('./fakes.js');

var ALICE = { _id: 'user/d/alice', name: 'alice', siteadmin: 0 };
var ROOT = { _id: 'user/d/root', name: 'root', siteadmin: 0xFFFFFFFF };

// Load the plugin with a stubbed _serveraction so the tests see which actions get through the gate.
function setup(opts) {
    opts = opts || {};
    var ph = F.makePluginHandler(opts.grants || {}, opts.permApi);
    var plugin = F.loadPlugin(ph);
    var reached = [];
    plugin._serveraction = function (cmd) { reached.push({ act: cmd.pluginaction, nodeid: cmd.nodeid, meshid: cmd.meshid, node: cmd._node && cmd._node._id }); };
    var gp = F.makeWebserver(F.makeNodes(), opts.rights || { 'mesh/d/A': 0xFFFFFFFF });
    return { ph: ph, plugin: plugin, reached: reached, gp: gp };
}

test('registers the three permissions, all denied by default', function () {
    var s = setup();
    assert.deepStrictEqual(Object.keys(s.ph.registered).sort(), ['deviceAssistant', 'deviceHistoryTab', 'deviceLiveTab']);
    Object.keys(s.ph.registered).forEach(function (k) { assert.strictEqual(s.ph.registered[k].default, 'denied'); });
    assert.strictEqual(s.ph.registered.deviceLiveTab.title, 'Event Log: Live view');
    assert.strictEqual(s.ph.registered.deviceHistoryTab.title, 'Event Log: History and Collect now');
    assert.strictEqual(s.ph.registered.deviceAssistant.title, 'Event Log: Assistant');
});

test('a meshid sent by the browser is ignored: the device group comes from the database', async function () {
    var s = setup({ grants: { 'user/d/alice|deviceHistoryTab': true } });
    var me = F.makeSession(ALICE);
    s.plugin.serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nB', meshid: 'mesh/d/A' }, me, s.gp);
    s.plugin.serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nA', meshid: 'mesh/d/B' }, me, s.gp);
    await F.settle();
    assert.deepStrictEqual(s.reached.map(function (r) { return r.nodeid + '@' + r.meshid; }), ['node/d/nA@mesh/d/A']);
    var denied = me.sent.filter(function (m) { return m.method == 'onAccessDenied'; });
    assert.strictEqual(denied.length, 1);
    assert.strictEqual(denied[0].nodeid, 'node/d/nB');
    // the permission check got the real device group
    assert.ok(s.ph.calls.every(function (c) { return c.nodeId == 'node/d/nA' && c.meshId == 'mesh/d/A'; }));
});

test('History and Collect now need the History permission', async function () {
    var s = setup();
    var me = F.makeSession(ALICE);
    s.plugin.serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nA' }, me, s.gp);
    s.plugin.serveraction({ pluginaction: 'collectNow', nodeid: 'node/d/nA' }, me, s.gp);
    await F.settle();
    assert.strictEqual(s.reached.length, 0);
    assert.strictEqual(me.sent.filter(function (m) { return m.method == 'onAccessDenied'; }).length, 2);

    var s2 = setup({ grants: { 'user/d/alice|deviceHistoryTab': true } });
    var me2 = F.makeSession(ALICE);
    s2.plugin.serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nA' }, me2, s2.gp);
    s2.plugin.serveraction({ pluginaction: 'collectNow', nodeid: 'node/d/nA' }, me2, s2.gp);
    await F.settle();
    assert.deepStrictEqual(s2.reached.map(function (r) { return r.act; }), ['getNodeHistory', 'collectNow']);
});

test('checkAccess reports exactly the granted views', async function () {
    var s = setup({ grants: { 'user/d/alice|deviceLiveTab': true } });
    var me = F.makeSession(ALICE);
    s.plugin.serveraction({ pluginaction: 'checkAccess', nodeid: 'node/d/nA' }, me, s.gp);
    await F.settle();
    var a = me.sent.filter(function (m) { return m.method == 'onAccess'; })[0];
    assert.ok(a);
    assert.strictEqual(a.nodeid, 'node/d/nA');
    assert.strictEqual(a.live, true);
    assert.strictEqual(a.history, false);
    assert.strictEqual(a.assistant, false);
});

test('full administrators get every view', async function () {
    var s = setup();
    var me = F.makeSession(ROOT);
    s.plugin.serveraction({ pluginaction: 'checkAccess', nodeid: 'node/d/nA' }, me, s.gp);
    await F.settle();
    var a = me.sent.filter(function (m) { return m.method == 'onAccess'; })[0];
    assert.strictEqual(a.live, true);
    assert.strictEqual(a.history, true);
});

test('without the permission framework only full administrators pass', async function () {
    var s = setup({ permApi: false, grants: { 'user/d/alice|deviceHistoryTab': true } });
    var me = F.makeSession(ALICE), root = F.makeSession(ROOT);
    s.plugin.serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nA' }, me, s.gp);
    s.plugin.serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nA' }, root, s.gp);
    await F.settle();
    assert.deepStrictEqual(s.reached.map(function (r) { return r.act; }), ['getNodeHistory']);
    assert.strictEqual(s.reached.length, 1);
});

test('a device the user cannot see is refused, also for full admins without device rights', async function () {
    var s = setup({ rights: {} });
    var root = F.makeSession(ROOT);
    s.plugin.serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nA' }, root, s.gp);
    s.plugin.serveraction({ pluginaction: 'checkAccess', nodeid: 'node/d/nA' }, root, s.gp);
    await F.settle();
    assert.strictEqual(s.reached.length, 0);
    var d = root.sent.filter(function (m) { return m.method == 'onAccessDenied'; });
    assert.deepStrictEqual(d.map(function (m) { return m.act; }).sort(), ['checkAccess', 'getNodeHistory']);
});

test('browser sessions cannot send agent actions; agents cannot send user actions', async function () {
    var s = setup({ grants: { 'user/d/alice|deviceHistoryTab': true } });
    var me = F.makeSession(ALICE), agent = F.makeAgent('node/d/nA', 'mesh/d/A');
    s.plugin.serveraction({ pluginaction: 'gatherlogs', data: '[]' }, me, s.gp);
    s.plugin.serveraction({ pluginaction: 'sendlog', sessionid: 'user/d/x/1' }, me, s.gp);
    s.plugin.serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nA' }, agent, s.gp);
    s.plugin.serveraction({ pluginaction: 'checkAccess', nodeid: 'node/d/nA' }, agent, s.gp);
    s.plugin.serveraction({ pluginaction: 'gatherlogs', data: '[]' }, agent, s.gp);
    await F.settle();
    assert.deepStrictEqual(s.reached.map(function (r) { return r.act; }), ['gatherlogs']);
});

test('server-only fields cannot be injected by the browser', async function () {
    var s = setup({ grants: { 'user/d/alice|deviceHistoryTab': true } });
    var me = F.makeSession(ALICE);
    s.plugin.serveraction({ pluginaction: 'adminSaveConfig', _node: { _id: 'node/d/nB' }, _rights: 0xFFFFFFFF }, me, s.gp);
    s.plugin.serveraction({ pluginaction: 'getNodeHistory', nodeid: 'node/d/nA', _node: { _id: 'node/d/nB' } }, me, s.gp);
    await F.settle();
    assert.strictEqual(s.reached[0].act, 'adminSaveConfig');
    assert.strictEqual(s.reached[0].node, undefined);
    assert.strictEqual(s.reached[1].node, 'node/d/nA');
});

test('isFullAdmin accepts only all server rights', function () {
    var s = setup();
    assert.strictEqual(s.plugin.isFullAdmin(F.makeSession(ROOT)), true);
    assert.strictEqual(s.plugin.isFullAdmin(F.makeSession({ _id: 'u', siteadmin: 0xFFFFFFFE })), false);
    assert.strictEqual(s.plugin.isFullAdmin(F.makeSession({ _id: 'u', siteadmin: 8 })), false);
    assert.strictEqual(s.plugin.isFullAdmin(null), false);
});
