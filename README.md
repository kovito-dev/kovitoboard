# KovitoBoard

Self-extending AI agent team system that runs on Claude Code.
Build and extend your own business automation system through dialogue alone.

日本語: 自己拡張型 AI エージェントチームシステム。Claude Code 上で動作し、
対話だけで自分専用の業務システムを構築・拡張できます。

## Status

Pre-release. Under active development. APIs and file layouts may change
without notice until the first tagged release.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (latest)
- Node.js 20 or later
- tmux

## Installation

To be published on the first tagged release.

## Usage

KovitoBoard is **not a Claude Code project itself**. It is a regular program
that is installed into an existing Claude Code project, where it generates
and manages agent definitions, tasks, and UI assets.

Detailed usage will be documented at the first tagged release.

## Repository Layout

```
src/         Core runtime
templates/   Project templates (agents, UI, config)
scripts/     Generation and utility scripts
tests/       Test suites
docs/specs/  Public-facing specifications
```

## Development

This repository contains only program source code, templates, tests, and
scripts. Development artifacts — agent definitions, session logs, design
specs, and fixtures — live in a separate private repository and are
synchronized into this repo only when publishable.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
