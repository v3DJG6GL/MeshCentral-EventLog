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

// ---- Assistant actions ------------------------------------------------------------------------------------------
// The real _serveraction runs; obj.ai is a stub that records what reaches it.
function setupAi(opts) {
    opts = opts || {};
    var ph = F.makePluginHandler(opts.grants || {}, opts.permApi);
    var plugin = F.loadPlugin(ph);
    var ai = { calls: [], admin: { calls: [], handle: function (cmd) { ai.admin.calls.push(cmd.pluginaction); return true; } } };
    ai.handle = function (cmd, myparent) { ai.calls.push({ act: cmd.pluginaction, nodeid: cmd.nodeid, meshid: cmd.meshid, node: cmd._node && cmd._node._id, rights: cmd._rights, user: myparent.user._id }); return Promise.resolve(); };
    ai.onAgentData = function (cmd, agent) { ai.agentData = (ai.agentData || []).concat([cmd.action]); return true; };
    ai.accessInfo = function () { return Promise.resolve({ assistant: true, assistantReason: null, endpoint: null, categories: {}, remaining: null }); };
    if (opts.noAi !== true) plugin.ai = ai;
    var gp = F.makeWebserver(F.makeNodes(), opts.rights || { 'mesh/d/A': 0xFFFFFFFF });
    return { ph: ph, plugin: plugin, ai: ai, gp: gp };
}
var AI_DEVICE = ['aiStart', 'aiConfirm', 'aiSend', 'aiFeedback'];
var AI_ADMIN = ['aiAdminGet', 'aiAdminSaveEndpoint', 'aiAdminDeleteEndpoint', 'aiAdminSaveSettings', 'aiAdminTest', 'aiAdminModels', 'aiAdminAudit'];

test('Assistant device actions need the Assistant permission', async function () {
    var s = setupAi({ grants: { 'user/d/alice|deviceHistoryTab': true, 'user/d/alice|deviceLiveTab': true } });
    var me = F.makeSession(ALICE);
    AI_DEVICE.forEach(function (a) { s.plugin.serveraction({ pluginaction: a, nodeid: 'node/d/nA', reqId: 'q-' + a }, me, s.gp); });
    await F.settle();
    assert.strictEqual(s.ai.calls.length, 0);
    var d = me.sent.filter(function (m) { return m.method == 'onAccessDenied'; });
    assert.deepStrictEqual(d.map(function (m) { return m.act; }).sort(), AI_DEVICE.slice().sort());
    assert.ok(d.every(function (m) { return /deviceAssistant/.test(m.reason) && m.reqId == 'q-' + m.act; }), 'reason names the permission, reqId echoed');
});

test('Assistant device actions need the Details right on top of the permission', async function () {
    var grants = { 'user/d/alice|deviceAssistant': true };
    var s = setupAi({ grants: grants, rights: { 'mesh/d/A': 0x00000008 } });   // remote control, no Details
    var me = F.makeSession(ALICE);
    AI_DEVICE.forEach(function (a) { s.plugin.serveraction({ pluginaction: a, nodeid: 'node/d/nA' }, me, s.gp); });
    await F.settle();
    assert.strictEqual(s.ai.calls.length, 0);
    assert.strictEqual(me.sent.filter(function (m) { return m.method == 'onAccessDenied' && /0x100000/.test(m.reason); }).length, 4);

    var s2 = setupAi({ grants: grants, rights: { 'mesh/d/A': 0x00100000 } });
    var me2 = F.makeSession(ALICE);
    AI_DEVICE.forEach(function (a) { s2.plugin.serveraction({ pluginaction: a, nodeid: 'node/d/nA', _rights: 0xFFFFFFFF }, me2, s2.gp); });
    await F.settle();
    assert.deepStrictEqual(s2.ai.calls.map(function (c) { return c.act; }), AI_DEVICE);
    assert.ok(s2.ai.calls.every(function (c) { return c.node == 'node/d/nA' && c.rights == 0x00100000 && c.meshid == 'mesh/d/A'; }), 'rights from the database, not the browser');

    var s3 = setupAi({ grants: grants });   // full device rights pass
    var me3 = F.makeSession(ALICE);
    s3.plugin.serveraction({ pluginaction: 'aiStart', nodeid: 'node/d/nA' }, me3, s3.gp);
    await F.settle();
    assert.strictEqual(s3.ai.calls.length, 1);
});

test('Assistant: a spoofed meshid is irrelevant', async function () {
    var s = setupAi({ grants: { 'user/d/alice|deviceAssistant': true } });
    var me = F.makeSession(ALICE);
    s.plugin.serveraction({ pluginaction: 'aiStart', nodeid: 'node/d/nB', meshid: 'mesh/d/A' }, me, s.gp);
    s.plugin.serveraction({ pluginaction: 'aiStart', nodeid: 'node/d/nA', meshid: 'mesh/d/B' }, me, s.gp);
    await F.settle();
    assert.deepStrictEqual(s.ai.calls.map(function (c) { return c.nodeid + '@' + c.meshid; }), ['node/d/nA@mesh/d/A']);
    assert.strictEqual(me.sent.filter(function (m) { return m.method == 'onAccessDenied' && m.nodeid == 'node/d/nB'; }).length, 1);
    assert.ok(s.ph.calls.every(function (c) { return c.nodeId == 'node/d/nA' && c.meshId == 'mesh/d/A'; }));
});

test('agents can never reach an Assistant action', async function () {
    var s = setupAi({ grants: { 'user/d/alice|deviceAssistant': true } });
    var agent = F.makeAgent('node/d/nA', 'mesh/d/A');
    AI_DEVICE.concat(['aiStop', 'aiClose']).concat(AI_ADMIN).concat(['aiSomethingNew']).forEach(function (a) {
        s.plugin.serveraction({ pluginaction: a, nodeid: 'node/d/nA', convId: 'c1' }, agent, s.gp);
    });
    await F.settle();
    assert.strictEqual(s.ai.calls.length, 0);
    assert.strictEqual(s.ai.admin.calls.length, 0);
    assert.strictEqual(agent.sent.length, 0);
});

test('Assistant admin actions need a full administrator', async function () {
    var s = setupAi();
    var me = F.makeSession(ALICE), admin = F.makeSession({ _id: 'user/d/admin', name: 'admin', siteadmin: 0xFFFFFFFE }), root = F.makeSession(ROOT);
    AI_ADMIN.forEach(function (a) {
        s.plugin.serveraction({ pluginaction: a, reqId: 'r-' + a }, me, s.gp);
        s.plugin.serveraction({ pluginaction: a, reqId: 'r-' + a }, admin, s.gp);
    });
    await F.settle();
    assert.strictEqual(s.ai.admin.calls.length, 0);
    [me, admin].forEach(function (sess) {
        var errs = sess.sent.filter(function (m) { return m.method == 'aiAdminError'; });
        assert.strictEqual(errs.length, AI_ADMIN.length);
        assert.ok(errs.every(function (m) { return m.scope == 'access' && m.reqId == 'r-' + AI_ADMIN[errs.indexOf(m)]; }));
    });
    AI_ADMIN.forEach(function (a) { s.plugin.serveraction({ pluginaction: a, reqId: 'r' }, root, s.gp); });
    await F.settle();
    assert.deepStrictEqual(s.ai.admin.calls, AI_ADMIN);

    var u = setupAi({ noAi: true });
    var root2 = F.makeSession(ROOT);
    u.plugin.serveraction({ pluginaction: 'aiAdminGet', reqId: 7 }, root2, u.gp);
    await F.settle();
    assert.deepStrictEqual([root2.sent[0].method, root2.sent[0].scope, root2.sent[0].reqId], ['aiAdminError', 'unavailable', 7]);
});

test('aiStop / aiClose reach the Assistant without device checks (ownership is checked there), also after a revoke', async function () {
    var s = setupAi({ grants: {} , rights: {} });   // no permission, no device rights any more
    var me = F.makeSession(ALICE);
    s.plugin.serveraction({ pluginaction: 'aiStop', nodeid: 'node/d/nA', convId: 'c1' }, me, s.gp);
    s.plugin.serveraction({ pluginaction: 'aiClose', nodeid: 'node/d/nA', convId: 'c1', _node: { _id: 'node/d/nB' } }, me, s.gp);
    await F.settle();
    assert.deepStrictEqual(s.ai.calls.map(function (c) { return c.act; }), ['aiStop', 'aiClose']);
    assert.ok(s.ai.calls.every(function (c) { return c.user == 'user/d/alice' && c.node === undefined; }), 'no server-only fields from the browser');
    assert.strictEqual(me.sent.length, 0);
});

test('without an Assistant instance, device actions answer onAiError unavailable', async function () {
    var s = setupAi({ noAi: true, grants: { 'user/d/alice|deviceAssistant': true } });
    var me = F.makeSession(ALICE);
    s.plugin.serveraction({ pluginaction: 'aiStart', nodeid: 'node/d/nA', reqId: 'r1' }, me, s.gp);
    s.plugin.serveraction({ pluginaction: 'aiStop', nodeid: 'node/d/nA', convId: 'c1' }, me, s.gp);
    await F.settle();
    assert.strictEqual(me.sent.length, 1);
    assert.deepStrictEqual([me.sent[0].method, me.sent[0].code, me.sent[0].reqId, me.sent[0].nodeid], ['onAiError', 'unavailable', 'r1', 'node/d/nA']);
});

test('reauthorize re-checks rights, permission and the Details right', async function () {
    var gp = F.makeWebserver(F.makeNodes(), { 'mesh/d/A': 0x00100000, 'mesh/d/B': 0x8 });
    var s = setupAi({ grants: { 'user/d/alice|deviceAssistant': true } });
    var me = F.makeSession(ALICE);
    var r = await s.plugin.reauthorize(me, gp, 'node/d/nA');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.node._id, 'node/d/nA');
    assert.strictEqual(r.rights, 0x00100000);
    r = await s.plugin.reauthorize(me, gp, 'node/d/nB');
    assert.strictEqual(r.ok, false);
    assert.ok(/Details/.test(r.reason));
    r = await s.plugin.reauthorize(me, gp, 'node/d/none');
    assert.strictEqual(r.ok, false);
    r = await s.plugin.reauthorize(me, null, 'node/d/nA');
    assert.strictEqual(r.ok, false);
    var s2 = setupAi({ grants: {} });
    r = await s2.plugin.reauthorize(me, gp, 'node/d/nA');
    assert.strictEqual(r.ok, false);
    assert.ok(/deviceAssistant/.test(r.reason));
    r = await s2.plugin.reauthorize(F.makeSession(ROOT), F.makeWebserver(F.makeNodes(), { 'mesh/d/A': 0xFFFFFFFF }), 'node/d/nA');
    assert.strictEqual(r.ok, true);
});

test('hook_processAgentData forwards only software replies', function () {
    var s = setupAi();
    var agent = F.makeAgent('node/d/nA', 'mesh/d/A');
    s.plugin.hook_processAgentData({ action: 'msg' }, agent, s.gp);
    s.plugin.hook_processAgentData(null, agent, s.gp);
    s.plugin.hook_processAgentData({ action: 'software', sessionid: 'eventlogai:1' }, agent, s.gp);
    assert.deepStrictEqual(s.ai.agentData, ['software']);
    s.ai.onAgentData = function () { throw new Error('boom'); };
    s.plugin.hook_processAgentData({ action: 'software' }, agent, s.gp);   // never throws into MeshCentral
    s.plugin.ai = null;
    s.plugin.hook_processAgentData({ action: 'software' }, agent, s.gp);
});

test('adminSaveConfig: only full administrators set the Assistant endpoint, and only to an existing one', async function () {
    var s = setupAi();
    var saved = [];
    s.plugin.db = {
        updateDefaultConfig: function (o) { saved.push(Object.assign({}, o)); return Promise.resolve(1); },
        updateConfig: function (id, o) { saved.push(Object.assign({ _set: id }, o)); return Promise.resolve({ insertedId: id }); },
        getAllConfigSets: function () { return Promise.resolve([]); }
    };
    s.ai.store = { getEndpoint: function (id) { return Promise.resolve(id == 'aiEndpoint:000000000001' ? { id: id } : null); } };
    var root = F.makeSession(ROOT), admin = F.makeSession({ _id: 'user/d/admin', name: 'admin', siteadmin: 0xFFFFFFFE });
    s.plugin.serveraction({ pluginaction: 'adminSaveConfig', id: '_default', opts: { name: 'D', aiEndpointId: 'aiEndpoint:000000000001', aiKey: 'x' } }, root, s.gp);
    s.plugin.serveraction({ pluginaction: 'adminSaveConfig', id: 'set1', opts: { name: 'S', aiEndpointId: 'aiEndpoint:999999999999' } }, root, s.gp);
    s.plugin.serveraction({ pluginaction: 'adminSaveConfig', id: 'set2', opts: { name: 'S2', aiEndpointId: 5 } }, root, s.gp);
    s.plugin.serveraction({ pluginaction: 'adminSaveConfig', id: 'set3', opts: { name: 'S3', aiEndpointId: '' } }, root, s.gp);
    s.plugin.serveraction({ pluginaction: 'adminSaveConfig', id: 'set4', opts: { name: 'S4', aiEndpointId: 'aiEndpoint:000000000001' } }, admin, s.gp);
    await F.settle();
    assert.strictEqual(saved.length, 3);
    saved.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    assert.deepStrictEqual(saved[0], { name: 'D', aiEndpointId: 'aiEndpoint:000000000001' });
    assert.deepStrictEqual(saved[1], { _set: 'set3', name: 'S3', aiEndpointId: '' });
    assert.deepStrictEqual(saved[2], { _set: 'set4', name: 'S4' }, 'a non-full administrator cannot change the endpoint');
    var fails = root.sent.filter(function (m) { return m.method == 'adminSaveFailed'; });
    assert.deepStrictEqual(fails.map(function (m) { return m.error; }), ['Unknown Assistant endpoint', 'Unknown Assistant endpoint']);
    assert.strictEqual(admin.sent.filter(function (m) { return m.method == 'adminUpdateConfigSets'; }).length, 1);
});
