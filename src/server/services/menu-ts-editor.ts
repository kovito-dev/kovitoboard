/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Menu TS editor — surgical edits to `app/menu.ts`.
 *
 * Used by `/api/recipes/uninstall` to remove an entry from
 * `menuEntries` without round-tripping the file through Claude Code.
 * Uninstall is the inverse of install, but we deliberately *do not*
 * make uninstall send a prompt to an agent: doing so would slow the
 * UX (cold-starting `claude` for a one-line array edit) and make the
 * operation depend on the trust-prompt handshake. A direct file edit
 * is fast, deterministic, and easy to test.
 *
 * Why regex instead of a real TS parser? `menu.ts` has a fixed shape
 * (the same template emitted by `recipe-applicator.buildMenuTsTemplate`
 * + the same regex consumed by `menu-extractor.parseMenuTs`), so a
 * parser-free approach keeps this module small and avoids pulling
 * `typescript` into the runtime dependency surface for a single use
 * case. If `menu.ts` is hand-edited into a shape this module cannot
 * recognize, callers receive an explicit `not-found` outcome and can
 * surface a helpful error to the user.
 */

const RECIPE_APPLICATOR_TEMPLATE_HEAD =
  "import type { AppMenuEntry } from '../src/renderer/types/app-types'"

/** Outcome of {@link removeMenuEntry}. */
export type MenuRemoveResult =
  | { kind: 'removed'; content: string }
  | { kind: 'not-found' }
  | { kind: 'parse-failed'; reason: string }

/**
 * Remove the entry whose `id` field matches `entryId` from a
 * `menu.ts` file's contents and return the rewritten source.
 *
 * Behavior:
 *   - When the entry is found, the entry literal *and* its trailing
 *     comma (if any) are stripped, then the array is reflowed so it
 *     remains valid TypeScript regardless of indentation.
 *   - When the entry is not present, returns `{ kind: 'not-found' }`
 *     so the caller can decide whether that is fatal or not (it is
 *     not fatal for uninstall — the user may have already removed
 *     the line by hand).
 *   - When the file does not declare `menuEntries` at all, returns
 *     `{ kind: 'parse-failed', reason }`.
 *
 * The implementation operates on the literal source string and does
 * not preserve hand-authored comments inside the matched entry — but
 * it leaves comments outside the entry untouched.
 */
export function removeMenuEntry(content: string, entryId: string): MenuRemoveResult {
  // Locate the menuEntries array.
  const arrayMatch = /export\s+const\s+menuEntries\s*:\s*[A-Za-z_$][\w$]*\[\]\s*=\s*\[/.exec(content)
  if (!arrayMatch) {
    return {
      kind: 'parse-failed',
      reason: 'Could not locate "export const menuEntries" array in app/menu.ts',
    }
  }

  // Find the matching closing bracket. Scan forward and count nested
  // brackets so an inner array literal in an entry does not close us
  // prematurely. (None of the supported entry shapes contain
  // brackets today, but we want to be robust against hand edits.)
  const arrayBodyStart = arrayMatch.index + arrayMatch[0].length
  const closeIndex = findMatchingClose(content, arrayBodyStart - 1)
  if (closeIndex === -1) {
    return {
      kind: 'parse-failed',
      reason: '"menuEntries = [" array is not terminated',
    }
  }

  const head = content.slice(0, arrayBodyStart)
  const arrayBody = content.slice(arrayBodyStart, closeIndex)
  const tail = content.slice(closeIndex)

  // Walk the array body and split it into top-level entry chunks
  // (each chunk is one `{...},?` literal plus surrounding whitespace).
  const chunks = splitArrayEntries(arrayBody)

  // Find the chunk whose entry literal references the matching id.
  const idRe = new RegExp(`\\bid\\s*:\\s*['"\`]${escapeRegex(entryId)}['"\`]`)
  const targetIndex = chunks.findIndex((c) => c.kind === 'entry' && idRe.test(c.text))
  if (targetIndex === -1) {
    return { kind: 'not-found' }
  }

  // Drop the entry chunk, plus the trailing-comma whitespace chunk if
  // there is one immediately after.
  chunks.splice(targetIndex, 1)

  // Re-stitch. Trim each chunk's surrounding whitespace and any
  // trailing comma (which `splitArrayEntries` sweeps into the chunk
  // text so it can be dropped together with the entry, but which we
  // want gone before re-joining — otherwise the rebuilt body picks
  // up `},,\n` between entries).
  const remainingEntries = chunks
    .filter((c) => c.kind === 'entry')
    .map((c) => c.text.trim().replace(/,\s*$/, ''))
  const newBody =
    remainingEntries.length === 0
      ? '\n'
      : '\n  ' + remainingEntries.join(',\n  ') + ',\n'

  return { kind: 'removed', content: head + newBody + tail }
}

/**
 * Locate the index of the `]` that matches the `[` at `openIndex`.
 * Returns -1 when the brackets are unbalanced.
 *
 * Aware of single-quoted, double-quoted, and template-literal
 * strings, plus single- and multi-line comments — none of those
 * count toward bracket balance.
 */
function findMatchingClose(source: string, openIndex: number): number {
  let depth = 0
  let i = openIndex
  while (i < source.length) {
    const c = source[i]
    // Strings
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(source, i)
      continue
    }
    // Line comment
    if (c === '/' && source[i + 1] === '/') {
      i = skipLineComment(source, i)
      continue
    }
    // Block comment
    if (c === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i)
      continue
    }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

function skipString(source: string, startIndex: number): number {
  const quote = source[startIndex]
  let i = startIndex + 1
  while (i < source.length) {
    const c = source[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    if (quote === '`' && c === '$' && source[i + 1] === '{') {
      // Template-literal expression; jump to the matching closing brace.
      i = skipTemplateExpression(source, i + 1)
      continue
    }
    i++
  }
  return source.length
}

function skipTemplateExpression(source: string, openBraceIndex: number): number {
  let depth = 0
  let i = openBraceIndex
  while (i < source.length) {
    const c = source[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(source, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return source.length
}

function skipLineComment(source: string, startIndex: number): number {
  const nl = source.indexOf('\n', startIndex)
  return nl === -1 ? source.length : nl + 1
}

function skipBlockComment(source: string, startIndex: number): number {
  const end = source.indexOf('*/', startIndex + 2)
  return end === -1 ? source.length : end + 2
}

interface ArrayChunk {
  kind: 'entry' | 'whitespace'
  text: string
}

/**
 * Split a `menuEntries` array body into alternating
 * whitespace / entry-literal chunks. Each entry chunk is one
 * `{...}` literal *plus* its trailing comma (if any) so the caller
 * can drop an entry and its comma in a single splice.
 */
function splitArrayEntries(body: string): ArrayChunk[] {
  const chunks: ArrayChunk[] = []
  let i = 0
  while (i < body.length) {
    const next = findNextLiteralStart(body, i)
    if (next === -1) {
      const ws = body.slice(i)
      if (ws.length > 0) chunks.push({ kind: 'whitespace', text: ws })
      break
    }
    if (next > i) {
      chunks.push({ kind: 'whitespace', text: body.slice(i, next) })
    }
    const close = findMatchingBrace(body, next)
    if (close === -1) {
      // Unparseable; bail and let the caller raise.
      throw new Error('Unbalanced object literal in menuEntries array')
    }
    let endIndex = close + 1
    // Sweep forward over a trailing comma so it is dropped together
    // with the entry.
    while (endIndex < body.length && /[\s,]/.test(body[endIndex])) {
      if (body[endIndex] === ',') {
        endIndex++
        break
      }
      endIndex++
    }
    chunks.push({ kind: 'entry', text: body.slice(next, endIndex) })
    i = endIndex
  }
  return chunks
}

function findNextLiteralStart(body: string, fromIndex: number): number {
  let i = fromIndex
  while (i < body.length) {
    const c = body[i]
    if (c === '{') return i
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(body, i)
      continue
    }
    if (c === '/' && body[i + 1] === '/') {
      i = skipLineComment(body, i)
      continue
    }
    if (c === '/' && body[i + 1] === '*') {
      i = skipBlockComment(body, i)
      continue
    }
    i++
  }
  return -1
}

function findMatchingBrace(body: string, openIndex: number): number {
  let depth = 0
  let i = openIndex
  while (i < body.length) {
    const c = body[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(body, i)
      continue
    }
    if (c === '/' && body[i + 1] === '/') {
      i = skipLineComment(body, i)
      continue
    }
    if (c === '/' && body[i + 1] === '*') {
      i = skipBlockComment(body, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the canonical empty `menu.ts` body. Used when uninstalling
 * the last menu entry in a project that only had recipe-installed
 * apps; the file is kept (with an empty array) so the renderer
 * loader does not need to special-case its absence.
 */
export function buildEmptyMenuTs(): string {
  return `${RECIPE_APPLICATOR_TEMPLATE_HEAD}

export const menuEntries: AppMenuEntry[] = []
`
}
