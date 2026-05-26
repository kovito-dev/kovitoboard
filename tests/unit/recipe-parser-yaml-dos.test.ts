/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Tests for the `safeMatter` / `safeStringify` wrappers introduced
 * in v0.2.1 to lock the recipe / agent / template YAML decoder
 * into `js-yaml`'s `CORE_SCHEMA`.
 *
 * Coverage:
 *
 *   1. Custom JS-typed tags (`!!js/function`, `!!js/regexp`,
 *      `!!js/undefined`) are rejected. These are the shapes that
 *      `DEFAULT_FULL_SCHEMA` would have accepted; CORE_SCHEMA
 *      refuses them outright, so a hostile recipe cannot smuggle
 *      executable shapes through frontmatter.
 *   2. Standard YAML primitives (int / float / bool / null / str
 *      / map / sequence) still decode correctly.
 *   3. Billion-laughs class payloads (anchor / alias amplification)
 *      do not hang or OOM the parser within reasonable bounds. The
 *      upstream size ceilings in security-limits.md bound the
 *      worst-case at parser entry — this test exercises the
 *      schema-level behaviour with a small but explosive payload
 *      so a regression in size limits cannot quietly reopen the
 *      attack surface.
 *   4. The wrapper's API surface (destructuring `{ data, content }`,
 *      `safeStringify(body, data)` round-trip) matches the
 *      gray-matter default invocation that the existing call sites
 *      rely on.
 *
 * @see src/server/recipe/safe-matter.ts (the SUT)
 * @see docs/specs/recipe-system.md (safe-schema adoption)
 */
import { describe, it, expect } from 'vitest'
import {
  safeMatter,
  safeStringify,
  SAFE_MATTER_MAX_BYTES,
  SAFE_MATTER_MAX_ALIASES,
  SAFE_MATTER_MAX_DEPTH,
} from '../../src/server/recipe/safe-matter'

describe('safeMatter — CORE_SCHEMA rejection of JS-typed tags', () => {
  it('rejects !!js/function in frontmatter', () => {
    const hostile = [
      '---',
      "evil: !!js/function 'function(){return 42}'",
      '---',
      'body',
    ].join('\n')
    expect(() => safeMatter(hostile)).toThrow()
  })

  it('rejects !!js/regexp in frontmatter', () => {
    const hostile = [
      '---',
      "pattern: !!js/regexp '/secret/i'",
      '---',
      'body',
    ].join('\n')
    expect(() => safeMatter(hostile)).toThrow()
  })

  it('rejects !!js/undefined in frontmatter', () => {
    const hostile = ['---', "wat: !!js/undefined ''", '---', 'body'].join('\n')
    expect(() => safeMatter(hostile)).toThrow()
  })

  it('rejects nested JS-typed shapes inside maps and sequences', () => {
    const hostile = [
      '---',
      'wrapped:',
      "  - inner: !!js/function 'function(){return 1}'",
      '---',
      'body',
    ].join('\n')
    expect(() => safeMatter(hostile)).toThrow()
  })
})

describe('safeMatter — top-level shape normalization', () => {
  it('normalizes a top-level YAML sequence to an empty object', () => {
    // `---\n- a\n- b\n---` parses to `['a', 'b']` under the
    // default contract, but arrays are typeof === 'object' in JS
    // so the previous `typeof result === 'object'` guard would
    // have let it through. The dedicated `Array.isArray` reject
    // keeps the destructure contract intact: callers can still
    // write `const { data, content } = safeMatter(...)` and
    // index named fields without worrying about array shapes.
    const yaml = ['---', '- a', '- b', '---', 'body'].join('\n')
    const { data, content } = safeMatter(yaml)
    expect(data).toEqual({})
    expect(content.trim()).toBe('body')
  })

  it('normalizes a top-level YAML scalar to an empty object', () => {
    const yaml = ['---', "'just a string'", '---', 'body'].join('\n')
    const { data } = safeMatter(yaml)
    expect(data).toEqual({})
  })
})

describe('safeMatter — defence-in-depth byte ceiling', () => {
  it('rejects an input larger than SAFE_MATTER_MAX_BYTES', () => {
    // A document at byte ceiling + 1 must throw before js-yaml
    // even sees it. The threshold is enforced via
    // `Buffer.byteLength(content, 'utf8')` so multi-byte UTF-8
    // characters cannot smuggle a larger payload past a naive
    // `.length` check.
    const huge = '#'.repeat(SAFE_MATTER_MAX_BYTES + 1)
    expect(() => safeMatter(huge)).toThrow(/exceeds defence-in-depth ceiling/)
  })

  it('accepts an input exactly at the byte ceiling', () => {
    // Use a body-only document so the parser does not attempt
    // to decode the entire payload as YAML. The cap targets the
    // raw input size, not the decoded structure.
    const cap = SAFE_MATTER_MAX_BYTES
    const body = '#'.repeat(cap)
    expect(() => safeMatter(body)).not.toThrow()
  })
})

describe('safeMatter — standard YAML primitives accepted', () => {
  it('decodes ints, floats, bools, null, and strings', () => {
    const yaml = [
      '---',
      'intVal: 42',
      'floatVal: 3.14',
      'trueVal: true',
      'falseVal: false',
      'nullVal: null',
      "stringVal: 'hello'",
      '---',
      'body content',
    ].join('\n')
    const { data, content } = safeMatter(yaml)
    expect(data).toEqual({
      intVal: 42,
      floatVal: 3.14,
      trueVal: true,
      falseVal: false,
      nullVal: null,
      stringVal: 'hello',
    })
    expect(content.trim()).toBe('body content')
  })

  it('decodes nested maps and sequences', () => {
    const yaml = [
      '---',
      'recipe:',
      '  name: Test',
      '  artifacts:',
      "    - path: 'pages/Foo.tsx'",
      "      type: 'page'",
      "    - path: 'lib/util.ts'",
      "      type: 'lib'",
      '---',
      'body',
    ].join('\n')
    const { data } = safeMatter(yaml) as {
      data: { recipe: { name: string; artifacts: Array<{ path: string; type: string }> } }
    }
    expect(data.recipe.name).toBe('Test')
    expect(data.recipe.artifacts).toHaveLength(2)
    expect(data.recipe.artifacts[0]).toEqual({ path: 'pages/Foo.tsx', type: 'page' })
  })

  it('returns an empty object for blank / null frontmatter', () => {
    const blank = ['---', '---', 'body only'].join('\n')
    const { data, content } = safeMatter(blank)
    expect(data).toEqual({})
    expect(content.trim()).toBe('body only')
  })

  it('handles a document with no frontmatter section', () => {
    const noFrontmatter = '# Just markdown, no frontmatter'
    const { data, content } = safeMatter(noFrontmatter)
    expect(data).toEqual({})
    expect(content).toBe(noFrontmatter)
  })
})

describe('safeMatter — quoted scalar tokens are not counted', () => {
  it('does not count `*foo` / `&bar` inside single-quoted strings', () => {
    // A legitimate value that happens to contain alias-looking
    // text must not eat into the alias budget. The scanner
    // strips single-quoted scalars before counting.
    const yaml = [
      '---',
      "value: 'preceded by *not_an_alias and &not_an_anchor'",
      '---',
      'body',
    ].join('\n')
    expect(() => safeMatter(yaml)).not.toThrow()
    const { data } = safeMatter(yaml) as {
      data: { value: string }
    }
    expect(data.value).toContain('*not_an_alias')
    expect(data.value).toContain('&not_an_anchor')
  })

  it('does not count `*foo` / `&bar` inside double-quoted strings', () => {
    const yaml = [
      '---',
      'value: "embedded *star and &amp markers"',
      '---',
      'body',
    ].join('\n')
    expect(() => safeMatter(yaml)).not.toThrow()
    const { data } = safeMatter(yaml) as {
      data: { value: string }
    }
    expect(data.value).toContain('*star')
    expect(data.value).toContain('&amp')
  })

  it('does not count `*foo` / `&bar` inside a YAML comment', () => {
    const yaml = [
      '---',
      'value: 1  # this comment mentions *foo and &bar',
      '---',
      'body',
    ].join('\n')
    expect(() => safeMatter(yaml)).not.toThrow()
    const { data } = safeMatter(yaml) as { data: { value: number } }
    expect(data.value).toBe(1)
  })
})

describe('safeMatter — nesting-depth budget', () => {
  it('refuses a block-style document exceeding SAFE_MATTER_MAX_DEPTH', () => {
    // Build a single chain of nested mappings whose 2-space
    // indent count exceeds the cap.
    const lines: string[] = ['---']
    for (let d = 0; d <= SAFE_MATTER_MAX_DEPTH + 1; d++) {
      lines.push(`${'  '.repeat(d)}k${d}:`)
    }
    lines.push(`${'  '.repeat(SAFE_MATTER_MAX_DEPTH + 2)}leaf: x`)
    lines.push('---')
    lines.push('body')
    expect(() => safeMatter(lines.join('\n'))).toThrow(
      /nesting-depth budget/,
    )
  })

  it('refuses a flow-style document exceeding SAFE_MATTER_MAX_DEPTH', () => {
    // Build a chain of nested flow-style sequences: `[[[[...]]]]`
    // beyond the cap.
    const open = '['.repeat(SAFE_MATTER_MAX_DEPTH + 5)
    const close = ']'.repeat(SAFE_MATTER_MAX_DEPTH + 5)
    const yaml = ['---', `nested: ${open}1${close}`, '---', 'body'].join('\n')
    expect(() => safeMatter(yaml)).toThrow(/nesting-depth budget/)
  })

  it('accepts shallow nesting that legitimate recipes actually use', () => {
    // Real-world recipe shape: 3-4 levels of nesting is typical
    // (recipe → artifacts → entry → field). Well inside the cap.
    const yaml = [
      '---',
      'recipe:',
      '  artifacts:',
      '    - path: pages/Foo',
      '      meta:',
      '        kind: page',
      '---',
      'body',
    ].join('\n')
    expect(() => safeMatter(yaml)).not.toThrow()
  })

  it('does not count `[` / `{` inside quoted strings toward flow depth', () => {
    // A legitimate value that contains bracket-like text in a
    // quoted scalar must not inflate the flow-depth scan.
    const yaml = [
      '---',
      'value: "an [opening bracket inside quotes does not nest"',
      '---',
      'body',
    ].join('\n')
    expect(() => safeMatter(yaml)).not.toThrow()
  })
})

describe('safeMatter — alias-token budget', () => {
  it('refuses an input whose anchor/alias token count exceeds SAFE_MATTER_MAX_ALIASES', () => {
    // Construct a frontmatter with N anchor definitions and N
    // alias references. 2*N tokens; refuses when 2N >
    // SAFE_MATTER_MAX_ALIASES.
    const N = SAFE_MATTER_MAX_ALIASES / 2 + 10
    const lines: string[] = ['---', 'anchors:']
    for (let i = 0; i < N; i++) {
      lines.push(`  - &a${i} x`)
    }
    lines.push('aliases:')
    for (let i = 0; i < N; i++) {
      lines.push(`  - *a${i}`)
    }
    lines.push('---')
    lines.push('body')
    expect(() => safeMatter(lines.join('\n'))).toThrow(
      /alias-token budget/,
    )
  })

  it('accepts a small number of legitimate anchors and aliases', () => {
    // A real-world shared-structure recipe (e.g. shared `kind:
    // page` constant) is rare but legal; one anchor + one alias
    // is well under the budget.
    const yaml = [
      '---',
      'shared: &kind page',
      'one: *kind',
      'two: *kind',
      '---',
      'body',
    ].join('\n')
    const { data } = safeMatter(yaml) as {
      data: { shared: string; one: string; two: string }
    }
    expect(data.shared).toBe('page')
    expect(data.one).toBe('page')
    expect(data.two).toBe('page')
  })

  it('refuses a billion-laughs style chain before js-yaml resolves it', () => {
    // Classic exponential-expansion shape — the actual decode is
    // never reached because the token count trips the budget
    // first. We assert behaviour, not which specific check
    // fires (alias-budget or byte-budget), as long as the
    // wrapper refuses the input deterministically and quickly.
    const lines: string[] = ['---']
    // Build a 10-wide chain of nested aliases. Token count is
    // O(W * D); W=10, D=22 → 220 tokens > 200 budget.
    let prev = 'leaf'
    lines.push('leaf: &leaf x')
    for (let i = 0; i < 22; i++) {
      const refs: string[] = []
      for (let j = 0; j < 10; j++) refs.push(`*${prev}`)
      const name = `n${i}`
      lines.push(`${name}: &${name} [${refs.join(', ')}]`)
      prev = name
    }
    lines.push('---')
    lines.push('body')
    const start = Date.now()
    expect(() => safeMatter(lines.join('\n'))).toThrow()
    const elapsed = Date.now() - start
    // Budget check fires before any exponential resolution can
    // begin; even on a slow CI box this should return in well
    // under a second.
    expect(elapsed).toBeLessThan(500)
  })
})

describe('safeMatter — billion-laughs / anchor amplification bounds', () => {
  it('does not hang on a small alias-expansion payload', () => {
    // A 5-level alias chain expands to ~2^5 references at the
    // outermost level. js-yaml v3 still resolves this without
    // exhausting memory on small inputs, but the test guards
    // against a regression where the schema choice accidentally
    // unblocks an unbounded resolver.
    const yaml = [
      '---',
      'a: &a [x, x]',
      'b: &b [*a, *a]',
      'c: &c [*b, *b]',
      'd: &d [*c, *c]',
      'e: [*d, *d]',
      '---',
      'body',
    ].join('\n')
    const start = Date.now()
    const { data } = safeMatter(yaml)
    const elapsed = Date.now() - start
    // The unwound 'e' array contains 2^5 = 32 leaf values via
    // shared references.
    expect(Array.isArray((data as { e: unknown }).e)).toBe(true)
    // Generous wall-clock budget — we are checking for "did not
    // hang", not benchmarking. 500ms is two orders of magnitude
    // above the typical parse time for this size on a laptop.
    expect(elapsed).toBeLessThan(500)
  })

  it('respects existing input-size limits when the payload grows', () => {
    // 1 MiB of trivial YAML scalars: large by design, but well
    // inside the parser's MAX_RECIPE_YAML_BYTES ceiling. This
    // documents the contract that DoS-class inputs are bounded
    // at parser entry by security-limits.md, not by the schema
    // choice alone. The point of the test is to lock in
    // "safeMatter does not regress the existing happy path for
    // large-but-legitimate frontmatter".
    const lines: string[] = ['---']
    for (let i = 0; i < 5000; i++) {
      lines.push(`key${i}: value${i}`)
    }
    lines.push('---')
    lines.push('body')
    const yaml = lines.join('\n')
    const { data } = safeMatter(yaml)
    expect(Object.keys(data).length).toBe(5000)
  })
})

describe('safeStringify — CORE_SCHEMA encoding round-trip', () => {
  it('round-trips standard primitives through encode/decode', () => {
    const data = {
      version: '1.0.0',
      enabled: true,
      count: 42,
      tags: ['alpha', 'beta'],
    }
    const encoded = safeStringify('body section', data)
    const { data: decoded, content } = safeMatter(encoded)
    expect(decoded).toEqual(data)
    expect(content.trim()).toBe('body section')
  })

  it('refuses to encode JS-typed values back into the document', () => {
    // safeStringify routes through yaml.dump with CORE_SCHEMA, so
    // attempting to encode a function / regexp / undefined / etc.
    // throws or coerces — either way it never produces an
    // executable JS-typed tag in the resulting frontmatter.
    const data: Record<string, unknown> = {
      ok: 'fine',
      // A regexp would be rendered as !!js/regexp under the
      // default schema; CORE_SCHEMA refuses it.
      pattern: /secret/i,
    }
    // js-yaml may throw or quietly stringify; we accept either
    // outcome as long as `!!js/regexp` never appears in the
    // serialized output.
    let encoded: string | null = null
    try {
      encoded = safeStringify('body', data)
    } catch {
      // throwing is also acceptable — the contract is "no JS tag
      // in the result", and throwing satisfies it.
    }
    if (encoded !== null) {
      expect(encoded).not.toContain('!!js/regexp')
      expect(encoded).not.toContain('!!js/function')
      expect(encoded).not.toContain('!!js/undefined')
    }
  })
})
