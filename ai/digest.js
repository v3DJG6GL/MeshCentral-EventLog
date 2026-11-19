'use strict';
// "Summary only" mode for models without tool calling: the server runs the same read-only tools up front and packs
// their results, by priority, into ONE fenced message that fits the budget.
//
// build({ tools, mode, input, budgetTokens, nonce, now }) -> Promise<{ text, refs, sections }>
//   tools  : toolset from ai/tools.js (run / pack / has)
//   mode   : 'explain'  input { ref, event, os? } -> event + reference + device + +-15 min neighbours (10) + 7-day group
//            'diagnose' input { window:{from,to} } -> device + facets + top 25 groups (most severe first) + 2 samples each
//            'ask'      input {}               -> the diagnose digest for the last 24 h
//   text   : prompts.fence(nonce, 'digest', ...) (redacted by tools.pack); '' when nothing could be added
//   refs   : the event refs that made it into the text

const prompts = require('./prompts.js');
const budget = require('./budget.js');

const MIN_SECTION_TOKENS = 150;

function iso(t) { const d = new Date(Number(t)); return isNaN(d.getTime()) ? undefined : d.toISOString(); }

function plan(mode, input, now) {
    input = input || {};
    const P = [];
    if (mode === 'explain') {
        const e = input.event || {};
        const tc = Number(e.tc) || now;
        // Linux / macOS: Id is a process id, not an event id (os: the device's, else told by the record's fields)
        const pidIds = input.os === 'linux' || input.os === 'macos' || (input.os !== 'windows' && (e.Unit != null || e.Priority != null || e.Subsystem != null || e.MsgType != null));
        P.push({ label: 'The event to explain', tool: 'get_event', args: { ref: input.ref } });
        P.push({ label: 'Reference for this event', tool: 'lookup_event_id', args: { ref: input.ref } });
        P.push({ label: 'Device', tool: 'get_device_info', args: {} });
        P.push({ label: 'Events within 15 minutes of it', tool: 'get_events', args: { window: { since: iso(tc - 900000), until: iso(tc + 900000) }, limit: 11 }, internal: { excludeId: e._id }, cut: 10 });
        const f = {};
        if (e.ProviderName) f.sources = [String(e.ProviderName).slice(0, 200)];
        if (!pidIds && e.Id != null && /^\d{1,6}$/.test(String(e.Id))) f.ids = String(e.Id);
        P.push({ label: 'The same event over the last 7 days', tool: 'event_groups', args: { window: { since: iso(now - 7 * 86400000), until: iso(now) }, filters: f, top_n: 3 } });
    } else {
        let w = mode === 'diagnose' && input.window ? input.window : { from: now - 86400000, to: now };
        const win = { since: iso(w.from), until: iso(w.to) };
        P.push({ label: 'Device', tool: 'get_device_info', args: {} });
        P.push({ label: 'Event counts in the window', tool: 'event_facets', args: { window: win } });
        P.push({ label: 'Event groups in the window (most severe first)', tool: 'event_groups', args: { window: win, top_n: 25 }, internal: { sampleEvents: 2 } });
    }
    return P;
}

async function build(o) {
    o = o || {};
    const tools = o.tools;
    const now = typeof o.now === 'function' ? o.now() : Date.now();
    let remaining = Math.max(0, Math.floor(Number(o.budgetTokens) || 0));
    const nonce = o.nonce || (tools && tools.nonce) || prompts.newNonce();
    const parts = [], sections = [];
    if (!tools || typeof tools.run !== 'function') return { text: '', refs: [], sections: [] };
    for (const step of plan(o.mode, o.input, now)) {
        if (remaining < MIN_SECTION_TOKENS) break;
        if (typeof tools.has === 'function' && !tools.has(step.tool)) continue;
        let r;
        try { r = await tools.run(step.tool, step.args, step.internal || null); } catch (e) { r = { ok: false, error: 'failed' }; }
        let data;
        if (!r || !r.ok) data = { error: String((r && r.error) || 'failed') };
        else {
            data = r.data;
            if (step.cut && data && Array.isArray(data.events)) { data = Object.assign({}, data, { events: data.events.slice(0, step.cut) }); data.returned = data.events.length; }
        }
        const head = '### ' + step.label + ' (' + step.tool + ')\n';
        const avail = remaining - budget.estimateTokens(head);
        if (avail < MIN_SECTION_TOKENS) break;
        const fit = tools.pack(data, avail);
        parts.push(head + fit.text);
        sections.push({ label: step.label, tool: step.tool, truncated: !!fit.truncated, items: (r && r.items) || 0 });
        remaining -= budget.estimateTokens(head + fit.text) + 1;
    }
    if (!parts.length) return { text: '', refs: [], sections: sections };
    const body = parts.join('\n\n');
    const refs = [];
    const re = /"(E\d{1,6})"/g;
    let m;
    while ((m = re.exec(body))) if (refs.indexOf(m[1]) < 0) refs.push(m[1]);
    return { text: prompts.fence(nonce, 'digest', body), refs: refs, sections: sections };
}

module.exports = { build, plan };
