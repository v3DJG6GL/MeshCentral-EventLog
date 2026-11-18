'use strict';
const test = require('node:test');
const assert = require('node:assert');
const llm = require('../../ai/llm.js');
const http = require('../../ai/http.js');
const adapters = require('../../ai/adapters/index.js');
const { createMockLlm, chatSse } = require('./mock-llm.js');

const chat = adapters.get('openai-chat');
const TOOLS = [
    { name: 'get_events', description: 'List events', parameters: { type: 'object', properties: { limit: { type: 'integer' }, q: { type: 'string' } }, additionalProperties: false } },
    { name: 'get_device_info', description: 'Device info', parameters: { type: 'object', properties: {}, additionalProperties: false } }
];

let mock;
test.before(async function () { mock = await createMockLlm(); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });

function ep(extra) { return Object.assign({ baseUrl: mock.base, model: 'qwen3:8b', apiKey: 'sk-local', maxOutputTokens: 1024 }, extra || {}); }
function run(e, transcript, tools, opts, events) {
    return llm.stream({ ep: e, adapter: chat, transcript: transcript, tools: tools, opts: opts, net: {}, retryBaseMs: 0, onEvent: function (ev) { if (events) events.push(ev); } }).promise;
}

test('openai-chat: two-round tool loop (fragments merged, missing id synthesized, reasoning dropped)', async function () {
    mock.script('/v1/chat/completions', {
        sse: chatSse({ text: 'Let me look ✓. ', reasoning: 'secret chain of thought', calls: [{ name: 'get_events', args: { limit: 5, q: 'Grüße' }, fragments: 5 }, { id: 'call_given', name: 'get_device_info', args: {} }] }),
        split: true, eol: '\r\n'
    }, { sse: chatSse({ text: 'The disk is failing [E1].' }), split: true });
    const transcript = { system: 'You are a helper.', items: [{ role: 'user', text: 'Why did it crash?' }] };
    const events = [];
    const r1 = await run(ep(), transcript, TOOLS, { toolChoice: 'auto' }, events);
    assert.strictEqual(r1.text, 'Let me look ✓. ');
    assert.ok(!JSON.stringify(events).includes('chain of thought'));
    assert.strictEqual(r1.stopReason, 'tools');
    assert.strictEqual(r1.calls.length, 2);
    assert.match(r1.calls[0].id, /^call_/);
    assert.deepStrictEqual(r1.calls[0].args, { limit: 5, q: 'Grüße' });
    assert.strictEqual(r1.calls[0].argsText, JSON.stringify({ limit: 5, q: 'Grüße' }));
    assert.strictEqual(r1.calls[1].id, 'call_given');
    assert.deepStrictEqual(r1.usage, { in: 11, out: 7 });
    assert.strictEqual(r1.raw, null);
    assert.ok(events.some(function (e) { return e.t === 'text'; }));

    const q1 = mock.requests[0];
    assert.strictEqual(q1.headers.authorization, 'Bearer sk-local');
    assert.strictEqual(q1.body.stream, true);
    assert.deepStrictEqual(q1.body.stream_options, { include_usage: true });
    assert.strictEqual(q1.body.max_tokens, 1024);
    assert.deepStrictEqual(q1.body.messages, [{ role: 'system', content: 'You are a helper.' }, { role: 'user', content: 'Why did it crash?' }]);
    assert.deepStrictEqual(q1.body.tools[0], { type: 'function', function: TOOLS[0] });
    assert.strictEqual(q1.body.tool_choice, undefined);

    transcript.items.push({ role: 'assistant', text: r1.text, calls: r1.calls, raw: r1.raw });
    transcript.items.push({ role: 'tool', results: [{ callId: r1.calls[0].id, name: 'get_events', content: '{"events":[]}', isError: false }, { callId: 'call_given', name: 'get_device_info', content: 'denied', isError: true }] });
    const r2 = await run(ep(), transcript, TOOLS, { toolChoice: 'none' });
    assert.strictEqual(r2.text, 'The disk is failing [E1].');
    assert.strictEqual(r2.stopReason, 'end');
    assert.deepStrictEqual(r2.calls, []);
    const m = mock.requests[1].body.messages;
    assert.deepStrictEqual(m[2], { role: 'assistant', content: 'Let me look ✓. ', tool_calls: [
        { id: r1.calls[0].id, type: 'function', function: { name: 'get_events', arguments: r1.calls[0].argsText } },
        { id: 'call_given', type: 'function', function: { name: 'get_device_info', arguments: '{}' } }] });
    assert.deepStrictEqual(m[3], { role: 'tool', tool_call_id: r1.calls[0].id, content: '{"events":[]}' });
    assert.deepStrictEqual(m[4], { role: 'tool', tool_call_id: 'call_given', content: 'Error: denied' });
    assert.strictEqual(mock.requests[1].body.tool_choice, 'none');
});

test('openai-chat: tool call deltas without index, arguments as an object, invalid JSON arguments', async function () {
    mock.script('/v1/chat/completions', { sse: [
        { choices: [{ index: 0, delta: { tool_calls: [{ id: 'a1', function: { name: 'get_events', arguments: '{"li' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: 'mit":3}' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ id: 'b2', function: { name: 'get_device_info', arguments: { x: 1 } } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ id: 'c3', function: { name: 'get_events', arguments: '{broken' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        'data: [DONE]\n\n'
    ], split: true });
    const r = await run(ep({ apiKey: null }), { system: '', items: [{ role: 'user', text: 'x' }] }, TOOLS, {});
    assert.deepStrictEqual(r.calls.map(function (c) { return [c.id, c.name, c.args]; }), [['a1', 'get_events', { limit: 3 }], ['b2', 'get_device_info', { x: 1 }], ['c3', 'get_events', null]]);
    assert.strictEqual(r.stopReason, 'tools', 'finish_reason stop with calls means tools');
    assert.strictEqual(mock.requests[0].headers.authorization, undefined);
    assert.strictEqual(mock.requests[0].body.messages[0].role, 'user', 'no empty system message');
});

test('openai-chat: no tools -> neither tools nor tool_choice is sent; finish reasons map', async function () {
    mock.script('/v1/chat/completions',
        { sse: chatSse({ text: 'cut', finish: 'length' }) },
        { sse: chatSse({ text: 'no', finish: 'content_filter' }) });
    const r1 = await run(ep(), { system: 's', items: [{ role: 'user', text: 'x' }] }, [], { toolChoice: 'none' });
    assert.strictEqual(r1.stopReason, 'length');
    assert.strictEqual(mock.requests[0].body.tools, undefined);
    assert.strictEqual(mock.requests[0].body.tool_choice, undefined);
    const r2 = await run(ep(), { system: 's', items: [{ role: 'user', text: 'x' }] }, [], {});
    assert.strictEqual(r2.stopReason, 'refusal');
});

test('openai-chat: a server that ignores stream:true and answers JSON', async function () {
    mock.script('/v1/chat/completions', { json: { choices: [{ index: 0, message: { role: 'assistant', content: 'hello', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_events', arguments: '{"limit":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } } });
    const r = await run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, TOOLS, {});
    assert.strictEqual(r.text, 'hello');
    assert.deepStrictEqual(r.calls[0].args, { limit: 1 });
    assert.deepStrictEqual(r.usage, { in: 3, out: 2 });
    assert.strictEqual(r.stopReason, 'tools');
});

test('openai-chat: in-stream error object -> error code', async function () {
    mock.script('/v1/chat/completions', { sse: [{ error: { message: 'model crashed', type: 'server_error' } }] });
    await assert.rejects(run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, [], {}), { code: 'server' });
});

test('openai-chat: classifyError', function () {
    const c = function (s, body, h) { return chat.classifyError(s, h || {}, typeof body === 'string' ? body : JSON.stringify(body)); };
    assert.strictEqual(c(401, { error: { message: 'bad key' } }).code, 'auth');
    assert.strictEqual(c(403, '').code, 'auth');
    assert.strictEqual(c(404, { error: { message: 'The model `x` does not exist', code: 'model_not_found' } }).code, 'model');
    assert.strictEqual(c(404, '<html>nginx</html>').code, 'badRequest');
    const rl = c(429, { error: { message: 'slow down' } }, { 'retry-after': '3' });
    assert.deepStrictEqual([rl.code, rl.retryable, rl.retryAfterMs], ['rateLimit', true, 3000]);
    assert.strictEqual(c(429, { error: { message: 'quota', code: 'insufficient_quota' } }).retryable, false);
    assert.strictEqual(c(429, '', { 'retry-after-ms': '250', 'retry-after': '9' }).retryAfterMs, 250);
    assert.strictEqual(c(503, '').code, 'overloaded');
    assert.strictEqual(c(529, '').code, 'overloaded');
    assert.deepStrictEqual([c(500, '').code, c(500, '').retryable], ['server', false]);
    const tu = c(400, { error: 'registry.ollama.ai/library/gemma:2b does not support tools' });
    assert.deepStrictEqual([tu.code, tu.toolsUnsupported], ['toolsUnsupported', true]);
    assert.strictEqual(c(400, { error: { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set' } }).code, 'toolsUnsupported');
    const cf = c(400, { error: { message: "This model's maximum context length is 8192 tokens.", code: 'context_length_exceeded' } });
    assert.deepStrictEqual([cf.code, cf.contextFull], ['contextFull', true]);
    assert.strictEqual(c(400, { error: { message: 'the request exceeds the available context size' } }).code, 'contextFull');
    assert.strictEqual(c(422, { detail: 'bad' }).code, 'badRequest');
    assert.strictEqual(c(422, { detail: 'bad' }).message, 'bad');
});

test('openai-chat: listModels (vLLM max_model_len) and probe of a non-Ollama server', async function () {
    mock.always('/v1/models', { json: { object: 'list', data: [{ id: 'qwen3:8b', owned_by: 'vllm', max_model_len: 32768 }, { id: 'other' }] } });
    const deps = { request: function (o) { return http.request(o); } };
    const models = await chat.listModels(ep(), deps);
    assert.deepStrictEqual(models, [{ id: 'qwen3:8b', ctx: 32768, owner: 'vllm' }, { id: 'other' }]);
    mock.script('/v1/chat/completions', { json: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } });
    const p = await chat.probe(ep(), deps);
    assert.deepStrictEqual([p.ok, p.tools, p.ctx, p.server], [true, true, 32768, 'vllm']);
    const probeReq = mock.requests.find(function (r) { return r.path === '/v1/chat/completions'; });
    assert.strictEqual(probeReq.body.stream, false);
    assert.strictEqual(probeReq.body.tools.length, 1);
    mock.script('/v1/chat/completions', { status: 400, json: { error: { message: 'tools are not supported by this model' } } });
    const p2 = await chat.probe(ep(), deps);
    assert.deepStrictEqual([p2.ok, p2.tools], [true, false]);
    mock.script('/v1/chat/completions', { status: 401, json: { error: { message: 'no' } } });
    const p3 = await chat.probe(ep(), deps);
    assert.deepStrictEqual([p3.ok, p3.code], [false, 'auth']);
});

test('openai-chat: listModels reads llama.cpp-style meta.n_ctx / meta.n_ctx_train', async function () {
    mock.always('/v1/models', { json: { object: 'list', data: [
        { id: 'strata', object: 'model', meta: { n_ctx: 16384, n_ctx_train: 131072 } },
        { id: 'llama', object: 'model', owned_by: 'llamacpp', meta: { n_ctx_train: 131072 } },
        { id: 'loading', object: 'model', meta: null }
    ] } });
    const deps = { request: function (o) { return http.request(o); } };
    const models = await chat.listModels(ep(), deps);
    assert.deepStrictEqual(models, [{ id: 'strata', ctx: 16384 }, { id: 'llama', ctx: 131072, owner: 'llamacpp' }, { id: 'loading' }]);
});

test('openai-chat: probe names llama.cpp only when /props carries its build_info', async function () {
    const deps = { request: function (o) { return http.request(o); } };
    mock.always('/v1/models', { json: { object: 'list', data: [{ id: 'qwen3:8b', object: 'model' }] } });
    mock.always('/props', { json: { default_generation_settings: { n_ctx: 8192 }, total_slots: 1 } });
    mock.script('/v1/chat/completions', { json: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } });
    const p = await chat.probe(ep(), deps);
    assert.deepStrictEqual([p.ok, p.ctx, p.server], [true, 8192, null]);
    mock.reset();
    mock.always('/v1/models', { json: { object: 'list', data: [{ id: 'qwen3:8b', object: 'model' }] } });
    mock.always('/props', { json: { default_generation_settings: { n_ctx: 8192 }, total_slots: 1, build_info: 'b6412-a1b2c3d4' } });
    mock.script('/v1/chat/completions', { json: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } });
    const p2 = await chat.probe(ep(), deps);
    assert.deepStrictEqual([p2.ok, p2.ctx, p2.server], [true, 8192, 'llama.cpp']);
});
