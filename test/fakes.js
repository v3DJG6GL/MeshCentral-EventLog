'use strict';
// Minimal stand-ins for the MeshCentral objects the plugin talks to. Only what the tests need.
// Device group A: user 'alice' has full rights. Device group B: alice has no rights.

var PLUGIN = require('path').join(__dirname, '..', 'eventlog.js');

function makeNodes() {
    return {
        'node/d/nA': { _id: 'node/d/nA', meshid: 'mesh/d/A', name: 'pc-a', domain: 'd' },
        'node/d/nA2': { _id: 'node/d/nA2', meshid: 'mesh/d/A', name: 'pc-a2', domain: 'd' },
        'node/d/nB': { _id: 'node/d/nB', meshid: 'mesh/d/B', name: 'pc-b', domain: 'd' }
    };
}

// rightsByMesh: { 'mesh/d/A': 0xFFFFFFFF, ... } for the session's user
function makeWebserver(nodes, rightsByMesh) {
    return {
        wsagents: {}, wssessions2: {},
        GetNodeWithRights: function (domain, user, nodeid, cb) {
            var n = nodes[nodeid];
            setImmediate(function () {
                if (n == null) return cb(null, 0, false);
                var r = rightsByMesh[n.meshid] || 0;
                cb(r ? n : null, r, r != 0);
            });
        }
    };
}

// grants: { 'userid|key': true } (plugin permission granted); permApi false = an old MeshCentral without the framework
function makePluginHandler(grants, permApi) {
    var ph = { parent: { pluginHandler: {} }, pluginPermissions: {}, calls: [] };
    if (permApi !== false) {
        ph.registerPermissions = function (name, perms) { ph.pluginPermissions[name] = { definitions: perms }; ph.registered = perms; };
        ph.checkPluginPermission = function (user, name, key, nodeId, meshId) {
            ph.calls.push({ user: user._id, key: key, nodeId: nodeId, meshId: meshId });
            if (user.siteadmin === 0xFFFFFFFF) return true;
            return grants[user._id + '|' + key] === true;
        };
    }
    ph.parent.pluginHandler = ph;
    return ph;
}

function loadPlugin(ph) {
    delete require.cache[require.resolve(PLUGIN)];
    var plugin = require(PLUGIN).eventlog(ph);
    plugin.registerPermissions();
    return plugin;
}

function makeSession(user) {
    var sent = [];
    return {
        user: user, domain: { id: 'd' }, sent: sent,
        ws: { readyState: 1, send: function (s) { sent.push(JSON.parse(s)); } }
    };
}
function makeAgent(nodeid, meshid) {
    var sent = [];
    return { dbNodeKey: nodeid, dbMeshKey: meshid, domain: { id: 'd' }, sent: sent, send: function (s) { sent.push(JSON.parse(s)); } };
}

// resolves after pending setImmediate / promise callbacks have run
function settle() { return new Promise(function (r) { setTimeout(r, 20); }); }

module.exports = { makeNodes: makeNodes, makeWebserver: makeWebserver, makePluginHandler: makePluginHandler, loadPlugin: loadPlugin, makeSession: makeSession, makeAgent: makeAgent, settle: settle };
