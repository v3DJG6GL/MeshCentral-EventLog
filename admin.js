/**
* @description MeshCentral event log plugin
* @author Ryan Blenis
* @copyright
* @license Apache-2.0
*/

"use strict";

// ---- Assistant audit log as CSV (RFC 4180; cells that a spreadsheet would run as a formula are neutralised) ----
var AUDIT_CSV_COLUMNS = ['time', 'user', 'device', 'endpoint', 'model', 'mode', 'steps', 'rounds', 'bytesSent', 'redacted', 'tokensIn', 'tokensOut', 'durationMs', 'result', 'error'];

function csvCell(v) {
    if (v == null) return '';
    if (typeof v == 'number') return isFinite(v) ? String(v) : '';   // a number cannot carry a formula
    if (typeof v == 'boolean') return v ? 'true' : 'false';
    var s = (typeof v == 'object') ? JSON.stringify(v) : String(v);
    // = + - @ tab CR (and their full-width forms) start a formula in Excel / LibreOffice / Sheets
    if (/^[=+\-@\t\r＝＋－＠]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function csvTime(t) {
    if (t == null || t === '') return '';
    var d = (t instanceof Date) ? t : new Date((typeof t == 'string' && /^\d+$/.test(t)) ? Number(t) : t);
    return isNaN(d.getTime()) ? '' : d.toISOString();
}

function csvNum(v) { var n = Number(v); return (v == null || v === '' || !isFinite(n)) ? null : n; }

function auditCsv(rows) {
    var lines = [AUDIT_CSV_COLUMNS.join(',')];
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
        if (r == null || typeof r != 'object') return;
        var redacted = null;
        if (r.redactionCounts != null && typeof r.redactionCounts == 'object') {
            redacted = 0;
            Object.keys(r.redactionCounts).forEach(function (k) { var n = Number(r.redactionCounts[k]); if (isFinite(n)) redacted += n; });
        } else redacted = csvNum(r.redactionCounts);
        var cells = [
            csvTime(r.time),
            (r.username != null && r.username !== '') ? r.username : r.userid,
            (r.nodename != null && r.nodename !== '') ? r.nodename : r.nodeid,
            r.endpointName,
            r.model,
            (r.mode == null && r.kind === 'settings') ? 'settings' : r.mode,
            Array.isArray(r.steps) ? r.steps.length : csvNum(r.steps),
            csvNum(r.rounds),
            csvNum(r.bytesSent),
            redacted,
            csvNum(r.tokensIn),
            csvNum(r.tokensOut),
            csvNum(r.durationMs),
            (r.result == null && r.kind === 'settings' && Array.isArray(r.changed)) ? 'changed: ' + r.changed.join(' ') : r.result,
            r.error
        ];
        lines.push(cells.map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
}

// Query parameter -> epoch milliseconds (accepts milliseconds or anything Date.parse understands), else undefined.
function queryTime(v) {
    if (typeof v != 'string' || v === '') return undefined;
    if (/^\d{1,15}$/.test(v)) return Number(v);
    var t = Date.parse(v);
    return isNaN(t) ? undefined : t;
}
function queryId(v) { return (typeof v == 'string' && v !== '' && v.length <= 512) ? v : undefined; }

module.exports.auditCsv = auditCsv;

module.exports.admin = function(parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshArgs = obj.parent.parent.parent.args;
    obj.util = require('util');

    obj.auditCsvReq = function(req, res, user) {
        if ((user.siteadmin >>> 0) !== 0xFFFFFFFF) { res.sendStatus(403); return; }
        if (parent.ai == null || parent.ai.store == null || typeof parent.ai.store.auditQuery != 'function') { res.sendStatus(404); return; }
        var q = req.query || {};
        Promise.resolve()
        .then(function () {
            return parent.ai.store.auditQuery({ since: queryTime(q.since), until: queryTime(q.until), userid: queryId(q.userid), nodeid: queryId(q.nodeid), skip: 0, limit: 5000 });
        })
        .then(function (r) {
            var csv = auditCsv((r && r.rows) || []);
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', 'attachment; filename="eventlog-assistant-audit.csv"');
            res.set('Cache-Control', 'no-store');
            res.set('X-Content-Type-Options', 'nosniff');
            res.send('﻿' + csv);   // BOM: Excel reads the file as UTF-8
        })
        .catch(function (e) { console.log('EVENTLOG AI: audit CSV export failed: ' + ((e && e.message) || e)); try { res.sendStatus(500); } catch (e2) { } });
    };

    obj.req = function(req, res, user) {
        if ((user.siteadmin & 0xFFFFFFFF) == 0) { res.sendStatus(401); return; }
        if (req.query && req.query.ai == 'auditcsv') { obj.auditCsvReq(req, res, user); return; }
        // JSON destined for an inline <script>: escape '<' so user-supplied names cannot break out of the tag
        var toJs = function(v) { return JSON.stringify(v).replace(/</g, '\\u003c'); };
        var vars = {
            configSets: 'null',
            configAssignments: 'null',
            // no secrets here: endpoints, settings and the audit log are loaded over the websocket (aiAdminGet)
            aiAdmin: toJs({ full: (user.siteadmin >>> 0) === 0xFFFFFFFF, available: parent.ai != null })
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
          // function replacers: a string replacement would interpret '$&', "$'" etc. inside user-entered text (alert rules, names)
          html = html.replace('{{{configSets}}}', function() { return vars.configSets; })
                     .replace('{{{configAssignments}}}', function() { return vars.configAssignments; })
                     .replace('{{{aiAdmin}}}', function() { return vars.aiAdmin; });
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
