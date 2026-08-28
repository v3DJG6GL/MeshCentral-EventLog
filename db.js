/** 
* @description MeshCentral-EventLog database module
* @author Ryan Blenis
* @copyright Ryan Blenis 2019
* @license Apache-2.0
*/

"use strict";
var Datastore = null;

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

module.exports.CreateDB = function(meshserver) {
    var obj = {};
    obj.dbVersion = 4;
    const expireLogEntrySeconds = (60 * 60 * 24 * 30); // 30 days (default, see retentionDays in the default config set)
    // numeric event time (ms since epoch) out of the PowerShell "/Date(ms)/" string or the stored digit array
    var tcOf = function(tcv) {
        if (Array.isArray(tcv)) tcv = tcv[0];
        var m = String(tcv).match(/\d+/);
        return m ? Number(m[0]) : 0;
    };
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
        if (params.ids) { // "1112, 100-199": Id is a number on Windows but a string (PID) on Linux, so match both types.
            var ors = [], singles = [];
            var pushBoth = function(n) { singles.push(n); singles.push(String(n)); };
            String(params.ids).split(',').forEach(function(part) {
                part = part.trim(); if (part == '') return;
                var m = part.match(/^(\d+)\s*-\s*(\d+)$/);
                if (m) {
                    var a = Number(m[1]), b = Number(m[2]);
                    if (b >= a && (b - a) <= 1000) { for (var v = a; v <= b; v++) pushBoth(v); } // expanded so string Ids match too
                    else ors.push({ Id: { $gte: a, $lte: b } }); // very wide range: numeric only
                } else if (/^\d+$/.test(part)) { pushBoth(Number(part)); }
            });
            if (singles.length) ors.push({ Id: { $in: singles } });
            if (ors.length) ands.push({ $or: ors });
        }
        if (ands.length) proj.$and = ands;
        return proj;
    };
    var cleanStrList = function(v, maxItems) { // sanitize a client-supplied filter list
        if (!Array.isArray(v)) return null;
        var out = v.filter(function(x) { return typeof x == 'string' && x.length < 256; }).slice(0, maxItems || 50);
        return out.length ? out : null;
    };
    var normParams = function(params) {
        params = params || {};
        return {
            limit: Math.min(Math.max(Number(params.limit) || 250, 1), 1000),
            skip: Math.max(Number(params.skip) || 0, 0),
            since: params.since || null,
            levels: (function() { if (!Array.isArray(params.levels)) return null; var l = params.levels.slice(0, 10).map(Number).filter((n) => !isNaN(n)); return l.length ? l : null; })(),
            logs: cleanStrList(params.logs, 50),
            sources: cleanStrList(params.sources, 100),
            text: (typeof params.text == 'string' && params.text.trim() != '') ? params.text.trim().substring(0, 256) : null,
            ids: (typeof params.ids == 'string' && params.ids.trim() != '') ? params.ids.trim().substring(0, 256) : null
        };
    };
    obj.applyRetention = function() {
        obj.getAllConfigSets().then(function(sets) {
            (sets || []).forEach(function(cs) { if (cs.default === true && cs.retentionDays) obj.setRetention(cs.retentionDays); });
        }).catch(function() { });
    };
    if (meshserver.args.mongodb) { // use MongDB
      loadModule(['mongodb']).MongoClient.connect(meshserver.args.mongodb, { useNewUrlParser: true, useUnifiedTopology: true }, function (err, client) {
          if (err != null) { console.log("Unable to connect to database: " + err); process.exit(); return; }
          Datastore = client;
          
          var dbname = 'meshcentral';
          if (meshserver.args.mongodbname) { dbname = meshserver.args.mongodbname; }
          const db = client.db(dbname);
          
          obj.eventsFile = db.collection('plugin_eventlog');
          obj.eventsFile.indexes(function (err, indexes) {
              // Check if we need to reset indexes
              var indexesByName = {}, indexCount = 0;
              for (var i in indexes) { indexesByName[indexes[i].name] = indexes[i]; indexCount++; }
              if ((indexCount != 5) || (indexesByName['NodeID1'] == null) || (indexesByName['TimeCreated1'] == null) || (indexesByName['ExpireTime1'] == null) || (indexesByName['Tc1'] == null)) {
                  // Reset all indexes
                  console.log('Resetting plugin (eventlog) indexes...');
                  obj.eventsFile.dropIndexes(function (err) {
                      obj.eventsFile.createIndex({ nodeid: 1 }, { name: 'NodeID1' });
                      obj.eventsFile.createIndex({ TimeCreated: 1 }, { name: 'TimeCreated1' });
                      obj.eventsFile.createIndex({ nodeid: 1, tc: -1 }, { name: 'Tc1' });
                      obj.eventsFile.createIndex({ 'time': 1}, { expireAfterSeconds: expireLogEntrySeconds, name: 'ExpireTime1' });
                  });
              }
          });
          obj.setRetention = function(days) {
              var secs = 60 * 60 * 24 * (Number(days) || 30);
              if (obj.retentionSeconds == secs) return;
              obj.retentionSeconds = secs;
              db.command({ collMod: 'plugin_eventlog', index: { name: 'ExpireTime1', expireAfterSeconds: secs } })
              .catch(function () {
                  return obj.eventsFile.dropIndex('ExpireTime1').catch(function () { })
                  .then(function () { return obj.eventsFile.createIndex({ time: 1 }, { expireAfterSeconds: secs, name: 'ExpireTime1' }); });
              })
              .catch(function (e) { console.log('EVENTLOG: could not update retention index: ' + e); });
          };
          
          obj.settingsFile = db.collection('plugin_eventlog_settings');
          
          obj.addEventsFor = function(nodeid, events) {
              if (!Array.isArray(events)) events = [ events ]; // a single event arrives as a bare object
              events = events.filter(function(e) { return e != null && typeof e == 'object'; });
              for (const [i, e] of Object.entries(events)) {
                  e.time = new Date();
                  e.nodeid = nodeid;
                  e.TimeCreated = String(e.TimeCreated).match(/\d+/g);
                  e.tc = tcOf(e.TimeCreated);
                  obj.eventsFile.insertOne(e);
              }
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
          obj.getConfigFor = function(nodeId, meshId) {
            return new Promise(function(resolve, reject) {
              obj.getConfigAssignments()
              .then((ca) => {
                  var configId = 'default';
                  ca.forEach((a) => {
                    if (a.asset == meshId) configId = a.configId;
                  });
                  ca.forEach((a) => {
                    if (a.asset == nodeId) configId = a.configId;
                  });
                  return configId;
              }).then((configId) => {
                var configBlob = null;
                obj.getAllConfigSets()
                .then((sets) => {
                  sets.forEach((s) => {
                    if (configId == 'default' && s.default === true) configBlob = s;
                    else if (s._id == configId) configBlob = s;
                  });
                  resolve(configBlob);
                });
              })
              .catch((e) => console.log('EVENTLOG: Error getting config for: ', e));
        });
      };
          obj.checkForDefault = function() {
              obj.getAllConfigSets()
              .then((cfgs) => {
                  if (cfgs.length == 0) {
                      obj.updateDefaultConfig({
                        name: 'Default',
                        liveLogs: 'Application,System',
                        liveNum: 100,
                        liveEntryTypes: [2,3],
                        historyEnabled: true,
                        historyLogs: 'Application,System',
                        historyEntryTypes: [2,3],
                        retentionDays: 30
                      });
                  }
              });
          };
          // per-node metadata reported by the agent (OS, Linux log capabilities)
          obj.setNodeMeta = function(nodeid, meta) {
              obj.settingsFile.updateOne({ type: 'nodeMeta', nodeid: nodeid }, { $set: { type: 'nodeMeta', nodeid: nodeid, os: meta.os || null, caps: meta.caps || null, updated: new Date() } }, { upsert: true })
              .catch(function (e) { console.log('EVENTLOG: setNodeMeta error: ' + e); });
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
        Datastore = loadModule(['@seald-io/nedb', '@yetzt/nedb', 'nedb']); // same fallback order as MeshCentral itself
        if (obj.eventsFile == null) {
            obj.eventsFile = new Datastore({ filename: meshserver.getConfigFilePath('plugin-eventlog-events.db'), autoload: true });
            if (typeof obj.eventsFile.setAutocompactionInterval == 'function') obj.eventsFile.setAutocompactionInterval(40000); else obj.eventsFile.persistence.setAutocompactionInterval(40000);
            obj.eventsFile.ensureIndex({ fieldName: 'nodeid' });
            obj.eventsFile.ensureIndex({ fieldName: 'TimeCreated' });
            obj.eventsFile.ensureIndex({ fieldName: 'tc' });
            obj.eventsFile.ensureIndex({ fieldName: 'time', expireAfterSeconds: expireLogEntrySeconds });
        }
        if (obj.settingsFile == null) {
            obj.settingsFile = new Datastore({ filename: meshserver.getConfigFilePath('plugin-eventlog-settings.db'), autoload: true });
            if (typeof obj.settingsFile.setAutocompactionInterval == 'function') obj.settingsFile.setAutocompactionInterval(40000); else obj.settingsFile.persistence.setAutocompactionInterval(40000);
        }
        
        obj.addEventsFor = function(nodeid, events) {
            if (!Array.isArray(events)) events = [ events ]; // a single event arrives as a bare object
            events = events.filter(function(e) { return e != null && typeof e == 'object'; });
            for (const [i, e] of Object.entries(events)) {
                e.time = new Date();
                e.nodeid = nodeid;
                e.TimeCreated = String(e.TimeCreated).match(/\d+/g);
                e.tc = tcOf(e.TimeCreated);
                obj.eventsFile.insert(e);
            }
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
        obj.setRetention = function(days) {
            var secs = 60 * 60 * 24 * (Number(days) || 30);
            if (obj.retentionSeconds == secs) return;
            obj.retentionSeconds = secs;
            obj.eventsFile.removeIndex('time', function () {
                obj.eventsFile.ensureIndex({ fieldName: 'time', expireAfterSeconds: secs });
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
                args.type = "configSet";
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
                obj.settingsFile.remove({type: "assignedConfig", asset: { $in: sel } },() => {
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
        obj.getConfigFor = function(nodeId, meshId) {
          return new Promise(function(resolve, reject) {
            obj.getConfigAssignments()
            .then((ca) => {
                var configId = 'default';
                ca.forEach((a) => {
                  if (a.asset == meshId) configId = a.configId;
                });
                ca.forEach((a) => {
                  if (a.asset == nodeId) configId = a.configId;
                });
                return configId;
            }).then((configId) => {
              var configBlob = null;
              obj.getAllConfigSets()
              .then((sets) => {
                sets.forEach((s) => {
                  if (configId == 'default' && s.default === true) configBlob = s;
                  else if (s._id == configId) configBlob = s;
                });
                resolve(configBlob);
              });
            })
            .catch((e) => console.log('EVENTLOG: Error getting config for: ', e));
        });
      };
      
      obj.checkForDefault = function() {
          obj.getAllConfigSets()
          .then((cfgs) => {
              if (cfgs.length == 0) {
                  obj.updateDefaultConfig({
                    name: 'Default',
                    liveLogs: 'Application,System',
                    liveNum: 100,
                    liveEntryTypes: [2,3],
                    historyEnabled: true,
                    historyLogs: 'Application,System',
                    historyEntryTypes: [2,3],
                    retentionDays: 30
                  });
              }
          });
      };
      
      // per-node metadata reported by the agent (OS, Linux log capabilities)
      obj.setNodeMeta = function(nodeid, meta) {
          obj.settingsFile.update({ type: 'nodeMeta', nodeid: nodeid }, { $set: { type: 'nodeMeta', nodeid: nodeid, os: meta.os || null, caps: meta.caps || null, updated: new Date() } }, { upsert: true }, function () { });
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
    }
    
    return obj;
}