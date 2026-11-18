/**
* @description MeshCentral-EventLog SQL storage backend (PostgreSQL / MariaDB / MySQL / SQLite)
* @license Apache-2.0
*
* MeshCentral keeps its own connection for these engines private (only SQLite exposes db.file), so
* pg / MariaDB / MySQL get a small pool of their own built from the same meshcentral config, while
* SQLite shares MeshCentral's handle - opening a second handle on the same file would fight it for
* the write lock and miss its PRAGMA setup. Either way the tables live in MeshCentral's own
* database, so whatever backs it up covers them too.
*/

"use strict";

const T_EV = 'plugin_eventlog_events';
const T_SET = 'plugin_eventlog_settings';
const T_AUD = 'plugin_eventlog_ai_audit';   // Assistant audit log (v0.2.0)
const T_CHAT = 'plugin_eventlog_ai_chats';  // Assistant saved results: chats, last diagnosis, explanations (v0.4.0)
const EVCOLS = ['nodeid', 'tc', 'time', 'level', 'logname', 'provider', 'eventid', 'eventid_num', 'message', 'extra'];
const SWEEP_CHUNK = 5000;
const ASSIGN_CHUNK = 500;

// Connection settings, accepting both shapes MeshCentral accepts (a URL string or an object with
// an ssl block naming certificate files). MeshCentral defaults a missing database name to
// 'meshcentral' but applies it to a CLONE of the config (its db.js), so args still has no
// database - the caller must apply the same default or every query fails with "no database
// selected". Parsing never throws: this runs inside server_startup, which has no error handling.
function connConfig(raw) {
    if (raw == null) return {};
    if (typeof raw == 'string') {
        var c = {};
        try {
            var u = new URL(raw);
            c.host = decodeURIComponent(u.hostname);
            if (u.port) c.port = Number(u.port);
            if (u.username) c.user = decodeURIComponent(u.username);
            if (u.password) c.password = decodeURIComponent(u.password);
            var dbn = decodeURIComponent(String(u.pathname || '').replace(/^\//, ''));
            if (dbn != '') c.database = dbn;
        } catch (e) {
            // not a URL: fall back to how MeshCentral itself splits a connection string
            var parts = raw.split(/[:@/]+/);
            if (parts.length >= 5) { c.user = parts[1]; c.password = parts[2]; c.host = parts[3]; c.port = Number(parts[4]); if (parts[5]) c.database = parts[5]; }
            else { console.log('EVENTLOG: could not parse the database connection string'); }
        }
        return c;
    }
    var o = Object.assign({}, raw);
    if (o.ssl != null && typeof o.ssl == 'object') {
        var fs = require('fs'), ssl = {};
        try {
            if (o.ssl.cacertpath) ssl.ca = fs.readFileSync(o.ssl.cacertpath);
            if (o.ssl.clientcertpath) ssl.cert = fs.readFileSync(o.ssl.clientcertpath);
            if (o.ssl.clientkeypath) ssl.key = fs.readFileSync(o.ssl.clientkeypath);
        } catch (e) { console.log('EVENTLOG: could not read a TLS certificate file: ' + e.message); }
        if (o.ssl.dontcheckserveridentity === true) ssl.rejectUnauthorized = false;
        o.ssl = ssl;
    }
    return o;
}

function toNum(v) {
    if (v == null) return null;
    if (typeof v == 'bigint') return Number(v);          // mariadb/mysql BIGINT
    var n = Number(v);                                    // pg returns BIGINT and COUNT(*) as strings
    return isNaN(n) ? null : n;
}
function parseDoc(v) {
    if (v == null) return {};
    if (typeof v == 'string') { try { return JSON.parse(v); } catch (e) { return {}; } }
    if (Buffer.isBuffer(v)) { try { return JSON.parse(v.toString('utf8')); } catch (e) { return {}; } }
    return v;
}
function trunc(v, n) {
    if (v == null) return null;
    v = String(v);
    return (v.length > n) ? v.substring(0, n) : v;
}
function newId() { return require('crypto').randomBytes(12).toString('hex'); }

// install the SQL implementation onto the object CreateDB built (which already carries the
// backend-independent helpers from db.js)
module.exports.install = function (obj, meshserver, kind, shared) {
    var pool = null, sqlite = null, mysqlPool = null;
    var D = {};

    // ---- dialect ---------------------------------------------------------
    if (kind == 'pg') {
        var pg = shared.loadModule(['pg']);
        var pgcfg = Object.assign({}, connConfig(meshserver.args.postgres), { max: 3 });
        if (pgcfg.database == null) pgcfg.database = 'meshcentral';
        pool = new pg.Pool(pgcfg);
        // without this an idle connection error is an unhandled 'error' event and takes the server down
        pool.on('error', function (e) { console.log('EVENTLOG: postgres pool error: ' + (e.message || e)); });
        D.query = function (sql, params) {
            return pool.query(sql, params || []).then(function (r) { return { rows: r.rows || [], affected: r.rowCount || 0 }; });
        };
        D.ph = function (i) { return '$' + i; };
        D.like = 'ILIKE';
        D.jsonType = 'JSON';
        D.end = function () { return pool.end(); };
    } else if (kind == 'mariadb') {
        var mariadb = shared.loadModule(['mariadb']);
        var macfg = Object.assign({}, connConfig(meshserver.args.mariadb), {
            connectionLimit: 3, bigIntAsNumber: true, insertIdAsNumber: true, decimalAsNumber: true
        });
        if (macfg.database == null) macfg.database = 'meshcentral';   // same default MeshCentral applies
        pool = mariadb.createPool(macfg);
        D.query = function (sql, params) {
            return pool.query(sql, params || []).then(function (r) {
                if (Array.isArray(r)) return { rows: r, affected: r.length };
                return { rows: [], affected: toNum(r.affectedRows) || 0, insertId: toNum(r.insertId) };
            });
        };
        D.ph = function () { return '?'; };
        D.like = 'LIKE';
        D.jsonType = 'JSON';
        D.end = function () { return pool.end(); };
    } else if (kind == 'mysql') {
        var mysql2 = shared.loadModule(['mysql2']);
        var mycfg = Object.assign({}, connConfig(meshserver.args.mysql), {
            connectionLimit: 3, waitForConnections: true
        });
        if (mycfg.database == null) mycfg.database = 'meshcentral';   // same default MeshCentral applies
        mysqlPool = mysql2.createPool(mycfg);
        pool = mysqlPool.promise();
        D.query = function (sql, params) {
            // query(), not execute(): no prepared-statement cache to grow, and array params stay literal
            return pool.query(sql, params || []).then(function (res) {
                var r = res[0];
                if (Array.isArray(r)) return { rows: r, affected: r.length };
                return { rows: [], affected: toNum(r.affectedRows) || 0, insertId: toNum(r.insertId) };
            });
        };
        D.ph = function () { return '?'; };
        D.like = 'LIKE';
        D.jsonType = 'JSON';
        D.end = function () { return new Promise(function (res) { mysqlPool.end(function () { res(); }); }); };
    } else { // sqlite: share MeshCentral's handle
        sqlite = meshserver.db.file;
        D.query = function (sql, params) {
            return new Promise(function (resolve, reject) {
                if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
                    sqlite.all(sql, params || [], function (err, rows) {
                        if (err) reject(err); else resolve({ rows: rows || [], affected: (rows || []).length });
                    });
                } else {
                    sqlite.run(sql, params || [], function (err) {
                        if (err) reject(err); else resolve({ rows: [], affected: this.changes || 0, insertId: this.lastID });
                    });
                }
            });
        };
        D.ph = function () { return '?'; };
        D.like = 'LIKE';   // ASCII-only case folding, see the changelog
        D.jsonType = 'TEXT';
        D.end = function () { return Promise.resolve(); };   // not ours to close
    }
    var isMy = (kind == 'mysql' || kind == 'mariadb');
    // 10 columns per row: keep well under pg's 65535 parameter cap and SQLite's 999 variable limit
    var rowsPerInsert = (kind == 'sqlite') ? 90 : 200;

    // ---- schema ----------------------------------------------------------
    function ddl() {
        var stmts = [];
        if (isMy) {
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_EV + ' (' +
                'id BIGINT NOT NULL AUTO_INCREMENT, nodeid VARCHAR(256) NOT NULL, tc BIGINT NOT NULL, time BIGINT NOT NULL, ' +
                'level SMALLINT, logname VARCHAR(255), provider VARCHAR(255), eventid VARCHAR(64), eventid_num BIGINT, ' +
                // MEDIUMTEXT: a >64KB message would fail the whole multi-row INSERT under strict mode
                'message MEDIUMTEXT, extra JSON, PRIMARY KEY (id), ' +
                'INDEX ' + T_EV + '_node_tc (nodeid, tc), INDEX ' + T_EV + '_time (time)' +
                ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_SET + ' (' +
                'id VARCHAR(256) NOT NULL, type VARCHAR(32) NOT NULL, extra VARCHAR(256), doc JSON, ' +
                'PRIMARY KEY (id), INDEX ' + T_SET + '_type_extra (type, extra)' +
                ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_AUD + ' (' +
                'id BIGINT NOT NULL AUTO_INCREMENT, time BIGINT NOT NULL, userid VARCHAR(256), nodeid VARCHAR(256), doc JSON, ' +
                'PRIMARY KEY (id), INDEX ' + T_AUD + '_time (time), INDEX ' + T_AUD + '_user_time (userid, time)' +
                ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
            // JSON columns: a saved chat document is at most 512 KB (ai/history.js), well within max_allowed_packet
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_CHAT + ' (' +
                'id VARCHAR(64) NOT NULL, time BIGINT NOT NULL, userid VARCHAR(256) NOT NULL, nodeid VARCHAR(256) NOT NULL, kind VARCHAR(16) NOT NULL, meta JSON, doc JSON, ' +
                'PRIMARY KEY (id), INDEX ' + T_CHAT + '_user_node_time (userid, nodeid, time), INDEX ' + T_CHAT + '_time (time)' +
                ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        } else {
            var serial = (kind == 'pg') ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY';
            var vc = function (n) { return (kind == 'pg') ? ('VARCHAR(' + n + ')') : 'TEXT'; };
            var big = (kind == 'pg') ? 'BIGINT' : 'INTEGER';
            var small = (kind == 'pg') ? 'SMALLINT' : 'INTEGER';
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_EV + ' (' +
                'id ' + serial + ', nodeid ' + vc(256) + ' NOT NULL, tc ' + big + ' NOT NULL, time ' + big + ' NOT NULL, ' +
                'level ' + small + ', logname ' + vc(255) + ', provider ' + vc(255) + ', eventid ' + vc(64) + ', eventid_num ' + big + ', ' +
                'message TEXT, extra ' + D.jsonType + ')');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_EV + '_node_tc ON ' + T_EV + ' (nodeid, tc DESC)');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_EV + '_time ON ' + T_EV + ' (time)');
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_SET + ' (' +
                'id ' + vc(256) + ' PRIMARY KEY NOT NULL, type ' + vc(32) + ' NOT NULL, extra ' + vc(256) + ', doc ' + D.jsonType + ')');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_SET + '_type_extra ON ' + T_SET + ' (type, extra)');
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_AUD + ' (' +
                'id ' + serial + ', time ' + big + ' NOT NULL, userid ' + vc(256) + ', nodeid ' + vc(256) + ', doc ' + D.jsonType + ')');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_AUD + '_time ON ' + T_AUD + ' (time)');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_AUD + '_user_time ON ' + T_AUD + ' (userid, time)');
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_CHAT + ' (' +
                'id ' + vc(64) + ' PRIMARY KEY NOT NULL, time ' + big + ' NOT NULL, userid ' + vc(256) + ' NOT NULL, nodeid ' + vc(256) + ' NOT NULL, kind ' + vc(16) + ' NOT NULL, ' +
                'meta ' + D.jsonType + ', doc ' + D.jsonType + ')');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_CHAT + '_user_node_time ON ' + T_CHAT + ' (userid, nodeid, time)');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_CHAT + '_time ON ' + T_CHAT + ' (time)');
        }
        return stmts.reduce(function (p, s) { return p.then(function () { return D.query(s, []); }); }, Promise.resolve());
    }

    // ---- init / ready ----------------------------------------------------
    // Every public call goes through ready(). A failed init is retried rather than cached, and the
    // plugin never quietly falls back to its own files: that silent divergence is the bug this fixes.
    // ready() gates on the schema and the one-time import only. The steps that follow go through
    // the public API (checkForDefault -> getAllConfigSets -> ready()), so they must run after it
    // resolves, not inside it - awaiting the promise being built here would deadlock.
    function ready() {
        if (obj._ready != null) return obj._ready;
        obj._ready = ddl()
        .then(function () { return importFromNedb(); })
        .catch(function (e) {
            obj._ready = null;   // not cached: the retry below (or the next call) tries again
            obj._retry = Math.min((obj._retry || 30000) * 2, 900000);
            console.log('EVENTLOG: ' + kind + ' initialisation failed, retrying in ' + Math.round(obj._retry / 1000) + 's: ' + (e.message || e));
            // one pending retry at a time, so a long outage cannot pile up dead handles
            if (obj._retryTimer != null) { try { clearTimeout(obj._retryTimer); } catch (e3) { } }
            obj._retryTimer = setTimeout(function () { obj._retryTimer = null; bootstrap(); }, obj._retry);
            try { obj._retryTimer.unref(); } catch (e2) { }
            throw e;
        });
        return obj._ready;
    }

    function bootstrap() {
        obj.initialized = ready()
        .then(function () { return obj.checkForDefault(); })
        .then(function () { return obj.applyRetention(); })
        .then(function () { return obj.updateDBVersion(obj.dbVersion); })   // a fresh SQL store starts at the current schema
        .then(function () {
            obj._retry = null;   // a later outage starts from the short backoff again
            obj.startMaintenance();
            console.log('EVENTLOG: ' + kind + ' storage ready');
        })
        .catch(function () { return null; });   // already logged; the retry timer takes it from here
        return obj.initialized;
    }
    // resolves when the backend is fully usable (schema, import, default config, retention)
    obj.ready = function () { return obj.initialized; };

    // One-time carry-over of the plugin's own NeDB settings (config sets and their assignments).
    // Collected events are deliberately not imported: that file can be enormous, reading it means
    // the very full-file NeDB parse this release exists to avoid, the data expires on its own and
    // the agents refill it within a minute.
    function importFromNedb() {
        return D.query('SELECT COUNT(*) AS n FROM ' + T_SET, []).then(function (r) {
            if ((toNum(r.rows[0] && r.rows[0].n) || 0) > 0) return null;
            var file;
            try { file = meshserver.getConfigFilePath('plugin-eventlog-settings.db'); } catch (e) { return null; }
            if (!require('fs').existsSync(file)) return null;
            var Datastore;
            try { Datastore = shared.loadModule(['@seald-io/nedb', '@yetzt/nedb', 'nedb']); } catch (e) { return null; }
            return new Promise(function (resolve) {
                var store = new Datastore({ filename: file, autoload: true });
                store.find({}, function (err, docs) {
                    if (err || docs == null || docs.length == 0) { resolve(null); return; }
                    var work = Promise.resolve(), n = 0;
                    docs.forEach(function (d) {
                        var id = null, extra = null, doc = Object.assign({}, d);
                        delete doc._id;
                        if (d.type == 'configSet') { id = String(d._id); extra = d.uid || null; }        // keep the id: assignments point at it
                        else if (d.type == 'assignedConfig') { id = 'assign:' + d.asset; extra = d.asset; }
                        else if (d.type == 'nodeMeta') { id = 'nodeMeta:' + d.nodeid; extra = d.nodeid; }
                        else if (d.type == 'aiEndpoint' || d.type == 'aiSettings' || d.type == 'aiAck') { id = String(d._id); extra = (d.extra != null) ? String(d.extra) : null; }
                        else return;   // db_version is per-backend
                        n++;
                        work = work.then(function () { return putDoc(id, d.type, extra, doc); });
                    });
                    work.then(function () {
                        if (n > 0) console.log('EVENTLOG: imported ' + n + ' settings from the plugin NeDB file (the plugin-eventlog-*.db files are no longer used)');
                        resolve(null);
                    }).catch(function (e) { console.log('EVENTLOG: settings import failed: ' + (e.message || e)); resolve(null); });
                });
            });
        });
    }

    // ---- generic document helpers (settings table) -----------------------
    function putDoc(id, type, extra, doc) {
        var body = JSON.stringify(doc || {});   // always a string: pg would read a raw array as an array literal
        var p = [id, type, extra, body];
        var sql;
        if (isMy) {
            sql = 'INSERT INTO ' + T_SET + ' (id,type,extra,doc) VALUES (?,?,?,?) ' +
                  'ON DUPLICATE KEY UPDATE type=VALUES(type), extra=VALUES(extra), doc=VALUES(doc)';
        } else {
            sql = 'INSERT INTO ' + T_SET + ' (id,type,extra,doc) VALUES (' + D.ph(1) + ',' + D.ph(2) + ',' + D.ph(3) + ',' + D.ph(4) + ') ' +
                  'ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, extra=EXCLUDED.extra, doc=EXCLUDED.doc';
        }
        return D.query(sql, p);
    }
    function rowToDoc(r) {
        var d = parseDoc(r.doc);
        d._id = r.id;
        return d;
    }
    function docsByType(type, extra) {
        var sql = 'SELECT id, doc FROM ' + T_SET + ' WHERE type = ' + D.ph(1);
        var p = [type];
        if (extra !== undefined) { sql += ' AND extra = ' + D.ph(2); p.push(extra); }
        return D.query(sql, p).then(function (r) { return r.rows.map(rowToDoc); });
    }
    function getDoc(id) {
        return D.query('SELECT id, doc FROM ' + T_SET + ' WHERE id = ' + D.ph(1), [id])
        .then(function (r) { return r.rows[0] ? rowToDoc(r.rows[0]) : null; });
    }
    function delDoc(id) {
        return D.query('DELETE FROM ' + T_SET + ' WHERE id = ' + D.ph(1), [id]).then(function (r) { return r.affected; });
    }

    // ---- events ----------------------------------------------------------
    function toRow(nodeid, e, nowMs) {
        var tc = shared.tcOf(e.TimeCreated);
        var extra = {};
        ['Priority', 'Unit', 'Transport', 'BootId'].forEach(function (k) { if (e[k] != null && e[k] !== '') extra[k] = e[k]; });
        var eid = (e.Id == null) ? null : trunc(e.Id, 64);
        var lvl = Number(e.Level);
        return {
            nodeid: nodeid, tc: tc, time: nowMs,
            level: isNaN(lvl) ? null : lvl,
            logname: trunc(e.LogName, 255),
            provider: trunc(e.ProviderName, 255),
            eventid: eid,
            eventid_num: (eid != null && /^\d{1,15}$/.test(eid)) ? Number(eid) : null,
            message: trunc(e.Message, 262144),
            extra: (Object.keys(extra).length > 0) ? JSON.stringify(extra) : null
        };
    }
    function rowToEvent(r) {
        var tc = toNum(r.tc) || 0;
        var e = {
            _id: String(r.id), nodeid: r.nodeid, tc: tc, time: toNum(r.time),
            Level: toNum(r.level),
            TimeCreated: [String(tc)],      // the digit-array shape the rest of the plugin expects
            LogName: r.logname, ProviderName: r.provider,
            Id: (r.eventid == null) ? '' : r.eventid,
            Message: (r.message == null) ? '' : r.message
        };
        var x = parseDoc(r.extra);
        for (var k in x) e[k] = x[k];
        return e;
    }
    function insertChunk(rows) {
        var params = [], tuples = [], n = 1;
        rows.forEach(function (row) {
            var ph = [];
            EVCOLS.forEach(function (c) { ph.push(D.ph(n++)); params.push(row[c]); });
            tuples.push('(' + ph.join(',') + ')');
        });
        return D.query('INSERT INTO ' + T_EV + ' (' + EVCOLS.join(',') + ') VALUES ' + tuples.join(','), params);
    }

    obj.addEventsFor = function (nodeid, events) {
        if (!Array.isArray(events)) events = [events];   // a single event arrives as a bare object
        events = events.filter(function (e) { return e != null && typeof e == 'object'; });
        if (events.length == 0) return Promise.resolve({ count: 0, maxTc: 0 });
        return ready().then(function () {
            var nowMs = Date.now(), maxTc = 0, rows = [];
            events.forEach(function (e) {
                var row = toRow(nodeid, e, nowMs);
                if (row.tc > maxTc) maxTc = row.tc;
                rows.push(row);
            });
            var chunks = [];
            for (var i = 0; i < rows.length; i += rowsPerInsert) chunks.push(rows.slice(i, i + rowsPerInsert));
            return chunks.reduce(function (p, c) { return p.then(function () { return insertChunk(c); }); }, Promise.resolve())
            .then(function () { obj.capNode(nodeid); return { count: rows.length, maxTc: maxTc }; });
        });
    };

    // Keep only the newest maxEventsPerNode events of a node. The cutoff lookup rides the
    // (nodeid, tc) index; a LIMIT inside an IN-subquery would not be portable to MySQL.
    obj.capNode = function (nodeid) {
        if (!obj.capDue(nodeid)) return;
        ready().then(function () {
            return D.query('SELECT tc FROM ' + T_EV + ' WHERE nodeid = ' + D.ph(1) + ' ORDER BY tc DESC LIMIT 1 OFFSET ' + (obj.maxEventsPerNode - 1), [nodeid]);
        })
        .then(function (r) {
            if (r.rows.length == 0) return null;
            return D.query('DELETE FROM ' + T_EV + ' WHERE nodeid = ' + D.ph(1) + ' AND tc < ' + D.ph(2), [nodeid, toNum(r.rows[0].tc)]);
        })
        .then(function (r) { if (r != null && r.affected > 0) console.log('EVENTLOG: per-node cap removed ' + r.affected + ' events for ' + nodeid); })
        .catch(function (e) { console.log('EVENTLOG: cap error: ' + (e.message || e)); });
    };

    function whereFor(nodeid, opts, params) {
        var w = ['nodeid = ' + D.ph(1)], p = [nodeid], n = 2;
        var addIn = function (col, list) {
            var ph = [];
            list.forEach(function (v) { ph.push(D.ph(n++)); p.push(v); });
            w.push(col + ' IN (' + ph.join(',') + ')');
        };
        // user filters (params.*) take precedence over the config set's collection filters (opts.*)
        var logs = params.logs || (opts.historyLogs ? String(opts.historyLogs).split(',') : null);
        if (logs) addIn('logname', logs);
        var levels = params.levels || opts.historyEntryTypes;
        if (levels) addIn('level', levels.map(Number));
        if (params.sources) addIn('provider', params.sources);
        if (params.since) { w.push('tc >= ' + D.ph(n++)); p.push(Number(params.since)); }
        if (params.until != null) { w.push('tc <= ' + D.ph(n++)); p.push(Number(params.until)); }
        if (params.text) {
            // '!' as the escape character: a backslash would be ambiguous on MySQL/MariaDB, whose
            // string literals process backslashes unless NO_BACKSLASH_ESCAPES is set.
            var pat = '%' + String(params.text).replace(/[!%_]/g, '!$&') + '%';
            var parts = [];
            ['message', 'provider', 'logname'].forEach(function (c) {
                parts.push(c + ' ' + D.like + ' ' + D.ph(n++) + " ESCAPE '!'");
                p.push(pat);
            });
            w.push('(' + parts.join(' OR ') + ')');
        }
        if (params.ids) { // Id is an event id on Windows and a PID on Linux, both stored as text
            var pid = shared.parseIds(params.ids), ors = [];
            if (pid.singles.length) {
                var ph = [];
                pid.singles.forEach(function (v) { ph.push(D.ph(n++)); p.push(String(v)); });
                ors.push('eventid IN (' + ph.join(',') + ')');
            }
            pid.ranges.forEach(function (r) {   // no expansion needed here: ranges of any width work
                ors.push('(eventid_num IS NOT NULL AND eventid_num BETWEEN ' + D.ph(n++) + ' AND ' + D.ph(n++) + ')');
                p.push(r[0], r[1]);
            });
            if (ors.length) w.push('(' + ors.join(' OR ') + ')');
        }
        return { sql: w.join(' AND '), params: p };
    }

    obj.getEventsFor = function (nodeid, opts, params, callback) {
        if (typeof params == 'function') { callback = params; params = null; }
        opts = opts || {}; params = shared.normParams(params);
        if (opts.historyEnabled === false) { callback(null, 0); return; }
        ready().then(function () {
            var w = whereFor(nodeid, opts, params);
            return D.query('SELECT COUNT(*) AS n FROM ' + T_EV + ' WHERE ' + w.sql, w.params)
            .then(function (cr) {
                var total = toNum(cr.rows[0] && cr.rows[0].n) || 0;
                // limit/offset are inlined: normParams already clamps them to 1..1000 / >=0
                return D.query('SELECT * FROM ' + T_EV + ' WHERE ' + w.sql + ' ORDER BY tc DESC, id DESC LIMIT ' + params.limit + ' OFFSET ' + params.skip, w.params)
                .then(function (r) { callback(r.rows.map(rowToEvent), total); });
            });
        }).catch(function (e) { console.log('EVENTLOG: getEventsFor error: ' + (e.message || e)); callback([], 0); });
    };

    obj.getStatsFor = function (nodeid, callback) {
        ready().then(function () {
            return D.query('SELECT COUNT(*) AS n, MAX(time) AS lasttime FROM ' + T_EV + ' WHERE nodeid = ' + D.ph(1), [nodeid]);
        })
        .then(function (r) {
            var row = r.rows[0] || {};
            callback({ count: toNum(row.n) || 0, last: toNum(row.lasttime) });
        })
        .catch(function () { callback({ count: 0, last: null }); });
    };

    obj.getLastEventFor = function (nodeid, callback) {
        ready().then(function () {
            return D.query('SELECT tc FROM ' + T_EV + ' WHERE nodeid = ' + D.ph(1) + ' ORDER BY tc DESC LIMIT 1', [nodeid]);
        })
        .then(function (r) {
            if (r.rows.length == 0) { callback([]); return; }
            var tc = toNum(r.rows[0].tc) || 0;
            callback([{ tc: tc, TimeCreated: [String(tc)] }]);
        })
        .catch(function () { callback([]); });
    };

    // range-wide facet counts (per level / category / source) for the history sidebar
    obj.getFacetsFor = function (nodeid, since, callback) {
        ready().then(function () {
            var w = 'nodeid = ' + D.ph(1), p = [nodeid];
            if (since) { w += ' AND tc >= ' + D.ph(2); p.push(Number(since)); }
            var q = function (col, extra) {
                return D.query('SELECT ' + col + ' AS k, COUNT(*) AS n FROM ' + T_EV + ' WHERE ' + w + ' GROUP BY ' + col + (extra || ''), p);
            };
            return Promise.all([q('level'), q('logname'), q('provider', ' ORDER BY COUNT(*) DESC LIMIT 200')]);
        })
        .then(function (res) {
            var out = { level: {}, log: {}, source: {} }, keys = ['level', 'log', 'source'];
            res.forEach(function (r, i) {
                r.rows.forEach(function (row) {
                    if (row.k == null || row.k === '') return;
                    out[keys[i]][row.k] = toNum(row.n) || 0;
                });
            });
            callback(out);
        })
        .catch(function (e) { console.log('EVENTLOG: getFacetsFor error: ' + (e.message || e)); callback(null); });
    };

    // facet counts over the same query History uses (config set filters + user filters), for the Assistant
    obj.getFacetsQuery = function (nodeid, opts, params, callback) {
        opts = opts || {};
        if (opts.historyEnabled === false) { callback({ level: {}, log: {}, source: {} }); return; }
        ready().then(function () {
            var w = whereFor(nodeid, opts, shared.normParams(params));
            var q = function (col, extra) {
                return D.query('SELECT ' + col + ' AS k, COUNT(*) AS n FROM ' + T_EV + ' WHERE ' + w.sql + ' GROUP BY ' + col + (extra || ''), w.params);
            };
            return Promise.all([q('level'), q('logname'), q('provider', ' ORDER BY COUNT(*) DESC LIMIT 200')]);
        })
        .then(function (res) {
            var out = { level: {}, log: {}, source: {} }, keys = ['level', 'log', 'source'];
            res.forEach(function (r, i) { r.rows.forEach(function (row) { if (row.k == null || row.k === '') return; out[keys[i]][row.k] = toNum(row.n) || 0; }); });
            callback(out);
        })
        .catch(function (e) { console.log('EVENTLOG: getFacetsQuery error: ' + (e.message || e)); callback(null); });
    };
    // events by their stored id, always limited to one device
    obj.getEventsByIds = function (nodeid, ids, callback) {
        var list = (Array.isArray(ids) ? ids : []).slice(0, 200).filter(function (id) { return typeof id == 'string' && /^\d{1,15}$/.test(id); });
        if (list.length == 0) { callback([]); return; }
        ready().then(function () {
            var ph = [], p = [nodeid], n = 2;
            list.forEach(function (id) { ph.push(D.ph(n++)); p.push(id); });
            return D.query('SELECT * FROM ' + T_EV + ' WHERE nodeid = ' + D.ph(1) + ' AND id IN (' + ph.join(',') + ')', p);
        })
        .then(function (r) { callback(r.rows.map(rowToEvent)); })
        .catch(function (e) { console.log('EVENTLOG: getEventsByIds error: ' + (e.message || e)); callback([]); });
    };

    // ---- Assistant settings documents (endpoints, settings, acknowledgements) ----
    obj.aiPutDoc = function (id, type, doc) {
        var d = Object.assign({}, doc || {}); delete d._id; d.type = type;
        return ready().then(function () { return putDoc(id, type, (d.extra != null) ? String(d.extra) : null, d); }).then(function () { return true; });
    };
    obj.aiGetDoc = function (id) { return ready().then(function () { return getDoc(id); }); };
    obj.aiDocs = function (type) { return ready().then(function () { return docsByType(type); }); };
    obj.aiDelDoc = function (id) { return ready().then(function () { return delDoc(id); }); };

    // ---- Assistant audit log ---------------------------------------------
    function auditWhere(q) {
        var w = [], p = [], n = 1;
        if (q.since != null) { w.push('time >= ' + D.ph(n++)); p.push(q.since); }
        if (q.until != null) { w.push('time <= ' + D.ph(n++)); p.push(q.until); }
        if (q.userid != null) { w.push('userid = ' + D.ph(n++)); p.push(q.userid); }
        if (q.nodeid != null) { w.push('nodeid = ' + D.ph(n++)); p.push(q.nodeid); }
        return { sql: w.length ? (' WHERE ' + w.join(' AND ')) : '', params: p };
    }
    obj.aiAuditAdd = function (rec) {
        return ready().then(function () {
            rec = shared.auditRec(rec);
            return D.query('INSERT INTO ' + T_AUD + ' (time,userid,nodeid,doc) VALUES (' + D.ph(1) + ',' + D.ph(2) + ',' + D.ph(3) + ',' + D.ph(4) + ')',
                [rec.time, trunc(rec.userid, 256), trunc(rec.nodeid, 256), JSON.stringify(rec)]);
        }).then(function () { return true; })
        .catch(function (e) { console.log('EVENTLOG AI: audit write failed: ' + (e.message || e)); return false; });
    };
    obj.aiAuditQuery = function (q) {
        q = shared.auditQueryNorm(q);
        if (q.none) return Promise.resolve({ rows: [], total: 0 });
        var w = auditWhere(q);
        return ready().then(function () { return D.query('SELECT COUNT(*) AS n FROM ' + T_AUD + w.sql, w.params); })
        .then(function (cr) {
            var total = toNum(cr.rows[0] && cr.rows[0].n) || 0;
            return D.query('SELECT id, doc FROM ' + T_AUD + w.sql + ' ORDER BY time DESC, id DESC LIMIT ' + q.limit + ' OFFSET ' + q.skip, w.params)
            .then(function (r) { return { rows: r.rows.map(function (row) { var d = parseDoc(row.doc); d._id = String(row.id); return d; }), total: total }; });
        });
    };
    obj.aiAuditSweep = function (cutoffMs) {
        var removed = 0, cutoff = Number(cutoffMs) || 0;
        var step = function () {
            if (obj._closed) return removed;
            var sql;
            if (isMy) sql = 'DELETE FROM ' + T_AUD + ' WHERE time < ? ORDER BY time LIMIT ' + SWEEP_CHUNK;
            else sql = 'DELETE FROM ' + T_AUD + ' WHERE id IN (SELECT id FROM ' + T_AUD + ' WHERE time < ' + D.ph(1) + ' ORDER BY time LIMIT ' + SWEEP_CHUNK + ')';
            return D.query(sql, [cutoff]).then(function (r) {
                removed += r.affected;
                if (r.affected < SWEEP_CHUNK) return removed;
                return new Promise(function (res) { setTimeout(res, 250); }).then(step);
            });
        };
        return ready().then(step);
    };

    // ---- Assistant saved results (chats, last diagnosis, explanations) ----------
    function chatRow(row, withDoc) {
        var o = { id: String(row.id), time: toNum(row.time) || 0, userid: row.userid, nodeid: row.nodeid, kind: row.kind, meta: parseDoc(row.meta) };
        if (withDoc) o.doc = parseDoc(row.doc);
        return o;
    }
    obj.aiChatPut = function (rec) {
        var r = shared.chatRec(rec);
        if (r == null) return Promise.resolve(false);
        return ready().then(function () {
            var p = [r.id, r.time, r.userid, r.nodeid, r.kind, JSON.stringify(r.meta), JSON.stringify(r.doc)];
            var ph = [1, 2, 3, 4, 5, 6, 7].map(function (i) { return D.ph(i); }).join(',');
            var sql;
            if (isMy) sql = 'INSERT INTO ' + T_CHAT + ' (id,time,userid,nodeid,kind,meta,doc) VALUES (' + ph + ') ON DUPLICATE KEY UPDATE time=VALUES(time), userid=VALUES(userid), nodeid=VALUES(nodeid), kind=VALUES(kind), meta=VALUES(meta), doc=VALUES(doc)';
            else sql = 'INSERT INTO ' + T_CHAT + ' (id,time,userid,nodeid,kind,meta,doc) VALUES (' + ph + ') ON CONFLICT (id) DO UPDATE SET time=excluded.time, userid=excluded.userid, nodeid=excluded.nodeid, kind=excluded.kind, meta=excluded.meta, doc=excluded.doc';
            return D.query(sql, p);
        }).then(function () { return true; });
    };
    obj.aiChatGet = function (id) {
        if (shared.chatIds(id).length != 1) return Promise.resolve(null);
        return ready().then(function () { return D.query('SELECT * FROM ' + T_CHAT + ' WHERE id = ' + D.ph(1), [id]); })
        .then(function (r) { return r.rows[0] ? chatRow(r.rows[0], true) : null; });
    };
    obj.aiChatList = function (q) {
        q = shared.chatQueryNorm(q);
        if (q.none) return Promise.resolve([]);
        var w = ['userid = ' + D.ph(1), 'nodeid = ' + D.ph(2)], p = [q.userid, q.nodeid], n = 3;
        if (q.kind != null) { w.push('kind = ' + D.ph(n++)); p.push(q.kind); }
        if (q.since != null) { w.push('time >= ' + D.ph(n++)); p.push(q.since); }
        return ready().then(function () {
            return D.query('SELECT id, time, userid, nodeid, kind, meta FROM ' + T_CHAT + ' WHERE ' + w.join(' AND ') + ' ORDER BY time DESC, id DESC LIMIT ' + q.limit + ' OFFSET ' + q.skip, p);
        }).then(function (r) { return r.rows.map(function (row) { return chatRow(row, false); }); });
    };
    obj.aiChatDel = function (ids) {
        ids = shared.chatIds(ids);
        if (ids.length == 0) return Promise.resolve(0);
        return ready().then(function () {
            return D.query('DELETE FROM ' + T_CHAT + ' WHERE id IN (' + ids.map(function (x, i) { return D.ph(i + 1); }).join(',') + ')', ids);
        }).then(function (r) { return r.affected || 0; });
    };
    var chatSweepWhere = function (where, params) {
        var removed = 0;
        var step = function () {
            if (obj._closed) return removed;
            var sql;
            if (isMy) sql = 'DELETE FROM ' + T_CHAT + ' WHERE ' + where + ' ORDER BY time LIMIT ' + SWEEP_CHUNK;
            else sql = 'DELETE FROM ' + T_CHAT + ' WHERE id IN (SELECT id FROM ' + T_CHAT + ' WHERE ' + where + ' ORDER BY time LIMIT ' + SWEEP_CHUNK + ')';
            return D.query(sql, params).then(function (r) {
                removed += r.affected;
                if (r.affected < SWEEP_CHUNK) return removed;
                return new Promise(function (res) { setTimeout(res, 250); }).then(step);
            });
        };
        return ready().then(step);
    };
    obj.aiChatSweep = function (cutoffMs) { return chatSweepWhere('time < ' + D.ph(1), [Number(cutoffMs) || 0]); };
    obj.aiChatPurge = function () { return chatSweepWhere('time >= ' + D.ph(1), [-1]); };
    obj.aiChatCounts = function () {
        return ready().then(function () { return D.query('SELECT kind, COUNT(*) AS n FROM ' + T_CHAT + ' GROUP BY kind', []); })
        .then(function (r) {
            var out = { chat: 0, diagnosis: 0, explain: 0 };
            r.rows.forEach(function (row) { if (out[row.kind] != null) out[row.kind] = toNum(row.n) || 0; });
            return out;
        });
    };

    // ---- retention -------------------------------------------------------
    obj.setRetention = function (days) {
        var secs = 60 * 60 * 24 * (Number(days) || shared.DEFAULT_RETENTION_DAYS);
        obj.retentionSeconds = secs;
    };

    // Chunked so a first sweep over a large table does not hold row locks for minutes.
    obj.retentionSweep = function () {
        if (obj._closed || obj._sweeping) return;
        obj._sweeping = true;
        var cutoff = Date.now() - (obj.retentionSeconds * 1000);
        var removed = 0;
        var step = function () {
            if (obj._closed) return Promise.resolve();
            var sql;
            if (isMy) sql = 'DELETE FROM ' + T_EV + ' WHERE time < ? ORDER BY time LIMIT ' + SWEEP_CHUNK;
            else sql = 'DELETE FROM ' + T_EV + ' WHERE id IN (SELECT id FROM ' + T_EV + ' WHERE time < ' + D.ph(1) + ' ORDER BY time LIMIT ' + SWEEP_CHUNK + ')';
            return D.query(sql, [cutoff]).then(function (r) {
                removed += r.affected;
                if (r.affected < SWEEP_CHUNK) return null;
                return new Promise(function (res) { setTimeout(res, 250); }).then(step);   // let other queries through
            });
        };
        ready().then(step)
        .then(function () {
            obj._sweeping = false;
            if (removed > 0) console.log('EVENTLOG: retention removed ' + removed + ' events older than ' + new Date(cutoff).toISOString());
        })
        .catch(function (e) { obj._sweeping = false; console.log('EVENTLOG: retention sweep error: ' + (e.message || e)); });
    };

    // ---- config sets -----------------------------------------------------
    obj.getAllConfigSets = function () {
        return ready().then(function () { return docsByType('configSet'); });
    };
    obj.updateDefaultConfig = function (args) {
        return ready().then(function () { return docsByType('configSet'); })
        .then(function (list) {
            var cur = null;
            list.forEach(function (d) { if (d.default === true) cur = d; });
            var doc = Object.assign({}, cur || { default: true }, args);
            var id = (cur != null) ? cur._id : newId();
            delete doc._id;
            doc.type = 'configSet';
            doc.uid = Math.random().toString(32).replace('0.', '');   // invalidates the config the agents hold
            return putDoc(id, 'configSet', doc.uid, doc).then(function () { return { insertedId: id }; });
        });
    };
    obj.updateConfig = function (id, args) {
        return ready().then(function () { return (id == '_new') ? null : getDoc(id); })
        .then(function (cur) {
            var doc = Object.assign({}, cur || {}, args);
            delete doc._id;
            doc.type = 'configSet';
            doc.uid = Math.random().toString(32).replace('0.', '');
            var realId = (id == '_new' || cur == null) ? newId() : id;
            return putDoc(realId, 'configSet', doc.uid, doc).then(function () { return { insertedId: realId }; });
        });
    };
    obj.deleteConfigSet = function (id) {
        return ready().then(function () {
            return D.query('DELETE FROM ' + T_SET + ' WHERE id = ' + D.ph(1) + ' AND type = ' + D.ph(2), [id, 'configSet']);
        }).then(function (r) { return r.affected; });
    };
    obj.checkConfigAuth = function (uid) {
        return ready().then(function () {
            return D.query('SELECT COUNT(*) AS n FROM ' + T_SET + ' WHERE type = ' + D.ph(1) + ' AND extra = ' + D.ph(2), ['configSet', uid]);
        }).then(function (r) { return toNum(r.rows[0] && r.rows[0].n) || 0; });
    };
    obj.assignConfig = function (configId, sel) {
        if (configId == '') configId = 'default';
        sel = Array.isArray(sel) ? sel : [];
        return ready().then(function () {
            var chunks = [];
            for (var i = 0; i < sel.length; i += ASSIGN_CHUNK) chunks.push(sel.slice(i, i + ASSIGN_CHUNK));
            return chunks.reduce(function (p, c) {
                return p.then(function () {
                    var n = 2, ph = [];
                    c.forEach(function () { ph.push(D.ph(n++)); });
                    return D.query('DELETE FROM ' + T_SET + ' WHERE type = ' + D.ph(1) + ' AND extra IN (' + ph.join(',') + ')', ['assignedConfig'].concat(c));
                });
            }, Promise.resolve());
        })
        .then(function () {
            if (configId == '_clear') return null;   // clearing: the removal above is all there is to do
            return sel.reduce(function (p, asset) {
                return p.then(function () {
                    return putDoc('assign:' + asset, 'assignedConfig', asset, { type: 'assignedConfig', asset: asset, configId: configId });
                });
            }, Promise.resolve());
        })
        .catch(function (e) { console.log('EVENTLOG: Error assigning configs: ', e); });
    };
    obj.getConfigAssignments = function () {
        return ready().then(function () { return docsByType('assignedConfig'); })
        .then(function (docs) { return docs.map(function (d) { return { asset: d.asset, configId: d.configId }; }); });
    };

    // ---- node metadata / version ----------------------------------------
    obj.setNodeMeta = function (nodeid, meta) {
        return ready().then(function () {
            return putDoc('nodeMeta:' + nodeid, 'nodeMeta', nodeid,
                { type: 'nodeMeta', nodeid: nodeid, os: meta.os || null, caps: meta.caps || null, updated: new Date().toISOString() });
        });
    };
    obj.getNodeMeta = function (nodeid, callback) {
        ready().then(function () { return getDoc('nodeMeta:' + nodeid); })
        .then(function (d) { callback(d ? { os: d.os, caps: d.caps } : null); })
        .catch(function () { callback(null); });
    };
    obj.updateDBVersion = function (v) {
        return ready().then(function () { return putDoc('db_version', 'db_version', null, { type: 'db_version', version: v }); });
    };
    obj.getDBVersion = function () {
        return ready().then(function () { return getDoc('db_version'); })
        .then(function (d) { return (d && d.version != null) ? d.version : obj.dbVersion; });
    };

    // internal escape hatch (diagnostics / tests): run a statement on this backend
    obj.__q = function (sql, params) { return ready().then(function () { return D.query(sql, params || []); }); };

    obj._backendClose = function () {
        if (obj._retryTimer != null) { try { clearTimeout(obj._retryTimer); } catch (e) { } obj._retryTimer = null; }
        try { D.end(); } catch (e) { }
    };

    bootstrap();
    return obj;
};
