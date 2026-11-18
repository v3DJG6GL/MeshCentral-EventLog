'use strict';
// Storage tests for db.js / db_sql.js on the backends that run without a server:
//   - NeDB (plugin-private files in a temp dir); needs @seald-io/nedb (or @yetzt/nedb / nedb) resolvable,
//     e.g. NODE_PATH=/path/to/node_modules node --test test/  - skipped otherwise.
//   - SQLite through a small sqlite3-style shim over node:sqlite (in memory) - skipped when node:sqlite is missing.
// MongoDB / PostgreSQL / MariaDB / MySQL need a server and are not exercised here.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var DBJS = path.join(__dirname, '..', 'db.js');
var T0 = 1700000000000;

function nedbAvailable() {
    var names = ['@seald-io/nedb', '@yetzt/nedb', 'nedb'];
    for (var i = 0; i < names.length; i++) { try { require.resolve(names[i]); return null; } catch (e) { } }
    return 'NeDB module not resolvable (install @seald-io/nedb and set NODE_PATH)';
}
function sqliteAvailable() {
    try { require('node:sqlite'); return null; } catch (e) { return 'node:sqlite not available in this Node version'; }
}

// MeshCentral's sqlite3 handle shape: all(sql, params, cb(err, rows)) and run(sql, params, function (err) { this.changes, this.lastID })
function sqliteShim() {
    var S = require('node:sqlite');
    var db = new S.DatabaseSync(':memory:');
    return {
        _db: db,
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
                try {
                    var st = db.prepare(sql), r = st.run.apply(st, params || []);
                    ctx.changes = Number(r.changes); ctx.lastID = Number(r.lastInsertRowid);
                } catch (e) { err = e; }
                if (typeof cb == 'function') cb.call(ctx, err);
            });
        },
        close: function () { try { db.close(); } catch (e) { } }
    };
}

function fakeServer(dir, db) {
    return {
        args: {},
        db: db,
        pluginHandler: {},
        getConfigFilePath: function (name) { return path.join(dir, name); }
    };
}

function cbp(fn) { return new Promise(function (resolve) { fn(function () { resolve(Array.prototype.slice.call(arguments)); }); }); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitFor(fn, what) {
    for (var i = 0; i < 200; i++) { if (await fn()) return; await delay(10); }
    throw new Error('timed out waiting for ' + what);
}

function ev(i, o) {
    return Object.assign({ TimeCreated: '/Date(' + (T0 + i * 1000) + ')/', Level: 2, LogName: 'System', ProviderName: 'Disk', Id: 7, Message: 'msg ' + i }, o || {});
}
// node A: 10 events with a mix of logs, levels and sources
function nodeAEvents() {
    var out = [];
    for (var i = 0; i < 10; i++) {
        if (i <= 3) out.push(ev(i));                                                                          // System / Disk / 2
        else if (i <= 6) out.push(ev(i, { LogName: 'Application', ProviderName: 'App', Level: 3, Id: 1000 + i }));
        else if (i <= 8) out.push(ev(i, { LogName: 'Security', ProviderName: 'Auth', Level: 4, Id: 4624, Message: 'logon special' }));
        else out.push(ev(i, { ProviderName: 'Kernel', Level: 1, Id: 41 }));
    }
    return out;
}
var A = 'node/d/nA', B = 'node/d/nB', C = 'node/d/nC';
var BIG = 3000;

var backends = [
    {
        name: 'nedb',
        skip: nedbAvailable(),
        open: function () {
            var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evl-nedb-'));
            var db = require(DBJS).CreateDB(fakeServer(dir, { databaseType: 1 }));
            return {
                db: db,
                ready: function () { return Promise.resolve(); },
                close: async function () {
                    // let queued NeDB writes land before the directory goes away
                    for (var k = 0; k < 2; k++) {
                        for (var f of [db.eventsFile, db.settingsFile, db.auditFile]) await cbp(function (cb) { f.find({ _id: '__none__' }, cb); });
                        await delay(20);
                    }
                    db.close();
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            };
        }
    },
    {
        name: 'sqlite',
        skip: sqliteAvailable(),
        open: function () {
            var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evl-sqlite-'));
            var shim = sqliteShim();
            var db = require(DBJS).CreateDB(fakeServer(dir, { databaseType: 8, file: shim }));
            return {
                db: db,
                ready: function () { return db.ready(); },
                close: async function () { await delay(20); db.close(); shim.close(); fs.rmSync(dir, { recursive: true, force: true }); }
            };
        }
    }
];

backends.forEach(function (be) {
    // a plain skipped test (not a skipped suite) so the run summary counts it
    if (be.skip) { test(be.name + ' backend', { skip: be.skip }, function () { }); return; }
    test.describe(be.name, function () {
        var h, db, idsA = {}, idsB = [];

        test.before(async function () {
            if (be.name == 'sqlite') delete process.env.EVENTLOG_STORAGE;
            h = be.open();
            db = h.db;
            await h.ready();
            await waitFor(async function () { var s = await db.getAllConfigSets(); return s && s.length == 1; }, 'the default config set');
            var r = await db.addEventsFor(A, nodeAEvents());
            assert.deepStrictEqual(r, { count: 10, maxTc: T0 + 9000 });
            await db.addEventsFor(B, [ev(0), ev(1, { Level: 3 }), ev(2)]);
            var big = [];
            for (var i = 0; i < BIG; i++) big.push(ev(i, { Level: (i % 2) ? 2 : 3 }));
            await db.addEventsFor(C, big);
            var a = await cbp(function (cb) { db.getEventsFor(A, {}, { limit: 100 }, cb); });
            a[0].forEach(function (e) { idsA[e.tc] = String(e._id); });
            var b = await cbp(function (cb) { db.getEventsFor(B, {}, { limit: 100 }, cb); });
            idsB = b[0].map(function (e) { return String(e._id); });
        });
        test.after(async function () { if (h) await h.close(); });

        // ---- regression: existing functions ----------------------------------
        test('config sets: default, new set, assignment, auth, delete', async function () {
            var sets = await db.getAllConfigSets();
            assert.strictEqual(sets.length, 1);
            assert.strictEqual(sets[0].default, true);
            assert.strictEqual(sets[0].historyLogs, 'Application,System');
            var res = await db.updateConfig('_new', { name: 'Servers', historyLogs: 'System', historyEntryTypes: [1, 2] });
            var newId = String(res.insertedId);
            sets = await db.getAllConfigSets();
            assert.strictEqual(sets.length, 2);
            var s = sets.find(function (x) { return String(x._id) == newId; });
            assert.ok(s, 'new config set listed');
            assert.strictEqual(await db.checkConfigAuth(s.uid), 1);
            await db.assignConfig(newId, [A]);
            var ca = await db.getConfigAssignments();
            assert.deepStrictEqual(ca.map(function (x) { return { asset: x.asset, configId: String(x.configId) }; }), [{ asset: A, configId: newId }]);
            assert.strictEqual((await db.getConfigFor(A, 'mesh/d/A')).name, 'Servers');
            assert.strictEqual((await db.getConfigFor(B, 'mesh/d/A')).default, true);
            await db.assignConfig('_clear', [A]);
            assert.deepStrictEqual(await db.getConfigAssignments(), []);
            await db.deleteConfigSet(newId);
            assert.strictEqual((await db.getAllConfigSets()).length, 1);
        });

        test('getEventsFor: order, total, user filters and config set filters', async function () {
            var r = await cbp(function (cb) { db.getEventsFor(A, {}, {}, cb); });
            assert.strictEqual(r[1], 10);
            assert.deepStrictEqual(r[0].map(function (e) { return e.tc; }), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(function (i) { return T0 + i * 1000; }));
            var q = async function (opts, params) { var x = await cbp(function (cb) { db.getEventsFor(A, opts, params, cb); }); return { tcs: x[0].map(function (e) { return (e.tc - T0) / 1000; }), total: x[1] }; };
            assert.deepStrictEqual(await q({}, { levels: [3] }), { tcs: [6, 5, 4], total: 3 });
            assert.deepStrictEqual(await q({}, { logs: ['Security'] }), { tcs: [8, 7], total: 2 });
            assert.deepStrictEqual(await q({}, { sources: ['Kernel'] }), { tcs: [9], total: 1 });
            assert.deepStrictEqual(await q({}, { text: 'SPECIAL' }), { tcs: [8, 7], total: 2 });
            assert.deepStrictEqual(await q({}, { ids: '41, 1004-1005' }), { tcs: [9, 5, 4], total: 3 });
            assert.deepStrictEqual(await q({}, { since: T0 + 7000 }), { tcs: [9, 8, 7], total: 3 });
            assert.deepStrictEqual(await q({}, { limit: 2, skip: 3 }), { tcs: [6, 5], total: 10 });
            // config set filters, and user filters taking precedence over them
            var cs = { historyLogs: 'System,Application', historyEntryTypes: [2, 3] };
            assert.deepStrictEqual(await q(cs, {}), { tcs: [6, 5, 4, 3, 2, 1, 0], total: 7 });
            assert.deepStrictEqual(await q(cs, { levels: [1] }), { tcs: [9], total: 1 });
            var dis = await cbp(function (cb) { db.getEventsFor(A, { historyEnabled: false }, {}, cb); });
            assert.strictEqual(dis[0], null);
        });

        test('getEventsFor: until (alone, with since, garbage ignored)', async function () {
            var q = async function (params) { var x = await cbp(function (cb) { db.getEventsFor(A, {}, params, cb); }); return x[0].map(function (e) { return (e.tc - T0) / 1000; }); };
            assert.deepStrictEqual(await q({ until: T0 + 2000 }), [2, 1, 0]);
            assert.deepStrictEqual(await q({ until: String(T0 + 1000) }), [1, 0]);
            assert.deepStrictEqual(await q({ since: T0 + 3000, until: T0 + 5000 }), [5, 4, 3]);
            assert.deepStrictEqual(await q({ since: T0 + 3000, until: T0 + 5000, levels: [2] }), [3]);
            assert.strictEqual((await q({ until: 'abc' })).length, 10);
            assert.strictEqual((await q({ until: null })).length, 10);
        });

        test('getFacetsFor (history sidebar) is unchanged', async function () {
            var f = await cbp(function (cb) { db.getFacetsFor(A, null, cb); });
            assert.deepStrictEqual(f[0], { level: { 1: 1, 2: 4, 3: 3, 4: 2 }, log: { System: 5, Application: 3, Security: 2 }, source: { Disk: 4, App: 3, Auth: 2, Kernel: 1 } });
            f = await cbp(function (cb) { db.getFacetsFor(A, T0 + 7000, cb); });
            assert.deepStrictEqual(f[0], { level: { 1: 1, 4: 2 }, log: { System: 1, Security: 2 }, source: { Auth: 2, Kernel: 1 } });
        });

        // ---- new: facets over the History query ------------------------------
        test('getFacetsQuery: config set filters, user filters, until, history disabled', async function () {
            var cs = { historyLogs: 'System,Application', historyEntryTypes: [2, 3] };
            var f = (await cbp(function (cb) { db.getFacetsQuery(A, cs, {}, cb); }))[0];
            assert.deepStrictEqual(f, { level: { 2: 4, 3: 3 }, log: { System: 4, Application: 3 }, source: { Disk: 4, App: 3 } });
            f = (await cbp(function (cb) { db.getFacetsQuery(A, cs, { sources: ['App'] }, cb); }))[0];
            assert.deepStrictEqual(f, { level: { 3: 3 }, log: { Application: 3 }, source: { App: 3 } });
            f = (await cbp(function (cb) { db.getFacetsQuery(A, cs, { until: T0 + 4000 }, cb); }))[0];
            assert.deepStrictEqual(f, { level: { 2: 4, 3: 1 }, log: { System: 4, Application: 1 }, source: { Disk: 4, App: 1 } });
            f = (await cbp(function (cb) { db.getFacetsQuery(A, {}, { levels: [4], text: 'logon' }, cb); }))[0];
            assert.deepStrictEqual(f, { level: { 4: 2 }, log: { Security: 2 }, source: { Auth: 2 } });
            f = (await cbp(function (cb) { db.getFacetsQuery(A, null, null, cb); }))[0];
            assert.deepStrictEqual(f.log, { System: 5, Application: 3, Security: 2 });
            f = (await cbp(function (cb) { db.getFacetsQuery(A, { historyEnabled: false }, {}, cb); }))[0];
            assert.deepStrictEqual(f, { level: {}, log: {}, source: {} });
            f = (await cbp(function (cb) { db.getFacetsQuery('node/d/none', {}, {}, cb); }))[0];
            assert.deepStrictEqual(f, { level: {}, log: {}, source: {} });
        });

        // ---- new: events by id -----------------------------------------------
        test('getEventsByIds: only this node, malformed ids ignored', async function () {
            var a1 = idsA[T0 + 1000], a8 = idsA[T0 + 8000];
            assert.ok(a1 && a8 && idsB.length == 3);
            var r = (await cbp(function (cb) { db.getEventsByIds(A, [a1, a8, idsB[0], idsB[1]], cb); }))[0];
            assert.deepStrictEqual(r.map(function (e) { return String(e._id); }).sort(), [a1, a8].sort());
            assert.ok(r.every(function (e) { return e.nodeid == A; }));
            var e8 = r.find(function (e) { return String(e._id) == a8; });
            assert.strictEqual(e8.LogName, 'Security');
            assert.strictEqual(e8.tc, T0 + 8000);
            // B's ids through node A: nothing
            assert.deepStrictEqual((await cbp(function (cb) { db.getEventsByIds(A, idsB, cb); }))[0], []);
            // malformed / hostile values are dropped, valid ones still served
            var bad = [null, 42, {}, ['x'], '', ' ' + a1, a1 + ' OR 1=1', '1; DROP TABLE x', '$where', 'x'.repeat(40), '00000000000000000000000000000000000', '../' + a1];
            r = (await cbp(function (cb) { db.getEventsByIds(A, bad.concat([a1]), cb); }))[0];
            assert.deepStrictEqual(r.map(function (e) { return String(e._id); }), [a1]);
            assert.deepStrictEqual((await cbp(function (cb) { db.getEventsByIds(A, bad, cb); }))[0], []);
            assert.deepStrictEqual((await cbp(function (cb) { db.getEventsByIds(A, 'notanarray', cb); }))[0], []);
            assert.deepStrictEqual((await cbp(function (cb) { db.getEventsByIds(A, [], cb); }))[0], []);
        });

        // ---- new: paged scan ---------------------------------------------------
        test('scanEventsFor: pages past 1000, truncates at max, history disabled', async function () {
            var r = await cbp(function (cb) { db.scanEventsFor(C, {}, {}, 2500, cb); });
            var evs = r[0];
            assert.strictEqual(evs.length, 2500);
            assert.strictEqual(r[1], true);
            assert.strictEqual(r[2], BIG);
            assert.strictEqual(new Set(evs.map(function (e) { return String(e._id); })).size, 2500, 'no duplicates across pages');
            assert.strictEqual(evs[0].tc, T0 + (BIG - 1) * 1000);
            for (var i = 1; i < evs.length; i++) assert.ok(evs[i - 1].tc > evs[i].tc, 'newest first');
            assert.strictEqual(evs[2499].tc, T0 + (BIG - 2500) * 1000);

            r = await cbp(function (cb) { db.scanEventsFor(C, {}, {}, 20000, cb); });
            assert.strictEqual(r[0].length, BIG); assert.strictEqual(r[1], false); assert.strictEqual(r[2], BIG);
            // default max (5000) when max is omitted
            r = await cbp(function (cb) { db.scanEventsFor(C, {}, {}, cb); });
            assert.strictEqual(r[0].length, BIG); assert.strictEqual(r[1], false);
            // filters (and opts) apply to every page; user skip/limit are overridden
            r = await cbp(function (cb) { db.scanEventsFor(C, { historyEntryTypes: [2] }, { until: T0 + 1999000, skip: 50, limit: 3 }, 600, cb); });
            assert.strictEqual(r[2], 1000);   // odd i in 0..1999
            assert.strictEqual(r[0].length, 600); assert.strictEqual(r[1], true);
            assert.ok(r[0].every(function (e) { return e.Level == 2 && e.tc <= T0 + 1999000; }));
            assert.strictEqual(r[0][0].tc, T0 + 1999000);
            // small result: one page
            r = await cbp(function (cb) { db.scanEventsFor(A, {}, {}, 1000, cb); });
            assert.strictEqual(r[0].length, 10); assert.strictEqual(r[1], false); assert.strictEqual(r[2], 10);
            r = await cbp(function (cb) { db.scanEventsFor(A, {}, {}, 3, cb); });
            assert.strictEqual(r[0].length, 3); assert.strictEqual(r[1], true);
            r = await cbp(function (cb) { db.scanEventsFor(C, { historyEnabled: false }, {}, 2500, cb); });
            assert.deepStrictEqual(r, [[], false, 0]);
            r = await cbp(function (cb) { db.scanEventsFor('node/d/none', {}, {}, 2500, cb); });
            assert.deepStrictEqual(r, [[], false, 0]);
        });

        // ---- new: assistant settings documents --------------------------------
        test('ai docs: put / get / list / replace / delete; no leak into config sets', async function () {
            assert.strictEqual(await db.aiPutDoc('aiEndpoint:e1', 'aiEndpoint', { name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', key: { mode: 'none' }, type: 'configSet', default: false }), true);
            await db.aiPutDoc('aiEndpoint:e2', 'aiEndpoint', { name: 'Other', model: 'm' });
            await db.aiPutDoc('aiSettings', 'aiSettings', { enabled: true, limits: { perDay: 10 } });
            await db.aiPutDoc('aiAck:user/d/alice:e1', 'aiAck', { at: 123 });
            var d = await db.aiGetDoc('aiEndpoint:e1');
            assert.strictEqual(d._id, 'aiEndpoint:e1');
            assert.strictEqual(d.type, 'aiEndpoint', 'the type argument wins over a type field in the doc');
            assert.deepStrictEqual(d.key, { mode: 'none' });
            assert.strictEqual(d.baseUrl, 'http://127.0.0.1:11434/v1');
            // replace, not merge
            await db.aiPutDoc('aiEndpoint:e1', 'aiEndpoint', { name: 'Local2' });
            d = await db.aiGetDoc('aiEndpoint:e1');
            assert.strictEqual(d.name, 'Local2');
            assert.strictEqual(d.baseUrl, undefined);
            var eps = await db.aiDocs('aiEndpoint');
            assert.deepStrictEqual(eps.map(function (x) { return x._id; }).sort(), ['aiEndpoint:e1', 'aiEndpoint:e2']);
            assert.strictEqual((await db.aiDocs('aiSettings'))[0].limits.perDay, 10);
            assert.strictEqual((await db.aiDocs('aiAck')).length, 1);
            assert.deepStrictEqual(await db.aiDocs('nothing'), []);
            // nothing of this shows up as a config set or an assignment
            var sets = await db.getAllConfigSets();
            assert.strictEqual(sets.length, 1);
            assert.strictEqual(sets[0].default, true);
            assert.deepStrictEqual(await db.getConfigAssignments(), []);
            assert.strictEqual((await db.getConfigFor(A, 'mesh/d/A')).default, true);
            assert.strictEqual(await db.getDBVersion(), db.dbVersion);
            // delete
            assert.strictEqual(await db.aiDelDoc('aiEndpoint:e2'), 1);
            assert.strictEqual(await db.aiDelDoc('aiEndpoint:e2'), 0);
            assert.strictEqual(await db.aiGetDoc('aiEndpoint:e2'), null);
            assert.strictEqual(await db.aiGetDoc('aiEndpoint:missing'), null);
            assert.strictEqual((await db.aiDocs('aiEndpoint')).length, 1);
        });

        // ---- new: assistant audit log ------------------------------------------
        test('audit: add / query (filters, order, paging, total) / sweep', async function () {
            var U1 = 'user/d/alice', U2 = 'user/d/bob';
            for (var i = 0; i < 12; i++) {
                var ok = await db.aiAuditAdd({ time: T0 + i * 60000, userid: (i % 3 == 0) ? U2 : U1, nodeid: (i < 6) ? A : B, kind: 'ask', n: i, tools: [{ name: 'getEvents' }] });
                assert.strictEqual(ok, true);
            }
            var r = await db.aiAuditQuery({});
            assert.strictEqual(r.total, 12);
            assert.deepStrictEqual(r.rows.map(function (x) { return x.n; }), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
            assert.strictEqual(r.rows[0].userid, U1);
            assert.strictEqual(r.rows[0].nodeid, B);
            assert.strictEqual(r.rows[0].time, T0 + 11 * 60000);
            assert.deepStrictEqual(r.rows[0].tools, [{ name: 'getEvents' }]);
            assert.ok(r.rows[0]._id != null);
            // paging
            r = await db.aiAuditQuery({ skip: 3, limit: 4 });
            assert.strictEqual(r.total, 12);
            assert.deepStrictEqual(r.rows.map(function (x) { return x.n; }), [8, 7, 6, 5]);
            r = await db.aiAuditQuery({ skip: 10, limit: 4 });
            assert.deepStrictEqual(r.rows.map(function (x) { return x.n; }), [1, 0]);
            // filters
            r = await db.aiAuditQuery({ userid: U2 });
            assert.strictEqual(r.total, 4);
            assert.deepStrictEqual(r.rows.map(function (x) { return x.n; }), [9, 6, 3, 0]);
            r = await db.aiAuditQuery({ nodeid: A, userid: U1 });
            assert.deepStrictEqual(r.rows.map(function (x) { return x.n; }), [5, 4, 2, 1]);
            r = await db.aiAuditQuery({ since: T0 + 3 * 60000, until: T0 + 7 * 60000 });
            assert.deepStrictEqual(r.rows.map(function (x) { return x.n; }), [7, 6, 5, 4, 3]);
            assert.strictEqual(r.total, 5);
            r = await db.aiAuditQuery({ since: T0 + 10 * 60000, userid: U1, limit: 1 });
            assert.strictEqual(r.total, 2);
            assert.deepStrictEqual(r.rows.map(function (x) { return x.n; }), [11]);
            // a given but unusable user/node filter matches nothing (fail closed, not "all rows")
            for (var badq of [{ userid: 'x'.repeat(300) }, { userid: '' }, { userid: 5 }, { nodeid: {} }]) {
                assert.deepStrictEqual(await db.aiAuditQuery(badq), { rows: [], total: 0 }, JSON.stringify(badq));
            }
            assert.strictEqual((await db.aiAuditQuery({ userid: 'user/d/nobody' })).total, 0);
            // a record without a time gets one; aiAuditAdd never rejects
            var before = Date.now();
            assert.strictEqual(await db.aiAuditAdd({ userid: 'user/d/carol', kind: 'explain' }), true);
            r = await db.aiAuditQuery({ userid: 'user/d/carol' });
            assert.strictEqual(r.total, 1);
            assert.ok(r.rows[0].time >= before && r.rows[0].time <= Date.now() + 5);
            var odd = await db.aiAuditAdd({ time: T0, userid: 'user/d/dave', args: { 'a.b': 1, $x: 2 } });
            assert.strictEqual(typeof odd, 'boolean');
            assert.strictEqual(await db.aiAuditAdd(null), true);
            // sweep: strictly older than the cutoff
            var removed = await db.aiAuditSweep(T0 + 4 * 60000);
            assert.strictEqual(removed, 4 + (odd ? 1 : 0));
            r = await db.aiAuditQuery({ limit: 5000 });
            assert.ok(r.rows.every(function (x) { return x.time >= T0 + 4 * 60000; }));
            assert.strictEqual(r.total, 8 + 2);   // n=4..11 + carol + the null record
            assert.strictEqual(await db.aiAuditSweep(T0 + 4 * 60000), 0);
            assert.strictEqual(await db.aiAuditSweep('garbage'), 0);
            assert.strictEqual((await db.aiAuditQuery({})).total, 10);
        });
    });
});
