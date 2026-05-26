/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Safe gray-matter wrapper enforcing js-yaml `CORE_SCHEMA` so the
 * YAML decoder cannot materialize arbitrary JavaScript types. The
 * compensatory security review (F-24) flagged that the default
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
 * `maxAliasCount`, but the upstream size ceilings in
 * `security-limits.md` (`MAX_RECIPE_YAML_BYTES`,
 * `MAX_RECIPE_TOTAL_BYTES`, etc.) bound the worst-case explosion at
 * parser entry — see `recipe-parser.ts` for the size-first stat
 * checks that gate every `safeMatter` call.
 *
 * The wrapper preserves gray-matter's API surface verbatim: callers
 * keep destructuring `{ data, content }` and the front-matter file
 * shape, so the only diff at each call site is the import path.
 *
 * @see docs/specs/recipe-system.md (safe-schema adoption)
 * @see docs/specs/security-limits.md (size-first DoS bounds)
 */
import matter from 'gray-matter'
// `@types/js-yaml` is not installed (it would only describe
// gray-matter's transitive dependency, which we now invoke
// directly). The local `js-yaml.d.ts` ambient declaration narrows
// the subset we actually use without dragging an extra dev-dep
// into the OSS body.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — see local ambient declaration in same dir
import yaml from 'js-yaml'

const yamlEngine = {
  parse: (input: string): object => {
    const result = yaml.load(input, { schema: yaml.CORE_SCHEMA })
    // js-yaml returns `unknown`; gray-matter expects an
    // object-shaped value for the front-matter section. Null /
    // scalar front-matter is normalized to an empty object so
    // downstream consumers can still safely destructure.
    if (result === null || result === undefined) return {}
    if (typeof result !== 'object') return {}
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
