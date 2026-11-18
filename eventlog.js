/**
* @description MeshCentral event log plugin
* @author Ryan Blenis
* @copyright
* @license Apache-2.0
*/

"use strict";

module.exports.eventlog = function (parent) {
    var obj = {};

    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.db = null;
    obj._lastMeta = {};   // nodeid -> last node metadata written, so repeat reports are not re-stored
    obj._lastAck = {};    // nodeid -> newest collection position acknowledged, so it never goes backwards
    obj._cfgCache = {};   // nodeid -> { uid, cfg, t }: the node's resolved config set, for ingest filtering

    // Functions that need to be brought to the front end for processing.
    // (If they need to be accessed in the GUI, they should be here.)
    // NOTE: these are serialized with .toString() and run in the browser.
    //       They must be self-contained and reference each other only via
    //       pluginHandler.eventlog.<fnName>.
    obj.exports = [
      'registerPluginTab',
      'on_device_page',
      'fe_on_message',
      'onRemoteEventLogStateChange',
      'createRemoteEventLog',
      'onDeviceRefreshEnd',
      'onLoadHistory',
      'onCollectNow',
      '_pluginPermissions',
      // new UI
      'elState',
      'elLevelInfo',
      'elHash',
      'elFixText',
      'elNormalize',
      'elFmtTime',
      'elParseIds',
      'elMatch',
      'elFiltered',
      'elFold',
      'elInjectStyles',
      'elEnsureShell',
      'elRenderShell',
      'elUpdate',
      'elRenderChips',
      'elRenderFacets',
      'elRenderBody',
      'elEmptyText',
      'elRenderDetailHtml',
      'elRenderStatus',
      'elSetView',
      'elSetLayout',
      'elToggleFold',
      'elSetShow',
      'elSetRange',
      'elSelLog',
      'elSelSource',
      'elToggleLevel',
      'elToggleFacet',
      'elFacetsMore',
      'elIdInput',
      'elTextInput',
      'elClearFilter',
      'elResetFilters',
      'elSetSort',
      'elRowClick',
      'elSetDTab',
      'elCopy',
      'elToggleRaw',
      'elFilterBy',
      'elKeyNav',
      'elRequestLive',
      'elAutoTick',
      'elRefresh',
      'elTogglePause',
      'elLoadHistory',
      'elLoadMore',
      'elCollectNow',
      'elExportCsv',
      // sizing / density (v0.1.2)
      'elLoadJson',
      'elSetRows',
      'elColDefault',
      'elColW',
      'elSaveCols',
      'elSetColW',
      'elRzDown',
      'elRzFit',
      'elGripDown',
      'elGripReset',
      'elFitAvail',
      'elViewBox',
      'elFitHeight',
      'elResetSizes',
      'elVSplitDown',
      'elVSplitReset',
      'elRowFor',
      'elDetailsText',
      // Linux support (v0.1.5)
      'elPlatform',
      'elIsSupported',
      'elPriName',
      'elLbl',
      'elRawOf',
      'elSelCat',
      'elHistAutoFill',
      'elHistRefilter',
      'elCounts',
      // live tunnel gating (v0.1.11)
      'elTabVisible',
      'elStopLive',
      'elEnsureLive',
      'elHookTabSwitch',
      'goPageStart',
      // include/exclude rules for categories and sources (v0.1.12)
      'elRules',
      'elAllowed',
      'elLiveAllowed',
      // plugin permissions (v0.2.0)
      'elCan',
      'elAccessGate',
      'elRequestAccess',
      'elRecheckAccess',
      'onAccess',
      'onAccessDenied'
    ];
    // the Assistant on the device tab (Explain, Diagnosis, Ask, data preview): ui_ai.js adds its functions and names
    require(__dirname + '/ui_ai.js').attach(obj);

    obj._pluginPermissions = function() {
        return {
            "deviceLiveTab": "Event Log: Live view",
            "deviceHistoryTab": "Event Log: History and Collect now",
            "deviceAssistant": "Event Log: Assistant"
        };
    };

    // ---- Plugin permissions (server side) -----------------------------------------------------
    // Registered with MeshCentral's plugin permission framework, so administrators grant them per user in MeshCentral's
    // permissions dialog (global, device group or device). All are denied by default. The keys are the ones the
    // Tech-Werkz fork introduced, so permissions granted there keep working.
    obj.PERMISSIONS = {
        deviceLiveTab:    { title: 'Event Log: Live view', desc: 'Can open the live event view of a device. Enforced by the tab only: the live view runs through MeshCentral\'s relay tunnel.', default: 'denied' },
        deviceHistoryTab: { title: 'Event Log: History and Collect now', desc: 'Can view the stored event history of a device and ask it to collect now.', default: 'denied' },
        deviceAssistant:  { title: 'Event Log: Assistant', desc: 'Can ask the Event Log assistant about a device. Also needs the Details right on the device.', default: 'denied' }
    };
    obj.MESHRIGHT_DEVICEDETAILS = 0x00100000;
    obj.MESHRIGHT_LIMITEVENTS = 0x00002000;
    obj.MESHRIGHT_NOSOFTWARE = 0x00800000;
    obj.MESHRIGHT_ADMIN = 0xFFFFFFFF;
    obj._permApi = false;
    obj.registerPermissions = function() {
        obj._permApi = false;
        try {
            if (obj.parent != null && typeof obj.parent.registerPermissions == 'function' && typeof obj.parent.checkPluginPermission == 'function') {
                obj.parent.registerPermissions('eventlog', obj.PERMISSIONS);
                obj._permApi = true;
            }
        } catch (e) { console.log('EVENTLOG: could not register plugin permissions: ' + ((e && e.message) || e)); }
        if (obj._permApi) console.log('EVENTLOG: plugin permissions registered (Live view, History and Collect now, Assistant; all denied by default)');
        else console.log('EVENTLOG: this MeshCentral has no plugin permission framework; the Event Log tab is limited to full administrators');
        return obj._permApi;
    };
    obj.isFullAdmin = function(myparent) {
        try { return (myparent != null && myparent.user != null && (myparent.user.siteadmin >>> 0) === 0xFFFFFFFF); } catch (e) { return false; }
    };
    // True when the user holds the plugin permission `key` for this device. Synchronous, fails closed.
    // `node` must be the device as loaded by resolveNodeRights: MeshCentral's check needs the device group explicitly
    // (its own lookup from a node id does not work), and a group sent by the browser must never be used.
    obj.hasPerm = function(user, key, node) {
        try {
            if (user == null || node == null || obj.PERMISSIONS[key] == null) return false;
            if ((user.siteadmin >>> 0) === 0xFFFFFFFF) return true;
            if (!obj._permApi) return false;   // no permission framework: full administrators only
            // MeshCentral allows everything for a plugin that registered nothing; we did register, so a missing
            // registration means something went wrong: refuse.
            if (obj.parent.pluginPermissions == null || obj.parent.pluginPermissions.eventlog == null) return false;
            return obj.parent.checkPluginPermission(user, 'eventlog', key, node._id, node.meshid) === true;
        } catch (e) { console.log('EVENTLOG: permission check failed: ' + ((e && e.message) || e)); return false; }
    };

    obj.server_startup = function() {
        obj.registerPermissions();
        obj.meshServer.pluginHandler.eventlog_db = require (__dirname + '/db.js').CreateDB(obj.meshServer);
        obj.db = obj.meshServer.pluginHandler.eventlog_db;
        obj.startAssistant();
    };

    // The Assistant (ai/*). A failure here only disables the Assistant; the rest of the plugin keeps working.
    // A previous instance (plugin reload, or server_startup running again) is closed first, so its conversations
    // and timers do not outlive it.
    obj.ai = null;
    obj.startAssistant = function() {
        var ph = obj.meshServer.pluginHandler;
        var prev = [obj.ai, (ph != null) ? ph.eventlog_ai : null];
        prev.forEach(function (p, i) {
            if (p == null || (i == 1 && p === prev[0])) return;
            try { if (typeof p.close == 'function') p.close(); } catch (e) { console.log('EVENTLOG AI: could not close the previous Assistant: ' + ((e && e.message) || e)); }
        });
        obj.ai = null;
        if (ph != null) ph.eventlog_ai = null;
        try {
            obj.ai = require(__dirname + '/ai/index.js').create({ plugin: obj, log: function (m) { console.log(String(m)); } });
            if (obj.ai != null && obj.ai.store != null) {
                var src = null; try { src = obj.ai.store.keySource(); } catch (e2) { }
                console.log('EVENTLOG AI: assistant ready (key source: ' + (src || 'unknown') + ')');
            }
        } catch (e) {
            obj.ai = null;
            console.log('EVENTLOG AI: the Assistant could not be started: ' + ((e && e.message) || e));
        }
        if (ph != null) ph.eventlog_ai = obj.ai;
        return obj.ai;
    };

    // Re-checks, during a running conversation, that the user may still use the Assistant on the device:
    // device rights from the database, the Assistant permission and the Details right. Never rejects.
    obj.reauthorize = function(myparent, grandparent, nodeid) {
        return new Promise(function (resolve) {
            try {
                if (myparent == null || myparent.user == null) { resolve({ ok: false, node: null, rights: 0, reason: 'no user' }); return; }
                obj.resolveNodeRights(myparent, grandparent, nodeid, function (node, rights) {
                    if (node == null) { resolve({ ok: false, node: null, rights: rights || 0, reason: 'no rights on this device' }); return; }
                    if (!obj.hasPerm(myparent.user, 'deviceAssistant', node)) { resolve({ ok: false, node: node, rights: rights, reason: 'missing permission deviceAssistant' }); return; }
                    var r = rights >>> 0;
                    if (r !== obj.MESHRIGHT_ADMIN && (r & obj.MESHRIGHT_DEVICEDETAILS) == 0) { resolve({ ok: false, node: node, rights: rights, reason: 'missing device right Details' }); return; }
                    resolve({ ok: true, node: node, rights: rights, reason: null });
                });
            } catch (e) { resolve({ ok: false, node: null, rights: 0, reason: 'error' }); }
        });
    };

    obj.consoleaction = function() {
        // due to this code running on the client side, this hook is actually contained
        //   in the ./modules_meshcore/eventlog.js (note kept here for informational purposes)
    };

    obj.handleAdminReq = function(req, res, user) {
        require(__dirname + '/admin.js').admin(obj).req(req, res, user);
    }

    // ------------------------------------------------------------------
    //  Front end (browser) code below. Serialized into the page.
    // ------------------------------------------------------------------

    // 'windows' | 'linux' | null. Decided from the agent architecture id: on Linux, osdesc is the
    // distro pretty-name ("Ubuntu 24.04.2 LTS") and never contains "linux", so osdesc is only a
    // last-resort fallback for Windows.
    obj.elPlatform = function() {
      if ((typeof currentNode == 'undefined') || (currentNode == null)) return null;
      if (currentNode.agent != null && currentNode.agent.id != null) {
          var id = currentNode.agent.id;
          var win = [1,2,3,4,21,22,34,42,43,10003,10004,10006,11000,11001,11002];
          var lin = [5,6,7,8,9,10,12,13,15,18,19,20,24,25,26,27,28,32,33,35,36,37,40,41,45]; // 11 is macOS despite its 'linux' platform tag
          if (win.indexOf(id) >= 0) return 'windows';
          if (lin.indexOf(id) >= 0) return 'linux';
      }
      if ((typeof currentNode.osdesc == 'string') && (currentNode.osdesc.toLowerCase().indexOf('windows') !== -1)) return 'windows';
      return null;
    };
    obj.elIsSupported = function() {
      var p = pluginHandler.eventlog.elPlatform();
      return (p == 'windows' || p == 'linux');
    };
    // syslog priority name (Linux detail views keep the raw 0-7 priority next to the collapsed level)
    obj.elPriName = function(p) {
      var names = ['Emergency','Alert','Critical','Error','Warning','Notice','Info','Debug'];
      return (names[p] != null) ? names[p] : ('Priority ' + p);
    };
    // column/detail labels differ per OS: journald has categories and PIDs instead of logs and event ids
    obj.elLbl = function(key) {
      var lx = (pluginHandler.eventlog.elState().os == 'linux');
      if (key == 'log') return lx ? 'Category' : 'Log';
      if (key == 'id') return lx ? 'PID' : 'Event ID';
      if (key == 'idShort') return lx ? 'PID' : 'ID';
      return key;
    };
    // the raw event for the JSON pane / copy: full journald record when available, else the reconstructed shape
    obj.elRawOf = function(ev) {
      if (ev._raw) return ev._raw;
      return { Level: ev.level, TimeCreated: new Date(ev.time).toISOString(), LogName: ev.log, ProviderName: ev.source, Id: ev.id, Message: ev.message };
    };

    // Include/exclude rules for a config set's Categories / Sources lists. `list` is an array or a
    // comma-delimited string of names; '*' matches anything; matching is case-insensitive.
    // Returns null when the list is empty (= no filter). The agent carries an ES5 copy of this.
    obj.elRules = function(list, mode) {
        var items = Array.isArray(list) ? list : String(list == null ? '' : list).split(',');
        var res = [];
        for (var i = 0; i < items.length; i++) {
            var pt = String(items[i]).replace(/^\s+|\s+$/g, '');
            if (pt == '') continue;
            res.push(new RegExp('^' + pt.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
        }
        if (res.length == 0) return null;
        return { exclude: (String(mode || 'exclude').toLowerCase() != 'include'), res: res };
    };
    obj.elAllowed = function(rules, value) {
        if (rules == null) return true;
        var v = String(value == null ? '' : value), hit = false;
        for (var i = 0; i < rules.res.length; i++) { if (rules.res[i].test(v)) { hit = true; break; } }
        return rules.exclude ? !hit : hit;
    };
    // Live view: apply the config set's Live categories (Linux) and sources (all OSes) in the browser,
    // so it works for Windows too, where the agent forwards PowerShell output as-is.
    obj.elLiveAllowed = function(ev) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var cfg = st.cfg;
        if (cfg == null) return true;
        if (st.os == 'linux' && !ph.elAllowed(ph.elRules(cfg.liveCategories, cfg.liveCategoriesMode), ev.log)) return false;
        return ph.elAllowed(ph.elRules(cfg.liveSources, cfg.liveSourcesMode), ev.source);
    };

    // called to notify the web server that there is a new tab in town
    obj.registerPluginTab = function() {
      if (!pluginHandler.eventlog.elIsSupported()) return { tabId: null, tabTitle: null };
      return {
        tabTitle: "Event Log",
        tabId: "pluginEventLog"
      };
    };

    // called to get the content for that tabs data
    obj.on_device_page = function() {
      return '<div id=pluginEventLog></div>';
    };

    // ---- state ----
    obj.elState = function() {
        var ph = pluginHandler.eventlog;
        if (ph.st == null) {
            ph.byKey = {};
            ph.st = {
                view: 'live',
                os: ph.elPlatform(),                                 // 'windows' | 'linux' | null (state resets on node change)
                lsel: '',                                            // Linux view selector ('', kernel, auth, audit, boot)
                meta: null,                                          // {os, caps} reported by the agent / server
                layout: getstore('evl_layout', 'ledger'),           // 'ledger' | 'viewer'
                fold: (getstore('evl_fold', '1') == '1'),
                show: Number(getstore('evl_show', '100')),
                range: getstore('evl_range', '24h'),
                rows: getstore('evl_rows', 'normal'),                // 'dense' | 'normal' | 'wrap'
                cols: { ledger: ph.elLoadJson('evl_cols_ledger'), viewer: ph.elLoadJson('evl_cols_viewer') },   // user column widths (px) per layout
                sideW: Number(getstore('evl_side', '0')) || 0,          // Viewer sidebar width (px), 0 = automatic
                heights: { ledger: Number(getstore('evl_h_ledger', '0')) || 0, viewer: Number(getstore('evl_h_viewer', '0')) || 0 }, // user table height (px) per layout, 0 = automatic
                filters: { levels: null, logs: null, sources: null, ids: '', text: '' },
                sort: { key: 'time', dir: -1 },
                cfg: null,                                           // resolved config set for this node (from onLoadHistory)
                selected: null, expanded: {}, dtab: 'general', raw: {},
                srcMore: false,
                paused: false, pending: [],
                live: { events: [], last: null },
                // recIds: show exactly these stored events (citations); base: offset of the first loaded event (page around a cited one)
                hist: { events: [], total: 0, stored: 0, lastCollected: null, skip: 0, base: 0, recIds: null, loaded: false, loading: false, enabled: true, retentionDays: null, facets: null },
                ai: ph.aiNewState()                                  // Assistant conversations of this device (ui_ai.js)
            };
        }
        return ph.st;
    };

    obj.elLoadJson = function(name) {
        try { var v = getstore(name, ''); if (v) { var o = JSON.parse(v); if (o && typeof o == 'object') return o; } } catch (e) { }
        return {};
    };

    obj.elLevelInfo = function() {
        return [
            { n: 1, name: 'Critical', cls: 'crit' },
            { n: 2, name: 'Error',    cls: 'err'  },
            { n: 3, name: 'Warning',  cls: 'warn' },
            { n: 4, name: 'Info',     cls: 'info' },
            { n: 5, name: 'Verbose',  cls: 'verb' },
            { n: 0, name: 'LogAlways',cls: 'verb' }
        ];
    };

    obj.elHash = function(s) {
        var h = 5381; s = String(s);
        for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) & 0x7FFFFFFF; }
        return h.toString(36);
    };

    // Repair UTF-8 text that was decoded as Latin-1 on the agent ("Ã„nderungen" -> "Änderungen").
    obj.elFixText = function(v) {
        if (v == null) return '';
        v = String(v);
        if (!/[\u00C2-\u00F4][\u0080-\u00BF]/.test(v)) return v;
        try { return decodeURIComponent(escape(v)); } catch (e) { return v; }
    };

    obj.elNormalize = function(raw) {
        try {
            if (raw == null || typeof raw != 'object') return null;
            var t = (raw.tc != null) ? raw.tc : raw.TimeCreated;
            if (Array.isArray(t)) t = t[0];
            if (typeof t == 'string') { var m = t.match(/\d+/); t = m ? m[0] : 0; }
            t = Number(t); if (isNaN(t)) t = 0;
            var lvl = Number(raw.Level); if (isNaN(lvl)) lvl = 0;
            var lvls = pluginHandler.eventlog.elLevelInfo();
            var li = null;
            for (var i in lvls) { if (lvls[i].n == lvl) li = lvls[i]; }
            if (li == null) li = { n: lvl, name: 'Level ' + lvl, cls: 'verb' };
            var ev = {
                level: lvl, levelName: li.name, levelCls: li.cls,
                time: t,
                log: pluginHandler.eventlog.elFixText(raw.LogName),
                source: pluginHandler.eventlog.elFixText(raw.ProviderName),
                id: (raw.Id == null) ? '' : String(raw.Id),
                message: pluginHandler.eventlog.elFixText(raw.Message),
                pri: (raw.Priority != null && !isNaN(Number(raw.Priority))) ? Number(raw.Priority) : null,
                unit: (raw.Unit != null) ? pluginHandler.eventlog.elFixText(raw.Unit) : '',
                transport: (raw.Transport != null) ? String(raw.Transport) : ''
            };
            ev.sig = pluginHandler.eventlog.elHash(ev.level + '|' + ev.log + '|' + ev.source + '|' + ev.id + '|' + ev.message);
            ev.key = pluginHandler.eventlog.elHash(ev.sig + '|' + ev.time);
            ev._raw = raw;   // full record for the JSON pane / copy (journald fields on Linux)
            return ev;
        } catch (e) { return null; }
    };

    obj.elFmtTime = function(ms, timeOnly) {
        if (!ms) return '-';
        var d = new Date(Number(ms));
        if (timeOnly) return d.toLocaleTimeString();
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
    };

    obj.elParseIds = function(str) {
        var out = [];
        String(str || '').split(',').forEach(function(part) {
            part = part.trim(); if (part == '') return;
            var m = part.match(/^(\d+)\s*-\s*(\d+)$/);
            if (m) { out.push([Number(m[1]), Number(m[2])]); }
            else if (part.match(/^\d+$/)) { out.push([Number(part), Number(part)]); }
        });
        return out;
    };

    obj.elMatch = function(ev, ignore) {
        var st = pluginHandler.eventlog.elState(), f = st.filters;
        if (ignore != 'level'  && f.levels  != null && !f.levels[ev.level])   return false;
        if (ignore != 'log'    && f.logs    != null && !f.logs[ev.log])       return false;
        if (ignore != 'source' && f.sources != null && !f.sources[ev.source]) return false;
        if (st._idRanges && st._idRanges.length) {
            var idn = Number(ev.id), ok = false;
            for (var i in st._idRanges) { if (idn >= st._idRanges[i][0] && idn <= st._idRanges[i][1]) { ok = true; break; } }
            if (!ok) return false;
        }
        if (st._cutoff && ev.time && ev.time < st._cutoff) return false;
        if (st._text) {
            var hay = (ev.message + ' ' + ev.source + ' ' + ev.log + ' ' + ev.id).toLowerCase();
            if (hay.indexOf(st._text) === -1) return false;
        }
        return true;
    };

    obj.elFiltered = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st._idRanges = ph.elParseIds(st.filters.ids);
        st._text = String(st.filters.text || '').trim().toLowerCase();
        var ranges = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
        st._cutoff = ranges[st.range] ? (Date.now() - ranges[st.range]) : 0;
        // Diagnosis has no event table; History with recIds shows exactly the cited events (the server picked them)
        var evs = (st.view == 'live') ? st.live.events : ((st.view == 'history') ? st.hist.events : []);
        var exact = (st.view == 'history' && st.hist.recIds != null && st.hist.recIds.length > 0);
        var rows = [], counts = { level: {}, log: {}, source: {} };
        for (var i in evs) {
            var ev = evs[i];
            if (ph.elMatch(ev, 'level'))  { counts.level[ev.level] = (counts.level[ev.level] || 0) + 1; }
            if (ph.elMatch(ev, 'log'))    { counts.log[ev.log] = (counts.log[ev.log] || 0) + 1; }
            if (ph.elMatch(ev, 'source')) { counts.source[ev.source] = (counts.source[ev.source] || 0) + 1; }
            if (exact || ph.elMatch(ev, null)) rows.push(ev);
        }
        var k = st.sort.key, dir = st.sort.dir;
        rows.sort(function(a, b) {
            var x = a[k], y = b[k];
            if (k == 'id') { x = Number(x); y = Number(y); }
            if (x < y) return -1 * dir;
            if (x > y) return 1 * dir;
            return (a.time < b.time) ? 1 : -1; // stable-ish secondary: newest first
        });
        st._total = evs.length;
        st._shown = rows.length;
        return { rows: rows, counts: counts };
    };

    obj.elFold = function(rows) {
        var out = [], map = {};
        for (var i in rows) {
            var ev = rows[i];
            if (map[ev.sig] == null) {
                map[ev.sig] = { ev: ev, count: 0, times: [], evs: [] };
                out.push(map[ev.sig]);
            }
            map[ev.sig].count++;
            map[ev.sig].evs.push(ev);   // every occurrence, in display order (citations of the ones further down)
            if (map[ev.sig].times.length < 24) map[ev.sig].times.push(ev.time);
        }
        return out;
    };

    // ---- rendering ----
    obj.elInjectStyles = function() {
        pluginHandler.eventlog.aiInjectStyles();   // the Assistant's rules (own <style id=evlAiStyles>)
        if (document.getElementById('evlStyles')) return;
        var css = `
#pluginEventLog {
  --evl-ink:#1c1c1c; --evl-muted:#5a6360; --evl-line:#c9c9c9; --evl-line2:#e6e6e6; --evl-bg:#fff;
  --evl-alt:#f4f6f5; --evl-hover:#e9f0f1; --evl-sel:#dbe9eb; --evl-chip:#eef1f0; --evl-input:#fff;
  --evl-acc:#1F6F78; --evl-acc-ink:#fff; --evl-ok:#1e8a4c; --evl-bline:#c9c9c9;
  --evl-crit:#8E1B1B; --evl-err:#C9352B; --evl-warn:#B86F00; --evl-info:#2E6DBF; --evl-verb:#7F8A86;
  --evl-ps-bg:#F3E8D2; --evl-ps-ink:#6B4E16; --evl-bubble:#e9f0f1; --evl-bubble-line:#cfe0e2; --evl-code:#f4f6f5; --evl-code-line:#dfe3e1; --evl-panel:#fafbfa;
  color: var(--evl-ink); background: var(--evl-bg);
}
body.night #pluginEventLog {
  --evl-ink:#bbbbbb; --evl-muted:#8b9591; --evl-line:#333; --evl-line2:#222; --evl-bg:#000;
  --evl-alt:#0d1110; --evl-hover:#18201f; --evl-sel:#18302f; --evl-chip:#1a1f1e; --evl-input:#111;
  --evl-acc:#5fb3bb; --evl-acc-ink:#000; --evl-ok:#3dbf7a; --evl-bline:#4a5250;
  --evl-crit:#ff7b73; --evl-err:#ff8a7e; --evl-warn:#f0b848; --evl-info:#8bb8ff; --evl-verb:#8b9591;
  --evl-ps-bg:#3a2e17; --evl-ps-ink:#f0d9a8; --evl-bubble:#122224; --evl-bubble-line:#24393b; --evl-code:#0d1110; --evl-code-line:#2a302e; --evl-panel:#070a0a;
}
#pluginEventLog .evlMono { font-family: Consolas, "DejaVu Sans Mono", monospace; font-size: 12px; font-variant-numeric: tabular-nums; }
#pluginEventLog .evlBar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:2px 0 6px; }
#pluginEventLog .evlSeg { display:inline-flex; border:1px solid var(--evl-bline); border-radius:3px; overflow:hidden; }
#pluginEventLog .evlSeg button { border:0; background:var(--evl-input); color:var(--evl-muted); padding:4px 11px; cursor:pointer; font:inherit; }
#pluginEventLog .evlSeg button.on { background:var(--evl-acc); color:var(--evl-acc-ink); font-weight:bold; }
#pluginEventLog .evlSeg button:focus-visible, #pluginEventLog .evlBtn:focus-visible { outline:2px solid var(--evl-acc); outline-offset:-2px; }
#pluginEventLog input.evlIn, #pluginEventLog select.evlSel { border:1px solid var(--evl-line); background:var(--evl-input); color:var(--evl-ink); border-radius:3px; padding:4px 6px; font:inherit; max-width:240px; }
#pluginEventLog input.evlIn::placeholder { color:var(--evl-muted); }
#pluginEventLog .evlGrow { flex:1; min-width:140px; }
#pluginEventLog .evlBtn { border:1px solid var(--evl-bline); background:var(--evl-input); color:var(--evl-ink); border-radius:3px; padding:4px 9px; cursor:pointer; font:inherit; }
#pluginEventLog .evlBtn.on { background:var(--evl-acc); color:var(--evl-acc-ink); border-color:var(--evl-acc); }
#pluginEventLog .evlBtn.mini { padding:1px 7px; font-size:12px; }
#pluginEventLog .evlBtn:hover { background:var(--evl-hover); border-color:var(--evl-acc); }
#pluginEventLog .evlBtn:active { background:var(--evl-sel); transform:translateY(1px); }
#pluginEventLog .evlBtn.on:hover, #pluginEventLog .evlBtn.on:active { background:var(--evl-acc); color:var(--evl-acc-ink); border-color:var(--evl-acc); filter:brightness(1.08); }
#pluginEventLog .evlBtn.ok { color:var(--evl-ok); border-color:var(--evl-ok); }
#pluginEventLog .evlSeg button:hover:not(.on) { background:var(--evl-hover); color:var(--evl-ink); }
#pluginEventLog .evlSeg button:active:not(.on) { background:var(--evl-sel); }
#pluginEventLog .evlChip:hover { border-color:var(--evl-acc); }
#pluginEventLog .evlFacet:hover .t { color:var(--evl-acc); }
#pluginEventLog .evlDTabs button:hover:not(.on) { color:var(--evl-ink); }
#pluginEventLog .evlLink:hover { text-decoration-style:solid; }
#pluginEventLog table.evlLog th:hover { color:var(--evl-ink); }
#pluginEventLog .evlLbl { color:var(--evl-muted); }
#pluginEventLog .evlChips { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:0 0 6px; }
#pluginEventLog .evlChip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--evl-line); border-radius:12px; padding:2px 10px 2px 8px; background:var(--evl-chip); color:var(--evl-ink); cursor:pointer; font-size:12px; }
#pluginEventLog .evlChip .sw { width:8px; height:8px; border-radius:50%; display:inline-block; }
#pluginEventLog .evlChip .n { color:var(--evl-muted); font-variant-numeric:tabular-nums; }
#pluginEventLog .evlChip.off { opacity:.45; text-decoration:line-through; }
#pluginEventLog .evlChip.filt { border-color:var(--evl-acc); background:transparent; }
#pluginEventLog .evlChip .x { color:var(--evl-muted); margin-left:2px; }
#pluginEventLog table.evlLog { width:100%; border-collapse:collapse; table-layout:fixed; }
#pluginEventLog table.evlLog th { text-align:left; font-weight:bold; color:var(--evl-muted); font-size:12px; padding:5px 8px; border-bottom:1px solid var(--evl-line); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; position:sticky; top:0; background:var(--evl-bg); z-index:1; }
#pluginEventLog .evlRz { position:absolute; top:0; right:0; width:8px; height:100%; cursor:col-resize; z-index:2; user-select:none; touch-action:none; }
#pluginEventLog .evlRz::after { content:""; position:absolute; top:25%; bottom:25%; right:3px; width:1px; background:var(--evl-line); }
#pluginEventLog .evlRz:hover::after, #pluginEventLog .evlRz.active::after { top:0; bottom:0; width:2px; right:2px; background:var(--evl-acc); }
#pluginEventLog .evlGuide { position:absolute; width:0; border-left:1px dashed var(--evl-acc); pointer-events:none; z-index:3; }
#pluginEventLog .evlGuide span { position:absolute; top:6px; left:6px; background:var(--evl-acc); color:var(--evl-acc-ink); font-size:11px; padding:1px 6px; border-radius:3px; white-space:nowrap; font-family:Consolas,"DejaVu Sans Mono",monospace; }
#pluginEventLog .evlResizing, #pluginEventLog .evlResizing * { cursor:col-resize !important; user-select:none; }
#pluginEventLog .evlResizing table.evlLog tbody tr:hover:not(.evlExpand) td { background:inherit; }
#pluginEventLog .evlGrip, #pluginEventLog .evlSplit { height:9px; cursor:row-resize; background:var(--evl-alt); border-top:1px solid var(--evl-line2); position:relative; touch-action:none; user-select:none; }
#pluginEventLog .evlSplit { height:7px; border-top:1px solid var(--evl-line); border-bottom:1px solid var(--evl-line); }
#pluginEventLog .evlGrip::after, #pluginEventLog .evlSplit::after { content:""; position:absolute; left:50%; top:3px; width:34px; height:1px; margin-left:-17px; background:var(--evl-line); box-shadow:0 2px 0 var(--evl-line); }
#pluginEventLog .evlSplit::after { top:2px; }
#pluginEventLog .evlGrip:hover, #pluginEventLog .evlGrip.active, #pluginEventLog .evlSplit:hover, #pluginEventLog .evlSplit.active { background:var(--evl-sel); }
#pluginEventLog .evlGrip:hover::after, #pluginEventLog .evlGrip.active::after, #pluginEventLog .evlSplit:hover::after, #pluginEventLog .evlSplit.active::after { background:var(--evl-acc); box-shadow:0 2px 0 var(--evl-acc); }
#pluginEventLog .evlDense table.evlLog tr:not(.evlExpand) td { padding:1px 8px; font-size:12px; }
#pluginEventLog .evlDense table.evlLog th { padding:3px 8px; }
#pluginEventLog .evlWrap table.evlLog tr:not(.evlExpand) td { white-space:normal; word-break:break-word; }
#pluginEventLog .evlWrap table.evlLog tr:not(.evlExpand) td.evlCLv, #pluginEventLog .evlWrap table.evlLog tr:not(.evlExpand) td.evlCTm, #pluginEventLog .evlWrap table.evlLog tr:not(.evlExpand) td.evlCId { white-space:nowrap; }
#pluginEventLog .evlLink { color:var(--evl-acc); cursor:pointer; text-decoration:underline dotted; }
#pluginEventLog table.evlLog th.sorted { color:var(--evl-ink); }
#pluginEventLog table.evlLog td.evlCId { text-align:right; }
#pluginEventLog table.evlLog td { padding:4px 8px; border-bottom:1px solid var(--evl-line2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; vertical-align:top; }
#pluginEventLog table.evlLog tbody tr { cursor:pointer; }
#pluginEventLog table.evlLog tbody tr:nth-child(even):not(.evlExpand) td { background:var(--evl-alt); }
#pluginEventLog table.evlLog tbody tr:hover:not(.evlExpand) td { background:var(--evl-hover); }
#pluginEventLog table.evlLog tr.evlSelRow td { background:var(--evl-sel) !important; }
#pluginEventLog .evlLv { display:inline-flex; align-items:center; gap:6px; font-weight:bold; }
#pluginEventLog .evlLv i { width:9px; height:9px; border-radius:50%; display:inline-block; flex:none; }
#pluginEventLog .evlLv.crit { color:var(--evl-crit); } #pluginEventLog .evlLv.crit i { background:var(--evl-crit); }
#pluginEventLog .evlLv.err  { color:var(--evl-err);  } #pluginEventLog .evlLv.err i  { background:var(--evl-err); }
#pluginEventLog .evlLv.warn { color:var(--evl-warn); } #pluginEventLog .evlLv.warn i { background:var(--evl-warn); }
#pluginEventLog .evlLv.info { color:var(--evl-info); } #pluginEventLog .evlLv.info i { background:var(--evl-info); }
#pluginEventLog .evlLv.verb { color:var(--evl-verb); } #pluginEventLog .evlLv.verb i { background:var(--evl-verb); }
#pluginEventLog .evlRep { display:inline-block; border:1px solid var(--evl-line); border-radius:10px; padding:0 7px; font-size:11px; color:var(--evl-muted); background:var(--evl-chip); margin-right:6px; }
#pluginEventLog .evlRep b { color:var(--evl-ink); }
#pluginEventLog tr.evlExpand td { white-space:normal; background:var(--evl-sel) !important; padding:10px 12px 12px 32px; cursor:default; }
#pluginEventLog .evlMsgFull { white-space:pre-wrap; max-width:110ch; line-height:1.45; }
#pluginEventLog .evlMeta { display:flex; gap:20px; color:var(--evl-muted); margin-top:8px; flex-wrap:wrap; }
#pluginEventLog .evlMeta b { color:var(--evl-ink); }
#pluginEventLog .evlActs { margin-top:9px; display:flex; gap:7px; flex-wrap:wrap; }
#pluginEventLog pre.evlRaw { background:var(--evl-chip); border:1px solid var(--evl-line2); padding:8px; overflow:auto; max-height:240px; margin:8px 0 0; font-size:11px; color:var(--evl-ink); white-space:pre-wrap; word-break:break-word; }
#pluginEventLog .evlStatus { display:flex; gap:16px; color:var(--evl-muted); font-size:12px; padding:7px 2px; align-items:center; flex-wrap:wrap; border-top:1px solid var(--evl-line2); margin-top:-1px; }
#pluginEventLog .evlStatus .live { color:var(--evl-ok); }
#pluginEventLog .evlStatus .warn { color:var(--evl-warn); }
#pluginEventLog .evlViewer { display:grid; grid-template-columns:var(--evl-side, 215px) 7px minmax(0, 1fr); border:1px solid var(--evl-line); border-radius:3px; overflow:hidden; }
#pluginEventLog .evlFacets { padding:9px 11px; background:var(--evl-alt); min-width:0; overflow-x:hidden; overflow-y:auto; contain:size; }
#pluginEventLog .evlVSplit { cursor:col-resize; background:var(--evl-alt); border-right:1px solid var(--evl-line); position:relative; touch-action:none; user-select:none; }
#pluginEventLog .evlVSplit::after { content:""; position:absolute; top:50%; left:2px; height:34px; width:1px; margin-top:-17px; background:var(--evl-line); box-shadow:2px 0 0 var(--evl-line); }
#pluginEventLog .evlVSplit:hover, #pluginEventLog .evlVSplit.active { background:var(--evl-sel); }
#pluginEventLog .evlVSplit:hover::after, #pluginEventLog .evlVSplit.active::after { background:var(--evl-acc); box-shadow:2px 0 0 var(--evl-acc); }
#pluginEventLog .evlFacets h4 { margin:11px 0 5px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--evl-muted); }
#pluginEventLog .evlFacets h4:first-child { margin-top:0; }
#pluginEventLog .evlFacet { display:flex; align-items:center; gap:7px; padding:2px 0; cursor:pointer; }
#pluginEventLog .evlFacet .cb { width:12px; height:12px; border:1px solid var(--evl-line); border-radius:2px; background:var(--evl-input); flex:none; display:inline-grid; place-items:center; font-size:9px; color:var(--evl-acc-ink); line-height:1; }
#pluginEventLog .evlFacet .cb.on { background:var(--evl-acc); border-color:var(--evl-acc); }
#pluginEventLog .evlFacet .t { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#pluginEventLog .evlFacet .n { margin-left:auto; color:var(--evl-muted); font-variant-numeric:tabular-nums; font-size:12px; }
#pluginEventLog .evlMore { color:var(--evl-acc); font-size:12px; cursor:pointer; display:inline-block; margin-top:3px; }
#pluginEventLog .evlScroll { overflow:auto; max-height:calc(100vh - 270px); min-height:160px; position:relative; container-type:inline-size; }
/* an expanded row spans the whole table, which can be wider than the visible area: keep its content within view (100cqw = .evlScroll) */
#pluginEventLog tr.evlExpand td > * { max-width:calc(100cqw - 44px); min-width:0; box-sizing:border-box; }
#pluginEventLog .evlVList { overflow:auto; max-height:max(200px, calc(100vh - 520px)); outline:none; position:relative; }
#pluginEventLog .evlVList table.evlLog th { top:0; }
#pluginEventLog .evlDetails { border-top:1px solid var(--evl-line); max-height:40vh; overflow:auto; }
#pluginEventLog .evlDTabs { display:flex; align-items:center; border-bottom:1px solid var(--evl-line); background:var(--evl-alt); }
#pluginEventLog .evlDTabs button { border:0; background:none; color:var(--evl-muted); padding:6px 14px; cursor:pointer; font:inherit; }
#pluginEventLog .evlDTabs button.on { color:var(--evl-ink); font-weight:bold; border-bottom:2px solid var(--evl-acc); margin-bottom:-1px; }
#pluginEventLog .evlDTabs .sp { flex:1; }
#pluginEventLog .evlDBody { display:grid; grid-template-columns:1fr 320px; gap:16px; padding:11px 13px; }
#pluginEventLog .evlKv { display:grid; grid-template-columns:auto 1fr; gap:3px 13px; font-size:12px; align-content:start; margin:0; }
#pluginEventLog .evlKv dt { color:var(--evl-muted); } #pluginEventLog .evlKv dd { margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#pluginEventLog .evlEmpty { padding:26px 10px; color:var(--evl-muted); text-align:center; }
@media (max-width: 1000px) {
  #pluginEventLog .evlViewer { grid-template-columns:1fr; }
  #pluginEventLog .evlVSplit { display:none; }
  #pluginEventLog .evlFacets { border-bottom:1px solid var(--evl-line); contain:none; max-height:30vh; }
  #pluginEventLog .evlDBody { grid-template-columns:1fr; }
}
`;
        var s = document.createElement('style');
        s.id = 'evlStyles';
        s.appendChild(document.createTextNode(css));
        document.head.appendChild(s);
    };

    // ---- Plugin permissions (browser side) ----------------------------------------------------
    // The server decides (MeshCentral plugin permissions plus device rights); the tab asks once per device and
    // shows only the views it was granted. Until the answer arrives nothing is shown or started.
    obj.elCan = function(what) {
        var a = pluginHandler.eventlog.elAccess;
        return (a != null && typeof currentNode != 'undefined' && currentNode != null && a.nodeid == currentNode._id && a[what] === true);
    };
    obj.elRequestAccess = function(force) {
        var ph = pluginHandler.eventlog;
        if (typeof currentNode == 'undefined' || currentNode == null) return;
        var now = Date.now(), asked = ph._accessAsked;
        if (force !== true && asked != null && asked.nodeid == currentNode._id && (now - asked.t) < 5000) return;   // one request per device and 5 s
        ph._accessAsked = { nodeid: currentNode._id, t: now };
        meshserver.send({ action: 'plugin', plugin: 'eventlog', pluginaction: 'checkAccess', nodeid: currentNode._id });
    };
    obj.elRecheckAccess = function() {   // "Check again" in the notice: pick up a permission granted a moment ago
        var ph = pluginHandler.eventlog;
        ph.elAccess = null;
        ph.elAccessGate();
        ph.elRequestAccess(true);
        return false;
    };
    // True when the tab may be drawn; otherwise draws a notice in its place.
    obj.elAccessGate = function() {
        var ph = pluginHandler.eventlog;
        if (!Q('pluginEventLog')) return false;
        var a = ph.elAccess, known = (a != null && typeof currentNode != 'undefined' && currentNode != null && a.nodeid == currentNode._id);
        if (known && (a.live || a.history || a.assistant)) {
            if (Q('evlNotice')) QH('pluginEventLog', '');   // permission was granted since the notice was drawn
            return true;
        }
        // only the Assistant is permitted but it is not available here: say why instead of "no permission"
        var why = known ? ph.aiUnavailText(a) : '';
        var key = known ? (why ? 'why' : 'denied') : 'checking';
        if (!Q('evlNotice') || Q('evlNotice').getAttribute('data-k') != key || Q('evlNotice').getAttribute('data-w') != why) {
            QH('pluginEventLog', '<div id=evlNotice data-k=' + key + ' data-w="' + EscapeHtml(why) + '" style="padding:18px 14px;opacity:.85"' + (why ? ' role=note' : '') + '>' +
                (why ? EscapeHtml(why) + ' <a href=# onclick="return pluginHandler.eventlog.elRecheckAccess()">Check again</a>'
                 : known ? 'You do not have permission to use the Event Log on this device. A MeshCentral administrator can grant it in the plugin\'s permissions (My Server, Plugins, Event Log, Permissions). <a href=# onclick="return pluginHandler.eventlog.elRecheckAccess()">Check again</a>'
                       : 'Checking permissions&hellip;') + '</div>');
        }
        if (!known) ph.elRequestAccess();
        return false;
    };
    obj.onAccess = function(server, message) {
        var ph = pluginHandler.eventlog, prev = ph.elAccess;
        var a = {}; for (var k in message) { if (k != 'action' && k != 'plugin' && k != 'method') a[k] = message[k]; }
        a.live = (message.live === true); a.history = (message.history === true); a.assistant = (message.assistant === true);
        ph.elAccess = a;
        if (typeof currentNode == 'undefined' || currentNode == null || currentNode._id != message.nodeid) return;
        var same = (prev != null && prev.nodeid == a.nodeid && prev.live == a.live && prev.history == a.history && prev.assistant == a.assistant &&
            prev.assistantReason == a.assistantReason && prev.configSetName == a.configSetName && prev.canManage == a.canManage);
        if (same && (Q('evlWrap') || Q('evlNotice'))) {   // nothing changed: keep the tab as it is (the endpoint shown may have)
            if (a.assistant && ph.st != null) ph.aiHistoryInit();
            if (Q('evlAiHd') && ph.st != null) QH('evlAiHd', ph.aiHeadHtml(ph.st.ai.convs[ph.st.ai.chat] || null));
            return;
        }
        if (!a.live) ph.elStopLive();
        if (!a.assistant && ph.st != null && ph.st.ai != null) {   // Assistant revoked: stop what runs, close its views
            ph.aiAbortAll();
            ph.aiDlgClose(true);
            ph.st.ai.open = false;
            if (ph.st.view == 'ai') ph.st.view = a.history ? 'history' : 'live';
        }
        if (Q('evlWrap')) QH('pluginEventLog', '');   // rebuild the shell with the views this user may use
        if (ph.elEnsureShell()) {
            var st = ph.elState();
            if (st.view == 'history' && a.history && !st.hist.loaded && !st.hist.loading) ph.elLoadHistory(true);
            if (a.assistant) ph.aiHistoryInit();   // saved chats, the last diagnosis and explanations of this user
        }
        setTimeout(function() { try { pluginHandler.eventlog.elEnsureLive(); } catch (e) { } }, 0);
    };
    // The server refused an action: the permissions may have changed, so ask again.
    obj.onAccessDenied = function(server, message) {
        var ph = pluginHandler.eventlog;
        if (typeof currentNode == 'undefined' || currentNode == null || currentNode._id != message.nodeid) return;
        if (message.act == 'checkAccess') { ph.onAccess(server, { nodeid: message.nodeid, live: false, history: false, assistant: false }); return; }
        // a refused Assistant request: end it in the UI (onAiError asks for the permissions again)
        if ((message.reqId != null || message.convId != null) && String(message.act || '').indexOf('ai') === 0) {
            ph.onAiError(server, { nodeid: message.nodeid, reqId: message.reqId, convId: message.convId, code: 'denied', message: '' });
        }
        ph.elRequestAccess(true);
    };

    obj.elEnsureShell = function() {
        var ph = pluginHandler.eventlog;
        ph.elInjectStyles();
        if (!Q('pluginEventLog')) return false;
        if (!ph.elAccessGate()) return false;
        if (!Q('evlWrap')) {
            var st0 = ph.elState();   // open on a view this user is allowed to see ('ai': the Assistant is all they have)
            var canL = ph.elCan('live'), canH = ph.elCan('history'), canA = ph.elCan('assistant');
            if (st0.view == 'live' && !canL) st0.view = canH ? 'history' : (canA ? 'ai' : 'live');
            else if (st0.view == 'history' && !canH) st0.view = canL ? 'live' : (canA ? 'ai' : 'history');
            else if (st0.view == 'ai' && (canL || canH || !canA)) st0.view = canL ? 'live' : 'history';
            // #evlCol holds the table and its status line; the Assistant panel #evlAi docks beside it (or below it on
            // narrow screens, or takes its place in full width). Both render from state: MeshCentral rebuilds this DOM
            // on every refresh.
            QH('pluginEventLog', '<div id=evlWrap><div id=evlToolbar></div><div id=evlMain class=evlMain><div id=evlCol class=evlCol>' +
                '<div id=evlChips class=evlChips></div><div id=evlBody></div><div id=evlStatus class=evlStatus></div></div>' +
                '<aside id=evlAi class=evlAi aria-label="Ask about this device" hidden></aside></div>' +
                '<div id=evlAiSay class=evlSr role=status aria-live=polite></div></div>');
            ph.elRenderShell();
            if (typeof ResizeObserver == 'function') {   // the page can change width without a window resize (side menu)
                try { if (ph._aiRO) ph._aiRO.disconnect(); ph._aiRO = new ResizeObserver(function() { try { pluginHandler.eventlog.aiLayout(); } catch (e) { } }); ph._aiRO.observe(Q('evlWrap')); ph._aiRO.observe(Q('evlToolbar')); } catch (e) { }
            }
        }
        ph.elFitHeight();   // the tab may have been hidden during the last render
        ph.aiLayout();      // the Ask panel's height too (fit to the window, or the height set with its grip)
        if (!ph._fitBound) { ph._fitBound = true; window.addEventListener('resize', function() { pluginHandler.eventlog.elFitHeight(); pluginHandler.eventlog.aiLayout(); }); }
        return true;
    };

    obj.elRenderShell = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var esc = EscapeHtml;
        var h = '<div class=evlBar>';
        var seg = function(id, v, perm, label) {
            return '<button id=' + id + (ph.elCan(perm) ? '' : ' hidden') + ' class="' + (st.view == v ? 'on' : '') + '" aria-pressed=' + (st.view == v ? 'true' : 'false') + ' onclick="return pluginHandler.eventlog.elSetView(\'' + v + '\')">' + label + '</button>';
        };
        if (st.view != 'ai') h += '<div class=evlSeg role=group aria-label="View">' + seg('evlVLive', 'live', 'live', '&#9679; Live') + seg('evlVHist', 'history', 'history', 'History') + '</div>';
        if (st.view == 'ai') {
            // the Assistant only: no event list, so no filters
        } else {
        if (st.os == 'linux') {
            h += '<span class=evlLbl>View</span> <select id=evlLxSel class=evlSel title="Log view - in Live view this is queried from journalctl directly (Kernel = -k, Security = auth facilities, This boot = -b)" onchange="return pluginHandler.eventlog.elSelCat(this.value)">';
            [['','All'],['kernel','Kernel'],['auth','Security (auth)'],['audit','Audit'],['boot','This boot']].forEach(function(o){ h += '<option value="' + o[0] + '"' + (st.lsel == o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; });
            h += '</select>';
        }
        if (st.layout == 'ledger') {
            h += '<span class=evlLbl>' + ph.elLbl('log') + '</span> <select id=evlLogSel class=evlSel onchange="return pluginHandler.eventlog.elSelLog(this)"><option value="">All</option></select>';
            h += '<span class=evlLbl>Source</span> <select id=evlSrcSel class=evlSel onchange="return pluginHandler.eventlog.elSelSource(this)"><option value="">All</option></select>';
        }
        h += '<input id=evlIdIn class=evlIn style=width:120px placeholder="IDs: 1112, 100-199" value="' + esc(st.filters.ids) + '" oninput="return pluginHandler.eventlog.elIdInput(this)">';
        h += '<input id=evlTxtIn class="evlIn evlGrow" placeholder="Search message, source, ID&hellip;" value="' + esc(st.filters.text) + '" oninput="return pluginHandler.eventlog.elTextInput(this)">';
        h += '<select id=evlRangeSel class=evlSel title="Time range" onchange="return pluginHandler.eventlog.elSetRange(this.value)">';
        [['all','Any time'],['1h','Last hour'],['24h','Last 24 h'],['7d','Last 7 days'],['30d','Last 30 days']].forEach(function(o){ h += '<option value=' + o[0] + (st.range == o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; });
        h += '</select>';
        h += '<span class=evlLbl>Show</span> <select id=evlShowSel class=evlSel title="Entries per log (Live) / per page (History)" onchange="return pluginHandler.eventlog.elSetShow(this.value)">';
        [10,15,25,50,100,250,500].forEach(function(n){ h += '<option value=' + n + (st.show == n ? ' selected' : '') + '>' + n + '</option>'; });
        h += '</select>';
        h += '<span class=evlLbl>Rows</span> <select id=evlRowsSel class=evlSel title="Row density: Compact (tight), Normal, Wrap (message text wraps onto several lines)" onchange="return pluginHandler.eventlog.elSetRows(this.value)">';
        [['dense','Compact'],['normal','Normal'],['wrap','Wrap']].forEach(function(o){ h += '<option value=' + o[0] + (st.rows == o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; });
        h += '</select>';
        h += '<button id=evlFoldBtn class="evlBtn ' + (st.fold ? 'on' : '') + '" title="Fold repeated events into one line" onclick="return pluginHandler.eventlog.elToggleFold()">&#8659; Fold repeats</button>';
        h += '<button id=evlPauseBtn class=evlBtn title="Pause live updates" onclick="return pluginHandler.eventlog.elTogglePause()" ' + (st.view != 'live' ? 'hidden' : '') + '>' + (st.paused ? '&#9654;' : '&#10074;&#10074;') + '</button>';
        h += '<button class=evlBtn title="Refresh" onclick="return pluginHandler.eventlog.elRefresh()">&#8635;</button>';
        h += '<button class=evlBtn title="Export the filtered rows as CSV" onclick="return pluginHandler.eventlog.elExportCsv()">&#10515; CSV</button>';
        h += '<div class=evlSeg title="Layout">' +
             '<button class="' + (st.layout == 'ledger' ? 'on' : '') + '" onclick="return pluginHandler.eventlog.elSetLayout(\'ledger\')">Table</button>' +
             '<button class="' + (st.layout == 'viewer' ? 'on' : '') + '" onclick="return pluginHandler.eventlog.elSetLayout(\'viewer\')">Viewer</button></div>';
        }
        if (ph.elCan('assistant')) {
            // Ask opens the chat panel; Diagnose opens it in full width with the time window (it never runs by itself)
            if (st.view != 'ai') h += '<button id=evlAiBtn class="evlBtn evlAiBtn' + (st.ai.open ? ' on' : '') + '" aria-expanded=' + (st.ai.open ? 'true' : 'false') + ' aria-controls=evlAi onclick="return pluginHandler.eventlog.aiToggle()">' +
                 '<svg width=14 height=14 viewBox="0 0 16 16" fill=none stroke=currentColor stroke-width=1.6 aria-hidden=true><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>Ask about this device<span class=evlAiDot aria-hidden=true></span></button>';
            h += '<button id=evlAiDiagBtn class="evlBtn evlAiDgBtn' + (st.view == 'ai' ? ' evlAiBtn' : '') + '" aria-controls=evlAi title="Diagnose this device: choose a time window, then start" onclick="return pluginHandler.eventlog.aiDiagOpen()">' + ph.aiIcon('diag') + 'Diagnose</button>';
        } else {   // say why the Assistant is not offered here (nothing for users without its permission)
            var why = ph.aiUnavailText(ph.elAccess);
            if (why) h += '<span id=evlAiWhy class=evlAiWhy role=note>' + esc(why) + '</span>';
        }
        h += '</div>';
        QH('evlToolbar', h);
        ph.elUpdate();
        ph.aiRenderPanel();
    };

    obj.elUpdate = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (!Q('evlWrap')) return;
        var fr = ph.elFiltered();
        // the Assistant only: no event table (the panel takes the page)
        var only = (st.view == 'ai'), b0 = Q('evlBody'), c0 = Q('evlChips'), s0 = Q('evlStatus');
        if (b0) b0.hidden = only; if (c0) c0.hidden = only; if (s0) s0.hidden = only;
        if (only) return;
        ph.elRenderChips(fr);
        ph.elRenderBody(fr);
        ph.elRenderStatus();
        // refresh the Log/Source dropdown options (ledger layout)
        if (st.layout == 'ledger') {
            var esc = EscapeHtml;
            var counts = ph.elCounts(fr);
            [['evlLogSel', 'log', st.filters.logs], ['evlSrcSel', 'source', st.filters.sources]].forEach(function(cfg) {
                var sel = Q(cfg[0]); if (!sel) return;
                var names = Object.keys(counts[cfg[1]]).sort();
                var cur = null;
                if (cfg[2] != null) { var kk = Object.keys(cfg[2]); if (kk.length == 1) cur = kk[0]; else cur = '_multi'; }
                var oh = '<option value="">All (' + names.length + ')</option>';
                if (cur == '_multi') oh += '<option value="_multi" selected>(multiple)</option>';
                names.forEach(function(n) { oh += '<option value="' + esc(n) + '"' + (cur == n ? ' selected' : '') + '>' + esc(n) + ' (' + counts[cfg[1]][n] + ')</option>'; });
                sel.innerHTML = oh;
            });
        }
    };

    obj.elRenderChips = function(fr) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var esc = EscapeHtml, h = '';
        var counts = ph.elCounts(fr);
        h += '<span class=evlLbl>Level</span>';
        ph.elLevelInfo().forEach(function(li) {
            if (li.n == 0 && !counts.level[0]) return; // hide LogAlways unless present
            var off = (st.filters.levels != null && !st.filters.levels[li.n]);
            h += '<span class="evlChip' + (off ? ' off' : '') + '" role=button tabindex=0 onclick="return pluginHandler.eventlog.elToggleLevel(' + li.n + ')" onkeypress="if(event.key==\'Enter\')pluginHandler.eventlog.elToggleLevel(' + li.n + ')">' +
                 '<i class=sw style="background:var(--evl-' + li.cls + ')"></i>' + li.name + ' <span class=n>' + (counts.level[li.n] || 0) + '</span></span>';
        });
        var filts = [];
        if (st.filters.logs != null)    { var k1 = Object.keys(st.filters.logs);    filts.push(['logs',    'Log: '    + (k1.length == 1 ? esc(k1[0]) : k1.length + ' selected')]); }
        if (st.filters.sources != null) { var k2 = Object.keys(st.filters.sources); filts.push(['sources', 'Source: ' + (k2.length == 1 ? esc(k2[0]) : k2.length + ' selected')]); }
        if (String(st.filters.ids).trim()  != '') filts.push(['ids',  'ID: '     + esc(st.filters.ids)]);
        if (String(st.filters.text).trim() != '') filts.push(['text', 'Search: ' + esc(st.filters.text)]);
        if (st.view == 'history' && st.hist.recIds != null && st.hist.recIds.length) filts.push(['recIds', 'Cited by the assistant: ' + st.hist.recIds.length + (st.hist.recIds.length == 1 ? ' event' : ' events')]);
        if (filts.length) {
            h += '<span class=evlLbl style=margin-left:12px>Active</span>';
            filts.forEach(function(f) {
                h += '<span class="evlChip filt" role=button tabindex=0 onclick="return pluginHandler.eventlog.elClearFilter(\'' + f[0] + '\')">' + f[1] + ' <span class=x>&#10005;</span></span>';
            });
            h += '<span class="evlChip" role=button tabindex=0 onclick="return pluginHandler.eventlog.elResetFilters()">Reset all</span>';
        }
        h += ph.aiNoticeHtml();   // "E3 is hidden by the current filters. Show anyway"
        QH('evlChips', h);
    };

    obj.elRenderFacets = function(fr) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var esc = EscapeHtml, h = '';
        var facet = function(kind, name, count, on) {
            return '<div class=evlFacet role=button tabindex=0 onclick="return pluginHandler.eventlog.elToggleFacet(\'' + kind + '\',\'' + esc(name).replace(/'/g, '&apos;') + '\')">' +
                   '<span class="cb' + (on ? ' on' : '') + '">' + (on ? '&#10003;' : '') + '</span><span class=t title="' + esc(name) + '">' + esc(name) + '</span><span class=n>' + count + '</span></div>';
        };
        var counts = ph.elCounts(fr);
        h += '<h4>' + ph.elLbl('log') + '</h4>';
        Object.keys(counts.log).sort().forEach(function(n) {
            h += facet('logs', n, counts.log[n], (st.filters.logs == null || st.filters.logs[n]));
        });
        h += '<h4>Source</h4>';
        var srcs = Object.keys(counts.source).sort(function(a, b) { return counts.source[b] - counts.source[a]; });
        var lim = st.srcMore ? srcs.length : 10;
        srcs.slice(0, lim).forEach(function(n) {
            h += facet('sources', n, counts.source[n], (st.filters.sources == null || st.filters.sources[n]));
        });
        if (srcs.length > 10) h += '<span class=evlMore role=button tabindex=0 onclick="return pluginHandler.eventlog.elFacetsMore()">' + (st.srcMore ? 'show fewer' : 'show ' + (srcs.length - 10) + ' more&hellip;') + '</span>';
        return h;
    };

    obj.elRenderBody = function(fr) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var esc = EscapeHtml;
        var frows = st.fold ? ph.elFold(fr.rows) : fr.rows.map(function(ev) { return { ev: ev, count: 1, times: [ev.time] }; });
        st._matching = frows.length;
        if (st.view == 'live' && frows.length > st.show) frows = frows.slice(0, st.show); // "Show N" = N displayed rows
        st._visible = frows.length;
        var sortTh = function(key, label) {
            var s = (st.sort.key == key) ? (' class=sorted') : '';
            var ar = (st.sort.key == key) ? (st.sort.dir == -1 ? ' &#9660;' : ' &#9650;') : '';
            var w = ph.elColW(key);
            var rz = (key != 'message') ? '<span class=evlRz title="Drag to resize &middot; double-click to fit" onpointerdown="return pluginHandler.eventlog.elRzDown(event,\'' + key + '\')" ondblclick="return pluginHandler.eventlog.elRzFit(event,\'' + key + '\')" onclick="event.stopPropagation();return false"></span>' : '';
            return '<th' + (w ? ' style=width:' + w + 'px' : '') + s + ' onclick="return pluginHandler.eventlog.elSetSort(\'' + key + '\')">' + label + ar + rz + '</th>';
        };
        var dens = (st.rows == 'dense') ? ' evlDense' : (st.rows == 'wrap') ? ' evlWrap' : '';
        var hstyle = st.heights[st.layout] ? ' style="height:' + st.heights[st.layout] + 'px;max-height:none;min-height:0"' : '';
        // gutter column with the citation chips of the conversation in focus (only while it cites something)
        // (folded rows can carry several: the column is as wide as the widest row's chips)
        var cm = ph.aiCiteMap(), gut = (cm.n > 0), gl = {}, gw = 52;
        if (gut) frows.forEach(function(r) { var l = ph.aiRowCites(r, cm); gl[r.ev.key] = l; gw = Math.max(gw, ph.aiGutterW(l)); });
        var gutTh = gut ? '<th class=evlCCite style=width:' + gw + 'px><span class=evlSr>Cited</span></th>' : '';
        var rowHtml = function(r, mode) {
            var ev = r.ev;
            var selCls = (mode == 'viewer' && st.selected == ev.key) || (mode == 'ledger' && st.expanded[ev.key]) ? ' class=evlSelRow' : '';
            var rep = (r.count > 1) ? '<span class=evlRep title="Identical event repeated"><b>&times;' + r.count + '</b></span>' : '';
            var h = '<tr id=evlR_' + ev.key + selCls + ' onclick="return pluginHandler.eventlog.elRowClick(\'' + ev.key + '\')">';
            if (gut) h += ph.aiGutterTd(r, cm, gl[ev.key]);
            h += '<td class=evlCLv><span class="evlLv ' + ev.levelCls + '"><i></i>' + esc(ev.levelName) + '</span></td>';
            h += '<td class="evlCTm evlMono">' + ph.elFmtTime(ev.time) + '</td>';
            if (mode == 'ledger') h += '<td class=evlCLog title="' + esc(ev.log) + '">' + esc(ev.log) + '</td>';
            h += '<td class=evlCSrc title="' + esc(ev.source) + '">' + esc(ev.source) + '</td>';
            h += '<td class="evlCId evlMono">' + esc(ev.id) + '</td>';
            h += '<td class=evlCMsg title="' + esc(ev.message).substring(0, 500) + '">' + rep + esc(ev.message) + '</td></tr>';
            if (mode == 'ledger' && st.expanded[ev.key]) {
                h += '<tr class=evlExpand onclick="event.stopPropagation()"><td colspan=' + (gut ? 7 : 6) + '>' + ph.elRenderDetailHtml(r) + '</td></tr>';
            }
            return h;
        };
        var h = '';
        if (st.layout == 'viewer') {
            h += '<div class=evlViewer id=evlViewer' + (st.sideW ? ' style="--evl-side:' + st.sideW + 'px"' : '') + '><div class=evlFacets id=evlFacets>' + ph.elRenderFacets(fr) + '</div>';
            h += '<div class=evlVSplit title="Drag to change the sidebar width &middot; double-click to reset" onpointerdown="return pluginHandler.eventlog.elVSplitDown(event)" ondblclick="return pluginHandler.eventlog.elVSplitReset()"></div>';
            h += '<div><div class="evlVList' + dens + '" id=evlVList tabindex=0' + hstyle + ' onkeydown="return pluginHandler.eventlog.elKeyNav(event)"><table class=evlLog><thead><tr>' + gutTh +
                 sortTh('level', 'Level') + sortTh('time', 'Time') + sortTh('source', 'Source') + sortTh('id', ph.elLbl('idShort')) + sortTh('message', 'Message') +
                 '</tr></thead><tbody>';
            var selRep = null;
            frows.forEach(function(r) { h += rowHtml(r, 'viewer'); if (st.selected == r.ev.key) selRep = r; });
            if (!frows.length) h += '<tr><td colspan=' + (gut ? 6 : 5) + '><div class=evlEmpty>' + ph.elEmptyText() + '</div></td></tr>';
            h += '</tbody></table></div>';
            h += '<div class=evlSplit title="Drag to change the list height &middot; double-click to reset" onpointerdown="return pluginHandler.eventlog.elGripDown(event,\'evlVList\')" ondblclick="return pluginHandler.eventlog.elGripReset()"></div>';
            if (selRep == null && frows.length) { selRep = frows[0]; st.selected = selRep.ev.key; }
            h += '<div class=evlDetails id=evlDetails>';
            // a cited occurrence further down a folded group is shown with its own record (aiOccOf)
            var occ = selRep ? ph.aiOccOf(selRep) : null, dev = (selRep && occ) ? occ.ev : (selRep ? selRep.ev : null);
            if (selRep) {
                h += '<div class=evlDTabs>' +
                     '<button class="' + (st.dtab == 'general' ? 'on' : '') + '" onclick="return pluginHandler.eventlog.elSetDTab(\'general\')">General</button>' +
                     '<button class="' + (st.dtab == 'json' ? 'on' : '') + '" onclick="return pluginHandler.eventlog.elSetDTab(\'json\')">Details (JSON)</button><span class=sp></span>' +
                     ph.aiExplainBtn(dev).replace('<button ', '<button style=margin:4px ') +
                     (ph.byKey[dev.key] ? '<button class="evlBtn mini" style=margin:4px title="' + (st.dtab == 'json' ? 'Copy the JSON shown below' : 'Copy this event as text (log, source, date, ID, level, message)') + '" onclick="return pluginHandler.eventlog.elCopy(\'' + dev.key + '\',\'' + (st.dtab == 'json' ? 'json' : 'details') + '\',this)">Copy</button>' : '') +
                     '<button class="evlBtn mini" style=margin:4px onclick="return pluginHandler.eventlog.elFilterBy(\'source\',\'' + selRep.ev.key + '\')">Filter: this source</button>' +
                     '<button class="evlBtn mini" style=margin:4px onclick="return pluginHandler.eventlog.elFilterBy(\'id\',\'' + selRep.ev.key + '\')">Filter: ID ' + esc(dev.id) + '</button></div>' +
                     (occ ? ph.aiOccBarHtml(selRep, occ) : '');
                if (st.dtab == 'json') {
                    h += '<pre class=evlRaw style="margin:10px 13px">' + esc(JSON.stringify(ph.elRawOf(dev), null, 2)) + '</pre>';
                } else {
                    var exH = ph.aiExplainHtml(dev);   // the explanation sits beside the details
                    h += '<div class="evlDBody' + (exH ? ' evlDBodyEx' : '') + '">' + (exH ? '<div>' : '') + '<div class=evlMsgFull>' + esc(dev.message) + '</div><dl class=evlKv>' +
                         '<dt>' + ph.elLbl('log') + '</dt><dd>' + esc(dev.log) + '</dd><dt>Source</dt><dd title="' + esc(dev.source) + '">' + esc(dev.source) + '</dd>' +
                         '<dt>' + ph.elLbl('id') + '</dt><dd class=evlMono>' + esc(dev.id) + '</dd><dt>Level</dt><dd>' + esc(dev.levelName) + ' (' + dev.level + ')</dd>' +
                         (dev.unit ? '<dt>Unit</dt><dd title="' + esc(dev.unit) + '">' + esc(dev.unit) + '</dd>' : '') +
                         (dev.pri != null ? '<dt>Priority</dt><dd>' + esc(ph.elPriName(dev.pri)) + ' (' + dev.pri + ')</dd>' : '') +
                         '<dt>Recorded</dt><dd class=evlMono>' + ph.elFmtTime(dev.time) + '</dd>' +
                         (selRep.count > 1 ? '<dt>Seen</dt><dd class=evlOccDd>' + selRep.count + '&times; &mdash; ' + ph.aiOccTimesHtml(selRep, 6, ', ', occ) + '</dd>' : '') +
                         '</dl>' + (exH ? '</div><div>' + exH + '</div>' : '') + '</div>';
                }
            } else { h += '<div class=evlEmpty>Select an event to see its details.</div>'; }
            h += '</div></div></div>';
        } else {
            h += '<div class="evlScroll' + dens + '" id=evlScroll' + hstyle + '><table class=evlLog><thead><tr>' + gutTh +
                 sortTh('level', 'Level') + sortTh('time', 'Time') + sortTh('log', ph.elLbl('log')) + sortTh('source', 'Source') + sortTh('id', ph.elLbl('id')) + sortTh('message', 'Message') +
                 '</tr></thead><tbody>';
            frows.forEach(function(r) { h += rowHtml(r, 'ledger'); });
            if (!frows.length) h += '<tr><td colspan=' + (gut ? 7 : 6) + '><div class=evlEmpty>' + ph.elEmptyText() + '</div></td></tr>';
            h += '</tbody></table></div>';
            h += '<div class=evlGrip title="Drag to change the table height &middot; double-click to reset" onpointerdown="return pluginHandler.eventlog.elGripDown(event,\'evlScroll\')" ondblclick="return pluginHandler.eventlog.elGripReset()"></div>';
        }
        QH('evlBody', h);
        ph.aiApplySel();
        ph.elFitHeight();
    };

    obj.elEmptyText = function() {
        var st = pluginHandler.eventlog.elState();
        if (st.view == 'history') {
            if (st.hist.loading) return 'Loading history&hellip;';
            if (st.hist.recIds != null && st.hist.recIds.length) return 'None of the cited events is stored any more. Retention may have removed them. Clear the &quot;Cited by the assistant&quot; filter to see the history again.';
            if (st.hist.enabled === false) return 'History collection is disabled for this device. Enable it in the plugin administration (Config Sets).';
            if (st.hist.stored == 0) return 'No events stored yet. The agent sends collected events about once a minute once its core is loaded &mdash; use &quot;Collect now&quot; below, or check back shortly.';
            return 'No events match the current filters. Adjust the filters above or reset them.';
        }
        if (st._total == 0) return 'Waiting for events from the device&hellip;';
        return 'No events match the current filters. Adjust the filters above or reset them.';
    };

    obj.elRenderDetailHtml = function(r) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var esc = EscapeHtml, occ = ph.aiOccOf(r), ev = occ ? occ.ev : r.ev;   // a cited occurrence further down the group
        var h = (occ ? ph.aiOccBarHtml(r, occ) : '') + '<div class=evlMsgFull>' + esc(ev.message) + '</div>';
        h += '<div class=evlMeta><span>' + ph.elLbl('log') + ' <b>' + esc(ev.log) + '</b></span><span>Source <b>' + esc(ev.source) + '</b></span>' +
             '<span>' + ph.elLbl('id') + ' <b class=evlMono>' + esc(ev.id) + '</b></span><span>Level <b>' + esc(ev.levelName) + ' (' + ev.level + ')</b></span>' +
             (ev.unit ? '<span>Unit <b>' + esc(ev.unit) + '</b></span>' : '') +
             (ev.pri != null ? '<span>Priority <b>' + esc(ph.elPriName(ev.pri)) + ' (' + ev.pri + ')</b></span>' : '') +
             '<span>Recorded <b class=evlMono>' + ph.elFmtTime(ev.time) + '</b></span></div>';
        if (r.count > 1) {
            h += '<div class=evlMeta><span>Occurrences (' + r.count + ')</span><span class="evlMono evlOccDd">' + ph.aiOccTimesHtml(r, 12, ' &middot; ', occ) + '</span></div>';
        }
        h += '<div class=evlActs>' +
             (ph.byKey[ev.key] ? '<button class="evlBtn mini" title="Copy this event as text (log, source, date, ID, level, message)" onclick="return pluginHandler.eventlog.elCopy(\'' + ev.key + '\',\'details\',this)">Copy details</button>' +
             '<button class="evlBtn mini" title="Copy only the message text" onclick="return pluginHandler.eventlog.elCopy(\'' + ev.key + '\',\'message\',this)">Copy message</button>' : '') +
             '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.elFilterBy(\'source\',\'' + ev.key + '\')">Filter: this source</button>' +
             '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.elFilterBy(\'id\',\'' + ev.key + '\')">Filter: ID ' + esc(ev.id) + '</button>' +
             '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.elToggleRaw(\'' + ev.key + '\')">' + (st.raw[ev.key] ? 'Hide' : 'Show') + ' raw JSON</button>' +
             ph.aiExplainBtn(ev) + '</div>';
        if (st.raw[ev.key]) {
            h += '<pre class=evlRaw>' + esc(JSON.stringify(ph.elRawOf(ev), null, 2)) + '</pre>';
        }
        h += ph.aiExplainHtml(ev);
        return h;
    };

    obj.elRenderStatus = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (!Q('evlStatus')) return;
        var h = '';
        if (st.view == 'ai') { QH('evlStatus', ''); return; }
        if (st.view == 'live') {
            if (ph.livelog == null) h += '<span class=warn>&#9679; Agent not connected &mdash; live view resumes when it reconnects</span>';
            else if (st.paused) h += '<span class=warn>&#10074;&#10074; Paused' + (st.pending.length ? ' &middot; ' + st.pending.length + ' new buffered' : '') + '</span>';
            else h += '<span class=live>&#9679; Live &middot; auto-refresh every 30 s</span>';
            h += '<span>Showing ' + (st._visible || 0) + ' of ' + (st._matching || 0) + (st.fold ? ' folded rows' : ' rows') + ' &middot; ' + st._total + ' events loaded' + (st._total - st._shown > 0 ? ' &middot; ' + (st._total - st._shown) + ' hidden by filters' : '') + '</span>';
            if (st.live.last) h += '<span>Last update <span class=evlMono>' + st.live.last.toLocaleTimeString() + '</span></span>';
        } else {
            h += '<span>History</span>';
            if (st.hist.loading) h += '<span>Loading&hellip;</span>';
            h += '<span>Showing ' + (st.fold ? ((st._visible || 0) + ' folded rows (' + st._shown + ' events)') : st._shown) + ' of ' + st.hist.total + ' in range &middot; ' + st.hist.stored + ' stored total' + (st.hist.retentionDays ? ' &middot; retention ' + st.hist.retentionDays + ' days' : '') + '</span>';
            h += '<span>Last collected: <span class=evlMono>' + (st.hist.lastCollected ? ph.elFmtTime(st.hist.lastCollected) : 'never') + '</span></span>';
            var histEnd = (st.hist.base || 0) + st.hist.events.length;   // base > 0 after a jump to a cited event
            if (histEnd < st.hist.total) h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.elLoadMore()">Load ' + Math.min(st.show, st.hist.total - histEnd) + ' more</button>';
            h += '<button class="evlBtn mini" onclick="return pluginHandler.eventlog.elCollectNow()">Collect now</button>';
            if (st.collectMsg) h += '<span>' + st.collectMsg + '</span>';
        }
        if (st.os == 'linux' && st.meta && st.meta.caps) {
            if (st.meta.caps.journalctl === false) h += '<span class=warn>systemd-journald not found on this device &mdash; flat-file /var/log support arrives in a later plugin version</span>';
            else if (st.meta.caps.persistent === false) h += '<span title="The journal is stored in memory only (/run/log/journal). Events collected into the server database are unaffected.">Volatile journal: the endpoint keeps logs since its last boot only</span>';
        }
        var parts = [];
        if (Object.keys(st.cols[st.layout] || {}).length > 0) parts.push('column widths');
        if (st.heights[st.layout]) parts.push('table height');
        if (st.layout == 'viewer' && st.sideW) parts.push('sidebar width');
        if (parts.length) h += '<span class=evlLink title="Back to the automatic sizes" onclick="return pluginHandler.eventlog.elResetSizes()">Reset ' + (parts.length > 2 ? 'sizes' : parts.join(' &amp; ')) + '</span>';
        QH('evlStatus', h);
        ph.elFitHeight();
    };

    // ---- interactions ----
    obj.elSetView = function(v) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (v != 'live' && v != 'history') return false;
        if (!ph.elCan(v)) return false;
        st.view = v;
        st.ai.notice = null; st.ai.peek = null;
        if (v == 'history' && !st.hist.loaded && !st.hist.loading) ph.elLoadHistory(true);
        ph.elRenderShell();
        return false;
    };
    obj.elSetLayout = function(l) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.layout = l; putstore('evl_layout', l);
        ph.elRenderShell();
        return false;
    };
    obj.elToggleFold = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.fold = !st.fold; putstore('evl_fold', st.fold ? '1' : '0');
        var b = Q('evlFoldBtn'); if (b) b.classList.toggle('on', st.fold);
        if (st.view == 'live' && st.fold) ph.elRequestLive(null);
        ph.elUpdate();
        if (st.view == 'history' && st.fold) ph.elHistAutoFill();
        return false;
    };
    obj.elSetShow = function(n) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.show = Number(n) || 100; putstore('evl_show', String(st.show));
        st.hist.recIds = null;   // any filter change ends "Cited by the assistant"
        if (st.view == 'live') ph.elRequestLive(null);
        else ph.elLoadHistory(true);   // History: reload the first page with the new page size
        ph.elUpdate();
        return false;
    };
    obj.elSetRange = function(r) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.range = r; putstore('evl_range', r);
        st.hist.recIds = null;
        if (st.view == 'history') ph.elLoadHistory(true); else ph.elUpdate();
        return false;
    };
    // Linux view selector: in Live view the selection is pushed down to journalctl; in both views
    // it also drives the client-side Category filter so the table follows immediately.
    obj.elSelCat = function(v) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.lsel = v;
        var catMap = { kernel: 'Kernel', auth: 'Auth', audit: 'Audit' };
        if (catMap[v]) { st.filters.logs = {}; st.filters.logs[catMap[v]] = 1; } else { st.filters.logs = null; }
        if (st.view == 'live') ph.elRequestLive(null);
        ph.elUpdate();
        ph.elHistRefilter();
        return false;
    };
    obj.elSelLog = function(el) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (el.value == '_multi') return false;
        if (el.value == '') st.filters.logs = null; else { st.filters.logs = {}; st.filters.logs[el.value] = 1; }
        ph.elUpdate();
        ph.elHistRefilter();
        return false;
    };
    obj.elSelSource = function(el) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (el.value == '_multi') return false;
        if (el.value == '') st.filters.sources = null; else { st.filters.sources = {}; st.filters.sources[el.value] = 1; }
        ph.elUpdate();
        ph.elHistRefilter();
        return false;
    };
    obj.elToggleLevel = function(n) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (st.filters.levels == null) { st.filters.levels = {}; ph.elLevelInfo().forEach(function(li) { st.filters.levels[li.n] = 1; }); }
        if (st.filters.levels[n]) delete st.filters.levels[n]; else st.filters.levels[n] = 1;
        var all = true; ph.elLevelInfo().forEach(function(li) { if (!st.filters.levels[li.n]) all = false; });
        if (all) st.filters.levels = null;
        ph.elUpdate();
        ph.elHistRefilter();
        return false;
    };
    obj.elToggleFacet = function(kind, name) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var counts = ph.elCounts(ph.elFiltered());
        var universe = Object.keys(kind == 'logs' ? counts.log : counts.source);
        if (st.filters[kind] == null) { st.filters[kind] = {}; universe.forEach(function(n) { st.filters[kind][n] = 1; }); }
        if (st.filters[kind][name]) delete st.filters[kind][name]; else st.filters[kind][name] = 1;
        var all = true; universe.forEach(function(n) { if (!st.filters[kind][n]) all = false; });
        if (all) st.filters[kind] = null;
        ph.elUpdate();
        ph.elHistRefilter();
        return false;
    };
    obj.elFacetsMore = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.srcMore = !st.srcMore; ph.elUpdate();
        return false;
    };
    obj.elIdInput = function(el) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.filters.ids = el.value;
        if (st._deb) clearTimeout(st._deb);
        st._deb = setTimeout(function() { pluginHandler.eventlog.elUpdate(); pluginHandler.eventlog.elHistRefilter(); }, 200);
        return false;
    };
    obj.elTextInput = function(el) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.filters.text = el.value;
        if (st._deb) clearTimeout(st._deb);
        st._deb = setTimeout(function() { pluginHandler.eventlog.elUpdate(); pluginHandler.eventlog.elHistRefilter(); }, 200);
        return false;
    };
    obj.elClearFilter = function(kind) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (kind == 'recIds') { st.hist.recIds = null; ph.elLoadHistory(true); ph.elUpdate(); return false; }
        if (kind == 'ids' || kind == 'text') { st.filters[kind] = ''; var el = Q(kind == 'ids' ? 'evlIdIn' : 'evlTxtIn'); if (el) el.value = ''; }
        else st.filters[kind] = null;
        ph.elUpdate();
        ph.elHistRefilter();
        return false;
    };
    obj.elResetFilters = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.filters = { levels: null, logs: null, sources: null, ids: '', text: '' };
        var e1 = Q('evlIdIn'); if (e1) e1.value = '';
        var e2 = Q('evlTxtIn'); if (e2) e2.value = '';
        ph.elUpdate();
        ph.elHistRefilter();
        return false;
    };
    obj.elSetRows = function(v) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.rows = v; putstore('evl_rows', v);
        ph.elUpdate();
        return false;
    };

    // ---- column widths / heights ----
    // Default column widths: measured from the real fonts (level names and the locale's time format vary), cached.
    obj.elColDefault = function(key) {
        var ph = pluginHandler.eventlog;
        var fixed = { level: 110, time: 175, log: 110, source: 230, id: 80 };
        if (!ph._autoW) {
            var host = Q('pluginEventLog'); if (!host) return fixed[key];
            var m = document.createElement('div'); m.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0;';
            host.appendChild(m);
            var meas = function(html) { m.innerHTML = html; return m.firstChild ? m.firstChild.getBoundingClientRect().width : 0; };
            var lv = 0; ph.elLevelInfo().forEach(function(li) { lv = Math.max(lv, meas('<span class="evlLv ' + li.cls + '"><i></i>' + li.name + '</span>')); });
            var tm = meas('<span class=evlMono>' + ph.elFmtTime(new Date(2026, 11, 28, 22, 58, 58).getTime()) + '</span>');
            var id = meas('<span class=evlMono>88888</span>');
            host.removeChild(m);
            if (!(lv > 0 && tm > 0)) return fixed[key];   // tab not visible yet: use the fallbacks, measure again next render
            ph._autoW = { level: Math.ceil(lv) + 20, time: Math.ceil(tm) + 20, id: Math.max(fixed.id, Math.ceil(id) + 20) };
        }
        return ph._autoW[key] || fixed[key];
    };
    obj.elColW = function(key) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (key == 'message') return 0;
        var u = st.cols[st.layout] && st.cols[st.layout][key];
        return (u > 0) ? u : ph.elColDefault(key);
    };
    obj.elSaveCols = function() {
        var st = pluginHandler.eventlog.elState();
        putstore('evl_cols_' + st.layout, JSON.stringify(st.cols[st.layout] || {}));
    };
    obj.elSetColW = function(key, w) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (!st.cols[st.layout]) st.cols[st.layout] = {};
        st.cols[st.layout][key] = w;
        ph.elSaveCols();
    };
    obj.elRzDown = function(ev, key) {
        var ph = pluginHandler.eventlog;
        var hd = ev.currentTarget || ev.target, th = hd.parentNode, sc = th.closest('.evlScroll, .evlVList');
        if (!th || !sc) return false;
        ev.preventDefault(); ev.stopPropagation();
        try { hd.setPointerCapture(ev.pointerId); } catch (e) { }
        hd.classList.add('active'); sc.classList.add('evlResizing');
        var guide = document.createElement('div'); guide.className = 'evlGuide'; guide.innerHTML = '<span></span>'; sc.appendChild(guide);
        var x0 = ev.clientX, w0 = th.getBoundingClientRect().width, w = 0;
        var mv = function(e) {
            w = Math.max(40, Math.round(w0 + e.clientX - x0));
            th.style.width = w + 'px';
            var r = sc.getBoundingClientRect(), t = th.getBoundingClientRect();
            guide.style.left = (t.right - r.left + sc.scrollLeft) + 'px'; guide.style.top = sc.scrollTop + 'px'; guide.style.height = sc.clientHeight + 'px';
            guide.firstChild.textContent = w + ' px';
        };
        var up = function() {
            hd.removeEventListener('pointermove', mv); hd.removeEventListener('pointerup', up); hd.removeEventListener('pointercancel', up);
            hd.classList.remove('active'); sc.classList.remove('evlResizing');
            if (guide.parentNode) guide.parentNode.removeChild(guide);
            ph._rzUntil = Date.now() + 400;   // swallow the click that follows the drag (would sort the column)
            if (w) { ph.elSetColW(key, w); ph.elRenderStatus(); }
        };
        hd.addEventListener('pointermove', mv); hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
        return false;
    };
    // double-click on a handle: fit the column to its widest cell (capped at 60% of the table)
    obj.elRzFit = function(ev, key) {
        var ph = pluginHandler.eventlog;
        var hd = ev.currentTarget || ev.target, th = hd.parentNode, sc = th.closest('.evlScroll, .evlVList'), tbl = th.closest('table');
        ev.preventDefault(); ev.stopPropagation();
        if (!th || !sc || !tbl) return false;
        var idx = th.cellIndex, w = th.scrollWidth + 2;
        var rows = tbl.tBodies[0] ? tbl.tBodies[0].rows : [];
        for (var i = 0; i < rows.length; i++) { if (rows[i].className.indexOf('evlExpand') >= 0) continue; var c = rows[i].cells[idx]; if (c) w = Math.max(w, c.scrollWidth + 2); }
        w = Math.max(40, Math.min(w, Math.round(sc.clientWidth * 0.6)));
        th.style.width = w + 'px';
        ph._rzUntil = Date.now() + 400;
        ph.elSetColW(key, w); ph.elRenderStatus();
        return false;
    };
    obj.elGripDown = function(ev, targetId) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var g = ev.currentTarget || ev.target, t = Q(targetId);
        if (!t) return false;
        ev.preventDefault();
        try { g.setPointerCapture(ev.pointerId); } catch (e) { }
        g.classList.add('active');
        var y0 = ev.clientY, h0 = t.getBoundingClientRect().height, hh = 0, cap = ph.elFitAvail() || 1e6;
        var mv = function(e) { hh = Math.min(cap, Math.max(90, Math.round(h0 + e.clientY - y0))); t.style.height = hh + 'px'; t.style.maxHeight = 'none'; t.style.minHeight = '0'; };
        var up = function() {
            g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
            g.classList.remove('active');
            if (hh) { st.heights[st.layout] = hh; putstore('evl_h_' + st.layout, String(hh)); ph.elRenderStatus(); }
        };
        g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
        return false;
    };
    // Height (px) the table can take so that everything below it (details, status line) still fits in the
    // window. 0 = unknown (tab hidden).
    obj.elFitAvail = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var t = Q(st.layout == 'viewer' ? 'evlVList' : 'evlScroll'), wrap = Q('evlWrap');
        if (!t || !wrap || !t.offsetParent) return 0;
        var r = t.getBoundingClientRect(), vb = ph.elViewBox();
        var top = r.top + vb.scroll, bottom = vb.bottom;   // measured from where the table sits when the page is scrolled to the top
        // only what sits below the table in its own column (grip, details pane, status line) counts: the Ask panel,
        // stacked below on narrow screens, must not shrink the table (that would feed back into the layout)
        var body = Q('evlBody'), stl = Q('evlStatus');
        var below = (body ? Math.max(0, body.getBoundingClientRect().bottom - r.bottom) : 0) + (stl ? stl.getBoundingClientRect().height : 0);
        return Math.max(90, Math.floor(bottom - top - below - 6));
    };
    // The visible part of the page that holds the tab: top/bottom in viewport px and how far it is scrolled. MeshCentral
    // scrolls either the window or an ancestor with overflow:auto. Shared by the table fit and the Ask panel's height.
    // Besides a scrolling ancestor, a grid cell that clips (MeshCentral's full-window layout: #column_l is overflow:hidden
    // in a grid row between the tab bar and the footer) ends the visible part; its size never depends on the content.
    obj.elViewBox = function() {
        var wrap = Q('evlWrap'), sc = null, ck = null;
        for (var p = wrap ? wrap.parentNode : null; p && p.nodeType == 1 && p != document.body && p != document.documentElement; p = p.parentNode) {
            var cs = getComputedStyle(p), oy = cs.overflowY;
            if (oy == 'auto' || oy == 'scroll') { sc = p; break; }
            if (!ck && (oy == 'hidden' || oy == 'clip') && p.parentNode && p.parentNode.nodeType == 1) {
                var pd = getComputedStyle(p.parentNode).display;
                if (pd == 'grid' || pd == 'inline-grid' || pd == '-ms-grid') ck = p;
            }
        }
        var top = 0, bottom = window.innerHeight, scroll = sc ? sc.scrollTop : (window.pageYOffset || 0);
        if (sc) { var r = sc.getBoundingClientRect(); top = Math.max(0, r.top); bottom = Math.min(bottom, r.bottom); }
        if (ck) { var rk = ck.getBoundingClientRect(); top = Math.max(top, rk.top); bottom = Math.min(bottom, rk.bottom); scroll += ck.scrollTop; }
        return { top: top, bottom: bottom, scroll: scroll };
    };
    // Automatic height fills the window; a user-dragged height is kept but never grows past it.
    obj.elFitHeight = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var t = Q(st.layout == 'viewer' ? 'evlVList' : 'evlScroll'), avail = ph.elFitAvail();
        if (!t || !avail) return;
        var uh = st.heights[st.layout];
        if (uh) { t.style.height = Math.min(uh, avail) + 'px'; t.style.maxHeight = 'none'; t.style.minHeight = '0'; }
        else { t.style.height = ''; t.style.maxHeight = avail + 'px'; t.style.minHeight = (st.layout == 'ledger') ? Math.min(160, avail) + 'px' : ''; }
    };
    obj.elGripReset = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.heights[st.layout] = 0; putstore('evl_h_' + st.layout, '0');
        ph.elUpdate();
        return false;
    };
    obj.elResetSizes = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.cols[st.layout] = {}; putstore('evl_cols_' + st.layout, '');
        st.heights[st.layout] = 0; putstore('evl_h_' + st.layout, '0');
        if (st.layout == 'viewer') { st.sideW = 0; putstore('evl_side', '0'); }
        ph.elUpdate();
        return false;
    };
    obj.elVSplitDown = function(ev) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var g = ev.currentTarget || ev.target, v = Q('evlViewer'), side = Q('evlFacets');
        if (!v || !side) return false;
        ev.preventDefault();
        try { g.setPointerCapture(ev.pointerId); } catch (e) { }
        g.classList.add('active');
        var x0 = ev.clientX, w0 = side.getBoundingClientRect().width, ww = 0, max = Math.max(160, Math.round(v.getBoundingClientRect().width * 0.5));
        var mv = function(e) { ww = Math.min(max, Math.max(120, Math.round(w0 + e.clientX - x0))); v.style.setProperty('--evl-side', ww + 'px'); };
        var up = function() {
            g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
            g.classList.remove('active');
            if (ww) { st.sideW = ww; putstore('evl_side', String(ww)); ph.elRenderStatus(); }
        };
        g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
        return false;
    };
    obj.elVSplitReset = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.sideW = 0; putstore('evl_side', '0');
        ph.elUpdate();
        return false;
    };

    obj.elSetSort = function(k) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (ph._rzUntil && Date.now() < ph._rzUntil) return false;   // click right after a resize drag
        if (st.sort.key == k) st.sort.dir = -st.sort.dir;
        else { st.sort.key = k; st.sort.dir = (k == 'time') ? -1 : 1; }
        ph.elUpdate();
        return false;
    };
    obj.elRowClick = function(key) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (st.layout == 'viewer') { st.selected = key; }
        else { st.expanded[key] = !st.expanded[key]; }
        if (st.ai) st.ai.occ = null;   // a click on the row shows its own (top) event again
        ph.elUpdate();
        return false;
    };
    obj.elSetDTab = function(t) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.dtab = t; ph.elUpdate();
        return false;
    };
    // the (possibly folded) row currently displayed for an event key
    obj.elRowFor = function(key) {
        var ph = pluginHandler.eventlog, st = ph.elState(), ev = ph.byKey[key];
        if (!ev) return null;
        if (st.fold) { var rows = ph.elFold(ph.elFiltered().rows); for (var i = 0; i < rows.length; i++) { if (rows[i].ev.key == key) return rows[i]; } }
        return { ev: ev, count: 1, times: [ev.time] };
    };
    // plain-text rendition of an event, in the layout of Windows Event Viewer's "Copy Details as Text"
    obj.elDetailsText = function(key) {
        var ph = pluginHandler.eventlog, r = ph.elRowFor(key);
        if (!r) return '';
        var ev = r.ev, st = ph.elState(), lx = (st.os == 'linux'), pad = function(l) { return (l + '              ').substring(0, 15); };
        var t = pad((lx ? 'Category:' : 'Log Name:')) + ev.log + '\n' + pad('Source:') + ev.source + '\n' + pad('Date:') + ph.elFmtTime(ev.time) + '\n' +
                pad((lx ? 'PID:' : 'Event ID:')) + ev.id + '\n' + pad('Level:') + ev.levelName + ' (' + ev.level + ')' + '\n';
        if (ev.unit) t += pad('Unit:') + ev.unit + '\n';
        if (ev.pri != null) t += pad('Priority:') + ph.elPriName(ev.pri) + ' (' + ev.pri + ')' + '\n';
        if (r.count > 1) t += pad('Occurrences:') + r.count + ' (' + r.times.slice(0, 12).map(function(x) { return ph.elFmtTime(x); }).join(', ') + (r.times.length > 12 ? ', ...' : '') + ')\n';
        t += 'Description:\n' + ev.message;
        return t;
    };
    // what = 'details' (default) | 'json' | 'message'; btn (optional) flashes "Copied" for a moment
    obj.elCopy = function(key, what, btn) {
        var ph = pluginHandler.eventlog, ev = ph.byKey[key];
        if (!ev) return false;
        var txt;
        if (what == 'json') txt = JSON.stringify(ph.elRawOf(ev), null, 2);
        else if (what == 'message') txt = ev.message;
        else txt = ph.elDetailsText(key);
        var fallback = function() {
            var ta = document.createElement('textarea'); ta.value = txt; ta.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } catch (e2) { }
            document.body.removeChild(ta);
        };
        try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(fallback); else fallback(); } catch (e) { fallback(); }
        if (btn && btn.tagName) {
            var old = btn.innerHTML; btn.innerHTML = 'Copied &#10003;'; btn.classList.add('ok');
            setTimeout(function() { try { btn.innerHTML = old; btn.classList.remove('ok'); } catch (e) { } }, 1200);
        }
        return false;
    };
    obj.elToggleRaw = function(key) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.raw[key] = !st.raw[key]; ph.elUpdate();
        return false;
    };
    obj.elFilterBy = function(what, key) {
        var ph = pluginHandler.eventlog, st = ph.elState(), ev = ph.byKey[key];
        if (!ev) return false;
        if (what == 'source') { st.filters.sources = {}; st.filters.sources[ev.source] = 1; }
        if (what == 'id') { st.filters.ids = String(ev.id); var el = Q('evlIdIn'); if (el) el.value = st.filters.ids; }
        ph.elUpdate();
        ph.elHistRefilter();
        return false;
    };
    obj.elKeyNav = function(ev) {
        if (ev.key != 'ArrowDown' && ev.key != 'ArrowUp') return true;
        var ph = pluginHandler.eventlog, st = ph.elState();
        var fr = ph.elFiltered();
        var frows = st.fold ? ph.elFold(fr.rows) : fr.rows.map(function(e) { return { ev: e }; });
        var idx = -1;
        frows.forEach(function(r, i) { if (r.ev.key == st.selected) idx = i; });
        idx += (ev.key == 'ArrowDown') ? 1 : -1;
        if (idx < 0) idx = 0; if (idx >= frows.length) idx = frows.length - 1;
        if (frows[idx]) { st.selected = frows[idx].ev.key; ph.elUpdate(); var l = Q('evlVList'); if (l) l.focus(); }
        ev.preventDefault();
        return false;
    };

    obj.elExportCsv = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        var fr = ph.elFiltered();
        var q = function(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
        var lx = (st.os == 'linux');
        var lines = ['Level,Time,' + (lx ? 'Category' : 'Log') + ',Source,' + (lx ? 'PID' : 'EventId') + ',Message'];
        fr.rows.forEach(function(ev) {
            lines.push([q(ev.levelName), q(new Date(ev.time).toISOString()), q(ev.log), q(ev.source), q(ev.id), q(ev.message)].join(','));
        });
        var name = 'eventlog-' + ((typeof currentNode != 'undefined' && currentNode) ? String(currentNode.name).replace(/[^\w.-]+/g, '_') : 'device') + '-' + st.view + '.csv';
        try {
            var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = name;
            document.body.appendChild(a); a.click();
            setTimeout(function() { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1000);
        } catch (e) { }
        return false;
    };

    // ---- live data ----
    obj.elRequestLive = function(since) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        try {
            if (ph.livelog != null && ph.livelog.State == 3) {
                // when folding repeats, fetch a larger batch so that N distinct rows can be shown
                var cmd = { action: 'plugin', plugin: 'eventlog', pluginaction: 'getlivelogs', num: st.fold ? Math.min(1000, st.show * 4) : st.show };
                if (since != null) cmd.since = since;
                if (st.os == 'linux' && st.lsel) cmd.lsel = st.lsel;
                ph.livelog.sendText(cmd);
            }
        } catch (e) { }
        return false;
    };
    obj.elAutoTick = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        // The tab can be left without another gotoDevice() (back button, plugin tab switch), so the
        // timer is also where an orphaned tunnel gets cleaned up.
        if (!ph.elTabVisible()) { ph.elStopLive(); return; }
        if ((typeof document != 'undefined') && (document.hidden === true)) return; // browser tab in the background
        ph.elRequestAccess();   // permissions can change while the tab is open (onAccess stops Live when it is revoked)
        if (!ph.elCan('live')) return;
        if (st.paused) return;
        var newest = 0;
        st.live.events.forEach(function(ev) { if (ev.time > newest) newest = ev.time; });
        ph.elRequestLive(newest ? Math.floor(newest / 1000) : null);
    };
    obj.elRefresh = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (st.view == 'live') ph.elRequestLive(null);
        else if (st.view == 'history') ph.elLoadHistory(true);
        return false;
    };
    obj.elTogglePause = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.paused = !st.paused;
        if (!st.paused && st.pending.length) {
            st.pending.forEach(function(ev) { st.live.events.push(ev); });
            st.pending = [];
        }
        var b = Q('evlPauseBtn');
        if (b) { b.innerHTML = st.paused ? '&#9654;' : '&#10074;&#10074;'; b.title = st.paused ? 'Resume live updates' : 'Pause live updates'; }
        ph.elUpdate();
        return false;
    };

    // ---- history data ----
    // aroundId (optional): load the page that contains this stored event (jump to a citation)
    obj.elLoadHistory = function(reset, aroundId) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (!ph.elCan('history')) return false;
        if (typeof currentNode == 'undefined' || currentNode == null) return false;
        if (reset === true) { st.hist.skip = 0; st.hist.base = 0; }
        st.hist.loading = true;
        var ranges = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
        var since = ranges[st.range] ? (Date.now() - ranges[st.range]) : null;
        var msg = { action: 'plugin', plugin: 'eventlog', pluginaction: 'getNodeHistory', nodeid: currentNode._id, meshid: currentNode.meshid, limit: st.show, skip: st.hist.skip, since: since };
        if (st.hist.recIds != null && st.hist.recIds.length) {
            msg.recIds = st.hist.recIds.slice(0, 200);   // exactly the events an answer cited, whatever the filters say
            msg.since = null;
        } else {
            // push the tab's filters into the server query so they cover all stored events, not just the loaded page
            var f = st.filters;
            if (f.levels != null) msg.levels = Object.keys(f.levels).map(Number);
            if (f.logs != null) msg.logs = Object.keys(f.logs);
            if (f.sources != null) msg.sources = Object.keys(f.sources);
            if (String(f.text || '').trim() != '') msg.text = String(f.text).trim();
            if (String(f.ids || '').trim() != '') msg.ids = String(f.ids).trim();
        }
        if (aroundId != null && typeof aroundId != 'object') msg.aroundId = String(aroundId);
        meshserver.send(msg);
        ph.elRenderStatus();
        return false;
    };
    // History filters run on the SERVER (the tab only holds one page): any filter change re-queries, debounced.
    obj.elHistRefilter = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (st.hist.recIds != null) { st.hist.recIds = null; if (st.view == 'history') ph.elUpdate(); }   // a filter change ends "Cited by the assistant"
        if (st.view != 'history') return false;
        if (st._refilterT) clearTimeout(st._refilterT);
        st._refilterT = setTimeout(function() { pluginHandler.eventlog.elLoadHistory(true); }, 250);
        return false;
    };
    // counts for chips/facets/dropdowns: in History the server reports range-wide counts
    // (the loaded page is only a slice); Live counts come from the loaded events.
    obj.elCounts = function(fr) {
        var st = pluginHandler.eventlog.elState();
        if (st.view == 'history' && st.hist.facets) return st.hist.facets;
        return fr.counts;
    };
    // With "Fold repeats" on, a page of N raw events can collapse into far fewer rows.
    // Keep fetching further pages until ~N folded rows are visible (bounded at 5000 loaded events).
    obj.elHistAutoFill = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (st.view != 'history' || !st.fold || st.hist.loading) return false;
        if ((st.hist.base || 0) + st.hist.events.length >= st.hist.total || st.hist.events.length >= 5000) return false;
        var folded = ph.elFold(ph.elFiltered().rows).length;
        if (folded >= st.show) return false;
        st.hist.skip = (st.hist.base || 0) + st.hist.events.length;
        ph.elLoadHistory(false);
        return true;
    };
    obj.elLoadMore = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        st.hist.skip = (st.hist.base || 0) + st.hist.events.length;
        ph.elLoadHistory(false);
        return false;
    };
    obj.elCollectNow = function() {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (!ph.elCan('history')) return false;
        if (typeof currentNode == 'undefined' || currentNode == null) return false;
        st.collectMsg = 'Requesting collection&hellip;';
        meshserver.send({ action: 'plugin', plugin: 'eventlog', pluginaction: 'collectNow', nodeid: currentNode._id, meshid: currentNode.meshid });
        ph.elRenderStatus();
        return false;
    };
    obj.onCollectNow = function(server, message) {
        var ph = pluginHandler.eventlog, st = ph.elState();
        if (message.ok) {
            st.collectMsg = 'Collection requested &mdash; reloading shortly&hellip;';
            setTimeout(function() { var s = pluginHandler.eventlog.elState(); if (s.view == 'history') pluginHandler.eventlog.elLoadHistory(true); }, 7000);
            setTimeout(function() { var s = pluginHandler.eventlog.elState(); s.collectMsg = null; if (s.view == 'history') pluginHandler.eventlog.elLoadHistory(true); }, 20000);
        } else {
            st.collectMsg = 'Device is not connected &mdash; collection runs when the agent is back online.';
        }
        ph.elRenderStatus();
    };
    obj.onLoadHistory = function(server, message) {
        var ph = pluginHandler.eventlog;
        if (!ph.elIsSupported()) return;
        // a reply for the previous device can still arrive after the user has switched away
        if ((message.nodeid != null) && (typeof currentNode != 'undefined') && (currentNode != null) && (message.nodeid != currentNode._id)) return;
        if (!ph.elEnsureShell()) return;
        var st = ph.elState();
        st.hist.loading = false; st.hist.loaded = true;
        if (message.meta) st.meta = message.meta;
        if (message.facets) st.hist.facets = message.facets;
        if (message.config) {
            st.cfg = message.config;   // the node's resolved config set (live category/source rules)
            st.hist.enabled = (message.config.historyEnabled !== false);
            if (message.config.retentionDays) st.hist.retentionDays = message.config.retentionDays;
        }
        st.hist.total = (message.total != null) ? message.total : (message.events ? message.events.length : 0);
        if (message.stored != null) st.hist.stored = message.stored;
        if (message.lastCollected != null) {
            var lc = message.lastCollected;
            st.hist.lastCollected = (typeof lc == 'string' || typeof lc == 'object') ? new Date(lc).getTime() : Number(lc);
        }
        var evs = message.events || [];
        // a page around a cited event replaces what is loaded; its offset becomes the base for "Load more"
        var around = (message.aroundId != null && !message.aroundMissing);
        if (!message.skip || around) st.hist.events = [];
        if (around) st.hist.base = Number(message.skip) || 0;
        else if (!message.skip) st.hist.base = 0;
        var prevCount = st.hist.events.length;
        for (var i in evs) {
            var n = ph.elNormalize(evs[i]);
            if (n == null) continue;
            ph.byKey[n.key] = n;
            var dup = false;
            if (message.skip && !around) { for (var j in st.hist.events) { if (st.hist.events[j].key == n.key) { dup = true; break; } } }
            if (!dup) st.hist.events.push(n);
        }
        ph.elUpdate();
        ph.aiAfterLoad(message);   // finish a jump to a cited event
        // only continue auto-filling folded pages while responses actually add events (loop guard)
        if (st.hist.events.length > prevCount && message.aroundId == null) ph.elHistAutoFill();
    };

    // ---- plumbing (tunnel to the agent) ----

    // called when a new plugin message is received on the front end
    obj.fe_on_message = function(server, message) {
      var ph = pluginHandler.eventlog;
      var data = JSON.parse(message);
      if (data.type == 'close') {
        if (ph.livelog) { ph.livelog.Stop(); ph.livelog = null; }
        return;
      }
      if (!ph.elEnsureShell()) return;
      var st = ph.elState();
      if (data.caps) st.meta = { os: data.os || st.os, caps: data.caps };
      var evs = data.data;
      if (evs == null) return;
      if (!Array.isArray(evs)) evs = [evs];
      var tgt = st.paused ? st.pending : st.live.events;
      var added = false;
      for (var i in evs) {
          var n = ph.elNormalize(evs[i]);
          if (n == null || n.log == '' && n.source == '') continue;
          if (!ph.elLiveAllowed(n)) continue;   // config set's Live include/exclude rules
          if (ph.byKey[n.key]) {
              // already known: skip if it is already in the live buffer
              var known = false;
              st.live.events.forEach(function(e) { if (e.key == n.key) known = true; });
              st.pending.forEach(function(e) { if (e.key == n.key) known = true; });
              if (known) continue;
          }
          ph.byKey[n.key] = n;
          tgt.push(n); added = true;
      }
      // cap the live buffer
      if (st.live.events.length > 2000) {
          st.live.events.sort(function(a, b) { return b.time - a.time; });
          st.live.events.length = 2000;
      }
      st.live.last = new Date();
      if (st.paused && added) ph.elRenderStatus(); else ph.elUpdate();
    };

    obj.onRemoteEventLogStateChange = function(xdata, state) {
        var ph = pluginHandler.eventlog;
        switch (state) {
            case 0:
                ph.elStopLive();
                ph.elRenderStatus();
                break;
            case 3:
                if (!ph.elTabVisible()) { ph.elStopLive(); return; }   // tab was left while the tunnel was still connecting
                ph.elEnsureShell();
                ph.elRequestLive(null);
                if (ph.autoTimer != null) { clearInterval(ph.autoTimer); }
                ph.autoTimer = setInterval(function() { try { pluginHandler.eventlog.elAutoTick(); } catch (e) { } }, 30000);
                break;
            default:
            break;
        }
    }

    obj.createRemoteEventLog = function(onEventLogUpdate) {
        var myobj = { protocol: 7 }; // we're a plugin
        myobj.onEventLogUpdate = onEventLogUpdate;
        myobj.xxStateChange = function(state) { }
        myobj.ProcessData = function(data) { onEventLogUpdate(null, data); }
        return myobj;
    }

    // True only when the Event Log tab is the plugin tab the user is actually looking at.
    // The live tunnel keeps an agent relay open and makes the endpoint run a collector every 30 s
    // (a PowerShell process on Windows), so it must not exist while the user is on the Desktop /
    // Terminal / Files tab or on another plugin's tab.
    obj.elTabVisible = function() {
        try {
            if ((typeof xxcurrentView != 'undefined') && (xxcurrentView != 19)) return false;   // 19 = the device Plugins panel
            var p = Q('p19');
            if ((p != null) && (p.style.display == 'none')) return false;
            var tab = Q('p19ph-pluginEventLog');
            if (tab == null) return false;
            if (tab.classList != null) return tab.classList.contains('on');
            return ((' ' + tab.className + ' ').indexOf(' on ') !== -1);
        } catch (e) { return false; }
    };

    obj.elStopLive = function() {
        var ph = pluginHandler.eventlog;
        if (ph.autoTimer != null) { clearInterval(ph.autoTimer); ph.autoTimer = null; }
        // clear the reference first: Stop() fires onStateChanged(0), which would otherwise stop it again
        var l = ph.livelog; ph.livelog = null;
        if (l != null) { try { l.Stop(); } catch (e) { } }
    };

    // Bring the tunnel in line with what is on screen. Safe to call repeatedly.
    obj.elEnsureLive = function() {
        var ph = pluginHandler.eventlog;
        if (!ph.elTabVisible()) { ph.elStopLive(); return; }
        if ((typeof currentNode == 'undefined') || (currentNode == null) || !ph.elIsSupported()) return;
        if (!ph.elEnsureShell()) return;
        ph.livelognode = currentNode;
        if (!ph.elCan('live')) {   // no permission for the Live view: never open the tunnel
            ph.elStopLive();
            var st1 = ph.elState();
            if (ph.elCan('history') && !st1.hist.loaded && !st1.hist.loading) ph.elLoadHistory(true);
            return;
        }
        if (!ph.livelognode.conn) { ph.elStopLive(); ph.elRenderStatus(); return; }   // agent offline
        if (ph.livelog == null) {
            ph.livelog = CreateAgentRedirect(meshserver, ph.createRemoteEventLog(ph.fe_on_message), serverPublicNamePort, authCookie, authRelayCookie, domainUrl);
            ph.livelog.attemptWebRTC = attemptWebRTC;
            ph.livelog.onStateChanged = ph.onRemoteEventLogStateChange;
            ph.livelog.onConsoleMessageChange = function () {
                if (pluginHandler.eventlog.livelog && pluginHandler.eventlog.livelog.consoleMessage) {
                    console.log('console message available. ', pluginHandler.eventlog.livelog.consoleMessage)
                }
            }
            ph.livelog.Start(ph.livelognode._id);
        }
        var st = ph.elState();
        if (!st.hist.loaded && !st.hist.loading) ph.elLoadHistory(true);   // first page of stored events
    };

    // Switching between plugin tabs does not go through gotoDevice(), so hook the switcher once.
    obj.elHookTabSwitch = function() {
        var ph = pluginHandler.eventlog;
        if (ph._cppWrapped === true) return;
        if ((typeof pluginHandler == 'undefined') || (typeof pluginHandler.callPluginPage != 'function')) return;
        ph._cppWrapped = true;
        var orig = pluginHandler.callPluginPage;
        pluginHandler.callPluginPage = function(id, el) {
            var r = orig.apply(this, arguments);
            try { setTimeout(function() { pluginHandler.eventlog.elEnsureLive(); }, 0); } catch (e) { }
            return r;
        };
    };

    // MeshCentral calls this hook at the top of go(), its panel switcher. The device Plugins panel
    // is opened with go(19) from the tab bar, which fires neither onDeviceRefreshEnd nor
    // callPluginPage - so without this, selecting the Event Log tab from another device tab would
    // never start the live view. It also stops the tunnel promptly when the user navigates away.
    obj.goPageStart = function(x, event) {
        // the panel has not been switched yet at this point, so decide once the stack unwinds
        setTimeout(function() { try { pluginHandler.eventlog.elEnsureLive(); } catch (e) { } }, 0);
    };

    obj.onDeviceRefreshEnd = function(nodeid, panel, refresh, event) {
      var ph = pluginHandler.eventlog;
      pluginHandler.registerPluginTab(ph.registerPluginTab());
      ph.elHookTabSwitch();
      if (typeof ph.livelog == 'undefined') { ph.livelog = null; }
      if (typeof ph.livelognode == 'undefined') { ph.livelognode = null; }
      var isSupported = ph.elIsSupported();   // Windows and Linux endpoints
      var sameNode = isSupported && (ph.livelognode != null) && (ph.livelognode._id == currentNode._id);
      // MeshCentral calls this hook on every gotoDevice() -- tab switches, node updates, connection state changes.
      // Only tear down the UI state when the node actually changed; otherwise keep the live connection
      // (stopping a still-connecting websocket logs an error) and keep the user's filters/data.
      if (!sameNode) {
          ph.elStopLive();
          ph.livelognode = null;
          if (ph.st != null && ph.st.ai != null) ph.aiStashSave();   // stop the Assistant's requests, keep its chats for a return visit
          ph.st = null;      // reset UI state for the new node
          ph.byKey = {};
      }
      if (!isSupported) { ph.elStopLive(); return; }
      ph.livelognode = currentNode;
      ph.elRequestAccess();   // every refresh (at most once per 5 s per device): a grant or a revoke takes effect without a page reload
      // the plugin tab DOM is rebuilt by MeshCentral on every refresh: re-create the shell (renders from state)
      ph.elEnsureShell();
      // MeshCentral restores the previously selected plugin tab right AFTER this hook returns, so the
      // "is our tab on screen?" decision has to wait for the current call stack to finish.
      setTimeout(function() { pluginHandler.eventlog.elEnsureLive(); }, 0);
    };

    // ------------------------------------------------------------------
    //  Server side
    // ------------------------------------------------------------------

    obj.hook_agentCoreIsStable = function(myparent, grandparent) {
        if (grandparent == null) { // detect old style call with single argument, backward compat, to be removed in the future.
            grandparent = myparent[1];
            myparent = myparent[0];
        }
        myparent.send(JSON.stringify({
            action: 'plugin',
            pluginaction: 'serviceCheck',
            plugin: 'eventlog',
            nodeid: myparent.dbNodeKey,
            rights: true,
            sessionid: true
        }));
        obj.db.getConfigFor(myparent.dbNodeKey, myparent.dbMeshKey)
        .then((cfgBlob) => {
            myparent.send(JSON.stringify({
                action: 'plugin',
                pluginaction: 'setConfigBlob',
                plugin: 'eventlog',
                nodeid: myparent.dbNodeKey,
                rights: true,
                sessionid: true,
                cfg: cfgBlob
            }));
        })
        .catch((e) => console.log('EVENTLOG: could not send the config to ' + myparent.dbNodeKey + ': ' + (e.message || e)));
    };

    // Called by MeshCentral for every message from every agent, so it returns at once unless the message is an
    // installed-software reply the Assistant asked for (ai/software.js checks the session id and the agent).
    obj.hook_processAgentData = function(command, agentObj, webserver) {
        if (command == null || command.action != 'software' || obj.ai == null) return;
        try { obj.ai.onAgentData(command, agentObj); } catch (e) { }
    };

    // Repair UTF-8 text that the agent decoded as Latin-1 (the PowerShell output file is UTF-8).
    obj.fixText = function(v) {
        if (typeof v != 'string' || !/[\u00C2-\u00F4][\u0080-\u00BF]/.test(v)) return v;
        try { return Buffer.from(v, 'latin1').toString('utf8'); } catch (e) { return v; }
    };
    obj.fixEvents = function(events) {
        var list = Array.isArray(events) ? events : [events];
        list.forEach(function(e) { if (e && typeof e == 'object') { e.Message = obj.fixText(e.Message); e.ProviderName = obj.fixText(e.ProviderName); e.LogName = obj.fixText(e.LogName); if (e.Unit != null) e.Unit = obj.fixText(e.Unit); } });
        return events;
    };

    // The node's resolved config set, cached per node. `uid` is the config version the agent holds;
    // a different uid (config saved in the admin page) or a 10-minute age refreshes it. Never rejects.
    obj.nodeConfig = function(nodeid, meshid, uid) {
        var c = obj._cfgCache[nodeid], now = Date.now();
        if (c != null && (uid == null || c.uid == uid) && (now - c.t) < 600000) return Promise.resolve(c.cfg);
        return obj.db.getConfigFor(nodeid, meshid)
        .then(function (cfg) { obj._cfgCache[nodeid] = { uid: (cfg != null) ? cfg.uid : uid, cfg: cfg, t: now }; return cfg; })
        .catch(function (e) { console.log('EVENTLOG: config lookup failed for ' + nodeid + ': ' + (e.message || e)); return (c != null) ? c.cfg : null; });
    };

    // True when the session belongs to a MeshCentral administrator (same test as the admin page itself, admin.js)
    obj.isPluginAdmin = function(myparent) {
        try { return (myparent != null && myparent.user != null && (myparent.user.siteadmin & 0xFFFFFFFF) != 0); } catch (e) { return false; }
    };

    // Config set History rules, applied to a batch as it arrives. Categories only mean something for
    // journald (on Windows LogName is the event log, which historyLogs already selects); sources
    // apply everywhere. Returns the events to store.
    obj.applyCollectionFilters = function(events, cfg, os) {
        if (cfg == null) return events;
        var cats = (os == 'linux') ? obj.elRules(cfg.historyCategories, cfg.historyCategoriesMode) : null;
        var srcs = obj.elRules(cfg.historySources, cfg.historySourcesMode);
        if (cats == null && srcs == null) return events;
        return events.filter(function (e) { return e != null && obj.elAllowed(cats, e.LogName) && obj.elAllowed(srcs, e.ProviderName); });
    };

    // ---- Alerts -------------------------------------------------------------------------------
    // Alert rules live in the config set (cfg.alerts), so they follow the same node / mesh
    // assignment as the collection rules. They are evaluated on the server against every batch as
    // it arrives - before the History include/exclude rules, so an event that is not stored can
    // still raise an alert. A firing rule dispatches a MeshCentral device event (etype 'node',
    // action 'eventlogalert'), which is stored in the device's Events list.
    obj.ALERT_MAX_EVENT_AGE_MS = 60 * 60 * 1000; // ignore events older than this: a fresh agent sends up to 24 h of backlog
    obj._alertHits = {};   // nodeid|ruleid -> [arrival ms, ...] of matches inside the rule's window
    obj._alertFired = {};  // nodeid|ruleid -> ms of the last alert (cooldown)

    // "1112, 100-199" -> matcher(value), or null when empty
    obj.alertIdMatcher = function(str) {
        var singles = {}, ranges = [], any = false;
        String(str == null ? '' : str).split(',').forEach(function (part) {
            part = part.trim(); if (part == '') return;
            var m = part.match(/^(\d+)\s*-\s*(\d+)$/);
            if (m) { var a = Number(m[1]), b = Number(m[2]); if (b >= a) { ranges.push([a, b]); any = true; } }
            else if (/^\d+$/.test(part)) { singles[String(Number(part))] = true; any = true; }
        });
        if (!any) return null;
        return function (id) {
            if (id == null || !/^\d+$/.test(String(id))) return false;
            var n = Number(id);
            if (singles[String(n)]) return true;
            for (var i = 0; i < ranges.length; i++) { if (n >= ranges[i][0] && n <= ranges[i][1]) return true; }
            return false;
        };
    };

    // compile one rule's filters once per batch. Empty filters match everything.
    obj.alertCompile = function(rule) {
        var levels = Array.isArray(rule.levels) ? rule.levels.map(Number).filter(function (n) { return !isNaN(n); }) : [];
        var text = (typeof rule.text == 'string' && rule.text.trim() != '') ? rule.text.trim().substring(0, 256).toLowerCase() : null;
        return {
            levels: levels.length ? levels : null,
            logs: obj.elRules(rule.logs, 'include'),
            sources: obj.elRules(rule.sources, 'include'),
            ids: obj.alertIdMatcher(rule.ids),
            text: text
        };
    };
    obj.alertMatches = function(c, e) {
        if (e == null || typeof e != 'object') return false;
        if (c.levels != null && c.levels.indexOf(Number(e.Level)) == -1) return false;
        if (!obj.elAllowed(c.logs, e.LogName)) return false;
        if (!obj.elAllowed(c.sources, e.ProviderName)) return false;
        if (c.ids != null && !c.ids(e.Id)) return false;
        if (c.text != null && String(e.Message == null ? '' : e.Message).toLowerCase().indexOf(c.text) == -1) return false;
        return true;
    };
    obj.alertEventTime = function(e) { // ms since epoch of the event, 0 when unknown
        var v = Array.isArray(e.TimeCreated) ? e.TimeCreated[0] : e.TimeCreated;
        var m = String(v).match(/\d+/);
        return m ? Number(m[0]) : 0;
    };

    // Evaluate the node's alert rules against a freshly received batch. Never throws.
    obj.evaluateAlerts = function(myparent, cfg, batch) {
        try {
            if (cfg == null || !Array.isArray(cfg.alerts) || cfg.alerts.length == 0 || !Array.isArray(batch)) return;
            var now = Date.now(), nodeid = myparent.dbNodeKey;
            var fresh = batch.filter(function (e) { // only recent events can alert
                if (e == null || typeof e != 'object') return false;
                var t = obj.alertEventTime(e);
                return (t == 0) || ((now - t) <= obj.ALERT_MAX_EVENT_AGE_MS);
            });
            if (fresh.length == 0) return;
            cfg.alerts.slice(0, 50).forEach(function (rule, idx) {
                if (rule == null || typeof rule != 'object' || rule.enabled === false) return;
                var c = obj.alertCompile(rule);
                var matches = fresh.filter(function (e) { return obj.alertMatches(c, e); });
                if (matches.length == 0) return;
                var key = nodeid + '|' + String(rule.id || ('r' + idx));
                var threshold = Math.floor(Number(rule.threshold)); if (!(threshold >= 1)) threshold = 1;
                var windowMin = Number(rule.windowMin); if (!(windowMin >= 1)) windowMin = 10;
                var cooldownMin = Number(rule.cooldownMin); if (isNaN(cooldownMin) || cooldownMin < 0) cooldownMin = 5;
                var hits = (obj._alertHits[key] || []).filter(function (t) { return (now - t) < windowMin * 60000; });
                for (var i = 0; i < matches.length; i++) hits.push(now);
                if (hits.length > 1000) hits = hits.slice(-1000);
                obj._alertHits[key] = hits;
                if (hits.length < threshold) return;
                var last = obj._alertFired[key];
                if (last != null && (now - last) < cooldownMin * 60000) return;
                obj._alertFired[key] = now;
                obj._alertHits[key] = [];
                obj.dispatchAlert(myparent, rule, matches, hits.length, windowMin, threshold);
            });
        } catch (e) { console.log('EVENTLOG: alert evaluation error: ' + (e.message || e)); }
    };

    obj.dispatchAlert = function(myparent, rule, matches, total, windowMin, threshold) {
        try {
            var last = matches[matches.length - 1];
            var oneLine = function (s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return (s.length > n) ? s.substring(0, n - 3) + '...' : s; };
            var name = oneLine(rule.name || 'Unnamed rule', 80);
            var msg = 'Event Log alert "' + name + '": ';
            msg += (threshold > 1) ? (total + ' matching events within ' + windowMin + ' min') : 'matching event';
            msg += ' - latest [' + oneLine(last.LogName, 40) + ' / ' + oneLine(last.ProviderName, 60) + ((last.Id != null && last.Id !== '') ? ' / ' + oneLine(last.Id, 20) : '') + '] ' + oneLine(last.Message, 200);
            var event = {
                etype: 'node', action: 'eventlogalert',
                nodeid: myparent.dbNodeKey, meshid: myparent.dbMeshKey, domain: myparent.domain.id,
                msg: msg, rule: name, count: total
            };
            obj.meshServer.DispatchEvent(['*', myparent.dbMeshKey, myparent.dbNodeKey], myparent, event);
        } catch (e) { console.log('EVENTLOG: could not dispatch the alert event: ' + (e.message || e)); }
    };

    // send a message to a connected agent, if possible. Returns true when sent.
    obj.sendToAgent = function(webserver, nodeid, message) {
        try {
            if (webserver == null || webserver.wsagents == null) return false;
            var agent = webserver.wsagents[nodeid];
            if (agent == null) return false;
            agent.send(JSON.stringify(message));
            return true;
        } catch (e) { return false; }
    };

    // Which plugin actions may come from where. Agent actions are only accepted from an agent connection;
    // device actions only from a user session, after the user's rights on that device are confirmed.
    obj.AGENT_ACTIONS = { sendlog: true, gatherlogs: true };
    obj.NODE_ACTIONS = { checkAccess: true, getNodeHistory: true, collectNow: true, aiStart: true, aiConfirm: true, aiSend: true, aiFeedback: true,
                         aiHistoryList: true, aiHistoryGet: true, aiHistoryDelete: true, aiChatEdit: true, aiFollowups: true };
    // Device actions that need a plugin permission, and device actions that need MeshCentral device rights on top.
    obj.ACTION_PERMISSION = { getNodeHistory: 'deviceHistoryTab', collectNow: 'deviceHistoryTab', aiStart: 'deviceAssistant', aiConfirm: 'deviceAssistant', aiSend: 'deviceAssistant', aiFeedback: 'deviceAssistant',
                              aiHistoryList: 'deviceAssistant', aiHistoryGet: 'deviceAssistant', aiHistoryDelete: 'deviceAssistant', aiChatEdit: 'deviceAssistant', aiFollowups: 'deviceAssistant' };
    obj.ACTION_RIGHTS = { aiStart: obj.MESHRIGHT_DEVICEDETAILS, aiConfirm: obj.MESHRIGHT_DEVICEDETAILS, aiSend: obj.MESHRIGHT_DEVICEDETAILS, aiFeedback: obj.MESHRIGHT_DEVICEDETAILS,
                          aiHistoryList: obj.MESHRIGHT_DEVICEDETAILS, aiHistoryGet: obj.MESHRIGHT_DEVICEDETAILS, aiHistoryDelete: obj.MESHRIGHT_DEVICEDETAILS, aiChatEdit: obj.MESHRIGHT_DEVICEDETAILS,
                          aiFollowups: obj.MESHRIGHT_DEVICEDETAILS };
    // Assistant actions authorized by conversation ownership inside ai/index.js (same user and connection), so Stop
    // and Close keep working after a permission was revoked; and the Assistant admin actions (full administrators).
    obj.AI_SESSION_ACTIONS = { aiStop: true, aiClose: true };
    obj.AI_ADMIN_ACTIONS = { aiAdminGet: true, aiAdminSaveEndpoint: true, aiAdminDeleteEndpoint: true, aiAdminSaveSettings: true, aiAdminTest: true, aiAdminModels: true, aiAdminAudit: true, aiAdminPreviewPrompt: true,
                              aiAdminHistoryStats: true, aiAdminHistoryPurge: true };
    // Every Assistant action is a user action; an agent connection never reaches one.
    obj.isAiAction = function(act) { return typeof act == 'string' && act.substring(0, 2) == 'ai'; };

    // Send to a browser session if it is still open. Never throws.
    obj.safeSend = function(myparent, o) {
        try {
            var ws = (myparent != null) ? myparent.ws : null;
            if (ws == null || (ws.readyState != null && ws.readyState !== 1)) return false;
            o.action = 'plugin'; o.plugin = 'eventlog';
            ws.send(JSON.stringify(o));
            return true;
        } catch (e) { return false; }
    };

    // One line per user, device and reason every 10 minutes, so "why can't X use the tab" can be read from the log.
    obj._deniedLogged = {};
    obj.logDenied = function(myparent, nodeid, action, reason) {
        try {
            var u = myparent.user, k = u._id + '|' + nodeid + '|' + reason, now = Date.now();
            if (obj._deniedLogged[k] != null && (now - obj._deniedLogged[k]) < 600000) return;
            obj._deniedLogged[k] = now;
            console.log('EVENTLOG: ' + action + ' refused for ' + (u.name || u._id) + ' on ' + nodeid + ': ' + reason);
        } catch (e) { }
    };
    obj.sendDenied = function(myparent, command, reason) {
        obj.logDenied(myparent, command.nodeid, command.pluginaction, reason);
        var msg = { method: 'onAccessDenied', nodeid: command.nodeid, act: command.pluginaction, reason: reason };
        // Assistant requests are matched by reqId / convId in the tab: echo them (short strings or numbers only)
        ['reqId', 'convId'].forEach(function (k) {
            var v = command[k];
            if ((typeof v == 'string' && v.length <= 64) || (typeof v == 'number' && isFinite(v))) msg[k] = v;
        });
        obj.safeSend(myparent, msg);
    };

    // What the Assistant offers this user on this device. Resolves to {assistant:false, assistantReason} until the
    // Assistant is configured; never rejects.
    // Users without the Assistant permission learn nothing more than 'permission'.
    obj.assistantAccess = function(myparent, node, rights) {
        var why = function(reason) {
            if (!obj.hasPerm(myparent && myparent.user, 'deviceAssistant', node)) return { assistant: false, assistantReason: 'permission' };
            var r = { assistant: false, assistantReason: reason };
            if (obj.isFullAdmin(myparent)) r.canManage = true;
            return r;
        };
        try {
            if (obj.ai != null && typeof obj.ai.accessInfo == 'function') {
                return Promise.resolve(obj.ai.accessInfo(myparent, node, rights)).catch(function (e) {
                    console.log('EVENTLOG AI: access check failed: ' + ((e && e.message) || e));
                    return why('error');
                });
            }
        } catch (e) { }
        return Promise.resolve(why('unavailable'));
    };
    // Tell the tab which views this user may use on this device.
    obj.sendAccess = function(myparent, node, rights) {
        var user = myparent.user;
        var msg = { method: 'onAccess', nodeid: node._id, live: obj.hasPerm(user, 'deviceLiveTab', node), history: obj.hasPerm(user, 'deviceHistoryTab', node) };
        return obj.assistantAccess(myparent, node, rights).then(function (a) {
            for (var k in a) { if (k != 'method' && k != 'nodeid') msg[k] = a[k]; }
            obj.safeSend(myparent, msg);
        });
    };

    // Short strings / finite numbers only: these ids are echoed back to the tab.
    obj.aiId = function(v) {
        if (typeof v == 'string' && v.length <= 64) return v;
        if (typeof v == 'number' && isFinite(v)) return v;
        return null;
    };
    // Assistant device actions, after serveraction's checks (aiStart / aiConfirm / aiSend / aiFeedback carry the
    // device and rights it resolved in command._node / _rights; aiStop / aiClose are checked by conversation
    // ownership in ai/index.js). The conversation answers asynchronously; nothing here waits for it.
    obj.aiDeviceAction = function(command, myparent, grandparent) {
        var act = command.pluginaction;
        if (myparent == null || myparent.user == null) return;   // user sessions only
        if (obj.NODE_ACTIONS[act] && command._node == null) { obj.sendDenied(myparent, command, 'no rights on this device'); return; }
        if (obj.ai == null || typeof obj.ai.handle != 'function') {
            if (obj.AI_SESSION_ACTIONS[act]) return;   // nothing to stop or close
            obj.safeSend(myparent, { method: 'onAiError', nodeid: command.nodeid, reqId: obj.aiId(command.reqId), convId: obj.aiId(command.convId), code: 'unavailable', message: 'The Assistant is not available on this server', retryable: false });
            return;
        }
        try {
            var p = obj.ai.handle(command, myparent, grandparent);
            if (p != null && typeof p.catch == 'function') p.catch(function (e) { console.log('EVENTLOG AI: ' + act + ' failed: ' + ((e && e.message) || e)); });
        } catch (e) { console.log('EVENTLOG AI: ' + act + ' failed: ' + ((e && e.message) || e)); }
    };
    // Assistant admin page actions: full administrators only (other administrators manage everything else).
    obj.aiAdminAction = function(command, myparent) {
        if (myparent == null || myparent.user == null) return;   // user sessions only
        var reqId = obj.aiId(command.reqId);
        if (!obj.isFullAdmin(myparent)) {
            obj.safeSend(myparent, { method: 'aiAdminError', reqId: reqId, scope: 'access', error: 'Only full administrators can manage the Assistant.' });
            return;
        }
        if (obj.ai == null || obj.ai.admin == null || typeof obj.ai.admin.handle != 'function') {
            obj.safeSend(myparent, { method: 'aiAdminError', reqId: reqId, scope: 'unavailable', error: 'The Assistant is not available on this server (see the server log).' });
            return;
        }
        try { obj.ai.admin.handle(command, myparent); }
        catch (e) { console.log('EVENTLOG AI: ' + command.pluginaction + ' failed: ' + ((e && e.message) || e)); }
    };

    // Resolve the device and the user's rights on it from the database, never from what the browser sent:
    // a meshid supplied by the browser would let a user with rights on one device group pass the check for a
    // device in another group. Calls back (node, rights) with node == null when the user may not see the device.
    obj.resolveNodeRights = function(myparent, grandparent, nodeid, func) {
        var done = function (node, rights) { try { func(node, rights); } catch (e) { console.log('EVENTLOG: device action error: ' + ((e && e.message) || e)); } };
        try {
            if (typeof nodeid != 'string' || nodeid.length > 128 || grandparent == null) { done(null, 0); return; }
            if (typeof grandparent.GetNodeWithRights == 'function') {
                grandparent.GetNodeWithRights(myparent.domain, myparent.user, nodeid, function (node, rights, visible) {
                    done((node != null && visible && rights != 0) ? node : null, rights || 0);
                });
                return;
            }
            // older MeshCentral: look the device up ourselves and check rights against its real device group
            if (grandparent.db != null && typeof grandparent.db.Get == 'function' && typeof grandparent.GetNodeRights == 'function') {
                grandparent.db.Get(nodeid, function (err, nodes) {
                    if (err || nodes == null || nodes.length != 1 || nodes[0].meshid == null) { done(null, 0); return; }
                    var r = grandparent.GetNodeRights(myparent.user, nodes[0].meshid, nodeid);
                    done((r != 0) ? nodes[0] : null, r);
                });
                return;
            }
        } catch (e) { console.log('EVENTLOG: device rights check failed: ' + ((e && e.message) || e)); }
        done(null, 0);   // no way to check: refuse
    };

    // data was sent to server from the client. do something with it.
    obj.serveraction = function(command, myparent, grandparent) {
        if (command == null || myparent == null) return;
        var fromUser = (myparent.user != null);
        if (fromUser && obj.AGENT_ACTIONS[command.pluginaction]) return;   // a browser session cannot pose as an agent
        if (!fromUser && obj.NODE_ACTIONS[command.pluginaction]) return;   // device actions are user actions
        if (!fromUser && obj.isAiAction(command.pluginaction)) return;     // so is everything of the Assistant
        if (fromUser) { for (var f in command) { if (f.charAt(0) == '_') delete command[f]; } }   // '_' fields are set by the server only
        if (!fromUser || !obj.NODE_ACTIONS[command.pluginaction]) return obj._serveraction(command, myparent, grandparent);
        obj.resolveNodeRights(myparent, grandparent, command.nodeid, function (node, rights) {
            var act = command.pluginaction;
            if (node == null) { obj.sendDenied(myparent, command, 'no rights on this device'); return; }
            command.meshid = node.meshid;   // from now on, the device group is the one stored for the device
            command._node = node; command._rights = rights;
            if (act == 'checkAccess') { obj.sendAccess(myparent, node, rights); return; }
            var perm = obj.ACTION_PERMISSION[act];
            if (perm != null && !obj.hasPerm(myparent.user, perm, node)) { obj.sendDenied(myparent, command, 'missing permission ' + perm); return; }
            var need = obj.ACTION_RIGHTS[act];
            if (need != null && (rights >>> 0) !== 0xFFFFFFFF && (rights & need) == 0) { obj.sendDenied(myparent, command, 'missing device right 0x' + need.toString(16)); return; }
            obj._serveraction(command, myparent, grandparent);
        });
    };
    obj._serveraction = function(command, myparent, grandparent) {
      var myobj = {};
      myobj.parent = myparent;

      if (command.uid && myparent.user == null) { // agent only: check to see if config is valid/current, if not, send update
        // This runs for every agent message carrying a uid (once per node per minute). On a SQL
        // backend these promises reject while the database is unreachable, and an unhandled
        // rejection terminates the MeshCentral process - so every path here is caught.
        obj.db.checkConfigAuth(command.uid)
        .then((cnt) => {
          if (cnt != 0) return null;
          return obj.db.getConfigFor(myparent.dbNodeKey, myparent.dbMeshKey)
          .then((cfgBlob) => {
            myparent.send(JSON.stringify({
                action: 'plugin',
                pluginaction: 'setConfigBlob',
                plugin: 'eventlog',
                nodeid: myparent.dbNodeKey,
                rights: true,
                sessionid: true,
                cfg: cfgBlob
            }));
          });
        })
        .catch((e) => console.log('EVENTLOG: could not refresh the endpoint config: ' + (e.message || e)));
      }

      switch (command.pluginaction) {
        case 'aiStart': case 'aiConfirm': case 'aiSend': case 'aiFeedback':   // device rights + permission checked in serveraction
        case 'aiHistoryList': case 'aiHistoryGet': case 'aiHistoryDelete':     // the same, and scoped to this user in ai/index.js
        case 'aiChatEdit':                                                      // the same (edit / delete / retry of a message)
        case 'aiFollowups':                                                     // the same ("Suggest questions")
        case 'aiStop': case 'aiClose': {                                      // ownership checked in ai/index.js
            obj.aiDeviceAction(command, myparent, grandparent);
            break;
        }
        case 'aiAdminGet': case 'aiAdminSaveEndpoint': case 'aiAdminDeleteEndpoint': case 'aiAdminSaveSettings':
        case 'aiAdminTest': case 'aiAdminModels': case 'aiAdminAudit': case 'aiAdminPreviewPrompt':
        case 'aiAdminHistoryStats': case 'aiAdminHistoryPurge': {
            obj.aiAdminAction(command, myparent);
            break;
        }
        case 'sendlog': {
          command.method = 'fe_on_message';
          if (command.sessionid != null) {
              if (typeof command.sessionid != 'string') break;
              var splitsessionid = command.sessionid.split('/');
              // Check that we are in the same domain and the user has rights over this node.
              if ((splitsessionid[0] == 'user') && (splitsessionid[1] == myobj.parent.domain.id)) {
                  // See if the session is connected. If so, go ahead and send this message to the target node
                  var ws = grandparent.wssessions2[command.sessionid];
                  if (ws != null) {
                      command.nodeid = myparent.dbNodeKey; // Set the nodeid, required for responses.
                      delete command.sessionid;       // Remove the sessionid, since we are sending to that sessionid, so it's implyed.
                      try { ws.send(JSON.stringify(command)); } catch (ex) { }
                  }
              }
          }
          break;
        }
        case 'gatherlogs': { // submit logs to server db
            try {
                if (typeof command.data != 'string' || command.data.length > 8 * 1024 * 1024) { console.log('EVENTLOG: gatherlogs payload rejected (missing or > 8MB)'); break; }
                if (command.caps != null && typeof obj.meshServer.pluginHandler.eventlog_db.setNodeMeta == 'function') {
                    // remember the endpoint's log capabilities (journald present/persistent, files, ...) for the UI.
                    // Linux agents report this with every batch, i.e. once a minute per node, but it changes
                    // almost never - only write when it actually differs from what we last stored.
                    var meta = { os: command.os || null, caps: command.caps };
                    var metaKey = JSON.stringify(meta);
                    var metaNode = myparent.dbNodeKey;
                    if (obj._lastMeta[metaNode] !== metaKey) {
                        obj._lastMeta[metaNode] = metaKey;
                        var mp = obj.meshServer.pluginHandler.eventlog_db.setNodeMeta(metaNode, meta);
                        // drop the cache entry again if the write failed, or the endpoint's OS would
                        // stay unknown until it changes (History would then apply the Windows log
                        // filter to a Linux node and hide its Kernel/Auth categories)
                        if (mp != null && typeof mp.catch == 'function') {
                            mp.catch(function (e) {
                                delete obj._lastMeta[metaNode];
                                console.log('EVENTLOG: setNodeMeta error: ' + (e.message || e));
                            });
                        }
                    }
                }
                var batch = obj.fixEvents(JSON.parse(command.data));
                if (!Array.isArray(batch)) batch = [batch];
                // The ack value is the newest event time of the batch AS RECEIVED - before the config
                // set's include/exclude rules drop anything - so the agent moves past dropped events too.
                // (Reading the node's newest stored event instead meant a sort over everything that node
                // had ever collected, once per node per minute.)
                var batchMaxTc = 0;
                batch.forEach(function (e) { var m = (e != null) ? String(e.TimeCreated).match(/\d+/) : null; if (m && Number(m[0]) > batchMaxTc) batchMaxTc = Number(m[0]); });
                obj.nodeConfig(myparent.dbNodeKey, myparent.dbMeshKey, command.uid)
                .then(function (cfg) {
                    obj.evaluateAlerts(myparent, cfg, batch);   // before the History rules drop anything
                    return obj.meshServer.pluginHandler.eventlog_db.addEventsFor(myparent.dbNodeKey, obj.applyCollectionFilters(batch, cfg, command.os));
                })
                .then(function (res) {
                    if (res == null || !(batchMaxTc > 0)) return; // nothing received: leave the agent's position alone
                    res = { count: res.count, maxTc: batchMaxTc };
                    // Two collection runs can be in flight at once (a "Collect now" while the agent's
                    // one-minute timer run is still going). If the older batch's acknowledgement were
                    // to land last, the agent would rewind its position - or its journal cursor - and
                    // re-send events that are already stored, duplicating them. Never acknowledge a
                    // position earlier than one already sent for this node. An equal position is still
                    // acknowledged, so a lost ack is simply repeated rather than stalling collection.
                    var prevAck = obj._lastAck[myparent.dbNodeKey];
                    if (prevAck != null && res.maxTc < prevAck) return;
                    obj._lastAck[myparent.dbNodeKey] = res.maxTc;
                    // send a message to the endpoint verifying receipt
                    var ack = {
                        action: 'plugin',
                        pluginaction: 'setLVDOC',
                        plugin: 'eventlog',
                        nodeid: myparent.dbNodeKey,
                        rights: true,
                        sessionid: true,
                        value: String(res.maxTc)    // ms since epoch, as the agent expects
                    };
                    if (command.os == 'linux' && command.cursor != null) ack.cursor = command.cursor; // echo: the agent commits this journal cursor
                    myparent.send(JSON.stringify(ack));
                })
                .catch(function (e) { console.log('EVENTLOG: error storing collected events: ' + e); });
              } catch (e) { console.log('Error gathering logs: ', e.stack); }
            break;
        }
        case 'getNodeHistory': {
            try {
                // make sure the agent-side module is loaded so the periodic collector runs
                obj.sendToAgent(grandparent, command.nodeid, { action: 'plugin', plugin: 'eventlog', pluginaction: 'serviceCheck', nodeid: command.nodeid, rights: true, sessionid: true });
                var q = {
                    limit: Math.min(Math.max(Number(command.limit) || 250, 1), 1000),
                    skip: Math.max(Number(command.skip) || 0, 0),
                    since: (command.since != null) ? Number(command.since) : null,
                    // user filters from the tab; sanitized in the db layer (normParams)
                    levels: command.levels, logs: command.logs, sources: command.sources,
                    text: command.text, ids: command.ids
                };
                // recIds: exactly these stored events (<= 200 ids); aroundId: the page that holds this event
                var recIds = Array.isArray(command.recIds)
                    ? command.recIds.filter(function (id) { return typeof id == 'string' && id.length > 0 && id.length <= 64; }).slice(0, 200)
                    : null;
                var aroundId = (recIds == null && typeof command.aroundId == 'string' && command.aroundId.length > 0 && command.aroundId.length <= 64) ? command.aroundId : null;
                var withMeta = function(meta) {
                  obj.db.getConfigFor(command.nodeid, command.meshid)
                  .catch(function (e) { console.log('EVENTLOG: getNodeHistory config lookup failed: ' + (e.message || e)); return null; })
                  .then((cfg) => {
                    var opts = cfg || {};
                    if (meta && meta.os == 'linux' && opts.historyLogs != null) {
                        // the config's historyLogs are Windows log names; on Linux they would hide
                        // stored categories (Kernel, Auth, ...) from the query
                        opts = Object.assign({}, opts); delete opts.historyLogs;
                    }
                    var reply = function(events, total, extra) {
                      // stored/lastCollected describe the node as a whole, not the page: only the first
                      // page needs them (the tab keeps the previous values for paged loads).
                      var withStats = function(stats) {
                        obj.db.getFacetsFor(command.nodeid, q.since, function(facets) {
                            if (myobj.parent.ws == null) return;
                            var msg = {
                                action: 'plugin', plugin: 'eventlog', method: 'onLoadHistory',
                                nodeid: command.nodeid,      // the tab drops replies for a device it has moved away from
                                events: events || [], total: total || 0, skip: q.skip,
                                config: cfg, meta: meta || null, facets: facets || null
                            };
                            if (stats != null) { msg.stored = stats.count; msg.lastCollected = stats.last; }
                            for (var xk in (extra || {})) msg[xk] = extra[xk];
                            try { myobj.parent.ws.send(JSON.stringify(msg)); } catch (e) { }
                        });
                      };
                      if (q.skip == 0) obj.db.getStatsFor(command.nodeid, withStats); else withStats(null);
                    };
                    if (recIds != null) {
                        // exactly these events (an Assistant answer's "open these events in History"), newest first
                        if (opts.historyEnabled === false || recIds.length == 0 || typeof obj.db.getEventsByIds != 'function') { reply([], 0, { recIds: recIds }); return; }
                        q.skip = 0;
                        obj.db.getEventsByIds(command.nodeid, recIds, function (events) {
                            var list = (Array.isArray(events) ? events : []).filter(function (e) { return e != null && e.nodeid == command.nodeid; });
                            list.sort(function (a, b) { return (Number(b.tc) - Number(a.tc)) || (String(b._id) < String(a._id) ? -1 : (String(b._id) > String(a._id) ? 1 : 0)); });
                            reply(list, list.length, { recIds: recIds });
                        });
                        return;
                    }
                    var page = function(extra) {
                        obj.db.getEventsFor(command.nodeid, opts, q, function(events, total) { reply(events, total, extra); });
                    };
                    if (aroundId == null || typeof obj.db.getEventsByIds != 'function') { page(aroundId != null ? { aroundId: aroundId, aroundMissing: true } : null); return; }
                    // the page (under the same filters) that holds this event: a cited event that is not loaded yet
                    obj.db.getEventsByIds(command.nodeid, [aroundId], function (found) {
                        var ev = (Array.isArray(found) ? found : []).filter(function (e) { return e != null && String(e._id) === aroundId && e.nodeid == command.nodeid; })[0];
                        var tc = (ev != null) ? Number(ev.tc) : NaN;
                        if (ev == null || !isFinite(tc)) { q.skip = 0; page({ aroundId: aroundId, aroundMissing: true }); return; }
                        var newerQ = Object.assign({}, q, { since: Math.max(Number(q.since) || 0, tc + 1), skip: 0, limit: 1 });
                        obj.db.getEventsFor(command.nodeid, opts, newerQ, function (x, newer) {
                            q.skip = Math.floor((Number(newer) || 0) / q.limit) * q.limit;
                            page({ aroundId: aroundId });
                        });
                    });
                  });
                };
                if (typeof obj.db.getNodeMeta == 'function') obj.db.getNodeMeta(command.nodeid, withMeta); else withMeta(null);
            } catch (e) { console.log('PLUGIN: eventlog: getNodeHistory error: ', e); }
          break;
        }
        case 'collectNow': {
            try {
                var ok = obj.sendToAgent(grandparent, command.nodeid, { action: 'plugin', plugin: 'eventlog', pluginaction: 'collectnow', nodeid: command.nodeid, rights: true, sessionid: true });
                if (myobj.parent.ws != null) {
                    myobj.parent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'eventlog', method: 'onCollectNow', ok: ok }));
                }
            } catch (e) { console.log('PLUGIN: eventlog: collectNow error: ', e); }
            break;
        }
        case 'adminSaveConfig': {
            // Every outcome is reported back to the admin page, so it can show whether the save worked.
            var sendAdmin = function(o) { try { o.action = 'plugin'; o.plugin = 'eventlog'; myobj.parent.ws.send(JSON.stringify(o)); } catch (e) { } };
            if (!obj.isPluginAdmin(myparent)) { sendAdmin({ method: 'adminSaveFailed', error: 'Administrator rights are required to change the configuration.' }); break; }
            obj._cfgCache = {};   // ingest filters pick up the change with the next batch
            var opts = {...command.opts, ...{}};
            var isDefault = (command.id == '_default');
            // The config set is sent to agents and to the device tab: the only Assistant field it may hold is the id
            // of the endpoint its devices use. Only full administrators choose it (the Assistant is theirs to
            // manage); for anyone else the field is left out, and every backend keeps the stored value (they merge).
            for (var ak in opts) { if (ak != 'aiEndpointId' && /^ai[A-Z]/.test(ak)) delete opts[ak]; }
            if (!obj.isFullAdmin(myparent)) delete opts.aiEndpointId;
            var epCheck = Promise.resolve(true);
            if (opts.aiEndpointId !== undefined) {
                if (opts.aiEndpointId === null) opts.aiEndpointId = '';
                if (typeof opts.aiEndpointId != 'string') epCheck = Promise.resolve(false);
                else if (opts.aiEndpointId !== '') {
                    var aiStore = (obj.ai != null) ? obj.ai.store : null;
                    epCheck = (aiStore == null || typeof aiStore.getEndpoint != 'function') ? Promise.resolve(false)
                        : Promise.resolve(aiStore.getEndpoint(opts.aiEndpointId)).then(function (ep) { return ep != null; }, function () { return false; });
                }
            }
            var saved = epCheck.then(function (epOk) {
                if (!epOk) { var ue = new Error('Unknown Assistant endpoint'); ue.unknownEndpoint = true; throw ue; }
                return isDefault ? obj.db.updateDefaultConfig(opts).then(function () {
                    if (opts.retentionDays != null && typeof obj.db.setRetention == 'function') obj.db.setRetention(opts.retentionDays);
                    return '';
                  })
                : obj.db.updateConfig(command.id, opts).then(function (d) { return (d != null && d.insertedId) || command.id; });
            });
            saved
            .then(function (savedId) {
                obj._cfgCache = {};   // again: a batch that arrived while the save was pending cached the old set
                return obj.db.getAllConfigSets().then(function (sets) {
                    sendAdmin({ method: 'adminUpdateConfigSets', sets: sets, selected: savedId, saved: true, defaultSet: isDefault, name: opts.name });
                });
            })
            .catch(function (e) {
                if (e && e.unknownEndpoint) { sendAdmin({ method: 'adminSaveFailed', error: 'Unknown Assistant endpoint' }); return; }
                console.log('EVENTLOG: Something went wrong saving the config: ' + ((e && e.message) || e));
                sendAdmin({ method: 'adminSaveFailed', error: String((e && e.message) || e).substring(0, 200) });
            });
            break;
        }
        case 'adminDeleteConfig': {
            if (!obj.isPluginAdmin(myparent)) break;
            obj._cfgCache = {};
            obj.db.deleteConfigSet(command.id)
            .then((d) => {
              var x = { action: "plugin", plugin: "eventlog", method: "adminConfigDeleted", id: command.id };
              myobj.parent.ws.send(JSON.stringify(x));
            })
            .catch((e) => console.log('EVENTLOG: Something went wrong deleting the config'));
            break;
        }
        case 'adminAssignConfig': { // configId, nodes, meshes
            if (!obj.isPluginAdmin(myparent)) break;
            obj._cfgCache = {};
            obj.db.assignConfig(command.configId, command.selection)
            .then(obj.db.getConfigAssignments)
            .then((d) => {
              var configAssignments = [];
              d.forEach((s) => {
                configAssignments.push({ asset: s.asset, configId: s.configId });
              });
              var x = { action: "plugin", plugin: "eventlog", method: "setsAssigned", data: configAssignments};
              myobj.parent.ws.send(JSON.stringify(x));
            })
            .catch((e) => console.log('EVENTLOG: Something went wrong assigning the config: ', e));
            break;
        }
        default: {
          break;
        }
      }
    }

    return obj;
};
