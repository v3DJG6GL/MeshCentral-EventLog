'use strict';
const test = require('node:test');
const assert = require('node:assert');
const llm = require('../../ai/llm.js');
const http = require('../../ai/http.js');
const adapters = require('../../ai/adapters/index.js');
const { createMockLlm, anthropicSse } = require('./mock-llm.js');

const an = adapters.get('anthropic');
const TOOLS = [
    { name: 'get_events', description: 'List events', parameters: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } },
    { name: 'get_event', description: 'One event', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false } }
];

let mock;
test.before(async function () { mock = await createMockLlm(); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });

function ep(extra) { return Object.assign({ baseUrl: mock.base, model: 'claude-opus-5-5', apiKey: 'sk-ant-test' }, extra || {}); }
function run(e, transcript, tools, opts, events) {
    return llm.stream({ ep: e, adapter: an, transcript: transcript, tools: tools, opts: opts, net: {}, retryBaseMs: 0, onEvent: function (ev) { if (events) events.push(ev); } }).promise;
}

const THINK = { type: 'thinking', thinking: 'Considering the Kernel-Power event…', signature: 'EqQBCkgIARABGAIiQL+sig/=' };
const REDACTED = { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr' };

test('anthropic: two-round tool loop; thinking blocks replayed unchanged; tool results grouped in one user message', async function () {
    mock.script('/v1/messages', {
        sse: anthropicSse({ blocks: [THINK, REDACTED, { type: 'text', text: 'I will check the events ✓.' }, { type: 'tool_use', id: 'toolu_01', name: 'get_events', input: { limit: 20 } }, { type: 'tool_use', id: 'toolu_02', name: 'get_event', input: { ref: 'E3' } }], stop: 'tool_use' }),
        split: true, eol: '\r\n'
    }, { sse: anthropicSse({ blocks: [{ type: 'text', text: 'Unexpected shutdown [E3].' }] }), split: true });
    const transcript = { system: 'You explain event logs.', items: [{ role: 'user', text: 'What happened?' }] };
    const events = [];
    const r1 = await run(ep(), transcript, TOOLS, { toolChoice: 'auto' }, events);
    assert.strictEqual(r1.text, 'I will check the events ✓.');
    assert.strictEqual(r1.stopReason, 'tools');
    assert.deepStrictEqual(r1.calls.map(function (c) { return [c.id, c.name, c.args]; }), [['toolu_01', 'get_events', { limit: 20 }], ['toolu_02', 'get_event', { ref: 'E3' }]]);
    assert.deepStrictEqual(r1.usage, { in: 21, out: 9 });
    assert.strictEqual(r1.raw.format, 'anthropic');
    assert.deepStrictEqual(r1.raw.items, [THINK, REDACTED, { type: 'text', text: 'I will check the events ✓.' },
        { type: 'tool_use', id: 'toolu_01', name: 'get_events', input: { limit: 20 } }, { type: 'tool_use', id: 'toolu_02', name: 'get_event', input: { ref: 'E3' } }]);
    assert.ok(!events.some(function (e) { return e.t === 'text' && /Considering/.test(e.d); }), 'thinking is not streamed as text');

    const q1 = mock.requests[0];
    assert.strictEqual(q1.headers['x-api-key'], 'sk-ant-test');
    assert.strictEqual(q1.headers['anthropic-version'], '2026-10-21');
    assert.strictEqual(q1.headers.authorization, undefined);
    for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in q1.body), k + ' must never be sent');
    assert.strictEqual(q1.body.max_tokens, 8192);
    assert.strictEqual(q1.body.system, 'You explain event logs.');
    assert.strictEqual(q1.body.stream, true);
    assert.deepStrictEqual(q1.body.tools[1], { name: 'get_event', description: 'One event', input_schema: TOOLS[1].parameters });
    assert.strictEqual(q1.body.tool_choice, undefined);
    assert.deepStrictEqual(q1.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'What happened?' }] }]);

    transcript.items.push({ role: 'assistant', text: r1.text, calls: r1.calls, raw: r1.raw });
    transcript.items.push({ role: 'tool', results: [{ callId: 'toolu_01', name: 'get_events', content: '[]', isError: false }, { callId: 'toolu_02', name: 'get_event', content: 'not found', isError: true }] });
    const r2 = await run(ep({ maxOutputTokens: 2000 }), transcript, TOOLS, { toolChoice: 'none' });
    assert.strictEqual(r2.text, 'Unexpected shutdown [E3].');
    assert.strictEqual(r2.stopReason, 'end');
    const b2 = mock.requests[1].body;
    for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in b2));
    assert.strictEqual(b2.max_tokens, 2000);
    assert.deepStrictEqual(b2.tool_choice, { type: 'none' });
    assert.strictEqual(b2.messages.length, 3);
    assert.deepStrictEqual(b2.messages[1], { role: 'assistant', content: r1.raw.items });
    assert.deepStrictEqual(b2.messages[1].content[0], THINK, 'thinking block with signature passed back unmodified');
    assert.deepStrictEqual(b2.messages[2], { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: '[]' },
        { type: 'tool_result', tool_use_id: 'toolu_02', content: 'not found', is_error: true }] });
});

test('anthropic: without raw (other format history) assistant turns are rebuilt from text + calls', function () {
    const b = an.buildRequest(ep(), { system: '', items: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: 'checking', calls: [{ id: 'c1', name: 'get_events', args: null, argsText: '{"limit":2}' }], raw: { format: 'openai-responses', items: [{ type: 'reasoning' }] } },
        { role: 'tool', results: [{ callId: 'c1', name: 'get_events', content: 'r', isError: false }] },
        { role: 'user', text: 'and now?' }
    ] }, TOOLS, { toolChoice: 'auto' }).body;
    assert.deepStrictEqual(b.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'c1', name: 'get_events', input: { limit: 2 } }] });
    assert.deepStrictEqual(b.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'r' }, { type: 'text', text: 'and now?' }] }, 'consecutive user content merged, tool_result first');
    assert.strictEqual(b.system, undefined);
});

test('anthropic: stop reasons map', async function () {
    const cases = [['max_tokens', 'length'], ['refusal', 'refusal'], ['pause_turn', 'end'], ['stop_sequence', 'end'], ['model_context_window_exceeded', 'length']];
    for (const [s] of cases) mock.script('/v1/messages', { sse: anthropicSse({ blocks: [{ type: 'text', text: 'x' }], stop: s }) });
    for (const [, want] of cases) assert.strictEqual((await run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, [], {})).stopReason, want);
});

test('anthropic: overloaded_error in the stream before any text is retried once', async function () {
    mock.script('/v1/messages', { sse: anthropicSse({ blocks: [], error: { type: 'overloaded_error', message: 'Overloaded' } }) }, { sse: anthropicSse({ blocks: [{ type: 'text', text: 'ok' }] }) });
    const r = await run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, [], {});
    assert.strictEqual(r.text, 'ok');
    assert.strictEqual(r.retried, true);
    assert.strictEqual(mock.requests.length, 2);
});

test('anthropic: overloaded_error after text is not retried', async function () {
    mock.script('/v1/messages', { sse: anthropicSse({ blocks: [{ type: 'text', text: 'partial answer' }], error: { type: 'overloaded_error', message: 'Overloaded' } }) });
    await assert.rejects(run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, [], {}), function (e) { return e.code === 'overloaded' && e.partial.text === 'partial answer'; });
    assert.strictEqual(mock.requests.length, 1);
});

test('anthropic: stream cut before message_delta -> network error', async function () {
    const ev = anthropicSse({ blocks: [{ type: 'text', text: 'abc' }] }).slice(0, 5);
    mock.script('/v1/messages', { sse: ev });
    await assert.rejects(run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, [], {}), { code: 'network' });
});

test('anthropic: classifyError uses error.type', function () {
    const c = function (s, type, msg, h) { return an.classifyError(s, h || {}, JSON.stringify({ type: 'error', error: { type: type, message: msg || 'm' } })); };
    assert.strictEqual(c(401, 'authentication_error').code, 'auth');
    assert.strictEqual(c(403, 'permission_error').code, 'auth');
    assert.strictEqual(c(404, 'not_found_error', 'model: claude-x').code, 'model');
    assert.deepStrictEqual([c(429, 'rate_limit_error', 'x', { 'retry-after': '2' }).code, c(429, 'rate_limit_error', 'x', { 'retry-after': '2' }).retryAfterMs], ['rateLimit', 2000]);
    assert.deepStrictEqual([c(529, 'overloaded_error').code, c(529, 'overloaded_error').retryable], ['overloaded', true]);
    assert.strictEqual(c(413, 'request_too_large').code, 'contextFull');
    assert.strictEqual(c(400, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum').code, 'contextFull');
    assert.strictEqual(c(400, 'invalid_request_error', 'temperature: unexpected').code, 'badRequest');
    assert.strictEqual(c(500, 'api_error').code, 'server');
});

test('anthropic: listModels (max_input_tokens, pagination) and probe', async function () {
    mock.script('/v1/models', { json: { data: [{ id: 'claude-opus-5-5', max_input_tokens: 1000000, max_tokens: 128000 }], has_more: true, last_id: 'claude-opus-5-5' } }, { json: { data: [{ id: 'claude-haiku-5-5', max_input_tokens: 1000000 }], has_more: false } });
    const deps = { request: function (o) { return http.request(o); } };
    const list = await an.listModels(ep(), deps);
    assert.deepStrictEqual(list.map(function (m) { return [m.id, m.ctx]; }), [['claude-opus-5-5', 1000000], ['claude-haiku-5-5', 1000000]]);
    assert.match(mock.requests[1].search, /after_id=claude-opus-5-5/);
    assert.strictEqual(mock.requests[0].headers['anthropic-version'], '2026-10-21');
    mock.script('/v1/models/claude-opus-5-5', { json: { id: 'claude-opus-5-5', max_input_tokens: 1000000 } });
    const p = await an.probe(ep(), deps);
    assert.deepStrictEqual([p.ok, p.tools, p.ctx], [true, true, 1000000]);
    mock.script('/v1/models/claude-opus-5-5', { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const p2 = await an.probe(ep(), deps);
    assert.deepStrictEqual([p2.ok, p2.code], [false, 'auth']);
    // a compatible server without /models/{id}: falls back to a tiny request
    mock.script('/v1/messages', { json: { type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } } });
    const p3 = await an.probe(ep(), deps);
    assert.deepStrictEqual([p3.ok, p3.tools], [true, true]);
    const last = mock.requests[mock.requests.length - 1];
    assert.strictEqual(last.path, '/v1/messages');
    for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in last.body));
});

test('anthropic: non-streamed JSON answer is parsed', async function () {
    mock.script('/v1/messages', { json: { type: 'message', content: [THINK, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 't9', name: 'get_events', input: { limit: 1 } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 3 } } });
    const r = await run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, TOOLS, {});
    assert.strictEqual(r.text, 'hi');
    assert.deepStrictEqual(r.calls[0].args, { limit: 1 });
    assert.deepStrictEqual(r.raw.items[0], THINK);
    assert.strictEqual(r.stopReason, 'tools');
});
