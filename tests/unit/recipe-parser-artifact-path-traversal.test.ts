/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Regression coverage for the recipe artifact-path traversal hardening
 * (supplementary review §S3): a malicious `recipe.yaml` cannot pull
 * arbitrary project files into `artifact.content` through `..`
 * segments, absolute paths, or symlinks inside the recipe directory.
 *
 * Three independent gates are exercised:
 *
 *   1. `extractArtifactEntries` rejects absolute paths at parse time.
 *   2. `extractArtifactEntries` rejects any `..` segment regardless of
 *      position (leading, interior, Windows-separator).
 *   3. `parseDirectoryRecipe` adds a final `realpath` containment
 *      check so a symlinked artifact inside the recipe directory
 *      cannot redirect to a file outside the tree.
 */
import { describe, it, expect, vi } from 'vitest'
import { parseRecipe } from '../../src/server/recipe-parser'
import type { FileAccessLayer } from '../../src/server/fs-layer'

vi.mock('../../src/server/logger', () => ({
  recipeLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  childLogger: vi.fn(() => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}))

const RECIPE_DIR = '/recipe-dir'

interface MockFsOptions {
  /**
   * Custom realpath mapping. Any path absent from this map is
   * resolved to itself (identity), which mirrors the non-symlink
   * default case.
   */
  realpathOverrides?: Record<string, string>
}

function makeFs(
  seed: Record<string, string>,
  options: MockFsOptions = {},
): FileAccessLayer {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  dirs.add(RECIPE_DIR)
  const overrides = options.realpathOverrides ?? {}

  return {
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
    statSync: (p) => {
      const f = files.get(p)
      const size = f != null ? Buffer.byteLength(f, 'utf-8') : 0
      return { size, mtime: new Date(), mtimeMs: 0 }
    },
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
    realpathSync: (p) => {
      if (overrides[p] !== undefined) return overrides[p]
      if (!files.has(p) && !dirs.has(p)) {
        throw new Error(`ENOENT: ${p}`)
      }
      return p
    },
    watch: () => ({
      close: async () => {
        /* no-op */
      },
    }),
  }
}

function makeYaml(artifactPath: string, options: { type?: string } = {}): string {
  return [
    '---',
    'name: "Traversal test"',
    'description: "test"',
    'version: "1.0.0"',
    'artifacts:',
    `  - path: "${artifactPath}"`,
    `    type: "${options.type ?? 'page'}"`,
    '---',
  ].join('\n')
}

function seedRecipe(yamlBody: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [`${RECIPE_DIR}/recipe.yaml`]: yamlBody,
    ...extra,
  }
}

describe('recipe-parser artifact path traversal (supplementary review §S3)', () => {
  describe('gate 1: extractArtifactEntries — absolute paths', () => {
    it('rejects a POSIX absolute path with /etc/passwd', () => {
      const fs = makeFs(seedRecipe(makeYaml('/etc/passwd')))
      expect(() => parseRecipe(RECIPE_DIR, fs)).toThrow(
        /must be a relative path inside the recipe directory/,
      )
    })

    it('rejects a path under the project home like /home/victim/.env', () => {
      const fs = makeFs(seedRecipe(makeYaml('/home/victim/.env')))
      expect(() => parseRecipe(RECIPE_DIR, fs)).toThrow(
        /must be a relative path inside the recipe directory/,
      )
    })
  })

  describe('gate 2: extractArtifactEntries — .. segments', () => {
    it('rejects a leading ../.. escape', () => {
      const fs = makeFs(seedRecipe(makeYaml('../../.env')))
      expect(() => parseRecipe(RECIPE_DIR, fs)).toThrow(
        /must not contain "\.\." segments/,
      )
    })

    it('rejects interior .. that normalises to ../etc', () => {
      // `a/../../../etc/passwd` normalises to `../../etc/passwd`.
      const fs = makeFs(seedRecipe(makeYaml('a/../../../etc/passwd')))
      expect(() => parseRecipe(RECIPE_DIR, fs)).toThrow(
        /must not contain "\.\." segments/,
      )
    })

    it('rejects a .. segment that survives even after a deep prefix', () => {
      // `pages/a/b/../../../../sibling.tsx` normalises to
      // `../sibling.tsx` — the prefix consumes three `..` segments,
      // and the remaining one escapes the recipe directory.
      const fs = makeFs(seedRecipe(makeYaml('pages/a/b/../../../../sibling.tsx')))
      expect(() => parseRecipe(RECIPE_DIR, fs)).toThrow(
        /must not contain "\.\." segments/,
      )
    })
  })

  describe('gate 3: parseDirectoryRecipe — realpath containment', () => {
    it('rejects an artifact whose realpath lands outside the recipe directory', () => {
      // The lexical path `pages/Test.tsx` is fine, but the resolved
      // target points to `/var/secret/leak.tsx` — modelling a
      // symlink that escapes the recipe tree at filesystem level.
      const fs = makeFs(
        {
          [`${RECIPE_DIR}/recipe.yaml`]: makeYaml('pages/Test.tsx'),
          [`${RECIPE_DIR}/pages/Test.tsx`]: '// stub',
          '/var/secret/leak.tsx': 'SECRET = "leaked"',
        },
        {
          realpathOverrides: {
            [`${RECIPE_DIR}/pages/Test.tsx`]: '/var/secret/leak.tsx',
          },
        },
      )
      expect(() => parseRecipe(RECIPE_DIR, fs)).toThrow(
        /resolves outside the recipe directory/,
      )
    })

    it('accepts an artifact whose realpath equals the lexical path', () => {
      const fs = makeFs({
        [`${RECIPE_DIR}/recipe.yaml`]: makeYaml('pages/Test.tsx'),
        [`${RECIPE_DIR}/pages/Test.tsx`]: '// stub',
      })
      const recipe = parseRecipe(RECIPE_DIR, fs)
      expect(recipe.artifacts).toHaveLength(1)
      expect(recipe.artifacts[0].path).toBe('pages/Test.tsx')
      expect(recipe.artifacts[0].content).toBe('// stub')
    })

    it('accepts an artifact whose realpath canonicalises inside the recipe directory', () => {
      // The realpath redirects to another file STILL inside the
      // recipe directory — this is the legitimate intra-directory
      // symlink case (e.g. a recipe author who linked
      // `pages/Test.tsx` -> `pages/Test.aliased.tsx`).
      const fs = makeFs(
        {
          [`${RECIPE_DIR}/recipe.yaml`]: makeYaml('pages/Test.tsx'),
          [`${RECIPE_DIR}/pages/Test.tsx`]: '// stub',
          [`${RECIPE_DIR}/pages/Test.aliased.tsx`]: '// aliased',
        },
        {
          realpathOverrides: {
            [`${RECIPE_DIR}/pages/Test.tsx`]: `${RECIPE_DIR}/pages/Test.aliased.tsx`,
          },
        },
      )
      const recipe = parseRecipe(RECIPE_DIR, fs)
      expect(recipe.artifacts).toHaveLength(1)
      expect(recipe.artifacts[0].path).toBe('pages/Test.tsx')
    })
  })
})
