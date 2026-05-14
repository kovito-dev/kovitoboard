/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Path validator for the file-preview endpoints
 * (`/api/artifact{,/raw}`).
 *
 * Two responsibilities:
 *
 * 1. Confine the resolved path to one of the artifact-readable roots
 *    — the project root, or the upload directory. Anything else is
 *    refused with a 403 so a caller cannot use the preview surface
 *    to read arbitrary host files (`/etc/shadow`, the user's home
 *    directory, etc.).
 *
 * 2. Apply the same hardcoded exclusion list the dispatcher enforces
 *    on recipe handlers (`.env`, `.env.*`, `.git/**`, `node_modules/**`,
 *    `.claude/credentials*`), so the preview path cannot bypass scope
 *    rules that the dispatcher already protects against. This used to
 *    be a side-channel: a recipe handler could not read `.env` via
 *    `read-file`, but the same caller could fetch
 *    `GET /api/artifact?path=.env` and pull the contents straight back.
 *
 * The size-cap parameter is opt-in. The JSON endpoint
 * (`/api/artifact`) does not pass it because `readArtifact` itself
 * substitutes a `[File too large: NNkB]` placeholder beyond its own
 * 1 MiB cap; the binary endpoint (`/api/artifact/raw`) passes
 * `HANDLER_LIMITS.READ_FILE_MAX_SIZE` so an oversized file cannot
 * stream unbounded bytes through `res.sendFile`. Aligning the raw
 * cap with the `read-file` handler keeps callers seeing a consistent
 * limit whether they reach the file via the dispatcher or via the
 * preview route.
 *
 * Pulled into its own module so the validator is unit-testable in
 * isolation — passing `projectRoot`, `uploadDir`, and `fs` as
 * arguments rather than closing over module-level state in
 * `index.ts` lets tests construct ephemeral fixtures.
 */

import { isAbsolute, normalize, resolve } from 'path'
import type { FileAccessLayer } from './fs-layer'
import { isForbidden, normalizeForExclusionMatch } from './scopeValidator'
import { realpathUpToExisting } from './pathResolver'

export type ArtifactPathValidation =
  | { ok: true; resolved: string }
  | { ok: false; status: number; error: string }

export interface ArtifactPathValidatorContext {
  /**
   * Absolute, canonicalized project root path. Callers MUST pass a
   * realpath-resolved value (build the context via
   * `prepareArtifactPathContext`); the validator does not
   * re-canonicalize it on every request because `projectRoot` is
   * process-stable.
   */
  projectRoot: string
  /**
   * Absolute, canonicalized upload directory path. Same canonical
   * contract as `projectRoot`. Files placed here by the upload
   * endpoint (`/api/upload`) carry UUID-based names produced by
   * server code, so reads confined to this directory are considered
   * safe even though it lives outside `projectRoot`.
   */
  uploadDir: string
  /** Filesystem access layer used for the optional size check. */
  fs: FileAccessLayer
}

/**
 * Build a canonical `ArtifactPathValidatorContext` from raw inputs.
 *
 * Both `projectRoot` and `uploadDir` are realpath-resolved once here
 * so per-request validation does not have to repeat the syscall on
 * every `/api/artifact{,/raw}` hit (the preview pane polls these
 * endpoints frequently). Centralizing the canonicalization in the
 * factory also keeps the canonical-space invariant from §I-5 in one
 * place: callers cannot accidentally hand the validator a lexical
 * project root and silently weaken confinement.
 */
export function prepareArtifactPathContext(raw: {
  projectRoot: string
  uploadDir: string
  fs: FileAccessLayer
}): ArtifactPathValidatorContext {
  return {
    projectRoot: realpathUpToExisting(raw.projectRoot),
    uploadDir: realpathUpToExisting(raw.uploadDir),
    fs: raw.fs,
  }
}

export interface ArtifactPathValidatorOptions {
  /**
   * Optional upper bound on the resolved file's size. Returns 413
   * when the file exceeds this many bytes. Omit on endpoints that
   * implement their own size handling (e.g. the JSON endpoint that
   * embeds an oversize placeholder via `readArtifact`).
   */
  maxSize?: number
}

/**
 * Project-root and upload-directory confinement, no exclusion check.
 * Returns the canonicalized absolute path, or `null` when the
 * requested path resolves outside both allowed roots.
 *
 * The check follows symlinks via `realpathUpToExisting` before the
 * prefix comparison so a symlink under `projectRoot` (or
 * `uploadDir`) that points outside the allowed roots cannot bypass
 * the confinement: the canonicalized target is what gets compared,
 * not the lexical path the caller submitted. `realpathUpToExisting`
 * resolves the existing prefix and appends any not-yet-existing
 * segments untouched, so validation works whether the file exists
 * or not.
 *
 * Exposed for callers that need just the confinement step (none in
 * production today; kept available so future preview-adjacent
 * endpoints can opt in incrementally without re-deriving the upload
 * dir prefix logic).
 */
export function resolveArtifactPath(
  requestedPath: string,
  ctx: Pick<ArtifactPathValidatorContext, 'projectRoot' | 'uploadDir'>,
): string | null {
  const lexical = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : normalize(resolve(ctx.projectRoot, requestedPath))

  // Canonicalize the requested path. Without it, a symlink under
  // `projectRoot` pointing outside the allowed roots would pass the
  // lexical prefix check and let the read leak out. The roots are
  // canonical already (see `prepareArtifactPathContext`), so we only
  // need the request-side syscall here.
  //
  // `realpathUpToExisting` resolves the existing prefix and appends
  // any not-yet-existing segments untouched, so validation works for
  // paths whose tail does not exist yet (a `?path=missing.txt`
  // request still reaches the size-check / 404 branch instead of
  // throwing during validation). Realpath failures (loops,
  // permission errors) refuse the read with `null`.
  let canonical: string
  try {
    canonical = realpathUpToExisting(lexical)
  } catch {
    return null
  }

  if (canonical === ctx.projectRoot || canonical.startsWith(ctx.projectRoot + '/')) {
    return canonical
  }

  if (canonical === ctx.uploadDir || canonical.startsWith(ctx.uploadDir + '/')) {
    return canonical
  }

  return null
}

/**
 * Full validator used by `/api/artifact{,/raw}`. Returns either the
 * confined absolute path that passed the exclusion check (and the
 * optional size cap), or a `(status, error)` pair the caller can
 * forward to `res.status(...).json(...)` verbatim.
 */
export function validatePathForArtifactRead(
  requestedPath: string,
  ctx: ArtifactPathValidatorContext,
  options?: ArtifactPathValidatorOptions,
): ArtifactPathValidation {
  const resolved = resolveArtifactPath(requestedPath, ctx)
  if (!resolved) {
    return {
      ok: false,
      status: 403,
      error: 'Access denied: path is outside project root',
    }
  }
  // Project-relative exclusion check. `resolveArtifactPath` returns
  // a canonicalized path, and `ctx.projectRoot` is canonical too
  // (built via `prepareArtifactPathContext`), so the normalized key
  // computation lines up with the on-disk layout. An empty key
  // (path outside the project root, e.g. the upload directory)
  // returns `false`, so attached uploads keep rendering through the
  // preview pane.
  //
  // The artifact pipeline runs outside the recipe scope dispatcher,
  // so we pass `matchedScope: null` — no recipe-style bypass scopes
  // apply, and the v1.8 operation-aware table gives the artifact
  // surface the strongest read-time exclusion (recipe-system.md
  // §6.6.3).
  const exclusionKey = normalizeForExclusionMatch(resolved, ctx.projectRoot)
  if (!exclusionKey.ok) {
    return {
      ok: false,
      status: 403,
      error: 'Access denied: path contains zero-width or bidi-override characters',
    }
  }
  if (
    isForbidden(exclusionKey.key, ctx.projectRoot, {
      operation: 'read',
      matchedScope: null,
    })
  ) {
    return {
      ok: false,
      status: 403,
      error: 'Access denied: path matches the artifact exclusion list',
    }
  }
  if (options?.maxSize !== undefined) {
    let stats: ReturnType<FileAccessLayer['lstatSync']>
    try {
      // `lstat` because `resolved` is already realpath-canonicalized
      // upstream — there is no link left to follow at this point, and
      // `lstatSync` exposes the `isFile` predicate `statSync` omits
      // from `FileStat`.
      stats = ctx.fs.lstatSync(resolved)
    } catch {
      // ENOENT (and friends) => 404 so the caller distinguishes
      // "missing" from "blocked" without leaking fs error details.
      return { ok: false, status: 404, error: 'File not found' }
    }
    // Reject anything that is not a regular file. FIFOs, sockets,
    // and device nodes can report `size === 0` and still block or
    // stream unboundedly when opened — `res.sendFile` would then
    // either hang the request or pump arbitrary kernel-supplied
    // bytes through the response. Directories trip the same trap
    // (`sendFile` against a directory errors out unpredictably).
    // Refusing them here keeps the size cap meaningful and the
    // streaming surface bounded.
    if (!stats.isFile) {
      return {
        ok: false,
        status: 403,
        error: 'Access denied: target is not a regular file',
      }
    }
    if (stats.size > options.maxSize) {
      return {
        ok: false,
        status: 413,
        error: `File size ${stats.size} exceeds the artifact read limit of ${options.maxSize} bytes`,
      }
    }
  }
  return { ok: true, resolved }
}
