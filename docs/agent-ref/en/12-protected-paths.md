# 12. Protected Paths

**Target KB version:** v0.2.10
**Last updated:** 2026-06-15
**Authoritative source:** [`../12-protected-paths.md`](../12-protected-paths.md) (Japanese)

> 📖 This chapter is a navigation layer. For detailed content, follow the section pointers below to the Japanese authoritative source. Agents may read the Japanese source directly and respond in English.

---

## Purpose

KovitoBoard manages a set of files, runtime state, and external preconditions that agents must not edit directly. Direct edits can cause data loss, runtime corruption, silent failures, or security-boundary violations. This chapter lists every protected path with its owner, why direct edits are forbidden, and the proper API/UI/CLI route to use instead. It is the public-facing source of truth that KB-bundled agents and any non-KB agent invoked inside a KB project should consult before touching the listed paths.

## Sections (→ Japanese authoritative source)

- §1 Why KB has protected paths → [`../12-protected-paths.md`](../12-protected-paths.md) §1
- §2 KB-managed files (do not edit directly) → [`../12-protected-paths.md`](../12-protected-paths.md) §2
- §3 External preconditions KB depends on → [`../12-protected-paths.md`](../12-protected-paths.md) §3
- §4 Runtime state during KB operation → [`../12-protected-paths.md`](../12-protected-paths.md) §4
- §5 User customization, recipes, and apps → [`../12-protected-paths.md`](../12-protected-paths.md) §5
- §6 Security boundaries → [`../12-protected-paths.md`](../12-protected-paths.md) §6
- §7 Alternative routes summary → [`../12-protected-paths.md`](../12-protected-paths.md) §7

## English-specific notes

_None at v0.2.4. This section is reserved for English-locale-specific guidance that does not belong in the authoritative Japanese source._

---

## Related chapters

- Agents → [`./02-agents.md`](./02-agents.md)
- Recipes → [`./04-recipes.md`](./04-recipes.md)
- Apps → [`./05-apps.md`](./05-apps.md)
- Troubleshooting → [`./06-troubleshooting.md`](./06-troubleshooting.md)
- Data handling → [`./09-data-handling.md`](./09-data-handling.md)
- Upgrading KB → [`./10-upgrade.md`](./10-upgrade.md)
- Process lifecycle → [`./11-lifecycle.md`](./11-lifecycle.md)
