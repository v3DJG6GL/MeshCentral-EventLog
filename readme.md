
# MeshCentral-EventLog

*Current Version: 0.1.12
Released: 2026-09-01*

Initially conceived as a proof of concept plugin for the [MeshCentral2](https://github.com/Ylianst/MeshCentral) Project to introduce extensibility into the project without requiring the MeshCentral2 project to incorporate everyone's requested changes into the main project, yet allow it to be accomplished by others. In creating this plugin, we're introducing the appropriate hooks into MeshCentral2 to allow extensibility to anyone who can write a plugin, while trying to modify the core project as little as possible.

## Installation

 Pre-requisite: First, make sure you have plugins enabled for your MeshCentral installation:
>     "plugins": {
>          "enabled": true
>     },
Restart your MeshCentral server after making this change.

 To install, simply add the plugin configuration URL when prompted:
 `https://raw.githubusercontent.com/v3DJG6GL/MeshCentral-EventLog/master/config.json`

Once installed, you'll need to update your agent cores in order to use the live / history features.

## Usage
*Supports Windows endpoints (Windows Event Log via PowerShell) and Linux endpoints (systemd-journald via journalctl) with a software agent installed. On Linux, events are shown in KSystemLog-style categories (System, Application, Kernel, Auth, Cron, Daemon, Audit); endpoints without systemd (e.g. Alpine, OpenWRT) are detected and flat-file /var/log support is planned.*

As a proof of concept, several methods were employed to become familiar with the [MeshCentral2](https://github.com/Ylianst/MeshCentral) project. 

#### Plugin Admin
You can now create configuration sets and assign them to nodes or meshes. Need to collect events from a new log file other than Application/System? Just add it and assign!

Each set filters what is collected (History) and shown (Live), each with an Include/Exclude switch:
- **Logs** — Windows event logs (`Application,System,Security`)
- **Categories (Linux)** — journald categories: System, Application, Kernel, Auth, Cron, Daemon, Audit. *Application* is program output and is usually the noisy one on desktops
- **Sources** — source / provider names, comma-delimited, `*` wildcards (e.g. exclude `plasmashell, kwin*`). Works on both OSes
- **Entry Types** — levels; on Linux they map onto syslog priorities (Critical 0–2, Error 3, Warning 4, Info 5–6, Verbose 7)

Retention (days) and the 100,000-events-per-device cap are server-wide.

#### Endpoint - Plugin tab
When viewing a remote endpoint, a new "Event Log" tab appears under the Plugins tab. It follows MeshCentral's light and night themes and uses the full width of the window.

- **Live** pulls the latest N entries (10–500, selectable on the tab; the admin config set provides the default) of the configured logs and entry types straight from the device, refreshes automatically every 30 s and can be paused.
- **History** shows the events the agent has collected and sent to the server (about once a minute), with a time range, paged loading, the time of the last collection and a "Collect now" button. Retention is configurable in the Default config set.
- **Filters**: level chips with counts, Log, Source (application/service name), Event ID lists and ranges (`1112, 100-199`), time range and free-text search. Click a column header to sort.
- **Layouts**: *Table* (dense, expandable rows) or *Viewer* (facet sidebar with counts, list and a details pane with the full message and raw JSON). *Fold repeats* collapses identical events into one line with an ×N badge.
- **Sizing**: drag a column header's right edge to resize it (double-click fits the column to its content), drag the rail under the table (Table) or between list and details (Viewer) to change the height, drag the rail next to the Viewer sidebar to change its width, and pick a row density (*Rows*: Compact / Normal / Wrap — Wrap shows long messages on several lines). All of it is remembered per browser; a *Reset* link in the status line restores the defaults.
- **Export** the filtered rows as CSV.

#### Endpoint - Console tab
You can see the application logs directly from the console, using the command:

> plugin eventlog getlog

This will, by default, get the latest 10 Application Log errors and warnings.
Advanced usages can specify in greater detail, e.g.

> plugin eventlog getlog System 100 Error false

Let's break that down:

`plugin` informs the system that you are about to utilize a plugin call

`eventlog` calls this eventlog module

`System` references the requested event log set

`100` is the number of entries to be returned

`Error` is the type of event log (e.g. Error, Information, Warning, etc.)

`false` is whether or not to return JSON formatted output, rather than truncated text

 
## Storage

Collected events are stored in **MeshCentral's own database**, so they are covered by the same backup:

| MeshCentral database | Where the plugin stores events |
| --- | --- |
| MongoDB | `plugin_eventlog` / `plugin_eventlog_settings` collections |
| PostgreSQL, MariaDB, MySQL | `plugin_eventlog_events` / `plugin_eventlog_settings` tables |
| SQLite | the same tables, in MeshCentral's SQLite file |
| NeDB (the default for small installs) | `plugin-eventlog-events.db` / `plugin-eventlog-settings.db` in `meshcentral-data` |

The startup log says which one is in use (`EVENTLOG: storage backend = ...`).

When a server that had been using the plugin's own NeDB files moves onto one of the SQL backends, config sets and their assignments are imported automatically the first time the plugin starts; previously collected events are not carried over (they expire on their own and the agents refill the history within a minute). The old `plugin-eventlog-*.db` files can then be deleted. Setting the environment variable `EVENTLOG_STORAGE=nedb` keeps the plugin on its own files.

How much is kept is controlled by **Retention (days)** in the Default config set, plus a fixed cap of 100,000 events per device.

# Future

This project may be expanded to include:
- Create alerts based on the log entries and user-defined filters
- When used in conjunction with a task-scheduling plugin could fire off a task on an endpoint in response to an event
- Thoughts welcome- please feel free to suggest something that might be useful to you

# Screenshots
![Device Plugin Page](https://user-images.githubusercontent.com/1929277/67437370-adcd1200-f5be-11e9-9750-99f9c89b4c11.png)
![Plugin Administration Page](https://user-images.githubusercontent.com/1929277/69597525-4565bc00-0fd4-11ea-8722-55fe06ed64cd.png)
