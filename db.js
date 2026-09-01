/** 
* @description MeshCentral-EventLog database module
* @author Ryan Blenis
* @copyright Ryan Blenis 2019
* @license Apache-2.0
*/

"use strict";
var Datastore = null;

// ---- tunables ------------------------------------------------------------
const DEFAULT_RETENTION_DAYS = 30;          // see retentionDays in the default config set
const MAX_EVENTS_PER_NODE = 100000;         // hard per-node cap, enforced after collection batches
const CAP_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const RETENTION_SWEEP_MS = 60 * 60 * 1000;
const NEDB_DELETE_CHUNK = 250;              // see removeInChunks(); measured ~47 ms per batch of this size
// MeshCentral uses this same value for every one of its own NeDB stores. Compaction rewrites the
// WHOLE datafile synchronously on the event loop, so a short interval stalls every relay on the
// server once the store is large (this plugin used 40s until 0.1.11 - see the changelog).
const COMPACTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Resolve a module from the plugin folder first, then from MeshCentral's own node_modules
// (plugins live in meshcentral-data/plugins, which is not always below MeshCentral's node_modules).
function loadModule(names) {
    var lastErr = null;
    for (var i in names) {
        try { return require(names[i]); } catch (e) { lastErr = e; }
        try { if (require.main && typeof require.main.require == 'function') return require.main.require(names[i]); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Module not found: ' + names.join(', '));
}

// ---- shared helpers (backend independent, also used by db_sql.js) --------

// numeric event time (ms since epoch) out of the PowerShell "/Date(ms)/" string or the stored digit array
function tcOf(tcv) {
    if (Array.isArray(tcv)) tcv = tcv[0];
    var m = String(tcv).match(/\d+/);
    return m ? Number(m[0]) : 0;
}

// "1112, 100-199" -> { singles: ['1112'], ranges: [[100, 199]] }
function parseIds(str) {
    var out = { singles: [], ranges: [] };
    String(str).split(',').forEach(function(part) {
        part = part.trim(); if (part == '') return;
        var m = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) { var a = Number(m[1]), b = Number(m[2]); if (b >= a) out.ranges.push([a, b]); }
        else if (/^\d+$/.test(part)) { out.singles.push(part); }
    });
    return out;
}

var cleanStrList = function(v, maxItems) { // sanitize a client-supplied filter list
    if (!Array.isArray(v)) return null;
    var out = v.filter(function(x) { return typeof x == 'string' && x.length < 256; }).slice(0, maxItems || 50);
    return out.length ? out : null;
};

// limit/skip are inlined into SQL (they cannot be parameters in every dialect), so they must come
// out of here as plain integers - not 1.5, 1e21 or Infinity, which would be a syntax error.
var intOr = function(v, dflt) { var n = Math.floor(Number(v)); return isFinite(n) ? n : dflt; };

var normParams = function(params) {
    params = params || {};
    return {
        limit: Math.min(Math.max(intOr(params.limit, 250) || 250, 1), 1000),
        skip: Math.min(Math.max(intOr(params.skip, 0), 0), 10000000),
        since: params.since || null,
        levels: (function() { if (!Array.isArray(params.levels)) return null; var l = params.levels.slice(0, 10).map(Number).filter((n) => !isNaN(n)); return l.length ? l : null; })(),
        logs: cleanStrList(params.logs, 50),
        sources: cleanStrList(params.sources, 100),
        text: (typeof params.text == 'string' && params.text.trim() != '') ? params.text.trim().substring(0, 256) : null,
        ids: (typeof params.ids == 'string' && params.ids.trim() != '') ? params.ids.trim().substring(0, 256) : null
    };
};

// document-store (Mongo / NeDB) query. The SQL backend builds its own WHERE from the same params.
var buildQuery = function(nodeid, opts, params) {
    var proj = { nodeid: nodeid };
    // user filters (params.*) take precedence over the config set's collection filters (opts.*)
    var logs = params.logs || (opts.historyLogs ? String(opts.historyLogs).split(',') : null);
    if (logs) proj.LogName = { $in: logs };
    var levels = params.levels || opts.historyEntryTypes;
    if (levels) proj.Level = { $in: levels.map((n) => Number(n)) };
    if (params.sources) proj.ProviderName = { $in: params.sources };
    if (params.since) proj.tc = { $gte: Number(params.since) };
    var ands = [];
    if (params.text) {
        var re = new RegExp(String(params.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        ands.push({ $or: [ { Message: { $regex: re } }, { ProviderName: { $regex: re } }, { LogName: { $regex: re } } ] });
    }
    if (params.ids) { // Id is a number on Windows but a string (PID) on Linux, so match both types.
        var p = parseIds(params.ids);
        var ors = [], singles = [];
        var pushBoth = function(n) { singles.push(Number(n)); singles.push(String(n)); };
        p.singles.forEach(pushBoth);
        p.ranges.forEach(function(r) {
            if ((r[1] - r[0]) <= 1000) { for (var v = r[0]; v <= r[1]; v++) pushBoth(v); } // expanded so string Ids match too
            else ors.push({ Id: { $gte: r[0], $lte: r[1] } }); // very wide range: numeric only
        });
        if (singles.length) ors.push({ Id: { $in: singles } });
        if (ors.length) ands.push({ $or: ors });
    }
    if (ands.length) proj.$and = ands;
    return proj;
};

// normalize an incoming collection batch in place; returns { count, maxTc }
function prepEvents(nodeid, events) {
    var now = new Date(), maxTc = 0;
    for (var i = 0; i < events.length; i++) {
        var e = events[i];
        e.time = now;
        e.nodeid = nodeid;
        e.TimeCreated = String(e.TimeCreated).match(/\d+/g);
        e.tc = tcOf(e.TimeCreated);
        if (e.tc > maxTc) maxTc = e.tc;
    }
    return { count: events.length, maxTc: maxTc };
}

// config-set resolution and maintenance scheduling, identical for every backend
function installShared(obj) {
    obj.getConfigFor = function(nodeId, meshId) {
        // Every step is chained (not fire-and-forget) so that a backend failure rejects this promise
        // instead of leaving it pending forever with an unhandled rejection behind it.
        return obj.getConfigAssignments()
        .then(function (ca) {
            var configId = 'default';
            (ca || []).forEach(function (a) { if (a.asset == meshId) configId = a.configId; });
            (ca || []).forEach(function (a) { if (a.asset == nodeId) configId = a.configId; });
            return configId;
        })
        .then(function (configId) {
            return obj.getAllConfigSets().then(function (sets) {
                var configBlob = null;
                (sets || []).forEach(function (s) {
                    if (configId == 'default' && s.default === true) configBlob = s;
                    else if (s._id == configId) configBlob = s;
                });
                return configBlob;
            });
        });
    };

    obj.checkForDefault = function() {
        return obj.getAllConfigSets()
        .then((cfgs) => {
            if (cfgs.length == 0) {
                return obj.updateDefaultConfig({
                    name: 'Default',
                    liveLogs: 'Application,System',
                    liveNum: 100,
                    liveEntryTypes: [2,3],
                    historyEnabled: true,
                    historyLogs: 'Application,System',
                    historyEntryTypes: [2,3],
                    retentionDays: DEFAULT_RETENTION_DAYS
                });
            }
        })
        .catch(function () { });
    };

    obj.applyRetention = function() {
        return obj.getAllConfigSets().then(function(sets) {
            (sets || []).forEach(function(cs) { if (cs.default === true && cs.retentionDays) obj.setRetention(cs.retentionDays); });
        }).catch(function() { });
    };

    // per-node cap check, throttled so a once-a-minute collection batch does not re-count every time
    obj.capDue = function(nodeid) {
        var now = Date.now();
        if (obj._capNext[nodeid] != null && obj._capNext[nodeid] > now) return false;
        obj._capNext[nodeid] = now + CAP_CHECK_INTERVAL_MS;
        return true;
    };

    obj.startMaintenance = function() {
        if (obj._maintStarted) return;
        obj._maintStarted = true;
        var t1 = setTimeout(function() { obj.retentionSweep(); }, 120000);          // shortly after startup
        var t2 = setInterval(function() { obj.retentionSweep(); }, RETENTION_SWEEP_MS);
        try { t1.unref(); t2.unref(); } catch (e) { }
        obj._timers.push(t1, t2);
    };
}

module.exports.CreateDB = function(meshserver) {
    // server_startup runs again when a plugin is installed or reloaded (pluginHandler.js). Without
    // this, every reload leaks another store with its own compaction / sweep timers.
    try {
        var prev = (meshserver.pluginHandler != null) ? meshserver.pluginHandler.eventlog_db : null;
        if (prev != null && typeof prev.close == 'function') { prev.close(); console.log('EVENTLOG: closed previous database instance'); }
    } catch (e) { }

    var obj = {};
    obj.dbVersion = 4;
    obj.retentionSeconds = DEFAULT_RETENTION_DAYS * 24 * 60 * 60;
    obj.maxEventsPerNode = MAX_EVENTS_PER_NODE;
    obj._timers = [];
    obj._capNext = {};
    obj._closed = false;
    installShared(obj);

    obj.close = function() {
        obj._closed = true;
        obj._timers.forEach(function(t) { try { clearInterval(t); } catch (e) { } try { clearTimeout(t); } catch (e) { } });
        obj._timers = [];
        [obj.eventsFile, obj.settingsFile].forEach(function(f) {
            if (f == null) return;
            try {
                if (typeof f.stopAutocompaction == 'function') f.stopAutocompaction();
                else if (f.persistence != null && typeof f.persistence.stopAutocompaction == 'function') f.persistence.stopAutocompaction();
            } catch (e) { }
        });
        if (obj.mongoClient != null) { try { obj.mongoClient.close(); } catch (e) { } obj.mongoClient = null; }
        if (typeof obj._backendClose == 'function') { try { obj._backendClose(); } catch (e) { } }
    };

    // Which store do we use? Until 0.1.11 only args.mongodb was checked, so every PostgreSQL,
    // MariaDB, MySQL and SQLite deployment silently got plugin-private NeDB files instead of the
    // database it had configured. databaseType comes from MeshCentral itself (db.js): 1 NeDB,
    // 2 MongoJS, 3 MongoDB, 4 MariaDB, 5 MySQL, 6 PostgreSQL, 7 AceBase, 8 SQLite.
    var sqlKind = null;
    if (String(process.env.EVENTLOG_STORAGE || '').toLowerCase() != 'nedb') {
        var dt = 0;
        try { dt = (meshserver.db != null && meshserver.db.databaseType != null) ? Number(meshserver.db.databaseType) : 0; } catch (e) { }
        if (dt == 6) sqlKind = 'pg';
        else if (dt == 4) sqlKind = 'mariadb';
        else if (dt == 5) sqlKind = 'mysql';
        else if (dt == 8) {
            // SQLite is the one engine whose handle MeshCentral exposes; sharing it avoids fighting
            // the same file for the write lock and inherits MeshCentral's PRAGMA setup.
            if (meshserver.db.file != null && typeof meshserver.db.file.all == 'function') sqlKind = 'sqlite';
            else console.log('EVENTLOG: MeshCentral is on SQLite but its database handle is not usable here - using NeDB files instead');
        }
    }
    if (sqlKind != null) {
        console.log('EVENTLOG: storage backend = ' + sqlKind + ' (MeshCentral database)');
        require(__dirname + '/db_sql.js').install(obj, meshserver, sqlKind, {
            loadModule: loadModule,
            tcOf: tcOf,
            parseIds: parseIds,
            normParams: normParams,
            cleanStrList: cleanStrList,
            DEFAULT_RETENTION_DAYS: DEFAULT_RETENTION_DAYS
        });
        return obj;
    }

    if (meshserver.args.mongodb) { // use MongDB
      console.log('EVENTLOG: storage backend = mongodb');
      loadModule(['mongodb']).MongoClient.connect(meshserver.args.mongodb, { useNewUrlParser: true, useUnifiedTopology: true }, function (err, client) {
          if (err != null) { console.log("Unable to connect to database: " + err); process.exit(); return; }
          Datastore = client;
          obj.mongoClient = client;

          var dbname = 'meshcentral';
          if (meshserver.args.mongodbname) { dbname = meshserver.args.mongodbname; }
          const db = client.db(dbname);
          
          obj.eventsFile = db.collection('plugin_eventlog');
          obj.eventsFile.indexes(function (err, indexes) {
              // Check if we need to reset indexes. NodeID1 (a prefix of Tc1) and TimeCreated1 (a
              // multikey index on a digit array nothing queries) were dropped in 0.1.11: they only
              // cost insert time and RAM. NodeTime1 serves getStatsFor's "last collected" lookup.
              var indexesByName = {}, indexCount = 0;
              for (var i in indexes) { indexesByName[indexes[i].name] = indexes[i]; indexCount++; }
              if ((indexCount != 4) || (indexesByName['Tc1'] == null) || (indexesByName['NodeTime1'] == null) || (indexesByName['ExpireTime1'] == null)) {
                  // Reset all indexes
                  console.log('Resetting plugin (eventlog) indexes...');
                  obj.eventsFile.dropIndexes(function (err) {
                      obj.eventsFile.createIndex({ nodeid: 1, tc: -1 }, { name: 'Tc1' });
                      obj.eventsFile.createIndex({ nodeid: 1, time: -1 }, { name: 'NodeTime1' });
                      obj.eventsFile.createIndex({ 'time': 1}, { expireAfterSeconds: obj.retentionSeconds, name: 'ExpireTime1' });
                  });
              }
          });
          obj.setRetention = function(days) {
              var secs = 60 * 60 * 24 * (Number(days) || DEFAULT_RETENTION_DAYS);
              if (obj.retentionSeconds == secs) return;
              obj.retentionSeconds = secs;
              db.command({ collMod: 'plugin_eventlog', index: { name: 'ExpireTime1', expireAfterSeconds: secs } })
              .catch(function () {
                  return obj.eventsFile.dropIndex('ExpireTime1').catch(function () { })
                  .then(function () { return obj.eventsFile.createIndex({ time: 1 }, { expireAfterSeconds: secs, name: 'ExpireTime1' }); });
              })
              .catch(function (e) { console.log('EVENTLOG: could not update retention index: ' + e); });
          };
          // MongoDB expires documents itself through the TTL index; nothing to sweep.
          obj.retentionSweep = function() { };
          
          obj.settingsFile = db.collection('plugin_eventlog_settings');
          
          // one batch = one round trip. Returns { count, maxTc }; maxTc is the collection ack value.
          obj.addEventsFor = function(nodeid, events) {
              if (!Array.isArray(events)) events = [ events ]; // a single event arrives as a bare object
              events = events.filter(function(e) { return e != null && typeof e == 'object'; });
              var r = prepEvents(nodeid, events);
              if (r.count == 0) return Promise.resolve(r);
              return obj.eventsFile.insertMany(events, { ordered: false })
              .then(function () { obj.capNode(nodeid); return r; });
          };

          obj.capNode = function(nodeid) {
              if (!obj.capDue(nodeid)) return;
              obj.eventsFile.countDocuments({ nodeid: nodeid })
              .then(function (n) {
                  if (!(n > obj.maxEventsPerNode)) return null;
                  return obj.eventsFile.find({ nodeid: nodeid }).sort({ tc: -1 }).skip(obj.maxEventsPerNode - 1).limit(1).project({ tc: 1 }).toArray();
              })
              .then(function (d) {
                  if (d == null || d[0] == null) return null;
                  return obj.eventsFile.deleteMany({ nodeid: nodeid, tc: { $lt: d[0].tc } });
              })
              .then(function (r) { if (r != null && r.deletedCount > 0) console.log('EVENTLOG: per-node cap removed ' + r.deletedCount + ' events for ' + nodeid); })
              .catch(function (e) { console.log('EVENTLOG: cap error: ' + e); });
          };
          
          obj.getEventsFor = function(nodeid, opts, params, callback) {
              if (typeof params == 'function') { callback = params; params = null; }
              opts = opts || {}; params = normParams(params);
              if (opts.historyEnabled === false) { callback(null, 0); return; }
              var proj = buildQuery(nodeid, opts, params);
              obj.eventsFile.countDocuments(proj)
              .then(function (total) {
                  return obj.eventsFile.find(proj).sort({ tc: -1 }).skip(params.skip).limit(params.limit).toArray()
                  .then(function (events) { callback(events, total); });
              })
              .catch(function (e) { console.log('EVENTLOG: getEventsFor error: ' + e); callback([], 0); });
          };
          obj.getStatsFor = function(nodeid, callback) {
              var stats = { count: 0, last: null };
              obj.eventsFile.countDocuments({ nodeid: nodeid })
              .then(function (count) {
                  stats.count = count || 0;
                  return obj.eventsFile.find({ nodeid: nodeid }).sort({ time: -1 }).limit(1).project({ time: 1 }).toArray();
              })
              .then(function (d) { if (d && d[0]) stats.last = d[0].time; callback(stats); })
              .catch(function () { callback(stats); });
          };
          obj.getLastEventFor = function(nodeid, callback) {
              obj.eventsFile.find({ nodeid: nodeid }).sort({ tc: -1 }).limit(1).toArray()
              .then(function (events) { callback(events); })
              .catch(function () { callback([]); });
          };
          // range-wide facet counts (per level / category / source) for the history sidebar
          obj.getFacetsFor = function(nodeid, since, callback) {
              var match = { nodeid: nodeid };
              if (since) match.tc = { $gte: Number(since) };
              obj.eventsFile.aggregate([
                  { $match: match },
                  { $facet: {
                      level: [ { $group: { _id: '$Level', n: { $sum: 1 } } } ],
                      log: [ { $group: { _id: '$LogName', n: { $sum: 1 } } } ],
                      source: [ { $group: { _id: '$ProviderName', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 200 } ]
                  } }
              ]).toArray()
              .then(function (d) {
                  var out = { level: {}, log: {}, source: {} };
                  if (d && d[0]) { ['level','log','source'].forEach(function(k) { (d[0][k] || []).forEach(function(r) { if (r._id != null && r._id !== '') out[k][r._id] = r.n; }); }); }
                  callback(out);
              })
              .catch(function () { callback(null); });
          };
          obj.updateDefaultConfig = function(args) {
              args.type = 'configSet';
              args.uid = Math.random().toString(32).replace('0.', '');
              return obj.settingsFile.updateOne({default: true}, { $set: args }, {upsert: true});
          };
          obj.updateConfig = function(id, args) {
              if (args._id != null) delete args._id;
              args.type = "configSet";
              args.uid = Math.random().toString(32).replace('0.', '');
              if (id == '_new') return obj.settingsFile.insertOne(args);
              var mdb = loadModule(['mongodb']);
              id = (typeof mdb.ObjectID == 'function') ? mdb.ObjectID(id) : new mdb.ObjectId(id);
              return obj.settingsFile.updateOne({_id: id}, { $set: args }, {upsert: true});
          };
          obj.getAllConfigSets = function() {
              return obj.settingsFile.find({type: "configSet"}).project({type: 0}).toArray();
          };
          obj.deleteConfigSet = function(id) {
              var mdb = loadModule(['mongodb']);
              id = (typeof mdb.ObjectID == 'function') ? mdb.ObjectID(id) : new mdb.ObjectId(id);
              return obj.settingsFile.deleteOne({_id: id});
          };
          obj.assignConfig = function(configId, sel) {
              if (configId == '') configId = "default";
              // multiple selections may not update, we need to delete and insert here
              return obj.settingsFile.deleteMany({type: "assignedConfig", asset: { $in: sel } })
              .then(() => {
                  if (configId == '_clear') { return; }
                  var inserts = [];
                  sel.forEach((s) => {
                      inserts.push({
                        type: "assignedConfig",
                        asset: s,
                        configId: configId
                      });
                  });
                  return obj.settingsFile.insertMany(inserts);
              })
              .catch((e) => console.log("EVENTLOG: Error assigning configs: ", e));
          }
          obj.getConfigAssignments = function() {
              return obj.settingsFile.find( { type: "assignedConfig" } ).project( { _id: 0, asset: 1, configId: 1 } ).toArray();
          }
          obj.checkConfigAuth = function(uid) {
            return obj.settingsFile.countDocuments( { type: "configSet", uid: uid } );
          }
          // per-node metadata reported by the agent (OS, Linux log capabilities)
          obj.setNodeMeta = function(nodeid, meta) {
              return obj.settingsFile.updateOne({ type: 'nodeMeta', nodeid: nodeid }, { $set: { type: 'nodeMeta', nodeid: nodeid, os: meta.os || null, caps: meta.caps || null, updated: new Date() } }, { upsert: true });
          };
          obj.getNodeMeta = function(nodeid, callback) {
              obj.settingsFile.find({ type: 'nodeMeta', nodeid: nodeid }).limit(1).toArray()
              .then(function (d) { callback((d && d[0]) ? { os: d[0].os, caps: d[0].caps } : null); })
              .catch(function () { callback(null); });
          };

          obj.updateDBVersion = function(new_version) {
            return obj.settingsFile.updateOne({type: "db_version"}, { $set: {version: new_version} }, {upsert: true});
          };
          
          obj.getDBVersion = function() {
              return new Promise(function(resolve, reject) {
                  obj.settingsFile.find( { type: "db_version" } ).project( { _id: 0, version: 1 } ).toArray(function(err, vers){
                      if (vers.length == 0) resolve(1);
                      else resolve(vers[0]['version']);
                  });
              });
          };
          
          obj.getDBVersion().then(function(current_version){
              if (current_version < 2) {
                  var etsi = ['LogAlways', 'Critical', 'Error', 'Warning', 'Info', 'Verbose'];
                  obj.eventsFile.find().sort({ TimeCreated: -1 }).toArray(function (err, events) {
                      for (let [i, e] of Object.entries(events)) {
                          if (typeof e.LevelDisplayName == 'string' && e.LevelDisplayName != '' && etsi.indexOf(e.LevelDisplayName) !== -1) {
                              e.Level = etsi.indexOf(e.LevelDisplayName);
                              delete e.LevelDisplayName;
                              obj.eventsFile.updateOne({_id: e._id}, {$set: e, $unset: {LevelDisplayName: ""} });
                          }
                      }
                  });
                  
                  obj.updateDBVersion(2);
              }
              if (current_version < 3) { // add numeric event time (tc) used for sorting / range queries
                  obj.eventsFile.find({ tc: { $exists: false } }).toArray(function (err, events) {
                      for (let [i, e] of Object.entries(events || [])) {
                          obj.eventsFile.updateOne({ _id: e._id }, { $set: { tc: tcOf(e.TimeCreated) } });
                      }
                  });
                  obj.updateDBVersion(3);
              }
              if (current_version < 4) { // v4: Linux events (additive fields Priority/Unit/Transport/BootId, nullable Id) - no data rewrite needed
                  obj.updateDBVersion(4);
              }
          });
          obj.checkForDefault();
          obj.applyRetention();
    });  
    } else { // use NeDb
        console.log('EVENTLOG: storage backend = nedb (plugin-private files)');
        Datastore = loadModule(['@seald-io/nedb', '@yetzt/nedb', 'nedb']); // same fallback order as MeshCentral itself
        var setCompaction = function(store) {
            if (typeof store.setAutocompactionInterval == 'function') store.setAutocompactionInterval(COMPACTION_INTERVAL_MS);
            else store.persistence.setAutocompactionInterval(COMPACTION_INTERVAL_MS);
        };
        if (obj.eventsFile == null) {
            obj.eventsFile = new Datastore({ filename: meshserver.getConfigFilePath('plugin-eventlog-events.db'), autoload: true });
            setCompaction(obj.eventsFile);
            obj.eventsFile.ensureIndex({ fieldName: 'nodeid' });
            // 0.1.11: 'TimeCreated' (a multikey index over a digit array) and 'tc' were never used by
            // any query - NeDB picks a single index and the nodeid equality always wins - and the TTL
            // on 'time' expired documents lazily, one removal per expired doc, only for nodes that
            // happened to be queried. Both are replaced by a plain 'time' index plus retentionSweep().
            // Note: these must not be nested inside each other's callbacks. Calling ensureIndex from
            // within a removeIndex callback re-enters NeDB's executor and the new index is built in
            // memory but never written to the datafile, so it would vanish on the next restart.
            var fixIndexes = function (store) {
                if (typeof store.removeIndexAsync == 'function') {
                    store.removeIndexAsync('TimeCreated')
                    .then(function () { return store.removeIndexAsync('tc'); })
                    .then(function () { return store.removeIndexAsync('time'); })
                    .then(function () { return store.ensureIndexAsync({ fieldName: 'time' }); })
                    .catch(function (e) { console.log('EVENTLOG: index cleanup: ' + (e.message || e)); });
                } else { // classic nedb: the executor runs queued tasks in submission order
                    store.removeIndex('TimeCreated', function () { });
                    store.removeIndex('tc', function () { });
                    store.removeIndex('time', function () { });
                    store.ensureIndex({ fieldName: 'time' }, function () { });
                }
            };
            fixIndexes(obj.eventsFile);
        }
        if (obj.settingsFile == null) {
            obj.settingsFile = new Datastore({ filename: meshserver.getConfigFilePath('plugin-eventlog-settings.db'), autoload: true });
            setCompaction(obj.settingsFile);
        }
        
        // one batch = one datafile append. Returns { count, maxTc }; maxTc is the collection ack value.
        obj.addEventsFor = function(nodeid, events) {
            if (!Array.isArray(events)) events = [ events ]; // a single event arrives as a bare object
            events = events.filter(function(e) { return e != null && typeof e == 'object'; });
            var r = prepEvents(nodeid, events);
            if (r.count == 0) return Promise.resolve(r);
            return new Promise(function(resolve, reject) {
                obj.eventsFile.insert(events, function (err) {
                    if (err) { reject(err); return; }
                    resolve(r);
                });
            }).then(function (res) { obj.capNode(nodeid); return res; });
        };

        obj.capNode = function(nodeid) {
            if (!obj.capDue(nodeid)) return;
            obj.eventsFile.count({ nodeid: nodeid }, function (err, n) {
                if (err || !(n > obj.maxEventsPerNode)) return;
                obj.eventsFile.find({ nodeid: nodeid }, { tc: 1 }).sort({ tc: -1 }).skip(obj.maxEventsPerNode - 1).limit(1).exec(function (err2, d) {
                    if (err2 || d == null || d[0] == null) return;
                    // chunked for the same reasons as the retention sweep: on a store upgraded from
                    // an older version a single node can be hundreds of thousands over the cap
                    removeInChunks({ nodeid: nodeid, tc: { $lt: d[0].tc } }, function (err3, removed) {
                        if (err3) { console.log('EVENTLOG: per-node cap error: ' + (err3.message || err3)); return; }
                        if (removed > 0) console.log('EVENTLOG: per-node cap removed ' + removed + ' events for ' + nodeid);
                    });
                });
            });
        };

        // Deleting a large set in one NeDB call is not an option, for two separate reasons:
        //   - remove(..., {multi:true}) resolves its candidates with validDocs.push(...docs), which
        //     throws "RangeError: Maximum call stack size exceeded" past roughly 100k documents, so
        //     retention would simply stop working on exactly the servers that need it most;
        //   - removing tens of thousands of documents in one call blocks the event loop for seconds
        //     (measured: ~8 s for 25k), which is the class of stall this release exists to remove.
        // find() uses a different code path and is safe at any size, so collect the ids first and
        // delete them in bounded batches, yielding between batches.
        var removeInChunks = function(query, callback) {
            var removed = 0;
            obj.eventsFile.find(query, { _id: 1 }).exec(function (err, docs) {
                if (err) { callback(err, 0); return; }
                if (docs == null || docs.length == 0) { callback(null, 0); return; }
                var ids = [];
                for (var i = 0; i < docs.length; i++) ids.push(docs[i]._id);
                var at = 0;
                var step = function () {
                    if (obj._closed || at >= ids.length) { callback(null, removed); return; }
                    var slice = ids.slice(at, at + NEDB_DELETE_CHUNK);
                    at += NEDB_DELETE_CHUNK;
                    obj.eventsFile.remove({ _id: { $in: slice } }, { multi: true }, function (e2, n) {
                        if (e2) { callback(e2, removed); return; }
                        removed += n;
                        setTimeout(step, 10);   // let the server serve requests between batches
                    });
                };
                step();
            });
        };

        // NeDB has no background expiry, so retention runs here instead of on a TTL index.
        obj.retentionSweep = function() {
            if (obj._closed || obj._sweeping) return;
            obj._sweeping = true;
            var cutoff = new Date(Date.now() - (obj.retentionSeconds * 1000));
            removeInChunks({ time: { $lt: cutoff } }, function (err, removed) {
                obj._sweeping = false;
                if (err) { console.log('EVENTLOG: retention sweep error: ' + (err.message || err)); return; }
                if (removed > 0) console.log('EVENTLOG: retention removed ' + removed + ' events older than ' + cutoff.toISOString());
            });
        };
        obj.setRetention = function(days) {
            var secs = 60 * 60 * 24 * (Number(days) || DEFAULT_RETENTION_DAYS);
            if (obj.retentionSeconds == secs) return;
            obj.retentionSeconds = secs;
        };

        obj.getEventsFor = function(nodeid, opts, params, callback) {
            if (typeof params == 'function') { callback = params; params = null; }
            opts = opts || {}; params = normParams(params);
            if (opts.historyEnabled === false) { callback(null, 0); return; }
            var proj = buildQuery(nodeid, opts, params);
            obj.eventsFile.count(proj, function (err, total) {
                obj.eventsFile.find(proj).sort({ tc: -1 }).skip(params.skip).limit(params.limit).exec(function (err, events) {
                    callback(events || [], total || 0);
                });
            });
        };
        obj.getStatsFor = function(nodeid, callback) {
            obj.eventsFile.count({ nodeid: nodeid }, function (err, count) {
                obj.eventsFile.find({ nodeid: nodeid }, { time: 1 }).sort({ time: -1 }).limit(1).exec(function (err, d) {
                    callback({ count: count || 0, last: (d && d[0]) ? d[0].time : null });
                });
            });
        };
        obj.getLastEventFor = function(nodeid, callback) {
            obj.eventsFile.find({ nodeid: nodeid }).sort({ tc: -1 }).limit(1).exec(function (err, events) {
                callback(events || []);
            });
        };
        // range-wide facet counts (per level / category / source) for the history sidebar
        obj.getFacetsFor = function(nodeid, since, callback) {
            var match = { nodeid: nodeid };
            if (since) match.tc = { $gte: Number(since) };
            obj.eventsFile.find(match, { Level: 1, LogName: 1, ProviderName: 1 }).exec(function (err, docs) {
                if (err || docs == null) { callback(null); return; }
                var out = { level: {}, log: {}, source: {} };
                for (var i = 0; i < docs.length; i++) {
                    var d = docs[i];
                    if (d.Level != null) out.level[d.Level] = (out.level[d.Level] || 0) + 1;
                    if (d.LogName != null && d.LogName !== '') out.log[d.LogName] = (out.log[d.LogName] || 0) + 1;
                    if (d.ProviderName != null && d.ProviderName !== '') out.source[d.ProviderName] = (out.source[d.ProviderName] || 0) + 1;
                }
                callback(out);
            });
        };
        obj.updateDefaultConfig = function(args) {
            args.type = 'configSet';
            args.uid = Math.random().toString(32).replace('0.', '');
            // NeDB's classic update() returns undefined, not a promise - wrap it so callers can .then()
            return new Promise(function(resolve, reject) {
                obj.settingsFile.update({default: true}, { $set: args }, {upsert: true}, function(err, numAffected) {
                    if (err) reject(err); else resolve(numAffected);
                });
            });
        };
        obj.updateConfig = function(id, args) {
            return new Promise(function(resolve, reject) {
                if (args._id != null) delete args._id;
                args.type = "configSet";
                args.uid = Math.random().toString(32).replace('0.', '');
                if (id == '_new') { 
                    obj.settingsFile.insert(args, function(err, newDocs) { 
                        if (err) reject(err);
                        newDocs.insertedId = newDocs._id;
                        resolve(newDocs);
                    });  
                } else {
                    obj.settingsFile.update({_id: id}, { $set: args }, {upsert: true, returnUpdatedDocs: true}, function(err, numDocs, upDocs) {
                        if (err) reject(err);
                        upDocs.insertedId = upDocs._id;
                        resolve(upDocs);
                    });
                }
            });
        };
        obj.getAllConfigSets = function(callback) {
            return new Promise(function(resolve, reject) {
                obj.settingsFile.find({type: "configSet"}).exec((err, sets) => {
                  if (err) reject(err);
                  resolve(sets);
                });
            });
        };
        obj.deleteConfigSet = function(id) {
            return new Promise(function(resolve, reject) {
                obj.settingsFile.remove({_id: id}, (err, numRemoved) => {
                    if (err) reject(err);
                    resolve(numRemoved);
                });
            });
        };
        obj.assignConfig = function(configId, sel) {
            return new Promise(function(resolve, reject) {
                if (configId == '') configId = "default";
                // multiple selections may not update, we need to delete and insert here
                obj.settingsFile.remove({type: "assignedConfig", asset: { $in: sel } }, { multi: true }, () => {
                      if (configId == '_clear') { resolve(); return; } // clearing: the removal above is all there is to do
                      var inserts = [];
                      sel.forEach((s) => {
                          inserts.push({
                            type: "assignedConfig",
                            asset: s,
                            configId: configId
                          });
                      });
                      obj.settingsFile.insert(inserts, () => resolve());
                  }
                )
            });
        }
        obj.getConfigAssignments = function(callback) {
            return new Promise(function(resolve, reject) {
                obj.settingsFile.find( { type: "assignedConfig" }, { _id: 0, asset: 1, configId: 1 } ).exec((err, docs) => {
                  resolve(docs);
                });
            });
        }
        obj.checkConfigAuth = function(uid) {
          return new Promise(function(resolve, reject) {
              obj.settingsFile.count( { type: "configSet", uid: uid } , function(err, count){
                  resolve(count);
              });
          });
        }

      // per-node metadata reported by the agent (OS, Linux log capabilities)
      obj.setNodeMeta = function(nodeid, meta) {
          return new Promise(function (resolve, reject) {
              obj.settingsFile.update({ type: 'nodeMeta', nodeid: nodeid }, { $set: { type: 'nodeMeta', nodeid: nodeid, os: meta.os || null, caps: meta.caps || null, updated: new Date() } }, { upsert: true }, function (err) {
                  if (err) reject(err); else resolve();
              });
          });
      };
      obj.getNodeMeta = function(nodeid, callback) {
          obj.settingsFile.find({ type: 'nodeMeta', nodeid: nodeid }).limit(1).exec(function (err, d) {
              callback((d && d[0]) ? { os: d[0].os, caps: d[0].caps } : null);
          });
      };

      obj.updateDBVersion = function(new_version) {
        return new Promise(function(resolve, reject) {
            obj.settingsFile.update({type: "db_version"}, { $set: {version: new_version} }, {upsert: true}, function(err, upDocs) {
                if (err) reject(err);
                resolve(upDocs);
            });
        });
      };
      
      obj.getDBVersion = function() {
        return new Promise(function(resolve, reject) {
            obj.settingsFile.find( { type: "db_version" }, { _id: 0, version: 1 } ).exec((err, docs) => {
              if (docs.length == 0) { resolve(1); }
              else resolve(docs[0]['version']);
            });
        });
      };
      
      obj.getDBVersion().then(function(current_version){
          if (current_version < 2) {
              var etsi = ['LogAlways', 'Critical', 'Error', 'Warning', 'Info', 'Verbose'];
              obj.eventsFile.find().sort({ TimeCreated: -1 }).exec(function (err, events) {
                  for (let [i, e] of Object.entries(events)) {
                      if (typeof e.LevelDisplayName == 'string' && e.LevelDisplayName != '' && etsi.indexOf(e.LevelDisplayName) !== -1) {
                          e.Level = etsi.indexOf(e.LevelDisplayName);
                          delete e.LevelDisplayName;
                          obj.eventsFile.update({_id: e._id}, {$set: e, $unset: {LevelDisplayName: ""} });
                      }
                  }
              });
              
              obj.updateDBVersion(2);
          }
          if (current_version < 3) { // add numeric event time (tc) used for sorting / range queries
              obj.eventsFile.find({ tc: { $exists: false } }).exec(function (err, events) {
                  for (let [i, e] of Object.entries(events || [])) {
                      obj.eventsFile.update({ _id: e._id }, { $set: { tc: tcOf(e.TimeCreated) } });
                  }
              });
              obj.updateDBVersion(3);
          }
          if (current_version < 4) { // v4: Linux events (additive fields Priority/Unit/Transport/BootId, nullable Id) - no data rewrite needed
              obj.updateDBVersion(4);
          }
      });

      obj.checkForDefault();
      obj.applyRetention();
      obj.startMaintenance();
    }
    
    return obj;
};
