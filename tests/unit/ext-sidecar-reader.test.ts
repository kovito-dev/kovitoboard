/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Sidecar reader tests (external-client-api.md §7.3.2.1 (S-5) / §9.4
 * "sidecar reader fixture", BL-2026-285).
 *
 * The reader is the single point that parses the Claude Code per-PID
 * sidecar (`<claudeDir>/sessions/<pid>.json`). Its correctness is the
 * most important failure mode: an upstream schema change must surface as
 * a deterministic `null` (fail-closed = under-delivery), never a partial
 * read that could over-deliver. These tests pin field extraction against
 * the real sidecar schema and the full fail-closed matrix.
 */
import { describe, it, expect } from 'vitest'
import { readSidecar, readProcStarttime } from '../../src/server/ext-client/sidecar-reader'
import type { FileAccessLayer } from '../../src/server/fs-layer'
import { join } from 'path'

const CLAUDE_DIR = '/home/u/.claude'

type BoundedResult =
  | { oversized: false; notRegular: false; content: string }
  | { oversized: true; notRegular: false; size: number }
  | { oversized: false; notRegular: true }

/**
 * Minimal in-memory fs-layer: maps `<claudeDir>/sessions/<pid>.json` to a
 * bounded-read outcome — a raw string body, a thrown error (absence /
 * read error), or an oversized / non-regular gate result. The reader
 * only exercises `readFileBoundedSync`.
 */
function makeFs(
  files: Record<string, string | (() => never) | BoundedResult>,
): FileAccessLayer {
  return {
    readFileBoundedSync: (p: string): BoundedResult => {
      const v = files[p]
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      if (typeof v === 'function') return v()
      if (typeof v === 'string') return { oversized: false, notRegular: false, content: v }
      return v
    },
  } as unknown as FileAccessLayer
}

function sidecarPath(pid: number): string {
  return join(CLAUDE_DIR, 'sessions', `${pid}.json`)
}

// Real sidecar schema captured from `~/.claude/sessions/<pid>.json`.
const REAL_SIDECAR = JSON.stringify({
  pid: 243405,
  sessionId: 'fce481a3-6d10-4536-b0a6-9ee3eab7cd59',
  cwd: '/home/u/workspace/proj',
  startedAt: 1782125733000,
  procStart: '4347449',
  version: '2.1.177',
  peerProtocol: 1,
  kind: 'interactive',
  entrypoint: 'cli',
  agent: 'kb-pdm',
  status: 'busy',
  updatedAt: 1782137510612,
  statusUpdatedAt: 1782137510612,
})

describe('readSidecar — field extraction (S-5)', () => {
  it('extracts sessionId / agent / procStart / startedAt / updatedAt from the real schema', () => {
    const fs = makeFs({ [sidecarPath(243405)]: REAL_SIDECAR })
    const snap = readSidecar(fs, CLAUDE_DIR, 243405)
    expect(snap).toEqual({
      pid: 243405,
      sessionId: 'fce481a3-6d10-4536-b0a6-9ee3eab7cd59',
      agent: 'kb-pdm',
      procStart: '4347449',
      startedAt: 1782125733000,
      updatedAt: 1782137510612,
    })
  })

  it('normalises a plain `claude` (no --agent) sidecar to agent: null', () => {
    const body = JSON.stringify({ pid: 10, sessionId: 's', agent: null, procStart: '1' })
    const fs = makeFs({ [sidecarPath(10)]: body })
    expect(readSidecar(fs, CLAUDE_DIR, 10)?.agent).toBeNull()
  })

  it('best-effort normalises wrong-typed optional fields to null (keeps sessionId)', () => {
    const body = JSON.stringify({
      sessionId: 's',
      agent: 42, // wrong type → null
      procStart: 99, // wrong type → null
      startedAt: 'nope', // wrong type → null
      updatedAt: {}, // wrong type → null
    })
    const fs = makeFs({ [sidecarPath(5)]: body })
    expect(readSidecar(fs, CLAUDE_DIR, 5)).toEqual({
      pid: 5,
      sessionId: 's',
      agent: null,
      procStart: null,
      startedAt: null,
      updatedAt: null,
    })
  })
})

describe('readSidecar — fail-closed matrix (S-1’ (c))', () => {
  it('returns null when the file is absent', () => {
    const fs = makeFs({})
    expect(readSidecar(fs, CLAUDE_DIR, 243405)).toBeNull()
  })

  it('returns null on a read error', () => {
    const fs = makeFs({
      [sidecarPath(7)]: () => {
        throw new Error('EACCES')
      },
    })
    expect(readSidecar(fs, CLAUDE_DIR, 7)).toBeNull()
  })

  it('returns null on JSON parse failure', () => {
    const fs = makeFs({ [sidecarPath(7)]: '{ not json' })
    expect(readSidecar(fs, CLAUDE_DIR, 7)).toBeNull()
  })

  it('returns null when sessionId is missing (the mandatory field)', () => {
    const fs = makeFs({ [sidecarPath(7)]: JSON.stringify({ agent: 'a', procStart: '1' }) })
    expect(readSidecar(fs, CLAUDE_DIR, 7)).toBeNull()
  })

  it('returns null when sessionId is empty / wrong-typed', () => {
    const fsEmpty = makeFs({ [sidecarPath(7)]: JSON.stringify({ sessionId: '' }) })
    expect(readSidecar(fsEmpty, CLAUDE_DIR, 7)).toBeNull()
    const fsWrong = makeFs({ [sidecarPath(8)]: JSON.stringify({ sessionId: 123 }) })
    expect(readSidecar(fsWrong, CLAUDE_DIR, 8)).toBeNull()
  })

  it('returns null when the body is a non-object (array / scalar)', () => {
    const fsArr = makeFs({ [sidecarPath(7)]: '[1,2,3]' })
    expect(readSidecar(fsArr, CLAUDE_DIR, 7)).toBeNull()
    const fsNum = makeFs({ [sidecarPath(8)]: '5' })
    expect(readSidecar(fsNum, CLAUDE_DIR, 8)).toBeNull()
  })

  it('returns null when the bounded read reports oversized (no content buffered)', () => {
    const fs = makeFs({ [sidecarPath(7)]: { oversized: true, notRegular: false, size: 999999 } })
    expect(readSidecar(fs, CLAUDE_DIR, 7)).toBeNull()
  })

  it('returns null when the bounded read reports a non-regular file (FIFO / device / symlink swap)', () => {
    const fs = makeFs({ [sidecarPath(7)]: { oversized: false, notRegular: true } })
    expect(readSidecar(fs, CLAUDE_DIR, 7)).toBeNull()
  })

  it('returns null for a non-positive / non-integer pid without touching fs', () => {
    let touched = false
    const fs = {
      readFileBoundedSync: () => {
        touched = true
        return { oversized: false, notRegular: false, content: '' }
      },
    } as unknown as FileAccessLayer
    expect(readSidecar(fs, CLAUDE_DIR, 0)).toBeNull()
    expect(readSidecar(fs, CLAUDE_DIR, -1)).toBeNull()
    expect(readSidecar(fs, CLAUDE_DIR, 1.5)).toBeNull()
    expect(touched).toBe(false)
  })
})

describe('readProcStarttime — live birth identity + liveness (S-6b)', () => {
  // A representative `/proc/<pid>/stat` line: field 1 pid, field 2 comm
  // (parenthesised), field 3 state, ... field 22 starttime.
  const STAT_LINE =
    '582568 (bash) S 243405 582568 582568 0 -1 4194304 499 2201 0 0 0 0 0 0 ' +
    '20 0 1 0 5805325 5046272 820 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0\n'

  function makeProcFs(content: string | (() => never)): FileAccessLayer {
    return {
      readFileBoundedSync: () => {
        if (typeof content === 'function') return content()
        return { oversized: false, notRegular: false, content }
      },
    } as unknown as FileAccessLayer
  }

  it('extracts starttime (field 22) from a normal stat line', () => {
    expect(readProcStarttime(makeProcFs(STAT_LINE), 582568)).toBe('5805325')
  })

  it('parses correctly when comm contains spaces and parentheses', () => {
    // Same field layout as STAT_LINE (starttime is field 22), but the
    // comm itself contains spaces and a nested ')(' — the parser must key
    // off the LAST ')' to find field 3 onward.
    const tricky =
      '999 (weird )( name) S 243405 999 999 0 -1 4194304 499 2201 0 0 0 0 0 0 ' +
      '20 0 1 0 4242424 5046272 820 0 0 0 0 0 0 0 0 0 0 0 0 0\n'
    expect(readProcStarttime(makeProcFs(tricky), 999)).toBe('4242424')
  })

  it('returns null when /proc/<pid>/stat is gone (process exited → no liveness)', () => {
    const fs = makeProcFs(() => {
      throw new Error('ENOENT')
    })
    expect(readProcStarttime(fs, 12345)).toBeNull()
  })

  it('returns null when there is no closing paren / field 22 is unparseable', () => {
    expect(readProcStarttime(makeProcFs('garbage with no paren'), 1)).toBeNull()
    expect(readProcStarttime(makeProcFs('1 (c) S 1 2 3\n'), 1)).toBeNull() // too few fields
  })

  it('returns null for a non-positive / non-integer pid', () => {
    const fs = makeProcFs(STAT_LINE)
    expect(readProcStarttime(fs, 0)).toBeNull()
    expect(readProcStarttime(fs, -5)).toBeNull()
    expect(readProcStarttime(fs, 2.5)).toBeNull()
  })
})
