/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe upload router (RC-3 / spec §6.x — file-picker source).
 *
 * Browser sandboxing prevents us from receiving a real local path
 * back from `<input type="file">` — we only get the file content. To
 * keep the existing `parseRecipe` flow (which resolves a directory or
 * single-file path on disk) reusable, this router materializes the
 * uploaded payload into a transient directory under the OS tmpdir,
 * runs `parseRecipe` against that directory, then deletes everything.
 *
 * The endpoint accepts a JSON body shaped like:
 *
 *   { files: [{ relPath: 'recipe.yaml', content: '…' }, …] }
 *
 * which is materialized into:
 *
 *   <tmp>/kb-recipe-upload-<rand>/
 *     recipe.yaml
 *     pages/Index.tsx
 *     …
 *
 * `parseRecipe` is then called with either the single-file path
 * (when the upload is a lone `.md`) or the directory path (when a
 * `recipe.yaml` was included). The transient files only live long
 * enough for the synchronous parser to read their contents — the
 * parser already inlines artifact bodies into `recipe.artifacts[*].content`,
 * so the cleanup below cannot hurt downstream consumers.
 */

import { Router } from 'express'
import express from 'express'
import { join, normalize, dirname } from 'path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import type { FileAccessLayer } from '../fs-layer'
import { parseRecipe, RecipeParseError } from '../recipe-parser'
import { inspectRecipe } from '../recipe-inspector'
import type { RecipeParseUploadRequest, RecipeUploadFile } from '../../shared/recipe-types'
import { lazyChildLogger } from '../logger'

const uploadLog = lazyChildLogger('recipe-upload')

/** Cap each individual file at 1MB. Recipe artifacts are tiny in practice. */
const MAX_FILE_SIZE = 1 * 1024 * 1024
/** Cap the whole request at 5MB so a hostile client cannot exhaust tmpdir. */
const MAX_TOTAL_SIZE = 5 * 1024 * 1024
/** Hard limit on files per upload — recipes ship single-digit artifact counts. */
const MAX_FILE_COUNT = 50

/**
 * Extensions we let through the upload surface. Mirrors the parser's
 * own ALLOWED_EXTENSIONS plus `.yaml` (the manifest) and `.markdown`.
 * Anything outside this set is rejected up-front rather than written
 * to tmp and rejected later.
 */
const ALLOWED_EXTS = new Set([
  '.tsx',
  '.ts',
  '.css',
  '.json',
  '.md',
  '.markdown',
  '.yaml',
  '.yml',
])

interface ValidationFailure {
  status: number
  error: string
}

/**
 * Reject anything that would let the upload escape the transient
 * recipe directory: leading slashes, `..` segments, drive letters,
 * non-string types, etc. Returns null when the path is safe.
 */
function validateRelPath(relPath: unknown): ValidationFailure | null {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return { status: 400, error: 'Each file requires a non-empty relPath' }
  }
  if (relPath.length > 512) {
    return { status: 400, error: `relPath too long: ${relPath.slice(0, 60)}…` }
  }
  // Normalize using forward slashes regardless of host OS so the
  // traversal check below catches Windows-style separators too.
  const unified = relPath.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    return { status: 400, error: `relPath must be relative: ${relPath}` }
  }
  // Split into segments and verify each one. `normalize` would also
  // collapse `..` quietly, but we want a hard rejection so a hostile
  // client cannot smuggle a path that resolves outside the tmp dir.
  const segs = unified.split('/').filter((s) => s.length > 0)
  for (const seg of segs) {
    if (seg === '..' || seg === '.') {
      return { status: 400, error: `relPath cannot contain '..' / '.': ${relPath}` }
    }
    if (seg.includes('\0')) {
      return { status: 400, error: `relPath contains a null byte: ${relPath}` }
    }
  }
  // Extension whitelist — the parser will refuse everything else
  // anyway, but rejecting up-front keeps the tmp dir clean.
  const dotIdx = unified.lastIndexOf('.')
  if (dotIdx < 0) {
    return { status: 400, error: `relPath has no extension: ${relPath}` }
  }
  const ext = unified.slice(dotIdx).toLowerCase()
  if (!ALLOWED_EXTS.has(ext)) {
    return { status: 400, error: `Unsupported file extension: ${ext}` }
  }
  return null
}

/**
 * Validate the `files[]` array shape and aggregate size budget. Returns
 * the validated list on success or a request-shaped error on failure.
 */
function validateFiles(
  raw: unknown,
): { files: RecipeUploadFile[] } | ValidationFailure {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { status: 400, error: 'files must be a non-empty array' }
  }
  if (raw.length > MAX_FILE_COUNT) {
    return { status: 400, error: `Too many files (max ${MAX_FILE_COUNT})` }
  }

  const seen = new Set<string>()
  let total = 0
  const validated: RecipeUploadFile[] = []

  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      return { status: 400, error: 'Each file entry must be an object' }
    }
    const e = entry as Record<string, unknown>
    const pathFailure = validateRelPath(e.relPath)
    if (pathFailure) return pathFailure
    if (typeof e.content !== 'string') {
      return { status: 400, error: 'Each file requires a string content' }
    }
    const size = Buffer.byteLength(e.content, 'utf-8')
    if (size > MAX_FILE_SIZE) {
      return { status: 413, error: `File too large: ${e.relPath as string}` }
    }
    total += size
    if (total > MAX_TOTAL_SIZE) {
      return { status: 413, error: 'Combined upload exceeds 5MB' }
    }
    const unified = (e.relPath as string).replace(/\\/g, '/')
    if (seen.has(unified)) {
      return { status: 400, error: `Duplicate relPath: ${e.relPath as string}` }
    }
    seen.add(unified)
    validated.push({ relPath: unified, content: e.content })
  }
  return { files: validated }
}

/**
 * Materialize the validated list into a freshly-created tmpdir and
 * return both the dir path and the resolved entry point that
 * `parseRecipe` should be pointed at. The entry point is the
 * directory itself when a `recipe.yaml` is present (canonical
 * directory recipe), otherwise the lone `.md` file.
 */
function writeUploadToTmp(
  files: RecipeUploadFile[],
): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kb-recipe-upload-'))
  for (const file of files) {
    const targetPath = normalize(join(dir, file.relPath))
    if (!targetPath.startsWith(dir)) {
      // Defensive: validateRelPath should have caught traversal, but
      // re-check after normalize() because `normalize` resolves `..`
      // segments (which we do reject earlier) AND collapses adjacent
      // separators that could otherwise hide intent.
      throw new Error(`Refusing to write outside tmp dir: ${file.relPath}`)
    }
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, file.content, 'utf-8')
  }

  const yamlPath = join(dir, 'recipe.yaml')
  // The renderer hands us forward-slash relPaths, so we test with the
  // same separator the parser expects on this OS. We rely on the
  // top-level `existsSync` import: an earlier revision used
  // `require('fs')` inline, but the build target is pure ESM so the
  // legacy CJS shim throws `require is not defined` at runtime,
  // collapsing every upload into a 400 with "require is not defined"
  // instead of letting the parser actually run.
  if (existsSync(yamlPath)) {
    return { dir, entry: dir }
  }

  const mdFile = files.find(
    (f) => f.relPath.endsWith('.md') || f.relPath.endsWith('.markdown'),
  )
  if (!mdFile) {
    throw new Error(
      'Upload contained neither recipe.yaml nor a .md file. Pick a recipe directory or a single Markdown recipe.',
    )
  }
  return { dir, entry: join(dir, mdFile.relPath) }
}

/**
 * Wire the upload router on top of a dedicated `express.json` parser
 * with a higher limit than the application default — recipe payloads
 * routinely run a few hundred kB once you include `pages/*.tsx`.
 */
export function createRecipeUploadRouter(fs: FileAccessLayer): Router {
  const router = Router()

  router.post(
    '/parse-upload',
    express.json({ limit: `${MAX_TOTAL_SIZE}b` }),
    async (req, res) => {
      const body = (req.body ?? {}) as Partial<RecipeParseUploadRequest>
      const result = validateFiles(body.files)
      if ('status' in result) {
        res.status(result.status).json({ error: result.error })
        return
      }

      let dir: string | null = null
      try {
        const written = writeUploadToTmp(result.files)
        dir = written.dir
        const recipe = parseRecipe(written.entry, fs)
        const inspection = await inspectRecipe(recipe)
        res.json({ recipe, inspection })
      } catch (err) {
        // Map security-limits breaches to the spec-mandated 413 / 400
        // envelope (security-limits.md §6.2). The structured warn log
        // emitted inside the parser keeps the forensic fields; this
        // outer log records the route-level outcome.
        if (err instanceof RecipeParseError) {
          uploadLog.warn({ err }, 'Recipe upload rejected by security limits')
          res.status(err.context.httpStatus).json({
            error:
              err.context.httpStatus === 413
                ? 'Recipe exceeds the maximum allowed size'
                : 'Recipe exceeds an allowed limit',
          })
          return
        }
        const message = err instanceof Error ? err.message : 'Failed to parse uploaded recipe'
        uploadLog.error({ err }, 'Recipe upload parse error')
        res.status(400).json({ error: message })
      } finally {
        if (dir) {
          try {
            rmSync(dir, { recursive: true, force: true })
          } catch (cleanupErr) {
            uploadLog.warn(
              { err: cleanupErr, dir },
              'Failed to clean up recipe upload tmp dir',
            )
          }
        }
      }
    },
  )

  return router
}

// Exported for unit tests so the validation logic can be exercised
// without spinning up Express.
export { validateFiles, validateRelPath, writeUploadToTmp }
