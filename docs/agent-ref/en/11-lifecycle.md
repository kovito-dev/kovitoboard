# 11. KovitoBoard Process Lifecycle

**Target KB version:** v0.2.10
**Last updated:** 2026-06-15
**Authoritative source:** [`../11-lifecycle.md`](../11-lifecycle.md) (Japanese)

> 📖 This chapter is a navigation layer. For detailed content, follow the section pointers below to the Japanese authoritative source. Agents may read the Japanese source directly and respond in English.

---

## Purpose

KovitoBoard's start / stop story is intentionally narrow: every supported entry point goes through the supervisor (`tools/kb-start.mjs`) and the cleaner (`tools/kb-stop.mjs`). This chapter defines the protocols for the three agent audiences — CLI users, project-side Claude Code agents, and KB-internal agents (which must never stop the KB hosting them).

## Sections (→ Japanese authoritative source)

- §1 The two official commands → [`../11-lifecycle.md`](../11-lifecycle.md) §1
- §2 Starting KB (agent protocol) → [`../11-lifecycle.md`](../11-lifecycle.md) §2
- §3 Stopping KB (agent protocol) → [`../11-lifecycle.md`](../11-lifecycle.md) §3
- §4 Multi-launch errors and stale PID files → [`../11-lifecycle.md`](../11-lifecycle.md) §4
- §5 Agents living inside KB must not stop KB → [`../11-lifecycle.md`](../11-lifecycle.md) §5
- §6 What `kb-stop` does and does not do → [`../11-lifecycle.md`](../11-lifecycle.md) §6
- §7 Common questions → [`../11-lifecycle.md`](../11-lifecycle.md) §7
- §8 Process-hygiene checklist (pre-flight / post-stop) → [`../11-lifecycle.md`](../11-lifecycle.md) §8

## English-specific notes

_None at v0.2.4. This section is reserved for English-locale-specific guidance (e.g., English-only supervisor banner strings) that does not belong in the authoritative Japanese source._

---

## Related chapters

- Protected paths (runtime state, PID file, tmux session) → [`./12-protected-paths.md`](./12-protected-paths.md)
- KB self-restart is forbidden → [`./10-upgrade.md`](./10-upgrade.md) §7
- Troubleshooting → [`./06-troubleshooting.md`](./06-troubleshooting.md)
