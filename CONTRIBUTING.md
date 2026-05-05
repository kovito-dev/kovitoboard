# Contributing to KovitoBoard

Thanks for your interest in contributing! This document covers the
development setup. End users should read [README.md](README.md) instead.

## Development setup

```bash
git clone https://github.com/kovito-dev/kovitoboard.git
cd kovitoboard
npm install

# Run with HMR (same as `npm start` but without the supervisor wrapper)
npm run dev -- --project-root /path/to/your-test-project

# Default ports:
#   Server: http://localhost:3001
#   Client: http://localhost:5173  (use this in your browser)
#
# When launched via `npm start`, the supervisor probes for free ports
# and falls back to the next available (5174, 5175, … / 3002, 3003, …).
# Read the "[kb-start] Frontend: http://localhost:<port>" line from the
# supervisor to know the actual URL.
#
# To pin ports explicitly (and fail loudly when they are busy):
#   npm start -- --port=8080 --vite-port=8000
#   PORT=8080 VITE_PORT=8000 npm start
```

> **`npm start` vs `npm run dev`:**
>
> - `npm start` — Canonical launch for **end users**. Runs the supervisor
>   (`tools/kb-start.mjs`) which manages server + Vite processes, creates
>   an `app/` symlink, supports restart via `POST /api/admin/restart`,
>   and probes for free ports (`--port` / `--vite-port` to pin).
> - `npm run dev` — **Contributor** shortcut. Runs `concurrently` directly
>   (no supervisor), useful for quick iteration without symlink setup.
>   Port probing is **not** active in this mode — set `PORT` /
>   `VITE_PORT` manually if the defaults are in use.

## Quality gates

```bash
# TypeScript typecheck (web + node configs)
npm run typecheck

# Build (static production bundle)
npm run build

# Unit tests (vitest)
npm test

# E2E L1 (Playwright against Fake Claude harness)
npm run test:e2e:l1

# Release hygiene check (language / PII / layout rules)
npm run check:hygiene
```

## Running in static-build (production) mode

For contributor validation of the static build:

```bash
npm run build
npm run prod -- --project-root /path/to/your-test-project
```

This serves pre-built assets from `dist/` (no HMR). Useful for CI and
release validation. End users should run `npm start` instead.

## Code style

- TypeScript first. Prefer `kebab-case` for filenames, `PascalCase` for
  React components.
- Avoid `any`; add minimal types when crossing module boundaries.
- All user-facing strings go through `src/renderer/i18n/` — no hardcoded
  Japanese or English literals in components.
- Repository hygiene rules (English everywhere except the i18n JA dict and
  templates with `.en.md` co-location) are enforced by
  `npm run check:hygiene`.

## License header (required for source files)

All `*.ts`, `*.tsx`, `*.mjs`, and `*.js` files must start with the
AGPL-3.0-or-later short header:

```
/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
```

You **do not need to add this manually** — the pre-commit hook
(`lefthook` `license-header`) auto-inserts the header into staged source
files. If you skip the hook (`--no-verify`) or if the file is not staged
through the normal commit flow, run:

```
node scripts/add-license-header.mjs <file...>          # targeted
node scripts/add-license-header.mjs                    # bulk (all sources)
node scripts/add-license-header.mjs --dry-run          # preview only
```

The check is enforced by `npm run check:hygiene` (also runs in CI), so a
missing header will block the build. Files that already contain
`SPDX-License-Identifier` are skipped (idempotent).

Excluded paths: `tests/fixtures/projects/**` (synthetic end-user repos
that emulate user content, not KovitoBoard source).

Rationale: keep the AGPL claim visible at the file level so that
downstream forks, SBOMs, and code search tools surface the license
without having to chase the root `LICENSE` file. See
[DEC-012](https://github.com/kovito-dev/kovitoboard) §3 for the full
hygiene gate design.

## Commit messages

- Use English. Be concise and describe what changes and why.
- Use a short prefix to categorize the change. The active set of
  prefixes in this repo is `[core]`, `[ui]`, `[test]`, `[script]`,
  `[meta]`.
- Do **not** include AI co-author trailers
  (`Co-Authored-By: Claude ...`, `Generated with [Claude Code]`, etc.).
  The maintainers' local commit-msg hook strips these automatically;
  contributors should also avoid adding them for copyright clarity.
- Do **not** include internal project metadata that has no meaning to
  readers of this public repository (internal task IDs, internal review
  question IDs, role-name tags, etc.). Describe the user-facing or
  developer-facing change directly.

## Pull requests

- PR descriptions in English. Describe the effect of the change for users
  or developers of this repo, not the internal process behind it.
- Keep PRs focused and small.

## License

By contributing you agree that your contributions are licensed under the
same AGPL-3.0 license as the project.
