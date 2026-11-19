'use strict';
// The admin page (views/admin.handlebars) in jsdom: the endpoint form's generation settings (server defaults as
// placeholders, levels the server does not take disabled, Anthropic / Responses limits), and the offer to use the
// first saved endpoint for the Default config set. Runs when jsdom can be found (EVL_JSDOM or a resolvable jsdom).
var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

function findJsdom() {
    var c = [process.env.EVL_JSDOM, 'jsdom'];
    for (var i = 0; i < c.length; i++) { if (!c[i]) continue; try { return require(c[i]); } catch (e) { } }
    return null;
}
var JSDOM_MOD = findJsdom();
var SKIP = JSDOM_MOD ? false : 'jsdom not found (set EVL_JSDOM)';
var WINDOWS = [];
test.afterEach(function () { while (WINDOWS.length) { try { WINDOWS.pop().close(); } catch (e) { } } });

var EP = {
    id: 'aiEndpoint:0123456789ab', name: 'gpu-01', format: 'openai-chat', preset: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen3',
    contextTokens: null, numCtx: null, maxOutputTokens: null, timeoutSec: 120, toolMode: 'auto', allowLinkLocal: false, extraInstructions: '',
    thinking: null, temperature: null, topP: null, topK: null, seed: null, network: 'loopback', hasKey: false, keyHint: '',
    caps: { tools: true, ctx: 262144, server: 'llama.cpp', at: Date.now(),
        thinking: { supported: true, levels: ['low', 'medium', 'high'], serverDefault: 'high', verified: true },
        genDefaults: { temperature: 1, topP: 0.95, topK: 20, seed: -1, maxTokens: -1 } }
};

function page(opts) {
    opts = opts || {};
    var html = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin.handlebars'), 'utf8')
        .replace('{{{configSets}}}', JSON.stringify(opts.sets || [{ _id: 'd1', default: true, name: 'Default' }]))
        .replace('{{{configAssignments}}}', '[]')
        .replace('{{{aiAdmin}}}', JSON.stringify({ full: true, available: true }));
    var dom = new JSDOM_MOD.JSDOM(html, {
        runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://mesh.example/pluginadmin.ashx?pin=eventlog',
        beforeParse: function (w) {
            w.sent = [];
            w.meshes = {}; w.nodes = [];
            w.pluginHandler = { eventlog: {} };
            w.meshserver = { send: function (m) { w.sent.push(JSON.parse(JSON.stringify(m))); } };
            w.Q = function (x) { return w.document.getElementById(x); };
            w.QS = function (x) { return w.document.getElementById(x).style; };
            w.confirm = function () { return true; };
            if (opts.noStorage) Object.defineProperty(w, 'localStorage', { get: function () { throw new Error('blocked'); } });
            else Object.keys(opts.store || {}).forEach(function (k) { w.localStorage.setItem(k, opts.store[k]); });
        }
    });
    var w = dom.window;
    WINDOWS.push(w);
    w.h = w.pluginHandler.eventlog;
    w.last = function (action) { var l = w.sent.filter(function (m) { return m.pluginaction == action; }); return l[l.length - 1]; };
    w.data = function (endpoints, usedBy) {
        var get = w.last('aiAdminGet');
        w.h.aiAdminData(null, { reqId: get && get.reqId, endpoints: endpoints, usedBy: usedBy || {}, settings: { limits: { maxOutputTokens: 2048 } } });
    };
    return w;
}
function $(w, id) { return w.document.getElementById(id); }

test('endpoint form: server defaults as placeholders, unsupported levels disabled, settings sent', { skip: SKIP }, function () {
    var w = page();
    w.data([EP]);
    w.elAiOpenForm(w.elAi.endpoints[0]);
    assert.strictEqual($(w, 'elAiTemp').placeholder, '1.00 (server default)');
    assert.strictEqual($(w, 'elAiTopP').placeholder, '0.95 (server default)');
    assert.strictEqual($(w, 'elAiTopK').placeholder, '20 (server default)');
    assert.strictEqual($(w, 'elAiSeed').placeholder, 'random (server default)');
    var sel = $(w, 'elAiThinking');
    assert.strictEqual(sel.options[0].textContent, 'High (server default)');
    assert.deepStrictEqual(Array.prototype.map.call(sel.options, function (o) { return o.value + ':' + o.disabled; }), [':false', 'off:true', 'low:false', 'medium:false', 'high:false']);
    assert.match(sel.options[1].title, /does not accept this level/);
    // another model: what was found no longer applies
    $(w, 'elAiModel').value = 'other'; w.elAiModelFacts();
    assert.strictEqual($(w, 'elAiTemp').placeholder, 'server default');
    assert.strictEqual(sel.options[0].textContent, 'Server default');
    assert.strictEqual(sel.options[1].disabled, false);
    $(w, 'elAiModel').value = 'qwen3'; w.elAiModelFacts();
    // save carries the settings; empty ones are null
    sel.value = 'medium'; $(w, 'elAiTemp').value = '0.7'; $(w, 'elAiSeed').value = '42';
    w.elAiSaveEndpoint();
    var save = w.last('aiAdminSaveEndpoint');
    assert.deepStrictEqual([save.endpoint.thinking, save.endpoint.temperature, save.endpoint.topP, save.endpoint.topK, save.endpoint.seed], ['medium', 0.7, null, null, 42]);
    // a changed setting is tested as a draft, not by id
    w.elAiTest();
    assert.ok(w.last('aiAdminTest').draft, 'draft test');
    assert.strictEqual(w.last('aiAdminTest').draft.temperature, 0.7);
    // out of range: inline error, nothing sent
    $(w, 'elAiTopP').value = '1.5';
    var n = w.sent.length;
    w.elAiSaveEndpoint();
    assert.strictEqual(w.sent.length, n);
    assert.ok($(w, 'elAiTopPErr'), 'inline error');
});

test('endpoint form: Anthropic disables all generation settings, Responses top-k and seed; the test result shows the new steps', { skip: SKIP }, function () {
    var w = page();
    w.data([]);
    w.elAiOpenForm(null);
    $(w, 'elAiType').value = 'anthropic'; w.elAiTypeChanged();
    ['elAiThinking', 'elAiTemp', 'elAiTopP', 'elAiTopK', 'elAiSeed'].forEach(function (id) { assert.strictEqual($(w, id).disabled, true, id); });
    assert.strictEqual($(w, 'elAiGenNote').hidden, false);
    assert.match($(w, 'elAiGenNote').textContent, /Anthropic Messages API .* takes no thinking or sampling settings/);
    $(w, 'elAiType').value = 'responses'; w.elAiTypeChanged();
    assert.deepStrictEqual(['elAiThinking', 'elAiTemp', 'elAiTopP', 'elAiTopK', 'elAiSeed'].map(function (id) { return $(w, id).disabled; }), [false, false, false, true, true]);
    $(w, 'elAiType').value = 'vllm'; w.elAiTypeChanged();
    assert.strictEqual($(w, 'elAiGenNote').hidden, true);
    // test result: the thinking / generation steps with their lines; a finding is not "not run"
    $(w, 'elAiModel').value = 'm';
    w.elAiTest();
    var t = w.last('aiAdminTest');
    w.h.aiAdminTestResult(null, { reqId: t.reqId, ok: true, network: 'loopback', steps: [
        { name: 'thinking', ok: null, ms: 0, detail: 'Not supported (the server rejected reasoning_effort)' },
        { name: 'generation', ok: null, ms: 0, detail: 'x', lines: ['Server defaults: Temperature 1.00', 'Applied by the Assistant: max output 2,048'] },
        { name: 'context', ok: null, ms: 0, detail: 'Skipped' }
    ], caps: { tools: true, ctx: 8192, thinking: { supported: false, levels: [] }, genDefaults: { temperature: 1 } } });
    var items = w.document.querySelectorAll('#elAiTestOut li');
    assert.match(items[0].textContent, /^– Note: Thinking\s*Not supported/);
    assert.doesNotMatch(items[0].textContent, /not run/);
    assert.match(items[1].textContent, /Generation defaults/);
    assert.deepStrictEqual(Array.prototype.map.call(items[1].querySelectorAll('.elAiLine'), function (e) { return e.textContent; }), ['Server defaults: Temperature 1.00', 'Applied by the Assistant: max output 2,048']);
    assert.match(items[2].textContent, /\(not run\)/);
    // the found facts apply to the form now
    assert.strictEqual($(w, 'elAiTemp').placeholder, '1.00 (server default)');
    assert.ok(['off', 'low', 'medium', 'high'].every(function (v) { return w.document.querySelector('#elAiThinking option[value="' + v + '"]').disabled; }));
    assert.match($(w, 'elAiGenNote').textContent, /takes no thinking setting/);
});

test('first endpoint: offer to use it for the Default config set; "Used by" hint when no set uses it', { skip: SKIP }, function () {
    var w = page();
    w.data([]);
    w.elAiOpenForm(null);
    $(w, 'elAiName').value = 'gpu-01'; $(w, 'elAiModel').value = 'qwen3';
    w.elAiSaveEndpoint();
    var save = w.last('aiAdminSaveEndpoint');
    var saved = Object.assign({}, EP, { caps: null });
    w.h.aiAdminSaved(null, { reqId: save.reqId, endpoint: saved });
    assert.strictEqual($(w, 'elAiOffer').hidden, true, 'shown only once the refresh confirms no set uses an endpoint');
    w.data([saved], {});
    assert.strictEqual($(w, 'elAiOffer').hidden, false);
    assert.strictEqual($(w, 'elAiOfferT').textContent, 'Use “gpu-01” for the Default config set? Devices that use the Default set can then use the Assistant.');
    assert.strictEqual(w.document.querySelector('#elAiEpRows .elAiUnused').textContent, 'Not used by any config set yet — assign it in Config Sets.');
    // Use it for Default: the config-set save path, Default set, only the endpoint id
    w.elAiOfferUse();
    var cfg = w.last('adminSaveConfig');
    assert.deepStrictEqual([cfg.id, cfg.opts], ['_default', { aiEndpointId: EP.id }]);
    assert.strictEqual($(w, 'elAiOfferYes').disabled, true);
    w.h.adminUpdateConfigSets(null, { sets: [{ _id: 'd1', default: true, name: 'Default', aiEndpointId: EP.id }], selected: '', saved: true, defaultSet: true });
    assert.strictEqual($(w, 'elAiOffer').hidden, true);
    assert.match($(w, 'elAiEpStatus').textContent, /The Default config set now uses “gpu-01”/);
    assert.strictEqual($(w, 'elSaveStatus').textContent, '', 'the Config Sets tab status is not touched');
    assert.ok(w.sent.filter(function (m) { return m.pluginaction == 'aiAdminGet'; }).length >= 3, 'usedBy refreshed');
    w.data([saved], { [EP.id]: ['Default'] });
    assert.strictEqual(w.document.querySelector('#elAiEpRows .elAiUnused'), null);
    // a later save while a set uses an endpoint: no offer
    w.h.aiAdminSaved(null, { reqId: w.last('aiAdminSaveEndpoint').reqId, endpoint: saved });
    w.data([saved], { [EP.id]: ['Default'] });
    assert.strictEqual($(w, 'elAiOffer').hidden, true);
});

test('first endpoint offer: Not now, and a refused save keeps the offer with the error', { skip: SKIP }, function () {
    var w = page();
    w.data([]);
    w.elAi.offer = { id: EP.id, name: 'gpu-01', state: 'check' };
    w.elAiRefresh();
    w.data([EP], {});
    assert.strictEqual($(w, 'elAiOffer').hidden, false);
    w.elAiOfferUse();
    w.h.adminSaveFailed(null, { error: 'Unknown Assistant endpoint' });
    assert.strictEqual($(w, 'elAiOffer').hidden, false);
    assert.match($(w, 'elAiOfferStatus').textContent, /Not saved: Unknown Assistant endpoint/);
    assert.strictEqual($(w, 'elAiOfferYes').disabled, false);
    w.elAiOfferDismiss();
    assert.strictEqual($(w, 'elAiOffer').hidden, true);
    assert.strictEqual(w.elAi.offer, null);
});

var FACT = { windows: ['Why did this device restart recently?', 'What changed in the last 24 hours?', 'Are there signs of disk or hardware problems?'], linux: ['Why did this device restart recently?', 'Which services failed in the last 24 hours?', 'Are there signs of disk, memory or hardware problems?'] };
function dataWith(w, settings, extra) {
    var get = w.last('aiAdminGet');
    w.h.aiAdminData(null, Object.assign({ reqId: get && get.reqId, endpoints: [], usedBy: {}, startersFactory: FACT, historyAvailable: true, historyCounts: { chat: 4, diagnosis: 1, explain: 7, total: 12 },
        settings: Object.assign({ limits: {}, quotas: {}, history: { enabled: true, retentionDays: 30 }, starters: { windows: null, linux: null } }, settings || {}) }, extra || {}));
}
function texts(w, os) { return Array.prototype.map.call(w.document.querySelectorAll('#elAiStart_' + os + ' input'), function (i) { return i.value; }); }

test('starter questions: factory lists shown, add / remove / reorder (focus follows) / reset, saved as null when back at the factory list', { skip: SKIP }, function () {
    var w = page();
    $(w, 'elAssistant').style.display = 'block';   // the tab is shown (focus only lands on visible elements)
    $(w, 'elAiColl_starters').click();   // the section is closed until opened
    dataWith(w, { starters: { windows: null, linux: ['Is journald healthy?'] } });
    assert.deepStrictEqual(texts(w, 'windows'), FACT.windows);
    assert.deepStrictEqual(texts(w, 'linux'), ['Is journald healthy?']);
    assert.strictEqual($(w, 'elAiStartTag_windows').textContent, 'Factory default');
    assert.strictEqual($(w, 'elAiStartTag_linux').textContent, 'Edited');
    assert.strictEqual($(w, 'elAiStartReset_windows').disabled, true);
    assert.strictEqual($(w, 'elAiStartCount_windows').textContent, '3 of 12');
    // move the second Windows question up: order changes, focus stays on the moved row's button
    var row = w.document.querySelectorAll('#elAiStart_windows li')[1];
    assert.strictEqual(row.querySelector('.up').getAttribute('aria-label'), 'Move “What changed in the last 24 hours?” up');
    assert.strictEqual(w.document.querySelector('#elAiStart_windows li .up').disabled, true, 'the first cannot move up');
    row.querySelector('.up').click();
    assert.deepStrictEqual(texts(w, 'windows'), [FACT.windows[1], FACT.windows[0], FACT.windows[2]]);
    assert.strictEqual(w.document.activeElement, w.document.querySelectorAll('#elAiStart_windows li')[0].querySelector('.down'), 'at the top: focus moves to the down button');
    assert.strictEqual($(w, 'elAiStartTag_windows').textContent, 'Edited');
    w.document.querySelectorAll('#elAiStart_windows li')[0].querySelector('.down').click();
    assert.deepStrictEqual(texts(w, 'windows'), FACT.windows);
    // add: a new empty row gets the focus; typing updates the list
    $(w, 'elAiStartAdd_windows').click();
    var inp = w.document.activeElement;
    assert.strictEqual(inp.tagName, 'INPUT');
    inp.value = 'Is BitLocker on?'; inp.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.strictEqual($(w, 'elAiStartCount_windows').textContent, '4 of 12');
    // remove the first
    w.document.querySelectorAll('#elAiStart_windows li')[0].querySelector('.rm').click();
    assert.deepStrictEqual(texts(w, 'windows'), [FACT.windows[1], FACT.windows[2], 'Is BitLocker on?']);
    assert.strictEqual(w.elAi.settingsDirty, true);
    // at most 12
    for (var i = 0; i < 12; i++) $(w, 'elAiStartAdd_windows').click();
    assert.strictEqual(texts(w, 'windows').length, 12);
    assert.strictEqual($(w, 'elAiStartAdd_windows').disabled, true);
    // saving: blank rows dropped; Linux edited, Windows reset -> null
    w.document.querySelectorAll('#elAiStart_linux li')[0].querySelector('.rm').click();
    assert.match($(w, 'elAiStart_linux').textContent, /No starter questions/);
    $(w, 'elAiStartReset_windows').click();
    assert.deepStrictEqual(texts(w, 'windows'), FACT.windows);
    w.elAiSaveSettings();
    var s = w.last('aiAdminSaveSettings').settings;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.starters)), { windows: null, linux: [] });
    $(w, 'elAiStartAdd_linux').click();
    w.document.activeElement.value = '  Which units failed?  '; w.document.activeElement.dispatchEvent(new w.Event('input', { bubbles: true }));
    $(w, 'elAiStartAdd_linux').click();   // left empty
    w.elAiSaveSettings();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.last('aiAdminSaveSettings').settings.starters.linux)), ['Which units failed?']);
});

test('access: "Users can change thinking and temperature in the chat" is on by default and saved with the settings', { skip: SKIP }, function () {
    var w = page();
    dataWith(w, {});
    assert.strictEqual($(w, 'elAiChatGen').checked, true, 'on when the server sends nothing (older settings)');
    w.elAiSaveSettings();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.last('aiAdminSaveSettings').settings.chatGen)), { enabled: true });
    w = page();
    dataWith(w, { chatGen: { enabled: false } });
    assert.strictEqual($(w, 'elAiChatGen').checked, false);
    $(w, 'elAiChatGen').checked = true;
    w.elAiSaveSettings();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.last('aiAdminSaveSettings').settings.chatGen)), { enabled: true });
    $(w, 'elAiChatGen').checked = false;
    w.elAiSaveSettings();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.last('aiAdminSaveSettings').settings.chatGen)), { enabled: false });
    assert.match($(w, 'elAiChatGen').parentNode.textContent, /Users can change thinking and temperature in the chat/);
});

test('saved results: retention and switch saved with the settings, counts shown, delete all asks first', { skip: SKIP }, function () {
    var w = page();
    dataWith(w, { history: { enabled: true, retentionDays: 45 } });
    assert.strictEqual($(w, 'elAiHistDays').value, '45');
    assert.strictEqual($(w, 'elAiHistOn').checked, true);
    assert.strictEqual($(w, 'elAiHistCounts').textContent, '4 chats, 1 diagnosis, 7 explanations.');
    $(w, 'elAiHistDays').value = '0';
    var n = w.sent.length;
    w.elAiSaveSettings();
    assert.strictEqual(w.sent.length, n, 'out of range: not sent');
    assert.ok($(w, 'elAiHistDaysErr'));
    $(w, 'elAiHistDays').value = '14'; $(w, 'elAiHistOn').checked = false;
    w.elAiSaveSettings();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.last('aiAdminSaveSettings').settings.history)), { enabled: false, retentionDays: 14 });
    // delete all: confirmed first
    var asked = null;
    w.confirm = function (m) { asked = m; return false; };
    $(w, 'elAiHistPurge').click();
    assert.match(asked, /Delete 12 saved chats, diagnoses and explanations of all users\?/);
    assert.strictEqual(w.last('aiAdminHistoryPurge'), undefined);
    w.confirm = function () { return true; };
    $(w, 'elAiHistPurge').click();
    var p = w.last('aiAdminHistoryPurge');
    assert.ok(p);
    w.h.aiAdminHistoryPurged(null, { reqId: p.reqId, removed: 12, counts: { chat: 0, diagnosis: 0, explain: 0, total: 0 } });
    assert.match($(w, 'elAiHistStatus').textContent, /Deleted 12 saved results/);
    assert.strictEqual($(w, 'elAiHistCounts').textContent, 'Nothing is saved.');
    assert.strictEqual($(w, 'elAiHistPurge').disabled, true);
    var w2 = page();
    dataWith(w2, {}, { historyAvailable: false, historyCounts: null });
    assert.strictEqual($(w2, 'elAiHistCounts').textContent, 'Not available on this server.');
    assert.strictEqual($(w2, 'elAiHistPurge').disabled, true);
});

var COLL = { data: 'elAiDataBody', prompt: 'elAiPromptBody', starters: 'elAiStartBody', requests: 'elAiReqBody' };
var FACTORY = { base: 'Base rules. {{nonce}}', ask: 'Ask. <followups>', explain: 'Explain. <explain>', diagnose: 'Diagnose. <diagnosis>' };
function withPrompts(w, settings) { dataWith(w, settings, { factory: FACTORY, factoryHash: {}, placeholders: { nonce: 'per request' } }); }
function isOpen(w, k) { return $(w, 'elAiColl_' + k).getAttribute('aria-expanded') == 'true' && !$(w, COLL[k]).hidden; }
function summary(w, k) { return Array.prototype.map.call($(w, 'elAiCollSum_' + k).children, function (e) { return e.textContent; }); }
function audits(w) { return w.sent.filter(function (m) { return m.pluginaction == 'aiAdminAudit'; }).length; }

test('collapsible sections: Data sent to the model, System prompt, Starter questions and Requests are closed on first load; Requests loads when opened', { skip: SKIP }, function () {
    var w = page();
    withPrompts(w, {});
    Object.keys(COLL).forEach(function (k) {
        var b = $(w, 'elAiColl_' + k);
        assert.strictEqual(b.tagName, 'BUTTON', k);
        assert.strictEqual(b.getAttribute('aria-expanded'), 'false', k);
        assert.strictEqual(b.getAttribute('aria-controls'), COLL[k], k);
        assert.strictEqual($(w, COLL[k]).hidden, true, k);
        assert.ok(b.querySelector('svg.elAiChev'), k + ' chevron');
    });
    assert.strictEqual($(w, 'elAiDataT').textContent, 'Data sent to the model');
    assert.strictEqual($(w, 'elAiPromptFs').getAttribute('aria-labelledby'), 'elAiPromptT');
    assert.strictEqual(audits(w), 0, 'no request list asked for while Requests is closed');
    // closed summaries
    assert.deepStrictEqual(summary(w, 'data'), ['Replacement: 10 of 10 types · 0 of 6 data types · Preview: every time']);
    assert.deepStrictEqual(summary(w, 'prompt'), ['Factory default']);
    assert.deepStrictEqual(summary(w, 'starters'), ['Windows: 3 · Linux: 3']);
    assert.strictEqual($(w, 'elAiCollSum_requests').textContent, '');
    // open Requests: the list is asked for once; closing and opening again does not ask again
    $(w, 'elAiColl_requests').click();
    assert.ok(isOpen(w, 'requests'));
    assert.strictEqual(audits(w), 1);
    var a = w.last('aiAdminAudit');
    assert.deepStrictEqual([a.skip, a.limit], [0, 50]);
    w.h.aiAdminAuditRows(null, { reqId: a.reqId, rows: [], total: 0 });
    assert.match($(w, 'elAiAuditRows').textContent, /No requests logged yet/);
    $(w, 'elAiColl_requests').click();
    assert.strictEqual(isOpen(w, 'requests'), false);
    $(w, 'elAiColl_requests').click();
    assert.strictEqual(audits(w), 1);
    // paging and filters behave as before
    w.elAiAuditPage(1);
    assert.strictEqual(audits(w), 2);
});

test('collapsible sections: the open state is remembered per browser; blocked storage leaves them closed', { skip: SKIP }, function () {
    var w = page();
    $(w, 'elAiColl_prompt').click();
    $(w, 'elAiColl_data').click(); $(w, 'elAiColl_data').click();
    assert.strictEqual(w.localStorage.getItem('evl_admin_open_prompt'), '1');
    assert.strictEqual(w.localStorage.getItem('evl_admin_open_data'), '0');
    assert.strictEqual(w.localStorage.getItem('evl_admin_open_requests'), null);
    var w2 = page({ store: { evl_admin_open_prompt: '1', evl_admin_open_data: '0', evl_admin_open_requests: '1' } });
    assert.deepStrictEqual(Object.keys(COLL).map(function (k) { return isOpen(w2, k); }), [false, true, false, true]);
    assert.strictEqual(audits(w2), 1, 'Requests remembered open: the list loads at once');
    assert.ok($(w2, 'elAiPromptFs').classList.contains('open'));
    var w3 = page({ noStorage: true });
    assert.deepStrictEqual(Object.keys(COLL).map(function (k) { return isOpen(w3, k); }), [false, false, false, false]);
    $(w3, 'elAiColl_starters').click();
    assert.ok(isOpen(w3, 'starters'), 'still opens without storage');
});

test('collapsible sections: a field error inside a closed section opens it and focuses the field', { skip: SKIP }, function () {
    var w = page();
    $(w, 'elAssistant').style.display = 'block';
    withPrompts(w, {});
    $(w, 'elAiAudFrom').value = '2026-05-10'; $(w, 'elAiAudTo').value = '2026-05-01';
    w.elAiAuditFilter();
    assert.ok(isOpen(w, 'requests'));
    assert.ok($(w, 'elAiAudToErr'), 'inline error');
    assert.strictEqual(w.document.activeElement, $(w, 'elAiAudTo'));
    assert.strictEqual(w.localStorage.getItem('evl_admin_open_requests'), null, 'opened for the error, not remembered');
    // Save settings still reads fields inside closed sections and still validates the others
    $(w, 'elAiR_ips').checked = false; $(w, 'elAiR_ips').dispatchEvent(new w.Event('change', { bubbles: true }));
    w.elAiStartAdd('linux'); w.elAi.starters.linux[3] = 'Is cron running?'; w.elAiStartState('linux');
    w.elAiSaveSettings();
    var s = w.last('aiAdminSaveSettings').settings;
    assert.strictEqual(s.redact.ips, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.starters.linux)), FACT.linux.concat(['Is cron running?']));
    assert.strictEqual(isOpen(w, 'data'), false);
    assert.strictEqual(isOpen(w, 'starters'), false);
});

test('collapsible sections: closed summaries follow edits (edited parts, unsaved changes, notes, counts)', { skip: SKIP }, function () {
    var w = page();
    withPrompts(w, { prompts: { ask: 'My ask. <followups>' }, starters: { windows: null, linux: ['Is journald healthy?'] }, categories: { network: true, notes: true }, previewPolicy: 'once' });
    assert.deepStrictEqual(summary(w, 'prompt'), ['Edited (Ask)']);
    assert.deepStrictEqual(summary(w, 'starters'), ['Windows: 3 · Linux: 1 (edited)']);
    assert.deepStrictEqual(summary(w, 'data'), ['Replacement: 10 of 10 types · 2 of 6 data types · Preview: once per user and endpoint']);
    // unsaved prompt edit (the dot in the tabs is inside the closed section; the summary says it)
    $(w, 'elAiPromptEdit').checked = true; $(w, 'elAiPromptEdit').dispatchEvent(new w.Event('change', { bubbles: true }));
    $(w, 'elAiTpl_base').value = 'Base rules without the nonce.'; $(w, 'elAiTpl_base').dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.deepStrictEqual(summary(w, 'prompt'), ['Edited (Base, Ask)', 'Unsaved changes', 'Editing', '1 note']);
    assert.ok($(w, 'elAiCollSum_prompt').querySelector('.elAiTag.unsaved'));
    $(w, 'elAiTpl_base').value = FACTORY.base; $(w, 'elAiTpl_base').dispatchEvent(new w.Event('input', { bubbles: true }));
    $(w, 'elAiPromptEdit').checked = false; $(w, 'elAiPromptEdit').dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.deepStrictEqual(summary(w, 'prompt'), ['Edited (Ask)']);
    // data: a type no longer replaced, another preview policy
    $(w, 'elAiR_macs').checked = false; $(w, 'elAiR_macs').dispatchEvent(new w.Event('change', { bubbles: true }));
    w.document.querySelector('input[name="elAiPreview"][value="never"]').checked = true;
    w.document.querySelector('input[name="elAiPreview"][value="never"]').dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.deepStrictEqual(summary(w, 'data'), ['Replacement: 9 of 10 types · 2 of 6 data types · Preview: off', 'Unsaved changes']);
    // starters: back to the factory list is unsaved until saved
    w.elAiStartReset('linux');
    assert.deepStrictEqual(summary(w, 'starters'), ['Windows: 3 · Linux: 3', 'Unsaved changes']);
    // saved: the summaries show the saved state
    w.elAiSaveSettings();
    var sv = w.last('aiAdminSaveSettings');
    w.h.aiAdminSettingsSaved(null, { reqId: sv.reqId, settings: sv.settings });
    assert.deepStrictEqual(summary(w, 'data'), ['Replacement: 9 of 10 types · 2 of 6 data types · Preview: off']);
    assert.deepStrictEqual(summary(w, 'starters'), ['Windows: 3 · Linux: 3']);
    assert.deepStrictEqual(summary(w, 'prompt'), ['Edited (Ask)']);
});
