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
    var defaultParams = {
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
var PLAT = (process.platform == 'win32') ? 'win32' : ((process.platform == 'linux') ? 'linux' : ((process.platform == 'darwin') ? 'darwin' : null));
var linuxCaps = null;      // { journalctl, jver, persistent, audit, dmesgJson, files: [] }
var linuxTmpDir = null;

// the agent's own directory (macOS: /usr/local/mesh_services/<name>/), or null
var agentDir = function() {
    try { var ep = String(process.execPath || ''); var i = ep.lastIndexOf('/'); if (i > 0) return ep.substring(0, i); } catch (e) { }
    return null;
};

var pickTmpDir = function() {
    if (linuxTmpDir != null) return linuxTmpDir;
    var fs = require('fs');
    var cands = ['/usr/local/mesh', '/var/tmp', '/tmp'];
    if (PLAT == 'darwin') { cands = ['/usr/local/mesh_services']; var ad = agentDir(); if (ad != null) cands.push(ad); cands.push('/var/tmp'); cands.push('/tmp'); }
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

// Include/exclude rules from a config set (Categories / Sources). ES5 copy of elRules/elAllowed in
// eventlog.js: `list` is an array or comma list, '*' matches anything, case-insensitive; null = no filter.
var evlRules = function(list, mode) {
    var items = (list instanceof Array) ? list : String(list == null ? '' : list).split(',');
    var res = [];
    for (var i = 0; i < items.length; i++) {
        var pt = String(items[i]).replace(/^\s+|\s+$/g, '');
        if (pt == '') continue;
        res.push(new RegExp('^' + pt.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
    }
    if (res.length == 0) return null;
    return { exclude: (String(mode || 'exclude').toLowerCase() != 'include'), res: res };
};
var evlAllowed = function(rules, value) {
    if (rules == null) return true;
    var v = String(value == null ? '' : value), hit = false;
    for (var i = 0; i < rules.res.length; i++) { if (rules.res[i].test(v)) { hit = true; break; } }
    return rules.exclude ? !hit : hit;
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
        if (!evlAllowed(params.catRules, cat)) continue;                                 // config set: Categories
        var src = j.SYSLOG_IDENTIFIER || j._COMM || j._SYSTEMD_UNIT || '';
        if (!evlAllowed(params.srcRules, src)) continue;                                 // config set: Sources
        var tms = Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000); if (isNaN(tms)) tms = 0;
        out.events.push({
            LogName: cat,
            Level: priToLevel(pri),
            Priority: pri,
            TimeCreated: '/Date(' + tms + ')/',   // journald timestamps are UTC epoch microseconds
            ProviderName: src,
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
    var params = { num: 200, priorities: null, cursor: null, sinceSec: null, unit: null, kernelOnly: false, boot: false, facility: null, transport: null, catFilter: null, catRules: null, srcRules: null, maxAgeHours: 24, live: false };
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
            runJournalCollector(linuxGatherCallback, { cursor: cur, sinceSec: lv, priorities: levelsToPriorities(cfg.historyEntryTypes),
                catRules: evlRules(cfg.historyCategories, cfg.historyCategoriesMode), srcRules: evlRules(cfg.historySources, cfg.historySourcesMode) });
        });
    } catch (e) { dbg('Periodic linux runner error: ' + e); }
};

// ------------------------------------------------------------------
//  macOS (unified log + crash reports) support. ES5 only, see above.
//  History: `log show --style ndjson` from a cursor "<µs>:<n>|c<sec>"
//  (last event time in µs since epoch, events with exactly that time
//  already delivered, crash report mtime cursor), committed when the
//  server acknowledges the batch (setLVDOC echoes it).
// ------------------------------------------------------------------
var macCaps = null;            // { log, ndjson, osver, crashDir }
var macHistRunning = 0;        // start time (ms) of the history run in flight, 0 = none
var macHistRunId = 0;          // id of the newest history run
var MAC_RUN_STALE_MS = 5 * 60 * 1000;
var MAC_BATCH_MAX = 2000;      // events per history batch
var MAC_HEAD_LINES = 2100;     // ndjson lines read per history run
var MAC_CRASH_MAX = 20;        // crash reports per run
var MAC_CRASH_DIR = '/Library/Logs/DiagnosticReports';
var MAC_AUTH_SUBS = ['com.apple.securityd', 'com.apple.Authorization', 'com.apple.opendirectoryd', 'com.apple.TCC', 'com.apple.LocalAuthentication'];
var MAC_AUTH_SUB_PREFIX = ['com.apple.loginwindow', 'com.apple.authkit'];
var MAC_AUTH_PROCS = ['sshd', 'sudo', 'su', 'authd', 'securityd', 'opendirectoryd', 'loginwindow', 'screensharingd', 'sshd-session'];
var MAC_INSTALL_PROCS = ['installd', 'system_installd', 'softwareupdated', 'softwareupdate', 'mdmclient', 'storedownloadd', 'appstoreagent', 'package_script_service'];
var MAC_INSTALL_SUB_PREFIX = ['com.apple.SoftwareUpdate', 'com.apple.install'];
var MAC_SYSTEM_PATH_PREFIX = ['/System/', '/usr/', '/bin/', '/sbin/', '/Library/Apple/', '/private/var/db/'];

var probeMacCaps = function(cb) {
    if (macCaps != null) { cb(macCaps); return; }
    var script = 'test -x /usr/bin/log && echo L=1 || echo L=0\n' +
        'echo V=`sw_vers -productVersion 2>/dev/null`\n' +
        // exit status tells whether this macOS knows --style ndjson (an unknown style is a usage error)
        'test -x /usr/bin/log && /usr/bin/log show --style ndjson --last 1m --predicate \'eventType == logEvent AND messageType == fault\' >/dev/null 2>&1 && echo J=1 || echo J=0\n' +
        'test -r ' + MAC_CRASH_DIR + ' && test -x ' + MAC_CRASH_DIR + ' && echo C=1 || echo C=0';
    shRun(script, function (o) {
        var caps = { log: false, ndjson: false, osver: '', crashDir: false };
        var lines = String(o.stdout).split('\n');
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].replace(/\r/g, '').replace(/^\s+|\s+$/g, '');
            if (ln == 'L=1') caps.log = true;
            else if (ln == 'J=1') caps.ndjson = true;
            else if (ln == 'C=1') caps.crashDir = true;
            else if (ln.substring(0, 2) == 'V=') caps.osver = ln.substring(2).replace(/[^0-9.]/g, '');
        }
        if (!caps.log) caps.ndjson = false;
        macCaps = caps;
        dbg('mac caps: ' + JSON.stringify(caps));
        cb(caps);
    });
};

// days since 1970-01-01 for a proleptic Gregorian date (no Date.parse: duktape's is not reliable for these formats)
var macDaysFromCivil = function(y, m, d) {
    y -= (m <= 2) ? 1 : 0;
    var era = Math.floor(y / 400);
    var yoe = y - era * 400;
    var doy = Math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
};

// "2026-11-19 10:00:00.123456+0100" (unified log), "2026-11-19 10:00:00.00 +0100" (.ips header),
// "...Z", "+01:00" -> { us, ms } since epoch (UTC); null when unparsable. Without a zone: local time.
var parseMacTime = function(s) {
    var m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(?:(Z)|([+-])(\d{2}):?(\d{2}))?\s*$/.exec(String(s == null ? '' : s));
    if (m == null) return null;
    var frac = Number(((m[7] || '') + '000000').substring(0, 6));
    var sec;
    if (m[8] || m[9]) {
        sec = macDaysFromCivil(Number(m[1]), Number(m[2]), Number(m[3])) * 86400 + Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]);
        if (m[9]) sec -= ((m[9] == '-') ? -1 : 1) * (Number(m[10]) * 3600 + Number(m[11]) * 60);
    } else {
        sec = Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime() / 1000);
    }
    if (isNaN(sec)) return null;
    var us = sec * 1000000 + frac;
    return { us: us, ms: Math.floor(us / 1000) };
};

// a --start argument in the endpoint's local time ("YYYY-MM-DD HH:MM:SS", the plain form `log` documents).
// When a DST change lies within the hour before, start an hour earlier: the repeated local hour is
// ambiguous, and events before the cursor are skipped by the parser anyway.
var macStartArg = function(sec) {
    sec = Math.floor(Number(sec));
    if (new Date((sec - 3600) * 1000).getTimezoneOffset() != new Date(sec * 1000).getTimezoneOffset()) sec -= 3600;
    var d = new Date(sec * 1000);
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
};

// the config's level list (0-5) -> what to collect on macOS. There is no Warning (3) on macOS.
// { all, types: [messageType tokens], info (--info), debug (--debug), levels: {1:true,...}, crash, panic }
var macLevelSel = function(levels) {
    var sel = { all: false, types: [], info: false, debug: false, levels: {}, crash: false, panic: false };
    var setAll = function () { sel.all = true; sel.types = []; sel.info = true; sel.debug = true; sel.levels = { 1: true, 2: true, 4: true, 5: true }; sel.crash = true; sel.panic = true; return sel; };
    if (levels == null || levels.length == 0) return setAll();
    var add = function (t) { for (var k = 0; k < sel.types.length; k++) { if (sel.types[k] == t) return; } sel.types.push(t); };
    for (var i = 0; i < levels.length; i++) {
        var n = Number(levels[i]);
        if (n == 0) return setAll();
        if (n == 1) { add('fault'); sel.levels[1] = true; sel.panic = true; }
        else if (n == 2) { add('error'); sel.levels[2] = true; sel.crash = true; }
        else if (n == 4) { add('default'); add('info'); sel.levels[4] = true; sel.info = true; }
        else if (n == 5) { add('debug'); sel.levels[5] = true; sel.info = true; sel.debug = true; }
    }
    return sel;
};
var macLevelOf = function(mt) {
    mt = String(mt || '').toLowerCase();
    if (mt == 'fault') return 1;
    if (mt == 'error') return 2;
    if (mt == 'debug') return 5;
    return 4; // default, info
};
var macMsgType = function(mt) {
    mt = String(mt || 'Default');
    return mt.charAt(0).toUpperCase() + mt.substring(1).toLowerCase();
};

// NSPredicate for `log show`, built from fixed tokens only; `extra` is one of the fixed MAC_PRED_* strings or
// a clause made by macSelPredicate (values through shSanitize, which removes every quote)
var macPredicate = function(sel, extra) {
    var p = 'eventType == logEvent';
    if (!sel.all) {
        var t = [];
        for (var i = 0; i < sel.types.length; i++) t.push('messageType == ' + sel.types[i]);
        p += ' AND (' + t.join(' OR ') + ')';
    }
    if (extra) p += ' AND (' + extra + ')';
    return p;
};
var macOrList = function(key, op, vals) {
    var t = [];
    for (var i = 0; i < vals.length; i++) t.push(key + ' ' + op + ' "' + vals[i] + '"');
    return t.join(' OR ');
};
var MAC_PRED_KERNEL = 'processImagePath == "/kernel" OR process == "kernel"';
var MAC_PRED_AUTH = macOrList('subsystem', '==', MAC_AUTH_SUBS) + ' OR ' + macOrList('subsystem', 'BEGINSWITH[c]', MAC_AUTH_SUB_PREFIX) + ' OR ' + macOrList('process', '==', MAC_AUTH_PROCS);
var MAC_PRED_INSTALL = macOrList('process', '==', MAC_INSTALL_PROCS) + ' OR ' + macOrList('subsystem', 'BEGINSWITH[c]', MAC_INSTALL_SUB_PREFIX);

// live selector -> { extra, catFilter, unified, crash, boot }
var macSelPredicate = function(lsel) {
    lsel = String(lsel == null ? '' : lsel);
    if (lsel == 'kernel') return { extra: MAC_PRED_KERNEL, catFilter: 'Kernel', unified: true, crash: false };
    if (lsel == 'auth') return { extra: MAC_PRED_AUTH, catFilter: 'Auth', unified: true, crash: false };
    if (lsel == 'install') return { extra: MAC_PRED_INSTALL, catFilter: 'Install', unified: true, crash: false };
    if (lsel == 'crash') return { extra: null, catFilter: 'Crash', unified: false, crash: true };
    if (lsel == 'boot') return { extra: null, catFilter: null, unified: true, crash: false, boot: true };
    if (lsel.substring(0, 10) == 'subsystem:' && shSanitize(lsel.substring(10)) != '') return { extra: 'subsystem == "' + shSanitize(lsel.substring(10)) + '"', catFilter: null, unified: true, crash: false };
    if (lsel.substring(0, 8) == 'process:' && shSanitize(lsel.substring(8)) != '') return { extra: 'process == "' + shSanitize(lsel.substring(8)) + '"', catFilter: null, unified: true, crash: false };
    return { extra: null, catFilter: null, unified: true, crash: true };
};

var macBasename = function(p) { p = String(p == null ? '' : p); var i = p.lastIndexOf('/'); return (i >= 0) ? p.substring(i + 1) : p; };
var macInList = function(v, list) { v = String(v).toLowerCase(); for (var i = 0; i < list.length; i++) { if (String(list[i]).toLowerCase() == v) return true; } return false; };
var macHasPrefix = function(v, list, ci) {
    v = String(v); if (ci) v = v.toLowerCase();
    for (var i = 0; i < list.length; i++) { var p = ci ? String(list[i]).toLowerCase() : String(list[i]); if (v.substring(0, p.length) == p) return true; }
    return false;
};

// category (LogName) of a unified-log event: { process, path, subsystem }
var macCategory = function(e) {
    var proc = String(e.process || ''), path = String(e.path || ''), sub = String(e.subsystem || '');
    if (proc == 'kernel' || path == '/kernel') return 'Kernel';
    if (macInList(sub, MAC_AUTH_SUBS) || macHasPrefix(sub, MAC_AUTH_SUB_PREFIX, true) || macInList(proc, MAC_AUTH_PROCS)) return 'Auth';
    if (macInList(proc, MAC_INSTALL_PROCS) || macHasPrefix(sub, MAC_INSTALL_SUB_PREFIX, true)) return 'Install';
    if (sub.substring(0, 10) == 'com.apple.' || macHasPrefix(path, MAC_SYSTEM_PATH_PREFIX, false)) return 'System';
    return 'Application';
};

var macCleanText = function(s) { return String(s == null ? '' : s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); };

// level / category / source rules shared by unified-log and crash events
var macEventAllowed = function(ev, params) {
    if (!params.sel.levels[ev.Level]) return false;
    if (params.catFilter != null && ev.LogName != params.catFilter) return false;
    if (!evlAllowed(params.catRules, ev.LogName)) return false;   // config set: Categories
    if (!evlAllowed(params.srcRules, ev.ProviderName)) return false; // config set: Sources
    return true;
};

// cursor "<µs>:<n>|c<sec>" -> { us, n, crash } (null parts when absent)
var macParseCursor = function(s) {
    var r = { us: null, n: 0, crash: null };
    var m = /^(\d+):(\d+)(?:\|c(\d+))?$/.exec(String(s == null ? '' : s));
    if (m == null) return r;
    if (Number(m[1]) > 0) { r.us = Number(m[1]); r.n = Number(m[2]); }
    if (m[3] != null && Number(m[3]) > 0) r.crash = Number(m[3]);
    return r;
};
var macFormatCursor = function(c) {
    return String(c.us != null ? c.us : 0) + ':' + String(c.us != null ? (c.n || 0) : 0) + '|c' + String(c.crash != null ? c.crash : 0);
};

// parse `log show --style ndjson` output. Non-JSON lines (a truncated tail, banners) and non-event objects
// (the final summary) are skipped. History (params.cursor): events up to the cursor are skipped, the
// returned last/tie describe the last examined event. Returns { events, lastUs, tie, examined, truncated, rc }
var parseMacNdjson = function(txt, params) {
    var out = { events: [], lastUs: null, tie: 0, examined: 0, truncated: false, rc: null };
    var cur = params.cursor || null, skipUs = (cur != null && cur.us != null) ? cur.us : null, skipN = (skipUs != null) ? (cur.n || 0) : 0;
    var minUs = (params.minUs != null) ? params.minUs : null, seenAtSkip = 0;
    out.lastUs = skipUs; out.tie = skipN;
    var lines = String(txt).split('\n');
    for (var li = 0; li < lines.length; li++) {
        var ln = lines[li];
        if (ln.length < 2 || ln.charAt(0) != '{') continue;
        var j = null;
        try { j = JSON.parse(ln); } catch (e) { continue; }
        if (j == null || typeof j != 'object') continue;
        if (j.evlrc != null) { out.rc = Number(j.evlrc); continue; } // exit status of `log show`, appended by the script
        if (j.eventType != null && j.eventType != 'logEvent') continue;
        var t = parseMacTime(j.timestamp);
        if (t == null) continue;
        if (minUs != null && t.us < minUs) continue;
        if (skipUs != null) {
            if (t.us < skipUs) continue;
            if (t.us == skipUs && seenAtSkip < skipN) { seenAtSkip++; continue; } // already delivered (same-µs ties)
        }
        if (!params.live && out.events.length >= MAC_BATCH_MAX) { out.truncated = true; break; }
        if (out.lastUs != null && t.us == out.lastUs) out.tie++; else { out.lastUs = t.us; out.tie = 1; }
        out.examined++;
        var path = String(j.processImagePath || ''), proc = macBasename(path), sub = String(j.subsystem || '');
        var ev = {
            LogName: macCategory({ process: proc, path: path, subsystem: sub }),
            Level: macLevelOf(j.messageType),
            MsgType: macMsgType(j.messageType),
            TimeCreated: '/Date(' + t.ms + ')/',
            ProviderName: proc,
            Subsystem: sub,
            OsCategory: String(j.category || ''),
            ProcessPath: path,
            Id: (j.processID != null && j.processID !== '') ? String(j.processID) : '',
            Message: macCleanText(j.eventMessage)
        };
        if (!macEventAllowed(ev, params)) continue;
        if (params.live) ev._us = t.us;
        out.events.push(ev);
    }
    return out;
};

// app/process name from a report file name: "Safari-2026-11-19-100000.ips", "Safari_2019-01-01-100000_host.crash"
var macCrashName = function(name) {
    var n = String(name).replace(/\.(ips|crash|panic|diag)$/i, '');
    n = n.replace(/[-_]\d{4}-\d{2}-\d{2}[-_]\d{6}.*$/, '');
    return n;
};

// one crash report -> event. name: file name, mtimeSec, content: first <= 4 KB
var macCrashEvent = function(name, mtimeSec, content) {
    var ext = (/\.([A-Za-z]+)$/.exec(name) || ['', ''])[1].toLowerCase();
    var hdr = null, t = null, prov = '';
    if (ext == 'ips') {
        var nl = content.indexOf('\n');
        try { hdr = JSON.parse(nl >= 0 ? content.substring(0, nl) : content); } catch (e) { hdr = null; }
        if (hdr == null || typeof hdr != 'object') hdr = null;
    }
    if (hdr != null) {
        prov = String(hdr.app_name || hdr.name || hdr.procName || '');
        if (hdr.timestamp != null) t = parseMacTime(hdr.timestamp);
    } else {
        var pm = /^Process:\s+([^\[\r\n]+?)\s*(\[|$)/m.exec(content); if (pm) prov = pm[1];
        var dm = /^Date\/Time:\s+([^\r\n]+)$/m.exec(content); if (dm) t = parseMacTime(dm[1]);
    }
    var panic = /panic/i.test(name) || (hdr != null && String(hdr.bug_type) == '210');
    if (prov == '') prov = panic ? 'kernel' : macCrashName(name);
    var ms = (t != null) ? t.ms : Number(mtimeSec) * 1000;
    return {
        LogName: 'Crash',
        Level: panic ? 1 : 2,
        MsgType: panic ? 'Panic' : 'Crash',
        TimeCreated: '/Date(' + ms + ')/',
        ProviderName: prov,
        Subsystem: '', OsCategory: '',
        ProcessPath: MAC_CRASH_DIR + '/' + name,
        Id: '',
        Message: macCleanText(content)
    };
};

// sh fragment listing crash reports newer than sinceSec (oldest first for history, newest first for live),
// at most `max`, each followed by its first 4 KB between delimiter lines
var macCrashScript = function(sinceSec, max, newestFirst, token) {
    return 'cd ' + MAC_CRASH_DIR + ' 2>/dev/null && for f in *.ips *.crash *.panic *.diag; do test -f "$f" && stat -f \'%m %N\' "$f"; done 2>/dev/null' +
        ' | awk -v c=' + Math.floor(Number(sinceSec) || 0) + ' \'$1 > c\'' +
        ' | sort -k1,1n' + (newestFirst ? 'r' : '') + ' -k2 | head -n ' + Math.floor(max) +
        ' | while read -r m f; do echo "' + token + ' $m $f"; head -c 4096 "$f"; echo; echo "' + token + '-END"; done';
};
// -> [{ mtime, name, content }]
var parseMacCrashOutput = function(txt, token) {
    var res = [], cur = null, lines = String(txt).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].replace(/\r$/, '');
        if (cur == null) {
            if (ln.substring(0, token.length + 1) == token + ' ') {
                var m = /^(\d+) (.+)$/.exec(ln.substring(token.length + 1));
                if (m) cur = { mtime: Number(m[1]), name: m[2], lines: [] };
            }
        } else if (ln == token + '-END') {
            if (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] == '') cur.lines.pop(); // the `echo` after head
            res.push({ mtime: cur.mtime, name: cur.name, content: cur.lines.join('\n') });
            cur = null;
        } else cur.lines.push(ln);
    }
    return res;
};

// the `log show` pipeline. History: chronological, head-bounded; live: the newest lines via tail.
// The exit status of `log show` is appended as {"evlrc":N} so a failed run is not taken as "no events".
var macLogCmd = function(p, fileName) {
    var cmd = '( nice -n 10 /usr/bin/log show --style ndjson';
    if (p.sel.info) cmd += ' --info';
    if (p.sel.debug) cmd += ' --debug';
    if (p.startSec != null) cmd += ' --start "' + macStartArg(p.startSec) + '"';
    else cmd += ' --last ' + p.last;
    cmd += " --predicate '" + macPredicate(p.sel, p.extra) + "'";
    cmd += '; echo "{\\"evlrc\\":$?}" )';
    if (p.live) cmd += ' | tail -n ' + (Math.floor(Number(p.num) || 100) + 50);
    else cmd += ' | head -n ' + MAC_HEAD_LINES;
    cmd += ' | head -c 8388608 > ' + fileName;
    return cmd;
};

// one collection run: unified log (into a tmp file) and/or crash reports (stdout), in one sh script.
// params: { live, num, sel, cursor, lvdocMs, sinceSec, extra, catFilter, catRules, srcRules, unified, crash, boot, maxAgeHours }
// func({ events, cursor (history: string or null), truncated, error })
var runMacCollector = function(func, passedParams) {
    var params = { live: false, num: 200, sel: macLevelSel(null), cursor: null, lvdocMs: null, sinceSec: null, extra: null, catFilter: null,
                   catRules: null, srcRules: null, unified: true, crash: true, boot: false, maxAgeHours: 24 };
    for (var pk in passedParams) { if (passedParams[pk] !== undefined && passedParams[pk] !== null) params[pk] = passedParams[pk]; }
    var cur = params.cursor || { us: null, n: 0, crash: null };
    var runStartMs = new Date().getTime(), nowSec = Math.floor(runStartMs / 1000);
    var sel = params.sel;
    var doUnified = params.unified && (sel.all || sel.types.length > 0);
    var doCrash = params.crash && (sel.crash || sel.panic);
    var fileName = null, token = 'EVLCRASH' + Math.random().toString(32).replace('0.', '');
    var lp = { live: params.live, num: params.num, sel: sel, extra: params.extra, startSec: null, last: null };
    var pc = { cursor: null, minUs: null, live: params.live, sel: sel, catFilter: params.catFilter, catRules: params.catRules, srcRules: params.srcRules };
    var crashSince, crashMax;
    if (params.live) {
        var winSec = (sel.info || sel.debug) ? 600 : 3600;   // default/info/debug are chatty: a shorter window keeps `log show` quick
        if (params.sinceSec != null) {
            lp.startSec = Math.max(Number(params.sinceSec), nowSec - winSec);
            pc.minUs = Number(params.sinceSec) * 1000000;
        } else lp.last = params.boot ? 'boot' : ((winSec / 60) + 'm');
        crashSince = (params.sinceSec != null) ? Number(params.sinceSec) - 1 : ((params.catFilter == 'Crash') ? 0 : nowSec - winSec);
        crashMax = Math.min(MAC_CRASH_MAX, Math.floor(Number(params.num) || 100));
    } else {
        if (cur.us != null) { lp.startSec = Math.floor(cur.us / 1000000); pc.cursor = cur; }
        else if (params.lvdocMs != null) { lp.startSec = Math.floor(Number(params.lvdocMs) / 1000); pc.cursor = { us: (Number(params.lvdocMs) + 1) * 1000, n: 0 }; }
        else lp.last = (Number(params.maxAgeHours) || 24) + 'h';   // bound the first-run backfill
        crashSince = (cur.crash != null) ? cur.crash : (nowSec - (Number(params.maxAgeHours) || 24) * 3600);
        crashMax = MAC_CRASH_MAX + 1;   // one extra to see whether the 20th report shares its mtime with the next
    }
    var script = '';
    if (doUnified) {
        fileName = pickTmpDir() + '/evlmout' + Math.random().toString(32).replace('0.', '') + '.txt';
        pushTmpFile(fileName);
        script += macLogCmd(lp, fileName) + '\n';
    }
    if (doCrash) script += macCrashScript(crashSince, crashMax, params.live, token) + '\n';
    if (script == '') { func({ events: [], cursor: null, truncated: false }); return; }
    dbg('Running mac collector: ' + script);
    shRun(script, function (o) {
        try {
            var res = { events: [], cursor: null, truncated: false, error: null };
            var next = { us: cur.us, n: cur.n, crash: cur.crash }, advanced = false;
            if (doUnified) {
                var txt = '';
                try { txt = require('fs').readFileSync(fileName).toString(); } catch (fe) { }
                popTmpFile(fileName);
                var u = parseMacNdjson(txt, pc);
                if (u.rc != null && u.rc != 0) { res.error = 'log'; dbg('log show failed (' + u.rc + '): ' + String(o.stderr || '').substring(0, 300)); }
                res.truncated = u.truncated;
                if (!params.live) {
                    if (u.examined > 0) { next.us = u.lastUs; next.n = u.tie; advanced = true; }
                    // `log show` completed (its status line is present, so nothing was cut off): nothing before the
                    // run start is left, start the next run there instead of at an old last event. 10 s earlier: entries
                    // logd had not persisted yet when `log show` read the store are picked up by the next run
                    var safeUs = (runStartMs - 10000) * 1000;
                    if (!u.truncated && u.rc === 0 && (next.us == null || next.us < safeUs)) { next.us = safeUs; next.n = 0; advanced = true; }
                }
                res.events = u.events;
            }
            if (doCrash) {
                var reps = parseMacCrashOutput(o.stdout, token);
                if (!params.live && reps.length > MAC_CRASH_MAX) {
                    // keep the cursor exact: drop the reports sharing the mtime of the first one not taken
                    var cut = reps[MAC_CRASH_MAX].mtime, keep = [];
                    for (var ri = 0; ri < MAC_CRASH_MAX; ri++) { if (reps[ri].mtime < cut) keep.push(reps[ri]); }
                    reps = (keep.length > 0) ? keep : reps.slice(0, MAC_CRASH_MAX);
                    res.truncated = true;
                } else if (!params.live) {
                    var csafe = nowSec - 1;   // every report written before the run started was listed
                    if (next.crash == null || next.crash < csafe) { next.crash = csafe; advanced = true; }
                }
                for (var ci = 0; ci < reps.length; ci++) {
                    if (!params.live && (next.crash == null || reps[ci].mtime > next.crash)) { next.crash = reps[ci].mtime; advanced = true; }
                    var cev = macCrashEvent(reps[ci].name, reps[ci].mtime, reps[ci].content);
                    if (!macEventAllowed(cev, pc)) continue;
                    if (params.live) {
                        cev._us = Number(String(cev.TimeCreated).replace(/[^0-9]/g, '')) * 1000;
                        if (pc.minUs != null && cev._us < pc.minUs) continue;   // already shown (its own time is before the file's mtime)
                    }
                    res.events.push(cev);
                }
            }
            if (params.live) {
                // newest first, at most num
                res.events.sort(function (a, b) { return b._us - a._us; });
                if (res.events.length > params.num) res.events = res.events.slice(0, params.num);
                for (var ei = 0; ei < res.events.length; ei++) delete res.events[ei]._us;
            } else if (advanced) res.cursor = macFormatCursor(next);
            func(res);
        } catch (e) { dbg('mac run error: ' + e); try { if (fileName != null) popTmpFile(fileName); } catch (e2) { } func({ events: [], cursor: null, truncated: false, error: 'exception' }); }
    });
};

// commit a cursor; never move it backwards (a late acknowledgement of an older batch)
var macCommitCursor = function(s) {
    var n = macParseCursor(s), c = macParseCursor(db.Get('pluginEventLog_mcursor'));
    if (n.us == null && n.crash == null) return;
    if (c.us != null && (n.us == null || n.us < c.us || (n.us == c.us && n.n < c.n))) { n.us = c.us; n.n = c.n; }
    if (c.crash != null && (n.crash == null || n.crash < c.crash)) n.crash = c.crash;
    db.Put('pluginEventLog_mcursor', macFormatCursor(n));
};

// periodic history batch finished: push to the server; the cursor is committed when the server acks (setLVDOC)
var macGatherCallback = function(res) {
    try {
        if (res.cursor == null) return;   // nothing examined (or the run failed): keep the position
        if (res.events.length == 0) { macCommitCursor(res.cursor); return; } // nothing to send: advance locally
        mesh = require('MeshAgent');
        var cfg = getEventLogConfig();
        mesh.SendCommand({
            "action": "plugin", "plugin": "eventlog", "pluginaction": "gatherlogs",
            "uid": (cfg.uid != null) ? cfg.uid : null,
            "os": "macos", "cursor": res.cursor, "caps": macCaps,
            "data": JSON.stringify(res.events)
        });
        // The server does not acknowledge a batch older than one it already acknowledged (it stores it, though).
        // That happens when a crash report's own time lies before already delivered log events: commit locally
        // then, or the same batch would be re-sent every minute.
        var bmax = 0;
        for (var i = 0; i < res.events.length; i++) { var tm = Number(String(res.events[i].TimeCreated).replace(/[^0-9]/g, '')); if (tm > bmax) bmax = tm; }
        var acked = Number(db.Get('pluginEventLog_mack'));
        if (!isNaN(acked) && acked > 0 && bmax < acked) macCommitCursor(res.cursor);
    } catch (e) { dbg('macGatherCallback error: ' + e); }
};

var capturePeriodicMac = function() {
    try {
        dbg('Periodic mac runner starting');
        var cfg = getEventLogConfig();
        if (cfg.historyEnabled !== true) return;
        // `log show` can run for tens of seconds: never start a second history run while one is in flight
        var now = new Date().getTime();
        if (macHistRunning != 0 && (now - macHistRunning) < MAC_RUN_STALE_MS) { dbg('mac history run still in flight, skipped'); return; }
        macHistRunning = now;
        var runId = ++macHistRunId;
        var done = function () { if (macHistRunId == runId) macHistRunning = 0; }; // a stale run finishing late must not clear a newer run's flag
        probeMacCaps(function (caps) {
            try {
                var unified = (caps.log && caps.ndjson);
                if (!unified && !caps.crashDir) { done(); dbg('log show not usable and no crash reports; periodic collection disabled'); return; }
                var lv = db.Get('pluginEventLog_lvdoc_mac');
                lv = (lv == '' || lv == null || isNaN(Number(lv))) ? null : Number(lv);
                runMacCollector(function (res) { done(); macGatherCallback(res); }, {
                    cursor: macParseCursor(db.Get('pluginEventLog_mcursor')), lvdocMs: lv, sel: macLevelSel(cfg.historyEntryTypes),
                    unified: unified, crash: caps.crashDir,
                    catRules: evlRules(cfg.historyCategories, cfg.historyCategoriesMode), srcRules: evlRules(cfg.historySources, cfg.historySourcesMode) });
            } catch (e) { done(); dbg('Periodic mac runner error: ' + e); }
        });
    } catch (e) { macHistRunning = 0; dbg('Periodic mac runner error: ' + e); }
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
    if (PLAT == 'darwin') { capturePeriodicMac(); return; }
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
            return "Eventlog is only available on Windows, Linux and macOS endpoints.";
        }
        
        var fnname = args['_'][1];
        mesh = parent;
        
        switch (fnname) {
          case 'serviceCheck': {
              // null function- simply can be called to load the plugin and make sure the timer is running
              if (PLAT == 'linux' && linuxCaps == null) { try { probeLinuxCaps(function () { }); } catch (e) { } }
              if (PLAT == 'darwin' && macCaps == null) { try { probeMacCaps(function () { }); } catch (e) { } }
              break;
          }
          case 'getlog': {
              if (PLAT == 'linux') return "On Linux endpoints, use the Event Log tab on the device page.";
              if (PLAT == 'darwin') return "On macOS endpoints, use the Event Log tab on the device page.";
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
            if (PLAT == 'darwin') return "On macOS endpoints, use the Event Log tab on the device page.";
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
                    var p = { live: true, num: num, priorities: levelsToPriorities(entryTypes), sinceSec: lxSince,
                              catRules: evlRules(cfg.liveCategories, cfg.liveCategoriesMode), srcRules: evlRules(cfg.liveSources, cfg.liveSourcesMode) };
                    if (lxSel == 'kernel') p.kernelOnly = true;
                    else if (lxSel == 'auth') { p.facility = 'auth,authpriv'; p.catFilter = 'Auth'; }
                    else if (lxSel == 'audit') { p.transport = 'audit'; p.catFilter = 'Audit'; }
                    else if (lxSel == 'boot') p.boot = true;
                    else if (lxSel.substring(0, 5) == 'unit:') p.unit = lxSel.substring(5);
                    try { runJournalCollector(function (res) { reply(res.events); }, p); } catch (e) { dbg('getlivelogs linux error ' + e); }
                });
                break;
            }
            if (PLAT == 'darwin') {
                var mcWs = isWsconnection, mcCon = wscon; // capture: the callback runs after consoleaction returned
                var mcSince = (args.since != null && !isNaN(Number(args.since))) ? (Number(args.since) + 1) : null;
                var mcSel = macSelPredicate(args.lsel);
                probeMacCaps(function (caps) {
                    var reply = function (events) {
                        if (!mcWs || mcCon == null) return;
                        try { mcCon.write(new Buffer(JSON.stringify({ uid: cfg.uid, os: 'macos', caps: caps, data: events }))); } catch (e) { dbg('live reply error ' + e); }
                    };
                    var unified = (caps.log && caps.ndjson);
                    if (!unified && !(mcSel.catFilter == 'Crash' && caps.crashDir)) {
                        reply([{ LogName: 'System', Level: 2, MsgType: 'Error', TimeCreated: '/Date(' + new Date().getTime() + ')/', ProviderName: 'eventlog-plugin',
                                 Subsystem: '', OsCategory: '', ProcessPath: '', Id: '',
                                 Message: !caps.log ? 'The macOS log tool (/usr/bin/log) was not found on this endpoint, so the unified log cannot be read.'
                                                    : ('The log tool on this endpoint (macOS ' + (caps.osver || 'unknown version') + ') does not support "log show --style ndjson", which the plugin needs to read the unified log. A newer macOS is required.') }]);
                        return;
                    }
                    var p = { live: true, num: num, sel: macLevelSel(entryTypes), sinceSec: mcSince, extra: mcSel.extra, catFilter: mcSel.catFilter, boot: (mcSel.boot === true),
                              unified: (mcSel.unified && unified), crash: (mcSel.crash && caps.crashDir),
                              catRules: evlRules(cfg.liveCategories, cfg.liveCategoriesMode), srcRules: evlRules(cfg.liveSources, cfg.liveSourcesMode) };
                    try { runMacCollector(function (res) { reply(res.events); }, p); } catch (e) { dbg('getlivelogs mac error ' + e); }
                });
                break;
            }
            var sinceTime = null;
            if (args.since != null && !isNaN(Number(args.since))) {
                // args.since is UTC seconds; the collector builds its StartTime from local 1970-01-01, so shift by the local offset
                sinceTime = Number(args.since) - (new Date().getTimezoneOffset() * 60) + 1;
            }
            // One query per log, each with its own -MaxEvents budget. Collapsing them into a single
            // Get-WinEvent over a LogName array would use one process instead of two, but -MaxEvents
            // then applies to the combined result: a burst in one log can crowd the other out of the
            // batch entirely, and since the next request resumes after the newest event received,
            // those entries would never appear in the Live view. The live collector only runs while
            // the Event Log tab is actually on screen (see elTabVisible in eventlog.js), which is
            // where the real cost was.
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
                if (PLAT == 'darwin') {
                    // macOS: the server acknowledged this batch - commit its cursor (unified log + crash reports)
                    var mav = Number(args.value), mprev = Number(db.Get('pluginEventLog_mack'));
                    if (!isNaN(mav) && mav > 0 && (isNaN(mprev) || mav > mprev)) {
                        db.Put('pluginEventLog_mack', String(mav));        // newest acknowledged event time (ms)
                        db.Put('pluginEventLog_lvdoc_mac', String(mav));   // fallback start when there is no cursor
                    }
                    if (args.cursor != null && args.cursor != '') { macCommitCursor(String(args.cursor)); dbg('mac cursor committed'); }
                    break;
                }
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
            if (PLAT == 'darwin') {
                macCaps = null; // config changed: re-probe capabilities
                try { probeMacCaps(function () { }); } catch (e) { }
                try {
                    var mcdb = require('SimpleDataStore').Shared();
                    mcdb.Put('pluginEventLog_cfg', args.cfg);
                    dbg('setting config (macos) ' + args.cfg);
                } catch (e) { dbg('setconfigBlob (macos) ' + e); }
                break;
            }
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