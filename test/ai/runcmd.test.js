'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../../ai/runcmd.js');

function agent(node) { return { dbNodeKey: node, sent: [], send: function (s) { this.sent.push(JSON.parse(s)); } }; }
function setup(extra) {
    const agents = { n1: agent('n1'), n2: agent('n2') };
    let hex = 0, t = 1000;
    const rc = R.create(Object.assign({
        getAgent: function (id) { return agents[id] || null; },
        randomHex: function () { return ('000000000000000' + (++hex).toString(16)).slice(-16); },
        now: function () { return t; }
    }, extra || {}));
    return { rc: rc, agents: agents, tick: function (ms) { t += ms; } };
}
function last(a) { return a.sent[a.sent.length - 1]; }
function reply(rc, a, result, extra) {
    const c = last(a);
    return rc.onAgentData(Object.assign({ action: 'msg', type: 'runcommands', result: result, sessionid: c.sessionid, responseid: c.responseid }, extra || {}), a);
}
function decodePs(cmds) {
    const m = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(cmds);
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
}
// the run's timeout timer is unref'd (right for MeshCentral); keep the loop alive while a test waits for it
async function alive(fn) { const k = setInterval(function () { }, 1000); try { return await fn(); } finally { clearInterval(k); } }

test('message shape per shell and platform; the reply resolves with output, truncated and duration', async function () {
    const { rc, agents, tick } = setup();
    const a = agents.n1;
    let p = rc.run('n1', { platform: 'windows', shell: 'PowerShell', text: '  Get-Service | Select -First 3  ', runAsUser: 1 });
    let c = last(a);
    assert.deepStrictEqual(Object.keys(c).sort(), ['action', 'cmds', 'reply', 'responseid', 'runAsUser', 'sessionid', 'type']);
    assert.deepStrictEqual([c.action, c.type, c.runAsUser, c.reply], ['runcommands', 2, 1, true]);
    assert.strictEqual(c.sessionid, 'eventlogai:0000000000000001');
    assert.strictEqual(c.responseid, c.sessionid);
    assert.ok(/^\$ProgressPreference='SilentlyContinue';.*iex\(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)\)\r\n$/.test(c.cmds), c.cmds);
    assert.strictEqual(c.cmds.split('\n').length, 2);   // one line plus the line end
    assert.strictEqual(decodePs(c.cmds), 'Get-Service | Select -First 3');
    assert.strictEqual(rc.busy('n1'), true);
    assert.strictEqual(rc.busy('n2'), false);
    tick(250);
    assert.strictEqual(reply(rc, a, 'Running  WinRM\r\n'), true);
    assert.deepStrictEqual(await p, { output: 'Running  WinRM\n', truncated: false, ms: 250 });
    assert.strictEqual(rc.busy('n1'), false);
    assert.strictEqual(rc.pendingCount(), 0);

    for (const sh of ['cmd', 'bat', 'batch']) {
        p = rc.run('n1', { platform: 'windows', shell: sh, text: 'ipconfig /all\nsc query w32time' });
        c = last(a);
        assert.deepStrictEqual([c.type, c.runAsUser], [1, 0]);
        assert.strictEqual(c.cmds, '@echo off\r\nchcp 65001>nul 2>&1\r\nipconfig /all\r\nsc query w32time\r\n');
        reply(rc, a, 'x');
        await p;
    }
    for (const sh of ['bash', 'sh', 'shell', 'zsh', 'console']) {
        p = rc.run('n2', { platform: sh === 'zsh' ? 'macos' : 'linux', shell: sh, text: 'journalctl -b -p err --no-pager\r\nuptime', runAsUser: 1 });
        c = last(agents.n2);
        assert.deepStrictEqual([c.type, c.runAsUser], [3, 0]);           // runAsUser is Windows only
        assert.strictEqual(c.cmds, 'journalctl -b -p err --no-pager\nuptime\n');
        reply(rc, agents.n2, 'ok');
        assert.strictEqual((await p).output, 'ok');
    }
    for (const sh of ['pwsh', 'ps', 'ps1']) {
        p = rc.run('n1', { platform: 'windows', shell: sh, text: 'hostname' });
        assert.strictEqual(last(a).type, 2);
        reply(rc, a, '');
        assert.strictEqual((await p).output, '');
    }
});

test('PowerShell goes as one base64 line that round-trips non-ASCII and multi-line scripts', function () {
    const script = 'if ($true) {\n  Write-Output "Grüße, 東京, 🚀"\n}\n\n$x = @"\nhere\n"@\n';
    const cmds = R.buildCmds('powershell', script);
    assert.strictEqual(cmds.indexOf('\n'), cmds.length - 1);
    assert.ok(/^[\x20-\x7e]+\r\n$/.test(cmds), 'ASCII only');
    assert.strictEqual(decodePs(cmds), script);
    assert.match(cmds, /\[Console\]::OutputEncoding=New-Object Text\.UTF8Encoding \$false/);
    assert.strictEqual(R.buildCmds('bash', 'echo ü\r\n'), 'echo ü\n\n');
});

test('validation: bad requests and shells that do not fit the platform', async function () {
    const { rc, agents } = setup();
    const bad = async function (nodeid, req, code) { await assert.rejects(rc.run(nodeid, req), function (e) { return e.code === code; }, JSON.stringify(req)); };
    await bad('n1', null, 'badRequest');
    await bad('', { platform: 'windows', shell: 'cmd', text: 'x' }, 'badRequest');
    await bad('n1', { platform: 'windows', shell: 'cmd', text: '   \n ' }, 'badRequest');
    await bad('n1', { platform: 'windows', shell: 'cmd', text: 5 }, 'badRequest');
    await bad('n1', { platform: 'windows', shell: 'cmd', text: 'x'.repeat(8001) }, 'badRequest');
    await bad('n1', { platform: 'windows', shell: 'cmd', text: 'echo a\u0000b' }, 'badRequest');
    for (const rau of [2, -1, '1', true, 0.5]) await bad('n1', { platform: 'windows', shell: 'cmd', text: 'x', runAsUser: rau }, 'badRequest');
    await bad('n1', { platform: 'windows', shell: 'bash', text: 'ls' }, 'unsupported');
    await bad('n1', { platform: 'linux', shell: 'powershell', text: 'ls' }, 'unsupported');
    await bad('n1', { platform: 'macos', shell: 'cmd', text: 'ls' }, 'unsupported');
    await bad('n1', { platform: 'android', shell: 'bash', text: 'ls' }, 'unsupported');
    await bad('n1', { platform: 'windows', shell: 'python', text: 'print(1)' }, 'unsupported');
    await bad('n1', { platform: undefined, shell: 'cmd', text: 'x' }, 'unsupported');
    assert.strictEqual(agents.n1.sent.length, 0);
    assert.strictEqual(rc.busy('n1'), false);
    // 8000 characters are fine
    const p = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'x'.repeat(8000) });
    reply(rc, agents.n1, '');
    await p;
    assert.strictEqual(R.normShell('PWSH'), 'powershell');
    assert.strictEqual(R.normShell('__proto__'), null);
});

test('one run per device: busy; offline; a failed send', async function () {
    const { rc, agents } = setup();
    const p1 = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'sleep 1' });
    await assert.rejects(rc.run('n1', { platform: 'linux', shell: 'bash', text: 'uptime' }), function (e) { return e.code === 'busy'; });
    assert.strictEqual(agents.n1.sent.length, 1);
    // another device is independent
    const p2 = rc.run('n2', { platform: 'linux', shell: 'bash', text: 'uptime' });
    assert.strictEqual(rc.pendingCount(), 2);
    reply(rc, agents.n2, 'up');
    reply(rc, agents.n1, 'slept');
    assert.strictEqual((await p1).output, 'slept');
    assert.strictEqual((await p2).output, 'up');
    await assert.rejects(rc.run('gone', { platform: 'linux', shell: 'bash', text: 'x' }), function (e) { return e.code === 'offline'; });
    agents.n1.send = function () { throw new Error('closed'); };
    await assert.rejects(rc.run('n1', { platform: 'linux', shell: 'bash', text: 'x' }), function (e) { return e.code === 'offline'; });
    assert.strictEqual(rc.busy('n1'), false);
    const thrower = R.create({ getAgent: function () { throw new Error('x'); } });
    await assert.rejects(thrower.run('n1', { platform: 'linux', shell: 'bash', text: 'x' }), function (e) { return e.code === 'offline'; });
});

test('timeout: the device stays busy until the late reply or stuckMs', async function () {
    const { rc, agents, tick } = setup({ stuckMs: 60000 });
    const a = agents.n1;
    await alive(function () { return assert.rejects(rc.run('n1', { platform: 'linux', shell: 'bash', text: 'read x' }, 20), function (e) { return e.code === 'timeout'; }); });
    assert.strictEqual(rc.pendingCount(), 0);
    assert.strictEqual(rc.busy('n1'), true);
    await assert.rejects(rc.run('n1', { platform: 'linux', shell: 'bash', text: 'uptime' }), function (e) { return e.code === 'busy'; });
    // a late reply from another device does not free it; one from the device does
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'runcommands', result: 'late', sessionid: last(a).sessionid, responseid: last(a).responseid }, agents.n2), true);
    assert.strictEqual(rc.busy('n1'), true);
    assert.strictEqual(reply(rc, a, 'late'), true);
    assert.strictEqual(rc.busy('n1'), false);
    // without a late reply it frees itself after stuckMs
    await alive(function () { return assert.rejects(rc.run('n1', { platform: 'linux', shell: 'bash', text: 'read x' }, 20), function (e) { return e.code === 'timeout'; }); });
    tick(59999);
    assert.strictEqual(rc.busy('n1'), true);
    tick(1);
    assert.strictEqual(rc.busy('n1'), false);
    // stuckMs 0: free right after the timeout
    const s0 = setup({ stuckMs: 0 });
    await alive(function () { return assert.rejects(s0.rc.run('n1', { platform: 'linux', shell: 'bash', text: 'x' }, 20), function (e) { return e.code === 'timeout'; }); });
    assert.strictEqual(s0.rc.busy('n1'), false);
});

test('foreign session ids, other devices and other messages are ignored', async function () {
    const { rc, agents } = setup();
    const a = agents.n1;
    const p = rc.run('n1', { platform: 'windows', shell: 'cmd', text: 'ver' });
    const sid = last(a).sessionid;
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'runcommands', result: 'x', sessionid: 'user/d/alice:abc', responseid: sid }, a), false);
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'runcommands', result: 'x', responseid: sid }, a), false);
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'runcommands', result: 'evil', sessionid: sid, responseid: sid }, agents.n2), true);
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'runcommands', result: 'evil', sessionid: sid, responseid: sid }, null), true);
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'runcommands', result: 'evil', sessionid: sid, responseid: 'other' }, a), true);
    assert.strictEqual(rc.onAgentData({ action: 'software', sessionid: sid, value: '[]' }, a), false);
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'other', sessionid: sid }, a), false);
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'runcommands', sessionid: 'eventlogai:ffffffffffffffff', result: 'x' }, a), true);   // ours by prefix, unknown: dropped
    assert.strictEqual(rc.onAgentData(null, a), false);
    assert.strictEqual(rc.onAgentData('x', a), false);
    assert.strictEqual(rc.pendingCount(), 1);
    // console text the agent streams for our session is consumed; an unknown one with our prefix is not
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'console', value: 'partial output', sessionid: sid }, a), true);
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'console', value: 'x', sessionid: 'eventlogai:ffffffffffffffff' }, a), false);
    assert.strictEqual(rc.pendingCount(), 1);
    reply(rc, a, 'Microsoft Windows [Version 10.0.19045.3803]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\nC:\\Program Files\\Mesh Agent>@echo off\r\n\r\nMicrosoft Windows [Version 10.0.19045.3803]\r\n');
    assert.strictEqual((await p).output, '\nMicrosoft Windows [Version 10.0.19045.3803]\n');
});

test('the agent\'s "already busy" console message fails the run as busy', async function () {
    const { rc, agents, tick } = setup();
    const a = agents.n1;
    let p = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'uptime' });
    // broadcast without a session id: from another agent ignored, from this one taken (and still routed as usual)
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'console', value: 'Run commands can\'t execute, already busy.' }, agents.n2), false);
    assert.strictEqual(rc.pendingCount(), 1);
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'console', value: 'Run commands can\'t execute, already busy.' }, a), false);
    await assert.rejects(p, function (e) { return e.code === 'busy'; });
    assert.strictEqual(rc.busy('n1'), false);
    // with our session id
    p = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'uptime' });
    assert.strictEqual(rc.onAgentData({ action: 'msg', type: 'console', value: 'Run commands can\'t execute, already busy.', sessionid: last(a).sessionid }, a), true);
    await assert.rejects(p, function (e) { return e.code === 'busy'; });
    // too long after the send it is someone else's refusal
    p = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'uptime' });
    tick(5001);
    rc.onAgentData({ action: 'msg', type: 'console', value: 'Run commands can\'t execute, already busy.' }, a);
    assert.strictEqual(rc.pendingCount(), 1);
    reply(rc, a, 'up');
    assert.strictEqual((await p).output, 'up');
});

test('output: ANSI and control characters stripped, capped at maxOutput, non-strings empty', async function () {
    const { rc, agents } = setup({ maxOutput: 10 });
    const a = agents.n1;
    let p = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'x' });
    reply(rc, a, '\x1b[31mred\x1b[0m\x1b]0;title\x07 \x1b[2K\x1b(Bok\x00\x07');
    assert.deepStrictEqual(await p, { output: 'red ok', truncated: false, ms: 0 });
    p = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'x' });
    reply(rc, a, '0123456789abcdef');
    assert.deepStrictEqual(await p, { output: '0123456789', truncated: true, ms: 0 });
    p = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'x' });
    reply(rc, a, { not: 'text' });
    assert.deepStrictEqual(await p, { output: '', truncated: false, ms: 0 });
    // no split surrogate pair at the cap
    assert.deepStrictEqual(R.cleanOutput('123456789🚀', 'bash', 10), { output: '123456789', truncated: true });
    assert.deepStrictEqual(R.cleanOutput('﻿a\r\nb\rc', 'powershell', 100), { output: 'a\nb\nc', truncated: false });
    // the default cap is 64 K characters
    const d = setup();
    p = d.rc.run('n1', { platform: 'linux', shell: 'bash', text: 'x' });
    reply(d.rc, d.agents.n1, 'y'.repeat(70000));
    const r = await p;
    assert.deepStrictEqual([r.output.length, r.truncated], [65536, true]);
});

test('close() aborts every pending run and frees the devices', async function () {
    const { rc } = setup();
    const p1 = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'x' });
    const p2 = rc.run('n2', { platform: 'windows', shell: 'cmd', text: 'x' });
    rc.close();
    await assert.rejects(p1, function (e) { return e.code === 'aborted'; });
    await assert.rejects(p2, function (e) { return e.code === 'aborted'; });
    assert.strictEqual(rc.pendingCount(), 0);
    assert.strictEqual(rc.busy('n1'), false);
});

test('defaults: real random session ids', async function () {
    const a = agent('n1');
    const rc = R.create({ getAgent: function () { return a; } });
    const p = rc.run('n1', { platform: 'linux', shell: 'bash', text: 'x' });
    assert.ok(/^eventlogai:[0-9a-f]{16}$/.test(a.sent[0].sessionid));
    reply(rc, a, 'ok');
    const r = await p;
    assert.strictEqual(r.output, 'ok');
    assert.ok(r.ms >= 0);
    assert.strictEqual(R.PREFIX, require('../../ai/software.js').PREFIX);
});
