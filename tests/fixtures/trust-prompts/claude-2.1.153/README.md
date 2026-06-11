# Claude Code 2.1.153 trust-prompt fixtures

Live captures from Claude Code 2.1.153 (the @stable dist-tag as of
2026-06-11). These back the `primaryTestedVersion` bump from 2.1.126
to 2.1.153 in `src/server/trust-patterns.json` with real-capture
artifacts, so the SSOT version no longer outruns the fixture set.

## How these were captured (2026-06-11)

Captured non-destructively with a version-isolated Claude Code binary
(no global install was touched):

- Binary: a project-local `@anthropic-ai/claude-code@2.1.153` install
  (`node_modules/.bin/claude`), confirmed `2.1.153 (Claude Code)` via
  `--version`.
- Driven under tmux at an 80-column pane to match the wrapping of the
  2.1.126 fixtures, with an isolated `HOME` so the shared user config
  was never mutated.
- Prompts triggered interactively, then cancelled with `Esc` so no
  command actually ran and no folder was permanently trusted.

## Layout comparison: 2.1.153 vs 2.1.126 — IDENTICAL

The two captured prompts render with the same layout as 2.1.126; no
menu-row, label, or footer changes were observed.

| Fixture | 2.1.153 layout |
|---|---|
| `folder-trust-initial.txt` | `❯ 1. Yes, I trust this folder` / `2. No, exit`, footer `Enter to confirm · Esc to cancel` — byte-identical to 2.1.126. |
| `bash-command-two-choices.txt` | `Contains simple_expansion` two-choice menu `❯ 1. Yes` / `2. No` (per-session row still dropped, as introduced in 2.1.126), footer `Esc to cancel · Tab to amend · ctrl+e to explain`. |

Because the layout is unchanged, the existing
`src/server/trust-patterns.json` patterns (`matchAny`, `footer`,
`labelPattern`, dynamic visible-choice resolution) match the 2.1.153
captures without modification. The `claude-2.1.126/` set remains valid
as the representative capture; this directory adds the 2.1.153
confirmation set.

## Fixtures in this directory

| Fixture | Purpose |
|---|---|
| `folder-trust-initial.txt` | Two-choice folder trust prompt. Confirms the loader and detector still match the original layout on 2.1.153. |
| `bash-command-two-choices.txt` | The 2.1.153 bash prompt for a `simple_expansion` command. The detector must resolve `Yes` to `1\n`, matching 2.1.126 behavior. |

PII has been scrubbed (the prompt boxes carry only a `/tmp/...`
workspace path; no user name, home path, or email appears).
