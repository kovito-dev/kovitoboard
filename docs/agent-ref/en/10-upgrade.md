# 10. Upgrading KovitoBoard

**Target KB version:** v0.2.9
**Last updated:** 2026-06-15
**Authoritative source:** [`../10-upgrade.md`](../10-upgrade.md) (Japanese)

> 📖 This chapter is a navigation layer. For detailed content, follow the section pointers below to the Japanese authoritative source. Agents may read the Japanese source directly and respond in English.

---

## Purpose

KB upgrades differ from typical npm-package or distributed-binary upgrades because (1) KB is git-clone-based, (2) user assets (`app/`, `recipes/`, `.kovitoboard/`) live inside the same working directory, and (3) recipes depend on the core handler set. This chapter defines the safe upgrade procedure and the protocol agents should follow when asked to upgrade KB.

## Sections (→ Japanese authoritative source)

- §1 Why KB upgrades differ from traditional software → [`../10-upgrade.md`](../10-upgrade.md) §1
- §2 Pre-upgrade checks → [`../10-upgrade.md`](../10-upgrade.md) §2
- §3 Standard upgrade flow → [`../10-upgrade.md`](../10-upgrade.md) §3
- §4 Resolving conflicts → [`../10-upgrade.md`](../10-upgrade.md) §4
- §5 Post-upgrade integrity checks → [`../10-upgrade.md`](../10-upgrade.md) §5
- §6 Rolling back → [`../10-upgrade.md`](../10-upgrade.md) §6
- §7 Protocol for user-side agents → [`../10-upgrade.md`](../10-upgrade.md) §7

## English-specific notes

_None at v0.1.0. This section is reserved for English-locale-specific guidance (e.g., English release-note conventions or English-only error messages from `git`) that does not belong in the authoritative Japanese source._

---

## Related chapters

- Protecting user-built apps → [`./05-apps.md`](./05-apps.md) §1.1
- Warning about direct `src/` modification → [`./05-apps.md`](./05-apps.md) §1.1.1
- Verifying recipes after upgrade → [`./04-recipes.md`](./04-recipes.md)
- Log verification → [`./08-logging.md`](./08-logging.md)
- Troubleshooting → [`./06-troubleshooting.md`](./06-troubleshooting.md)
