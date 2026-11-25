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
    assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id, question: 'Why did it restart?', done: done('Power loss [E1].', { E1: rec('e1') }), steps: [{ tool: 'get_events', args: '{"limit":5}', ms: 3, items: 5, status: 'done' }, { note: 'Step limit reached: writing the answer with what was found so far.', kind: 'limit' }, { note: 'Let me check.', kind: 'other' }], endpointName: 'gpu', model: 'm1' }), true);
    x.clock.t += 1000;
    assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id, question: 'And before?', done: done('Nothing [E2].', { E2: rec('e2') }), steps: [], model: 'm1' }), true);
    const item = await h.get(U1, N1, 'chat', id);
    assert.strictEqual(item.title, 'Why did it restart?');
    assert.deepStrictEqual(item.messages.map(function (m) { return m.q; }), ['Why did it restart?', 'And before?']);
    assert.strictEqual(item.messages[0].cites.E1._id, 'e1');
    assert.deepStrictEqual(item.messages[0].steps, [{ tool: 'get_events', args: '{"limit":5}', status: 'done', items: 5, ms: 3 },
        { note: 'Step limit reached: writing the answer with what was found so far.', kind: 'limit' }, { note: 'Let me check.' }], 'limit entries keep their kind');
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

test('history: diagnoses are chats (all kept, marked in the list); an earlier saved diagnosis is migrated once; explanations per event', async function () {
    const x = makeHistory(), h = x.h;
    const d1 = h.newChatId(), d2 = h.newChatId();
    assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: d1, question: historyMod.diagQuestion('24h'), type: 'diagnosis', window: '24h', range: { from: 1, to: 2 },
        done: done('first', {}, { structured: { summary: 'The disk \uE002host\uE003PC01\uE004 stalls [E1]. Then it restarted.' } }) }), true);
    x.clock.t += 5000;
    await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: d2, question: historyMod.diagQuestion('7d'), type: 'diagnosis', window: '7d', range: { from: 3, to: 4 }, done: done('second', { E1: rec('e1') }, { structured: { summary: '' } }) });
    x.clock.t += 1000;
    await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: d2, question: 'And the power?', done: done('Fine.') });
    let l = await h.list(U1, N1);
    assert.deepStrictEqual(l.chats.map(function (c) { return [c.title, c.type, c.window, c.count]; }),
        [['Diagnosis of the last 7 days', 'diagnosis', '7d', 2], ['The disk PC01 stalls.', 'diagnosis', '24h', 1]], 'both kept, newest first, titles from the summary');
    assert.strictEqual(l.diagnosis, null);
    const c2 = await h.get(U1, N1, 'chat', d2);
    assert.deepStrictEqual([c2.type, c2.window, c2.range.from, c2.messages[0].q, c2.messages[1].q], ['diagnosis', '7d', 3, 'Diagnose the last 7 days', 'And the power?']);
    assert.strictEqual(await h.get(U2, N1, 'chat', d2), null);
    // a diagnosis saved by an earlier version (kind 'diagnosis') shows up as a diagnosis chat, once
    const oldId = 'dg' + 'f'.repeat(40);
    x.db.rows.set(oldId, { id: oldId, time: x.clock.t - 86400000, userid: U1, nodeid: N1, kind: 'diagnosis', meta: { window: 'restart' },
        doc: { time: x.clock.t - 86400000, generatedAt: x.clock.t - 86400000, window: 'restart', range: { from: 5, to: 6, restartAt: 6 }, text: 'Old text', structured: { v: 1, summary: 'Old summary [E2].', hypotheses: [] }, cites: { E2: rec('e2') }, steps: [{ tool: 'get_events', args: '{}', status: 'done', items: 2, ms: 1 }], model: 'old-model', endpointName: 'gpu' } });
    const [la, lb] = await Promise.all([h.list(U1, N1), h.list(U1, N1)]);
    assert.strictEqual(x.db.rows.has(oldId), false, 'the old item is gone');
    const mig = Array.from(x.db.rows.values()).filter(function (r) { return r.kind === 'chat' && r.meta.type === 'diagnosis' && r.meta.window === 'restart'; });
    assert.strictEqual(mig.length, 1, 'migrated once even with two lists at the same time');
    assert.ok(la.chats.concat(lb.chats).some(function (c) { return c.id === mig[0].id; }));
    l = await h.list(U1, N1);
    assert.deepStrictEqual(l.chats.map(function (c) { return c.title; }), ['Diagnosis of the last 7 days', 'The disk PC01 stalls.', 'Old summary.']);
    const m = await h.get(U1, N1, 'chat', mig[0].id);
    assert.deepStrictEqual([m.type, m.window, m.messages.length, m.messages[0].q, m.messages[0].a, m.messages[0].structured.summary, m.messages[0].cites.E2._id, m.messages[0].model],
        ['diagnosis', 'restart', 1, 'Diagnose around the last restart', 'Old text', 'Old summary [E2].', 'e2', 'old-model']);
    // another user's old diagnosis is not migrated into this user's list
    x.db.rows.set('dgbob', { id: 'dgbob', time: x.clock.t, userid: U2, nodeid: N1, kind: 'diagnosis', meta: {}, doc: { text: 'b' } });
    assert.strictEqual((await h.list(U1, N1)).chats.length, 3);
    assert.ok(x.db.rows.has('dgbob'));
    // explanations
    await h.saveExplain({ userid: U1, nodeid: N1, eventId: 'e1', done: done('means A', {}, { structured: { meaning: 'A' } }) });
    await h.saveExplain({ userid: U1, nodeid: N1, eventId: 'e2', done: done('means B') });
    await h.saveExplain({ userid: U1, nodeid: N1, eventId: 'e1', done: done('means A again') });
    assert.strictEqual((await h.get(U1, N1, 'explain', 'e1')).text, 'means A again');
    assert.strictEqual((await h.get(U2, N1, 'explain', 'e1')), null);
    l = await h.list(U1, N1);
    assert.deepStrictEqual(l.explains.map(function (e) { return e.eventId; }).sort(), ['e1', 'e2']);
    assert.deepStrictEqual(await h.counts(), { chat: 3, diagnosis: 1, explain: 2, total: 6 });
});

test('history: editChat deletes or truncates messages of the owner\'s chat only; the diagnosis or the last message deletes the chat', async function () {
    const x = makeHistory(), h = x.h;
    const id = h.newChatId();
    for (const q of ['q0', 'q1', 'q2', 'q3']) { x.clock.t += 10; await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id, question: q, done: done('a ' + q, { E1: rec('e1') }) }); }
    // scope: another user or device, a bad id, op or index
    assert.deepStrictEqual(await h.editChat(U2, N1, id, 1, 'delete'), { ok: false, code: 'notFound' });
    assert.deepStrictEqual(await h.editChat(U1, N2, id, 1, 'delete'), { ok: false, code: 'notFound' });
    assert.deepStrictEqual(await h.editChat(U1, N1, '../x', 1, 'delete'), { ok: false, code: 'notFound' });
    assert.deepStrictEqual(await h.editChat(U1, N1, id, 1, 'drop'), { ok: false, code: 'invalid' });
    assert.deepStrictEqual(await h.editChat(U1, N1, id, -1, 'delete'), { ok: false, code: 'invalid' });
    assert.deepStrictEqual(await h.editChat(U1, N1, id, 9, 'delete'), { ok: false, code: 'changed' });
    assert.deepStrictEqual(await h.editChat(U1, N1, id, 1, 'delete', 'not q1'), { ok: false, code: 'changed' }, 'the question must match');
    assert.strictEqual((await h.get(U1, N1, 'chat', id)).messages.length, 4, 'nothing changed');
    let r = await h.editChat(U1, N1, id, 1, 'delete', 'q1');
    assert.deepStrictEqual([r.ok, r.item.messages.map(function (m) { return m.q; })], [true, ['q0', 'q2', 'q3']]);
    assert.strictEqual(x.db.rows.get(id).meta.count, 3);
    r = await h.editChat(U1, N1, id, 1, 'truncate', 'q2');
    assert.deepStrictEqual(r.item.messages.map(function (m) { return m.q; }), ['q0']);
    assert.strictEqual((await h.list(U1, N1)).chats[0].count, 1);
    r = await h.editChat(U1, N1, id, 0, 'truncate');
    assert.deepStrictEqual(r, { ok: true, deleted: true }, 'the last message: the chat goes');
    assert.strictEqual(x.db.rows.has(id), false);
    // a diagnosis chat: deleting the diagnosis deletes the whole chat
    const dg = h.newChatId();
    await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: dg, question: 'Diagnose the last 24 hours', type: 'diagnosis', window: '24h', done: done('d', {}, { structured: { summary: 'S.' } }) });
    await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: dg, question: 'f1', done: done('x') });
    await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: dg, question: 'f2', done: done('y') });
    r = await h.editChat(U1, N1, dg, 1, 'delete');
    assert.deepStrictEqual([r.item.type, r.item.messages.map(function (m) { return m.q; })], ['diagnosis', ['Diagnose the last 24 hours', 'f2']]);
    assert.deepStrictEqual(await h.editChat(U1, N1, dg, 0, 'delete'), { ok: true, deleted: true });
    assert.strictEqual(x.db.rows.has(dg), false);
});

test('history: command outputs of a question are saved (5 at most, 64 KB each, an earlier { shell, cmd } as a list); the oldest are shortened first to fit 512 KB', async function () {
    const x = makeHistory(), h = x.h;
    const id = h.newChatId();
    const item = function (i, out) { return { shell: 'powershell', cmd: 'Get-Thing ' + i, output: out, truncated: false, ok: true, ms: 120.4 }; };
    const six = []; for (let i = 0; i < 6; i++) six.push(item(i, 'out ' + i));
    assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id, question: '', done: done('a'), attach: six }), true);
    let it = await h.get(U1, N1, 'chat', id);
    assert.strictEqual(it.title, 'Get-Thing 0', 'only outputs: named after the first command');
    assert.strictEqual(it.messages[0].q, '');
    assert.strictEqual(it.messages[0].attach.length, 5);
    assert.deepStrictEqual(it.messages[0].attach[1], { shell: 'powershell', cmd: 'Get-Thing 1', output: 'out 1', truncated: false, ok: true, ms: 120 });
    // an output over 64 KB is cut (truncated); the earlier single form; junk is dropped
    x.clock.t += 10;
    await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id, question: 'q2', done: done('b'), attach: [item(9, 'ü'.repeat(40000)), { shell: '', cmd: 'x' }, 'junk'] });
    x.clock.t += 10;
    await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id, question: 'q3', done: done('c'), attach: { shell: 'bash', cmd: 'df -h' } });
    it = await h.get(U1, N1, 'chat', id);
    const a2 = it.messages[1].attach;
    assert.strictEqual(a2.length, 1);
    assert.ok(Buffer.byteLength(a2[0].output, 'utf8') <= 64 * 1024 && a2[0].truncated === true);
    assert.deepStrictEqual(it.messages[2].attach, [{ shell: 'bash', cmd: 'df -h' }]);
    // many large outputs: the oldest are shortened (to 2000 characters, trimmed) before any message goes
    const id2 = h.newChatId(), five = function (k) { const l = []; for (let i = 0; i < 5; i++) l.push(item(k * 10 + i, String(k) + 'O'.repeat(60000))); return l; };
    for (let k = 0; k < 6; k++) { x.clock.t += 10; assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N1, chatId: id2, question: 'm' + k, done: done('ans ' + k), attach: five(k) }), true); }
    const raw = x.db.rows.get(id2);
    assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= historyMod.MAX_DOC, 'within 512 KB: ' + Buffer.byteLength(JSON.stringify(raw)));
    const ms = raw.doc.messages;
    assert.strictEqual(ms.length, 6, 'no message dropped');
    assert.ok(ms[0].attach.every(function (a) { return a.trimmed === true && a.output.length === 2000; }), 'the oldest shortened');
    assert.ok(ms[5].attach.every(function (a) { return !a.trimmed && a.output.length === 60001; }), 'the newest kept');
    assert.ok(ms.every(function (m) { return m.a.indexOf('ans ') === 0; }), 'the answers stay');
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
    const dgId = h.newChatId();
    assert.strictEqual(await h.saveChatTurn({ userid: U1, nodeid: N2, chatId: dgId, question: 'Diagnose the last 24 hours', type: 'diagnosis', window: '24h', done: done('D'.repeat(600000), d, { structured: { summary: 'S'.repeat(300000) } }) }), true);
    assert.ok(Buffer.byteLength(JSON.stringify(x.db.rows.get(dgId))) <= historyMod.MAX_DOC);
    assert.strictEqual(x.db.rows.get(dgId).meta.type, 'diagnosis');
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
    await h.saveChatTurn({ userid: U2, nodeid: N2, chatId: h.newChatId(), question: 'Diagnose the last 24 hours', type: 'diagnosis', window: '24h', done: done('d') });
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
    const dd = t.of('onAiDone').pop();
    assert.match(dd.chatId, /^ch[0-9a-f]{24}$/, 'a diagnosis is saved as a chat');
    assert.strictEqual(t.of('onAiStarted').pop().chatId, dd.chatId);
    await until(async function () { return !!(await t.hist.get('user/d/alice', F.NODE, 'chat', dd.chatId)); }, 'diagnosis saved');
    const dc = await t.hist.get('user/d/alice', F.NODE, 'chat', dd.chatId);
    assert.deepStrictEqual([dc.type, dc.window, dc.messages[0].q], ['diagnosis', '7d', 'Diagnose the last 7 days']);
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

function diagReply(refs) {
    const d = { v: 1, summary: 'The print spooler on PC-ALICE01 crashes [' + refs[0] + '].', hypotheses: [{ id: 'h1', title: 'Broken printer driver', status: 'likely', confidence: 0.8, why: 'Repeated 7031 [' + refs[0] + '].', evidence: [refs[0]] }],
                nextSteps: [{ text: 'Reinstall the driver' }] };
    return { sse: chatSse({ text: 'Done.\n<diagnosis>' + JSON.stringify(d) + '</diagnosis>' }) };
}
function userMsgs(r) { return r.body.messages.filter(function (m) { return m.role === 'user'; }).map(function (m) { return m.content; }); }

test('index: a diagnosis is a chat; follow-ups continue its session with the Ask task; continued later, the recap has the diagnosis and its events', async function () {
    let refs = [];
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { filters: { levels: ['err'] }, limit: 5 } }] }) },
        function (rec) { refs = refsIn(rec.bodyText); return diagReply(refs); },
        function () { return { sse: chatSse({ text: 'Yes, see [' + refs[0] + '].' }) }; });
    const t = setup();
    await t.start('diagnose', { window: '24h' });
    const d1 = t.last('onAiDone');
    assert.ok(d1 && d1.structured, t.ws.sent.map(function (m) { return m.method + (m.code ? ':' + m.code : ''); }).join(','));
    const convId = t.last('onAiStarted').convId, chatId = d1.chatId;
    assert.match(chatId, /^ch[0-9a-f]{24}$/);
    assert.match(chatReqs()[0].body.messages[0].content, /Task: diagnose/);
    await t.send(convId, 'Is the driver really broken?');
    const d2 = t.of('onAiDone').pop();
    assert.ok(d2 && d2.turn === 2, t.ws.sent.map(function (m) { return m.method + (m.code ? ':' + m.code : ''); }).join(','));
    assert.deepStrictEqual(d2.invalidCitations, [], 'the diagnosis\'s refs stay valid');
    assert.strictEqual(d2.chatId, chatId);
    const r3 = chatReqs()[2].body;
    assert.match(r3.messages[0].content, /Task: answer the technician's questions/, 'follow-ups get the Ask task');
    assert.ok(r3.messages.some(function (m) { return m.role === 'assistant' && /<diagnosis>/.test(m.content || ''); }), 'the same model session: the diagnosis is in the transcript');
    await until(async function () { const c = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId); return c && c.messages.length === 2; }, 'saved');
    const c = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId);
    assert.deepStrictEqual([c.type, c.messages[0].q, c.messages[1].q], ['diagnosis', 'Diagnose the last 24 hours', 'Is the driver really broken?']);
    assert.strictEqual(c.title, 'The print spooler on PC-ALICE01 crashes.');
    t.ai.sessions.closeAll('test');
    // later: the saved diagnosis chat continues in a new session with a recap of the diagnosis
    mock.reset();
    mock.script(CHAT, function () { return { sse: chatSse({ text: 'Still [' + refs[0] + '].' }) }; });
    await t.start('ask', { text: 'Did it crash again?' }, { chatId: chatId, reqId: 'r9' });
    const u = userMsgs(chatReqs()[0])[0];
    assert.match(u, /Diagnosis summary: The print spooler on HOST_\d+ crashes \[E\d+\]/);
    assert.match(u, /- Broken printer driver \(likely, about 80%\): .*Evidence: E\d+\./);
    assert.match(u, /Next steps suggested:\n1\. Reinstall the driver/);
    assert.ok(u.indexOf(refs[0] + ': ') >= 0, 'the cited event is listed under its ref');
    const d3 = t.of('onAiDone').pop();
    assert.deepStrictEqual([d3.chatId, d3.invalidCitations], [chatId, []]);
    t.close();
});

test('index: aiChatEdit on a saved chat (owner and device only, never while running); the next question gets a recap of what is left, citations stay valid', async function () {
    let refs = [];
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { filters: { levels: ['err'] }, limit: 5 } }] }) },
        function (rec) { refs = refsIn(rec.bodyText); return { sse: chatSse({ text: 'First answer [' + refs[0] + '].' }) }; },
        function () { return { sse: chatSse({ text: 'Second answer [' + refs[1] + '].' }) }; },
        function () { return { sse: chatSse({ text: 'Third answer.' }) }; });
    const t = setup();
    await t.start('ask', { text: 'one' });
    const convId = t.last('onAiStarted').convId, chatId = t.last('onAiDone').chatId;
    await t.send(convId, 'two');
    await t.send(convId, 'three');
    await until(async function () { const c = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId); return c && c.messages.length === 3; }, 'saved');
    const edited = function (who) { return (who || t.myparent).ws.sent.filter(function (m) { return m.method === 'onAiChatEdited'; }).pop(); };
    // another user, another device, bad input: refused, nothing changes
    const bob = other(t, { _id: 'user/d/bob', name: 'bob' });
    await t.hcmd('aiChatEdit', { chatId: chatId, index: 1, op: 'delete' }, bob);
    assert.deepStrictEqual([edited(bob).ok, edited(bob).code], [false, 'notFound']);
    await t.ai.handle(Object.assign(t.cmd('aiChatEdit', { chatId: chatId, index: 1, op: 'delete' }), { nodeid: 'node/d/nB', _node: Object.assign({}, t.node, { _id: 'node/d/nB' }) }), t.myparent, {});
    assert.deepStrictEqual([edited().ok, edited().code, edited().nodeid], [false, 'notFound', 'node/d/nB']);
    await t.hcmd('aiChatEdit', { chatId: chatId, index: 1, op: 'explode' });
    assert.strictEqual(edited().code, 'invalid');
    await t.hcmd('aiChatEdit', { chatId: chatId, index: 1, op: 'delete', q: 'not two' });
    assert.strictEqual(edited().code, 'changed');
    t.plugin.perms.deviceAssistant = false;
    await t.hcmd('aiChatEdit', { chatId: chatId, index: 1, op: 'delete' });
    assert.strictEqual(t.last('onAiError').code, 'denied');
    t.plugin.perms.deviceAssistant = true;
    assert.strictEqual((await t.hist.get('user/d/alice', F.NODE, 'chat', chatId)).messages.length, 3);
    // while a request of this chat runs: busy
    mock.script(CHAT, { sse: chatSse({ text: 'slow' }), hang: true });
    const p = t.send(convId, 'four');
    await F.waitFor(t.ws, 'onAiDelta', function (m) { return m.turn === 4; });
    await t.hcmd('aiChatEdit', { chatId: chatId, index: 1, op: 'delete' });
    assert.deepStrictEqual([edited().ok, edited().code], [false, 'busy']);
    await t.ai.handle(t.cmd('aiStop', { convId: convId }), t.myparent, {});
    await p;
    // retry the second answer: truncate at 1; the open session is closed
    await t.hcmd('aiChatEdit', { chatId: chatId, index: 1, op: 'truncate', q: 'two' });
    const e = edited();
    assert.deepStrictEqual([e.ok, e.deleted, e.chatId, e.chat.messages.map(function (m) { return m.q; })], [true, false, chatId, ['one']]);
    assert.strictEqual(t.ai.sessions.get(convId), null, 'the session of the chat is closed');
    mock.reset();
    mock.script(CHAT, function () { return { sse: chatSse({ text: 'Retried [' + refs[0] + '].' }) }; });
    await t.start('ask', { text: 'two' }, { chatId: chatId, reqId: 'r5' });
    const u = userMsgs(chatReqs()[0])[0];
    assert.match(u, /Technician asked: one/);
    assert.ok(u.indexOf('Second answer') < 0 && u.indexOf('Third answer') < 0, 'the removed answers are not in the recap');
    assert.ok(u.indexOf(refs[0] + ': ') >= 0);
    const dn = t.of('onAiDone').pop();
    assert.deepStrictEqual([dn.invalidCitations, dn.citations[refs[0]] != null], [[], true], 'the remaining citation stays valid');
    await until(async function () { const c = await t.hist.get('user/d/alice', F.NODE, 'chat', chatId); return c && c.messages.length === 2; }, 'saved again');
    // delete the first: the rest stays; the last one: the chat goes
    await t.hcmd('aiChatEdit', { chatId: chatId, index: 0, op: 'delete', q: 'one' });
    assert.deepStrictEqual(edited().chat.messages.map(function (m) { return m.q; }), ['two']);
    await t.hcmd('aiChatEdit', { chatId: chatId, index: 0, op: 'delete' });
    assert.deepStrictEqual([edited().ok, edited().deleted, edited().chat], [true, true, null]);
    assert.strictEqual(t.hdb.rows.has(chatId), false);
    t.close();
});

test('index: aiChatEdit without saving works on the conversation\'s own messages; a new model session with a recap follows', async function () {
    let refs = [];
    mock.script(CHAT,
        { sse: chatSse({ calls: [{ id: 'c1', name: 'get_events', args: { filters: { levels: ['err'] }, limit: 5 } }] }) },
        function (rec) { refs = refsIn(rec.bodyText); return { sse: chatSse({ text: 'Answer one [' + refs[0] + '].' }) }; },
        function () { return { sse: chatSse({ text: 'Answer two.' }) }; },
        function () { return { sse: chatSse({ text: 'Answer three.' }) }; },
        function () { return { sse: chatSse({ text: 'Answer two again [' + refs[0] + '].' }) }; });
    const t = setup({ settings: { history: { enabled: false } } });
    await t.start('ask', { text: 'one' });
    const convId = t.last('onAiStarted').convId;
    await t.send(convId, 'two');
    await t.send(convId, 'three');
    const edited = function (who) { return (who || t.myparent).ws.sent.filter(function (m) { return m.method === 'onAiChatEdited'; }).pop(); };
    // only the owner's connection
    const bob = other(t, { _id: 'user/d/bob', name: 'bob' });
    await t.hcmd('aiChatEdit', { convId: convId, index: 1, op: 'truncate' }, bob);
    assert.deepStrictEqual([edited(bob).ok, edited(bob).code], [false, 'notFound']);
    await t.hcmd('aiChatEdit', { convId: convId, index: 1, op: 'truncate', q: 'two' });
    assert.deepStrictEqual([edited().ok, edited().count, edited().convId], [true, 1, convId]);
    await t.send(convId, 'two, edited');
    const last = chatReqs().pop().body;
    const users = userMsgs({ body: last });
    assert.strictEqual(users.length, 1, 'a new model session: only the new question (with the recap)');
    assert.match(users[0], /label=recap>>>[\s\S]*Technician asked: one[\s\S]*Answer one/);
    assert.ok(users[0].indexOf('Answer two.') < 0 && users[0].indexOf('Answer three') < 0);
    assert.match(users[0], /two, edited$/);
    assert.deepStrictEqual(t.of('onAiDone').pop().invalidCitations, []);
    // deleting the only message left closes the conversation
    await t.hcmd('aiChatEdit', { convId: convId, index: 0, op: 'delete', q: 'one' });
    assert.deepStrictEqual([edited().ok, edited().count], [true, 1]);
    await t.hcmd('aiChatEdit', { convId: convId, index: 0, op: 'delete' });
    assert.deepStrictEqual([edited().ok, edited().deleted], [true, true]);
    assert.strictEqual(t.ai.sessions.get(convId), null);
    t.close();
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
    t.db.meta = { os: 'macos', caps: { log: true, osver: '14.5' } };
    a = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(a.starters, storeMod.STARTERS.macos, 'macOS: its own list (settings stored before macOS support have none)');
    t.store.settings.starters = { windows: null, linux: null, macos: ['Is FileVault on?'] };
    a = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(a.starters, ['Is FileVault on?']);
    t.db.meta = null;
    t.node.agent = { ver: 0, id: 29, caps: 15 };   // an Apple silicon agent that never reported: macOS from the agent id
    a = await t.ai.accessInfo(t.myparent, t.node, 0xFFFFFFFF);
    assert.deepStrictEqual(a.starters, ['Is FileVault on?']);
    t.node.agent = { ver: 0, id: 4, caps: 15 };
    t.store.settings.starters = { windows: null, linux: ['Is journald healthy?'] };
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
    assert.deepStrictEqual([s.starters, s.history], [{ windows: null, linux: null, macos: null }, { enabled: true, retentionDays: 30 }]);
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
    assert.deepStrictEqual(storeMod.startersFor(s, 'macos'), S.macos, 'no macOS list stored: the factory list');
    assert.deepStrictEqual(storeMod.startersFor(s, 'android'), [], 'Android: none (no event logs)');
    assert.deepStrictEqual(storeMod.startersFor(s, null), S.windows);
    assert.deepStrictEqual(Object.keys(S), ['windows', 'linux', 'macos']);
    assert.ok(S.macos.length >= 3 && S.macos.length <= 12 && S.macos.every(function (q) { return q.length <= 200; }));
    // a stored document from before macOS support (windows / linux only) keeps its lists and gets macOS null
    let old = storeMod.mergeSettings(storeMod.DEFAULTS, {});
    old = storeMod.mergeSettings(Object.assign({}, old, { starters: { windows: ['A?'], linux: ['B?'] } }), {});
    assert.deepStrictEqual(old.starters, { windows: ['A?'], linux: ['B?'], macos: null });
    old = storeMod.mergeSettings(old, { starters: { macos: S.macos.slice() } });
    assert.strictEqual(old.starters.macos, null, 'the macOS factory list is stored as null');
    old = storeMod.mergeSettings(old, { starters: { macos: ['Is FileVault on?'] } });
    assert.deepStrictEqual(old.starters, { windows: ['A?'], linux: ['B?'], macos: ['Is FileVault on?'] });
    s = storeMod.mergeSettings(s, { history: { enabled: false, retentionDays: 0 } });
    assert.deepStrictEqual(s.history, { enabled: false, retentionDays: 1 });
    s = storeMod.mergeSettings(s, { history: { retentionDays: 99999, enabled: 'yes' } });
    assert.deepStrictEqual(s.history, { enabled: false, retentionDays: 3650 });
    // a stored document from before (no history / starters fields) gets the defaults
    s = storeMod.mergeSettings(storeMod.DEFAULTS, { enabled: true, starters: 'garbage', history: { retentionDays: 'x' } });
    assert.deepStrictEqual([s.starters, s.history], [{ windows: null, linux: null, macos: null }, { enabled: true, retentionDays: 30 }]);
});
