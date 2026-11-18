'use strict';
// Endpoint address validation (SSRF guard) for LLM endpoints.
//
// check(urlString, { allowLinkLocal, resolver, timeoutMs }) -> Promise (never rejects) of
//   { ok, error?, url, network: 'loopback'|'private'|'public', addresses: [{address, family, kind}], lookup }
//   - http/https only, no userinfo; literal IPs are taken as-is (the WHATWG URL parser already normalises
//     0x7f.1, 2130706433, [::ffff:127.0.0.1] ...), names are resolved with dns.lookup(host, {all:true}).
//   - every address is classified; link-local and cloud metadata addresses are refused unless allowLinkLocal;
//     unspecified (0.0.0.0/8, ::), multicast, broadcast and reserved ranges are always refused.
//   - lookup: a dns.lookup-compatible function that only ever answers with the validated addresses
//     (pass it to http.request so a second DNS answer cannot point the connection elsewhere).
// classifyHost(hostname) -> sync hint: 'loopback'|'private'|'public'|'blocked' for literal IPs and localhost,
//   'private?' for .local/.lan/.internal/.home.arpa/.localdomain/single-label names, 'public?' for other names,
//   'invalid' when the name cannot be parsed.
// classifyAddress(ip) -> 'loopback'|'private'|'public'|'linklocal'|'metadata'|'blocked'|'invalid'

const dns = require('dns');
const net = require('net');

const METADATA_V4 = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', '192.0.0.192']);

function v4bytes(s) {
    const p = s.split('.');
    if (p.length !== 4) return null;
    const b = p.map(Number);
    return b.every(function (x, i) { return Number.isInteger(x) && x >= 0 && x <= 255 && /^\d{1,3}$/.test(p[i]); }) ? b : null;
}

function classifyV4(b) {
    const s = b.join('.');
    if (METADATA_V4.has(s)) return 'metadata';
    const [a, c] = b;
    if (a === 0) return 'blocked';                                // "this network" / unspecified
    if (a === 127) return 'loopback';
    if (a === 10) return 'private';
    if (a === 172 && c >= 16 && c <= 31) return 'private';
    if (a === 192 && c === 168) return 'private';
    if (a === 100 && c >= 64 && c <= 127) return 'private';       // CGNAT 100.64/10
    if (a === 169 && c === 254) return 'linklocal';
    if (a === 192 && c === 0 && b[2] === 0) return 'blocked';     // IETF protocol assignments
    if (a === 198 && (c === 18 || c === 19)) return 'private';    // benchmarking 198.18/15
    if (a >= 224 && a <= 239) return 'blocked';                   // multicast
    if (a >= 240) return 'blocked';                               // reserved + 255.255.255.255 broadcast
    return 'public';
}

// Parse an IPv6 literal (no brackets, optional %zone) into 16 bytes, or null.
function v6bytes(s) {
    s = String(s);
    const z = s.indexOf('%');
    if (z >= 0) s = s.slice(0, z);
    if (!net.isIPv6(s)) return null;
    let tail = [];
    const lastColon = s.lastIndexOf(':');
    if (s.indexOf('.', lastColon) >= 0) {                        // embedded IPv4 tail
        const b = v4bytes(s.slice(lastColon + 1));
        if (!b) return null;
        tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
        s = s.slice(0, lastColon + 1);                           // ends with ':'
        if (!s.endsWith('::')) s = s.slice(0, -1);
    }
    const want = 8 - tail.length;
    let groups;
    const dbl = s.indexOf('::');
    if (dbl >= 0) {
        const left = s.slice(0, dbl) ? s.slice(0, dbl).split(':') : [];
        const right = s.slice(dbl + 2) ? s.slice(dbl + 2).split(':') : [];
        const fill = want - left.length - right.length;
        if (fill < 0) return null;
        groups = left.concat(new Array(fill).fill('0'), right);
    } else {
        groups = s ? s.split(':') : [];
    }
    if (groups.length !== want) return null;
    const words = groups.map(function (g) { return parseInt(g, 16); }).concat(tail);
    if (words.length !== 8 || words.some(function (w) { return !(w >= 0 && w <= 0xFFFF); })) return null;
    const out = [];
    words.forEach(function (w) { out.push(w >> 8, w & 255); });
    return out;
}

function classifyV6(b) {
    const zeroTo = function (n) { for (let i = 0; i < n; i++) if (b[i] !== 0) return false; return true; };
    if (zeroTo(16)) return 'blocked';                                         // ::
    if (zeroTo(15) && b[15] === 1) return 'loopback';                         // ::1
    if (zeroTo(10) && b[10] === 0xFF && b[11] === 0xFF) return classifyV4(b.slice(12));   // ::ffff:a.b.c.d
    if (zeroTo(12)) return 'blocked';                                         // ::a.b.c.d (deprecated IPv4-compatible)
    if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xFF && b[3] === 0x9B) {      // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
        if (b[4] === 0 && b[5] === 1) return 'private';
        return classifyV4(b.slice(12)) === 'public' ? 'public' : 'blocked';   // translated non-public IPv4: refuse
    }
    if (b[0] === 0x01 && b.slice(1, 8).every(function (x) { return x === 0; })) return 'blocked';  // 100::/64 discard
    if (b[0] === 0x20 && b[1] === 0x02) {                                     // 6to4 2002::/16 embeds an IPv4
        return classifyV4(b.slice(2, 6)) === 'public' ? 'public' : 'blocked';
    }
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0D && b[3] === 0xB8) return 'blocked';   // documentation
    if (b[0] === 0xFF) return 'blocked';                                      // multicast
    if (b[0] === 0xFE && (b[1] & 0xC0) === 0x80) return 'linklocal';          // fe80::/10
    if (b[0] === 0xFE && (b[1] & 0xC0) === 0xC0) return 'private';            // fec0::/10 (deprecated site-local)
    if ((b[0] & 0xFE) === 0xFC) {                                             // ULA fc00::/7
        if (b[0] === 0xFD && b[1] === 0x00 && b[2] === 0x0E && b[3] === 0xC2 &&
            b.slice(4, 14).every(function (x) { return x === 0; }) && b[14] === 0x02 && b[15] === 0x54) return 'metadata'; // fd00:ec2::254
        return 'private';
    }
    return 'public';
}

function classifyAddress(ip) {
    if (typeof ip !== 'string') return 'invalid';
    if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
    if (net.isIPv4(ip)) { const b = v4bytes(ip); return b ? classifyV4(b) : 'invalid'; }
    const b6 = v6bytes(ip);
    return b6 ? classifyV6(b6) : 'invalid';
}

const LOCAL_SUFFIX = /\.(local|lan|internal|intranet|home|home\.arpa|localdomain|corp|private)$/i;

function classifyHost(hostname) {
    let h = String(hostname == null ? '' : hostname).trim();
    if (!h) return 'invalid';
    try { h = new URL('http://' + (h.indexOf(':') >= 0 && !h.startsWith('[') && net.isIPv6(h) ? '[' + h + ']' : h) + '/').hostname; }
    catch (e) { return 'invalid'; }
    if (h.startsWith('[')) h = h.slice(1, -1);
    if (net.isIP(h)) {
        const k = classifyAddress(h);
        return (k === 'linklocal' || k === 'metadata') ? 'blocked' : k;
    }
    h = h.replace(/\.$/, '').toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
    if (h.indexOf('.') < 0 || LOCAL_SUFFIX.test(h)) return 'private?';
    return 'public?';
}

function fail(error, url) { return { ok: false, error: error, url: url || null, network: null, addresses: [], lookup: null }; }

// dns.lookup-compatible function answering only with the validated addresses for the validated host.
function pinnedLookup(hostname, addresses) {
    const host = String(hostname).toLowerCase();
    const list = addresses.map(function (a) { return { address: a.address, family: a.family }; });
    return function lookup(name, options, cb) {
        if (typeof options === 'function') { cb = options; options = {}; }
        if (typeof options === 'number') options = { family: options };
        options = options || {};
        const done = function (err, a, f) { process.nextTick(function () { cb(err, a, f); }); };
        let n = String(name).toLowerCase();
        if (n.startsWith('[') && n.endsWith(']')) n = n.slice(1, -1);
        if (n !== host && !list.some(function (a) { return a.address === n; })) {
            const e = new Error('Address not validated for this endpoint'); e.code = 'ENOTFOUND'; return done(e);
        }
        const fam = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0;
        const pick = fam ? list.filter(function (a) { return a.family === fam; }) : list.slice();
        if (!pick.length) { const e = new Error('No validated address of the requested family'); e.code = 'ENOTFOUND'; return done(e); }
        if (options.all) return done(null, pick.map(function (a) { return { address: a.address, family: a.family }; }));
        done(null, pick[0].address, pick[0].family);
    };
}

function resolveAll(resolver, host, timeoutMs) {
    return new Promise(function (resolve) {
        let settled = false;
        const timer = setTimeout(function () { if (!settled) { settled = true; resolve({ error: 'DNS lookup timed out' }); } }, timeoutMs);
        try {
            resolver(host, { all: true, verbatim: true }, function (err, addrs) {
                if (settled) return;
                settled = true; clearTimeout(timer);
                if (err) return resolve({ error: 'DNS lookup failed (' + (err.code || 'error') + ')' });
                if (!Array.isArray(addrs)) addrs = addrs ? [{ address: addrs, family: net.isIPv6(addrs) ? 6 : 4 }] : [];
                resolve({ addrs: addrs });
            });
        } catch (e) { if (!settled) { settled = true; clearTimeout(timer); resolve({ error: 'DNS lookup failed' }); } }
    });
}

async function check(urlString, opts) {
    opts = opts || {};
    let u;
    try { u = new URL(String(urlString == null ? '' : urlString).trim()); } catch (e) { return fail('Invalid address'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('Only http:// and https:// addresses are allowed', u.href);
    if (u.username || u.password) return fail('User name or password in the address is not allowed', null);
    let host = u.hostname;
    if (!host) return fail('Address has no host name', u.href);
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

    let addrs;
    if (net.isIP(host)) addrs = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
    else {
        const r = await resolveAll(opts.resolver || dns.lookup, host, opts.timeoutMs || 5000);
        if (r.error) return fail(r.error, u.href);
        addrs = r.addrs.filter(function (a) { return a && typeof a.address === 'string'; });
        if (!addrs.length) return fail('Host name did not resolve', u.href);
    }

    const out = [];
    for (const a of addrs) {
        const fam = a.family === 6 || a.family === 'IPv6' ? 6 : a.family === 4 || a.family === 'IPv4' ? 4 : (net.isIPv6(a.address) ? 6 : 4);
        const kind = classifyAddress(a.address);
        if (kind === 'invalid') return fail('Host name resolved to an invalid address', u.href);
        if (kind === 'blocked') return fail('Address ' + a.address + ' is not allowed (unspecified, multicast, broadcast or reserved)', u.href);
        if ((kind === 'linklocal' || kind === 'metadata') && !opts.allowLinkLocal)
            return fail('Address ' + a.address + ' is ' + (kind === 'metadata' ? 'a cloud metadata address' : 'link-local') + ' and blocked (enable "allow link-local" to use it)', u.href);
        out.push({ address: a.address, family: fam, kind: kind });
    }
    const network = out.every(function (a) { return a.kind === 'loopback'; }) ? 'loopback'
        : out.every(function (a) { return a.kind !== 'public'; }) ? 'private' : 'public';
    return { ok: true, url: u.href, hostname: host, network: network, addresses: out, lookup: pinnedLookup(host, out) };
}

module.exports = { check, classifyHost, classifyAddress, pinnedLookup, _v6bytes: v6bytes };
