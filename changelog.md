# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Known Issues]
- None. Please feel free to submit an issue via [GitHub](https://github.com/ryanblenis/MeshCentral-EventLog) if you find anything.

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
