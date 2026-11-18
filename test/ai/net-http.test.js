'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { request } = require('../../ai/http.js');
const { createMockLlm } = require('./mock-llm.js');

let mock;
test.before(async function () { mock = await createMockLlm(); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });

test('buffered GET: JSON body, identity encoding requested, no redirects followed', async function () {
    mock.script('/v1/models', { json: { data: [{ id: 'a' }] } });
    const r = await request({ url: mock.base + '/models', headers: { Authorization: 'Bearer k' } }).promise;
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.bodyText), { data: [{ id: 'a' }] });
    assert.strictEqual(mock.requests[0].headers['accept-encoding'], 'identity');
    assert.strictEqual(mock.requests[0].headers.authorization, 'Bearer k');
});

test('POST object body is JSON-encoded with content-length', async function () {
    mock.script('/v1/x', { json: { ok: 1 } });
    await request({ url: mock.base + '/x', method: 'POST', body: { a: 'ü' } }).promise;
    assert.deepStrictEqual(mock.requests[0].body, { a: 'ü' });
    assert.strictEqual(mock.requests[0].headers['content-type'], 'application/json');
    assert.strictEqual(mock.requests[0].headers['content-length'], String(Buffer.byteLength('{"a":"ü"}')));
});

test('streaming: onChunk gets decoded UTF-8 even when split mid-sequence', async function () {
    const text = 'Grüße 😀 ✓ '.repeat(200);
    mock.script('/s', { body: text, split: true });
    let got = '';
    const r = await request({ url: mock.url + '/s' }, function (t) { got += t; }).promise;
    assert.strictEqual(got, text);
    assert.strictEqual(r.bodyText, undefined);
    assert.strictEqual(r.bytes, Buffer.byteLength(text));
});

test('error status: body returned (capped), onChunk not called', async function () {
    mock.script('/e', { status: 500, body: 'x'.repeat(5000) });
    let chunks = 0;
    const r = await request({ url: mock.url + '/e', maxErrorBytes: 1000 }, function () { chunks++; }).promise;
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.bodyText.length, 1000);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(chunks, 0);
});

test('3xx is refused with code redirect and not followed', async function () {
    mock.script('/r', { redirect: mock.url + '/elsewhere' });
    await assert.rejects(request({ url: mock.url + '/r' }).promise, function (e) { return e.code === 'redirect' && e.status === 302; });
    assert.strictEqual(mock.requests.length, 1);
});

test('tooLarge: streaming and buffered', async function () {
    mock.script('/big', { body: 'y'.repeat(50000), split: 1000 }, { body: 'y'.repeat(50000) });
    await assert.rejects(request({ url: mock.url + '/big', maxBytes: 10000 }, function () { }).promise, { code: 'tooLarge' });
    await assert.rejects(request({ url: mock.url + '/big', maxBytes: 10000 }).promise, { code: 'tooLarge' });
});

test('idle timeout fires when the server stops sending, and the connection is closed', async function () {
    mock.script('/hang', { body: 'data: partial\n\n', hang: true });
    await assert.rejects(request({ url: mock.url + '/hang', idleTimeoutMs: 150 }, function () { }).promise, function (e) { return e.code === 'timeout' && e.phase === 'idle'; });
    assert.ok(await mock.waitForClose(mock.requests[0], 1000));
});

test('idle timeout also covers waiting for the response headers', async function () {
    mock.script('/nohead', { hangBeforeHeaders: true });
    await assert.rejects(request({ url: mock.url + '/nohead', idleTimeoutMs: 150 }).promise, { code: 'timeout' });
});

test('total timeout', async function () {
    mock.script('/slow', { body: 'z'.repeat(100), split: 1, chunkDelayMs: 20 });
    await assert.rejects(request({ url: mock.url + '/slow', totalTimeoutMs: 200, idleTimeoutMs: 5000 }, function () { }).promise, function (e) { return e.code === 'timeout' && e.phase === 'total'; });
});

test('abort rejects with aborted and closes the socket (server observes it)', async function () {
    mock.script('/hang2', { body: 'data: x\n\n', hang: true });
    let first;
    const h = request({ url: mock.url + '/hang2' }, function (t) { first = first || t; });
    while (!first) await new Promise(function (r) { setTimeout(r, 5); });
    h.abort('user pressed stop');
    await assert.rejects(h.promise, function (e) { return e.code === 'aborted' && /stop/.test(e.message); });
    assert.ok(await mock.waitForClose(mock.requests[0], 1000));
});

test('connect timeout (a lookup that never answers keeps the socket connecting)', async function () {
    const h = request({ url: 'http://never.test:9/', lookup: function () { }, connectTimeoutMs: 100 });
    await assert.rejects(h.promise, function (e) { return e.code === 'timeout' && e.phase === 'connect'; });
});

test('connection refused -> network', async function () {
    const net = require('net');
    const s = net.createServer(); await new Promise(function (r) { s.listen(0, '127.0.0.1', r); });
    const port = s.address().port; await new Promise(function (r) { s.close(r); });
    await assert.rejects(request({ url: 'http://127.0.0.1:' + port + '/' }).promise, function (e) { return e.code === 'network' && e.sysCode === 'ECONNREFUSED'; });
});

test('server closes mid-body -> network', async function () {
    mock.script('/cut', { body: 'a'.repeat(1000), destroyAfterBytes: 100, headers: { 'content-length': '1000' } });
    await assert.rejects(request({ url: mock.url + '/cut' }, function () { }).promise, { code: 'network' });
});

test('an exception in onChunk rejects the promise with it', async function () {
    mock.script('/t', { body: 'abc' });
    const boom = Object.assign(new Error('boom'), { code: 'badResponse' });
    await assert.rejects(request({ url: mock.url + '/t' }, function () { throw boom; }).promise, function (e) { return e === boom; });
});

test('invalid URL and protocol reject without throwing', async function () {
    await assert.rejects(request({ url: 'nope' }).promise, { code: 'network' });
    await assert.rejects(request({ url: 'ftp://x/' }).promise, { code: 'network' });
});
