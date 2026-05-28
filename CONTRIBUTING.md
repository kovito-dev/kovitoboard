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

## For External Contributors

Thanks for considering a contribution to KovitoBoard! This section
covers everything you need to know to submit a successful pull request
from a fork.

### Code of Conduct

By participating, you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant v2.1).

### Pull Request Workflow

1. **Fork** this repository to your GitHub account
2. **Clone** your fork locally
3. **Create a feature branch** from `staging`:
   - Naming: `feature/<short-description>`, `fix/<short-description>`,
     `chore/<short-description>`, `docs/<short-description>`
4. **Make your changes** and verify quality gates locally:
   ```bash
   npm run typecheck
   npm run build
   npm test
   npm run check:hygiene
   ```
5. **Commit** with a clear English message describing the *why* of the
   change
6. **Push** to your fork and **open a PR** against the upstream `staging`
   branch (not `main`)
7. **Wait for CI** to complete (typecheck / build / test / hygiene /
   language check) — all must pass
8. **Address review feedback** if requested
9. After approval, the maintainer will squash-merge to `staging`;
   release-time `staging → main` happens via a coordinated merge commit

### Language Policy

- **All text in the repository must be in English** — code, comments,
  log messages, UI strings, documentation, commit messages, PR titles,
  PR bodies, and issue threads
- A dedicated CI check
  ([`.github/workflows/pr-language-check.yml`](.github/workflows/pr-language-check.yml))
  detects Japanese characters in PR title / body and fails the PR
- Exception: `src/renderer/i18n/ja.ts` (Japanese translation dictionary)

### Internal IDs

KovitoBoard's internal coordination uses identifiers like `DEC-*`,
`BL-*`, agent tags (`(agent: ...)`), and internal question IDs. These
are **for internal coordination only** and **must not appear in
external-facing artifacts**:

- ❌ Not allowed: commit messages, PR titles, PR bodies, issue threads,
  code comments
- ✅ Enforcement: the
  [`pr-language-check`](.github/workflows/pr-language-check.yml) CI
  workflow scans every PR title and body for these patterns (and for
  Japanese characters) and fails the PR if any are detected. The
  maintainer additionally runs a local `.git/hooks/commit-msg` hook on
  internal pushes for an early signal, but that hook is not
  distributed with forks, so external contributors are expected to
  follow this guidance manually

### CI Behavior on Fork PRs

- **No secrets are required** for any CI job — all checks (hygiene,
  typecheck, build, hygiene-post-build, test, pr-language-check) run
  on fork PRs and internal PRs alike. The `pr-language-check` workflow
  uses the default `GITHUB_TOKEN`, which is read-only on fork PRs; the
  language scan itself runs the same way, and only the auxiliary
  follow-up actions (automatic labelling, in-PR warning comments) are
  degraded to log-only messages for forks. The pass / fail signal
  for the required status check is unaffected.
- **L1 E2E** runs on `push` to `staging` / `main` (post-merge
  integration check), not on PRs — this keeps the PR feedback loop fast
- **First-time contributor approval**: For your first PR from a fork,
  GitHub may pause workflow execution pending maintainer approval. This
  is a one-time gate; subsequent PRs run automatically.

### What We Look For in a Good PR

- **Focused scope** — one logical change per PR
- **Test coverage** — new code paths covered by unit tests or L1 E2E
- **Spec alignment** — if your change touches a documented behavior in
  `docs/specs/`, reference the affected spec in the PR description
- **Backward compatibility** — breaking changes call out the migration
  path explicitly in the PR template's `Breaking Change` section
- **Atomic commits** — squashable history, no merge commits inside the
  PR branch

### Reporting Security Issues

**Do not file security vulnerabilities as public issues.** See
[SECURITY.md](SECURITY.md) for the responsible disclosure process.

### Questions

For general questions about usage, architecture, or design intent, open
a `[Question]` issue with the
[Question template](.github/ISSUE_TEMPLATE/question.md). The maintainer
will respond as time allows.
