# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Known Issues]
- None. Please feel free to submit an issue via [GitHub](https://github.com/ryanblenis/MeshCentral-EventLog) if you find anything.

## [Unreleased]
### Added
- macOS endpoints (experimental, not yet tested on a real Mac): Live view and Stored history from the unified log (`log show`) plus crash and kernel panic reports, in the categories System, Application, Kernel, Auth, Install and Crash; a view selector (Kernel, Security, Software install, Crash reports, This boot); the Assistant works for Macs and has its own starter questions
- Android devices show in the Event Log tab why there are no logs (the Android agent cannot run the collector, and reading other apps' logs needs the READ_LOGS permission)

### Changed
- Config sets: the categories filter applies to Linux and macOS (Install and Crash are macOS-only; Cron, Daemon and Audit Linux-only)

## [0.6.1] - 2026-11-19
### Fixed
- Assistant: when the step limit is reached, the model is asked to write its answer instead of showing raw tool calls as text; tool calls a server returns as text are understood
- Assistant: Suggest questions works with thinking models
- Assistant: lookups for events missing from the built-in reference say so plainly

## [0.6.0] - 2026-11-19
### Added
- Admin page: a summary at the top of Data sent to the model shows what leaves your network and what is replaced first; a filter on the Assignment page; a bar for unsaved changes with Discard

### Changed
- Admin page: new layout with a side navigation, sections as cards with clear headings, Live view and Stored history side by side in config sets, and the request log on its own page

## [0.5.2] - 2026-11-19
### Changed
- Admin page: the Requests, Data sent to the model, System prompt and Starter questions sections are collapsed until opened (the request list loads when opened)

## [0.5.1] - 2026-11-18
### Fixed
- Assistant: the Diagnose time-window choice is laid out in one row and the model is named only once

## [0.5.0] - 2026-11-18
### Added
- Assistant: questions can be edited or deleted and answers retried; questions can be copied
- Assistant: thinking level and temperature can be changed per chat (admins can turn this off); “Suggest questions” creates new follow-up questions

### Changed
- Assistant: suggested follow-up questions are a compact, collapsible row
- Assistant: a diagnosis is now a chat — the result appears in the Ask panel, follow-up questions continue it, and earlier diagnoses are listed with the chats
- Assistant: the chat panel can be switched to full width
- Assistant: the Stop button shows that the model is still working
- Assistant: what the model writes between its lookups is shown in the steps, not in the answer

### Removed
- Assistant: the Helpful / Not helpful buttons

### Fixed
- Assistant: long diagnoses scroll inside the window
- Assistant: dragging the panel's height grip no longer makes the panel jump to an earlier height

## [0.4.1] - 2026-11-18
### Fixed
- Assistant: the Ask panel fills the window height instead of following the event table, and its height can be changed with a grip at the bottom edge (double-click restores the automatic height)
- Assistant: with “Fold repeats” on, every cited occurrence shows its citation chip and opens exactly that occurrence
- Assistant: answers give times in the technician's time zone instead of UTC

## [0.4.0] - 2026-11-18
### Added
- Assistant: the system prompt can be viewed and, after switching on edit mode, changed per part (base instructions, Ask, Explain, Diagnosis) with reset to factory defaults and a full-prompt preview; additional instructions globally and per endpoint
- Assistant endpoints: optional generation settings (thinking level, temperature, top-p, top-k, seed) with the server's defaults shown; Test connection detects supported thinking levels and lists the server's generation defaults next to the values the Assistant applies
- Assistant: chats, the last diagnosis and explanations are saved per user and device (retention configurable, delete per chat or all), the Ask panel lists earlier chats and continues them with a recap; starter questions are editable per OS

### Changed
- Assistant: clearer instructions for Linux devices (systemd journal fields, process ids, journalctl/systemctl)
- Event Log tab: when the Assistant is not available on a device, users with the Assistant permission see why (for example no endpoint assigned to the device's config set, or the Assistant turned off)
- Assistant: while an answer is being prepared, a progress strip, the current step in plain words, an elapsed-time counter and a streaming cursor show what is happening; the Ask button shows a dot when an answer is running in the closed panel
- Assistant: a “Thinking…” phase shows while the model reasons; saving the first endpoint offers to use it for the Default config set

## [0.3.2] - 2026-11-18
### Changed
- Assistant: default daily limits are 100 questions and 3,000,000 tokens per user, and up to 15 steps per answer (adjustable up to 50); the per-answer tool call and data caps now scale with the step limit and the model's context. Saved settings that still had the old defaults (40 questions, 300,000 tokens, 8 steps, 400 KB) switch to the new defaults; values you changed are kept.
- Assistant admin page: *Tool calls per answer* and *Data per answer (KB)* can be set next to *Max steps per answer*; left empty they are automatic (3 tool calls per step; about 3 bytes per context token, at least 400 KB). A set data limit is used as it is, so it can also be lower than the automatic one
- Assistant admin page: Test connection shows the authentication step as *API key* with "No API key needed: the server accepted the request" when no key is configured

### Fixed
- Assistant: an endpoint tested before its first save is now saved with the detected context size (it was assumed to be 8,192 tokens until tested again)
- Assistant admin page: empty limit fields show the value that applies (default or detected, e.g. 262,144 tokens), and Test connection no longer shows 0 ms for steps answered by the same request

## [0.3.1] - 2026-11-18
### Fixed
- Fetch models now shows the context size reported by llama.cpp-style servers (for example Strata), and Test connection no longer names such servers llama.cpp

## [0.3.0] - 2026-11-18
### Changed
- Assistant admin page: the *Preset* and *API format* dropdowns are one *Server type* choice (Ollama, vLLM, LM Studio, llama.cpp, LocalAI, Other OpenAI-compatible server, OpenAI Responses API, Anthropic Messages API). Choosing a self-hosted server fills in its usual address only while the address field is empty or still holds another server's default. The endpoints table shows the same *Server type*

### Fixed
- Assistant admin page: *Fetch models* no longer asks for a name (or a model): it only checks the address and the API key field. *Test connection* needs the address and the model, not a name. Only *Save endpoint* requires the name
- Assistant admin page: for a host name the browser no longer guesses that the address is outside your network. It notes that the server checks where the name points; after *Fetch models*, *Test connection* or saving, the hint shows the server's verdict (local network, this server, or the cloud warning). A test or model list of a saved endpoint also updates its *Location* in the endpoints table
- Assistant admin page: one short help line for the API key instead of two overlapping ones

## [0.2.0] - 2026-11-18
### Added
- **Assistant: help from a language model to understand a device's event log.** It reads the device's stored events and MeshCentral data and answers in three places on the Event Log tab. It only reads: it runs no commands, and suggested commands are text for the technician. Answers can be wrong; they cite the stored events they rely on (`E1`, `E2`, ...), and selecting a citation finds and highlights the event in the table
  - *Explain this event* on History rows: what it means, what it means on this device, whether it is usually harmless, what to check next. Can be continued in Ask
  - *Diagnosis*, a third view next to Live and History: for the last 24 hours, the last 7 days or around the last restart, a summary, a timeline, possible causes with evidence for and against, numbered next steps and the evidence used. It only runs when asked
  - *Ask about this device*, a chat panel beside the table (below it on narrow windows), with suggested follow-up questions, Stop and New chat. "Open these N events in History" shows exactly the cited events
  - Answers can be marked *Helpful* / *Not helpful*; a possible cause can be marked as wrong
  - No agent core update is needed: everything runs on the MeshCentral server, which is also the only place that talks to the model
- **Assistant tab on the admin page** (full administrators only)
  - *Endpoints*: add, edit, test and delete model servers. Presets for self-hosted servers only (Ollama, vLLM, LM Studio, llama.cpp, LocalAI, Custom); a cloud service can be used by entering its address. A permanent note recommends local or self-hosted models, and the address field says whether an address is on this server, the local network or outside it. No specific models are recommended: *Fetch models* and *Test connection* show what the server reports (tool-call support, context size)
  - API formats: OpenAI-compatible chat (Chat Completions; for Ollama with a context size set, Ollama's own chat API so *Ollama context (num_ctx)* takes effect), OpenAI Responses and Anthropic Messages
  - *How the model reads data*: Tool calls, Summary only (one prepared summary, for models without tool calls) or Automatic
  - *Data sent to the model*: which values are replaced before sending, which categories the model may read (device summary and hardware, network interfaces, stored event history, MeshCentral device events, device notes, installed software), and whether to show a preview before sending to an endpoint outside your network (every time, once per user and endpoint, or never)
  - *Access*: turn the Assistant on or off, questions and tokens per user per day, steps per answer
  - *Audit log*: every answer with user, device, endpoint, amount sent, values replaced, tokens and result; paged, with a retention period (90 days by default), optional full transcripts and CSV export (cells that a spreadsheet would run as a formula are neutralised)
- **"Assistant endpoint" in each config set**, so different devices can use different models. *None* by default, which keeps the Assistant off for those devices. Only full administrators can change it
- **Installed software** as a data category (off by default), read live from the agent's own software inventory. Only when the agent is online and the user's device rights include the software inventory
- **Pseudonymization:** user, computer and domain names, IP and MAC addresses, email addresses, Windows SIDs, paths with user names and secrets in messages are replaced with placeholders before sending, and restored (marked) in the answer. Always on for endpoints outside your network, optional for local ones. It is best effort: names in free text can slip through
- **Preview before sending** to an endpoint outside your network: the user sees what will be sent (readable and raw, counts per category, replaced values), can switch categories off, and sends or cancels
- **Safeguards**
  - The model can only use read-only tools, bound to the one device the conversation started on; permission and device rights are checked again before every tool call
  - Never sent: stored SSH / RDP credentials, BitLocker recovery keys, Intel AMT passwords, device group invitation codes, user records, location data and hardware serial numbers
  - Event log text is treated as untrusted data and suspicious text is flagged. This lowers, but cannot remove, the risk of misleading answers caused by text planted in a log (prompt injection)
  - Answers are rendered without raw HTML and without loading images; links show their real domain
  - API keys are stored encrypted and never shown again; `env:VAR_NAME` reads a key from an environment variable of the MeshCentral server instead. A key is never sent over plain http to a public address
  - Requests go from the MeshCentral server only, without following redirects; public https endpoints use the `HTTPS_PROXY` / `HTTP_PROXY` proxy. Link-local and cloud metadata addresses are blocked unless allowed for the endpoint
- **New data:** the Assistant's audit log is stored in a `plugin_eventlog_ai_audit` collection (MongoDB), a `plugin_eventlog_ai_audit` table (PostgreSQL, MariaDB, MySQL, SQLite) or `plugin-eventlog-ai-audit.db` (NeDB, in `meshcentral-data`). Endpoints and settings go into the existing settings store
  - API keys are encrypted with the key file `plugin-eventlog-ai.key` in `meshcentral-data` (created on first start, mode 0600). Back it up with the rest of your data: if it is lost, stored API keys have to be entered again
- Tests: `node --test test/` (Node 22 or newer, no dependencies)
### Changed
- **Breaking: access to the Event Log tab is now controlled by MeshCentral's plugin permissions.** Three permissions are registered, all **denied by default**: *Event Log: Live view*, *Event Log: History and Collect now* and *Event Log: Assistant*. Until an administrator grants them (My Server, Plugins, Event Log, Permissions), only full administrators can use the tab. Users also still need MeshCentral rights on the device
  - The permission keys are the same as in the Tech-Werkz fork, so permissions granted there keep working
  - History and Collect now are checked on the server. The Live view runs through MeshCentral's relay tunnel, so its permission is enforced by the tab only
  - Without Live permission the tab never opens the live tunnel; without History permission it hides History. A user with neither sees a notice with a "Check again" link. Permission changes take effect on the next device refresh, without reloading the page
  - On a MeshCentral without the plugin permission framework, only full administrators can use the tab
- **New installations collect Critical events too** (for example Kernel-Power 41 after an unexpected restart), in addition to Error and Warning: the Default config set now has Critical, Error and Warning as Entry Types for Live and History. Existing installations keep their config sets unchanged - add *Critical* under Config sets → Entry Types on the plugin admin page so History and the Assistant can see unexpected restarts
### Fixed
- **Security:** History and Collect now checked the user's rights against the device group sent by the browser. A user with rights on one device group could read the stored events of a device in another group. The device group is now taken from MeshCentral's database
- **Security:** a browser session could send messages meant for agents, for example to push messages into another user's open Event Log tab. Agent messages are now accepted only from agents, and device actions only from users
- The plugin admin page inserted device, device group and config set names as HTML. They are now inserted as text
- Live view replies carried no device id (a wrong variable)
- MongoDB: loading further pages of History could repeat or skip events that share the same timestamp. Paging now has a tie-breaker

## [0.1.14] - 2026-11-14
### Added
- **Alerts.** A config set can now hold alert rules. When incoming events match a rule, the plugin raises a MeshCentral device event (action `eventlogalert`), which is stored in the device's Events list
  - A rule can filter by Entry Type, Log, Source (`*` wildcards), Event IDs (`1112, 100-199`) and message text, and can require *N matching events within M minutes*. A per-device cooldown stops one noisy event from alerting repeatedly
  - Rules follow the same node / mesh assignment as the rest of the config set, so no new storage is involved on MongoDB, NeDB or SQL
  - Rules are evaluated on the server as batches arrive, before the History include/exclude rules, so an event you choose not to store can still alert. No agent core update is needed
  - Events older than one hour are ignored, so a newly installed agent's 24 h backlog does not fire a burst of alerts
### Changed
- **Saving a config set now tells you what happened.** A status line next to Save shows "Saving...", then a confirmation with the time, or the reason it failed (or a warning if the server does not answer within 10 seconds). Saving the Default set used to get no answer at all
- Saving a *new* config set no longer leaves the form on "new": pressing Save a second time used to create a duplicate set
- The admin actions (save, delete, assign) now check on the server that the caller is a MeshCentral administrator; before, only the admin page itself did
- The admin page now uses the same look as the device page's Event Log tab: the same colors, buttons, inputs, table styling and segmented tab switch, full width, and it follows MeshCentral's light / night theme
### Fixed
- Saved text containing `$&` or `$'` was altered when the admin page was rendered (the page template used a string replacement). The values are now inserted verbatim

## [0.1.13] - 2026-09-19
### Fixed
- **The event table now always fits the browser window.** Its height is measured against the window instead of a fixed estimate, and is re-fitted when the window is resized, so the details pane and the status line (with "Reset height") can no longer be pushed out of view
  - A height set by dragging the grip is kept as a preference but never grows past the window; dragging stops at the window edge. Enlarging the window restores the chosen height
  - Viewer layout: the Log/Source sidebar scrolls on its own instead of stretching the layout, and a very long event message scrolls inside the details pane (max. 40% of the window height)

## [0.1.12] - 2026-09-01
### Added
- **Config sets can now include or exclude by Category and by Source**, for Live and History separately. Each list has an Include/Exclude switch; empty lists mean no filter
  - *Categories (Linux)*: the journald categories (System, Application, Kernel, Auth, Cron, Daemon, Audit). Until now the "Logs" fields only meant something on Windows, so a Linux endpoint collected every category - and on a desktop, *Application* (program stdout/stderr) is by far the noisiest
  - *Sources*: comma-delimited source / provider names, `*` wildcards, case-insensitive - e.g. `plasmashell, kwin*` in Exclude mode. Works on Windows and Linux
  - History rules are applied on the server as batches arrive, so they take effect immediately for every OS and every agent version. Linux agents additionally apply them before sending (less traffic) once their core is updated. Live rules are applied in the browser (and on Linux agents)
  - Rules affect newly collected events; what is already stored ages out with retention. The Category/Source dropdowns on the device tab still show everything that is stored
### Changed
- The collection acknowledgement now reflects the newest event *received*, not the newest *stored*, so endpoints move past events that a rule dropped instead of re-sending them every minute

## [0.1.11] - 2026-09-01
### Fixed
- **The plugin made the whole MeshCentral server stall for tens of seconds at a time, with CPU usage climbing a little more every day.** Every page was affected, desktop and terminal sessions included, and restarting MeshCentral did not help. The plugin compacted its NeDB store every 40 seconds; NeDB compaction serialises *every stored document* to JSON and rewrites the whole file on the Node event loop, so nothing else on the server runs while it happens. Measured on a fast local disk, one compaction blocks for roughly 9 ms per 1,000 stored events (0.9 s at 100k events, 3.6 s at 400k) - and the store grew with every collection, which is why the CPU graph kept climbing. Compaction now runs once every 24 hours, the same value MeshCentral uses for all of its own NeDB stores
- Reloading or re-installing the plugin left the previous database instance running with its own timers, so the compaction cost multiplied with each reload. The plugin now closes the old instance first
- Collected events were inserted one at a time - one file append (NeDB) or one round trip (MongoDB) per event, up to 2,000 per minute per Linux endpoint. Each batch is now stored in a single operation
- After every collection batch the server sorted everything a node had ever collected, once per node per minute, only to read back the newest event's timestamp for the collection acknowledgement. That value now comes from the batch being stored
- Retention on NeDB relied on a TTL index. NeDB has no background expiry: it removes expired documents one at a time, and only among the results of queries that happen to touch them, so events for devices nobody opened were never removed and a large expiry ran inside a user's query. Retention is now an hourly background sweep
- Dropped two indexes that no query could use: `TimeCreated` (indexed per element over a digit array) and `tc`. NeDB uses a single index per query and the `nodeid` lookup always won. They only cost memory and insert time. On MongoDB, `NodeID1` (a prefix of `Tc1`) and `TimeCreated1` are dropped for the same reason, and a `(nodeid, time)` index is added for the "last collected" lookup
- Linux endpoints re-sent their log capabilities with every batch, and each report was written to the database. It is now only written when it actually changes
- Loading a further page of history no longer re-counts the node's whole event store
- **The Event Log tab kept a live connection to the endpoint even when you were looking at a different tab.** Opening any Windows or Linux device page started an agent tunnel and a 30-second refresh, whether or not the Event Log tab was showing - so sitting on the Desktop tab made the endpoint run a log collector every 30 seconds. The tunnel now starts when the Event Log tab is actually selected and stops when you leave it or the browser tab goes to the background
- NeDB only: assigning a config set to several devices removed just one of their previous assignments, so stale assignments accumulated; and clearing an assignment stored a literal `_clear` config id instead of removing it. Both matched the MongoDB behaviour already
- Retention and the per-device cap now delete in small batches. A single large NeDB delete blocks the server for seconds (measured: about 8 seconds for 25,000 events) and, past roughly 100,000 documents, fails outright with "Maximum call stack size exceeded" - so on exactly the servers that needed it most, retention would have silently stopped working. Clearing a 200,000-event backlog now takes about 30 seconds in the background, with no pause longer than a fraction of a second
- The collection acknowledgement can no longer move an endpoint backwards. Two collection runs can overlap (pressing "Collect now" while the one-minute timer run is in flight); if the older run's reply arrived last, the endpoint rewound its position - or its journald cursor - and re-sent events that were already stored, duplicating them in the history
- Database errors could take the MeshCentral process down. Several server-side database calls had no error handler, and on the new SQL backends an unreachable database rejects rather than hanging, which Node treats as a fatal unhandled rejection. Every path is now handled and logged
- A history reply arriving after the user has already switched to another device is discarded instead of being shown under the new device
- A device's reported OS/capabilities are re-sent if storing them failed, instead of being assumed stored (on Linux devices this could hide the Kernel, Auth and Daemon categories from History)

### Added
- **Support for MeshCentral's own database on PostgreSQL, MariaDB, MySQL and SQLite.** The plugin only ever checked for MongoDB, so every other SQL deployment silently got plugin-private NeDB files - which is also where the stalls above came from. Events and settings now live in the same database as the rest of MeshCentral (tables `plugin_eventlog_events` and `plugin_eventlog_settings`), so they are covered by whatever backs it up. MongoDB installations are unchanged, and NeDB remains the fallback for NeDB servers
  - Existing config sets and their assignments are imported once, automatically. **Previously collected events are not imported** - reading that file means exactly the full-file parse this release removes, the data expires on its own anyway and the agents refill it within a minute. After the import the old `plugin-eventlog-*.db` files are unused and can be deleted
  - Free-text search uses `ILIKE` on PostgreSQL and a case-insensitive collation on MariaDB/MySQL. On SQLite, case-insensitive matching applies to ASCII only, so a search for `MUNCHEN` will not match `münchen` there
  - The startup log names the store in use: `EVENTLOG: storage backend = ...`. Setting the environment variable `EVENTLOG_STORAGE=nedb` forces the old plugin-private files back
- A per-device cap of 100,000 stored events, applied after collection. Retention by age alone let a single busy endpoint grow the store without bound - and on NeDB the entire store is held in memory

### Notes
- The live view still runs one PowerShell query per configured log on Windows. Merging them into a single query would use one process instead of two, but `-MaxEvents` would then apply to the combined result, so a burst in one log could crowd another out of the batch entirely and those entries would never appear. The cost that mattered was that this ran at all while you were on another tab, which is fixed above

## [0.1.10] - 2026-08-28
### Fixed
- Saving the Default config set in the admin panel failed on NeDB servers with "Error loading plugin handler (TypeError: Cannot read properties of undefined (reading 'then'))": NeDB's update() does not return a promise the way MongoDB's does. Long-standing bug, surfaced once the admin page rendered again (0.1.7)

## [0.1.9] - 2026-08-28
### Fixed
- **History filters now search ALL stored events, not just the loaded page.** Level chips, Category/Source facets and dropdowns, free-text search and the ID field are pushed into the server database query; changing any filter re-queries (debounced). Previously they only filtered the events already loaded into the browser, so e.g. the two stored Errors were invisible while the newest 500 Info entries filled the page
- Chip / facet / dropdown counts in History are now range-wide server-side counts instead of counts over the loaded page (Live view still counts its loaded events)
- Linux: the History query no longer applies the config set's Windows log names ("Application,System"), which silently hid stored Kernel/Auth/Cron/Daemon events from the History view
- ID filter ranges (e.g. 100-199) now also match Linux events, whose PID is stored as a string

## [0.1.8] - 2026-08-28
### Fixed
- History + "Fold repeats": a page of 500 events could collapse into a handful of rows. History now keeps loading further pages automatically until about "Show" folded rows are visible (bounded at 5000 loaded events); toggling Fold on triggers the same top-up
- History status line now says "Showing X folded rows (Y events) of Z in range" when folding, instead of counting raw events only

## [0.1.7] - 2026-08-28
### Fixed
- Plugin admin page could show another plugin's admin UI (blank "Quick commands" page): MeshCentral points the shared Express views directory at the plugin of the current request, and our async render could pick up a concurrent plugin's identically-named admin.handlebars. The page is now rendered directly from this plugin's own template
- Config sets JSON embedded in the admin page now escapes `<` (hardening against script-tag breakout via config set names)

## [0.1.6] - 2026-08-28
### Fixed
- History view: changing "Show" now reloads the page with the new page size immediately (previously it only applied to the next "Load more" / a full page reload)

## [0.1.5] - 2026-08-28
### Added
- **Linux endpoint support (systemd-journald).** The Event Log tab now appears on Linux devices too:
  - Live view and periodic history collection read the journal via `journalctl -o json` (the same approach Filebeat uses); incremental collection resumes from a journal cursor, so nothing is re-sent and nothing is missed between runs. First run is bounded to the last 24 h
  - Events are shown in KSystemLog/GNOME-Logs-style categories derived from the journal metadata: System, Application, Kernel, Auth, Cron, Daemon, Audit
  - New "View" selector (All / Kernel / Security (auth) / Audit / This boot) — in Live view it is pushed down to journalctl (`-k`, auth facilities, `_TRANSPORT=audit`, `-b`)
  - Columns and details adapt: Category instead of Log, PID instead of Event ID; the detail pane shows the systemd Unit and the raw syslog priority (Emergency…Debug) next to the collapsed level; the Details (JSON) pane and Copy now show the full journald record
  - Syslog priorities map onto the existing level filter (0-2 Critical, 3 Error, 4 Warning, 5-6 Info, 7 Verbose), so config sets (entry types, history on/off, retention) apply unchanged
  - The agent probes endpoint capabilities once (journalctl version, persistent journal, auditd, /var/log files) and the UI adapts: a volatile-journal hint, and a clear message on endpoints without systemd (flat-file /var/log support is planned as the next step)
  - Safety rails: journalctl output is bounded (2000 events / 8 MB per batch, drained over successive runs), shell arguments are sanitized, and collection stays outside the agent's event loop
### Fixed
- Storing a single event failed if it did not have exactly 6 fields (brittle single-vs-array detection in the database layer)
- `Object.assign` in the agent module replaced with a plain merge (not guaranteed to exist in the agent's duktape runtime)
- Windows detection in the browser now uses the agent architecture id instead of matching "windows" in the OS description (which is a distro name like "Ubuntu 24.04.2 LTS" on Linux and could misdetect unusual Windows descriptions)

## [0.1.3] - 2026-08-23
### Added
- Viewer: draggable sidebar width (rail between the facets and the list); "Reset sizes" covers it
- Buttons, chips, facets and tabs show hover/pressed states; Copy flashes "Copied"
### Fixed
- Copy now copies what the pane shows: on General, the event as text in Windows Event Viewer's "Copy Details as Text" layout (Log Name, Source, Date, Event ID, Level, Occurrences, Description); on Details (JSON), the JSON. Table rows offer "Copy details" and "Copy message"

## [0.1.2] - 2026-08-23
### Added
- Resizable columns in both layouts: drag the header edge (live width readout), double-click to fit to content; widths are remembered per layout
- Resizable table height (rail under the table) and Viewer list/details split (rail between them); double-click resets
- Row density control (Rows: Compact / Normal / Wrap); Wrap shows long messages on several lines
- "Reset column widths / height" link in the status line
### Fixed
- "WebSocket is closed before the connection is established" in the browser console: the live tunnel was stopped and restarted on every device refresh (tab switch, node update, connection change). It is now kept while the same device stays selected, and the tab's filters/data survive refreshes too
- Status line says "Agent not connected" instead of showing a blank tab when the agent goes offline
### Changed
- Default column widths are measured from the real font and date format, so Level and Time are no longer truncated
- "Show" offers 10 and 15 rows as well

## [0.1.1] - 2026-08-23
### Fixed
- Plugin database never initialized when `promise`/`nedb` are absent (Docker image, MeshCentral ≥ 1.1) — root cause of the empty History tab
- UTF-8 text decoded as Latin-1 by the agent is repaired on server and browser
### Changed
- Live "Show N" = N displayed rows (after filter/fold); table scrolls in its own container
- Plugin URLs point at this fork so in-app updates work

## [0.1.0] - 2026-08-23
### Added
- Device tab rewritten: full-width table that follows MeshCentral's light/night theme, sortable columns, expandable rows with the full message
- Filters: level chips with counts, Log and Source selection, Event ID (lists and ranges such as `1112, 100-199`), time range, free-text search; "Filter by this source / ID" shortcuts
- Two layouts, switchable on the tab: **Table** (default) and **Viewer** (facet sidebar with counts, list, details pane with General / JSON tabs, arrow-key navigation)
- "Fold repeats": identical events collapse into one line with an ×N badge and the list of occurrences
- Live view: configurable entries per log (25–500, remembered per user; the admin value is the default), pause/resume, manual refresh, auto-refresh every 30 s that only fetches new events
- History view: time range, paged loading ("Load more"), status line (events stored, last collection time, retention), "Collect now" button
- CSV export of the filtered rows
- History retention configurable (days) in the Default config set
### Fixed
- Only ~900 px of the window was used; message column was truncated
- Dark (night) mode was ignored
- Non-ASCII characters (e.g. umlauts) were stripped from event messages by the agent
- Live view filtered on the history entry types instead of the live entry types
- `gatherlogs` fell through into `getNodeHistory`; history could stay empty until the agent reconnected (the server now nudges the agent module to load when the tab is opened)
- PowerShell < 3 detection did not actually stop the collection timer
- Temporary output files of long-running collections could be deleted by a concurrent live request
- Version 1→2 migration could set `Level = -1` on events without `LevelDisplayName`
- Event messages were inserted as HTML; they are now escaped
- Server-side rights check on history / collect requests
### Changed
- Events gain a numeric `tc` (event time in ms) field with an index; existing rows are migrated on first start (db version 3)

## [0.0.24] - 2021-09-19
### Fixed
- Compatibility with MeshCentral > 0.9.7

## [0.0.23] - 2020-03-10
### Fixed
- Detect PowerShell major version <= 2 and disable periodic updates for endpoint (requires 3+)

## [0.0.22] - 2020-02-10
### Fixed
- Add more reliable tmp file tracking and cleanup

## [0.0.21] - 2020-01-08
### Fixed
- Cleanup console messages for non-windows clients

## [0.0.20] - 2020-01-02
### Fixed
- Update Mongo call from count() (deprecated) to countDocuments()

## [0.0.19] - 2019-12-26
### Fixed
- Update plugin hook call to be compatible with 0.4.6-p+

## [0.0.18] - 2019-12-15
### Fixed
- Safety check the existence of the plugin page for non-windows devices (was producing an error in javascript)

## [0.0.17] - 2019-12-02
### Fixed
- Config Comparisons failing for NeDB users fixed
- Saving event log configuration sets for NeDB users no longer breaks
- Config set reverting to "Default" after update with MongoDB (now stays current value)

## [0.0.16] - 2019-12-02
### Added
- Better support for plugin tabs (tab now does not display for non-Windows devices)

## [0.0.15] - 2019-11-28
### Fixed
- Plugin was rewriting entire plugin-designated area. Made it more "plugin friendly".

## [0.0.14] - 2019-11-27
### Fixed
- Upon upgrading from 0.0.12 to 0.0.13, history entries were lost. They are now brought back.

## [0.0.13] - 2019-11-25
### Added
- Admin interface
- Ability to create different event log collection sets and assign them to nodes/meshes
- Support for MeshCentral GUI plugin installation / upgrades
### Changed
- The way event types are stored in the database. Now Integer (e.g. 3), was String (e.g. "Info")

## [0.0.12] - 2019-10-28
### Fixed
- Striping when filtering and changing log types

## [0.0.11] - 2019-10-28
### Added
- MongoDB support (prior versions were NeDB only)
### Fixed
- Endpoints now start polling for event log data and transmitting back to the server immediately, without having to view the device in the web UI first.

## [0.0.10] - 2019-10-25
### Fixed
- Sort order / striping issue after filtering event logs

## [0.0.9] - 2019-10-24
### Fixed
- Only open relay for live logs to nodes that are online

## [0.0.8] - 2019-10-24
### Added
- Ability to filter event logs via text search

## [0.0.7] - 2019-10-24
### Added
- Ability to view historical events (when collected from endpoints)

## [0.0.6] - 2019-10-23
### Added
- Updated styles for better readability and navigation. 
- New tab for event log history (if enabled on the endpoints). Currently a placeholder but will be added to output soon.

## [0.0.5] - 2019-10-23
### Fixed
- Live event logs weren't pulling from endpoints since MeshCentral 0.4.2-l due to new security. This has been fixed.

## [0.0.4] - 2019-10-15
### Fixed
- Switching from one device to another caused live event data not to load for that device. Next device viewed would work as expected. This should be consistent now.

## [0.0.3] - 2019-10-15
### Added
- Periodic log poller for each endpoint. Submits event log data to server to be parsed and stored.
- Added Changelog to project

### Fixed
- Event log querier (Powershell) to have better support for multiple logs  (types/names), errant data, and transportation of data.

## [0.0.2] - 2019-10-13
### Added
- New UI in Plugins subsection

## [0.0.1] - 2019-10-09
### Added
- Released initial version
