'use strict';
// Whitelist builders for the device data the Assistant may forward to a model. Nothing here copies a whole
// MeshCentral document: every field is picked by name, so new or sensitive fields never leak by accident.
//
// Never forwarded: node ssh / rdp credentials, intelamt.pass / mpspass, pmt, device group AMT / KVM passwords and
// invite codes, user records, locations (iploc / gpsloc / wifiloc / userloc), BitLocker recovery keys
// (hardware.windows.volumes[*].recoveryPassword, hardware.windows.bitlocker) and serial numbers unless
// opts.serials is true.
//
// getDoc(meshDb, id)                          -> Promise<doc|null>        (meshDb.Get(id, cb(err, docs)))
// nodeSummary(node, { connectivity })         -> object
// sysinfoSummary(siDoc, { serials })          -> object|null
// networkSummary(ifDoc)                       -> [{ name, type, status, mac, ipv4[], ipv6[], gateway, dns[] }]|null
// lastConnect(lcDoc)                          -> { time, addr }|null
// notes(ntDoc)                                -> string|null              (truncated to 4000 chars)
// deviceInfo({ meshDb, nodeid, node, categories, getConnectivityState, serials, osVersion }) -> Promise<object>
//   osVersion: the OS version the plugin's collector reported (macOS: e.g. '14.5'), added as device.osVersion
// deviceEvents({ meshDb, nodeid, domain, userid, rights, limit })              -> Promise<[{ time, action, msg }]>
// seeds(node, siDoc)                          -> { hosts, domains, users, serials } for ai/redact.js

const RIGHT_LIMITEVENTS = 0x00002000;
const RIGHT_ADMIN = 0xFFFFFFFF;

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function str(v, max) {
    if (v == null) return null;
    if (typeof v !== 'string') { if (typeof v === 'number' || typeof v === 'boolean') v = String(v); else return null; }
    v = v.trim();
    if (!v) return null;
    max = max || 200;
    return v.length > max ? v.slice(0, max) + '…' : v;
}
function num(v) { const n = typeof v === 'string' ? Number(v.trim()) : v; return (typeof n === 'number' && Number.isFinite(n)) ? n : null; }
function iso(v) {
    if (v == null || v === '') return null;
    let t = v;
    if (v instanceof Date) t = v.getTime();
    else if (typeof v === 'string' && /^\d{9,15}$/.test(v.trim())) t = Number(v.trim());
    else if (typeof v === 'string') t = Date.parse(v);
    if (typeof t !== 'number' || !Number.isFinite(t)) return null;
    if (t < 1e11) t = t * 1000;    // seconds
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
// Only scalar values of the listed keys; out-of-whitelist keys are never looked at.
function pickScalars(src, keys, max) {
    if (!isObj(src)) return null;
    const o = {};
    let n = 0;
    for (const k of keys) {
        const v = src[k];
        if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) { o[k] = v; n++; }
        else { const s = str(v, max || 200); if (s != null) { o[k] = s; n++; } }
    }
    return n ? o : null;
}
function compact(o) {
    if (!isObj(o)) return o;
    for (const k of Object.keys(o)) {
        const v = o[k];
        if (v == null || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length)) delete o[k];
    }
    return o;
}
// MeshCentral escapes '%', '.', '$' and ',' in stored field names (common.escapeFieldName).
function unEscapeFieldName(name) {
    name = String(name);
    if (name.indexOf('%') === -1) return name;
    return name.split('%2C').join(',').split('%2E').join('.').split('%24').join('$').split('%25').join('%');
}

function getDoc(meshDb, id) {
    return new Promise(function (resolve) {
        try {
            if (meshDb == null || typeof meshDb.Get !== 'function') return resolve(null);
            meshDb.Get(id, function (err, docs) {
                resolve((!err && Array.isArray(docs) && docs.length > 0 && isObj(docs[0])) ? docs[0] : null);
            });
        } catch (e) { resolve(null); }
    });
}

const POWER = ['unknown', 'on', 'sleep', 'sleep', 'sleep', 'hibernate', 'off', 'present', 'off'];

function nodeSummary(node, opts) {
    opts = opts || {};
    if (!isObj(node)) return null;
    const o = {
        name: str(node.name, 120),
        realName: str(node.rname, 120),
        host: str(node.host, 200),
        os: str(node.osdesc, 200),
        description: str(node.desc, 500),
        tags: Array.isArray(node.tags) ? node.tags.map(function (t) { return str(t, 60); }).filter(Boolean).slice(0, 20) : null
    };
    if (isObj(node.agent)) o.agent = compact({ version: num(node.agent.ver), type: num(node.agent.id), capabilities: num(node.agent.caps) });
    const c = opts.connectivity;
    if (isObj(c)) {
        const bits = num(c.connectivity) || 0;
        o.connection = compact({ agent: !!(bits & 1), intelAmtCira: !!(bits & 2) || null, intelAmtLocal: !!(bits & 4) || null, relay: !!(bits & 8) || null, power: POWER[num(c.powerState) || 0] || null });
    } else if (c === null) o.connection = { agent: false };
    o.lastBoot = iso(node.lastbootuptime);
    if (Array.isArray(node.av)) {
        o.antivirus = node.av.filter(isObj).slice(0, 8).map(function (a) { return compact({ product: str(a.product, 120), enabled: typeof a.enabled === 'boolean' ? a.enabled : null, updated: typeof a.updated === 'boolean' ? a.updated : null }); });
    }
    o.securityCenter = pickScalars(node.wsc, ['antiVirus', 'autoUpdate', 'firewall'], 60) || pickScalars(node.lsc, ['antiVirus', 'firewall'], 60);
    o.defender = pickScalars(node.defender, ['RealTimeProtection', 'TamperProtected', 'IsVirtualMachine', 'AntivirusEnabled', 'AntispywareEnabled', 'BehaviorMonitorEnabled', 'IoavProtectionEnabled', 'NISEnabled', 'OnAccessProtectionEnabled', 'AMServiceEnabled', 'AntivirusSignatureAge', 'AntivirusSignatureVersion', 'AMProductVersion', 'QuickScanAge', 'FullScanAge'], 80);
    if (Array.isArray(node.users)) o.loggedInUsers = node.users.map(function (u) { return str(u, 120); }).filter(Boolean).slice(0, 10);
    return compact(o);
}

const ID_KEYS = ['cpu_name', 'bios_vendor', 'bios_version', 'bios_date', 'bios_mode', 'board_vendor', 'board_name', 'board_version', 'product_name', 'sys_vendor', 'chassis_manufacturer', 'chassis_type'];
const SERIAL_KEYS = ['bios_serial', 'board_serial', 'chassis_serial', 'chassis_assettag', 'product_uuid', 'product_serial'];

function volumesOf(v) {
    const out = [];
    if (Array.isArray(v)) v.forEach(function (x) { if (isObj(x)) out.push([x.name || x.DriveLetter || null, x]); });
    else if (isObj(v)) for (const k of Object.keys(v)) if (isObj(v[k])) out.push([unEscapeFieldName(k), v[k]]);
    return out.slice(0, 26).map(function (p) {
        const x = p[1];
        // explicit fields only: never recoveryPassword / identifier / key protectors
        return compact({
            name: str(p[0] != null ? p[0] : x.name, 40), label: str(x.label || x.VolumeName, 60), type: str(x.type || x.FileSystem, 30),
            size: num(x.size != null ? x.size : x.Size), free: num(x.sizeremaining != null ? x.sizeremaining : x.FreeSpace),
            removable: typeof x.removable === 'boolean' ? x.removable : null,
            bitlockerProtection: x.protectionStatus != null ? str(x.protectionStatus, 30) : null,
            bitlockerStatus: x.volumeStatus != null ? str(x.volumeStatus, 40) : null,
            encryptionMethod: x.encryptionMethod != null ? str(x.encryptionMethod, 40) : null
        });
    });
}

function sysinfoSummary(si, opts) {
    opts = opts || {};
    const h = isObj(si) && isObj(si.hardware) ? si.hardware : null;
    if (!h) return null;
    const o = {};
    o.hardware = pickScalars(h.identifiers, ID_KEYS.concat(opts.serials ? SERIAL_KEYS : []), 120);
    const w = isObj(h.windows) ? h.windows : null;
    if (w) {
        o.windows = pickScalars(w.osinfo, ['Caption', 'Version', 'BuildNumber', 'OSArchitecture', 'LastBootUpTime', 'InstallDate', 'Locale', 'MUILanguages'], 120);
        if (Array.isArray(w.memory)) {
            let total = 0, n = 0;
            for (const m of w.memory) if (isObj(m)) { const c = num(m.Capacity); if (c) { total += c; n++; } }
            if (n) o.memory = { totalBytes: total, modules: n };
        }
        if (Array.isArray(w.cpu) && w.cpu.length && isObj(w.cpu[0])) o.cpu = pickScalars(w.cpu[0], ['Name', 'NumberOfCores', 'NumberOfLogicalProcessors', 'MaxClockSpeed'], 120);
        if (Array.isArray(w.drives)) {
            o.drives = w.drives.filter(isObj).slice(0, 16).map(function (d) {
                return compact({ model: str(d.Model || d.Caption, 120), size: num(d.Size), status: str(d.Status, 40), media: str(d.MediaType, 60), interface: str(d.InterfaceType, 30) });
            });
        }
        if (w.volumes != null) o.volumes = volumesOf(w.volumes);
    }
    for (const k of ['linux', 'darwin']) {
        if (isObj(h[k])) {
            o[k] = pickScalars(h[k], ['LastBootUpTime', 'arch', 'kernel_release', 'kernel_build', 'product_name', 'sys_vendor', 'board_vendor', 'board_name', 'board_version', 'bios_vendor', 'bios_version', 'bios_date', 'cpu_name'], 120);
            const mem = h[k].memory;
            if (isObj(mem)) o.memory = pickScalars(mem, ['total', 'MemTotal', 'available', 'MemAvailable', 'free'], 40);
            else if (num(mem)) o.memory = { total: num(mem) };
        }
    }
    if (isObj(h.tpm)) o.tpm = pickScalars(h.tpm, ['SpecVersion', 'ManufacturerId', 'ManufacturerVersion', 'IsActivated', 'IsEnabled', 'IsOwned'], 60);
    if (isObj(h.mobile)) o.mobile = pickScalars(h.mobile, ['model', 'brand', 'bootloader'], 80);
    compact(o);
    return Object.keys(o).length ? o : null;
}

function networkSummary(ifDoc) {
    const n2 = isObj(ifDoc) && isObj(ifDoc.netif2) ? ifDoc.netif2 : null;
    if (!n2) return null;
    const out = [];
    for (const k of Object.keys(n2)) {
        if (out.length >= 16) break;
        const list = Array.isArray(n2[k]) ? n2[k].filter(isObj) : [];
        const it = { name: str(unEscapeFieldName(k), 80), ipv4: [], ipv6: [], dns: [] };
        for (const a of list.slice(0, 16)) {
            if (!it.mac && typeof a.mac === 'string' && a.mac !== '00:00:00:00:00:00') it.mac = str(a.mac, 40);
            if (!it.status && a.status != null) it.status = str(a.status, 20);
            if (!it.type && a.type != null) it.type = str(a.type, 30);
            const addr = str(a.address, 80);
            if (addr) {
                const fam = String(a.family || '').toLowerCase();
                const v6 = fam === 'ipv6' || fam === '6' || addr.indexOf(':') >= 0;
                const entry = a.netmask ? addr + ' / ' + str(a.netmask, 60) : addr;
                if (v6) { if (it.ipv6.length < 8) it.ipv6.push(entry); } else if (it.ipv4.length < 8) it.ipv4.push(entry);
            }
            const gw = a.gateway || a.defaultGateway || (Array.isArray(a.gateways) ? a.gateways[0] : null);
            if (!it.gateway && gw) it.gateway = str(gw, 80);
            const dns = a.dns || a.dnsServers || a.dnsservers || a.DNSServerSearchOrder;
            (Array.isArray(dns) ? dns : (typeof dns === 'string' ? dns.split(/[,\s]+/) : [])).forEach(function (d) {
                const s = str(d, 80); if (s && it.dns.length < 6 && it.dns.indexOf(s) < 0) it.dns.push(s);
            });
            if (!it.dnsSuffix && a.dnssuffix) it.dnsSuffix = str(a.dnssuffix, 120);
        }
        out.push(compact(it));
    }
    return out.length ? out : null;
}

function lastConnect(lc) {
    if (!isObj(lc)) return null;
    const o = compact({ time: iso(lc.time), addr: str(lc.addr, 80) });
    return Object.keys(o).length ? o : null;
}

function notes(nt) {
    if (!isObj(nt) || typeof nt.value !== 'string') return null;
    const v = nt.value.trim();
    if (!v) return null;
    return v.length > 4000 ? v.slice(0, 4000) + '…' : v;
}

async function deviceInfo(p) {
    p = p || {};
    const cats = p.categories || {};
    const nodeid = p.nodeid;
    const out = {};
    let node = await getDoc(p.meshDb, nodeid);
    if (node == null || node._id !== nodeid) node = p.node;
    let conn;
    try { conn = typeof p.getConnectivityState === 'function' ? p.getConnectivityState(nodeid) : undefined; } catch (e) { conn = undefined; }
    if (cats.deviceSummary !== false) {
        out.device = nodeSummary(node, { connectivity: conn === undefined ? undefined : (conn || null) });
        const ov = str(p.osVersion, 40);
        if (ov && isObj(out.device)) out.device.osVersion = ov;
        const si = await getDoc(p.meshDb, 'si' + nodeid);
        const sys = sysinfoSummary(si, { serials: !!p.serials });
        if (sys) out.system = sys;
        const lc = lastConnect(await getDoc(p.meshDb, 'lc' + nodeid));
        if (lc) out.lastAgentConnect = lc;
    }
    if (cats.network) {
        const net = networkSummary(await getDoc(p.meshDb, 'if' + nodeid));
        if (net) out.network = net;
    }
    if (cats.notes) {
        const n = notes(await getDoc(p.meshDb, 'nt' + nodeid));
        if (n) out.notes_untrusted = n;
    }
    return out;
}

function deviceEvents(p) {
    p = p || {};
    const limit = Math.max(1, Math.min(50, Math.floor(Number(p.limit) || 20)));
    return new Promise(function (resolve) {
        const done = function (err, docs) {
            if (err || !Array.isArray(docs)) return resolve([]);
            resolve(docs.filter(isObj).slice(0, limit).map(function (d) {
                return compact({ time: iso(d.time), action: str(d.action, 40), msg: str(d.msg, 500) });
            }));
        };
        try {
            const db = p.meshDb;
            const rights = Number(p.rights) >>> 0;
            if (db == null) return resolve([]);
            if ((rights & RIGHT_LIMITEVENTS) !== 0 && rights !== RIGHT_ADMIN) {
                if (typeof db.GetNodeEventsSelfWithLimit !== 'function') return resolve([]);
                db.GetNodeEventsSelfWithLimit(p.nodeid, p.domain, p.userid, limit, null, done);
            } else {
                if (typeof db.GetNodeEventsWithLimit !== 'function') return resolve([]);
                db.GetNodeEventsWithLimit(p.nodeid, p.domain, limit, null, done);
            }
        } catch (e) { resolve([]); }
    });
}

function seeds(node, si) {
    const hosts = [], domains = [], users = [], serials = [];
    const add = function (list, v) { if (typeof v === 'string' && v.trim() && list.indexOf(v.trim()) < 0) list.push(v.trim()); };
    if (isObj(node)) {
        add(hosts, node.name); add(hosts, node.rname);
        if (typeof node.host === 'string' && !/^[\d.:[\]]+$/.test(node.host)) add(hosts, node.host);
        for (const k of ['users', 'lusers', 'upnusers']) if (Array.isArray(node[k])) node[k].slice(0, 50).forEach(function (u) { add(users, u); });
    }
    const h = isObj(si) && isObj(si.hardware) ? si.hardware : null;
    if (h) {
        const w = isObj(h.windows) ? h.windows : {};
        const os = isObj(w.osinfo) ? w.osinfo : {};
        add(hosts, os.CSName); add(hosts, os.DNSHostName); add(hosts, os.ComputerName);
        add(domains, os.Domain);
        for (const k of ['linux', 'darwin']) if (isObj(h[k])) { add(hosts, h[k].hostname); add(hosts, h[k].Hostname); }
        if (isObj(h.identifiers)) for (const k of SERIAL_KEYS) add(serials, h.identifiers[k]);
        if (isObj(h.linux)) for (const k of ['product_serial', 'board_serial', 'chassis_serial', 'product_uuid']) add(serials, h.linux[k]);
    }
    return { hosts: hosts, domains: domains, users: users, serials: serials };
}

module.exports = { getDoc, nodeSummary, sysinfoSummary, networkSummary, lastConnect, notes, deviceInfo, deviceEvents, seeds, unEscapeFieldName };
