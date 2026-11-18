'use strict';
// End to end through eventlog.js: the plugin with a REAL storage backend (SQLite through a node:sqlite shim, in
// memory), a fake MeshCentral server and the mock LLM. Everything is driven through serveraction the way the
// browser does it: a full administrator sets up an endpoint and assigns it, users ask the Assistant.
// Skipped when node:sqlite is not available.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var F = require('./fakes.js');
var M = require('./ai/mock-llm.js');

var CHAT = '/v1/chat/completions';
var NODE = 'node/d/nA';
var ROOT = { _id: 'user/d/root', name: 'root', siteadmin: 0xFFFFFFFF };
var ALICE = { _id: 'user/d/alice', name: 'alice', siteadmin: 0 };
var BOB = { _id: 'user/d/bob', name: 'bob', siteadmin: 0 };

function sqliteSkip() { try { require('node:sqlite'); return false; } catch (e) { return 'node:sqlite not available in this Node version'; } }

// MeshCentral's sqlite3 handle shape (same shim as test/db.test.js)
function sqliteShim() {
    var S = require('node:sqlite');
    var db = new S.DatabaseSync(':memory:');
    return {
        all: function (sql, params, cb) {
            setImmediate(function () {
                var rows = null, err = null;
                try { var st = db.prepare(sql); rows = st.all.apply(st, params || []); } catch (e) { err = e; }
                cb(err, rows);
            });
        },
        run: function (sql, params, cb) {
            setImmediate(function () {
                var ctx = { changes: 0, lastID: undefined }, err = null;
                try { var st = db.prepare(sql), r = st.run.apply(st, params || []); ctx.changes = Number(r.changes); ctx.lastID = Number(r.lastInsertRowid); } catch (e) { err = e; }
                if (typeof cb == 'function') cb.call(ctx, err);
            });
        },
        close: function () { try { db.close(); } catch (e) { } }
    };
}

// MeshCentral's own documents for the device (what the Assistant reads through meshServer.db.Get)
function meshDocs(node) {
    var d = {};
    d[NODE] = node;
    d['si' + NODE] = { _id: 'si' + NODE, hardware: { windows: { osinfo: { Caption: 'Microsoft Windows 11 Pro', Version: '10.0.22631' } } } };
    d['if' + NODE] = { _id: 'if' + NODE, netif2: { Ethernet: [{ address: '192.168.1.50', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:01' }] } };
    d['nt' + NODE] = { _id: 'nt' + NODE, value: 'PSU replaced in March.' };
    return d;
}

function session(user) {
    var sent = [], h = {};
    var ws = {
        readyState: 1,
        send: function (s) { sent.push(JSON.parse(s)); },
        once: function (ev, fn) { (h[ev] = h[ev] || []).push(fn); },
        close: function () { ws.readyState = 3; (h.close || []).splice(0).forEach(function (f) { f(); }); }
    };
    return { user: user, domain: { id: 'd' }, ws: ws, sent: sent };
}
function waitFor(sess, method, pred, ms) {
    return new Promise(function (resolve, reject) {
        var t0 = Date.now();
        (function poll() {
            var m = sess.sent.find(function (x) { return x.method === method && (!pred || pred(x)); });
            if (m) return resolve(m);
            if (Date.now() - t0 > (ms || 5000)) return reject(new Error('timeout waiting for ' + method + '; got ' + sess.sent.map(function (x) { return x.method + (x.code ? ':' + x.code : ''); }).join(',')));
            setTimeout(poll, 5);
        })();
    });
}
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function refsIn(text) { var out = [], re = /\\?"(E\d+)\\?"/g, m; while ((m = re.exec(text))) if (out.indexOf(m[1]) < 0) out.push(m[1]); return out; }

// The mock model: with tools and nothing to cite yet it calls get_events; otherwise it answers citing a ref it saw.
function brain(rec) {
    var b = rec.body || {};
    var msgs = Array.isArray(b.messages) ? b.messages : [];
    var refs = refsIn(rec.bodyText);
    var hasToolResult = msgs.some(function (m) { return m.role === 'tool'; });
    if (!hasToolResult && Array.isArray(b.tools) && b.tools.length && refs.length == 0) {
        return { sse: M.chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { limit: 5 } }] }), split: true };
    }
    return { sse: M.chatSse({ text: 'The disk reported errors [' + (refs[0] || 'E1') + '].' }), split: true };
}

test('integration: plugin + SQLite + mock LLM, driven through serveraction', { skip: sqliteSkip() }, async function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evl-int-'));
    var shim = sqliteShim();
    var mock = await M.createMockLlm({ seed: 11 });
    var nodes = F.makeNodes();
    nodes[NODE].osdesc = 'Microsoft Windows 11 Pro';
    var docs = meshDocs(nodes[NODE]);
    var gp = F.makeWebserver(nodes, { 'mesh/d/A': 0xFFFFFFFF });
    var meshServer = {
        args: {},
        db: {
            databaseType: 8, file: shim,
            Get: function (id, cb) { var d = docs[id]; setImmediate(function () { cb(null, d ? [JSON.parse(JSON.stringify(d))] : []); }); },
            GetNodeEventsWithLimit: function (nodeid, domain, limit, filter, cb) { setImmediate(function () { cb(null, [{ time: new Date(), action: 'agentconnect', msg: 'Agent connected' }]); }); },
            GetNodeEventsSelfWithLimit: function (nodeid, domain, userid, limit, filter, cb) { setImmediate(function () { cb(null, []); }); }
        },
        webserver: gp,
        loginCookieEncryptionKey: Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        getConfigFilePath: function (name) { return path.join(dir, name); },
        GetConnectivityState: function () { return { connectivity: 1, powerState: 1 }; }
    };
    var ph = F.makePluginHandler({ 'user/d/alice|deviceAssistant': true, 'user/d/alice|deviceHistoryTab': true });
    ph.parent = meshServer;
    meshServer.pluginHandler = ph;
    var plugin = F.loadPlugin(ph);
    var logs = [], firstDb = null;
    var origLog = console.log;
    console.log = function () { logs.push(Array.prototype.join.call(arguments, ' ')); };
    try {
        plugin.server_startup();
        assert.ok(plugin.ai, 'Assistant created');
        assert.strictEqual(ph.eventlog_ai, plugin.ai);
        assert.ok(plugin.ai.store && plugin.ai.admin, 'store and admin available');
        await plugin.db.ready();

        var root = session(ROOT), alice = session(ALICE), bob = session(BOB);
        var act = function (sess, o) { plugin.serveraction(Object.assign({ action: 'plugin', plugin: 'eventlog' }, o), sess, gp); };

        // ---- admin: endpoint (loopback mock), settings, assignment to the default config set ----
        act(alice, { pluginaction: 'aiAdminGet', reqId: 'a0' });
        var denied = await waitFor(alice, 'aiAdminError', function (m) { return m.reqId === 'a0'; });
        assert.strictEqual(denied.scope, 'access');

        act(root, { pluginaction: 'aiAdminSaveEndpoint', reqId: 'a1', endpoint: { name: 'Mock', format: 'openai-chat', baseUrl: mock.base, model: 'test-model', toolMode: 'tools', contextTokens: 32768 }, keyAction: 'set', key: 'sk-integration-SECRET-1234' });
        var saved = await waitFor(root, 'aiAdminSaved', function (m) { return m.reqId === 'a1'; });
        var epId = saved.endpoint.id;
        assert.ok(/^aiEndpoint:[0-9a-f]{12}$/.test(epId));
        assert.strictEqual(saved.endpoint.network, 'loopback');
        assert.strictEqual(saved.endpoint.hasKey, true);
        assert.ok(JSON.stringify(root.sent).indexOf('sk-integration-SECRET') < 0, 'the key never goes back to the browser');

        act(root, { pluginaction: 'aiAdminSaveSettings', reqId: 'a2', settings: { enabled: true, storeTranscripts: true, previewPolicy: 'every', quotas: { perUserQuestions: 0, perUserTokens: 0 } } });
        await waitFor(root, 'aiAdminSettingsSaved', function (m) { return m.reqId === 'a2'; });

        act(root, { pluginaction: 'adminSaveConfig', id: '_default', opts: { name: 'Default', aiEndpointId: 'aiEndpoint:000000000000' } });
        var bad = await waitFor(root, 'adminSaveFailed');
        assert.strictEqual(bad.error, 'Unknown Assistant endpoint');
        act(root, { pluginaction: 'adminSaveConfig', id: '_default', opts: { name: 'Default', aiEndpointId: epId } });
        var sets = await waitFor(root, 'adminUpdateConfigSets');
        var def = sets.sets.find(function (s) { return s.default === true; });
        assert.strictEqual(def.aiEndpointId, epId);
        assert.strictEqual(def.historyLogs, 'Application,System', 'the other fields of the set are kept');

        act(root, { pluginaction: 'aiAdminGet', reqId: 'a3' });
        var data = await waitFor(root, 'aiAdminData', function (m) { return m.reqId === 'a3'; });
        assert.deepStrictEqual(data.usedBy[epId], ['Default']);
        assert.strictEqual(data.settings.enabled, true);

        // ---- events in the real database ----
        var now = Date.now(), raw = [];
        for (var i = 0; i < 12; i++) raw.push({ TimeCreated: '/Date(' + (now - (i + 1) * 60000) + ')/', Level: 2, LogName: 'System', ProviderName: 'disk', Id: 7, Message: 'The device, \\Device\\Harddisk0\\DR0, has a bad block. (' + i + ')' });
        for (var j = 0; j < 5; j++) raw.push({ TimeCreated: '/Date(' + (now - (j + 1) * 3600000) + ')/', Level: 3, LogName: 'Application', ProviderName: 'App', Id: 1000 + j, Message: 'Warning ' + j });
        await plugin.db.addEventsFor(NODE, raw);
        await plugin.db.addEventsFor('node/d/nB', [{ TimeCreated: '/Date(' + now + ')/', Level: 2, LogName: 'System', ProviderName: 'disk', Id: 7, Message: 'OTHER-DEVICE' }]);

        // ---- access ----
        act(alice, { pluginaction: 'checkAccess', nodeid: NODE });
        var acc = await waitFor(alice, 'onAccess');
        assert.strictEqual(acc.assistant, true, JSON.stringify(acc));
        assert.strictEqual(acc.history, true);
        assert.strictEqual(acc.live, false);
        assert.deepStrictEqual([acc.endpoint.name, acc.endpoint.model, acc.endpoint.network], ['Mock', 'test-model', 'loopback']);

        act(bob, { pluginaction: 'checkAccess', nodeid: NODE });
        var accB = await waitFor(bob, 'onAccess');
        assert.strictEqual(accB.assistant, false);
        assert.strictEqual(accB.assistantReason, 'permission');
        act(bob, { pluginaction: 'aiStart', nodeid: NODE, reqId: 'b1', mode: 'ask', input: { text: 'hi' } });
        var dB = await waitFor(bob, 'onAccessDenied');
        assert.deepStrictEqual([dB.act, dB.reqId], ['aiStart', 'b1']);

        // ---- ask: tool loop, steps, deltas, citations ----
        mock.always(CHAT, brain);
        act(alice, { pluginaction: 'aiStart', nodeid: NODE, meshid: 'mesh/d/B', reqId: 'r1', mode: 'ask', input: { text: 'What is wrong with this PC?' } });
        var started = await waitFor(alice, 'onAiStarted', function (m) { return m.reqId === 'r1'; });
        assert.strictEqual(started.nodeid, NODE);
        assert.strictEqual(started.network, 'loopback');
        var done = await waitFor(alice, 'onAiDone', function (m) { return m.convId === started.convId; });
        var steps = alice.sent.filter(function (m) { return m.method === 'onAiStep' && m.convId === started.convId; });
        assert.ok(steps.some(function (s) { return s.tool === 'get_events'; }), 'a get_events step');
        assert.ok(alice.sent.some(function (m) { return m.method === 'onAiDelta' && m.convId === started.convId; }), 'streamed deltas');
        var cites = Object.keys(done.citations || {});
        assert.ok(cites.length >= 1, 'a citation: ' + JSON.stringify(done));
        var cited = done.citations[cites[0]];
        assert.strictEqual(cited.nodeid, NODE);
        assert.ok(cited._id && /^\d+$/.test(cited._id), 'cited record in getNodeHistory shape');
        // the key reached the endpoint, never the browser
        var chatReq = mock.requests.filter(function (r) { return r.path === CHAT; });
        assert.ok(chatReq.length >= 2);
        assert.strictEqual(chatReq[0].headers.authorization, 'Bearer sk-integration-SECRET-1234');
        assert.ok(JSON.stringify(alice.sent).indexOf('sk-integration-SECRET') < 0);
        assert.ok(mock.requests.every(function (r) { return r.bodyText.indexOf('OTHER-DEVICE') < 0; }), 'no other device data sent');

        // follow-up in the same conversation
        var nDone = alice.sent.filter(function (m) { return m.method === 'onAiDone'; }).length;
        act(alice, { pluginaction: 'aiSend', nodeid: NODE, convId: started.convId, text: 'And now?' });
        await waitFor(alice, 'onAiDone', function () { return alice.sent.filter(function (m) { return m.method === 'onAiDone'; }).length > nDone; });

        // ---- citation jumps in History: recIds and aroundId on the real database ----
        act(alice, { pluginaction: 'getNodeHistory', nodeid: NODE, recIds: [cited._id, '999999', 'x'.repeat(80)] });
        var h1 = await waitFor(alice, 'onLoadHistory', function (m) { return Array.isArray(m.recIds); });
        assert.deepStrictEqual(h1.events.map(function (e) { return e._id; }), [cited._id]);
        assert.strictEqual(h1.total, 1);
        var all = await new Promise(function (r) { plugin.db.getEventsFor(NODE, def, { limit: 100 }, function (ev) { r(ev); }); });
        var target = all[all.length - 1];
        act(alice, { pluginaction: 'getNodeHistory', nodeid: NODE, limit: 5, aroundId: target._id });
        var h2 = await waitFor(alice, 'onLoadHistory', function (m) { return m.aroundId === target._id; });
        assert.ok(h2.events.some(function (e) { return e._id === target._id; }), 'the page holds the event');
        assert.strictEqual(h2.skip % 5, 0);
        assert.ok(!h2.aroundMissing);
        act(alice, { pluginaction: 'getNodeHistory', nodeid: NODE, limit: 5, aroundId: '424242' });
        var h3 = await waitFor(alice, 'onLoadHistory', function (m) { return m.aroundId === '424242'; });
        assert.strictEqual(h3.aroundMissing, true);
        assert.strictEqual(h3.skip, 0);
        var otherId = await new Promise(function (r) { plugin.db.getEventsFor('node/d/nB', {}, {}, function (ev) { r(ev[0]._id); }); });
        act(alice, { pluginaction: 'getNodeHistory', nodeid: NODE, recIds: [otherId] });
        var h4 = await waitFor(alice, 'onLoadHistory', function (m) { return Array.isArray(m.recIds) && m.recIds[0] === otherId; });
        assert.strictEqual(h4.events.length, 0, 'another device\'s event is not returned');

        // ---- explain and diagnose ----
        act(alice, { pluginaction: 'aiStart', nodeid: NODE, reqId: 'r2', mode: 'explain', input: { eventId: target._id } });
        var s2 = await waitFor(alice, 'onAiStarted', function (m) { return m.reqId === 'r2'; });
        var d2 = await waitFor(alice, 'onAiDone', function (m) { return m.convId === s2.convId; });
        assert.ok(typeof d2.text === 'string' && d2.text.length > 0);
        act(alice, { pluginaction: 'aiStart', nodeid: NODE, reqId: 'r3', mode: 'diagnose', input: { window: '24h' } });
        var s3 = await waitFor(alice, 'onAiStarted', function (m) { return m.reqId === 'r3'; });
        await waitFor(alice, 'onAiDone', function (m) { return m.convId === s3.convId; });

        // ---- Stop while the answer streams ----
        mock.reset();
        mock.always(CHAT, { sse: M.chatSse({ text: 'Partial answer that never ends', textPieces: 3, done: false }), hang: true });
        act(alice, { pluginaction: 'aiStart', nodeid: NODE, reqId: 'r4', mode: 'ask', input: { text: 'Long question' } });
        var s4 = await waitFor(alice, 'onAiStarted', function (m) { return m.reqId === 'r4'; });
        await waitFor(alice, 'onAiDelta', function (m) { return m.convId === s4.convId; });
        var hung = mock.requests.filter(function (r) { return r.path === CHAT; })[0];
        act(alice, { pluginaction: 'aiStop', nodeid: NODE, convId: s4.convId });
        var stopped = await waitFor(alice, 'onAiError', function (m) { return m.convId === s4.convId; });
        assert.strictEqual(stopped.code, 'aborted');
        assert.strictEqual(await mock.waitForClose(hung, 2000), true, 'the request to the model was closed');
        assert.ok(!alice.sent.some(function (m) { return m.method === 'onAiDone' && m.convId === s4.convId; }));
        // another user cannot close alice's conversation (at most 3 stay open per user: the stopped one is the newest)
        act(root, { pluginaction: 'aiClose', nodeid: NODE, convId: s4.convId });
        await delay(30);
        assert.ok(plugin.ai.sessions.get(s4.convId) != null, 'still open');
        act(alice, { pluginaction: 'aiClose', nodeid: NODE, convId: s4.convId });
        await delay(30);
        assert.strictEqual(plugin.ai.sessions.get(s4.convId), null, 'closed by its owner');

        // ---- audit ----
        await delay(50);
        act(root, { pluginaction: 'aiAdminAudit', reqId: 'a4', since: now - 3600000 });
        var audit = await waitFor(root, 'aiAdminAuditRows', function (m) { return m.reqId === 'a4'; });
        var turns = audit.rows.filter(function (r) { return r.kind !== 'feedback'; });
        assert.ok(turns.length >= 5, 'one row per turn: ' + turns.length);
        assert.ok(turns.every(function (r) { return r.userid === ALICE._id && r.nodeid === NODE; }));
        assert.ok(turns.some(function (r) { return r.result === 'cancelled'; }), 'the stopped turn is audited');
        assert.ok(turns.every(function (r) { return r.transcript === undefined; }), 'transcripts only on request');
        assert.ok(JSON.stringify(audit).indexOf('sk-integration-SECRET') < 0);

        // ---- the device tab's config never carries Assistant data beyond the endpoint id ----
        var cfgKeys = Object.keys(h2.config || {}).filter(function (k) { return /^ai/.test(k); });
        assert.deepStrictEqual(cfgKeys, ['aiEndpointId']);

        // ---- reload: server_startup again closes the previous Assistant ----
        var first = plugin.ai;
        firstDb = plugin.db;
        plugin.server_startup();
        assert.notStrictEqual(plugin.ai, first);
        await first.handle({ pluginaction: 'aiStart', nodeid: NODE, reqId: 'z', _node: nodes[NODE], _rights: 0xFFFFFFFF, mode: 'ask', input: { text: 'q' } }, alice, gp);
        assert.strictEqual(alice.sent[alice.sent.length - 1].code, 'internal', 'the closed instance refuses');
    } finally {
        console.log = origLog;
        try { if (plugin.ai) plugin.ai.close(); } catch (e) { }
        await delay(30);
        try { plugin.db.close(); } catch (e) { }
        try { if (firstDb && firstDb !== plugin.db) firstDb.close(); } catch (e) { }
        shim.close();
        await mock.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    if (process.env.EVL_INT_LOG) origLog(logs.join('\n'));
    assert.ok(!logs.some(function (l) { return l.indexOf('sk-integration-SECRET') >= 0; }), 'the key never appears in the log');
    assert.deepStrictEqual(logs.filter(function (l) { return /EVENTLOG AI: .*(internal error|failed|could not)/i.test(l); }), [], 'no Assistant errors in the log');
});
