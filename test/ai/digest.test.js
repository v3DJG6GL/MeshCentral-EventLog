'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('./engine-fakes.js');
const tools = require('../../ai/tools.js');
const digest = require('../../ai/digest.js');
const redact = require('../../ai/redact.js');
const sessionMod = require('../../ai/session.js');
const dd = require('../../ai/devicedata.js');
const budget = require('../../ai/budget.js');

function mk() {
    const node = F.makeNode(), meshDb = F.makeMeshDb(node), db = F.makePluginDb(F.makeEvents());
    const S = { nodeid: F.NODE, node: node, rights: 0xFFFFFFFF, domain: 'd', userid: 'u', os: 'windows', histOpts: { historyEntryTypes: [1, 2, 3, 4] }, refs: sessionMod.createRefs(), nonce: 'abc123', redactor: redact.create({ seeds: dd.seeds(node, meshDb.docs['si' + F.NODE]) }), suspicious: new Set() };
    const T = tools.create(S, { db: db, meshDb: meshDb, categories: { deviceSummary: true, storedEvents: true }, agentOnline: function () { return false; } });
    return { S: S, T: T, db: db };
}

test('diagnose digest: device, facets, groups with samples, fenced, within budget, redacted', async function () {
    const x = mk();
    const d = await digest.build({ tools: x.T, mode: 'diagnose', input: { window: { from: F.NOW - 86400000, to: F.NOW } }, budgetTokens: 3000, nonce: 'abc123' });
    assert.ok(d.text.indexOf('<<<UNTRUSTED_DATA nonce=abc123 label=digest>>>') === 0);
    assert.ok(budget.estimateTokens(d.text) <= 3000 + 60);
    assert.ok(/### Device/.test(d.text) && /### Event counts/.test(d.text) && /### Event groups/.test(d.text));
    assert.ok(/"samples":\[/.test(d.text));
    assert.ok(d.refs.length > 0 && d.refs.every(function (r) { return x.S.refs.returned.has(r); }));
    assert.ok(d.text.indexOf('PC-ALICE01') < 0);
    F.assertNoForbidden(assert, 'digest', d.text);
    const small = await digest.build({ tools: x.T, mode: 'diagnose', input: { window: { from: F.NOW - 86400000, to: F.NOW } }, budgetTokens: 600, nonce: 'abc123' });
    assert.ok(budget.estimateTokens(small.text) <= 700);
    const none = await digest.build({ tools: x.T, mode: 'diagnose', input: {}, budgetTokens: 50 });
    assert.strictEqual(none.text, '');
});

test('explain digest: event, reference, device, neighbours without the event itself, 7-day group', async function () {
    const x = mk();
    const ev = x.db.events.find(function (e) { return e.Id === 41; });
    const ref = x.S.refs.add(ev);
    const d = await digest.build({ tools: x.T, mode: 'explain', input: { ref: ref, event: ev }, budgetTokens: 5000, nonce: 'abc123' });
    for (const h of ['The event to explain', 'Reference for this event', 'Device', 'within 15 minutes', 'last 7 days']) assert.ok(d.text.indexOf(h) >= 0, h);
    const near = x.db.calls.filter(function (c) { return c.fn === 'getEventsFor'; })[0].params;
    assert.ok(near.since === ev.tc - 900000 && near.until === ev.tc + 900000);
    assert.ok(/"known":true/.test(d.text));
    const plan = digest.plan('ask', {}, F.NOW);
    assert.deepStrictEqual(plan.map(function (p) { return p.tool; }), ['get_device_info', 'event_facets', 'event_groups']);
});
