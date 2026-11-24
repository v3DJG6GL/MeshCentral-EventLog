'use strict';
// One Assistant turn: model rounds with read-only tool calls, streaming to the browser, finalize, audit.
//
// runTurn(S, userText, deps) -> Promise<void>   never rejects; every outcome ends in onAiDone or onAiError + audit
//   S        session (ai/session.js) with mode, transcript, redactor, refs, toolMode ('tools'|'summary'), toolModeAuto,
//            ep (no key), model? (the chat's model, else ep.model; for the audit record), window?, os, nonce, answers[],
//            suspicious:Set, reqId?, genEff? { thinking, temperature } (the settings in effect for this turn, written to
//            the audit record)
//   userText the user message for the model, already composed and redacted by the caller
//   deps: {
//     llm, adapter, store, settings, log, now,
//     epCall()            -> ep for the adapter, with apiKey (resolved per request; never stored on S)
//     net                 { lookup, agent, network }
//     tools               toolset (ai/tools.js)
//     budget              { ctx, maxOutput, input }        (input = budget.inputBudget(ctx, maxOutput))
//     send(method, obj)   -> bool   adds nodeid + convId; must check that the ws is still open
//     authorize()         -> Promise<{ ok, reason }>        before every tool call (rights + permission again)
//     closeSession(reason)
//     getEventsByIds(ids) -> Promise<[stored event]>      for onAiDone.citations
//     buildDigest(tokens) -> Promise<{ text, refs }>      summary fallback when the endpoint rejects tools
//     systemPrompt(toolNames) -> string                   rebuilt for the summary fallback
//     onToolsUnsupported()                                persist caps.tools = false
//     onDone(doneMsg, { steps })                          optional: after onAiDone was sent (saving the result)
//     timeouts { idleMs, totalMs, connectMs }, flushMs (75), maxCallsPerRound (4), maxCalls (settings.limits.maxCalls, else 3 x maxRounds)
//   }
// Text the model writes in a round that also calls tools ("I'll start with a broad look at the device") is not part of
// the answer: it is sent as onAiNote { turn, i, round, text } (i = its place in the steps, round = the model call) and
// kept with the steps; onAiDelta { turn, seq, round, text } carries the round, so the browser can drop the text of a
// round that turned out to be such a note. The answer (and the <diagnosis> / <explain> / <followups> blocks) is the
// text of the last round only (the last note's text when the last round wrote nothing).
// Tool calls a model wrote as text (ai/toolcalls.js: Qwen/Hermes <tool_call>, <function_calls>, [TOOL_CALLS] ...) are
// never shown: in a round that may still use tools and has no structured calls they are run like structured calls;
// otherwise they are removed from the text (the stream to the browser stops where such markup starts).
// When tool use ends for the turn (Max steps / tool calls / data per answer, or the context is nearly full), that
// model call gets a short closing instruction as a last user message (not kept in the transcript) and the browser
// an onAiNote { turn, i, round, text, kind: 'limit' } saying so. A closing round that only announces more lookups
// (or tool calls) is asked once more, more firmly; if it still writes no answer the turn fails with code stepLimit.
// onAiDone.usage.steps counts the model calls that ran lookups (what Max steps per answer limits).
// While the model reasons, onAiThinking { turn, round, chars } is sent (at most every 500 ms per model call; round
// counts the model calls of the turn, chars the reasoning characters of that call so far): a count only, never the
// reasoning text, and nothing once the call's answer text has started.
// Transcript items are append-only within a turn (provider-native raw blocks replay verbatim); a failed or
// cancelled turn is rolled back as a whole so the next question starts from the last good state. When a chat
// changes its model, ai/index.js drops the raw blocks of the earlier answers (they replay as text and calls).

const prompts = require('./prompts.js');
const citations = require('./citations.js');
const toolcalls = require('./toolcalls.js');
const budgetMod = require('./budget.js');

const MAX_DELTA_CHARS = 5000;           // <= 16 KB per onAiDelta message
const THINK_MS = 500;                   // onAiThinking at most twice a second
const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const CODE_MAP = {
    auth: 'auth', model: 'model', rateLimit: 'rateLimit', overloaded: 'overloaded', timeout: 'timeout', network: 'network',
    blocked: 'blocked', contextFull: 'contextFull', aborted: 'aborted', badResponse: 'badResponse', badRequest: 'badResponse',
    server: 'badResponse', toolsUnsupported: 'model', denied: 'denied', refusal: 'refusal', stepLimit: 'stepLimit'
};
// what the browser is told when tool use ends for the turn (steps list and status line)
const LIMIT_NOTE = {
    steps: 'Step limit reached: writing the answer with what was found so far.',
    calls: 'Lookup limit reached: writing the answer with what was found so far.',
    data: 'Data limit for one answer reached: writing the answer with what was found so far.',
    context: 'The model\'s context is nearly full: writing the answer with what was found so far.'
};
const LIMIT_ERR = {
    steps: 'The model kept asking for more data after the step limit. Try a shorter time window, or have an administrator raise Max steps per answer.',
    calls: 'The model kept asking for more data after the lookup limit. Try a shorter time window, or have an administrator raise Tool calls per answer.',
    data: 'The model kept asking for more data after the data limit for one answer. Try a shorter time window or a narrower question.',
    context: 'The model kept asking for more data although its context is nearly full. Try a shorter time window or a narrower question.'
};
// A closing answer that only announces more work ("Let me verify the event IDs.") is no answer.
const PREAMBLE_RE = /^(?:let me|let's|let us|i'll|i will|i need to|i should|i'm going to|i am going to|i'd like to|i want to|now,? (?:i|let)|next,? (?:i|let)|first,? (?:i|let)|to (?:verify|confirm|check|be sure)|checking|looking up|verifying)\b/i;
function usableAnswer(text, mode) {
    const t = prompts.parseFollowups(String(text || '')).text.trim();
    if (!t) return false;
    if ((mode === 'diagnose' && /<diagnosis\s*>/i.test(text)) || (mode === 'explain' && /<explain\s*>/i.test(text))) return true;
    if (t.length >= 200 || /\[\s*E\d{1,6}/.test(t)) return true;
    return !(PREAMBLE_RE.test(t) || /[:\u2026]\s*$|\.\.\.\s*$/.test(t));
}
function closingText(mode, firm) {
    const block = mode === 'diagnose' ? ' End with the <diagnosis> block as instructed.' : mode === 'explain' ? ' End with the <explain> block as instructed.' : ' End with the <followups> block as instructed.';
    return firm
        ? 'Tool calls are not available any more and will not be run. Do not write <tool_call>, <function=...> or any other tool call, and do not announce further lookups. Write your complete final answer now from the data above; say what remains unverified.' + block
        : 'No more lookups are available for this question. Write your final answer now from the data you already have; do not call tools.' + block;
}

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function clip(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
function bytes(s) { return Buffer.byteLength(typeof s === 'string' ? s : (JSON.stringify(s) || ''), 'utf8'); }
function mkErr(code, message) { const e = new Error(message); e.code = code; return e; }
function mapStrings(v, fn, key, depth) {
    depth = depth || 0;
    if (depth > 16) return v;
    if (typeof v === 'string') return fn(v, key);
    if (Array.isArray(v)) return v.map(function (x) { return mapStrings(x, fn, key, depth + 1); });
    if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = mapStrings(v[k], fn, k, depth + 1); return o; }
    return v;
}
function collectRefs(v, out, depth) {
    depth = depth || 0;
    if (depth > 16 || v == null) return out;
    if (typeof v === 'string') { const m = /^\s*\[?\s*E0*(\d{1,6})\s*\]?\s*$/i.exec(v); if (m) out.add('E' + m[1]); for (const r of citations.extract(v)) out.add(r); }
    else if (Array.isArray(v)) v.forEach(function (x) { collectRefs(x, out, depth + 1); });
    else if (isObj(v)) Object.keys(v).forEach(function (k) { collectRefs(v[k], out, depth + 1); });
    return out;
}
function hostOf(url) { try { return new URL(url).host; } catch (e) { return null; } }
function transcriptForAudit(t) {
    try {
        const items = (t.items || []).map(function (it) {
            if (it.role === 'tool') return { role: 'tool', results: (it.results || []).map(function (r) { return { name: r.name, isError: !!r.isError, content: r.content }; }) };
            if (it.role === 'assistant') return { role: 'assistant', text: it.text || '', calls: (it.calls || []).map(function (c) { return { name: c.name, args: c.argsText }; }) };
            return { role: 'user', text: it.text || '' };
        });
        let s = JSON.stringify({ system: t.system || '', items: items });
        if (bytes(s) > MAX_TRANSCRIPT_BYTES) s = Buffer.from(s, 'utf8').subarray(0, MAX_TRANSCRIPT_BYTES).toString('utf8') + '…';
        return s;
    } catch (e) { return null; }
}
function capTokens(input) { return Math.max(400, Math.min(6000, Math.floor(0.2 * input))); }
// Per-turn caps. Tool calls (single data lookups across all steps): settings.limits.maxCalls, automatic (null)
// 3 per allowed step; deps.maxCalls overrides both. New data sent to the model in one turn (the question plus tool
// results, not the history resent each round): settings.limits.maxSentKB, automatic (null) about 3 bytes per
// context token and at least 400 KB.
function turnLimits(limits, B, deps) {
    limits = limits || {}; deps = deps || {};
    const maxRounds = Number(limits.maxRounds) > 0 ? Math.floor(Number(limits.maxRounds)) : 15;
    const maxCalls = Number(deps.maxCalls) > 0 ? Number(deps.maxCalls) : (Number(limits.maxCalls) > 0 ? Math.floor(Number(limits.maxCalls)) : 3 * maxRounds);
    const perRound = Number(deps.maxCallsPerRound) > 0 ? Number(deps.maxCallsPerRound) : 4;
    const ctxKB = B && Number(B.ctx) > 0 ? Math.ceil(Number(B.ctx) * 3 / 1024) : 0;
    const maxSentKB = Number(limits.maxSentKB) > 0 ? Number(limits.maxSentKB) : Math.max(400, ctxKB);
    return { maxRounds: maxRounds, maxCalls: maxCalls, perRound: perRound, maxSentKB: maxSentKB, maxSentBytes: maxSentKB * 1024 };
}

async function runTurn(S, userText, deps) {
    try { await turn(S, userText, deps); }
    catch (e) {
        try { (deps && deps.log || console.log)('EVENTLOG AI: turn failed unexpectedly (' + ((e && e.name) || 'Error') + ')'); } catch (e2) { }
    }
}

async function turn(S, userText, deps) {
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    const log = typeof deps.log === 'function' ? deps.log : function () { };
    const settings = deps.settings || {};
    const limits = settings.limits || {};
    const B = deps.budget || { ctx: 8192, maxOutput: 1024, input: budgetMod.inputBudget(8192, 1024) };
    const L = turnLimits(limits, B, deps);
    const maxRounds = L.maxRounds, maxCalls = L.maxCalls, perRound = L.perRound, maxSent = L.maxSentBytes;
    const cap = capTokens(B.input);
    const flushMs = Number(deps.flushMs) > 0 ? Number(deps.flushMs) : 75;
    const tmo = deps.timeouts || {};
    const R = S.redactor;
    const t0 = now();

    S.turn = (S.turn || 0) + 1;
    const turnNo = S.turn;
    S.lastActive = t0;
    if (!Array.isArray(S.answers)) S.answers = [];
    if (!S.suspicious) S.suspicious = new Set();

    const saved = { transcript: S.transcript, len: S.transcript.items.length, segment: S.segment || 0 };
    const steps = [];
    const texts = [];
    let finalText = null;
    let rounds = 0, calls = 0, bytesSent = 0, bytesRecv = 0, dataBytes = bytes(userText);
    let tokIn = 0, tokOut = 0, estimated = false, stopReason = 'end';
    let ignoredNone = false, fellBack = false, segRetried = false, firm = false, askedMore = false, limitWhy = null, textCalls = false;
    let abortReason = null, cur = null, abortReject = null;
    const abortP = new Promise(function (resolve, reject) { abortReject = reject; });
    abortP.catch(function () { });
    S.abort = function (reason) {
        if (abortReason) return;
        abortReason = reason || 'aborted';
        if (cur) { try { cur.abort(abortReason); } catch (e) { } }
        abortReject(mkErr('aborted', 'Aborted'));
    };

    // ---- streaming to the browser ------------------------------------------------------------------------------
    const rs = R.restorer({ mark: true });
    let outBuf = '', seq = 0, timer = null, roundHasText = false, deltaRound = 0;
    function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        while (outBuf) {
            let n = Math.min(outBuf.length, MAX_DELTA_CHARS);
            if (n < outBuf.length) { const c = outBuf.charCodeAt(n - 1); if (c >= 0xD800 && c <= 0xDBFF) n--; }
            const chunk = outBuf.slice(0, n);
            outBuf = outBuf.slice(n);
            deps.send('onAiDelta', { turn: turnNo, seq: ++seq, round: deltaRound, text: chunk });
        }
    }
    function emit(text) {
        if (!text) return;
        outBuf += text;
        if (!timer) { timer = setTimeout(flush, flushMs); if (typeof timer.unref === 'function') timer.unref(); }
    }
    // ---- "thinking" (reasoning) phases: counts only, throttled -------------------------------------------------------
    let callNo = 0, thinkChars = 0, thinkSentAt = 0, thinkTimer = null, thinkOn = false;
    function sendThinking() {
        if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
        thinkSentAt = Date.now();
        deps.send('onAiThinking', { turn: turnNo, round: callNo, chars: thinkChars });
    }
    function onThinking(n) {
        if (abortReason || roundHasText) return;
        S.lastActive = now();
        thinkChars += Math.max(0, Number(n) || 0);
        const wait = THINK_MS - (Date.now() - thinkSentAt);
        if (!thinkOn || wait <= 0) { thinkOn = true; sendThinking(); }
        else if (!thinkTimer) { thinkTimer = setTimeout(sendThinking, wait); if (typeof thinkTimer.unref === 'function') thinkTimer.unref(); }
    }
    function stopThinking() { if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; } }

    // the text of the current model call as received; what was streamed of it; held back from markedAt on (tool-call
    // markup, ai/toolcalls.js) and, until the next chunk, a tail that could be the start of such markup
    let roundRaw = '', roundSent = 0, markedAt = -1;
    function streamable(final) {
        if (markedAt >= 0) return markedAt;
        const m = toolcalls.MARK_RE.exec(roundRaw.slice(Math.max(0, roundSent - 40)));
        if (m) { markedAt = Math.max(0, roundSent - 40) + m.index; return Math.max(roundSent, markedAt); }
        if (final) return roundRaw.length;
        const k = Math.max(roundRaw.lastIndexOf('<'), roundRaw.lastIndexOf('['));
        return k >= roundSent && roundRaw.length - k < 40 ? k : roundRaw.length;
    }
    function sendRound(final) {
        const end = Math.max(roundSent, streamable(final));
        if (end > roundSent) { emit(rs.push(roundRaw.slice(roundSent, end))); roundSent = end; }
    }
    function onText(d) {
        if (abortReason) return;
        stopThinking();
        S.lastActive = now();
        if (!roundHasText) { roundHasText = true; flush(); deltaRound = callNo; }
        roundRaw += d;
        sendRound(false);
    }
    // the text of a round that also called tools: a note in the steps, not part of the answer
    function addNote(text) {
        emit(rs.flush()); flush();
        let t = prompts.parseFollowups(toolcalls.strip(String(text || ''))).text;
        t = prompts.parseBlock(prompts.parseBlock(t, 'diagnosis').text, 'explain').text.trim();
        if (!t || steps.length >= 64) return;
        const note = clip(R.restore(t, { mark: true }), 2000);
        const i = steps.length;
        steps.push({ note: note });
        deps.send('onAiNote', { turn: turnNo, i: i, round: callNo, text: note });
    }
    // tool use ended for this turn: once, in the steps
    function addLimitNote(why) {
        if (limitWhy || steps.length >= 64) { limitWhy = limitWhy || why; return; }
        limitWhy = why;
        const i = steps.length;
        steps.push({ note: LIMIT_NOTE[why], kind: 'limit' });
        deps.send('onAiNote', { turn: turnNo, i: i, round: callNo, text: LIMIT_NOTE[why], kind: 'limit' });
    }

    function newSegment(text) {
        if (!S.answers.length) return false;
        const recap = recapText(S.answers, {
            intro: 'Recap of this chat so far (the earlier messages were dropped to fit the context):', max: 6,
            refsLine: 'Event refs returned so far: ' + Array.from(S.refs.returned).slice(-150).join(', ')
        });
        S.segment = (S.segment || 0) + 1;
        S.transcript = { system: S.transcript.system, items: [{ role: 'user', text: prompts.fence(S.nonce, 'recap', recap) + '\n\n' + text }] };
        return true;
    }

    // ---- start: budget check for long Ask chats ---------------------------------------------------------------
    const estAll = budgetMod.estimateTokens(S.transcript, S.ratio) + budgetMod.estimateTokens(userText, S.ratio) + budgetMod.estimateTokens(deps.tools.defs, S.ratio);
    if (S.mode === 'ask' && S.transcript.items.length && estAll > 0.85 * B.input && newSegment(userText)) segRetried = true;
    else S.transcript.items.push({ role: 'user', text: userText });

    // closing: an instruction sent as the last user message of this call only
    function streamOnce(toolChoice, toolsSent, closing) {
        let ep;
        try { ep = deps.epCall(); } catch (e) { throw mkErr('auth', 'The API key could not be read'); }
        const tr = closing ? { system: S.transcript.system, items: S.transcript.items.concat([{ role: 'user', text: closing }]) } : S.transcript;
        bytesSent += bytes(tr) + bytes(toolsSent);
        stopThinking();
        callNo++; thinkChars = 0; thinkOn = false;
        roundRaw = ''; roundSent = 0; markedAt = -1;
        cur = deps.llm.stream({
            ep: ep, adapter: deps.adapter, transcript: tr, tools: toolsSent,
            opts: { toolChoice: toolChoice, maxOutputTokens: B.maxOutput }, net: deps.net,
            onEvent: function (ev) { if (ev && ev.t === 'text') onText(ev.d); else if (ev && ev.t === 'thinking') onThinking(ev.n); },
            idleTimeoutMs: tmo.idleMs, totalTimeoutMs: tmo.totalMs, connectTimeoutMs: tmo.connectMs, log: log
        });
        if (abortReason) { try { cur.abort(abortReason); } catch (e) { } }
        return cur.promise;
    }
    function learnQuirks(q) {
        if (!isObj(q) || !Object.keys(q).length) return;
        S.ep.quirks = Object.assign({}, S.ep.quirks || {}, q);
        try { Promise.resolve(deps.store.setQuirks(S.ep.id, S.ep.quirks)).catch(function () { }); } catch (e) { }
    }
    function errorResult(c, msg) { return { callId: c.id, name: c.name, content: prompts.fence(S.nonce, String(c.name || 'tool').slice(0, 40), JSON.stringify({ error: msg })), isError: true }; }

    async function loop() {
        for (;;) {
            if (abortReason) throw mkErr('aborted', 'Aborted');
            const toolMode = S.toolMode === 'tools';
            const toolsSent = toolMode ? deps.tools.defs : [];
            const estIn = budgetMod.estimateTokens(S.transcript, S.ratio) + budgetMod.estimateTokens(toolsSent, S.ratio);
            const why = !toolMode ? null : rounds >= maxRounds ? 'steps' : calls >= maxCalls ? 'calls' : estIn > 0.85 * B.input ? 'context' : dataBytes >= maxSent ? 'data' : ignoredNone ? (limitWhy || 'steps') : null;
            const closed = !toolMode || !!why;
            const toolChoice = closed ? 'none' : 'auto';
            if (why) addLimitNote(why);
            roundHasText = false;
            let res;
            try { res = await streamOnce(toolChoice, toolsSent, why ? closingText(S.mode, firm) : null); }
            catch (e) { if (e && e.quirks) learnQuirks(e.quirks); throw e; }
            finally { cur = null; stopThinking(); }
            if (abortReason) throw mkErr('aborted', 'Aborted');
            sendRound(true);
            if (res.quirks) learnQuirks(res.quirks);
            bytesRecv += bytes(res.text || '') + (res.calls || []).reduce(function (n, c) { return n + bytes(c.argsText || ''); }, 0);
            if (res.usage && res.usage.in > 0) {
                tokIn += res.usage.in; tokOut += res.usage.out || 0;
                S.ratio = budgetMod.calibrate(S.ratio, res.usage.in, estIn);
            } else {
                estimated = true;
                tokIn += estIn; tokOut += budgetMod.estimateTokens(res.text || '') + budgetMod.estimateTokens((res.calls || []).map(function (c) { return c.argsText; }).join(''));
            }
            let rcalls = Array.isArray(res.calls) ? res.calls : [];
            let rtext = res.text || '', raw = res.raw || null;
            // tool calls written as text: run them while tools may still be used, else drop them from the text
            const tx = toolcalls.parse(rtext, deps.tools && deps.tools.defs);
            if (tx.found) {
                rtext = tx.text;
                if (!rcalls.length && !closed && tx.calls.length) {
                    rcalls = tx.calls.map(function (c) { return { id: 'txt_' + turnNo + '_' + callNo + '_' + Math.random().toString(36).slice(2, 8), name: c.name, args: c.args, argsText: c.argsText }; });
                    raw = null;   // the provider's own blocks hold the text, not these calls
                    if (!textCalls) { textCalls = true; log('EVENTLOG AI: the model wrote its tool calls as text; they are read from the text'); }
                }
            }
            stopReason = res.stopReason || 'end';
            if (stopReason === 'tools' && !rcalls.length) stopReason = 'end';
            if (why && !rcalls.length && !usableAnswer(rtext, S.mode) && (tx.found || stopReason !== 'length')) {
                // a closing round that asks for more data (or writes nothing) instead of answering: once more, more firmly;
                // then a model that still only asks for data fails the turn (an empty answer stays an empty answer)
                if (tx.found || rtext.trim()) askedMore = true;
                addNote(rtext);   // what it wrote leaves the answer area for the steps
                if (!firm) { firm = true; continue; }
                if (askedMore) throw mkErr('stepLimit', LIMIT_ERR[why] || LIMIT_ERR.steps);
            }
            if (rtext) texts.push(rtext);
            S.transcript.items.push({ role: 'assistant', text: rtext, calls: rcalls, raw: raw });
            if (!rcalls.length) { finalText = rtext; return; }

            if (stopReason === 'length' || stopReason === 'refusal') {
                S.transcript.items.push({ role: 'tool', results: rcalls.map(function (c) { return errorResult(c, 'Not executed: the answer was cut off'); }) });
                finalText = rtext;
                return;
            }
            if (closed) {
                // tool use is over for this turn (limits); a model that still calls tools gets one more chance to answer
                S.transcript.items.push({ role: 'tool', results: rcalls.map(function (c) { return errorResult(c, 'Tool use has ended for this question. Answer now with the data you already have.'); }) });
                if (ignoredNone) {
                    if (toolMode && !usableAnswer(rtext, S.mode)) { addNote(rtext); throw mkErr('stepLimit', LIMIT_ERR[limitWhy] || LIMIT_ERR.steps); }
                    finalText = rtext; return;
                }
                ignoredNone = true; firm = true; askedMore = true;
                addNote(rtext);
                continue;
            }
            addNote(rtext);
            const results = [];
            for (let i = 0; i < rcalls.length; i++) {
                const c = rcalls[i];
                if (i >= perRound) { results.push(errorResult(c, 'At most ' + perRound + ' tool calls per round; repeat this call in the next round if you still need it.')); continue; }
                const auth = await Promise.race([Promise.resolve(deps.authorize()), abortP]);
                if (!auth || !auth.ok) throw mkErr('denied', 'Access to this device was revoked');
                if (abortReason) throw mkErr('aborted', 'Aborted');
                const name = String(c.name || '').replace(/[^\w.-]/g, '').slice(0, 60) || 'tool';
                const shownArgs = c.args != null ? R.redactValue(c.args) : { _invalid: R.redact(clip(c.argsText, 300)) };
                const stepI = steps.length;
                const st = { tool: name, args: clip(JSON.stringify(shownArgs), 2000), ms: 0, items: 0, bytes: 0, status: 'running' };
                steps.push(st);
                deps.send('onAiStep', { turn: turnNo, i: stepI, tool: name, args: shownArgs, status: 'running', items: 0, bytes: 0, ms: 0 });
                const ts = now();
                const r = await Promise.race([deps.tools.exec(c.name, c.args, { capTokens: cap }), abortP]);
                st.ms = now() - ts; st.items = r.items || 0; st.bytes = r.bytes || 0; st.status = r.isError ? 'error' : 'done';
                S.lastActive = now();
                deps.send('onAiStep', { turn: turnNo, i: stepI, tool: name, args: shownArgs, status: st.status, items: st.items, bytes: st.bytes, ms: st.ms });
                results.push({ callId: c.id, name: c.name, content: r.content, isError: !!r.isError });
                dataBytes += r.bytes || 0;
            }
            S.transcript.items.push({ role: 'tool', results: results });
            calls += rcalls.length;
            rounds++;
        }
    }

    let result = 'answered', errCode = null, errMsg = null, errRetryable = false, errPhase = null;
    try {
        for (;;) {
            try { await loop(); break; }
            catch (e) {
                if (abortReason || !e) throw e;
                if (e.code === 'toolsUnsupported' && S.toolModeAuto && S.toolMode === 'tools' && rounds === 0 && !fellBack && !texts.length && typeof deps.buildDigest === 'function') {
                    fellBack = true;
                    S.toolMode = 'summary';
                    try { if (typeof deps.onToolsUnsupported === 'function') deps.onToolsUnsupported(); } catch (e2) { }
                    if (typeof deps.systemPrompt === 'function') S.transcript.system = deps.systemPrompt([]);
                    const dg = await deps.buildDigest(Math.floor(B.input * 0.5));
                    const last = S.transcript.items[S.transcript.items.length - 1];
                    if (dg && dg.text && last && last.role === 'user') { last.text = last.text + '\n\n' + dg.text; dataBytes += bytes(dg.text); for (const r of dg.refs || []) S.refs.mark(r); }
                    continue;
                }
                if (e.code === 'contextFull' && S.mode === 'ask' && !segRetried && rounds === 0 && !texts.length) {
                    segRetried = true;
                    const ut = S.transcript.items[S.transcript.items.length - 1];
                    S.transcript.items.length = saved.len;
                    if (newSegment(ut && ut.role === 'user' ? ut.text : userText)) continue;
                }
                throw e;
            }
        }
    } catch (e) {
        result = 'error';
        errCode = (e && CODE_MAP[e.code]) || 'internal';
        errMsg = e && e.code ? String(e.message || errCode) : 'Internal error';
        errRetryable = !!(e && e.retryable);
        if (errCode === 'timeout' && e && (e.phase === 'connect' || e.phase === 'idle' || e.phase === 'total')) errPhase = e.phase;   // connect: never reached the endpoint
        if (e && e.code === 'toolsUnsupported') errMsg = 'The model does not accept tool calls. Set the endpoint to "Summary only".';
        if (abortReason) {
            result = abortReason === 'denied' ? 'error' : 'cancelled';
            errCode = abortReason === 'denied' ? 'denied' : 'aborted';
            errMsg = abortReason === 'denied' ? 'Access to this device was revoked' : (abortReason === 'stopped' ? 'Stopped' : 'The conversation was closed');
            errRetryable = false; errPhase = null;
        } else if (errCode === 'denied') { try { S.abort('denied'); } catch (e2) { } }
        if (errCode === 'internal') log('EVENTLOG AI: internal error in a turn (' + ((e && e.name) || 'Error') + ')');
    } finally {
        if (timer) { clearTimeout(timer); timer = null; }
        stopThinking();
    }

    const durationMs = now() - t0;
    let doneMsg = null;
    if (result === 'answered') {
        try { doneMsg = await finalize(); }
        catch (e) { result = 'error'; errCode = 'internal'; errMsg = 'Internal error'; log('EVENTLOG AI: could not finish the answer (' + ((e && e.name) || 'Error') + ')'); }
    }
    if (result === 'answered') {
        flush();
        deps.send('onAiDone', doneMsg);
        // the caller saves the result (ai/history.js); what it does never changes this turn
        if (typeof deps.onDone === 'function') {
            try { deps.onDone(doneMsg, { steps: steps.map(function (x) { return x.note != null ? (x.kind ? { note: x.note, kind: x.kind } : { note: x.note }) : { tool: x.tool, args: x.args, ms: x.ms, items: x.items, status: x.status === 'running' ? 'error' : x.status }; }) }); }
            catch (e) { log('EVENTLOG AI: saving the result failed (' + ((e && e.name) || 'Error') + ')'); }
        }
    } else {
        outBuf = '';
        S.transcript = saved.transcript;
        S.transcript.items.length = Math.min(S.transcript.items.length, saved.len);
        S.segment = saved.segment;
        const em = { reqId: turnNo === 1 ? (S.reqId || null) : null, turn: turnNo, code: errCode, message: errMsg, retryable: errRetryable };
        if (errPhase) em.phase = errPhase;
        deps.send('onAiError', em);
    }
    S.abort = null;
    S.lastActive = now();
    S.lastTurn = { tokensIn: tokIn, tokensOut: tokOut, result: result };

    // ---- audit ------------------------------------------------------------------------------------------------
    try {
        const rec = {
            time: t0, userid: S.userid, username: S.username || null, nodeid: S.nodeid, nodename: (S.node && S.node.name) || null,
            endpointId: S.ep.id || null, endpointName: S.ep.name || null, host: hostOf(S.ep.baseUrl), model: S.model || S.ep.model || null, format: S.ep.format || null,
            mode: S.mode, convId: S.convId, turn: turnNo, toolMode: S.toolMode,
            steps: steps.filter(function (s) { return s.note == null; }).map(function (s) { return { tool: s.tool, args: s.args, ms: s.ms, items: s.items, bytes: s.bytes, status: s.status === 'running' ? 'error' : s.status }; }),
            rounds: rounds + (result === 'answered' ? 1 : 0), bytesSent: bytesSent, bytesRecv: bytesRecv,
            redactionOn: !!S.redacted, redactionCounts: R.counts(), tokensIn: tokIn, tokensOut: tokOut, estimated: estimated,
            durationMs: durationMs, result: result, error: errCode, counted: true
        };
        // the thinking level and temperature in effect (the chat's override, else the endpoint's; null = the server's default)
        if (isObj(S.genEff)) { rec.thinking = S.genEff.thinking == null ? null : S.genEff.thinking; rec.temperature = S.genEff.temperature == null ? null : S.genEff.temperature; }
        if (settings.storeTranscripts) { const tr = transcriptForAudit(S.transcript); if (tr) rec.transcript = tr; }
        Promise.resolve(deps.store.auditAdd(rec)).catch(function () { });
    } catch (e) { log('EVENTLOG AI: audit record failed'); }

    if (errCode === 'denied' && typeof deps.closeSession === 'function') { try { deps.closeSession('denied'); } catch (e) { } }

    async function finalize() {
        emit(rs.flush());
        // the answer is the last round's text; notes written between lookups are not part of it
        let body = (finalText != null && finalText.trim()) ? finalText : (texts.filter(function (x) { return x && x.trim(); }).pop() || '');
        body = toolcalls.strip(body);
        let structured = null;
        const pf = prompts.parseFollowups(body);
        body = pf.text;
        if (S.mode === 'explain') { const pb = prompts.parseBlock(body, 'explain'); body = pb.text; structured = prompts.validateExplain(pb.json); }
        else if (S.mode === 'diagnose') {
            const pb = prompts.parseBlock(body, 'diagnosis'); body = pb.text;
            structured = prompts.validateDiagnosis(pb.json, { windowFrom: S.window && S.window.from, windowTo: S.window && S.window.to, validRefs: S.refs.returned, os: S.os });
        }
        // what a later recap says about this answer (as sent to the model): a diagnosis also by its structured parts
        const recapExtra = (S.mode === 'diagnose' && structured) ? prompts.diagnosisText(structured) : '';
        const invalid = new Set();
        const cv = citations.validate(body, S.refs.returned);
        cv.invalid.forEach(function (r) { invalid.add(r); });
        const cited = new Set(cv.valid);
        if (structured) {
            structured = mapStrings(structured, function (s, key) {
                const v = citations.validate(s, S.refs.returned);
                v.invalid.forEach(function (r) { invalid.add(r); });
                v.valid.forEach(function (r) { cited.add(r); });
                return R.restore(v.text, { mark: key !== 'text' || !isCommandText(structured, s) });
            });
            collectRefs(structured, new Set()).forEach(function (r) { if (S.refs.returned.has(r)) cited.add(r); });
        }
        const answerRedacted = cv.text;
        const text = R.restore(cv.text, { mark: true });
        const followups = pf.followups.map(function (f) { return R.restore(f); });
        const refs = Array.from(cited).filter(function (r) { return S.refs.has(r); });
        const cites = {};
        if (refs.length && typeof deps.getEventsByIds === 'function') {
            const ids = refs.map(function (r) { return S.refs.idOf(r); }).filter(Boolean);
            let recs = [];
            try { recs = await deps.getEventsByIds(ids); } catch (e) { recs = []; }
            const byId = new Map((recs || []).map(function (e) { return [String(e._id), e]; }));
            for (const r of refs) { const rec = byId.get(S.refs.idOf(r)); if (rec) cites[r] = rec; }
        }
        S.answers.push({ q: clip(userText, 2000), a: recapExtra ? recapExtra + (answerRedacted ? '\n\n' + answerRedacted : '') : answerRedacted });
        return {
            turn: turnNo, text: text, structured: structured, citations: cites, invalidCitations: Array.from(invalid),
            suspicious: Array.from(S.suspicious).filter(function (r) { return S.refs.returned.has(r); }),
            redactionCounts: R.counts(), usage: { in: tokIn, out: tokOut, estimated: estimated, ms: now() - t0, rounds: rounds + 1, steps: rounds },
            stopReason: stopReason, followups: followups, segment: S.segment || 0
        };
    }
}

// Recap text for a new model session that replaces earlier messages (a long chat cut to fit the context, or a saved
// chat continued later): the latest question / answer pairs, at most o.max of them (default 6), each clipped (400 /
// 1500 characters), the oldest dropped first while the pairs exceed o.maxChars (the newest pair is always kept,
// cut to fit); then o.refsLine. answers: [{ q, a }] already as sent to the model (pseudonymized).
function recapText(answers, o) {
    o = o || {};
    const max = Number(o.max) > 0 ? Math.floor(Number(o.max)) : 6;
    const maxChars = Number(o.maxChars) > 0 ? Number(o.maxChars) : Infinity;
    const parts = [];
    let used = 0;
    const list = Array.isArray(answers) ? answers : [];
    for (let i = list.length - 1; i >= 0 && parts.length < max; i--) {
        const x = list[i] || {};
        let p = 'Technician asked: ' + clip(x.q, 400) + '\nYou answered: ' + clip(x.a, 1500);
        if (parts.length && used + p.length > maxChars) break;
        const cut = Math.max(200, Math.floor(Math.min(maxChars, 1e9)));
        if (p.length > cut) p = p.slice(0, cut) + '…';
        parts.unshift(p);
        used += p.length;
    }
    return (o.intro || 'Recap of this chat so far:') + '\n\n' + parts.join('\n\n') + (o.refsLine ? '\n\n' + o.refsLine : '');
}

// command texts are restored without markers so they can be copied as-is
function isCommandText(structured, s) {
    if (!structured || !Array.isArray(structured.nextSteps)) return false;
    return structured.nextSteps.some(function (st) { return st && st.command && st.command.text === s; });
}

module.exports = { runTurn, capTokens, turnLimits, recapText };
