'use strict';
// Minimal HTTP client for LLM endpoints on core http/https (no fetch: undici has fixed 300 s timeouts and
// cannot take an http.Agent for proxying).
//
// request(opts, onChunk) -> { promise, abort(reason) }
//   opts: { url, method='GET', headers, body (string|Buffer|object -> JSON), lookup, agent,
//           connectTimeoutMs=10000, idleTimeoutMs=60000, totalTimeoutMs, maxBytes=8 MiB, maxErrorBytes=64 KiB,
//           onResponse({status, headers}) }
//   onChunk(text): decoded UTF-8 text of a 2xx body as it arrives (streaming). Without onChunk the 2xx body is
//   buffered (up to maxBytes) and returned as bodyText. For status >= 400 the body (capped at maxErrorBytes,
//   truncated, not an error) is always returned as bodyText and onChunk is not called.
//   promise resolves { status, headers, bodyText?, bytes } or rejects with Error.code in
//   'timeout' | 'aborted' | 'network' | 'tooLarge' | 'redirect' (3xx are never followed; err.status set).
//   An exception thrown by onChunk/onResponse rejects the promise with that exception.
// Never logs anything (bodies, headers and keys stay out of logs by construction).

const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');

function mkErr(code, message, extra) {
    const e = new Error(message);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
}

function request(opts, onChunk) {
    opts = opts || {};
    let settled = false;
    let req = null, res = null;
    let tConnect = null, tIdle = null, tTotal = null;
    let resolveP, rejectP;
    const promise = new Promise(function (resolve, reject) { resolveP = resolve; rejectP = reject; });
    promise.catch(function () { });                       // the caller handles it; never an unhandled rejection here

    const connectTimeoutMs = opts.connectTimeoutMs > 0 ? opts.connectTimeoutMs : 10000;
    const idleTimeoutMs = opts.idleTimeoutMs > 0 ? opts.idleTimeoutMs : 60000;
    const maxBytes = opts.maxBytes > 0 ? opts.maxBytes : 8 * 1024 * 1024;
    const maxErrorBytes = opts.maxErrorBytes > 0 ? opts.maxErrorBytes : 65536;

    function clearTimers() {
        if (tConnect) { clearTimeout(tConnect); tConnect = null; }
        if (tIdle) { clearTimeout(tIdle); tIdle = null; }
        if (tTotal) { clearTimeout(tTotal); tTotal = null; }
    }
    function settle(err, value) {
        if (settled) return;
        settled = true;
        clearTimers();
        if (err) {
            try { if (res) res.destroy(); } catch (e) { }
            try { if (req) req.destroy(); } catch (e) { }
            rejectP(err);
        } else resolveP(value);
    }
    function armIdle() {
        if (settled) return;
        if (tIdle) clearTimeout(tIdle);
        tIdle = setTimeout(function () { settle(mkErr('timeout', 'No data from the server for ' + Math.round(idleTimeoutMs / 1000) + ' s', { phase: 'idle' })); }, idleTimeoutMs);
    }

    let u;
    try { u = new URL(opts.url); } catch (e) { settle(mkErr('network', 'Invalid URL')); return { promise: promise, abort: function () { } }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { settle(mkErr('network', 'Unsupported protocol')); return { promise: promise, abort: function () { } }; }
    const mod = u.protocol === 'https:' ? https : http;

    let body = opts.body;
    const headers = {};
    if (opts.headers) for (const k of Object.keys(opts.headers)) if (opts.headers[k] != null) headers[k.toLowerCase()] = String(opts.headers[k]);
    if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
        body = JSON.stringify(body);
        if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    if (body != null) {
        body = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
        headers['content-length'] = String(body.length);
    }
    headers['accept-encoding'] = 'identity';

    const ropts = {
        protocol: u.protocol,
        hostname: u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname,
        port: u.port || undefined,
        path: (u.pathname || '/') + (u.search || ''),
        method: (opts.method || (body != null ? 'POST' : 'GET')).toUpperCase(),
        headers: headers
    };
    if (opts.lookup) ropts.lookup = opts.lookup;
    if (opts.agent) ropts.agent = opts.agent;
    if (u.protocol === 'https:' && u.hostname && !/^[\d.]+$|^\[/.test(u.hostname)) ropts.servername = u.hostname;

    if (opts.totalTimeoutMs > 0) tTotal = setTimeout(function () {
        // not even connected yet: report it as the connect failure it is
        if (tConnect) settle(mkErr('timeout', 'Could not connect within ' + Math.round(opts.totalTimeoutMs / 1000) + ' s', { phase: 'connect' }));
        else settle(mkErr('timeout', 'The request took longer than ' + Math.round(opts.totalTimeoutMs / 1000) + ' s', { phase: 'total' }));
    }, opts.totalTimeoutMs);
    tConnect = setTimeout(function () { settle(mkErr('timeout', 'Could not connect within ' + Math.round(connectTimeoutMs / 1000) + ' s', { phase: 'connect' })); }, connectTimeoutMs);

    try {
        req = mod.request(ropts);
    } catch (e) {
        settle(mkErr('network', 'Request failed: ' + (e.code || e.message)));
        return { promise: promise, abort: function () { } };
    }

    req.on('socket', function (s) {
        const connected = function () { if (tConnect) { clearTimeout(tConnect); tConnect = null; } armIdle(); };
        if (s.connecting) s.once('connect', connected); else connected();
    });
    req.on('error', function (e) {
        settle(mkErr('network', 'Connection failed' + (e && e.code ? ' (' + e.code + ')' : ''), { sysCode: e && e.code }));
    });
    req.on('response', function (r) {
        res = r;
        if (settled) { try { r.destroy(); } catch (e) { } return; }
        armIdle();
        const status = r.statusCode || 0;
        const rh = r.headers || {};
        if (status >= 300 && status < 400) {
            settle(mkErr('redirect', 'The server answered with a redirect (HTTP ' + status + '), which is not followed', { status: status }));
            return;
        }
        try { if (opts.onResponse) opts.onResponse({ status: status, headers: rh }); }
        catch (e) { settle(e); return; }

        const isErr = status >= 400;
        const stream = !isErr && typeof onChunk === 'function';
        const cap = isErr ? maxErrorBytes : maxBytes;
        const decoder = new StringDecoder('utf8');
        let bytes = 0, text = '', truncated = false;

        r.on('data', function (chunk) {
            if (settled) return;
            armIdle();
            bytes += chunk.length;
            if (isErr) {
                if (truncated) return;
                const room = cap - (bytes - chunk.length);
                if (chunk.length > room) {
                    // enough of the error body: answer now and drop the connection instead of draining the rest
                    text += decoder.write(chunk.subarray(0, Math.max(0, room)));
                    truncated = true;
                    settle(null, { status: status, headers: rh, bytes: bytes, bodyText: text, truncated: true });
                    try { r.destroy(); } catch (e) { }
                    return;
                }
                text += decoder.write(chunk);
                return;
            }
            if (bytes > cap) { settle(mkErr('tooLarge', 'The response is larger than ' + cap + ' bytes', { status: status })); return; }
            const s = decoder.write(chunk);
            if (stream) {
                if (!s) return;
                try { onChunk(s); } catch (e) { settle(e); }
            } else text += s;
        });
        r.on('end', function () {
            if (settled) return;
            const rest = decoder.end();
            if (stream) { if (rest) { try { onChunk(rest); } catch (e) { settle(e); return; } } }
            else if (!truncated) text += rest;
            const out = { status: status, headers: rh, bytes: bytes };
            if (!stream) out.bodyText = text;
            if (truncated) out.truncated = true;
            settle(null, out);
        });
        r.on('aborted', function () { settle(mkErr('network', 'The server closed the connection before the response was complete', { status: status })); });
        r.on('error', function (e) { settle(mkErr('network', 'Response error' + (e && e.code ? ' (' + e.code + ')' : ''), { status: status })); });
        r.on('close', function () { if (!settled) settle(mkErr('network', 'The server closed the connection before the response was complete', { status: status })); });
    });

    try { if (body != null) req.end(body); else req.end(); }
    catch (e) { settle(mkErr('network', 'Request failed')); }

    return {
        promise: promise,
        abort: function (reason) {
            settle(mkErr('aborted', typeof reason === 'string' && reason ? reason : 'Aborted'));
        }
    };
}

module.exports = { request, mkErr };
