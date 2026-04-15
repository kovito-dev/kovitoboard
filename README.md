# KovitoBoard

Self-extending AI agent team system that runs on Claude Code.

日本語: Claude Code 上で動作する AI エージェントチームの管理ダッシュボード。
`.claude/agents/` に配置されたエージェント定義を読み取り、セッション監視・レシピ管理・
trust-prompt 中継をブラウザ UI で提供します。

<!-- Phase 6 でデモ GIF を追加予定 -->

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (latest)
- Node.js 20 or later
- tmux
- npm 9+

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/kovito-dev/kovitoboard.git
cd kovitoboard
npm install

# 2. Point to your Claude Code project
export KOVITOBOARD_PROJECT_DIR=/path/to/your-project

# 3. Launch
npm run dev

# 4. Open http://localhost:5173 in your browser
```

> **Note:** KovitoBoard is **not** a Claude Code project itself. It is a regular
> program that reads an existing Claude Code project's `.claude/agents/` directory
> and JSONL session files.

## Agent Definition

KovitoBoard reads agent definitions from `$KOVITOBOARD_PROJECT_DIR/.claude/agents/*.md`.

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

- **Agent editing is not supported.** v0.1.0 is read-only; CRUD UI is planned for v0.2.0.
- **Settings are read-only.** The settings modal displays configuration but cannot save changes.
- **dist/ ESM issue.** The tsc output requires `tsx` runtime; an esbuild bundler will be introduced in v0.2.0.

See [docs/v0.1.0-known-issues.md](docs/v0.1.0-known-issues.md) for the full list.

## Development

```bash
# Development server (auto-reload)
npm run dev

# Type check
npm run typecheck

# Build
npm run build

# Unit tests
npm test

# E2E tests (requires dev server or auto-starts via Playwright)
npm run test:e2e
```

## License

AGPL-3.0 — see [LICENSE](LICENSE).
