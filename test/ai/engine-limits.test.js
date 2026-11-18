'use strict';
// Engine limits and abort paths: round limit, per-round call cap, invalid args, revoked rights, Stop, ws close,
// TTL, tools-unsupported fallback, context overflow.
const test = require('node:test');
const assert = require('node:assert');
const F = require('./engine-fakes.js');
const { createMockLlm, chatSse } = require('./mock-llm.js');

const CHAT = '/v1/chat/completions';

let mock;
test.before(async function () { mock = await createMockLlm({ seed: 11 }); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });
function chatReqs() { return mock.requests.filter(function (r) { return r.path === CHAT; }); }
function methods(t) { return t.ws.sent.map(function (m) { return m.method + (m.code ? ':' + m.code : ''); }).join(','); }

test('round limit reached -> tool_choice none; a model that still calls tools gets error results and one more round', async function () {
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'event_facets', args: {} }] }) },
        { sse: chatSse({ calls: [{ id: 'c2', name: 'get_events', args: {} }] }) },     // ignores tool_choice none
        { sse: chatSse({ text: 'Final.' }) });
    const t = F.setup({ mock: mock, settings: { limits: { maxRounds: 1 } } });
    await t.start('ask', { text: 'q' });
    assert.ok(t.last('onAiDone'), methods(t));
    const r = chatReqs();
    assert.strictEqual(r.length, 3);
    assert.strictEqual(r[0].body.tool_choice, undefined);
    assert.strictEqual(r[1].body.tool_choice, 'none');
    assert.strictEqual(r[2].body.tool_choice, 'none');
    assert.ok(Array.isArray(r[1].body.tools), 'tools are never dropped mid-conversation');
    assert.ok(/Tool use has ended/.test(r[2].bodyText));
    assert.strictEqual(t.of('onAiStep').filter(function (s) { return s.status === 'done'; }).length, 1, 'the ignored call was not executed');
    t.close();
});

test('more than 4 calls in one round: the extra ones get an error result; invalid args -> error result, never a crash', async function () {
    mock.script(CHAT,
        { sse: chatSse({ calls: [
            { id: 'a', name: 'get_events', args: { limit: 500 } },
            { id: 'b', name: 'get_event', args: { ref: 'nope' } },
            { id: 'c', name: 'get_events', argsText: '{"limit": 5,' },
            { id: 'd', name: 'no_such_tool', args: {} },
            { id: 'e', name: 'event_facets', args: {} }
        ] }) },
        { sse: chatSse({ text: 'ok' }) });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'q' });
    assert.ok(t.last('onAiDone'), methods(t));
    const done = t.of('onAiStep').filter(function (s) { return s.status !== 'running'; });
    assert.deepStrictEqual(done.map(function (s) { return s.status; }), ['error', 'error', 'error', 'error']);
    const tools = chatReqs()[1].body.messages.filter(function (m) { return m.role === 'tool'; });
    assert.strictEqual(tools.length, 5);
    assert.ok(/must be at most 50/.test(tools[0].content));
    assert.ok(/invalid format/.test(tools[1].content));
    assert.ok(/not valid JSON/.test(tools[2].content));
    assert.ok(/Unknown or unavailable tool/.test(tools[3].content));
    assert.ok(/At most 4 tool calls/.test(tools[4].content));
    t.close();
});

test('rights revoked mid-turn -> denied, session closed, audit says error', async function () {
    mock.script(CHAT, { sse: chatSse({ calls: [{ id: 'c1', name: 'event_facets', args: {} }] }) }, { sse: chatSse({ text: 'never' }) });
    const t = F.setup({ mock: mock });
    t.plugin.reauthOk = false;
    await t.start('ask', { text: 'q' });
    const err = t.last('onAiError');
    assert.ok(err, methods(t));
    assert.strictEqual(err.code, 'denied');
    assert.strictEqual(t.ai.sessions.size(), 0);
    assert.strictEqual(chatReqs().length, 1, 'no further model call');
    assert.strictEqual(t.of('onAiStep').length, 0, 'the tool never ran');
    assert.strictEqual(t.store.audits[0].result, 'error');
    assert.strictEqual(t.store.audits[0].error, 'denied');
    t.close();
});

test('Stop mid-stream aborts the model request (the server sees the client close)', async function () {
    mock.script(CHAT, { sse: chatSse({ text: 'partial answer that never ends' }), hang: true });
    const t = F.setup({ mock: mock });
    const p = t.start('ask', { text: 'q' });
    await F.waitFor(t.ws, 'onAiDelta');
    const S = t.ai.sessions.forUser('user/d/alice')[0];
    assert.ok(S.busy);
    await t.ai.handle(t.cmd('aiStop', { convId: S.convId }), t.myparent, {});
    await p;
    const err = t.last('onAiError');
    assert.strictEqual(err.code, 'aborted');
    assert.ok(await mock.waitForClose(chatReqs()[0], 2000), 'client closed the connection');
    assert.strictEqual(t.store.audits[0].result, 'cancelled');
    assert.ok(!t.last('onAiDone'));
    // the session stays usable after a Stop
    assert.strictEqual(t.ai.sessions.size(), 1);
    assert.strictEqual(S.busy, false);
    assert.strictEqual(S.transcript.items.length, 0, 'the cancelled turn was rolled back');
    // Stop from another connection of the same user is ignored
    t.close();
});

test('aiStop / aiClose only work for the owning user on the same connection', async function () {
    mock.script(CHAT, { sse: chatSse({ text: 'x' }), hang: true });
    const t = F.setup({ mock: mock });
    const p = t.start('ask', { text: 'q' });
    await F.waitFor(t.ws, 'onAiDelta');
    const S = t.ai.sessions.forUser('user/d/alice')[0];
    const other = F.makeMyparent(F.makeWs());
    await t.ai.handle(t.cmd('aiStop', { convId: S.convId }), other, {});
    await t.ai.handle(t.cmd('aiClose', { convId: S.convId }), F.makeMyparent(t.ws, { _id: 'user/d/mallory', name: 'm' }), {});
    assert.ok(S.busy && !S.closed);
    await t.ai.handle(t.cmd('aiClose', { convId: S.convId }), t.myparent, {});
    await p;
    assert.ok(S.closed);
    assert.strictEqual(t.ai.sessions.size(), 0);
    t.close();
});

test('ws close closes the sessions of that connection and aborts the in-flight request', async function () {
    mock.script(CHAT, { sse: chatSse({ text: 'x' }), hang: true });
    const t = F.setup({ mock: mock });
    const p = t.start('ask', { text: 'q' });
    await F.waitFor(t.ws, 'onAiDelta');
    const n = t.ws.sent.length;
    t.ws.close();
    await p;
    assert.strictEqual(t.ai.sessions.size(), 0);
    assert.ok(await mock.waitForClose(chatReqs()[0], 2000));
    assert.strictEqual(t.ws.sent.length, n, 'nothing sent to a closed connection');
    assert.strictEqual(t.store.audits[0].result, 'cancelled');
    t.close();
});

test('idle sessions expire after the TTL', async function () {
    let skew = 0;
    mock.script(CHAT, { sse: chatSse({ text: 'answer' }) });
    const t = F.setup({ mock: mock, aiOpts: { now: function () { return Date.now() + skew; } } });
    await t.start('ask', { text: 'q' });
    const convId = t.last('onAiDone').convId;
    skew = 29 * 60000; t.ai.sessions.sweep();
    assert.strictEqual(t.ai.sessions.size(), 1);
    skew = 31 * 60000; t.ai.sessions.sweep();
    assert.strictEqual(t.ai.sessions.size(), 0);
    const e = t.last('onAiError');
    assert.strictEqual(e.code, 'aborted');
    assert.strictEqual(e.convId, convId);
    await t.send(convId, 'more?');
    assert.strictEqual(t.last('onAiError').code, 'invalid');
    t.close();
});

test('automatic tool mode: "does not support tools" -> summary digest once, caps stored, next session starts in summary mode', async function () {
    mock.script(CHAT,
        { status: 400, json: { error: { message: 'registry.ollama.ai/library/gemma does not support tools' } } },
        { sse: chatSse({ text: 'From the digest: spooler crashes.' }) });
    const t = F.setup({ mock: mock, ep: { toolMode: 'auto' } });
    await t.start('diagnose', { window: '24h' });
    const done = t.last('onAiDone');
    assert.ok(done, methods(t));
    const r = chatReqs();
    assert.strictEqual(r.length, 2);
    assert.ok(Array.isArray(r[0].body.tools));
    assert.strictEqual(r[1].body.tools, undefined, 'no tools after the fallback');
    const user = r[1].body.messages.filter(function (m) { return m.role === 'user'; }).pop().content;
    assert.ok(/label=digest/.test(user), 'digest appended');
    assert.ok(/No tools are available/.test(r[1].body.messages[0].content), 'system prompt rebuilt without tools');
    const caps = t.store.caps.filter(function (c) { return c.caps.tools === false; });
    assert.strictEqual(caps.length, 1);
    F.assertNoForbidden(assert, 'digest request', r[1].bodyText);

    mock.reset();
    mock.script(CHAT, { sse: chatSse({ text: 'Summary again.' }) });
    await t.start('ask', { text: 'again' }, { reqId: 'r2' });
    assert.strictEqual(t.last('onAiStarted').toolMode, 'summary');
    assert.strictEqual(chatReqs().length, 1);
    assert.strictEqual(chatReqs()[0].body.tools, undefined);
    t.close();
});

test('explicit tool mode: "does not support tools" is reported, not hidden', async function () {
    mock.script(CHAT, { status: 400, json: { error: { message: 'model does not support tools' } } });
    const t = F.setup({ mock: mock, ep: { toolMode: 'tools' } });
    await t.start('ask', { text: 'q' });
    const e = t.last('onAiError');
    assert.strictEqual(e.code, 'model');
    assert.strictEqual(chatReqs().length, 1);
    t.close();
});

test('Ask context overflow -> new segment with a server-built recap', async function () {
    const longAnswer = 'The spooler crashes repeatedly. '.repeat(120);
    mock.script(CHAT, { sse: chatSse({ text: longAnswer, usage: { prompt_tokens: 2500, completion_tokens: 1300 } }) }, { sse: chatSse({ text: 'Second answer.' }) });
    const t = F.setup({ mock: mock, ep: { contextTokens: 4000, maxOutputTokens: 1024 } });
    await t.start('ask', { text: 'first question' });
    const d1 = t.last('onAiDone');
    assert.ok(d1, methods(t));
    assert.strictEqual(d1.segment, 0);
    await t.send(d1.convId, 'second question');
    const d2 = t.last('onAiDone');
    assert.strictEqual(d2.turn, 2);
    assert.strictEqual(d2.segment, 1);
    const b = chatReqs()[1].body;
    const users = b.messages.filter(function (m) { return m.role === 'user'; });
    assert.strictEqual(users.length, 1, 'old messages dropped');
    assert.ok(/label=recap/.test(users[0].content) && /first question/.test(users[0].content) && /second question/.test(users[0].content));
    assert.ok(!b.messages.some(function (m) { return m.role === 'assistant'; }));
    t.close();
});

test('contextFull from the server in Ask -> one retry in a new segment', async function () {
    mock.script(CHAT, { sse: chatSse({ text: 'first' }) },
        { status: 400, json: { error: { message: 'This model\'s maximum context length is 8192 tokens', code: 'context_length_exceeded' } } },
        { sse: chatSse({ text: 'second' }) });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'q1' });
    const convId = t.last('onAiDone').convId;
    await t.send(convId, 'q2');
    const d = t.last('onAiDone');
    assert.strictEqual(d.turn, 2);
    assert.strictEqual(d.segment, 1);
    assert.strictEqual(chatReqs().length, 3);
    t.close();
});

test('maxSentKB reached -> tool use stops for the turn', async function () {
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { limit: 50 } }] }) },
        { sse: chatSse({ text: 'done' }) });
    const t = F.setup({ mock: mock, settings: { limits: { maxSentKB: 1 } } });
    await t.start('ask', { text: 'q' });
    assert.ok(t.last('onAiDone'));
    assert.strictEqual(chatReqs()[1].body.tool_choice, 'none');
    t.close();
});

test('a model error is reported with its code; the turn is rolled back', async function () {
    mock.script(CHAT, { status: 401, json: { error: { message: 'bad key' } } });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'q' });
    const e = t.last('onAiError');
    assert.strictEqual(e.code, 'auth');
    assert.strictEqual(e.reqId, 'r1');
    assert.ok(e.convId);
    assert.strictEqual(t.store.audits[0].result, 'error');
    assert.strictEqual(t.store.audits[0].error, 'auth');
    t.close();
});
