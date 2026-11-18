'use strict';
const test = require('node:test');
const assert = require('node:assert');
const llm = require('../../ai/llm.js');
const http = require('../../ai/http.js');
const adapters = require('../../ai/adapters/index.js');
const { createMockLlm, ollamaNd } = require('./mock-llm.js');

const chat = adapters.get('openai-chat');
const ollama = adapters.ollama;
const TOOLS = [{ name: 'get_events', description: 'List events', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } }];

let mock;
test.before(async function () { mock = await createMockLlm(); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });

const deps = { request: function (o) { return http.request(o); } };
function ep(extra) { return Object.assign({ baseUrl: mock.base + '/', model: 'llama3.1:8b', apiKey: null, maxOutputTokens: 512, numCtx: 16384, ollamaNative: true }, extra || {}); }
function run(e, transcript, tools, opts) { return llm.stream({ ep: e, adapter: chat, transcript: transcript, tools: tools, opts: opts, net: {}, retryBaseMs: 0 }).promise; }

test('ollama native: /api/chat NDJSON tool loop with object arguments and synthesized ids', async function () {
    mock.script('/api/chat',
        { ndjson: ollamaNd({ text: 'Checking… ', calls: [{ name: 'get_events', arguments: { limit: 4 } }, { name: 'get_events', arguments: { limit: 9 } }] }), split: true },
        { ndjson: ollamaNd({ text: 'All good ✓' }), split: true, eol: '\r\n' });
    const transcript = { system: 'sys', items: [{ role: 'user', text: 'hi' }] };
    const r1 = await run(ep(), transcript, TOOLS, { toolChoice: 'auto' });
    assert.strictEqual(r1.text, 'Checking… ');
    assert.strictEqual(r1.stopReason, 'tools');
    assert.deepStrictEqual(r1.calls.map(function (c) { return c.args; }), [{ limit: 4 }, { limit: 9 }]);
    assert.ok(r1.calls[0].id && r1.calls[1].id && r1.calls[0].id !== r1.calls[1].id);
    assert.deepStrictEqual(r1.usage, { in: 40, out: 8 });
    const b1 = mock.requests[0].body;
    assert.strictEqual(mock.requests[0].path, '/api/chat');
    assert.deepStrictEqual(b1.options, { num_ctx: 16384, num_predict: 512 });
    assert.strictEqual(b1.stream, true);
    assert.strictEqual(b1.tools[0].function.name, 'get_events');
    assert.deepStrictEqual(b1.messages[0], { role: 'system', content: 'sys' });

    transcript.items.push({ role: 'assistant', text: r1.text, calls: r1.calls, raw: r1.raw });
    transcript.items.push({ role: 'tool', results: r1.calls.map(function (c, i) { return { callId: c.id, name: c.name, content: 'result ' + i, isError: false }; }) });
    const r2 = await run(ep(), transcript, TOOLS, { toolChoice: 'none' });
    assert.strictEqual(r2.text, 'All good ✓');
    assert.strictEqual(r2.stopReason, 'end');
    const b2 = mock.requests[1].body;
    assert.deepStrictEqual(b2.messages[2], { role: 'assistant', content: 'Checking… ', tool_calls: [{ function: { name: 'get_events', arguments: { limit: 4 } } }, { function: { name: 'get_events', arguments: { limit: 9 } } }] });
    assert.deepStrictEqual(b2.messages[3], { role: 'tool', tool_name: 'get_events', content: 'result 0' });
    assert.strictEqual(b2.tools, undefined, "toolChoice 'none' is expressed by not offering tools");
});

test('ollama native: in-stream error and done_reason length', async function () {
    mock.script('/api/chat', { ndjson: [{ error: 'model runner has unexpectedly stopped' }] }, { ndjson: ollamaNd({ text: 'cut', done_reason: 'length' }) });
    await assert.rejects(run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, [], {}), { code: 'server' });
    const r = await run(ep(), { system: '', items: [{ role: 'user', text: 'x' }] }, [], {});
    assert.strictEqual(r.stopReason, 'length');
});

test('ollama helpers: isOllama, show (capabilities + context length), tags', async function () {
    mock.always('/api/version', { json: { version: '0.12.3' } });
    mock.always('/api/show', { json: { capabilities: ['completion', 'tools'], parameters: 'stop "<|eot|>"\nnum_ctx 8192', details: { family: 'llama' }, model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 } } });
    mock.always('/api/tags', { json: { models: [{ name: 'llama3.1:8b', size: 4900000000, details: { family: 'llama', parameter_size: '8.0B' } }] } });
    assert.strictEqual(await ollama.isOllama(ep(), deps), '0.12.3');
    const s = await ollama.show(ep(), deps);
    assert.deepStrictEqual(s, {
        capabilities: ['completion', 'tools'], tools: true, ctx: 131072, numCtx: 8192, family: 'llama',
        thinking: { supported: false, levels: [], serverDefault: null, verified: false, detail: 'reported by Ollama' },
        genDefaults: { temperature: 0.8, topP: 0.9, topK: 40, seed: -1, maxTokens: -1 }
    });
    assert.deepStrictEqual(mock.requests.find(function (r) { return r.path === '/api/show'; }).body, { model: 'llama3.1:8b' });
    assert.deepStrictEqual(await ollama.tags(ep(), deps), [{ id: 'llama3.1:8b', size: 4900000000, family: 'llama', parameterSize: '8.0B' }]);
});

test('ollama: probe through openai-chat detects Ollama; a non-Ollama server returns null from isOllama', async function () {
    mock.always('/api/version', { json: { version: '0.12.3' } });
    mock.always('/api/show', { json: { capabilities: ['completion'], model_info: { 'general.architecture': 'gemma', 'gemma.context_length': 8192 } } });
    mock.always('/v1/models', { json: { data: [{ id: 'llama3.1:8b' }] } });
    const p = await chat.probe(ep({ ollamaNative: false, numCtx: null }), deps);
    assert.deepStrictEqual([p.ok, p.tools, p.ctx, p.server], [true, false, 8192, 'ollama 0.12.3']);
    assert.match(p.detail, /default context/);
    mock.reset();
    mock.always('/api/show', { status: 404, json: { error: "model 'nope' not found" } });
    mock.always('/api/version', { json: { version: '0.12.3' } });
    const p2 = await chat.probe(ep({ model: 'nope' }), deps);
    assert.deepStrictEqual([p2.ok, p2.code], [false, 'model']);
    mock.reset();
    assert.strictEqual(await ollama.isOllama(ep(), deps), null);
});
