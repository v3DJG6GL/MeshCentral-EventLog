'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../../ai/redact.js');

const SEEDS = { hosts: ['PC01'], domains: ['corp.local', 'CORP'], users: ['CORP\\jsmith'] };
const LOGON = 'An account was successfully logged on.\r\n\r\nSubject:\r\n\tSecurity ID:\t\tS-1-5-18\r\n\tAccount Name:\t\tPC01$\r\n' +
    '\tAccount Domain:\t\tCORP\r\n\tLogon ID:\t\t0x3E7\r\n\r\nLogon Type:\t\t\t3\r\n\r\nNew Logon:\r\n' +
    '\tSecurity ID:\t\tS-1-5-21-1004336348-1177238915-682003330-1001\r\n\tAccount Name:\t\tbob\r\n\tAccount Domain:\t\tCORP\r\n' +
    '\tWorkstation Name:\tLAPTOP7\r\n\tSource Network Address:\t10.1.2.3\r\n\tElevated Token:\t\tYes';

test('Windows logon event: accounts, domain, SID, workstation, IP replaced; structure kept', function () {
    const r = R.create({ seeds: SEEDS });
    const o = r.redact(LOGON);
    assert.match(o, /Account Name:\t\tHOST_1\$/);
    assert.match(o, /Account Domain:\t\tDOMAIN_\d/);
    assert.match(o, /Security ID:\t\tS-1-5-18/);          // well-known SID kept
    assert.match(o, /Security ID:\t\tSID_1/);
    assert.match(o, /Account Name:\t\tUSER_1/);
    assert.match(o, /Workstation Name:\tHOST_2/);
    assert.match(o, /Source Network Address:\tIP_1/);
    assert.match(o, /Elevated Token:\t\tYes/);
    assert.match(o, /Logon ID:\t\t0x3E7/);
    for (const v of ['PC01', 'bob', 'CORP', 'LAPTOP7', '10.1.2.3', '1004336348']) assert.ok(!o.includes(v), v + ' leaked');
    assert.strictEqual(r.restore(o), LOGON);
});

test('deterministic numbering, case-insensitive for hosts/users/domains/emails', function () {
    const r = R.create({ seeds: { hosts: ['PC01'] } });
    assert.strictEqual(r.redact('PC01 pc01 Pc01'), 'HOST_1 HOST_1 HOST_1');
    assert.strictEqual(r.redact('user=alice user=Alice user=carol'), 'user=USER_1 user=USER_1 user=USER_2');
    assert.strictEqual(r.redact('a@x.com A@X.COM'), 'EMAIL_1 EMAIL_1');
    assert.strictEqual(r.redact('10.0.0.5 then 10.0.0.6 then 10.0.0.5'), 'IP_1 then IP_2 then IP_1');
    const r2 = R.create({ seeds: { hosts: ['PC01'] } });
    assert.strictEqual(r2.redact('PC01 pc01 Pc01'), 'HOST_1 HOST_1 HOST_1');
    assert.deepStrictEqual(r.counts(), { users: 2, hosts: 1, domains: 0, ips: 2, macs: 0, emails: 1, sids: 0, secrets: 0, serials: 0 });
    assert.strictEqual(r.total(), 6);
});

test('secrets: keyword forms, quoted, Bearer, JWT, AWS key; restore gives [secret]', function () {
    const r = R.create({});
    const s = 'password=hunter2 pwd: "s3cr3t!!" api_key=\'abcd1234efgh\' client_secret=zzzzzz Authorization: Bearer abcdefgh12345678 ' +
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl key AKIAABCDEFGHIJKLMNOP token 0123456789abcdef0123456789abcdef01';
    const o = r.redact(s);
    for (const v of ['hunter2', 's3cr3t', 'abcd1234efgh', 'zzzzzz', 'abcdefgh12345678', 'eyJhbGci', 'AKIAABCDEFGHIJKLMNOP', '0123456789abcdef0123']) {
        assert.ok(!o.includes(v), v + ' leaked: ' + o);
    }
    assert.match(o, /password=SECRET_\d/);
    assert.match(o, /pwd: "SECRET_\d"/);
    assert.match(o, /Authorization: Bearer SECRET_\d/);
    assert.ok(!r.restore(o).includes('hunter2'));
    assert.match(r.restore(o), /password=\[secret\]/);
    assert.strictEqual(r.restore('SECRET_1', { mark: true }), '\uE002secret\uE003[secret]\uE004');
});

test('secret look-alikes that are not secrets stay', function () {
    const r = R.create({});
    for (const s of ['Elevated Token:\t\tYes', 'Token Elevation Type:\t\t%%1936', 'Password Last Set:\t%%1794',
        'sudo: root : TTY=pts/0 ; PWD=/root ; USER=root ; COMMAND=/bin/ls', 'Failure Reason:\t\tUnknown user name or bad password.']) {
        assert.strictEqual(r.redact(s), s);
    }
    assert.strictEqual(r.counts().secrets, 0);
});

test('restore with marks; unknown tokens and pre-existing token-like text', function () {
    const r = R.create({ seeds: { hosts: ['PC01'] } });
    const input = 'HOST_1 in log text, PC01 real, USER_7 too';
    const o = r.redact(input);
    assert.strictEqual(o, 'HOST\u20171 in log text, HOST_1 real, USER\u20177 too');
    assert.strictEqual(r.restore(o), input);
    assert.strictEqual(r.restore(o, { mark: true }), 'HOST_1 in log text, \uE002host\uE003PC01\uE004 real, USER_7 too');
    assert.strictEqual(r.restore('HOST_9 and xHOST_1 and HOST_1x and _HOST_1'), 'HOST_9 and xHOST_1 and HOST_1x and _HOST_1');
    // the model echoing the escaped form gets the original back, not a real value
    assert.strictEqual(r.restore('HOST\u20171'), 'HOST_1');
});

test('streaming restorer: every split point of a sample matches restore()', function () {
    const r = R.create({ seeds: { hosts: ['PC01', 'SRV-DB'], users: ['jsmith'] } });
    const red = r.redact('PC01 talked to SRV-DB as jsmith from 10.0.0.1 and 10.0.0.2 and 10.0.0.3 and 10.0.0.4 ' +
        '10.0.0.5 10.0.0.6 10.0.0.7 10.0.0.8 10.0.0.9 10.0.0.10 10.0.0.11 10.0.0.12 password=x1y2z3 HOST_1');
    const text = 'On ' + red.split(' ').slice(0, 3).join(' ') + ' (HOST_2), USER_1 at IP_12: IP_1. HOS HOST HOST_ HOST_99 SECRET_1' +
        ' and ' + red;
    for (const mark of [false, true]) {
        const expected = r.restore(text, { mark: mark });
        for (let i = 0; i <= text.length; i++) {
            const st = r.restorer({ mark: mark });
            const got = st.push(text.slice(0, i)) + st.push(text.slice(i)) + st.flush();
            assert.strictEqual(got, expected, 'split at ' + i);
        }
        // three-way splits
        for (let i = 0; i < text.length; i += 3) {
            for (let j = i; j <= text.length; j += 5) {
                const st = r.restorer({ mark: mark });
                const got = st.push(text.slice(0, i)) + st.push(text.slice(i, j)) + st.push(text.slice(j)) + st.flush();
                assert.strictEqual(got, expected, 'split at ' + i + ',' + j);
            }
        }
        // char by char
        const st = r.restorer({ mark: mark });
        let got = '';
        for (const ch of text) got += st.push(ch);
        assert.strictEqual(got + st.flush(), expected);
    }
});

test('restorer holds back HOST_1 that could still grow into HOST_12', function () {
    const r = R.create({});
    for (let i = 1; i <= 12; i++) r.redact('10.9.9.' + i);
    const st = r.restorer({});
    assert.strictEqual(st.push('at IP_1'), 'at ');
    assert.strictEqual(st.push('2 now'), '10.9.9.12 now');
    assert.strictEqual(st.push(' IP_1'), ' ');
    assert.strictEqual(st.flush(), '10.9.9.1');
});

test('DOMAIN\\user, well-known accounts and registry paths', function () {
    const r = R.create({});
    assert.strictEqual(r.redact('NT AUTHORITY\\SYSTEM NT AUTHORITY\\LOCAL SERVICE BUILTIN\\Administrators Window Manager\\DWM-1 Font Driver Host\\UMFD-0'),
        'NT AUTHORITY\\SYSTEM NT AUTHORITY\\LOCAL SERVICE BUILTIN\\Administrators Window Manager\\DWM-1 Font Driver Host\\UMFD-0');
    assert.strictEqual(r.redact('HKLM\\SOFTWARE\\Microsoft\\Windows HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\x'),
        'HKLM\\SOFTWARE\\Microsoft\\Windows HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\x');
    assert.strictEqual(r.redact('by ACME\\mary'), 'by DOMAIN_1\\USER_1');
    assert.strictEqual(r.redact('ACME\\Administrator'), 'DOMAIN_1\\Administrator');   // Administrator kept literal
    assert.strictEqual(r.redact('AzureAD\\JohnDoe'), 'AzureAD\\USER_2');
    assert.strictEqual(r.redact('ACME\\J\u00fcrgen.M\u00fcller logged on'), 'DOMAIN_1\\USER_3 logged on');
});

test('Linux auth lines', function () {
    const r = R.create({});
    assert.strictEqual(r.redact('Failed password for invalid user admin from 203.0.113.9 port 51234 ssh2'),
        'Failed password for invalid user USER_1 from IP_1 port 51234 ssh2');
    assert.strictEqual(r.redact('Accepted publickey for bob from 192.168.1.20 port 5555 ssh2'), 'Accepted publickey for USER_2 from IP_2 port 5555 ssh2');
    assert.strictEqual(r.redact('pam_unix(sudo:session): session opened for user root(uid=0) by bob(uid=1000)'),
        'pam_unix(sudo:session): session opened for user root(uid=0) by USER_2(uid=1000)');
    assert.strictEqual(r.redact('sudo:      bob : TTY=pts/0 ; PWD=/home/bob ; USER=root ; COMMAND=/usr/bin/ls'),
        'sudo:      USER_2 : TTY=pts/0 ; PWD=/home/USER_2 ; USER=root ; COMMAND=/usr/bin/ls');
    assert.strictEqual(r.redact('pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.9  user=carol'),
        'pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=IP_1  user=USER_3');
});

test('paths, seeded FQDNs and emails', function () {
    const r = R.create({ seeds: SEEDS });
    const s = 'C:\\Users\\John Smith\\Desktop\\x.txt C:\\Users\\Public\\x /home/alice/.bashrc pc01.corp.local srv9.corp.local mail bob@corp.local';
    const o = r.redact(s);
    assert.strictEqual(o, 'C:\\Users\\USER_1\\Desktop\\x.txt C:\\Users\\Public\\x /home/USER_2/.bashrc HOST_1.DOMAIN_1 HOST_2.DOMAIN_1 mail EMAIL_1');
    assert.strictEqual(r.restore('HOST_2.DOMAIN_1'), 'srv9.corp.local');
});

test('MACs and IPs: keeps loopback, broadcast, netmasks, version numbers', function () {
    const r = R.create({});
    assert.strictEqual(r.redact('aa:bb:cc:dd:ee:ff AA-BB-CC-DD-EE-01 00:00:00:00:00:00 ff:ff:ff:ff:ff:ff'), 'MAC_1 MAC_2 00:00:00:00:00:00 ff:ff:ff:ff:ff:ff');
    assert.strictEqual(r.redact('127.0.0.1 0.0.0.0 255.255.255.255 255.255.255.0 ::1 :: fe80::1c2b:3c4d:5e6f:7a8b%12 ::ffff:192.168.0.10.'),
        '127.0.0.1 0.0.0.0 255.255.255.255 255.255.255.0 ::1 :: IP_1 IP_2.');
    assert.strictEqual(r.redact('2001:db8::8a2e:370:7334 and 192.168.0.10:443'), 'IP_3 and IP_4:443');
});

const NO_CHANGE = [
    'The system has rebooted without cleanly shutting down first. This error could be caused if the system stopped responding, crashed, or lost power unexpectedly.',
    'Microsoft-Windows-Kernel-Power: BugcheckCode 159 BugcheckParameter1 0x3 PowerButtonTimestamp 0',
    'The computer has rebooted from a bugcheck.  The bugcheck was: 0x0000009f (0x0000000000000003, 0xffffc40c2fd6d060, 0xfffff8065f467750, 0xffffc40c3a4c1010). A dump was saved in: C:\\Windows\\MEMORY.DMP. Report Id: 6b3f0f6a-61b2-4f8c-a5a9-2d1a4e0d1c11.',
    'Faulting application name: chrome.exe, version: 120.0.6099.130, time stamp: 0x6578a2b9\r\nFaulting module name: ntdll.dll, version: 10.0.22621.2506, time stamp: 0x8a6b1c34\r\nException code: 0xc0000005\r\nFault offset: 0x00000000000a1b2c\r\nFaulting process id: 0x1f3c',
    'The Windows Update service entered the stopped state.',
    'The start type of the Background Intelligent Transfer Service service was changed from auto start to demand start.',
    'Installation Successful: Windows successfully installed the following update: 2024-01 Cumulative Update for Windows 11 Version 23H2 for x64-based Systems (KB5034123)',
    'The application-specific permission settings do not grant Local Activation permission for the COM Server application with CLSID {2593F8B9-4EAF-457C-B68A-50F6B8EA6B54} and APPID {15C20B67-12E7-4BB6-92BB-7AFF07997402} to the user NT AUTHORITY\\SYSTEM SID (S-1-5-18) from address LocalHost (Using LRPC) running in the application container Unavailable SID (Unavailable).',
    'The device, \\Device\\Harddisk0\\DR0, has a bad block.',
    'Reset to device, \\Device\\RaidPort0, was issued.',
    'Name resolution for the name wpad timed out after none of the configured DNS servers responded.',
    'A fatal alert was generated and sent to the remote endpoint. This may result in termination of the connection. The TLS protocol defined fatal error code is 40. The Windows SChannel error state is 1205.',
    'The operating system started at system time 2024-05-01T08:00:01.500000000Z.',
    'Started user@1000.service - User Manager for UID 1000.',
    'systemd[1]: nginx.service: Main process exited, code=exited, status=1/FAILURE',
    'kernel: Out of memory: Killed process 1234 (java) total-vm:8123456kB, anon-rss:4000000kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:9000kB oom_score_adj:0',
    'kernel: myapp[4321]: segfault at 0 ip 00007f3a2b1c4d5e sp 00007ffd1a2b3c40 error 4 in libc.so.6[7f3a2b000000+195000]',
    'kernel: blk_update_request: I/O error, dev sda, sector 123456 op 0x0:(READ) flags 0x0 phys_seg 1 prio class 0',
    'kernel: EXT4-fs error (device sda1): ext4_find_entry:1455: inode #2: comm ls: reading directory lblock 0',
    'Volume Shadow Copy Service error: Unexpected error DeviceIoControl(\\\\?\\Volume{0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0} - 0000000000000134,0x0053c008,0000000000000000,0,000001E2F5A1B2C0,4096,[0]).  hr = 0x80070057, The parameter is incorrect.',
    'Windows 10.0.22631.4460 build; driver version 31.0.101.2111; file version 6.1.7601.24546',
    'The Group Policy Client service failed the sign-in. The universal unique identifier (UUID) type is not supported.',
    'Session 2 of user root.'
];

test('no false positives on typical Windows/Linux event messages', function () {
    const r = R.create({ seeds: { hosts: ['PC01'], domains: ['corp.local'], users: ['jsmith'] } });
    for (const s of NO_CHANGE) assert.strictEqual(r.redact(s), s);
    assert.strictEqual(r.total(), 0);
});

test('toggles, serials and redactValue deep copy', function () {
    const r = R.create({ enabled: { ips: false, users: false }, seeds: { hosts: ['PC01'] } });
    assert.strictEqual(r.redact('user=bob 10.0.0.1 PC01'), 'user=bob 10.0.0.1 HOST_1');
    const s = R.create({ enabled: { serials: true } });
    assert.strictEqual(s.redact('Serial Number: ABC123XYZ'), 'Serial Number: SERIAL_1');
    assert.strictEqual(R.create({}).redact('Serial Number: ABC123XYZ'), 'Serial Number: ABC123XYZ');
    const src = { a: 'user=bob', list: ['10.0.0.1', 5, null, { 'user=bob': 'x' }], n: 3 };
    const o = R.create({}).redactValue(src);
    assert.deepStrictEqual(o, { a: 'user=USER_1', list: ['IP_1', 5, null, { 'user=bob': 'x' }], n: 3 });
    assert.strictEqual(src.a, 'user=bob');
});

test('bad input never throws', function () {
    const r = R.create(null);
    assert.strictEqual(r.redact(null), '');
    assert.strictEqual(r.redact(undefined), '');
    assert.strictEqual(r.redact(42), '42');
    assert.strictEqual(r.restore(null), '');
    assert.strictEqual(r.redactValue(undefined), undefined);
    const st = r.restorer();
    assert.strictEqual(st.push(null), '');
    assert.strictEqual(st.flush(), '');
    assert.doesNotThrow(() => R.create({ seeds: { hosts: 'x', users: [null, 3, '(', '['], domains: [{}] } }).redact('a ( [ b'));
});
