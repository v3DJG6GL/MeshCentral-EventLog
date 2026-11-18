'use strict';
// API key storage: AES-256-GCM with a per-installation key file, environment variable references.
//
// create({ keyFile, fallbackSecret, fs?, env?, log?, platform? }) -> {
//   source: 'file' | 'derived',
//   encrypt(plain, aad) -> { v:1, iv, ct, tag, last4 }        (base64 fields; last4 only for keys >= 12 chars)
//   decrypt(obj, aad)   -> string | null                       (null on tamper, wrong key or AAD mismatch)
//   isEnvRef(s)         -> bool   for { env:'VAR' } or the string 'env:VAR'
//   parseEnvRef(s)      -> 'VAR' | null
//   resolve(stored, aad)-> string | null                       ({env} read from the environment at call time)
// }
// Key file: 32 random bytes, created with { flag:'wx', mode:0o600 } when missing; a warning is logged when its
// mode is looser than 0600. When it cannot be created or read, the key is derived with HKDF-SHA256 from
// fallbackSecret (salt 'eventlog-ai-v1'). Throws only when neither is available (call it at startup).

const crypto = require('crypto');

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SALT = 'eventlog-ai-v1';
const INFO = 'eventlog-ai-key';

function create(opts) {
    opts = opts || {};
    const fs = opts.fs || require('fs');
    const env = opts.env || process.env;
    const log = opts.log || function (m) { console.log(m); };
    const platform = opts.platform || process.platform;
    let key = null, source = null;

    function warn(m) { try { log('EVENTLOG AI: ' + m); } catch (e) { } }

    function readKey() {
        const b = fs.readFileSync(opts.keyFile);
        if (!Buffer.isBuffer(b) || b.length !== 32) throw Object.assign(new Error('bad key file'), { code: 'EBADKEY' });
        return b;
    }
    function checkMode() {
        if (platform === 'win32') return;
        try {
            const st = fs.statSync(opts.keyFile);
            if (st && (st.mode & 0o077)) warn('key file ' + opts.keyFile + ' is accessible by other users (mode ' + (st.mode & 0o777).toString(8) + '); run chmod 600 on it');
        } catch (e) { }
    }

    if (opts.keyFile) {
        try {
            try { key = readKey(); }
            catch (e) {
                if (e.code !== 'ENOENT') throw e;
                const fresh = crypto.randomBytes(32);
                try { fs.writeFileSync(opts.keyFile, fresh, { flag: 'wx', mode: 0o600 }); key = fresh; }
                catch (e2) { if (e2.code === 'EEXIST') key = readKey(); else throw e2; }   // created concurrently
            }
            source = 'file';
            checkMode();
        } catch (e) {
            key = null;
            warn('cannot use key file ' + opts.keyFile + ' (' + (e.code || 'error') + '); using a key derived from the server secret');
        }
    }
    if (!key) {
        if (opts.fallbackSecret == null || opts.fallbackSecret === '') throw new Error('secrets: no usable key file and no fallback secret');
        key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(opts.fallbackSecret), 'utf8'), SALT, INFO, 32));
        source = 'derived';
    }

    function aadBuf(aad) { return Buffer.from(aad == null ? '' : String(aad), 'utf8'); }

    function encrypt(plain, aad) {
        plain = String(plain == null ? '' : plain);
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', key, iv);
        c.setAAD(aadBuf(aad));
        const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
        return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64'), last4: plain.length >= 12 ? plain.slice(-4) : '' };
    }

    function decrypt(obj, aad) {
        try {
            if (!obj || obj.v !== 1 || typeof obj.iv !== 'string' || typeof obj.ct !== 'string' || typeof obj.tag !== 'string') return null;
            const iv = Buffer.from(obj.iv, 'base64'), tag = Buffer.from(obj.tag, 'base64');
            if (iv.length !== 12 || tag.length !== 16) return null;
            const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
            d.setAAD(aadBuf(aad));
            d.setAuthTag(tag);
            return Buffer.concat([d.update(Buffer.from(obj.ct, 'base64')), d.final()]).toString('utf8');
        } catch (e) { return null; }
    }

    function parseEnvRef(s) {
        let name = null;
        if (s && typeof s === 'object' && typeof s.env === 'string') name = s.env;
        else if (typeof s === 'string' && s.startsWith('env:')) name = s.slice(4).trim();
        return name != null && ENV_NAME.test(name) ? name : null;
    }
    function isEnvRef(s) { return parseEnvRef(s) != null; }

    function resolve(stored, aad) {
        if (stored == null) return null;
        const name = parseEnvRef(stored);
        if (name) { const v = env[name]; return typeof v === 'string' && v !== '' ? v : null; }
        if (typeof stored === 'object' && stored.v === 1) return decrypt(stored, aad);
        return null;                                   // plaintext is never accepted as a stored form
    }

    return { source: source, encrypt: encrypt, decrypt: decrypt, isEnvRef: isEnvRef, parseEnvRef: parseEnvRef, resolve: resolve };
}

module.exports = { create, ENV_NAME };
