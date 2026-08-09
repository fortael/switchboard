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

### Session identity and fork detection

When a new Claude session is spawned with `--fork-session` or a plan is accepted, a new `.jsonl` file appears with a different session UUID. `session-transitions.js` monitors active PTY sessions for new files in their project folder and matches them to the correct parent via `forkedFrom` or `parentSessionId` fields in the JSONL. Once matched, it re-keys the active session map and notifies the renderer.
