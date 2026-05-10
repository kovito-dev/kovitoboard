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
import { isForbidden } from './scopeValidator'
import { realpathUpToExisting } from './pathResolver'

export type ArtifactPathValidation =
  | { ok: true; resolved: string }
  | { ok: false; status: number; error: string }

export interface ArtifactPathValidatorContext {
  /** Absolute project root path. */
  projectRoot: string
  /**
   * Absolute upload directory path. Files placed here by the upload
   * endpoint (`/api/upload`) carry UUID-based names produced by
   * server code, so reads confined to this directory are considered
   * safe even though it lives outside `projectRoot`.
   */
  uploadDir: string
  /** Filesystem access layer used for the optional size check. */
  fs: FileAccessLayer
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

  // Canonicalize the requested path AND both allowed roots. Without
  // canonicalizing the roots, `requestedPath` could resolve to the
  // real target of a symlinked project root and fail the prefix
  // check; without canonicalizing the requested path, a symlink
  // under `projectRoot` pointing outside the allowed roots would
  // pass the lexical prefix check and let the read leak out.
  // Either failure mode lets a `?path=...` request reach files
  // outside the artifact surface, so the comparison has to happen
  // in canonical space on both sides.
  //
  // `realpathUpToExisting` resolves the existing prefix and
  // appends any not-yet-existing segments untouched, so validation
  // also works for files the caller asked to read but that have
  // been removed since (we still want the confinement check to
  // fail safely rather than throw).
  let canonical: string
  let projectRootCanon: string
  let uploadDirCanon: string
  try {
    canonical = realpathUpToExisting(lexical)
    projectRootCanon = realpathUpToExisting(ctx.projectRoot)
    uploadDirCanon = realpathUpToExisting(ctx.uploadDir)
  } catch {
    // Symlink loops or other realpath failures => refuse the read.
    return null
  }

  if (canonical === projectRootCanon || canonical.startsWith(projectRootCanon + '/')) {
    return canonical
  }

  if (canonical === uploadDirCanon || canonical.startsWith(uploadDirCanon + '/')) {
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
  // a canonicalized path, so the relative-path computation inside
  // `isForbidden` only matches the exclusion patterns when its
  // second argument is canonicalized too — otherwise a symlinked
  // project root would produce a `..`-prefixed relative form and
  // skip the check. `isForbidden` itself returns `false` for paths
  // outside the project (e.g. the upload directory), so attached
  // uploads keep rendering through the preview pane.
  let projectRootCanon: string
  try {
    projectRootCanon = realpathUpToExisting(ctx.projectRoot)
  } catch {
    return {
      ok: false,
      status: 403,
      error: 'Access denied: project root could not be resolved',
    }
  }
  if (isForbidden(resolved, projectRootCanon)) {
    return {
      ok: false,
      status: 403,
      error: 'Access denied: path matches the artifact exclusion list',
    }
  }
  if (options?.maxSize !== undefined) {
    let size: number
    try {
      size = ctx.fs.statSync(resolved).size
    } catch {
      // statSync raises ENOENT (and friends) here; route those to a
      // 404 so the caller distinguishes "missing" from "blocked"
      // without exposing fs error details.
      return { ok: false, status: 404, error: 'File not found' }
    }
    if (size > options.maxSize) {
      return {
        ok: false,
        status: 413,
        error: `File size ${size} exceeds the artifact read limit of ${options.maxSize} bytes`,
      }
    }
  }
  return { ok: true, resolved }
}
