'use strict';
/**
 * Curated event reference (ai/eventref.json).
 *
 * lookup(provider, id) -> { known:true, provider, id, title, meaning, causes, checks, benign, benignNote? } | { known:false }
 *   Provider matching is case-insensitive; "Microsoft-Windows-" prefixes, spaces and underscores are normalized
 *   ("Microsoft-Windows-Kernel-Power" == "Kernel-Power", "Service Control Manager" == "service-control-manager"),
 *   plus the alias table in the JSON (e.g. "DNS Client Events" -> DNS-Client, "W32Time" -> Time-Service).
 * lookupLinux(message, unit) -> { known:true, key, title, meaning, causes, checks, benign, benignNote? } | null
 *   First matching message pattern (journald / kernel messages).
 */

let DATA;
try { DATA = require('./eventref.json'); } catch (e) { DATA = { aliases: {}, windows: [], linux: [] }; }

function normProvider(p) {
    if (p == null) return '';
    let n = String(p).trim().toLowerCase();
    n = n.replace(/^microsoft-windows-/, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const aliases = (DATA && DATA.aliases) || {};
    return Object.prototype.hasOwnProperty.call(aliases, n) ? aliases[n] : n;
}

const INDEX = new Map();
for (const e of (Array.isArray(DATA.windows) ? DATA.windows : [])) {
    if (!e || !Array.isArray(e.providers)) continue;
    for (const p of e.providers) {
        const k = normProvider(p) + '|' + Number(e.id);
        if (!INDEX.has(k)) INDEX.set(k, e);
    }
}

const LINUX = [];
for (const e of (Array.isArray(DATA.linux) ? DATA.linux : [])) {
    try { LINUX.push({ re: new RegExp(e.pattern, e.flags || ''), e: e }); } catch (err) { /* skip bad pattern */ }
}

function copyCommon(e) {
    const o = { title: String(e.title || ''), meaning: String(e.meaning || ''), causes: (e.causes || []).slice(), checks: (e.checks || []).slice(), benign: !!e.benign };
    if (e.benignNote) o.benignNote = String(e.benignNote);
    return o;
}

function lookup(provider, id) {
    try {
        const n = normProvider(provider);
        const num = typeof id === 'number' ? id : (typeof id === 'string' && /^\s*\d{1,6}\s*$/.test(id) ? Number(id) : NaN);
        if (!n || !Number.isInteger(num)) return { known: false };
        const e = INDEX.get(n + '|' + num);
        if (!e) return { known: false };
        return Object.assign({ known: true, provider: e.providers[0], id: num }, copyCommon(e));
    } catch (err) { return { known: false }; }
}

function lookupLinux(message, unit) {
    try {
        let m = message == null ? '' : String(message);
        if (m.length > 8192) m = m.slice(0, 8192);
        const u = unit == null ? '' : String(unit);
        const text = u && !m.includes(u) ? u + ': ' + m : m;
        if (!text) return null;
        for (const x of LINUX) {
            x.re.lastIndex = 0;
            if (x.re.test(text)) return Object.assign({ known: true, key: x.e.key }, copyCommon(x.e));
        }
        return null;
    } catch (err) { return null; }
}

function list() { return { windows: DATA.windows || [], linux: DATA.linux || [] }; }

module.exports = { lookup, lookupLinux, normProvider, list };
