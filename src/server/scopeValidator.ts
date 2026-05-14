/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Scope Validator — maps scope to path and enforces operation-aware
 * exclusion (recipe-system.md v1.8 §6.5 / §6.6).
 *
 * Called from the handler dispatcher to ensure, before handler
 * execution, that the path is within an approved scope's region and
 * is not on the operation-aware exclusion list.
 *
 * The exclusion table is managed in **this one place only**.
 * Individual handlers must not perform their own exclusion checks.
 *
 * Key v1.8 changes (security-threat-model.md §S2/§S3/§S9):
 *   - Path normalization pipeline for exclusion match (§6.6.2 step 1-6:
 *     realpath → NFC → suspicious-char reject → separator unification →
 *     Win32 canonicalization → case-fold).
 *   - Operation-aware exclusion (§6.6.3): the same path may be read-OK
 *     and write-blocked depending on the matched scope.
 *   - Expanded `.claude/...` block surface (§S3 mitigation): hooks,
 *     settings, settings.local.json, commands are full-block; agents,
 *     skills, and CLAUDE.md (any nested) are read+write blocked with
 *     reads bypassable only via the corresponding dedicated `*-read`
 *     scope (`agents-read`, `skills-read`, `claude-md-read`). The
 *     broader `project-read` scope is **not** sufficient to read those
 *     narrow-scope subtrees.
 *   - v0.2.x temporary disabled (§6.5.3 final paragraph): the new
 *     `agents-write` / `skills-write` opt-in scopes are intentionally
 *     **not** introduced here; the install path is disabled in v0.2.x
 *     so write access to `.claude/agents/` / `.claude/skills/` is
 *     uniformly blocked until v0.3.0 reintroduces the opt-in scopes.
 *
 * @see recipe-system.md v1.8 §6.5 (scope definitions)
 * @see recipe-system.md v1.8 §6.6 (exclusion, operation-aware)
 * @see security-threat-model.md v1.2 §S2 / §S3 / §S9
 * @stable v0.2.0
 */

import * as path from 'path'
import type { Scope, HandlerErrorCode } from './handlers/types.js'
import {
  normalizePath,
  resolveScopeRoot,
  isWithin,
  isClaudeMdPath,
  PathResolutionError,
  realpathUpToExisting,
} from './pathResolver.js'
import { lazyChildLogger } from './logger.js'

/**
 * Logger handle for the scope-validator. `lazyChildLogger` is used
 * (instead of `serverLogger`) so unit tests that import this module
 * without booting `initLogger()` do not crash when the
 * `PathRejectedSuspiciousChar` event fires — the console fallback
 * keeps assertions stable while production keeps routing through the
 * real pino logger.
 */
const log = lazyChildLogger('scope-validator')

// =========================================
// Operation kind
// =========================================

/**
 * Filesystem operation kind, threaded into the exclusion table so the
 * same path can be read-allowed and write-blocked depending on which
 * scope matched in the precedence loop.
 */
export type ExclusionOperation = 'read' | 'write'

// =========================================
// §6.6.2 Path normalization pipeline (exclusion match only)
// =========================================

/**
 * Unicode code points that cause an exclusion-match path to be
 * rejected outright. Covers zero-width characters and bidi overrides
 * used to visually spoof e.g. `.git<ZWSP>/hooks` or
 * `.claude<ZWSP>/settings.json` (recipe-system.md v1.8 §6.6.2 step 3).
 */
const SUSPICIOUS_CHAR_REGEX =
  /[\u200B\u200C\u200D\uFEFF\u202A\u202B\u202C\u202D\u202E]/

/**
 * Result of normalizing a physical path for exclusion match. `ok:
 * false` means the path contained a suspicious character and the
 * caller must reject (security event, fail-fast `Internal` error).
 */
export type ExclusionKeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: 'SuspiciousChar' }

/**
 * Apply the §6.6.2 6-step normalization pipeline (step 1 happens
 * upstream when `physicalPath` is the output of `normalizePath` /
 * `realpathUpToExisting`).
 *
 * The pipeline is applied **only** for exclusion match. Real fs
 * read/write keeps using `physicalPath` directly so case-sensitive
 * filesystems still see the original bytes.
 */
export function normalizeForExclusionMatch(
  physicalPath: string,
  projectRoot: string,
): ExclusionKeyResult {
  // Step 2: NFC — defend against NFD / composing diacritics bypass.
  const nfcAbs = physicalPath.normalize('NFC')
  const nfcRoot = projectRoot.normalize('NFC')

  // Step 3: zero-width / bidi-override reject (security event).
  if (SUSPICIOUS_CHAR_REGEX.test(nfcAbs)) {
    return { ok: false, reason: 'SuspiciousChar' }
  }

  // Compute the project-relative portion. Paths outside the project
  // root produce an empty key — callers treat that as "no exclusion
  // match" (attachments, uploads, kb-data-read targets, etc.).
  const rel = path.relative(nfcRoot, nfcAbs)
  if (rel === '' || rel.startsWith('..')) {
    return { ok: true, key: '' }
  }

  // Step 4: separator unification (`\` → `/`) so Windows-style
  // segment markers cannot bypass the patterns below.
  const sepUnified = rel.replace(/\\/g, '/')

  // Step 5: Win32 / NTFS canonicalization. NTFS aliases trailing
  // dots and spaces to the dotless / spaceless form (`CLAUDE.md.` and
  // `CLAUDE.md ` both open the same file as `CLAUDE.md`). Strip them
  // per segment. Shortname (`PROGRA~1`) is not handled here — it
  // would require an FS round-trip and is off on modern NTFS by
  // default; left as documented residual in security-threat-model.md
  // §S2.
  const canon = stripTrailingDotsAndSpaces(sepUnified)

  // Step 6: case-fold. Applied regardless of FS case sensitivity so
  // exclusion patterns match `.GIT/HOOKS`, `Claude.md`, etc.
  const folded = canon.toLowerCase()

  return { ok: true, key: folded }
}

function stripTrailingDotsAndSpaces(p: string): string {
  return p
    .split('/')
    .map((seg) => seg.replace(/[. ]+$/, ''))
    .join('/')
}

// =========================================
// §6.6 Exclusion table (operation-aware)
// =========================================

interface ExclusionEntry {
  /**
   * Predicate matching against the normalized exclusion key
   * (project-relative, case-folded, forward-slash separated).
   */
  match: (key: string) => boolean
  /** Operations this entry blocks. */
  blockedOps: ReadonlyArray<ExclusionOperation>
  /**
   * Scopes that bypass the block on the **read** path only. For the
   * v1.8 narrow-scope subtrees (`.claude/agents/` tree, `.claude/skills/`
   * tree, any nested `CLAUDE.md`), these are the dedicated read-permission
   * scopes (`agents-read`, `skills-read`, `claude-md-read`) — recipes
   * must hold one of them to read those paths; `project-read` is
   * **not** sufficient.
   *
   * Empty / undefined means no read bypass exists. Write bypass is
   * intentionally absent in v0.2.x: the spec-defined `agents-write` /
   * `skills-write` opt-in scopes are deferred to v0.3.0 alongside the
   * re-enabled install path (§6.5.3 final paragraph, temporary
   * disabled path).
   */
  readBypassScopes?: ReadonlyArray<Scope>
}

const EXCLUSIONS: readonly ExclusionEntry[] = [
  // .env exact or .env.* and the same as a basename anywhere nested.
  {
    match: (k) => matchEnv(k),
    blockedOps: ['read', 'write'],
  },
  // .git directory tree and the `.git` gitfile (worktree / submodule
  // pointer file). A v0.2.1 follow-up will extend matching to
  // bare-repo / submodule linked gitdirs once §6.6.1 normative
  // implementation lands.
  {
    match: (k) => matchGit(k),
    blockedOps: ['read', 'write'],
  },
  // node_modules tree.
  {
    match: (k) => matchNodeModules(k),
    blockedOps: ['read', 'write'],
  },
  // .claude/credentials* — single-file or extension family.
  {
    match: (k) => matchClaudeCredentials(k),
    blockedOps: ['read', 'write'],
  },
  // v1.8: .claude/hooks/** — RCE vector via Claude Code launch hooks.
  {
    match: (k) => matchClaudeHooks(k),
    blockedOps: ['read', 'write'],
  },
  // v1.8: .claude/settings.json + .claude/settings.local.json — Claude
  // Code per-project configuration (hook registration etc.).
  {
    match: (k) => matchClaudeSettings(k),
    blockedOps: ['read', 'write'],
  },
  // v1.8: .claude/commands/** — Claude Code slash-command definitions.
  {
    match: (k) => matchClaudeCommands(k),
    blockedOps: ['read', 'write'],
  },
  // v1.8: .claude/agents/** — read+write blocked; reads bypass only
  // via the dedicated `agents-read` scope (project-read cannot reach
  // these paths).
  {
    match: (k) => matchClaudeAgents(k),
    blockedOps: ['read', 'write'],
    readBypassScopes: ['agents-read'],
  },
  // v1.8: .claude/skills/** — read+write blocked; reads bypass only
  // via the dedicated `skills-read` scope.
  {
    match: (k) => matchClaudeSkills(k),
    blockedOps: ['read', 'write'],
    readBypassScopes: ['skills-read'],
  },
  // v1.8: CLAUDE.md / CLAUDE.local.md anywhere under the project root
  // (case-insensitive). Read+write blocked; reads bypass only via the
  // dedicated `claude-md-read` scope.
  {
    match: (k) => matchClaudeMdBasename(k),
    blockedOps: ['read', 'write'],
    readBypassScopes: ['claude-md-read'],
  },
]

// --- match predicates (each receives the normalized key) ---

function matchEnv(k: string): boolean {
  if (k === '.env' || k.startsWith('.env.')) return true
  const idx = k.lastIndexOf('/')
  const base = idx === -1 ? k : k.slice(idx + 1)
  return base === '.env' || base.startsWith('.env.')
}

function matchGit(k: string): boolean {
  if (k === '.git') return true
  return k.startsWith('.git/')
}

function matchNodeModules(k: string): boolean {
  if (k === 'node_modules') return true
  return k.startsWith('node_modules/')
}

function matchClaudeCredentials(k: string): boolean {
  return k === '.claude/credentials' || k.startsWith('.claude/credentials')
}

function matchClaudeHooks(k: string): boolean {
  return k === '.claude/hooks' || k.startsWith('.claude/hooks/')
}

function matchClaudeSettings(k: string): boolean {
  return k === '.claude/settings.json' || k === '.claude/settings.local.json'
}

function matchClaudeCommands(k: string): boolean {
  return k === '.claude/commands' || k.startsWith('.claude/commands/')
}

function matchClaudeAgents(k: string): boolean {
  return k === '.claude/agents' || k.startsWith('.claude/agents/')
}

function matchClaudeSkills(k: string): boolean {
  return k === '.claude/skills' || k.startsWith('.claude/skills/')
}

function matchClaudeMdBasename(k: string): boolean {
  if (k === '') return false
  const idx = k.lastIndexOf('/')
  const base = idx === -1 ? k : k.slice(idx + 1)
  return base === 'claude.md' || base === 'claude.local.md'
}

// =========================================
// §6.6.3 isForbidden — operation + matchedScope aware
// =========================================

/**
 * Determine whether the given exclusion key matches an entry that
 * blocks the requested operation under the matched scope.
 *
 * Callers must pass the normalized key from
 * {@link normalizeForExclusionMatch}. The signature mirrors the
 * normative shape from recipe-system.md v1.8 §6.6.3.
 *
 * `matchedScope === null` indicates a check path that runs outside
 * the recipe scope dispatcher (e.g. the artifact-path-validator's
 * project-internal preview path). Bypass scopes never trigger in that
 * mode, so non-scope callers see full-strength exclusion.
 *
 * @param exclusionKey - Output of normalizeForExclusionMatch (the
 *   project-relative, case-folded form). Pass the empty string to
 *   signal "outside project root" — the function returns false.
 * @param _projectRoot - Project root; unused at this layer but kept
 *   in the signature for spec parity and future absolute-key needs.
 * @param context - operation kind + scope that matched in the
 *   precedence loop.
 */
export function isForbidden(
  exclusionKey: string,
  _projectRoot: string,
  context: { operation: ExclusionOperation; matchedScope: Scope | null },
): boolean {
  if (exclusionKey === '') return false
  for (const entry of EXCLUSIONS) {
    if (!entry.match(exclusionKey)) continue
    if (!entry.blockedOps.includes(context.operation)) continue
    // Read-only bypass: a recipe with the dedicated read scope
    // (`agents-read` / `skills-read` / `claude-md-read`) may read the
    // narrow-scope subtree even though the entry blocks reads from a
    // broader scope like `project-read`. Writes are never bypassed in
    // v0.2.x — see the `readBypassScopes` field comment for the
    // temporary-disabled rationale.
    if (
      context.operation === 'read' &&
      entry.readBypassScopes &&
      context.matchedScope !== null &&
      entry.readBypassScopes.includes(context.matchedScope)
    ) {
      continue
    }
    return true
  }
  return false
}

// =========================================
// filterExcludedEntries — operation-aware (list-files only)
// =========================================

/**
 * Remove excluded paths from a list-files result.
 *
 * v1.8: callers pass the recipe's approvedScopes so per-entry bypass
 * selection can keep readable entries under `.claude/agents/`,
 * `.claude/skills/`, and `<any>/CLAUDE.md` visible when the recipe
 * holds the corresponding read scope. Suspicious-char rejections are
 * silently dropped (metadata-leak avoidance) and recorded as a
 * security event in the server log.
 */
export function filterExcludedEntries<T extends { path: string }>(
  entries: T[],
  context: {
    operation: 'read'
    approvedScopes: readonly Scope[]
    projectRoot: string
  },
): T[] {
  const { operation, approvedScopes, projectRoot } = context
  return entries.filter((entry) => {
    const absPath = path.isAbsolute(entry.path)
      ? entry.path
      : path.join(projectRoot, entry.path)
    const normalize = normalizeForExclusionMatch(absPath, projectRoot)
    if (!normalize.ok) {
      reportSuspiciousCharRejection(absPath)
      return false
    }
    const matchedScope = selectReadBypassScope(normalize.key, approvedScopes)
    return !isForbidden(normalize.key, projectRoot, {
      operation,
      matchedScope,
    })
  })
}

/**
 * Pick the recipe-approved scope that, if any, bypasses a read-time
 * exclusion for the given entry. Returns null when no relevant
 * bypass scope is held (the read will be blocked).
 */
function selectReadBypassScope(
  exclusionKey: string,
  approvedScopes: readonly Scope[],
): Scope | null {
  for (const entry of EXCLUSIONS) {
    if (!entry.match(exclusionKey)) continue
    if (!entry.readBypassScopes) continue
    for (const bypass of entry.readBypassScopes) {
      if (approvedScopes.includes(bypass)) return bypass
    }
  }
  return null
}

// =========================================
// Suspicious-char security event
// =========================================

/**
 * Emit a structured security event for a path rejected by §6.6.2
 * step 3 (zero-width / bidi-override). The event sits outside the
 * regular handler audit log because rejection happens before scope
 * selection — no appId / recipeId context exists at this point.
 * Forensic queries filter on `event: 'PathRejectedSuspiciousChar'`.
 *
 * @see recipe-system.md v1.8 §6.5.5 / §6.6.2 step 3
 */
function reportSuspiciousCharRejection(physicalPath: string): void {
  log.warn(
    { event: 'PathRejectedSuspiciousChar', physicalPath },
    'Rejected path containing zero-width or bidi-override characters',
  )
}

// =========================================
// Scope validation
// =========================================

export interface ScopeValidationResult {
  ok: boolean
  failedCode?: HandlerErrorCode
  /**
   * Fully resolved absolute path of the validated argument, computed
   * once inside the dispatcher so handlers do not have to (and must
   * not) re-derive it from `projectRoot + input.path`. Set only when
   * `ok === true`. The dispatcher threads this onto `HandlerContext`
   * so path-bound handlers consume the same physical path that
   * passed scope/exclusion checks. Closes the scope-escape gap that
   * arose when a handler re-resolved a relative argument against
   * `projectRoot` regardless of which scope had matched, and
   * narrows the symlink-swap race window between validation and
   * the subsequent fs operation.
   */
  resolvedPath?: string
}

/**
 * Validate that a path argument is within an approved scope's region
 * and is not blocked by the operation-aware exclusion table.
 *
 * On success returns `{ ok: true, resolvedPath }` so the dispatcher
 * can hand the physical path to the handler verbatim.
 *
 * v1.8 adds an explicit `operation` argument so the exclusion table
 * can distinguish read-vs-write decisions and so write-only blocks
 * (`.claude/agents/`, `.claude/skills/`, `<any>/CLAUDE.md`) keep reads
 * working when the recipe holds the matching `*-read` scope.
 *
 * @param rawPath - Path argument received by the handler
 * @param approvedScopes - Scopes approved by the user at install time
 * @param requiredScopes - Scopes accepted by this handler (any match
 *   is sufficient)
 * @param appId - KB-local app id (drives `own-data` scope root)
 * @param projectRoot - Target project root
 * @param kovitoboardRoot - KovitoBoard installation root (kb-data-read)
 * @param operation - Operation kind: 'read' for read-file / list-files,
 *   'write' for write-file. Threaded into the exclusion table.
 */
export function validatePathForScope(
  rawPath: string,
  approvedScopes: readonly Scope[],
  requiredScopes: readonly Scope[],
  appId: string,
  projectRoot: string,
  kovitoboardRoot: string | undefined,
  operation: ExclusionOperation,
): ScopeValidationResult {
  const matchingScopes = requiredScopes.filter((s) =>
    approvedScopes.includes(s),
  )

  if (matchingScopes.length === 0) {
    return { ok: false, failedCode: 'ScopeViolation' }
  }

  // Resolve symlinks in the supplied roots up front so the prefix
  // comparison below sees the same physical path that
  // `normalizePath(rawPath, scopeRoot)` returns.
  const projectRootResolved = realpathUpToExisting(projectRoot)
  const kovitoboardRootResolved = kovitoboardRoot
    ? realpathUpToExisting(kovitoboardRoot)
    : undefined

  // Spec §6.6.3 evaluation order: try every matching scope in turn.
  // An exclusion hit under a broader scope (e.g. `project-read`) is
  // not the final answer — a narrower scope (`agents-read`,
  // `skills-read`, `claude-md-read`) may still bypass the read block
  // and authorize the operation. We therefore track whether any
  // scope hit the exclusion table so the final outcome can be
  // disambiguated between `PathOutOfScope` (no scope ever covered
  // the region) and `PathForbidden` (a scope covered the region but
  // could not bypass the exclusion).
  //
  // Subtle case: `.git/HEAD` read with `[project-read, own-data]`.
  // `project-read` covers the path with an exclusion hit, but
  // `own-data` re-interprets the relative path against
  // `app/data/<appId>/` so the project-relative exclusion key no
  // longer starts with `.git/`. The own-data branch reaches
  // `{ ok: true }` and the handler then fails open as `NotFound`
  // when no such file lives inside the recipe's data root. That is
  // intentional: the attacker-controlled rawPath never touched
  // `<projectRoot>/.git/HEAD` itself (own-data has its own root), so
  // the v1.0 `PathForbidden` was tighter than the spec requires.
  let blockedByExclusion = false

  for (const scope of matchingScopes) {
    const scopeRoot = realpathUpToExisting(
      resolveScopeRoot(
        scope,
        projectRootResolved,
        appId,
        kovitoboardRootResolved,
      ),
    )
    let physical: string

    try {
      physical = normalizePath(rawPath, scopeRoot)
    } catch (err) {
      if (err instanceof PathResolutionError) {
        return { ok: false, failedCode: 'Internal' }
      }
      throw err
    }

    // claude-md-read is a file-only scope. It only ever allows reads
    // of `<any>/CLAUDE.md` / `<any>/CLAUDE.local.md`. Writes never match,
    // so a write attempt under this scope falls through to the next
    // scope without setting blockedByExclusion.
    if (scope === 'claude-md-read') {
      if (operation === 'write') continue
      if (!isClaudeMdPath(physical, projectRootResolved)) continue
      const normalized = normalizeForExclusionMatch(
        physical,
        projectRootResolved,
      )
      if (!normalized.ok) {
        reportSuspiciousCharRejection(physical)
        return { ok: false, failedCode: 'Internal' }
      }
      if (
        isForbidden(normalized.key, projectRootResolved, {
          operation,
          matchedScope: scope,
        })
      ) {
        blockedByExclusion = true
        continue
      }
      return { ok: true, resolvedPath: physical }
    }

    if (!isWithin(physical, scopeRoot)) continue

    const normalized = normalizeForExclusionMatch(physical, projectRootResolved)
    if (!normalized.ok) {
      reportSuspiciousCharRejection(physical)
      return { ok: false, failedCode: 'Internal' }
    }
    if (
      isForbidden(normalized.key, projectRootResolved, {
        operation,
        matchedScope: scope,
      })
    ) {
      blockedByExclusion = true
      continue
    }

    return { ok: true, resolvedPath: physical }
  }

  // Distinguish "region covered, exclusion bit" from "no scope ever
  // covered the region" so callers see the spec-defined error code.
  return {
    ok: false,
    failedCode: blockedByExclusion ? 'PathForbidden' : 'PathOutOfScope',
  }
}

/**
 * Scope-only validation (for handlers without path arguments).
 * Used by own-data-bound handlers such as kv-*.
 */
export function validateScopeOnly(
  approvedScopes: readonly Scope[],
  requiredScopes: readonly Scope[],
): ScopeValidationResult {
  const hasMatch =
    requiredScopes.length === 0 ||
    requiredScopes.some((s) => approvedScopes.includes(s))
  return hasMatch
    ? { ok: true }
    : { ok: false, failedCode: 'ScopeViolation' }
}
