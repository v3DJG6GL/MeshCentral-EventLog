'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const secretsMod = require('../../ai/secrets.js');
const ng = require('../../ai/netguard.js');
const http = require('../../ai/http.js');
const llm = require('../../ai/llm.js');
const adapters = require('../../ai/adapters/index.js');
const storeMod = require('../../ai/store.js');
const adminMod = require('../../ai/admin.js');
const { createMockLlm } = require('./mock-llm.js');

const KEY = 'sk-live-TOPSECRET-abcdefgh1234';

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function fakeDb() {
    const docs = new Map(), audit = [];
    const db = {
        docs: docs, audit: audit, configSets: [],
        aiPutDoc: async function (id, type, doc) { docs.set(id, clone(Object.assign({}, doc, { _id: id, type: type }))); return true; },
        aiGetDoc: async function (id) { const d = docs.get(id); return d ? clone(d) : null; },
        aiDocs: async function (type) { return Array.from(docs.values()).filter(function (d) { return d.type === type; }).map(clone); },
        aiDelDoc: async function (id) { return docs.delete(id) ? 1 : 0; },
        aiAuditAdd: async function (rec) { audit.push(Object.assign({ _id: String(audit.length + 1) }, clone(rec))); return true; },
        aiAuditQuery: async function (q) {
            q = q || {};
            const rows = audit.filter(function (r) { return (q.since == null || r.time >= q.since) && (q.until == null || r.time <= q.until) && (q.userid == null || r.userid === q.userid) && (q.nodeid == null || r.nodeid === q.nodeid); })
                .sort(function (a, b) { return b.time - a.time; });
            return { rows: clone(rows.slice(q.skip || 0, (q.skip || 0) + (q.limit || 100))), total: rows.length };
        },
        aiAuditSweep: async function () { return 0; },
        getAllConfigSets: async function () { return clone(db.configSets); }
    };
    return db;
}
const DNS = { 'llm.lan': ['127.0.0.1'], 'api.example.com': ['93.184.216.34'] };
const resolver = function (host, opts, cb) {
    setImmediate(function () {
        const v = DNS[host];
        if (!v) { const e = new Error('dns'); e.code = 'ENOTFOUND'; return cb(e); }
        cb(null, v.map(function (a) { return { address: a, family: 4 }; }));
    });
};
const netguard = { check: function (u, o) { return ng.check(u, Object.assign({ resolver: resolver, timeoutMs: 1000 }, o || {})); } };

let mock, tmp;
test.before(async function () { mock = await createMockLlm(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evl-admin-')); });
test.after(async function () { await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
test.beforeEach(function () { mock.reset(); });

let n = 0;
function setup(opts) {
    opts = opts || {};
    const db = fakeDb();
    const logs = [];
    const log = function (m) { logs.push(m); };
    const secrets = secretsMod.create({ keyFile: path.join(tmp, 'k' + (++n) + '.key'), fallbackSecret: 'x', log: log, env: { LLM_KEY: 'env-key-value-0000' } });
    const store = storeMod.create({ db: db, secrets: secrets, netguard: netguard, log: log });
    let proxyCalls = 0;
    const admin = adminMod.create({ store: store, db: db, netguard: netguard, adapters: adapters, llm: llm, http: opts.http || http, getProxyAgent: function () { proxyCalls++; return opts.agent; }, log: log, testAfterSave: opts.testAfterSave === true });
    const sent = [];
    const myparent = { user: { _id: 'user/d/admin', siteadmin: 0xFFFFFFFF }, ws: { readyState: 1, send: function (s) { sent.push(JSON.parse(s)); } } };
    let rid = 0;
    function call(cmd) {
        const reqId = 'r' + (++rid);
        const handled = admin.handle(Object.assign({ action: 'plugin', plugin: 'eventlog', reqId: reqId }, cmd), myparent);
        assert.strictEqual(handled, true);
        return new Promise(function (resolve, reject) {
            const t0 = Date.now();
            (function poll() {
                const m = sent.find(function (x) { return x.reqId === reqId; });
                if (m) return resolve(m);
                if (Date.now() - t0 > 15000) return reject(new Error('no reply for ' + cmd.pluginaction));
                setTimeout(poll, 5);
            })();
        });
    }
    return { db: db, store: store, admin: admin, sent: sent, myparent: myparent, call: call, logs: logs, proxyCalls: function () { return proxyCalls; } };
}

function chatEp(extra) { return Object.assign({ name: 'Mock chat', format: 'openai-chat', preset: 'vllm', baseUrl: mock.base, model: 'm1' }, extra || {}); }
function noKeyAnywhere(t) {
    assert.ok(!JSON.stringify(t.sent).includes(KEY), 'key in a reply');
    assert.ok(!JSON.stringify(t.sent).includes('TOPSECRET'), 'key fragment in a reply');
    assert.ok(!t.logs.join('\n').includes('TOPSECRET'), 'key in the log');
}
function step(r, name) { return r.steps.find(function (s) { return s.name === name; }); }

test('unknown actions and bad commands are not handled', function () {
    const t = setup();
    assert.strictEqual(t.admin.handle({ pluginaction: 'aiStart' }, t.myparent), false);
    assert.strictEqual(t.admin.handle({ pluginaction: 'toString' }, t.myparent), false);
    assert.strictEqual(t.admin.handle(null, t.myparent), false);
    assert.strictEqual(t.admin.handle({}, t.myparent), false);
    assert.strictEqual(t.sent.length, 0);
});

test('save / get / delete endpoint; key never in replies; usedBy', async function () {
    const t = setup();
    let r = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp(), keyAction: 'set', key: KEY });
    assert.strictEqual(r.method, 'aiAdminSaved');
    assert.strictEqual(r.action, 'plugin'); assert.strictEqual(r.plugin, 'eventlog');
    assert.strictEqual(r.endpoint.hasKey, true);
    assert.strictEqual(r.endpoint.keyHint, '…1234');
    assert.strictEqual(r.endpoint.network, 'loopback');
    assert.ok(!('key' in r.endpoint));
    const id = r.endpoint.id;

    r = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp({ name: 'x'.repeat(70) }), keyAction: 'set', key: KEY });
    assert.strictEqual(r.method, 'aiAdminError');
    assert.strictEqual(r.scope, 'endpoint');
    assert.match(r.error, /Name/);
    r = await t.call({ pluginaction: 'aiAdminSaveEndpoint' });
    assert.strictEqual(r.method, 'aiAdminError');
    r = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp({ name: 'Later', baseUrl: 'https://unknown.example/v1' }) });
    assert.strictEqual(r.method, 'aiAdminSaved');
    assert.match(r.warning, /DNS/);
    assert.strictEqual(r.endpoint.network, null);
    const laterId = r.endpoint.id;

    t.db.configSets = [{ _id: 'c1', name: 'Servers', aiEndpointId: id }, { _id: 'c2', name: 'Desktops', aiEndpointId: id }, { _id: 'c3', name: 'None' }];
    r = await t.call({ pluginaction: 'aiAdminGet' });
    assert.strictEqual(r.method, 'aiAdminData');
    assert.strictEqual(r.endpoints.length, 2);
    assert.deepStrictEqual(r.usedBy, { [id]: ['Servers', 'Desktops'] });
    assert.strictEqual(r.keySource, 'file');
    assert.deepStrictEqual(r.settings, storeMod.DEFAULTS);
    assert.ok(r.endpoints.every(function (e) { return !('key' in e) && typeof e.hasKey === 'boolean'; }));

    r = await t.call({ pluginaction: 'aiAdminDeleteEndpoint', id: id });
    assert.strictEqual(r.method, 'aiAdminError');
    assert.strictEqual(r.scope, 'endpoint');
    assert.deepStrictEqual(r.sets, ['Servers', 'Desktops']);
    assert.match(r.error, /Servers, Desktops/);
    r = await t.call({ pluginaction: 'aiAdminDeleteEndpoint', id: laterId });
    assert.deepStrictEqual([r.method, r.id], ['aiAdminDeleted', laterId]);
    r = await t.call({ pluginaction: 'aiAdminDeleteEndpoint', id: laterId });
    assert.strictEqual(r.method, 'aiAdminError');
    noKeyAnywhere(t);
});

test('settings are clamped; errors carry scope settings', async function () {
    const t = setup();
    let r = await t.call({ pluginaction: 'aiAdminSaveSettings', settings: { limits: { maxRounds: 1000 }, previewPolicy: 'once', bogus: true } });
    assert.strictEqual(r.method, 'aiAdminSettingsSaved');
    assert.strictEqual(r.settings.limits.maxRounds, 50);
    assert.strictEqual(r.settings.previewPolicy, 'once');
    assert.ok(!('bogus' in r.settings));
    r = await t.call({ pluginaction: 'aiAdminSaveSettings', settings: 'nope' });
    assert.deepStrictEqual([r.method, r.scope], ['aiAdminError', 'settings']);
});

test('system prompt: aiAdminData carries the factory templates, hashes and overrides', async function () {
    const P = require('../../ai/prompts.js');
    const t = setup();
    let r = await t.call({ pluginaction: 'aiAdminGet' });
    assert.deepStrictEqual(r.factory, Object.assign({}, P.FACTORY));
    assert.deepStrictEqual(r.factoryHash, Object.assign({}, P.FACTORY_HASH));
    assert.deepStrictEqual(r.prompts, storeMod.DEFAULTS.prompts);
    assert.deepStrictEqual(Object.keys(r.placeholders), Object.keys(P.PLACEHOLDERS));
    await t.call({ pluginaction: 'aiAdminSaveSettings', settings: { prompts: { ask: 'Own ask <followups>' } } });
    r = await t.call({ pluginaction: 'aiAdminGet' });
    assert.strictEqual(r.prompts.ask, 'Own ask <followups>');
    assert.strictEqual(r.settings.prompts.ask, 'Own ask <followups>');
    assert.strictEqual(r.prompts.edited.ask.factoryHash, P.FACTORY_HASH.ask);
});

test('system prompt: saving records who edited which part, drops reset parts and writes a settings audit record', async function () {
    const P = require('../../ai/prompts.js');
    const t = setup();
    t.myparent.user.name = 'admin';
    const t0 = Date.now();
    // the page cannot set edited itself
    let r = await t.call({ pluginaction: 'aiAdminSaveSettings', settings: {
        prompts: { base: 'No fence {{nonce}}', explain: 'Explain without block', ask: null, diagnose: P.FACTORY.diagnose, edited: { ask: { at: 1, by: 'mallory' }, base: { at: 1, by: 'mallory' } } },
        extraInstructions: 'Answer in German.'
    } });
    assert.strictEqual(r.method, 'aiAdminSettingsSaved');
    const ed = r.settings.prompts.edited;
    assert.deepStrictEqual(Object.keys(ed).sort(), ['base', 'explain']);
    assert.strictEqual(ed.base.by, 'admin');
    assert.ok(ed.base.at >= t0);
    assert.strictEqual(ed.base.factoryHash, P.FACTORY_HASH.base);
    assert.strictEqual(ed.explain.factoryHash, P.FACTORY_HASH.explain);
    assert.deepStrictEqual(r.warnings, ['Without the <explain> block the Explain view falls back to plain text.']);
    let audit = t.db.audit.filter(function (a) { return a.kind === 'settings'; });
    assert.strictEqual(audit.length, 1);
    assert.deepStrictEqual([audit[0].counted, audit[0].userid, audit[0].username], [false, 'user/d/admin', 'admin']);
    assert.deepStrictEqual(audit[0].changed, ['prompts.base', 'prompts.explain', 'extraInstructions']);
    assert.ok(audit[0].time >= t0);
    const firstAt = ed.base.at;

    // another user changes only explain: base keeps its edit record; settings without prompt changes write no record
    t.myparent.user.name = 'bob';
    r = await t.call({ pluginaction: 'aiAdminSaveSettings', settings: { prompts: { base: 'No fence {{nonce}}', explain: 'Explain <explain>' }, extraInstructions: 'Answer in German.' } });
    assert.deepStrictEqual([r.settings.prompts.edited.base.by, r.settings.prompts.edited.base.at, r.settings.prompts.edited.explain.by], ['admin', firstAt, 'bob']);
    assert.deepStrictEqual(r.warnings, []);
    r = await t.call({ pluginaction: 'aiAdminSaveSettings', settings: { previewPolicy: 'once' } });
    audit = t.db.audit.filter(function (a) { return a.kind === 'settings'; });
    assert.deepStrictEqual(audit.map(function (a) { return a.changed; }), [['prompts.base', 'prompts.explain', 'extraInstructions'], ['prompts.explain']]);

    // reset to the factory default ('' or the factory text): the edit record goes, the change is audited
    r = await t.call({ pluginaction: 'aiAdminSaveSettings', settings: { prompts: { base: '', explain: P.FACTORY.explain }, extraInstructions: '' } });
    assert.deepStrictEqual([r.settings.prompts.base, r.settings.prompts.explain, r.settings.prompts.edited, r.settings.extraInstructions], [null, null, {}, '']);
    audit = t.db.audit.filter(function (a) { return a.kind === 'settings'; });
    assert.deepStrictEqual(audit[2].changed, ['prompts.base', 'prompts.explain', 'extraInstructions']);
    // settings records are not counted as questions
    assert.strictEqual((await t.store.usage('user/d/admin', 0)).questions, 0);
});

test('system prompt: preview renders the draft with sample values and returns warnings', async function () {
    const P = require('../../ai/prompts.js');
    const t = setup();
    await t.call({ pluginaction: 'aiAdminSaveSettings', settings: { prompts: { ask: 'Saved ask <followups>' }, extraInstructions: 'Saved extra' } });
    // no draft: the saved settings
    let r = await t.call({ pluginaction: 'aiAdminPreviewPrompt', mode: 'ask', os: 'windows' });
    assert.strictEqual(r.method, 'aiAdminPromptPreview');
    assert.match(r.text, /^You are a read-only troubleshooting assistant for ONE MeshCentral device: "SAMPLE-PC" \(Windows\)\./);
    assert.match(r.text, /\n\nSaved ask <followups>\n\nAdditional instructions from the administrator:\nSaved extra$/);
    assert.match(r.text, /nonce=[0-9a-f]{24} \.\.\.>>>/);
    assert.match(r.text, /Tools \(read-only, bound to this device\): get_device_info, /);
    assert.match(r.text, /HOST_1/);
    assert.deepStrictEqual(r.warnings, []);
    assert.ok(r.tokens > 100);
    // a draft (unsaved) wins over the saved text, for every part it carries
    r = await t.call({ pluginaction: 'aiAdminPreviewPrompt', mode: 'diagnose', os: 'linux', draft: {
        prompts: { base: 'Draft base {{device}}{{os}} {{osNotes}} {{oops}}', ask: null, diagnose: 'Draft diagnosis' }, extraInstructions: '', endpointExtra: '/no_think'
    } });
    assert.strictEqual(r.text.split('\n\n')[0].indexOf('Draft base SAMPLE-PC (Linux) On this Linux device'), 0);
    assert.match(r.text, /\{\{oops\}\}/);
    assert.match(r.text, /\n\nDraft diagnosis\n\nModel-specific instructions:\n\/no_think$/);
    assert.ok(r.text.indexOf('Saved extra') < 0, 'the draft cleared the extra instructions');
    assert.deepStrictEqual(r.warnings, [
        'Without {{nonce}} the rule that marks event data as untrusted is incomplete: text in event logs could be taken as instructions.',
        'Without the <diagnosis> block the Diagnosis view falls back to plain text.',
        'Unknown placeholders are sent as they are: {{oops}}.'
    ]);
    // explain with the factory text; unknown mode / os fall back to ask / windows; the diagnosis gets a sample window
    r = await t.call({ pluginaction: 'aiAdminPreviewPrompt', mode: 'explain', os: 'linux', draft: { prompts: { ask: null } } });
    assert.ok(r.text.endsWith(P.FACTORY.explain + '\n\nAdditional instructions from the administrator:\nSaved extra'));
    r = await t.call({ pluginaction: 'aiAdminPreviewPrompt', mode: 'nope', os: 'mac', draft: 'x' });
    assert.deepStrictEqual([r.mode, r.os], ['ask', 'windows']);
    r = await t.call({ pluginaction: 'aiAdminPreviewPrompt', mode: 'diagnose', draft: { prompts: {} } });
    assert.match(r.text, /Time window of interest: \d{4}-.* to \d{4}-/);
    // the preview never saves
    assert.strictEqual((await t.store.getSettings()).prompts.base, null);
});

test('endpoint: model-specific instructions are saved, returned and their change audited', async function () {
    const t = setup();
    t.myparent.user.name = 'admin';
    let r = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp({ extraInstructions: '/no_think' }) });
    assert.strictEqual(r.endpoint.extraInstructions, '/no_think');
    const id = r.endpoint.id;
    r = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp({ id: id, extraInstructions: '/no_think' }) });
    r = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp({ id: id }) });
    assert.strictEqual(r.endpoint.extraInstructions, '');
    const audit = t.db.audit.filter(function (a) { return a.kind === 'settings'; });
    assert.deepStrictEqual(audit.map(function (a) { return [a.changed, a.endpointName, a.username]; }), [[['endpoint.extraInstructions'], 'Mock chat', 'admin'], [['endpoint.extraInstructions'], 'Mock chat', 'admin']]);
    r = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp({ id: id, extraInstructions: 'x'.repeat(4001) }) });
    assert.deepStrictEqual([r.method, r.scope], ['aiAdminError', 'endpoint']);
    assert.match(r.error, /4000/);
});

test('test: openai-chat with tools, stored key, caps and lastTest saved', async function () {
    const t = setup();
    const saved = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp(), keyAction: 'set', key: KEY });
    mock.always('/v1/models', { json: { data: [{ id: 'm1', owned_by: 'vllm', max_model_len: 32768 }] } });
    mock.always('/v1/chat/completions', { json: { choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } } });
    const r = await t.call({ pluginaction: 'aiAdminTest', id: saved.endpoint.id });
    assert.strictEqual(r.method, 'aiAdminTestResult');
    assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
    assert.deepStrictEqual(r.steps.map(function (s) { return s.name; }), ['resolve', 'connect', 'auth', 'model', 'tools', 'context']);
    assert.ok(r.steps.every(function (s) { return s.ok === true && typeof s.ms === 'number' && typeof s.detail === 'string' && s.detail.length <= 300; }), JSON.stringify(r.steps));
    assert.strictEqual(r.network, 'loopback');
    assert.strictEqual(step(r, 'auth').detail, 'API key accepted');
    assert.ok(!('noKey' in step(r, 'auth')));
    assert.strictEqual(r.caps.tools, true);
    assert.strictEqual(r.caps.ctx, 32768);
    assert.strictEqual(r.caps.server, 'vllm');
    assert.match(step(r, 'context').detail, /32768/);
    // the stored key went to the server, as a bearer token
    const chatReq = mock.requests.find(function (x) { return x.path === '/v1/chat/completions'; });
    assert.strictEqual(chatReq.headers.authorization, 'Bearer ' + KEY);
    assert.ok(Array.isArray(chatReq.body.tools) && chatReq.body.tools.length === 1);
    const ep = await t.store.getEndpoint(saved.endpoint.id);
    assert.strictEqual(ep.caps.tools, true);
    assert.strictEqual(ep.lastTest.ok, true);
    assert.strictEqual(t.proxyCalls(), 0, 'no proxy for a loopback target');
    noKeyAnywhere(t);
});

test('save: a new endpoint is tested in the background (caps and lastTest stored, aiAdminData pushed)', async function () {
    const t = setup({ testAfterSave: true });
    mock.always('/v1/models', { json: { data: [{ id: 'm1', owned_by: 'vllm', max_model_len: 65536 }] } });
    mock.always('/v1/chat/completions', { json: { choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } } });
    const saved = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp() });
    assert.strictEqual(saved.method, 'aiAdminSaved');
    assert.strictEqual(saved.endpoint.caps, null, 'the save reply does not wait for the test');
    const t0 = Date.now();
    let push;
    while (!(push = t.sent.find(function (m) { return m.method === 'aiAdminData' && m.reqId == null; })) && Date.now() - t0 < 10000) await new Promise(function (r) { setTimeout(r, 5); });
    assert.ok(push, 'aiAdminData pushed');
    const pe = push.endpoints.find(function (e) { return e.id === saved.endpoint.id; });
    assert.strictEqual(pe.caps.ctx, 65536);
    const ep = await t.store.getEndpoint(saved.endpoint.id);
    assert.strictEqual(ep.caps.ctx, 65536);
    assert.strictEqual(ep.caps.tools, true);
    assert.strictEqual(ep.lastTest.ok, true);
    // a save that keeps address, model and format keeps the caps and does not test again
    const n = mock.requests.length;
    await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp({ id: saved.endpoint.id, name: 'Renamed' }) });
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.strictEqual(mock.requests.length, n);
    assert.strictEqual((await t.store.getEndpoint(saved.endpoint.id)).caps.ctx, 65536);
});

test('test: model without tool support -> ok with tools false; draft results are not stored', async function () {
    const t = setup();
    const saved = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp() });
    mock.always('/v1/models', { json: { data: [{ id: 'm1' }] } });
    mock.always('/v1/chat/completions', { status: 400, json: { error: { message: 'model m1 does not support tools', type: 'invalid_request_error' } } });
    const r = await t.call({ pluginaction: 'aiAdminTest', draft: Object.assign(chatEp(), { id: saved.endpoint.id, keyAction: 'keep' }) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(step(r, 'auth').noKey, true);
    assert.strictEqual(step(r, 'auth').detail, 'No API key needed: the server accepted the request');
    assert.strictEqual(step(r, 'tools').ok, false);
    assert.match(step(r, 'tools').detail, /summary/);
    assert.strictEqual(step(r, 'context').ok, null);
    assert.strictEqual(r.caps.tools, false);
    const ep = await t.store.getEndpoint(saved.endpoint.id);
    assert.strictEqual(ep.caps, null);
    assert.strictEqual(ep.lastTest, null);
});

test('test: authentication failure echoing the key is scrubbed', async function () {
    const t = setup();
    mock.always('/v1/models', { status: 401, json: { error: { message: 'Incorrect API key provided: ' + KEY, type: 'invalid_request_error' } } });
    const r = await t.call({ pluginaction: 'aiAdminTest', draft: Object.assign(chatEp(), { keyAction: 'set', key: KEY }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(step(r, 'connect').ok, true);
    assert.strictEqual(step(r, 'auth').ok, false);
    assert.match(step(r, 'auth').detail, /\[key\]/);
    assert.strictEqual(step(r, 'model').ok, null);
    assert.strictEqual(mock.requests.find(function (x) { return x.path === '/v1/models'; }).headers.authorization, 'Bearer ' + KEY);
    noKeyAnywhere(t);
});

test('test: anthropic format uses x-api-key and reports the context', async function () {
    const t = setup();
    mock.always('/v1/models/claude-test', { json: { id: 'claude-test', type: 'model', max_input_tokens: 200000, max_tokens: 64000 } });
    const r = await t.call({ pluginaction: 'aiAdminTest', draft: { name: 'A', format: 'anthropic', baseUrl: mock.base, model: 'claude-test', keyAction: 'set', key: KEY } });
    assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
    assert.strictEqual(r.caps.ctx, 200000);
    assert.strictEqual(r.caps.tools, true);
    const req = mock.requests.find(function (x) { return x.path === '/v1/models/claude-test'; });
    assert.strictEqual(req.headers['x-api-key'], KEY);
    assert.ok(req.headers['anthropic-version']);
    noKeyAnywhere(t);
});

function ollamaRoutes(tools, numCtxParam) {
    mock.always('/api/version', { json: { version: '0.12.6' } });
    mock.always('/api/show', function (rec) {
        const m = rec.body && rec.body.model;
        if (m === 'missing') return { status: 404, json: { error: "model 'missing' not found" } };
        return { json: { capabilities: tools ? ['completion', 'tools'] : ['completion'], model_info: { 'general.architecture': 'llama', 'llama.context_length': m === 'qwen3:4b' ? 40960 : 131072 }, parameters: numCtxParam ? 'num_ctx ' + numCtxParam + '\nstop "<|eot_id|>"' : 'stop "<|eot_id|>"', details: { family: 'llama' } } };
    });
    mock.always('/v1/models', { json: { data: [{ id: 'llama3.1:8b' }, { id: 'qwen3:4b' }] } });
    mock.always('/api/tags', { json: { models: [{ name: 'llama3.1:8b', details: { family: 'llama' } }, { name: 'qwen3:4b' }, { model: 'nomic-embed' }] } });
}
function ollamaEp(extra) { return Object.assign({ name: 'Ollama', format: 'openai-chat', preset: 'ollama', baseUrl: mock.base, model: 'llama3.1:8b' }, extra || {}); }

test('test: Ollama with tools, model context and the default-context note', async function () {
    const t = setup();
    ollamaRoutes(true);
    const r = await t.call({ pluginaction: 'aiAdminTest', draft: ollamaEp() });
    assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
    assert.strictEqual(r.caps.tools, true);
    assert.strictEqual(r.caps.ctx, 131072);
    assert.match(r.caps.server, /^ollama 0\.12\.6/);
    assert.match(step(r, 'context').detail, /Ollama's default context may be only 4096 tokens; set Ollama context below or OLLAMA_CONTEXT_LENGTH/);
    assert.ok(!mock.requests.some(function (x) { return x.path === '/v1/chat/completions'; }), 'no chat request needed for Ollama');
    // with an Ollama context set, no note
    const r2 = await t.call({ pluginaction: 'aiAdminTest', draft: ollamaEp({ numCtx: 16384 }) });
    assert.doesNotMatch(step(r2, 'context').detail, /default context/);
    assert.match(step(r2, 'context').detail, /16384/);
});

test('test: Ollama model without tools; unknown model fails the model step', async function () {
    const t = setup();
    ollamaRoutes(false, 8192);
    let r = await t.call({ pluginaction: 'aiAdminTest', draft: ollamaEp() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.caps.tools, false);
    assert.strictEqual(step(r, 'tools').ok, false);
    assert.match(step(r, 'context').detail, /num_ctx 8192/);
    r = await t.call({ pluginaction: 'aiAdminTest', draft: ollamaEp({ model: 'missing' }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(step(r, 'model').ok, false);
    assert.match(step(r, 'model').detail, /not found/);
});

test('test: blocked metadata address and bad addresses are refused before any request', async function () {
    const t = setup();
    const before = mock.requests.length;
    const r = await t.call({ pluginaction: 'aiAdminTest', draft: chatEp({ baseUrl: 'http://169.254.169.254/v1' }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(step(r, 'resolve').ok, false);
    assert.match(step(r, 'resolve').detail, /metadata/);
    assert.ok(r.steps.slice(1).every(function (s) { return s.ok === null; }));
    assert.strictEqual(r.network, null);
    assert.strictEqual(mock.requests.length, before);
    const bad = await t.call({ pluginaction: 'aiAdminTest', draft: chatEp({ baseUrl: 'gopher://x' }) });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.steps[0].detail, /http/);
    const missing = await t.call({ pluginaction: 'aiAdminTest', id: 'aiEndpoint:000000000000' });
    assert.strictEqual(missing.ok, false);
    assert.match(missing.steps[0].detail, /not found/);
});

test('test: a name is resolved once and the connection uses the pinned address', async function () {
    const t = setup();
    mock.always('/v1/models', { json: { data: [{ id: 'm1' }] } });
    mock.always('/v1/chat/completions', { json: { choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } });
    // llm.lan only exists in the injected resolver: success proves the pinned lookup was used
    const r = await t.call({ pluginaction: 'aiAdminTest', draft: chatEp({ baseUrl: 'http://llm.lan:' + mock.port + '/v1' }) });
    assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
    assert.strictEqual(r.network, 'loopback');
    assert.strictEqual(mock.requests.find(function (x) { return x.path === '/v1/chat/completions'; }).headers.host, 'llm.lan:' + mock.port);
});

test('test: redirects are not followed', async function () {
    const t = setup();
    mock.always('/v1/models', { redirect: 'http://169.254.169.254/latest/meta-data' });
    mock.always('/v1/chat/completions', { redirect: 'http://169.254.169.254/latest/meta-data' });
    const r = await t.call({ pluginaction: 'aiAdminTest', draft: chatEp() });
    assert.strictEqual(r.ok, false);
    const failed = r.steps.find(function (s) { return s.ok === false; });
    assert.ok(failed && (failed.name === 'connect' || failed.name === 'model'), JSON.stringify(r.steps));
    assert.ok(!mock.requests.some(function (x) { return x.path.startsWith('/latest'); }));
});

test('models: OpenAI-compatible list and Ollama tags with show details', async function () {
    const t = setup();
    mock.always('/v1/models', { json: { data: [{ id: 'a', max_model_len: 8192, owned_by: 'vllm' }, { id: 'b' }, { id: 'a' }, { nope: 1 }] } });
    let r = await t.call({ pluginaction: 'aiAdminModels', draft: chatEp({ model: '' }) });
    assert.strictEqual(r.method, 'aiAdminModelsResult');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models, [{ id: 'a', ctx: 8192 }, { id: 'b' }]);

    mock.reset();
    ollamaRoutes(true);
    r = await t.call({ pluginaction: 'aiAdminModels', draft: ollamaEp() });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models, [{ id: 'llama3.1:8b', tools: true, ctx: 131072 }, { id: 'qwen3:4b', tools: true, ctx: 40960 }, { id: 'nomic-embed', tools: true, ctx: 131072 }]);

    mock.reset();
    mock.always('/v1/models', { status: 401, json: { error: { message: 'bad key ' + KEY } } });
    r = await t.call({ pluginaction: 'aiAdminModels', draft: chatEp({ keyAction: 'set', key: KEY }) });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.models, []);
    assert.match(r.error, /Authentication failed/);
    r = await t.call({ pluginaction: 'aiAdminModels', draft: chatEp({ baseUrl: 'http://169.254.169.254/v1' }) });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /metadata/);
    r = await t.call({ pluginaction: 'aiAdminModels', draft: chatEp({ keyAction: 'set', key: 'env:NOT_SET_VAR' }) });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /NOT_SET_VAR is not set/);
    noKeyAnywhere(t);
});

test('draft env key reference and remove', async function () {
    const t = setup();
    mock.always('/v1/models', { json: { data: [{ id: 'm1' }] } });
    let r = await t.call({ pluginaction: 'aiAdminModels', draft: chatEp({ keyAction: 'set', key: 'env:LLM_KEY' }) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mock.requests[mock.requests.length - 1].headers.authorization, 'Bearer env-key-value-0000');
    const saved = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp(), keyAction: 'set', key: KEY });
    r = await t.call({ pluginaction: 'aiAdminModels', draft: Object.assign(chatEp(), { id: saved.endpoint.id, keyAction: 'remove' }) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mock.requests[mock.requests.length - 1].headers.authorization, undefined);
    r = await t.call({ pluginaction: 'aiAdminModels', id: saved.endpoint.id });
    assert.strictEqual(mock.requests[mock.requests.length - 1].headers.authorization, 'Bearer ' + KEY);
    noKeyAnywhere(t);
});

test('test: stops at the first connect-level failure, later steps skipped', async function () {
    for (const fail of [
        { err: http.mkErr('timeout', 'Could not connect within 8 s', { phase: 'connect' }), detail: /Could not connect within 8 s/ },
        { err: http.mkErr('network', 'Connection failed (ECONNREFUSED)', { sysCode: 'ECONNREFUSED' }), detail: /ECONNREFUSED/ }
    ]) {
        const urls = [];
        const fakeHttp = { request: function (ro) { urls.push(ro.url); const p = Promise.reject(fail.err); p.catch(function () { }); return { promise: p, abort: function () { } }; } };
        const t = setup({ http: fakeHttp });
        for (const ep of [chatEp({ baseUrl: 'http://llm.lan:8000/v1' }), chatEp({ baseUrl: 'http://llm.lan:11434/v1', preset: 'ollama' }), { name: 'A', format: 'anthropic', baseUrl: 'http://llm.lan:8000', model: 'c' }]) {
            urls.length = 0;
            const r = await t.call({ pluginaction: 'aiAdminTest', draft: Object.assign(ep, { keyAction: 'remove' }) });
            assert.strictEqual(r.ok, false);
            assert.strictEqual(urls.length, 1, 'one request only, got ' + urls.join(' '));
            const by = {}; r.steps.forEach(function (x) { by[x.name] = x; });
            assert.strictEqual(by.resolve.ok, true);
            assert.strictEqual(by.connect.ok, false);
            assert.match(by.connect.detail, fail.detail);
            for (const n of ['auth', 'model', 'tools', 'context']) assert.deepStrictEqual([n, by[n].ok, by[n].detail], [n, null, 'Skipped']);
        }
    }
});

test('test: an HTTP error answer is not a connect failure (the probe goes on)', async function () {
    const t = setup();
    mock.script('/v1/models', { status: 404, body: '{"error":"no"}' });
    const r = await t.call({ pluginaction: 'aiAdminTest', draft: Object.assign(chatEp(), { keyAction: 'remove' }) });
    assert.ok(mock.requests.some(function (q) { return /chat\/completions$/.test(q.path); }), 'the chat request still ran');
    assert.strictEqual(r.steps.find(function (x) { return x.name === 'connect'; }).ok, true);
});

test('audit rows: transcript only on request', async function () {
    const t = setup();
    await t.store.saveSettings({ storeTranscripts: true });
    await t.store.auditAdd({ userid: 'user/d/a', nodeid: 'node/d/1', time: 1000, transcript: { items: ['x'] } });
    await t.store.auditAdd({ userid: 'user/d/b', nodeid: 'node/d/2', time: 2000 });
    let r = await t.call({ pluginaction: 'aiAdminAudit', skip: 0, limit: 10 });
    assert.strictEqual(r.method, 'aiAdminAuditRows');
    assert.strictEqual(r.total, 2);
    assert.ok(r.rows.every(function (x) { return !('transcript' in x); }));
    // MeshCentral sets command.userid to the caller on every plugin command: it must not filter
    r = await t.call({ pluginaction: 'aiAdminAudit', userid: 'user/d/admin', skip: 0, limit: 10 });
    assert.strictEqual(r.total, 2);
    r = await t.call({ pluginaction: 'aiAdminAudit', userid: 'user/d/admin', filterNodeid: 'node/d/2' });
    assert.deepStrictEqual(r.rows.map(function (x) { return x.userid; }), ['user/d/b']);
    r = await t.call({ pluginaction: 'aiAdminAudit', userid: 'user/d/admin', filterUserid: 'user/d/a', withTranscript: true });
    assert.strictEqual(r.total, 1);
    assert.deepStrictEqual(r.rows[0].transcript, { items: ['x'] });
    r = await t.call({ pluginaction: 'aiAdminAudit', since: 1500, until: 3000 });
    assert.deepStrictEqual(r.rows.map(function (x) { return x.userid; }), ['user/d/b']);
});

test('closed websocket: nothing sent, nothing thrown; bad reqId dropped', async function () {
    const t = setup();
    t.myparent.ws.readyState = 3;
    assert.strictEqual(t.admin.handle({ pluginaction: 'aiAdminGet', reqId: 'x' }, t.myparent), true);
    assert.strictEqual(t.admin.handle({ pluginaction: 'aiAdminGet' }, {}), true);
    await new Promise(function (r) { setTimeout(r, 30); });
    assert.strictEqual(t.sent.length, 0);
    t.myparent.ws.readyState = 1;
    t.admin.handle({ pluginaction: 'aiAdminGet', reqId: { evil: 1 } }, t.myparent);
    await new Promise(function (r) { setTimeout(r, 30); });
    assert.strictEqual(t.sent.length, 1);
    assert.strictEqual(t.sent[0].reqId, undefined);
});

test('public targets: proxy agent for https, no key over http', async function () {
    const https = require('https');
    const agent = new https.Agent();
    const seen = [];
    agent.addRequest = function (req, o) { seen.push(o.host || o.hostname); setImmediate(function () { req.emit('error', Object.assign(new Error('proxy refused'), { code: 'ECONNREFUSED' })); }); };
    const t = setup({ agent: agent });
    let r = await t.call({ pluginaction: 'aiAdminTest', draft: chatEp({ baseUrl: 'https://api.example.com/v1', keyAction: 'set', key: KEY }) });
    assert.strictEqual(r.network, 'public');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(step(r, 'connect').ok, false);
    assert.ok(t.proxyCalls() > 0);
    assert.ok(seen.length > 0 && seen.every(function (h) { return h === 'api.example.com'; }));
    r = await t.call({ pluginaction: 'aiAdminTest', draft: chatEp({ baseUrl: 'http://api.example.com/v1', keyAction: 'set', key: KEY }) });
    assert.strictEqual(r.ok, false);
    assert.match(step(r, 'connect').detail, /unencrypted/);
    r = await t.call({ pluginaction: 'aiAdminModels', draft: chatEp({ baseUrl: 'http://api.example.com/v1', keyAction: 'set', key: KEY }) });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /unencrypted/);
    assert.strictEqual(r.network, 'public');
    noKeyAnywhere(t);
});

test('drafts without a name: models (no model either) and test work, save still needs a name', async function () {
    const t = setup();
    mock.always('/v1/models', { json: { data: [{ id: 'm1' }] } });
    mock.always('/v1/chat/completions', { json: { choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } });
    const draft = { name: '', format: 'openai-chat', preset: 'ollama', baseUrl: 'http://llm.lan:' + mock.port + '/v1', model: '', keyAction: 'set', key: KEY };
    let r = await t.call({ pluginaction: 'aiAdminModels', draft: draft });
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.models, [{ id: 'm1' }]);
    assert.strictEqual(r.network, 'loopback');
    r = await t.call({ pluginaction: 'aiAdminModels', draft: { baseUrl: mock.base } });   // no name, format or model at all
    assert.strictEqual(r.ok, true, r.error);
    r = await t.call({ pluginaction: 'aiAdminTest', draft: Object.assign({}, draft, { model: 'm1' }) });
    assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
    assert.strictEqual(r.network, 'loopback');
    r = await t.call({ pluginaction: 'aiAdminTest', draft: draft });
    assert.strictEqual(r.ok, false);
    assert.match(r.steps[0].detail, /Model is required/);
    r = await t.call({ pluginaction: 'aiAdminModels', draft: { name: '', baseUrl: 'ftp://x/v1' } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.network, null);
    assert.match(r.error, /http/);
    r = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: Object.assign({}, draft, { model: 'm1' }), keyAction: 'set', key: KEY });
    assert.strictEqual(r.method, 'aiAdminError');
    assert.match(r.error, /Name must be/);
    noKeyAnywhere(t);
});

test('a test or model list of a saved endpoint stores the network the server found', async function () {
    const t = setup();
    mock.always('/v1/models', { json: { data: [{ id: 'm1' }] } });
    mock.always('/v1/chat/completions', { json: { choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } });
    DNS['later.lan'] = undefined;
    const saved = await t.call({ pluginaction: 'aiAdminSaveEndpoint', endpoint: chatEp({ baseUrl: 'http://later.lan:' + mock.port + '/v1' }) });
    assert.strictEqual(saved.endpoint.network, null);
    DNS['later.lan'] = ['127.0.0.1'];
    try {
        let r = await t.call({ pluginaction: 'aiAdminTest', id: saved.endpoint.id });
        assert.strictEqual(r.network, 'loopback');
        assert.strictEqual((await t.store.getEndpoint(saved.endpoint.id)).network, 'loopback');
        await t.store.setNetwork(saved.endpoint.id, 'bogus');
        assert.strictEqual((await t.store.getEndpoint(saved.endpoint.id)).network, 'loopback');
        await t.store.setNetwork(saved.endpoint.id, 'public');
        r = await t.call({ pluginaction: 'aiAdminModels', id: saved.endpoint.id });
        assert.strictEqual(r.network, 'loopback');
        assert.strictEqual((await t.store.getEndpoint(saved.endpoint.id)).network, 'loopback');
        r = await t.call({ pluginaction: 'aiAdminGet' });
        assert.strictEqual(r.endpoints[0].network, 'loopback');
    } finally { delete DNS['later.lan']; }
});
