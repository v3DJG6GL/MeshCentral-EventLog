/** 
* @description MeshCentral event log plugin
* @author Ryan Blenis
* @copyright 
* @license Apache-2.0
*/

"use strict";


module.exports.admin = function(parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshArgs = obj.parent.parent.parent.args;
    obj.util = require('util');
    
    obj.req = function(req, res, user) {
        if ((user.siteadmin & 0xFFFFFFFF) == 0) { res.sendStatus(401); return; }
        // JSON destined for an inline <script>: escape '<' so user-supplied names cannot break out of the tag
        var toJs = function(v) { return JSON.stringify(v).replace(/</g, '\\u003c'); };
        var vars = {
            configSets: 'null',
            configAssignments: 'null'
        };
        parent.db.getAllConfigSets()
        .then((cfs) => {
          vars.configSets = toJs(cfs);
        })
        .then(parent.db.getConfigAssignments)
        .then((cfa) => {
          vars.configAssignments = toJs(cfa);
          // Render the template ourselves instead of res.render('admin'): MeshCentral points the
          // shared Express 'views' directory at the plugin of the CURRENT request, so by the time
          // this async handler renders, a concurrent pluginadmin.ashx request from another plugin
          // with its own admin.handlebars (e.g. QuickCommands) may have moved it - serving that
          // plugin's page here.
          var path = require('path');
          var html = require('fs').readFileSync(path.join(__dirname, 'views', 'admin.handlebars')).toString();
          html = html.replace('{{{configSets}}}', vars.configSets).replace('{{{configAssignments}}}', vars.configAssignments);
          res.set('Content-Type', 'text/html; charset=utf-8');
          res.send(html);
        })
        .catch((e) => { console.log('EVENTLOG: admin page render error: ' + e); try { res.sendStatus(500); } catch (e2) { } });
    }
    
    obj.post = function(req, res, user) {
        res.sendStatus(401); return;
    }
    
    return obj;
}