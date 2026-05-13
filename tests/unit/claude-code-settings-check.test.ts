/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Unit tests for `claude-code-settings-check.ts`.
 *
 * Covers the threat ledger from handoff
 * `v02x-phase1-claude-code-recommended-settings-check-request.md`
 * v1.1 §8.2:
 *   - T-2-1 path traversal / symlink redirection
 *   - T-2-2 fail-closed on read / parse / schema failure
 *   - T-2-3 dismiss state bounding + bypass-mode dismiss refusal
 *   - T-2-4 runtime mutation detection (`watchSettingsFile`)
 *
 * The fs-layer used in these tests is an in-memory minimal mock that
 * implements only the read paths exercised by the check helper. The
 * full `FileAccessLayer` interface is satisfied by casting through
 * `unknown`; this keeps the test fixtures small without depending on
 * the real `DirectFsLayer` (which would otherwise pull in chokidar).
 */
import { describe, it, expect } from 'vitest'
import {
  checkClaudeCodeSettings,
  evaluateDismiss,
  buildDismissRecord,
  shouldLogStartupWarning,
  watchSettingsFile,
} from '../../src/server/claude-code-settings-check'
import type {
  FileAccessLayer,
  WatchEvent,
  WatchHandle,
} from '../../src/server/fs-layer'
import type {
  SettingsCheckResult,
  ClaudeCodeSettingsWarning,
  KovitoboardSetting,
} from '../../src/shared/setting-types'

type WatchHandler = (event: WatchEvent) => void

interface MockFsOptions {
  files?: Record<string, string>
  /** Paths that should report ENOENT when read but exist via realpath. */
  unreadable?: Set<string>
  /** Resolution overrides: input path -> canonical path. */
  realpaths?: Record<string, string>
  /** Paths that should throw on realpath (broken symlink). */
  brokenLinks?: Set<string>
  /** Watcher hooks the test suite can drive. */
  watchers?: Map<string, WatchHandler>
  /** Override stat size (defaults to the matching file's UTF-8 byte length). */
  statSizes?: Record<string, number>
}

function makeFs(opts: MockFsOptions = {}): FileAccessLayer {
  const files = opts.files ?? {}
  const realpaths = opts.realpaths ?? {}
  const unreadable = opts.unreadable ?? new Set<string>()
  const brokenLinks = opts.brokenLinks ?? new Set<string>()
  const watchers = opts.watchers ?? new Map<string, WatchHandler>()
  const statSizes = opts.statSizes ?? {}
  const fs: Partial<FileAccessLayer> = {
    existsSync: (path: string) => {
      if (brokenLinks.has(path)) return true
      return path in files || path in realpaths
    },
    readFileSync: (path: string) => {
      if (unreadable.has(path)) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      if (path in files) return files[path]
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    statSync: (path: string) => {
      if (path in statSizes) {
        return { size: statSizes[path], mtime: new Date(0), mtimeMs: 0 }
      }
      if (path in files) {
        return {
          size: Buffer.byteLength(files[path], 'utf-8'),
          mtime: new Date(0),
          mtimeMs: 0,
        }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    realpathSync: (path: string) => {
      if (brokenLinks.has(path)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return realpaths[path] ?? path
    },
    watch: (path: string, handler: WatchHandler): WatchHandle => {
      watchers.set(path, handler)
      return {
        close: () => {
          watchers.delete(path)
        },
      }
    },
  }
  return fs as FileAccessLayer
}

const HOME = '/home/user'
const PROJECT = '/home/user/projects/demo'

function userPath() {
  return `${HOME}/.claude/settings.json`
}
function projectPath() {
  return `${PROJECT}/.claude/settings.json`
}

describe('checkClaudeCodeSettings — happy paths', () => {
  it('returns overallOk: false when no settings file exists (deny missing)', () => {
    const fs = makeFs()
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('ok')
    expect(result.permissionMode.ok).toBe(true) // defaults to "default"
    expect(result.denyPattern.ok).toBe(false)
    expect(result.bypassMode.ok).toBe(true)
    expect(result.overallOk).toBe(false)
  })

  it('reports overallOk: true when user settings cover all recommendations', () => {
    const fs = makeFs({
      files: {
        [userPath()]: JSON.stringify({
          permissionMode: 'default',
          permissions: { deny: ['.kovitoboard/'] },
        }),
      },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.overallOk).toBe(true)
    expect(result.reason).toBe('ok')
    expect(result.permissionMode.current).toBe('default')
    expect(result.denyPattern.hasKovitoboardDeny).toBe(true)
    expect(result.bypassMode.active).toBe(false)
  })

  it('honors `Read(.kovitoboard/**)`-style deny entries', () => {
    const fs = makeFs({
      files: {
        [userPath()]: JSON.stringify({
          permissionMode: 'default',
          permissions: { deny: ['Read(.kovitoboard/**)'] },
        }),
      },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.denyPattern.hasKovitoboardDeny).toBe(true)
  })

  it('flags bypassPermissions and surfaces permissionMode mismatch together', () => {
    const fs = makeFs({
      files: {
        [userPath()]: JSON.stringify({
          permissionMode: 'bypassPermissions',
          permissions: { deny: ['.kovitoboard/'] },
        }),
      },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.permissionMode.ok).toBe(false)
    expect(result.bypassMode.active).toBe(true)
    expect(result.bypassMode.ok).toBe(false)
    expect(result.overallOk).toBe(false)
  })

  it('lets project settings override user permissionMode and union deny', () => {
    const fs = makeFs({
      files: {
        [userPath()]: JSON.stringify({
          permissionMode: 'bypassPermissions',
          permissions: { deny: [] },
        }),
        [projectPath()]: JSON.stringify({
          permissionMode: 'default',
          permissions: { deny: ['.kovitoboard/'] },
        }),
      },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.permissionMode.current).toBe('default')
    expect(result.permissionMode.ok).toBe(true)
    expect(result.bypassMode.active).toBe(false)
    expect(result.denyPattern.hasKovitoboardDeny).toBe(true)
    expect(result.overallOk).toBe(true)
  })

  it('treats project deny entries as union with user deny entries', () => {
    const fs = makeFs({
      files: {
        [userPath()]: JSON.stringify({
          permissionMode: 'default',
          permissions: { deny: ['Bash(rm:*)'] },
        }),
        [projectPath()]: JSON.stringify({
          permissionMode: 'default',
          permissions: { deny: ['Read(.kovitoboard/**)'] },
        }),
      },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.denyPattern.hasKovitoboardDeny).toBe(true)
  })
})

describe('T-2-1: path traversal / symlink redirection', () => {
  it('rejects a project .claude that realpath escapes the home directory', () => {
    const fs = makeFs({
      files: {
        [projectPath()]: JSON.stringify({ permissionMode: 'default' }),
      },
      realpaths: {
        [projectPath()]: '/tmp/attacker-claude/settings.json',
      },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('path-resolution-rejected')
    expect(result.overallOk).toBe(false)
    // T-2-2 fail-closed contract: surfaces all three rows as not-ok
    // so the toast does not look like a partial assessment.
    expect(result.permissionMode.ok).toBe(false)
    expect(result.denyPattern.ok).toBe(false)
    expect(result.bypassMode.ok).toBe(false)
  })

  it('rejects a broken project .claude symlink (ENOENT on realpath)', () => {
    const fs = makeFs({
      brokenLinks: new Set([projectPath()]),
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('path-resolution-rejected')
  })

  it('accepts a project .claude that realpath keeps under home', () => {
    // The fixture stores the file contents at BOTH the original
    // candidate path (so existsSync hits) and the resolved canonical
    // path (so the subsequent readFileSync hits) — mirroring how a
    // real symlink under the home directory would behave.
    const resolved = `${HOME}/symlink-target/settings.json`
    const contents = JSON.stringify({
      permissionMode: 'default',
      permissions: { deny: ['.kovitoboard/'] },
    })
    const fs = makeFs({
      files: {
        [projectPath()]: contents,
        [resolved]: contents,
      },
      realpaths: {
        [projectPath()]: resolved,
      },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('ok')
    expect(result.overallOk).toBe(true)
  })

  it('accepts a project .claude whose realpath stays inside the project tree (outside home)', () => {
    // Mirrors the L1 fixture: project root lives in /tmp, which is
    // outside the user's home directory but is still a legitimate
    // installation. As long as the realpath stays inside the project
    // tree we should NOT reject.
    const externalProject = '/tmp/kb-e2e/projects/demo'
    const candidate = `${externalProject}/.claude/settings.json`
    const contents = JSON.stringify({
      permissionMode: 'default',
      permissions: { deny: ['.kovitoboard/'] },
    })
    const fs = makeFs({
      files: { [candidate]: contents },
    })
    const result = checkClaudeCodeSettings(fs, externalProject, HOME)
    expect(result.reason).toBe('ok')
    expect(result.overallOk).toBe(true)
  })

  it('rejects sibling-prefix attack on home directory', () => {
    // A path like `/home/user-evil/...` must not match `/home/user`
    // by raw startsWith — separator-aware check is what the helper
    // applies internally.
    const fs = makeFs({
      files: {
        [projectPath()]: JSON.stringify({ permissionMode: 'default' }),
      },
      realpaths: {
        [projectPath()]: '/home/user-evil/.claude/settings.json',
      },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('path-resolution-rejected')
  })
})

describe('T-2-2: fail-closed on read / parse / schema failure', () => {
  it('returns reason=read-error when readFileSync throws', () => {
    const fs = makeFs({
      files: { [userPath()]: 'noop' },
      unreadable: new Set([userPath()]),
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('read-error')
    expect(result.overallOk).toBe(false)
  })

  it('returns reason=parse-error on invalid JSON', () => {
    const fs = makeFs({
      files: { [userPath()]: '{not valid json' },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('parse-error')
    expect(result.overallOk).toBe(false)
  })

  it('returns reason=schema-mismatch when parsed value is not an object', () => {
    const fs = makeFs({
      files: { [userPath()]: '["array-not-object"]' },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('schema-mismatch')
    expect(result.overallOk).toBe(false)
  })

  it('returns reason=schema-mismatch for primitive JSON values', () => {
    const fs = makeFs({
      files: { [userPath()]: '"a string"' },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('schema-mismatch')
  })

  it('returns reason=schema-mismatch for JSON null', () => {
    const fs = makeFs({
      files: { [userPath()]: 'null' },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('schema-mismatch')
  })

  it('returns reason=file-too-large when stat reports >1MiB', () => {
    const fs = makeFs({
      files: { [userPath()]: JSON.stringify({ permissionMode: 'default' }) },
      statSizes: { [userPath()]: 2 * 1024 * 1024 },
    })
    const result = checkClaudeCodeSettings(fs, PROJECT, HOME)
    expect(result.reason).toBe('file-too-large')
    expect(result.overallOk).toBe(false)
  })
})

const baseResult: SettingsCheckResult = {
  permissionMode: { current: 'default', recommended: 'default', ok: true },
  denyPattern: { hasKovitoboardDeny: false, ok: false, remediation: 'add' },
  bypassMode: { active: false, ok: true },
  overallOk: false,
  reason: 'ok',
  settingsFilePath: '/home/user/.claude/settings.json',
}

describe('T-2-3: dismiss state evaluation', () => {
  it('suppresses toast within 24h when snapshot matches', () => {
    const now = Date.parse('2026-05-13T12:00:00Z')
    const dismissed: ClaudeCodeSettingsWarning = {
      dismissedAt: '2026-05-13T11:00:00Z',
      dismissedResult: baseResult,
    }
    const evaluation = evaluateDismiss(baseResult, dismissed, now)
    expect(evaluation.suppressToast).toBe(true)
    expect(evaluation.effectiveExpiresAt).not.toBeNull()
  })

  it('does NOT suppress when cooldown expired', () => {
    const now = Date.parse('2026-05-15T12:00:00Z')
    const dismissed: ClaudeCodeSettingsWarning = {
      dismissedAt: '2026-05-13T11:00:00Z', // 49h ago
      dismissedResult: baseResult,
    }
    const evaluation = evaluateDismiss(baseResult, dismissed, now)
    expect(evaluation.suppressToast).toBe(false)
  })

  it('clamps future-dated dismissedAt to now + 24h (T-2-3 ceiling)', () => {
    const now = Date.parse('2026-05-13T12:00:00Z')
    const dismissed: ClaudeCodeSettingsWarning = {
      dismissedAt: '2099-01-01T00:00:00Z', // far future
      dismissedResult: baseResult,
    }
    const evaluation = evaluateDismiss(baseResult, dismissed, now)
    // Clamped: effective dismissedAt = now, expiration = now + 24h.
    expect(evaluation.suppressToast).toBe(true)
    const expires = Date.parse(evaluation.effectiveExpiresAt as string)
    expect(expires - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  it('does NOT suppress when bypass mode is active (I-8)', () => {
    const current: SettingsCheckResult = {
      ...baseResult,
      bypassMode: { active: true, ok: false },
      permissionMode: { current: 'bypassPermissions', recommended: 'default', ok: false },
    }
    const dismissed: ClaudeCodeSettingsWarning = {
      dismissedAt: new Date().toISOString(),
      dismissedResult: current,
    }
    const evaluation = evaluateDismiss(current, dismissed)
    expect(evaluation.suppressToast).toBe(false)
  })

  it('does NOT suppress when the snapshot drifts from the current check', () => {
    const dismissed: ClaudeCodeSettingsWarning = {
      dismissedAt: new Date().toISOString(),
      dismissedResult: {
        ...baseResult,
        denyPattern: {
          hasKovitoboardDeny: true,
          ok: true,
          remediation: 'add',
        },
      },
    }
    const evaluation = evaluateDismiss(baseResult, dismissed)
    expect(evaluation.suppressToast).toBe(false)
  })

  it('suppresses unconditionally when overallOk', () => {
    const ok: SettingsCheckResult = { ...baseResult, overallOk: true }
    const evaluation = evaluateDismiss(ok, undefined)
    expect(evaluation.suppressToast).toBe(true)
  })

  it('does not suppress when dismissedAt is unparseable', () => {
    const dismissed: ClaudeCodeSettingsWarning = {
      dismissedAt: 'not-a-date',
      dismissedResult: baseResult,
    }
    const evaluation = evaluateDismiss(baseResult, dismissed)
    expect(evaluation.suppressToast).toBe(false)
  })
})

describe('buildDismissRecord', () => {
  it('emits an ISO timestamp + snapshot copy with settingsFilePath stripped', () => {
    const record = buildDismissRecord(baseResult, Date.parse('2026-05-13T12:00:00Z'))
    expect(record.dismissedAt).toBe('2026-05-13T12:00:00.000Z')
    // settingsFilePath is intentionally stripped from the persisted
    // snapshot (CodeX attempt 2 — sensitive path persistence) since
    // the matching logic does not consult it.
    expect(record.dismissedResult.settingsFilePath).toBeNull()
    expect(record.dismissedResult.permissionMode).toEqual(baseResult.permissionMode)
    expect(record.dismissedResult.denyPattern).toEqual(baseResult.denyPattern)
    expect(record.dismissedResult.bypassMode).toEqual(baseResult.bypassMode)
    expect(record.dismissedResult.reason).toBe(baseResult.reason)
    expect(record.dismissedResult.overallOk).toBe(baseResult.overallOk)
  })
})

describe('evaluateDismiss — securityRecommendationsReviewedAt no longer auto-suppresses', () => {
  // CodeX attempt 3 noted that a bare review timestamp suppressed
  // subsequent drift for 24h. The current implementation seeds
  // `claudeCodeSettingsWarning` from onboarding instead, so the
  // drift-aware comparison applies uniformly. These tests pin the
  // new behavior: a setting that carries only `reviewedAt` (but no
  // `claudeCodeSettingsWarning`) does NOT suppress.
  it('does NOT suppress on reviewedAt alone (drift-unsafe)', () => {
    const now = Date.parse('2026-05-13T12:00:00Z')
    const setting: KovitoboardSetting = {
      version: '1.1',
      user: { displayName: 'u', avatar: null },
      project: { name: 'p', description: '', path: PROJECT },
      locale: 'en',
      onboarding: {
        completedAt: '2026-05-13T11:00:00Z',
        wizardVersion: '0.1.0',
        securityRecommendationsReviewedAt: '2026-05-13T11:00:00Z',
      },
    }
    const evaluation = evaluateDismiss(baseResult, undefined, now, { setting })
    expect(evaluation.suppressToast).toBe(false)
  })
})

describe('shouldLogStartupWarning', () => {
  it('skips logging when warning is already resolved', () => {
    const ok: SettingsCheckResult = { ...baseResult, overallOk: true }
    expect(shouldLogStartupWarning(ok, null)).toBe(false)
  })

  it('logs when bypass mode is active even if dismissed recently', () => {
    const setting: KovitoboardSetting = {
      version: '1.1',
      user: { displayName: 'u', avatar: null },
      project: { name: 'p', description: '', path: PROJECT },
      locale: 'en',
      onboarding: {
        completedAt: '2026-05-13T11:00:00Z',
        wizardVersion: '0.1.0',
      },
      claudeCodeSettingsWarning: {
        dismissedAt: '2026-05-13T11:00:00Z',
        dismissedResult: baseResult,
      },
    }
    const bypass: SettingsCheckResult = {
      ...baseResult,
      bypassMode: { active: true, ok: false },
    }
    expect(shouldLogStartupWarning(bypass, setting, Date.parse('2026-05-13T12:00:00Z'))).toBe(true)
  })

  it('skips logging when claudeCodeSettingsWarning suppresses (in cooldown + matching)', () => {
    const setting: KovitoboardSetting = {
      version: '1.1',
      user: { displayName: 'u', avatar: null },
      project: { name: 'p', description: '', path: PROJECT },
      locale: 'en',
      onboarding: {
        completedAt: '2026-05-13T11:00:00Z',
        wizardVersion: '0.1.0',
      },
      claudeCodeSettingsWarning: {
        dismissedAt: '2026-05-13T11:00:00Z',
        dismissedResult: baseResult,
      },
    }
    expect(shouldLogStartupWarning(baseResult, setting, Date.parse('2026-05-13T12:00:00Z'))).toBe(false)
  })

  it('logs when dismiss snapshot drifted from current result', () => {
    const setting: KovitoboardSetting = {
      version: '1.1',
      user: { displayName: 'u', avatar: null },
      project: { name: 'p', description: '', path: PROJECT },
      locale: 'en',
      onboarding: {
        completedAt: '2026-05-13T11:00:00Z',
        wizardVersion: '0.1.0',
      },
      claudeCodeSettingsWarning: {
        dismissedAt: '2026-05-13T11:00:00Z',
        dismissedResult: {
          ...baseResult,
          permissionMode: {
            current: 'acceptEdits',
            recommended: 'default',
            ok: false,
          },
        },
      },
    }
    expect(shouldLogStartupWarning(baseResult, setting, Date.parse('2026-05-13T12:00:00Z'))).toBe(true)
  })

  it('logs when no setting record exists', () => {
    expect(shouldLogStartupWarning(baseResult, null)).toBe(true)
  })
})

describe('T-2-4: watchSettingsDirectories supplements file-level watching', () => {
  it('watches both home and project .claude directories when they exist', async () => {
    const { watchSettingsDirectories } = await import(
      '../../src/server/claude-code-settings-check'
    )
    const watchers = new Map<string, WatchHandler>()
    const fs = makeFs({
      watchers,
      files: {
        [`${HOME}/.claude/dummy`]: 'x',
        [`${PROJECT}/.claude/dummy`]: 'x',
      },
    })
    // existsSync returns true only when the path appears in `files` or
    // `realpaths`; add the directory paths so the helper finds them.
    const fsAug = {
      ...fs,
      existsSync: (path: string) => {
        if (path === `${HOME}/.claude`) return true
        if (path === `${PROJECT}/.claude`) return true
        return (fs.existsSync as (p: string) => boolean)(path)
      },
    } as unknown as FileAccessLayer
    let fired = 0
    const handle = watchSettingsDirectories(fsAug, PROJECT, () => {
      fired += 1
    }, HOME)
    expect(handle).not.toBeNull()
    // Two directory watchers attached
    expect(watchers.size).toBe(2)
    for (const h of watchers.values()) {
      h({ type: 'add', path: '/x' })
    }
    expect(fired).toBe(2)
    handle?.close()
  })

  it('returns null when neither home nor project anchor exists', async () => {
    const { watchSettingsDirectories } = await import(
      '../../src/server/claude-code-settings-check'
    )
    const fs = makeFs() // no files, no realpaths → existsSync returns false
    const handle = watchSettingsDirectories(fs, PROJECT, () => {}, HOME)
    expect(handle).toBeNull()
  })

  it('falls back to watching the anchor itself when .claude does not exist yet', async () => {
    const { watchSettingsDirectories } = await import(
      '../../src/server/claude-code-settings-check'
    )
    const watchers = new Map<string, WatchHandler>()
    // Existence: home and project exist, but their .claude
    // subdirectories do not. The fallback should watch the
    // anchors so a later .claude/ creation still triggers the
    // mutation handler.
    const fs = {
      ...makeFs({ watchers }),
      existsSync: (path: string) => path === HOME || path === PROJECT,
    } as unknown as FileAccessLayer
    let fired = 0
    const handle = watchSettingsDirectories(fs, PROJECT, () => {
      fired += 1
    }, HOME)
    expect(handle).not.toBeNull()
    expect(watchers.size).toBe(2)
    expect(Array.from(watchers.keys())).toEqual([HOME, PROJECT])
    // CodeX attempt 3 — only the `.claude` child should fire the
    // mutation callback; unrelated siblings must be filtered out so
    // the anchor watcher does not churn on every home/project
    // mutation.
    const homeHandler = watchers.get(HOME)
    const projectHandler = watchers.get(PROJECT)
    homeHandler?.({ type: 'addDir', path: `${HOME}/Downloads` }) // ignored
    projectHandler?.({ type: 'add', path: `${PROJECT}/README.md` }) // ignored
    expect(fired).toBe(0)
    homeHandler?.({ type: 'addDir', path: `${HOME}/.claude` })
    projectHandler?.({ type: 'addDir', path: `${PROJECT}/.claude` })
    expect(fired).toBe(2)
    handle?.close()
  })
})

describe('T-2-4: watchSettingsFile runtime mutation detection', () => {
  it('invokes the handler on file change events', () => {
    const watchers = new Map<string, WatchHandler>()
    const fs = makeFs({ watchers })
    let fired = 0
    const handle = watchSettingsFile(fs, '/home/user/.claude/settings.json', () => {
      fired += 1
    })
    expect(handle).not.toBeNull()
    const h = watchers.get('/home/user/.claude/settings.json')
    expect(h).toBeDefined()
    h?.({ type: 'change', path: '/home/user/.claude/settings.json' })
    h?.({ type: 'add', path: '/home/user/.claude/settings.json' })
    h?.({ type: 'unlink', path: '/home/user/.claude/settings.json' })
    h?.({ type: 'ready' })
    h?.({ type: 'error', error: new Error('x') })
    expect(fired).toBe(3) // change + add + unlink, not ready / error
    handle?.close()
  })

  it('returns null when watch throws', () => {
    const fs = {
      watch: () => {
        throw new Error('boom')
      },
    } as unknown as FileAccessLayer
    const handle = watchSettingsFile(fs, '/x', () => {})
    expect(handle).toBeNull()
  })

  it('does not crash when the mutation handler throws', () => {
    const watchers = new Map<string, WatchHandler>()
    const fs = makeFs({ watchers })
    const handle = watchSettingsFile(fs, '/p', () => {
      throw new Error('handler-bug')
    })
    expect(handle).not.toBeNull()
    expect(() =>
      watchers.get('/p')?.({ type: 'change', path: '/p' }),
    ).not.toThrow()
  })
})
