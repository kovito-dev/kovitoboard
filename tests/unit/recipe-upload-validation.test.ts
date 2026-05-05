/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * RC-3: validation guard rails for the file-picker upload route.
 *
 * The renderer constructs a JSON payload from the user's file
 * selection and POSTs it to /api/recipes/parse-upload. The server
 * has to reject anything that would (a) escape the transient tmp
 * directory or (b) exhaust resources before the real parser is ever
 * called. These tests pin those invariants so a future refactor of
 * `validateFiles` cannot silently weaken them.
 */
import { describe, it, expect } from 'vitest'
import {
  validateFiles,
  validateRelPath,
} from '../../src/server/routes/recipe-upload-routes'

const TINY = 'noop\n'

describe('validateRelPath (RC-3 path safety)', () => {
  it('accepts a normal recipe-relative path', () => {
    expect(validateRelPath('recipe.yaml')).toBeNull()
    expect(validateRelPath('pages/Index.tsx')).toBeNull()
    expect(validateRelPath('lib/utils/helpers.ts')).toBeNull()
  })

  it('rejects an absolute path', () => {
    const f = validateRelPath('/etc/passwd.json')
    expect(f).not.toBeNull()
    expect(f?.error).toMatch(/must be relative/i)
  })

  it('rejects a Windows-style absolute path', () => {
    const f = validateRelPath('C:\\windows\\hosts.json')
    expect(f).not.toBeNull()
    expect(f?.error).toMatch(/must be relative/i)
  })

  it('rejects parent-traversal segments', () => {
    expect(validateRelPath('../etc/passwd.json')).not.toBeNull()
    expect(validateRelPath('pages/../../escape.tsx')).not.toBeNull()
    expect(validateRelPath('a/./b.json')).not.toBeNull()
  })

  it('rejects an unsupported extension', () => {
    const f = validateRelPath('payload.bin')
    expect(f).not.toBeNull()
    expect(f?.error).toMatch(/unsupported file extension/i)
  })

  it('rejects an extensionless path', () => {
    expect(validateRelPath('Makefile')).not.toBeNull()
  })

  it('rejects an empty / non-string relPath', () => {
    expect(validateRelPath('')).not.toBeNull()
    expect(validateRelPath(null)).not.toBeNull()
    expect(validateRelPath(undefined)).not.toBeNull()
    expect(validateRelPath(42)).not.toBeNull()
  })

  it('rejects a path containing a null byte', () => {
    const f = validateRelPath('recipe\0.yaml')
    expect(f).not.toBeNull()
    expect(f?.error).toMatch(/null byte/i)
  })
})

describe('validateFiles (RC-3 payload shape + size budget)', () => {
  it('accepts a single .md upload', () => {
    const result = validateFiles([{ relPath: 'recipe.md', content: TINY }])
    expect('files' in result).toBe(true)
    if ('files' in result) {
      expect(result.files).toHaveLength(1)
      expect(result.files[0].relPath).toBe('recipe.md')
    }
  })

  it('accepts a multi-file directory upload', () => {
    const result = validateFiles([
      { relPath: 'recipe.yaml', content: 'name: foo\n' },
      { relPath: 'pages/Index.tsx', content: 'export default () => null' },
    ])
    expect('files' in result).toBe(true)
  })

  it('rejects an empty array', () => {
    const r = validateFiles([])
    expect('error' in r).toBe(true)
  })

  it('rejects a non-array payload', () => {
    expect('error' in validateFiles(null)).toBe(true)
    expect('error' in validateFiles({ recipe: 'foo' })).toBe(true)
  })

  it('rejects a duplicate relPath (catches accidental override)', () => {
    const r = validateFiles([
      { relPath: 'recipe.yaml', content: TINY },
      { relPath: 'recipe.yaml', content: TINY },
    ])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/duplicate/i)
  })

  it('rejects a malformed entry (missing content)', () => {
    const r = validateFiles([{ relPath: 'recipe.md' }])
    expect('error' in r).toBe(true)
  })

  it('rejects > 50 files', () => {
    const big = Array.from({ length: 51 }, (_, i) => ({
      relPath: `pages/file-${i}.tsx`,
      content: TINY,
    }))
    const r = validateFiles(big)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/too many files/i)
  })

  it('rejects an oversize single file (> 1MB)', () => {
    const fat = 'x'.repeat(1024 * 1024 + 1)
    const r = validateFiles([{ relPath: 'recipe.md', content: fat }])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.status).toBe(413)
  })

  it('rejects when the combined size exceeds 5MB', () => {
    const oneMB = 'x'.repeat(1024 * 1024 - 4)
    const files = Array.from({ length: 6 }, (_, i) => ({
      relPath: `pages/file-${i}.tsx`,
      content: oneMB,
    }))
    const r = validateFiles(files)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.status).toBe(413)
  })

  it('normalizes back-slashes in relPath to forward slashes', () => {
    const r = validateFiles([
      { relPath: 'pages\\Index.tsx', content: TINY },
    ])
    expect('files' in r).toBe(true)
    if ('files' in r) expect(r.files[0].relPath).toBe('pages/Index.tsx')
  })
})
