# MeshCentral-EventLog

*Current Version: 0.1.14
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

After installing or updating, grant the plugin's permissions (see [Permissions](#permissions)): they are all denied by default, so until then only full administrators can use the Event Log tab.

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

- **Alerts** — rules that raise a MeshCentral device event when incoming events match. Each rule can filter by entry type, log, source (`*` wildcards), event IDs (`1112, 100-199`) and message text, and can require *N matching events within M minutes*, with a per-device cooldown. Alerts are evaluated on the server as events arrive (before the History include/exclude rules) and appear in the device's Events list. Events older than one hour are ignored.

- **Assistant endpoint** — the model the [Assistant](#assistant) uses for devices with this set (*None* by default, which turns the Assistant off for them)

Retention (days) and the 100,000-events-per-device cap are server-wide.

The **Assistant** tab of the admin page (full administrators only) manages the model endpoints, what data may be sent to a model, daily limits and the Assistant's audit log; see [Assistant](#assistant).

#### Endpoint - Plugin tab
When viewing a remote endpoint, a new "Event Log" tab appears under the Plugins tab. It follows MeshCentral's light and night themes and uses the full width of the window.

- **Live** pulls the latest N entries (10–500, selectable on the tab; the admin config set provides the default) of the configured logs and entry types straight from the device, refreshes automatically every 30 s and can be paused.
- **History** shows the events the agent has collected and sent to the server (about once a minute), with a time range, paged loading, the time of the last collection and a "Collect now" button. Retention is configurable in the Default config set.
- **Filters**: level chips with counts, Log, Source (application/service name), Event ID lists and ranges (`1112, 100-199`), time range and free-text search. Click a column header to sort.
- **Layouts**: *Table* (dense, expandable rows) or *Viewer* (facet sidebar with counts, list and a details pane with the full message and raw JSON). *Fold repeats* collapses identical events into one line with an ×N badge.
- **Sizing**: drag a column header's right edge to resize it (double-click fits the column to its content), drag the rail under the table (Table) or between list and details (Viewer) to change the height, drag the rail next to the Viewer sidebar to change its width, and pick a row density (*Rows*: Compact / Normal / Wrap — Wrap shows long messages on several lines). All of it is remembered per browser; a *Reset* link in the status line restores the defaults.
- **Export** the filtered rows as CSV.
- **Assistant** (optional, needs an endpoint and the *Event Log: Assistant* permission): *Explain this event* on History rows, a third view *Diagnosis*, and an *Ask about this device* panel beside the table. See [Assistant](#assistant).

What a user sees depends on the [plugin permissions](#permissions): views they may not use are hidden.

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

## Permissions

The plugin registers three permissions with MeshCentral's plugin permission framework (*My Server → Plugins → Event Log → Permissions*):

| Permission | Allows | Enforced by |
| --- | --- | --- |
| **Event Log: Live view** | the Live view of a device | the tab only: the live view runs through MeshCentral's relay tunnel, which the plugin's server code does not see |
| **Event Log: History and Collect now** | the stored history of a device and the "Collect now" button | the server |
| **Event Log: Assistant** | Explain this event, Diagnosis and Ask (also needs MeshCentral's **Details** right on the device) | the server, again before every step the Assistant takes |

> **Breaking change in 0.2.0:** all three permissions are **denied by default**. After updating, only full administrators can use the Event Log tab until you grant the permissions.

> **Loaded via `settings.plugins.list`?** Such plugins are not shown on the *My Server → Plugins* page, so the Permissions dialog cannot be opened there. Install the plugin normally (configuration URL above) to grant the permissions, or, for advanced setups, edit the `pluginpermission//eventlog` document in MeshCentral's plugin permissions store (`pluginpermissions` collection or table) while MeshCentral is stopped.

- Users still need their normal MeshCentral rights on the device; the permissions only add to them. Device rights are taken from MeshCentral's database, never from what the browser sends.
- A user with neither Live nor History sees a notice with a "Check again" link. Permission changes take effect on the next device refresh, without reloading the page.
- On a MeshCentral without the plugin permission framework, only full administrators can use the tab. When the framework is present, the startup log shows `EVENTLOG: plugin permissions registered ...`.
- The permission keys (`deviceLiveTab`, `deviceHistoryTab`, `deviceAssistant`) are the same as in the Tech-Werkz fork, so permissions granted there keep working.
- The Assistant tab of the admin page (endpoints, API keys, data policy, audit log) is for **full administrators** only.

## Assistant

The Assistant helps a technician understand what a device's event log says. It uses a language model (LLM) that you run or choose, and answers in three places on the device's Event Log tab:

- **Explain this event** — a button on History rows (in the expanded row and the Viewer's details pane): what the event means, what it means on this device, whether it is usually harmless and what to check next.
- **Diagnosis** — a third view next to Live and History. Pick *Last 24 hours*, *Last 7 days* or *Around the last restart*; it never runs on its own. It shows a summary, a timeline, possible causes (likely / possible / ruled out, with the evidence for and against), numbered next steps and the evidence it used.
- **Ask about this device** — a chat panel beside the table for free questions ("Why did this device restart recently?").

Things to know:
- **It only reads.** The Assistant can look at the device's data and stored events, nothing else. It never runs commands; suggested commands are text for the technician to check and run.
- **Answers can be wrong.** Answers cite the stored events they rely on (`E1`, `E2`, ...). Selecting a citation finds and highlights the event in the table, and *Open these N events in History* shows exactly the cited events. Check them before acting.
- Answers can be marked *Helpful* / *Not helpful*, and a possible cause can be marked as wrong.
- No agent core update is needed; everything runs on the MeshCentral server.

### Choosing a model

**Use a local or self-hosted model if you can** (for example [Ollama](https://ollama.com), vLLM, LM Studio, llama.cpp or LocalAI): event logs and device details then stay on your network. The endpoint form has presets for these servers, which fill in the usual address. A cloud service can be used by entering its address yourself (there are no cloud presets); it then receives the data you allow, with personal values always replaced (see below).

The plugin does not recommend specific models. Test connection and *Fetch models* show what the server reports, such as tool-call support and context size. Models without tool calls still work in *Summary only* mode: the server prepares one summary of the device and its events and sends it with the question, so answers can only use what is in that summary.

Supported API formats:
- **OpenAI-compatible chat** (Chat Completions; spoken by most self-hosted servers). For Ollama, the plugin uses Ollama's own chat API when a context size is set.
- **OpenAI Responses**
- **Anthropic Messages**

**Ollama context:** Ollama's default context can be as small as 4,096 tokens, too small for event logs. Set *Ollama context (num_ctx)* on the endpoint (the plugin sends it with every request), or set `OLLAMA_CONTEXT_LENGTH` on the Ollama server. A larger context needs more memory there.

### Setup

1. Admin page (*My Server → Plugins → Event Log*) → **Assistant** tab → **Add endpoint**: choose a preset or *Custom*, the API format, the address, an API key if the server needs one, and the model (*Fetch models* lists what the server offers).
2. **Test connection** (address, connection, API key, model, tool calls, context size), then **Save endpoint**.
3. Check **Data sent to the model** (what may be read, what is replaced, the preview policy) and the daily limits under **Access**, then **Save settings**.
4. **Config Sets** tab → edit a set → **Assistant endpoint**: pick the endpoint. Devices using that set can now use the Assistant (the default is *None*).
5. Grant **Event Log: Assistant** (*My Server → Plugins → Event Log → Permissions*) to the users or groups who should use it. They also need MeshCentral's **Details** right on the device.

### What data is sent

Under *What the model may read*, an administrator chooses the categories (defaults in brackets):
- Device summary and hardware: OS, hardware, agent, antivirus, last boot (on)
- Network interfaces and addresses (on)
- Stored event history (on)
- MeshCentral device events (on; MeshCentral's own event-visibility limits apply)
- Device notes (off)
- Installed software (off): read live from the agent's own software inventory; needs the agent to be online, and users whose device rights exclude the software inventory do not get it

Each category is offered to the model only when it is on. Every field is picked by name from a fixed list; the following are **never sent**: stored credentials (SSH / RDP), BitLocker recovery keys, Intel AMT passwords (device and device group), device group invitation codes, user records, location data and hardware serial numbers.

**Replacing personal values (pseudonymization):** before anything is sent, user names, computer and domain names, IP and MAC addresses, email addresses, Windows SIDs, paths containing user names and secrets in messages (tokens, keys, passwords) can be replaced with placeholders such as `HOST_1`; the answer shows the real values again (marked), and the mapping never leaves the server. Well-known accounts like SYSTEM or Administrator stay as they are, because they help the diagnosis.
- **Always on** for endpoints outside your network; for local endpoints (this server or private addresses) each replacement is your choice.
- It is **best effort**: names inside free text that look like ordinary words can slip through. Use a local model for data that must not leave your network.

**Preview for endpoints outside your network:** before a question is sent to such an endpoint, the user sees what will be sent (readable and raw, with counts per category and the replaced values), can switch categories off, and then sends or cancels; on Cancel nothing is sent. The policy is *every time* (default), *once per user and endpoint*, or *never*.

### Security

- **Read-only tools, bound to one device.** The model can only call the plugin's read-only tools, each limited to the device the conversation started on. The user's permission and device rights are checked again before every tool call, so revoking access stops a running answer at its next step.
- **Event log text is untrusted.** A log message can contain text written to mislead the model (prompt injection). The plugin marks all device data as data, never as instructions, and flags suspicious text. This lowers the risk of misleading answers but cannot remove it; the read-only tools are what keeps such text from doing anything.
- **Output is shown safely.** Raw HTML from the model is shown as text, images are never loaded (they become a link that names their domain), and links show their real domain.
- **API keys** are stored encrypted (AES-256-GCM) with a key file `plugin-eventlog-ai.key` in `meshcentral-data` and are never shown or sent to a browser again (the form only shows the last four characters). Back the key file up with the rest of `meshcentral-data`: without it, stored API keys cannot be decrypted and have to be entered again. Instead of a key you can enter `env:VAR_NAME` to read it from an environment variable of the MeshCentral server. A key is never sent over plain `http://` to a public address.
- **Requests always go from the MeshCentral server**, never from the browser. Public `https://` endpoints use the proxy set by `HTTPS_PROXY` / `HTTP_PROXY` (as MeshCentral itself does). Redirects are not followed, and the address checked when connecting is the one used. Link-local and cloud metadata addresses (169.254.x.x, fe80::) are blocked unless *Allow link-local addresses* is turned on for the endpoint.
- **Limits:** questions and tokens per user per day (0 = no limit), steps per answer, maximum answer length and a timeout per request. A conversation ends after 30 minutes without questions.
- **Audit log:** every answer is logged with who asked, about which device, which endpoint and model, how much was sent and how many values were replaced. Full administrators can page through it and export it as CSV on the Assistant tab. Entries are kept for 90 days by default. *Also store full questions and answers* (off by default) keeps transcripts as they were sent to the model, with personal values replaced; anyone who can read the database can read them.

## Storage

Collected events are stored in **MeshCentral's own database**, so they are covered by the same backup:

| MeshCentral database | Where the plugin stores events |
| --- | --- |
| MongoDB | `plugin_eventlog` / `plugin_eventlog_settings` / `plugin_eventlog_ai_audit` collections |
| PostgreSQL, MariaDB, MySQL | `plugin_eventlog_events` / `plugin_eventlog_settings` / `plugin_eventlog_ai_audit` tables |
| SQLite | the same tables, in MeshCentral's SQLite file |
| NeDB (the default for small installs) | `plugin-eventlog-events.db` / `plugin-eventlog-settings.db` / `plugin-eventlog-ai-audit.db` in `meshcentral-data` |

The startup log says which one is in use (`EVENTLOG: storage backend = ...`).

Assistant endpoints and settings live in the settings store; the Assistant's audit log has its own collection, table or file (`..._ai_audit`). The key that encrypts stored API keys is the file `plugin-eventlog-ai.key` in `meshcentral-data`. It is not in the database, so **back it up together with the database**: if it is lost, API keys have to be entered again.

When a server that had been using the plugin's own NeDB files moves onto one of the SQL backends, config sets and their assignments are imported automatically the first time the plugin starts; previously collected events are not carried over (they expire on their own and the agents refill the history within a minute). The old `plugin-eventlog-*.db` files can then be deleted. Setting the environment variable `EVENTLOG_STORAGE=nedb` keeps the plugin on its own files.

How much is kept is controlled by **Retention (days)** in the Default config set, plus a fixed cap of 100,000 events per device.

## Development

The tests use Node's built-in test runner and need no dependencies (Node 22 or newer):

```
node --test test/
```

Some optional suites are skipped unless their modules can be found:
- NeDB backend tests: install `@seald-io/nedb` and point `NODE_PATH` at its `node_modules` (`NODE_PATH=/path/to/node_modules node --test test/`). The SQLite tests use `node:sqlite` and are skipped where it is missing.
- Answer rendering tests in a simulated browser: set `EVL_JSDOM` to a `jsdom` module and `EVL_MC_SCRIPTS` to MeshCentral's `public/scripts` folder (for its `marked` and DOMPurify copies).

`node scripts/check-syntax.js` checks the syntax of every `.js` file and of the inline scripts of the admin page. CI (`.github/workflows/ci.yml`) runs it and all test suites, the optional ones included, on Node 22, 24 and 26 for every push to master and every pull request.

### Releases

Releases are made by `.github/workflows/release.yml`, not by hand:
- Describe each change in `changelog.md` under `## [Unreleased]` ([Keep a Changelog](https://keepachangelog.com/en/1.0.0/) headings) and push to master. When CI has passed for that commit, a release follows automatically. The version step comes from the changelog: `### Added` or `### Changed` → minor, a `**Breaking` entry → major (minor while the version is 0.x), anything else (`### Fixed`, `### Security`, ...) → patch. An empty `[Unreleased]` section means no release, so documentation or housekeeping pushes don't release.
- Put `[skip release]` in the commit message to push changelog entries without releasing yet.
- To release on demand, or to pick the step yourself: Actions → Release → *Run workflow* on master, with bump `patch`, `minor` or `major` (`auto` uses the changelog). The commit still needs a successful CI run.
- The release commit (`Release vX.Y.Z [skip ci]`) writes the version into `config.json`, the top of this readme and `changelog.md` (`[Unreleased]` becomes `[X.Y.Z] - date`). The commit is tagged `vX.Y.Z`, and a GitHub release is created with that changelog section as its notes. MeshCentral offers updates based on `config.json` on master and lists older versions from the tags. Don't change the version by hand.
- The workflow pushes to master. If master is protected, allow GitHub Actions to push to it, or add a `RELEASE_TOKEN` repository secret (a token with *Contents: read and write* on this repository). Without the secret, the built-in `GITHUB_TOKEN` is used.

# Future

This project may be expanded to include:
- When used in conjunction with a task-scheduling plugin could fire off a task on an endpoint in response to an event
- Thoughts welcome- please feel free to suggest something that might be useful to you

# Screenshots
![Device Plugin Page](https://user-images.githubusercontent.com/1929277/67437370-adcd1200-f5be-11e9-9750-99f9c89b4c11.png)
![Plugin Administration Page](https://user-images.githubusercontent.com/1929277/69597525-4565bc00-0fd4-11ea-8722-55fe06ed64cd.png)
