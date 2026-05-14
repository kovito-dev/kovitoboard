/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * list-files handler — Returns a list of files and directories within a directory.
 *
 * Traverses the directory using BFS and returns an entry list.
 * Excluded paths are removed from results via filterExcludedEntries.
 * Path validation is handled by the dispatcher, so no validation is done here.
 *
 * @see recipe-system.md §12-2-1 list-files
 * @stable v0.1.0
 */

import * as fs from 'fs'
import * as path from 'path'
import type {
  HandlerDef,
  ListFilesInput,
  ListFilesOutput,
  FileEntry,
  HandlerContext,
  HandlerResponse,
} from '../types.js'
import {
  handlerOk,
  handlerError,
  HANDLER_LIMITS,
  HANDLER_REQUIRED_SCOPES,
} from '../types.js'
import { filterExcludedEntries } from '../../scopeValidator.js'
import { realpathUpToExisting } from '../../pathResolver.js'

/**
 * Determines whether the dispatcher-resolved base path lands inside
 * this app's own-data root (`<projectRoot>/app/data/<appId>/`).
 * Used solely to pick the deeper traversal limit
 * (`LIST_FILES_MAX_DEPTH_OWN`); the actual scope check already
 * happened in the dispatcher and the physical base path arrives via
 * `context.resolvedPath`.
 *
 * Resolving against the physical own-data root (rather than the
 * shape of `input.path`) means callers can use the natural scope-
 * root-relative form (e.g. `.` or `notes/foo.md`) without losing the
 * deeper traversal allowance, and it cannot be tricked by an
 * `app/data/<appId>/...`-shaped path that resolved through some
 * other scope.
 *
 * Both sides are canonicalized via `realpathUpToExisting` so a
 * symlinked `projectRoot` (e.g. the kb-test runner's
 * `~/test/kb-latest -> kb-blank-<ts>`) does not cause the prefix
 * comparison to fall through; the dispatcher already returns a
 * realpath-resolved `context.resolvedPath`.
 */
function isOwnDataBase(context: HandlerContext): boolean {
  if (!context.approvedScopes.includes('own-data') || !context.resolvedPath) {
    return false
  }
  const ownDataRoot = realpathUpToExisting(
    path.join(context.projectRoot, 'app', 'data', context.appId),
  )
  const base = context.resolvedPath
  return base === ownDataRoot || base.startsWith(ownDataRoot + path.sep)
}

/**
 * Traverses a directory using BFS and returns an array of FileEntry.
 */
function listDirectory(
  basePath: string,
  recursive: boolean,
  maxDepth: number,
  maxEntries: number,
): FileEntry[] {
  const entries: FileEntry[] = []

  // BFS queue: [absolutePath, currentDepth]
  const queue: Array<[string, number]> = [[basePath, 0]]

  while (queue.length > 0 && entries.length < maxEntries) {
    const [currentDir, depth] = queue.shift()!

    let dirEntries: fs.Dirent[]
    try {
      dirEntries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      // Skip unreadable directories (e.g. insufficient permissions)
      continue
    }

    for (const dirent of dirEntries) {
      if (entries.length >= maxEntries) break

      const entryAbsPath = path.join(currentDir, dirent.name)
      const relativePath = path.relative(basePath, entryAbsPath)

      let stat: fs.Stats
      try {
        stat = fs.statSync(entryAbsPath)
      } catch {
        // Skip entries where stat fails
        continue
      }

      entries.push({
        name: dirent.name,
        path: relativePath,
        isDirectory: dirent.isDirectory(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      })

      // Recursive traversal: add to BFS queue if directory and within depth limit
      if (recursive && dirent.isDirectory() && depth < maxDepth) {
        queue.push([entryAbsPath, depth + 1])
      }
    }
  }

  return entries
}

export const listFilesHandler: HandlerDef<ListFilesInput, ListFilesOutput> = {
  name: 'list-files',
  requiredScopes: HANDLER_REQUIRED_SCOPES['list-files'],

  validate: (input: unknown): string | null => {
    if (input === null || typeof input !== 'object') {
      return 'input must be an object'
    }
    const obj = input as Record<string, unknown>

    if (typeof obj.path !== 'string' || obj.path.length === 0) {
      return 'path must be a non-empty string'
    }

    if (obj.recursive !== undefined && typeof obj.recursive !== 'boolean') {
      return 'recursive must be a boolean'
    }

    return null
  },

  execute: async (
    input: ListFilesInput,
    context: HandlerContext,
  ): Promise<HandlerResponse<ListFilesOutput>> => {
    // Use the physical base path the dispatcher resolved during
    // scope validation. Re-joining `context.projectRoot + input.path`
    // here would bypass the per-scope root (e.g. `own-data` lives
    // under `app/data/<appId>/`, not the project root) and re-open
    // the symlink-swap window between validate and readdir.
    if (!context.resolvedPath) {
      return handlerError('Internal', 'list-files requires a dispatcher-resolved path')
    }
    const basePath = context.resolvedPath
    const recursive = input.recursive ?? false

    // Check directory existence
    try {
      const stat = fs.statSync(basePath)
      if (!stat.isDirectory()) {
        return handlerError('InvalidArgs', `Path is not a directory: ${input.path}`)
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return handlerError('NotFound', `Directory not found: ${input.path}`)
      }
      return handlerError('Internal', `Failed to access directory: ${input.path}`)
    }

    // Switch max depth based on whether the path is own-data
    const maxDepth = isOwnDataBase(context)
      ? HANDLER_LIMITS.LIST_FILES_MAX_DEPTH_OWN
      : HANDLER_LIMITS.LIST_FILES_MAX_DEPTH_OTHER

    try {
      const rawEntries = listDirectory(
        basePath,
        recursive,
        maxDepth,
        HANDLER_LIMITS.LIST_FILES_MAX_ENTRIES,
      )

      // Remove excluded paths (temporarily convert entry paths to absolute for filtering)
      const entriesWithAbsPaths = rawEntries.map((entry) => ({
        ...entry,
        path: path.join(basePath, entry.path),
      }))
      const filtered = filterExcludedEntries(entriesWithAbsPaths, {
        operation: 'read',
        approvedScopes: context.approvedScopes,
        projectRoot: context.projectRoot,
      })

      // Convert results back to relative paths
      const result: FileEntry[] = filtered.map((entry) => ({
        ...entry,
        path: path.relative(basePath, entry.path),
      }))

      return handlerOk({ entries: result })
    } catch (err: unknown) {
      return handlerError('Internal', `Failed to list files: ${(err as Error).message}`)
    }
  },
}
