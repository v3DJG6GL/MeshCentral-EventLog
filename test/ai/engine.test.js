'use strict';
// End-to-end Assistant turns against the mock LLM: tool loops per API format, citations, redaction, audit.
const test = require('node:test');
const assert = require('node:assert');
const F = require('./engine-fakes.js');
const { createMockLlm, chatSse, anthropicSse } = require('./mock-llm.js');

const CHAT = '/v1/chat/completions';
const MSGS = '/v1/messages';
const M_OPEN = '', M_MID = '', M_CLOSE = '';

let mock;
test.before(async function () { mock = await createMockLlm({ seed: 7 }); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });

function refsIn(text) { const out = []; const re = /\\?"(E\d+)\\?"/g; let m; while ((m = re.exec(text))) if (out.indexOf(m[1]) < 0) out.push(m[1]); return out; }
function chatReqs() { return mock.requests.filter(function (r) { return r.path === CHAT; }); }
function noDotKeys(v, path) {
    if (Array.isArray(v)) return v.forEach(function (x, i) { noDotKeys(x, path + '[' + i + ']'); });
    if (v && typeof v === 'object') for (const k of Object.keys(v)) { assert.ok(!/[.$]/.test(k), 'key ' + path + '.' + k); noDotKeys(v[k], path + '.' + k); }
}

test('ask, openai-chat: two tool rounds, citations from returned refs only, followups, audit', async function () {
    let seen = [];
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'event_facets', args: { window: { since: '24h' } } }, { id: 'c2', name: 'event_groups', args: { window: { since: '24h' }, top_n: 5 } }] }), split: true },
        { sse: chatSse({ calls: [{ id: 'c3', name: 'get_events', args: { filters: { levels: ['err'], sources: ['Service Control Manager'] }, limit: 5 } }] }), split: true },
        function (rec) {
            seen = refsIn(rec.bodyText);
            return { sse: chatSse({ text: 'The Print Spooler keeps crashing on HOST_1 [' + seen[0] + ', ' + seen[1] + '] and [E99].\n<followups>["Why does the spooler crash on HOST_1?","Is the DNS warning related?"]</followups>' }), split: true };
        });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'What is wrong with PC-ALICE01?' });
    const started = t.last('onAiStarted');
    assert.strictEqual(started.reqId, 'r1');
    assert.strictEqual(started.toolMode, 'tools');
    assert.strictEqual(started.redacted, true);
    const done = t.last('onAiDone');
    assert.ok(done, 'onAiDone: ' + t.ws.sent.map(function (m) { return m.method + ':' + (m.code || ''); }).join(','));
    assert.strictEqual(chatReqs().length, 3);
    // round 2 and 3 requests carry the tool results, fenced with the nonce
    const b2 = chatReqs()[1].body;
    const toolMsgs = b2.messages.filter(function (m) { return m.role === 'tool'; });
    assert.strictEqual(toolMsgs.length, 2);
    assert.ok(/<<<UNTRUSTED_DATA nonce=[0-9a-f]+ label=event_facets>>>/.test(toolMsgs[0].content));
    assert.ok(seen.length >= 2);
    // citations: valid ones kept, the invented one replaced
    assert.deepStrictEqual(done.invalidCitations, ['E99']);
    assert.ok(done.text.indexOf('[unverified]') >= 0);
    assert.ok(done.citations[seen[0]] && done.citations[seen[0]]._id, 'cited record present');
    assert.strictEqual(done.citations[seen[0]].nodeid, F.NODE);
    assert.ok(!('E99' in done.citations));
    // pseudonyms restored with markers in the answer; followups restored plainly
    assert.ok(done.text.indexOf(M_OPEN + 'host' + M_MID + 'PC-ALICE01' + M_CLOSE) >= 0, done.text);
    assert.deepStrictEqual(done.followups, ['Why does the spooler crash on PC-ALICE01?', 'Is the DNS warning related?']);
    assert.ok(done.text.indexOf('<followups>') < 0);
    assert.strictEqual(done.usage.rounds, 3);
    assert.ok(done.usage.in > 0);
    // deltas restored with markers too, numbered
    const deltas = t.of('onAiDelta');
    assert.ok(deltas.length >= 1);
    deltas.forEach(function (d, i) { assert.strictEqual(d.seq, i + 1); assert.strictEqual(d.turn, 1); });
    assert.ok(deltas.map(function (d) { return d.text; }).join('').indexOf(M_OPEN + 'host' + M_MID + 'PC-ALICE01' + M_CLOSE) >= 0);
    // steps
    const steps = t.of('onAiStep');
    assert.deepStrictEqual(steps.map(function (s) { return s.tool + ':' + s.status; }), ['event_facets:running', 'event_facets:done', 'event_groups:running', 'event_groups:done', 'get_events:running', 'get_events:done']);
    assert.ok(t.plugin.reauthCalls >= 3, 'authorized before every call');
    // nothing sensitive went to the model or the browser
    for (const r of mock.requests) F.assertNoForbidden(assert, 'request ' + r.path, r.bodyText);
    F.assertNoForbidden(assert, 'browser', JSON.stringify(t.ws.sent));
    for (const r of chatReqs()) { assert.ok(r.bodyText.indexOf('PC-ALICE01') < 0, 'host redacted'); assert.ok(r.bodyText.indexOf('jdoe') < 0, 'user redacted'); }
    // audit
    assert.strictEqual(t.store.audits.length, 1);
    const a = t.store.audits[0];
    assert.strictEqual(a.result, 'answered');
    assert.strictEqual(a.mode, 'ask');
    assert.strictEqual(a.steps.length, 3);
    assert.strictEqual(typeof a.steps[0].args, 'string');
    assert.strictEqual(a.counted, true);
    assert.ok(a.bytesSent > 0 && a.bytesRecv > 0);
    assert.ok(typeof a.transcript === 'string' && a.transcript.length < 262144 + 10);
    assert.ok(a.transcript.indexOf('PC-ALICE01') < 0, 'stored transcript is redacted');
    noDotKeys(a, 'audit');
    F.assertNoForbidden(assert, 'audit', JSON.stringify(a));
    // a follow-up question in the same conversation
    mock.script(CHAT, { sse: chatSse({ text: 'Follow-up answer.' }) });
    await t.send(done.convId, 'And the DNS warnings on PC-ALICE01?');
    const d2 = t.last('onAiDone');
    assert.strictEqual(d2.turn, 2);
    const b4 = chatReqs()[3].body;
    assert.ok(b4.messages.length > 6, 'history kept');
    assert.ok(b4.messages[b4.messages.length - 1].content.indexOf('HOST_1') >= 0);
    t.close();
});

test('explain, anthropic: tool_use round then <explain> block; citation records from the db', async function () {
    const t = F.setup({ mock: mock, format: 'anthropic' });
    const kp = t.events.find(function (e) { return e.Id === 41; });
    mock.script(MSGS,
        { sse: anthropicSse({ blocks: [{ type: 'thinking', thinking: 'Look it up.', signature: 'sig1' }, { type: 'tool_use', id: 'tu1', name: 'lookup_event_id', input: { provider: 'Microsoft-Windows-Kernel-Power', id: 41 } }, { type: 'tool_use', id: 'tu2', name: 'get_events', input: { window: { since: '6h' }, filters: { ids: '6008' }, limit: 3 } }], stop: 'tool_use' }) },
        function (rec) {
            const r = refsIn(rec.bodyText);
            return { sse: anthropicSse({ blocks: [{ type: 'text', text: 'Unexpected power loss on HOST_1 [E1], followed by [' + r[1] + '].\n<explain>{"meaning":"Kernel-Power 41 [E1]","onDevice":"Rebooted at 3h ago","harmless":{"verdict":"rarely","text":"Usually not harmless"},"checkNext":["Check the PSU"]}</explain>' }] }) };
        });
    await t.start('explain', { eventId: kp._id });
    const done = t.last('onAiDone');
    assert.ok(done, JSON.stringify(t.ws.sent.map(function (m) { return [m.method, m.code, m.message]; })));
    assert.ok(done.structured && done.structured.meaning.indexOf('Kernel-Power 41') >= 0);
    assert.strictEqual(done.structured.harmless.verdict, 'rarely');
    assert.strictEqual(done.citations.E1._id, kp._id, 'E1 is the explained event');
    assert.strictEqual(done.invalidCitations.length, 0);
    const reqs = mock.requests.filter(function (r) { return r.path === MSGS; });
    assert.strictEqual(reqs.length, 2);
    // first message has the event fenced and its ref
    const first = reqs[0].body.messages[0];
    const firstText = typeof first.content === 'string' ? first.content : first.content.map(function (b) { return b.text || ''; }).join('');
    assert.ok(firstText.indexOf('[E1]') >= 0 && firstText.indexOf('label=event') >= 0);
    // second request: thinking replayed verbatim, tool results sent, tools still offered
    const b2 = reqs[1].body;
    const asst = b2.messages.find(function (m) { return m.role === 'assistant'; });
    assert.ok(asst.content.some(function (b) { return b.type === 'thinking' && b.signature === 'sig1'; }));
    const tr = b2.messages[b2.messages.length - 1].content.filter(function (b) { return b.type === 'tool_result'; });
    assert.strictEqual(tr.length, 2);
    assert.ok(Array.isArray(b2.tools) && b2.tools.length > 0);
    for (const r of reqs) F.assertNoForbidden(assert, 'anthropic request', r.bodyText);
    t.close();
});

test('diagnose, anthropic, restart window: structured diagnosis validated against the window and refs', async function () {
    const t = F.setup({ mock: mock, format: 'anthropic' });
    mock.script(MSGS,
        { sse: anthropicSse({ blocks: [{ type: 'tool_use', id: 'a1', name: 'event_groups', input: { top_n: 10 } }], stop: 'tool_use' }) },
        function (rec) {
            const r = refsIn(rec.bodyText);
            const diag = { v: 1, summary: 'Power loss [' + r[0] + ']', lanes: [{ id: 'power', label: 'Power', markers: [{ t: 0, level: 'crit', label: 'reboot', cites: [r[0], 'E77'] }] }],
                hypotheses: [{ id: 'h1', title: 'PSU on HOST_1', status: 'likely', confidence: 0.8, why: 'see [' + r[0] + ']', evidence: [r[0]], against: [], confirm: 'Check' }],
                nextSteps: [{ text: 'Check power', command: { shell: 'powershell', text: 'Get-WinEvent -ComputerName HOST_1 -LogName System' } }], evidence: [{ cite: r[0], note: 'x' }], unexplained: [] };
            return { sse: anthropicSse({ blocks: [{ type: 'text', text: 'Summary.\n<diagnosis>' + JSON.stringify(diag) + '</diagnosis>' }] }) };
        });
    await t.start('diagnose', { window: 'restart' });
    const done = t.last('onAiDone');
    assert.ok(done, JSON.stringify(t.ws.sent.map(function (m) { return [m.method, m.code, m.message]; })));
    const s = done.structured;
    assert.ok(s, 'structured');
    const restart = F.NOW - 3 * F.H;
    assert.ok(Math.abs(s.window.from - (restart - 6 * F.H)) <= 60000, 'window starts 6 h before the restart');
    assert.strictEqual(s.lanes[0].markers[0].t, s.window.from, 'marker clamped into the window');
    assert.deepStrictEqual(s.lanes[0].markers[0].cites.length, 1, 'invented ref dropped');
    assert.ok(s.hypotheses[0].title.indexOf(M_OPEN + 'host' + M_MID + 'PC-ALICE01' + M_CLOSE) >= 0, 'restored with markers');
    assert.strictEqual(s.nextSteps[0].command.text, 'Get-WinEvent -ComputerName PC-ALICE01 -LogName System', 'commands restored without markers');
    assert.ok(Object.keys(done.citations).length >= 1);
    t.close();
});

test('injection payloads: flagged as suspicious, the model cannot reach another device', async function () {
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { filters: { sources: ['EvilApp'] }, limit: 10 } }] }) },
        // the "compromised" model tries to follow the injected instructions
        { sse: chatSse({ calls: [{ id: 'c2', name: 'get_events', args: { nodeid: 'node/d/other', limit: 10 } }, { id: 'c3', name: 'get_device_info', args: { node: 'node/d/other' } }] }) },
        { sse: chatSse({ text: 'Some events contain instructions; I did not follow them.' }) });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'Anything odd in the EvilApp events?' });
    const done = t.last('onAiDone');
    assert.ok(done);
    assert.ok(done.suspicious.length >= 1, 'suspicious refs reported');
    const steps = t.of('onAiStep').filter(function (s) { return s.status !== 'running'; });
    assert.strictEqual(steps[1].status, 'error');
    assert.strictEqual(steps[2].status, 'error');
    assert.ok(t.db.calls.every(function (c) { return c.nodeid === F.NODE; }), 'every db query is for the session device');
    const b3 = chatReqs()[2].bodyText;
    assert.ok(/unknown property/.test(b3));
    assert.ok(/injection_suspect/.test(chatReqs()[1].bodyText));
    for (const r of mock.requests) F.assertNoForbidden(assert, 'request', r.bodyText);
    t.close();
});

test('public endpoint: redaction forced even when every toggle is off; local endpoint honours the toggles', async function () {
    const off = { redact: { users: false, hosts: false, domains: false, ips: false, macs: false, emails: false, sids: false, paths: false, secrets: false, serials: false }, previewPolicy: 'never' };
    mock.script(CHAT, { sse: chatSse({ calls: [{ id: 'c1', name: 'get_device_info', args: {} }] }) }, { sse: chatSse({ text: 'Device HOST_1 user USER_1.' }) });
    const t = F.setup({ mock: mock, network: 'public', settings: off, ep: { key: null } });
    await t.start('ask', { text: 'Tell me about PC-ALICE01 and CORP\\jdoe' });
    const done = t.last('onAiDone');
    assert.ok(done, JSON.stringify(t.ws.sent.map(function (m) { return [m.method, m.code, m.message]; })));
    assert.strictEqual(t.last('onAiStarted').redacted, true);
    assert.strictEqual(t.last('onAiStarted').network, 'public');
    for (const r of chatReqs()) {
        for (const s of ['PC-ALICE01', 'jdoe', '192.168.1.50', 'aa:bb:cc:dd:ee:01', 'corp.example.com']) assert.ok(r.bodyText.toLowerCase().indexOf(s.toLowerCase()) < 0, s + ' sent to a public endpoint');
        F.assertNoForbidden(assert, 'public request', r.bodyText);
    }
    assert.ok(done.text.indexOf(M_OPEN + 'host' + M_MID + 'PC-ALICE01' + M_CLOSE) >= 0);
    assert.ok(done.redactionCounts.hosts >= 1);
    t.close();

    mock.reset();
    mock.script(CHAT, { sse: chatSse({ text: 'Plain.' }) });
    const t2 = F.setup({ mock: mock, network: 'private', settings: off });
    await t2.start('ask', { text: 'Tell me about PC-ALICE01' });
    assert.strictEqual(t2.last('onAiStarted').redacted, false);
    assert.ok(chatReqs()[0].bodyText.indexOf('PC-ALICE01') >= 0, 'no redaction for a private endpoint with the toggles off');
    t2.close();
});

test('long answers are split into onAiDelta messages of at most 16 KB', async function () {
    const long = 'Lorem ipsum dolor sit amet, ünïcödé ✓ '.repeat(1500);
    mock.script(CHAT, { sse: chatSse({ text: long, textPieces: 40 }) });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'Write a lot' });
    const deltas = t.of('onAiDelta');
    assert.ok(deltas.length >= 3);
    for (const d of deltas) assert.ok(Buffer.byteLength(JSON.stringify(d), 'utf8') <= 16 * 1024 + 300, 'delta size ' + Buffer.byteLength(d.text));
    assert.strictEqual(deltas.map(function (d) { return d.text; }).join(''), long);
    t.close();
});

test('interim text: what the model writes in rounds with tool calls becomes notes in the steps, never part of the answer', async function () {
    let refs = [];
    mock.script(CHAT,
        { sse: chatSse({ text: 'I\'ll start with a broad look at the device HOST_1.', calls: [{ id: 'c1', name: 'event_facets', args: { window: { since: '24h' } } }] }) },
        function (rec) { refs = refsIn(rec.bodyText); return { sse: chatSse({ text: 'Now let me look at the errors. <followups>["x?"]</followups>', calls: [{ id: 'c2', name: 'get_events', args: { filters: { levels: ['err'] }, limit: 3 } }] }) }; },
        function (rec) { refs = refsIn(rec.bodyText); return { sse: chatSse({ text: 'The spooler crashes [' + refs[0] + '].\n<followups>["Why?"]</followups>' }) }; });
    const t = F.setup({ mock: mock });
    await t.start('ask', { text: 'What is wrong?' });
    const done = t.last('onAiDone');
    assert.ok(done, t.ws.sent.map(function (m) { return m.method; }).join(','));
    assert.ok(done.text.indexOf('The spooler crashes') === 0, done.text);
    assert.ok(done.text.indexOf('broad look') < 0 && done.text.indexOf('let me look') < 0, 'no interim text in the answer');
    assert.deepStrictEqual(done.followups, ['Why?'], 'followups from the final round only');
    const notes = t.of('onAiNote');
    assert.strictEqual(notes.length, 2);
    assert.deepStrictEqual(notes.map(function (n) { return [n.turn, n.i, n.round]; }), [[1, 0, 1], [1, 2, 2]], 'notes take their place among the steps, before the lookups of their round');
    assert.ok(notes[0].text.indexOf(M_OPEN + 'host' + M_MID + 'PC-ALICE01' + M_CLOSE) >= 0, 'restored with markers: ' + notes[0].text);
    assert.strictEqual(notes[1].text, 'Now let me look at the errors.', 'blocks removed from a note');
    const steps = t.of('onAiStep').map(function (s) { return s.i; });
    assert.deepStrictEqual(Array.from(new Set(steps)), [1, 3]);
    // deltas carry the round, so the browser can drop a round's text when it turns out to be a note
    const deltas = t.of('onAiDelta');
    assert.ok(deltas.every(function (d) { return typeof d.round === 'number'; }));
    assert.ok(deltas.filter(function (d) { return d.round === 3; }).map(function (d) { return d.text; }).join('').indexOf('The spooler crashes') === 0);
    assert.ok(deltas.filter(function (d) { return d.round === 1; }).map(function (d) { return d.text; }).join('').indexOf('broad look') >= 0);
    // the audit keeps the tool steps only
    const a = t.store.audits.find(function (x) { return x.kind !== 'feedback'; });
    assert.deepStrictEqual(a.steps.map(function (s) { return s.tool; }), ['event_facets', 'get_events']);
    t.close();
});

test('interim text: the <diagnosis> block comes from the final round; a final round without text falls back to the last note', async function () {
    let refs = [];
    mock.script(CHAT,
        { sse: chatSse({ text: 'I will look at the restarts first.', calls: [{ id: 'c1', name: 'get_events', args: { filters: { levels: ['crit', 'err'] }, limit: 5 } }] }) },
        function (rec) {
            refs = refsIn(rec.bodyText);
            const d = { v: 1, summary: 'Power loss [' + refs[0] + '].', hypotheses: [{ id: 'h1', title: 'Power loss', status: 'likely', confidence: 0.7, why: 'Kernel-Power 41.', evidence: [refs[0]] }] };
            return { sse: chatSse({ text: 'Summary.\n<diagnosis>' + JSON.stringify(d) + '</diagnosis>' }) };
        });
    const t = F.setup({ mock: mock });
    await t.start('diagnose', { window: '24h' });
    const done = t.last('onAiDone');
    assert.ok(done && done.structured, JSON.stringify(t.ws.sent.map(function (m) { return m.method; })));
    assert.ok(done.structured.summary.indexOf('Power loss') === 0);
    assert.strictEqual(done.text, 'Summary.');
    assert.strictEqual(t.of('onAiNote')[0].text, 'I will look at the restarts first.');
    t.close();

    mock.reset();
    mock.script(CHAT,
        { sse: chatSse({ text: 'The answer is in the events.', calls: [{ id: 'c1', name: 'event_facets', args: { window: { since: '24h' } } }] }) },
        { sse: chatSse({ text: '' }) });
    const u = F.setup({ mock: mock });
    await u.start('ask', { text: 'q' });
    assert.strictEqual(u.last('onAiDone').text, 'The answer is in the events.');
    u.close();
});
