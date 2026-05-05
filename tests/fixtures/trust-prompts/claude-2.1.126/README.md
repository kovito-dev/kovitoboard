# Claude Code 2.1.126 trust-prompt fixtures

Live captures from Claude Code 2.1.126 (the @stable dist-tag as of
2026-05-03). Replaces the 2.1.104 set as the primary tested version
because 2.1.126 changed the bash-command menu layout in a way that
breaks the old static keys mapping.

## What changed in 2.1.126

The `bash-command` permission prompt no longer offers
`Yes, and allow this session`. For commands flagged with
`Contains simple_expansion` (variable expansion, etc.) Claude Code
now shows only:

```
❯ 1. Yes
  2. No
```

Older trust-patterns assumed `2 = Yes, allow this session` and sent
`"2\n"`, which 2.1.126 interprets as `No`. Claude Code records this
as `User rejected tool use` and parks the session — see DEC-024 #5
or the developer session log for the full story.

## How the patterns adapted

Each `choices[]` entry in `src/server/trust-patterns.json` carries a
`labelPattern` regex. At detection time the detector parses the
`N. <label>` rows out of the tmux capture and rewrites `keys` to
`${N}\n` for whichever rows are actually visible. Choices whose
`labelPattern` does not appear on screen are dropped from the
broadcast so the UI never advertises a button that selects nothing.

The static `keys` field in the JSON is now a fallback — used only
when the menu cannot be parsed (rare, but covers truncated buffers).

## Fixtures in this directory

| Fixture | Purpose |
|---|---|
| `folder-trust-initial.txt` | Two-choice folder trust prompt (unchanged from 2.1.97). Verifies the loader and detector still match the original layout. |
| `bash-command-two-choices.txt` | The 2.1.126 bash prompt with the per-session row dropped. The detector must resolve `Yes` to `1\n` here, not `2\n`. |

PII has been scrubbed (workspace path, user name, email).
