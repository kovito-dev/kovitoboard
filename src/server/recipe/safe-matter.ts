/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Safe gray-matter wrapper enforcing js-yaml `CORE_SCHEMA` so the
 * YAML decoder cannot materialize arbitrary JavaScript types. The
 * compensatory security review flagged that the default
 * gray-matter pipeline routes through js-yaml's `DEFAULT_FULL_SCHEMA`,
 * which accepts `!!js/function`, `!!js/regexp`, `!!js/undefined`,
 * and other JS-specific tags — any of which would let a hostile
 * recipe smuggle executable shapes through frontmatter.
 *
 * `CORE_SCHEMA` restricts the parser to the standard YAML primitives
 * (scalars, sequences, mappings, with the JSON-style int / float /
 * bool / null / str resolvers) and rejects every custom tag. That
 * keeps the recipe / agent / template authoring surface focused on
 * data, not embedded code.
 *
 * Anchor / alias amplification (billion-laughs class DoS) is a
 * separate axis from the schema choice. This wrapper enforces
 * three complementary bounds:
 *
 *   - **Per-caller size enforcement.** `recipe-parser.ts`
 *     performs stat-first size checks against
 *     `MAX_RECIPE_YAML_BYTES` / `MAX_RECIPE_TOTAL_BYTES` before
 *     calling `safeMatter`, so externally-sourced recipe
 *     documents are bounded at parser entry. The agent /
 *     template paths (`agent-writer.ts`, `template-reader.ts`)
 *     operate on KB-managed files whose size is bounded by KB's
 *     own write paths.
 *
 *   - **Defence-in-depth byte ceiling.** The wrapper itself
 *     rejects any input larger than `SAFE_MATTER_MAX_BYTES`
 *     (5 MiB) before handing it to js-yaml. That keeps a
 *     runaway frontmatter section from reaching the alias
 *     resolver regardless of which call site routed it here.
 *
 *   - **Text-level alias-count bound.** js-yaml does not expose
 *     a runtime cap on alias resolution, so the wrapper pre-
 *     scans the raw input for YAML anchor (`&name`) and alias
 *     (`*name`) tokens and refuses the document when the count
 *     exceeds `SAFE_MATTER_MAX_ALIASES` (200). The scan first
 *     strips quoted scalars and comments so a string value that
 *     contains `*foo` or `&bar` does not eat into the budget.
 *
 *   - **Text-level nesting-depth bound.** A deeply nested
 *     payload — even one well under the byte and alias budgets —
 *     can still force pathological recursion in the parser. The
 *     wrapper rejects any document whose block-style indent
 *     depth or flow-style `[` / `{` nesting exceeds
 *     `SAFE_MATTER_MAX_DEPTH` (20). The block-style scan uses
 *     2-space indent levels (the canonical recipe style); the
 *     flow-style scan counts net open brackets character by
 *     character after the quoted-scalar strip.
 *
 * Top-level shape is also constrained: the parse engine
 * normalises non-mapping results (null, scalars, arrays) to an
 * empty object so downstream destructuring of named fields stays
 * safe. A top-level YAML sequence is treated the same as no
 * frontmatter rather than slipping through as an array (arrays
 * are `typeof === 'object'` in JavaScript, so this guard is
 * required even though the schema-level check rejects custom
 * tags).
 *
 * The wrapper preserves gray-matter's API surface verbatim:
 * callers keep destructuring `{ data, content }` and the
 * front-matter file shape, so the only diff at each call site is
 * the import path.
 *
 * @see docs/specs/recipe-system.md (safe-schema adoption)
 * @see docs/specs/security-limits.md (size-first DoS bounds)
 */
import matter from 'gray-matter'
// js-yaml is a first-class runtime dependency of this package
// (`package.json` lists it directly, not via gray-matter's
// transitive hoist) and `@types/js-yaml` is a dev-dep. That
// makes the wrapper's dependency surface explicit and survives
// stricter package managers (e.g. pnpm without
// `hoistedDependencies`) or a future gray-matter upgrade that
// drops js-yaml from its own dependency tree.
import yaml from 'js-yaml'

/**
 * Defence-in-depth ceiling on the raw input handed to the
 * wrapper. Per-caller checks (e.g. `recipe-parser.ts` enforcing
 * `MAX_RECIPE_YAML_BYTES`) run upstream of this point; the cap
 * here exists so a future caller that forgets the upstream
 * check still cannot stream a multi-megabyte amplification
 * payload into js-yaml's alias resolver.
 *
 * Exported for unit-test access only.
 */
export const SAFE_MATTER_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB

/**
 * Hard cap on the number of YAML anchor / alias tokens the
 * wrapper will tolerate in a single document. js-yaml does not
 * expose a runtime alias-count limiter, so we pre-scan the raw
 * input and refuse the parse before it ever starts when the
 * token count exceeds this bound. Exported for unit-test
 * access only.
 */
export const SAFE_MATTER_MAX_ALIASES = 200

/**
 * Hard cap on YAML nesting depth (block-style 2-space indent or
 * flow-style `[` / `{`). Even a small frontmatter that hits a
 * runaway depth can force pathological recursion in the parser.
 * Exported for unit-test access only.
 */
export const SAFE_MATTER_MAX_DEPTH = 20

/**
 * Matches a YAML anchor (`&name`) or alias (`*name`) reference.
 * The scanner runs against a quote-stripped view of the input so
 * the pattern does not need to know about YAML's quoting rules;
 * see `stripQuotedScalarsAndComments`.
 */
const ALIAS_TOKEN_PATTERN = /(?:^|[\s[\]{},:])[&*][A-Za-z_][\w-]*/g

/**
 * Remove `'...'` / `"..."` scalar values and `#...` comments
 * from a YAML document. The goal is not full YAML lexing — only
 * to ensure that incidental `&foo` / `*foo` text inside quoted
 * strings does not eat into the alias-token budget, and that
 * `[` / `{` characters inside quoted strings do not inflate the
 * flow-style depth scan. The replacement is content-preserving
 * for length so column offsets stay consistent in any later
 * diagnostics that might want to map back to the source.
 */
function stripQuotedScalarsAndComments(input: string): string {
  return input
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => "'" + ' '.repeat(m.length - 2) + "'")
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => '"' + ' '.repeat(m.length - 2) + '"')
    .replace(/#[^\n]*/g, (m) => ' '.repeat(m.length))
}

function checkNestingDepth(stripped: string): void {
  // Block-style: maximum 2-space indent prefix on any line.
  let maxBlockDepth = 0
  for (const line of stripped.split('\n')) {
    const m = line.match(/^( +)/)
    if (m) {
      const depth = Math.floor(m[1].length / 2)
      if (depth > maxBlockDepth) maxBlockDepth = depth
    }
  }
  // Flow-style: net open-bracket depth after the strip.
  let flowDepth = 0
  let maxFlowDepth = 0
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]
    if (ch === '[' || ch === '{') {
      flowDepth++
      if (flowDepth > maxFlowDepth) maxFlowDepth = flowDepth
    } else if (ch === ']' || ch === '}') {
      if (flowDepth > 0) flowDepth--
    }
  }
  if (
    maxBlockDepth > SAFE_MATTER_MAX_DEPTH ||
    maxFlowDepth > SAFE_MATTER_MAX_DEPTH
  ) {
    throw new Error(
      `safeMatter input exceeds nesting-depth budget (${SAFE_MATTER_MAX_DEPTH})`,
    )
  }
}

const yamlEngine = {
  parse: (input: string): object => {
    const stripped = stripQuotedScalarsAndComments(input)
    const aliasTokens = stripped.match(ALIAS_TOKEN_PATTERN) ?? []
    if (aliasTokens.length > SAFE_MATTER_MAX_ALIASES) {
      throw new Error(
        `safeMatter input exceeds alias-token budget (${SAFE_MATTER_MAX_ALIASES})`,
      )
    }
    checkNestingDepth(stripped)
    const result = yaml.load(input, {
      schema: yaml.CORE_SCHEMA,
    })
    // js-yaml returns `unknown`; gray-matter expects an
    // object-shaped value for the front-matter section.
    //
    // The accepted shape is a plain mapping. The four
    // explicit rejections below normalize the four ways a YAML
    // document can produce something that is technically
    // `typeof === 'object'` (or absent) yet not a key/value
    // record:
    //   * null / undefined           — no frontmatter parsed
    //   * scalars (string / number)  — top-level primitive
    //   * arrays                     — top-level sequence
    //                                  (Array.isArray catches
    //                                  this even though it is
    //                                  also typeof 'object')
    //
    // Normalising them all to `{}` keeps downstream destructuring
    // of named fields safe and preserves gray-matter's drop-in
    // contract.
    if (result === null || result === undefined) return {}
    if (typeof result !== 'object') return {}
    if (Array.isArray(result)) return {}
    return result as object
  },
  stringify: (data: object): string =>
    yaml.dump(data, { schema: yaml.CORE_SCHEMA }),
}

/**
 * Drop-in replacement for `matter(content)` whose YAML engine
 * runs with `js-yaml`'s `CORE_SCHEMA`. The function signature
 * matches gray-matter's default invocation (string in, full
 * `GrayMatterFile` shape out), so existing destructuring sites
 * keep working without code changes.
 *
 * Sites that also call `matter.stringify(body, data)` should
 * import `safeStringify` from this module; the writer-side
 * encoding must be routed through the same CORE_SCHEMA engine to
 * keep the round-trip consistent.
 */
export function safeMatter(content: string): matter.GrayMatterFile<string> {
  // Defence-in-depth: refuse a runaway input before js-yaml even
  // sees it. Upstream callers (recipe-parser.ts) enforce tighter
  // per-format limits via stat-first checks; this guard keeps the
  // floor at a single fixed bound for every caller.
  if (Buffer.byteLength(content, 'utf8') > SAFE_MATTER_MAX_BYTES) {
    throw new Error(
      `safeMatter input exceeds defence-in-depth ceiling (${SAFE_MATTER_MAX_BYTES} bytes)`,
    )
  }
  return matter(content, { engines: { yaml: yamlEngine } })
}

/**
 * Narrow replacement for `matter.stringify(file, data)`. This is
 * not a full drop-in for `matter.stringify(file, data, options)`:
 * the `options` slot is intentionally omitted because the whole
 * point of this module is to pin the YAML engine, and a
 * caller-supplied `engines` override would defeat that. All
 * current call sites already use the two-argument shape, and
 * any future caller that needs gray-matter's broader options
 * surface should land that intentionally so the engine-pinning
 * contract stays visible at the call site.
 *
 * Threads the same CORE_SCHEMA YAML engine so the serialized
 * frontmatter cannot regress into `DEFAULT_FULL_SCHEMA` shapes.
 */
export function safeStringify(file: string, data?: object): string {
  return matter.stringify(file, data ?? {}, {
    engines: { yaml: yamlEngine },
  })
}
