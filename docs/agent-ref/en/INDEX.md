# KovitoBoard Reference (for Agents) — English

**Target KB version:** v0.1.0
**Last updated:** 2026-04-18
**Role:** Navigation layer. Detailed content lives in the Japanese authoritative source at [`../INDEX.md`](../INDEX.md).

> ℹ️ **About this tree:** `docs/agent-ref/en/` is a **navigation layer**, not a translation. Each chapter here provides English section titles and pointers into the Japanese authoritative source (`docs/agent-ref/`). Agents reading this tree should follow the pointers and read the Japanese detailed content directly — Claude can read Japanese and respond in English without loss.
>
> This design keeps detailed information in one place (the Japanese source), avoiding spec drift between languages. English-locale-specific notes (UI labels, common English-speaker confusions) may be added to each chapter's "English-specific notes" section when needed.

---

This document is the entry point that Kovito's Concierge "Kobi" and other agents consult when answering English-speaking users' questions about KovitoBoard (KB).

---

## Reference Rules (for Agents)

1. First, use the "Navigate by what you want to do" section below to identify the relevant chapter.
2. Read the English chapter file for the navigation and any English-specific notes.
3. Follow the pointer(s) to the Japanese authoritative source and Read that section for the actual content.
4. Respond to the user in English.
5. **Never read all chapters at once.** (Context-overload prevention.)
6. If the pointed-to section doesn't answer the question, do not guess. Say "I don't know — let's look into this together" and ask the user.

---

## Navigate by what you want to do

### 🔰 I'm new to KB / I want the big picture
→ [`01-overview.md`](./01-overview.md)

### 🤖 Agents
- Add a new agent → [`02-agents.md`](./02-agents.md) §3
- Change an agent's name / personality → [`02-agents.md`](./02-agents.md) §4
- Change an agent's avatar image → [`02-agents.md`](./02-agents.md) §5
- An agent isn't showing up → [`06-troubleshooting.md`](./06-troubleshooting.md) §2

### 💬 Sessions (conversations with an agent)
- Start a session → [`03-sessions.md`](./03-sessions.md) §2
- View past session history → [`03-sessions.md`](./03-sessions.md) §4
- The session isn't progressing → [`06-troubleshooting.md`](./06-troubleshooting.md) §3
- I'm being asked for a trust prompt → [`06-troubleshooting.md`](./06-troubleshooting.md) §7

### 📦 Recipes
- What is a recipe → [`04-recipes.md`](./04-recipes.md) §1
- Install an external recipe → [`04-recipes.md`](./04-recipes.md) §2
- A recipe is asking for scope approval → [`04-recipes.md`](./04-recipes.md) §7
- Export something I built as a recipe → [`04-recipes.md`](./04-recipes.md) §4
- Use an official recipe → [`04-recipes.md`](./04-recipes.md) §5
- A recipe won't load → [`06-troubleshooting.md`](./06-troubleshooting.md) §4

### 🛠️ Custom app development
- Build my own app → [`05-apps.md`](./05-apps.md) §2
- Structure of the `app/` directory → [`05-apps.md`](./05-apps.md) §3
- Add a custom API handler → [`05-apps.md`](./05-apps.md) §4
- Difference between user-defined backend API and recipes → [`05-apps.md`](./05-apps.md) §5

### ⚙️ Settings
- Change master info (user name, etc.) → [`01-overview.md`](./01-overview.md) §4
- Change the project name → [`01-overview.md`](./01-overview.md) §4

### 🚨 Troubleshooting
→ [`06-troubleshooting.md`](./06-troubleshooting.md)

### 🎓 I want to go deeper (advanced)
→ [`07-advanced.md`](./07-advanced.md)

---

## Chapter list (navigation layer)

| File | Content | Authoritative source |
|---|---|---|
| [`01-overview.md`](./01-overview.md) | KB overview, glossary, settings basics | [`../01-overview.md`](../01-overview.md) |
| [`02-agents.md`](./02-agents.md) | Adding / editing agents, avatar images | [`../02-agents.md`](../02-agents.md) |
| [`03-sessions.md`](./03-sessions.md) | Starting sessions, interacting, history | [`../03-sessions.md`](../03-sessions.md) |
| [`04-recipes.md`](./04-recipes.md) | Recipe loading, execution, history, export | [`../04-recipes.md`](../04-recipes.md) |
| [`05-apps.md`](./05-apps.md) | Using `app/`, custom app development | [`../05-apps.md`](../05-apps.md) |
| [`06-troubleshooting.md`](./06-troubleshooting.md) | Common problems and fixes | [`../06-troubleshooting.md`](../06-troubleshooting.md) |
| [`07-advanced.md`](./07-advanced.md) | Skills, automation, advanced settings | [`../07-advanced.md`](../07-advanced.md) |

---

## External documents (outside the scope of this reference)

- **KB usage guide (getting started):** Before public release, see `README.md` at the KB repository root (as of v0.1.0).
- **Recipe catalog:** Not publicly available in v0.1.0. Bundled official recipes are listed in [`04-recipes.md`](./04-recipes.md) §5.
- **Blog / articles:** Planned after release (Kovito official).

---

## About the agent's own behavior

- Always read this INDEX first and then move to the matching chapter.
- Follow the chapter's section pointers into the Japanese authoritative source for detailed content.
- If the content doesn't answer the question, be honest — don't guess.
- Do not edit the user's `.claude/` or `CLAUDE.md` without explicit consent (and even with consent, confirm carefully).
- If KB specs and implementation may have drifted, check the top of the Japanese INDEX for a "⚠️ Needs update" note.

---

## Revision history

| Version | Date | Change | Author |
|---|---|---|---|
| v0.1 | 2026-04-18 | Initial English skeleton (C4) as summary-style | architect |
| v0.2 | 2026-04-18 | Redefined as navigation layer. Details delegated to Japanese authoritative source | architect |
