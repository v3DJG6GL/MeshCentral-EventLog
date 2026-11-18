'use strict';
var test = require('node:test');
var assert = require('node:assert');
var auditCsv = require('../admin.js').auditCsv;

var HEADER = 'time,user,device,endpoint,model,mode,steps,rounds,bytesSent,redacted,tokensIn,tokensOut,durationMs,result,error';

function lines(csv) { assert.ok(csv.endsWith('\r\n')); return csv.slice(0, -2).split('\r\n'); }

test('header only for no rows or bad input', function () {
    assert.deepStrictEqual(lines(auditCsv([])), [HEADER]);
    assert.deepStrictEqual(lines(auditCsv(null)), [HEADER]);
    assert.deepStrictEqual(lines(auditCsv([null, 5, 'x'])), [HEADER]);
});

test('one row: ISO time, names before ids, step and redaction counts', function () {
    var t = Date.UTC(2026, 10, 18, 9, 30, 0);
    var csv = auditCsv([{
        time: t, username: 'alice', userid: 'user/d/alice', nodename: 'PC-1', nodeid: 'node/d/x',
        endpointName: 'Local Ollama', model: 'qwen3:8b', mode: 'ask', steps: [{}, {}, {}], rounds: 2,
        bytesSent: 12345, redactionCounts: { ips: 2, users: 1, bad: 'x' }, tokensIn: 900, tokensOut: 120,
        durationMs: 4567, result: 'ok', error: null
    }]);
    assert.deepStrictEqual(lines(csv), [HEADER, '2026-11-18T09:30:00.000Z,alice,PC-1,Local Ollama,qwen3:8b,ask,3,2,12345,3,900,120,4567,ok,']);
});

test('falls back to ids; numeric steps; string and Date times', function () {
    var l = lines(auditCsv([
        { time: '2026-01-02T03:04:05Z', userid: 'user/d/bob', nodeid: 'node/d/y', steps: 4 },
        { time: new Date(0) },
        { time: 'not a time' }
    ]));
    assert.strictEqual(l[1], '2026-01-02T03:04:05.000Z,user/d/bob,node/d/y,,,,4,,,,,,,,');
    assert.strictEqual(l[2].split(',')[0], '1970-01-01T00:00:00.000Z');
    assert.strictEqual(l[3].split(',')[0], '');
});

test('RFC 4180 quoting of commas, quotes and line breaks', function () {
    var l = auditCsv([{ username: 'Smith, John', nodename: 'say "hi"', error: 'line1\nline2', result: 'a\r\nb' }]);
    assert.ok(l.indexOf('"Smith, John","say ""hi"""') > 0);
    assert.ok(l.indexOf('"a\r\nb","line1\nline2"\r\n') > 0);
});

test('spreadsheet formulas are neutralised', function () {
    ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx', '＝1+1'].forEach(function (v) {
        var cell = auditCsv([{ username: v }]).split('\r\n')[1].split(',')[1];
        var unq = (cell.charAt(0) == '"') ? cell.slice(1, -1) : cell;
        assert.strictEqual(unq, "'" + v, JSON.stringify(v));
    });
    // a formula that also needs quoting: prefix inside the quotes
    var row = auditCsv([{ error: '=HYPERLINK("http://x","y")' }]).split('\r\n')[1];
    assert.ok(row.endsWith(',"\'=HYPERLINK(""http://x"",""y"")"'));
    // harmless text and numbers are left alone
    assert.strictEqual(auditCsv([{ username: 'a=b' }]).split('\r\n')[1].split(',')[1], 'a=b');
});

test('settings records: mode "settings" and the changed fields as the result', function () {
    var l = lines(auditCsv([{ time: 0, kind: 'settings', counted: false, username: 'admin', changed: ['prompts.base', 'extraInstructions'] }]));
    assert.strictEqual(l[1], '1970-01-01T00:00:00.000Z,admin,,,,settings,,,,,,,,changed: prompts.base extraInstructions,');
});
