# CLAUDE.md — KovitoBoard

Guidance for AI coding agents (Claude Code, GitHub Copilot, etc.) that
work directly on this repository.

## Repository overview

KovitoBoard is the OSS distribution. It is a regular program — not a
Claude Code project itself — and is dropped into an existing Claude
Code project to monitor and orchestrate agent sessions.

For the human-facing project description see [`README.md`](README.md);
for contribution guidance see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Documentation map

User-facing reference documentation lives under [`docs/agent-ref/`](docs/agent-ref/).
Internal design memos, decisions, and specs are deliberately kept out
of this repository — they live in the private `kovitoboard-dev`
companion repository.

## PR-based workflow

All changes to `main` and `staging` must go through a pull request.
Direct pushes to `main` and `staging` are blocked by branch protection
(no admin bypass). Hotfixes are no exception — they also go through a
PR.

### Workflow summary for AI agents

1. Cut a feature branch from the latest `staging`. Branch naming
   conventions:
   - kebab-case, ASCII letters / digits / hyphen only, max 50 chars
   - prefixes: `feature/` / `fix/` / `chore/` / `docs/` / `release/`
   - no internal IDs (no DEC-xxx, no BL-xxxx, no `(agent: <id>)`)
   - examples: `feature/recipe-export-rework`,
     `fix/trust-prompt-race`
2. Commit on the feature branch following commit message rules below.
3. Push the branch and open a draft PR against `staging`:
   ```bash
   gh pr create --draft --base staging \
     --title "<title>" --body "<body>"
   ```
4. When the change is ready for review, mark it ready:
   ```bash
   gh pr ready <pr-number>
   ```
   This triggers the `codex-pr-review` automation: a CodeX-based
   reviewer leaves structured findings as a PR comment.
5. The agent reads the findings, auto-fixes Low/Medium issues
   (capped at 3 attempts), and escalates High/Critical issues to the
   maintainer. Detailed escalation rules live in the private
   `kovitoboard-dev` companion repository.
6. Once approved, the PR is merged with **squash merge** (feature →
   staging). Releases are merged from staging to `main` with a
   **merge commit**. Branches are deleted automatically after merge.

### Commit message rules (recap)

- Use feature-name / behaviour / module wording. Do **not** include
  internal identifiers used inside the private companion repository
  (DEC IDs, BL IDs, internal issue numbers, `(agent: <id>)`).
- Do **not** add `Co-Authored-By: Claude ...` or similar AI trailers.
  A local `commit-msg` hook strips them automatically.
- Recommended prefixes: `[core]`, `[template]`, `[test]`, `[script]`,
  `[meta]`. Examples:
  ```
  [core] persist agent themeColor in settings
  [core] add CLI override for kb-start port resolution
  [test] cover ambient sidebar handover into the file preview
  ```

### Where the full rules live

The complete operational rules for AI agents working on this
repository (full PR flow, Level 4 auto-fix loop, escalation paths,
session-log conventions) live in the private `kovitoboard-dev`
companion repository under `.claude/rules/pr-operations.md` and
`.claude/rules/git-commit.md`. They are intentionally not shipped
with this repository because they target internal AI-agent
operations rather than the OSS distribution itself.

External contributors are not expected to follow that internal flow
beyond the surface rules listed above. A contributor-facing
`CONTRIBUTING.md` will be expanded before external pull requests are
accepted (see the project's release roadmap).

## CI verification rule (DEC-018)

AI agents must follow this rule whenever they commit and push to this
repository.

### Before starting work

Run `gh run list --branch main --limit 5` to inspect the latest CI
status:

- All recent runs green → proceed with normal work.
- Any recent run red → **fixing CI takes priority over the task you
  came in to do, even if the failure looks unrelated**. A red main
  silently invalidates the assumption that other agents rely on.
- Status unclear → ask the maintainer (or surface a question to the
  architect agent on the kovitoboard-dev side).

### After commit & push

- Wait for CI to finish before ending the session.
- If your latest commit turns the suite red, fix it immediately. If
  the fix has to wait (environment issue, blocked PR, etc.), record
  this in the kovitoboard-dev session log and escalate.
- Never bypass pre-commit / pre-push hooks unless explicitly
  authorised (no `--no-verify`).

The full rationale and operational rules live in DEC-018 v1.1 in the
private kovitoboard-dev repository.

## Language policy

This repository is OSS-distributed. All code, comments, log strings,
console messages, error messages, commit messages, PR titles, and
issue titles must be in English. The narrow exceptions
(`src/renderer/i18n/ja.ts`, Japanese-paired template files, the
`tests/` tree pending migration) are documented in DEC-012.
