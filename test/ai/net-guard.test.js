'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ng = require('../../ai/netguard.js');

function fakeResolver(map) {
    return function (host, opts, cb) {
        const r = map[host];
        setImmediate(function () {
            if (!r) { const e = new Error('nx'); e.code = 'ENOTFOUND'; return cb(e); }
            cb(null, r.map(function (a) { return { address: a, family: a.indexOf(':') >= 0 ? 6 : 4 }; }));
        });
    };
}

const TABLE = [
    // url, ok, network (when ok), allowLinkLocal
    ['http://127.0.0.1:11434/v1', true, 'loopback'],
    ['http://[::1]:8000/v1', true, 'loopback'],
    ['http://[::ffff:127.0.0.1]/v1', true, 'loopback'],
    ['http://0x7f.1/v1', true, 'loopback'],
    ['http://2130706433/v1', true, 'loopback'],
    ['http://017700000001/', true, 'loopback'],
    ['http://10.0.0.5:8080/v1', true, 'private'],
    ['http://172.16.3.4/', true, 'private'],
    ['http://192.168.1.20:1234/v1', true, 'private'],
    ['http://100.64.0.10/', true, 'private'],
    ['http://[fd12:3456::1]/', true, 'private'],
    ['https://8.8.8.8/v1', true, 'public'],
    ['https://[2606:4700::1111]/', true, 'public'],
    ['http://169.254.169.254/latest/meta-data', false],
    ['http://[::ffff:169.254.169.254]/', false],
    ['http://[::ffff:a9fe:a9fe]/', false],
    ['http://169.254.10.10/', false],
    ['http://[fe80::1]/', false],
    ['http://[fd00:ec2::254]/', false],
    ['http://100.100.100.200/', false],
    ['http://0.0.0.0:11434/', false],
    ['http://0/', false],
    ['http://224.0.0.251/', false],
    ['http://255.255.255.255/', false],
    ['http://[ff02::1]/', false],
    ['http://[::]/', false],
    ['http://169.254.10.10/', true, 'private', true],
    ['http://[fe80::1]/', true, 'private', true],
    ['http://169.254.169.254/', true, 'private', true],
    ['http://0.0.0.0/', false, null, true],
    ['ftp://127.0.0.1/', false],
    ['file:///etc/passwd', false],
    ['http://user:pw@127.0.0.1/', false],
    ['http://user@127.0.0.1/', false],
    ['not a url', false]
];

for (const [url, ok, network, allow] of TABLE) {
    test('netguard ' + url + (allow ? ' (allowLinkLocal)' : '') + ' -> ' + (ok ? network : 'refused'), async function () {
        const r = await ng.check(url, { allowLinkLocal: !!allow, resolver: fakeResolver({}) });
        assert.strictEqual(r.ok, ok, r.error);
        if (ok) { assert.strictEqual(r.network, network); assert.strictEqual(typeof r.lookup, 'function'); }
        else assert.ok(typeof r.error === 'string' && r.error.length > 0);
    });
}

test('netguard: names are resolved; any public address makes the endpoint public; any blocked address refuses', async function () {
    const res = fakeResolver({
        'gpu.lan': ['192.168.1.9'],
        'mixed.example': ['10.0.0.1', '93.184.216.34'],
        'evil.example': ['93.184.216.34', '169.254.169.254'],
        'loop.example': ['127.0.0.1', '::1'],
        'v6only.example': ['fd00::5']
    });
    assert.strictEqual((await ng.check('http://gpu.lan:11434/v1', { resolver: res })).network, 'private');
    assert.strictEqual((await ng.check('http://mixed.example/v1', { resolver: res })).network, 'public');
    assert.strictEqual((await ng.check('http://loop.example/v1', { resolver: res })).network, 'loopback');
    assert.strictEqual((await ng.check('http://v6only.example/v1', { resolver: res })).network, 'private');
    const evil = await ng.check('http://evil.example/', { resolver: res });
    assert.strictEqual(evil.ok, false);
    assert.match(evil.error, /metadata/);
    const nx = await ng.check('http://nowhere.example/', { resolver: res });
    assert.strictEqual(nx.ok, false);
    assert.match(nx.error, /DNS/);
});

test('netguard: a hanging resolver times out instead of hanging the caller', async function () {
    const r = await ng.check('http://slow.example/', { resolver: function () { }, timeoutMs: 50 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /timed out/);
});

test('netguard: pinned lookup answers only with the validated addresses (defeats DNS rebinding)', async function () {
    let calls = 0;
    const rebinding = function (host, opts, cb) { calls++; setImmediate(function () { cb(null, calls === 1 ? [{ address: '192.168.1.9', family: 4 }, { address: 'fd00::9', family: 6 }] : [{ address: '169.254.169.254', family: 4 }]); }); };
    const r = await ng.check('http://model.lan/v1', { resolver: rebinding });
    assert.ok(r.ok);
    const one = await new Promise(function (resolve) { r.lookup('model.lan', {}, function (e, a, f) { resolve([e, a, f]); }); });
    assert.deepStrictEqual(one, [null, '192.168.1.9', 4]);
    const all = await new Promise(function (resolve) { r.lookup('MODEL.lan', { all: true }, function (e, a) { resolve(a); }); });
    assert.deepStrictEqual(all, [{ address: '192.168.1.9', family: 4 }, { address: 'fd00::9', family: 6 }]);
    const v6 = await new Promise(function (resolve) { r.lookup('model.lan', 6, function (e, a, f) { resolve([a, f]); }); });
    assert.deepStrictEqual(v6, ['fd00::9', 6]);
    const other = await new Promise(function (resolve) { r.lookup('elsewhere.example', {}, function (e) { resolve(e); }); });
    assert.strictEqual(other.code, 'ENOTFOUND');
    assert.strictEqual(calls, 1, 'the resolver is not asked again');
});

test('netguard: pinned lookup works with a real http.request (autoSelectFamily asks for all addresses)', async function () {
    const http = require('http');
    const srv = http.createServer(function (req, res) { res.end('ok'); });
    await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
    try {
        const port = srv.address().port;
        const g = await ng.check('http://pinned.test:' + port + '/', { resolver: fakeResolver({ 'pinned.test': ['127.0.0.1'] }) });
        assert.ok(g.ok);
        const body = await new Promise(function (resolve, reject) {
            http.get({ host: 'pinned.test', port: port, path: '/', lookup: g.lookup, agent: false }, function (res) { let b = ''; res.on('data', function (c) { b += c; }); res.on('end', function () { resolve(b); }); }).on('error', reject);
        });
        assert.strictEqual(body, 'ok');
    } finally { srv.close(); }
});

test('classifyHost hints', function () {
    const cases = {
        'localhost': 'loopback', 'api.localhost': 'loopback', '127.0.0.1': 'loopback', '0x7f.1': 'loopback', '::1': 'loopback', '[::1]': 'loopback',
        '10.1.1.1': 'private', '192.168.0.2': 'private', 'fd00::1': 'private',
        'ollama': 'private?', 'gpu.local': 'private?', 'llm.lan': 'private?', 'svc.internal': 'private?', 'box.home.arpa': 'private?',
        'api.openai.com': 'public?', '8.8.8.8': 'public',
        '169.254.169.254': 'blocked', 'fe80::1': 'blocked', '0.0.0.0': 'blocked', '': 'invalid', 'a b': 'invalid'
    };
    for (const h of Object.keys(cases)) assert.strictEqual(ng.classifyHost(h), cases[h], h);
});

test('classifyAddress covers IPv4-mapped, NAT64 and 6to4 forms', function () {
    assert.strictEqual(ng.classifyAddress('::ffff:127.0.0.1'), 'loopback');
    assert.strictEqual(ng.classifyAddress('::ffff:7f00:1'), 'loopback');
    assert.strictEqual(ng.classifyAddress('::ffff:169.254.169.254'), 'metadata');
    assert.strictEqual(ng.classifyAddress('::ffff:10.0.0.1'), 'private');
    assert.strictEqual(ng.classifyAddress('64:ff9b::8.8.8.8'), 'public');
    assert.strictEqual(ng.classifyAddress('64:ff9b::a9fe:a9fe'), 'blocked');
    assert.strictEqual(ng.classifyAddress('2002:a9fe:a9fe::1'), 'blocked');
    assert.strictEqual(ng.classifyAddress('fe80::1%eth0'), 'linklocal');
    assert.strictEqual(ng.classifyAddress('nonsense'), 'invalid');
});
