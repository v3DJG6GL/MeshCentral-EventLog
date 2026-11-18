'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../../ai/eventref.js');
const DATA = require('../../ai/eventref.json');

function checkEntry(e, where) {
    assert.ok(typeof e.title === 'string' && e.title.length > 3, where + ' title');
    assert.ok(typeof e.meaning === 'string' && e.meaning.length > 10 && e.meaning.length <= 400, where + ' meaning');
    assert.ok(Array.isArray(e.causes) && e.causes.length >= 1 && e.causes.length <= 4, where + ' causes');
    assert.ok(Array.isArray(e.checks) && e.checks.length >= 1 && e.checks.length <= 3, where + ' checks');
    for (const s of e.causes.concat(e.checks)) assert.ok(typeof s === 'string' && s.length > 2, where + ' item');
    assert.strictEqual(typeof e.benign, 'boolean', where + ' benign');
    if (e.benign) assert.ok(typeof e.benignNote === 'string' && e.benignNote.length > 3, where + ' benignNote');
}

test('every Windows entry is complete and unique per provider+id', function () {
    const seen = new Set();
    for (const e of DATA.windows) {
        const where = e.providers[0] + ' ' + e.id;
        assert.ok(Array.isArray(e.providers) && e.providers.length >= 1, where);
        assert.ok(Number.isInteger(e.id), where + ' id');
        checkEntry(e, where);
        for (const p of new Set(e.providers.map(E.normProvider))) {
            const k = p + '|' + e.id;
            assert.ok(!seen.has(k), 'duplicate ' + k);
            seen.add(k);
        }
    }
});

test('every Linux entry is complete and its pattern compiles', function () {
    const keys = new Set();
    for (const e of DATA.linux) {
        assert.ok(typeof e.key === 'string' && !keys.has(e.key), e.key);
        keys.add(e.key);
        assert.doesNotThrow(() => new RegExp(e.pattern, e.flags || ''), e.key);
        checkEntry(e, e.key);
    }
});

test('required coverage', function () {
    const need = {
        'Microsoft-Windows-Kernel-Power': [41, 42, 107, 109], EventLog: [6005, 6006, 6008, 6009, 6013], User32: [1074, 1076], BugCheck: [1001],
        'Service Control Manager': [7000, 7001, 7009, 7011, 7022, 7023, 7024, 7026, 7031, 7034, 7036, 7040, 7045],
        'Application Error': [1000], 'Application Hang': [1002], 'Windows Error Reporting': [1001], '.NET Runtime': [1026],
        disk: [7, 11, 51, 153, 157], stornvme: [129, 11], storahci: [129], Ntfs: [55, 98, 130, 137], volmgr: [46, 161],
        'WHEA-Logger': [17, 18, 19, 47, 1],
        'Microsoft-Windows-Security-Auditing': [4624, 4625, 4634, 4648, 4672, 4720, 4722, 4725, 4726, 4732, 4740, 4767, 4771, 4776, 1102],
        'Microsoft-Windows-Eventlog': [1102, 104], DistributedCOM: [10016, 10010], Schannel: [36887, 36874, 36888],
        'Microsoft-Windows-DNS-Client': [1014], 'Microsoft-Windows-Time-Service': [129, 134, 36],
        'Microsoft-Windows-WindowsUpdateClient': [19, 20, 43, 44], 'Microsoft-Windows-GroupPolicy': [1129, 1053, 1085],
        NETLOGON: [5719, 3210], Tcpip: [4199], 'Microsoft-Windows-Kernel-General': [12, 13], 'Microsoft-Windows-Winlogon': [7001, 7002],
        'Microsoft-Windows-Diagnostics-Performance': [100, 200], ESENT: [455, 490], VSS: [8193, 12289, 13]
    };
    for (const p of Object.keys(need)) for (const id of need[p]) assert.strictEqual(E.lookup(p, id).known, true, p + ' ' + id);
});

test('lookup: aliases, case, string ids, unknowns', function () {
    const a = E.lookup('Kernel-Power', 41), b = E.lookup('microsoft-windows-kernel-power', '41');
    assert.strictEqual(a.known, true);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.provider, 'Microsoft-Windows-Kernel-Power');
    assert.strictEqual(a.id, 41);
    assert.ok(a.causes.length > 0 && a.checks.length > 0);
    assert.strictEqual(E.lookup('service control manager', 7036).benign, true);
    assert.strictEqual(E.lookup('Microsoft-Windows-Service Control Manager', 7031).known, true);
    assert.strictEqual(E.lookup('DNS Client Events', 1014).benign, true);
    assert.strictEqual(E.lookup('W32Time', 134).known, true);
    assert.strictEqual(E.lookup('Microsoft-Windows-WER-SystemErrorReporting', 1001).provider, 'BugCheck');
    assert.strictEqual(E.lookup('Disk', 7).known, true);
    assert.strictEqual(E.lookup('Microsoft-Windows-WHEA-Logger', 18).known, true);
    assert.strictEqual(E.lookup('DCOM', 10016).benign, true);
    assert.strictEqual(E.lookup('Microsoft-Windows-DistributedCOM', 10016).benign, true);
    assert.strictEqual(E.lookup('Microsoft-Windows-Kernel-Power', 41).benign, false);
    assert.strictEqual(E.lookup('e1dexpress', 27).known, true);
    assert.deepStrictEqual(E.lookup('Kernel-Power', 99999), { known: false });
    assert.deepStrictEqual(E.lookup('NoSuchProvider', 41), { known: false });
    assert.deepStrictEqual(E.lookup('', 41), { known: false });
    assert.deepStrictEqual(E.lookup(null, null), { known: false });
    assert.deepStrictEqual(E.lookup('Kernel-Power', '41abc'), { known: false });
    assert.deepStrictEqual(E.lookup('Kernel-Power', 41.5), { known: false });
    // results are copies
    a.causes.push('x');
    assert.notStrictEqual(E.lookup('Kernel-Power', 41).causes.length, a.causes.length);
});

test('lookupLinux patterns', function () {
    const cases = [
        ['Out of memory: Killed process 1234 (java) total-vm:8123456kB', 'oom-killer'],
        ['java invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0', 'oom-killer'],
        ['oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,task=java,pid=1234,uid=1000', 'oom-killer'],
        ['myapp[4321]: segfault at 0 ip 00007f3a2b1c4d5e sp 00007ffd1a2b3c40 error 4 in libc.so.6[7f3a2b000000+195000]', 'segfault'],
        ['blk_update_request: I/O error, dev sda, sector 123456 op 0x0:(READ)', 'io-error'],
        ['I/O error, dev nvme0n1, sector 2048 op 0x1:(WRITE) flags 0x800', 'io-error'],
        ['EXT4-fs error (device sda1): ext4_find_entry:1455: inode #2: comm ls: reading directory lblock 0', 'ext4-error'],
        ['XFS (dm-0): Metadata corruption detected at xfs_dinode_verify+0x1a0/0x7c0 [xfs], inode 0x1234 dinode', 'xfs-corruption'],
        ["nginx.service: Failed with result 'exit-code'.", 'unit-failed'],
        ['nginx.service: Main process exited, code=exited, status=1/FAILURE', 'unit-failed'],
        ['Unit foo.service entered failed state.', 'unit-failed'],
        ['watchdog: BUG: soft lockup - CPU#2 stuck for 23s! [kworker/2:1:123]', 'soft-lockup'],
        ['INFO: task jbd2/sda1-8:345 blocked for more than 120 seconds.', 'hung-task'],
        ['mce: [Hardware Error]: Machine check events logged', 'mce'],
        ['Failed password for invalid user admin from 203.0.113.9 port 51234 ssh2', 'ssh-failed-password'],
        ['pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.9', 'auth-failure'],
        ['Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(0,0)', 'kernel-panic'],
        ['nvme nvme0: I/O 123 QID 4 timeout, aborting', 'nvme-timeout'],
        ['nvme nvme0: controller is down; will reset: CSTS=0xffffffff, PCI_STATUS=0x10', 'nvme-timeout'],
        ['e1000e 0000:00:1f.6 eno1: NIC Link is Down', 'link-down'],
        ['IPv6: ADDRCONF(NETDEV_UP): eth0: link is not ready', 'link-down'],
        ['CPU0: Core temperature above threshold, cpu clock throttled (total events = 1)', 'thermal'],
        ['thermal thermal_zone0: critical temperature reached (105 C), shutting down', 'thermal'],
        ['File /var/log/journal/abc/system.journal corrupted or uncleanly shut down, renaming and replacing.', 'journal-corrupted']
    ];
    for (const [msg, key] of cases) {
        const r = E.lookupLinux(msg);
        assert.ok(r, msg);
        assert.strictEqual(r.key, key, msg);
        assert.strictEqual(r.known, true);
    }
    assert.strictEqual(E.lookupLinux('Started Session 2 of user root.'), null);
    assert.strictEqual(E.lookupLinux('Accepted publickey for bob from 10.0.0.5 port 50022 ssh2'), null);
    assert.strictEqual(E.lookupLinux(null), null);
    assert.strictEqual(E.lookupLinux('x'.repeat(100000)), null);
    assert.strictEqual(E.lookupLinux('Journal file corrupt, replacing', 'systemd-journald.service').key, 'journal-corrupted');
    assert.strictEqual(E.lookupLinux('Journal effectively 0 bytes', 'systemd-journald.service'), null);
});
