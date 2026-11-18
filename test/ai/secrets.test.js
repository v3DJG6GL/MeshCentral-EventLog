'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const secrets = require('../../ai/secrets.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'evl-secrets-')); }
const quiet = function () { };

test('key file is created with 32 random bytes and mode 0600; round trip', function () {
    const d = tmpDir();
    const keyFile = path.join(d, 'plugin-eventlog-ai.key');
    const s = secrets.create({ keyFile: keyFile, fallbackSecret: 'x', log: quiet });
    assert.strictEqual(s.source, 'file');
    assert.strictEqual(fs.readFileSync(keyFile).length, 32);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
    const enc = s.encrypt('sk-test-1234567890abcd', 'aiEndpoint:1');
    assert.strictEqual(enc.v, 1);
    assert.strictEqual(enc.last4, 'abcd');
    assert.ok(!JSON.stringify(enc).includes('sk-test'));
    assert.strictEqual(s.decrypt(enc, 'aiEndpoint:1'), 'sk-test-1234567890abcd');
    // the same key file is reused by a second instance
    const s2 = secrets.create({ keyFile: keyFile, fallbackSecret: 'other', log: quiet });
    assert.strictEqual(s2.decrypt(enc, 'aiEndpoint:1'), 'sk-test-1234567890abcd');
    fs.rmSync(d, { recursive: true, force: true });
});

test('tamper and AAD mismatch -> null', function () {
    const d = tmpDir();
    const s = secrets.create({ keyFile: path.join(d, 'k'), log: quiet });
    const enc = s.encrypt('secret-value-long-enough', 'ep1');
    assert.strictEqual(s.decrypt(enc, 'ep2'), null);
    const ct = Buffer.from(enc.ct, 'base64'); ct[0] ^= 1;
    assert.strictEqual(s.decrypt(Object.assign({}, enc, { ct: ct.toString('base64') }), 'ep1'), null);
    const tag = Buffer.from(enc.tag, 'base64'); tag[3] ^= 0x80;
    assert.strictEqual(s.decrypt(Object.assign({}, enc, { tag: tag.toString('base64') }), 'ep1'), null);
    assert.strictEqual(s.decrypt(Object.assign({}, enc, { tag: enc.tag.slice(0, 8) }), 'ep1'), null);
    assert.strictEqual(s.decrypt(Object.assign({}, enc, { v: 2 }), 'ep1'), null);
    assert.strictEqual(s.decrypt(null, 'ep1'), null);
    assert.strictEqual(s.decrypt('garbage', 'ep1'), null);
    // another key cannot read it
    const other = secrets.create({ keyFile: path.join(d, 'k2'), log: quiet });
    assert.strictEqual(other.decrypt(enc, 'ep1'), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('short keys get no last4 hint; IVs are unique', function () {
    const d = tmpDir();
    const s = secrets.create({ keyFile: path.join(d, 'k'), log: quiet });
    assert.strictEqual(s.encrypt('short', 'a').last4, '');
    assert.notStrictEqual(s.encrypt('same-secret-value', 'a').iv, s.encrypt('same-secret-value', 'a').iv);
    fs.rmSync(d, { recursive: true, force: true });
});

test('env references: validated names, read at call time', function () {
    const d = tmpDir();
    const env = {};
    const s = secrets.create({ keyFile: path.join(d, 'k'), env: env, log: quiet });
    assert.strictEqual(s.isEnvRef({ env: 'OPENAI_API_KEY' }), true);
    assert.strictEqual(s.isEnvRef('env:OPENAI_API_KEY'), true);
    assert.strictEqual(s.isEnvRef({ env: 'lower' }), false);
    assert.strictEqual(s.isEnvRef({ env: '1ABC' }), false);
    assert.strictEqual(s.isEnvRef({ env: 'A'.repeat(65) }), false);
    assert.strictEqual(s.isEnvRef('env:PATH;rm'), false);
    assert.strictEqual(s.isEnvRef('sk-plain'), false);
    assert.strictEqual(s.resolve({ env: 'MY_KEY' }, 'ep'), null);
    env.MY_KEY = 'from-env';
    assert.strictEqual(s.resolve({ env: 'MY_KEY' }, 'ep'), 'from-env');
    env.MY_KEY = 'rotated';
    assert.strictEqual(s.resolve({ env: 'MY_KEY' }, 'ep'), 'rotated');
    assert.strictEqual(s.resolve({ env: 'bad name' }, 'ep'), null);
    assert.strictEqual(s.resolve('plaintext-is-never-accepted', 'ep'), null);
    assert.strictEqual(s.resolve(s.encrypt('stored-secret-xyz', 'ep'), 'ep'), 'stored-secret-xyz');
    assert.strictEqual(s.resolve(null, 'ep'), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('loose key file permissions produce a warning', { skip: process.platform === 'win32' }, function () {
    const d = tmpDir();
    const keyFile = path.join(d, 'k');
    fs.writeFileSync(keyFile, require('crypto').randomBytes(32), { mode: 0o644 });
    fs.chmodSync(keyFile, 0o644);
    const logs = [];
    const s = secrets.create({ keyFile: keyFile, log: function (m) { logs.push(m); } });
    assert.strictEqual(s.source, 'file');
    assert.ok(logs.some(function (m) { return /^EVENTLOG AI: .*chmod 600/.test(m); }), logs.join('\n'));
    fs.rmSync(d, { recursive: true, force: true });
});

test('derived fallback when the key file cannot be created; deterministic per secret', function () {
    const d = tmpDir();
    const bad = path.join(d, 'missing-dir', 'k');
    const logs = [];
    const a = secrets.create({ keyFile: bad, fallbackSecret: 'cookie-key', log: function (m) { logs.push(m); } });
    assert.strictEqual(a.source, 'derived');
    assert.ok(logs.some(function (m) { return /^EVENTLOG AI: cannot use key file/.test(m); }));
    const b = secrets.create({ keyFile: bad, fallbackSecret: 'cookie-key', log: quiet });
    const enc = a.encrypt('derived-secret-value', 'ep');
    assert.strictEqual(b.decrypt(enc, 'ep'), 'derived-secret-value');
    const c = secrets.create({ fallbackSecret: 'other-cookie-key', log: quiet });
    assert.strictEqual(c.decrypt(enc, 'ep'), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('a corrupt key file falls back to the derived key; no key at all throws', function () {
    const d = tmpDir();
    const keyFile = path.join(d, 'k');
    fs.writeFileSync(keyFile, 'short', { mode: 0o600 });
    const s = secrets.create({ keyFile: keyFile, fallbackSecret: 'f', log: quiet });
    assert.strictEqual(s.source, 'derived');
    assert.throws(function () { secrets.create({ keyFile: path.join(d, 'nodir', 'k'), log: quiet }); });
    fs.rmSync(d, { recursive: true, force: true });
});

test('injectable fs: a concurrent creator (EEXIST) is handled by reading the file', function () {
    const key = require('crypto').randomBytes(32);
    let reads = 0;
    const fakeFs = {
        readFileSync: function () { reads++; if (reads === 1) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return key; },
        writeFileSync: function (f, data, o) { assert.strictEqual(o.flag, 'wx'); assert.strictEqual(o.mode, 0o600); throw Object.assign(new Error('x'), { code: 'EEXIST' }); },
        statSync: function () { return { mode: 0o100600 }; }
    };
    const s = secrets.create({ keyFile: '/virtual/k', fs: fakeFs, log: quiet, platform: 'linux' });
    assert.strictEqual(s.source, 'file');
    assert.strictEqual(reads, 2);
});
