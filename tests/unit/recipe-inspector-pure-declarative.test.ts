/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `analyzePureDeclarative` — the heuristic that flags
 * recipe artifacts reaching outside the declarative handler model.
 *
 * Pinned behavior:
 *   - Declarative-only artifacts (calls to `window.kb.call`,
 *     plain JSX, etc.) report `pureDeclarative: true`.
 *   - Each non-declarative pattern adds its name to
 *     `detectedNonDeclarativePatterns`. Multiple matches of the same
 *     pattern across files dedupe to a single entry.
 *   - JSON / Markdown artifacts are skipped — they cannot exercise
 *     the runtime patterns we look for.
 *   - Pattern names are stable IDs the renderer uses to look up
 *     localized labels for the warning dialog.
 *
 * @see docs/specs/v0.1.0-recipe-install-handover.md §3.5
 * @see DEC-006 v2.0 § 6
 */
import { describe, expect, it } from 'vitest'
import { analyzePureDeclarative } from '../../src/server/recipe-inspector'
import type { ArtifactType, ArtifactWithContent } from '../../src/shared/recipe-types'

function makeArtifact(
  path: string,
  content: string,
  type: ArtifactType = 'page',
): ArtifactWithContent {
  return { path, type, content, sizeBytes: Buffer.byteLength(content, 'utf-8') }
}

describe('analyzePureDeclarative', () => {
  it('reports pureDeclarative=true for empty artifact list', () => {
    const result = analyzePureDeclarative([])
    expect(result.pureDeclarative).toBe(true)
    expect(result.detectedNonDeclarativePatterns).toEqual([])
  })

  it('reports pureDeclarative=true for declarative-only code', () => {
    const code = `
      import { useEffect, useState } from 'react'
      export default function Page() {
        const [items, setItems] = useState<string[]>([])
        useEffect(() => {
          window.kb.call('list-items', {}).then((res) => {
            if (res.ok) setItems(res.data as string[])
          })
        }, [])
        return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>
      }
    `
    const result = analyzePureDeclarative([makeArtifact('pages/Page.tsx', code)])
    expect(result.pureDeclarative).toBe(true)
    expect(result.detectedNonDeclarativePatterns).toEqual([])
  })

  it('detects express-router import', () => {
    const code = `import { Router } from 'express'\nconst r = Router()\n`
    const result = analyzePureDeclarative([makeArtifact('lib/router.ts', code, 'lib')])
    expect(result.pureDeclarative).toBe(false)
    expect(result.detectedNonDeclarativePatterns).toContain('express-router')
  })

  it('detects direct fetch()', () => {
    const code = `const data = await fetch('/api/foo').then((r) => r.json())\n`
    const result = analyzePureDeclarative([makeArtifact('pages/Foo.tsx', code)])
    expect(result.pureDeclarative).toBe(false)
    expect(result.detectedNonDeclarativePatterns).toContain('direct-fetch')
  })

  it('detects axios import', () => {
    const code = `import axios from 'axios'\n`
    const result = analyzePureDeclarative([makeArtifact('lib/http.ts', code, 'lib')])
    expect(result.pureDeclarative).toBe(false)
    expect(result.detectedNonDeclarativePatterns).toContain('axios-import')
  })

  it('detects child_process import', () => {
    // The shell-exec regex looks for actual call sites
    // (`spawn(`, `execSync(` etc.), not the bare named import — so
    // a plain import only flags the `child-process` pattern.
    const code = `import { spawn } from 'child_process'\n`
    const result = analyzePureDeclarative([makeArtifact('utils/spawn.ts', code, 'util')])
    expect(result.pureDeclarative).toBe(false)
    expect(result.detectedNonDeclarativePatterns).toContain('child-process')
  })

  it('detects direct fs import (with and without node: prefix)', () => {
    const codeBare = `import { readFileSync } from 'fs'\n`
    const codeNode = `import { readFileSync } from 'node:fs'\n`
    const r1 = analyzePureDeclarative([makeArtifact('utils/a.ts', codeBare, 'util')])
    const r2 = analyzePureDeclarative([makeArtifact('utils/b.ts', codeNode, 'util')])
    expect(r1.detectedNonDeclarativePatterns).toContain('node-fs-direct')
    expect(r2.detectedNonDeclarativePatterns).toContain('node-fs-direct')
  })

  it('detects shell-exec patterns (exec/execSync/spawn/spawnSync)', () => {
    const code = `execSync('ls')\n`
    const result = analyzePureDeclarative([makeArtifact('utils/x.ts', code, 'util')])
    expect(result.detectedNonDeclarativePatterns).toContain('shell-exec')
  })

  it('detects process.env writes', () => {
    const code = `process.env.MY_FLAG = 'true'\n`
    const result = analyzePureDeclarative([makeArtifact('utils/env.ts', code, 'util')])
    expect(result.detectedNonDeclarativePatterns).toContain('process-env-write')
  })

  it('dedupes matched pattern names across multiple files', () => {
    const code = `const a = await fetch('/x'); const b = await fetch('/y');\n`
    const result = analyzePureDeclarative([
      makeArtifact('pages/A.tsx', code),
      makeArtifact('pages/B.tsx', code),
    ])
    const fetchCount = result.detectedNonDeclarativePatterns.filter(
      (p) => p === 'direct-fetch',
    ).length
    expect(fetchCount).toBe(1)
  })

  it('skips JSON and Markdown artifacts', () => {
    // The patterns would textually match these files (e.g. fetch in
    // a JSON snippet) but we explicitly skip non-code formats.
    const json = `{"snippet": "fetch('/danger')"}\n`
    const md = `Use fetch('/x') here\n`
    const result = analyzePureDeclarative([
      // ArtifactType narrows to 'page' | 'style' | ...; the inspector
      // gates on extension, so we forge a benign type here.
      makeArtifact('lib/data.json', json, 'lib'),
      makeArtifact('lib/notes.md', md, 'lib'),
    ])
    expect(result.pureDeclarative).toBe(true)
  })

  it('returns the union of patterns when multiple types are present', () => {
    const code = `
      import { Router } from 'express'
      import axios from 'axios'
      const r = await fetch('/x')
    `
    const result = analyzePureDeclarative([makeArtifact('lib/mixed.ts', code, 'lib')])
    expect(result.pureDeclarative).toBe(false)
    expect(result.detectedNonDeclarativePatterns.sort()).toEqual(
      ['axios-import', 'direct-fetch', 'express-router'].sort(),
    )
  })
})
