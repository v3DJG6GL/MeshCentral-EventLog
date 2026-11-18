'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSseParser } = require('../../ai/sse.js');
const { createNdjsonParser } = require('../../ai/ndjson.js');
const { rng } = require('./mock-llm.js');

const SEED = Number(process.env.MOCK_SEED) || 4242;

// Feed a Buffer in random pieces (byte boundaries, so UTF-8 sequences and \r\n pairs get split).
function feedRandom(parser, buf, rand) {
    let i = 0;
    while (i < buf.length) { const n = 1 + Math.floor(rand() * 7); parser.push(buf.subarray(i, i + n)); i += n; }
    parser.end();
}

const SSE_SAMPLE = [
    ': comment at the start',
    'event: message_start',
    'data: {"a":"héllo wörld ✓ 😀"}',
    '',
    'data: line one',
    'data: line two',
    '',
    'event: ping',
    'data:',
    '',
    ':keep-alive',
    '',
    'data:no-space',
    'id: 7',
    'retry: 100',
    '',
    'data: [DONE]',
    ''
];
const SSE_EXPECTED = [
    { event: 'message_start', data: '{"a":"héllo wörld ✓ 😀"}' },
    { event: 'message', data: 'line one\nline two' },
    { event: 'ping', data: '' },
    { event: 'message', data: 'no-space' },
    { event: 'done' }
];

for (const eol of ['\n', '\r\n', '\r']) {
    test('sse: ' + JSON.stringify(eol) + ' line endings, 200 random splits', function () {
        const buf = Buffer.from('﻿' + SSE_SAMPLE.join(eol) + eol, 'utf8');
        const rand = rng(SEED);
        for (let round = 0; round < 200; round++) {
            const got = [];
            feedRandom(createSseParser(function (e) { got.push(e); }), buf, rand);
            assert.deepStrictEqual(got, SSE_EXPECTED, 'seed ' + SEED + ' round ' + round);
        }
    });
}

test('sse: string input, final event without a trailing blank line, byte-at-a-time', function () {
    const got = [];
    const p = createSseParser(function (e) { got.push(e); });
    const s = 'data: {"x":1}\r\n\r\ndata: tail';
    for (const ch of s) p.push(ch);
    p.end();
    assert.deepStrictEqual(got, [{ event: 'message', data: '{"x":1}' }, { event: 'message', data: 'tail' }]);
});

test('sse: \\r at the end of a chunk followed by \\n in the next is one line break', function () {
    const got = [];
    const p = createSseParser(function (e) { got.push(e); });
    p.push('data: a\r'); p.push('\ndata: b\r'); p.push('\n\r'); p.push('\n');
    p.end();
    assert.deepStrictEqual(got, [{ event: 'message', data: 'a\nb' }]);
});

test('ndjson: random splits, \\r\\n, blank lines, malformed lines counted', function () {
    const objs = [{ a: 1, s: 'ünïcødé 😀' }, { b: [1, 2, 3] }, { done: true, msg: 'x\ny' }];
    const text = objs.map(function (o) { return JSON.stringify(o); }).join('\r\n') + '\r\n\n{not json}\n' + JSON.stringify({ last: 1 });
    const buf = Buffer.from(text, 'utf8');
    const rand = rng(SEED + 1);
    for (let round = 0; round < 200; round++) {
        const got = []; const errs = [];
        const p = createNdjsonParser(function (o) { got.push(o); }, function (e) { errs.push(e); });
        feedRandom(p, buf, rand);
        assert.deepStrictEqual(got, objs.concat([{ last: 1 }]), 'round ' + round);
        assert.strictEqual(errs.length, 1);
        assert.strictEqual(p.errors, 1);
        assert.strictEqual(errs[0].snippet, '{not json}');
    }
});

test('ndjson: no onError handler -> malformed lines are ignored, nothing throws', function () {
    const got = [];
    const p = createNdjsonParser(function (o) { got.push(o); });
    p.push('oops\n{"ok":true}\n');
    p.end();
    assert.deepStrictEqual(got, [{ ok: true }]);
    assert.strictEqual(p.errors, 1);
});
