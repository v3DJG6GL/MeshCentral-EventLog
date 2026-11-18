'use strict';
/**
 * Citation refs ([E12]) in model output.
 *
 * extract(text)                    -> ['E3', 'E7', ...] unique, in order of first appearance. Recognizes [E3],
 *                                     [E3, E7], [E3; E7], [E3][E7]. Leading zeros are normalized (E03 -> E3).
 * validate(text, returnedRefs)     -> { text, valid, invalid }: refs not in returnedRefs (Set or array) are removed
 *                                     from their bracket; a bracket left empty becomes "[unverified]".
 * validateList(refs, returnedRefs) -> the refs (normalized, unique, in order) that are in returnedRefs.
 */

const GROUP_RE = /\[\s*(E\d{1,6}(?:\s*[,;]\s*E\d{1,6})*)\s*\]/g;

function norm(ref) {
    const m = /^\s*E0*(\d{1,6})\s*$/i.exec(String(ref));
    return m ? 'E' + m[1] : null;
}
function toSet(refs) {
    if (refs instanceof Set) return new Set([...refs].map(norm).filter(Boolean));
    if (Array.isArray(refs)) return new Set(refs.map(norm).filter(Boolean));
    return new Set();
}
function splitGroup(inner) { return inner.split(/\s*[,;]\s*/).map(norm).filter(Boolean); }

function extract(text) {
    if (typeof text !== 'string' || !text) return [];
    const seen = new Set(), out = [];
    for (const m of text.matchAll(GROUP_RE)) {
        for (const r of splitGroup(m[1])) if (!seen.has(r)) { seen.add(r); out.push(r); }
    }
    return out;
}

function validate(text, returnedRefs) {
    if (typeof text !== 'string') return { text: text == null ? '' : String(text), valid: [], invalid: [] };
    const ok = toSet(returnedRefs);
    const valid = [], invalid = [], vs = new Set(), is = new Set();
    const out = text.replace(GROUP_RE, (m, inner) => {
        const refs = splitGroup(inner);
        const keep = [];
        for (const r of refs) {
            if (ok.has(r)) { if (!keep.includes(r)) keep.push(r); if (!vs.has(r)) { vs.add(r); valid.push(r); } }
            else if (!is.has(r)) { is.add(r); invalid.push(r); }
        }
        if (!keep.length) return '[unverified]';
        if (keep.length === refs.length && refs.every((r, i) => r === keep[i]) && !/E0\d/i.test(inner)) return m;
        return '[' + keep.join(', ') + ']';
    });
    return { text: out, valid: valid, invalid: invalid };
}

function validateList(refs, returnedRefs) {
    if (!Array.isArray(refs)) return [];
    const ok = toSet(returnedRefs);
    const out = [];
    for (const r of refs) {
        const n = norm(r);
        if (n && ok.has(n) && !out.includes(n)) out.push(n);
    }
    return out;
}

module.exports = { extract, validate, validateList, normRef: norm };
