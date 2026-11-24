'use strict';
// "Suggest questions" (aiFollowups) and the answer settings per chat (thinking, temperature) in ai/index.js.
const test = require('node:test');
const assert = require('node:assert');
const F = require('./engine-fakes.js');
const { createMockLlm, chatSse, anthropicSse, responsesSse } = require('./mock-llm.js');
const historyMod = require('../../ai/history.js');
const storeMod = require('../../ai/store.js');
const aiIndex = require('../../ai/index.js');

const CHAT = '/v1/chat/completions';
let mock;
test.before(async function () { mock = await createMockLlm({ seed: 17 }); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });
function chatReqs() { return mock.requests.filter(function (r) { return r.path === CHAT; }); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, what) { for (let i = 0; i < 300; i++) { if (await fn()) return; await sleep(5); } throw new Error('timed out: ' + what); }

function memDb() {
    const rows = new Map();
    const copy = function (x) { return JSON.parse(JSON.stringify(x)); };
    return {
        rows: rows,
        aiChatPut: function (r) { rows.set(r.id, copy(r)); return Promise.resolve(true); },
        aiChatGet: function (id) { return Promise.resolve(rows.has(id) ? copy(rows.get(id)) : null); },
        aiChatList: function (q) {
            let l = Array.from(rows.values()).filter(function (r) { return r.userid === q.userid && r.nodeid === q.nodeid && (!q.kind || r.kind === q.kind) && (q.since == null || r.time >= q.since); });
            l.sort(function (a, b) { return b.time - a.time; });
            l = l.slice(q.skip || 0, (q.skip || 0) + (q.limit || 50));
            return Promise.resolve(l.map(function (r) { const o = copy(r); delete o.doc; return o; }));
        },
        aiChatDel: function (ids) { let n = 0; ids.forEach(function (id) { if (rows.delete(id)) n++; }); return Promise.resolve(n); },
        aiChatSweep: function () { return Promise.resolve(0); },
        aiChatPurge: function () { const n = rows.size; rows.clear(); return Promise.resolve(n); },
        aiChatCounts: function () { return Promise.resolve({ chat: rows.size, diagnosis: 0, explain: 0 }); }
    };
}
function setup(o) {
    o = o || {};
    const db = memDb();
    let t;
    const hist = historyMod.create({ db: db, getSettings: function () { return t.store.getSettings(); }, log: function () { } });
    t = F.setup(Object.assign({ mock: mock, aiOpts: { history: hist } }, o));
    t.hdb = db; t.hist = hist;
    t.fu = function (extra, myparent) { return t.ai.handle(t.cmd('aiFollowups', Object.assign({ reqId: 'fu1' }, extra || {})), myparent || t.myparent, {}); };
    return t;
}
const FU = '<followups>["Is PC-ALICE01 still crashing?", "Which driver failed?", "When did it start?"]</followups>';

test('aiFollowups: one short request without tools from a pseudonymized recap; values restored; saved; tokens counted, not a question', async function () {
    mock.script(CHAT, function (rec) { return { sse: chatSse({ text: /HOST_\d+/.exec(rec.bodyText)[0] + ' lost power.\n<followups>["Old one?"]</followups>', usage: { prompt_tokens: 100, completion_tokens: 20 } }) }; });
    const t = setup({ settings: { quotas: { perUserQuestions: 5, perUserTokens: 0 } }, ep: { caps: { thinking: { supported: true, levels: ['off', 'low', 'medium', 'high'], verified: true }, at: Date.now() }, temperature: 0.6 } });
    await t.start('ask', { text: 'Why did PC-ALICE01 restart?' });
    const d1 = t.last('onAiDone');
    assert.deepStrictEqual(d1.followups, ['Old one?']);
    await until(function () { return t.hdb.rows.has(d1.chatId); }, 'saved');
    const convId = t.last('onAiStarted').convId;

    mock.reset();
    mock.script(CHAT, function (rec) {
        // the model sees pseudonyms only; it answers with one, which is restored for the technician
        const host = /HOST_\d+/.exec(rec.bodyText)[0];
        return { sse: chatSse({ text: FU.replace('PC-ALICE01', host), usage: { prompt_tokens: 50, completion_tokens: 12 } }) };
    });
    await t.fu({ convId: convId, chatId: d1.chatId });
    const r = t.last('onAiFollowups');
    assert.ok(r, t.ws.sent.map(function (m) { return m.method + (m.code ? ':' + m.code : ''); }).join(','));
    assert.deepStrictEqual([r.reqId, r.chatId, r.convId, r.turn], ['fu1', d1.chatId, convId, 1]);
    assert.deepStrictEqual(r.followups, ['Is PC-ALICE01 still crashing?', 'Which driver failed?', 'When did it start?']);
    const b = chatReqs()[0].body;
    assert.strictEqual('tools' in b, false, 'no tools offered');
    assert.strictEqual(b.max_tokens, 300);
    assert.strictEqual(b.reasoning_effort, 'none', 'thinking off: the endpoint can switch it off');
    assert.strictEqual(b.temperature, 0.6, 'the endpoint temperature stays');
    assert.match(b.messages[0].content, /^Suggest up to 3 short follow-up questions .* Reply only with <followups>\["…"\]<\/followups>\.$/);
    assert.ok(chatReqs()[0].bodyText.indexOf('PC-ALICE01') < 0, 'pseudonymized like the recap');
    assert.match(b.messages[1].content, /label=conversation>>>[\s\S]*Technician asked: Why did HOST_\d+ restart\?[\s\S]*You answered: HOST_\d+ lost power\./);
    // saved as the last message's follow-ups
    await until(async function () { const c = await t.hist.get('user/d/alice', F.NODE, 'chat', d1.chatId); return c.messages[0].followups.length === 3; }, 'followups saved');
    // audit: kind followups, not counted as a question; tokens count
    const a = t.store.audits.filter(function (x) { return x.kind === 'followups'; });
    assert.strictEqual(a.length, 1);
    assert.deepStrictEqual([a[0].counted, a[0].tokensIn, a[0].tokensOut, a[0].result, a[0].thinking, a[0].temperature, a[0].chatId], [false, 50, 12, 'answered', 'off', 0.6, d1.chatId]);
    const info = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(info.remaining, { questions: 4, tokens: null }, 'one question used, the suggestion is not one');
    t.close();
});

test('aiFollowups: a saved chat without an open conversation; another user cannot; refusals (permission, rights, busy, token quota, nothing given)', async function () {
    mock.script(CHAT, { sse: chatSse({ text: 'Fine.' }) });
    const t = setup({ settings: { quotas: { perUserTokens: 1000 } } });
    await t.start('ask', { text: 'First?' });
    const chatId = t.last('onAiDone').chatId;
    await until(function () { return t.hdb.rows.has(chatId); }, 'saved');
    t.ai.sessions.closeAll('test');

    mock.always(CHAT, { sse: chatSse({ text: 'Sure.\n' + FU }) });
    await t.fu({ chatId: chatId, convId: 'gone' });
    let r = t.last('onAiFollowups');
    assert.deepStrictEqual([r.chatId, r.convId, r.turn, r.followups.length], [chatId, null, 1, 3]);
    assert.strictEqual(r.followups[0], 'Is PC-ALICE01 still crashing?');
    assert.strictEqual(chatReqs().pop().body.reasoning_effort, 'none', 'thinking support unknown: thinking off is still asked for');
    const saved = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId);
    assert.strictEqual(saved.messages[0].followups[1], 'Which driver failed?');

    const errs = function () { return t.of('onAiError').filter(function (m) { return m.scope === 'followups'; }); };
    // bob: not found
    const ws2 = F.makeWs(), bob = { user: { _id: 'user/d/bob', name: 'bob' }, ws: ws2, domain: { id: 'd' } };
    await t.fu({ chatId: chatId }, bob);
    assert.strictEqual(ws2.sent.pop().code, 'notFound');
    // permission, rights
    t.plugin.perms.deviceAssistant = false;
    await t.fu({ chatId: chatId });
    assert.strictEqual(errs().pop().code, 'denied');
    t.plugin.perms.deviceAssistant = true;
    await t.ai.handle(t.cmd('aiFollowups', { reqId: 'fu2', chatId: chatId, _rights: 0x8 }), t.myparent, {});
    assert.deepStrictEqual([errs().pop().code, errs().pop().reqId], ['denied', 'fu2']);
    await t.fu({});
    assert.strictEqual(errs().pop().code, 'invalid');
    // busy: a question of that chat runs
    mock.reset();
    mock.script(CHAT, { sse: chatSse({ text: 'slow' }), delayMs: 300 });
    const run = t.start('ask', { text: 'Again?' }, { chatId: chatId, reqId: 'r2' });
    await until(function () { return t.ai.sessions.forUser('user/d/alice').some(function (S) { return S.busy; }); }, 'busy');
    await t.fu({ chatId: chatId });
    assert.strictEqual(errs().pop().code, 'busy');
    await run;
    // token quota used up
    t.store.audits.push({ counted: true, userid: 'user/d/alice', time: Date.now(), tokensIn: 5000, tokensOut: 0 });
    await t.fu({ chatId: chatId });
    assert.strictEqual(errs().pop().code, 'quota');
    t.close();
});

test('aiFollowups: no block -> empty list; a model error is reported to the button and audited', async function () {
    mock.script(CHAT, { sse: chatSse({ text: 'Fine.' }) });
    const t = setup();
    await t.start('ask', { text: 'First?' });
    const convId = t.last('onAiStarted').convId;
    mock.reset();
    mock.script(CHAT, { sse: chatSse({ text: 'I cannot think of any.' }) }, { status: 401, json: { error: { message: 'bad key' } } });
    await t.fu({ convId: convId });
    assert.deepStrictEqual(t.last('onAiFollowups').followups, []);
    await t.fu({ convId: convId, reqId: 'fu9' });
    const e = t.last('onAiError');
    assert.deepStrictEqual([e.scope, e.reqId, e.code, e.convId], ['followups', 'fu9', 'auth', null]);
    const a = t.store.audits.filter(function (x) { return x.kind === 'followups'; });
    assert.deepStrictEqual(a.map(function (x) { return x.result + ':' + (x.error || ''); }), ['answered:', 'error:auth']);
    t.close();
});

test('aiFollowups with a thinking model: thinking off asked for; a 400 naming it -> once more without; cut off while reasoning -> once more with more room; an empty reply fails clearly', async function () {
    mock.script(CHAT, { sse: chatSse({ text: 'Fine.' }) });
    const t = setup();
    await t.start('ask', { text: 'First?' });
    const convId = t.last('onAiStarted').convId;
    const fuReqs = function () { return chatReqs().filter(function (r) { return /Suggest the follow-up questions now/.test(r.bodyText); }); };

    // the server refuses reasoning_effort: once more without it
    mock.reset();
    mock.script(CHAT, { status: 400, json: { error: { message: 'Unrecognized request argument supplied: reasoning_effort', type: 'invalid_request_error' } } }, { sse: chatSse({ text: FU }) });
    await t.fu({ convId: convId, reqId: 'a' });
    let r = t.last('onAiFollowups');
    assert.ok(r && r.reqId === 'a', t.ws.sent.map(function (m) { return m.method + (m.code ? ':' + m.code : ''); }).join(','));
    assert.strictEqual(r.followups.length, 3);
    assert.deepStrictEqual(fuReqs().map(function (x) { return x.body.reasoning_effort; }), ['none', undefined]);

    // it reasoned until max_tokens and wrote nothing: once more with 1500 tokens
    mock.reset();
    mock.script(CHAT, { sse: chatSse({ reasoning: 'The user wants questions about the restart...', text: '', finish: 'length', usage: { prompt_tokens: 40, completion_tokens: 300 } }) },
        { sse: chatSse({ text: '<think>short</think>\n["Did the PSU fail?", "Was there a BSOD?"]', usage: { prompt_tokens: 40, completion_tokens: 30 } }) });
    await t.fu({ convId: convId, reqId: 'b' });
    r = t.last('onAiFollowups');
    assert.deepStrictEqual([r.reqId, r.followups], ['b', ['Did the PSU fail?', 'Was there a BSOD?']]);
    assert.deepStrictEqual(fuReqs().map(function (x) { return x.body.max_tokens; }), [300, 1500]);
    const au = t.store.audits.filter(function (x) { return x.kind === 'followups'; }).pop();
    assert.deepStrictEqual([au.tokensIn, au.tokensOut, au.result], [80, 330, 'answered'], 'both requests counted');

    // still nothing: a clear error, the reason class in the server log (no content)
    mock.reset();
    mock.always(CHAT, { sse: chatSse({ reasoning: 'Thinking hard', text: '', finish: 'length' }) });
    await t.fu({ convId: convId, reqId: 'c' });
    const e = t.last('onAiError');
    assert.deepStrictEqual([e.scope, e.reqId, e.code], ['followups', 'c', 'noAnswer']);
    assert.strictEqual(fuReqs().length, 2, 'one retry only');
    assert.ok(t.logs.some(function (l) { return l === 'EVENTLOG AI: Suggest questions: no questions in the reply (cutOff)'; }), t.logs.join('\n'));
    t.close();
});

test('aiFollowups: no thinking setting when the endpoint is known not to take "off"', async function () {
    mock.script(CHAT, { sse: chatSse({ text: 'Fine.' }) });
    const t = setup({ ep: { caps: { thinking: { supported: true, levels: ['low', 'medium', 'high'], verified: true }, at: Date.now() } } });
    await t.start('ask', { text: 'First?' });
    mock.reset();
    mock.script(CHAT, { sse: chatSse({ text: FU }) });
    await t.fu({ convId: t.last('onAiStarted').convId });
    assert.strictEqual(t.last('onAiFollowups').followups.length, 3);
    assert.ok(!('reasoning_effort' in chatReqs()[0].body));
    t.close();
});

test('readFollowups: lenient reading of a reply', function () {
    const P = require('../../ai/prompts.js');
    const q = function (s) { return P.readFollowups(s); };
    assert.deepStrictEqual(q('<followups>["A?", "B?"]</followups>'), { followups: ['A?', 'B?'], reason: null });
    assert.deepStrictEqual(q('<think>reasoning [1, 2]</think>Here you go:\n["Is the disk failing?", "When did it start?"]').followups, ['Is the disk failing?', 'When did it start?']);
    assert.deepStrictEqual(q('<think>never closed, all reasoning').reason, 'empty');
    assert.deepStrictEqual(q('reasoning without its opening tag</think>\n- First question\n- Second question').followups, ['First question', 'Second question']);
    assert.deepStrictEqual(q('Suggestions:\n1. **Which driver failed?**\n2) "Is the PSU OK?"\n3. Did Windows update?\n4. Fourth?').followups, ['Which driver failed?', 'Is the PSU OK?', 'Did Windows update?']);
    assert.deepStrictEqual(q('You could ask:\nWhich service crashed first?\nIs the spooler disabled now?').followups, ['Which service crashed first?', 'Is the spooler disabled now?']);
    assert.deepStrictEqual(q('<followups>["Complete one?", "Cut o').followups, ['Complete one?'], 'a block cut off inside the array');
    assert.deepStrictEqual(q('<tool_call>\n<function=get_events>\n</function>\n</tool_call>\n<followups>["After markup?"]</followups>').followups, ['After markup?']);
    assert.deepStrictEqual(q('<tool_call>\n<function=get_events>\n</function>\n</tool_call>'), { followups: [], reason: 'empty' });
    assert.deepStrictEqual(q('I cannot think of any.'), { followups: [], reason: 'noQuestions' });
    assert.deepStrictEqual(q(''), { followups: [], reason: 'empty' });
});

test('chatGenInfo / genIn: levels from the endpoint, unknown -> all not verified, none for Anthropic or no thinking setting', function () {
    const S = { chatGen: { enabled: true } };
    assert.deepStrictEqual(aiIndex.chatGenInfo(S, { format: 'openai-chat', caps: null, thinking: 'low', temperature: 0.7 }),
        { enabled: true, thinkingLevels: ['off', 'low', 'medium', 'high'], thinkingVerified: false, temperature: true, endpointThinking: 'low', endpointTemperature: 0.7 });
    let i = aiIndex.chatGenInfo(S, { format: 'openai-chat', caps: { thinking: { supported: true, levels: ['low', 'medium', 'high'], verified: true } } });
    assert.deepStrictEqual([i.thinkingLevels, i.thinkingVerified], [['low', 'medium', 'high'], true]);
    i = aiIndex.chatGenInfo(S, { format: 'openai-chat', caps: { thinking: { supported: false, levels: ['off'] } } });
    assert.strictEqual(i.thinkingLevels, null);
    i = aiIndex.chatGenInfo(S, { format: 'anthropic', thinking: 'high', temperature: 1 });
    assert.deepStrictEqual([i.thinkingLevels, i.temperature, i.endpointThinking, i.endpointTemperature], [null, false, null, null]);
    i = aiIndex.chatGenInfo({ chatGen: { enabled: false } }, { format: 'openai-chat' });
    assert.strictEqual(i.enabled, false);
    const info = aiIndex.chatGenInfo(S, { format: 'openai-chat', caps: { thinking: { supported: true, levels: ['low', 'high'] } } });
    assert.deepStrictEqual(aiIndex.genIn({ thinking: 'high', temperature: 0.734 }, info), { thinking: 'high', temperature: 0.73 });
    assert.deepStrictEqual(aiIndex.genIn({ thinking: 'off', temperature: 2.5 }, info), {}, 'unsupported level and out-of-range temperature ignored');
    assert.deepStrictEqual(aiIndex.genIn({ thinking: 'low', temperature: '0.5' }, info), { thinking: 'low' });
    assert.deepStrictEqual(aiIndex.genIn({ thinking: 'high', temperature: 1 }, Object.assign({}, info, { enabled: false })), {});
    assert.deepStrictEqual(aiIndex.genIn({ thinking: 'high', temperature: 1 }, aiIndex.chatGenInfo(S, { format: 'anthropic' })), {});
});

test('answer settings: gen of aiStart / aiSend overrides the endpoint per request, audited, saved with the chat and used again when it continues', async function () {
    mock.always(CHAT, { sse: chatSse({ text: 'Fine.' }) });
    const t = setup({ ep: { thinking: 'low', temperature: 0.4, topK: 30 } });
    const acc = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(acc.chatGen, { enabled: true, thinkingLevels: ['off', 'low', 'medium', 'high'], thinkingVerified: false, temperature: true, endpointThinking: 'low', endpointTemperature: 0.4 });
    await t.start('ask', { text: 'Q1?' }, { gen: { thinking: 'high', temperature: 1.234 } });
    let b = chatReqs().pop().body;
    assert.deepStrictEqual([b.reasoning_effort, b.temperature, b.top_k], ['high', 1.23, 30], 'override on top, the other settings stay');
    let au = t.store.audits.pop();
    assert.deepStrictEqual([au.thinking, au.temperature], ['high', 1.23]);
    const chatId = t.last('onAiDone').chatId, convId = t.last('onAiStarted').convId;
    await until(async function () { const c = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId); return c && c.gen; }, 'gen saved');
    assert.deepStrictEqual((await t.hist.get('user/d/alice', F.NODE, 'chat', chatId)).gen, { thinking: 'high', temperature: 1.23 });
    // aiSend: changed; invalid values ignored (the endpoint's apply)
    await t.ai.handle(t.cmd('aiSend', { convId: convId, text: 'Q2?', gen: { thinking: 'off', temperature: 9 } }), t.myparent, {});
    b = chatReqs().pop().body;
    assert.deepStrictEqual([b.reasoning_effort, b.temperature], ['none', 0.4]);
    // aiSend without gen keeps the chat's settings
    await t.ai.handle(t.cmd('aiSend', { convId: convId, text: 'Q3?' }), t.myparent, {});
    b = chatReqs().pop().body;
    assert.deepStrictEqual([b.reasoning_effort, b.temperature], ['none', 0.4]);
    await until(async function () { const c = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId); return c && c.messages.length === 3; }, 'three saved');
    assert.deepStrictEqual((await t.hist.get('user/d/alice', F.NODE, 'chat', chatId)).gen, { thinking: 'off' });
    // continued later without gen: the saved settings
    t.ai.sessions.closeAll('test');
    await t.start('ask', { text: 'Q4?' }, { chatId: chatId, reqId: 'r4' });
    b = chatReqs().pop().body;
    assert.deepStrictEqual([b.reasoning_effort, b.temperature], ['none', 0.4]);
    // the admin turns it off: gen is ignored, also for an open conversation
    t.store.settings.chatGen = { enabled: false };
    await t.ai.handle(t.cmd('aiSend', { convId: t.last('onAiStarted').convId, text: 'Q5?', gen: { thinking: 'high', temperature: 1.5 } }), t.myparent, {});
    b = chatReqs().pop().body;
    assert.deepStrictEqual([b.reasoning_effort, b.temperature], ['low', 0.4]);
    au = t.store.audits.pop();
    assert.deepStrictEqual([au.thinking, au.temperature], ['low', 0.4]);
    assert.strictEqual((await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF)).chatGen.enabled, false);
    t.close();
});

test('answer settings: a level the endpoint does not take is ignored; Anthropic ignores them all', async function () {
    mock.always(CHAT, { sse: chatSse({ text: 'Fine.' }) });
    let t = setup({ ep: { caps: { thinking: { supported: true, levels: ['low', 'medium', 'high'] }, at: Date.now() } } });
    await t.start('ask', { text: 'Q?' }, { gen: { thinking: 'off', temperature: 0.2 } });
    let b = chatReqs().pop().body;
    assert.deepStrictEqual(['reasoning_effort' in b, b.temperature], [false, 0.2]);
    t.close();
    mock.reset();
    mock.always('/v1/messages', { sse: anthropicSse({ blocks: [{ type: 'text', text: 'Fine.' }] }) });
    t = setup({ format: 'anthropic' });
    await t.start('ask', { text: 'Q?' }, { gen: { thinking: 'high', temperature: 0.2 } });
    assert.ok(t.last('onAiDone'));
    b = mock.requests.filter(function (r) { return r.path === '/v1/messages'; }).pop().body;
    assert.deepStrictEqual(['temperature' in b, 'thinking' in b], [false, false]);
    const au = t.store.audits.pop();
    assert.deepStrictEqual([au.thinking, au.temperature], [null, null]);
    t.close();
});

test('settings: chatGen.enabled merges (default on, boolean only)', function () {
    const base = storeMod.mergeSettings(storeMod.DEFAULTS, {});
    assert.deepStrictEqual(base.chatGen, { enabled: true });
    assert.deepStrictEqual(storeMod.mergeSettings(base, { chatGen: { enabled: false } }).chatGen, { enabled: false });
    assert.deepStrictEqual(storeMod.mergeSettings(base, { chatGen: { enabled: 'no' } }).chatGen, { enabled: true });
    assert.deepStrictEqual(storeMod.mergeSettings(storeMod.mergeSettings(base, { chatGen: { enabled: false } }), { limits: {} }).chatGen, { enabled: false });
});

// ---- model choice per chat (ep.userModels) ----
const M2 = { id: 'qwen3.8-flash-next', thinkingMap: { off: null, low: 20, medium: 70, high: 90, max: 99 } };
const M2CAPS = { model: M2.id, caps: { at: Date.now(), tools: true, ctx: 65536, thinking: { supported: true, verified: true, levels: ['low', 'medium', 'high', 'max'], accepted: ['low', 'high', 50], reasoned: ['high', 50] } } };
function modelsEp(extra) { return Object.assign({ userModels: { enabled: true, models: [M2] }, capsByModel: [M2CAPS] }, extra || {}); }

test('chatGenInfo / genIn: listed models with their own levels; thinking checked against the picked model; a model off the list ignored', function () {
    const S = { chatGen: { enabled: true } };
    const ep = Object.assign({ format: 'openai-chat', model: 'test-model', caps: null, thinkingMap: { max: 'xhigh' } }, modelsEp());
    const i = aiIndex.chatGenInfo(S, ep);
    assert.deepStrictEqual(i.models, [
        { id: 'test-model', label: 'test-model', default: true, thinkingLevels: ['off', 'low', 'medium', 'high', 'max'], thinkingVerified: false },
        { id: M2.id, label: M2.id, default: false, thinkingLevels: ['low', 'medium', 'high', 'max'], thinkingVerified: true }
    ]);
    assert.strictEqual(i.defaultModel, 'test-model');
    assert.deepStrictEqual(aiIndex.genIn({ model: M2.id, thinking: 'off' }, i), { model: M2.id }, 'off is not offered for this model');
    assert.deepStrictEqual(aiIndex.genIn({ model: M2.id, thinking: 'max' }, i), { model: M2.id, thinking: 'max' });
    assert.deepStrictEqual(aiIndex.genIn({ model: 'other', thinking: 'off' }, i), { thinking: 'off' });
    // the model choice does not depend on chatGen.enabled; Anthropic gets it too (no levels)
    assert.deepStrictEqual(aiIndex.genIn({ model: M2.id, thinking: 'max' }, aiIndex.chatGenInfo({ chatGen: { enabled: false } }, ep)), { model: M2.id });
    const a = aiIndex.chatGenInfo(S, Object.assign({}, ep, { format: 'anthropic' }));
    assert.deepStrictEqual(a.models.map(function (m) { return m.id + ':' + m.thinkingLevels; }), ['test-model:null', M2.id + ':null']);
    // no choice: the shape stays as before
    assert.ok(!('models' in aiIndex.chatGenInfo(S, Object.assign({}, ep, { userModels: { enabled: false, models: [M2] } }))));
});

test('model choice: the picked model is used for the request, the thinking map of that model, the audit and the saved chat; an unknown one falls back with a note', async function () {
    mock.always(CHAT, { sse: chatSse({ text: 'Fine.' }) });
    const t = setup({ ep: modelsEp() });
    const acc = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(acc.chatGen.models.map(function (m) { return m.id; }), ['test-model', M2.id]);
    await t.start('ask', { text: 'Q1?' }, { gen: { model: M2.id, thinking: 'max' } });
    let b = chatReqs().pop().body;
    assert.deepStrictEqual([b.model, b.reasoning_effort], [M2.id, 99], 'the model and its map value (a number)');
    const st = t.last('onAiStarted');
    assert.deepStrictEqual([st.model, 'modelFallback' in st], [M2.id, false]);
    let au = t.store.audits.pop();
    assert.deepStrictEqual([au.model, au.thinking], [M2.id, 'max']);
    const chatId = t.last('onAiDone').chatId;
    await until(async function () { const c = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId); return c && c.gen; }, 'gen saved');
    const saved = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId);
    assert.deepStrictEqual([saved.gen, saved.messages[0].model], [{ model: M2.id, thinking: 'max' }, M2.id]);
    // aiSend without gen keeps the model; gen without model keeps it too, its thinking checked against that model
    await t.ai.handle(t.cmd('aiSend', { convId: st.convId, text: 'Q2?', gen: { thinking: 'low' } }), t.myparent, {});
    b = chatReqs().pop().body;
    assert.deepStrictEqual([b.model, b.reasoning_effort], [M2.id, 20]);
    // back to the endpoint's model mid-conversation
    await t.ai.handle(t.cmd('aiSend', { convId: st.convId, text: 'Q3?', gen: { model: 'test-model', thinking: 'max' } }), t.myparent, {});
    b = chatReqs().pop().body;
    assert.deepStrictEqual([b.model, 'reasoning_effort' in b], ['test-model', false], 'max has no value in the default map');
    assert.strictEqual(t.store.audits.pop().model, 'test-model');
    // a model that is not allowed: the endpoint's, with a note
    t.ai.sessions.closeAll('test');
    await t.start('ask', { text: 'Q4?' }, { gen: { model: 'evil-model' }, reqId: 'r4' });
    b = chatReqs().pop().body;
    assert.strictEqual(b.model, 'test-model');
    const fb = t.last('onAiStarted').modelFallback;
    assert.deepStrictEqual([fb.requested, fb.model], ['evil-model', 'test-model']);
    assert.match(fb.message, /^The model evil-model is no longer available; this chat continues with test-model\.$/);
    // aiSend with a model off the list: onAiModelFallback, the endpoint's model
    await t.ai.handle(t.cmd('aiSend', { convId: t.last('onAiStarted').convId, text: 'Q5?', gen: { model: 'evil-model' } }), t.myparent, {});
    assert.deepStrictEqual([t.last('onAiModelFallback').requested, t.last('onAiModelFallback').convId], ['evil-model', t.last('onAiStarted').convId]);
    assert.strictEqual(chatReqs().pop().body.model, 'test-model');
    t.close();
});

test('model choice: a saved chat whose model is no longer allowed continues with the endpoint\'s model and says so; Suggest questions follows the chat\'s model', async function () {
    mock.always(CHAT, { sse: chatSse({ text: 'Fine.\n' + FU }) });
    const t = setup({ ep: modelsEp() });
    await t.start('ask', { text: 'Q1?' }, { gen: { model: M2.id } });
    const chatId = t.last('onAiDone').chatId, convId = t.last('onAiStarted').convId;
    await until(async function () { const c = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId); return c && c.gen; }, 'saved');
    // Suggest questions in the open conversation: its model
    await t.fu({ convId: convId });
    assert.strictEqual(chatReqs().pop().body.model, M2.id);
    assert.strictEqual(t.store.audits.filter(function (x) { return x.kind === 'followups'; }).pop().model, M2.id);
    t.ai.sessions.closeAll('test');
    // the saved chat, no conversation: its saved model while it is allowed
    await t.fu({ chatId: chatId, reqId: 'fu2' });
    assert.strictEqual(chatReqs().pop().body.model, M2.id);
    // continued while allowed: the saved model without a note
    await t.start('ask', { text: 'Q2?' }, { chatId: chatId, reqId: 'r2' });
    assert.deepStrictEqual([chatReqs().pop().body.model, t.last('onAiStarted').model, 'modelFallback' in t.last('onAiStarted')], [M2.id, M2.id, false]);
    t.ai.sessions.closeAll('test');
    // the admin turns the choice off: the endpoint's model, with a note
    t.store.endpoints.ep1.userModels.enabled = false;
    await t.start('ask', { text: 'Q3?' }, { chatId: chatId, reqId: 'r3' });
    assert.strictEqual(chatReqs().pop().body.model, 'test-model');
    const st = t.last('onAiStarted');
    assert.deepStrictEqual([st.model, st.continued, st.modelFallback.requested, st.modelFallback.model], ['test-model', true, M2.id, 'test-model']);
    await t.fu({ chatId: chatId, convId: 'gone', reqId: 'fu3' });
    assert.strictEqual(t.last('onAiFollowups').reqId, 'fu3');
    t.close();
});

test('model choice: a changed model replays earlier answers as text (no reasoning items with encrypted content of the old model)', async function () {
    const RS = '/v1/responses';
    mock.always(RS, { sse: responsesSse({ items: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC-OF-MODEL-A' }, { type: 'message', text: 'Fine.' }] }) });
    const t = setup({ format: 'openai-responses', ep: modelsEp() });
    await t.start('ask', { text: 'Q1?' });
    const convId = t.last('onAiStarted').convId;
    const reqs = function () { return mock.requests.filter(function (r) { return r.path === RS; }); };
    // same model: the reasoning item is replayed as it came
    await t.ai.handle(t.cmd('aiSend', { convId: convId, text: 'Q2?' }), t.myparent, {});
    let b = reqs().pop();
    assert.strictEqual(b.body.model, 'test-model');
    assert.ok(b.bodyText.indexOf('ENC-OF-MODEL-A') >= 0, 'replayed for the same model');
    // another model: earlier answers as plain assistant text
    await t.ai.handle(t.cmd('aiSend', { convId: convId, text: 'Q3?', gen: { model: M2.id } }), t.myparent, {});
    b = reqs().pop();
    assert.strictEqual(b.body.model, M2.id);
    assert.ok(t.last('onAiDone'), t.ws.sent.map(function (m) { return m.method + (m.code ? ':' + m.code : ''); }).join(','));
    assert.strictEqual(b.bodyText.indexOf('ENC-OF-MODEL-A'), -1, 'no encrypted reasoning of the old model');
    assert.ok(!b.body.input.some(function (x) { return x && x.type === 'reasoning'; }));
    assert.deepStrictEqual(b.body.input.filter(function (x) { return x && x.role === 'assistant'; }).map(function (x) { return x.content; }), ['Fine.', 'Fine.']);
    t.close();
});

test('model choice: independent of chatGen.enabled; the Anthropic format gets the model only', async function () {
    mock.always(CHAT, { sse: chatSse({ text: 'Fine.' }) });
    let t = setup({ settings: { chatGen: { enabled: false } }, ep: modelsEp() });
    const acc = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual([acc.chatGen.enabled, acc.chatGen.models.length], [false, 2]);
    await t.start('ask', { text: 'Q?' }, { gen: { model: M2.id, thinking: 'high', temperature: 0.3 } });
    const b = chatReqs().pop().body;
    assert.deepStrictEqual([b.model, 'reasoning_effort' in b, 'temperature' in b], [M2.id, false, false]);
    t.close();
    mock.reset();
    mock.always('/v1/messages', { sse: anthropicSse({ blocks: [{ type: 'text', text: 'Fine.' }] }) });
    t = setup({ format: 'anthropic', ep: { userModels: { enabled: true, models: [{ id: 'claude-b', thinkingMap: null }] } } });
    const a = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(a.chatGen.models.map(function (m) { return m.id + ':' + m.thinkingLevels; }), ['test-model:null', 'claude-b:null']);
    await t.start('ask', { text: 'Q?' }, { gen: { model: 'claude-b', thinking: 'high' } });
    const ab = mock.requests.filter(function (r) { return r.path === '/v1/messages'; }).pop().body;
    assert.deepStrictEqual([ab.model, 'thinking' in ab], ['claude-b', false]);
    assert.strictEqual(t.store.audits.pop().model, 'claude-b');
    t.close();
});
