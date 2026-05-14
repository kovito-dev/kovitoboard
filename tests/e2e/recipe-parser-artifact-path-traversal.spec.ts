/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipe parser artifact-path traversal — wire-level boundary tests
 * (supplementary review §S3).
 *
 * `extractArtifactEntries` rejects three escape shapes at YAML-parse
 * entry so a malicious recipe cannot pull arbitrary project files
 * into `artifact.content`:
 *
 *   - absolute paths (`/etc/passwd`, `/home/user/.env`)
 *   - leading `..` segments (`../../.env`)
 *   - interior `..` after a long prefix that still escapes after
 *     `path.normalize` (`a/b/../../../sibling.tsx`)
 *
 * The wire path runs through `/api/recipes/parse-upload`, the same
 * surface covered by the DoS defence spec. The rejection envelope
 * must NOT leak the structured forensic context (path strings, limit
 * names) the server-side warn log retains.
 */
import { test, expect } from './helpers/l1-per-test-setup'

const API_BASE = 'http://127.0.0.1:3001'

function buildYaml(artifactPath: string): string {
  return [
    '---',
    'recipeId: "traversal-fixture"',
    'name: "Traversal fixture"',
    'description: "wire-level artifact-path traversal fixture"',
    'version: "1.0.0"',
    'artifacts:',
    `  - path: "${artifactPath}"`,
    '    type: "page"',
    '---',
  ].join('\n')
}

const ARTIFACT_STUB =
  'export default function Index(): JSX.Element { return null as never }\n'

test.describe('recipe parser artifact-path traversal (wire-level)', () => {
  test('rejects an absolute artifact path (/etc/passwd)', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/recipes/parse-upload`, {
      data: {
        files: [
          { relPath: 'recipe.yaml', content: buildYaml('/etc/passwd') },
          { relPath: 'pages/Index.tsx', content: ARTIFACT_STUB },
        ],
      },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
    // The rejection envelope must not echo the attacker-supplied
    // path back verbatim — that would let a malicious uploader use
    // the response body as an oracle for filesystem layout. The
    // server-side warn log line retains the forensic detail.
    expect(body.error).not.toContain('/etc/passwd')
  })

  test('rejects a leading ..-escape (../../.env)', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/recipes/parse-upload`, {
      data: {
        files: [
          { relPath: 'recipe.yaml', content: buildYaml('../../.env') },
          { relPath: 'pages/Index.tsx', content: ARTIFACT_STUB },
        ],
      },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })

  test('rejects an interior .. that escapes after normalize', async ({ request }) => {
    // `pages/a/b/../../../../sibling.tsx` normalises to
    // `../sibling.tsx`, escaping the recipe directory even though
    // every segment of the original literal looks innocuous.
    const res = await request.post(`${API_BASE}/api/recipes/parse-upload`, {
      data: {
        files: [
          {
            relPath: 'recipe.yaml',
            content: buildYaml('pages/a/b/../../../../sibling.tsx'),
          },
          { relPath: 'pages/Index.tsx', content: ARTIFACT_STUB },
        ],
      },
    })
    expect(res.status()).toBe(400)
  })

  test('accepts a benign relative artifact path (positive control)', async ({
    request,
  }) => {
    const res = await request.post(`${API_BASE}/api/recipes/parse-upload`, {
      data: {
        files: [
          { relPath: 'recipe.yaml', content: buildYaml('pages/Index.tsx') },
          { relPath: 'pages/Index.tsx', content: ARTIFACT_STUB },
        ],
      },
    })
    if (res.status() !== 200) {
      const body = await res.text()
      throw new Error(`expected 200 but got ${res.status()}: ${body}`)
    }
    const body = await res.json()
    expect(body.recipe?.metadata?.recipeId).toBe('traversal-fixture')
  })
})
