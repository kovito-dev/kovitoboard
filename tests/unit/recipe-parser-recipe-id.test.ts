/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `recipe-parser.ts`'s `recipeId` handling
 * (DEC-024 D-8 / spec §3.3).
 *
 * Pinned behavior:
 *   - Explicit, valid `recipeId` is used verbatim.
 *   - Invalid characters / too-long values cause `parseRecipe` to
 *     throw before the recipe is persisted with an unsafe id.
 *   - Missing `recipeId` falls back to `kebabCase(name)` and emits a
 *     `parser` warn log line (the v0.2.0 plan turns this into a
 *     parse error).
 *   - Names with no ASCII characters yield the placeholder
 *     `'recipe'` so the contract `recipeId: string` is always
 *     satisfied (an empty fallback would be a downstream landmine).
 *
 * The tests build a minimal in-memory recipe directory via the
 * existing `FileAccessLayer` mocking pattern from
 * `agent-reader-find-dir.test.ts` so we exercise the real
 * `parseRecipe` entry point rather than the private
 * `extractMetadata` helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileAccessLayer } from '../../src/server/fs-layer'

// Stub the recipe logger so tests can observe fallback warn lines
// without standing up the pino root. The real `recipeLogger` is a
// Proxy lazily resolving `childLogger('recipe')`, which throws when
// the root logger has not been initialized — and `vi.spyOn` cannot
// attach to a Proxy property anyway. Replacing the module entirely
// is the cleanest path.
const recipeLoggerStub = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}
vi.mock('../../src/server/logger', () => ({
  recipeLogger: recipeLoggerStub,
}))

interface MockFsState {
  files: Map<string, string>
}

function makeMockFs(seed: Record<string, string>): FileAccessLayer {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  // Always-present root markers so existsSync('/recipe-dir') resolves.
  dirs.add('/recipe-dir')

  const fs: FileAccessLayer = {
    readFileSync: (p) => {
      const f = files.get(p)
      if (f == null) throw new Error(`ENOENT: ${p}`)
      return f
    },
    readBytesSync: () => Buffer.alloc(0),
    writeFileSync: () => {
      throw new Error('writeFileSync not supported in mock')
    },
    unlinkSync: () => {
      throw new Error('unlinkSync not supported in mock')
    },
    rmSync: () => {
      throw new Error('rmSync not supported in mock')
    },
    existsSync: (p) => files.has(p) || dirs.has(p),
    statSync: () => ({ size: 0, mtime: new Date(), mtimeMs: 0 }),
    readdirSync: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/'
      const items = new Set<string>()
      for (const filePath of files.keys()) {
        if (filePath.startsWith(prefix)) {
          const rest = filePath.slice(prefix.length).split('/')[0]
          items.add(rest)
        }
      }
      return [...items]
    },
    mkdirSync: () => {
      /* no-op */
    },
    symlinkSync: () => {
      throw new Error('symlinkSync not supported in mock')
    },
    watch: () => ({
      close: async () => {
        /* no-op */
      },
    }),
  }
  // Hold onto state via closure; not exposed externally.
  void ({ files } satisfies MockFsState)
  return fs
}

const RECIPE_DIR = '/recipe-dir'

function makeRecipeYaml(opts: {
  recipeId?: string | null
  name: string
  extra?: string
}): string {
  const lines: string[] = ['---']
  if (opts.recipeId != null) {
    // Quote to keep YAML happy even when value contains slashes / dots.
    lines.push(`recipeId: "${opts.recipeId}"`)
  }
  lines.push(`name: "${opts.name}"`)
  lines.push('description: "test recipe"')
  lines.push('version: "1.0.0"')
  lines.push('artifacts:')
  lines.push('  - path: "pages/Test.tsx"')
  lines.push('    type: "page"')
  if (opts.extra) lines.push(opts.extra)
  lines.push('---')
  return lines.join('\n')
}

function seedRecipe(yamlBody: string): Record<string, string> {
  return {
    [`${RECIPE_DIR}/recipe.yaml`]: yamlBody,
    [`${RECIPE_DIR}/pages/Test.tsx`]: '// stub',
  }
}

const warnSpy = recipeLoggerStub.warn

beforeEach(() => {
  warnSpy.mockClear()
})

afterEach(() => {
  /* spies persist across tests via the module mock; mockClear above
     resets call history each test. */
})

describe('parseRecipe — recipeId', () => {
  it('uses an explicit recipeId verbatim', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = makeRecipeYaml({ recipeId: 'document-viewer', name: 'Doc Viewer' })
    const fs = makeMockFs(seedRecipe(yaml))
    const recipe = parseRecipe(RECIPE_DIR, fs)
    expect(recipe.metadata.recipeId).toBe('document-viewer')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('accepts namespaced ids (org/recipe@1.0.0 form)', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = makeRecipeYaml({
      recipeId: 'kovito-dev/document-viewer@1.0.0',
      name: 'Doc Viewer',
    })
    const fs = makeMockFs(seedRecipe(yaml))
    const recipe = parseRecipe(RECIPE_DIR, fs)
    expect(recipe.metadata.recipeId).toBe('kovito-dev/document-viewer@1.0.0')
  })

  it('accepts hash-form ids using the formal-regex characters', async () => {
    // Spec §3.3 lists `sha256:abc123...` as an OK example, but the
    // formal regex `[A-Za-z0-9_\-./@]+` does not include `:` —
    // those two parts of the spec are inconsistent. We treat the
    // formal regex as the Source of Truth (it gates persistence,
    // file paths, etc.) and accept hash-form ids using `-` or `.`
    // separators instead. If the spec later relaxes the regex to
    // include `:`, this test moves with it.
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = makeRecipeYaml({
      recipeId: 'sha256-abc123def456',
      name: 'Doc Viewer',
    })
    const fs = makeMockFs(seedRecipe(yaml))
    const recipe = parseRecipe(RECIPE_DIR, fs)
    expect(recipe.metadata.recipeId).toBe('sha256-abc123def456')
  })

  it('throws when recipeId contains illegal characters', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = makeRecipeYaml({
      // Whitespace is not in the allowed set [A-Za-z0-9_\-./@].
      recipeId: 'has space',
      name: 'Doc Viewer',
    })
    const fs = makeMockFs(seedRecipe(yaml))
    expect(() => parseRecipe(RECIPE_DIR, fs)).toThrow(/recipeId.*invalid characters/)
  })

  it('throws when recipeId exceeds 256 characters', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const longId = 'a'.repeat(257)
    const yaml = makeRecipeYaml({ recipeId: longId, name: 'Doc Viewer' })
    const fs = makeMockFs(seedRecipe(yaml))
    expect(() => parseRecipe(RECIPE_DIR, fs)).toThrow(/recipeId.*too long/)
  })

  it('falls back to kebab-case(name) when recipeId is missing, with a warn log', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = makeRecipeYaml({ name: 'My Sample Recipe' })
    const fs = makeMockFs(seedRecipe(yaml))
    const recipe = parseRecipe(RECIPE_DIR, fs)
    expect(recipe.metadata.recipeId).toBe('my-sample-recipe')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [meta, msg] = warnSpy.mock.calls[0]
    expect(meta).toMatchObject({ fallbackRecipeId: 'my-sample-recipe', name: 'My Sample Recipe' })
    expect(typeof msg).toBe('string')
    expect(msg).toMatch(/v0\.2\.0/)
  })

  it('treats an empty-string recipeId as missing (falls back + warn)', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = makeRecipeYaml({ recipeId: '', name: 'TODO 管理' })
    const fs = makeMockFs(seedRecipe(yaml))
    const recipe = parseRecipe(RECIPE_DIR, fs)
    // "TODO 管理" — only "todo" is ASCII, so kebab-case yields "todo".
    expect(recipe.metadata.recipeId).toBe('todo')
    expect(warnSpy).toHaveBeenCalled()
  })

  it('uses the placeholder "recipe" when the name has no ASCII characters', async () => {
    const { parseRecipe } = await import('../../src/server/recipe-parser')
    const yaml = makeRecipeYaml({ name: 'ドキュメントビュアー' })
    const fs = makeMockFs(seedRecipe(yaml))
    const recipe = parseRecipe(RECIPE_DIR, fs)
    // The name has zero ASCII alphanumerics; the parser must still
    // hand out a non-empty string. Anything else would let an empty
    // recipeId leak into manifest paths.
    expect(recipe.metadata.recipeId).toBe('recipe')
    expect(warnSpy).toHaveBeenCalled()
  })
})
