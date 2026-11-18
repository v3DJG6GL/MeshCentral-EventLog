'use strict';
// Server side of the Assistant admin page (full administrators only; the caller checks siteadmin 0xFFFFFFFF).
//
// create({ store, db, netguard, adapters, llm, http, getProxyAgent, log }) -> { handle(command, myparent) -> bool }
//   handle returns false for an action it does not know, true otherwise (the reply is sent asynchronously).
//   Replies go to myparent.ws as { action:'plugin', plugin:'eventlog', method, reqId?, ... }:
//   aiAdminGet            -> aiAdminData { endpoints:[public], settings, usedBy:{epId:[set names]}, keySource }
//   aiAdminSaveEndpoint   -> aiAdminSaved { endpoint(public), warning? }       | aiAdminError { scope:'endpoint' }
//   aiAdminDeleteEndpoint -> aiAdminDeleted { id }                              | aiAdminError { scope:'endpoint' }
//   aiAdminSaveSettings   -> aiAdminSettingsSaved { settings }                  | aiAdminError { scope:'settings' }
//   aiAdminTest {id|draft}-> aiAdminTestResult { ok, steps:[{name,ok,ms,detail}], network, caps }
//       steps resolve, connect, auth, model, tools, context; a step that could not run has ok:null.
//       Only a test of a saved endpoint ({id} without draft) stores caps, lastTest and network.
//   aiAdminModels {id|draft} -> aiAdminModelsResult { ok, models:[{id, ctx?, tools?}], network, error? }
//       network: 'loopback'|'private'|'public' once the address was checked, else null (as in aiAdminTestResult)
// A draft needs no name (it is never stored); a draft for aiAdminModels needs no model either.
//   aiAdminAudit {since, until, filterUserid, filterNodeid, skip, limit, withTranscript} -> aiAdminAuditRows { rows, total }
//       (filterUserid, not userid: MeshCentral overwrites command.userid with the caller's id on every plugin command)
// A draft carries the unsaved form fields plus keyAction/key; keyAction 'keep' with an id uses the stored key.
// Outbound requests use the netguard-pinned lookup, the proxy agent for public https targets, never follow
// redirects, stay on the validated host, never send a key over http:// to a public address and share a 30 s
// budget per test (the admin page waits 40 s) and stop at the first connect-level failure. Details sent back
// are short (<= 300 chars) and have the key scrubbed.

const OVERALL_MS = 30000;
const MAX_INFLIGHT = 4;
const MAX_SHOW = 20;

function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }
function mkErr(code, message) { const e = new Error(message); e.code = code; return e; }

function create(o) {
    o = o || {};
    const store = o.store, db = o.db, netguard = o.netguard, adapters = o.adapters, httpMod = o.http;
    const getProxyAgent = typeof o.getProxyAgent === 'function' ? o.getProxyAgent : function () { return undefined; };
    const log = o.log || function (m) { console.log(m); };
    let inflight = 0;

    function warn(m) { try { log('EVENTLOG AI: ' + m); } catch (e) { } }
    function errText(e) { return e && e.message ? String(e.message).replace(/\s+/g, ' ').slice(0, 160) : 'error'; }

    function safeSend(myparent, msg) {
        try {
            const ws = myparent && myparent.ws;
            if (!ws || ws.readyState !== 1) return;
            ws.send(JSON.stringify(Object.assign({ action: 'plugin', plugin: 'eventlog' }, msg)));
        } catch (e) { warn('admin reply failed (' + (e && e.name) + ')'); }
    }

    function short(s, key) {
        let t = String(s == null ? '' : s);
        if (key && key.length >= 4) t = t.split(key).join('[key]');
        t = t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
        return t.length > 300 ? t.slice(0, 299) + '…' : t;
    }

    // ---- endpoint resolution for test / models -----------------------------------------------------------
    // -> { ep (store fields), apiKey, saved (bool: the stored endpoint unchanged) }; throws Error{code:'invalid'}
    async function resolveTarget(command, vopts) {
        const id = typeof command.id === 'string' && command.id ? command.id : (isObj(command.draft) && typeof command.draft.id === 'string' && command.draft.id ? command.draft.id : null);
        const stored = id ? await store.getEndpoint(id) : null;
        if (id && !stored) throw mkErr('invalid', 'Endpoint not found');
        if (!isObj(command.draft)) {
            if (!stored) throw mkErr('invalid', 'Endpoint not found');
            return { ep: stored, apiKey: store.resolveKey(stored), saved: true, id: stored.id };
        }
        const d = command.draft;
        const f = store.validateEndpoint(d, Object.assign({ draft: true }, vopts || {}));
        f.quirks = stored && stored.baseUrl === f.baseUrl ? stored.quirks || null : null;
        let apiKey = null;
        const ka = d.keyAction == null ? 'keep' : d.keyAction;
        if (ka === 'keep') apiKey = stored ? store.resolveKey(stored) : null;
        else if (ka === 'set') {
            const k = typeof d.key === 'string' ? d.key.trim() : '';
            if (!k) throw mkErr('invalid', 'Enter an API key, or keep or remove the stored one');
            if (/^env:/i.test(k)) {
                const name = k.slice(4).trim();
                apiKey = store.resolveKey({ id: '', key: { env: name } });
                if (apiKey == null) throw mkErr('invalid', 'The environment variable ' + name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) + ' is not set on the server or is not a valid name');
            } else apiKey = k;
        } else if (ka !== 'remove') throw mkErr('invalid', 'Unknown key action');
        return { ep: f, apiKey: apiKey, saved: false, id: stored ? stored.id : null };
    }

    function adapterEp(ep, apiKey) {
        return { baseUrl: ep.baseUrl, model: ep.model, apiKey: apiKey || null, maxOutputTokens: 16, numCtx: ep.numCtx || null, ollamaNative: false, quirks: ep.quirks || undefined };
    }

    // a failure before the server answered at all (refused, unreachable, TLS, connect timeout): the next
    // requests of the same test would fail the same way, each after its own timeout
    function isConnectFailure(e) {
        return !!e && ((e.code === 'timeout' && e.phase === 'connect') || (e.code === 'network' && e.status == null));
    }

    // deps.request bound to the validated address; all requests share one deadline and can be aborted together.
    // After the first connect-level failure every further request fails at once with that error.
    function makeDeps(chk, apiKey, deadline) {
        const active = new Set();
        let connectFail = null;
        const host = String(chk.hostname || '').toLowerCase();
        const stats = { firstResponseMs: null, t0: Date.now() };
        function refuse(code, message) {
            const p = Promise.reject(mkErr(code, message));
            p.catch(function () { });
            return { promise: p, abort: function () { } };
        }
        const deps = {
            request: function (ro) {
                ro = ro || {};
                let u;
                try { u = new URL(ro.url); } catch (e) { return refuse('network', 'Invalid URL'); }
                let h = u.hostname.toLowerCase();
                if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
                if (h !== host) return refuse('blocked', 'Request to a host that was not validated');
                if (u.protocol === 'http:' && chk.network === 'public' && apiKey) return refuse('blocked', 'Refusing to send an API key over unencrypted http:// to a public address');
                if (connectFail) return refuse(connectFail.code, connectFail.message);
                const left = deadline - Date.now();
                if (left <= 0) return refuse('timeout', 'The test took longer than ' + Math.round(OVERALL_MS / 1000) + ' s');
                const req = Object.assign({}, ro, {
                    lookup: chk.lookup,
                    totalTimeoutMs: Math.min(ro.totalTimeoutMs > 0 ? ro.totalTimeoutMs : 20000, left),
                    idleTimeoutMs: Math.min(ro.idleTimeoutMs > 0 ? ro.idleTimeoutMs : 20000, left),
                    connectTimeoutMs: Math.min(ro.connectTimeoutMs > 0 ? ro.connectTimeoutMs : 10000, left),
                    maxBytes: Math.min(ro.maxBytes > 0 ? ro.maxBytes : 4194304, 4194304),
                    onResponse: function (r) {
                        if (stats.firstResponseMs == null) stats.firstResponseMs = Date.now() - stats.t0;
                        if (typeof ro.onResponse === 'function') ro.onResponse(r);
                    }
                });
                if (u.protocol === 'https:' && chk.network === 'public') {
                    let agent; try { agent = getProxyAgent(); } catch (e) { agent = undefined; }
                    if (agent) req.agent = agent;
                }
                const hnd = httpMod.request(req);
                active.add(hnd);
                const done = function () { active.delete(hnd); };
                hnd.promise.then(done, function (e) { done(); if (!connectFail && isConnectFailure(e)) connectFail = e; });
                return hnd;
            }
        };
        return {
            deps: deps, stats: stats,
            abortAll: function () { for (const hnd of active) { try { hnd.abort('The test took longer than ' + Math.round(OVERALL_MS / 1000) + ' s'); } catch (e) { } } active.clear(); }
        };
    }

    // run fn(deps) under the overall budget; resolves fn's result or rejects Error{code:'timeout'}
    function withBudget(chk, apiKey, deadline, fn) {
        const d = makeDeps(chk, apiKey, deadline);
        let timer;
        const guard = new Promise(function (resolve, reject) {
            timer = setTimeout(function () { d.abortAll(); reject(mkErr('timeout', 'The test took longer than ' + Math.round(OVERALL_MS / 1000) + ' s')); }, Math.max(0, deadline - Date.now()));
        });
        const p = Promise.resolve().then(function () { return fn(d.deps, d.stats); });
        return Promise.race([p, guard]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); d.abortAll(); throw e; });
    }

    function netDetail(chk) {
        const addrs = (chk.addresses || []).map(function (a) { return a.address; });
        return short((chk.network === 'loopback' ? 'Local (this server)' : chk.network === 'private' ? 'Private network' : 'Public address (cloud): data is pseudonymized') +
            ' – ' + addrs.slice(0, 4).join(', ') + (addrs.length > 4 ? ' +' + (addrs.length - 4) : ''));
    }

    const OLLAMA_CTX_NOTE = "Ollama's default context may be only 4096 tokens; set Ollama context below or OLLAMA_CONTEXT_LENGTH";

    // ---- test ----
    async function runTest(command) {
        const t0 = Date.now();
        const steps = [];
        const add = function (name, ok, ms, detail) { steps.push({ name: name, ok: ok, ms: ms, detail: detail }); };
        const skip = function (names) { for (const n of names) add(n, null, 0, 'Skipped'); };
        const tgt = await resolveTarget(command);
        const ep = tgt.ep, key = tgt.apiKey;
        const adapter = adapters.get(ep.format);
        if (!adapter) throw mkErr('invalid', 'Unknown API format');

        const chk = await netguard.check(ep.baseUrl, { allowLinkLocal: ep.allowLinkLocal === true });
        if (!chk || !chk.ok) {
            add('resolve', false, Date.now() - t0, short(chk && chk.error || 'Address is not allowed', key));
            skip(['connect', 'auth', 'model', 'tools', 'context']);
            return { ok: false, steps: steps, network: null, caps: null, tgt: tgt, ms: Date.now() - t0 };
        }
        add('resolve', true, Date.now() - t0, netDetail(chk));
        if (/^http:/i.test(ep.baseUrl) && chk.network === 'public' && key) {
            add('connect', false, 0, 'Refusing to send an API key over unencrypted http:// to a public address; use https://');
            skip(['auth', 'model', 'tools', 'context']);
            return { ok: false, steps: steps, network: chk.network, caps: null, tgt: tgt, ms: Date.now() - t0 };
        }

        const aep = adapterEp(ep, key);
        const tProbe = Date.now();
        let pr, extraOllama = null;
        try {
            pr = await withBudget(chk, key, t0 + OVERALL_MS, async function (deps) {
                const r = await adapter.probe(aep, deps);
                // Ollama behind the Anthropic / Responses formats: the chat probe does not ask /api/show
                if (r && !r.ollama && ep.preset === 'ollama' && ep.format !== 'openai-chat') {
                    try {
                        const ver = await adapters.ollama.isOllama(aep, deps);
                        if (ver) { const s = await adapters.ollama.show(aep, deps); extraOllama = { version: ver, modelCtx: s.ctx, numCtx: s.numCtx, tools: s.tools }; }
                    } catch (e) { }
                }
                return r;
            });
        } catch (e) {
            pr = { ok: false, tools: null, ctx: null, server: null, code: e.code || 'network', detail: e.message || 'Connection failed' };
        }
        const probeMs = Date.now() - tProbe;
        pr = isObj(pr) ? pr : { ok: false, code: 'badResponse', detail: 'No probe result' };
        const ol = pr.ollama || extraOllama;
        if (extraOllama) {
            if (pr.tools == null && extraOllama.tools != null) pr.tools = extraOllama.tools;
            if (!pr.ctx && extraOllama.modelCtx) pr.ctx = extraOllama.modelCtx;
            pr.server = pr.server || 'ollama ' + extraOllama.version;
        }
        const code = pr.ok ? null : (pr.code || 'badResponse');
        const detail = short(pr.detail, key);

        if (code === 'network' || code === 'timeout' || code === 'blocked' || code === 'redirect' || code === 'aborted') {
            add('connect', false, probeMs, detail || 'Connection failed');
            skip(['auth', 'model', 'tools', 'context']);
            return { ok: false, steps: steps, network: chk.network, caps: null, tgt: tgt, ms: Date.now() - t0 };
        }
        add('connect', true, probeMs, short('Server answered' + (pr.server ? ' (' + pr.server + ')' : '')));
        if (code === 'auth') {
            add('auth', false, 0, detail || 'Authentication failed');
            skip(['model', 'tools', 'context']);
            return { ok: false, steps: steps, network: chk.network, caps: null, tgt: tgt, ms: Date.now() - t0 };
        }
        add('auth', true, 0, key ? 'API key accepted' : 'No API key needed');
        if (code) {
            add('model', false, 0, detail || 'The model request failed');
            skip(['tools', 'context']);
            return { ok: false, steps: steps, network: chk.network, caps: null, tgt: tgt, ms: Date.now() - t0 };
        }
        add('model', true, 0, short('Model ' + ep.model + (detail ? ': ' + detail : ' answered'), key));
        add('tools', pr.tools === true ? true : pr.tools === false ? false : null, 0,
            pr.tools === true ? 'Tool calling supported' : pr.tools === false ? 'No tool calling: the Assistant sends a summary of the data instead' : 'Tool support unknown');
        const ctx = Number(pr.ctx) > 0 ? Math.floor(Number(pr.ctx)) : null;
        let cdetail = ctx ? 'Context ' + ctx + ' tokens' : 'Context size not detected; 8192 tokens are assumed unless set';
        if (ep.contextTokens) cdetail += '; set to ' + ep.contextTokens + ' tokens for this endpoint';
        if (ol) {
            if (ep.numCtx) cdetail += '; Ollama context ' + ep.numCtx + ' tokens';
            else if (ol.numCtx) cdetail += '; the model file sets num_ctx ' + ol.numCtx;
            else cdetail += '. ' + OLLAMA_CTX_NOTE;
        }
        add('context', ctx ? true : null, 0, short(cdetail));
        const caps = { tools: pr.tools === true ? true : pr.tools === false ? false : null, ctx: ctx, numCtx: ol && Number(ol.numCtx) > 0 ? Math.floor(Number(ol.numCtx)) : null, server: pr.server ? String(pr.server).slice(0, 80) : null, at: Date.now() };
        return { ok: true, steps: steps, network: chk.network, caps: caps, tgt: tgt, ms: Date.now() - t0 };
    }

    async function doTest(command, myparent) {
        const reqId = command.reqId;
        let r;
        try { r = await runTest(command); }
        catch (e) {
            const msg = e && e.code === 'invalid' ? short(e.message) : 'The test could not run';
            if (!(e && e.code === 'invalid')) warn('endpoint test failed (' + errText(e) + ')');
            safeSend(myparent, { method: 'aiAdminTestResult', reqId: reqId, ok: false, steps: [{ name: 'resolve', ok: false, ms: 0, detail: msg }], network: null, caps: null });
            return;
        }
        if (r.tgt.saved) {
            try {
                if (r.caps) await store.setCaps(r.tgt.id, r.caps);
                if (r.network) await store.setNetwork(r.tgt.id, r.network);
                const failed = r.steps.find(function (s) { return s.ok === false && s.name !== 'tools'; });
                await store.setLastTest(r.tgt.id, { ok: r.ok, at: Date.now(), ms: r.ms, detail: failed ? failed.detail : (r.steps.find(function (s) { return s.name === 'model'; }) || {}).detail });
            } catch (e) { warn('could not store the test result (' + errText(e) + ')'); }
        }
        safeSend(myparent, { method: 'aiAdminTestResult', reqId: reqId, ok: r.ok, steps: r.steps, network: r.network, caps: r.caps });
    }

    // ---- models ----
    function cleanModels(list) {
        const out = [], seen = new Set();
        for (const m of Array.isArray(list) ? list : []) {
            if (!isObj(m) || typeof m.id !== 'string' || !m.id || m.id.length > 200 || seen.has(m.id)) continue;
            seen.add(m.id);
            const x = { id: m.id };
            if (Number(m.ctx) > 0) x.ctx = Math.floor(Number(m.ctx));
            if (m.tools === true || m.tools === false) x.tools = m.tools;
            out.push(x);
            if (out.length >= 1000) break;
        }
        return out;
    }

    async function listModels(command) {
        const t0 = Date.now();
        const tgt = await resolveTarget(command, { noModel: true });
        const ep = tgt.ep, key = tgt.apiKey;
        const adapter = adapters.get(ep.format);
        if (!adapter) throw mkErr('invalid', 'Unknown API format');
        const chk = await netguard.check(ep.baseUrl, { allowLinkLocal: ep.allowLinkLocal === true });
        if (!chk || !chk.ok) throw mkErr('invalid', chk && chk.error || 'Address is not allowed');
        const withNet = function (e) { e.network = chk.network; e.key = key; return e; };
        if (/^http:/i.test(ep.baseUrl) && chk.network === 'public' && key) throw withNet(mkErr('invalid', 'Refusing to send an API key over unencrypted http:// to a public address; use https://'));
        const aep = adapterEp(ep, key);
        return withBudget(chk, key, t0 + OVERALL_MS, async function (deps) {
            const ollama = adapters.ollama;
            if ((ep.format === 'openai-chat' || ep.preset === 'ollama') && ollama && await ollama.isOllama(aep, deps)) {
                const tags = await ollama.tags(aep, deps);
                const models = tags.map(function (t) { return { id: t.id }; });
                const first = models.slice(0, MAX_SHOW);
                let i = 0;
                const worker = async function () {
                    while (i < first.length) {
                        const m = first[i++];
                        try {
                            const s = await ollama.show(Object.assign({}, aep, { model: m.id }), deps);
                            if (s.tools != null) m.tools = s.tools;
                            if (s.ctx) m.ctx = s.ctx;
                        } catch (e) { if (e && e.code === 'timeout') return; }
                    }
                };
                await Promise.all([worker(), worker(), worker(), worker()]);
                return cleanModels(models);
            }
            return cleanModels(await adapter.listModels(aep, deps));
        }).then(function (models) { return { models: models, key: key, network: chk.network, tgt: tgt }; }, function (e) { throw withNet(e && typeof e === 'object' ? e : mkErr('internal', String(e))); });
    }

    async function doModels(command, myparent) {
        const reqId = command.reqId;
        try {
            const r = await listModels(command);
            if (r.tgt.saved && r.network) { try { await store.setNetwork(r.tgt.id, r.network); } catch (e) { warn('could not store the address check (' + errText(e) + ')'); } }
            safeSend(myparent, { method: 'aiAdminModelsResult', reqId: reqId, ok: true, models: r.models, network: r.network });
        } catch (e) {
            const known = e && e.code && e.code !== 'internal';
            if (!known) warn('model list failed (' + errText(e) + ')');
            const prefix = e && e.code === 'auth' ? 'Authentication failed: ' : '';
            safeSend(myparent, { method: 'aiAdminModelsResult', reqId: reqId, ok: false, models: [], network: (e && e.network) || null, error: short(known ? prefix + (e.message || 'Request failed') : 'The model list could not be loaded', e && e.key) });
        }
    }

    // ---- data / save / delete / settings / audit ----
    async function usedByMap() {
        const sets = await db.getAllConfigSets();
        const used = {};
        for (const s of sets || []) {
            if (!s || typeof s.aiEndpointId !== 'string' || !s.aiEndpointId) continue;
            (used[s.aiEndpointId] = used[s.aiEndpointId] || []).push(s.name ? String(s.name) : (s.default === true ? 'Default' : 'Unnamed'));
        }
        return used;
    }

    async function doGet(command, myparent) {
        try {
            const eps = await store.listEndpoints();
            const settings = await store.getSettings();
            const usedBy = await usedByMap();
            safeSend(myparent, { method: 'aiAdminData', reqId: command.reqId, endpoints: eps.map(store.publicEndpoint), settings: settings, usedBy: usedBy, keySource: store.keySource() || null });
        } catch (e) {
            warn('admin data failed (' + errText(e) + ')');
            safeSend(myparent, { method: 'aiAdminError', reqId: command.reqId, scope: 'data', error: 'The Assistant settings could not be loaded' });
        }
    }

    function userError(e, fallback) {
        if (e && (e.code === 'invalid' || e.code === 'notFound' || e.code === 'inUse')) return short(e.message);
        warn(fallback.toLowerCase() + ' (' + errText(e) + ')');
        return fallback;
    }

    async function doSave(command, myparent) {
        try {
            if (!isObj(command.endpoint)) throw mkErr('invalid', 'Missing endpoint data');
            const ep = await store.saveEndpoint(command.endpoint, { keyAction: command.keyAction == null ? 'keep' : command.keyAction, key: command.key });
            const msg = { method: 'aiAdminSaved', reqId: command.reqId, endpoint: store.publicEndpoint(ep) };
            if (ep.warning) msg.warning = short(ep.warning);
            safeSend(myparent, msg);
        } catch (e) {
            safeSend(myparent, { method: 'aiAdminError', reqId: command.reqId, scope: 'endpoint', error: userError(e, 'Could not save the endpoint') });
        }
    }

    async function doDelete(command, myparent) {
        try {
            await store.deleteEndpoint(command.id);
            safeSend(myparent, { method: 'aiAdminDeleted', reqId: command.reqId, id: command.id });
        } catch (e) {
            const msg = { method: 'aiAdminError', reqId: command.reqId, scope: 'endpoint', error: userError(e, 'Could not delete the endpoint') };
            if (e && Array.isArray(e.sets)) msg.sets = e.sets;
            safeSend(myparent, msg);
        }
    }

    async function doSettings(command, myparent) {
        try {
            if (!isObj(command.settings)) throw mkErr('invalid', 'Missing settings');
            const s = await store.saveSettings(command.settings);
            safeSend(myparent, { method: 'aiAdminSettingsSaved', reqId: command.reqId, settings: s });
        } catch (e) {
            safeSend(myparent, { method: 'aiAdminError', reqId: command.reqId, scope: 'settings', error: userError(e, 'Could not save the settings') });
        }
    }

    async function doAudit(command, myparent) {
        try {
            const fu = typeof command.filterUserid === 'string' && command.filterUserid ? command.filterUserid : undefined;
            const fnid = typeof command.filterNodeid === 'string' && command.filterNodeid ? command.filterNodeid : (typeof command.nodeid === 'string' && command.nodeid ? command.nodeid : undefined);   // nodeid is passed through unchanged
            const q = { since: command.since, until: command.until, userid: fu, nodeid: fnid, skip: command.skip, limit: Math.min(Math.max(Number(command.limit) || 100, 1), 1000) };
            const r = await store.auditQuery(q);
            const rows = ((r && r.rows) || []).map(function (x) {
                const y = Object.assign({}, x);
                if (command.withTranscript !== true) delete y.transcript;
                return y;
            });
            safeSend(myparent, { method: 'aiAdminAuditRows', reqId: command.reqId, rows: rows, total: (r && r.total) || 0 });
        } catch (e) {
            warn('audit query failed (' + errText(e) + ')');
            safeSend(myparent, { method: 'aiAdminError', reqId: command.reqId, scope: 'audit', error: 'The audit log could not be loaded' });
        }
    }

    function limited(fn, method) {
        return function (command, myparent) {
            if (inflight >= MAX_INFLIGHT) {
                const busy = method === 'aiAdminTestResult'
                    ? { method: method, reqId: command.reqId, ok: false, steps: [{ name: 'resolve', ok: false, ms: 0, detail: 'Too many tests are running; try again in a moment' }], network: null, caps: null }
                    : { method: method, reqId: command.reqId, ok: false, models: [], network: null, error: 'Too many requests are running; try again in a moment' };
                safeSend(myparent, busy);
                return Promise.resolve();
            }
            inflight++;
            return fn(command, myparent).then(function () { inflight--; }, function () { inflight--; });
        };
    }

    const ACTIONS = {
        aiAdminGet: doGet,
        aiAdminSaveEndpoint: doSave,
        aiAdminDeleteEndpoint: doDelete,
        aiAdminSaveSettings: doSettings,
        aiAdminTest: limited(doTest, 'aiAdminTestResult'),
        aiAdminModels: limited(doModels, 'aiAdminModelsResult'),
        aiAdminAudit: doAudit
    };

    // reqId is echoed back: only short strings and finite numbers
    function cleanReqId(v) {
        if (typeof v === 'string' && v.length <= 64) return v;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        return undefined;
    }

    function handle(command, myparent) {
        if (!isObj(command) || typeof command.pluginaction !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, command.pluginaction)) return false;
        try {
            const c = Object.assign({}, command, { reqId: cleanReqId(command.reqId) });
            const p = ACTIONS[command.pluginaction](c, myparent);
            if (p && typeof p.catch === 'function') p.catch(function (e) { warn(command.pluginaction + ' failed (' + errText(e) + ')'); });
        } catch (e) { warn(command.pluginaction + ' failed (' + errText(e) + ')'); }
        return true;
    }

    return { handle: handle, _safeSend: safeSend };
}

module.exports = { create, OVERALL_MS };
