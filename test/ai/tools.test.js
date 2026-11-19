'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('./engine-fakes.js');
const tools = require('../../ai/tools.js');
const redact = require('../../ai/redact.js');
const sessionMod = require('../../ai/session.js');
const dd = require('../../ai/devicedata.js');

function mkS(extra) {
    const node = F.makeNode();
    const meshDb = F.makeMeshDb(node);
    const S = Object.assign({ nodeid: F.NODE, node: node, rights: 0xFFFFFFFF, domain: 'd', userid: 'user/d/alice', os: 'windows', histOpts: { historyEntryTypes: [1, 2, 3, 4] }, refs: sessionMod.createRefs(), nonce: 'abc123', redactor: redact.create({ seeds: dd.seeds(node, meshDb.docs['si' + F.NODE]) }), suspicious: new Set() }, extra || {});
    return { S: S, meshDb: meshDb, db: F.makePluginDb(F.makeEvents()) };
}
function mk(cats, extra, depsExtra) {
    const x = mkS(extra);
    x.T = tools.create(x.S, Object.assign({ db: x.db, meshDb: x.meshDb, categories: cats || { deviceSummary: true, network: true, storedEvents: true, meshEvents: true, notes: true, software: true }, agentOnline: function () { return true; }, software: { request: function () { return Promise.resolve([{ name: 'Zed' }, { name: 'Alpha Office' }]); } } }, depsExtra || {}));
    return x;
}

test('validator: types, enums, bounds, patterns, required, additionalProperties', function () {
    const v = tools.validate;
    const s = tools.DEFS.get_events.parameters;
    assert.strictEqual(v(s, {}), null);
    assert.strictEqual(v(s, { limit: 50, window: { since: '24h' }, filters: { levels: ['err', 'warn'], ids: '41, 100-200' } }), null);
    assert.ok(/at most 50/.test(v(s, { limit: 51 })));
    assert.ok(/at least 1/.test(v(s, { limit: 0 })));
    assert.ok(/must be integer/.test(v(s, { limit: 2.5 })));
    assert.ok(/one of/.test(v(s, { filters: { levels: ['fatal'] } })));
    assert.ok(/invalid format/.test(v(s, { filters: { ids: '1; DROP' } })));
    assert.ok(/unknown property "nodeid"/.test(v(s, { nodeid: 'node/d/other' })));
    assert.ok(/unknown property/.test(v(s, { window: { since: '1h', node: 'x' } })));
    assert.ok(/more than 20 items/.test(v(s, { filters: { sources: new Array(21).fill('a') } })));
    assert.ok(/is required/.test(v(tools.DEFS.get_event.parameters, {})));
    assert.ok(/must be string or integer|must be integer or string/.test(v(tools.DEFS.lookup_event_id.parameters, { id: true })));
    assert.deepStrictEqual(tools.normalizeArgs(s, { limit: '5', window: null, filters: { text: null, ids: '41' } }), { limit: 5, filters: { ids: '41' } });
});

test('parseTime: ISO, relative ages, epoch ms, garbage', function () {
    const now = 1e12;
    assert.strictEqual(tools.parseTime('24h', now), now - 86400000);
    assert.strictEqual(tools.parseTime('90m', now), now - 5400000);
    assert.strictEqual(tools.parseTime('7d', now), now - 7 * 86400000);
    assert.strictEqual(tools.parseTime('2026-01-01T00:00:00Z', now), Date.UTC(2026, 0, 1));
    assert.ok(Number.isNaN(tools.parseTime('yesterday', now)));
    assert.strictEqual(tools.parseTime(null, now), null);
});

test('tools offered per category; software needs rights and an online agent; no tool takes a device id', function () {
    assert.deepStrictEqual(mk().T.names, ['get_device_info', 'event_facets', 'event_groups', 'get_events', 'get_event', 'lookup_event_id', 'get_device_events', 'get_installed_software']);
    assert.deepStrictEqual(mk({ storedEvents: true }).T.names, ['event_facets', 'event_groups', 'get_events', 'get_event', 'lookup_event_id']);
    assert.deepStrictEqual(mk({ network: true }).T.names, ['get_device_info']);
    assert.ok(/network interfaces/.test(mk({ network: true }).T.defs[0].description));
    assert.deepStrictEqual(mk({ software: true }, { rights: 0x00100000 | 0x00800000 }).T.names, []);
    assert.deepStrictEqual(mk({ software: true }, null, { agentOnline: function () { return false; } }).T.names, []);
    for (const d of mk().T.defs) {
        assert.strictEqual(d.parameters.additionalProperties, false);
        assert.ok(!JSON.stringify(d.parameters).match(/node|mesh|device_?id/i), d.name + ' takes a device id');
    }
});

test('get_events: compact events, refs registered, injection flagged, real values searched, redacted before fencing', async function () {
    const x = mk();
    const r = await x.T.exec('get_events', { filters: { sources: ['EvilApp'] }, limit: 5 }, { capTokens: 3000 });
    assert.strictEqual(r.isError, false);
    assert.ok(r.content.indexOf('<<<UNTRUSTED_DATA nonce=abc123 label=get_events>>>') === 0);
    const body = JSON.parse(r.content.split('\n').slice(1, -1).join('\n'));
    assert.strictEqual(body.events.length, 3);
    const e = body.events.find(function (x) { return x.id === 666; });
    assert.ok(!body.events.find(function (x) { return x.id === 668; }).injection_suspect, 'the split half alone is not flagged (heuristic)');
    assert.deepStrictEqual(Object.keys(e).sort(), ['id', 'injection_suspect', 'log', 'lvl', 'msg_untrusted', 'ref', 'src', 't'].sort());
    assert.strictEqual(e.lvl, 'err');
    assert.ok(typeof e.t === 'number');
    assert.ok(x.S.suspicious.has(e.ref));
    assert.ok(x.S.refs.returned.has(e.ref));
    // the model searches with a pseudonym; the db is queried with the real value
    const r2 = await x.T.exec('get_events', { filters: { text: 'PC-ALICE01' } }, { capTokens: 3000 });
    assert.ok(r2.content.indexOf('PC-ALICE01') < 0, 'output redacted');
    const tok = x.S.redactor.redact('PC-ALICE01');
    const r3 = await x.T.exec('get_events', { filters: { text: tok }, limit: 3 }, { capTokens: 3000 });
    assert.ok(JSON.parse(r3.content.split('\n').slice(1, -1).join('\n')).total > 0);
    const last = x.db.calls[x.db.calls.length - 1];
    assert.strictEqual(last.params.text, 'PC-ALICE01');
    assert.strictEqual(last.nodeid, F.NODE);
});

test('results are capped to the token budget; dropped items are not counted as returned refs', async function () {
    const x = mk();
    const r = await x.T.exec('get_events', { limit: 50 }, { capTokens: 400 });
    assert.ok(r.truncated);
    assert.ok(r.content.length < 400 * 3 + 200);
    assert.ok(x.S.refs.size() === 50 && x.S.refs.returned.size < 50);
});

test('windows are clamped; the session window is the default', async function () {
    const x = mk(null, { window: { from: F.NOW - 3600000, to: F.NOW } });
    await x.T.run('get_events', {});
    let p = x.db.calls[x.db.calls.length - 1].params;
    assert.strictEqual(p.since, F.NOW - 3600000);
    await x.T.run('get_events', { window: { since: '1000d' } });
    p = x.db.calls[x.db.calls.length - 1].params;
    assert.ok(p.since >= Date.now() - 400 * 86400000 - 1000);
    const bad = await x.T.run('get_events', { window: { since: '1h', until: '2h' } });
    assert.ok(!bad.ok && /after/.test(bad.error));
    const bad2 = await x.T.run('get_events', { window: { since: 'last tuesday' } });
    assert.ok(!bad2.ok);
});

test('event_groups / event_facets / get_event / lookup_event_id', async function () {
    const x = mk();
    const g = await x.T.run('event_groups', { window: { since: '7d' }, top_n: 3 });
    assert.ok(g.ok);
    assert.strictEqual(g.data.groups.length, 3);
    assert.strictEqual(g.data.groups[0].lvl, 'crit');
    assert.ok(g.data.groups[0].sample_refs.length >= 1);
    const f = await x.T.run('event_facets', { window: { since: '7d' } });
    assert.ok(f.data.total > 200 && f.data.levels.err > 0 && f.data.sources['Service Control Manager'] > 0);
    const ref = g.data.groups[0].sample_refs[0];
    const ge = await x.T.run('get_event', { ref: '[' + ref + ']' });
    assert.ok(ge.ok && ge.data.ref === ref && ge.data.id === 41);
    assert.ok(!(await x.T.run('get_event', { ref: 'E9999' })).ok);
    const l = await x.T.run('lookup_event_id', { ref: ref });
    assert.ok(l.data.known && /Kernel-Power/i.test(l.data.provider));
    const l2 = await x.T.run('lookup_event_id', { provider: 'Nobody', id: 1 });
    assert.strictEqual(l2.data.known, false);
    const l3 = await x.T.run('lookup_event_id', {});
    assert.ok(!l3.ok);
    const sw = await x.T.run('get_installed_software', { name_contains: 'office' });
    assert.deepStrictEqual(sw.data.items, [{ name: 'Alpha Office' }]);
    const de = await x.T.run('get_device_events', { limit: 2 });
    assert.strictEqual(de.data.events.length, 2);
});

test('history disabled and db failures become error results', async function () {
    const x = mk(null, { histOpts: { historyEnabled: false } });
    const r = await x.T.exec('get_events', {}, {});
    assert.ok(r.isError && /disabled/.test(r.content));
    const y = mk();
    y.db.getEventsFor = function () { throw new Error('db exploded'); };
    const r2 = await y.T.exec('get_events', {}, {});
    assert.ok(r2.isError && /failed/.test(r2.content));
});

function macEvents() {
    const t0 = F.NOW - 3600000;
    const e = function (id, o) { return Object.assign({ _id: id, nodeid: F.NODE, Level: 2, LogName: 'System', MsgType: 'Error', Subsystem: '', OsCategory: '', ProcessPath: '', Id: '' }, o); };
    return [
        e('m00000000000000000000001', { tc: t0, LogName: 'Crash', Level: 1, MsgType: 'Panic', ProviderName: 'Kernel', ProcessPath: '/Library/Logs/DiagnosticReports/panic-full-2026-11-18-080000.panic', Message: 'panic(cpu 0 caller 0xffffff8012345678): Kernel trap at 0xffffff7f9a2b3c4d, type 14=page fault' }),
        e('m00000000000000000000002', { tc: t0 + 1000, ProviderName: 'launchd', Subsystem: 'com.apple.xpc', OsCategory: 'connection', ProcessPath: '/sbin/launchd', Id: '1', Message: 'Service exited with abnormal code: 78' }),
        e('m00000000000000000000003', { tc: t0 + 2000, ProviderName: 'launchd', Subsystem: 'com.apple.xpc', OsCategory: 'connection', ProcessPath: '/sbin/launchd', Id: '1', Message: 'Service exited with abnormal code: 15' }),
        // a PID that is also a Windows event id with a curated entry (Kernel-Power 41): never looked up as one
        e('m00000000000000000000004', { tc: t0 + 3000, LogName: 'Application', Level: 4, MsgType: 'Default', ProviderName: 'Kernel-Power', Id: '41', Message: 'nothing special' })
    ];
}

test('macOS events: subsystem, os_log category, message type and PID in the output; groups by subsystem; the macOS reference', async function () {
    const x = mk(null, { os: 'macos', histOpts: { historyEntryTypes: [1, 2, 3, 4] } });
    x.db.events.length = 0;
    macEvents().forEach(function (e) { x.db.events.push(e); });
    const r = await x.T.run('get_events', { window: { since: '7d' } });
    assert.ok(r.ok);
    const byMsg = function (re) { return r.data.events.find(function (e) { return re.test(e.msg_untrusted); }); };
    const svc = byMsg(/abnormal code: 78/);
    assert.deepStrictEqual([svc.log, svc.src, svc.id, svc.subsystem, svc.os_category, svc.msg_type, svc.lvl], ['System', 'launchd', '1', 'com.apple.xpc', 'connection', 'Error', 'err']);
    const panic = byMsg(/^panic/);
    assert.deepStrictEqual([panic.log, panic.msg_type, panic.lvl, 'subsystem' in panic, 'os_category' in panic], ['Crash', 'Panic', 'crit', false, false]);
    assert.ok(!('unit' in svc));
    // get_event adds the process path
    const ge = await x.T.run('get_event', { ref: svc.ref });
    assert.strictEqual(ge.data.process_path, '/sbin/launchd');
    // event_groups: the two launchd errors are one template group with the subsystem
    const g = await x.T.run('event_groups', { window: { since: '7d' } });
    const xpc = g.data.groups.find(function (gr) { return gr.subsystem === 'com.apple.xpc'; });
    assert.deepStrictEqual([xpc.count, xpc.src, xpc.template_untrusted], [2, 'launchd', 'Service exited with abnormal code: <*>']);
    // lookup_event_id with a ref: the macOS reference, never the Windows one by PID
    assert.deepStrictEqual([(await x.T.run('lookup_event_id', { ref: panic.ref })).data.key, (await x.T.run('lookup_event_id', { ref: panic.ref })).data.known], ['mac-kernel-panic', true]);
    assert.strictEqual((await x.T.run('lookup_event_id', { ref: byMsg(/nothing special/).ref })).data.known, false);
    // the device info carries the collector's macOS version
    const y = mk({ deviceSummary: true }, { os: 'macos', osVersion: '14.5' });
    const di = await y.T.run('get_device_info', {});
    assert.strictEqual(di.data.device.osVersion, '14.5');
    assert.strictEqual((await mk({ deviceSummary: true }).T.run('get_device_info', {})).data.device.osVersion, undefined);
    // the schema descriptions name macOS
    assert.match(tools.DEFS.event_groups.description, /unit\/subsystem\+message template \(Linux, macOS\)/);
    assert.match(tools.DEFS.get_events.parameters.properties.filters.properties.logs.description, /Linux and macOS: categories/);
});

test('macOS records on a device of unknown OS are told by their fields; Windows records keep the provider+id reference', async function () {
    const x = mk(null, { os: null });
    x.db.events.length = 0;
    macEvents().forEach(function (e) { x.db.events.push(e); });
    const r = await x.T.run('get_events', { window: { since: '7d' } });
    const kp = r.data.events.find(function (e) { return /nothing special/.test(e.msg_untrusted); });
    assert.strictEqual((await x.T.run('lookup_event_id', { ref: kp.ref })).data.known, false, 'MsgType marks a macOS record: Id is a PID');
    const w = mk();
    const g = await w.T.run('event_groups', { window: { since: '7d' }, top_n: 1 });
    assert.ok((await w.T.run('lookup_event_id', { ref: g.data.groups[0].sample_refs[0] })).data.known);
});
