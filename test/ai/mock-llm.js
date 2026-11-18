'use strict';
// Scriptable mock LLM server for tests (no dependencies). Not a test file itself: it only exports helpers.
//
// const mock = await createMockLlm({ seed })
//   mock.url  'http://127.0.0.1:<port>'     mock.base  mock.url + '/v1'
//   mock.script(path, ...responses)   queue responses for a path (/v1/chat/completions, /v1/messages, /api/chat ...)
//   mock.always(path, response)       answer every request to path with response once the queue is empty
//   mock.requests                     [{ method, path, headers, bodyText, body, clientClosed, finished }]
//   mock.waitForClose(rec, ms)        resolves true when the client closed that connection before the response ended
//   mock.reset(), mock.close()
// Response spec: { status=200, headers, json | body | sse:[events] | ndjson:[objects], eol:'\n'|'\r\n',
//   split: true (random byte boundaries, also mid UTF-8 sequence and mid line) | <chunk size>,
//   delayMs (before headers), chunkDelayMs, hang (send what there is, never end), hangBeforeHeaders,
//   redirect: '<location>', retryAfter, destroyAfterBytes, handler(req, res, rec) }
// SSE events: a string is written verbatim (comments, '[DONE]' lines ...), { event, data } adds an event: line,
// any other object is sent as a data-only event; data objects are JSON-encoded.

const http = require('http');

function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function sseText(events, eol) {
    eol = eol || '\n';
    let out = '';
    for (const ev of events) {
        if (typeof ev === 'string') { out += ev; continue; }
        let name = null, data = ev;
        if (ev && typeof ev === 'object' && 'data' in ev && Object.keys(ev).every(function (k) { return k === 'event' || k === 'data'; })) { name = ev.event || null; data = ev.data; }
        const s = typeof data === 'string' ? data : JSON.stringify(data);
        if (name) out += 'event: ' + name + eol;
        for (const line of s.split('\n')) out += 'data: ' + line + eol;
        out += eol;
    }
    return out;
}

function splitBuffer(buf, rand, size) {
    const parts = [];
    if (size > 0) { for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size)); return parts; }
    let i = 0;
    while (i < buf.length) {
        const n = 1 + Math.floor(rand() * Math.min(24, buf.length - i));
        parts.push(buf.subarray(i, i + n));
        i += n;
    }
    return parts;
}

async function createMockLlm(opts) {
    opts = opts || {};
    const seed = opts.seed != null ? opts.seed : (Number(process.env.MOCK_SEED) || (Date.now() % 100000));
    const rand = rng(seed);
    const queues = new Map(), defaults = new Map();
    const requests = [];
    const sockets = new Set();
    const waiters = [];

    function notify() { for (const w of waiters.slice()) w(); }

    const server = http.createServer(function (req, res) {
        const u = new URL(req.url, 'http://x');
        const chunks = [];
        req.on('data', function (c) { chunks.push(c); });
        req.on('end', function () {
            const bodyText = Buffer.concat(chunks).toString('utf8');
            let body = null; try { body = JSON.parse(bodyText); } catch (e) { }
            const rec = { method: req.method, path: u.pathname, search: u.search, headers: req.headers, bodyText: bodyText, body: body, clientClosed: false, finished: false };
            requests.push(rec);
            res.on('finish', function () { rec.finished = true; });
            res.on('close', function () { if (!res.writableFinished) { rec.clientClosed = true; notify(); } });
            const q = queues.get(u.pathname);
            const spec = (q && q.length) ? q.shift() : defaults.get(u.pathname);
            if (!spec) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'no route for ' + u.pathname } })); return; }
            respond(req, res, rec, typeof spec === 'function' ? spec(rec) : spec);
        });
    });
    server.on('connection', function (s) { sockets.add(s); s.on('close', function () { sockets.delete(s); }); });

    function respond(req, res, rec, spec) {
        if (spec.handler) return spec.handler(req, res, rec);
        if (spec.hangBeforeHeaders) return;
        const go = function () {
            if (res.destroyed) return;
            const headers = Object.assign({}, spec.headers || {});
            let status = spec.status || 200;
            let body = null;
            if (spec.redirect) { status = spec.status || 302; headers.location = spec.redirect; body = Buffer.from(''); }
            else if (spec.sse) { headers['content-type'] = headers['content-type'] || 'text/event-stream'; body = Buffer.from(sseText(spec.sse, spec.eol), 'utf8'); }
            else if (spec.ndjson) { headers['content-type'] = headers['content-type'] || 'application/x-ndjson'; body = Buffer.from(spec.ndjson.map(function (o) { return (typeof o === 'string' ? o : JSON.stringify(o)) + (spec.eol || '\n'); }).join(''), 'utf8'); }
            else if (spec.json !== undefined) { headers['content-type'] = headers['content-type'] || 'application/json'; body = Buffer.from(JSON.stringify(spec.json), 'utf8'); }
            else body = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body == null ? '' : String(spec.body), 'utf8');
            if (spec.retryAfter != null) headers['retry-after'] = String(spec.retryAfter);
            if (spec.destroyAfterBytes != null) body = body.subarray(0, spec.destroyAfterBytes);
            const parts = spec.split ? splitBuffer(body, rand, typeof spec.split === 'number' ? spec.split : 0) : [body];
            res.writeHead(status, headers);
            let i = 0;
            const next = function () {
                if (res.destroyed) return;
                if (i < parts.length) {
                    const p = parts[i++];
                    if (p.length) res.write(p);
                    if (spec.chunkDelayMs) setTimeout(next, spec.chunkDelayMs); else setImmediate(next);
                    return;
                }
                if (spec.destroyAfterBytes != null) { res.socket && res.socket.destroy(); return; }
                if (spec.hang) return;
                res.end();
            };
            next();
        };
        if (spec.delayMs) setTimeout(go, spec.delayMs); else go();
    }

    await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const url = 'http://127.0.0.1:' + port;

    return {
        url: url, base: url + '/v1', port: port, seed: seed, requests: requests,
        script: function (path) { const q = queues.get(path) || []; for (const r of Array.prototype.slice.call(arguments, 1)) q.push(r); queues.set(path, q); return this; },
        always: function (path, spec) { defaults.set(path, spec); return this; },
        reset: function () { queues.clear(); defaults.clear(); requests.length = 0; },
        waitForClose: function (rec, ms) {
            return new Promise(function (resolve) {
                if (rec.clientClosed) return resolve(true);
                const t = setTimeout(function () { done(false); }, ms || 2000);
                function check() { if (rec.clientClosed) done(true); }
                function done(v) { clearTimeout(t); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); resolve(v); }
                waiters.push(check);
            });
        },
        close: function () {
            return new Promise(function (resolve) {
                for (const s of sockets) s.destroy();
                server.close(function () { resolve(); });
            });
        }
    };
}

// ---- stream builders --------------------------------------------------------------------------------------

function pieces(s, n) {
    const cps = Array.from(String(s));
    if (!cps.length) return [];
    n = Math.max(1, Math.min(n || 3, cps.length));
    const out = [], size = Math.ceil(cps.length / n);
    for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
    return out;
}

// OpenAI chat completions SSE. calls: [{ id?, name, args (object) | argsText, fragments }]
function chatSse(o) {
    o = o || {};
    const ev = [];
    const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'm' };
    ev.push(Object.assign({}, base, { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
    if (o.reasoning) ev.push(Object.assign({}, base, { choices: [{ index: 0, delta: { reasoning_content: o.reasoning }, finish_reason: null }] }));
    for (const p of pieces(o.text || '', o.textPieces || 3)) ev.push(Object.assign({}, base, { choices: [{ index: 0, delta: { content: p }, finish_reason: null }] }));
    (o.calls || []).forEach(function (c, idx) {
        const args = c.argsText != null ? c.argsText : JSON.stringify(c.args || {});
        const frags = pieces(args, c.fragments || 3);
        frags.forEach(function (f, k) {
            const tc = { index: c.noIndex ? undefined : idx, function: { arguments: f } };
            if (k === 0) { if (c.id) tc.id = c.id; tc.type = 'function'; tc.function.name = c.name; }
            ev.push(Object.assign({}, base, { choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }] }));
        });
    });
    ev.push(Object.assign({}, base, { choices: [{ index: 0, delta: {}, finish_reason: o.finish || ((o.calls || []).length ? 'tool_calls' : 'stop') }] }));
    if (o.usage !== false) ev.push(Object.assign({}, base, { choices: [], usage: Object.assign({ prompt_tokens: 11, completion_tokens: 7 }, o.usage || {}) }));
    if (o.done !== false) ev.push('data: [DONE]\n\n');
    return ev;
}

// Anthropic Messages SSE. blocks: [{type:'thinking',thinking,signature} | {type:'redacted_thinking',data}
//   | {type:'text',text} | {type:'tool_use',id,name,input}]
function anthropicSse(o) {
    o = o || {};
    const ev = [];
    const push = function (type, data) { ev.push({ event: type, data: Object.assign({ type: type }, data) }); };
    push('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: Object.assign({ input_tokens: 21, output_tokens: 1 }, o.usageStart || {}) } });
    ev.push(': keep-alive comment\n\n');
    push('ping', {});
    (o.blocks || []).forEach(function (b, i) {
        if (b.type === 'text') {
            push('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
            for (const p of pieces(b.text, 3)) push('content_block_delta', { index: i, delta: { type: 'text_delta', text: p } });
        } else if (b.type === 'thinking') {
            push('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
            for (const p of pieces(b.thinking, 2)) if (p) push('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: p } });
            push('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: b.signature } });
        } else if (b.type === 'redacted_thinking') {
            push('content_block_start', { index: i, content_block: { type: 'redacted_thinking', data: b.data } });
        } else if (b.type === 'tool_use') {
            push('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
            for (const p of pieces(b.inputText != null ? b.inputText : JSON.stringify(b.input || {}), 3)) push('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: p } });
        }
        push('content_block_stop', { index: i });
    });
    if (o.error) { push('error', { error: o.error }); return ev; }
    push('message_delta', { delta: { stop_reason: o.stop || 'end_turn', stop_sequence: null }, usage: { output_tokens: o.outputTokens || 9 } });
    push('message_stop', {});
    return ev;
}

// OpenAI Responses SSE. items: [{type:'reasoning',id,encrypted_content,summary} | {type:'message',text}
//   | {type:'function_call',id,call_id,name,arguments}]
function responsesSse(o) {
    o = o || {};
    const ev = [];
    const push = function (type, data) { ev.push({ event: type, data: Object.assign({ type: type }, data) }); };
    push('response.created', { response: { id: 'resp_1', status: 'in_progress' } });
    const output = [];
    (o.items || []).forEach(function (it, i) {
        let item;
        if (it.type === 'message') {
            item = { type: 'message', id: it.id || 'msg_' + i, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: it.text, annotations: [] }] };
            push('response.output_item.added', { output_index: i, item: Object.assign({}, item, { content: [] }) });
            for (const p of pieces(it.text, 3)) push('response.output_text.delta', { output_index: i, content_index: 0, item_id: item.id, delta: p });
        } else if (it.type === 'function_call') {
            item = { type: 'function_call', id: it.id || 'fc_' + i, call_id: it.call_id, name: it.name, arguments: it.arguments, status: 'completed' };
            push('response.output_item.added', { output_index: i, item: Object.assign({}, item, { arguments: '' }) });
            for (const p of pieces(it.arguments, 3)) push('response.function_call_arguments.delta', { output_index: i, item_id: item.id, delta: p });
        } else {
            item = Object.assign({ status: 'completed' }, it);
            push('response.output_item.added', { output_index: i, item: item });
        }
        push('response.output_item.done', { output_index: i, item: item });
        output.push(item);
    });
    if (o.failed) { push('response.failed', { response: { id: 'resp_1', status: 'failed', error: o.failed } }); return ev; }
    const resp = { id: 'resp_1', status: o.incomplete ? 'incomplete' : 'completed', output: output, usage: { input_tokens: 31, output_tokens: 12 } };
    if (o.incomplete) { resp.incomplete_details = { reason: o.incomplete }; push('response.incomplete', { response: resp }); }
    else push('response.completed', { response: resp });
    return ev;
}

// Ollama native /api/chat NDJSON. calls: [{ name, arguments (object) }]
function ollamaNd(o) {
    o = o || {};
    const lines = [];
    for (const p of pieces(o.text || '', 3)) lines.push({ model: 'm', message: { role: 'assistant', content: p }, done: false });
    if ((o.calls || []).length) lines.push({ model: 'm', message: { role: 'assistant', content: '', tool_calls: o.calls.map(function (c) { return { function: { name: c.name, arguments: c.arguments } }; }) }, done: false });
    lines.push({ model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: o.done_reason || 'stop', prompt_eval_count: 40, eval_count: 8 });
    return lines;
}

module.exports = { createMockLlm, sseText, chatSse, anthropicSse, responsesSse, ollamaNd, pieces, rng };
