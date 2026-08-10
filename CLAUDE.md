# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules

- Never `git commit` or `git push` unless the user explicitly asks.

## Commands

```bash
# Install dependencies (compiles native modules node-pty and better-sqlite3)
npm install

# Start the app (bundles CodeMirror + Vue once, launches Electron)
npm start

# Dev mode: bundles everything, then watches Vue files + hot-reloads on change
npm run dev

# Faster iteration (skips slow CodeMirror bundle, still rebuilds Vue once)
npm run electron

# Rebundle CodeMirror only (needed after editing public/codemirror-setup.js)
npm run bundle:codemirror

# Run tests
npm test

# Run a single test file
node --test test/folder-index-state.test.js

# Build for distribution
npm run build:mac     # DMG + zip (arm64 + x64)
npm run build:win     # NSIS installer
npm run build:linux   # AppImage + deb
```

Tests use Node's built-in `node:test` runner — no Jest or Mocha.

## Architecture

Switchboard is an **Electron app** that acts as a session manager and IDE emulator for Claude Code CLI. The app has the standard Electron split:

- **Main process** (`main.js`) — all Node.js/filesystem/PTY logic. Communicates with the renderer via IPC.
- **Renderer process** (`public/`) — plain HTML/CSS/JS, no framework. Receives `window.api` from the preload bridge.
- **Preload** (`preload.js`) — context bridge that exposes `window.api` to the renderer. Every IPC channel is declared here.

### Data flow

1. Claude Code stores sessions as `.jsonl` files under `~/.claude/projects/<encoded-path>/`.
2. `main.js` watches this directory for changes and keeps a **SQLite cache** (`~/.switchboard/switchboard.db` via `db.js`) of session metadata and a full-text search index.
3. The cache is populated either via a **Worker thread** (`workers/scan-projects.js`) on first load or incrementally via `session-cache.js` when the watcher detects `.jsonl` changes.
4. The renderer calls `window.api.getProjects()` → IPC → `buildProjectsFromCache()` to get the project/session tree.

### Key modules

| File                                     | Role                                                                                                                                                       |
|------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `db.js`                                  | SQLite schema, migrations, all DB read/write helpers                                                                                                       |
| `session-cache.js`                       | In-memory + DB cache management; incremental folder refresh                                                                                                |
| `session-transitions.js`                 | Detects fork/plan-accept transitions in active PTY sessions by watching for new `.jsonl` files                                                             |
| `terminal-mirror.js`                     | Headless xterm per live PTY in the main process — the screen a reattach is restored from                                                                   |
| `mcp-bridge.js`                          | Per-session WebSocket MCP server — registers Switchboard as a VS Code–compatible IDE so Claude CLI sends diffs/file-opens here instead of to a real editor |
| `derive-project-path.js`                 | Decodes encoded folder names back to filesystem paths                                                                                                      |
| `encode-project-path.js`                 | Encodes a filesystem path to the `~/.claude/projects/<folder>` naming convention                                                                           |
| `shell-profiles.js`                      | Shell discovery (zsh, bash, WSL) and argument construction for PTY spawning                                                                                |
| `schedule-runner.js` / `schedule-ipc.js` | Cron-style scheduled task support                                                                                                                          |
| `workers/scan-projects.js`               | Worker thread for initial full-scan of `~/.claude/projects/`                                                                                               |
| `public/app.js`                          | Renderer entry point; top-level state and routing between sidebar views                                                                                    |
| `public/sidebar.js`                      | Left sidebar: project/session list, search, starred/archived filters                                                                                       |
| `public/terminal-manager.js`             | xterm.js terminal instances, PTY attach/detach, grid view                                                                                                  |
| `public/viewer-panel.js`                 | Right panel: file viewer + diff review UI (CodeMirror)                                                                                                     |
| `public/codemirror-setup.js`             | CodeMirror bundle entry (dev dependency; output is `public/codemirror-bundle.js`)                                                                          |

### IDE emulation (MCP bridge)

When a Claude session starts, `main.js` calls `startMcpServer()` which binds a WebSocket server on a random port and writes a lock file to `~/.claude/ide/`. Claude CLI discovers this file and connects, treating Switchboard as an IDE. File diffs proposed by Claude arrive as `openDiff` MCP calls, which `main.js` forwards to the renderer via `mcp-open-diff` IPC. The renderer shows them in `viewer-panel.js`. The user's accept/reject/edit decision comes back as `mcpDiffResponse` IPC → `resolvePendingDiff()`.

### Settings

Settings are stored in SQLite (`settings` table) keyed by `"global"` or `"project:<path>"`. Defaults are defined in `SETTING_DEFAULTS` in `main.js`. The renderer always calls `getEffectiveSettings(projectPath)` to get merged global+project values.

Appearance settings the main process never reads — `uiFont`, `monoFont`, `uiScale`,
`terminalFontSize` — deliberately stay out of `SETTING_DEFAULTS`: a key listed
there becomes overridable per project, which is wrong for anything that applies
to the whole window. They live in the `"global"` row, are read once by the init
block in `public/app.js`, and are pushed live by the `window._apply*` callbacks
that `SettingsPanelApp.vue` calls after saving.

### WSL-backed accounts

An account may carry `wslDistro`, in which case its Claude home lives inside
that WSL distribution and `configDir` is the Windows UNC view of it. Accounts
without the field behave exactly as before — every helper below is identity for
them.

Four rules, in order of how easy they are to break:

1. **The POSIX path is canonical.** `projectPath` is stored, keyed and
   `encodeProjectPath`-hashed in the form Claude wrote into the `.jsonl` — never
   the Windows form. `add-project` normalises a UNC path from the folder picker
   back to POSIX via `canonicalProjectPath()`.
2. **Translate at the fs boundary, never before.** Wrap the argument of every
   `fs.*` call that can receive a project path in `hostPath()`, and compose
   paths with `projectJoin()` — plain `path.join` on Windows rewrites a POSIX
   path with backslashes and destroys rule 1. This applies to paths arriving
   from the CLI over MCP too.
3. **Anything that runs *in* a project runs in the distribution.** Use
   `projectExecFile()` (or `projectGit()` on top of it), which rewrites
   `(argv, cwd)` into `wsl.exe -d <distro> --cd <cwd> --exec <argv>`. Never a
   shell string: the project path must not meet shell quoting.
4. **A WSL account is a config directory, not a distribution.** One distribution
   can hold several Claude accounts, told apart only by which directory they
   read, so `wslClaudePosix` — not `wslDistro` — is what identifies an account
   and what `findWslAccount()` dedupes on. That POSIX directory is what crosses
   as `CLAUDE_CONFIG_DIR`, and only when it is not the `$HOME/.claude` the
   distribution would resolve on its own (`accountWslConfigEnv()`); `configDir`
   is its Windows view and means nothing inside. Anything named in the PTY
   environment must also be listed in `withWslEnv()`, or `wsl.exe` drops it.
   Accounts attached before this was possible carry no `wslClaudePosix` and are
   backfilled to the default home in `getAccounts()`.

Whatever the account owns follows the account, not the Windows home — plans,
global memory files, `/stats`, schedules. Modules that cannot reach
`activeConfigDir()` take an injected `configure({...})` (see the two schedule
modules) rather than pinning a directory at module load.

Change detection uses an mtime-sweep poll for WSL accounts: a recursive
`fs.watch` over the 9p share succeeds and then delivers nothing, so its silence
is indistinguishable from no changes.

If the MCP bridge never connects for a WSL session, check in this order: a
Windows Firewall rule for inbound connections on the `vEthernet (WSL)` adapter,
and a proxy configured inside the distribution — the CLI resolves a proxy for
the IDE socket and honours `NO_PROXY`, so `HTTP_PROXY`/`ALL_PROXY` set in the
distro will capture the connection to the host address.

### Merged account view

The global setting `mergedAccountView` puts every account's projects in one
list. It lives in the `"global"` settings row rather than `SETTING_DEFAULTS` —
a key listed there becomes overridable per project, which is wrong for something
that applies to the whole window. `accountsInView()` in `main.js` is the one
place that answers "which accounts" — `session-cache.js` takes it through
`init()` rather than rebuilding it; nothing else should branch on the setting.

**The setting is a hard boundary, not a preference.** With it off the app must
behave exactly as it did before the merged view existed: nothing may consult,
read from, watch or activate an account other than the active one. Every branch
this feature added is on the merged side of a `mergedAccountView()` test, and
`open-terminal` ignores `sessionOptions.accountId` outright when the setting is
off rather than trusting each caller to have left it out. When adding anything
here, ask what it does with the setting off — the answer has to be "what it did
before".

The one thing the rule does not forbid is *switching* to another account, which
the dropdown has always done in either view. An external launch naming an account
is that same move, made from outside; it is why the switch happens before
`launch-project-session` rather than being handed to `open-terminal` as a field.

Three consequences worth knowing before touching this code:

1. **The active account no longer means "what is on screen"** — in the merged
   view. It means where a launch that names no account of its own goes. Anything
   that reads *what to show* asks `accountsInView()`; anything that reads *where
   to run* takes the account from the launch.
2. **A launch names its account.** `open-terminal` takes
   `sessionOptions.accountId` and activates it before spawning, so fork
   detection, MCP diffs and the file panel stay on the same account as the
   shell. A resume passes the session's own `accountId` — never the active one.
   A reattach is a launch too, and there the running session's own `accountId`
   wins. The reply always carries the account actually in effect, never the one
   that was asked for: the renderer follows it, and a declined request that
   reported itself as granted would move the UI to an account the main process
   is not on. An external launch (`wootonpad://`, `--project`) names only a path,
   so `launch-project-session` carries the `accountForPath()` answer alongside
   it — resolved in the main process because such a launch routinely arrives
   before the renderer has a project list to look in. It may also name an account
   outright, as `?account=<distro>:<config dir>`; that is a request to *switch*,
   so it activates the account rather than passing it down as a field, which
   `open-terminal` would drop outside the merged view. Environment variables are
   why it has to be in the URL at all: nothing in a distribution's environment
   reaches a Windows app. `launch-project-session` says *whether* the account was
   named, not only which it is: a named one has just been switched to, so the
   renderer's list is still the previous account's and a session resumed out of it
   would name a `.jsonl` that does not exist in the home the shell will run in.
3. **The account is resolved from the path, not from the selection.**
   `hostPath()` and `projectExecFile()` go through `accountForPath()`, so a
   project of a WSL account is read and its git run inside that distribution
   while another account is active. Outside the merged view `accountForPath()`
   returns the active account unconditionally — that is what keeps the standard
   view byte-for-byte what it was, and why the merged branch must never be the
   default.

Session cache rows carry `accountId`; `cache_meta` and `search_map` do not, and
are shared by folder name. That is why the worker path clears search entries per
session rather than per folder — two accounts holding the same project produce
the same folder name, and a folder-wide delete drops the other account's rows.

### A terminal names its account

A plain terminal carries `CLAUDE_CONFIG_DIR` for the account it was launched
under, so the CLI run by hand in it — and anything around it that reads the
variable — lands where the tab says rather than on whatever Claude home the shell
would resolve alone. `accountShellConfigDir()` gives the value: POSIX for a WSL
account, never the UNC `configDir`. Two things this needs and neither is
optional — any inherited value is deleted first, and `withWslEnv()` names the
variable, without which `wsl.exe` drops it at the boundary and the whole thing is
a no-op exactly where it matters.

It is a default, not a guarantee: rc files are sourced after the environment is
handed over, so an `export` there outranks it, as does a wrapper reached through
an alias — a developer who wrote either made a choice more specific than ours.

### Session identity and fork detection

When a new Claude session is spawned with `--fork-session` or a plan is accepted, a new `.jsonl` file appears with a different session UUID. `session-transitions.js` monitors active PTY sessions for new files in their project folder and matches them to the correct parent via `forkedFrom` or `parentSessionId` fields in the JSONL. Once matched, it re-keys the active session map and notifies the renderer.

### A reattach is handed a screen, not a recording

A session outlives the terminal showing it: closing a tab or reloading the window
leaves the PTY running, and reopening it has to put back what was on screen.
`terminal-mirror.js` keeps a headless xterm per live PTY, fed the same bytes the
renderer is sent, and `open-terminal` serializes it.

The rule this replaced a ring of raw PTY chunks for: **a byte log has no safe
truncation point.** Dropping its head drops the cursor position, scroll region,
SGR and alt-screen state that the dropped prefix established, and can cut an
escape sequence in half. Claude Code redraws differentially — cursor moved
relative to the frame it believes is on screen, only the changes rewritten — so a
screen restored from a truncated log is not the one the next frame is drawn
against, and the difference stays visible as duplicated rows and a cursor parked
in a column nothing put it in.

The mirror is also where the CLI's own signals are read from — the OSC 0 title
that says whether it is working, and the OSC 9 notification that says it is
waiting for the user. Those used to be matched with a regex against each PTY
read, which drops any sequence a read boundary falls inside; a dropped OSC 9 is a
permission prompt the tray never hears about. `createMirror` takes an `osc` map
for this, and handlers observe rather than consume — each returns false so xterm
still does what it would have done. The cost is that the signals now arrive a
tick later than the bytes that carried them, which is why the tray tests have to
let a push settle before they read the tray.

Four things this needs, and none of them are optional:

1. **Every byte reaches the mirror.** There is no equivalent of the old
   "suppress buffering during resize": a screen with a hole is not a smaller
   screen, it is a wrong one.
2. **The mirror and the renderer's terminal measure characters the same way.**
   Same grapheme addon, same Unicode version as `createTerminalEntry()` — change
   one and change the other, or the same bytes occupy different columns in each.
3. **Nothing may reach the renderer ahead of the screen.** Serializing waits for
   the mirror's own parse to drain, so it is not instantaneous; live output is
   queued for that window and flushed behind the screen.
4. **Cursor visibility is carried by hand.** `SerializeAddon` restores contents,
   colours, cursor position, the alt buffer and the DEC modes it knows — but not
   DECTCEM, the one a TUI holds off for most of a frame.

The PTY is no longer nudged to `cols + 1` and back to force a repaint on
reattach: the renderer was never told about the intermediate width, so for as
long as it lasted the CLI drew frames for a screen wider than the one they landed
on. A reattach has a real screen now and nothing to force.

### A session waiting for you stays waiting

`session._attention` records that the CLI asked the user something. The CLI asks
**once**, so anything that drops the request drops it permanently — which is why
none of the three rules below is a filter at the moment it arrives:

1. **Being watched is re-asked, not decided.** `noteSessionNotification` records
   every request, including one raised while the session is on screen;
   `traySnapshot` is where `isWatchingSession` is consulted, so the answer follows
   the user out of the window. Everything that changes that answer has to rebuild
   the tray, and none of it involves the CLI: `blur` and `hide` for leaving the
   window, and `session-viewed` unconditionally — the session being switched *to*
   holds no request, so clearing alone would return early and leave the tray
   reporting the session just left as quiet.
2. **Both replies are watched for, and typing is the earlier one.** Answering
   requires looking at the session, so the reply is only ever visible as input to
   it or as the CLI resuming work. `terminal-input` clears the mark, and
   `setCliBusy` clears it again when the session goes busy. The second alone is
   not enough: an answer that ends the turn rather than continuing it never
   produces a spinner, and the mark would outlive it.
3. **One rule, in one place.** `ATTENTION_MESSAGE` is tested in the main process
   and the verdict travels to the renderer with the message. Two copies of the
   test drift apart in the direction that matters — the sidebar marking a session
   the tray does not.

The tray only knows the two states above, `attention` and `busy`. The renderer
has a third, `response-ready`, that never reaches the tray: a session that has
finished and is waiting for input shows the idle icon.
