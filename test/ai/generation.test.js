'use strict';
// Generation settings per endpoint (thinking level, temperature, top-p, top-k, seed): request mapping per API format,
// store validation, rejected settings, reasoning ("thinking") events without the reasoning text, server defaults
// from /props and Ollama model files, and the engine's throttled onAiThinking phase messages.
const test = require('node:test');
const assert = require('node:assert');
const llm = require('../../ai/llm.js');
const adapters = require('../../ai/adapters/index.js');
const C = require('../../ai/adapters/common.js');
const storeMod = require('../../ai/store.js');
const budget = require('../../ai/budget.js');
const F = require('./engine-fakes.js');
const { createMockLlm, chatSse, anthropicSse, responsesSse, sseText } = require('./mock-llm.js');

const chat = adapters.get('openai-chat'), rs = adapters.get('openai-responses'), an = adapters.get('anthropic');
const T = { system: 'S', items: [{ role: 'user', text: 'Q' }] };
const ALL = { thinking: 'off', temperature: 0.7, topP: 0.9, topK: 20, seed: 42 };

let mock;
test.before(async function () { mock = await createMockLlm({ seed: 5 }); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });

function ep(extra) { return Object.assign({ baseUrl: mock.base, model: 'm', apiKey: null, maxOutputTokens: 512 }, extra || {}); }
function run(adapter, e, events) {
    return llm.stream({ ep: e, adapter: adapter, transcript: T, tools: [], net: {}, retryBaseMs: 0, onEvent: function (ev) { if (events) events.push(ev); } }).promise;
}

// ---- request bodies ------------------------------------------------------------------------------------------------
test('request bodies: settings are sent only when set, per API format', function () {
    const KEYS = ['temperature', 'top_p', 'top_k', 'seed', 'reasoning_effort', 'reasoning', 'think', 'options'];
    const none = function (b) { return KEYS.filter(function (k) { return k in b; }); };
    // nothing set: nothing sent
    assert.deepStrictEqual(none(chat.buildRequest(ep(), T, [], {}).body), []);
    assert.deepStrictEqual(none(rs.buildRequest(ep(), T, [], {}).body), []);
    assert.deepStrictEqual(none(an.buildRequest(ep(), T, [], {}).body), []);
    assert.deepStrictEqual(chat.buildRequest(ep({ ollamaNative: true }), T, [], {}).body.options, { num_predict: 512 });
    // openai-chat (vLLM, llama.cpp, LM Studio, Ollama /v1 ...): off -> reasoning_effort 'none'
    let b = chat.buildRequest(ep(ALL), T, [], {}).body;
    assert.deepStrictEqual([b.temperature, b.top_p, b.top_k, b.seed, b.reasoning_effort], [0.7, 0.9, 20, 42, 'none']);
    b = chat.buildRequest(ep({ thinking: 'high', temperature: 0 }), T, [], {}).body;
    assert.deepStrictEqual([b.reasoning_effort, b.temperature, 'top_p' in b, 'top_k' in b, 'seed' in b], ['high', 0, false, false, false]);
    // Ollama native: options.*, think false / true
    b = chat.buildRequest(ep(Object.assign({ ollamaNative: true, numCtx: 16384 }, ALL)), T, [], {}).body;
    assert.deepStrictEqual(b.options, { num_ctx: 16384, num_predict: 512, temperature: 0.7, top_p: 0.9, top_k: 20, seed: 42 });
    assert.strictEqual(b.think, false);
    assert.ok(!('temperature' in b) && !('reasoning_effort' in b));
    assert.strictEqual(chat.buildRequest(ep({ ollamaNative: true, thinking: 'low' }), T, [], {}).body.think, true);
    // Responses: temperature, top_p, reasoning.effort; never top_k / seed
    b = rs.buildRequest(ep(ALL), T, [], {}).body;
    assert.deepStrictEqual([b.temperature, b.top_p, b.reasoning, 'top_k' in b, 'seed' in b], [0.7, 0.9, { effort: 'none' }, false, false]);
    assert.deepStrictEqual(rs.buildRequest(ep({ thinking: 'medium' }), T, [], {}).body.reasoning, { effort: 'medium' });
    // Anthropic (2026-10-21): never, even when set
    assert.deepStrictEqual(none(an.buildRequest(ep(Object.assign({ thinking: 'high' }, ALL)), T, [], {}).body), []);
    // a bad value in ep (not from the store) is not sent
    assert.deepStrictEqual(none(chat.buildRequest(ep({ thinking: 'max', temperature: '0.5' }), T, [], {}).body), []);
});

// ---- store ---------------------------------------------------------------------------------------------------------
test('store: generation settings are validated, clamped and dropped where the API format has none', function () {
    const v = function (x) { return storeMod.validateEndpoint(Object.assign({ name: 'E', baseUrl: 'http://localhost:1/v1', model: 'm' }, x)); };
    let o = v({});
    assert.deepStrictEqual([o.thinking, o.temperature, o.topP, o.topK, o.seed], [null, null, null, null, null]);
    o = v({ thinking: 'medium', temperature: '0.333', topP: 1.7, topK: 5000, seed: '7' });
    assert.deepStrictEqual([o.thinking, o.temperature, o.topP, o.topK, o.seed], ['medium', 0.33, 1, 1000, 7]);
    o = v({ thinking: '', temperature: '', topP: null, topK: 0, seed: 0 });
    assert.deepStrictEqual([o.thinking, o.temperature, o.topP, o.topK, o.seed], [null, null, null, 1, 0]);
    o = v({ temperature: -1, topK: 12.6 });
    assert.deepStrictEqual([o.temperature, o.topK], [0, 13]);
    assert.throws(function () { v({ thinking: 'max' }); }, /Thinking must be/);
    assert.throws(function () { v({ temperature: 'warm' }); }, /Temperature must be a number/);
    assert.throws(function () { v({ topP: true }); }, /Top-p must be a number/);
    assert.throws(function () { v({ seed: -1 }); }, /Seed must be a whole number/);
    assert.throws(function () { v({ seed: 1.5 }); }, /Seed must be a whole number/);
    assert.throws(function () { v({ seed: 2147483648 }); }, /Seed must be a whole number/);
    o = v(Object.assign({ format: 'anthropic' }, ALL, { thinking: 'high' }));
    assert.deepStrictEqual([o.thinking, o.temperature, o.topP, o.topK, o.seed], [null, null, null, null, null]);
    o = v(Object.assign({ format: 'openai-responses' }, ALL));
    assert.deepStrictEqual([o.thinking, o.temperature, o.topP, o.topK, o.seed], ['off', 0.7, 0.9, null, null]);
});

test('store: publicEndpoint fills the settings of endpoints saved before they existed', async function () {
    const docs = new Map();
    const db = { aiPutDoc: async function (id, type, d) { docs.set(id, Object.assign({ _id: id, type: type }, d)); }, aiGetDoc: async function (id) { return docs.get(id) || null; }, aiDocs: async function () { return Array.from(docs.values()); }, aiDelDoc: async function () { }, getAllConfigSets: async function () { return []; } };
    const st = storeMod.create({ db: db, secrets: { encrypt: function () { return null; }, resolve: function () { return null; } }, netguard: { check: async function () { return { ok: true, network: 'loopback' }; } }, log: function () { } });
    const pub = st.publicEndpoint({ id: 'aiEndpoint:000000000001', name: 'Old', format: 'openai-chat', baseUrl: 'http://x/v1', model: 'm', key: null });
    assert.deepStrictEqual([pub.thinking, pub.temperature, pub.topP, pub.topK, pub.seed], [null, null, null, null, null]);
    const saved = await st.saveEndpoint({ name: 'New', baseUrl: 'http://localhost:9/v1', model: 'm', thinking: 'low', temperature: 1.2, seed: 3 });
    const got = st.publicEndpoint(await st.getEndpoint(saved.id));
    assert.deepStrictEqual([got.thinking, got.temperature, got.topP, got.topK, got.seed], ['low', 1.2, null, null, 3]);
});

// ---- rejected settings ---------------------------------------------------------------------------------------------
test('a 400 naming a setting fails clearly and is not retried without it', async function () {
    mock.always('/v1/chat/completions', { status: 400, json: { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: 'invalid_request_error', param: 'temperature' } } });
    await assert.rejects(run(chat, ep({ temperature: 0.2, topK: 5 })), function (e) {
        assert.strictEqual(e.code, 'badRequest');
        assert.strictEqual(e.setting, 'temperature');
        assert.match(e.message, /rejected the endpoint setting “Temperature” \(temperature\): Unsupported parameter/);
        return true;
    });
    assert.strictEqual(mock.requests.length, 1, 'no silent retry');
    // a 400 about something that was not sent is an ordinary error
    mock.reset();
    mock.always('/v1/chat/completions', { status: 400, json: { error: { message: "Unsupported parameter: 'seed'" } } });
    await assert.rejects(run(chat, ep({ temperature: 0.2 })), function (e) { assert.strictEqual(e.setting, undefined); return true; });
    // Responses: reasoning.effort
    mock.reset();
    mock.always('/v1/responses', { status: 400, json: { error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." } } });
    await assert.rejects(run(rs, ep({ thinking: 'high' })), function (e) { assert.strictEqual(e.setting, 'thinking'); assert.match(e.message, /“Thinking” \(reasoning\)/); return true; });
    // Ollama native: think
    assert.deepStrictEqual(chat.rejectedSetting(400, JSON.stringify({ error: '"qwen2.5" does not support thinking' }), { think: true, options: {} }, { ollamaNative: true }).field, 'thinking');
    assert.strictEqual(chat.rejectedSetting(500, 'temperature invalid', { temperature: 1 }, {}), null);
});

// ---- thinking events -----------------------------------------------------------------------------------------------
test('thinkSplitter: a leading <think> block is counted, never passed on; tags split across chunks', function () {
    const feed = function (chunks) {
        let text = '', n = 0, opened = 0;
        const s = C.thinkSplitter(function (t) { text += t; }, function (k) { if (k === 0) opened++; n += k; });
        chunks.forEach(function (c) { s.push(c); }); s.end();
        return { text: text, n: n, opened: opened };
    };
    assert.deepStrictEqual(feed(['<think>abc</think>\n\nAnswer']), { text: 'Answer', n: 3, opened: 1 });
    assert.deepStrictEqual(feed(['  <th', 'ink>a', 'bc</th', 'ink>', '  ', 'Ans', 'wer']), { text: 'Ans' + 'wer', n: 3, opened: 1 });
    assert.deepStrictEqual(feed(['Plain <think> later', ' text']), { text: 'Plain <think> later text', n: 0, opened: 0 });
    assert.deepStrictEqual(feed(['<b>bold</b>']), { text: '<b>bold</b>', n: 0, opened: 0 });
    assert.deepStrictEqual(feed(['<thi']), { text: '<thi', n: 0, opened: 0 });
    assert.deepStrictEqual(feed(['<think>never closed']), { text: '', n: 12, opened: 1 });
    assert.deepStrictEqual(feed(['\n', 'Hi']), { text: '\nHi', n: 0, opened: 0 });
});

test('openai-chat: reasoning_content and inline <think> become thinking counts; the answer has neither', async function () {
    const SECRET = 'secret chain of thought';
    mock.script('/v1/chat/completions',
        { sse: chatSse({ reasoning: SECRET, text: 'The disk fails.' }), split: true },
        { sse: chatSse({ text: '<think>' + SECRET + '</think>\n\nThe disk fails.', textPieces: 7 }), split: true });
    for (let i = 0; i < 2; i++) {
        const events = [];
        const r = await run(chat, ep(), events);
        assert.strictEqual(r.text, 'The disk fails.');
        assert.ok(!JSON.stringify(events).includes('chain'), 'no reasoning text in events');
        const th = events.filter(function (e) { return e.t === 'thinking'; });
        assert.ok(th.length >= 1);
        assert.strictEqual(th.reduce(function (n, e) { return n + e.n; }, 0), SECRET.length);
        assert.ok(events.findIndex(function (e) { return e.t === 'thinking'; }) < events.findIndex(function (e) { return e.t === 'text'; }));
    }
    // the reasoning field (OpenRouter, Ollama /v1)
    const ev = [];
    const sse = sseText([{ choices: [{ index: 0, delta: { reasoning: 'hmm' } }] }, { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }, 'data: [DONE]\n\n']);
    const p = chat.createParser(function (e) { ev.push(e); }, {});
    p.push(sse); p.end();
    assert.deepStrictEqual(ev.filter(function (e) { return e.t !== 'stop'; }), [{ t: 'thinking', n: 3 }, { t: 'text', d: 'OK' }]);
    // non-streamed answers lose a leading think block too
    const ns = [];
    chat.parseNonStream({ choices: [{ message: { content: '<think>x</think>Done' }, finish_reason: 'stop' }] }, function (e) { ns.push(e); }, {});
    assert.deepStrictEqual(ns.filter(function (e) { return e.t === 'text'; }), [{ t: 'text', d: 'Done' }]);
});

test('ollama native: message.thinking is counted, not shown', function () {
    const ev = [];
    const p = chat.createParser(function (e) { ev.push(e); }, { ollamaNative: true });
    p.push(JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'let me see' }, done: false }) + '\n');
    p.push(JSON.stringify({ message: { role: 'assistant', content: 'Fine.' }, done: false }) + '\n');
    p.push(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
    p.end();
    assert.deepStrictEqual(ev.filter(function (e) { return e.t === 'thinking' || e.t === 'text'; }), [{ t: 'thinking', n: 10 }, { t: 'text', d: 'Fine.' }]);
});

test('responses and anthropic: reasoning items and thinking blocks are counted', async function () {
    const ev = [];
    mock.script('/v1/responses', { sse: responsesSse({ items: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc==' }, { type: 'message', text: 'Done.' }] }), split: true });
    let r = await run(rs, ep(), ev);
    assert.strictEqual(r.text, 'Done.');
    assert.deepStrictEqual(ev.filter(function (e) { return e.t === 'thinking'; }), [{ t: 'thinking', n: 0 }]);
    const ev2 = [];
    const p = rs.createParser(function (e) { ev2.push(e); });
    p.push(sseText([{ type: 'response.reasoning_summary_text.delta', delta: 'abcd' }, { type: 'response.reasoning_text.delta', delta: 'ef' }]));
    assert.deepStrictEqual(ev2, [{ t: 'thinking', n: 4 }, { t: 'thinking', n: 2 }]);
    const ev3 = [];
    mock.script('/v1/messages', { sse: anthropicSse({ blocks: [{ type: 'thinking', thinking: 'deep thoughts', signature: 'sig' }, { type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'Answer.' }] }), split: true });
    r = await run(an, ep(), ev3);
    assert.strictEqual(r.text, 'Answer.');
    assert.ok(!JSON.stringify(ev3.filter(function (e) { return e.t !== 'raw'; })).includes('deep'), 'no thinking text outside the raw replay blocks');
    const th = ev3.filter(function (e) { return e.t === 'thinking'; });
    assert.strictEqual(th.reduce(function (n, e) { return n + e.n; }, 0), 'deep thoughts'.length);
    assert.strictEqual(th.length, 4, 'two block starts and two deltas');
});

// ---- server defaults -----------------------------------------------------------------------------------------------
test('server defaults: /props (llama.cpp, Strata) and Ollama model files', function () {
    assert.deepStrictEqual(C.propsDefaults({ default_generation_settings: { n_ctx: 8192, params: { temperature: 1, top_p: 0.95, top_k: 20, seed: 4294967295, n_predict: -1 } } }),
        { temperature: 1, topP: 0.95, topK: 20, seed: -1, maxTokens: -1 });
    assert.deepStrictEqual(C.propsDefaults({ default_generation_settings: { temperature: 0.8, top_k: 40, seed: 7, n_predict: 512 } }),
        { temperature: 0.8, topP: null, topK: 40, seed: 7, maxTokens: 512 });
    assert.strictEqual(C.propsDefaults({ default_generation_settings: { n_ctx: 1 } }), null);
    assert.strictEqual(C.propsDefaults(null), null);
    assert.strictEqual(C.propsEffort({ default_generation_settings: { params: { reasoning_effort: 'high' } } }), 'high');
    assert.strictEqual(C.propsEffort({ default_generation_settings: { params: { chat_template_kwargs: { reasoning_effort: 'none' } } } }), 'off');
    assert.strictEqual(C.propsEffort({}), null);
    const o = adapters.ollama.modelfileDefaults('stop "<|eot|>"\ntemperature 0.6\ntop_p 0.95\nPARAMETER top_k 20\nnum_ctx 8192\nseed -1\nnum_predict 1024');
    assert.deepStrictEqual(o, { temperature: 0.6, topP: 0.95, topK: 20, seed: -1, maxTokens: 1024 });
    assert.deepStrictEqual(adapters.ollama.modelfileDefaults(undefined), adapters.ollama.OLLAMA_DEFAULTS);
});

test('budget.applied: the numbers a conversation uses (shared by the engine and Test connection)', function () {
    assert.deepStrictEqual(budget.applied({}, null, {}), { ctx: 8192, maxOutput: 2048, timeoutSec: 120, ollama: false, ollamaNative: false, ctxSource: 'assumed', notes: [] });
    assert.strictEqual(budget.applied({}, { ctx: 262144 }, { maxOutputTokens: 4096, timeoutSec: 60 }).maxOutput, 4096);
    assert.strictEqual(budget.applied({ timeoutSec: 300 }, null, { timeoutSec: 60 }).timeoutSec, 300);
    const o = budget.applied({ format: 'openai-chat' }, { server: 'ollama 0.12.6', ctx: 131072 }, {});
    assert.deepStrictEqual([o.ctx, o.maxOutput, o.ctxSource, o.ollamaNative, o.notes.length], [4096, 2048, 'ollamaDefault', false, 1]);
    const n = budget.applied({ format: 'openai-chat', numCtx: 32768 }, { server: 'ollama' }, {});
    assert.deepStrictEqual([n.ctx, n.ctxSource, n.ollamaNative], [32768, 'ollama', true]);
});

// ---- engine: onAiThinking ------------------------------------------------------------------------------------------
test('engine: thinking phases reach the browser as throttled counts, never as text, and stop once the answer starts', async function () {
    const SECRET = 'PRIVATE-REASONING-';
    const frames = [];
    for (let i = 0; i < 12; i++) frames.push({ id: 'x', choices: [{ index: 0, delta: { reasoning_content: SECRET + i }, finish_reason: null }] });
    frames.push({ id: 'x', choices: [{ index: 0, delta: { content: 'The answer.' }, finish_reason: null }] });
    frames.push({ id: 'x', choices: [{ index: 0, delta: { reasoning_content: 'late' }, finish_reason: null }] });
    frames.push({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    mock.always('/v1/chat/completions', {
        handler: function (req, res) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            let i = 0;
            const next = function () {
                if (res.destroyed) return;
                if (i < frames.length) { res.write(sseText([frames[i++]])); setTimeout(next, 100); return; }
                res.end('data: [DONE]\n\n');
            };
            next();
        }
    });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'Why?' });
    const done = t.last('onAiDone');
    assert.ok(done, t.ws.sent.map(function (m) { return m.method; }).join(','));
    assert.strictEqual(done.text.trim(), 'The answer.');
    const th = t.of('onAiThinking');
    assert.ok(th.length >= 2 && th.length <= 5, 'throttled to about two a second: ' + th.length);
    assert.ok(th.every(function (m) { return m.turn === 1 && m.round === 1 && typeof m.chars === 'number'; }));
    assert.strictEqual(th[0].chars, (SECRET + '0').length, 'the first one at once');
    for (let i = 1; i < th.length; i++) assert.ok(th[i].chars > th[i - 1].chars);
    assert.ok(t.ws.sent.every(function (m) { return JSON.stringify(m).indexOf('PRIVATE-REASONING') < 0 && JSON.stringify(m).indexOf('late') < 0; }), 'no reasoning text reaches the browser');
    const iDelta = t.ws.sent.findIndex(function (m) { return m.method === 'onAiDelta'; });
    assert.ok(t.ws.sent.slice(iDelta).every(function (m) { return m.method !== 'onAiThinking'; }), 'nothing after the answer started');
    t.close();
});

test('engine: endpoint generation settings are sent; a rejected one ends the turn with a message naming it', async function () {
    mock.script('/v1/chat/completions', { sse: chatSse({ text: 'Fine.' }) });
    let t = F.setup({ mock: mock, ep: { thinking: 'low', temperature: 0.4, topK: 30 } });
    await t.start('ask', { text: 'Q?' });
    assert.ok(t.last('onAiDone'));
    const b = mock.requests[mock.requests.length - 1].body;
    assert.deepStrictEqual([b.reasoning_effort, b.temperature, b.top_k, 'top_p' in b, 'seed' in b], ['low', 0.4, 30, false, false]);
    t.close();
    mock.reset();
    mock.always('/v1/chat/completions', { status: 400, json: { error: { message: 'top_k is not supported', type: 'invalid_request_error' } } });
    t = F.setup({ mock: mock, ep: { topK: 30 } });
    await t.start('ask', { text: 'Q?' });
    const err = t.last('onAiError');
    assert.strictEqual(err.code, 'badResponse');
    assert.match(err.message, /“Top-k” \(top_k\)/);
    assert.strictEqual(mock.requests.filter(function (r) { return r.path === '/v1/chat/completions'; }).length, 1);
    t.close();
});
