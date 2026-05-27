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

import { parseMenuTs } from './menu-extractor'

const RECIPE_APPLICATOR_TEMPLATE_HEAD =
  "import type { AppMenuEntry } from '../src/renderer/types/app-types'"

/** Outcome of {@link removeMenuEntry}. */
export type MenuRemoveResult =
  | { kind: 'removed'; content: string }
  | { kind: 'not-found' }
  | { kind: 'parse-failed'; reason: string }

/**
 * A single `menuEntries[]` entry to append. Mirrors the shape the
 * recipe-applicator template emits and the renderer reads through
 * `menu-extractor.parseMenuTs`.
 *
 * The `page` field is the relative import path **after** the
 * `<appId>/` prefix has been composed — `appendMenuEntry` writes it
 * unchanged into the `component: () => import('./<page>')` thunk,
 * so callers MUST compose `<appId>/<sub-path>` themselves (spec
 * recipe-system v1.12 §10.9.3 Step 5.6 path-boundary invariant).
 * Pre-composing in the caller keeps the editor agnostic about the
 * appId/page relationship and lets the unit test exercise the
 * `isCanonicalAppIdPath` check at the boundary instead of duplicating
 * it here.
 */
export interface AppendMenuEntryInput {
  /** Menu entry id — matches the recipe.yaml `menu[i].id` field. */
  id: string
  /** Display label — matches the recipe.yaml `menu[i].label` field. */
  label: string
  /** Icon name — matches the recipe.yaml `menu[i].icon` field, default `'box'`. */
  icon: string
  /**
   * Pre-composed page path of the form `<appId>/<sub-path>` (no
   * leading `./`, no extension). The thunk emitted as
   * `component: () => import('./<page>')` runs through the renderer's
   * `menu-extractor.isCanonicalAppIdPath` check, which requires the
   * `<appId>/` prefix (spec v1.12 §10.9.3 Step 5.6).
   */
  page: string
}

/** Outcome of {@link appendMenuEntry}. */
export type MenuAppendResult =
  | { kind: 'appended'; content: string }
  | { kind: 'already-present' }

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
 * Append `entry` to the `menuEntries[]` array of a `menu.ts` file
 * and return the rewritten source. Used by the bundled-installer
 * Step 5.6 (spec recipe-system v1.12 §10.9.3) to register the menu
 * row for a bundled-enable transaction.
 *
 * Behavior:
 *   - When `parseMenuTs(content)` already surfaces an entry whose
 *     `id` matches `entry.id`, returns `{ kind: 'already-present' }`
 *     and **does NOT touch the file**. The presence check uses the
 *     same parser the renderer and `isEnabledAndManifestCoherent`
 *     run, so writer and reader never disagree about whether a row
 *     exists. A raw regex would also match commented-out snippets
 *     or unrelated string literals (codex review #58 attempt 2
 *     Medium #1).
 *   - When the entry is absent, appends it to the end of the array
 *     using the canonical recipe-applicator entry shape
 *     (`{ id, label, icon, component: () => import('./<page>') }`)
 *     and returns `{ kind: 'appended', content }`.
 *   - Throws a `MenuTsParseFailedError` when `menuEntries` cannot be
 *     located in the source. The bundled-installer routes this to
 *     500 `EnableMenuTsAppendFailed` per spec v1.12 §10.9.3 Step 5.6.
 *     `appendMenuEntry` throws (rather than returning a `parse-failed`
 *     variant the way `removeMenuEntry` does) because a corrupted
 *     `menu.ts` at enable time is a fail-closed condition; the
 *     install transaction must not silently downgrade to a no-op.
 *
 * Grammar restriction: the helper accepts only the simple ASCII +
 * BMP characters `parseMenuTs` can read back (no single quotes,
 * double quotes, backticks, or backslashes in `id` / `label` /
 * `icon` / `page`). Inputs that contain those characters are
 * rejected with a `MenuTsParseFailedError`. The bundled-installer
 * already validates `id` / `page` against
 * `isCanonicalAppIdPath` + the `appId` slug regex, both of which
 * are ASCII-only by construction. `label` is the only field that
 * can carry user-facing punctuation; recipe authors that need
 * quote characters must pick a quote-free fallback for the menu
 * row (the `recipe.yaml` `name` field stays free-form). This
 * keeps writer and reader on the same grammar so a successful
 * write always round-trips through the renderer (codex review #58
 * attempt 2 Medium #2).
 *
 * The caller is responsible for path-boundary verification — the
 * editor writes `entry.page` verbatim into the `import('./<page>')`
 * thunk. `bundled-installer` runs `isCanonicalAppIdPath(page, appId)`
 * before calling this helper (spec v1.12 §10.9.3 Step 5.6 path-
 * boundary invariant).
 */
export class MenuTsParseFailedError extends Error {
  constructor(readonly reason: string) {
    super(`menu-ts-editor: ${reason}`)
    this.name = 'MenuTsParseFailedError'
  }
}

/**
 * Characters that break the single-quoted literal grammar the helper
 * emits and the simple `parseMenuTs` regex consumes:
 *
 *   - Single quote / double quote / backtick / backslash — break the
 *     quote pairing or trigger escape interpretation.
 *   - Line terminators (`\n`, `\r`, U+2028, U+2029) — TS/JS terminate
 *     a single-quoted string literal at any line terminator, so
 *     interpolating one verbatim produces invalid TypeScript and the
 *     module loader rejects the entire `app/menu.ts` file. Codex
 *     review #58 attempt 3 Medium #1 surfaced this.
 *   - Other ASCII control characters (U+0000-U+001F minus the line
 *     terminators above, plus U+007F) — `parseMenuTs` would either
 *     mis-read or silently drop them depending on the runtime; reject
 *     so the writer never persists a value the renderer cannot read.
 */
const UNSAFE_MENU_LITERAL_RE = /['"`\\\u0000-\u001F\u007F\u2028\u2029]/

/**
 * Probe a string field for characters that break the simple
 * `parseMenuTs` regex (single quote, double quote, backtick,
 * backslash, ASCII control characters, U+2028 / U+2029). Bundled
 * recipe asset validation surfaces these as 503
 * `BundledRecipeMalformed` at the bundled-installer level (codex
 * review #58 attempt 6 Medium): the value originates in the
 * recipe.yaml content, not in the menu-ts-editor, so the failure
 * class is "recipe content defect" rather than "internal menu
 * append failure". Exported so the bundled-installer can run the
 * same probe upstream without duplicating the regex.
 */
export function containsUnsafeMenuLiteralChar(value: string): boolean {
  return UNSAFE_MENU_LITERAL_RE.test(value)
}

function assertSafeMenuLiteral(field: string, value: string): void {
  if (UNSAFE_MENU_LITERAL_RE.test(value)) {
    throw new MenuTsParseFailedError(
      `menu entry ${field} contains a quote, backslash, line terminator, or other control character that the menu reader cannot parse back: ${JSON.stringify(value)}`,
    )
  }
}

export function appendMenuEntry(
  content: string,
  entry: AppendMenuEntryInput,
): MenuAppendResult {
  // Grammar guard. The bundled enable contract requires the menu
  // row to round-trip through `parseMenuTs`; rejecting unsafe
  // characters at the writer is the only way to keep that invariant
  // without rewriting the reader's regex grammar (codex review #58
  // attempt 2 Medium #2). We validate every string field — the
  // bundled-installer already narrows `id` and `page` to ASCII
  // alphanumeric + hyphen + `/`, but the validation here is
  // defensive in case a future caller bypasses those gates.
  assertSafeMenuLiteral('id', entry.id)
  assertSafeMenuLiteral('label', entry.label)
  assertSafeMenuLiteral('icon', entry.icon)
  assertSafeMenuLiteral('page', entry.page)

  // Idempotent gate (codex review #58 attempt 2 Medium #1).
  // Delegate the presence check to `parseMenuTs` so writer and
  // reader observe the same set of entries; a raw regex would also
  // match a commented-out snippet or a literal containing the same
  // id substring and short-circuit a legitimate append.
  let parsedEntries: { id: string }[]
  try {
    parsedEntries = parseMenuTs(content)
  } catch (err) {
    throw new MenuTsParseFailedError(
      `Could not parse "menuEntries" while checking idempotence: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (parsedEntries.some((e) => e.id === entry.id)) {
    return { kind: 'already-present' }
  }

  // Locate the `menuEntries[]` array. Same gate as `removeMenuEntry`
  // so the editor stays consistent about what counts as a parseable
  // menu.ts. (`parseMenuTs` succeeding above only means *some* entries
  // were extracted — the regex below confirms the array shape we are
  // about to splice into.)
  const arrayMatch = /export\s+const\s+menuEntries\s*:\s*[A-Za-z_$][\w$]*\[\]\s*=\s*\[/.exec(content)
  if (!arrayMatch) {
    throw new MenuTsParseFailedError(
      'Could not locate "export const menuEntries" array in app/menu.ts',
    )
  }
  const arrayBodyStart = arrayMatch.index + arrayMatch[0].length
  const closeIndex = findMatchingClose(content, arrayBodyStart - 1)
  if (closeIndex === -1) {
    throw new MenuTsParseFailedError('"menuEntries = [" array is not terminated')
  }

  const arrayBody = content.slice(arrayBodyStart, closeIndex)

  // Emit the new entry in the canonical recipe-applicator template
  // shape. `assertSafeMenuLiteral` above guarantees no escape work
  // is required — every field is quote / backtick / backslash free,
  // so a single-quoted literal interpolates the value verbatim.
  const newEntry =
    `  {\n` +
    `    id: '${entry.id}',\n` +
    `    label: '${entry.label}',\n` +
    `    icon: '${entry.icon}',\n` +
    `    component: () => import('./${entry.page}'),\n` +
    `  }`

  // Re-stitch the file. Three layout cases to keep the output a
  // valid TypeScript module regardless of how the existing array is
  // formatted:
  //
  //   (a) Empty array (`menuEntries: AppMenuEntry[] = []` or
  //       `[\n]`): emit a fresh multi-line body with a trailing
  //       comma so the result matches `buildEmptyMenuTs`-style
  //       round-trips.
  //   (b) Non-empty array whose body already ends with `,\n` (the
  //       buildMenuTs layout in the test fixtures): just append our
  //       entry + trailing comma.
  //   (c) Non-empty array with no trailing comma (hand-edit /
  //       single-line layout): inject the leading `,` ourselves.
  const head = content.slice(0, arrayBodyStart)
  const tail = content.slice(closeIndex)

  // Whitespace-only body counts as case (a). Anything else is a
  // populated array.
  if (arrayBody.trim().length === 0) {
    return {
      kind: 'appended',
      content: head + '\n' + newEntry + ',\n' + tail,
    }
  }

  const trimmedRight = arrayBody.replace(/\s+$/, '')
  if (trimmedRight.endsWith(',')) {
    // Case (b): trailing comma exists, just append the new entry +
    // trailing comma.
    return {
      kind: 'appended',
      content:
        head +
        trimmedRight +
        '\n' +
        newEntry +
        ',\n' +
        tail,
    }
  }
  // Case (c): no trailing comma yet — inject one before appending.
  return {
    kind: 'appended',
    content:
      head +
      trimmedRight +
      ',\n' +
      newEntry +
      ',\n' +
      tail,
  }
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
