'use strict';
// Server-Sent Events parser (WHATWG event-stream rules, lenient where LLM servers differ).
// createSseParser(onEvent) -> { push(strOrBuffer), end() }
//   onEvent({ event, data })   event defaults to 'message'; multi-line data joined with '\n'
//   onEvent({ event: 'done' }) for a 'data: [DONE]' line (OpenAI-style terminator)
// Accepts Buffers (decoded with a StringDecoder, so UTF-8 sequences split across chunks are safe) or strings
// (assumed already decoded). Line endings: \r\n, \n or \r, also when a \r\n pair is split across chunks.

const { StringDecoder } = require('string_decoder');

function createSseParser(onEvent) {
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let dataLines = [];
    let hasData = false;
    let eventName = '';
    let skipLF = false;     // previous chunk ended with \r: a leading \n in the next chunk belongs to it
    let first = true;       // strip a BOM at the very start of the stream
    let ended = false;

    function dispatch() {
        if (!hasData) { eventName = ''; return; }
        const data = dataLines.join('\n');
        const name = eventName || 'message';
        dataLines = []; hasData = false; eventName = '';
        if (data.trim() === '[DONE]') onEvent({ event: 'done' });
        else onEvent({ event: name, data: data });
    }

    function line(l) {
        if (l === '') { dispatch(); return; }
        if (l.charCodeAt(0) === 58) return;          // ':' comment / keep-alive
        const i = l.indexOf(':');
        const field = i < 0 ? l : l.slice(0, i);
        let value = i < 0 ? '' : l.slice(i + 1);
        if (value.charCodeAt(0) === 32) value = value.slice(1);
        if (field === 'data') { dataLines.push(value); hasData = true; }
        else if (field === 'event') eventName = value;
        // 'id' and 'retry' are irrelevant for a single request/response stream
    }

    function feed(text) {
        if (!text) return;
        if (first) { first = false; if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); if (!text) return; }
        if (skipLF) { skipLF = false; if (text.charCodeAt(0) === 10) text = text.slice(1); }
        buf += text;
        let start = 0;
        const n = buf.length;
        for (let i = 0; i < n; i++) {
            const c = buf.charCodeAt(i);
            if (c !== 10 && c !== 13) continue;
            line(buf.slice(start, i));
            if (c === 13) {
                if (i + 1 < n) { if (buf.charCodeAt(i + 1) === 10) i++; }
                else skipLF = true;
            }
            start = i + 1;
        }
        buf = start > 0 ? buf.slice(start) : buf;
    }

    return {
        push: function (chunk) {
            if (ended || chunk == null) return;
            feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
        },
        end: function () {
            if (ended) return;
            ended = true;
            feed(decoder.end());
            if (buf.length) { const rest = buf; buf = ''; line(rest); }
            dispatch();                              // lenient: a final event without the blank line still counts
        }
    };
}

module.exports = { createSseParser };
