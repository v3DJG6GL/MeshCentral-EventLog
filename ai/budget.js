'use strict';
/**
 * Token budget helpers. The estimate is deliberately simple (UTF-8 bytes / 3) and is calibrated per endpoint from
 * the usage the provider reports.
 *
 * estimateTokens(strOrObj, ratio = 1)       -> ceil(utf8Bytes / 3 * ratio); objects are measured as compact JSON
 * calibrate(prevRatio, reportedIn, estimatedIn) -> new ratio, clamped 0.5..2. estimatedIn is the estimate that was
 *     made WITH prevRatio, so the new ratio is prevRatio * reportedIn / estimatedIn. Bad numbers -> prevRatio (or 1).
 * fitJson(value, maxTokens, { truncateFields }) -> { text, truncated, dropped }
 *     Compact JSON no larger than maxTokens * 3 bytes (except when maxTokens is too small to hold even the
 *     truncation notice). Steps: 1) shorten the named string fields (default msg_untrusted: 300 chars), 2) shorten
 *     every string over 300 chars, 3) drop trailing items of the largest array (repeated). When anything was cut, a
 *     top-level "truncated": true and a "note" are added (arrays are wrapped as { items, truncated, note }).
 * inputBudget(ctx, maxOutput)               -> floor((ctx - maxOutput) * 0.9), at least 1024
 */

const BYTES_PER_TOKEN = 3;
const NOTE = 'Result truncated to fit the context budget. Narrow the time window or add filters (source, level, event id, text) to see the rest.';
const ELL = '…';

function byteLen(s) { return Buffer.byteLength(s, 'utf8'); }
function safeStringify(v) {
    try { const s = JSON.stringify(v); return s === undefined ? '' : s; } catch (e) { return ''; }
}

function estimateTokens(v, ratio) {
    let r = Number(ratio);
    if (!Number.isFinite(r) || r <= 0) r = 1;
    let s;
    if (typeof v === 'string') s = v;
    else if (v == null) return 0;
    else s = safeStringify(v);
    if (!s) return 0;
    return Math.ceil(byteLen(s) / BYTES_PER_TOKEN * r);
}

function clampRatio(r) { return Math.min(2, Math.max(0.5, r)); }
function calibrate(prevRatio, reportedIn, estimatedIn) {
    let prev = Number(prevRatio);
    if (!Number.isFinite(prev) || prev <= 0) prev = 1;
    prev = clampRatio(prev);
    const rep = Number(reportedIn), est = Number(estimatedIn);
    if (!Number.isFinite(rep) || !Number.isFinite(est) || rep <= 0 || est <= 0) return prev;
    return clampRatio(prev * rep / est);
}

function inputBudget(ctx, maxOutput) {
    let c = Number(ctx), m = Number(maxOutput);
    if (!Number.isFinite(c) || c <= 0) c = 8192;
    if (!Number.isFinite(m) || m < 0) m = 0;
    return Math.max(1024, Math.floor((c - m) * 0.9));
}

// Deep copy (JSON semantics) while shortening strings: fields[key] gives a per-field limit, all > 'all' limit.
function shorten(v, fields, all, depth, key) {
    if (depth > 64) return null;
    if (typeof v === 'string') {
        let lim = (key != null && Object.prototype.hasOwnProperty.call(fields, key)) ? fields[key] : null;
        if (all != null) lim = lim == null ? all : Math.min(lim, all);
        if (lim != null && lim >= 0 && v.length > lim) return { v: v.slice(0, lim) + ELL, cut: true };
        return { v: v, cut: false };
    }
    if (Array.isArray(v)) {
        let cut = false;
        const a = v.map((x) => { const r = shorten(x, fields, all, depth + 1, null); if (r.cut) cut = true; return r.v; });
        return { v: a, cut: cut };
    }
    if (v && typeof v === 'object') {
        if (typeof v.toJSON === 'function') return shorten(v.toJSON(), fields, all, depth + 1, key);
        let cut = false;
        const o = {};
        for (const k of Object.keys(v)) {
            if (v[k] === undefined || typeof v[k] === 'function') continue;
            const r = shorten(v[k], fields, all, depth + 1, k);
            if (r.cut) cut = true;
            o[k] = r.v;
        }
        return { v: o, cut: cut };
    }
    return { v: v === undefined ? null : v, cut: false };
}

// All arrays inside v with their serialized size, largest first.
function arraysBySize(v) {
    const out = [];
    (function walk(x, depth) {
        if (depth > 64 || !x || typeof x !== 'object') return;
        if (Array.isArray(x)) {
            if (x.length) out.push({ arr: x, size: byteLen(safeStringify(x)) });
            for (const y of x) walk(y, depth + 1);
        } else {
            for (const k of Object.keys(x)) walk(x[k], depth + 1);
        }
    })(v, 0);
    out.sort((a, b) => b.size - a.size);
    return out;
}

function fitJson(value, maxTokens, opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    const fields = (opts.truncateFields && typeof opts.truncateFields === 'object') ? opts.truncateFields : { msg_untrusted: 300 };
    let mt = Number(maxTokens);
    if (!Number.isFinite(mt) || mt <= 0) mt = 1000;
    const maxBytes = Math.floor(mt * BYTES_PER_TOKEN);

    const plain = safeStringify(value === undefined ? null : value) || 'null';
    if (byteLen(plain) <= maxBytes) return { text: plain, truncated: false, dropped: 0 };

    const wrap = (v) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) return Object.assign({}, v, { truncated: true, note: NOTE });
        return { items: v, truncated: true, note: NOTE };
    };
    const fits = (v) => byteLen(safeStringify(wrap(v))) <= maxBytes;

    // 1) named fields, 2) every long string
    let work = shorten(value, fields, null, 0, null).v;
    if (!fits(work)) work = shorten(work, {}, 300, 0, null).v;
    let dropped = 0;
    // 3) drop trailing items of the largest array until it fits
    let guard = 0;
    while (!fits(work) && guard++ < 1000) {
        const list = arraysBySize(work);
        if (!list.length) break;
        const a = list[0].arr;
        const orig = a.length;
        const full = a.slice();
        // largest k in [0, orig-1] that fits (binary search); if none, empty it and keep going with the next array
        let lo = 0, hi = orig - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            a.length = 0; for (let i = 0; i < mid; i++) a.push(full[i]);
            if (fits(work)) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        const k = best < 0 ? 0 : best;
        a.length = 0; for (let i = 0; i < k; i++) a.push(full[i]);
        dropped += orig - k;
    }
    let text = safeStringify(wrap(work));
    if (byteLen(text) > maxBytes) {
        // Not reducible by the steps above (e.g. a huge object of scalars): send only the notice.
        text = safeStringify({ truncated: true, note: NOTE });
        if (byteLen(text) > maxBytes) text = '{"truncated":true}';
    }
    return { text: text, truncated: true, dropped: dropped };
}

module.exports = { estimateTokens, calibrate, fitJson, inputBudget, BYTES_PER_TOKEN, NOTE };
