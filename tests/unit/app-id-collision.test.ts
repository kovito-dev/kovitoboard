/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for the app-id collision detector
 * (`POST /api/apps/check-id-availability` underlying logic).
 *
 * Pinned behavior (spec §3.1):
 *   - The format regex `/^[a-z][a-z0-9-]{0,63}$/` is enforced at
 *     the boundary; the ambient detector accepts only well-formed
 *     ids and trusts callers to validate before suggesting a base.
 *   - All four namespaces are walked: `app/menu.ts` entries,
 *     `app/<id>/`, `app/data/<id>/`, `recipes-installed/<id>/`.
 *   - When `proposedId` is taken, the function suggests `<base>-2`
 *     and walks upward until either a free slot is found or
 *     `SUFFIX_MAX_INDEX` (100) is exhausted.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'path'
import {
  collectTakenAppIds,
  findAvailableAppId,
  validateProposedAppId,
  APP_ID_PATTERN,
  SUFFIX_MAX_INDEX,
} from '../../src/server/services/app-id-collision'
import type { FileAccessLayer } from '../../src/server/fs-layer'

/**
 * Build a `FileAccessLayer` over a literal map of paths -> contents
 * for files, plus an explicit set of directory paths. Anything not
 * listed is reported as not existing.
 */
function makeMockFs(opts: {
  files?: Record<string, string>
  dirs?: string[]
}): FileAccessLayer {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const dirs = new Set<string>(opts.dirs ?? [])
  // Make sure parent dirs of every file are also reachable, so the
  // detector's `existsSync(appDir)` path checks line up with reality.
  for (const filePath of files.keys()) {
    const parts = filePath.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/') || '/')
    }
  }
  // Also pre-populate immediate parents of declared dirs.
  for (const d of [...dirs]) {
    const parts = d.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/') || '/')
    }
  }

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
    statSync: () => ({ size: 0, mtime: new Date(), mtimeMs: 0 }),
    readdirSync: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/'
      const items = new Set<string>()
      for (const filePath of files.keys()) {
        if (filePath.startsWith(prefix)) {
          const rest = filePath.slice(prefix.length).split('/')[0]
          items.add(rest)
        }
      }
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length).split('/')[0]
          if (rest.length > 0) items.add(rest)
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
    watch: () => ({ close: async () => {} }),
  }
}

const PROJECT_ROOT = '/proj'

function menuTsContent(ids: string[]): string {
  const items = ids
    .map(
      (id) =>
        `  { id: '${id}', label: '${id}', icon: 'content', component: () => import('./pages/${id}') }`,
    )
    .join(',\n')
  return `import type { AppMenuEntry } from '../src/renderer/types/app-types'\n\nexport const menuEntries: AppMenuEntry[] = [\n${items}${ids.length ? ',\n' : ''}]\n`
}

describe('validateProposedAppId', () => {
  it.each([
    ['todo', true],
    ['todo-list', true],
    ['todo-2', true],
    ['a', true],
    ['a'.repeat(64), true],
    ['a'.repeat(65), false],
    ['1todo', false], // must start with a letter
    ['Todo', false], // uppercase rejected
    ['todo_list', false], // underscore not in regex
    ['todo list', false], // whitespace rejected
    ['', false],
  ])('"%s" -> %s', (input, expected) => {
    const result = validateProposedAppId(input)
    if (expected) expect(result.kind).toBe('valid')
    else expect(result.kind).toBe('invalid')
  })

  it('rejects non-string input', () => {
    expect(validateProposedAppId(null).kind).toBe('invalid')
    expect(validateProposedAppId(123).kind).toBe('invalid')
    expect(validateProposedAppId(undefined).kind).toBe('invalid')
  })
})

describe('collectTakenAppIds', () => {
  it('collects ids from app/menu.ts entries', () => {
    const fs = makeMockFs({
      files: {
        [join(PROJECT_ROOT, 'app/menu.ts')]: menuTsContent(['todo', 'doc']),
      },
    })
    const taken = collectTakenAppIds(fs, PROJECT_ROOT)
    expect(taken.has('todo')).toBe(true)
    expect(taken.has('doc')).toBe(true)
  })

  it('collects ids from app/<id>/ subdirectories (excluding well-known siblings)', () => {
    const fs = makeMockFs({
      files: {
        [join(PROJECT_ROOT, 'app/menu.ts')]: menuTsContent([]),
        [join(PROJECT_ROOT, 'app/notes/page.tsx')]: '',
      },
      dirs: [
        join(PROJECT_ROOT, 'app/notes'),
        join(PROJECT_ROOT, 'app/data'), // siblings: must NOT be flagged
        join(PROJECT_ROOT, 'app/styles'),
      ],
    })
    const taken = collectTakenAppIds(fs, PROJECT_ROOT)
    expect(taken.has('notes')).toBe(true)
    expect(taken.has('data')).toBe(false)
    expect(taken.has('styles')).toBe(false)
    expect(taken.has('menu.ts')).toBe(false)
  })

  it('collects ids from app/data/<id>/ even without a menu entry', () => {
    const fs = makeMockFs({
      files: {
        [join(PROJECT_ROOT, 'app/menu.ts')]: menuTsContent([]),
      },
      dirs: [
        join(PROJECT_ROOT, 'app/data'),
        join(PROJECT_ROOT, 'app/data/orphan-data'),
      ],
    })
    const taken = collectTakenAppIds(fs, PROJECT_ROOT)
    expect(taken.has('orphan-data')).toBe(true)
  })

  it('collects ids from recipes-installed/<id>/ history', () => {
    const fs = makeMockFs({
      files: {
        [join(PROJECT_ROOT, 'app/menu.ts')]: menuTsContent([]),
        [join(PROJECT_ROOT, '.kovitoboard/recipes-installed/old-todo/manifest.json')]: '{}',
      },
    })
    const taken = collectTakenAppIds(fs, PROJECT_ROOT)
    expect(taken.has('old-todo')).toBe(true)
  })

  it('returns an empty set for a fresh project', () => {
    const fs = makeMockFs({})
    const taken = collectTakenAppIds(fs, PROJECT_ROOT)
    expect(taken.size).toBe(0)
  })
})

describe('findAvailableAppId', () => {
  it('returns available: true when no namespace contains the id', () => {
    const fs = makeMockFs({})
    const result = findAvailableAppId(fs, PROJECT_ROOT, 'todo')
    expect(result.available).toBe(true)
  })

  it('suggests "<base>-2" when the base is taken', () => {
    const fs = makeMockFs({
      files: {
        [join(PROJECT_ROOT, 'app/menu.ts')]: menuTsContent(['todo']),
      },
    })
    const result = findAvailableAppId(fs, PROJECT_ROOT, 'todo')
    expect(result.available).toBe(false)
    if (!result.available) {
      expect(result.suggested).toBe('todo-2')
      expect(result.reason).toContain('todo')
    }
  })

  it('walks past consecutive collisions (todo, todo-2 -> suggests todo-3)', () => {
    const fs = makeMockFs({
      files: {
        [join(PROJECT_ROOT, 'app/menu.ts')]: menuTsContent(['todo', 'todo-2']),
      },
    })
    const result = findAvailableAppId(fs, PROJECT_ROOT, 'todo')
    if (!result.available) {
      expect(result.suggested).toBe('todo-3')
    }
  })

  it('flags a recipes-installed history entry as taken even without a menu / dir', () => {
    const fs = makeMockFs({
      files: {
        [join(PROJECT_ROOT, '.kovitoboard/recipes-installed/todo/manifest.json')]: '{}',
      },
    })
    const result = findAvailableAppId(fs, PROJECT_ROOT, 'todo')
    expect(result.available).toBe(false)
  })

  it('returns suggested: null when SUFFIX_MAX_INDEX is exhausted', () => {
    // Pre-populate every suffix variant up to and including
    // SUFFIX_MAX_INDEX. The detector is then forced to give up.
    const ids = ['todo']
    for (let i = 2; i <= SUFFIX_MAX_INDEX; i++) ids.push(`todo-${i}`)
    const fs = makeMockFs({
      files: {
        [join(PROJECT_ROOT, 'app/menu.ts')]: menuTsContent(ids),
      },
    })
    const result = findAvailableAppId(fs, PROJECT_ROOT, 'todo')
    expect(result.available).toBe(false)
    if (!result.available) {
      expect(result.suggested).toBeNull()
      expect(result.reason).toMatch(/no free suffix-numbered candidate/i)
    }
  })

  it('emits suggestions that themselves match the format regex', () => {
    const fs = makeMockFs({
      files: {
        [join(PROJECT_ROOT, 'app/menu.ts')]: menuTsContent(['notes']),
      },
    })
    const result = findAvailableAppId(fs, PROJECT_ROOT, 'notes')
    if (!result.available && result.suggested) {
      expect(APP_ID_PATTERN.test(result.suggested)).toBe(true)
    }
  })
})
