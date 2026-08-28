/** 
* @description MeshCentral event log plugin
* @author Ryan Blenis
* @copyright 
* @license Apache-2.0
*/

"use strict";
var mesh;
var periodicEventLogTimer = null;
var obj = this;
var _sessionid;
var isWsconnection = false;
var wscon = null;
var debug_flag = false;

var dbg = function(str) {
    if (debug_flag !== true) return;
    var fs = require('fs');
    var logStream = fs.createWriteStream('eventlog.txt', {'flags': 'a'});
    // use {'flags': 'a'} to append and {'flags': 'w'} to erase and write a new file
    logStream.write('\n'+new Date().toLocaleString()+': '+ str);
    logStream.end('\n');
}


var sendlogCallback = function (retObj) {
  if (retObj.stdout.length > 0) {
      if (!isWsconnection)
      mesh.SendCommand({ 
          "action": "plugin", 
          "plugin": "eventlog",
          "pluginaction": "sendlog",
          "data": JSON.stringify(retObj.stdout), 
          "sessionid": _sessionid,
          "tag": "console"
      });
  }
};

var getlogCallback = function (output) { 
    if (output.stderr.length > 0) {
        if (!isWsconnection) sendConsoleText(output.stderr);
    }
    var lines = output.stdout.trim().split('\r\n');
    for (var i in lines) {
        if (!isWsconnection) sendConsoleText(lines[i]);
    }
    if (isWsconnection) {
        var response = {};
        var db = require('SimpleDataStore').Shared();
        var cfg = getEventLogConfig();
        response.uid = cfg.uid;
        response.data = JSON.parse(output.stdout);
        wscon.write(new Buffer(JSON.stringify(response)));
    }
};

var pushTmpFile = function(fn) {
    var fns = getTmpFileNames();
    fns.push({ name: fn, time:  Math.floor(new Date() / 1000) })
    db.Put('pluginEventLog_tmpfns', fns);
    dbg('Pushed tmp ' + fn)
};
var popTmpFile = function(fn) { // remove tmp file and other (possibly orphaned) files older than 120 sec
    var now = Math.floor(new Date() / 1000);
    var fns = getTmpFileNames();
    var newFns = [];
    fns.forEach(function(t) {
        dbg('t is ' + JSON.stringify(t))
        if ( t.name == fn || ((now - t.time) > 120)) {
            try { require('fs').unlinkSync(t.name); } catch(e) { }
            dbg('popped tmp ' + fn)
        } else {
            newFns.push(t); dbg('pushing ' + JSON.stringify(t))
        }
    });
    dbg('tmpfns written ' + newFns)
    db.Put('pluginEventLog_tmpfns', newFns);
};
var runPwshCollector = function(func, passedParams) {
    const defaultParams = {
        fromLog: 'Application',
        num: 10,
        entryType: 'Error,Warning',
        convertToJson: true,
        sinceTime: null,
        entryTypeNum: null
    };
    // duktape may not provide Object.assign: merge manually
    var params = {};
    for (var dk in defaultParams) { params[dk] = defaultParams[dk]; }
    for (var pk in passedParams) { if (passedParams[pk] !== undefined) params[pk] = passedParams[pk]; }
    var fileRand = Math.random().toString(32).replace('0.', '');
    var fileName = 'psout'+fileRand+'.txt';
    var convertToJsonText = '';
    var sinceTimePre = '';
    var sinceTimeStr = '';
    if (params.sinceTime != null) {
        sinceTimePre = '$sinceTime = (Get-Date 01.01.1970)+([System.TimeSpan]::fromseconds('+Number(params.sinceTime-1)+'));';
        sinceTimeStr = 'StartTime=$sinceTime;';
    }
    var entryTypes = {
      'LogAlways': 0,
      'Critial': 1,
      'Error': 2,
      'Warning': 3,
      'Info': 4,
      'Verbose': 5
    };
    var entryTypeCodes = [];
    if (params.entryTypeNum === null) {
        var etObj = params.entryType.split(',');
        for (var i in etObj) {
            entryTypeCodes.push(entryTypes[etObj[i]]); 
        }
    } else {
        entryTypeCodes = params.entryTypeNum;
    }
    if (params.convertToJson) {
      convertToJsonText = " | convertTo-JSON -Compress"
    }
    var ret = {};
    pushTmpFile(fileName);
    ret.child = require('child_process').execFile("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",["-command \""+sinceTimePre+"Get-WinEvent -FilterHashTable @{"+sinceTimeStr+"LogName='"+params.fromLog.split(',').join("','")+"'; Level="+entryTypeCodes.join(',')+"} -MaxEvents "+params.num+" | Select-Object LogName, Level, TimeCreated, ProviderName, Message, Id "+convertToJsonText+" | Out-File "+fileName+" -Encoding UTF8\""]);
    ret.child.stdout.str = ''; ret.child.stdout.on('data', function (c) { this.str += c.toString(); });
    ret.child.stderr.str = ''; ret.child.stderr.on('data', function (c) { this.str += c.toString(); });
    //ret.child.on('exit', func(ret));
    ret.child.on('exit', function (code) {
        var o = {};
        o.stdout = this.stdout.str;
        o.stderr = this.stderr.str;
        try {
            // buffer the output to text and strip nasty characters
            o.stdout = require('fs').readFileSync(fileName, 'utf8').toString();
            if (o.stdout) {
                o.stdout = o.stdout.trim();
                o.stdout = o.stdout.replace(/^\uFEFF/, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); 
                func(o);
            }
            popTmpFile(fileName);
            dbg('Running powershell: '+sinceTimePre+"Get-WinEvent -FilterHashTable @{"+sinceTimeStr+"LogName='"+params.fromLog.split(',').join("','")+"'; Level="+entryTypeCodes.join(',')+"} -MaxEvents "+params.num+" | Select-Object LogName, Level, TimeCreated, ProviderName, Message, Id "+convertToJsonText+" | Out-File "+fileName);
        } catch (e) {
            dbg('Powershell run error: '+e.stack);
        }
        
    });
};

var runPwshTest = function(func) {
    dbg('pwsh test function');
    var fileRand = Math.random().toString(32).replace('0.', '');
    var fileName = 'psout'+fileRand+'.txt';
    pushTmpFile(fileName);
    var ret = {};
    ret.child = require('child_process').execFile("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",["-command \"$PSVersionTable.PSVersion.Major | Out-File "+fileName+" -Encoding UTF8\""]);
    ret.child.stdout.str = ''; ret.child.stdout.on('data', function (c) { this.str += c.toString(); });
    ret.child.stderr.str = ''; ret.child.stderr.on('data', function (c) { this.str += c.toString(); });
    //ret.child.on('exit', func(ret));
    ret.child.on('exit', function (code) {
        var o = {};
        o.stdout = this.stdout.str;
        o.stderr = this.stderr.str;
        try {
            // buffer the output to text and strip nasty characters
            o.stdout = require('fs').readFileSync(fileName, 'utf8').toString();
            if (o.stdout) {
                o.stdout = o.stdout.trim();
                o.stdout = o.stdout.replace(/^\uFEFF/, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); 
                func(o);
            }
            popTmpFile(fileName);
        } catch (e) {
            dbg('Powershell run error: '+e.stack);
        }
        
    });
};

// ------------------------------------------------------------------
//  Linux (systemd-journald) support
//  duktape is ES5-only here: no arrow functions, let, template
//  literals, spread, Object.assign or Array.prototype.includes.
// ------------------------------------------------------------------
var PLAT = (process.platform == 'win32') ? 'win32' : ((process.platform == 'linux') ? 'linux' : null);
var linuxCaps = null;      // { journalctl, jver, persistent, audit, dmesgJson, files: [] }
var linuxTmpDir = null;

var pickTmpDir = function() {
    if (linuxTmpDir != null) return linuxTmpDir;
    var fs = require('fs');
    var cands = ['/usr/local/mesh', '/var/tmp', '/tmp'];
    for (var i = 0; i < cands.length; i++) {
        try { if (fs.existsSync(cands[i])) { linuxTmpDir = cands[i]; return linuxTmpDir; } } catch (e) { }
    }
    linuxTmpDir = '/tmp';
    return linuxTmpDir;
};

// run a shell script via /bin/sh; async (exit event, the agent event loop keeps running).
// stdout is byte-capped so a runaway command cannot exhaust agent memory. cb({stdout, stderr, code})
var shRun = function(cmd, cb) {
    var child = require('child_process').execFile('/bin/sh', ['sh']);
    child.stdout.str = ''; child.stdout.on('data', function (c) {
        this.str += c.toString();
        if (this.str.length > 4194304) { try { child.kill(); } catch (e) { } }
    });
    child.stderr.str = ''; child.stderr.on('data', function (c) { this.str += c.toString(); });
    child.on('exit', function (code) {
        try { cb({ stdout: child.stdout.str, stderr: child.stderr.str, code: code }); } catch (e) { dbg('shRun cb error: ' + e); }
    });
    child.stdin.write(cmd + '\nexit\n');
};

// keep only characters that are safe inside a double-quoted shell argument
var shSanitize = function(s) {
    return String(s).replace(/[^A-Za-z0-9@:;,._+=\/-]/g, '');
};

var probeLinuxCaps = function(cb) {
    if (linuxCaps != null) { cb(linuxCaps); return; }
    var script = 'journalctl --version 2>/dev/null | head -n 1\n' +
        'test -d /var/log/journal && echo P=1 || echo P=0\n' +
        'test -r /var/log/audit/audit.log && echo A=1 || echo A=0\n' +
        'dmesg --json >/dev/null 2>&1 && echo D=1 || echo D=0\n' +
        'for f in syslog messages auth.log secure kern.log daemon.log cron; do test -r /var/log/$f && echo F=$f; done';
    shRun(script, function (o) {
        var caps = { journalctl: false, jver: 0, persistent: false, audit: false, dmesgJson: false, files: [] };
        var lines = String(o.stdout).split('\n');
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].replace(/\r/g, '').replace(/^\s+|\s+$/g, '');
            if (ln.substring(0, 8) == 'systemd ') { var m = ln.match(/systemd (\d+)/); if (m) { caps.journalctl = true; caps.jver = Number(m[1]); } }
            else if (ln == 'P=1') caps.persistent = true;
            else if (ln == 'A=1') caps.audit = true;
            else if (ln == 'D=1') caps.dmesgJson = true;
            else if (ln.substring(0, 2) == 'F=') caps.files.push(ln.substring(2));
        }
        linuxCaps = caps;
        dbg('linux caps: ' + JSON.stringify(caps));
        cb(caps);
    });
};

// syslog priority (0-7) -> the plugin's Windows-style level (0-5)
var priToLevel = function(p) {
    if (p <= 2) return 1;  // emerg/alert/crit -> Critical
    if (p == 3) return 2;  // err              -> Error
    if (p == 4) return 3;  // warning          -> Warning
    if (p == 7) return 5;  // debug            -> Verbose
    return 4;              // notice/info      -> Info
};

// the config's level list (0-5) -> the set of syslog priorities to collect
var levelsToPriorities = function(levels) {
    if (levels == null || levels.length == 0) return null;
    var map = { 0: [0,1,2,3,4,5,6,7], 1: [0,1,2], 2: [3], 3: [4], 4: [5,6], 5: [7] };
    var seen = {}, out = [];
    for (var i = 0; i < levels.length; i++) {
        var pris = map[Number(levels[i])];
        if (pris == null) continue;
        for (var j = 0; j < pris.length; j++) { if (!seen[pris[j]]) { seen[pris[j]] = true; out.push(pris[j]); } }
    }
    return out.length ? out : null;
};

// derive a KSystemLog/GNOME-Logs-style category from journal metadata (becomes LogName)
var journalCategory = function(j) {
    if (j._TRANSPORT == 'kernel') return 'Kernel';
    if (j._TRANSPORT == 'audit') return 'Audit';
    var fac = Number(j.SYSLOG_FACILITY);
    if (fac == 4 || fac == 10) return 'Auth';
    if (fac == 9 || fac == 15) return 'Cron';
    if (j._TRANSPORT == 'stdout' || fac == 1) return 'Application'; // program output / user facility (GNOME Logs: "Applications")
    if (fac == 3) return 'Daemon';
    if (fac == 0) return 'Kernel';
    return 'System';
};

// MESSAGE fields with non-UTF8 bytes arrive as arrays of byte values
var journalMsgText = function(m) {
    if (m == null) return '';
    if (typeof m == 'string') return m;
    if (m instanceof Array) {
        var s = '';
        for (var i = 0; i < m.length; i += 1000) { s += String.fromCharCode.apply(null, m.slice(i, i + 1000)); }
        return s;
    }
    return String(m);
};

// journalctl -o json is NDJSON: one object per line. Returns {events, cursor, truncated}.
var parseJournalNdjson = function(txt, params) {
    var out = { events: [], cursor: null, truncated: false };
    var priSet = null;
    if (params.priorities != null) { priSet = {}; for (var i = 0; i < params.priorities.length; i++) { priSet[params.priorities[i]] = true; } }
    var lines = String(txt).split('\n');
    var max = 2000; // batch cap; the cursor of the last examined line lets the next run drain the rest
    for (var li = 0; li < lines.length; li++) {
        var ln = lines[li];
        if (ln.length < 2) continue;
        var j = null;
        try { j = JSON.parse(ln); } catch (e) { continue; } // tolerate the truncated trailing line of a byte-capped read
        if (out.events.length >= max) { out.truncated = true; break; }
        if (j.__CURSOR) out.cursor = j.__CURSOR;
        var pri = Number(j.PRIORITY); if (isNaN(pri)) pri = 6;
        if (priSet != null && !priSet[pri]) continue;
        var cat = journalCategory(j);
        if (params.catFilter != null && cat != params.catFilter) continue;
        var tms = Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000); if (isNaN(tms)) tms = 0;
        out.events.push({
            LogName: cat,
            Level: priToLevel(pri),
            Priority: pri,
            TimeCreated: '/Date(' + tms + ')/',   // journald timestamps are UTC epoch microseconds
            ProviderName: j.SYSLOG_IDENTIFIER || j._COMM || j._SYSTEMD_UNIT || '',
            Unit: j._SYSTEMD_UNIT || '',
            Transport: j._TRANSPORT || '',
            BootId: j._BOOT_ID || '',
            Id: (j._PID != null) ? String(j._PID) : '',
            Message: journalMsgText(j.MESSAGE)
        });
    }
    return out;
};

// build and run one journalctl query. func({events, cursor, truncated, error?})
var runJournalCollector = function(func, passedParams) {
    var params = { num: 200, priorities: null, cursor: null, sinceSec: null, unit: null, kernelOnly: false, boot: false, facility: null, transport: null, catFilter: null, maxAgeHours: 24, live: false };
    for (var pk in passedParams) { if (passedParams[pk] !== undefined && passedParams[pk] !== null) params[pk] = passedParams[pk]; }
    var fileName = pickTmpDir() + '/evljout' + Math.random().toString(32).replace('0.', '') + '.txt';
    pushTmpFile(fileName);
    var cmd = 'journalctl --no-pager -o json';
    if (linuxCaps != null && linuxCaps.jver >= 236) cmd += ' --output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,SYSLOG_FACILITY,_PID,_COMM,_SYSTEMD_UNIT,_TRANSPORT,_BOOT_ID';
    if (params.live) {
        cmd += ' -r -n ' + (Number(params.num) || 200);
        if (params.sinceSec != null) cmd += ' --since "@' + Math.floor(Number(params.sinceSec)) + '"';
        if (params.boot) cmd += ' -b';
    } else {
        // incremental history collection: chronological order so the last line's cursor is the resume point
        if (params.cursor != null && params.cursor != '') cmd += ' --after-cursor="' + shSanitize(params.cursor) + '"';
        else if (params.sinceSec != null) cmd += ' --since "@' + Math.floor(Number(params.sinceSec)) + '"';
        else cmd += ' --since "-' + (Number(params.maxAgeHours) || 24) + 'h"'; // bound the first-run backfill
    }
    if (params.priorities != null) { var mx = 0; for (var i = 0; i < params.priorities.length; i++) { if (params.priorities[i] > mx) mx = params.priorities[i]; } cmd += ' -p ' + mx; } // -p N = 0..N prefilter; exact set applied in the parser
    if (params.kernelOnly) cmd += ' -k';
    if (params.unit != null) cmd += ' -u "' + shSanitize(params.unit) + '"';
    if (params.facility != null && linuxCaps != null && linuxCaps.jver >= 232) cmd += ' --facility=' + shSanitize(params.facility);
    if (params.transport != null) cmd += ' ' + shSanitize('_TRANSPORT=' + params.transport);
    cmd += ' | head -n 2100 | head -c 8388608 > ' + fileName; // hard output bounds; journalctl errors stay on stderr
    dbg('Running journalctl: ' + cmd);
    shRun(cmd, function (o) {
        try {
            var txt = '';
            try { txt = require('fs').readFileSync(fileName).toString(); } catch (fe) { }
            popTmpFile(fileName);
            var res = parseJournalNdjson(txt, params);
            if (o.stderr != null && o.stderr.length > 0 && res.events.length == 0) {
                dbg('journalctl stderr: ' + o.stderr.substring(0, 300));
                if (params.cursor != null && o.stderr.toLowerCase().indexOf('cursor') !== -1) res.error = 'cursor';
            }
            func(res);
        } catch (e) { dbg('journal run error: ' + e); try { popTmpFile(fileName); } catch (e2) { } }
    });
};

// periodic history batch finished: push to the server; the cursor is committed when the server acks (setLVDOC)
var linuxGatherCallback = function(res) {
    try {
        if (res.error == 'cursor') { db.Put('pluginEventLog_jcursor', ''); dbg('journal cursor invalid, cleared (journal rotated?)'); return; }
        if (res.events.length == 0) {
            if (res.cursor != null) db.Put('pluginEventLog_jcursor', res.cursor); // nothing to send: advance locally
            return;
        }
        mesh = require('MeshAgent');
        var cfg = getEventLogConfig();
        mesh.SendCommand({
            "action": "plugin", "plugin": "eventlog", "pluginaction": "gatherlogs",
            "uid": (cfg.uid != null) ? cfg.uid : null,
            "os": "linux", "cursor": res.cursor, "caps": linuxCaps,
            "data": JSON.stringify(res.events)
        });
    } catch (e) { dbg('linuxGatherCallback error: ' + e); }
};

var capturePeriodicLinux = function() {
    try {
        dbg('Periodic linux runner starting');
        var cfg = getEventLogConfig();
        if (cfg.historyEnabled !== true) return;
        probeLinuxCaps(function (caps) {
            if (!caps.journalctl) { dbg('journalctl not available; periodic collection disabled'); return; }
            var cur = db.Get('pluginEventLog_jcursor');
            if (cur == '' || cur == null) cur = null;
            var lv = db.Get('pluginEventLog_lvdoc_lx');
            if (lv == '' || lv == null || isNaN(Number(lv))) lv = null; else lv = Number(lv);
            runJournalCollector(linuxGatherCallback, { cursor: cur, sinceSec: lv, priorities: levelsToPriorities(cfg.historyEntryTypes) });
        });
    } catch (e) { dbg('Periodic linux runner error: ' + e); }
};

var gatherlogsCallback = function(output) {
    mesh = require('MeshAgent');
    var db = require('SimpleDataStore').Shared();
    var cfg = getEventLogConfig();
    var cuid = null;
    if (cfg.uid != null) {
      cuid = cfg.uid;
    }
    mesh.SendCommand({ "action": "plugin", "plugin": "eventlog", "pluginaction": "gatherlogs", "uid": cuid, "data": output.stdout});
};

var capturePeriodicEventLog = function() {
    if (PLAT == 'linux') { capturePeriodicLinux(); return; }
    if (process.platform != 'win32') {
      dbg('Periodic runner not running (unsupported platform)');
      return false;
    }
    try {
        dbg('Periodic runner starting');
        var db = require('SimpleDataStore').Shared();
        // this is where we collect logs, either to a file to be Xferred later, or now, whichev.
        var lvdoc = db.Get('pluginEventLog_lvdoc');
        if (lvdoc == '' || lvdoc == null || isNaN(Number(lvdoc))) lvdoc = null;
        var cfg = getEventLogConfig();
        var fromLogs = cfg.historyLogs;
        var entryTypes = cfg.historyEntryTypes;
        if (cfg.historyEnabled !== true) return;
        runPwshCollector(gatherlogsCallback, {fromLog: fromLogs, num: 200, sinceTime: lvdoc, entryTypeNum: entryTypes });
    } catch (e) { dbg('Periodic runner error: ' + e); }
};

if (periodicEventLogTimer == null) { periodicEventLogTimer = setInterval(capturePeriodicEventLog, 1*60*1000); } // 1 minute(s)

function consoleaction(args, rights, sessionid, parent) {
        isWsconnection = false;
        wscon = parent;
        var _sessionid = sessionid;
        if (typeof args['_'] == 'undefined') {
          args['_'] = [];
          args['_'][1] = args.pluginaction;
          args['_'][2] = null;
          args['_'][3] = null;
          args['_'][4] = null;
          isWsconnection = true;
        }
        
        if (PLAT == null) {
            if (isWsconnection) {
                parent.write(new Buffer(JSON.stringify({ctrlChannel: "102938", type: "close"})));
            }
            return "Eventlog is only available on Windows and Linux endpoints.";
        }
        
        var fnname = args['_'][1];
        mesh = parent;
        
        switch (fnname) {
          case 'serviceCheck': {
              // null function- simply can be called to load the plugin and make sure the timer is running
              if (PLAT == 'linux' && linuxCaps == null) { try { probeLinuxCaps(function () { }); } catch (e) { } }
              break;
          }
          case 'getlog': {
              if (PLAT == 'linux') return "On Linux endpoints, use the Event Log tab on the device page.";
              var ret = {};

              var data, fromLog = 'Application', num = 10, entryType = 'Error,Warning', convertToJson = true;
              var convertToJsonText = '';
              
              if (args['_'][2]) {
                fromLog = args['_'][2];
              }
              if (args['_'][3]) {
                num = args['_'][3];
              }
              if (args['_'][4]) {
                entryType = args['_'][4];
              }
              if (args['_'][5]) {
                convertToJson = args['_'][5];
              }
              if (convertToJson) {
                convertToJsonText = " | convertTo-JSON"
              }
            
              runPwshCollector(getlogCallback, {fromLog: fromLog, num: num, entryType: entryType, convertToJson: convertToJson});
            
              return "Getting logs. Please wait...";
          break; 
          }
          case 'sendlog': {
            if (PLAT == 'linux') return "On Linux endpoints, use the Event Log tab on the device page.";
            var ret = {};
            
            var data, fromLog = 'Application', num = 10, entryType = 'Error,Warning';
            if (args['_'][2]) {
              fromLog = args['_'][2];
            }
            if (args['_'][3]) {
              num = args['_'][3];
            }
            if (args['_'][4]) {
              entryType = args['_'][4];
            }
            if (args['_'][5]) {
              convertToJson = args['_'][5];
            }
            
            runPwshCollector(sendlogCallback, {fromLog: fromLog, num: num, entryType: entryType, convertToJson: convertToJson});
            
            return "Sending logs.";
          break; 
        }
        case 'getlivelogs': {
            var db = require('SimpleDataStore').Shared();
            var cfg = getEventLogConfig();
            var logList = String(cfg.liveLogs).split(',');
            var num = Number(args.num);
            if (isNaN(num) || num <= 0) num = Number(cfg.liveNum) || 100;
            if (num > 1000) num = 1000;
            var entryTypes = cfg.liveEntryTypes || cfg.historyEntryTypes;
            if (PLAT == 'linux') {
                var lxWs = isWsconnection, lxCon = wscon; // capture: the callback runs after consoleaction returned
                var lxSince = (args.since != null && !isNaN(Number(args.since))) ? (Number(args.since) + 1) : null;
                var lxSel = (args.lsel != null) ? String(args.lsel) : '';
                probeLinuxCaps(function (caps) {
                    var reply = function (events) {
                        if (!lxWs || lxCon == null) return;
                        try { lxCon.write(new Buffer(JSON.stringify({ uid: cfg.uid, os: 'linux', caps: caps, data: events }))); } catch (e) { dbg('live reply error ' + e); }
                    };
                    if (!caps.journalctl) {
                        reply([{ LogName: 'System', Level: 3, Priority: 4, TimeCreated: '/Date(' + new Date().getTime() + ')/', ProviderName: 'eventlog-plugin', Unit: '', Transport: '', BootId: '', Id: '',
                                 Message: 'systemd-journald was not found on this endpoint. Flat-file /var/log support is planned for a later plugin version.' }]);
                        return;
                    }
                    var p = { live: true, num: num, priorities: levelsToPriorities(entryTypes), sinceSec: lxSince };
                    if (lxSel == 'kernel') p.kernelOnly = true;
                    else if (lxSel == 'auth') { p.facility = 'auth,authpriv'; p.catFilter = 'Auth'; }
                    else if (lxSel == 'audit') { p.transport = 'audit'; p.catFilter = 'Audit'; }
                    else if (lxSel == 'boot') p.boot = true;
                    else if (lxSel.substring(0, 5) == 'unit:') p.unit = lxSel.substring(5);
                    try { runJournalCollector(function (res) { reply(res.events); }, p); } catch (e) { dbg('getlivelogs linux error ' + e); }
                });
                break;
            }
            var sinceTime = null;
            if (args.since != null && !isNaN(Number(args.since))) {
                // args.since is UTC seconds; the collector builds its StartTime from local 1970-01-01, so shift by the local offset
                sinceTime = Number(args.since) - (new Date().getTimezoneOffset() * 60) + 1;
            }
            try { 
              for (var i in logList) {
                runPwshCollector(getlogCallback, {'fromLog': logList[i], 'num': num, 'entryTypeNum': entryTypes, 'convertToJson': true, 'sinceTime': sinceTime});
              }
            } catch(e) { dbg('getlivelogs error '+e); }
            break;
        }
        case 'collectnow': { // run the periodic history collection right away (requested from the device page)
            try { capturePeriodicEventLog(); } catch (e) { dbg('collectnow error ' + e); }
            break;
        }
        case 'setLVDOC': { // set last verified date of collection (e.g. last successful log collection) from the server
            try {
                var db = require('SimpleDataStore').Shared();
                if (args.cursor != null && args.cursor != '') {
                    // linux: the server acknowledged this batch - commit the journal cursor (at-least-once delivery)
                    db.Put('pluginEventLog_jcursor', String(args.cursor));
                    var lxsv = Math.floor(Number(args.value) / 1000) + 1; // journald times are UTC epoch ms: no local-offset math
                    if (!isNaN(lxsv)) db.Put('pluginEventLog_lvdoc_lx', String(lxsv));
                    dbg('linux cursor committed');
                    break;
                }
                var dt = new Date();
                var offsetMin = dt.getTimezoneOffset();
                //dbg('offset min: '+offsetMin);
                var offsetSec = offsetMin * 60;
                //dbg('offset sec: '+offsetSec);
                //dbg('offset '+offsetSec);
                var savetime = Number(args.value).toString();
                savetime = Number(savetime.slice(0, -3));     // strip milliseconds
                //dbg('savetime2 '+savetime);
                savetime = savetime - offsetSec;              // offset seconds
                savetime += 2; // timers are fuzzy. two second delay so we don't reXmit the last message
                savetime = savetime.toString();
                dbg('setting lvdoc to '+savetime);
                db.Put('pluginEventLog_lvdoc', savetime);          // to minimize Xferred event logs
            } catch (e) { dbg('setLVDOC error: '+e) }
            break;
        }
        case 'sendlogs': {
          mesh.SendCommand({ 
                  "action": "plugin", 
                  "plugin": "eventlog",
                  "pluginaction": "sendlogs",
                  "data": JSON.stringify({test: "testing"})
          });
          break;
        }
        case 'setConfigBlob': {
            if (PLAT == 'linux') {
                linuxCaps = null; // config changed: re-probe capabilities
                try { probeLinuxCaps(function () { }); } catch (e) { }
                try {
                    var lxdb = require('SimpleDataStore').Shared();
                    lxdb.Put('pluginEventLog_cfg', args.cfg);
                    dbg('setting config (linux) ' + args.cfg);
                } catch (e) { dbg('setconfigBlob (linux) ' + e); }
                break;
            }
            runPwshTest(function (output) {
                var version = parseInt(output.stdout);
                if (version <= 2) {
                    dbg('Plugin EventLog disabled on endpoint. Powershell version not capable');
                    if (periodicEventLogTimer != null) { try { clearInterval(periodicEventLogTimer); } catch (e) { } }
                    periodicEventLogTimer = null;
                } else {
                    dbg('Powershell version is >= 3. Continuing as planned.');
                }
            });
            try {
                var db = require('SimpleDataStore').Shared();
                var cfg = args.cfg;
                db.Put('pluginEventLog_cfg', cfg);
                dbg('setting config '+cfg);
            } catch (e) { dbg('setconfigBlob '+e); }
          break;
        }
      }
}

function getEventLogConfig() {
    var cfg = db.Get('pluginEventLog_cfg');
    if (cfg == '' || cfg == null) return getDefaultConfig();
    try {
        cfg = JSON.parse(cfg);
    } catch (e) { return getDefaultConfig(); }
    return cfg;
}

function getTmpFileNames() {
    var fns = db.Get('pluginEventLog_tmpfns');
    if (fns == '' || fns == null) return [];
    try {
        fns = JSON.parse(fns);
    } catch (e) { return []; }
    return fns;
}

function getDefaultConfig() {
    return {
     id: '',
     name: 'Default',
     liveLogs: 'Application,System',
     liveNum: 100,
     liveEntryTypes: [2,3],
     historyEnabled: true,
     historyLogs: 'Application,System',
     historyEntryTypes: [2,3]
   };
}

function sendConsoleText(text, sessionid) {
    if (typeof text == 'object') { text = JSON.stringify(text); }
    mesh.SendCommand({ "action": "msg", "type": "console", "value": text, "sessionid": sessionid });
}

module.exports = { consoleaction : consoleaction };