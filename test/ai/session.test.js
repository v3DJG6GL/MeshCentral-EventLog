'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sessionMod = require('../../ai/session.js');

function ws() { const h = []; return { readyState: 1, once: function (e, f) { if (e === 'close') h.push(f); }, fire: function () { h.splice(0).forEach(function (f) { f(); }); } }; }

test('open: 32-hex convId, defaults, ownership by user and connection', function () {
    const m = sessionMod.create({});
    const w = ws();
    const r = m.open({ userid: 'u1', ws: w, nodeid: 'n' });
    assert.ok(r.ok);
    assert.ok(/^[0-9a-f]{32}$/.test(r.S.convId));
    assert.strictEqual(r.S.turn, 0);
    assert.strictEqual(r.S.ratio, 1);
    assert.strictEqual(m.owned(r.S.convId, { user: { _id: 'u1' }, ws: w }), r.S);
    assert.strictEqual(m.owned(r.S.convId, { user: { _id: 'u2' }, ws: w }), null);
    assert.strictEqual(m.owned(r.S.convId, { user: { _id: 'u1' }, ws: ws() }), null);
    assert.strictEqual(m.owned(123, { user: { _id: 'u1' }, ws: w }), null);
    m.stop();
});

test('caps: 3 open per user (oldest idle evicted), 1 busy per user, global busy cap', function () {
    let t = 1000;
    const closed = [];
    const m = sessionMod.create({ now: function () { return t; }, maxBusyGlobal: 2, onClose: function (S, why) { closed.push(why); } });
    const a = m.open({ userid: 'u1' }).S; t++;
    const b = m.open({ userid: 'u1' }).S; t++;
    const c = m.open({ userid: 'u1' }).S; t++;
    a.lastActive = 5000;            // a was used most recently -> b is the oldest idle one
    assert.ok(m.acquire(c));
    const d = m.open({ userid: 'u1' }).S;
    assert.strictEqual(m.size(), 3);
    assert.ok(b.closed && !a.closed && !c.closed && !d.closed);
    assert.deepStrictEqual(closed, ['evicted']);
    assert.strictEqual(m.acquire(d), false, 'one busy per user');
    assert.strictEqual(m.canBusy('u1'), false);
    const e = m.open({ userid: 'u2' }).S;
    assert.ok(m.acquire(e));
    const f = m.open({ userid: 'u3' }).S;
    assert.strictEqual(m.canBusy('u3'), false, 'global cap');
    assert.strictEqual(m.acquire(f), false);
    m.release(c);
    assert.ok(m.acquire(f));
    assert.strictEqual(m.busyCount(), 2);
    m.stop();
});

test('close aborts an in-flight turn; ws close closes all sessions of that connection; TTL sweep', function () {
    let t = 0;
    const m = sessionMod.create({ now: function () { return t; }, ttlMs: 1000 });
    const w = ws();
    const a = m.open({ userid: 'u1', ws: w }).S;
    const b = m.open({ userid: 'u2', ws: w }).S;
    const c = m.open({ userid: 'u3', ws: ws() }).S;
    let aborted = null;
    m.acquire(a); a.abort = function (why) { aborted = why; };
    w.fire();
    assert.strictEqual(aborted, 'closed');
    assert.ok(a.closed && b.closed && !c.closed);
    assert.strictEqual(m.size(), 1);
    assert.strictEqual(m.busyCount(), 1);
    m.release(a);
    assert.strictEqual(m.busyCount(), 0);
    t = 999; m.sweep(); assert.strictEqual(m.size(), 1);
    t = 2001; m.sweep(); assert.strictEqual(m.size(), 0);
    assert.strictEqual(c.closeReason, 'expired');
    const d = m.open({ userid: 'u4' }).S;
    m.closeAll('reload');
    assert.strictEqual(d.closeReason, 'reload');
    assert.strictEqual(m.close(d, 'again'), false);
    m.stop();
});

test('refs registry: stable refs per stored id, returned set, markIn only for assigned quoted refs', function () {
    const r = sessionMod.createRefs();
    const e1 = { _id: 'a1', Message: 'x'.repeat(20000) }, e2 = { _id: 'a2' };
    assert.strictEqual(r.add(e1), 'E1');
    assert.strictEqual(r.add(e2), 'E2');
    assert.strictEqual(r.add({ _id: 'a1' }), 'E1');
    assert.strictEqual(r.add({ noid: 1 }), null);
    assert.strictEqual(r.idOf('E2'), 'a2');
    assert.strictEqual(r.idOf('e02'), 'a2');
    assert.strictEqual(r.get('E1').Message.length, 8000, 'stored copy is bounded');
    assert.strictEqual(r.returned.size, 0);
    r.markIn('{"ref":"E2","x":"E7","msg":"text E1 unquoted"}');
    assert.deepStrictEqual(Array.from(r.returned), ['E2']);
    r.mark('E1'); r.mark('E9');
    assert.deepStrictEqual(Array.from(r.returned).sort(), ['E1', 'E2']);
});
