[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

# Changelog

All notable changes to KovitoBoard will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The ambient sidebar now uses its width more efficiently: the session
  label moved into the header, and the pin control became a compact icon
  next to the agent picker, leaving more room for the conversation.
- The ambient sidebar's message composer now bottom-aligns its controls
  with the input field, removing the slight vertical offset between them.

## [0.2.4] - 2026-06-11

A maintenance patch with localization and display fixes, a browser
favicon, and documentation updates.

### Added

- A browser favicon, so KovitoBoard is recognizable in browser tabs and
  bookmarks.

### Changed

- Primary tested Claude Code version raised to 2.1.153 (`@stable`
  channel), following Anthropic's `@stable` dist-tag.

### Fixed

- The "Add Agent" template picker now shows template descriptions in the
  active display language. Previously, in English mode, it displayed
  Japanese descriptions.
- Agent descriptions are no longer lost from the agent list after
  creating an agent from a template.
- The Settings "Basic" tab footer now correctly states that changes take
  effect after reloading the page (it previously said changes apply
  immediately after saving).

### Documentation

- Renamed the "Session Monitor" feature to "Live Sessions" and clarified
  that it is interactive — you can chat with running sessions, share
  images and files, and resume or continue them, not just watch.
- Added guidance for restarting KovitoBoard (next day, after stopping, or
  after a reboot) and for starting it automatically on boot.
- Updated the Path A heading wording to "no terminal needed".

## [0.2.3] - 2026-06-07

A maintenance patch: a localization fix and a security dependency update.

### Fixed

- The Document Viewer sample app now shows file modification dates in
  the active display language. Previously the dates were always
  formatted in US English regardless of the selected language.

### Security

- Updated the bundled `react-router-dom` to 7.17.0, clearing two
  upstream High advisories (GHSA-49rj-9fvp-4h2h, GHSA-8x6r-g9mw-2r78).
  Both affect React Router's framework-mode server only; KovitoBoard
  uses React Router client-side in declarative (`<BrowserRouter>`)
  mode, so it was not exploitable. The update is applied as dependency
  hygiene.

## [0.2.2] - 2026-05-31

Localization fixes for the bundled sample apps and a small visual
polish.

### Fixed

- Recipe-based sample apps now show their navigation menu labels and
  in-app text in the active display language. Previously the bundled
  Document Viewer displayed Japanese labels and text even when
  KovitoBoard was set to English.
- The "open folder" icon in the Document Viewer's file tree is now
  clearly visible; it previously appeared faint compared to the
  closed-folder icon.

## [0.2.1] - 2026-05-30

User-facing improvements from a full manual UX pass, plus security
hardening ahead of the public release.

### Added

- Bundled sample apps can now be enabled and disabled directly, without
  going through the recipe install flow. The Apps screen is reorganized
  into a three-tab layout (Apps / Sample Apps / Recipes) with
  drag-and-drop ordering that persists.
- The Document Viewer sample app now renders HTML files in addition to
  Markdown, shows an icon-based file tree in the left pane, and has
  visible scrollbars in both panes.
- Governance files for external contributors: pull-request and issue
  templates, `CODEOWNERS`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and a
  "For External Contributors" section in `CONTRIBUTING.md`.
- The Apps screen now shows a hint that apps can be reordered by drag
  and drop.

### Changed

- Work Roots moved from a standalone sidebar item into a tab in the
  Settings modal.
- Agents created from KovitoBoard templates now include structured
  field markers by default, so their personality, tone, and extra
  instructions are editable right away.
- The recipe export refusal message (for apps with server-side `api/`
  code) is now action-first and avoids internal jargon, making it
  clearer how to make an app distributable.
- The "Code-trusted (bundled)" trust badge is now placed at the
  top-right of the app view.

### Fixed

- The per-app three-dot menu (export recipe / disable) no longer renders
  off the right edge of the window where it could not be used.
- Session input area: the attach and send buttons now align with the
  text area, the text-area scrollbar appears only when needed, and the
  Ambient sidebar input no longer opens oversized on first display.

### Security

- The Document Viewer now renders untrusted HTML inside a sandboxed
  iframe (a separate, script-less, opaque-origin browsing context) so
  that hostile inline styles cannot overlay or spoof the host UI,
  including trust prompts.
- Hardened the Content-Security-Policy (`base-uri`, `object-src`,
  `form-action`, `frame-ancestors`), menu page path resolution, an
  upload write race, and YAML parser denial-of-service handling.
- Strengthened the `.git` directory exclusion against bare-repository,
  case-insensitive, and Unicode-variant bypass attempts.
- Updated `ws` to 8.21.0 and `qs` to 6.15.2 to resolve
  CVE-2026-45736 and CVE-2026-8723.
- Removed the maintainer's personal email from the governance docs;
  security reports are now handled through GitHub's private
  vulnerability reporting.

## [0.2.0] - 2026-05-26

Security and design hardening release. Adds protected-path reference,
CLAUDE.md guidance pointer, process lifecycle commands, capture API
opt-in, recommended settings check, trust marker UI, Rule of Two
warning, and temporarily disables recipe install pending the KovitoHub
signed-only model planned for v0.3.0.

### Added — Protected-paths reference and CLAUDE.md guidance pointer

- `docs/agent-ref/12-protected-paths.md` lists every KB-managed path
  and the proper API/UI/CLI route to use instead of editing it
  directly.
- After onboarding, KovitoBoard appends a one-line pointer to
  `<projectRoot>/CLAUDE.md` between
  `<!-- KB:GUIDANCE_START --> ... <!-- KB:GUIDANCE_END -->` markers so
  Claude Code agents in the project know to consult
  `kovitoboard/docs/agent-ref/INDEX.md` for KB-related tasks.
- The block is auto-managed; KovitoBoard will not re-inject it if you
  delete the markers. To skip the injection entirely set
  `claudeMdGuidance.disabled = true` in `.kovitoboard/setting.json`
  before running onboarding.

### Added — Process lifecycle commands

- `npm run kb:stop` for graceful shutdown including tmux session
  cleanup and residual process diagnostics.
- Multi-launch refusal via
  `<projectRoot>/.kovitoboard/run/supervisor.pid` with stale-detection
  fallback.
- Startup preflight checks for tmux 3.4+, Node.js, and Claude CLI.
- `docs/agent-ref/11-lifecycle.md` documents the start / stop
  protocol for agents acting on behalf of KovitoBoard users.

### Changed — Shared installation prevention

- KovitoBoard now refuses to start when invoked from inside the KB
  clone itself without an explicit `--project-root` (or
  `KOVITOBOARD_PROJECT_ROOT`). Use the embedded deployment model
  documented in README.md.
- The cwd-fallback path now logs a warning and surfaces a
  confirmation in the UI when invoked, since it is treated as an
  exceptional path.

### Added — Capture API opt-in mechanism for a11y / exposed-context

- Recipe apps that use `window.kb.capture.snapshot()` (accessibility
  tree walker) or `window.kb.exposeContext()` now require explicit
  opt-in approval at install time. The recipe manifest declares
  `captureRequires: ['a11y' | 'exposed-context']`, and the install
  warning dialog surfaces a per-kind approval section that the user
  must explicitly check.
- A trusted-host-mediated identity model (per-mount capture tokens
  issued by KB and never exposed to recipe code) replaces body-based
  appId trust.
- Grandfather behavior: existing recipes installed before v0.2.0
  retain capture access without re-approval (`captureRequires: []`).

### Added — Claude Code recommended settings check at startup / onboarding

- On startup, KovitoBoard inspects the merged Claude Code settings
  (`~/.claude/settings.json` + project-local `.claude/settings.json`)
  and warns when any of three recommended settings is missing:
  `permissionMode` is not `default`/`acceptEdits`/`plan`, the
  `.kovitoboard/` deny pattern is absent from `permissions.deny`, or
  bypass mode is active.
- Warnings surface as a toast for onboarded users (24h dismiss
  cooldown, drift detection invalidates the dismiss) and as an
  inline Security step in the onboarding wizard for first-time
  users. Per-item acknowledge UI prevents rubber-stamp approval.
- The settings file is watched at runtime via `fs.watch`; mutations
  trigger a re-check. Settings paths are redacted (home masking +
  credential redaction) before logging.

### Added — Trust marker UI and Rule of Two warning

- 5-level trust vocabulary indicators in the trust prompt UI with
  preamble warning surfacing potential prompt injection patterns.
- Warning toast and onboarding step when Claude Code Rule of Two
  bypass mode is active, with onboarding gate requiring per-item
  acknowledgment.

### Changed — Recipe install temporarily disabled

- New recipe install via `/api/recipes/install` is **disabled** in
  this release. The endpoint returns 410 Gone, and the install button
  in the UI is hidden / disabled with a "Coming in v0.3.0 with
  KovitoHub" notice.
- Existing recipes installed in v0.1.x or v0.2.0 continue to work
  unchanged (grandfathered). View, uninstall, and export flows are
  preserved.
- KovitoBoard's recipe distribution is moving to a signed-only model
  via KovitoHub (publisher signing + central marketplace, planned
  for v0.3.0). A developer sideload mode (opt-in via
  `KB_DEVELOPER_MODE=1`) is also planned for v0.3.0.
- See `README.md` "Recipe distribution model" section for the
  broader rationale.

### Security

- Per-launch auth token for HTTP API and WebSocket upgrade
- Backend and Vite dev server bound to 127.0.0.1
- Mark-installed gated behind a one-shot install-session nonce
- Dispatcher resolved path threaded through HandlerContext (TOCTOU)
- Anthropic API key / JWT redaction in structured log records
- Migrate direct console.* calls to pino-backed loggers
- Refuse recipe export when app contains custom backend files
- Atomic write helper for JSON stores
- Safety boundary + trusted-code model in install warning dialog
- Serialize handler dispatch per appId
- `/api/artifact` exclusion list + size cap
- Recipe export appId path-traversal defense
- DoS limits at recipe-parser entry
- Artifact-path traversal rejection at recipe parser
- WebSocket heartbeat with dead-connection termination
- `KOVITOBOARD_E2E_TMUX_SESSION` gated behind `KB_E2E_MODE`
- Operation-aware exclusion for recipe scope validator
- cwd allow-list gate for spawn / tmux consumers
- tmux `sendViaBuffer` tmpfile 0600 + O_EXCL
- Server-side catch envelope redaction
- Server-side dedup ledger for trust prompt respond races
- Legacy anchor detection removal
- Agent-ref install / `kb-stop --all` path hardening

### Notes

- Several install-flow hardening items (install verdict trust, recipe
  hash scope, Expand All review gate, KH registration warning,
  install preview) are deferred to v0.3.0 because the install
  endpoint is disabled in v0.2.0; they will be re-evaluated under the
  signed-only model.
- v0.2.0 remains private (closed). Public landing page updates
  planned for v0.2.1.

### Migration notes

#### Shared installation refusal (formerly silent fallback)

Starting `npm run dev` from inside the KovitoBoard clone now exits
with ERROR. Use `npm start -- --project-root <path-to-claude-code-project>`
or set `KOVITOBOARD_PROJECT_ROOT`. Contributors developing the
KovitoBoard codebase should pass the project root explicitly.

#### Stopping KovitoBoard

Use `npm run kb:stop` instead of `Ctrl+C` for clean shutdown of
supervisor, tmux session, and Vite dev server. Ctrl+C still works
for contributors.

#### Recipe install temporarily disabled (existing recipes grandfathered)

Recipe install via `/api/recipes/install` is disabled in v0.2.0. The
install button in the UI is hidden / disabled with a "Coming in
v0.3.0 with KovitoHub" notice.

- **Existing recipes** installed in v0.1.x or v0.2.0 continue to
  work unchanged. No action is required.
- **New recipe install** is unavailable until v0.3.0.
- **For developers** who need to test or develop recipes locally, a
  developer sideload mode (opt-in via `KB_DEVELOPER_MODE=1`) is
  planned for v0.3.0.
- See `README.md` "Recipe distribution model" section for the
  broader rationale.

#### tmux 3.4+ requirement

Startup preflight check now enforces tmux 3.4+. Earlier versions
exit with a clear error message and remediation steps. Upgrade tmux
to 3.4 or later before running v0.2.0.

## [0.1.1] - 2026-05-06

Validation release for the self-update detection and agent-driven upgrade flow.
No new features — minor i18n wording adjustments to provide a known surface
for upgrade-time merge handling.

### Changed

- `onboarding.welcome.subtitle`: rephrased the welcome subtitle on the
  onboarding screen (`src/renderer/i18n/{ja,en}.ts`).
- `ambientSidebar.placeholder`: rephrased the empty-state hint shown in the
  ambient session sidebar (`src/renderer/i18n/{ja,en}.ts`).
- `version.loadFailed`: rephrased the error message displayed when version
  information cannot be loaded (`src/renderer/i18n/{ja,en}.ts`).

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
