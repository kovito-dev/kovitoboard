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
 * separate axis from the schema choice. js-yaml v3 has no built-in
 * `maxAliasCount`, so this wrapper enforces two complementary
 * bounds:
 *
 *   - **Per-caller size enforcement.** `recipe-parser.ts` performs
 *     stat-first size checks against `MAX_RECIPE_YAML_BYTES` /
 *     `MAX_RECIPE_TOTAL_BYTES` before calling `safeMatter`, so
 *     externally-sourced recipe documents are bounded at parser
 *     entry. The agent / template paths (`agent-writer.ts`,
 *     `template-reader.ts`) operate on KB-managed files whose
 *     size is bounded by KB's own write paths, but they share
 *     this wrapper so any future entry point inherits the same
 *     contract.
 *
 *   - **Defence-in-depth ceiling (this module).** The wrapper
 *     itself rejects any input larger than
 *     `SAFE_MATTER_MAX_BYTES` (5 MiB) before handing it to
 *     js-yaml. That keeps a runaway frontmatter section from
 *     reaching the alias-resolution loop regardless of which
 *     call site routed it here — even a future caller that
 *     forgot to add an upstream size check stops at this
 *     boundary.
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

const yamlEngine = {
  parse: (input: string): object => {
    const result = yaml.load(input, { schema: yaml.CORE_SCHEMA })
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
 * Drop-in replacement for `matter.stringify(file, data, options)`.
 * Threads the same CORE_SCHEMA YAML engine so the serialized
 * frontmatter cannot regress into `DEFAULT_FULL_SCHEMA` shapes
 * even when callers pass additional options.
 */
export function safeStringify(
  file: string,
  data?: object,
): string {
  return matter.stringify(file, data ?? {}, {
    engines: { yaml: yamlEngine },
  })
}
