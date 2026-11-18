'use strict';
const test = require('node:test');
const assert = require('node:assert');
const softwareMod = require('../../ai/software.js');

function agent(node) { return { dbNodeKey: node, sent: [], send: function (s) { this.sent.push(JSON.parse(s)); } }; }

test('request sends MeshCentral\'s installedapps command and resolves on the matching reply', async function () {
    const a = agent('node/d/n1');
    const sw = softwareMod.create({ getAgent: function (id) { return id === 'node/d/n1' ? a : null; } });
    const p = sw.request('node/d/n1', 0xFFFFFFFF, 5000);
    const c = a.sent[0];
    assert.deepStrictEqual(Object.keys(c).sort(), ['action', 'rights', 'sessionid', 'type']);
    assert.strictEqual(c.rights, 0xFFFFFFFF);
    assert.ok(/^eventlogai:[0-9a-f]{16}$/.test(c.sessionid));
    // wrong device: ignored (but recognised as ours)
    assert.strictEqual(sw.onAgentData({ action: 'software', sessionid: c.sessionid, value: '[{"name":"Evil"}]' }, agent('node/d/n2')), true);
    assert.strictEqual(sw.onAgentData({ action: 'software', sessionid: c.sessionid, value: '[]' }, null), true);
    assert.strictEqual(sw.onAgentData({ action: 'software', sessionid: 'abc', value: '[]' }, a), false);
    assert.strictEqual(sw.onAgentData({ action: 'other', sessionid: c.sessionid }, a), false);
    sw.onAgentData({ action: 'software', sessionid: c.sessionid, value: JSON.stringify([
        { name: 'A', version: '1', publisher: 'P', date: '20240101', uninstall: 'C:\\x.exe /S' },
        { DisplayName: 'B', DisplayVersion: '2', Publisher: 'Q', InstallDate: '2023' },
        { Name: 'C', Version: '3' }, { version: 'no name' }, null
    ]) }, a);
    const list = await p;
    assert.deepStrictEqual(list, [
        { name: 'A', version: '1', publisher: 'P', installDate: '20240101' },
        { name: 'B', version: '2', publisher: 'Q', installDate: '2023' },
        { name: 'C', version: '3', publisher: null, installDate: null }
    ]);
    assert.strictEqual(sw.pendingCount(), 0);
    // a late duplicate is dropped
    assert.strictEqual(sw.onAgentData({ action: 'software', sessionid: c.sessionid, value: '[]' }, a), true);
});

test('errors: offline, timeout, denied, unsupported, bad data; list capped', async function () {
    const a = agent('n');
    const sw = softwareMod.create({ getAgent: function (id) { return id === 'n' ? a : null; }, maxItems: 3 });
    await assert.rejects(sw.request('gone', 0), function (e) { return e.code === 'offline'; });
    await assert.rejects(sw.request('n', 0, 20), function (e) { return e.code === 'timeout'; });
    let p = sw.request('n', 0x00800000);
    sw.onAgentData({ action: 'software', sessionid: a.sent[a.sent.length - 1].sessionid, value: JSON.stringify({ success: false, error: 'Denied' }) }, a);
    await assert.rejects(p, function (e) { return e.code === 'denied'; });
    p = sw.request('n', 0);
    sw.onAgentData({ action: 'software', sessionid: a.sent[a.sent.length - 1].sessionid, value: JSON.stringify({ error: 'Not supported' }) }, a);
    await assert.rejects(p, function (e) { return e.code === 'unsupported'; });
    p = sw.request('n', 0);
    sw.onAgentData({ action: 'software', sessionid: a.sent[a.sent.length - 1].sessionid, value: '{not json' }, a);
    await assert.rejects(p, function (e) { return e.code === 'badResponse'; });
    p = sw.request('n', 0);
    sw.onAgentData({ action: 'software', sessionid: a.sent[a.sent.length - 1].sessionid, value: [1, 2, 3, 4, 5].map(function (i) { return { name: 'x' + i }; }) }, a);
    assert.strictEqual((await p).length, 3);
    p = sw.request('n', 0);
    sw.close();
    await assert.rejects(p, function (e) { return e.code === 'aborted'; });
});

test('normalize accepts the linux / mac wrapper shapes', function () {
    assert.deepStrictEqual(softwareMod.normalize({ packages: [{ name: 'openssl', version: '3.0' }] }, 10), [{ name: 'openssl', version: '3.0', publisher: null, installDate: null }]);
    assert.strictEqual(softwareMod.normalize('[]', 10).length, 0);
});
