'use strict';
const test = require('node:test');
const assert = require('node:assert');
const llm = require('../../ai/llm.js');
const http = require('../../ai/http.js');
const adapters = require('../../ai/adapters/index.js');
const { createMockLlm, responsesSse } = require('./mock-llm.js');

const rs = adapters.get('openai-responses');
const TOOLS = [{ name: 'get_events', description: 'List events', parameters: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } }];

let mock;
test.before(async function () { mock = await createMockLlm(); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });

function ep(extra) { return Object.assign({ baseUrl: mock.base, model: 'gpt-x', apiKey: 'sk-x', maxOutputTokens: 4000 }, extra || {}); }
function run(e, transcript, tools, opts) { return llm.stream({ ep: e, adapter: rs, transcript: transcript, tools: tools, opts: opts, net: {}, retryBaseMs: 0 }).promise; }

const REASONING = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAABencrypted==' };

test('openai-responses: two-round tool loop with call_id and reasoning items replayed', async function () {
    mock.script('/v1/responses', {
        sse: responsesSse({ items: [REASONING, { type: 'message', id: 'msg_1', text: 'Looking ✓' }, { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'get_events', arguments: '{"limit":7}' }] }),
        split: true
    }, { sse: responsesSse({ items: [{ type: 'message', text: 'Done.' }] }), split: true, eol: '\r\n' });
    const transcript = { system: 'Be brief.', items: [{ role: 'user', text: 'Explain' }] };
    const r1 = await run(ep(), transcript, TOOLS, { toolChoice: 'auto' });
    assert.strictEqual(r1.text, 'Looking ✓');
    assert.strictEqual(r1.stopReason, 'tools');
    assert.deepStrictEqual(r1.calls, [{ id: 'call_abc', name: 'get_events', argsText: '{"limit":7}', args: { limit: 7 } }]);
    assert.deepStrictEqual(r1.usage, { in: 31, out: 12 });
    assert.strictEqual(r1.raw.format, 'openai-responses');
    assert.deepStrictEqual(r1.raw.items.map(function (x) { return x.type; }), ['reasoning', 'message', 'function_call']);
    assert.deepStrictEqual(r1.raw.items[0], Object.assign({ status: 'completed' }, REASONING));

    const b1 = mock.requests[0].body;
    assert.strictEqual(mock.requests[0].headers.authorization, 'Bearer sk-x');
    assert.strictEqual(b1.instructions, 'Be brief.');
    assert.strictEqual(b1.store, false);
    assert.deepStrictEqual(b1.include, ['reasoning.encrypted_content']);
    assert.strictEqual(b1.max_output_tokens, 4000);
    assert.strictEqual(b1.stream, true);
    assert.deepStrictEqual(b1.input, [{ role: 'user', content: 'Explain' }]);
    assert.deepStrictEqual(b1.tools, [{ type: 'function', name: 'get_events', description: 'List events', parameters: TOOLS[0].parameters, strict: false }]);
    assert.strictEqual(b1.tool_choice, undefined);

    transcript.items.push({ role: 'assistant', text: r1.text, calls: r1.calls, raw: r1.raw });
    transcript.items.push({ role: 'tool', results: [{ callId: 'call_abc', name: 'get_events', content: '[1,2]', isError: false }] });
    const r2 = await run(ep(), transcript, TOOLS, { toolChoice: 'none' });
    assert.strictEqual(r2.text, 'Done.');
    assert.strictEqual(r2.stopReason, 'end');
    const b2 = mock.requests[1].body;
    assert.strictEqual(b2.tool_choice, 'none');
    assert.deepStrictEqual(b2.input.slice(1, 4), r1.raw.items, 'reasoning / message / function_call items replayed verbatim');
    assert.strictEqual(b2.input[1].encrypted_content, REASONING.encrypted_content);
    assert.deepStrictEqual(b2.input[4], { type: 'function_call_output', call_id: 'call_abc', output: '[1,2]' });
});

test('openai-responses: history from another format is rebuilt (assistant text + function_call items)', function () {
    const b = rs.buildRequest(ep(), { system: '', items: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: 'hm', calls: [{ id: 'c1', name: 'get_events', args: { limit: 1 } }], raw: { format: 'anthropic', items: [{ type: 'thinking' }] } },
        { role: 'tool', results: [{ callId: 'c1', name: 'get_events', content: 'boom', isError: true }] }
    ] }, [], {}).body;
    assert.deepStrictEqual(b.input.slice(1), [
        { role: 'assistant', content: 'hm' },
        { type: 'function_call', call_id: 'c1', name: 'get_events', arguments: '{"limit":1}' },
        { type: 'function_call_output', call_id: 'c1', output: 'Error: boom' }]);
    assert.strictEqual(b.tools, undefined);
    assert.strictEqual(b.instructions, undefined);
});

test('openai-responses: incomplete -> length, failed -> error, error event, early end', async function () {
    mock.script('/v1/responses',
        { sse: responsesSse({ items: [{ type: 'message', text: 'cut' }], incomplete: 'max_output_tokens' }) },
        { sse: responsesSse({ items: [], failed: { code: 'server_error', message: 'boom' } }) },
        { sse: [{ event: 'error', data: { type: 'error', code: 'rate_limit_exceeded', message: 'slow down' } }] },
        { sse: responsesSse({ items: [{ type: 'message', text: 'abc' }] }).slice(0, 4) });
    const t = { system: '', items: [{ role: 'user', text: 'x' }] };
    assert.strictEqual((await run(ep(), t, [], {})).stopReason, 'length');
    await assert.rejects(run(ep(), t, [], {}), { code: 'server' });
    // rateLimit in the stream before any text is retried once; the retry gets the cut stream -> network
    await assert.rejects(run(ep(), t, [], {}), { code: 'network' });
    assert.strictEqual(mock.requests.length, 4);
});

test('openai-responses: non-streamed JSON answer is parsed', async function () {
    mock.script('/v1/responses', { json: { id: 'r', status: 'completed', output: [REASONING, { type: 'function_call', id: 'fc', call_id: 'call_q', name: 'get_events', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 2 } } });
    const r = await run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, TOOLS, {});
    assert.deepStrictEqual(r.calls.map(function (c) { return c.id; }), ['call_q']);
    assert.strictEqual(r.raw.items.length, 2);
    assert.strictEqual(r.stopReason, 'tools');
});

test('openai-responses: probe and listModels', async function () {
    const deps = { request: function (o) { return http.request(o); } };
    mock.always('/v1/models', { json: { data: [{ id: 'gpt-x' }] } });
    assert.deepStrictEqual(await rs.listModels(ep(), deps), [{ id: 'gpt-x' }]);
    mock.script('/v1/models/gpt-x', { json: { id: 'gpt-x' } });
    mock.script('/v1/responses', { json: { status: 'completed', output: [] } });
    const p = await rs.probe(ep(), deps);
    assert.deepStrictEqual([p.ok, p.tools], [true, true]);
    const pr = mock.requests.find(function (r) { return r.path === '/v1/responses'; }).body;
    assert.strictEqual(pr.stream, false);
    assert.strictEqual(pr.max_output_tokens, 16);
    mock.script('/v1/models/gpt-x', { status: 404, json: { error: { message: 'The model gpt-x does not exist', code: 'model_not_found' } } });
    const p2 = await rs.probe(ep(), deps);
    assert.deepStrictEqual([p2.ok, p2.code], [false, 'model']);
});
