# 04. Recipes

**Target KB version:** v0.2.4
**Last updated:** 2026-06-11
**Authoritative source:** [`../04-recipes.md`](../04-recipes.md) (Japanese)

> 📖 This chapter is a navigation layer. For detailed content, follow the section pointers below to the Japanese authoritative source. Agents may read the Japanese source directly and respond in English.

---

## Purpose

Give the user a working understanding of the recipe system: what a recipe is, how to enable a bundled sample recipe, how to export their own work as a recipe, which recipes KB ships with, and how the declarative handler model plus scope approval keep recipes safe.

> 🛑 **Important v0.2.x precondition:** **External recipe install is disabled in v0.2.x** (`/api/recipes/install` and `/api/recipes/apply` both return 410 Gone). It is planned to return in **v0.3.0 with KovitoHub** (signed publisher model). In v0.2.x you can only enable **bundled sample recipes** (Document Viewer / TODO) from the **Sample apps tab** on the Apps screen, plus view / disable / export already-installed recipes. Do **not** tell users they can install external recipes right now (see §2).

## Sections (→ Japanese authoritative source)

- §1 What a recipe is → [`../04-recipes.md`](../04-recipes.md) §1
- §2 Loading an external recipe (disabled in v0.2.x — coming in v0.3.0 with KovitoHub) → [`../04-recipes.md`](../04-recipes.md) §2
- §3 Running a recipe and viewing history → [`../04-recipes.md`](../04-recipes.md) §3
- §4 Exporting your own work as a recipe (apps with `api/` are refused, §4.3) → [`../04-recipes.md`](../04-recipes.md) §4
- §5 Official sample recipes (Document Viewer, TODO — enable from the Sample apps tab) → [`../04-recipes.md`](../04-recipes.md) §5
- §6 The declarative handler model (overview) → [`../04-recipes.md`](../04-recipes.md) §6
- §7 Scope and approval → [`../04-recipes.md`](../04-recipes.md) §7
- §8 Recipe troubleshooting → [`../04-recipes.md`](../04-recipes.md) §8

## English-specific notes

- **Recipes tab banner (v0.2.x):** The Recipes tab shows "Coming in v0.3.0 with KovitoHub" — "Install signed recipes from KovitoHub. Each recipe is verified by the publisher and audited by KovitoBoard." This is a preview of a future feature; no external install happens in v0.2.x.
- **Apps screen tabs:** Apps / Sample apps / Recipes. Bundled samples are enabled/disabled from **Sample apps**; disabling a sample is non-destructive (its `app/data/<appId>/` is kept).
- **Export refusal:** an app containing `app/<appId>/api/` cannot be exported as a recipe (HTTP 400 `CustomBeNotExportable`); the UI shows an action-first message offering two paths (rewrite as declarative `api.calls`, or document the server-side logic for post-install implementation).

---

## Related chapters

- Apps (`app/`) — for full-power extensions that recipes can't express → [`./05-apps.md`](./05-apps.md)
- **Emitting logs from recipe pages** → [`./08-logging.md`](./08-logging.md) §4 (`window.kb.log`)
- Recipe failures → [`./06-troubleshooting.md`](./06-troubleshooting.md) §4
