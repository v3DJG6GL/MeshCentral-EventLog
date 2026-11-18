'use strict';
// Newline-delimited JSON parser (Ollama native streaming).
// createNdjsonParser(onObject, onError) -> { push(strOrBuffer), end(), errors }
//   onObject(obj) for every line that parses; onError(err) for malformed lines (counted, never thrown).
//   err.snippet holds at most the first 80 characters of the bad line.

const { StringDecoder } = require('string_decoder');

function createNdjsonParser(onObject, onError) {
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let ended = false;
    let errors = 0;

    function line(l) {
        if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
        if (!l.trim()) return;
        let obj;
        try { obj = JSON.parse(l); } catch (e) {
            errors++;
            if (onError) { const err = new Error('Malformed JSON line'); err.snippet = l.slice(0, 80); onError(err); }
            return;
        }
        onObject(obj);
    }

    function feed(text) {
        if (!text) return;
        buf += text;
        let start = 0, i;
        while ((i = buf.indexOf('\n', start)) >= 0) { line(buf.slice(start, i)); start = i + 1; }
        if (start > 0) buf = buf.slice(start);
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
        },
        get errors() { return errors; }
    };
}

module.exports = { createNdjsonParser };
