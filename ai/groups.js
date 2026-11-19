'use strict';
/**
 * Template masking and grouping of stored events.
 *
 * mask(message) turns a message into a template: variable parts (GUIDs, 0x hex, IPs, paths, quoted strings,
 * numbers with 2+ digits, hex runs of 8+) become "<*>", whitespace is collapsed, the result is capped at 160 chars.
 *
 * groupEvents(events, { top, samples, os }) groups stored event records
 * ({ _id, tc, LogName, Level, ProviderName, Id, Message, Unit?, Priority?, Subsystem?, MsgType? }):
 *   Windows: key = ProviderName|Id
 *   Linux (os === 'linux', or the record has Unit/Priority): key = Unit|ProviderName|mask(Message).slice(0, 120)
 *   macOS (os === 'macos', or the record has Subsystem/MsgType): key = Subsystem|ProviderName|mask(Message).slice(0, 120)
 *     (Id is the process id there, never part of the key)
 * Each group carries unit (Linux) and subsystem (macOS), '' when the records have none.
 * Sorted by severity (lower Level = more severe; Level 0 counts as information) then by count (desc), then by last
 * occurrence (desc). sampleIds are the _ids of the most recent occurrences (newest first).
 */

const net = require('node:net');

const MAX_TEMPLATE = 160;
const W = '<*>';

const RE_GUID = /\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?/g;
const RE_HEX0X = /\b0[xX][0-9a-fA-F]+\b/g;
const RE_IPV6 = /(?<![\w:.])(?=[0-9a-fA-F:]*:[0-9a-fA-F]*:)([0-9a-fA-F:]{2,39})(%\w+)?(?![\w:])/g;
const RE_IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g;
const RE_WINPATH = /(?:\b[A-Za-z]:\\|\\\\[^\\\s]+\\|\\(?:Device|Driver|REGISTRY|\?\?)\\)[^\s"'<>|,;]*/g;
const RE_UNIXPATH = /(?<![\w.\/<>*])\/(?:[\w.@+~-]+\/)*[\w.@+~-]+\/?/g;
const RE_DQ = /"[^"\r\n]{0,400}"/g;
const RE_SQ = /(?<![A-Za-z])'[^'\r\n]{0,400}'/g;
const RE_HEXRUN = /\b[0-9a-fA-F]{8,}\b/g;
const RE_NUM = /\d{2,}/g;

function mask(message) {
    if (message == null) return '';
    let s = typeof message === 'string' ? message : String(message);
    if (s.length > 4000) s = s.slice(0, 4000);
    try {
        s = s.replace(RE_GUID, W)
            .replace(RE_HEX0X, W)
            .replace(RE_IPV4, W)
            .replace(RE_IPV6, (m, ip) => net.isIPv6(ip) ? W : m)
            .replace(RE_WINPATH, W)
            .replace(RE_UNIXPATH, W)
            .replace(RE_DQ, W)
            .replace(RE_SQ, W)
            .replace(RE_HEXRUN, W)
            .replace(RE_NUM, W)
            .replace(/\s+/g, ' ')
            .trim();
    } catch (e) { s = String(s).replace(/\s+/g, ' ').trim(); }
    return s.length > MAX_TEMPLATE ? s.slice(0, MAX_TEMPLATE) : s;
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
// Level 0 ("LogAlways") and unknown levels rank as information.
function sevLevel(l) { const n = num(l, 4); return (n >= 1 && n <= 5) ? n : 4; }
function str(v) { return v == null ? '' : String(v); }

// journald (Linux) and unified-log (macOS) records: grouped by message template, Id is a process id
function isTemplateEvent(e, os) {
    if (os === 'linux' || os === 'macos') return true;
    if (os === 'windows') return false;
    return e.Unit !== undefined || e.Priority !== undefined || e.Subsystem !== undefined || e.MsgType !== undefined;
}

function groupEvents(events, opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    const top = Math.max(1, Math.min(1000, Math.floor(num(opts.top, 30))));
    const samples = Math.max(0, Math.min(50, Math.floor(num(opts.samples, 3))));
    if (!Array.isArray(events)) return [];
    const map = new Map();
    for (const e of events) {
        if (!e || typeof e !== 'object') continue;
        const byTemplate = isTemplateEvent(e, opts.os);
        const src = str(e.ProviderName);
        const id = e.Id == null ? '' : e.Id;
        const unit = e.Unit == null ? '' : str(e.Unit);
        const subsystem = e.Subsystem == null ? '' : str(e.Subsystem);
        let template = null;
        let key;
        if (byTemplate) {
            template = mask(e.Message);
            key = (unit || subsystem) + '|' + src + '|' + template.slice(0, 120);
        } else {
            key = src + '|' + str(id);
        }
        const tc = num(e.tc, 0);
        const lvl = sevLevel(e.Level);
        let g = map.get(key);
        if (!g) {
            g = { key: key, count: 0, first: tc, last: tc, level: lvl, log: str(e.LogName), src: src, id: id, unit: unit, subsystem: subsystem,
                template: template !== null ? template : mask(e.Message), _samples: [] };
            map.set(key, g);
        }
        g.count++;
        if (tc < g.first) g.first = tc;
        if (tc > g.last) g.last = tc;
        if (lvl < g.level) g.level = lvl;
        if (!g.template && e.Message) g.template = template !== null ? template : mask(e.Message);
        if (samples > 0 && e._id != null) {
            const ss = g._samples;
            if (ss.length < samples) { ss.push({ id: e._id, tc: tc }); ss.sort((a, b) => b.tc - a.tc); }
            else if (tc > ss[ss.length - 1].tc) { ss[ss.length - 1] = { id: e._id, tc: tc }; ss.sort((a, b) => b.tc - a.tc); }
        }
    }
    const out = [...map.values()];
    out.sort((a, b) => (a.level - b.level) || (b.count - a.count) || (b.last - a.last) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out.slice(0, top).map((g) => ({
        key: g.key, count: g.count, first: g.first, last: g.last, level: g.level, log: g.log, src: g.src, id: g.id,
        unit: g.unit, subsystem: g.subsystem, template: g.template, sampleIds: g._samples.map((x) => x.id)
    }));
}

module.exports = { mask, groupEvents };
