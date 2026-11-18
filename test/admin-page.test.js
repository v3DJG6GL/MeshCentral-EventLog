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
