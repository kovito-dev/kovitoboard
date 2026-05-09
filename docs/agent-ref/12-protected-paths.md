# 12. Protected Paths

**Target KB version:** v0.2.0
**Last updated:** 2026-05-09
**Authoritative:** This chapter is authored in English here (no parallel Japanese chapter under `docs/agent-ref/`). The internal SSOT for KB maintainers is the project's design specification — agents and contributors should rely on this chapter as the public-facing source of truth.

> 📖 **When to read this chapter:** Before any agent (including non-KB agents like Claude Code's general-purpose agent) edits files, runs commands, or interacts with KB's runtime state. Anything under `<projectRoot>/.kovitoboard/`, `<projectRoot>/.claude/`, the embedded KB installation directory, or KB's tmux sessions is potentially protected — consult this chapter first.

---

## Purpose

KovitoBoard manages a set of files, runtime state, and external preconditions that agents must not edit directly. Direct edits can cause data loss, runtime corruption, silent failures, or security boundary violations.

This chapter lists every protected path with: (a) the management owner, (b) why direct edits are forbidden, and (c) the proper API/UI/CLI route to use instead. When in doubt, consult this chapter before editing anything under `<projectRoot>/.kovitoboard/`, `<projectRoot>/.claude/`, or KB's installation directory.

## Table of contents

- §1 Why KB has protected paths
- §2 KB-managed files (do not edit directly)
- §3 External preconditions KB depends on
- §4 Runtime state during KB operation
- §5 User customization, recipes, and apps
- §6 Security boundaries
- §7 Alternative routes summary

## Path placeholders

These placeholders are used consistently throughout the tables below:

- **`<projectRoot>`** — the user's project root (the directory KB was launched from, where `.kovitoboard/` and `.claude/` live).
- **`<kbRepo>`** — the embedded KB installation directory (the OSS distribution checkout, typically `<projectRoot>/kovitoboard/` in the embedded layout).

Trust-boundary note for agents: edits intended for KB internals belong in `<kbRepo>` (and almost always require a specification revision first), while edits intended for the user's data belong in `<projectRoot>` (and follow the alternative routes listed below).

---

## §1 Why KB has protected paths

KB manages files, runtime state, and external preconditions on behalf of the user. When an agent edits one of these directly:

- **Data loss** — atomic-write race conditions corrupt JSON stores, append-only logs lose ordering guarantees, recipe history breaks integrity with installed manifests.
- **Runtime corruption** — tmux window naming conventions break, the supervisor PID file becomes stale-but-believed-fresh, the `app/` symlink points elsewhere on next boot.
- **Silent failures** — pino-roll log rotation stops working when `current.log` is replaced by a regular file; trust-prompt detection patterns lose their captured evidence; the `_audit.log` rotation breaks if the file is truncated mid-flight.
- **Security boundary violations** — bypassing the trust-prompt UI breaks the user-consent model; relaxing CSP or scope validation reopens cross-origin / cross-scope risks; logging redacted-by-default fields leaks secrets.

This chapter is the SSOT that KB-bundled agents (Concierge "Kobi" / KB Developer / Secretary) and any non-KB agent invoked inside a KB project should consult before touching the listed paths. The same content is mirrored from KB's internal specification so both bundled agents and external contributors share one understanding.

---

## §2 KB-managed files (do not edit directly)

| Path | Owner | Why direct edits are forbidden | Alternative route |
|---|---|---|---|
| `.kovitoboard/setting.json` | `setting-manager.ts` (atomic write) | Parse errors / write races / lost user settings (A-1) | KB UI Settings page or `setupOnboarding` API |
| `.kovitoboard/session-agents.jsonl` | `session-manager.ts` (append-only) | Append-only invariant breaks; history integrity lost (A-2) | Session APIs (`/api/session/*`) |
| `.kovitoboard/recipe-history.jsonl` | `recipe-applicator.ts` (append-only) | Append-only invariant breaks; history integrity lost (A-2) | Recipe APIs (`/api/recipes/*`) |
| `.kovitoboard/recipes-installed/<appId>/manifest.json` | `recipe-applicator.ts` | Drift between manifest and `recipe-history.jsonl` (A-3) | Recipe install / uninstall APIs |
| `.kovitoboard/logs/` (including `current.log` symlink) | pino-roll (KB internal logger) | Rotation invariant breaks; logs become undiagnosable (A-4) | Read-only for agents. Cleanup is a maintenance task performed by the user (with KB stopped); agents must not truncate, redirect, or delete these files. |
| `.kovitoboard/debug/trust-prompt/<file>` | `trust-prompt-relay.ts` | Loss of captured evidence used to refine detection patterns (A-5) | Read-only for agents. Cleanup of confirmed-pattern captures is a maintenance task performed by the user; agents must not delete entries. |
| `.kovitoboard/run/supervisor.pid` | `kb-start.mjs` | Stale-detection logic confused; multi-instance coordination breaks (C-1) | `npm run kb:stop` (writes / deletes are owned by supervisor / kb-stop) |
| `<kbRepo>/app` (symlink pointing to `<projectRoot>/app`) | `kb-start.mjs` (`ensureAppSymlink`) | Next-boot symlink-setup warning; user apps disappear (A-6) | KB-managed (restart the supervisor if the symlink must change) |
| `<kbRepo>/dist/` (production build output) | `npm run build` | Loader path confusion if the tree is hand-edited | Generated only via `npm run build` |

---

## §3 External preconditions KB depends on

| Path / Target | Owner | Why direct edits are forbidden | Alternative route |
|---|---|---|---|
| `<projectRoot>/.claude/agents/<id>.md` | User / Claude Code | Frontmatter (`name` / `description` / `model`) is read by KB; convention breaks the agent list and ID resolution (B-1) | Edit only following Claude Code's official frontmatter convention |
| `<projectRoot>/CLAUDE.md` `<!-- KB:GUIDANCE_START --> ... <!-- KB:GUIDANCE_END -->` block | KB (CLAUDE.md guidance injection) | Hand-edits inside the block are overwritten on next boot (idempotent re-injection); see `claudeMdGuidance.disabled` opt-out (B-2) | Toggle `.kovitoboard/setting.json` `claudeMdGuidance.disabled = true` if you must opt out |
| Claude Code binary (`~/.claude-versions/<ver>/bin/claude`) | User + KB version detection | Switching to `@latest` / `@beta` may break trust-prompt detection patterns (B-3) | Follow the version-compatibility warnings shown by KB |
| `<projectRoot>/.gitignore` `kovitoboard/` entry | User | Missing entry leaks the embedded KB installation into the user's repository, bloating history (B-4) | Initial setup guide and onboarding check (a hardened check is on the v0.3.x roadmap) |
| `<kbRepo>/templates/agents/<name>.md` | OSS-distributed (git-managed) | Edits conflict with KB updates, customizations are lost (B-5) | Customize by copying to `<projectRoot>/.claude/agents/<id>.md` first |

---

## §4 Runtime state during KB operation

| Target | Owner | Why direct edits are forbidden | Alternative route |
|---|---|---|---|
| tmux session `kovitoboard-<projectDir>` | `tmux-bridge.ts` | Window-naming convention breaks; `AgentActivityMonitor` state corrupts (C-1) | KB UI (start / stop agent) or `npm run kb:stop` |
| Ports 3001 (backend) / 5173 (Vite) (defaults) | `kb-start.mjs` port resolution | `lsof -i :3001 → kill -9` may stop a different KB instance (C-2) | `npm run kb:stop` (uses the supervisor PID file) |
| Internal API `/api/admin/*` (restart / stop) | `admin-routes.ts` | Restart loops accumulate Claude processes (C-3) | KB UI buttons; raw curl is for administrative operations only |
| WebSocket `/api/ws` trust-prompt-response path | `trust-prompt-relay.ts` | User-consent flow is bypassed; trust model collapses (C-4) | KB UI's trust-prompt approval flow only |
| `KOVITOBOARD_PROJECT_ROOT` env at KB launch | User + `config.ts` priority chain | Shared-installation derivative path (C-5) | Embedded model: launch via `npm start -- --project-root ..` (M-1 refuses launches from inside the KB clone itself) |

---

## §5 User customization, recipes, and apps

| Path | Owner | Why direct edits are forbidden | Alternative route |
|---|---|---|---|
| `app/<appId>/manifest.json` | KB (`recipe-applicator.ts`) | `appId` collision; recipe export integrity breaks (D-1) | Recipe APIs or KB UI's recipe-export feature |
| `app/<appId>/api/*.ts` (declarative handler section) | User-authored + KB scanner | Free-form Express style fails the load-time scan; handler dispatch breaks (D-2) | Follow the handler conventions in KB's app-directory-extension specification |
| `app/data/<appId>/_audit.log` (including rotation) | KB audit-logging subsystem | Rotation invariant breaks; audit trail is lost (D-3) | Read-only for agents (rotation is owned by KB; agents must not truncate or hand-rotate the file). |
| Recipe scope-approval state (`recipe-history.jsonl` `scope` field) | KB scope-validation pipeline | Distribution-time security premise collapses (D-4) | Recipe install UI / API only |

---

## §6 Security boundaries

| Target | Owner | Why direct edits are forbidden | Alternative route |
|---|---|---|---|
| `<kbRepo>/src/server/**` CSP / scope-validation code | OSS maintainers + existing specifications | Cross-scope risks reopen (E-1) | File a specification revision through KB's design-review process before editing |
| `<kbRepo>/src/server/trust-prompt-relay.ts` detection / response paths | OSS maintainers | Auto-response wrappers collapse the trust model (E-2) | Accept user consent through the UI only |
| `setting.json` redacted-by-default fields (current and future) | `setting-manager.ts` | Adding debug code that logs raw values leaks secrets (E-3) | Follow the masking conventions in KB's logging specification (no redacted fields are defined yet at v1.0) |

---

## §7 Alternative routes summary

A "what to do instead" cheat sheet covering the most common edits agents try.

| Want to do | Use | Don't |
|---|---|---|
| Modify settings (locale, displayName, etc.) | KB UI Settings page | Edit `.kovitoboard/setting.json` directly |
| Install / uninstall a recipe | KB UI Recipes page or `/api/recipes/*` | Modify `recipes-installed/<appId>/manifest.json` |
| Stop KB cleanly | `npm run kb:stop` | `kill -9` the supervisor PID |
| Inspect KB logs | Read `.kovitoboard/logs/current.log` | Truncate / redirect into the file |
| Adjust the `<kbRepo>/app` symlink | Restart the supervisor | `rm` the symlink and recreate it manually |
| Edit a bundled agent template | Copy to `<projectRoot>/.claude/agents/<id>.md`, then edit there | Edit `<kbRepo>/templates/agents/<name>.md` directly |
| Pin a Claude Code version | Use the version controls KB exposes (or at least respect KB's compatibility warnings) | Switch the binary to `@latest` / `@beta` without checking detection patterns |
| Run multiple KB instances on the same project | One supervisor per project root (M-1 refuses shared-installation launches) | Start a second `npm start` in another shell against the same project |
| Approve a trust prompt | KB UI's trust-prompt dialog | Post WebSocket frames to `/api/ws` directly |
| Add a custom API handler | Place it under `app/<appId>/api/*.ts` following the handler conventions | Mount a free-form Express router into KB |
| Inspect or rotate `_audit.log` | KB-managed rotation only | Truncate or hand-rotate the file |
| Disable the CLAUDE.md guidance block | Set `.kovitoboard/setting.json` `claudeMdGuidance.disabled = true` | Hand-edit inside `<!-- KB:GUIDANCE_START -->` (it gets re-injected) |

---

## Related chapters

- Agents → [`./02-agents.md`](./02-agents.md)
- Recipes → [`./04-recipes.md`](./04-recipes.md)
- Apps → [`./05-apps.md`](./05-apps.md)
- Troubleshooting → [`./06-troubleshooting.md`](./06-troubleshooting.md)
- Data handling → [`./09-data-handling.md`](./09-data-handling.md)
- Upgrading KB → [`./10-upgrade.md`](./10-upgrade.md)
