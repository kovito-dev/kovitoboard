/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Boundary tests for the L-R1..L-R9 security-limits ceilings enforced
 * at recipe parser entry (security-limits.md v1.1 §5.1).
 *
 * Each limit covers two cases: the largest accepted input (boundary
 * value) and the smallest rejected input (boundary + 1). All
 * rejection cases assert that:
 *   - `parseRecipe` throws a `RecipeParseError`
 *   - the structured `context.limit` matches the limit identifier
 *   - `context.actualValue` is the observed value
 *   - `recipeLogger.warn` was called with `limit`, `limitValue`,
 *     `actualValue` so operators can correlate routes / log lines
 *
 * L-R6 (`MAX_APP_ID_LENGTH`) is enforced by the `APP_ID_PATTERN`
 * regex in `mark-installed`'s validator (`{0,63}` quantifier — 1
 * leading char + 0..63 = max 64). The parser itself never sees an
 * `appId`, so the boundary is asserted against the validator instead
 * of the parser, mirroring how the spec splits "parser entry" from
 * "install handover".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileAccessLayer } from '../../src/server/fs-layer'
import {
  MAX_RECIPE_YAML_BYTES,
  MAX_RECIPE_TOTAL_BYTES,
  MAX_RECIPE_ARTIFACTS,
  MAX_ARTIFACT_FILE_BYTES,
  MAX_RECIPE_ID_LENGTH,
  MAX_APP_ID_LENGTH,
  MAX_RECIPE_NAME_LENGTH,
  MAX_INSTRUCTION_BYTES,
  MAX_PERMISSION_ENTRIES,
} from '../../src/shared/security-limits'

const recipeLoggerStub = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}
vi.mock('../../src/server/logger', () => ({
  recipeLogger: recipeLoggerStub,
  // mark-installed validator path uses no logger; stub is parser-only.
}))

const warnSpy = recipeLoggerStub.warn

beforeEach(() => {
  warnSpy.mockClear()
})

afterEach(() => {
  /* state lives in the closure; mockClear above resets calls. */
})

interface RecipeYamlOpts {
  recipeId?: string
  name?: string
  description?: string
  version?: string
  artifacts?: Array<{ path: string; type?: string }>
  instruction?: string
  scopes?: string[]
  extraYaml?: string
}

function buildRecipeYaml(opts: RecipeYamlOpts = {}): string {
  const recipeId = opts.recipeId ?? 'fixture-recipe'
  const name = opts.name ?? 'Fixture Recipe'
  const description = opts.description ?? 'test recipe'
  const version = opts.version ?? '1.0.0'
  const artifacts = opts.artifacts ?? [{ path: 'pages/Test.tsx', type: 'page' }]

  const lines: string[] = ['---']
  lines.push(`recipeId: "${recipeId}"`)
  lines.push(`name: ${JSON.stringify(name)}`)
  lines.push(`description: ${JSON.stringify(description)}`)
  lines.push(`version: "${version}"`)
  if (opts.instruction !== undefined) {
    // Use the strip-form literal block scalar (`|-`) so YAML does NOT
    // append a trailing newline — the parsed instruction has to match
    // the input byte-for-byte to keep the L-R8 boundary tests exact.
    lines.push('instruction: |-')
    for (const ln of opts.instruction.split('\n')) {
      lines.push(`  ${ln}`)
    }
  }
  if (opts.scopes !== undefined) {
    lines.push('api:')
    lines.push('  scopes:')
    for (const s of opts.scopes) {
      lines.push(`    - "${s}"`)
    }
    lines.push('  calls: []')
  }
  lines.push('artifacts:')
  for (const a of artifacts) {
    lines.push(`  - path: "${a.path}"`)
    lines.push(`    type: "${a.type ?? 'page'}"`)
  }
  if (opts.extraYaml) {
    lines.push(opts.extraYaml)
  }
  lines.push('---')
  return lines.join('\n')
}

const RECIPE_DIR = '/recipe-dir'

function makeFs(seed: Record<string, string>): FileAccessLayer {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  dirs.add(RECIPE_DIR)

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
      // Return the on-disk byte count from the seeded content so
      // the parser's stat-before-read L-R4 / L-R2 checks see the
      // same size the artifact will actually contribute (the parser
      // enforces ceilings on stat metadata before invoking
      // readFileSync, so a flat `size: 0` mock would silently
      // disable the stat-side enforcement).
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
    watch: () => ({
      close: async () => {
        /* no-op */
      },
    }),
  }
}

function seedSingleArtifact(yamlBody: string, artifactBody = '// stub'): Record<string, string> {
  return {
    [`${RECIPE_DIR}/recipe.yaml`]: yamlBody,
    [`${RECIPE_DIR}/pages/Test.tsx`]: artifactBody,
  }
}

async function parse(seed: Record<string, string>) {
  const { parseRecipe } = await import('../../src/server/recipe-parser')
  const fs = makeFs(seed)
  return parseRecipe(RECIPE_DIR, fs)
}

async function expectLimitThrow(seed: Record<string, string>, limit: string, actual: number) {
  const { parseRecipe, RecipeParseError } = await import('../../src/server/recipe-parser')
  const fs = makeFs(seed)
  try {
    parseRecipe(RECIPE_DIR, fs)
    throw new Error(`expected ${limit} to throw but it succeeded`)
  } catch (err) {
    expect(err).toBeInstanceOf(RecipeParseError)
    if (err instanceof RecipeParseError) {
      expect(err.context.limit).toBe(limit)
      expect(err.context.actualValue).toBe(actual)
    }
    const matchingCall = warnSpy.mock.calls.find(
      ([fields]) => (fields as Record<string, unknown>)?.limit === limit,
    )
    expect(matchingCall, `expected warn log for ${limit}`).toBeDefined()
    if (matchingCall) {
      const [fields] = matchingCall as [Record<string, unknown>, string]
      expect(fields.limitValue).toBeGreaterThan(0)
      expect(fields.actualValue).toBe(actual)
    }
  }
}

describe('recipe-parser DoS limits', () => {
  describe('L-R1: MAX_RECIPE_YAML_BYTES', () => {
    it(`accepts recipe.yaml at exactly ${MAX_RECIPE_YAML_BYTES} bytes`, async () => {
      const base = buildRecipeYaml()
      const padding = MAX_RECIPE_YAML_BYTES - Buffer.byteLength(base, 'utf-8')
      expect(padding).toBeGreaterThan(0)
      const padded = base + '\n' + '#'.repeat(padding - 1)
      expect(Buffer.byteLength(padded, 'utf-8')).toBe(MAX_RECIPE_YAML_BYTES)
      const recipe = await parse(seedSingleArtifact(padded))
      expect(recipe.metadata.recipeId).toBe('fixture-recipe')
    })

    it(`rejects recipe.yaml at ${MAX_RECIPE_YAML_BYTES + 1} bytes`, async () => {
      const base = buildRecipeYaml()
      const padding = MAX_RECIPE_YAML_BYTES + 1 - Buffer.byteLength(base, 'utf-8')
      const padded = base + '\n' + '#'.repeat(padding - 1)
      expect(Buffer.byteLength(padded, 'utf-8')).toBe(MAX_RECIPE_YAML_BYTES + 1)
      await expectLimitThrow(
        seedSingleArtifact(padded),
        'MAX_RECIPE_YAML_BYTES',
        MAX_RECIPE_YAML_BYTES + 1,
      )
    })
  })

  describe('L-R2: MAX_RECIPE_TOTAL_BYTES', () => {
    // The boundary is large (10 MiB). To keep the test fast we use a
    // shrunken envelope: a tiny yaml plus an artifact sized to make
    // the total cross the ceiling. We rely on the artifact-size hop
    // being checked after L-R4 — so we set MAX_ARTIFACT_FILE_BYTES to
    // be small enough to fit, but the running total to cross L-R2.
    // Two 2 MiB artifacts + the rest in artifact #N drive the total
    // over 10 MiB; we use small files repeated to avoid huge memory
    // in the mock fs.

    it('accepts a recipe whose total bytes equal the ceiling', async () => {
      // 5 artifacts × ~2 MiB each = ~10 MiB. Use exact arithmetic.
      // We pick artifact bytes so that yamlBytes + 5 * artifactBytes == ceiling.
      const yamlBody = buildRecipeYaml({
        artifacts: [
          { path: 'pages/A.tsx', type: 'page' },
          { path: 'pages/B.tsx', type: 'page' },
          { path: 'pages/C.tsx', type: 'page' },
          { path: 'pages/D.tsx', type: 'page' },
          { path: 'pages/E.tsx', type: 'page' },
        ],
      })
      const yamlBytes = Buffer.byteLength(yamlBody, 'utf-8')
      const perArtifact = Math.floor((MAX_RECIPE_TOTAL_BYTES - yamlBytes) / 5)
      const artifactBody = 'x'.repeat(perArtifact)
      const remainder =
        MAX_RECIPE_TOTAL_BYTES - yamlBytes - perArtifact * 5
      const lastArtifactBody = 'x'.repeat(perArtifact + remainder)
      const seed: Record<string, string> = {
        [`${RECIPE_DIR}/recipe.yaml`]: yamlBody,
        [`${RECIPE_DIR}/pages/A.tsx`]: artifactBody,
        [`${RECIPE_DIR}/pages/B.tsx`]: artifactBody,
        [`${RECIPE_DIR}/pages/C.tsx`]: artifactBody,
        [`${RECIPE_DIR}/pages/D.tsx`]: artifactBody,
        [`${RECIPE_DIR}/pages/E.tsx`]: lastArtifactBody,
      }
      // Sanity: each artifact must fit under L-R4 = 2 MiB.
      expect(Buffer.byteLength(lastArtifactBody, 'utf-8')).toBeLessThanOrEqual(
        MAX_ARTIFACT_FILE_BYTES,
      )
      const recipe = await parse(seed)
      expect(recipe.artifacts).toHaveLength(5)
    })

    it('rejects a recipe whose total bytes exceed the ceiling by 1', async () => {
      const yamlBody = buildRecipeYaml({
        artifacts: [
          { path: 'pages/A.tsx', type: 'page' },
          { path: 'pages/B.tsx', type: 'page' },
          { path: 'pages/C.tsx', type: 'page' },
          { path: 'pages/D.tsx', type: 'page' },
          { path: 'pages/E.tsx', type: 'page' },
        ],
      })
      const yamlBytes = Buffer.byteLength(yamlBody, 'utf-8')
      const perArtifact = Math.floor((MAX_RECIPE_TOTAL_BYTES - yamlBytes) / 5)
      const artifactBody = 'x'.repeat(perArtifact)
      const remainder =
        MAX_RECIPE_TOTAL_BYTES - yamlBytes - perArtifact * 5
      // Add one extra byte to the last artifact to push total over.
      const lastArtifactBody = 'x'.repeat(perArtifact + remainder + 1)
      expect(Buffer.byteLength(lastArtifactBody, 'utf-8')).toBeLessThanOrEqual(
        MAX_ARTIFACT_FILE_BYTES,
      )
      const seed: Record<string, string> = {
        [`${RECIPE_DIR}/recipe.yaml`]: yamlBody,
        [`${RECIPE_DIR}/pages/A.tsx`]: artifactBody,
        [`${RECIPE_DIR}/pages/B.tsx`]: artifactBody,
        [`${RECIPE_DIR}/pages/C.tsx`]: artifactBody,
        [`${RECIPE_DIR}/pages/D.tsx`]: artifactBody,
        [`${RECIPE_DIR}/pages/E.tsx`]: lastArtifactBody,
      }
      await expectLimitThrow(seed, 'MAX_RECIPE_TOTAL_BYTES', MAX_RECIPE_TOTAL_BYTES + 1)
    })
  })

  describe('L-R3: MAX_RECIPE_ARTIFACTS', () => {
    function buildMany(n: number): { yaml: string; seed: Record<string, string> } {
      const artifacts = Array.from({ length: n }, (_, i) => ({
        path: `pages/F${i}.tsx`,
        type: 'page',
      }))
      const yaml = buildRecipeYaml({ artifacts })
      const seed: Record<string, string> = {
        [`${RECIPE_DIR}/recipe.yaml`]: yaml,
      }
      for (let i = 0; i < n; i++) {
        seed[`${RECIPE_DIR}/pages/F${i}.tsx`] = '// stub'
      }
      return { yaml, seed }
    }

    it(`accepts ${MAX_RECIPE_ARTIFACTS} artifacts`, async () => {
      const { seed } = buildMany(MAX_RECIPE_ARTIFACTS)
      const recipe = await parse(seed)
      expect(recipe.artifacts).toHaveLength(MAX_RECIPE_ARTIFACTS)
    })

    it(`rejects ${MAX_RECIPE_ARTIFACTS + 1} artifacts`, async () => {
      const { seed } = buildMany(MAX_RECIPE_ARTIFACTS + 1)
      await expectLimitThrow(seed, 'MAX_RECIPE_ARTIFACTS', MAX_RECIPE_ARTIFACTS + 1)
    })
  })

  describe('L-R4: MAX_ARTIFACT_FILE_BYTES', () => {
    it(`accepts an artifact at exactly ${MAX_ARTIFACT_FILE_BYTES} bytes`, async () => {
      const body = 'x'.repeat(MAX_ARTIFACT_FILE_BYTES)
      const recipe = await parse(seedSingleArtifact(buildRecipeYaml(), body))
      expect(recipe.artifacts[0].sizeBytes).toBe(MAX_ARTIFACT_FILE_BYTES)
    })

    it(`rejects an artifact at ${MAX_ARTIFACT_FILE_BYTES + 1} bytes`, async () => {
      const body = 'x'.repeat(MAX_ARTIFACT_FILE_BYTES + 1)
      await expectLimitThrow(
        seedSingleArtifact(buildRecipeYaml(), body),
        'MAX_ARTIFACT_FILE_BYTES',
        MAX_ARTIFACT_FILE_BYTES + 1,
      )
    })
  })

  describe('L-R5: MAX_RECIPE_ID_LENGTH', () => {
    it(`accepts recipeId at exactly ${MAX_RECIPE_ID_LENGTH} chars`, async () => {
      const recipeId = 'a'.repeat(MAX_RECIPE_ID_LENGTH)
      const recipe = await parse(seedSingleArtifact(buildRecipeYaml({ recipeId })))
      expect(recipe.metadata.recipeId).toBe(recipeId)
    })

    it(`rejects recipeId at ${MAX_RECIPE_ID_LENGTH + 1} chars`, async () => {
      const recipeId = 'a'.repeat(MAX_RECIPE_ID_LENGTH + 1)
      await expectLimitThrow(
        seedSingleArtifact(buildRecipeYaml({ recipeId })),
        'MAX_RECIPE_ID_LENGTH',
        MAX_RECIPE_ID_LENGTH + 1,
      )
    })

    it('also applies to the kebab-case(name) fallback path', async () => {
      // No explicit recipeId in the yaml: the parser falls back to
      // `kebab-case(name)`. A 128-char ASCII name produces a
      // 128-char fallback id which exceeds the L-R5 ceiling — the
      // ceiling must therefore gate the synthesized id too, not
      // only the explicitly-supplied one.
      const longName = 'a'.repeat(MAX_RECIPE_NAME_LENGTH)
      const yaml = buildRecipeYaml({ name: longName }).replace(
        /^recipeId: ".*"$/m,
        '',
      )
      // Sanity: the manipulated yaml no longer carries a recipeId
      // line so the parser must take the fallback branch.
      expect(yaml.includes('recipeId:')).toBe(false)
      await expectLimitThrow(
        seedSingleArtifact(yaml),
        'MAX_RECIPE_ID_LENGTH',
        MAX_RECIPE_ID_LENGTH + (MAX_RECIPE_NAME_LENGTH - MAX_RECIPE_ID_LENGTH),
      )
    })
  })

  describe('L-R6: MAX_APP_ID_LENGTH (mark-installed validator)', () => {
    // The parser never sees an `appId`; the boundary is gated by the
    // APP_ID_PATTERN regex inside `markInstalledValidator.ts`. We
    // exercise the same path the route layer uses.
    it(`accepts appId at exactly ${MAX_APP_ID_LENGTH} chars`, async () => {
      const { validateMarkInstalledRequest } = await import(
        '../../src/server/recipe/markInstalledValidator.js'
      )
      const appId = 'a' + 'b'.repeat(MAX_APP_ID_LENGTH - 1) // 64 chars total
      const result = validateMarkInstalledRequest('any/recipe-id', {
        appId,
        approvedScopes: [],
        recipeVersion: '1.0.0',
        recipeSource: 'sample',
        recipeHash: 'sha256:deadbeef',
        installNonce: '0123456789abcdef0123456789abcdef',
      })
      expect(result.ok).toBe(true)
    })

    it(`rejects appId at ${MAX_APP_ID_LENGTH + 1} chars`, async () => {
      const { validateMarkInstalledRequest } = await import(
        '../../src/server/recipe/markInstalledValidator.js'
      )
      const appId = 'a' + 'b'.repeat(MAX_APP_ID_LENGTH) // 65 chars total
      const result = validateMarkInstalledRequest('any/recipe-id', {
        appId,
        approvedScopes: [],
        recipeVersion: '1.0.0',
        recipeSource: 'sample',
        recipeHash: 'sha256:deadbeef',
        installNonce: '0123456789abcdef0123456789abcdef',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(400)
        expect(result.error).toMatch(/appId/)
      }
    })
  })

  describe('L-R7: MAX_RECIPE_NAME_LENGTH', () => {
    it(`accepts name at exactly ${MAX_RECIPE_NAME_LENGTH} chars`, async () => {
      const name = 'n'.repeat(MAX_RECIPE_NAME_LENGTH)
      const recipe = await parse(seedSingleArtifact(buildRecipeYaml({ name })))
      expect(recipe.metadata.name).toBe(name)
    })

    it(`rejects name at ${MAX_RECIPE_NAME_LENGTH + 1} chars`, async () => {
      const name = 'n'.repeat(MAX_RECIPE_NAME_LENGTH + 1)
      await expectLimitThrow(
        seedSingleArtifact(buildRecipeYaml({ name })),
        'MAX_RECIPE_NAME_LENGTH',
        MAX_RECIPE_NAME_LENGTH + 1,
      )
    })
  })

  describe('L-R8: MAX_INSTRUCTION_BYTES', () => {
    it(`accepts instruction at exactly ${MAX_INSTRUCTION_BYTES} bytes`, async () => {
      const instruction = 'i'.repeat(MAX_INSTRUCTION_BYTES)
      const recipe = await parse(
        seedSingleArtifact(buildRecipeYaml({ instruction })),
      )
      expect(recipe.instruction).toBeDefined()
      expect(Buffer.byteLength(recipe.instruction ?? '', 'utf-8')).toBe(
        MAX_INSTRUCTION_BYTES,
      )
    })

    it(`rejects instruction at ${MAX_INSTRUCTION_BYTES + 1} bytes`, async () => {
      const instruction = 'i'.repeat(MAX_INSTRUCTION_BYTES + 1)
      await expectLimitThrow(
        seedSingleArtifact(buildRecipeYaml({ instruction })),
        'MAX_INSTRUCTION_BYTES',
        MAX_INSTRUCTION_BYTES + 1,
      )
    })
  })

  describe('L-R9: MAX_PERMISSION_ENTRIES', () => {
    // The api.scopes shape validator rejects unknown scope names, so
    // we use the only valid scope name repeated. Recipe parsing has
    // a separate down-stream uniqueness check for scopes only via
    // validateApiSection — duplicates of valid names pass type
    // validation and let the count check fire cleanly.

    it(`accepts ${MAX_PERMISSION_ENTRIES} permission entries`, async () => {
      const scopes = Array.from({ length: MAX_PERMISSION_ENTRIES }, () => 'project-read')
      const recipe = await parse(seedSingleArtifact(buildRecipeYaml({ scopes })))
      expect(recipe.api?.scopes).toHaveLength(MAX_PERMISSION_ENTRIES)
    })

    it(`rejects ${MAX_PERMISSION_ENTRIES + 1} permission entries`, async () => {
      const scopes = Array.from(
        { length: MAX_PERMISSION_ENTRIES + 1 },
        () => 'project-read',
      )
      await expectLimitThrow(
        seedSingleArtifact(buildRecipeYaml({ scopes })),
        'MAX_PERMISSION_ENTRIES',
        MAX_PERMISSION_ENTRIES + 1,
      )
    })
  })
})
