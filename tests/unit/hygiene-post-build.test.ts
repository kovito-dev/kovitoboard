/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the post-build hygiene helpers (v0.2.0 / spec v1.7
 * §6.10.6.17 H-CR5-A).
 *
 * The hygiene check itself runs as a CLI in CI; the helpers it
 * relies on (`validateManifestSchema`, `walkBootstrapChain`,
 * `detectTopLevelAwait`, `detectAtomicityViolations`) are exported
 * for unit-level coverage so regressions land before a real build.
 */
import { describe, expect, it } from 'vitest'
import {
  validateManifestSchema,
  walkBootstrapChain,
  detectTopLevelAwait,
  detectAtomicityViolations,
} from '../../tools/check-release-hygiene.mjs'

describe('validateManifestSchema (H-CR5-A schema gate)', () => {
  it('accepts a well-formed Vite manifest', () => {
    expect(() =>
      validateManifestSchema({
        'src/renderer/main.tsx': {
          file: 'assets/main-abcd.js',
          imports: ['src/renderer/app-host/hostBootstrap.ts'],
        },
        'src/renderer/app-host/hostBootstrap.ts': {
          file: 'assets/hostBootstrap-1234.js',
        },
      }),
    ).not.toThrow()
  })

  it('rejects a non-object manifest', () => {
    expect(() => validateManifestSchema(null)).toThrow(/not an object/)
    expect(() => validateManifestSchema(42)).toThrow(/not an object/)
  })

  it('rejects an entry with missing string `file`', () => {
    expect(() =>
      validateManifestSchema({
        'src/foo.ts': { imports: [] },
      }),
    ).toThrow(/has no string "file"/)
  })

  it('rejects an entry with non-array imports', () => {
    expect(() =>
      validateManifestSchema({
        'src/foo.ts': { file: 'assets/foo.js', imports: 'not-array' },
      }),
    ).toThrow(/imports is not an array/)
  })
})

describe('walkBootstrapChain', () => {
  it('walks transitive imports starting from each root', () => {
    const manifest = {
      'src/renderer/main.tsx': {
        file: 'a',
        imports: ['src/renderer/app-host/hostBootstrap.ts', 'src/renderer/App.tsx'],
      },
      'src/renderer/app-host/hostBootstrap.ts': {
        file: 'b',
        imports: [],
      },
      'src/renderer/App.tsx': {
        file: 'c',
        imports: ['src/renderer/lib/x.ts'],
      },
      'src/renderer/lib/x.ts': {
        file: 'd',
        imports: [],
      },
    }
    const reachable = walkBootstrapChain(manifest, ['src/renderer/main.tsx'])
    expect(reachable.has('src/renderer/main.tsx')).toBe(true)
    expect(reachable.has('src/renderer/app-host/hostBootstrap.ts')).toBe(true)
    expect(reachable.has('src/renderer/App.tsx')).toBe(true)
    expect(reachable.has('src/renderer/lib/x.ts')).toBe(true)
  })

  it('does not crash on a missing manifest entry', () => {
    const manifest = {
      'src/renderer/main.tsx': {
        file: 'a',
        imports: ['nonexistent-key'],
      },
    }
    const reachable = walkBootstrapChain(manifest, ['src/renderer/main.tsx'])
    expect(reachable.size).toBe(2)
  })
})

describe('detectTopLevelAwait (H-CR2)', () => {
  it('returns an empty array for code with no top-level await', () => {
    const source = `
      import { foo } from 'foo'
      const bar = 42
      async function baz() {
        await foo()
      }
      export { baz }
    `
    expect(detectTopLevelAwait(source)).toEqual([])
  })

  it('detects module-level top-level await', () => {
    const source = `
      import { foo } from 'foo'
      const bar = await foo()
      export const baz = 42
    `
    const hits = detectTopLevelAwait(source)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('ignores await inside async function bodies', () => {
    const source = `
      async function fn() {
        const x = await Promise.resolve(1)
        return x
      }
    `
    expect(detectTopLevelAwait(source)).toEqual([])
  })
})

describe('detectAtomicityViolations (H-CR4)', () => {
  it('returns an empty array for a clean critical section', () => {
    const source = `
      withCriticalSection('ok-scope', () => {
        const x = 1
        return x
      })
    `
    expect(detectAtomicityViolations(source)).toEqual([])
  })

  it('flags an await inside the critical section', () => {
    const source = `
      withCriticalSection('bad-scope', () => {
        const x = await something()
        return x
      })
    `
    const hits = detectAtomicityViolations(source)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].scope).toBe('bad-scope')
    expect(hits[0].construct).toBe('await')
  })

  it('flags .then chains inside the critical section', () => {
    const source = `
      withCriticalSection('also-bad', () => {
        Promise.resolve().then(() => {})
      })
    `
    const hits = detectAtomicityViolations(source)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].construct).toBe('.then(')
  })

  it('flags process.nextTick inside the critical section', () => {
    const source = `
      withCriticalSection('next-tick-bad', () => {
        process.nextTick(() => {})
      })
    `
    const hits = detectAtomicityViolations(source)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].construct).toBe('process.nextTick(')
  })
})
