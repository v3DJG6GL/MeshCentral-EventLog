'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../ai/citations.js');

test('extract: single, multi, adjacent; unique in order', function () {
    assert.deepStrictEqual(C.extract('Disk errors [E3] then crash [E7, E3] and [E9][E10]; also [E2; E11] and [E05]'), ['E3', 'E7', 'E9', 'E10', 'E2', 'E11', 'E5']);
    assert.deepStrictEqual(C.extract('no refs [E] [X3] E4 [e]'), []);
    assert.deepStrictEqual(C.extract(null), []);
});

test('validate replaces unknown refs, keeps known ones', function () {
    const ok = new Set(['E1', 'E3', 'E7']);
    const r = C.validate('A [E3] B [E99] C [E3, E99, E7] D [E98][E1] E [E04]', ok);
    assert.strictEqual(r.text, 'A [E3] B [unverified] C [E3, E7] D [unverified][E1] E [unverified]');
    assert.deepStrictEqual(r.valid, ['E3', 'E7', 'E1']);
    assert.deepStrictEqual(r.invalid, ['E99', 'E98', 'E4']);
    assert.strictEqual(C.validate('[E03]', ['E3']).text, '[E3]');
    assert.strictEqual(C.validate('[E3]', null).text, '[unverified]');
    assert.deepStrictEqual(C.validate(undefined, ok), { text: '', valid: [], invalid: [] });
});

test('validateList', function () {
    assert.deepStrictEqual(C.validateList(['E3', 'E9', 'e1', 'E3', 'bogus', 5], new Set(['E1', 'E3'])), ['E3', 'E1']);
    assert.deepStrictEqual(C.validateList(null, new Set(['E1'])), []);
});
