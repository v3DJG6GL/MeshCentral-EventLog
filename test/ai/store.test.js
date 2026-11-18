'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const secretsMod = require('../../ai/secrets.js');
const ng = require('../../ai/netguard.js');
const storeMod = require('../../ai/store.js');

// In-memory stand-in for the db.js / db_sql.js Assistant helpers.
function fakeDb() {
    const docs = new Map(), audit = [];
    let auditSeq = 0;
    const db = {
        docs: docs, audit: audit, configSets: [],
        aiPutDoc: async function (id, type, doc) {
            const d = JSON.parse(JSON.stringify(Object.assign({}, doc, { _id: id, type: type })));
            for (const k of Object.keys(d)) if (k.indexOf('.') >= 0 || k[0] === '$') throw new Error('bad key ' + k);
            docs.set(id, d); return true;
        },
        aiGetDoc: async function (id) { const d = docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; },
        aiDocs: async function (type) { return Array.from(docs.values()).filter(function (d) { return d.type === type; }).map(function (d) { return JSON.parse(JSON.stringify(d)); }); },
        aiDelDoc: async function (id) { return docs.delete(id) ? 1 : 0; },
        aiAuditAdd: async function (rec) {
            (function walk(v) {
                if (v && typeof v === 'object') for (const k of Object.keys(v)) {
                    if (k.indexOf('.') >= 0 || k[0] === '$') throw new Error('NeDB would refuse key ' + k);
                    walk(v[k]);
                }
            })(rec);
            audit.push(Object.assign({ _id: String(++auditSeq) }, JSON.parse(JSON.stringify(rec)))); return true;
        },
        aiAuditQuery: async function (q) {
            q = q || {};
            let rows = audit.filter(function (r) {
                return (q.since == null || r.time >= q.since) && (q.until == null || r.time <= q.until) &&
                    (q.userid == null || r.userid === q.userid) && (q.nodeid == null || r.nodeid === q.nodeid);
            }).sort(function (a, b) { return b.time - a.time; });
            const total = rows.length;
            rows = rows.slice(q.skip || 0, (q.skip || 0) + (q.limit || 100));
            return { rows: JSON.parse(JSON.stringify(rows)), total: total };
        },
        aiAuditSweep: async function (cutoff) {
            let n = 0;
            for (let i = audit.length - 1; i >= 0; i--) if (audit[i].time < cutoff) { audit.splice(i, 1); n++; }
            db.lastCutoff = cutoff;
            return n;
        },
        getAllConfigSets: async function () { return JSON.parse(JSON.stringify(db.configSets)); }
    };
    return db;
}

// resolver: hostname -> [addresses] | Error code string
function resolverFrom(map) {
    return function (host, opts, cb) {
        const v = map[host];
        setImmediate(function () {
            if (v == null || typeof v === 'string') { const e = new Error('dns'); e.code = v || 'ENOTFOUND'; return cb(e); }
            cb(null, v.map(function (a) { return { address: a, family: a.indexOf(':') >= 0 ? 6 : 4 }; }));
        });
    };
}
function fakeNetguard(map) {
    const resolver = resolverFrom(map || {});
    return { check: function (u, o) { return ng.check(u, Object.assign({ resolver: resolver, timeoutMs: 1000 }, o || {})); }, resolver: resolver };
}

const tmpDirs = [];
function makeSecrets(env) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evl-store-'));
    tmpDirs.push(d);
    return secretsMod.create({ keyFile: path.join(d, 'plugin-eventlog-ai.key'), fallbackSecret: 'x', log: function () { }, env: env || {} });
}
test.after(function () { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup(extra) {
    extra = extra || {};
    const db = fakeDb();
    const logs = [];
    const secrets = makeSecrets(extra.env);
    const store = storeMod.create({ db: db, secrets: secrets, netguard: fakeNetguard(extra.dns || { 'llm.lan': ['192.168.1.20'], 'api.example.com': ['93.184.216.34'] }), log: function (m) { logs.push(m); } });
    return { db: db, store: store, secrets: secrets, logs: logs };
}

const BASE = { name: 'Local Ollama', format: 'openai-chat', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/', model: 'llama3.1:8b' };
const KEY = 'sk-test-SECRET-0123456789wxyz';

test('saveEndpoint: validation errors', async function () {
    const { store } = setup();
    const bad = [
        [{}, /Name/],
        [Object.assign({}, BASE, { name: 'x'.repeat(65) }), /Name/],
        [Object.assign({}, BASE, { format: 'gemini' }), /format/i],
        [Object.assign({}, BASE, { baseUrl: 'ftp://h/x' }), /http/],
        [Object.assign({}, BASE, { baseUrl: 'http://u:p@127.0.0.1/v1' }), /password/i],
        [Object.assign({}, BASE, { baseUrl: 'not a url' }), /valid URL/],
        [Object.assign({}, BASE, { baseUrl: 'http://127.0.0.1/v1?x=1' }), /query/],
        [Object.assign({}, BASE, { model: '' }), /Model/],
        [Object.assign({}, BASE, { model: 'm'.repeat(201) }), /Model/],
        [Object.assign({}, BASE, { contextTokens: 100 }), /Context size/],
        [Object.assign({}, BASE, { numCtx: 5e6 }), /Ollama context/],
        [Object.assign({}, BASE, { maxOutputTokens: 10 }), /answer length/],
        [Object.assign({}, BASE, { timeoutSec: 5 }), /Timeout/],
        [Object.assign({}, BASE, { timeoutSec: 12.5 }), /Timeout/],
        [Object.assign({}, BASE, { baseUrl: 'http://169.254.169.254/v1' }), /metadata/],
        [Object.assign({}, BASE, { baseUrl: 'http://0.0.0.0:11434/v1' }), /not allowed/],
        [Object.assign({}, BASE, { id: 'aiEndpoint:000000000000' }), /not found/]
    ];
    for (const [input, re] of bad) {
        await assert.rejects(store.saveEndpoint(input, { keyAction: 'keep' }), function (e) { assert.match(e.message, re, JSON.stringify(input)); assert.ok(e.code === 'invalid' || e.code === 'notFound'); return true; });
    }
    await assert.rejects(store.saveEndpoint(BASE, { keyAction: 'bogus' }), /key action/);
    await assert.rejects(store.saveEndpoint(BASE, { keyAction: 'set', key: '' }), /API key/);
    await assert.rejects(store.saveEndpoint(BASE, { keyAction: 'set', key: 'env:lower-case' }), /Environment variable/);
    await assert.rejects(store.saveEndpoint(BASE, { keyAction: 'set', key: 'sk with space' }), /spaces/);
    assert.deepStrictEqual(await store.listEndpoints(), []);
});

test('saveEndpoint: normalises, records network, unique names, link-local opt-in', async function () {
    const { store } = setup();
    const ep = await store.saveEndpoint(Object.assign({ timeoutSec: '60', numCtx: 32768, contextTokens: '' }, BASE), {});
    assert.match(ep.id, /^aiEndpoint:[0-9a-f]{12}$/);
    assert.strictEqual(ep.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.strictEqual(ep.network, 'loopback');
    assert.strictEqual(ep.timeoutSec, 60);
    assert.strictEqual(ep.numCtx, 32768);
    assert.strictEqual(ep.contextTokens, null);
    assert.strictEqual(ep.maxOutputTokens, null);
    assert.strictEqual(ep.toolMode, 'auto');
    assert.strictEqual(ep.key, null);
    assert.strictEqual(ep.warning, undefined);
    await assert.rejects(store.saveEndpoint(Object.assign({}, BASE, { name: 'local OLLAMA' }), {}), /already uses this name/);
    // renaming itself to a case variant is fine
    const ren = await store.saveEndpoint(Object.assign({}, BASE, { id: ep.id, name: 'LOCAL ollama' }), {});
    assert.strictEqual(ren.id, ep.id);
    const lan = await store.saveEndpoint({ name: 'LAN', format: 'anthropic', baseUrl: 'https://llm.lan/v1', model: 'm' }, {});
    assert.strictEqual(lan.network, 'private');
    assert.strictEqual(lan.preset, 'custom');
    const pub = await store.saveEndpoint({ name: 'Pub', format: 'openai-responses', baseUrl: 'https://api.example.com/v1', model: 'm' }, {});
    assert.strictEqual(pub.network, 'public');
    const ll = await store.saveEndpoint({ name: 'LL', baseUrl: 'http://169.254.10.10:8080/v1', model: 'm', allowLinkLocal: true }, {});
    assert.strictEqual(ll.network, 'private');
    assert.strictEqual(ll.allowLinkLocal, true);
    assert.deepStrictEqual((await store.listEndpoints()).map(function (e) { return e.name; }), ['LAN', 'LL', 'LOCAL ollama', 'Pub']);
    const got = await store.getEndpoint(ep.id);
    assert.strictEqual(got.id, ep.id);
    assert.strictEqual(got._id, undefined);
    assert.strictEqual(got.type, undefined);
    assert.strictEqual(await store.getEndpoint('nope'), null);
});

test('saveEndpoint: DNS failure is not fatal (network null + warning)', async function () {
    const { store } = setup();
    const ep = await store.saveEndpoint({ name: 'Later', baseUrl: 'https://not-yet.example/v1', model: 'm' }, {});
    assert.strictEqual(ep.network, null);
    assert.match(ep.warning, /DNS lookup failed/);
    assert.ok(!Object.keys(ep).includes('warning'));
    assert.strictEqual((await store.getEndpoint(ep.id)).warning, undefined);
});

test('keys: set / keep / remove / env, AAD bound to the id, never in publicEndpoint', async function () {
    const { store, db } = setup({ env: { LLM_KEY: 'from-env-value-1234' } });
    let ep = await store.saveEndpoint(BASE, { keyAction: 'set', key: '  ' + KEY + '  ' });
    assert.strictEqual(ep.key.v, 1);
    assert.strictEqual(ep.key.last4, 'wxyz');
    assert.ok(!JSON.stringify(Array.from(db.docs.values())).includes(KEY));
    assert.strictEqual(store.resolveKey(ep), KEY);
    // AAD = id: the ciphertext copied to another endpoint id does not decrypt
    assert.strictEqual(store.resolveKey(Object.assign({}, ep, { id: 'aiEndpoint:ffffffffffff' })), null);
    let pub = store.publicEndpoint(ep);
    assert.strictEqual(pub.hasKey, true);
    assert.strictEqual(pub.keyHint, '…wxyz');
    assert.ok(!('key' in pub));
    assert.ok(!JSON.stringify(pub).includes(KEY) && !JSON.stringify(pub).includes(ep.key.ct));

    // keep (default) survives an address change to another host
    ep = await store.saveEndpoint(Object.assign({}, BASE, { id: ep.id, baseUrl: 'https://llm.lan/v1' }));
    assert.strictEqual(store.resolveKey(ep), KEY);
    ep = await store.saveEndpoint(Object.assign({}, BASE, { id: ep.id }), { keyAction: 'set', key: 'env:LLM_KEY' });
    assert.deepStrictEqual(ep.key, { env: 'LLM_KEY' });
    assert.strictEqual(store.resolveKey(ep), 'from-env-value-1234');
    pub = store.publicEndpoint(ep);
    assert.strictEqual(pub.keyHint, 'env:LLM_KEY');
    assert.strictEqual(pub.hasKey, true);
    ep = await store.saveEndpoint(Object.assign({}, BASE, { id: ep.id }), { keyAction: 'remove' });
    assert.strictEqual(ep.key, null);
    assert.strictEqual(store.resolveKey(ep), null);
    pub = store.publicEndpoint(ep);
    assert.strictEqual(pub.hasKey, false);
    assert.strictEqual(pub.keyHint, '');
    // short key -> no last4 hint
    ep = await store.saveEndpoint(Object.assign({}, BASE, { id: ep.id }), { keyAction: 'set', key: 'short' });
    assert.strictEqual(store.publicEndpoint(ep).keyHint, '');
    assert.strictEqual(store.resolveKey(ep), 'short');
    assert.strictEqual(store.resolveKey({ id: 'x', key: { v: 1, iv: 'zz', ct: 'zz', tag: 'zz' } }), null);
    assert.strictEqual(store.resolveKey(null), null);
});

test('caps / quirks / lastTest; target change clears them; acks', async function () {
    const { store } = setup();
    let ep = await store.saveEndpoint(BASE, {});
    await store.setCaps(ep.id, { tools: true, ctx: 131072, server: 'ollama 0.12', at: 5 });
    await store.setQuirks(ep.id, { useMaxCompletionTokens: true });
    await store.setQuirks(ep.id, { noStreamOptions: true });
    await store.setLastTest(ep.id, { ok: true, at: 7, ms: 42, detail: 'x'.repeat(400) });
    ep = await store.getEndpoint(ep.id);
    assert.deepStrictEqual(ep.caps, { tools: true, ctx: 131072, server: 'ollama 0.12', at: 5 });
    assert.deepStrictEqual(ep.quirks, { useMaxCompletionTokens: true, noStreamOptions: true });
    assert.strictEqual(ep.lastTest.detail.length, 300);
    assert.strictEqual(await store.setCaps('aiEndpoint:000000000000', {}), null);
    // rename only: caches kept
    ep = await store.saveEndpoint(Object.assign({}, BASE, { id: ep.id, name: 'Renamed' }), {});
    assert.ok(ep.caps && ep.quirks && ep.lastTest);

    assert.strictEqual(await store.getAck('user/d/alice', ep.id), false);
    assert.strictEqual(await store.setAck('user/d/alice', ep.id), true);
    assert.strictEqual(await store.getAck('user/d/alice', ep.id), true);
    assert.strictEqual(await store.getAck('user/d/bob', ep.id), false);
    assert.strictEqual(await store.setAck('', ep.id), false);
    // model change: caches cleared; address change: acknowledgements cleared too
    ep = await store.saveEndpoint(Object.assign({}, BASE, { id: ep.id, name: 'Renamed', model: 'qwen3' }), {});
    assert.strictEqual(ep.caps, null); assert.strictEqual(ep.quirks, null); assert.strictEqual(ep.lastTest, null);
    assert.strictEqual(await store.getAck('user/d/alice', ep.id), true);
    ep = await store.saveEndpoint(Object.assign({}, BASE, { id: ep.id, name: 'Renamed', model: 'qwen3', baseUrl: 'http://127.0.0.1:8000/v1' }), {});
    assert.strictEqual(await store.getAck('user/d/alice', ep.id), false);
});

test('ack documents carry extra = userid', async function () {
    const { store, db } = setup();
    const ep = await store.saveEndpoint(BASE, {});
    await store.setAck('user/d/alice', ep.id);
    const d = db.docs.get('aiAck:user/d/alice:' + ep.id);
    assert.strictEqual(d.type, 'aiAck');
    assert.strictEqual(d.extra, 'user/d/alice');
});

test('deleteEndpoint refused while a config set uses it; acks removed', async function () {
    const { store, db } = setup();
    const ep = await store.saveEndpoint(BASE, {});
    await store.setAck('user/d/alice', ep.id);
    db.configSets = [{ _id: 'c1', name: 'Servers', aiEndpointId: ep.id }, { _id: 'c2', default: true, aiEndpointId: ep.id }, { _id: 'c3', name: 'Other', aiEndpointId: '' }];
    await assert.rejects(store.deleteEndpoint(ep.id), function (e) {
        assert.strictEqual(e.code, 'inUse');
        assert.deepStrictEqual(e.sets, ['Servers', 'Default']);
        assert.match(e.message, /Servers, Default/);
        return true;
    });
    assert.ok(await store.getEndpoint(ep.id));
    db.configSets = [];
    assert.strictEqual(await store.deleteEndpoint(ep.id), true);
    assert.strictEqual(await store.getEndpoint(ep.id), null);
    assert.strictEqual(db.docs.has('aiAck:user/d/alice:' + ep.id), false);
    await assert.rejects(store.deleteEndpoint(ep.id), function (e) { return e.code === 'notFound'; });
});

test('settings: defaults, clamping, unknown keys dropped, partial update, cache', async function () {
    const { store, db } = setup();
    const d = await store.getSettings();
    assert.deepStrictEqual(d, storeMod.DEFAULTS);
    d.limits.maxRounds = 99;                                   // a copy: the cache is not affected
    assert.strictEqual((await store.getSettings()).limits.maxRounds, 15);
    assert.deepStrictEqual(storeMod.DEFAULTS.limits, { maxRounds: 15, maxCalls: null, maxOutputTokens: 2048, timeoutSec: 120, maxSentKB: null });
    assert.deepStrictEqual(storeMod.DEFAULTS.quotas, { perUserQuestions: 100, perUserTokens: 3000000 });
    const s = await store.saveSettings({
        enabled: 'yes', evil: 1, limits: { maxRounds: 99, maxOutputTokens: 1, timeoutSec: '300', maxSentKB: -5, extra: 3 },
        quotas: { perUserQuestions: 12.6, perUserTokens: 'abc' }, retentionDays: 0, storeTranscripts: true,
        previewPolicy: 'sometimes', redact: { users: false, serials: 1, weird: true }, categories: { software: true, notes: true, x: true }
    });
    assert.strictEqual(s.enabled, true);
    assert.ok(!('evil' in s));
    assert.deepStrictEqual(s.limits, { maxRounds: 50, maxCalls: null, maxOutputTokens: 64, timeoutSec: 300, maxSentKB: 16 });
    assert.deepStrictEqual(s.quotas, { perUserQuestions: 13, perUserTokens: 3000000 });
    assert.strictEqual(s.retentionDays, 1);
    assert.strictEqual(s.storeTranscripts, true);
    assert.strictEqual(s.previewPolicy, 'every');
    assert.strictEqual(s.redact.users, false);
    assert.strictEqual(s.redact.serials, false);
    assert.ok(!('weird' in s.redact));
    assert.strictEqual(s.categories.software, true);
    assert.ok(!('x' in s.categories));
    const stored = db.docs.get('aiSettings');
    assert.strictEqual(stored.type, 'aiSettings');
    assert.ok(!('evil' in stored));
    const s2 = await store.saveSettings({ previewPolicy: 'never', enabled: false });
    assert.strictEqual(s2.previewPolicy, 'never');
    assert.strictEqual(s2.limits.maxRounds, 50);              // kept
    assert.strictEqual(s2.limits.maxSentKB, 16);              // kept
    assert.strictEqual((await store.saveSettings({ limits: { maxRounds: 0 } })).limits.maxRounds, 1);
    // maxCalls / maxSentKB: a number is clamped, null or '' means automatic; other limits ignore null
    let s4 = await store.saveSettings({ limits: { maxCalls: 500, maxSentKB: 9000 } });
    assert.deepStrictEqual([s4.limits.maxCalls, s4.limits.maxSentKB], [200, 8192]);
    s4 = await store.saveSettings({ limits: { maxCalls: 0, maxSentKB: 3 } });
    assert.deepStrictEqual([s4.limits.maxCalls, s4.limits.maxSentKB], [1, 16]);
    s4 = await store.saveSettings({ limits: { maxCalls: null, maxSentKB: '', maxRounds: null } });
    assert.deepStrictEqual([s4.limits.maxCalls, s4.limits.maxSentKB, s4.limits.maxRounds], [null, null, 1]);
    // a fresh store reads the stored document merged with defaults
    db.docs.set('aiSettings', { _id: 'aiSettings', type: 'aiSettings', limits: { maxRounds: 3 }, junk: 1 });
    const fresh = storeMod.create({ db: db, secrets: makeSecrets(), netguard: fakeNetguard(), log: function () { } });
    const s3 = await fresh.getSettings();
    assert.strictEqual(s3.limits.maxRounds, 3);
    assert.strictEqual(s3.limits.maxOutputTokens, 2048);
    assert.ok(!('junk' in s3));
});

test('settings: an unversioned document with the old defaults is migrated once; changed values and sv:2 documents are kept', async function () {
    function freshStore(db, logs) { return storeMod.create({ db: db, secrets: makeSecrets(), netguard: fakeNetguard(), log: function (m) { if (logs) logs.push(m); } }); }
    // old defaults -> new defaults, saved once with sv:2 (concurrent first reads share one load)
    const db = fakeDb();
    let puts = 0;
    const put = db.aiPutDoc;
    db.aiPutDoc = function (id, type, doc) { if (id === 'aiSettings') puts++; return put(id, type, doc); };
    db.docs.set('aiSettings', { _id: 'aiSettings', type: 'aiSettings', enabled: false,
        limits: { maxRounds: 8, maxOutputTokens: 2048, timeoutSec: 120, maxSentKB: 400 }, quotas: { perUserQuestions: 40, perUserTokens: 300000 } });
    const store = freshStore(db);
    const [s] = await Promise.all([store.getSettings(), store.getSettings()]);
    assert.deepStrictEqual(s.limits, { maxRounds: 15, maxCalls: null, maxOutputTokens: 2048, timeoutSec: 120, maxSentKB: null });
    assert.deepStrictEqual(s.quotas, { perUserQuestions: 100, perUserTokens: 3000000 });
    assert.strictEqual(s.enabled, false);
    assert.ok(!('sv' in s));
    assert.strictEqual(puts, 1);
    let stored = db.docs.get('aiSettings');
    assert.strictEqual(stored.sv, storeMod.SETTINGS_VERSION);
    assert.strictEqual(stored.sv, 2);
    assert.deepStrictEqual([stored.limits.maxRounds, stored.limits.maxSentKB, stored.quotas.perUserQuestions, stored.quotas.perUserTokens], [15, null, 100, 3000000]);
    await store.getSettings();
    await freshStore(db).getSettings();                        // now versioned: not saved again
    assert.strictEqual(puts, 1);
    // a later save keeps sv:2
    await store.saveSettings({ limits: { maxRounds: 8 } });
    stored = db.docs.get('aiSettings');
    assert.deepStrictEqual([stored.sv, stored.limits.maxRounds], [2, 8]);
    // ... and 8 is no longer read as an old default
    assert.strictEqual((await freshStore(db).getSettings()).limits.maxRounds, 8);

    // custom values are kept (values equal to an old default in the same document still move)
    const db2 = fakeDb();
    db2.docs.set('aiSettings', { _id: 'aiSettings', type: 'aiSettings',
        limits: { maxRounds: 10, maxSentKB: 600 }, quotas: { perUserQuestions: 25, perUserTokens: 300000 } });
    const s2 = await freshStore(db2).getSettings();
    assert.deepStrictEqual([s2.limits.maxRounds, s2.limits.maxSentKB, s2.quotas.perUserQuestions, s2.quotas.perUserTokens], [10, 600, 25, 3000000]);
    assert.strictEqual(db2.docs.get('aiSettings').sv, 2);

    // a document with sv:2 is left alone, even when it holds the old default values
    const db3 = fakeDb();
    let puts3 = 0;
    const put3 = db3.aiPutDoc;
    db3.aiPutDoc = function (id, type, doc) { puts3++; return put3(id, type, doc); };
    db3.docs.set('aiSettings', { _id: 'aiSettings', type: 'aiSettings', sv: 2,
        limits: { maxRounds: 8, maxSentKB: 400 }, quotas: { perUserQuestions: 40, perUserTokens: 300000 } });
    const s3 = await freshStore(db3).getSettings();
    assert.deepStrictEqual([s3.limits.maxRounds, s3.limits.maxSentKB, s3.quotas.perUserQuestions, s3.quotas.perUserTokens], [8, 400, 40, 300000]);
    assert.strictEqual(puts3, 0);

    // no stored document: nothing to migrate, nothing written
    const db4 = fakeDb();
    assert.deepStrictEqual(await freshStore(db4).getSettings(), storeMod.DEFAULTS);
    assert.ok(!db4.docs.has('aiSettings'));

    // a failed migration save is logged and does not fail the load
    const db5 = fakeDb(), logs5 = [];
    db5.docs.set('aiSettings', { _id: 'aiSettings', type: 'aiSettings', limits: { maxRounds: 8 } });
    db5.aiPutDoc = async function () { throw new Error('disk full'); };
    const s5 = await freshStore(db5, logs5).getSettings();
    assert.strictEqual(s5.limits.maxRounds, 15);
    assert.ok(logs5.some(function (m) { return /^EVENTLOG AI: could not save the migrated settings \(disk full\)/.test(m); }), logs5.join('\n'));
});

test('audit: sanitising, transcript policy, usage, sweep', async function () {
    const { store, db } = setup();
    const now = Date.now();
    assert.strictEqual(await store.auditAdd({
        user: 'user/d/alice', node: 'node/d/n1', mode: 'ask', tokensIn: 100, tokensOut: 20,
        steps: [{ tool: 'get_events', args: { 'a.b': 1, $where: 'x', window: '24h' } }, { tool: 'get_device_info', args: 'already text' }],
        'bad.key': 1, $set: { x: 1 }, nested: { ok: 1, 'x.y': 2, deep: [{ $gt: 1, fine: true }] }, fn: function () { },
        transcript: { items: [1, 2] }
    }), true);
    const r = db.audit[0];
    assert.ok(r.time >= now);
    assert.strictEqual(r.userid, 'user/d/alice');
    assert.strictEqual(r.nodeid, 'node/d/n1');
    assert.strictEqual(typeof r.steps[0].args, 'string');
    assert.deepStrictEqual(JSON.parse(r.steps[0].args), { 'a.b': 1, $where: 'x', window: '24h' });
    assert.strictEqual(r.steps[1].args, 'already text');
    assert.ok(!('bad.key' in r) && !('$set' in r) && !('fn' in r));
    assert.deepStrictEqual(r.nested, { ok: 1, deep: [{ fine: true }] });
    assert.ok(!('transcript' in r), 'transcripts are not stored unless enabled');

    await store.saveSettings({ storeTranscripts: true });
    await store.auditAdd({ userid: 'user/d/alice', time: now - 1000, tokensIn: 5, tokensOut: 5, transcript: { items: ['hi'] } });
    await store.auditAdd({ userid: 'user/d/alice', time: now - 500, counted: false, tokensIn: 7, tokensOut: 3, transcript: { big: 'x'.repeat(300 * 1024) } });
    await store.auditAdd({ userid: 'user/d/bob', time: now, tokens: { in: 1000, out: 1 } });
    await store.auditAdd({ userid: 'user/d/alice', time: now - 10 * 86400000, tokensIn: 999 });
    assert.deepStrictEqual(db.audit[1].transcript, { items: ['hi'] });
    assert.ok(!('transcript' in db.audit[2]));
    assert.strictEqual(db.audit[2].transcriptDropped, 'too large');
    assert.strictEqual(await store.auditAdd(null), false);

    assert.deepStrictEqual(await store.usage('user/d/alice', now - 86400000), { questions: 2, tokens: 140 });
    assert.deepStrictEqual(await store.usage('user/d/bob', now - 86400000), { questions: 1, tokens: 1001 });
    assert.deepStrictEqual(await store.usage('', 0), { questions: 0, tokens: 0 });

    const q = await store.auditQuery({ userid: 'user/d/alice', limit: 2 });
    assert.strictEqual(q.total, 4);
    assert.strictEqual(q.rows.length, 2);

    await store.saveSettings({ retentionDays: 7 });
    const removed = await store.sweep();
    assert.strictEqual(removed, 1);
    assert.ok(Math.abs(db.lastCutoff - (Date.now() - 7 * 86400000)) < 5000);
});

test('audit and usage never reject on database errors', async function () {
    const { store, db, logs } = setup();
    db.aiAuditAdd = async function () { throw new Error('disk full'); };
    db.aiAuditQuery = async function () { throw new Error('down'); };
    db.aiAuditSweep = async function () { throw new Error('down'); };
    assert.strictEqual(await store.auditAdd({ userid: 'u' }), false);
    assert.deepStrictEqual(await store.usage('u', 0), { questions: 0, tokens: 0 });
    assert.strictEqual(await store.sweep(), 0);
    assert.ok(logs.length >= 3 && logs.every(function (m) { return m.startsWith('EVENTLOG AI: '); }));
});

test('concurrent setCaps / setLastTest / setQuirks do not lose updates', async function () {
    const { store } = setup();
    const ep = await store.saveEndpoint(BASE, {});
    await Promise.all([store.setCaps(ep.id, { tools: false }), store.setLastTest(ep.id, { ok: true, ms: 1 }), store.setQuirks(ep.id, { a: true }), store.setQuirks(ep.id, { b: true })]);
    const got = await store.getEndpoint(ep.id);
    assert.deepStrictEqual(got.caps, { tools: false });
    assert.strictEqual(got.lastTest.ok, true);
    assert.deepStrictEqual(got.quirks, { a: true, b: true });
});

