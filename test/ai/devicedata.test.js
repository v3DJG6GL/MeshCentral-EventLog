'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('./engine-fakes.js');
const dd = require('../../ai/devicedata.js');

test('deviceInfo: whitelisted fields only; credentials, BitLocker keys, locations and serials never included', async function () {
    const node = F.makeNode(), meshDb = F.makeMeshDb(node);
    const all = { deviceSummary: true, network: true, notes: true };
    const out = await dd.deviceInfo({ meshDb: meshDb, nodeid: F.NODE, node: node, categories: all, getConnectivityState: function () { return { connectivity: 1, powerState: 1 }; } });
    const s = JSON.stringify(out);
    F.assertNoForbidden(assert, 'deviceInfo', s);
    for (const k of ['recoveryPassword', 'bitlocker', 'ssh', 'rdp', 'intelamt', 'pmt', 'iploc', 'gpsloc', 'wifiloc', 'userloc', 'identifier', 'SerialNumber']) assert.ok(s.indexOf('"' + k + '"') < 0, k);
    assert.strictEqual(out.device.name, 'PC-ALICE01');
    assert.strictEqual(out.device.os, 'Microsoft Windows 11 Pro');
    assert.deepStrictEqual(out.device.connection, { agent: true, power: 'on' });
    assert.deepStrictEqual(out.device.antivirus, [{ product: 'Windows Defender', enabled: true, updated: true }]);
    assert.strictEqual(out.system.windows.BuildNumber, '22631');
    assert.deepStrictEqual(out.system.memory, { totalBytes: 17179869184, modules: 2 });
    assert.strictEqual(out.system.volumes[0].bitlockerProtection, 'On');
    assert.strictEqual(out.system.volumes[0].free, 120000000000);
    assert.strictEqual(out.system.hardware.bios_vendor, 'LENOVO');
    assert.strictEqual(out.system.hardware.bios_serial, undefined);
    assert.strictEqual(out.network.length, 2);
    assert.strictEqual(out.network[1].name, 'vEthernet (WSL.1)', 'field names unescaped');
    assert.deepStrictEqual(out.network[0].ipv4, ['192.168.1.50 / 255.255.255.0']);
    assert.strictEqual(out.network[0].gateway, '192.168.1.1');
    assert.ok(/PSU replaced/.test(out.notes_untrusted));
    assert.ok(out.lastAgentConnect.addr);
    // categories off -> not read
    const min = await dd.deviceInfo({ meshDb: meshDb, nodeid: F.NODE, node: node, categories: { deviceSummary: true } });
    assert.ok(!min.network && !min.notes_untrusted);
    const withSerials = dd.sysinfoSummary(meshDb.docs['si' + F.NODE], { serials: true });
    assert.strictEqual(withSerials.hardware.bios_serial, 'BIOSSERIAL-9988');
    // a node doc the db cannot load falls back to the session copy, still whitelisted
    const empty = { Get: function (id, cb) { cb(null, []); } };
    const fb = await dd.deviceInfo({ meshDb: empty, nodeid: F.NODE, node: node, categories: all });
    F.assertNoForbidden(assert, 'fallback', JSON.stringify(fb));
    assert.strictEqual(fb.device.name, 'PC-ALICE01');
});

test('deviceEvents: own events only with Limit Events; only time, action, msg', async function () {
    const meshDb = F.makeMeshDb(F.makeNode());
    const all = await dd.deviceEvents({ meshDb: meshDb, nodeid: F.NODE, domain: 'd', userid: 'user/d/alice', rights: 0xFFFFFFFF, limit: 10 });
    assert.strictEqual(all.length, 3);
    assert.deepStrictEqual(Object.keys(all[0]).sort(), ['action', 'msg', 'time']);
    const own = await dd.deviceEvents({ meshDb: meshDb, nodeid: F.NODE, domain: 'd', userid: 'user/d/alice', rights: 0x00100000 | 0x00002000, limit: 99 });
    assert.deepStrictEqual(own.map(function (e) { return e.action; }), ['agentconnect', 'changenode']);
    assert.deepStrictEqual(meshDb.calls, ['all', 'self']);
    assert.deepStrictEqual(await dd.deviceEvents({ meshDb: null }), []);
});

test('seeds collect host, domain, user and serial values for the redactor', function () {
    const node = F.makeNode(), si = F.makeMeshDb(node).docs['si' + F.NODE];
    const s = dd.seeds(node, si);
    assert.ok(s.hosts.indexOf('PC-ALICE01') >= 0 && s.hosts.indexOf('pc-alice01.corp.example.com') >= 0);
    assert.deepStrictEqual(s.users, ['CORP\\jdoe']);
    assert.ok(s.serials.indexOf('BIOSSERIAL-9988') >= 0);
    assert.deepStrictEqual(dd.seeds(null, null), { hosts: [], domains: [], users: [], serials: [] });
    assert.strictEqual(dd.unEscapeFieldName('a%2Eb%25c%24d%2Ce'), 'a.b%c$d,e');
});
