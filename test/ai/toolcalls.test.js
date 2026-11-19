'use strict';
// Tool calls a model writes as text (ai/toolcalls.js) and the end of tool use in a turn (ai/engine.js): a closing
// round gets an instruction, raw tool-call markup never reaches the answer, the notes or the stream.
const test = require('node:test');
const assert = require('node:assert');
const F = require('./engine-fakes.js');
const T = require('../../ai/toolcalls.js');
const { createMockLlm, chatSse } = require('./mock-llm.js');

const CHAT = '/v1/chat/completions';
const DEFS = [
    { name: 'lookup_event_id', parameters: { type: 'object', properties: { provider: { type: 'string' }, id: { type: ['integer', 'string'] }, ref: { type: 'string' } } } },
    { name: 'get_events', parameters: { type: 'object', properties: { limit: { type: 'integer' }, levels: { type: 'array' }, text: { type: 'string' } } } }
];
// what Strata passed through as content (Qwen3 XML tool calls)
const QWEN = 'Let me verify meanings of key event IDs.\n<tool_call>\n<function=lookup_event_id>\n<parameter=id>\n1023\n</parameter>\n<parameter=provider>\nMicrosoft-Windows-Perflib\n</parameter>\n</function>\n</tool_call>\n' +
    '<tool_call>\n<function=lookup_event_id>\n<parameter=id>\n7031\n</parameter>\n<parameter=provider>\nService Control Manager\n</parameter>\n</function>\n</tool_call>';

let mock;
test.before(async function () { mock = await createMockLlm({ seed: 23 }); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });
function chatReqs() { return mock.requests.filter(function (r) { return r.path === CHAT; }); }
function methods(t) { return t.ws.sent.map(function (m) { return m.method + (m.code ? ':' + m.code : ''); }).join(','); }
function lastUser(req) { const m = req.body.messages; return m[m.length - 1].role === 'user' ? m[m.length - 1].content : null; }
function refsIn(text) { const s = new Set(); const re = /"ref":"(E\d+)"/g; let m; while ((m = re.exec(text))) s.add(m[1]); return Array.from(s); }
function streamed(t) { return t.of('onAiDelta').map(function (d) { return d.text; }).join(''); }
const MARKUP = /<tool_call|<function=|<parameter=|<\/function>|\[TOOL_CALLS\]|<invoke|<\|tool_call/;

test('parse: Qwen/Hermes XML and JSON, <|tool_call|>, Anthropic-style XML, Mistral, Llama; types from the schema', function () {
    let r = T.parse(QWEN, DEFS);
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.text, 'Let me verify meanings of key event IDs.');
    assert.deepStrictEqual(r.calls.map(function (c) { return [c.name, c.args]; }), [['lookup_event_id', { id: 1023, provider: 'Microsoft-Windows-Perflib' }], ['lookup_event_id', { id: 7031, provider: 'Service Control Manager' }]]);
    assert.strictEqual(r.calls[0].argsText, '{"id":1023,"provider":"Microsoft-Windows-Perflib"}');
    r = T.parse('Checking.\n<tool_call>\n{"name": "get_events", "arguments": {"limit": "5", "text": "disk"}}\n</tool_call>', DEFS);
    assert.deepStrictEqual([r.text, r.calls[0].name, r.calls[0].args], ['Checking.', 'get_events', { limit: 5, text: 'disk' }]);
    r = T.parse('<|tool_call|>[{"name":"get_events","arguments":{"limit":3}}]', DEFS);
    assert.deepStrictEqual([r.text, r.calls[0].args], ['', { limit: 3 }]);
    r = T.parse('Ok <function_calls>\n<invoke name="get_events">\n<parameter name="limit">7</parameter>\n<parameter name="levels">[1,2]</parameter>\n</invoke>\n</function_calls> done', DEFS);
    assert.deepStrictEqual([r.text, r.calls[0].args], ['Ok done', { limit: 7, levels: [1, 2] }]);
    r = T.parse('[TOOL_CALLS][{"name":"get_events","arguments":{"limit":2}}]', DEFS);
    assert.deepStrictEqual(r.calls[0].args, { limit: 2 });
    r = T.parse('[TOOL_CALLS]get_events[ARGS]{"limit":4}', DEFS);
    assert.deepStrictEqual([r.text, r.calls[0].name, r.calls[0].args], ['', 'get_events', { limit: 4 }]);
    r = T.parse('<|python_tag|>{"name": "get_events", "parameters": {"limit": 9}}', DEFS);
    assert.deepStrictEqual(r.calls[0].args, { limit: 9 });
    // a call that was cut off is removed but never run with half its arguments
    r = T.parse('Answer text.\n<tool_call>\n<function=lookup_event_id>\n<parameter=id>\n10', DEFS);
    assert.deepStrictEqual([r.text, r.calls.length, r.found], ['Answer text.', 0, true]);
    // no markup: unchanged
    r = T.parse('Plain answer: a < b and [E1].', DEFS);
    assert.deepStrictEqual([r.text, r.calls.length, r.found], ['Plain answer: a < b and [E1].', 0, false]);
    assert.strictEqual(T.strip('Summary [E1].\n\n' + QWEN.split('\n').slice(1).join('\n')), 'Summary [E1].');
});

test('a round that may still use tools: calls written as text are run like structured calls', async function () {
    mock.script(CHAT,
        { sse: chatSse({ text: 'I will look at the event counts first.\n<tool_call>\n<function=event_facets>\n</function>\n</tool_call>' }) },
        { sse: chatSse({ text: 'Done: the spooler crashes.' }) });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'q' });
    const done = t.last('onAiDone');
    assert.ok(done, methods(t));
    const st = t.of('onAiStep').filter(function (s) { return s.status !== 'running'; });
    assert.deepStrictEqual(st.map(function (s) { return s.tool + ':' + s.status; }), ['event_facets:done'], 'the text call ran');
    const r = chatReqs();
    assert.strictEqual(r.length, 2);
    const asst = r[1].body.messages.filter(function (m) { return m.role === 'assistant'; })[0];
    assert.strictEqual(asst.content, 'I will look at the event counts first.', 'the markup is not replayed as text');
    assert.strictEqual(asst.tool_calls[0].function.name, 'event_facets');
    const tool = r[1].body.messages.filter(function (m) { return m.role === 'tool'; })[0];
    assert.strictEqual(tool.tool_call_id, asst.tool_calls[0].id);
    assert.strictEqual(done.text, 'Done: the spooler crashes.');
    const notes = t.of('onAiNote');
    assert.deepStrictEqual(notes.map(function (n) { return n.text; }), ['I will look at the event counts first.']);
    assert.ok(!MARKUP.test(streamed(t)), 'no markup streamed: ' + streamed(t));
    assert.ok(t.logs.some(function (l) { return /wrote its tool calls as text/.test(l); }));
    t.close();
});

test('invalid arguments in a text call are reported to the model like those of a structured call', async function () {
    mock.script(CHAT,
        { sse: chatSse({ text: '<tool_call>\n<function=get_events>\n<parameter=limit>\n500\n</parameter>\n</function>\n</tool_call>' }) },
        { sse: chatSse({ text: 'ok' }) });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'q' });
    assert.ok(t.last('onAiDone'), methods(t));
    const tool = chatReqs()[1].body.messages.filter(function (m) { return m.role === 'tool'; })[0];
    assert.ok(/must be at most 50/.test(tool.content), tool.content);
    t.close();
});

test('step limit: the closing call gets an instruction; text tool calls instead of an answer -> once more, firmly -> a proper diagnosis', async function () {
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { limit: 5 } }] }) },
        { sse: chatSse({ text: QWEN }) },
        function (rec) {
            const r = refsIn(rec.bodyText);
            const diag = { v: 1, summary: 'Spooler crashes [' + r[0] + ']', lanes: [], hypotheses: [{ id: 'h1', title: 'Spooler driver', status: 'likely', confidence: 0.7, why: 'see [' + r[0] + ']', evidence: [r[0]], against: [], confirm: 'Check' }], nextSteps: [], evidence: [], unexplained: [] };
            return { sse: chatSse({ text: 'The print spooler keeps crashing [' + r[0] + '].\n<diagnosis>' + JSON.stringify(diag) + '</diagnosis>' }) };
        });
    const t = F.setup({ mock: mock, settings: { limits: { maxRounds: 1 } } });
    await t.start('diagnose', { window: '24h' });
    const done = t.last('onAiDone');
    assert.ok(done, methods(t));
    const r = chatReqs();
    assert.strictEqual(r.length, 3);
    assert.match(lastUser(r[0]), /^Diagnose this device/, 'no instruction while tools may be used');
    assert.match(lastUser(r[1]), /^No more lookups are available for this question\. Write your final answer now .* End with the <diagnosis> block as instructed\.$/);
    assert.deepStrictEqual([r[1].body.tool_choice, Array.isArray(r[1].body.tools)], ['none', true]);
    assert.match(lastUser(r[2]), /^Tool calls are not available any more and will not be run\. Do not write <tool_call>/);
    assert.ok(!/<tool_call>/.test(r[2].bodyText.replace(/Do not write <tool_call>/g, '')), 'the round with text tool calls is not replayed');
    assert.ok(done.structured && done.structured.hypotheses.length === 1, 'diagnosis card');
    assert.ok(!MARKUP.test(done.text) && /keeps crashing/.test(done.text));
    assert.strictEqual(done.usage.steps, 1, 'one step ran lookups');
    // the browser: a limit entry in the steps, the preamble as a note, never the markup
    const notes = t.of('onAiNote');
    assert.deepStrictEqual(notes.map(function (n) { return [n.kind || null, n.text]; }),
        [['limit', 'Step limit reached: writing the answer with what was found so far.'], [null, 'Let me verify meanings of key event IDs.']]);
    assert.ok(!MARKUP.test(streamed(t)), 'no markup streamed');
    // the instructions are not kept in the transcript
    const audit = t.store.audits[0];
    assert.ok(audit.transcript && audit.transcript.indexOf('No more lookups are available') < 0);
    t.close();
});

test('step limit: a model that keeps writing tool calls -> a clear error, never the markup; the turn is rolled back', async function () {
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { limit: 5 } }] }) },
        { sse: chatSse({ text: QWEN, textPieces: 60 }) },   // markup split across many chunks
        { sse: chatSse({ text: 'Let me check one more thing.\n<tool_call>\n{"name": "get_events", "arguments": {"limit": 5}}\n</tool_call>' }) });
    const t = F.setup({ mock: mock, settings: { limits: { maxRounds: 1 } } });
    await t.start('diagnose', { window: '24h' });
    const err = t.last('onAiError');
    assert.ok(err, methods(t));
    assert.strictEqual(err.code, 'stepLimit');
    assert.strictEqual(err.message, 'The model kept asking for more data after the step limit. Try a shorter time window, or have an administrator raise Max steps per answer.');
    assert.strictEqual(chatReqs().length, 3, 'one firm retry only');
    assert.ok(!t.last('onAiDone'));
    assert.ok(!MARKUP.test(streamed(t)) && !t.of('onAiNote').some(function (n) { return MARKUP.test(n.text); }));
    assert.strictEqual(t.store.audits[0].error, 'stepLimit');
    t.close();
});

test('lookup limit: structured calls after the limit -> firm retry; still calls -> error naming the lookup limit', async function () {
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'a', name: 'event_facets', args: {} }, { id: 'b', name: 'get_events', args: { limit: 2 } }] }) },
        { sse: chatSse({ text: 'Let me look again.', calls: [{ id: 'c', name: 'get_events', args: {} }] }) },
        { sse: chatSse({ calls: [{ id: 'd', name: 'get_events', args: {} }] }) });
    const t = F.setup({ mock: mock, settings: { limits: { maxRounds: 5, maxCalls: 2 } } });
    await t.start('ask', { text: 'q' });
    const err = t.last('onAiError');
    assert.ok(err, methods(t));
    assert.deepStrictEqual([err.code, /lookup limit/.test(err.message)], ['stepLimit', true]);
    const r = chatReqs();
    assert.match(lastUser(r[1]), /^No more lookups are available .* End with the <followups> block as instructed\.$/);
    assert.ok(/Tool use has ended/.test(r[2].bodyText) && /^Tool calls are not available any more/.test(lastUser(r[2])));
    assert.strictEqual(t.of('onAiNote')[0].text, 'Lookup limit reached: writing the answer with what was found so far.');
    t.close();
});

test('step limit: an answer after the limit that also carries stray tool-call markup is shown without it', async function () {
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { limit: 5 } }] }) },
        { sse: chatSse({ text: 'The print spooler crashed 30 times; the driver is the likely cause.\n<tool_call>\n<function=lookup_event_id>\n<parameter=id>\n7031\n</parameter>\n</function>\n</tool_call>\n<followups>["Which driver?"]</followups>' }) });
    const t = F.setup({ mock: mock, settings: { limits: { maxRounds: 1 } } });
    await t.start('ask', { text: 'q' });
    const done = t.last('onAiDone');
    assert.ok(done, methods(t));
    assert.strictEqual(chatReqs().length, 2, 'a usable answer: no retry');
    assert.strictEqual(done.text, 'The print spooler crashed 30 times; the driver is the likely cause.');
    assert.deepStrictEqual(done.followups, ['Which driver?']);
    assert.ok(!MARKUP.test(streamed(t)));
    t.close();
});
