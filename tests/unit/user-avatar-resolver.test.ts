/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Q11 / SM-4: avatar-resolver helpers for the operator's own avatar.
 *
 * Covers:
 *  - Path resolution priority among supported extensions
 *  - Relative-name shape (used by /api/config to drive <AgentAvatar>)
 *  - Idempotent delete when the directory or file is missing
 *  - Namespace isolation from the agent custom directory (so a
 *    user-uploaded image cannot collide with an agent named "user"/
 *    "_user"/etc.)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  deleteUserAvatar,
  getCustomDir,
  getUserAvatarDir,
  resolveUserAvatarPath,
  resolveUserAvatarRelativeName,
  USER_AVATAR_FILE_STEM,
} from '../../src/server/services/avatar-resolver'
import type { FileAccessLayer } from '../../src/server/fs-layer'

interface MockFs extends FileAccessLayer {
  files: Set<string>
  dirs: Set<string>
}

function createMockFs(): MockFs {
  const files = new Set<string>()
  const dirs = new Set<string>()
  const mock = {
    files,
    dirs,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: () => '',
    readBytesSync: () => Buffer.alloc(0),
    writeFileSync: (p: string) => {
      files.add(p)
    },
    unlinkSync: (p: string) => {
      files.delete(p)
    },
    rmSync: () => {},
    statSync: () => ({ size: 0, mtime: new Date(), mtimeMs: 0 }),
    readdirSync: () => [],
    mkdirSync: (p: string) => {
      dirs.add(p)
    },
    symlinkSync: () => {},
    watch: () => ({ close: () => {} }),
  } as unknown as MockFs
  return mock
}

/**
 * The avatar-resolver computes the base directory from
 * import.meta.url, so the mock has to claim that the dev path exists
 * (otherwise the resolver falls back to the build path which also
 * does not match anything in the mock). We add the dev dir to the
 * dirs set whenever a test wants the path under it to resolve.
 */
function ensureBaseDir(fs: MockFs) {
  const userDir = getUserAvatarDir(fs)
  // Walk up two parents — `getAvatarsBaseDir` checks both candidates
  // and returns the first that exists. By marking the user dir as
  // existing, the avatars/<sub> base resolves through the dev branch.
  fs.dirs.add(userDir)
}

describe('user avatar resolver (Q11 / SM-4)', () => {
  let fs: MockFs

  beforeEach(() => {
    fs = createMockFs()
  })

  describe('resolveUserAvatarPath', () => {
    it('returns null when the user avatar dir does not exist', () => {
      expect(resolveUserAvatarPath(fs)).toBeNull()
    })

    it('returns null when the dir exists but no avatar file is present', () => {
      ensureBaseDir(fs)
      expect(resolveUserAvatarPath(fs)).toBeNull()
    })

    it('returns the absolute path when avatar.png exists', () => {
      ensureBaseDir(fs)
      const userDir = getUserAvatarDir(fs)
      const filePath = `${userDir}/${USER_AVATAR_FILE_STEM}.png`
      fs.files.add(filePath)
      expect(resolveUserAvatarPath(fs)).toBe(filePath)
    })

    it('finds avatar.svg when the upload is an SVG', () => {
      ensureBaseDir(fs)
      const userDir = getUserAvatarDir(fs)
      const filePath = `${userDir}/${USER_AVATAR_FILE_STEM}.svg`
      fs.files.add(filePath)
      expect(resolveUserAvatarPath(fs)).toBe(filePath)
    })
  })

  describe('resolveUserAvatarRelativeName', () => {
    it('returns null when nothing has been uploaded', () => {
      expect(resolveUserAvatarRelativeName(fs)).toBeNull()
    })

    it('returns user/avatar.<ext> for a populated dir', () => {
      ensureBaseDir(fs)
      const userDir = getUserAvatarDir(fs)
      fs.files.add(`${userDir}/${USER_AVATAR_FILE_STEM}.webp`)
      expect(resolveUserAvatarRelativeName(fs)).toBe('user/avatar.webp')
    })
  })

  describe('deleteUserAvatar', () => {
    it('returns false when the dir does not exist', () => {
      expect(deleteUserAvatar(fs)).toBe(false)
    })

    it('removes every supported variant in one pass', () => {
      ensureBaseDir(fs)
      const userDir = getUserAvatarDir(fs)
      fs.files.add(`${userDir}/${USER_AVATAR_FILE_STEM}.png`)
      fs.files.add(`${userDir}/${USER_AVATAR_FILE_STEM}.svg`)
      expect(deleteUserAvatar(fs)).toBe(true)
      expect(fs.files.has(`${userDir}/${USER_AVATAR_FILE_STEM}.png`)).toBe(false)
      expect(fs.files.has(`${userDir}/${USER_AVATAR_FILE_STEM}.svg`)).toBe(false)
    })

    it('returns false when the dir exists but no avatar file is present', () => {
      ensureBaseDir(fs)
      expect(deleteUserAvatar(fs)).toBe(false)
    })
  })

  describe('namespace isolation from custom agents', () => {
    /**
     * Architect §6.9 explicitly notes the user avatar must not share
     * a namespace with agent custom uploads. This test guards
     * against an accidental refactor that points the user resolver at
     * the agent custom dir.
     */
    it('user dir is not the same as the agent custom dir', () => {
      const customDir = getCustomDir(fs)
      const userDir = getUserAvatarDir(fs)
      expect(customDir).not.toBe(userDir)
      expect(userDir.endsWith('/user')).toBe(true)
      expect(customDir.endsWith('/custom')).toBe(true)
    })

    it('user-avatar lookup ignores files in the agent custom dir', () => {
      // An agent named "avatar" should NOT be picked up by the user
      // resolver even if it occupies `<custom>/avatar.png`.
      const customDir = getCustomDir(fs)
      fs.dirs.add(customDir)
      fs.files.add(`${customDir}/${USER_AVATAR_FILE_STEM}.png`)
      // The user dir is still empty — resolver must return null.
      expect(resolveUserAvatarPath(fs)).toBeNull()
      expect(resolveUserAvatarRelativeName(fs)).toBeNull()
    })
  })
})
