/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { MessageKey } from './ja'

/** English message catalog */
const en: Record<MessageKey, string> = {
  // Onboarding
  'onboarding.welcome.title': 'Welcome to KovitoBoard (KB)',
  'onboarding.welcome.subtitle': 'Build your dedicated AI agent team',
  'onboarding.welcome.intro': 'KovitoBoard is a local, open-source web app that lets you drive Claude Code from your browser. Run agent sessions, build your own pages, or install external apps (recipes).',
  'onboarding.welcome.language': 'Choose your language',
  'onboarding.user.title': 'Tell us about yourself',
  'onboarding.user.displayName': 'Display name',
  'onboarding.user.displayNamePlaceholder': 'Enter your name',
  'onboarding.user.avatar': 'Avatar',
  'onboarding.project.title': 'Basic information',
  'onboarding.project.name': 'Application title',
  'onboarding.project.namePlaceholder': 'Enter the application title',
  'onboarding.project.description': 'Subtitle',
  'onboarding.project.descriptionPlaceholder': 'Enter the subtitle',
  'onboarding.concierge.title': 'Add Kobi as your concierge?',
  'onboarding.concierge.confirm': 'Would you like to add "Kobi", the Kovito Concierge, as an agent?',
  'onboarding.concierge.description': 'Guides you through KB and handles simple development tasks.',
  'onboarding.concierge.benefits.title': 'What Kobi will help you with',
  'onboarding.concierge.benefit.1': 'Install and remove app recipes',
  'onboarding.concierge.benefit.2': 'Adjust basic settings on your behalf',
  'onboarding.concierge.benefit.3': 'Walk you through KB whenever you need a hand',
  'onboarding.concierge.benefit.4': 'Help when KB hits an error or other trouble',
  'onboarding.concierge.benefit.5': 'Be the first agent to ask when you are stuck',
  'onboarding.concierge.skipNote': 'You can add Kobi later, but the initial setup goes more smoothly with Kobi at your side.',
  'onboarding.concierge.add': 'Add (Recommended)',
  'onboarding.concierge.skip': 'Add later',
  'onboarding.concierge.adding': 'Adding...',
  'onboarding.complete.title': 'All set!',
  'onboarding.complete.description': 'KovitoBoard is ready to go.',
  'onboarding.complete.talkToKobi': 'Talk to Kobi',
  'onboarding.complete.goToAgents': 'Go to agents',
  'onboarding.complete.preparing': 'Preparing...',
  'onboarding.complete.skipClaudeMdGuidance': 'Skip CLAUDE.md guidance injection',
  'onboarding.complete.skipClaudeMdGuidanceHint': "When checked, KovitoBoard will not write a guidance block into your project's CLAUDE.md. Choose this if you manage CLAUDE.md yourself.",
  'onboarding.welcome.start': 'Get Started',
  'onboarding.user.avatarHint': 'Avatar image (optional, max 1MB)',
  'onboarding.user.avatarSizeError': 'File size exceeds 1MB',
  'onboarding.user.displayNameRequired': 'Display name is required',
  'onboarding.user.displayNameMaxLength': 'Display name must be 30 characters or less',
  'onboarding.project.nameRequired': 'Application title is required',
  'onboarding.project.nameMaxLength': 'Application title must be 50 characters or less',
  'onboarding.project.descriptionMaxLength': 'Subtitle must be 500 characters or less',
  'onboarding.project.path': 'Project path',
  'onboarding.project.pathNote': 'To use a different location, restart the server in the desired directory.',
  'onboarding.next': 'Next',
  'onboarding.back': 'Back',
  'onboarding.step': 'Step {current} / {total}',
  // Phase 1 prompt injection ② Claude Code recommended settings
  // (handoff v1.1 §3.4 / §3.7, onboarding-scenarios §9.5.2)
  'onboarding.security.title': 'Security recommendations',
  'onboarding.security.subtitle': 'Review the recommended Claude Code settings before you continue.',
  'onboarding.security.intro': 'As a prompt-injection mitigation we recommend the following Claude Code configuration.',
  'onboarding.security.acknowledge': 'I have reviewed these recommendations',
  // Per-BOX individual acknowledgement labels. Each label scopes to a
  // single recommendation so the user cannot read "I have reviewed
  // these recommendations" as a single rubber-stamp tick covering all
  // three. Rendered inside the corresponding SecurityRow / bypass
  // card per spec §9.5.2.3 (v1.4 normative pin) so the wrapper-level
  // single checkbox pattern stays banned.
  'onboarding.security.acknowledge.bypassMode': 'I have reviewed the bypass mode setting',
  'onboarding.security.acknowledge.permissionMode': 'I have reviewed the permissionMode setting',
  'onboarding.security.acknowledge.denyPattern': 'I have reviewed the deny pattern setting',
  'onboarding.security.allOk': 'All recommended settings are satisfied.',
  'onboarding.security.failClosed': 'Could not read your Claude Code settings file.',
  'onboarding.security.failClosedRemediation': 'Edit the Claude Code settings file or check that the KovitoBoard server is reachable. See the terminal log for details.',
  'onboarding.security.failClosedCandidatePath': 'Settings file path: ~/.claude/settings.json (user-level) or <projectRoot>/.claude/settings.json (project-level)',
  'onboarding.security.recheck': 'Recheck',
  'onboarding.security.permissionMode.label': 'permissionMode = default',
  'onboarding.security.permissionMode.description': 'Keep Claude Code in default permission mode. bypassPermissions skips the human-in-the-loop confirmation and violates the Rule of Two, so we discourage it.',
  'onboarding.security.denyPattern.label': 'Add .kovitoboard/ to deny pattern',
  'onboarding.security.denyPattern.description': 'Add ".kovitoboard/" to Claude Code permissions.deny so Claude Code itself cannot write into KovitoBoard internal state.',
  'onboarding.security.bypassMode.label': 'Disable bypass mode',
  'onboarding.security.bypassMode.description': 'When bypassPermissions is active, the Rule of Two (untrusted input + sensitive data + external state) is violated 3 of 3 and HITL is required.',
  'onboarding.security.why': 'Why?',
  'onboarding.security.whyModal.heading': 'Background',
  'onboarding.security.whyModal.responsibility': 'Detecting and blocking prompt injection is the responsibility of Anthropic (Claude Code). KovitoBoard only checks whether the recommended settings are in place; it does not implement deny pattern matching itself.',
  'onboarding.security.whyModal.ruleOfTwo': 'Rule of Two: when untrusted input + sensitive data access + external state change all line up, a human in the loop must approve the action.',
  'onboarding.security.whyModal.close': 'Close',
  // Phase 1 prompt injection ② startup warn toast
  // (handoff v1.1 §3.3, trust-prompt-relay §10.5.4)
  'security.toast.title': 'Security recommendations',
  'security.toast.intro': 'Your Claude Code settings have non-recommended values:',
  'security.toast.permissionMode.violation': 'permissionMode is {current} (recommended: default)',
  'security.toast.denyPattern.violation': '.kovitoboard/ is not in Claude Code deny pattern',
  'security.toast.bypassMode.violation': 'bypass mode is active (Rule of Two violation, HITL required)',
  'security.toast.failClosed': 'Could not read your Claude Code settings file. Please review the settings manually.',
  'security.toast.askAgent': 'Ask an agent to fix this',
  'security.toast.askAgentFailed': 'Could not start a session. Please try again.',
  'security.toast.dismiss': 'Dismiss (24h)',
  // Phase 1 prompt injection ④ Rule of Two violation announcement
  // (handoff v1.1 §3.2 / §3.5 / §3.6, prompt-injection-threat-model §4)
  'ruleOfTwo.violation.title': 'Rule of Two Violation Detected',
  'ruleOfTwo.violation.description': 'bypass mode is enabled — 3/3 violation',
  'ruleOfTwo.violation.element.untrustedInput': '(A) untrusted input',
  'ruleOfTwo.violation.element.sensitiveData': '(B) sensitive data access',
  'ruleOfTwo.violation.element.externalState': '(C) external state change',
  'ruleOfTwo.violation.elementStructurallyRequired': 'structurally required in a KB session',
  'ruleOfTwo.violation.elementClaudeAccess': 'Claude can read ~/.ssh, ~/.aws, etc.',
  'ruleOfTwo.violation.elementBypassConsequence': 'bypass mode allows git push / npm publish without confirmation',
  'ruleOfTwo.violation.consequence': '→ HITL (Human-In-The-Loop) is required',
  'ruleOfTwo.violation.accept': 'I understand the risk and accept HITL responsibility',
  'ruleOfTwo.violation.acceptDisabledHint.modal': 'Open the Why? explanation before accepting',
  'ruleOfTwo.violation.acceptDisabledHint.idle': 'Please take a moment (2 s) to absorb the explanation before accepting',
  'ruleOfTwo.violation.why': 'Why is Rule of Two important?',
  'ruleOfTwo.violation.changeMode': 'Change to default mode',
  'ruleOfTwo.modal.heading': 'Why is the Rule of Two important?',
  'ruleOfTwo.modal.intro': 'The Rule of Two is a structural criterion for the attack surface. If two or fewer of the elements (A), (B), (C) are present, an automated action retains a safety margin. When all three line up, the structural attack precondition is met and a human review (HITL) becomes mandatory.',
  'ruleOfTwo.modal.element.untrustedInput.title': '(A) untrusted input',
  'ruleOfTwo.modal.element.untrustedInput.detail': 'Arbitrary text or data ingested from outside: recipe output, web fetch results, file contents, etc.',
  'ruleOfTwo.modal.element.sensitiveData.title': '(B) sensitive data access',
  'ruleOfTwo.modal.element.sensitiveData.detail': 'API keys, SSH credentials, auth tokens, personal files, internal company data, etc.',
  'ruleOfTwo.modal.element.externalState.title': '(C) external state change',
  'ruleOfTwo.modal.element.externalState.detail': 'Actions with hard-to-revert side effects: git push, npm publish, API requests, file writes, and so on.',
  'ruleOfTwo.modal.kbContext': 'In a KovitoBoard session, (A) and (B) are structurally required. Claude Code runs in the user environment with access to ~/.ssh and ~/.aws, and recipes / web fetches structurally ingest untrusted input.',
  'ruleOfTwo.modal.cBlockMeaning': 'Therefore KovitoBoard relies on HITL to block (C) external state change, which avoids reaching the 3/3 attack precondition by design. bypass mode disables that (C) gate and is what produces the Rule of Two violation.',
  'ruleOfTwo.modal.hitl': 'HITL (Human-In-The-Loop): the design that requires a human review before any (C) external state change. With bypass mode disabled, Claude Code surfaces a confirmation prompt before every (C) action.',
  'ruleOfTwo.modal.boundary': 'Responsibility boundary: detecting a Rule of Two violation is the responsibility of Anthropic (Claude Code). KovitoBoard only surfaces the notice; it does not implement detection logic.',
  'ruleOfTwo.modal.close': 'Close',

  // Navigation
  'nav.titleBar.settings': 'Settings',

  // Project root banner (process-lifecycle.md v1.2 §3 / shared-installation-prevention §M-3)
  'projectRootBanner.label': 'Project',
  'projectRootBanner.source.cliArg': 'via --project-root',
  'projectRootBanner.source.env': 'via KOVITOBOARD_PROJECT_ROOT',
  'projectRootBanner.source.settingJson': 'restored from setting.json',
  'projectRootBanner.source.cwdFallback': 'current directory (fallback)',
  'projectRootBanner.source.unknown': 'unknown source',
  'projectRootBanner.cwdFallbackWarning': 'KovitoBoard may be looking at the wrong project. Restart with --project-root <path>.',

  // Ambient Session Sidebar (DEC-020 / EU8)
  'ambientSidebar.heading': 'Sessions',
  'ambientSidebar.toggle.expand': 'Open sidebar',
  'ambientSidebar.toggle.collapse': 'Close sidebar',
  'ambientSidebar.openInSessions': 'Open in sessions screen',
  'ambientSidebar.placeholder': 'Pick an agent and send your first message.',
  'ambientSidebar.resize.handle': 'Resize sidebar',
  'ambientSidebar.picker.label': 'Sessions with agents',
  'ambientSidebar.picker.unselected': '(unselected)',
  'ambientSidebar.pin.button': 'Pin the selected agent',
  'ambientSidebar.pin.alreadyPinned': 'Pinned',
  'ambientSidebar.chat.empty': 'No messages yet. Send the first one.',
  'ambientSidebar.composer.placeholder': 'Type a message (Cmd/Ctrl + Enter to send)',
  'ambientSidebar.composer.pickAgentFirst': 'Pick an agent first',
  'ambientSidebar.composer.shortcut': 'Cmd/Ctrl + Enter',
  'ambientSidebar.composer.pasteHint': 'Paste images directly',
  'ambientSidebar.composer.send': 'Send',
  'ambientSidebar.composer.sending': 'Sending…',
  'ambientSidebar.pick.start': 'Pick a screen element',
  'ambientSidebar.pick.cancel': 'Cancel pick',
  'ambientSidebar.pick.included': 'A picked element will travel with the next message',
  'ambientSidebar.pick.includedHint': 'The next message includes the picked element under [Selected]',
  'ambientSidebar.pick.clear': 'Clear',

  // Screen labels (consumed by ambient sidebar kbcontext / screenLabel, DEC-020 §2.3)
  'screen.unknown': 'Unknown screen',
  'screen.agents': 'Agents',
  'screen.sessions': 'Sessions',
  // v0.2.1 BL-2026-162 §4'.1 (sidebar rebrand): legacy 'App recipes'
  // value is rebranded to 'Apps'. Key kept for backward compat.
  'screen.recipes': 'Apps',

  // Chat
  'chat.message.action.copy': 'Copy',
  'chat.message.action.copied': 'Copied',
  // System banners that replace the raw English sentinels Claude Code
  // emits when the agent turn is interrupted.
  'chat.message.interrupt.userInterrupt': 'Request was interrupted (the tool call was not approved, so the agent stopped responding).',
  'chat.message.interrupt.toolRejected': 'Tool use was rejected. Type your next instruction to continue.',

  // Session
  'session.detail.status.loading': 'Loading session...',
  'session.empty': 'Select a session',
  'session.list.tab.latest': 'Latest',
  'session.list.tab.all': 'All',
  'session.list.empty': 'No sessions found',
  'session.list.badge.sidebar': 'Sidebar',
  'session.list.badge.sidebarOrigin': 'Started from the ambient sidebar',

  // File preview
  'file.preview.error.read': 'Failed to read file',
  'file.preview.error.fetch': 'Failed to fetch file',

  // Agent
  'agent.edit.button.backToDetail': 'Back to agent detail',
  'agent.edit.title': 'Edit Agent',
  'agent.edit.description': 'Edit attributes of {id}',

  // Recipe
  // v0.2.1 BL-2026-162 §4'.1: 'App recipes' → 'Apps' (value-only
  // rebrand; key intentionally retained).
  'recipe.title': 'Apps',
  'recipe.button.createApp': 'Create new app',
  'recipe.code.button.expandAll': 'Expand all',
  // recipe.tab.sample / recipe.tab.history are now orphan in v0.2.1.
  // The 3-tab restructure (§4'.2) replaces them with appsScreen.tab.*.
  // Keys kept for wire compatibility (legacy clients).
  'recipe.tab.sample': 'Sample recipes',
  'recipe.tab.history': 'History',
  // recipe.tab.export was retired earlier — recipe export now runs
  // from the AmbientSidebar's per-app actions popover.
  // recipe.tab.import was retired in v0.2.x alongside the recipe
  // install temporary disable (recipe-system.md §10.6).
  'recipe.install.comingSoon':
    'Recipe install is temporarily disabled in v0.2.x. The KovitoHub signed publisher model is planned for v0.3.0.',

  // Capture capability approval (v0.2.0 Phase 1 prompt-injection ①,
  // opt-in mechanism). The dialog itself does not render in v0.2.x
  // because recipe install is disabled, but the keys are populated
  // ahead of the v0.3.0 re-enable so the component does not ship
  // with placeholder labels. See `app-directory-extension.md` v1.2
  // §10.5.2 and the implementation handoff.
  'recipe.capture.title': 'Capture Capability Approval',
  'recipe.capture.description':
    'This recipe requests the following capture capabilities. Approve each one individually before installing.',
  'recipe.capture.kind.a11y': 'a11y (accessibility snapshot of UI)',
  'recipe.capture.kind.exposed-context': 'exposed-context (window.kb.exposeContext)',
  'recipe.capture.why.a11y':
    'Allows the recipe to ask the server for a structured outline of the visible UI. KovitoBoard only shares element roles and accessible names — not raw HTML — but the agent can still infer what is on screen.',
  'recipe.capture.why.exposed-context':
    'Allows the recipe to ask the server to read the payload your app published via window.kb.exposeContext. Approve only when the recipe needs the app state your code has chosen to surface (selected ids, active filters, etc.).',
  'recipe.capture.whyLink': 'Why?',
  'recipe.capture.approveButton': 'Approve Selected',
  'recipe.capture.error.notApproved':
    "Capture '{kind}' is not approved for this recipe.",
  // Normative warning text (spec v1.4 §10.5.5). Always-visible at
  // approval point. Communicates the v0.2.x same-instance trust
  // collapse to the user.
  'recipe.capture.trustWarning':
    'By approving capture for this recipe, you agree to trust all other recipes installed in this KovitoBoard instance. v0.2.x cannot structurally isolate one recipe from another. This is an experimental preview; future versions will close this gap.',

  // App creation modal (v0.1.0-app-creation-flow.md §7.4)
  'appCreate.modal.title': 'Create new app',
  'appCreate.field.agent': 'Assignee agent',
  'appCreate.field.purpose': 'Purpose and overview',
  'appCreate.field.purpose.placeholder':
    'Describe what problem this app solves and what it does',
  'appCreate.field.purpose.example':
    'e.g., I want to search across notes (Markdown files) in my project. Currently I run grep every time, which is tedious',
  'appCreate.field.purpose.required': 'Required',
  'appCreate.section.optional': 'Details (optional)',
  'appCreate.field.input': 'Input (what is passed in / what triggers the app)',
  'appCreate.field.output': 'Output (what the user gets)',
  'appCreate.field.frequency': 'Usage frequency / timing',
  'appCreate.button.cancel': 'Cancel',
  'appCreate.button.create': 'Create',
  'appCreate.error.noAgents':
    'No agents defined. Please create an agent from the Agents page first.',
  'appCreate.error.sessionCreationFailed': 'Failed to create session: {error}',

  // KB-authored message summary chips (chat surfaces)
  'kbAuthored.section.preamble': 'Sidebar session preamble',
  'kbAuthored.section.kbcontext': 'Screen context (kbcontext)',
  'kbAuthored.section.a11y': 'Accessibility snapshot (a11y)',
  'kbAuthored.section.exposedContext': 'App-exposed context (ExposedContext)',
  'kbAuthored.section.selected': 'Selected element',
  'kbAuthored.section.recipeInstall': 'Recipe install request: {name}',
  'kbAuthored.section.appCreate': 'App creation request',
  'kbAuthored.section.continueSession': 'Continued from session {sessionId}',
  // SS-3 / Q4: sentinel-based unification adds these kinds.
  'kbAuthored.section.skillBaseDir': 'Skill activation: working directory notice',
  'kbAuthored.section.other': 'KB auto-generated message',
  'kbAuthored.button.expand': 'Show details',
  'kbAuthored.button.collapse': 'Collapse',

  // Onboarding (additional)
  // Language endonym — always displayed in native script regardless of locale
  'onboarding.welcome.languageJa': '日本語',

  // Navigation (menu)
  'nav.menu.agents': 'Agents',
  'nav.menu.sessions': 'Sessions',
  // v0.2.1 BL-2026-162 §4'.1 / §6.1 i18n SSOT: 'App recipes' → 'Apps'.
  // Key retained so existing nav references stay valid.
  'nav.menu.recipes': 'Apps',
  // v0.2.1 BL-2026-167: `nav.menu.workRoots` was removed alongside
  // the side-nav entry; the Settings modal uses `setting.tab.workRoots`
  // instead.

  // Work roots settings page (spec cwd-allowlist.md v1.0 §7.4). The
  // page lists / adds / removes the cwd allow-list entries that sit
  // outside the project root. Wording is deliberately calm —
  // adding a folder lets Claude Code write inside it, which is the
  // single biggest security trade-off in this screen.
  'workRoots.title': 'Work roots',
  'workRoots.description':
    'Folders KovitoBoard is allowed to use as the working directory for Claude Code. The project root is always included; additional roots are listed below.',
  'workRoots.addSection.title': 'Add a work root',
  'workRoots.addSection.help':
    'Enter an absolute path. KovitoBoard will refuse system directories and the KovitoBoard repo root itself for safety.',
  'workRoots.addButton': 'Add',
  'workRoots.adding': 'Adding…',
  'workRoots.listSection.title': 'Additional work roots',
  'workRoots.listSection.empty': 'No additional work roots yet.',
  'workRoots.listSection.loadError':
    'Failed to load the current work roots. The list shown above may be incomplete. See server logs for details and reload to retry.',
  'workRoots.deleteConfirm.title': 'Remove this work root?',
  'workRoots.deleteConfirm.body':
    'KovitoBoard will refuse to start new Claude Code sessions under this folder. In-flight sessions will keep running until they exit on their own.',
  'workRoots.errorCodeLabel': 'Error code',

  // Agent (default)
  'agent.default.name': 'Default',

  // Chat input
  'chat.input.attachedFiles': 'Attached files',
  'chat.input.sendError': 'Send failed',
  'chat.input.sendFallback': 'Failed to send',
  'chat.input.placeholder': 'Type a message... (Ctrl+Enter to send, paste images)',
  'chat.input.placeholder.resume': 'Resume session... (Ctrl+Enter to send)',
  'chat.input.placeholder.active': 'Type a message... (Ctrl+Enter to send)',
  'chat.input.hint.full': 'Ctrl+Enter to send · Attach files · Ctrl+V to paste images',
  'chat.input.hint.short': 'Ctrl+Enter to send',
  'chat.input.status.responding': 'Claude is responding...',
  'chat.input.screenshot.button': 'Capture screen',
  'chat.input.screenshot.tooltip': 'Capture a screen, window, or tab and attach it',
  'chat.input.screenshot.error': 'Screenshot failed',
  'chat.input.resize.handle': 'Resize input height',

  // Agent avatar
  'agent.avatar.error.format': 'Supported formats: PNG, JPG, WEBP, SVG',
  'agent.avatar.error.size': 'File size must be 2MB or less',
  'agent.avatar.error.uploadFailed': 'Upload failed',
  'agent.avatar.error.deleteFailed': 'Delete failed',
  'agent.avatar.status.uploading': 'Uploading...',
  'agent.avatar.button.change': 'Change image',
  'agent.avatar.button.remove': 'Remove custom image',
  'agent.avatar.hint': 'PNG, JPG, WEBP, SVG (max 2MB)',

  // User avatar (Q11 / SM-4)
  'user.avatar.error.format': 'Supported formats: PNG, JPG, WEBP, SVG',
  'user.avatar.error.size': 'File size must be 1MB or less',
  'user.avatar.error.uploadFailed': 'Upload failed',
  'user.avatar.error.deleteFailed': 'Delete failed',
  'user.avatar.status.uploading': 'Uploading...',
  'user.avatar.button.change': 'Change image',
  'user.avatar.button.remove': 'Remove profile image',
  'user.avatar.hint': 'PNG, JPG, WEBP, SVG (max 1MB)',

  // Recipe history
  'recipe.history.status.loading': 'Loading history...',
  'recipe.history.error': 'Failed to load history: {error}',
  'recipe.history.empty': 'No recipes have been applied yet.',
  'recipe.history.emptyHint': 'Apply a recipe from the "Import" tab and it will appear here.',
  'recipe.history.fileCount': '{count} files',
  'recipe.history.menuCount': '{count} menus',

  // Chat timeline
  'chat.timeline.mode.standard': 'Standard',
  'chat.timeline.mode.detail': 'Detail',
  'chat.timeline.readOnly': 'This session is read-only (ended or agent not running)',
  'chat.timeline.continue.loading': 'Continuing...',
  'chat.timeline.continue.button': 'Continue in new session',
  'chat.topic.active': 'Active',
  'chat.topic.new': 'New topic',
  'chat.topic.startNew': 'Start a new topic with {agent}',
  'chat.topic.placeholder': 'Type your first message... (Ctrl+Enter to send, Esc to cancel)',
  'chat.topic.status.sending': 'Sending...',
  'chat.topic.button.start': 'Start',

  // Sample recipes — read-only listing while recipe install is
  // disabled in v0.2.x. Install / reinstall / warning / picker keys
  // were retired alongside the disable; the `recipe.install.comingSoon`
  // key above replaces the install CTAs on the sample page.
  'recipe.sample.status.loading': 'Loading sample recipes...',
  'recipe.sample.button.reload': 'Reload',
  'recipe.sample.empty': 'No sample recipes',
  'recipe.sample.emptyHint': 'Add recipes to the recipes/ directory and they will appear here.',
  'recipe.sample.section.available': 'Available ({count})',
  'recipe.sample.section.installed': 'Installed ({count})',
  'recipe.sample.badge.installed': 'Installed',
  'recipe.sample.installedDate': 'Installed on',

  // App removal flow (DEC-024 #3)
  'nav.action.removeApp': 'Remove app',
  'nav.action.appActions': 'App actions',
  'app.actions.exportRecipe': 'Export recipe',
  'app.actions.removeApp': 'Remove app',
  'app.actions.disable': 'Disable',
  'appsTab.actions.disableError': 'Disable failed',
  'appRemoval.modal.title': 'Remove app "{name}"',
  'appRemoval.modal.body': 'About to remove "{name}".',
  'appRemoval.modal.bullet.menu': 'The app disappears from the sidebar',
  'appRemoval.modal.bullet.code': 'The app code (app/{appId}/) is deleted',
  'appRemoval.modal.bullet.data': 'The app data (app/data/{appId}/) is deleted',
  'appRemoval.modal.agentNote': 'The removal is performed by an agent. Pick one on the next screen.',
  'appRemoval.modal.button.cancel': 'Cancel',
  'appRemoval.modal.button.proceed': 'Next',
  'appRemoval.modal.close': 'Close',
  'appRemoval.picker.title': 'Choose an agent to perform the removal',
  'appRemoval.picker.button.cancel': 'Cancel',
  'appRemoval.picker.button.confirm': 'Remove with this agent',
  'appRemoval.error.noAgents': 'No agents are defined. Create one from the Agents page first.',
  'appRemoval.error.sessionCreationFailed': 'Failed to create session: {error}',

  // Agent list
  'agent.list.title': 'Agents',
  'agent.list.description': '{count} agents registered',
  'agent.list.button.add': 'Add',
  'agent.list.empty': 'No agents found',
  'agent.list.emptyHint': 'Place agent definition files in .claude/agents/',
  'agent.list.guide.title': 'How to create',
  'agent.list.guide.step1': 'Create a .claude/agents/ directory in your project root',
  'agent.list.guide.step2': 'Create a Markdown file (e.g. my-agent.md)',
  'agent.list.guide.step3': 'Define name and description in YAML front matter',
  'agent.list.guide.templateTitle': 'Template example',
  'agent.list.guide.restartHint': 'Restart KovitoBoard after placing the files',

  // Welcome banner
  'welcome.subtitle': 'KovitoBoard is running',
  'welcome.agentCount': '{count} agents are registered.',
  'welcome.gettingStarted': 'Getting started:',
  'welcome.selectAgent': 'Select an agent and start a session.',
  'welcome.button.viewAgents': 'View agents',
  'welcome.createAgentHint': 'Start by creating an agent definition file.',
  'welcome.agentDirHint': 'Place a Markdown file in your project\'s .claude/agents/ directory and KovitoBoard will recognize it as an agent.',
  'welcome.seeGuideHint': 'See the empty state guide in the "Agents" menu for details.',
  'welcome.settingsHint': 'You can access settings anytime from the gear icon in the header',

  // Agent creation
  'agent.create.title': 'Add Agent',
  'agent.create.button.backToList': 'Back to agent list',
  'agent.create.button.backToTemplate': 'Back to template selection',
  'agent.create.button.create': 'Create Agent',
  'agent.create.status.creating': 'Creating...',
  'agent.create.step.selectTemplate': 'Select a template',
  'agent.create.step.configure': 'Review agent settings',
  'agent.create.validation.idPattern': 'Alphanumeric, hyphens, and underscores only (must start with alphanumeric)',
  'agent.create.template.loading': 'Loading templates...',
  'agent.create.template.empty': 'No templates available',
  'agent.create.template.alreadyExists': 'An agent from this template already exists',
  'agent.create.template.alreadyExists.short': 'Already added',
  'agent.create.templateLabel': 'Template',
  'agent.create.field.agentId': 'Agent ID',
  'agent.create.field.agentIdHint': 'Used as the file name',
  'agent.create.field.displayName': 'Display name',
  'agent.create.field.optional': 'optional',
  'agent.create.field.displayNameHint': 'Template name will be used if left empty',
  'agent.create.launchHint.prefix': 'Launch from Claude Code with',
  'agent.create.launchHint.suffix': '',
  // AA-3: build an agent without picking a template
  'agent.create.scratch.title': 'Build from scratch',
  'agent.create.scratch.badge': 'Custom',
  'agent.create.scratch.description': 'Skip the template gallery and write the persona, tone, and instructions yourself. Power-user path.',
  'agent.create.scratch.hint': 'Write the system prompt directly',
  'agent.create.scratch.field.displayName.placeholder': 'e.g. Code Reviewer',
  'agent.create.scratch.field.systemPrompt.label': 'System prompt',
  'agent.create.scratch.field.systemPrompt.placeholder': 'You are …\n\n(Describe the role, tone, and behaviour of this agent. Markdown is supported.)',
  'agent.create.scratch.field.systemPrompt.hint': 'Used verbatim as the body of the agent definition Markdown. Claude Code reads it as the system prompt at launch.',
  'agent.create.scratch.error.fieldsRequired': 'Display name, description, and system prompt are all required.',

  // Common
  'common.save': 'Save',
  'common.copy': 'Copy',
  'common.close': 'Close',
  'common.dismiss': 'Dismiss',
  'common.optional': 'optional',
  'common.clear': 'Clear',

  // Session meta information bar (Q5 / SS-4)
  'sessionStatus.title': 'Session info',
  'sessionStatus.label.model': 'Model',
  'sessionStatus.label.context': 'Context',
  'sessionStatus.label.elapsed': 'Elapsed',
  'sessionStatus.value.notSet': '—',

  // Agent list sections (Q13 / AA-7)
  'agent.list.section.bundled': 'Bundled',
  'agent.list.section.user': 'User',
  'agent.list.section.system': 'System',

  // Q2 / AD-2: KB:* marker injection banner
  'agent.edit.inject.title': 'Structured field markers (KB:*) are missing',
  'agent.edit.inject.description': "To edit personality / tone / extra instructions from this screen, KB needs to append an empty marker block at the end of the agent definition. Your existing body content is preserved unchanged.",
  'agent.edit.inject.button.add': 'Add markers',
  'agent.edit.inject.button.injecting': 'Adding...',

  // Slash-command warning (Q12 / SS-6)
  'slashCommandWarning.title': 'Possible Claude Code TUI command',
  'slashCommandWarning.body': "Messages that start with `/` may be treated as Claude Code TUI commands (such as /context, /help, /model). In that case the response will appear in the terminal (tmux) only, not in the KB UI.",
  'slashCommandWarning.hint': "Since KB cannot display the response, attach to the session via `tmux attach` if you need to inspect the result.",
  'slashCommandWarning.suppress': "Don't show this again",
  'slashCommandWarning.confirm': 'Send anyway',
  'slashCommandWarning.cancel': 'Cancel',

  // Tooltip / control buttons
  'tooltip.chat.reload': 'Reload session',
  'tooltip.chat.copyAll': 'Copy all messages as Markdown',
  'tooltip.chat.startNew': 'Start a session with a new topic',
  'tooltip.chat.continueInNew': "Continue this session's context in a new session",
  'tooltip.input.removeAttachment': 'Remove attachment',
  'tooltip.input.dismissError': 'Dismiss error',
  'tooltip.input.attachFile': 'Attach file',
  'tooltip.input.send': 'Send (Ctrl+Enter)',
  'tooltip.input.stop': 'Stop response (Esc)',
  'tooltip.filePreview.close': 'Close preview',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.loading': 'Loading...',
  'common.error': 'An error occurred',
  'common.retry': 'Retry',

  // Recipe export
  'recipe.export.status.scanning': 'Scanning app/ directory...',
  'recipe.export.status.exporting': 'Exporting...',
  'recipe.export.empty': 'No exportable files found for this app.',
  'recipe.export.emptyHint': 'Add pages or styles to app/<appId>/ before exporting.',
  'recipe.export.done.title': 'Export complete',
  'recipe.export.done.downloadStarted': 'Download started: {filename}',
  'recipe.export.done.downloadHint': 'The file is saved to your browser’s download folder (usually ~/Downloads).',
  'recipe.export.button.export': 'Export',
  'recipe.export.scanResult.title': 'App contents',
  'recipe.export.scanResult.total': 'Total: {fileCount} files / {size} KB',
  'recipe.export.scanResult.menuCount': '{count} menus',
  'recipe.export.field.recipeId': 'Recipe ID',
  'recipe.export.field.recipeIdPlaceholder': 'my-app',
  'recipe.export.field.name': 'Recipe name',
  'recipe.export.field.description': 'Description',
  'recipe.export.field.descriptionPlaceholder': 'A recipe that adds a custom page',
  'recipe.export.field.version': 'Version',
  'recipe.export.field.author': 'Author',
  'recipe.export.hint.recipeId': 'A-Z / a-z / 0-9 / _ / - / . / / / @ only. 1–256 characters. The persistent identifier used at distribution.',
  'recipe.export.modal.title': 'Export recipe',
  'recipe.export.modal.subtitle': 'Export the app "{displayName}" as a redistributable recipe.',
  'recipe.export.modal.cancel': 'Cancel',
  'recipe.export.modal.close': 'Close',
  'recipe.export.error.appIdMissing': 'Cannot resolve appId. Make sure an app screen is open.',
  'recipe.export.error.recipeIdRequired': 'Recipe ID is required.',
  'recipe.export.error.recipeIdFormat': 'Recipe ID must contain only A-Z / a-z / 0-9 / _ / - / . / / / @ and be 1–256 characters.',
  'recipe.export.error.customBeNotExportable':
    'This app cannot be exported as a recipe. To distribute it, do one of the following: (1) rewrite the server-side logic as declarative API calls that recipes support (api.calls in recipe.yaml + window.kb.call), or (2) document the server-side logic separately so recipients can implement it with agent assistance after installing the recipe. Why: the code under app/{appId}/api/ ({files}) falls outside what a recipe can safely package.',

  // Recipe import — retired in v0.2.x alongside the recipe install
  // temporary disable. Will return with the v0.3.0 sideload mode.

  // Agent structured field editor
  'agent.field.displayName.label': 'Display name',
  'agent.field.displayName.description': 'Agent name shown in the UI. Auto-generated from file name when left blank.',
  'agent.field.description.label': 'Description',
  'agent.field.description.description': 'Short blurb shown in the agent list. Leave blank to remove.',
  'agent.field.description.placeholder': 'e.g. Handles code review and suggestions',
  'agent.field.model.label': 'Model',
  'agent.field.model.description': "Claude model dist-tag. `default` uses Claude Code's configured default.",
  'agent.field.themeColor.label': 'Theme color',
  'agent.field.themeColor.description': 'Accent color used by the avatar and list card. Leave blank to revert to the default.',
  'agent.field.themeColor.clear': 'Clear',

  // Q7 / AS-5 file preview sub-actions
  'filePreview.openInBrowser': 'Open in browser',
  'agent.field.displayName.placeholder': '(auto)',
  'agent.field.noMarkers.title': 'Manually created agent file',
  'agent.field.noMarkers.description': 'Structured field markers (KB:*) are not present. Personality, tone, and extra instructions cannot be edited. Only the display name can be changed.',
  'agent.field.personality.label': 'Personality',
  'agent.field.personality.description': 'Define the agent\'s core personality traits as a bulleted list.',
  'agent.field.personality.placeholder': '- Cheerful and positive\n- Polite demeanor\n- ...',
  'agent.field.toneSample.label': 'Tone sample',
  'agent.field.toneSample.description': 'Provide concrete examples of the agent\'s tone. Include conversation examples and tone characteristics.',
  'agent.field.toneSample.placeholder': '(Example)\nUser: Hello\nAgent: ...',
  'agent.field.extraInstructions.label': 'Extra instructions',
  'agent.field.extraInstructions.description': 'Additional rules or constraints to give the agent beyond the standard instructions.',
  'agent.field.extraInstructions.placeholder': '(Optional) Enter any special constraints or rules here',
  'agent.field.status.saving': 'Saving...',
  'agent.field.hint.unsaved': 'You have unsaved changes',

  // Trust prompt
  'trust.kind.folderTrust': 'Folder trust',
  'trust.kind.write': 'File write',
  'trust.kind.edit': 'File edit',
  'trust.kind.read': 'File read',
  'trust.kind.bash': 'Bash command execution',
  'trust.kind.sandboxNetwork': 'Network (sandbox)',
  'trust.kind.other': 'Other',
  'trust.detected.title': 'Trust confirmation',
  'trust.detected.degenerate.title': 'Non-standard prompt format detected',
  'trust.detected.degenerate.description': 'Choices may appear in a different order or count than usual. Check the actual message below before responding.',
  'trust.detected.extractedInfo': 'Extracted info',
  'trust.detected.noChoices': 'No choices available (check pattern definitions)',
  'trust.fallback.title': 'Unknown input prompt',
  'trust.fallback.badge': 'Fallback',
  'trust.fallback.warning.title': 'Prompt does not match any pattern definition',
  'trust.fallback.warning.description': 'Check the actual message below and respond using the free input field or key buttons.',
  'trust.fallback.quickKeys': 'Common keys',
  'trust.fallback.freeInput': 'Free input (sent in literal mode)',
  'trust.fallback.freeInputPlaceholder': 'Enter text to send...',
  'trust.fallback.button.send': 'Send',
  'trust.common.customAnswer.title': 'Custom answer (for options not listed)',
  'trust.common.quickKeys': 'Common keys',
  'trust.common.freeInput': 'Free input (sent in literal mode)',
  'trust.common.freeInputPlaceholder': 'Enter text to send...',
  'trust.common.button.send': 'Send',
  'trust.tmux.label': 'Last resort: open tmux directly',
  'trust.tmux.copy': 'Copy',
  'trust.tmux.copied': 'Copied',
  'trust.unsupported.title': 'Input form not operable from KB UI',
  'trust.unsupported.description': 'This form requires terminal interaction. Attach the tmux session to operate it, or press Cancel (Esc) to dismiss.',
  'trust.unsupported.button.cancel': 'Cancel (Esc)',
  'trust.unsupported.badge': 'Unsupported',
  'trust.rawBuffer.title': 'Actual message (tail)',

  // Trust marker + preamble warning (recipe trust axis, v0.2.0)
  'trust.level.kbTrusted': 'KB-trusted',
  'trust.level.codeTrusted': 'Code-trusted (signed)',
  'trust.level.codeTrustedSideloaded': 'Code-trusted (sideloaded)',
  'trust.level.codeTrustedBundled': 'Code-trusted (bundled)',
  'trust.level.unknown': 'Unknown (grandfather)',
  'trust.marker.ariaLabel': 'Recipe trust level: {label}',
  'trust.unknown.reinstall': 'Re-install via KovitoHub (v0.3.0) to verify',
  'trust.preamble.fromApp': 'This content originated from app: {appId}',
  'trust.preamble.fromUserPaste': 'This content originated from user paste',
  'trust.preamble.fromUnknown': 'This content originated from an unverified source',

  // Agent detail
  'agent.detail.tab.profile': 'Profile',
  'agent.detail.tab.sessions': 'Session history',
  'agent.detail.tab.definition': 'Definition file',
  'agent.detail.button.backToList': 'Agent list',
  'agent.detail.button.newSession': 'New session',
  'agent.detail.status.creatingSession': 'Creating new session...',
  'agent.detail.editBanner.description': 'Edit display name, personality, tone, and extra instructions',
  // System default agent (the virtual "Claude (default)" entry)
  'agent.default.displayName': 'Claude (default)',
  'agent.default.role': 'Default',
  'agent.default.description': 'Vanilla Claude Code session without a custom system prompt. Useful for general-purpose chats inside KB.',

  'agent.detail.section.overview': 'Overview',
  'agent.detail.section.basicInfo': 'Basic info',
  'agent.detail.section.avatar': 'Avatar',
  'agent.detail.section.stats': 'Cumulative stats',
  'agent.detail.field.employeeId': 'Employee ID',
  'agent.detail.field.agentId': 'Agent ID',
  'agent.detail.field.model': 'Model',
  'agent.detail.field.command': 'Launch command',
  'agent.detail.field.themeColor': 'Theme color',
  'agent.detail.stat.sessions': 'Sessions',
  'agent.detail.stat.messages': 'Messages',
  'agent.detail.stat.toolCalls': 'Tool calls',
  'agent.detail.stat.tokens': 'Tokens',
  'agent.detail.activeConfirm.message': '{agent} has an active session',
  'agent.detail.activeConfirm.startNew': 'Start new session',
  'agent.detail.activeConfirm.openActive': 'Open active session',
  'agent.detail.sessions.empty': 'No session history',
  'agent.detail.sessions.emptyHint': 'Sessions will appear here once recorded by hooks for this agent',
  'agent.detail.definition.notFound': 'Definition file not found',
  'agent.detail.newSession.placeholder': 'Send first message to {agent}... (Ctrl+Enter)',

  // Settings
  'setting.title': 'Settings',
  'setting.tab.basic': 'Basic',
  // v0.2.1 BL-2026-167: added when the standalone Work Roots side-nav
  // item was folded into the Settings modal (judgement doc v1.1
  // §2.5). Same wording as the previous `nav.menu.workRoots`.
  'setting.tab.workRoots': 'Work roots',
  'setting.tab.skills': 'Skills',
  'setting.tab.automations': 'Automations',
  'setting.tab.integrations': 'Integrations',
  'setting.tab.rules': 'Rules',
  'setting.tab.ambientSidebar': 'Sidebar',

  // Settings — Ambient Sidebar tab (DEC-020 / EU8)
  'setting.ambientSidebar.section.preferences': 'Preferences',
  'setting.ambientSidebar.section.pinned': 'Per-screen pins',
  'setting.ambientSidebar.openByDefault': 'Open the sidebar by default at launch',
  'setting.ambientSidebar.globalDefault.label': 'Default agent for unpinned screens',
  'setting.ambientSidebar.globalDefault.unselected': 'None',
  'setting.ambientSidebar.empty': 'No pins yet. Pin from the sidebar on each screen.',
  'setting.ambientSidebar.unpin': 'Unpin',
  'setting.ambientSidebar.unpinned': '(unselected)',
  'setting.ambientSidebar.deleted': '(deleted)',
  'setting.basic.error.loadFailed': 'Failed to load basic settings',
  'setting.basic.section.userAvatar': 'Profile image',
  'setting.basic.section.info': 'Basic info',
  'setting.basic.notSet': 'Not set',
  'setting.basic.field.projectName': 'Application title',
  'setting.basic.field.description': 'Subtitle',
  'setting.basic.field.userName': 'Display name',
  'setting.basic.field.language': 'Language',
  'setting.basic.help.projectName': 'Application title shown in the KB header (required, up to 100 characters)',
  'setting.basic.help.description': 'Subtitle shown beneath the title (optional, up to 200 characters)',
  'setting.basic.help.userName': 'How agents address you (required, up to 50 characters)',
  'setting.basic.help.language': 'KB UI language',
  'setting.basic.footer': 'Changes take effect after reloading the page',
  'setting.basic.button.save': 'Save',
  'setting.basic.button.saving': 'Saving...',
  'setting.basic.button.reset': 'Reset changes',
  'setting.basic.status.saved': '✓ Saved',
  'setting.basic.status.error': 'Failed to save',
  'setting.basic.language.ja': 'Japanese',
  'setting.basic.language.en': 'English',
  'setting.skills.category.operation': 'Operation',
  'setting.skills.category.procedure': 'Procedure',
  'setting.skills.category.knowledge': 'Knowledge',
  'setting.skills.empty': 'No skills registered yet',
  'setting.skills.emptyHint': 'Ask the concierge to add a briefing skill',
  'setting.automations.section.hooks': 'Hooks',
  'setting.automations.section.schedule': 'Schedule',
  'setting.automations.hooks.empty': 'No hooks configured',
  'setting.automations.schedule.empty': 'No automation schedules yet',
  'setting.integrations.empty': 'No integrations configured yet',
  'setting.integrations.emptyHint': 'Ask an agent about specific integration targets you want (Chatwork / Slack / etc.)',
  'setting.rules.empty': 'No rules configured yet',
  'setting.rules.emptyHint': 'Ask the concierge to add a rule for commit messages',
  // --- Admin / Server status ---
  'admin.status.indicator.title': 'Server Status',
  'admin.status.healthy': 'Healthy',
  'admin.status.degraded': 'Some features are degraded',
  'admin.status.down': 'Server is down',
  'admin.status.unknown': 'Checking status...',
  'admin.status.be': 'Server',
  'admin.status.tmux': 'tmux',
  'admin.status.agents': 'Agents',
  'admin.status.url': 'URL',
  'admin.status.git': 'Git',
  'admin.status.git.untracked': 'Not a git checkout',
  'admin.status.uptime': 'Running ({duration})',
  'admin.status.activeCount': '{count} active',
  'admin.status.banner.degraded': 'KovitoBoard is running with degraded features',
  'admin.status.banner.down': 'Lost connection to the KovitoBoard server',

  'admin.restart.button': 'Restart Server',
  'admin.restart.confirm.title': 'Restart the server?',
  'admin.restart.confirm.body': 'All agents and sessions will be temporarily disconnected. Conversation history is preserved.',
  'admin.restart.confirm.ok': 'Restart',
  'admin.restart.confirm.cancel': 'Cancel',
  'admin.restart.progress': 'Restarting server...',
  'admin.restart.done': 'Server restart complete',
  'admin.restart.failed': 'Server restart failed',

  'admin.stop.button': 'Stop Server',
  'admin.stop.confirm.title': 'Stop the server?',
  'admin.stop.confirm.body': 'All agents and sessions will be disconnected. You will need to restart from the terminal.',
  'admin.stop.confirm.ok': 'Stop',
  'admin.stop.done': 'Server stopped',

  'admin.stopped.banner.title': 'Server is stopped',
  'admin.stopped.banner.body': 'To restart, run the following in your terminal:',
  'admin.stopped.banner.command': 'npm start -- --project-root <your-project-path>',
  'admin.stopped.banner.footer': 'This page will automatically reconnect when the server starts.',

  // Version info (v0.1.0-version-display.md §5.4)
  'version.section.title': 'Versions',
  'version.kb.label': 'KovitoBoard',
  'version.claudeCode.label': 'Claude Code',
  'version.loading': 'Loading version info…',
  'version.loadFailed': 'Could not retrieve version info',
  'version.kb.upToDate': '✅ Up to date',
  'version.kb.outdated': '⚠️ {latest} is available',
  'version.kb.fetchFailed': 'ℹ️ Update info not available yet (will turn on after the public release)',
  'version.kb.disabledByEnv': 'ℹ️ Version check disabled (env)',
  'version.kb.disabledByConfig': 'ℹ️ Version check disabled (config)',
  'version.kb.recheckButton': 'Check now',
  'version.kb.rechecking': 'Checking…',
  'version.kb.upgradeButton': 'Update',
  'version.claudeCode.primary': '✅ Primary (tested)',
  'version.claudeCode.bestEffort': '⚠️ Best-effort (primary: {primary})',
  'version.claudeCode.outOfRange': '❌ Outside supported range (primary: {primary})',
  'version.claudeCode.notDetected': 'ℹ️ Not detected',
  'version.header.warning.outOfRange': '⚠️ Claude Code outside supported range',
  'version.header.warning.kbOutdated': '⚠️ KB {latest} is available',
  'version.header.warning.multiple': '⚠️ {count} warnings',

  // Version info — upgrade dispatch (Phase C)
  'version.upgrade.agentLabel': 'Request from',
  'version.upgrade.loadingAgents': 'Loading agents…',
  'version.upgrade.noAgents': 'No agents available. Add an agent first.',
  'version.upgrade.dispatching': 'Dispatching…',
  'version.upgrade.confirm.title': 'Request a KB upgrade?',
  'version.upgrade.confirm.body': 'Ask {agentId} to upgrade KovitoBoard to {latest}.',
  'version.upgrade.confirm.note': 'After dispatch, follow the agent\'s work on the Sessions page.',
  'version.upgrade.confirm.ok': 'Dispatch',

  'admin.agent.restart.button': 'Restart',
  'admin.agent.restart.confirm.title': 'Restart {agentName}?',
  'admin.agent.restart.confirm.body.line1': "This agent's tmux window will be stopped and restarted.",
  'admin.agent.restart.confirm.body.line2': 'Conversation history is preserved',
  'admin.agent.restart.confirm.body.line3': 'In-progress work (running commands, pane state) will be lost',
  'admin.agent.restart.confirm.body.line4': 'The agent will be temporarily unresponsive during restart',
  'admin.agent.restart.confirm.ok': 'Restart',
  'admin.agent.restart.progress': 'Restarting {agentName}...',
  'admin.agent.restart.done': '{agentName} restarted',
  'admin.agent.restart.failed': 'Failed to restart {agentName}',

  // GlobalErrorBoundary fallback UI
  'error.boundary.title': 'KovitoBoard could not be displayed',
  'error.boundary.intro': 'An error occurred while rendering the page. The KovitoBoard server may have stopped, or an unhandled bug may have surfaced.',
  'error.boundary.steps.heading': 'Please try the following:',
  'error.boundary.steps.serverCheck': 'Check that the KovitoBoard server (the process you started with `npm start` or similar) is running. If it has stopped, start it again.',
  'error.boundary.steps.reload': 'Once you have confirmed the server is up, reload this page.',
  'error.boundary.steps.askAgent': 'If the problem persists, use the button below to copy a diagnostic message and hand it to your Claude Code agent for triage.',
  'error.boundary.button.reload': 'Reload page',
  'error.boundary.button.copyDiag': 'Copy diagnostic message',
  'error.boundary.button.copied': 'Copied',
  'error.boundary.button.copyFailed': 'Copy failed (please select and copy manually)',
  'error.boundary.diag.heading': 'Diagnostic message (for the Claude Code agent)',
  'error.boundary.diag.promptHeader': 'A React render error occurred in the KovitoBoard web UI. Please investigate the root cause and fix it using the information below.',

  // ---------------------------------------------------------------------
  // v0.2.1 BL-2026-162 — Apps screen rebrand + 3-tab restructure
  // SSOT: docs/design/discussions/v021-bundled-sample-enable-disable-decision-2026-05-18.md
  //       §4'.2 wireframe + §6 i18n SSOT (group 6.2 / 6.3 / 6.4 / 6.5 / 6.6 / 6.7)
  // ---------------------------------------------------------------------

  // Tab labels for the new AppsScreen 3-tab layout.
  'appsScreen.tab.apps': 'Apps',
  'appsScreen.tab.samples': 'Sample apps',
  'appsScreen.tab.recipes': 'Recipes',

  // App source identifier badges (§4.9 / §6.3). 4 persisted values +
  // the scanner-derived 'self-made' category. The grandfather
  // `'sample'` badge gets its own value so the Apps tab can
  // distinguish a pre-v0.2.1 install lineage from a fresh v0.2.1
  // bundled enable at a glance.
  'app.source.selfMade': 'Self-made',
  'app.source.bundled': 'Bundled',
  'app.source.sample': 'Sample',
  'app.source.import': 'Imported',
  'app.source.url': 'URL',

  // Apps tab controls (§6.4).
  'appsScreen.button.addApp': '+ Add app',
  'appsScreen.button.createSelfMade': '+ Create self-made app',
  'appsScreen.button.rename': 'Rename',
  'appsScreen.button.renameSave': 'Save',
  'appsScreen.button.renameCancel': 'Cancel',
  'appsScreen.button.renameReset': 'Reset',
  'appsScreen.button.renameResetTooltip':
    'Reset to the default app name.',
  'appsScreen.label.dragHandle': 'Drag to reorder',
  'appsScreen.label.renamePlaceholder': 'Enter app menu label',
  'appsScreen.error.menuLabelTooLong': 'Menu label is too long (max 80 characters).',
  'appsScreen.error.menuLabelEmpty':
    'Menu label cannot be empty. Use Reset to restore the default.',

  // Apps tab empty-state hints (§6.4).
  'appsTab.empty': 'No apps installed yet.',
  'appsTab.emptyHint':
    'Use "+ Add app" to enable a sample app, or "+ Create self-made app" to start a new one.',

  // Apps tab D&D reorder feedback (BS-L6).
  'appsTab.reorder.saving': 'Saving the new order…',
  'appsTab.reorder.hint': 'Drag and drop to reorder apps',

  // Per-row Actions menu trigger (§4'.6).
  'app.actions.menu': 'App actions',

  // Sample apps tab (§6.5).
  'samplesTab.info.comingSoon':
    'Coming in v0.3.0: install apps from KovitoHub. For now, try sample apps below.',
  'samplesTab.button.enable': 'Enable',
  'samplesTab.label.enabled': 'Enabled',
  'samplesTab.label.openInAppsTab': 'Manage in Apps tab',

  // Recipes tab preview UI (§6.6 / §4.10 BS-L10 — network silent).
  'recipeTab.banner.comingSoon': 'Coming in v0.3.0 with KovitoHub',
  'recipeTab.banner.description':
    'Install signed recipes from KovitoHub. Each recipe is verified by the publisher and audited by KovitoBoard.',
  'recipeTab.mockup.exampleRecipeTitle': 'Example Recipe',
  'recipeTab.mockup.signBadge': 'Signed',
  'recipeTab.mockup.installButton': 'Install',
  'recipeTab.footnote.previewOnly': 'Preview only. Full functionality in v0.3.0.',

  // Bundled enable / disable user-facing strings (§6.7).
  'recipe.bundled.enable.button': 'Enable',
  'recipe.bundled.disable.confirm': 'Disable this app? Your data will be preserved.',
  'recipe.bundled.dataPreservedNotice': 'App data preserved. Re-enable to restore.',
}

export default en
