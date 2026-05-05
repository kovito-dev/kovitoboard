# 05. Custom App Development (`app/`)

**Target KB version:** v0.1.0
**Last updated:** 2026-05-03
**Authoritative source:** [`../05-apps.md`](../05-apps.md) (Japanese)

> 📖 This chapter is a navigation layer. For detailed content, follow the section pointers below to the Japanese authoritative source. Agents may read the Japanese source directly and respond in English.

---

## Purpose

Introduce the `app/` extension area: what it is, how to add a page or a custom backend API, how it differs from recipes, and how to export work from `app/` into a portable recipe. `app/` is the **full-power** area — the user is responsible for what runs there.

## Sections (→ Japanese authoritative source)

- §1 What the `app/` directory is → [`../05-apps.md`](../05-apps.md) §1
- §2 Building your own app — the flow → [`../05-apps.md`](../05-apps.md) §2
- §3 Structure of `app/` → [`../05-apps.md`](../05-apps.md) §3
- §4 Adding an API handler (user-defined backend API) → [`../05-apps.md`](../05-apps.md) §4
- §5 How `app/` differs from recipes → [`../05-apps.md`](../05-apps.md) §5
- §6 Exporting `app/` work as a recipe → [`../05-apps.md`](../05-apps.md) §6
- §7 Example: a lightweight Intel-style viewer app → [`../05-apps.md`](../05-apps.md) §7
- §8 Long-running BE app pattern (job queue + polling) → [`../05-apps.md`](../05-apps.md) §8
- §9 Publishing internal state to the Ambient Sidebar (`window.kb.exposeContext`, β-method) → [`../05-apps.md`](../05-apps.md) §9
- §10 Removing an app (NavMenu remove button, agent-led deletion) → [`../05-apps.md`](../05-apps.md) §10

## English-specific notes

_None at v0.1.0. This section is reserved for English-locale-specific guidance (English page naming conventions, English route path examples, etc.) that does not belong in the authoritative Japanese source._

---

## Related chapters

- Recipes (for comparison) → [`./04-recipes.md`](./04-recipes.md)
- **Logging from API handlers and pages** → [`./08-logging.md`](./08-logging.md) (server: `globalThis.kbContext.logger` / renderer: `window.kb.log`)
- Advanced topics → [`./07-advanced.md`](./07-advanced.md)
