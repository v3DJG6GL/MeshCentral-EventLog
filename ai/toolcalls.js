'use strict';
// Tool calls a model wrote as plain text instead of structured calls: some servers do not parse the model's own
// tool-call syntax (or offer no tools for a request with tool_choice 'none', so the model writes the calls as text).
//
// parse(text, defs) -> { text, calls: [{ name, args, argsText }], found }
//   text   the text without any tool-call markup (whitespace tidied)
//   calls  the calls it held, arguments converted to the types the tool's schema asks for (defs: [{ name,
//          parameters }]; a value that does not fit stays as written, so the normal validation reports it)
//   found  whether there was any markup (also an unterminated or unparseable one)
// strip(text) -> text without the markup; has(text) -> bool; MARK_RE: where markup starts (for a streamed text).
//
// Formats: Qwen / Hermes <tool_call>…</tool_call> holding <function=NAME><parameter=KEY>value</parameter></function>
// or JSON {"name","arguments"|"parameters"}; a bare <function=NAME>…</function>; <|tool_call|> / <|tool_call_start|>
// and Llama's <|python_tag|> followed by JSON; Anthropic-style <function_calls><invoke name="NAME"><parameter
// name="KEY">value</parameter></invoke></function_calls> (also a bare <invoke>); Mistral [TOOL_CALLS] followed by a
// JSON array or NAME[ARGS]{…}; DeepSeek <｜tool▁calls▁begin｜>…<｜tool▁calls▁end｜>. Markup that is cut off runs to
// the end of the text.

const MARK_SRC = '<\\s*tool_calls?\\b|<\\|(?:tool_calls?(?:_start|_begin|_section_begin)?|python_tag)\\|>|<\\s*function_calls\\b|<\\s*invoke\\s+name\\s*=|<\\s*function\\s*=|\\[TOOL_CALLS\\]|<｜tool▁calls?▁begin｜>';
const MARK_RE = new RegExp(MARK_SRC, 'i');
const MAX_CALLS = 16;

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function has(text) { return typeof text === 'string' && MARK_RE.test(text); }

// end index (exclusive) of the JSON value starting at s[i] ('{' or '['), or -1
function jsonEnd(s, i) {
    const open = s[i];
    if (open !== '{' && open !== '[') return -1;
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < s.length; k++) {
        const ch = s[k];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return k + 1; }
    }
    return -1;
}
function firstJson(s) {
    const m = /[{[]/.exec(s);
    if (!m) return null;
    const e = jsonEnd(s, m.index);
    if (e < 0) return null;
    try { return { value: JSON.parse(s.slice(m.index, e)), start: m.index, end: e }; } catch (err) { return null; }
}

function schemaOf(defs, name) {
    const d = (Array.isArray(defs) ? defs : []).find(function (x) { return x && x.name === name; });
    return d && isObj(d.parameters) && isObj(d.parameters.properties) ? d.parameters.properties : null;
}
// a parameter written as text -> the type its schema asks for (when it fits), else the trimmed text
function coerce(raw, schema) {
    const s = String(raw == null ? '' : raw).trim();
    const types = schema && schema.type != null ? [].concat(schema.type) : [];
    if (!types.length) {
        if (/^(?:[{[]|-?\d+(?:\.\d+)?$|true$|false$|null$)/.test(s)) { try { return JSON.parse(s); } catch (e) { } }
        return s;
    }
    if ((types.indexOf('integer') >= 0 || types.indexOf('number') >= 0) && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s)) {
        const n = Number(s);
        if (Number.isFinite(n) && (types.indexOf('number') >= 0 || Number.isInteger(n))) return n;
    }
    if (types.indexOf('boolean') >= 0 && /^(?:true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if ((types.indexOf('array') >= 0 || types.indexOf('object') >= 0) && /^[{[]/.test(s)) {
        try { const v = JSON.parse(s); if ((Array.isArray(v) && types.indexOf('array') >= 0) || (isObj(v) && types.indexOf('object') >= 0)) return v; } catch (e) { }
    }
    if (types.indexOf('array') >= 0 && types.indexOf('string') < 0 && s && !/^[{[]/.test(s)) return s.split(/\s*,\s*/).filter(Boolean);
    return s;
}
function mkCall(name, args, defs) {
    name = String(name == null ? '' : name).trim().replace(/^["']|["']$/g, '');
    if (!name) return null;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = null; } }
    if (args == null) args = {};
    if (!isObj(args)) return { name: name, args: null, argsText: JSON.stringify(args) };
    const props = schemaOf(defs, name);
    if (props) {
        // JSON written as text may still carry numbers as strings ("id": "1023")
        const out = {};
        for (const k of Object.keys(args)) out[k] = typeof args[k] === 'string' && props[k] ? coerce(args[k], props[k]) : args[k];
        args = out;
    }
    return { name: name, args: args, argsText: JSON.stringify(args) };
}
// {"name": .., "arguments"|"parameters": ..} or {"function": {"name", "arguments"}} (one object or an array of them)
function fromJson(v, defs, out) {
    const list = Array.isArray(v) ? v : [v];
    for (const o of list) {
        if (!isObj(o)) continue;
        const f = isObj(o.function) ? o.function : o;
        const name = typeof f.name === 'string' ? f.name : (typeof o.name === 'string' ? o.name : null);
        if (!name) continue;
        const args = f.arguments !== undefined ? f.arguments : (f.parameters !== undefined ? f.parameters : (o.arguments !== undefined ? o.arguments : o.parameters));
        const c = mkCall(name, args, defs);
        if (c) out.push(c);
    }
}
// <function=NAME> <parameter=KEY>value</parameter> … </function> (Qwen3-Coder / Qwen3.5 style)
function fromXmlFunctions(s, defs, out) {
    // only complete calls: one cut off (no </function>) is never run with half its arguments
    const re = /<\s*function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\s*\/\s*function\s*>/gi;
    let m;
    while ((m = re.exec(s))) {
        const name = m[1].replace(/^["']|["']$/g, '');
        const props = schemaOf(defs, name) || {};
        const args = {};
        const pre = /<\s*parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)(?:<\s*\/\s*parameter\s*>|(?=<\s*parameter\s*=)|(?=<\s*\/\s*function\s*>)|$)/gi;
        let p;
        while ((p = pre.exec(m[2]))) { const k = p[1].replace(/^["']|["']$/g, ''); args[k] = coerce(p[2], props[k]); }
        const c = mkCall(name, args, defs);
        if (c) out.push(c);
    }
}
// <invoke name="NAME"> <parameter name="KEY">value</parameter> … </invoke>
function fromInvokes(s, defs, out) {
    const re = /<\s*invoke\s+name\s*=\s*["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\s*\/\s*invoke\s*>/gi;
    let m;
    while ((m = re.exec(s))) {
        const name = m[1];
        const props = schemaOf(defs, name) || {};
        const args = {};
        const pre = /<\s*parameter\s+name\s*=\s*["']?([^"'>\s]+)["']?\s*>([\s\S]*?)(?:<\s*\/\s*parameter\s*>|$)/gi;
        let p;
        while ((p = pre.exec(m[2]))) args[p[1]] = coerce(p[2], props[p[1]]);
        const c = mkCall(name, args, defs);
        if (c) out.push(c);
    }
}
function fromInner(s, defs, out) {
    if (/<\s*function\s*=/i.test(s)) return fromXmlFunctions(s, defs, out);
    if (/<\s*invoke\s+name\s*=/i.test(s)) return fromInvokes(s, defs, out);
    const j = firstJson(s);
    if (j) fromJson(j.value, defs, out);
}

// Every markup segment of text: [{ start, end }] in order, calls appended to out.
function segments(text, defs, out) {
    const segs = [];
    let i = 0;
    const re = new RegExp(MARK_SRC, 'gi');
    while (i < text.length) {
        re.lastIndex = i;
        const m = re.exec(text);
        if (!m) break;
        const start = m.index, tag = m[0].replace(/\s+/g, '').toLowerCase();
        let end = text.length, body = '';
        const rest = text.slice(start + m[0].length);
        let cm;
        if (/^<tool_calls?/.test(tag)) {
            // <tool_call> … </tool_call> (or <tool_calls> … </tool_calls>)
            const gt = rest.indexOf('>');
            const after = /^[^<]*?>/.test(rest) && !/^\s*=/.test(rest) ? rest.slice(gt + 1) : rest;
            const off = text.length - after.length;
            cm = /<\s*\/\s*tool_calls?\s*>/i.exec(after);
            body = cm ? after.slice(0, cm.index) : after;
            end = cm ? off + cm.index + cm[0].length : text.length;
        } else if (tag.indexOf('<|') === 0) {
            cm = /<\|(?:\/tool_calls?|tool_calls?_(?:end|section_end)|eom_id|eot_id)\|>/i.exec(rest);
            body = cm ? rest.slice(0, cm.index) : rest;
            end = cm ? start + m[0].length + cm.index + cm[0].length : text.length;
            if (!cm) { const j = firstJson(body); if (j) { end = start + m[0].length + j.end; body = body.slice(0, j.end); } }
        } else if (tag === '<function_calls') {
            cm = /<\s*\/\s*function_calls\s*>/i.exec(rest);
            body = cm ? rest.slice(0, cm.index) : rest;
            end = cm ? start + m[0].length + cm.index + cm[0].length : text.length;
        } else if (tag.indexOf('<invoke') === 0) {
            const full = text.slice(start);
            cm = /<\s*\/\s*invoke\s*>/i.exec(full);
            body = cm ? full.slice(0, cm.index + cm[0].length) : full;
            end = cm ? start + cm.index + cm[0].length : text.length;
        } else if (tag.indexOf('<function=') === 0) {
            const full = text.slice(start);
            cm = /<\s*\/\s*function\s*>/i.exec(full);
            body = cm ? full.slice(0, cm.index + cm[0].length) : full;
            end = cm ? start + cm.index + cm[0].length : text.length;
        } else if (tag === '[tool_calls]') {
            // [TOOL_CALLS][{…}] or [TOOL_CALLS]name[ARGS]{…} (repeated)
            const lead = /^\s*/.exec(rest)[0].length;
            if (rest[lead] === '[' || rest[lead] === '{') {
                const e = jsonEnd(rest, lead);
                body = e > 0 ? rest.slice(lead, e) : rest;
                end = e > 0 ? start + m[0].length + e : text.length;
                if (e > 0) { try { fromJson(JSON.parse(body), defs, out); } catch (err) { } }
            } else {
                let k = 0;
                const nre = /\s*([\w.-]+)\s*\[ARGS\]\s*/y;
                for (;;) {
                    nre.lastIndex = k;
                    const nm = nre.exec(rest);
                    if (!nm) break;
                    const e = jsonEnd(rest, nre.lastIndex);
                    if (e < 0) { k = rest.length; break; }
                    const c = mkCall(nm[1], rest.slice(nre.lastIndex, e), defs);
                    if (c) out.push(c);
                    k = e;
                    const nx = /^\s*\[TOOL_CALLS\]/.exec(rest.slice(k));
                    if (nx) k += nx[0].length;
                }
                end = k ? start + m[0].length + k : text.length;
            }
            segs.push({ start: start, end: end });
            i = Math.max(end, start + 1);
            continue;
        } else {
            // DeepSeek: <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME\n```json\n{…}\n```<｜tool▁call▁end｜>…
            cm = /<｜tool▁calls▁end｜>/.exec(rest);
            body = cm ? rest.slice(0, cm.index) : rest;
            end = cm ? start + m[0].length + cm.index + cm[0].length : text.length;
            const cre = /<｜tool▁sep｜>\s*([\w.-]+)\s*([\s\S]*?)(?=<｜tool▁call▁end｜>|<｜tool▁call▁begin｜>|$)/g;
            let c;
            while ((c = cre.exec(body))) { const j = firstJson(c[2]); const k = mkCall(c[1], j ? j.value : {}, defs); if (k) out.push(k); if (!c[0].length) cre.lastIndex++; }
            segs.push({ start: start, end: end });
            i = Math.max(end, start + 1);
            continue;
        }
        fromInner(body, defs, out);
        segs.push({ start: start, end: end });
        i = Math.max(end, start + 1);
    }
    return segs;
}

function tidy(s) { return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }

function parse(text, defs) {
    const src = typeof text === 'string' ? text : (text == null ? '' : String(text));
    if (!MARK_RE.test(src)) return { text: src, calls: [], found: false };
    const calls = [];
    const segs = segments(src, defs, calls);
    let out = '', last = 0;
    const join = function (piece) {
        if (!out || /\n$/.test(out)) { out += piece; return; }
        out = out.replace(/[ \t]+$/, '');
        out += (/^[ \t]*\S/.test(piece) && /\S$/.test(out) ? ' ' : '') + piece.replace(/^[ \t]+/, '');
    };
    for (const sg of segs) { join(src.slice(last, sg.start)); last = sg.end; }
    join(src.slice(last));
    // stray closing tags of a format whose opening was consumed elsewhere
    out = out.replace(/<\s*\/\s*(?:tool_calls?|function_calls|function|invoke|parameter)\s*>/gi, '');
    return { text: tidy(out), calls: calls.slice(0, MAX_CALLS), found: true };
}
function strip(text) { return parse(text, null).text; }

module.exports = { parse, strip, has, MARK_RE, MARK_SRC };
