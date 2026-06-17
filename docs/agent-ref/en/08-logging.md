# 08. Logging Conventions

**Target KB version:** v0.2.10
**Last updated:** 2026-06-15
**Authoritative source:** [`../08-logging.md`](../08-logging.md) (Japanese)

> 📖 This chapter is a navigation layer. For detailed content, follow the section pointers below to the Japanese authoritative source. Agents may read the Japanese source directly and respond in English.

---

## Purpose

How to emit logs from user-extension code (custom `app/api/*.ts` handlers, recipe pages) using KB's unified logging mechanism, so that user-environment agents (Kovito Developer, Kovi, etc.) can diagnose user-extension behavior from a single `.kovitoboard/logs/server.log`.

## Sections (→ Japanese authoritative source)

- §1 KB logging mechanism overview → [`../08-logging.md`](../08-logging.md) §1
- §2 component naming convention (3 systems: `server.*` / `client.*` / `app.<name>.*`) → [`../08-logging.md`](../08-logging.md) §2
- §3 Server-side handler logging (`globalThis.kbContext.logger`) → [`../08-logging.md`](../08-logging.md) §3
- §4 Renderer-side recipe page logging (`window.kb.log`) → [`../08-logging.md`](../08-logging.md) §4
- §5 Log level usage guidelines → [`../08-logging.md`](../08-logging.md) §5
- §6 PII / sensitive information handling → [`../08-logging.md`](../08-logging.md) §6
- §7 Sample implementation (`app.example/research-reports/`) → [`../08-logging.md`](../08-logging.md) §7
- §8 Troubleshooting reference → [`../08-logging.md`](../08-logging.md) §8

## English-specific notes

_None at v0.1.0. The component naming convention (`server.*` / `client.*` / `app.<name>.*`) and log level vocabulary (`debug` / `info` / `warn` / `error`) are language-neutral. Recipe authors can write log messages in English when developing for a non-Japanese audience._

---

## Related chapters

- Custom app development → [`./05-apps.md`](./05-apps.md)
- Recipe system → [`./04-recipes.md`](./04-recipes.md)
- Troubleshooting and log references → [`./06-troubleshooting.md`](./06-troubleshooting.md)
