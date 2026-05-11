/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe parser DoS defense — wire-level boundary tests.
 *
 * Verifies that the L-R limit checks added at recipe-parser entry
 * (security-limits.md v1.1 §5.1) are reachable through the HTTP
 * surface and that the route layer maps the resulting
 * `RecipeParseError` into the spec-mandated 413 / 400 envelope
 * without leaking forensic context to the caller (§6.2).
 *
 * The `/api/recipes/parse-upload` wrapper applies its own per-file
 * and per-payload caps (1 MiB / 5 MiB / 50 files). Several L-R
 * limits sit BELOW the wrapper caps, so this suite picks inputs that
 * stay below the wrapper caps while crossing the parser's own
 * boundary — e.g. a 64 KiB + 1 instruction body sits well inside
 * the wrapper but trips L-R8 inside the parser. The remaining cases
 * confirm the wire path also rejects payloads that breach the
 * wrapper caps (1.1 MiB yaml, oversized totals).
 *
 * The grandfather parse path stays operational under v0.2.x recipe
 * install temporary disable (recipe-system.md §10.6), so the
 * happy-path "valid recipe -> 200" case has to keep passing.
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'

function buildRecipeYaml(opts: {
  recipeId?: string
  name?: string
  instruction?: string
}): string {
  const recipeId = opts.recipeId ?? 'dos-defense-fixture'
  const name = opts.name ?? 'DoS defense fixture'
  const lines = [
    '---',
    `recipeId: "${recipeId}"`,
    `name: ${JSON.stringify(name)}`,
    'description: "wire-level DoS defense fixture"',
    'version: "1.0.0"',
  ]
  if (opts.instruction !== undefined) {
    lines.push('instruction: |-')
    for (const ln of opts.instruction.split('\n')) {
      lines.push(`  ${ln}`)
    }
  }
  lines.push('artifacts:')
  lines.push('  - path: "pages/Index.tsx"')
  lines.push('    type: "page"')
  lines.push('---')
  return lines.join('\n')
}

const ARTIFACT_STUB =
  'export default function Index(): JSX.Element { return null as never }\n'

test.describe('recipe parser DoS defense (wire-level)', () => {
  test('valid recipe is parsed (grandfather path)', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/recipes/parse-upload`, {
      data: {
        files: [
          { relPath: 'recipe.yaml', content: buildRecipeYaml({}) },
          { relPath: 'pages/Index.tsx', content: ARTIFACT_STUB },
        ],
      },
    })
    if (res.status() !== 200) {
      // Surface the server's error envelope so diagnostics survive
      // through the Playwright trace when the happy path regresses
      // (e.g. recipe-inspector tightens a check or the route layer
      // mis-maps a new error class).
      const body = await res.text()
      throw new Error(`expected 200 but got ${res.status()}: ${body}`)
    }
    const body = await res.json()
    expect(body.recipe?.metadata?.recipeId).toBe('dos-defense-fixture')
  })

  test('oversized instruction trips L-R8 inside the parser', async ({ request }) => {
    // 64 KiB + 1 instruction body sits well inside the upload
    // wrapper's per-file (1 MiB) and total (5 MiB) caps but crosses
    // MAX_INSTRUCTION_BYTES = 64 KiB inside the parser. The route
    // layer maps RecipeParseError -> 413 with a generic envelope.
    const instruction = 'i'.repeat(65_537)
    const res = await request.post(`${API_BASE}/api/recipes/parse-upload`, {
      data: {
        files: [
          {
            relPath: 'recipe.yaml',
            content: buildRecipeYaml({ instruction }),
          },
          { relPath: 'pages/Index.tsx', content: ARTIFACT_STUB },
        ],
      },
    })
    if (res.status() !== 413) {
      const body = await res.text()
      throw new Error(`expected 413 but got ${res.status()}: ${body}`)
    }
    const body = await res.json()
    expect(typeof body.error).toBe('string')
    // The envelope must NOT leak the parser's structured forensic
    // fields (limit identifier / actual / paths) per security-limits
    // §6.2. The generic message is enough for the caller; the warn
    // log line retains the forensic detail server-side.
    expect(body.error).not.toContain('MAX_INSTRUCTION_BYTES')
  })

  test('oversized recipeId trips L-R5 inside the parser', async ({ request }) => {
    const recipeId = 'a'.repeat(65)
    const res = await request.post(`${API_BASE}/api/recipes/parse-upload`, {
      data: {
        files: [
          {
            relPath: 'recipe.yaml',
            content: buildRecipeYaml({ recipeId }),
          },
          { relPath: 'pages/Index.tsx', content: ARTIFACT_STUB },
        ],
      },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
    expect(body.error).not.toContain('MAX_RECIPE_ID_LENGTH')
  })

  test('payload that crosses the upload wrapper cap is rejected at the wire', async ({
    request,
  }) => {
    // The upload wrapper caps a single file at 1 MiB; sending a
    // 1.1 MiB recipe.yaml exercises the rejection path before the
    // parser is even invoked. Either way the wire must refuse, and
    // the caller gets a 413 (per security-limits §6.2 mapping).
    const padding = 'x'.repeat(1_100_000)
    const yaml = buildRecipeYaml({}) + '\n# pad: ' + padding
    const res = await request.post(`${API_BASE}/api/recipes/parse-upload`, {
      data: {
        files: [
          { relPath: 'recipe.yaml', content: yaml },
          { relPath: 'pages/Index.tsx', content: ARTIFACT_STUB },
        ],
      },
    })
    expect(res.status()).toBe(413)
  })
})
