'use strict';
const test = require('node:test');
const assert = require('node:assert');
const llm = require('../../ai/llm.js');
const adapters = require('../../ai/adapters/index.js');
const { createMockLlm, chatSse } = require('./mock-llm.js');

const chat = adapters.get('openai-chat');
const T = { system: '', items: [{ role: 'user', text: 'hi' }] };
const PATH = '/v1/chat/completions';
const MAXTOK = { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter' } };
const STREAMOPT = { detail: [{ type: 'extra_forbidden', loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted' }] };

let mock;
test.before(async function () { mock = await createMockLlm(); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });

function start(epExtra) {
    return llm.stream({ ep: Object.assign({ baseUrl: mock.base, model: 'o-model', apiKey: null, maxOutputTokens: 900 }, epExtra || {}), adapter: chat, transcript: T, tools: [], opts: {}, net: {}, retryBaseMs: 0 }).promise;
}

test('400 "use max_completion_tokens" -> resent once with max_completion_tokens; quirk reported', async function () {
    mock.script(PATH, { status: 400, json: MAXTOK }, { sse: chatSse({ text: 'ok' }) });
    const r = await start();
    assert.strictEqual(r.text, 'ok');
    assert.deepStrictEqual(r.quirks, { useMaxCompletionTokens: true });
    assert.strictEqual(r.retried, false, 'does not use up the rate-limit retry');
    assert.strictEqual(mock.requests.length, 2);
    assert.strictEqual(mock.requests[0].body.max_tokens, 900);
    assert.strictEqual(mock.requests[1].body.max_tokens, undefined);
    assert.strictEqual(mock.requests[1].body.max_completion_tokens, 900);
    assert.deepStrictEqual(mock.requests[1].body.stream_options, { include_usage: true });
});

test('400 rejecting stream_options -> resent once without it; quirk reported', async function () {
    mock.script(PATH, { status: 400, json: STREAMOPT }, { sse: chatSse({ text: 'ok' }) });
    const r = await start();
    assert.deepStrictEqual(r.quirks, { noStreamOptions: true });
    assert.strictEqual(mock.requests[1].body.stream_options, undefined);
    assert.strictEqual(mock.requests[1].body.max_tokens, 900);
});

test('both quirks learned in sequence; the rate-limit retry is still available afterwards', async function () {
    mock.script(PATH, { status: 400, json: MAXTOK }, { status: 400, json: { error: { message: 'Unrecognized request argument supplied: stream_options' } } },
        { status: 429, retryAfter: '0', json: {} }, { sse: chatSse({ text: 'done' }) });
    const r = await start();
    assert.strictEqual(r.text, 'done');
    assert.deepStrictEqual(r.quirks, { useMaxCompletionTokens: true, noStreamOptions: true });
    assert.strictEqual(r.retried, true);
    assert.strictEqual(mock.requests.length, 4);
    const last = mock.requests[3].body;
    assert.deepStrictEqual([last.max_tokens, last.max_completion_tokens, last.stream_options], [undefined, 900, undefined]);
});

test('the same 400 again after the fix -> no loop: badRequest with the learned quirk attached', async function () {
    mock.always(PATH, { status: 400, json: MAXTOK });
    await assert.rejects(start(), function (e) { return e.code === 'badRequest' && e.quirks && e.quirks.useMaxCompletionTokens === true; });
    assert.strictEqual(mock.requests.length, 2);
});

test('a different 400 after the fix -> fails once, no further resend', async function () {
    mock.script(PATH, { status: 400, json: MAXTOK }, { status: 400, json: { error: { message: 'messages: field required' } } }, { sse: chatSse({ text: 'never' }) });
    await assert.rejects(start(), function (e) { return e.code === 'badRequest' && /messages/.test(e.message) && e.quirks.useMaxCompletionTokens; });
    assert.strictEqual(mock.requests.length, 2);
});

test('a value error about max_tokens is not a quirk', async function () {
    mock.script(PATH, { status: 400, json: { error: { message: 'max_tokens is too large: 50000. This model supports at most 16384 completion tokens.' } } });
    await assert.rejects(start(), function (e) { return e.code === 'badRequest' && e.quirks === undefined; });
    assert.strictEqual(mock.requests.length, 1);
});

test('ep.quirks shapes the first request; nothing is re-learned', async function () {
    mock.script(PATH, { sse: chatSse({ text: 'ok' }) });
    const r = await start({ quirks: { useMaxCompletionTokens: true, noStreamOptions: true } });
    assert.strictEqual(r.quirks, undefined);
    const b = mock.requests[0].body;
    assert.deepStrictEqual([b.max_tokens, b.max_completion_tokens, b.stream_options], [undefined, 900, undefined]);
});

test('Ollama native requests never learn chat quirks', function () {
    assert.strictEqual(chat.detectQuirk(400, JSON.stringify(MAXTOK), { max_tokens: 1 }, { ollamaNative: true }), null);
});
