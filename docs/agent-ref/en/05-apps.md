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

---

## 11. Capture state survival across restart (v0.2.x)

**Target KB version:** v0.2.x onwards (spec `app-directory-extension.md` §10.5.6).

Recipes that use `window.kb.capture.<kind>` (a11y / exposed-context) MUST treat React state and other in-memory UI state as **lossy across restart-triggered reload events**. A KovitoBoard process restart (SIGUSR2 / Quit & relaunch) invalidates the per-launch internal token; the host renderer detects the resulting 401 from the capture-token endpoints, rejects every in-flight capture Promise with `RestartReloadError`, and triggers `window.location.reload()`.

### Required pattern: persist + re-hydrate

Capture work must be re-runnable from durable state. The recommended pattern is:

```typescript
// Persist any critical state BEFORE issuing the capture call.
async function capturePageA11y() {
  await window.kb.call('data:write', {
    path: '_state.json',
    content: JSON.stringify(currentState),
  })
  try {
    const snapshot = await window.kb.capture.a11y()
    return snapshot
  } catch (e) {
    if (e instanceof Error && e.name === 'RestartReloadError') {
      // KB will reload momentarily; state is already persisted, so
      // the re-mounted page will pick up from where the capture left
      // off. Returning silently lets the reload run.
      return
    }
    throw e
  }
}

// Re-hydrate on next mount.
useEffect(() => {
  async function rehydrate() {
    const persisted = await window.kb.call('data:read', { path: '_state.json' })
    if (persisted) setState(JSON.parse(persisted))
  }
  void rehydrate()
}, [])
```

### What the host promises

- Pending capture Promises are rejected with `RestartReloadError` **before** the reload fires.
- The reload is scheduled with `setTimeout(..., 0)` so the rejection handlers run first.
- Recipe authors do **not** need to attach manual reload triggers — the host handles the navigation.

### What recipe authors must NOT assume

- React state across the reload (it is wiped).
- That the same `mountId` / capture token will exist post-reload (both are fresh per mount).
- Scroll position, modal open/closed state, expanded panels (all gone on reload).

v0.3.0 isolation work will revisit state preservation (Service Worker / out-of-process renderer paths under design); until then, persist anything you cannot reconstruct from server-side state.

