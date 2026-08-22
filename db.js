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
    obj.dbVersion = 3;
    const expireLogEntrySeconds = (60 * 60 * 24 * 30); // 30 days (default, see retentionDays in the default config set)
    // numeric event time (ms since epoch) out of the PowerShell "/Date(ms)/" string or the stored digit array
    var tcOf = function(tcv) {
        if (Array.isArray(tcv)) tcv = tcv[0];
        var m = String(tcv).match(/\d+/);
        return m ? Number(m[0]) : 0;
    };
    var buildQuery = function(nodeid, opts, params) {
        var proj = { nodeid: nodeid };
        if (opts.historyLogs) proj.LogName = { $in: String(opts.historyLogs).split(',') };
        if (opts.historyEntryTypes) proj.Level = { $in: opts.historyEntryTypes.map((n) => Number(n)) };
        if (params.since) proj.tc = { $gte: Number(params.since) };
        return proj;
    };
    var normParams = function(params) {
        params = params || {};
        return { limit: Math.min(Math.max(Number(params.limit) || 250, 1), 1000), skip: Math.max(Number(params.skip) || 0, 0), since: params.since || null };
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
              if (Object.getOwnPropertyNames(events).length == 6 && events.LogName) events = [ events ];
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
            if (Object.getOwnPropertyNames(events).length == 6 && events.LogName) events = [ events ];
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
            return obj.settingsFile.update({default: true}, { $set: args }, {upsert: true});
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
      });
      
      obj.checkForDefault();
      obj.applyRetention();
    }
    
    return obj;
}