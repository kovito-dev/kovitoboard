[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

# Changelog

All notable changes to KovitoBoard will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-05

Initial release (closed beta).

### Added

- Onboarding 5-step flow with concierge agent (Kobi) auto-provisioning
- Recipe install / re-install / export flow with declarative scope contracts
  (DEC-006 v2.0)
- Custom app creation and removal lifecycle (EU9)
- Ambient session sidebar with screen-context awareness
- Trust prompt UI relay (folder-trust / Write / Edit / Bash patterns)
- Persistent logging (pino, JSON Lines, daily rotation, 7-day retention) and
  `npm run diagnose` Markdown report
- Agent reference docs (`docs/agent-ref/`, 9 chapters Japanese + English
  pointers)
- Server health UI (status indicator + popover, 5s polling)
- Version display (KB version, Claude Code version with tier, update check)
- Full Japanese / English i18n

### Notes

- Closed beta release. Public announcement and landing page updates planned
  for v0.2.1.
