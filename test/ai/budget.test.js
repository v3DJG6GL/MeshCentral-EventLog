'use strict';
const test = require('node:test');
const assert = require('node:assert');
const B = require('../../ai/budget.js');

test('estimateTokens: utf8 bytes / 3, ratio, objects as JSON', function () {
    assert.strictEqual(B.estimateTokens(''), 0);
    assert.strictEqual(B.estimateTokens('abc'), 1);
    assert.strictEqual(B.estimateTokens('abcd'), 2);
    assert.strictEqual(B.estimateTokens('äää'), 2);          // 6 bytes
    assert.strictEqual(B.estimateTokens('abcdef', 1.5), 3);
    assert.strictEqual(B.estimateTokens({ a: 1 }), Math.ceil(7 / 3));
    assert.strictEqual(B.estimateTokens(null), 0);
    assert.strictEqual(B.estimateTokens('abc', 'x'), 1);
    const cyc = {}; cyc.self = cyc;
    assert.strictEqual(B.estimateTokens(cyc), 0);
});

test('calibrate: prev * reported / estimated, clamped 0.5..2', function () {
    assert.strictEqual(B.calibrate(1, 1200, 1000), 1.2);
    assert.strictEqual(B.calibrate(1.2, 1000, 1000), 1.2);
    assert.strictEqual(B.calibrate(1, 10000, 1000), 2);
    assert.strictEqual(B.calibrate(1, 10, 1000), 0.5);
    assert.strictEqual(B.calibrate(1.3, 0, 1000), 1.3);
    assert.strictEqual(B.calibrate(undefined, 'x', null), 1);
    assert.strictEqual(B.calibrate(9, null, null), 2);
});

test('inputBudget', function () {
    assert.strictEqual(B.inputBudget(8192, 1024), Math.floor(7168 * 0.9));
    assert.strictEqual(B.inputBudget(2000, 1900), 1024);
    assert.strictEqual(B.inputBudget('x', 'y'), Math.floor(8192 * 0.9));
});

function ev(i, len) { return { ref: 'E' + i, t: 1700000000000 + i, lvl: 2, log: 'System', src: 'disk', id: 7, msg_untrusted: 'x'.repeat(len) }; }

test('fitJson: small values unchanged', function () {
    const v = { events: [ev(1, 10)] };
    const r = B.fitJson(v, 1000);
    assert.deepStrictEqual(r, { text: JSON.stringify(v), truncated: false, dropped: 0 });
});

test('fitJson: truncates msg_untrusted first, then drops trailing items of the largest array', function () {
    const v = { window: { from: 1, to: 2 }, events: [], other: [1, 2, 3] };
    for (let i = 1; i <= 10; i++) v.events.push(ev(i, 2000));
    // enough room for all ten once messages are cut to 300 chars
    let r = B.fitJson(v, 1600);
    let o = JSON.parse(r.text);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.dropped, 0);
    assert.strictEqual(o.events.length, 10);
    assert.strictEqual(o.events[0].msg_untrusted.length, 301);
    assert.strictEqual(o.truncated, true);
    assert.match(o.note, /Narrow/);
    assert.ok(Buffer.byteLength(r.text) <= 1600 * 3);
    // tighter: items dropped from the end, the small array untouched
    r = B.fitJson(v, 500);
    o = JSON.parse(r.text);
    assert.ok(Buffer.byteLength(r.text) <= 1500, Buffer.byteLength(r.text));
    assert.ok(o.events.length > 0 && o.events.length < 10);
    assert.strictEqual(r.dropped, 10 - o.events.length);
    assert.strictEqual(o.events[0].ref, 'E1');
    assert.deepStrictEqual(o.other, [1, 2, 3]);
    assert.strictEqual(v.events[0].msg_untrusted.length, 2000);   // input not modified
});

test('fitJson: custom fields, arrays wrapped, never above the byte cap', function () {
    const arr = [];
    for (let i = 0; i < 200; i++) arr.push({ name: 'app ' + i, note: 'n'.repeat(100) });
    const r = B.fitJson(arr, 300, { truncateFields: { note: 10 } });
    const o = JSON.parse(r.text);
    assert.ok(Array.isArray(o.items));
    assert.strictEqual(o.items[0].note.length, 11);
    assert.ok(Buffer.byteLength(r.text) <= 900);
    for (const mt of [40, 60, 100, 250, 1000]) {
        const x = B.fitJson({ a: 'y'.repeat(50000), list: arr }, mt);
        assert.ok(Buffer.byteLength(x.text) <= mt * 3, mt + ': ' + Buffer.byteLength(x.text));
        assert.doesNotThrow(() => JSON.parse(x.text));
    }
    const big = {}; for (let i = 0; i < 2000; i++) big['k' + i] = i;
    const x = B.fitJson(big, 100);
    assert.deepStrictEqual(Object.keys(JSON.parse(x.text)).sort(), ['note', 'truncated']);
    assert.strictEqual(B.fitJson(undefined, 10).text, 'null');
});
