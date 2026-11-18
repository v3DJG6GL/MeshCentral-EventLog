'use strict';
// Saved results (ai/history.js) and their use in ai/index.js: per user and device scope, caps, retention, the
// recap that continues a saved chat in a new session (citations keep working), starter questions per OS.
const test = require('node:test');
const assert = require('node:assert');
const F = require('./engine-fakes.js');
const { createMockLlm, chatSse } = require('./mock-llm.js');
const historyMod = require('../../ai/history.js');
const storeMod = require('../../ai/store.js');

const CHAT = '/v1/chat/completions';
const DAY = 86400000;
let mock;
test.before(async function () { mock = await createMockLlm({ seed: 11 }); });
test.after(async function () { await mock.close(); });
test.beforeEach(function () { mock.reset(); });
function chatReqs() { return mock.requests.filter(function (r) { return r.path === CHAT; }); }
function refsIn(text) { const out = []; const re = /\\?"(E\d+)\\?"/g; let m; while ((m = re.exec(text))) if (out.indexOf(m[1]) < 0) out.push(m[1]); return out; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, what) { for (let i = 0; i < 300; i++) { if (await fn()) return; await sleep(5); } throw new Error('timed out: ' + what); }

// the db.js saved-results API in memory (same semantics as the real backends, see test/db.test.js)
function memDb() {
    const rows = new Map();
    const copy = function (x) { return JSON.parse(JSON.stringify(x)); };
    const db = {
        rows: rows, puts: 0,
        aiChatPut: function (r) { db.puts++; if (!r || !r.id) return Promise.resolve(false); rows.set(r.id, copy(r)); return Promise.resolve(true); },
        aiChatGet: function (id) { return Promise.resolve(rows.has(id) ? copy(rows.get(id)) : null); },
        aiChatList: function (q) {
            if (!q || typeof q.userid !== 'string' || typeof q.nodeid !== 'string') return Promise.resolve([]);
            let l = Array.from(rows.values()).filter(function (r) { return r.userid === q.userid && r.nodeid === q.nodeid && (!q.kind || r.kind === q.kind) && (q.since == null || r.time >= q.since); });
            l.sort(function (a, b) { return b.time - a.time || (a.id < b.id ? 1 : -1); });
            l = l.slice(q.skip || 0, (q.skip || 0) + (q.limit || 50));
            return Promise.resolve(l.map(function (r) { const o = copy(r); delete o.doc; return o; }));
        },
        aiChatDel: function (ids) { let n = 0; (Array.isArray(ids) ? ids : [ids]).forEach(function (id) { if (rows.delete(id)) n++; }); return Promise.resolve(n); },
        aiChatSweep: function (cut) { let n = 0; for (const [id, r] of Array.from(rows)) if (r.time < cut) { rows.delete(id); n++; } return Promise.resolve(n); },
        aiChatPurge: function () { const n = rows.size; rows.clear(); return Promise.resolve(n); },
        aiChatCounts: function () { const c = { chat: 0, diagnosis: 0, explain: 0 }; rows.forEach(function (r) { c[r.kind]++; }); return Promise.resolve(c); }
    };
    return db;
}
function makeHistory(o) {
    o = o || {};
    const db = o.db || memDb();
    const clock = { t: o.t0 || Date.now() };
    const settings = { history: Object.assign({ enabled: true, retentionDays: 30 }, o.history || {}) };
    const logs = [];
    const h = historyMod.create({ db: db, getSettings: function () { return Promise.resolve(JSON.parse(JSON.stringify(settings))); }, now: function () { return clock.t; }, log: function (m) { logs.push(m); } });
    return { h: h, db: db, clock: clock, settings: settings, logs: logs };
}
const U1 = 'user/d/alice', U2 = 'user/d/bob', N1 = 'node/d/nA', N2 = 'node/d/nB';
function done(text, cites, extra) { return Object.assign({ text: text, structured: null, citations: cites || {}, invalidCitations: [], followups: ['Next?'], usage: { in: 10, out: 5, ms: 20, rounds: 1 } }, extra || {}); }
function rec(id, msg) { return { _id: id, nodeid: N1, tc: 1700000000000, Level: 2, LogName: 'System', ProviderName: 'Disk', Id: 7, Message: msg || 'bad block' }; }

test('history: a chat is saved per user and device; nobody else can read, list or delete it', async function () {
    const x = makeHistory(), h = x.h;
    const id = h.newChatId();
    assert.match(id, /^ch[0-9a-f]{24}$/);
    assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id, question: 'Why did it restart?', done: done('Power loss [E1].', { E1: rec('e1') }), steps: [{ tool: 'get_events', args: '{"limit":5}', ms: 3, items: 5, status: 'done' }], endpointName: 'gpu', model: 'm1' }), true);
    x.clock.t += 1000;
    assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id, question: 'And before?', done: done('Nothing [E2].', { E2: rec('e2') }), steps: [], model: 'm1' }), true);
    const item = await h.get(U1, N1, 'chat', id);
    assert.strictEqual(item.title, 'Why did it restart?');
    assert.deepStrictEqual(item.messages.map(function (m) { return m.q; }), ['Why did it restart?', 'And before?']);
    assert.strictEqual(item.messages[0].cites.E1._id, 'e1');
    assert.deepStrictEqual(item.messages[0].steps, [{ tool: 'get_events', args: '{"limit":5}', status: 'done', items: 5, ms: 3 }]);
    assert.strictEqual(item.messages[1].model, 'm1');
    const l = await h.list(U1, N1);
    assert.deepStrictEqual([l.enabled, l.retentionDays, l.chats.length, l.chats[0].id, l.chats[0].count, l.chats[0].title], [true, 30, 1, id, 2, 'Why did it restart?']);
    // another user, another device: not found, not listed, not deletable, never written to
    assert.strictEqual(await h.get(U2, N1, 'chat', id), null);
    assert.strictEqual(await h.get(U1, N2, 'chat', id), null);
    assert.strictEqual((await h.list(U2, N1)).chats.length, 0);
    assert.strictEqual((await h.list(U1, N2)).chats.length, 0);
    assert.strictEqual(await h.remove(U2, N1, 'chat', id), false);
    assert.strictEqual(await h.remove(U1, N2, 'chat', id), false);
    assert.strictEqual(await h.saveChatTurn({ userid: U2, nodeid: N1, chatId: id, question: 'hijack', done: done('x') }), false);
    assert.strictEqual((await h.get(U1, N1, 'chat', id)).messages.length, 2, 'the other user\'s turn did not land in the chat');
    // malformed ids and kinds
    for (const bad of ['', 'ch123', 'x'.repeat(65), null, 5, { $gt: '' }, '../ch' + 'a'.repeat(24)]) assert.strictEqual(await h.get(U1, N1, 'chat', bad), null, String(bad));
    assert.strictEqual(await h.get(U1, N1, 'nope', id), null);
    assert.strictEqual(await h.get('', N1, 'chat', id), null);
    // the owner deletes it
    assert.strictEqual(await h.remove(U1, N1, 'chat', id), true);
    assert.strictEqual(await h.get(U1, N1, 'chat', id), null);
    assert.strictEqual(await h.remove(U1, N1, 'chat', id), false);
});

test('history: the last diagnosis is replaced, explanations are kept per event; both scoped', async function () {
    const x = makeHistory(), h = x.h;
    await h.saveDiagnosis({ userid: U1, nodeid: N1, window: '24h', range: { from: 1, to: 2 }, done: done('first', {}, { structured: { summary: 'S1' } }) });
    x.clock.t += 5000;
    await h.saveDiagnosis({ userid: U1, nodeid: N1, window: '7d', range: { from: 3, to: 4 }, done: done('second', { E1: rec('e1') }, { structured: { summary: 'S2' } }) });
    let d = await h.get(U1, N1, 'diagnosis');
    assert.deepStrictEqual([d.window, d.text, d.structured.summary, d.cites.E1._id, d.generatedAt], ['7d', 'second', 'S2', 'e1', x.clock.t]);
    assert.strictEqual(Array.from(x.db.rows.values()).filter(function (r) { return r.kind === 'diagnosis'; }).length, 1);
    assert.strictEqual(await h.get(U2, N1, 'diagnosis'), null);
    assert.strictEqual(await h.get(U1, N2, 'diagnosis'), null);
    await h.saveExplain({ userid: U1, nodeid: N1, eventId: 'e1', done: done('means A', {}, { structured: { meaning: 'A' } }) });
    await h.saveExplain({ userid: U1, nodeid: N1, eventId: 'e2', done: done('means B') });
    await h.saveExplain({ userid: U1, nodeid: N1, eventId: 'e1', done: done('means A again') });
    assert.strictEqual((await h.get(U1, N1, 'explain', 'e1')).text, 'means A again');
    assert.strictEqual((await h.get(U2, N1, 'explain', 'e1')), null);
    const l = await h.list(U1, N1);
    assert.deepStrictEqual(l.explains.map(function (e) { return e.eventId; }).sort(), ['e1', 'e2']);
    assert.deepStrictEqual([l.diagnosis.window, l.diagnosis.generatedAt], ['7d', x.clock.t]);
    assert.strictEqual(await h.remove(U2, N1, 'diagnosis'), false);
    assert.strictEqual(await h.remove(U1, N1, 'diagnosis'), true);
    assert.strictEqual((await h.list(U1, N1)).diagnosis, null);
    assert.deepStrictEqual(await h.counts(), { chat: 0, diagnosis: 0, explain: 2, total: 2 });
});

test('history: caps (50 chats, 200 explanations, 512 KB per item) never fail a save', async function () {
    const x = makeHistory(), h = x.h;
    const ids = [];
    for (let i = 0; i < 53; i++) { const id = h.newChatId(); ids.push(id); x.clock.t += 10; assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id, question: 'q' + i, done: done('a' + i) }), true); }
    const l = await h.list(U1, N1);
    assert.strictEqual(l.chats.length, 50);
    assert.strictEqual(l.chats[0].title, 'q52');
    for (let i = 0; i < 3; i++) assert.strictEqual(await h.get(U1, N1, 'chat', ids[i]), null, 'oldest pruned');
    await h.saveChatTurn({ userid: U2, nodeid: N1, chatId: h.newChatId(), question: 'bob', done: done('x') });
    assert.strictEqual((await h.list(U1, N1)).chats.length, 50, 'another user\'s chats do not count');
    for (let i = 0; i < 205; i++) await h.saveExplain({ userid: U1, nodeid: N2, eventId: 'ev' + i, done: done('m') });
    assert.strictEqual((await h.list(U1, N2)).explains.length, 200);
    // size: huge citations and long answers are trimmed, the newest message stays
    const big = {}; for (let i = 1; i <= 80; i++) big['E' + i] = rec('id' + i, 'M'.repeat(30000));
    const id = h.newChatId();
    for (let i = 0; i < 12; i++) { x.clock.t += 10; assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N2, chatId: id, question: 'long ' + i, done: done('A'.repeat(150000), big) }), true); }
    const raw = x.db.rows.get(id);
    assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= historyMod.MAX_DOC, 'within 512 KB: ' + Buffer.byteLength(JSON.stringify(raw)));
    const item = await h.get(U1, N2, 'chat', id);
    assert.strictEqual(item.messages[item.messages.length - 1].q, 'long 11');
    assert.ok(Object.keys(item.messages[item.messages.length - 1].cites).length <= 60);
    assert.strictEqual(raw.meta.count, 12, 'count includes dropped messages');
    const d = {}; for (let i = 1; i <= 80; i++) d['E' + i] = rec('id' + i, 'M'.repeat(100000));
    assert.strictEqual(await h.saveDiagnosis({ userid: U1, nodeid: N2, window: '24h', done: done('D'.repeat(600000), d, { structured: { summary: 'S'.repeat(300000) } }) }), true);
    assert.ok(Buffer.byteLength(JSON.stringify(Array.from(x.db.rows.values()).find(function (r) { return r.kind === 'diagnosis' && r.nodeid === N2; }))) <= historyMod.MAX_DOC);
    // a failing database: logged, resolves false
    x.db.aiChatPut = function () { return Promise.reject(new Error('disk full')); };
    assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: h.newChatId(), question: 'q', done: done('a') }), false);
    assert.ok(x.logs.some(function (m) { return /could not save the chat \(disk full\)/.test(m); }));
});

test('history: retention (list/get hide expired items, the sweep deletes them), disabled saving, purge', async function () {
    const x = makeHistory({ history: { retentionDays: 2 } }), h = x.h;
    const old = h.newChatId(), fresh = h.newChatId();
    await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: old, question: 'old', done: done('a') });
    x.clock.t += 3 * DAY;
    await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: fresh, question: 'fresh', done: done('a') });
    assert.deepStrictEqual((await h.list(U1, N1)).chats.map(function (c) { return c.title; }), ['fresh']);
    assert.strictEqual(await h.get(U1, N1, 'chat', old), null);
    assert.strictEqual(await h.sweep(), 1);
    assert.strictEqual(x.db.rows.has(old), false);
    assert.strictEqual(x.db.rows.has(fresh), true);
    x.settings.history.enabled = false;
    const l = await h.list(U1, N1);
    assert.deepStrictEqual([l.enabled, l.chats.length], [false, 0]);
    assert.strictEqual(await h.get(U1, N1, 'chat', fresh), null);
    assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: fresh, question: 'x', done: done('a') }), false);
    assert.strictEqual(await h.remove(U1, N1, 'chat', fresh), true, 'deleting your own item works while saving is off');
    x.settings.history.enabled = true;
    await h.saveDiagnosis({ userid: U2, nodeid: N2, window: '24h', done: done('d') });
    assert.strictEqual(await h.purge(), 1);
    assert.deepStrictEqual(await h.counts(), { chat: 0, diagnosis: 0, explain: 0, total: 0 });
    assert.strictEqual(historyMod.create({ db: {} }), null, 'no store in the database: no history');
    assert.strictEqual(historyMod.titleOf('  a\n' + 'b'.repeat(100)).length, 80);
});

// ---- ai/index.js ---------------------------------------------------------------------------------------------
function setup(o) {
    o = o || {};
    const db = memDb();
    let t;
    const hist = historyMod.create({ db: db, getSettings: function () { return t.store.getSettings(); }, log: function () { } });
    t = F.setup(Object.assign({ mock: mock, aiOpts: { history: hist } }, o));
    t.hdb = db; t.hist = hist;
    t.hcmd = function (action, extra, myparent) { return t.ai.handle(t.cmd(action, extra || {}), myparent || t.myparent, {}); };
    return t;
}
function other(t, user) { const ws = F.makeWs(); return { user: user, ws: ws, domain: { id: 'd' } }; }

test('index: an Ask turn is saved under the chat id it reports; a new session continues it with a recap and the old refs', async function () {
    let firstRefs = [];
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { filters: { levels: ['crit', 'err'] }, limit: 5 } }] }) },
        function (rec) { firstRefs = refsIn(rec.bodyText); return { sse: chatSse({ text: 'The device lost power on PC-ALICE01 [' + firstRefs[0] + '].\n<followups>["What caused it?"]</followups>' }) }; });
    const t = setup();
    await t.start('ask', { text: 'Why did PC-ALICE01 restart?' });
    const d1 = t.last('onAiDone');
    assert.ok(d1, t.ws.sent.map(function (m) { return m.method; }).join(','));
    assert.match(d1.chatId, /^ch[0-9a-f]{24}$/);
    assert.strictEqual(t.last('onAiStarted').chatId, d1.chatId);
    const cited = firstRefs[0], citedId = d1.citations[cited]._id;
    await until(function () { return t.hdb.rows.has(d1.chatId); }, 'chat saved');
    const saved = await t.hist.get('user/d/alice', F.NODE, 'chat', d1.chatId);
    assert.strictEqual(saved.messages[0].q, 'Why did PC-ALICE01 restart?', 'the question as typed');
    assert.ok(saved.messages[0].a.indexOf('PC-ALICE01') >= 0, 'the answer as shown (values restored)');
    assert.strictEqual(saved.messages[0].cites[cited]._id, citedId);
    assert.deepStrictEqual(saved.messages[0].followups, ['What caused it?']);
    assert.ok(saved.messages[0].steps.length === 1 && saved.messages[0].steps[0].tool === 'get_events');
    assert.strictEqual(JSON.stringify(saved).indexOf('UNTRUSTED_DATA'), -1, 'no tool results or fences are saved');
    t.ai.sessions.closeAll('test');

    // a new session (after a reload) continues the saved chat
    mock.reset();
    mock.script(CHAT, function (rec) { return { sse: chatSse({ text: 'It was the same event as before [' + cited + '].' }) }; });
    await t.start('ask', { text: 'Did it happen again?' }, { chatId: d1.chatId, reqId: 'r2' });
    const st2 = t.of('onAiStarted').pop();
    assert.deepStrictEqual([st2.chatId, st2.continued], [d1.chatId, true]);
    const body = chatReqs()[0].body, user = body.messages.filter(function (m) { return m.role === 'user'; })[0].content;
    assert.match(user, /<<<UNTRUSTED_DATA nonce=[0-9a-f]+ label=recap>>>/);
    assert.match(user, /Technician asked: Why did HOST_\d+ restart\?/, 'the recap is pseudonymized for this session');
    assert.ok(user.indexOf('PC-ALICE01') < 0, 'no real host name in the recap');
    assert.ok(user.indexOf(cited + ': System Service Control Manager') >= 0 || user.indexOf(cited + ': ') >= 0, 'cited events listed under their refs');
    assert.match(user, /Did it happen again\?$/);
    const d2 = t.of('onAiDone').pop();
    assert.deepStrictEqual(d2.invalidCitations, [], 'the old ref is valid in the new session');
    assert.strictEqual(d2.citations[cited]._id, citedId, 'and points to the same event');
    assert.strictEqual(d2.chatId, d1.chatId);
    await until(async function () { const c = await t.hist.get('user/d/alice', F.NODE, 'chat', d1.chatId); return c && c.messages.length === 2; }, 'second message');
    const c2 = await t.hist.get('user/d/alice', F.NODE, 'chat', d1.chatId);
    assert.deepStrictEqual([c2.messages[1].q, c2.messages[1].cont, c2.title], ['Did it happen again?', true, 'Why did PC-ALICE01 restart?']);
    t.close();
});

test('index: a chat id of another user or device starts a new chat; aiHistory actions are scoped to the caller', async function () {
    mock.always(CHAT, { sse: chatSse({ text: 'ok' }) });
    const t = setup();
    await t.start('ask', { text: 'first' });
    const id = t.last('onAiDone').chatId;
    await until(function () { return t.hdb.rows.has(id); }, 'saved');
    // bob (same device, permission) cannot continue, read or delete alice's chat
    const bob = other(t, { _id: 'user/d/bob', name: 'bob' });
    await t.ai.handle(t.cmd('aiStart', { reqId: 'b1', mode: 'ask', input: { text: 'mine now?' }, chatId: id }), bob, {});
    const bs = bob.ws.sent.find(function (m) { return m.method === 'onAiStarted'; });
    assert.ok(bs.chatId && bs.chatId !== id, 'a new chat id');
    assert.strictEqual(bs.continued, false);
    assert.ok(chatReqs().every(function (r) { return r.bodyText.indexOf('label=recap') < 0; }), 'no recap of alice\'s chat');
    await t.hcmd('aiHistoryGet', { kind: 'chat', id: id }, bob);
    assert.strictEqual(bob.ws.sent.filter(function (m) { return m.method === 'onAiHistoryItem'; })[0].item, null);
    await t.hcmd('aiHistoryList', {}, bob);
    const bl = bob.ws.sent.filter(function (m) { return m.method === 'onAiHistory'; })[0];
    assert.ok(bl.chats.every(function (c) { return c.id !== id; }));
    await t.hcmd('aiHistoryDelete', { kind: 'chat', id: id }, bob);
    assert.strictEqual(bob.ws.sent.filter(function (m) { return m.method === 'onAiHistoryDeleted'; })[0].ok, false);
    assert.ok(t.hdb.rows.has(id), 'still there');
    // another device: alice's chat is not found there
    const nodeB = Object.assign({}, t.node, { _id: 'node/d/nB' });
    await t.ai.handle(Object.assign(t.cmd('aiHistoryGet', { kind: 'chat', id: id }), { nodeid: 'node/d/nB', _node: nodeB }), t.myparent, {});
    assert.strictEqual(t.last('onAiHistoryItem').item, null);
    assert.strictEqual(t.last('onAiHistoryItem').nodeid, 'node/d/nB');
    // alice: list, get, delete
    await t.hcmd('aiHistoryList');
    const l = t.last('onAiHistory');
    assert.deepStrictEqual([l.nodeid, l.enabled, l.available, l.chats.length, l.chats[0].id, l.chats[0].title], [F.NODE, true, true, 1, id, 'first']);
    await t.hcmd('aiHistoryGet', { kind: 'chat', id: id });
    assert.strictEqual(t.last('onAiHistoryItem').item.messages[0].q, 'first');
    await t.hcmd('aiHistoryGet', { kind: 'chat', id: 'ch' + '0'.repeat(24) });
    assert.strictEqual(t.last('onAiHistoryItem').item, null);
    await t.hcmd('aiHistoryGet', { kind: 'bogus', id: id });
    assert.strictEqual(t.last('onAiError').code, 'invalid');
    await t.hcmd('aiStart', { reqId: 'x', mode: 'ask', input: { text: 'q' }, chatId: '../etc' });
    assert.strictEqual(t.last('onAiError').code, 'invalid');
    await t.hcmd('aiHistoryDelete', { kind: 'chat', id: id });
    assert.strictEqual(t.last('onAiHistoryDeleted').ok, true);
    assert.strictEqual(t.hdb.rows.has(id), false);
    // without the permission or the Details right: refused here too
    t.plugin.perms.deviceAssistant = false;
    await t.hcmd('aiHistoryList');
    assert.strictEqual(t.last('onAiError').code, 'denied');
    t.plugin.perms.deviceAssistant = true;
    await t.ai.handle(t.cmd('aiHistoryList', { _rights: 0x8 }), t.myparent, {});
    assert.strictEqual(t.last('onAiError').code, 'denied');
    t.close();
});

test('index: Explain and Diagnosis results are saved; saving off saves nothing; a save failure does not touch the turn', async function () {
    mock.always(CHAT, { sse: chatSse({ text: 'It means [E1].' }) });
    const t = setup();
    const ev = t.events.find(function (e) { return e.Id === 1000; });
    await t.start('explain', { eventId: ev._id });
    assert.ok(t.last('onAiDone'));
    await until(async function () { return !!(await t.hist.get('user/d/alice', F.NODE, 'explain', ev._id)); }, 'explain saved');
    const ex = await t.hist.get('user/d/alice', F.NODE, 'explain', ev._id);
    assert.strictEqual(ex.cites.E1._id, ev._id);
    await t.start('diagnose', { window: '7d' }, { reqId: 'd1' });
    await until(async function () { return !!(await t.hist.get('user/d/alice', F.NODE, 'diagnosis')); }, 'diagnosis saved');
    assert.strictEqual((await t.hist.get('user/d/alice', F.NODE, 'diagnosis')).window, '7d');
    t.close();

    const u = setup({ settings: { history: { enabled: false } } });
    await u.start('ask', { text: 'q' });
    assert.strictEqual(u.last('onAiStarted').chatId, null);
    assert.strictEqual(u.last('onAiDone').chatId, undefined);
    await sleep(30);
    assert.strictEqual(u.hdb.rows.size, 0);
    const a = await u.ai.accessInfo(u.myparent, u.node, 0xFFFFFFFF);
    assert.deepStrictEqual(a.saved, { enabled: false });
    u.close();

    const v = setup();
    v.hdb.aiChatPut = function () { return Promise.reject(new Error('boom')); };
    await v.start('ask', { text: 'q' });
    assert.ok(v.last('onAiDone'));
    assert.strictEqual(v.of('onAiError').length, 0);
    v.close();
});

test('accessInfo: saved results info and the starter questions for the device\'s OS', async function () {
    const t = setup();
    let a = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(a.saved, { enabled: true, retentionDays: 30 });
    assert.deepStrictEqual(a.starters, storeMod.STARTERS.windows);
    t.db.meta = { os: 'linux' };
    a = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(a.starters, storeMod.STARTERS.linux);
    t.store.settings.starters = { windows: null, linux: ['Is journald healthy?'] };
    t.store.settings.history = { enabled: true, retentionDays: 7 };
    a = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual([a.starters, a.saved.retentionDays], [['Is journald healthy?'], 7]);
    t.db.meta = { os: null };
    t.node.osdesc = 'FreeBSD 14';
    a = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(a.starters, storeMod.STARTERS.windows, 'unknown OS: the Windows list');
    t.plugin.perms.deviceAssistant = false;
    a = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.strictEqual('starters' in a || 'saved' in a, false, 'nothing without the permission');
    t.close();
});

test('settings: starters merge (clean, clamp, dedupe, factory -> null, reset) and history retention clamp', function () {
    const S = storeMod.STARTERS;
    let s = storeMod.mergeSettings(storeMod.DEFAULTS, {});
    assert.deepStrictEqual([s.starters, s.history], [{ windows: null, linux: null }, { enabled: true, retentionDays: 30 }]);
    s = storeMod.mergeSettings(s, { starters: { windows: [' Is the disk OK?\n', 'Is the disk OK?', '', 42, 'x'.repeat(250)].concat(Array(20).fill('q').map(function (q, i) { return q + i; })), linux: S.linux.slice() } });
    assert.strictEqual(s.starters.windows.length, 12);
    assert.strictEqual(s.starters.windows[0], 'Is the disk OK?');
    assert.strictEqual(s.starters.windows[1].length, 200);
    assert.strictEqual(s.starters.linux, null, 'the factory list is stored as null');
    s = storeMod.mergeSettings(s, { starters: { linux: [] } });
    assert.deepStrictEqual([s.starters.linux, s.starters.windows.length], [[], 12], 'an empty list is kept; windows untouched');
    assert.deepStrictEqual(storeMod.startersFor(s, 'linux'), []);
    s = storeMod.mergeSettings(s, { starters: { windows: null, linux: 'nope' } });
    assert.deepStrictEqual([s.starters.windows, s.starters.linux], [null, []], 'reset; a non-list is ignored');
    assert.deepStrictEqual(storeMod.startersFor(s, 'windows'), S.windows);
    assert.deepStrictEqual(storeMod.startersFor({}, 'mac'), S.windows);
    s = storeMod.mergeSettings(s, { history: { enabled: false, retentionDays: 0 } });
    assert.deepStrictEqual(s.history, { enabled: false, retentionDays: 1 });
    s = storeMod.mergeSettings(s, { history: { retentionDays: 99999, enabled: 'yes' } });
    assert.deepStrictEqual(s.history, { enabled: false, retentionDays: 3650 });
    // a stored document from before (no history / starters fields) gets the defaults
    s = storeMod.mergeSettings(storeMod.DEFAULTS, { enabled: true, starters: 'garbage', history: { retentionDays: 'x' } });
    assert.deepStrictEqual([s.starters, s.history], [{ windows: null, linux: null }, { enabled: true, retentionDays: 30 }]);
});
