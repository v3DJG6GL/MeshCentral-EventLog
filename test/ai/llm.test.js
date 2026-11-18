'use strict';
const test = require('node:test');
const assert = require('node:assert');
const llm = require('../../ai/llm.js');
const adapters = require('../../ai/adapters/index.js');
const { createMockLlm, chatSse, sseText } = require('./mock-llm.js');

const chat = adapters.get('openai-chat');
const T = { system: '', items: [{ role: 'user', text: 'hi' }] };

let mock;
test.before(async function () { mock = await createMockLlm(); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });

function ep(extra) { return Object.assign({ baseUrl: mock.base, model: 'm', apiKey: null }, extra || {}); }
function start(extra) {
    return llm.stream(Object.assign({ ep: ep(), adapter: chat, transcript: T, tools: [], opts: {}, net: {}, retryBaseMs: 0 }, extra || {}));
}
const PATH = '/v1/chat/completions';

test('retry once on 429 with retry-after, then success', async function () {
    mock.script(PATH, { status: 429, retryAfter: '0', json: { error: { message: 'slow' } } }, { sse: chatSse({ text: 'ok' }) });
    const r = await start().promise;
    assert.strictEqual(r.text, 'ok');
    assert.strictEqual(r.retried, true);
    assert.strictEqual(mock.requests.length, 2);
});

test('only one retry: 429 twice -> rateLimit', async function () {
    mock.script(PATH, { status: 429, retryAfter: '0', json: {} }, { status: 429, retryAfter: '0', json: {} }, { sse: chatSse({ text: 'never' }) });
    await assert.rejects(start().promise, function (e) { return e.code === 'rateLimit' && e.retryable === true && e.status === 429; });
    assert.strictEqual(mock.requests.length, 2);
});

test('retry-after beyond 10 s is not waited for', async function () {
    mock.script(PATH, { status: 429, retryAfter: '60', json: {} });
    const t0 = Date.now();
    await assert.rejects(start().promise, function (e) { return e.code === 'rateLimit' && e.retryAfterMs === 60000; });
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual(mock.requests.length, 1);
});

test('retry honours retry-after-ms (waits about that long)', async function () {
    mock.script(PATH, { status: 503, headers: { 'retry-after-ms': '150' }, json: {} }, { sse: chatSse({ text: 'ok' }) });
    const t0 = Date.now();
    const r = await start({ retryBaseMs: 5000 }).promise;
    assert.ok(Date.now() - t0 >= 140);
    assert.strictEqual(r.retried, true);
});

test('503 overloaded and connection reset before any data are retried', async function () {
    mock.script(PATH, { status: 503, json: {} }, { sse: chatSse({ text: 'a' }) });
    assert.strictEqual((await start().promise).text, 'a');
    mock.reset();
    mock.script(PATH, { sse: chatSse({ text: 'never' }), destroyAfterBytes: 0 }, { sse: chatSse({ text: 'b' }) });
    const r = await start().promise;
    assert.strictEqual(r.text, 'b');
    assert.strictEqual(r.retried, true);
});

test('no retry after the first text delta: the cut stream fails with network and keeps the partial text', async function () {
    const body = sseText(chatSse({ text: 'Hello there, this is a long answer', textPieces: 6 }));
    mock.script(PATH, { body: body, headers: { 'content-type': 'text/event-stream' }, destroyAfterBytes: Math.floor(body.length / 2) }, { sse: chatSse({ text: 'second' }) });
    const events = [];
    await assert.rejects(start({ onEvent: function (e) { events.push(e); } }).promise, function (e) { return e.code === 'network' && e.partial && e.partial.text.length > 0; });
    assert.strictEqual(mock.requests.length, 1);
    assert.ok(events.some(function (e) { return e.t === 'text'; }));
});

test('non-retryable errors: 401 auth, 400 tools unsupported, 400 context full', async function () {
    mock.script(PATH, { status: 401, json: { error: { message: 'bad key' } } },
        { status: 400, json: { error: 'model does not support tools' } },
        { status: 400, json: { error: { message: 'maximum context length is 4096 tokens' } } });
    await assert.rejects(start().promise, function (e) { return e.code === 'auth' && e.retryable === false && e.message === 'bad key'; });
    await assert.rejects(start().promise, function (e) { return e.code === 'toolsUnsupported' && e.toolsUnsupported === true; });
    await assert.rejects(start().promise, function (e) { return e.code === 'contextFull' && e.contextFull === true; });
    assert.strictEqual(mock.requests.length, 3);
});

test('abort closes the connection (mock observes the close) and rejects with aborted', async function () {
    mock.script(PATH, { sse: chatSse({ text: 'first ' , done: false, usage: false }).slice(0, 2), hang: true });
    let h;
    const gotText = new Promise(function (resolve) {
        h = start({ onEvent: function (e) { if (e.t === 'text') resolve(); } });
    });
    await gotText;
    h.abort('Stopped by the user');
    await assert.rejects(h.promise, function (e) { return e.code === 'aborted' && e.message === 'Stopped by the user'; });
    assert.ok(await mock.waitForClose(mock.requests[0], 1000), 'server saw the client close the connection');
});

test('abort during the retry backoff cancels the retry', async function () {
    mock.script(PATH, { status: 503, json: {} }, { sse: chatSse({ text: 'x' }) });
    const h = start({ retryBaseMs: 300 });
    await new Promise(function (r) { setTimeout(r, 100); });
    h.abort();
    await assert.rejects(h.promise, { code: 'aborted' });
    await new Promise(function (r) { setTimeout(r, 400); });
    assert.strictEqual(mock.requests.length, 1);
});

test('idle timeout -> timeout (not retried), connection closed', async function () {
    mock.script(PATH, { sse: chatSse({ text: '' }).slice(0, 1), hang: true });
    await assert.rejects(start({ idleTimeoutMs: 150 }).promise, { code: 'timeout' });
    assert.strictEqual(mock.requests.length, 1);
    assert.ok(await mock.waitForClose(mock.requests[0], 1000));
});

test('redirect is refused (blocked) and not followed', async function () {
    mock.script(PATH, { redirect: 'http://169.254.169.254/latest' });
    await assert.rejects(start().promise, function (e) { return e.code === 'blocked' && /redirect/i.test(e.message); });
    assert.strictEqual(mock.requests.length, 1);
});

test('tooLarge -> badResponse', async function () {
    mock.script(PATH, { sse: chatSse({ text: 'x'.repeat(5000) }) });
    await assert.rejects(start({ maxBytes: 1000 }).promise, { code: 'badResponse' });
});

test('more than 20 malformed events -> badResponse; a few are tolerated', async function () {
    const bad = []; for (let i = 0; i < 25; i++) bad.push('data: {nope\n\n');
    mock.script(PATH, { sse: bad.concat(chatSse({ text: 'late' })) }, { sse: bad.slice(0, 5).concat(chatSse({ text: 'fine' })) });
    await assert.rejects(start().promise, { code: 'badResponse' });
    assert.strictEqual((await start().promise).text, 'fine');
});

test('a 200 HTML page is badResponse (wrong address or format)', async function () {
    mock.script(PATH, { body: '<html><body>Welcome</body></html>', headers: { 'content-type': 'text/html' } });
    await assert.rejects(start().promise, function (e) { return e.code === 'badResponse' && /no usable data/.test(e.message); });
});

test('a key is never sent over http:// to a public endpoint', async function () {
    await assert.rejects(start({ ep: ep({ apiKey: 'sk-secret' }), net: { network: 'public' } }).promise, { code: 'blocked' });
    assert.strictEqual(mock.requests.length, 0);
});

test('net.lookup is used; net.agent only for https targets', async function () {
    mock.script(PATH, { sse: chatSse({ text: 'ok' }) });
    let looked = 0;
    const lookup = function (host, o, cb) { looked++; if (typeof o === 'function') cb = o; const all = o && o.all; process.nextTick(function () { all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4); }); };
    const agent = { addRequest: function () { throw new Error('agent must not be used for http'); } };
    const r = await start({ ep: ep({ baseUrl: 'http://mock.invalid:' + mock.port + '/v1' }), net: { lookup: lookup, agent: agent } }).promise;
    assert.strictEqual(r.text, 'ok');
    assert.ok(looked >= 1);
});

test('events stream in order; calls carry parsed args; onEvent exceptions are contained', async function () {
    mock.script(PATH, { sse: chatSse({ text: 'abc', textPieces: 3, calls: [{ id: 'c', name: 'f', args: { a: 1 } }] }), split: true });
    const seen = [];
    const r = await start({ log: function () { }, onEvent: function (e) { seen.push(e.t); if (e.t === 'usage') throw new Error('ui bug'); } }).promise;
    assert.deepStrictEqual(seen, ['text', 'text', 'text', 'call', 'usage', 'stop']);
    assert.deepStrictEqual(r.calls[0].args, { a: 1 });
});

test('unknown adapter -> badRequest without throwing', async function () {
    await assert.rejects(llm.stream({ ep: ep(), adapter: null }).promise, { code: 'badRequest' });
});
