'use strict';
// One streamed model call: build the request with the format adapter, send it over ai/http.js, parse the stream.
//
// stream({ ep, adapter, transcript, tools, opts, net:{ lookup, agent, network }, onEvent,
//          idleTimeoutMs, totalTimeoutMs, connectTimeoutMs, maxBytes, request?, retryBaseMs?, log? })
//   -> { promise, abort(reason) }
//   promise resolves { text, calls:[{id,name,args(object|null when the JSON is invalid),argsText}],
//                      raw: { format, items } | null, usage: {in,out} | null, stopReason, retried }
//   or rejects with Error { code, retryable, status?, retryAfterMs?, partial? } where code is one of
//   auth|model|rateLimit|overloaded|timeout|network|blocked|contextFull|badRequest|badResponse|aborted|toolsUnsupported|server
// - onEvent receives the adapter events as they stream ({t:'text',d}, {t:'call',...,args}, {t:'usage'}, {t:'stop'},
//   {t:'thinking',n} = n more reasoning characters went by (0: a reasoning block started); the reasoning text itself
//   never leaves the adapter).
// - A 400 naming a generation setting the endpoint set (temperature, top_p, top_k, seed, reasoning effort / think;
//   adapter.rejectedSetting) is not retried without it: it fails with code badRequest, err.setting = the field and a
//   message that names the setting, so the admin can change it.
// - Retries once for rateLimit / overloaded / 502-504 / network errors, only while no text or call has been
//   emitted; waits retry-after / retry-after-ms (or 1-2 s), never longer than 10 s (a longer retry-after is
//   not retried but returned with err.retryAfterMs).
// - A 400 naming a request field the server rejects (adapter.detectQuirk: max_tokens -> max_completion_tokens,
//   stream_options dropped) is resent at once with the field fixed, once per quirk; what was learned is reported
//   as result.quirks / err.quirks ({ useMaxCompletionTokens, noStreamOptions }, learned keys only) so the caller
//   can store it and pass it back as ep.quirks.
// - More than 20 malformed stream events -> badResponse. A 3xx answer -> blocked (redirects are never followed).
// - net.agent (proxy) is used for https targets only; net.network === 'public' with an http:// address and a
//   key is refused (blocked) so a key never travels in clear text over the internet.

const httpMod = require('./http.js');

const MAX_MALFORMED = 20;
const MAX_RETRY_WAIT_MS = 10000;
const RETRY_CODES = { rateLimit: 1, overloaded: 1, network: 1, server: 1 };

function mkErr(code, message, extra) {
    const e = new Error(message);
    e.code = code;
    e.retryable = false;
    if (extra) for (const k of Object.keys(extra)) if (extra[k] !== undefined) e[k] = extra[k];
    return e;
}

function parseArgs(text) {
    if (text == null || text === '') return {};
    try { const v = JSON.parse(text); return v != null && typeof v === 'object' && !Array.isArray(v) ? v : null; }
    catch (e) { return null; }
}

function mapHttpError(e) {
    switch (e && e.code) {
        case 'timeout': return mkErr('timeout', e.message, { phase: e.phase });
        case 'aborted': return mkErr('aborted', e.message);
        case 'network': return mkErr('network', e.message, { retryable: true, sysCode: e.sysCode });
        case 'tooLarge': return mkErr('badResponse', e.message);
        case 'redirect': return mkErr('blocked', 'The endpoint answered with a redirect (HTTP ' + e.status + '); redirects are not followed', { status: e.status });
        case 'badResponse': return e.retryable === undefined ? Object.assign(e, { retryable: false }) : e;
        default: return mkErr('badResponse', 'Unexpected error while reading the response');
    }
}

function stream(p) {
    p = p || {};
    const ep = p.ep || {};
    const adapter = p.adapter;
    const opts = Object.assign({ stream: true, toolChoice: 'auto' }, p.opts || {});
    const net = p.net || {};
    const doRequest = p.request || httpMod.request;
    const retryBaseMs = p.retryBaseMs != null ? p.retryBaseMs : 1000;
    const log = p.log || function (m) { console.log(m); };

    let settled = false, aborted = false, retried = false, visible = false;
    const learned = {};                              // request-shape quirks learned from 400 answers (see detectQuirk)
    let cur = null, sleepTimer = null;
    let resolveP, rejectP;
    const promise = new Promise(function (resolve, reject) { resolveP = resolve; rejectP = reject; });
    promise.catch(function () { });

    function settle(err, val) {
        if (settled) return;
        settled = true;
        if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
        const q = Object.keys(learned).length ? Object.assign({}, learned) : null;
        if (err) { if (q) err.quirks = q; rejectP(err); }
        else { if (q) val.quirks = q; resolveP(val); }
    }
    function forward(ev) {
        if (typeof p.onEvent !== 'function') return;
        try { p.onEvent(ev); } catch (e) { try { log('EVENTLOG AI: stream event handler failed (' + (e && e.name) + ')'); } catch (e2) { } }
    }
    function fail(err, acc) {
        if (settled) return;
        if (aborted) { settle(mkErr('aborted', 'Aborted')); return; }
        if (acc && (acc.text || acc.calls.length)) err.partial = { text: acc.text, calls: acc.calls };
        if (!retried && !visible && err.retryable && RETRY_CODES[err.code]) {
            const wait = err.retryAfterMs != null ? Math.max(0, err.retryAfterMs) : retryBaseMs * (err.code === 'network' ? 1 : 2);
            if (wait <= MAX_RETRY_WAIT_MS) {
                retried = true;
                sleepTimer = setTimeout(function () { sleepTimer = null; try { attempt(); } catch (e) { settle(mkErr('badResponse', 'Internal error')); } }, wait);
                return;
            }
        }
        settle(err);
    }

    function attempt() {
        if (settled) return;
        let built;
        const epq = Object.keys(learned).length ? Object.assign({}, ep, { quirks: Object.assign({}, ep.quirks || {}, learned) }) : ep;
        try { built = adapter.buildRequest(epq, p.transcript || { system: '', items: [] }, Array.isArray(p.tools) ? p.tools : [], opts); }
        catch (e) { settle(mkErr('badRequest', 'Could not build the request')); return; }
        const url = String(built.url || '');
        const isHttps = /^https:/i.test(url);
        if (!isHttps && net.network === 'public' && ep.apiKey) {
            settle(mkErr('blocked', 'Refusing to send an API key over unencrypted http:// to a public address'));
            return;
        }

        const acc = { text: '', calls: [], raw: [], usage: null, stop: null, error: null, malformed: 0, events: 0, fatal: null };
        let mode = 'stream', jsonBuf = '';

        function handle(ev) {
            if (settled || !ev || acc.fatal) return;
            switch (ev.t) {
                case 'text':
                    if (typeof ev.d !== 'string' || !ev.d) return;
                    acc.text += ev.d; acc.events++; visible = true;
                    forward({ t: 'text', d: ev.d });
                    break;
                case 'call': {
                    const c = { id: String(ev.id || ''), name: String(ev.name || ''), argsText: ev.argsText == null ? '{}' : String(ev.argsText) };
                    c.args = parseArgs(c.argsText);
                    acc.calls.push(c); acc.events++; visible = true;
                    forward({ t: 'call', id: c.id, name: c.name, argsText: c.argsText, args: c.args });
                    break;
                }
                case 'raw': acc.raw.push(ev.x); forward(ev); break;
                case 'thinking': forward({ t: 'thinking', n: Math.max(0, Math.floor(Number(ev.n) || 0)) }); break;
                case 'usage': acc.usage = { in: Number(ev.in) || 0, out: Number(ev.out) || 0 }; acc.events++; forward(ev); break;
                case 'stop': acc.stop = ev.reason || 'end'; acc.events++; forward(ev); break;
                case 'error': if (!acc.error) acc.error = ev; acc.events++; forward(ev); break;
                case 'malformed':
                    acc.malformed++;
                    if (acc.malformed > MAX_MALFORMED) acc.fatal = mkErr('badResponse', 'The server sent more than ' + MAX_MALFORMED + ' malformed stream events');
                    break;
                default: break;
            }
        }

        let parser;
        try { parser = adapter.createParser(handle, ep); }
        catch (e) { settle(mkErr('badRequest', 'Could not create the stream parser')); return; }

        const ropts = {
            url: url, method: 'POST', headers: built.headers, body: JSON.stringify(built.body),
            lookup: net.lookup || undefined, agent: isHttps && net.agent ? net.agent : undefined,
            connectTimeoutMs: p.connectTimeoutMs, idleTimeoutMs: p.idleTimeoutMs, totalTimeoutMs: p.totalTimeoutMs, maxBytes: p.maxBytes,
            onResponse: function (r) {
                if (r.status >= 400) return;
                const ct = String((r.headers && r.headers['content-type']) || '');
                if (!ep.ollamaNative && /json/i.test(ct) && !/ndjson|event-stream/i.test(ct)) mode = 'json';
            }
        };
        const onChunk = function (text) {
            if (settled) return;
            if (mode === 'json') { jsonBuf += text; return; }
            parser.push(text);
            if (acc.fatal) throw acc.fatal;          // http.js rejects with it and closes the connection
        };

        try { cur = doRequest(ropts, onChunk); }
        catch (e) { fail(mkErr('network', 'Request failed', { retryable: true }), acc); return; }

        cur.promise.then(function (res) {
            if (settled) return;
            if (res.status >= 400) {
                // a rejected request field: fix it and resend at once (one resend per quirk; no backoff and it
                // does not use up the rate-limit/overload retry)
                let quirk = null;
                if (typeof adapter.detectQuirk === 'function') { try { quirk = adapter.detectQuirk(res.status, res.bodyText || '', built.body, epq); } catch (e) { quirk = null; } }
                if (quirk && !learned[quirk] && !(ep.quirks && ep.quirks[quirk]) && !visible && !aborted) {
                    learned[quirk] = true;
                    try { attempt(); } catch (e) { settle(mkErr('badResponse', 'Internal error')); }
                    return;
                }
                let rej = null;
                if (typeof adapter.rejectedSetting === 'function') { try { rej = adapter.rejectedSetting(res.status, res.bodyText || '', built.body, epq); } catch (e) { rej = null; } }
                if (rej) {
                    fail(mkErr('badRequest', 'The model server rejected the endpoint setting \u201c' + rej.label + '\u201d (' + rej.param + '): ' + String(rej.message || '').slice(0, 200) +
                        '. An administrator can clear it in the endpoint settings.', { status: res.status, setting: rej.field }), acc);
                    return;
                }
                let c;
                try { c = adapter.classifyError(res.status, res.headers || {}, res.bodyText || ''); }
                catch (e) { c = { code: 'server', message: 'HTTP ' + res.status, retryable: false }; }
                fail(mkErr(c.code || 'server', c.message || ('HTTP ' + res.status), {
                    status: res.status, retryable: !!c.retryable, retryAfterMs: c.retryAfterMs == null ? undefined : c.retryAfterMs,
                    toolsUnsupported: !!c.toolsUnsupported, contextFull: !!c.contextFull
                }), acc);
                return;
            }
            try {
                if (mode === 'json') {
                    let j;
                    try { j = JSON.parse(jsonBuf); } catch (e) { fail(mkErr('badResponse', 'The server sent invalid JSON'), acc); return; }
                    adapter.parseNonStream(j, handle, ep);
                } else parser.end();
            } catch (e) { fail(mkErr('badResponse', 'Could not parse the response'), acc); return; }
            if (acc.fatal) { fail(acc.fatal, acc); return; }
            if (acc.error) {
                const code = acc.error.code || 'server';
                fail(mkErr(code, acc.error.message || 'The model reported an error', { retryable: !!RETRY_CODES[code] && code !== 'server' }), acc);
                return;
            }
            if (!acc.stop) {
                if (!acc.events) { fail(mkErr('badResponse', 'The server sent no usable data (check the API format and address)'), acc); return; }
                acc.stop = acc.calls.length ? 'tools' : 'end';
            }
            settle(null, {
                text: acc.text,
                calls: acc.calls,
                raw: acc.raw.length ? { format: adapter.format, items: acc.raw } : null,
                usage: acc.usage,
                stopReason: acc.stop,
                retried: retried
            });
        }, function (e) {
            if (settled) return;
            fail(acc.fatal && e === acc.fatal ? acc.fatal : mapHttpError(e), acc);
        }).catch(function () { settle(mkErr('badResponse', 'Internal error while reading the response')); });
    }

    if (!adapter || typeof adapter.buildRequest !== 'function') settle(mkErr('badRequest', 'Unknown API format'));
    else {
        try { attempt(); } catch (e) { settle(mkErr('badResponse', 'Internal error')); }
    }

    return {
        promise: promise,
        abort: function (reason) {
            if (settled) return;
            aborted = true;
            settle(mkErr('aborted', typeof reason === 'string' && reason ? reason : 'Aborted'));
            if (cur) { try { cur.abort(reason); } catch (e) { } }
        }
    };
}

module.exports = { stream, mkErr };
