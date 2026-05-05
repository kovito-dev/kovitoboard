[English](README.md) | [日本語](README.ja.md)

# KovitoBoard

Self-extending AI agent team system that runs on Claude Code.

KovitoBoard reads `.claude/agents/` definitions from an existing Claude Code
project and provides a browser dashboard for session monitoring, recipe
management, and trust-prompt relay.

<!-- A demo GIF will be added in Phase 6 -->

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`@stable` channel recommended — see below)
- Node.js 20 or later
- tmux 3.4 or later
- npm 9+

### Installing tmux

`tmux` is a separate OS-level program (not an npm package) that KovitoBoard
uses to drive Claude Code. macOS ships an older version, so install or
upgrade via Homebrew:

```bash
# macOS (Homebrew)
brew install tmux
# or, if already installed:
brew upgrade tmux

# Ubuntu / Debian / WSL2
sudo apt-get install tmux
```

Verify the version:

```bash
tmux -V   # → tmux 3.4 or higher
```

## Quick Start

```bash
# 1) Clone KovitoBoard inside your Claude Code project directory
cd /path/to/your-claude-code-project
git clone https://github.com/kovito-dev/kovitoboard.git
cd kovitoboard
npm install

# 2) Launch — KovitoBoard starts with hot-reload for your app/ extensions
npm start -- --project-root ..

# 3) Open the URL printed at the end of `npm start`'s output.
#    With default settings this is http://localhost:5173, but the
#    supervisor automatically picks the next free port if 5173 (or 3001
#    for the backend) is already in use, so always read the
#    "Frontend: http://localhost:<port>  ← open this in your browser"
#    line from the supervisor.
```

> **Note:** KovitoBoard runs in development mode by default. This enables
> hot-reload for user extensions placed under your project's `app/`
> directory (e.g., via recipe apply). You don't need to rebuild or restart
> the server when files change there.
>
> **Tip:** Add `kovitoboard/` to your project's `.gitignore` to avoid
> tracking KovitoBoard as a nested git repo.

> **Note:** KovitoBoard is **not** a Claude Code project itself. It is a
> regular program that reads an existing Claude Code project's
> `.claude/agents/` directory and JSONL session files.

### What you can target with `--project-root`

You can point `--project-root` at any of the following:

1. **An existing Claude Code project** (`.claude/agents/` present) — full
   feature set.
2. **A brand-new empty directory** — the agent list starts empty. Create
   `.claude/agents/*.md` under the directory to grow the team.
3. **A directory that previously hosted a Claude Code project** — past
   session logs will be visible. Claude Code stores session logs by absolute
   path, so re-using the same directory resurfaces prior history.

### Advanced launch methods

- **Targeting a different project:** `npm start -- --project-root /absolute/path`
- **Environment variable:** `KOVITOBOARD_PROJECT_ROOT=/path npm start`
- **Contributor / production mode (static build):** See [CONTRIBUTING.md](./CONTRIBUTING.md). Not required for end users.
- **Persisted setting:** After completing onboarding, `.kovitoboard/setting.json`
  remembers the project path. Subsequent launches can omit `--project-root`
  when started from the same directory.
- **Ports:** the Vite dev server defaults to **5173** and the backend API
  defaults to **3001**. The supervisor (`tools/kb-start.mjs`) probes both
  ports on launch and falls back to the next free one (`5174`, `5175`, …
  / `3002`, `3003`, …) when the default is in use. Always open the
  URL printed in the `[kb-start] Frontend: http://localhost:<port>` line.

  To pin specific ports (and have the launcher fail loudly when they are
  busy instead of falling back):

  ```bash
  # CLI flags
  npm start -- --port=8080 --vite-port=8000

  # Environment variables (legacy, same precedence as CLI flags after
  # CLI parsing)
  PORT=8080 VITE_PORT=8000 npm start
  ```

  CLI flags take precedence over env vars; both override the auto-probe.

Priority order (higher wins):
`--project-root` → `KOVITOBOARD_PROJECT_ROOT` → `.kovitoboard/setting.json` →
`process.cwd()`.

On startup, the resolved project root and its source are printed to the
server log, so you can verify the resolution took the expected path:

```
[kovitoboard] Project root: /path/to/project (source: cli-arg)
```

### Logs and Troubleshooting

KovitoBoard writes structured logs to `.kovitoboard/logs/` as JSON Lines
with daily rotation and a default 7-day retention. The latest active
file is exposed via a `current.log` symlink:

```
.kovitoboard/logs/current.log              -> latest rotated file
.kovitoboard/logs/server.YYYY-MM-DD.<n>.log
```

Override retention or log level via environment variables or
`.kovitoboard/setting.json`:

```bash
KOVITOBOARD_DEBUG=1                  # debug-level logging
KOVITOBOARD_LOG_RETENTION_DAYS=14    # 1-365 days (env wins over setting.json)
```

```jsonc
// .kovitoboard/setting.json
{
  "logging": { "retentionDays": 14 }
}
```

When reporting an issue, generate a diagnostic report:

```bash
npm run diagnose > diag.md
```

`diag.md` bundles KovitoBoard / Node / OS / Claude Code / tmux versions,
the onboarding state from `setting.json`, and the last 100 lines of the
active server log. Home directory paths are masked as `~`, but please
review the contents (especially log lines) before posting to GitHub
Issues — other potentially sensitive information may remain.

## Data Handling

KovitoBoard runs agents through Claude Code. Please be aware:

- **Information shown in KB is forwarded to Claude (the model)** when you ask an
  agent about it. This includes screen content via the Ambient Session Sidebar,
  files opened in apps like Document Viewer, and information loaded through recipes.
- **Anthropic's data handling settings apply.** Claude Pro/Max accounts have
  "do not train on my data" enabled by default — you can verify this in your Claude
  account settings.
- **For applications handling sensitive data, we strongly recommend implementing
  masking at the data ingestion layer** (e.g., redact secrets when loading files,
  hide sensitive fields before they reach the screen). KovitoBoard provides no
  built-in masking; application authors and recipe authors are encouraged to design
  data flow with this in mind.

For details, see [docs/agent-ref/09-data-handling.md](./docs/agent-ref/09-data-handling.md).

## Supported Claude Code Versions

KovitoBoard tracks the **`@stable`** release channel of Claude Code.
Trust-prompt detection patterns are calibrated against a specific version,
and best-effort support is provided for a range of nearby releases.

| | Version |
|---|---|
| **Primary tested** | 2.1.104 (`@stable` channel) |
| **Best-effort** | 2.1.x / 2.2.x |

### Recommended setup

Install (or pin) the stable channel:

```bash
npm install -g @anthropic-ai/claude-code@stable
```

Or, if you use Claude Code's built-in auto-update, set the channel in your
Claude Code settings (`~/.claude/settings.json`):

```json
{
  "autoUpdatesChannel": "stable"
}
```

### Startup version check

When KovitoBoard starts, it runs `claude --version` and compares the
result with the primary tested version. If they differ you will see a
warning in the server log — KovitoBoard still starts normally, but
trust-prompt detection may behave unexpectedly.

### Troubleshooting

1. Check your installed version: `claude --version`
2. Switch to the stable channel: `npm install -g @anthropic-ai/claude-code@stable`
3. Restart KovitoBoard (`npm start`)
4. If trust-prompt detection still fails, please
   [open an issue](https://github.com/kovito-dev/kovitoboard/issues) with
   the output of `claude --version` and the server log.

## Agent Definition

KovitoBoard reads agent definitions from `<project-root>/.claude/agents/*.md`.

Each `.md` file uses YAML frontmatter:

```markdown
---
name: my-agent
displayName: My Agent
description: A helpful agent
color: blue
---

# My Agent

System prompt and instructions go here.
```

### Required fields

| Field | Description |
|-------|-------------|
| `name` | Unique identifier (kebab-case) |
| `displayName` | Display name shown in UI |
| `description` | Short description |

### Optional fields

| Field | Default | Description |
|-------|---------|-------------|
| `color` | `gray` | Theme color for the agent card |
| `summary` | — | One-line summary shown in lists |

## Features

### Agent Dashboard
Browse and inspect agent definitions. View agent details, metadata, and
the raw Markdown definition file. (Read-only in v0.1.0.)

### Session Monitor
Watch active Claude Code sessions in real time. JSONL session files are
monitored via chokidar and updates are pushed to the browser over WebSocket.

### Recipe System
Import, inspect, and export agent recipes — portable bundles that package
agent definitions with page components and API extensions.

- **Import:** Parse recipe files (YAML directory or single Markdown) with
  security inspection (path traversal, dangerous patterns, size limits)
- **History:** Track previously applied recipes
- **Export:** Generate recipes from existing agent configurations

### Trust Prompt Relay
When Claude Code displays a trust prompt in a tmux session (e.g., "Do you
want to create this file?"), KovitoBoard detects it via `capture-pane`
polling and relays it to the browser UI. You can approve or reject
directly from the dashboard.

### App Extensions
Place custom pages, API routes, and styles in the `app/` directory to
extend KovitoBoard without modifying the core source. See `app.example/`
for a working example.

## Architecture

```
Browser (React + Vite)
   ↕ WebSocket + REST
Express Server
   ├── Agent Reader      (.claude/agents/*.md)
   ├── Session Manager   (JSONL file watcher via chokidar)
   ├── Trust Prompt Detector (tmux capture-pane polling)
   ├── Recipe Engine      (parse / inspect / apply / export)
   └── tmux Bridge        (send-keys relay)
```

## Repository Layout

```
src/
  server/       Backend — Express + WebSocket + file watchers
  renderer/     Frontend — React 19 + Tailwind CSS
  shared/       Shared type definitions (WebSocket events, recipe types)
tests/
  e2e/          Playwright E2E tests
  unit/         Vitest unit tests
app.example/    Example app extension (menu, page, API, styles)
docs/           Specifications and known issues
```

## Known Limitations (v0.1.0)

- **Settings are read-only.** The settings modal displays configuration but cannot save changes.
- **dist/ ESM issue.** The tsc output requires `tsx` runtime; an esbuild bundler will be introduced in v0.2.0.

## Contributing

For development setup (HMR via `npm run dev`, running tests, etc.), see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

KovitoBoard is licensed under the **GNU Affero General Public License v3 or later (AGPL-3.0-or-later)**. See [LICENSE](LICENSE) for the full license text.

Copyright (C) 2026 Anode LLC.
