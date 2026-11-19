'use strict';
// The admin page (views/admin.handlebars) in jsdom: the endpoint form's generation settings (server defaults as
// placeholders, levels the server does not take disabled, Anthropic / Responses limits), the offer to use the first
// saved endpoint for the Default config set, and the layout: side navigation (remembered page, scrollspy), the parts
// that start collapsed, the data boundary strip, the save bar (areas, Discard, Save per area), batched assignments
// and the config set editor's payload. Runs when jsdom can be found (EVL_JSDOM or a resolvable jsdom).
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
        .replace('{{{configAssignments}}}', JSON.stringify(opts.assignments || []))
        .replace('{{{aiAdmin}}}', JSON.stringify(opts.ai || { full: true, available: true }));
    var dom = new JSDOM_MOD.JSDOM(html, {
        runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://mesh.example/pluginadmin.ashx?pin=eventlog',
        beforeParse: function (w) {
            w.sent = [];
            w.meshes = opts.meshes || {}; w.nodes = opts.nodes || [];
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
    assert.strictEqual(w.document.querySelector('#elAiEpRows .elAiUnused').textContent, 'Not used by any config set yet — assign it in Config sets.');
    // Use it for Default: the config-set save path, Default set, only the endpoint id
    w.elAiOfferUse();
    var cfg = w.last('adminSaveConfig');
    assert.deepStrictEqual([cfg.id, cfg.opts], ['_default', { aiEndpointId: EP.id }]);
    assert.strictEqual($(w, 'elAiOfferYes').disabled, true);
    w.h.adminUpdateConfigSets(null, { sets: [{ _id: 'd1', default: true, name: 'Default', aiEndpointId: EP.id }], selected: '', saved: true, defaultSet: true });
    assert.strictEqual($(w, 'elAiOffer').hidden, true);
    assert.match($(w, 'elAiEpStatus').textContent, /The Default config set now uses “gpu-01”/);
    assert.strictEqual($(w, 'elSaveStatus').textContent, '', 'the config set status is not touched');
    assert.strictEqual(w.elDirty().config, false, 'the editor shows the Default set with the new endpoint, not an unsaved change');
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
    w.elGoPage('assistant');   // the page is shown (focus only lands on visible elements)
    $(w, 'elAiColl_starters').click();   // the part is closed until opened
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


var FACTORY = { base: 'Base rules. {{nonce}}', ask: 'Ask. <followups>', explain: 'Explain. <explain>', diagnose: 'Diagnose. <diagnosis>' };
function withPrompts(w, settings, extra) { dataWith(w, settings, Object.assign({ factory: FACTORY, factoryHash: {}, placeholders: { nonce: 'per request' } }, extra || {})); }
var COLL = { prompt: 'elAiPromptBody', starters: 'elAiStartBody', preview: 'elAiPrevBody', adv: 'elAiAdvBody' };
function isOpen(w, k) { return $(w, 'elAiColl_' + k).getAttribute('aria-expanded') == 'true' && !$(w, COLL[k]).hidden; }
function summary(w, k) { return Array.prototype.map.call($(w, 'elAiCollSum_' + k).children, function (e) { return e.textContent; }); }
function audits(w) { return w.sent.filter(function (m) { return m.pluginaction == 'aiAdminAudit'; }).length; }
function shown(w) { return ['elAssignment', 'elConfigSets', 'elAssistant', 'elRequests'].filter(function (id) { return !$(w, id).hidden; }); }
function fire(w, el, type) { el.dispatchEvent(new w.Event(type || 'change', { bubbles: true })); }
function setVal(w, id, v) { $(w, id).value = v; fire(w, $(w, id), 'input'); fire(w, $(w, id), 'change'); }
function setCheck(w, id, on) { $(w, id).checked = on; fire(w, $(w, id), 'change'); }
function bar(w) { return $(w, 'elSaveBar').hidden ? null : $(w, 'elBarList').textContent; }
function stripLines(w) { return Array.prototype.map.call($(w, 'elAiStripText').children, function (p) { return (p.className ? p.className + ': ' : '') + p.textContent; }); }
var CLOUD = Object.assign({}, EP, { id: 'aiEndpoint:cloud0000001', name: 'strata', baseUrl: 'https://llm.example.com/v1', network: 'public', caps: null });
var LOCAL = Object.assign({}, EP, { id: 'aiEndpoint:local0000001', name: 'ollama-gpu01', baseUrl: 'http://10.20.4.11:11434/v1', network: 'private', caps: null });

test('side navigation: pages instead of tabs, aria-current, the last page remembered per browser, "Go to" select', { skip: SKIP }, function () {
    var w = page();
    assert.deepStrictEqual(shown(w), ['elAssignment'], 'Assignment first');
    assert.strictEqual(w.document.querySelector('#elRail a[data-page="assignment"]').getAttribute('aria-current'), 'page');
    assert.strictEqual(w.document.getElementById('eventLogAdminNav'), null, 'no top tabs');
    w.document.querySelector('#elRail a[data-page="configsets"]').click();
    assert.deepStrictEqual(shown(w), ['elConfigSets']);
    assert.strictEqual(w.document.querySelector('#elRail a[data-page="configsets"]').getAttribute('aria-current'), 'page');
    assert.strictEqual(w.document.querySelector('#elRail a[data-page="assignment"]').hasAttribute('aria-current'), false);
    assert.strictEqual(w.localStorage.getItem('evl_admin_page'), 'configsets');
    assert.strictEqual(w.document.activeElement.tagName, 'H1', 'focus moves to the page heading');
    // an Assistant section link opens the Assistant page
    w.document.querySelector('#elRail a[data-sec="elSecAccess"]').click();
    assert.deepStrictEqual(shown(w), ['elAssistant']);
    assert.strictEqual(w.document.querySelector('#elRail a[data-page="assistant"]:not([data-sec])').getAttribute('aria-current'), 'page');
    assert.strictEqual(w.document.activeElement.id, 'elAiAccessH');
    // Requests is its own page and loads its list when first opened (not before)
    assert.strictEqual(audits(w), 0);
    w.document.querySelector('#elRail a[data-page="requests"]').click();
    assert.deepStrictEqual(shown(w), ['elRequests']);
    assert.strictEqual(audits(w), 1);
    w.elGoPage('assignment'); w.elGoPage('requests');
    assert.strictEqual(audits(w), 1, 'loaded once');
    // narrow width: the "Go to" select does the same
    $(w, 'elNavSel').value = 'configsets'; fire(w, $(w, 'elNavSel'));
    assert.deepStrictEqual(shown(w), ['elConfigSets']);
    // remembered: a new page opens the last one (Requests loads at once)
    var w2 = page({ store: { evl_admin_page: 'requests' } });
    assert.deepStrictEqual(shown(w2), ['elRequests']);
    assert.strictEqual(audits(w2), 1);
    var w3 = page({ noStorage: true });
    assert.deepStrictEqual(shown(w3), ['elAssignment'], 'blocked storage: Assignment');
    w3.elGoPage('configsets');
    assert.deepStrictEqual(shown(w3), ['elConfigSets']);
});

test('scrollspy: the rail marks the Assistant section at the top of the window', { skip: SKIP }, function () {
    var w = page();
    w.elGoPage('assistant');
    var tops = { elSecEndpoints: -600, elSecData: -200, elSecBehaviour: 40, elSecAccess: 500, elSecSaved: 900 };
    Object.keys(tops).forEach(function (id) { $(w, id).getBoundingClientRect = function () { return { top: tops[id], bottom: tops[id] + 300, left: 0, right: 0, width: 0, height: 300 }; }; });
    w.elSpy();
    var cur = w.document.querySelectorAll('#elRail a.spy');
    assert.strictEqual(cur.length, 1);
    assert.strictEqual(cur[0].getAttribute('data-sec'), 'elSecBehaviour');
    assert.strictEqual(cur[0].getAttribute('aria-current'), 'location');
    assert.strictEqual($(w, 'elNavSel').value, 'assistant|elSecBehaviour');
    tops = { elSecEndpoints: 120, elSecData: 700, elSecBehaviour: 1400, elSecAccess: 2000, elSecSaved: 2600 };
    w.elSpy();
    assert.strictEqual(w.document.querySelector('#elRail a.spy').getAttribute('data-sec'), 'elSecEndpoints', 'at the top: the first section');
    w.elGoPage('configsets');
    assert.strictEqual(w.document.querySelectorAll('#elRail a.spy, #elRail a[aria-current="location"]').length, 0, 'no section marked on other pages');
});

test('collapsed by default: only System prompt, Starter questions, Full prompt preview and the endpoint\'s Advanced options', { skip: SKIP }, function () {
    var w = page();
    withPrompts(w, {});
    var colls = Array.prototype.map.call(w.document.querySelectorAll('button[aria-controls][aria-expanded].coll-btn'), function (b) { return b.id; });
    assert.deepStrictEqual(colls.sort(), ['elAiColl_adv', 'elAiColl_preview', 'elAiColl_prompt', 'elAiColl_starters']);
    Object.keys(COLL).forEach(function (k) {
        assert.strictEqual(isOpen(w, k), false, k);
        assert.ok($(w, 'elAiColl_' + k).querySelector('svg.elAiChev'), k + ' chevron');
    });
    // Data sent to the model, Access and Saved results are plain cards (not collapsible); Requests is a page
    ['elAiDataBody', 'elAiQuotaQ', 'elAiHistDays'].forEach(function (id) { assert.strictEqual($(w, id).closest('[data-coll]'), null, id); });
    ['elAiColl_data', 'elAiColl_requests', 'elAiCollSum_data'].forEach(function (id) { assert.strictEqual($(w, id), null, id); });
    // summaries while closed
    assert.deepStrictEqual(summary(w, 'prompt'), ['Factory default in all four parts.', 'Editing is off.']);
    assert.deepStrictEqual(summary(w, 'starters'), ['Windows: 3 questions, Linux: 3 questions.']);
    assert.match($(w, 'elAiCollSum_preview').textContent, /including unsaved changes/);
    // remembered per browser; blocked storage leaves them closed
    $(w, 'elAiColl_prompt').click();
    assert.ok(isOpen(w, 'prompt'));
    assert.strictEqual(w.localStorage.getItem('evl_admin_open_prompt'), '1');
    var w2 = page({ store: { evl_admin_open_prompt: '1', evl_admin_open_adv: '1' } });
    assert.deepStrictEqual(Object.keys(COLL).map(function (k) { return isOpen(w2, k); }), [true, false, false, true]);
    var w3 = page({ noStorage: true });
    assert.deepStrictEqual(Object.keys(COLL).map(function (k) { return isOpen(w3, k); }), [false, false, false, false]);
    $(w3, 'elAiColl_starters').click();
    assert.ok(isOpen(w3, 'starters'), 'still opens without storage');
});

test('endpoint editor: Advanced options holds the rarely changed fields, shows a live summary and opens for a field error', { skip: SKIP }, function () {
    var w = page();
    w.elGoPage('assistant');
    w.data([EP]);
    w.elAiOpenForm(w.elAi.endpoints[0]);
    ['elAiMaxOut', 'elAiTimeout', 'elAiCtx', 'elAiThinking', 'elAiTemp', 'elAiEpExtra', 'elAiLinkLocal'].forEach(function (id) { assert.strictEqual($(w, id).closest('[data-coll]').id, 'elAiAdvBody', id); });
    w.document.querySelectorAll('input[name="elAiToolMode"]').forEach(function (r) { assert.strictEqual(r.closest('[data-coll]').id, 'elAiAdvBody'); });
    assert.strictEqual(isOpen(w, 'adv'), false);
    assert.strictEqual($(w, 'elAiCollSum_adv').textContent, 'The model reads data automatically. Limits use the defaults. Generation uses the server’s values. Link-local addresses are blocked.');
    setVal(w, 'elAiTimeout', '300');
    w.document.querySelector('input[name="elAiToolMode"][value="summary"]').checked = true; fire(w, w.document.querySelector('input[name="elAiToolMode"][value="summary"]'));
    setVal(w, 'elAiEpExtra', '/no_think');
    assert.strictEqual($(w, 'elAiCollSum_adv').textContent, 'The model reads a summary only. Limits: timeout 300 s. Generation uses the server’s values. Model-specific instructions set. Link-local addresses are blocked.');
    // an error in a closed part opens it and focuses the field; opened for the error, not remembered
    $(w, 'elAiTopP').value = '7';
    w.elAiSaveEndpoint();
    assert.ok(isOpen(w, 'adv'));
    assert.ok($(w, 'elAiTopPErr'));
    assert.strictEqual(w.document.activeElement, $(w, 'elAiTopP'));
    assert.strictEqual(w.localStorage.getItem('evl_admin_open_adv'), null);
    assert.strictEqual(bar(w), null, 'the endpoint editor is saved on its own, not with the bar');
});

test('data boundary strip: a cloud endpoint in use (values always replaced, preview warning), only local, none', { skip: SKIP }, function () {
    var w = page();
    w.elGoPage('assistant');
    withPrompts(w, { enabled: true, redact: { ips: false, serials: false }, categories: { storedEvents: true, deviceSummary: true }, previewPolicy: 'every' },
        { endpoints: [CLOUD, LOCAL], usedBy: { [CLOUD.id]: ['Default'] } });
    assert.strictEqual($(w, 'elAiStripFlow').getAttribute('aria-hidden'), 'true');
    assert.strictEqual($(w, 'elAiStripText').getAttribute('aria-live'), 'polite');
    assert.deepStrictEqual(Array.prototype.map.call(w.document.querySelectorAll('#elAiStripFlow .db-node'), function (n) { return n.className + ' | ' + n.textContent; }), [
        'db-node | Devicesagents send events', 'db-node | MeshCentral serverreplaces values first',
        'db-node local idle | ollama-gpu01Local, not used', 'db-node cloud | strataCloud, used by Default']);
    assert.ok(w.document.querySelector('#elAiStripFlow .db-zone .db-locals'), 'local endpoints are drawn inside the network');
    assert.strictEqual(w.document.querySelector('#elAiStripFlow .db-cross').className, 'db-cross');
    assert.deepStrictEqual(stripLines(w), [
        'Leaves your network to strata (Cloud): stored events and device summary.',
        'Replaced first (10 of 10): user names, computer names, domain names, IP addresses, MAC addresses, email addresses, Windows SIDs, paths with user names, secrets in messages, serial numbers.',
        'quiet: Always replaced for cloud endpoints, also IP addresses and serial numbers, which are not ticked below.',
        'Preview: every time.']);
    assert.strictEqual(w.document.querySelectorAll('#elAiStripText .db-warn').length, 0, 'no warning: the server replaces everything for a cloud endpoint');
    // live: another data type, then no preview
    setCheck(w, 'elAiC_network', true);
    assert.match(stripLines(w)[0], /stored events, device summary and network interfaces\.$/);
    w.document.querySelector('input[name="elAiPreview"][value="never"]').checked = true; fire(w, w.document.querySelector('input[name="elAiPreview"][value="never"]'));
    assert.deepStrictEqual(stripLines(w).slice(-2), ['Preview: never.', 'db-warn: Nobody sees a preview before data goes to strata.']);
    setCheck(w, 'elAiEnabled', false);
    assert.strictEqual(stripLines(w)[0], 'quiet: The Assistant is turned off under Access, so nothing is sent now. Once it is on:');

    // only a local endpoint in use: nothing leaves; the ticks decide; no warning even without a preview
    var w2 = page();
    withPrompts(w2, { enabled: true, redact: { serials: false }, categories: { storedEvents: true }, previewPolicy: 'never' }, { endpoints: [CLOUD, LOCAL], usedBy: { [LOCAL.id]: ['Default', 'Servers'] } });
    assert.deepStrictEqual(stripLines(w2), [
        'Nothing leaves your network. Default and Servers use ollama-gpu01 on your network. It may read stored events.',
        'Replaced first (9 of 10): user names, computer names, domain names, IP addresses, MAC addresses, email addresses, Windows SIDs, paths with user names, secrets in messages.',
        'quiet: Sent as they are: serial numbers. Replacing values is your choice for endpoints on your network.']);
    assert.strictEqual(w2.document.querySelector('#elAiStripFlow .db-cross').className, 'db-cross idle');
    assert.strictEqual(w2.document.querySelectorAll('#elAiStripText .db-warn').length, 0);

    // no config set uses an endpoint
    var w3 = page();
    withPrompts(w3, { enabled: true }, { endpoints: [LOCAL], usedBy: {} });
    assert.deepStrictEqual(stripLines(w3), ['Nothing is sent. No config set uses an endpoint yet. Choose one under Config sets, Assistant endpoint.']);
    assert.strictEqual(w3.document.querySelector('#elAiStripFlow .db-cross'), null, 'no endpoint outside: no arrow across the boundary');
});

test('save bar: appears for changes, names the areas, marks the rail; Discard restores; Save sends each area once and reports', { skip: SKIP }, function () {
    var w = page({ sets: [{ _id: 'd1', default: true, name: 'Default', liveLogs: 'Application,System', liveNum: 100, liveEntryTypes: [1, 2, 3] }] });
    withPrompts(w, { enabled: true, quotas: { perUserQuestions: 100, perUserTokens: 0 } });
    assert.strictEqual(bar(w), null, 'hidden while nothing changed');
    setCheck(w, 'elAiR_ips', false);
    setVal(w, 'elAiQuotaQ', '50');
    assert.strictEqual(bar(w), 'Data sent to the model, Access');
    assert.strictEqual(w.document.querySelector('#elRail a[data-area="data"] .dot').hidden, false);
    assert.strictEqual(w.document.querySelector('#elRail a[data-area="access"] .dot').hidden, false);
    assert.strictEqual(w.document.querySelector('#elRail a[data-area="beh"] .dot').hidden, true);
    assert.match(w.document.querySelector('#elRail a[data-area="data"]').textContent, /\(unsaved changes\)/);
    // back to the loaded value: no longer a change
    setVal(w, 'elAiQuotaQ', '100');
    assert.strictEqual(bar(w), 'Data sent to the model');
    // Discard restores the last loaded values
    setVal(w, 'elAiQuotaQ', '50');
    setVal(w, 'elname', 'Main');
    assert.strictEqual(bar(w), 'Config set Main, Data sent to the model, Access');
    $(w, 'elBarDiscard').click();
    assert.strictEqual(bar(w), null);
    assert.strictEqual($(w, 'elAiR_ips').checked, true);
    assert.strictEqual($(w, 'elAiQuotaQ').value, '100');
    assert.strictEqual($(w, 'elname').value, 'Default');
    assert.strictEqual(w.sent.filter(function (m) { return /^(aiAdminSaveSettings|adminSaveConfig)$/.test(m.pluginaction); }).length, 0, 'Discard sends nothing');
    // Save: one settings save for the Assistant areas, one config save
    setCheck(w, 'elAiTranscripts', true);
    setVal(w, 'elAiExtra', 'Answer in German.');
    setVal(w, 'elliveLogs', 'Application');
    assert.strictEqual(bar(w), 'Config set Default, Assistant behaviour, Requests');
    $(w, 'elBarSave').click();
    var st = w.sent.filter(function (m) { return m.pluginaction == 'aiAdminSaveSettings'; }), cf = w.sent.filter(function (m) { return m.pluginaction == 'adminSaveConfig'; });
    assert.strictEqual(st.length, 1); assert.strictEqual(cf.length, 1);
    assert.strictEqual(st[0].settings.storeTranscripts, true);
    assert.strictEqual(st[0].settings.extraInstructions, 'Answer in German.');
    assert.strictEqual(cf[0].id, '_default'); assert.strictEqual(cf[0].opts.liveLogs, 'Application');
    assert.strictEqual(w.last('adminAssignConfig'), undefined, 'no assignment changes: nothing sent');
    assert.strictEqual($(w, 'elBarSave').disabled, true, 'Save waits for the answers');
    assert.match($(w, 'elAiSetStatus').textContent, /Saving/);
    // the config answer arrives first: that area is saved, the settings are still pending
    w.h.adminUpdateConfigSets(null, { sets: [Object.assign({ _id: 'd1', default: true }, cf[0].opts)], selected: '', saved: true, defaultSet: true, name: 'Default' });
    assert.strictEqual(bar(w), 'Assistant behaviour, Requests');
    assert.strictEqual($(w, 'elSaveStatus').textContent, '');
    // a refused settings save keeps the bar with the reason
    w.h.aiAdminError(null, { reqId: st[0].reqId, error: 'Settings are locked' });
    assert.strictEqual(bar(w), 'Assistant behaviour, Requests');
    assert.match($(w, 'elAiSetStatus').textContent, /Assistant settings not saved: Settings are locked/);
    assert.strictEqual($(w, 'elBarSave').disabled, false);
    $(w, 'elBarSave').click();
    var st2 = w.last('aiAdminSaveSettings');
    w.h.aiAdminSettingsSaved(null, { reqId: st2.reqId, settings: st2.settings });
    assert.strictEqual(bar(w), null, 'everything saved: the bar goes away');
    assert.match($(w, 'elSavedNote').textContent, /Saved Assistant behaviour, Requests/);
    assert.strictEqual($(w, 'elAiExtra').value, 'Answer in German.');
});

test('save bar: an invalid field keeps the bar, shows its page and focuses it; nothing is sent', { skip: SKIP }, function () {
    var w = page();
    withPrompts(w, { enabled: true, history: { enabled: true, retentionDays: 30 } });
    setVal(w, 'elAiHistDays', '0');
    setVal(w, 'elliveLogs', 'System');
    w.elGoPage('configsets');
    var n = w.sent.length;
    $(w, 'elBarSave').click();
    assert.strictEqual(w.sent.length, n, 'nothing sent, the config set included');
    assert.deepStrictEqual(shown(w), ['elAssistant'], 'the page with the field is shown');
    assert.strictEqual(w.document.activeElement, $(w, 'elAiHistDays'));
    assert.ok($(w, 'elAiHistDaysErr'), 'inline error');
    assert.strictEqual(bar(w), 'Config set Default, Saved results');
    assert.match($(w, 'elAiSetStatus').textContent, /Check the marked fields/);
    setVal(w, 'elAiHistDays', '14');
    $(w, 'elBarSave').click();
    assert.strictEqual(w.last('aiAdminSaveSettings').settings.history.retentionDays, 14);
    assert.strictEqual($(w, 'elAiHistDaysErr'), null);
});

var SETS = [
    { _id: 'd1', default: true, name: 'Default', liveLogs: 'Application,System', liveNum: 100, liveEntryTypes: [1, 2, 3], liveCategories: ['Application'], liveCategoriesMode: 'exclude', liveSources: 'plasmashell, kwin*', liveSourcesMode: 'exclude',
      historyEnabled: true, historyLogs: 'Application,System,Security', historyEntryTypes: ['1', '2'], historyCategories: 'kernel,Auth', historyCategoriesMode: 'include', historySources: '', historySourcesMode: 'include', retentionDays: 45,
      aiEndpointId: '', alerts: [{ id: 'r1', enabled: true, name: 'Disk errors', levels: [1, 2], logs: 'System', sources: 'disk, Ntfs', ids: '7, 55', text: '', threshold: 3, windowMin: 10, cooldownMin: 60 }] },
    { _id: 's2', name: 'Servers', liveLogs: 'System', liveNum: 50, liveEntryTypes: [2], historyEnabled: false, historyLogs: 'System', historyEntryTypes: [], retentionDays: 30, alerts: [] }
];

test('config sets: the side-by-side editor saves exactly the stored format; chips are checkboxes; alert rules have a summary and an editor', { skip: SKIP }, function () {
    var w = page({ sets: SETS });
    w.elGoPage('configsets');
    // chips are labelled checkboxes in a group
    var live = $(w, 'elliveEntryTypes');
    assert.strictEqual(live.getAttribute('role'), 'group');
    assert.deepStrictEqual(Array.prototype.map.call(live.querySelectorAll('input[type=checkbox]'), function (i) { return i.parentNode.textContent + ':' + i.checked; }),
        ['LogAlways:false', 'Critical:true', 'Error:true', 'Warning:true', 'Info:false', 'Verbose:false']);
    assert.deepStrictEqual(Array.prototype.map.call($(w, 'elhistoryCategories').querySelectorAll('input:checked'), function (i) { return i.value; }), ['Kernel', 'Auth'], 'a stored string list, any case');
    // the alert rule: one summary line, the fields behind Edit
    var rule = w.document.querySelector('#elalertRules .elAlertRule');
    assert.strictEqual(rule.querySelector('.elaTitle').textContent, 'Disk errors');
    assert.strictEqual(rule.querySelector('.elaSum').textContent, 'Critical or Error, in System, from disk, Ntfs, IDs 7, 55. Fires at 3 within 10 min, then waits 60 min.');
    assert.strictEqual(rule.querySelector('.rule-b').hidden, true);
    rule.querySelector('.elaEdit').click();
    assert.strictEqual(rule.querySelector('.rule-b').hidden, false);
    assert.strictEqual(rule.querySelector('.elaEdit').getAttribute('aria-expanded'), 'true');
    // unchanged: Save sends what the old form sent for the same values
    assert.strictEqual(bar(w), null);
    w.saveConfig();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.last('adminSaveConfig'))), { action: 'plugin', plugin: 'eventlog', pluginaction: 'adminSaveConfig', id: '_default', opts: {
        name: 'Default', liveLogs: 'Application,System', liveNum: '100', liveEntryTypes: ['1', '2', '3'], liveCategories: ['Application'], liveCategoriesMode: 'exclude',
        liveSources: 'plasmashell, kwin*', liveSourcesMode: 'exclude', historyEnabled: true, historyLogs: 'Application,System,Security', historyEntryTypes: ['1', '2'],
        historyCategories: ['Kernel', 'Auth'], historyCategoriesMode: 'include', historySources: '', historySourcesMode: 'include', retentionDays: 45,
        alerts: [{ id: 'r1', enabled: true, name: 'Disk errors', levels: [1, 2], logs: 'System', sources: 'disk, Ntfs', ids: '7, 55', text: '', threshold: 3, windowMin: 10, cooldownMin: 60 }],
        aiEndpointId: '' } });
    w.h.adminUpdateConfigSets(null, { sets: SETS, selected: '', saved: true, defaultSet: true, name: 'Default' });
    // edits through the chips and the rule editor
    var ver = live.querySelector('input[value="5"]'); ver.checked = true; fire(w, ver);
    var err = rule.querySelector('.elaLevels input[value="2"]'); err.checked = false; fire(w, err);
    assert.strictEqual(rule.querySelector('.elaSum').textContent.indexOf('Critical, in System'), 0, 'the summary follows the editor');
    assert.strictEqual(bar(w), 'Config set Default');
    $(w, 'elBarSave').click();
    var o = w.last('adminSaveConfig').opts;
    assert.deepStrictEqual([o.liveEntryTypes, o.alerts[0].levels], [['1', '2', '3', '5'], [1]]);
    // a new rule opens with its editor
    $(w, 'elaAddBtn').click();
    var rules = w.document.querySelectorAll('#elalertRules .elAlertRule');
    assert.strictEqual(rules.length, 2);
    assert.strictEqual(rules[1].querySelector('.rule-b').hidden, false);
    assert.strictEqual(w.document.activeElement, rules[1].querySelector('.elaName'));
});

test('config sets: switching with unsaved changes is held back in the save bar; Discard and switch; Delete asks first', { skip: SKIP }, function () {
    var w = page({ sets: SETS });
    w.elGoPage('configsets');
    setVal(w, 'elhistoryLogs', 'System');
    $(w, 'elconfigSet').value = 's2'; fire(w, $(w, 'elconfigSet'));
    assert.strictEqual($(w, 'elconfigSet').value, '', 'still the Default set');
    assert.strictEqual($(w, 'elname').value, 'Default');
    assert.strictEqual($(w, 'elBarWarn').hidden, false);
    assert.match($(w, 'elBarWarnT').textContent, /Config set “Default” has unsaved changes\. Save or discard them before you switch to another set\./);
    $(w, 'elBarSwitch').click();
    assert.strictEqual($(w, 'elconfigSet').value, 's2');
    assert.strictEqual($(w, 'elname').value, 'Servers');
    assert.strictEqual($(w, 'elhistoryEnabled').checked, false);
    assert.strictEqual($(w, 'elhistorySources').value, '', 'a field the set does not have shows the default, not the previous set');
    assert.strictEqual(bar(w), null);
    assert.strictEqual($(w, 'elCfgDelBtn').disabled, false);
    // Default cannot be deleted
    w.elCfgSwitch('');
    assert.strictEqual($(w, 'elCfgDelBtn').disabled, true);
    // a new set is an unsaved change until saved
    $(w, 'elCfgNew').click();
    assert.strictEqual($(w, 'elconfigSet').value, '_new');
    assert.strictEqual(bar(w), 'Config set New Config');
    $(w, 'elBarDiscard').click();
    assert.strictEqual($(w, 'elconfigSet').value, '');
    assert.strictEqual(w.document.querySelector('#elconfigSet option[value="_new"]'), null);
    // delete: confirmed first
    w.elCfgSwitch('s2');
    var asked = null; w.confirm = function (m) { asked = m; return false; };
    $(w, 'elCfgDelBtn').click();
    assert.match(asked, /Delete the config set “Servers”\?/);
    assert.strictEqual(w.last('adminDeleteConfig'), undefined);
    w.confirm = function () { return true; };
    $(w, 'elCfgDelBtn').click();
    assert.strictEqual(w.last('adminDeleteConfig').id, 's2');
});

var MESHES = { 'mesh//g1': { _id: 'mesh//g1', name: 'Office Zurich', mtype: 2 }, 'mesh//g2': { _id: 'mesh//g2', name: 'Lab', mtype: 2 } };
var NODES = [{ _id: 'node//a', name: 'FIN-LT-0142', meshid: 'mesh//g1', mtype: 2 }, { _id: 'node//b', name: 'LAB-UBU-03', meshid: 'mesh//g2', mtype: 2 }, { _id: 'node//c', name: 'HR-LT-0031', meshid: 'mesh//g2', mtype: 2 }];
function rowOf(w, name) { return Array.prototype.filter.call(w.document.querySelectorAll('#elAssignment tr.eldataRow'), function (r) { return r.children[1].textContent === name; })[0]; }
function setCell(r) { return r.lastChild.firstChild; }

test('assignment: inherited values muted, own sets bold; selections batched into the save bar and sent per set on Save; filter', { skip: SKIP }, function () {
    var w = page({ sets: SETS, meshes: MESHES, nodes: NODES, assignments: [{ asset: 'mesh//g2', configId: 's2' }, { asset: 'node//c', configId: 'default' }] });
    assert.deepStrictEqual([setCell(rowOf(w, 'Office Zurich')).className, setCell(rowOf(w, 'Office Zurich')).textContent], ['inh', 'Default (inherited)']);
    assert.deepStrictEqual([setCell(rowOf(w, 'Lab')).className, setCell(rowOf(w, 'Lab')).textContent], ['expl', 'Servers']);
    assert.deepStrictEqual([setCell(rowOf(w, 'LAB-UBU-03')).className, setCell(rowOf(w, 'LAB-UBU-03')).textContent], ['inh', 'Servers (from group)']);
    assert.deepStrictEqual([setCell(rowOf(w, 'HR-LT-0031')).className, setCell(rowOf(w, 'HR-LT-0031')).textContent], ['expl', 'Default']);
    assert.strictEqual($(w, 'elAsAssign').disabled, true);
    // select two rows, assign Servers: pending, highlighted, nothing sent yet
    var a = rowOf(w, 'FIN-LT-0142').querySelector('input'), g = rowOf(w, 'Office Zurich').querySelector('input');
    a.checked = true; fire(w, a); g.checked = true; fire(w, g);
    assert.strictEqual($(w, 'elAsCount').textContent, '2 selected');
    $(w, 'elassignSet').value = 's2';
    $(w, 'elAsAssign').click();
    assert.strictEqual(w.last('adminAssignConfig'), undefined);
    assert.ok(rowOf(w, 'FIN-LT-0142').classList.contains('chg'));
    assert.strictEqual(rowOf(w, 'FIN-LT-0142').querySelector('.chgtag').textContent, 'Changed');
    assert.strictEqual(setCell(rowOf(w, 'Office Zurich')).textContent, 'Servers');
    assert.strictEqual(bar(w), '2 assignments changed');
    assert.strictEqual(w.document.querySelector('#elRail a[data-area="assign"] .dot').hidden, false);
    // clear the HR device's own set: back to its group's set
    var c = rowOf(w, 'HR-LT-0031').querySelector('input'); c.checked = true; fire(w, c);
    $(w, 'elAsClear').click();
    assert.strictEqual(setCell(rowOf(w, 'HR-LT-0031')).textContent, 'Servers (from group)');
    assert.strictEqual(bar(w), '3 assignments changed');
    // filter
    setVal(w, 'elAsFilter', 'lab');
    assert.deepStrictEqual(Array.prototype.filter.call(w.document.querySelectorAll('#elAssignment tr.eldataRow'), function (r) { return !r.hidden; }).map(function (r) { return r.children[1].textContent; }), ['Lab', 'HR-LT-0031', 'LAB-UBU-03']);
    $(w, 'elAsDevicesAll').checked = true; fire(w, $(w, 'elAsDevicesAll'));
    assert.strictEqual($(w, 'elAsCount').textContent, '2 selected', 'select all: only the rows shown');
    $(w, 'elAsDevicesAll').checked = false; fire(w, $(w, 'elAsDevicesAll'));
    assert.strictEqual($(w, 'elAsCount').textContent, 'Select rows to change them');
    setVal(w, 'elAsFilter', '');
    // Save: one message per target set, with the existing action
    $(w, 'elBarSave').click();
    var msgs = w.sent.filter(function (m) { return m.pluginaction == 'adminAssignConfig'; }).map(function (m) { return m.configId + ':' + m.selection.slice().sort().join(','); }).sort();
    assert.deepStrictEqual(msgs, ['_clear:node//c', 's2:mesh//g1,node//a']);
    w.h.setsAssigned(null, { data: [{ asset: 'mesh//g2', configId: 's2' }, { asset: 'mesh//g1', configId: 's2' }, { asset: 'node//a', configId: 's2' }, { asset: 'node//c', configId: 'default' }] });
    assert.strictEqual(bar(w), '1 assignment changed', 'one answer of two: what the server has is no longer pending');
    assert.strictEqual($(w, 'elBarSave').disabled, true, 'still waiting');
    w.h.setsAssigned(null, { data: [{ asset: 'mesh//g2', configId: 's2' }, { asset: 'mesh//g1', configId: 's2' }, { asset: 'node//a', configId: 's2' }] });
    assert.strictEqual(bar(w), null);
    assert.strictEqual(rowOf(w, 'FIN-LT-0142').classList.contains('chg'), false);
    assert.deepStrictEqual([setCell(rowOf(w, 'FIN-LT-0142')).className, setCell(rowOf(w, 'FIN-LT-0142')).textContent], ['expl', 'Servers']);
    assert.match($(w, 'elSavedNote').textContent, /Saved 3 assignments/);
    // Discard drops pending assignments
    var b = rowOf(w, 'LAB-UBU-03').querySelector('input'); b.checked = true; fire(w, b);
    $(w, 'elAsAssign').click();
    assert.strictEqual(bar(w), '1 assignment changed');
    $(w, 'elBarDiscard').click();
    assert.strictEqual(bar(w), null);
    assert.strictEqual(setCell(rowOf(w, 'LAB-UBU-03')).textContent, 'Servers (from group)');
});

test('administrators who are not full administrators: no Assistant in the navigation, the config set keeps its stored endpoint', { skip: SKIP }, function () {
    var w = page({ ai: { full: false, available: true }, sets: SETS, store: { evl_admin_page: 'assistant' } });
    assert.deepStrictEqual(shown(w), ['elAssignment'], 'a remembered Assistant page falls back to Assignment');
    assert.strictEqual($(w, 'elRailAi').hidden, true);
    assert.strictEqual($(w, 'elNavSelAi').disabled, true);
    w.elGoPage('requests');
    assert.deepStrictEqual(shown(w), ['elAssignment']);
    assert.strictEqual(w.sent.filter(function (m) { return /^aiAdmin/.test(m.pluginaction); }).length, 0, 'no Assistant requests');
    w.elGoPage('configsets');
    assert.strictEqual($(w, 'elaiEndpointId').hidden, true);
    assert.match($(w, 'elaiEndpointRo').textContent, /Only full administrators can change it/);
    setVal(w, 'elliveLogs', 'System');
    assert.strictEqual(bar(w), 'Config set Default');
    $(w, 'elBarSave').click();
    assert.strictEqual('aiEndpointId' in w.last('adminSaveConfig').opts, false);
    // full administrator on a server without the Assistant: only its notice
    var w2 = page({ ai: { full: true, available: false } });
    w2.elGoPage('assistant');
    assert.deepStrictEqual(shown(w2), ['elAssistant']);
    assert.strictEqual($(w2, 'elAiNotice').textContent, 'The Assistant is not available on this server.');
    assert.strictEqual($(w2, 'elRailAiSubs').hidden, true);
    assert.strictEqual($(w2, 'elaiEndpointRow').hidden, true);
});

test('collapsible parts: summaries follow edits (edited parts, unsaved changes, notes, counts)', { skip: SKIP }, function () {
    var w = page();
    withPrompts(w, { prompts: { ask: 'My ask. <followups>' }, starters: { windows: null, linux: ['Is journald healthy?'] } });
    assert.deepStrictEqual(summary(w, 'prompt'), ['Edited (Ask)', 'Editing is off.']);
    assert.deepStrictEqual(summary(w, 'starters'), ['Windows: 3 questions, Linux: 1 question (edited).']);
    $(w, 'elAiPromptEdit').checked = true; fire(w, $(w, 'elAiPromptEdit'));
    $(w, 'elAiTpl_base').value = 'Base rules without the nonce.'; fire(w, $(w, 'elAiTpl_base'), 'input');
    assert.deepStrictEqual(summary(w, 'prompt'), ['Edited (Base, Ask)', 'Unsaved changes', 'Editing', '1 note']);
    assert.ok($(w, 'elAiCollSum_prompt').querySelector('.elAiTag.unsaved'));
    assert.strictEqual(bar(w), 'Assistant behaviour');
    $(w, 'elAiTpl_base').value = FACTORY.base; fire(w, $(w, 'elAiTpl_base'), 'input');
    $(w, 'elAiPromptEdit').checked = false; fire(w, $(w, 'elAiPromptEdit'));
    assert.deepStrictEqual(summary(w, 'prompt'), ['Edited (Ask)', 'Editing is off.']);
    assert.strictEqual(bar(w), null);
    w.elAiStartReset('linux');
    assert.deepStrictEqual(summary(w, 'starters'), ['Windows: 3 questions, Linux: 3 questions.', 'Unsaved changes']);
    assert.strictEqual(bar(w), 'Assistant behaviour');
    w.elAiSaveSettings();
    var sv = w.last('aiAdminSaveSettings');
    w.h.aiAdminSettingsSaved(null, { reqId: sv.reqId, settings: sv.settings });
    assert.deepStrictEqual(summary(w, 'starters'), ['Windows: 3 questions, Linux: 3 questions.']);
    assert.strictEqual(bar(w), null);
});
