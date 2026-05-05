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
