'use strict';
/**
 * Per-conversation deterministic pseudonymizer + restorer.
 *
 * create({ seeds, enabled }) returns an instance whose mapping (real value <-> token) lives only in memory on the
 * server. Tokens are KIND_n (USER_1, HOST_1, DOMAIN_1, IP_1, MAC_1, EMAIL_1, SID_1, SECRET_1, SERIAL_1), numbered per
 * kind in first-seen order. Host, user, domain and email values are matched case-insensitively (the first-seen
 * spelling is what restore() gives back). SECRET_n never restores to the secret, only to "[secret]".
 *
 * Text that already looks like one of our tokens is escaped before redaction ("HOST_1" -> "HOST\u20171") so a
 * log line cannot make the restorer reveal a real value, and restored back to the original text afterwards.
 *
 * Kept literal on purpose (not identifying, useful for diagnosis): well-known accounts and groups such as SYSTEM,
 * LOCAL SERVICE, NETWORK SERVICE, ANONYMOUS LOGON, Administrator, Guest, DefaultAccount, root, nobody, DWM-n/UMFD-n,
 * and well-known domains such as NT AUTHORITY, BUILTIN, NT SERVICE, Window Manager, Font Driver Host, WORKGROUP,
 * AzureAD. Also kept: loopback/unspecified/broadcast IPs and 255.x netmasks, well-known SIDs (S-1-5-18, S-1-5-32-544,
 * S-1-5-80-... service SIDs), all-zero/broadcast MACs. Machine accounts ("PC01$") become "HOST_n$".
 *
 * Best effort: free-form text can always carry identifying data the patterns do not recognize.
 */

const net = require('node:net');

const KINDS = ['USER', 'HOST', 'DOMAIN', 'IP', 'MAC', 'EMAIL', 'SID', 'SECRET', 'SERIAL'];
const PLURAL = { USER: 'users', HOST: 'hosts', DOMAIN: 'domains', IP: 'ips', MAC: 'macs', EMAIL: 'emails', SID: 'sids', SECRET: 'secrets', SERIAL: 'serials' };
const CI_KINDS = new Set(['USER', 'HOST', 'DOMAIN', 'EMAIL', 'MAC', 'IP']);
const KIND_ALT = KINDS.join('|');
// One regex for "looks like a token": used for escaping input and for restoring output, so both agree.
const TOKEN_RE_SRC = '(?<![A-Za-z0-9_])(' + KIND_ALT + ')([_\\u2017])(\\d+)(?![A-Za-z0-9_])';
const ESC = '\u2017';
const M_OPEN = '\uE002', M_MID = '\uE003', M_CLOSE = '\uE004';

const DEFAULT_ENABLED = { secrets: true, emails: true, sids: true, macs: true, ips: true, users: true, paths: true, hosts: true, serials: false };

const KEEP_USERS = new Set([
    '', '-', '--', 'n/a', 'na', 'none', 'null', 'unknown', '*', 'system', 'local service', 'network service', 'localservice',
    'networkservice', 'anonymous logon', 'anonymous', 'administrator', 'administrators', 'guest', 'defaultaccount',
    'wdagutilityaccount', 'defaultuser0', 'default', 'default user', 'public', 'all users', 'users', 'everyone',
    'trustedinstaller', 'iusr', 'root', 'nobody', 'daemon', 'sshd', 'gdm', 'lightdm', 'polkitd', 'messagebus', 'www-data',
    'krbtgt', 'self', 'creator owner', 'authenticated users', 'interactive', 'service', 'batch', 'dialup', 'network',
    'local system', 'localsystem', 'nt authority', 'user', 'yes', 'no', 'true', 'false'
]);
const KEEP_USER_RE = /^(?:DWM-\d+|UMFD-\d+|systemd-[\w-]+|_[\w-]+|\d+|%%\d+|0x[0-9a-f]+|S-1-[\d-]+|\$|HOST_\d+\$?)$/i;
const KEEP_DOMAINS = new Set([
    '', '-', 'n/a', 'nt authority', 'builtin', 'nt service', 'window manager', 'font driver host', 'iis apppool',
    'workgroup', 'nt virtual machine', 'azuread', 'microsoftaccount', 'local', 'localhost', 'localdomain', 'nt-authority'
]);
// Registry roots and similar "X\Y" that are not DOMAIN\user.
const NOT_DOMAIN_RE = /^(?:HK(?:LM|CU|CR|U|CC)|HKEY_\w+|REGISTRY|Device|Driver|Global\?\?|GLOBALROOT|SystemRoot|Windows|Program Files|ProgramData|Microsoft|SOFTWARE|SYSTEM|CurrentControlSet|Services)$/i;
const KEEP_HOSTS = new Set(['', '-', 'localhost', 'n/a', 'unknown', 'local', 'localdomain', 'workgroup', '127.0.0.1', '::1']);
const SECRET_VALUE_SKIP = /^(?:yes|no|true|false|none|null|n\/a|-|\*+|empty|required|invalid|expired|missing|set|unset|redacted|\[secret\]|%%\d+|0|1)$/i;
const SYSTEMD_SUFFIX = /\.(?:service|socket|target|mount|automount|timer|slice|scope|path|device|swap)$/i;

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function isStr(s) { return typeof s === 'string'; }

function create(opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    const en = Object.assign({}, DEFAULT_ENABLED);
    if (opts.enabled && typeof opts.enabled === 'object') {
        for (const k of Object.keys(DEFAULT_ENABLED)) if (opts.enabled[k] !== undefined) en[k] = !!opts.enabled[k];
    }

    const byKey = new Map();    // KIND + '\0' + normalized value -> token
    const byToken = new Map();  // token -> original value (first-seen spelling)
    const next = {}; for (const k of KINDS) next[k] = 0;
    const escaped = new Set();  // token-like strings that were present in the input (as KIND_n)

    function tok(kind, value) {
        if (!isStr(value)) return value;
        const v = value;
        if (v === '') return v;
        if (byToken.has(v)) return v;
        const key = kind + '\0' + (CI_KINDS.has(kind) ? v.toLowerCase() : v);
        let t = byKey.get(key);
        if (!t) {
            t = kind + '_' + (++next[kind]);
            byKey.set(key, t);
            byToken.set(t, v);
        }
        return t;
    }
    function isOurToken(v) { return byToken.has(v); }

    // ---- seeds --------------------------------------------------------------------------------------------------
    const seedHosts = new Set(), seedDomains = new Set(), seedUsers = new Set(), seedSerials = new Set();
    const seeds = (opts.seeds && typeof opts.seeds === 'object') ? opts.seeds : {};
    const asList = (x) => Array.isArray(x) ? x : (isStr(x) ? [x] : []);
    function addUserSeed(u) {
        if (!isStr(u)) return;
        u = u.trim();
        if (!u) return;
        let m = /^([^\\]+)\\(.+)$/.exec(u);
        if (m) { addDomainSeed(m[1]); u = m[2]; }
        m = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(u);
        if (m) { addDomainSeed(m[2]); u = m[1]; }
        if (u.length >= 3 && !KEEP_USERS.has(u.toLowerCase()) && !KEEP_USER_RE.test(u)) seedUsers.add(u);
    }
    function addDomainSeed(d) {
        if (!isStr(d)) return;
        d = d.trim().replace(/^\.+|\.+$/g, '');
        if (d.length >= 2 && !KEEP_DOMAINS.has(d.toLowerCase())) seedDomains.add(d);
    }
    function addHostSeed(h) {
        if (!isStr(h)) return;
        h = h.trim().replace(/\$$/, '');
        if (!h || KEEP_HOSTS.has(h.toLowerCase()) || net.isIP(h)) return;
        const dot = h.indexOf('.');
        if (dot > 0) { addDomainSeed(h.slice(dot + 1)); h = h.slice(0, dot); }
        if (h.length >= 2) seedHosts.add(h);
    }
    asList(seeds.hosts).forEach(addHostSeed);
    asList(seeds.domains).forEach(addDomainSeed);
    asList(seeds.users).forEach(addUserSeed);
    asList(seeds.serials).forEach((s) => { if (isStr(s) && s.trim().length >= 4) seedSerials.add(s.trim()); });

    const byLenDesc = (a, b) => b.length - a.length;
    const B_L = '(?<![\\p{L}\\p{N}_\\-])', B_R = '(?![\\p{L}\\p{N}_\\-])';
    const hostRe = seedHosts.size ? new RegExp(B_L + '(' + [...seedHosts].sort(byLenDesc).map(esc).join('|') + ')' + B_R, 'giu') : null;
    const domList = [...seedDomains].sort(byLenDesc).map(esc).join('|');
    // FQDN under a seeded domain: leading labels become a HOST, the domain a DOMAIN.
    const fqdnRe = seedDomains.size ? new RegExp('(?<![\\p{L}\\p{N}_.\\-])((?:[\\p{L}\\p{N}_\\-]{1,63}\\.){1,6}?)(' + domList + ')(?![\\p{L}\\p{N}_\\-]|\\.[\\p{L}\\p{N}])', 'giu') : null;
    const domRe = seedDomains.size ? new RegExp(B_L + '(' + domList + ')(?![\\p{L}\\p{N}_\\-]|\\.[\\p{L}\\p{N}])', 'giu') : null;
    const userRe = seedUsers.size ? new RegExp(B_L + '(' + [...seedUsers].sort(byLenDesc).map(esc).join('|') + ')' + B_R, 'giu') : null;
    const serialRe = seedSerials.size ? new RegExp(B_L + '(' + [...seedSerials].sort(byLenDesc).map(esc).join('|') + ')' + B_R, 'gu') : null;

    // ---- value helpers ------------------------------------------------------------------------------------------
    function keepUser(v) { return KEEP_USERS.has(v.toLowerCase()) || KEEP_USER_RE.test(v) || isOurToken(v); }
    function userTok(v) {
        if (!isStr(v)) return v;
        const t = v.trim();
        if (!t || keepUser(t)) return v;
        if (/\$$/.test(t) && t.length > 1) return en.hosts ? hostTok(t.slice(0, -1)) + '$' : v; // machine account
        if (t.includes('\\')) return domUser(t);
        if (!en.users) return v;
        return v.replace(t, tok('USER', t));
    }
    function hostTok(v) {
        if (!en.hosts || !isStr(v)) return v;
        const t = v.trim();
        if (!t || KEEP_HOSTS.has(t.toLowerCase()) || isOurToken(t) || net.isIP(t)) return v;
        return v.replace(t, tok('HOST', t));
    }
    function domTok(v) {
        if (!en.hosts || !isStr(v)) return v;
        const t = v.trim();
        if (!t || KEEP_DOMAINS.has(t.toLowerCase()) || isOurToken(t)) return v;
        return v.replace(t, tok('DOMAIN', t));
    }
    function domUser(s) {
        const i = s.indexOf('\\');
        const d = s.slice(0, i), u = s.slice(i + 1);
        if (KEEP_DOMAINS.has(d.toLowerCase())) return d + '\\' + (d.toLowerCase() === 'azuread' || d.toLowerCase() === 'microsoftaccount' ? userTok(u) : u);
        if (keepUser(u)) return domTok(d) + '\\' + u;
        return domTok(d) + '\\' + userTok(u);
    }

    // ---- passes -------------------------------------------------------------------------------------------------
    function passSecrets(s) {
        // PEM private keys
        s = s.replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, (m) => tok('SECRET', m));
        // URL userinfo password
        s = s.replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:)([^\s@/]{1,256})(@)/gi, (m, a, p, c) => a + tok('SECRET', p) + c);
        // Authorization headers
        s = s.replace(/\b(Authorization\s*[:=]\s*)(?:(Bearer|Basic|Token|Digest|Negotiate|NTLM)\s+)?([^\s,;"']+)/gi,
            (m, a, scheme, v) => SECRET_VALUE_SKIP.test(v) ? m : a + (scheme ? scheme + ' ' : '') + tok('SECRET', v));
        s = s.replace(/\b(Bearer\s+)([A-Za-z0-9\-._~+/]{8,}=*)/gi, (m, a, v) => isOurToken(v) ? m : a + tok('SECRET', v));
        // JWT
        s = s.replace(/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, (m) => tok('SECRET', m));
        // AWS access key ids
        s = s.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, (m) => tok('SECRET', m));
        // keyword = value / keyword: value  (quoted or bare)
        s = s.replace(/(?<![A-Za-z0-9_-])((?:[A-Za-z0-9]{1,24}[_-]){0,3}(?:password|passwd|passphrase|pwd|token|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key))(\s*)([=:])(\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;&'"<>]+))/gi,
            (m, kw, s1, sep, s2, dq, sq, bare) => {
                const v = dq !== undefined ? dq : (sq !== undefined ? sq : bare);
                if (v === undefined || v === '' || SECRET_VALUE_SKIP.test(v) || isOurToken(v)) return m;
                if (/^pwd$/i.test(kw) && /^[/~]/.test(v)) return m;           // sudo "PWD=/home/x" is a directory
                if (sep === ':' && v.length < 4) return m;
                const t = tok('SECRET', v);
                const q = dq !== undefined ? '"' : (sq !== undefined ? "'" : '');
                return kw + s1 + sep + s2 + q + t + q;
            });
        // long key material right after a keyword: "api key 3f2a...", "token: AbC..."
        s = s.replace(/\b((?:api[ _-]?key|key|token|secret|password)\s+)([A-Za-z0-9+/=_-]{32,})/gi, (m, a, v) =>
            (/[0-9]/.test(v) && /[A-Za-z]/.test(v) && !isOurToken(v) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) ? a + tok('SECRET', v) : m);
        return s;
    }
    function passEmails(s) {
        return s.replace(/(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24})(?![A-Za-z0-9-])/g, (m, u, d) => {
            if (SYSTEMD_SUFFIX.test(m)) return m;
            return tok('EMAIL', m);
        });
    }
    function passSids(s) {
        return s.replace(/\bS-1-(?:5-21|12-1)(?:-\d+){3,5}\b/g, (m) => tok('SID', m));
    }
    function passMacs(s) {
        return s.replace(/(?<![0-9A-Fa-f:\-.])([0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\2){4}[0-9A-Fa-f]{2})(?![0-9A-Fa-f:\-]|\.[0-9A-Fa-f])/g, (m) => {
            if (/^(?:00[:-]){5}00$/i.test(m) || /^(?:ff[:-]){5}ff$/i.test(m)) return m;
            return tok('MAC', m);
        });
    }
    const OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
    const IPV4_RE = new RegExp('(?<![\\w.])(' + OCT + '\\.' + OCT + '\\.' + OCT + '\\.' + OCT + ')(?![\\w]|\\.\\d)', 'g');
    function keepIp4(ip) { return /^127\./.test(ip) || ip === '0.0.0.0' || /^255\./.test(ip); }
    function passIps(s) {
        // IPv6 first (may embed a dotted IPv4 tail)
        s = s.replace(/(?<![\w:.])((?=[0-9A-Fa-f:]*:[0-9A-Fa-f]*:)[0-9A-Fa-f:]{2,39}(?:(?<=:)\d{1,3}(?:\.\d{1,3}){3})?)(%[A-Za-z0-9_.-]{1,32})?(?![\w:]|\.\d)/g, (m, ip) => {
            if (!net.isIPv6(ip)) return m;
            const l = ip.toLowerCase();
            if (l === '::1' || l === '::' || /^(?:0{1,4}:){7}0{0,3}[01]$/.test(l)) return m;
            return tok('IP', m);
        });
        s = s.replace(IPV4_RE, (m, ip, off, str) => {
            if (keepIp4(ip)) return m;
            const before = str.slice(Math.max(0, off - 12), off);
            if (/(?:version|ver\.?|v|build|release)\s*[:=]?\s*$/i.test(before)) return m;
            return tok('IP', m);
        });
        return s;
    }
    const DOMUSER_RE = /(?<![\p{L}\p{N}_\\.:/$%-])(NT AUTHORITY|NT SERVICE|Window Manager|Font Driver Host|IIS APPPOOL|NT VIRTUAL MACHINE|\p{L}[\p{L}\p{N}_.-]{0,62})\\([\p{L}\p{N}_.$-]{1,64})(?![\\\p{L}\p{N}_.$-])/giu;
    const USER_FIELD_RE = /\b(Account Name|User Name|Logon Account|Target User Name|TargetUserName|SubjectUserName|Account For Which Logon Failed|Client User Name|User)([ \t]*[:=][ \t]*)([^\r\n\t]*)/g;
    const HOST_FIELD_RE = /\b(Workstation Name|Source Workstation|Workstation|Caller Computer Name|Client Name|Computer Name|WorkstationName)([ \t]*[:=][ \t]*)([^\r\n\t]*)/g;
    const DOM_FIELD_RE = /\b(Account Domain|Supplied Realm Name|User Domain|TargetDomainName|SubjectDomainName)([ \t]*[:=][ \t]*)([^\r\n\t]*)/g;
    // Cut a field value at the next "Some Label:" (messages whose whitespace was collapsed) and trim it.
    function fieldValue(raw) {
        let v = raw;
        const cut = /\s+[A-Z][A-Za-z]*(?: [A-Za-z]+){0,4}:/.exec(v);
        if (cut) v = v.slice(0, cut.index);
        return v.replace(/\s+$/, '');
    }
    function passFields(s, re, fn) {
        return s.replace(re, (m, label, sep, raw) => {
            const v = fieldValue(raw);
            if (!v) return m;
            return label + sep + fn(v) + raw.slice(v.length);
        });
    }
    function passUsers(s) {
        if (en.users || en.hosts) {
            s = s.replace(DOMUSER_RE, (m, d, u) => {
                if (NOT_DOMAIN_RE.test(d) || /^[A-Za-z]$/.test(d)) return m;
                if (/^\d+(?:\.\d+)*$/.test(d)) return m;
                return domUser(d + '\\' + u);
            });
            s = passFields(s, USER_FIELD_RE, (v) => {
                if (/^(?:N\/A|-|%%\d+)$/i.test(v)) return v;
                if (/\s/.test(v) && !keepUser(v)) {
                    // "John Smith" or "CORP\bob something": take the first word unless the whole value looks like a name
                    if (/^[\p{L}][\p{L}.'-]*(?: [\p{L}][\p{L}.'-]*){1,2}$/u.test(v)) return userTok(v);
                    const first = v.split(/\s+/)[0];
                    return userTok(first) + v.slice(first.length);
                }
                return userTok(v);
            });
            s = passFields(s, DOM_FIELD_RE, (v) => /\s/.test(v) && !KEEP_DOMAINS.has(v.toLowerCase()) ? v : domTok(v));
            s = passFields(s, HOST_FIELD_RE, (v) => /\s/.test(v) ? v : (/\$$/.test(v) ? hostTok(v.slice(0, -1)) + '$' : hostTok(v)));
        }
        if (en.users) {
            s = s.replace(/\b((?:r|login|logname|SUDO_)?user|USER|acct|LOGNAME|ruser|username|uname)(=)("?)([^\s"';,()]+)\3/g, (m, k, eq, q, v) => {
                if (keepUser(v)) return m;
                return k + eq + q + userTok(v) + q;
            });
            s = s.replace(/\bfor (invalid |illegal )?user ([^\s"';,()]+)/g, (m, inv, v) => keepUser(v) ? m : 'for ' + (inv || '') + 'user ' + userTok(v));
            s = s.replace(/\b(Invalid user |Accepted \w+ for |Failed \w+ for |Disconnected from user |session (?:opened|closed) for |by user )([^\s"';,()]+)/g, (m, a, v) => {
                if (/^(?:invalid|illegal|user)$/i.test(v) || keepUser(v)) return m;
                return a + userTok(v);
            });
            s = s.replace(/\b(by )([\w.$-]+)(?=\(uid=)/g, (m, a, v) => keepUser(v) ? m : a + userTok(v));
            s = s.replace(/\b(sudo:\s{1,8})([\w.$-]+)(?= : )/g, (m, a, v) => keepUser(v) ? m : a + userTok(v));
        }
        return s;
    }
    function passPaths(s) {
        s = s.replace(/((?:\b[A-Za-z]:|\\\\[^\\\s]+\\[^\\\s]+|(?<![\w\\]))\\+(?:Users|Documents and Settings)\\+)(?:([^\\/:*?"<>|\r\n\t]{1,64}?)(?=\\)|([^\\/:*?"<>|\s]{1,64})(?=$|["'\s,;)\]]))/gi, (m, pre, u1, u2) => {
            const u = u1 !== undefined ? u1 : u2;
            if (keepUser(u) || /^(?:All Users|Default User|Default|Public|defaultuser\d*)$/i.test(u)) return m;
            return pre + userTok(u);
        });
        s = s.replace(/(?<![\w.])(\/(?:home|Users|var\/home)\/)([^/\s"':;,]+)/g, (m, pre, u) => keepUser(u) ? m : pre + userTok(u));
        return s;
    }
    function passSeeds(s) {
        if (en.hosts && hostRe) s = s.replace(hostRe, (m) => isOurToken(m) ? m : tok('HOST', m));
        if (en.hosts && fqdnRe) {
            s = s.replace(fqdnRe, (m, labels, dom) => {
                const h = labels.slice(0, -1);
                const hostPart = isOurToken(h) ? h : (/^(?:www|_[\w-]+)$/i.test(h) ? h : tok('HOST', h));
                return hostPart + '.' + tok('DOMAIN', dom);
            });
        }
        if (en.hosts && domRe) s = s.replace(domRe, (m) => isOurToken(m) ? m : tok('DOMAIN', m));
        if (en.users && userRe) s = s.replace(userRe, (m) => isOurToken(m) ? m : tok('USER', m));
        return s;
    }
    function passSerials(s) {
        if (serialRe) s = s.replace(serialRe, (m) => tok('SERIAL', m));
        s = s.replace(/\b(Serial(?:[ _]?Number)?|S\/N|SerialNo)([ \t]*[:=][ \t]*)("?)([A-Za-z0-9][A-Za-z0-9._-]{3,63})\3/gi, (m, k, sep, q, v) => {
            if (SECRET_VALUE_SKIP.test(v) || /^(?:0+|To be filled by O\.E\.M\.|Default string|None)$/i.test(v) || isOurToken(v)) return m;
            return k + sep + q + tok('SERIAL', v) + q;
        });
        return s;
    }

    const escRe = new RegExp(TOKEN_RE_SRC, 'g');
    function redact(str) {
        if (!isStr(str)) return str == null ? '' : String(str);
        if (!str) return str;
        let s = str.replace(escRe, (m, k, sep, n) => {
            if (sep !== '_') return m;
            escaped.add(k + '_' + n);
            return k + ESC + n;
        });
        try {
            if (en.secrets) s = passSecrets(s);
            if (en.emails) s = passEmails(s);
            if (en.sids) s = passSids(s);
            if (en.macs) s = passMacs(s);
            if (en.ips) s = passIps(s);
            s = passUsers(s);
            if (en.paths) s = passPaths(s);
            s = passSeeds(s);
            if (en.serials) s = passSerials(s);
        } catch (e) {
            return s; // never throw; partial redaction is still better than none
        }
        return s;
    }

    function redactValue(v, depth) {
        depth = depth || 0;
        if (depth > 64) return null;
        if (isStr(v)) return redact(v);
        if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
        if (v && typeof v === 'object') {
            if (v instanceof Date) return new Date(v.getTime());
            const o = {};
            for (const k of Object.keys(v)) o[k] = redactValue(v[k], depth + 1);
            return o;
        }
        return v;
    }

    function restoreOne(m, k, sep, n, mark) {
        const t = k + '_' + n;
        if (sep === ESC) return escaped.has(t) ? t : m;
        if (!byToken.has(t)) return m;
        const val = k === 'SECRET' ? '[secret]' : byToken.get(t);
        return mark ? M_OPEN + k.toLowerCase() + M_MID + val + M_CLOSE : val;
    }
    function restore(str, o) {
        if (!isStr(str)) return str == null ? '' : String(str);
        const mark = !!(o && o.mark);
        return str.replace(new RegExp(TOKEN_RE_SRC, 'g'), (m, k, sep, n) => restoreOne(m, k, sep, n, mark));
    }

    // Streaming restorer: holds back a trailing piece that could still become (or grow into) a token.
    const KIND_PREFIXES = new Set();
    for (const k of KINDS) for (let i = 1; i <= k.length; i++) KIND_PREFIXES.add(k.slice(0, i));
    function restorer(o) {
        const mark = !!(o && o.mark);
        let pending = '';
        let ctx = '';   // last character already emitted (for the look-behind at the start of the buffer)
        function out(text) {
            if (!text) return '';
            const r = restore(ctx + text, { mark: mark }).slice(ctx.length);
            ctx = text.slice(-1);
            return r;
        }
        return {
            push(chunk) {
                if (chunk == null) return '';
                const buf = pending + String(chunk);
                const tail = /(?<![A-Za-z0-9_])([A-Z]{1,6})([_\u2017]\d*)?$/.exec(buf);
                let hold = -1;
                if (tail) {
                    const startOk = tail.index > 0 || !/[A-Za-z0-9_]/.test(ctx);
                    if (startOk && (tail[2] === undefined ? KIND_PREFIXES.has(tail[1]) : KINDS.includes(tail[1]))) hold = tail.index;
                }
                if (hold < 0) { pending = ''; return out(buf); }
                pending = buf.slice(hold);
                return out(buf.slice(0, hold));
            },
            flush() {
                const p = pending; pending = '';
                return out(p);
            }
        };
    }

    function counts() {
        const c = {};
        for (const k of KINDS) c[PLURAL[k]] = next[k];
        return c;
    }
    function total() { let t = 0; for (const k of KINDS) t += next[k]; return t; }

    return { redact, redactValue: (v) => redactValue(v, 0), restore, restorer, counts, total, enabled: Object.assign({}, en) };
}

module.exports = { create, KINDS };
