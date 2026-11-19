'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../../ai/groups.js');

test('mask replaces variable parts', function () {
    assert.strictEqual(G.mask('The bugcheck was: 0x0000009f (0x0000000000000003, 0xffffc40c2fd6d060). Report Id: 6b3f0f6a-61b2-4f8c-a5a9-2d1a4e0d1c11.'),
        'The bugcheck was: <*> (<*>, <*>). Report Id: <*>.');
    assert.strictEqual(G.mask('Connection from 10.1.2.3:443 and fe80::1c2b:3c4d:5e6f:7a8b%12 closed'), 'Connection from <*> and <*> closed');
    assert.strictEqual(G.mask('A dump was saved in: C:\\Windows\\MEMORY.DMP. Next'), 'A dump was saved in: <*> Next');
    assert.strictEqual(G.mask('open /var/log/syslog failed: status=1/FAILURE'), 'open <*> failed: status=1/FAILURE');
    assert.strictEqual(G.mask('The "Print Spooler" service took 30000 ms (pid 1234, x 7)'), 'The <*> service took <*> ms (pid <*>, x 7)');
    assert.strictEqual(G.mask("unit 'foo.service' hash deadbeef01234567 done"), 'unit <*> hash <*> done');
    assert.strictEqual(G.mask('  a \r\n\t b  '), 'a b');
    assert.strictEqual(G.mask('Microsoft-Windows-Kernel-Power started'), 'Microsoft-Windows-Kernel-Power started');
    assert.strictEqual(G.mask('x'.repeat(500)).length, 160);
    assert.strictEqual(G.mask(null), '');
    assert.strictEqual(G.mask(12345), '<*>');
});

test('Windows grouping by provider|id; severity first, then count', function () {
    const ev = [];
    let n = 0;
    const add = (src, id, lvl, tc, msg) => ev.push({ _id: 'r' + (++n), tc: tc, LogName: 'System', Level: lvl, ProviderName: src, Id: id, Message: msg || 'm ' + n });
    for (let i = 0; i < 5; i++) add('Service Control Manager', 7036, 4, 1000 + i);
    for (let i = 0; i < 2; i++) add('disk', 7, 3, 2000 + i);
    add('Microsoft-Windows-Kernel-Power', 41, 1, 3000);
    for (let i = 0; i < 3; i++) add('Service Control Manager', 7031, 2, 4000 + i);
    add('EventLog', 6005, 0, 5000);   // Level 0 = information
    add('disk', 7, 3, 1500);
    const g = G.groupEvents(ev, { samples: 2 });
    assert.deepStrictEqual(g.map((x) => x.key), [
        'Microsoft-Windows-Kernel-Power|41', 'Service Control Manager|7031', 'disk|7', 'Service Control Manager|7036', 'EventLog|6005']);
    const disk = g[2];
    assert.strictEqual(disk.count, 3);
    assert.strictEqual(disk.first, 1500);
    assert.strictEqual(disk.last, 2001);
    assert.strictEqual(disk.level, 3);
    assert.strictEqual(disk.log, 'System');
    assert.strictEqual(disk.src, 'disk');
    assert.strictEqual(disk.id, 7);
    assert.deepStrictEqual(disk.sampleIds, ['r7', 'r6']);   // newest first
    assert.strictEqual(g[4].level, 4);
    assert.strictEqual(G.groupEvents(ev, { top: 2 }).length, 2);
    assert.deepStrictEqual(G.groupEvents(ev, { samples: 0 })[0].sampleIds, []);
});

test('Linux grouping by unit|src|masked message', function () {
    const ev = [
        { _id: 'a', tc: 1, Level: 2, Priority: 3, Unit: 'nginx.service', ProviderName: 'systemd', Id: '1', Message: 'nginx.service: Main process exited, code=exited, status=1/FAILURE' },
        { _id: 'b', tc: 2, Level: 2, Priority: 3, Unit: 'nginx.service', ProviderName: 'systemd', Id: '1', Message: 'nginx.service: Main process exited, code=exited, status=1/FAILURE' },
        { _id: 'c', tc: 3, Level: 4, Unit: 'sshd.service', ProviderName: 'sshd', Id: '2201', Message: 'Accepted publickey for bob from 10.0.0.5 port 50022 ssh2' },
        { _id: 'd', tc: 4, Level: 4, Unit: 'sshd.service', ProviderName: 'sshd', Id: '2299', Message: 'Accepted publickey for bob from 10.0.0.9 port 51234 ssh2' }
    ];
    const g = G.groupEvents(ev, {});
    assert.strictEqual(g.length, 2);
    assert.strictEqual(g[0].unit, 'nginx.service');
    assert.strictEqual(g[0].count, 2);
    assert.strictEqual(g[1].count, 2);   // different PIDs (Id) but same template
    assert.strictEqual(g[1].key, 'sshd.service|sshd|Accepted publickey for bob from <*> port <*> ssh2');
    assert.strictEqual(g[1].template, 'Accepted publickey for bob from <*> port <*> ssh2');
    // os: 'linux' forces template keys even without Unit
    assert.strictEqual(G.groupEvents([{ _id: 'x', tc: 1, Level: 4, ProviderName: 'kernel', Id: '0', Message: 'usb 1-1: new device 1234' }], { os: 'linux' })[0].key,
        '|kernel|usb 1-1: new device <*>');
});

test('bad input is tolerated', function () {
    assert.deepStrictEqual(G.groupEvents(null), []);
    assert.deepStrictEqual(G.groupEvents([null, 5, 'x']), []);
    const g = G.groupEvents([{}], {});
    assert.strictEqual(g.length, 1);
    assert.strictEqual(g[0].level, 4);
});

test('macOS grouping by subsystem|process|masked message; the PID (Id) is not part of the key', function () {
    const ev = [
        { _id: 'a', tc: 1, Level: 2, MsgType: 'Error', LogName: 'System', Subsystem: 'com.apple.xpc', OsCategory: 'connection', ProviderName: 'launchd', Id: '1', Message: 'Service exited with abnormal code: 78' },
        { _id: 'b', tc: 5, Level: 2, MsgType: 'Error', LogName: 'System', Subsystem: 'com.apple.xpc', OsCategory: 'connection', ProviderName: 'launchd', Id: '1', Message: 'Service exited with abnormal code: 15' },
        { _id: 'c', tc: 3, Level: 4, MsgType: 'Default', LogName: 'Auth', Subsystem: '', ProviderName: 'sshd', Id: '812', Message: 'Accepted publickey for bob from 10.0.0.5 port 50022 ssh2' },
        { _id: 'd', tc: 4, Level: 4, MsgType: 'Default', LogName: 'Auth', Subsystem: '', ProviderName: 'sshd', Id: '944', Message: 'Accepted publickey for bob from 10.0.0.9 port 51234 ssh2' }
    ];
    for (const os of ['macos', undefined]) {   // the device's OS, or told by the records' Subsystem / MsgType
        const g = G.groupEvents(ev, { os: os });
        assert.strictEqual(g.length, 2, String(os));
        assert.strictEqual(g[0].key, 'com.apple.xpc|launchd|Service exited with abnormal code: <*>');
        assert.deepStrictEqual([g[0].count, g[0].subsystem, g[0].unit, g[0].first, g[0].last, g[0].sampleIds], [2, 'com.apple.xpc', '', 1, 5, ['b', 'a']]);
        assert.strictEqual(g[1].key, '|sshd|Accepted publickey for bob from <*> port <*> ssh2');
        assert.strictEqual(g[1].count, 2, 'different PIDs, same template');
    }
    // os: 'macos' forces template keys even without the macOS fields (an SQL database keeps only known columns)
    assert.strictEqual(G.groupEvents([{ _id: 'x', tc: 1, Level: 4, ProviderName: 'kernel', Id: '0', Message: 'AppleUSBHostPort: port 3 connected 12' }], { os: 'macos' })[0].key,
        '|kernel|AppleUSBHostPort: port 3 connected <*>');
    // Windows records keep provider|id
    assert.strictEqual(G.groupEvents([{ _id: 'w', tc: 1, Level: 2, ProviderName: 'disk', Id: 7, Message: 'bad block' }], {})[0].subsystem, '');
});
