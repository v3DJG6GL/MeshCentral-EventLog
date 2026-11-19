'use strict';
// The MeshAgent-side module (modules_meshcore/eventlog.js) on macOS: loaded with vm in a sandbox that stands in for
// MeshAgent (require stubs for fs, child_process, SimpleDataStore, MeshAgent; process.platform), so the module's
// top-level functions are reachable on the context. No real `log` or /bin/sh is run.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var EventEmitter = require('events');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'modules_meshcore', 'eventlog.js'), 'utf8');
var J = function (x) { return JSON.parse(JSON.stringify(x)); };   // values from the vm realm -> plain values

// opts: { platform, handler(script, files) -> { stdout, stderr, code, file, hold } }
function load(opts) {
    opts = opts || {};
    var store = {}, files = {}, scripts = [], sent = [], held = [];
    var handler = opts.handler || function () { return {}; };
    var fakeFs = {
        existsSync: function (p) { return (opts.dirs || ['/var/tmp', '/tmp']).indexOf(p) >= 0 || files[p] !== undefined; },
        readFileSync: function (p) { if (files[p] === undefined) throw new Error('ENOENT ' + p); return Buffer.from(files[p]); },
        unlinkSync: function (p) { delete files[p]; },
        createWriteStream: function () { return { write: function () { }, end: function () { } }; }
    };
    var finish = function (child, script, r) {
        var m = /> (\S+\.txt)\s*(\n|$)/.exec(script);
        if (m) files[m[1]] = (r.file != null) ? r.file : '';
        if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
        if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
        child.emit('exit', r.code || 0);
    };
    var cp = {
        execFile: function () {
            var child = new EventEmitter();
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            child.kill = function () { };
            child.stdin = { write: function (s) {
                scripts.push(s);
                setImmediate(function () {
                    var r = handler(s, files) || {};
                    if (r.hold) held.push(function () { finish(child, s, r); });
                    else finish(child, s, r);
                });
            } };
            return child;
        }
    };
    var db = { Get: function (k) { return store[k] === undefined ? null : store[k]; }, Put: function (k, v) { store[k] = (typeof v == 'string') ? v : JSON.stringify(v); } };
    var mesh = { SendCommand: function (c) { sent.push(J(c)); } };
    var req = function (name) {
        if (name == 'fs') return fakeFs;
        if (name == 'child_process') return cp;
        if (name == 'SimpleDataStore') return { Shared: function () { return db; } };
        if (name == 'MeshAgent') return mesh;
        throw new Error('unexpected require ' + name);
    };
    var ctx = {
        require: req, db: db, Buffer: Buffer, console: console, module: { exports: {} },
        process: { platform: opts.platform || 'darwin', execPath: '/usr/local/mesh_services/meshagent/meshagent' },
        setInterval: function () { return 1; }, clearInterval: function () { }
    };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx, { filename: 'eventlog-agent.js' });
    return { ctx: ctx, store: store, files: files, scripts: scripts, sent: sent, held: held };
}
function tick(n) { return new Promise(function (r) { var i = 0; (function f() { if (++i >= (n || 20)) return r(); setImmediate(f); })(); }); }

var PROBE_OK = 'L=1\nV=14.5\nJ=1\nC=1\n';
function ev(ts, o) {
    o = o || {};
    return JSON.stringify({ eventType: o.eventType || 'logEvent', timestamp: ts, messageType: o.mt || 'Error', processImagePath: o.path || '/usr/libexec/foo',
        subsystem: o.sub || '', category: o.cat || '', processID: o.pid != null ? o.pid : 42, eventMessage: o.msg || ('m ' + ts) });
}
// a timestamp string in UTC for µs since epoch
function tsOf(us) {
    var d = new Date(Math.floor(us / 1000)), p = function (n, w) { return String(n).padStart(w || 2, '0'); };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + '.' + p(us % 1000000, 6) + '+0000';
}
function sel(c, levels) { return c.macLevelSel(levels); }

// ---------------------------------------------------------------- ES5

test('the agent module stays ES5 (MeshAgent runs DukTape)', function () {
    var code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"])\/\/.*$/gm, '$1');
    assert.ok(!/=>/.test(code), 'arrow function');
    assert.ok(!/\b(let|const|class)\s/.test(code), 'let/const/class');
    assert.ok(code.indexOf('`') < 0 || !/`[^`]*\$\{/.test(code), 'template literal');
    assert.ok(!/\.includes\(|Object\.assign\(|\.startsWith\(|\.endsWith\(|\.padStart\(|\.repeat\(|Array\.from\(/.test(code), 'ES2015+ library call');
});

// ---------------------------------------------------------------- timestamps

test('parseMacTime: offsets, microseconds, .ips header form, Z, colon offsets', function () {
    var c = load().ctx;
    var t = c.parseMacTime('2026-11-19 10:00:00.123456+0100');
    assert.strictEqual(t.us, Date.UTC(2026, 10, 19, 9, 0, 0) * 1000 + 123456);
    assert.strictEqual(t.ms, Date.UTC(2026, 10, 19, 9, 0, 0) + 123);
    assert.strictEqual(c.parseMacTime('2026-11-19 10:00:00.000001-0530').us, Date.UTC(2026, 10, 19, 15, 30, 0) * 1000 + 1);
    assert.strictEqual(c.parseMacTime('2026-11-19 10:00:00.12 +0200').ms, Date.UTC(2026, 10, 19, 8, 0, 0) + 120);   // .ips header style
    assert.strictEqual(c.parseMacTime('2026-01-01T00:00:00Z').ms, Date.UTC(2026, 0, 1));
    assert.strictEqual(c.parseMacTime('2024-02-29 23:59:59.5+01:00').ms, Date.UTC(2024, 1, 29, 22, 59, 59, 500));
    assert.strictEqual(c.parseMacTime('1970-01-01 00:00:00+0000').us, 0);
    assert.strictEqual(c.parseMacTime('garbage'), null);
    assert.strictEqual(c.parseMacTime(null), null);
    // agrees with Date.UTC across a spread of dates (leap years, month ends)
    for (var i = 0; i < 400; i++) {
        var ms = Date.UTC(1999, 0, 1) + i * 86400 * 1000 * 23 + i * 3333;
        var us = ms * 1000 + (i * 7) % 1000;
        assert.strictEqual(c.parseMacTime(tsOf(us)).us, us);
    }
});

test('macStartArg: local time, plain documented form', function () {
    var c = load().ctx;
    var sec = Math.floor(Date.UTC(2026, 10, 19, 9, 0, 5) / 1000);
    var s = c.macStartArg(sec);
    assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    var d = new Date(sec * 1000);
    if (new Date((sec - 3600) * 1000).getTimezoneOffset() == d.getTimezoneOffset()) {
        assert.strictEqual(s, d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
            String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':05');
    }
});

// ---------------------------------------------------------------- categories

test('macCategory follows the spec rules in order', function () {
    var c = load().ctx;
    var cat = function (proc, p, sub) { return c.macCategory({ process: proc, path: p, subsystem: sub }); };
    assert.strictEqual(cat('kernel', '/kernel', 'com.apple.securityd'), 'Kernel');
    assert.strictEqual(cat('x', '/kernel', ''), 'Kernel');
    assert.strictEqual(cat('foo', '/usr/libexec/foo', 'com.apple.securityd'), 'Auth');
    assert.strictEqual(cat('foo', '/usr/libexec/foo', 'com.apple.loginwindow.logging'), 'Auth');
    assert.strictEqual(cat('foo', '/usr/libexec/foo', 'com.apple.AuthKit'), 'Auth');
    assert.strictEqual(cat('sshd-session', '/usr/libexec/sshd-session', ''), 'Auth');
    assert.strictEqual(cat('sudo', '/usr/bin/sudo', ''), 'Auth');
    assert.strictEqual(cat('softwareupdated', '/System/Library/x/softwareupdated', 'com.apple.mobileassetd'), 'Install');
    assert.strictEqual(cat('foo', '/usr/libexec/foo', 'com.apple.SoftwareUpdate.core'), 'Install');
    assert.strictEqual(cat('foo', '/Applications/X.app/foo', 'com.apple.installer'), 'Install');
    assert.strictEqual(cat('foo', '/Applications/X.app/foo', 'com.apple.coreaudio'), 'System');
    assert.strictEqual(cat('foo', '/System/Library/foo', ''), 'System');
    assert.strictEqual(cat('foo', '/private/var/db/foo', ''), 'System');
    assert.strictEqual(cat('foo', '/sbin/foo', ''), 'System');
    assert.strictEqual(cat('Slack', '/Applications/Slack.app/Contents/MacOS/Slack', 'com.tinyspeck.slack'), 'Application');
    assert.strictEqual(cat('foo', '/opt/homebrew/bin/foo', ''), 'Application');
});

// ---------------------------------------------------------------- levels and predicates

test('level mapping and predicate building', function () {
    var c = load().ctx;
    var s = sel(c, [2, 3]);
    assert.deepStrictEqual(J(s.types), ['error']);
    assert.strictEqual(s.info || s.debug, false);
    assert.strictEqual(s.crash, true); assert.strictEqual(s.panic, false);
    assert.strictEqual(c.macPredicate(s, null), 'eventType == logEvent AND (messageType == error)');
    s = sel(c, [1, 4]);
    assert.deepStrictEqual(J(s.types), ['fault', 'default', 'info']);
    assert.strictEqual(s.info, true); assert.strictEqual(s.debug, false); assert.strictEqual(s.panic, true); assert.strictEqual(s.crash, false);
    assert.strictEqual(c.macPredicate(s, null), 'eventType == logEvent AND (messageType == fault OR messageType == default OR messageType == info)');
    s = sel(c, [5]);
    assert.deepStrictEqual(J(s.types), ['debug']); assert.strictEqual(s.debug, true); assert.strictEqual(s.info, true);
    s = sel(c, [3]);   // no Warning on macOS
    assert.deepStrictEqual(J(s.types), []); assert.strictEqual(s.all, false); assert.strictEqual(s.crash || s.panic, false);
    [null, [], [0], [2, 0]].forEach(function (lv) {
        var a = sel(c, lv);
        assert.strictEqual(a.all, true); assert.strictEqual(a.info && a.debug && a.crash && a.panic, true);
        assert.strictEqual(c.macPredicate(a, null), 'eventType == logEvent');
    });
    assert.strictEqual(c.macLevelOf('Fault'), 1); assert.strictEqual(c.macLevelOf('Error'), 2);
    assert.strictEqual(c.macLevelOf('Default'), 4); assert.strictEqual(c.macLevelOf('Info'), 4); assert.strictEqual(c.macLevelOf('Debug'), 5);
    // selectors: fixed tokens; user values sanitized (quotes, spaces, $ removed)
    assert.strictEqual(c.macPredicate(sel(c, [2]), c.macSelPredicate('kernel').extra), 'eventType == logEvent AND (messageType == error) AND (processImagePath == "/kernel" OR process == "kernel")');
    assert.match(c.macSelPredicate('auth').extra, /subsystem == "com.apple.securityd" OR .*subsystem BEGINSWITH\[c\] "com.apple.loginwindow" OR .*process == "sshd-session"$/);
    assert.match(c.macSelPredicate('install').extra, /^process == "installd" OR .*subsystem BEGINSWITH\[c\] "com.apple.install"$/);
    assert.strictEqual(c.macSelPredicate('subsystem:com.foo" OR 1==1\'; rm -rf /').extra, 'subsystem == "com.fooOR1==1;rm-rf/"');
    assert.strictEqual(c.macSelPredicate('crash').unified, false);
    assert.strictEqual(c.macSelPredicate('boot').boot, true);
    assert.strictEqual(c.macSelPredicate('').crash, true);
});

test('log show command lines for history and live', function () {
    var c = load().ctx;
    var h = c.macLogCmd({ live: false, sel: sel(c, [2, 3]), startSec: null, last: '24h' }, '/var/tmp/evlmoutX.txt');
    assert.strictEqual(h, '( nice -n 10 /usr/bin/log show --style ndjson --last 24h --predicate \'eventType == logEvent AND (messageType == error)\'; echo "{\\"evlrc\\":$?}" ) | head -n 2100 | head -c 8388608 > /var/tmp/evlmoutX.txt');
    var sec = Math.floor(Date.UTC(2026, 10, 19, 9, 0, 0) / 1000);
    h = c.macLogCmd({ live: false, sel: sel(c, [1, 4]), startSec: sec }, '/f.txt');
    assert.ok(h.indexOf('--info --start "' + c.macStartArg(sec) + '" --predicate') > 0, h);
    var l = c.macLogCmd({ live: true, num: 100, sel: sel(c, [5]), last: '10m', extra: c.MAC_PRED_KERNEL }, '/f.txt');
    assert.strictEqual(l, '( nice -n 10 /usr/bin/log show --style ndjson --info --debug --last 10m --predicate \'eventType == logEvent AND (messageType == debug) AND (processImagePath == "/kernel" OR process == "kernel")\'; echo "{\\"evlrc\\":$?}" ) | tail -n 150 | head -c 8388608 > /f.txt');
});

// ---------------------------------------------------------------- ndjson parsing and the cursor

var BASE = Date.UTC(2026, 10, 19, 9, 0, 0) * 1000;   // µs
function pc(c, o) { o = o || {}; return { cursor: o.cursor || null, live: !!o.live, sel: sel(c, o.levels || null), catFilter: o.catFilter || null, catRules: o.catRules || null, srcRules: o.srcRules || null, minUs: o.minUs }; }

test('ndjson: junk lines, the summary object, a truncated last line and the status line', function () {
    var c = load().ctx;
    var txt = ['Filtering the log data using "x"', ev(tsOf(BASE + 1)), '', ev(tsOf(BASE + 2), { eventType: 'activityCreateEvent' }), ev(tsOf(BASE + 3), { mt: 'Fault' }),
        '{"count":3,"finished":1}', '{"evlrc":0}', ev(tsOf(BASE + 4)).substring(0, 40)].join('\n');
    var r = c.parseMacNdjson(txt, pc(c));
    assert.strictEqual(r.events.length, 2);
    assert.strictEqual(r.rc, 0);
    assert.strictEqual(r.lastUs, BASE + 3); assert.strictEqual(r.tie, 1);
    var e = J(r.events[1]);
    assert.deepStrictEqual(e, { LogName: 'System', Level: 1, MsgType: 'Fault', TimeCreated: '/Date(' + Math.floor((BASE + 3) / 1000) + ')/', ProviderName: 'foo',
        Subsystem: '', OsCategory: '', ProcessPath: '/usr/libexec/foo', Id: '42', Message: 'm ' + tsOf(BASE + 3) });
    assert.strictEqual(c.parseMacNdjson('{"evlrc":64}', pc(c)).rc, 64);
});

test('ndjson: level set and Categories/Sources rules apply, filtered events still move the cursor', function () {
    var c = load().ctx;
    var txt = [ev(tsOf(BASE + 1), { mt: 'Default' }), ev(tsOf(BASE + 2), { path: '/usr/sbin/sshd' }), ev(tsOf(BASE + 3), { path: '/Applications/A.app/A' })].join('\n');
    var r = c.parseMacNdjson(txt, pc(c, { levels: [2], catRules: c.evlRules('Auth', 'exclude') }));
    assert.deepStrictEqual(J(r.events).map(function (e) { return e.ProviderName; }), ['A']);
    assert.strictEqual(r.lastUs, BASE + 3); assert.strictEqual(r.examined, 3);
    r = c.parseMacNdjson(txt, pc(c, { srcRules: c.evlRules('ssh*', 'include') }));
    assert.deepStrictEqual(J(r.events).map(function (e) { return e.LogName; }), ['Auth']);
    r = c.parseMacNdjson(txt, pc(c, { catFilter: 'Application' }));
    assert.strictEqual(r.events.length, 1);
});

test('cursor skip: events before the cursor and the first n with the same µs are skipped', function () {
    var c = load().ctx;
    var X = BASE + 500;
    var txt = [ev(tsOf(X - 1), { msg: 'old' }), ev(tsOf(X), { msg: 'a' }), ev(tsOf(X), { msg: 'b' }), ev(tsOf(X), { msg: 'c' }), ev(tsOf(X + 1), { msg: 'd' })].join('\n');
    var r = c.parseMacNdjson(txt, pc(c, { cursor: { us: X, n: 2 } }));
    assert.deepStrictEqual(J(r.events).map(function (e) { return e.Message; }), ['c', 'd']);
    assert.strictEqual(r.lastUs, X + 1); assert.strictEqual(r.tie, 1);
    r = c.parseMacNdjson(txt.split('\n').slice(0, 4).join('\n'), pc(c, { cursor: { us: X, n: 2 } }));
    assert.strictEqual(r.lastUs, X); assert.strictEqual(r.tie, 3);   // ties accumulate across batches
    r = c.parseMacNdjson(txt.split('\n').slice(0, 3).join('\n'), pc(c, { cursor: { us: X, n: 2 } }));
    assert.strictEqual(r.examined, 0); assert.strictEqual(r.lastUs, X); assert.strictEqual(r.tie, 2);
    assert.deepStrictEqual(J(c.macParseCursor('1763542800123456:3|c1763542000')), { us: 1763542800123456, n: 3, crash: 1763542000 });
    assert.deepStrictEqual(J(c.macParseCursor('bogus')), { us: null, n: 0, crash: null });
    assert.strictEqual(c.macFormatCursor({ us: 1763542800123456, n: 3, crash: null }), '1763542800123456:3|c0');
    assert.deepStrictEqual(J(c.macParseCursor('0:0|c55')), { us: null, n: 0, crash: 55 });
});

test('a truncated batch with same-µs ties continues exactly where it stopped', function () {
    var c = load().ctx;
    var all = [];
    for (var i = 0; i < 1995; i++) all.push(ev(tsOf(BASE + i), { msg: 'e' + i }));
    for (var k = 0; k < 10; k++) all.push(ev(tsOf(BASE + 5000), { msg: 't' + k }));   // ten events with one µs, across the 2000 cap
    all.push(ev(tsOf(BASE + 6000), { msg: 'last' }));
    var got = [], cursor = null, rounds = 0;
    while (rounds++ < 5) {
        // `log show --start <cursor second>` re-emits everything from that second on: model it with the whole list
        var lines = all.slice(0, 2100).join('\n');
        var r = c.parseMacNdjson(lines, pc(c, { cursor: cursor }));
        r.events.forEach(function (e) { got.push(e.Message); });
        if (r.examined == 0) break;
        cursor = { us: r.lastUs, n: r.tie };
        if (rounds == 1) { assert.strictEqual(r.truncated, true); assert.strictEqual(r.events.length, 2000); assert.deepStrictEqual(J(cursor), { us: BASE + 5000, n: 5 }); }
    }
    assert.strictEqual(got.length, all.length);
    assert.strictEqual(new Set(got).size, all.length);
    assert.strictEqual(got[got.length - 1], 'last');
});

// ---------------------------------------------------------------- crash reports

test('crash reports: .ips header, panic .ips, .panic text, .crash text, delimiter parsing', function () {
    var c = load().ctx;
    var ipsHdr = '{"app_name":"Safari","timestamp":"2026-11-19 10:00:00.00 +0100","app_version":"18.1","bug_type":"309","name":"Safari"}';
    var e = J(c.macCrashEvent('Safari-2026-11-19-100000.ips', 1763546500, ipsHdr + '\n{\n  "uptime" : 1000\n}'));
    assert.deepStrictEqual(e, { LogName: 'Crash', Level: 2, MsgType: 'Crash', TimeCreated: '/Date(' + Date.UTC(2026, 10, 19, 9, 0, 0) + ')/', ProviderName: 'Safari',
        Subsystem: '', OsCategory: '', ProcessPath: '/Library/Logs/DiagnosticReports/Safari-2026-11-19-100000.ips', Id: '', Message: ipsHdr + '\n{\n  "uptime" : 1000\n}' });
    e = J(c.macCrashEvent('Kernel-2026-11-19-100000.ips', 1763546500, '{"bug_type":"210","timestamp":"2026-11-19 09:00:00.00 +0000","os_version":"macOS 15.1"}\n{}'));
    assert.strictEqual(e.Level, 1); assert.strictEqual(e.MsgType, 'Panic'); assert.strictEqual(e.ProviderName, 'kernel');
    e = J(c.macCrashEvent('panic-full-2026-11-19-100000.0002.panic', 1763546500, 'panic(cpu 0 caller 0xffffff): "Kernel trap"'));
    assert.strictEqual(e.Level, 1); assert.strictEqual(e.MsgType, 'Panic'); assert.strictEqual(e.TimeCreated, '/Date(1763546500000)/');
    e = J(c.macCrashEvent('Mail_2019-01-01-100000_mac.crash', 1546333200, 'Process:               Mail [123]\nPath:  /Applications/Mail.app\nDate/Time:  2019-01-01 10:00:00.123 +0100\n'));
    assert.strictEqual(e.ProviderName, 'Mail'); assert.strictEqual(e.TimeCreated, '/Date(' + (Date.UTC(2019, 0, 1, 9, 0, 0) + 123) + ')/'); assert.strictEqual(e.Level, 2);
    assert.strictEqual(c.macCrashName('foo.cpu_resource-2026-11-19-100000.diag'), 'foo.cpu_resource');
    var out = 'TOK 1763546500 Safari-1.ips\n{"app_name":"Safari"}\nbody\n\nTOK-END\nTOK 1763546600 my app-2.crash\nProcess: my app [1]\n\nTOK-END\nnoise\n';
    var reps = J(c.parseMacCrashOutput(out, 'TOK'));
    assert.deepStrictEqual(reps, [{ mtime: 1763546500, name: 'Safari-1.ips', content: '{"app_name":"Safari"}\nbody' }, { mtime: 1763546600, name: 'my app-2.crash', content: 'Process: my app [1]' }]);
    var sh = c.macCrashScript(100, 21, false, 'TOK');
    assert.ok(sh.indexOf("stat -f '%m %N'") > 0 && sh.indexOf("awk -v c=100 '$1 > c'") > 0 && sh.indexOf('sort -k1,1n -k2 | head -n 21') > 0 && sh.indexOf('head -c 4096 "$f"') > 0, sh);
    assert.ok(c.macCrashScript(0, 20, true, 'TOK').indexOf('sort -k1,1nr -k2') > 0);
});

// ---------------------------------------------------------------- history end to end

function macHandler(o) {
    o = o || {};
    return function (s) {
        if (s.indexOf('echo L=') >= 0) return { stdout: o.probe || PROBE_OK };
        var r = { file: (s.indexOf('log show') >= 0) ? (o.ndjson || '') : null, stdout: '', hold: o.hold };
        if (s.indexOf('DiagnosticReports') >= 0 && o.crash) { var tok = /echo "(EVLCRASH\w+) \$m/.exec(s)[1]; r.stdout = o.crash(tok); }
        if (o.onRun) o.onRun(s);
        return r;
    };
}

test('history: first run backfills 24h, sends gatherlogs with os macos and cursor; ack commits; next run starts at the cursor', async function () {
    var nowUs = Date.now() * 1000;
    var t1 = nowUs - 60e6, t2 = nowUs - 30e6;
    var nd = [ev(tsOf(t1), { msg: 'one' }), ev(tsOf(t2), { msg: 'two' }), ev(tsOf(t2), { msg: 'three' })].join('\n');   // cut: no status line
    var crashMtime = Math.floor(Date.now() / 1000) - 100;
    var s = load({ handler: macHandler({ ndjson: nd, crash: function (tok) { return tok + ' ' + crashMtime + ' App-2026.ips\n{"app_name":"App","bug_type":"309","timestamp":"' + tsOf(t1 + 5) + '"}\n\n' + tok + '-END\n'; } }) });
    s.ctx.db.Put('pluginEventLog_cfg', JSON.stringify({ historyEnabled: true, historyEntryTypes: [2, 3], uid: 'u1' }));
    s.ctx.capturePeriodicEventLog();
    await tick();
    var run = s.scripts.filter(function (x) { return x.indexOf('log show --style ndjson --last 24h') >= 0; });
    assert.strictEqual(run.length, 1, s.scripts.join('\n---\n'));
    assert.ok(run[0].indexOf("--predicate 'eventType == logEvent AND (messageType == error)'") > 0);
    assert.ok(run[0].indexOf('> /usr/local/mesh_services/meshagent/evlmout') < 0 && run[0].indexOf('> /var/tmp/evlmout') > 0, 'tmp dir: /usr/local/mesh_services missing in the sandbox, agent dir missing -> /var/tmp');
    assert.strictEqual(s.sent.length, 1);
    var g = s.sent[0];
    assert.strictEqual(g.pluginaction, 'gatherlogs'); assert.strictEqual(g.os, 'macos'); assert.strictEqual(g.uid, 'u1');
    assert.deepStrictEqual(g.caps, { log: true, ndjson: true, osver: '14.5', crashDir: true });
    var data = JSON.parse(g.data);
    assert.deepStrictEqual(data.map(function (e) { return e.Message.split('\n')[0]; }).slice(0, 3), ['one', 'two', 'three']);
    assert.strictEqual(data[3].LogName, 'Crash'); assert.strictEqual(data[3].ProviderName, 'App');
    // ndjson cut off (no status line): resume at the last event; crash listing complete: resume just before the run start
    var gc = J(s.ctx.macParseCursor(g.cursor));
    assert.strictEqual(gc.us, t2); assert.strictEqual(gc.n, 2);
    assert.ok(gc.crash >= Math.floor(Date.now() / 1000) - 3 && gc.crash > crashMtime, g.cursor);
    assert.strictEqual(s.store.pluginEventLog_mcursor, undefined, 'not committed before the ack');
    assert.deepStrictEqual(Object.keys(s.files), [], 'tmp file removed');
    // server ack (echoes the cursor)
    s.ctx.consoleaction({ pluginaction: 'setLVDOC', value: String(Math.floor(t2 / 1000)), cursor: g.cursor }, null, null, {});
    assert.strictEqual(s.store.pluginEventLog_mcursor, g.cursor);
    assert.strictEqual(s.store.pluginEventLog_jcursor, undefined); assert.strictEqual(s.store.pluginEventLog_lvdoc, undefined);
    // an older ack arriving late does not rewind
    s.ctx.consoleaction({ pluginaction: 'setLVDOC', value: '1', cursor: t1 + ':1|c5' }, null, null, {});
    assert.strictEqual(s.store.pluginEventLog_mcursor, g.cursor);
    // next run: --start from the cursor second, crash listing after the crash cursor
    s.ctx.capturePeriodicEventLog();
    await tick();
    var last = s.scripts[s.scripts.length - 1];
    assert.ok(last.indexOf('--start "' + s.ctx.macStartArg(Math.floor(t2 / 1e6)) + '"') > 0, last);
    assert.ok(last.indexOf("awk -v c=" + gc.crash + " '$1 > c'") > 0, last);
    // the same output again: everything is at or before the cursor -> nothing sent, nothing new examined
    assert.strictEqual(s.sent.length, 1);
});

test('history: zero events with a completed log show advances the cursor locally to 10 s before the run start', async function () {
    var s = load({ handler: macHandler({ ndjson: '{"evlrc":0}\n' }) });
    s.ctx.db.Put('pluginEventLog_cfg', JSON.stringify({ historyEnabled: true, historyEntryTypes: [1, 2] }));
    var before = Date.now();
    s.ctx.capturePeriodicEventLog();
    await tick();
    assert.strictEqual(s.sent.length, 0);
    var cur = s.ctx.macParseCursor(s.store.pluginEventLog_mcursor);
    assert.ok(cur.us >= (before - 10000) * 1000 && cur.us <= (Date.now() - 10000) * 1000, s.store.pluginEventLog_mcursor);
    assert.strictEqual(cur.n, 0);
    assert.ok(cur.crash >= Math.floor(before / 1000) - 1);
});

test('history: a failed log show keeps the position', async function () {
    var s = load({ handler: macHandler({ ndjson: '{"evlrc":64}\n' }) });
    s.ctx.db.Put('pluginEventLog_cfg', JSON.stringify({ historyEnabled: true, historyEntryTypes: [2] }));
    s.ctx.db.Put('pluginEventLog_mcursor', '1763542800123456:3|c1763542000');
    s.ctx.capturePeriodicEventLog();
    await tick();
    var cur = s.ctx.macParseCursor(s.store.pluginEventLog_mcursor);
    assert.strictEqual(cur.us, 1763542800123456); assert.strictEqual(cur.n, 3);
    assert.ok(cur.crash > 1763542000, 'the crash part still advances');
});

test('history: crash-only batch older than the last ack is committed locally (the server would not ack it)', async function () {
    var mt = Math.floor(Date.now() / 1000) - 10;
    var s = load({ handler: macHandler({ ndjson: '{"evlrc":0}\n', crash: function (tok) { return tok + ' ' + mt + ' X.panic\npanic(cpu 0)\n' + tok + '-END\n'; } }) });
    s.ctx.db.Put('pluginEventLog_cfg', JSON.stringify({ historyEnabled: true, historyEntryTypes: [1, 2] }));
    s.ctx.db.Put('pluginEventLog_mack', String(Date.now() + 60000));
    s.ctx.capturePeriodicEventLog();
    await tick();
    assert.strictEqual(s.sent.length, 1);
    assert.strictEqual(JSON.parse(s.sent[0].data)[0].MsgType, 'Panic');
    assert.strictEqual(s.store.pluginEventLog_mcursor, s.sent[0].cursor);
});

test('history: more than 20 crash reports -> oldest 20, cut before an mtime tie', async function () {
    var base = Math.floor(Date.now() / 1000) - 5000;
    var s = load({ handler: macHandler({ ndjson: '{"evlrc":0}\n', crash: function (tok) {
        var o = '';
        for (var i = 0; i < 21; i++) { var m = base + ((i >= 18) ? 18 : i); o += tok + ' ' + m + ' R' + i + '.crash\nProcess: R' + i + ' [1]\n\n' + tok + '-END\n'; }
        return o;
    } }) });
    s.ctx.db.Put('pluginEventLog_cfg', JSON.stringify({ historyEnabled: true, historyEntryTypes: [2] }));
    s.ctx.capturePeriodicEventLog();
    await tick();
    var data = JSON.parse(s.sent[0].data);
    assert.strictEqual(data.length, 18);   // R18..R20 share an mtime: they all go into the next run
    assert.ok(/\|c/.test(s.sent[0].cursor) && s.ctx.macParseCursor(s.sent[0].cursor).crash == base + 17, s.sent[0].cursor);
});

test('history: overlap guard - no second run while one is in flight; stale after 5 minutes', async function () {
    var s = load({ handler: macHandler({ ndjson: '{"evlrc":0}\n', hold: true }) });
    s.ctx.db.Put('pluginEventLog_cfg', JSON.stringify({ historyEnabled: true, historyEntryTypes: [2] }));
    var runs = function () { return s.scripts.filter(function (x) { return x.indexOf('echo L=') < 0 && x.indexOf('| head -n 2100') > 0; }).length; };
    s.ctx.capturePeriodicEventLog();
    await tick();   // the probe is answered at once, the collector run is held
    assert.strictEqual(runs(), 1);
    assert.strictEqual(s.held.length, 1);
    s.ctx.capturePeriodicEventLog();
    s.ctx.consoleaction({ pluginaction: 'collectnow' }, null, null, {});
    await tick();
    assert.strictEqual(runs(), 1, 'second and third run skipped while the first is in flight');
    // live requests still run alongside
    s.ctx.consoleaction({ pluginaction: 'getlivelogs', num: 10 }, null, null, { write: function () { } });
    await tick();
    assert.ok(s.scripts.some(function (x) { return x.indexOf('| tail -n 60') > 0; }));
    // stale flag: a run started > 5 min ago no longer blocks
    s.ctx.macHistRunning = Date.now() - 6 * 60 * 1000;
    s.ctx.capturePeriodicEventLog();
    await tick();
    assert.strictEqual(runs(), 2);
    // the stale run finishing late does not clear the newer run's flag
    var newer = s.ctx.macHistRunning;
    s.held.shift()();
    await tick();
    assert.strictEqual(s.ctx.macHistRunning, newer);
    while (s.held.length) s.held.shift()();
    await tick();
    assert.strictEqual(s.ctx.macHistRunning, 0);
});

// ---------------------------------------------------------------- live view and console commands

test('live: reply shape, newest first, num cap, since window', async function () {
    var nowUs = Date.now() * 1000;
    var lines = []; for (var i = 0; i < 8; i++) lines.push(ev(tsOf(nowUs - (8 - i) * 1e6), { msg: 'L' + i }));
    lines.push('{"evlrc":0}');
    var s = load({ handler: macHandler({ ndjson: lines.join('\n') }) });
    s.ctx.db.Put('pluginEventLog_cfg', JSON.stringify({ uid: 'u9', liveEntryTypes: [2, 3] }));
    var replies = [];
    var con = { write: function (b) { replies.push(JSON.parse(b.toString())); } };
    s.ctx.consoleaction({ pluginaction: 'getlivelogs', num: 5 }, null, null, con);
    await tick();
    assert.strictEqual(replies.length, 1);
    var r = replies[0];
    assert.strictEqual(r.os, 'macos'); assert.strictEqual(r.uid, 'u9'); assert.strictEqual(r.caps.ndjson, true);
    assert.deepStrictEqual(r.data.map(function (e) { return e.Message; }), ['L7', 'L6', 'L5', 'L4', 'L3']);
    var cmd = s.scripts.filter(function (x) { return x.indexOf('log show') >= 0 && x.indexOf('echo L=') < 0; })[0];
    assert.ok(cmd.indexOf('--last 60m --predicate \'eventType == logEvent AND (messageType == error)\'') > 0 && cmd.indexOf('| tail -n 55 |') > 0, cmd);
    assert.ok(cmd.indexOf('DiagnosticReports') > 0, 'All includes crash reports');
    // since: events up to `since` are not repeated, --start from since+1
    var since = Math.floor((nowUs - 3e6) / 1e6);
    s.ctx.consoleaction({ pluginaction: 'getlivelogs', num: 50, since: since, lsel: 'kernel' }, null, null, con);
    await tick();
    cmd = s.scripts[s.scripts.length - 1];
    assert.ok(cmd.indexOf('--start "' + s.ctx.macStartArg(since + 1) + '"') > 0 && cmd.indexOf('process == "kernel"') > 0 && cmd.indexOf('DiagnosticReports') < 0, cmd);
    assert.ok(replies[1].data.every(function (e) { return Number(/\d+/.exec(e.TimeCreated)[0]) >= (since + 1) * 1000; }));
});

test('live: log missing / ndjson unsupported -> one explanatory event; crash selector', async function () {
    var replies = [], con = { write: function (b) { replies.push(JSON.parse(b.toString())); } };
    var s = load({ handler: macHandler({ probe: 'L=0\nV=10.11\nJ=0\nC=1\n' }) });
    s.ctx.consoleaction({ pluginaction: 'getlivelogs' }, null, null, con);
    await tick();
    assert.strictEqual(replies[0].data.length, 1);
    assert.match(replies[0].data[0].Message, /\/usr\/bin\/log\) was not found/);
    s = load({ handler: macHandler({ probe: 'L=1\nV=10.14.6\nJ=0\nC=1\n', crash: function (tok) { return tok + ' 1763546500 A-1.ips\n{"app_name":"A"}\n' + tok + '-END\n'; } }) });
    s.ctx.consoleaction({ pluginaction: 'getlivelogs' }, null, null, con);
    await tick();
    assert.match(replies[1].data[0].Message, /macOS 10\.14\.6\) does not support "log show --style ndjson"/);
    assert.ok(!s.scripts.some(function (x) { return x.indexOf('log show --style ndjson --') >= 0 && x.indexOf('echo L=') < 0; }));
    // crash reports only: works without ndjson
    s.ctx.consoleaction({ pluginaction: 'getlivelogs', lsel: 'crash' }, null, null, con);
    await tick();
    assert.strictEqual(replies[2].data.length, 1); assert.strictEqual(replies[2].data[0].LogName, 'Crash'); assert.strictEqual(replies[2].data[0].ProviderName, 'A');
    assert.ok(s.scripts[s.scripts.length - 1].indexOf("awk -v c=0 '$1 > c'") > 0);
});

test('console commands on macOS; setConfigBlob re-probes', async function () {
    var s = load({ handler: macHandler() });
    assert.strictEqual(s.ctx.consoleaction({ _: ['', 'getlog'] }, null, 1, {}), 'On macOS endpoints, use the Event Log tab on the device page.');
    assert.strictEqual(s.ctx.consoleaction({ _: ['', 'sendlog'] }, null, 1, {}), 'On macOS endpoints, use the Event Log tab on the device page.');
    s.ctx.consoleaction({ pluginaction: 'serviceCheck' }, null, null, {});
    await tick();
    assert.strictEqual(s.scripts.filter(function (x) { return x.indexOf('echo L=') >= 0; }).length, 1);
    s.ctx.consoleaction({ pluginaction: 'setConfigBlob', cfg: '{"historyEnabled":true}' }, null, null, {});
    await tick();
    assert.strictEqual(s.scripts.filter(function (x) { return x.indexOf('echo L=') >= 0; }).length, 2);
    assert.ok(!s.scripts.some(function (x) { return /powershell/i.test(x); }));
    assert.strictEqual(s.store.pluginEventLog_cfg, '{"historyEnabled":true}');
    s.ctx.consoleaction({ pluginaction: 'setLVDOC', value: '1763546500123' }, null, null, {});   // no cursor (older server): fallback only
    assert.strictEqual(s.store.pluginEventLog_lvdoc_mac, '1763546500123');
    assert.strictEqual(s.store.pluginEventLog_lvdoc, undefined);
});

// ---------------------------------------------------------------- other platforms unchanged

test('smoke: Linux sandbox behaves as before', async function () {
    var s = load({ platform: 'linux', handler: function (sc) { if (sc.indexOf('journalctl --version') >= 0) return { stdout: 'systemd 255 (255.4)\nP=1\nA=0\nD=1\n' }; return { file: '' }; } });
    assert.strictEqual(s.ctx.PLAT, 'linux');
    assert.strictEqual(s.ctx.consoleaction({ _: ['', 'getlog'] }, null, 1, {}), 'On Linux endpoints, use the Event Log tab on the device page.');
    s.ctx.db.Put('pluginEventLog_cfg', JSON.stringify({ historyEnabled: true, historyEntryTypes: [2, 3] }));
    s.ctx.capturePeriodicEventLog();
    await tick();
    assert.ok(s.scripts.some(function (x) { return x.indexOf('journalctl --no-pager -o json') == 0 && x.indexOf('--since "-24h"') > 0 && x.indexOf('> /var/tmp/evljout') > 0; }), s.scripts.join('\n'));
    assert.ok(!s.scripts.some(function (x) { return x.indexOf('/usr/bin/log') >= 0; }));
    s.ctx.consoleaction({ pluginaction: 'setLVDOC', value: '1763546500123', cursor: 's=abc' }, null, null, {});
    assert.strictEqual(s.store.pluginEventLog_jcursor, 's=abc');
    assert.strictEqual(s.store.pluginEventLog_lvdoc_lx, '1763546501');
    assert.strictEqual(s.store.pluginEventLog_mcursor, undefined);
});

test('smoke: Windows sandbox behaves as before; other platforms rejected', async function () {
    var s = load({ platform: 'win32' });
    assert.strictEqual(s.ctx.PLAT, 'win32');
    s.ctx.db.Put('pluginEventLog_cfg', JSON.stringify({ historyEnabled: true, historyLogs: 'Application,System', historyEntryTypes: [2, 3] }));
    s.ctx.consoleaction({ pluginaction: 'setLVDOC', value: '1763546500123' }, null, null, {});
    assert.strictEqual(s.store.pluginEventLog_lvdoc, String(1763546500 - new Date().getTimezoneOffset() * 60 + 2));
    assert.strictEqual(s.store.pluginEventLog_mcursor, undefined);
    s = load({ platform: 'freebsd' });
    assert.strictEqual(s.ctx.PLAT, null);
    assert.strictEqual(s.ctx.consoleaction({ _: ['', 'getlog'] }, null, 1, {}), 'Eventlog is only available on Windows, Linux and macOS endpoints.');
});
