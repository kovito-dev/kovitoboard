/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest'

import {
  decideDetach,
  buildDetachedSpawnArgs,
} from '../../tools/kb-detach-helpers.mjs'

describe('decideDetach', () => {
  it('returns false when no flag and no env are set', () => {
    expect(decideDetach([], {})).toBe(false)
    expect(decideDetach(['--port=3001'], { PATH: '/usr/bin' })).toBe(false)
  })

  it('returns true when --detach flag is present', () => {
    expect(decideDetach(['--detach'], {})).toBe(true)
    expect(decideDetach(['--port=3001', '--detach'], {})).toBe(true)
    expect(decideDetach(['--detach', '--project-root', '/x'], {})).toBe(true)
  })

  it('returns true when KOVITOBOARD_DETACH=1 env is set', () => {
    expect(decideDetach([], { KOVITOBOARD_DETACH: '1' })).toBe(true)
  })

  it('treats env values other than the literal "1" as not requesting detach', () => {
    expect(decideDetach([], { KOVITOBOARD_DETACH: '0' })).toBe(false)
    expect(decideDetach([], { KOVITOBOARD_DETACH: 'true' })).toBe(false)
    expect(decideDetach([], { KOVITOBOARD_DETACH: '' })).toBe(false)
  })

  it('returns false when KOVITOBOARD_DETACHED=1 is set, even if --detach is requested', () => {
    // Re-exec child path: parent forwards env, but the child must
    // take the foreground branch to avoid an infinite spawn loop.
    expect(
      decideDetach(['--detach'], { KOVITOBOARD_DETACHED: '1' }),
    ).toBe(false)
    expect(
      decideDetach([], {
        KOVITOBOARD_DETACH: '1',
        KOVITOBOARD_DETACHED: '1',
      }),
    ).toBe(false)
  })

  it('only honours the literal "1" for KOVITOBOARD_DETACHED', () => {
    // Defensive: any non-"1" value means "not yet detached", so a
    // legitimate --detach request should still go through.
    expect(
      decideDetach(['--detach'], { KOVITOBOARD_DETACHED: '0' }),
    ).toBe(true)
    expect(
      decideDetach(['--detach'], { KOVITOBOARD_DETACHED: '' }),
    ).toBe(true)
  })
})

describe('buildDetachedSpawnArgs', () => {
  it('drops every --detach occurrence from childArgs but keeps the script + other args', () => {
    const argv = [
      '/usr/bin/node',
      '/repo/tools/kb-start.mjs',
      '--detach',
      '--port=3001',
      '--detach',
      '--project-root',
      '/work',
    ]
    const { childArgs } = buildDetachedSpawnArgs(argv, {})
    expect(childArgs).toEqual([
      '/repo/tools/kb-start.mjs',
      '--port=3001',
      '--project-root',
      '/work',
    ])
  })

  it('preserves the script path even when no extra args are present', () => {
    const argv = ['/usr/bin/node', '/repo/tools/kb-start.mjs']
    const { childArgs } = buildDetachedSpawnArgs(argv, {})
    expect(childArgs).toEqual(['/repo/tools/kb-start.mjs'])
  })

  it('removes KOVITOBOARD_DETACH from childEnv', () => {
    const env = {
      PATH: '/usr/bin',
      KOVITOBOARD_DETACH: '1',
      KOVITOBOARD_PROJECT_ROOT: '/work',
    }
    const { childEnv } = buildDetachedSpawnArgs(
      ['/usr/bin/node', 'kb-start.mjs'],
      env,
    )
    expect(childEnv.KOVITOBOARD_DETACH).toBeUndefined()
    expect(childEnv.PATH).toBe('/usr/bin')
    expect(childEnv.KOVITOBOARD_PROJECT_ROOT).toBe('/work')
  })

  it('sets KOVITOBOARD_DETACHED=1 in childEnv to break recursion', () => {
    const { childEnv } = buildDetachedSpawnArgs(
      ['/usr/bin/node', 'kb-start.mjs'],
      { PATH: '/usr/bin' },
    )
    expect(childEnv.KOVITOBOARD_DETACHED).toBe('1')
  })

  it('skips undefined env values (Node may surface them as undefined entries)', () => {
    const env = {
      PATH: '/usr/bin',
      EMPTY_BUT_PRESENT: '',
      MISSING: undefined as unknown as string,
    }
    const { childEnv } = buildDetachedSpawnArgs(
      ['/usr/bin/node', 'kb-start.mjs'],
      env,
    )
    expect(childEnv.PATH).toBe('/usr/bin')
    expect(childEnv.EMPTY_BUT_PRESENT).toBe('')
    expect('MISSING' in childEnv).toBe(false)
  })

  it('produces a stable shape for the typical foreground re-exec case', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      KOVITOBOARD_DETACH: '1',
    }
    const { childArgs, childEnv } = buildDetachedSpawnArgs(
      [
        '/usr/bin/node',
        '/repo/tools/kb-start.mjs',
        '--detach',
        '--project-root',
        '/work',
      ],
      env,
    )
    // The child invocation must look like a normal foreground start
    // with the detach marker in env so decideDetach() returns false
    // there.
    expect(childArgs).toEqual([
      '/repo/tools/kb-start.mjs',
      '--project-root',
      '/work',
    ])
    expect(childEnv).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      KOVITOBOARD_DETACHED: '1',
    })
    // Sanity: feeding the produced env back into decideDetach() must
    // make the child take the foreground branch.
    expect(decideDetach(childArgs.slice(1), childEnv)).toBe(false)
  })
})
