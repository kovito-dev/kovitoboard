/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Shared L1 helpers for the v0.2.1 bundled enable/disable + app menu
 * metadata wire-contract specs (BS-T1 ~ BS-T15, committee request v1.1).
 *
 * The fixture method is "A" — programmatic state construction inside
 * the existing l1-default project root, no playwright.config.l1.ts
 * extension. See `tests/e2e/bundled-enable-disable.spec.ts` for the
 * full rationale.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'

/**
 * Wait for a single ws frame matching `frameType` on the KB API ws
 * endpoint. Uses the Node-side `ws` package (rather than the page-side
 * `WebSocket` global) so the Origin header is settable — the WS
 * verifier (`src/server/middleware/auth.ts:236`) rejects unset
 * origins, and a browser page that has not navigated past
 * `about:blank` produces a `null` origin that fails the check.
 */
export async function waitForWsFrame(
  frameType: string,
  opts: { port?: number; vitePort?: number; timeoutMs?: number } = {},
): Promise<{ type: string; payload: Record<string, unknown> }> {
  const port = opts.port ?? 3001
  const vitePort = opts.vitePort ?? 5174
  const timeoutMs = opts.timeoutMs ?? 5_000
  const token = process.env.KB_LAUNCH_TOKEN ?? ''
  const url = `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`
  return new Promise<{ type: string; payload: Record<string, unknown> }>(
    (resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Origin: `http://localhost:${vitePort}` },
      })
      const deadline = setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* ignore close-on-timeout race */
        }
        reject(
          new Error(
            `[v021-bundled-helpers] ws frame "${frameType}" not observed within ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)
      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString())
          if (data && typeof data === 'object' && data.type === frameType) {
            clearTimeout(deadline)
            ws.close()
            resolve(data)
          }
        } catch {
          // ignore non-JSON / heartbeat frames
        }
      })
      ws.on('error', (err) => {
        clearTimeout(deadline)
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `[v021-bundled-helpers] ws connection error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        )
      })
    },
  )
}

/**
 * Workaround for the fixture vs `appendMenuEntry` regex drift:
 *   - The bundled-installer's menu.ts editor (`appendMenuEntry`,
 *     `src/server/services/menu-ts-editor.ts:473`) requires the
 *     `export const menuEntries: AppMenuEntry[] = [...]` form.
 *   - `tests/fixtures/projects/blank-onboarded/app/menu.ts` omits the
 *     type annotation on purpose (its leading comment notes that the
 *     `AppMenuEntry` import path would escape the fixture project
 *     root at parse time).
 * Returns the original bytes so the caller can restore them in
 * afterEach via `restoreMenuTs`.
 */
export function rewriteMenuTsForEnable(projectRoot: string): string {
  const menuTsPath = join(projectRoot, 'app', 'menu.ts')
  const original = readFileSync(menuTsPath, 'utf-8')
  if (
    /export\s+const\s+menuEntries\s*:\s*[A-Za-z_$][\w$]*\[\]\s*=\s*\[/.test(
      original,
    )
  ) {
    return original
  }
  const rewritten = original.replace(
    /export\s+const\s+menuEntries\s*=\s*\[/,
    'export const menuEntries: AppMenuEntry[] = [',
  )
  writeFileSync(menuTsPath, rewritten)
  return original
}

export function restoreMenuTs(projectRoot: string, original: string): void {
  const menuTsPath = join(projectRoot, 'app', 'menu.ts')
  writeFileSync(menuTsPath, original)
}

/**
 * Reject ids that could escape the intended app/recipe directory via
 * path-separator or `..` segments. The destructive filesystem helpers
 * below (`cleanupAppDir`, `seedGrandfatherManifest`) join the id into a
 * write/delete path; trusting a raw id here would let a future caller
 * (or a value derived from a server response or a malformed fixture)
 * remove or overwrite arbitrary files under the test runner's working
 * tree. The read helpers (`readAppManifest`, `readRecipeManifest`) go
 * through the same gate so traversal is rejected uniformly regardless
 * of which entry point a spec picks up.
 */
function assertSafePathSegment(value: string, label: string): void {
  if (value === '' || value === '.' || value === '..') {
    throw new Error(
      `[v021-bundled-helpers] empty or relative ${label}: "${value}"`,
    )
  }
  if (
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split(/[/\\]/).includes('..')
  ) {
    throw new Error(
      `[v021-bundled-helpers] unsafe ${label} (path traversal): "${value}"`,
    )
  }
}

/**
 * Reject relative paths that would escape the app directory once
 * joined to it. Allows nested directories like `pages/DocumentViewer`
 * but forbids absolute roots, leading slashes, NUL bytes, and any
 * `..` segment. Used for `seedGrandfatherManifest`'s `componentPath`
 * so the on-disk write and the generated `menu.ts` import string
 * both stay inside `app/<appId>/`.
 */
function assertSafeRelativePath(value: string, label: string): void {
  if (value === '' || value === '.' || value === '..') {
    throw new Error(
      `[v021-bundled-helpers] empty or relative ${label}: "${value}"`,
    )
  }
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.endsWith('/')
  ) {
    throw new Error(
      `[v021-bundled-helpers] unsafe ${label} (absolute / relative-prefix / trailing-slash): "${value}"`,
    )
  }
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(
        `[v021-bundled-helpers] unsafe ${label} (path traversal segment): "${value}"`,
      )
    }
  }
}

/**
 * Verify the `<projectRoot>/app` root is a real directory (not a
 * symlink). The destructive helpers below recurse into `app/<appId>/`
 * with `rmSync({ recursive: true })`, so if a prior test or the SUT
 * has replaced the root with a symlink to somewhere outside the
 * fixture, the cleanup would follow the link and remove files outside
 * the per-test boundary. Mirrors the server-side app-root anomaly
 * check (`src/server/services/bundled-installer.ts` boundary
 * verification).
 */
function assertAppRootIsDirectory(projectRoot: string): void {
  const appRoot = join(projectRoot, 'app')
  if (!existsSync(appRoot)) return
  const st = lstatSync(appRoot)
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(
      `[v021-bundled-helpers] refusing to mutate non-directory app root: "${appRoot}"`,
    )
  }
}

export function cleanupAppDir(projectRoot: string, appId: string): void {
  assertSafePathSegment(appId, 'appId')
  assertAppRootIsDirectory(projectRoot)
  rmSync(join(projectRoot, 'app', appId), { recursive: true, force: true })
}

export function readHistoryLines(projectRoot: string): unknown[] {
  const historyPath = join(projectRoot, '.kovitoboard', 'recipe-history.jsonl')
  if (!existsSync(historyPath)) return []
  return readFileSync(historyPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

/**
 * Tail the L1 server's pino log file under
 * `<projectRoot>/.kovitoboard/logs/`. The KB logger writes to either
 * a `current.log` symlink-style file or a date-suffixed
 * `server.YYYY-MM-DD.N.log` file (the multi-stream sink rotates by
 * date and ordinal). We pick the newest `*.log` file by mtime so the
 * caller always sees the latest entries for the current test.
 *
 * Returns the parsed JSON lines (skipping malformed lines silently).
 * Returns `[]` when the log directory does not exist (the first
 * request landing on a fresh project root creates it lazily).
 */
export function readServerLogLines(
  projectRoot: string,
  opts: { tailLines?: number } = {},
): Record<string, unknown>[] {
  const tailLines = opts.tailLines ?? 500
  const logsDir = join(projectRoot, '.kovitoboard', 'logs')
  if (!existsSync(logsDir)) return []
  const files = readdirSync(logsDir)
    .filter((n) => n.endsWith('.log'))
    .map((n) => ({
      n,
      mtime: statSync(join(logsDir, n)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
  if (files.length === 0) return []
  const newest = files[0].n
  const newestPath = join(logsDir, newest)
  // Read only the tail of the file so memory cost stays bounded by
  // `tailLines` rather than scaling with the whole log on a long /
  // noisy run. The 96 KB tail budget covers ~500 JSON-Lines pino
  // entries with headroom; the partial-line at the front is dropped
  // below so we never hand a half-truncated record to `JSON.parse`.
  const TAIL_BUDGET = Math.max(96 * 1024, tailLines * 256)
  const size = statSync(newestPath).size
  let raw: string
  if (size <= TAIL_BUDGET) {
    raw = readFileSync(newestPath, 'utf-8')
  } else {
    const fd = openSync(newestPath, 'r')
    try {
      const buf = Buffer.alloc(TAIL_BUDGET)
      readSync(fd, buf, 0, TAIL_BUDGET, size - TAIL_BUDGET)
      raw = buf.toString('utf-8')
    } finally {
      closeSync(fd)
    }
  }
  const allLines = raw.split('\n').filter((line) => line.length > 0)
  // When the read window started mid-line, the first surviving line
  // is a partial record; drop it so the parser only sees complete
  // JSON objects.
  const completeLines =
    size > TAIL_BUDGET && allLines.length > 0 ? allLines.slice(1) : allLines
  const tail = completeLines.slice(-tailLines)
  const parsed: Record<string, unknown>[] = []
  for (const line of tail) {
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        parsed.push(obj as Record<string, unknown>)
      }
    } catch {
      // skip malformed lines
    }
  }
  return parsed
}

/**
 * Read the AppManifest for an installed appId. Returns `null` when
 * the manifest does not exist.
 */
export function readAppManifest(
  projectRoot: string,
  appId: string,
): Record<string, unknown> | null {
  assertSafePathSegment(appId, 'appId')
  const p = join(projectRoot, 'app', appId, 'manifest.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8'))
}

/**
 * Read the RecipeManifest for an installed recipeId. Returns `null`
 * when the manifest does not exist.
 */
export function readRecipeManifest(
  projectRoot: string,
  recipeId: string,
): Record<string, unknown> | null {
  assertSafePathSegment(recipeId, 'recipeId')
  const p = join(
    projectRoot,
    '.kovitoboard',
    'recipes-installed',
    recipeId,
    'manifest.json',
  )
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8'))
}

export interface GrandfatherSeed {
  recipeId: string
  appId: string
  source: 'sample'
  displayName?: string
  componentPath?: string
}

/**
 * Seed a v0.1.x-style grandfather install state (RecipeManifest +
 * AppManifest + history line + menu.ts entry) so an enable request
 * can hit the `'already-enabled'` short-circuit in
 * `isEnabledAndManifestCoherent` (bundled-installer.ts:1527).
 *
 * The bundled-installer's manifest store cache is computed at boot
 * and currently does not rescan this on-disk seed inside an L1 test
 * — see BS-T4 fixme in bundled-enable-disable.spec.ts for the open
 * escalate.
 */
export function seedGrandfatherManifest(
  projectRoot: string,
  seed: GrandfatherSeed,
): void {
  assertSafePathSegment(seed.recipeId, 'recipeId')
  assertSafePathSegment(seed.appId, 'appId')
  const displayName = seed.displayName ?? 'Document Viewer'
  const componentPath = seed.componentPath ?? 'pages/DocumentViewer'
  // `componentPath` is joined into `app/<appId>/<componentPath>.tsx`
  // and into the generated `menu.ts` import string, so a future
  // caller passing `..` or an absolute path could write outside the
  // app directory and undercut the path-safety boundary already
  // enforced for `recipeId` / `appId` above.
  assertSafeRelativePath(componentPath, 'componentPath')

  const recipesInstalledDir = join(
    projectRoot,
    '.kovitoboard',
    'recipes-installed',
    seed.recipeId,
  )
  mkdirSync(recipesInstalledDir, { recursive: true })
  writeFileSync(
    join(recipesInstalledDir, 'manifest.json'),
    JSON.stringify(
      {
        appId: seed.appId,
        recipeId: seed.recipeId,
        recipeVersion: '1.0.0',
        hash: 'sha256-grandfather-stub',
        installedAt: '2026-04-18T00:00:00.000Z',
        approvedScopes: ['project-read'],
        api: { scopes: ['project-read'], calls: [] },
        captureRequires: [],
        approvedCaptures: [],
        trust: 'unknown',
        source: seed.source,
      },
      null,
      2,
    ),
  )

  const appDir = join(projectRoot, 'app', seed.appId)
  mkdirSync(join(appDir, 'pages'), { recursive: true })
  writeFileSync(
    join(appDir, 'manifest.json'),
    JSON.stringify(
      {
        appId: seed.appId,
        displayName,
        createdAt: '2026-04-18T00:00:00.000Z',
        kovitoboardVersion: '0.1.0',
        source: {
          type: 'recipe',
          recipeId: seed.recipeId,
          recipeVersion: '1.0.0',
          recipeSource: seed.source,
        },
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(appDir, componentPath + '.tsx'),
    '// grandfather stub — not the real bundled artifact\n',
  )

  const historyPath = join(projectRoot, '.kovitoboard', 'recipe-history.jsonl')
  const record =
    JSON.stringify({
      action: 'install',
      recipe: seed.recipeId,
      version: '1.0.0',
      timestamp: '2026-04-18T00:00:00.000Z',
      result: 'success',
    }) + '\n'
  writeFileSync(historyPath, record)

  const menuTsPath = join(projectRoot, 'app', 'menu.ts')
  const current = readFileSync(menuTsPath, 'utf-8')
  // `seed.appId` / `componentPath` are validated to simple-slug shape
  // (`assertSafePathSegment` / `assertSafeRelativePath` above) so
  // template-interpolating them into a single-quoted literal is
  // safe. `displayName` is caller-controlled free-form text, so pass
  // it through `JSON.stringify` to produce a properly escaped
  // double-quoted TypeScript string — embedded quotes, backslashes,
  // newlines, or NUL bytes cannot break the file's syntax or inject
  // code/imports.
  const safeLabel = JSON.stringify(displayName)
  const grandfatherEntry =
    `  {\n` +
    `    id: '${seed.appId}',\n` +
    `    label: ${safeLabel},\n` +
    `    icon: 'content',\n` +
    `    component: () => import('./${seed.appId}/${componentPath}'),\n` +
    `  },\n`
  const arrayMatch = /(\]\s*\n?)$/.exec(current)
  if (!arrayMatch) {
    throw new Error(
      '[v021-bundled-helpers] seedGrandfatherManifest: cannot locate menu.ts closing bracket',
    )
  }
  const insertPos = arrayMatch.index
  const updated =
    current.slice(0, insertPos) + grandfatherEntry + current.slice(insertPos)
  writeFileSync(menuTsPath, updated)
}
