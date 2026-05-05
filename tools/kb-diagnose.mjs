#!/usr/bin/env node
/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * KovitoBoard diagnostic CLI (DEC-017 §7).
 *
 * Standalone Node script (does NOT require the KB server to be
 * running). Collects environment info, project state, and the tail of
 * the latest server log, then prints a Markdown report to stdout for
 * GitHub Issue attachment.
 *
 * Usage:
 *   npm run diagnose             # prints to stdout
 *   npm run diagnose > diag.md   # write to a file
 *
 * Each information source is wrapped in its own try/catch so a single
 * failure (e.g. claude binary missing) does not abort the whole
 * report. Stderr is reserved for warnings about acquisition
 * failures; the Markdown report itself goes to stdout only.
 *
 * Home-directory paths in log content are already masked by the KB
 * server-side logger (DEC-017 §8). This CLI does no additional
 * masking — sensitive content beyond the home directory may still
 * appear, and the report header advises a manual review.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import os from 'os'
import process from 'process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

/**
 * Resolve the project root the KB server would use. Mirrors the
 * environment override that kb-start.mjs / index.ts honor; falls
 * back to the current working directory.
 */
function resolveProjectRoot() {
  const env = process.env.KOVITOBOARD_PROJECT_ROOT
  if (env) return resolve(env)
  return process.cwd()
}

/** Read JSON safely. Returns null on any failure. */
function tryReadJson(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    process.stderr.write(`[kb-diagnose] warn: failed to read ${path}: ${err.message}\n`)
    return null
  }
}

/** Run an external command and return stdout, or null on failure. */
function tryExec(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 5000 })
    if (r.status !== 0) return null
    return (r.stdout || '').trim() || null
  } catch {
    return null
  }
}

/**
 * Locate the active KB log file under .kovitoboard/logs/.
 *
 * Priority order:
 *   1. `current.log` symlink (created by pino-roll v4 when symlink: true)
 *   2. The most recently modified `server.*.log` file
 *
 * Returns the absolute path or null.
 */
function findActiveLogFile(projectRoot) {
  const logsDir = join(projectRoot, '.kovitoboard', 'logs')
  if (!existsSync(logsDir)) return null

  const symlink = join(logsDir, 'current.log')
  if (existsSync(symlink)) return symlink

  let entries
  try {
    entries = readdirSync(logsDir).filter(
      (f) => f.startsWith('server.') && f.endsWith('.log'),
    )
  } catch {
    return null
  }
  if (entries.length === 0) return null

  // Pick the most-recently-modified file
  let latest = null
  let latestMtime = 0
  for (const f of entries) {
    const p = join(logsDir, f)
    try {
      const st = statSync(p)
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs
        latest = p
      }
    } catch {
      /* skip */
    }
  }
  return latest
}

/**
 * Read the last `n` lines of a text file. Best-effort: if the file
 * is large we still read it all (the file is bounded by daily
 * rotation + retention, so worst case ~500MB; still acceptable for a
 * diagnostic snapshot).
 */
function readTailLines(path, n) {
  try {
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    return lines.slice(-n)
  } catch (err) {
    process.stderr.write(`[kb-diagnose] warn: failed to read log: ${err.message}\n`)
    return null
  }
}

// --- Information acquisition ------------------------------------------------

const projectRoot = resolveProjectRoot()
const acquired = {
  total: 0,
  failed: 0,
}

function recordSource(value) {
  acquired.total += 1
  if (value === null || value === undefined || value === '') {
    acquired.failed += 1
  }
}

const pkg = tryReadJson(join(repoRoot, 'package.json'))
const kbVersion = pkg?.version ?? null
recordSource(kbVersion)

const nodeVersion = process.version
recordSource(nodeVersion)

const platform = `${os.platform()} ${os.arch()}`
recordSource(platform)

const claudeRaw = tryExec('claude', ['--version'])
recordSource(claudeRaw)
const claudeVersion = claudeRaw ?? '(not detected)'

const tmuxRaw = tryExec('tmux', ['-V'])
recordSource(tmuxRaw)
const tmuxVersion = tmuxRaw ?? '(not detected)'

const setting = tryReadJson(join(projectRoot, '.kovitoboard', 'setting.json'))
recordSource(setting)
const settingProjectPath = setting?.project?.path ?? null
const onboardingState = setting?.onboarding?.completedAt
  ? `completed at ${setting.onboarding.completedAt}`
  : setting?.onboarding
    ? 'in progress'
    : '(no setting.json yet)'

const activeLogPath = findActiveLogFile(projectRoot)
const logTail = activeLogPath ? readTailLines(activeLogPath, 100) : null
recordSource(activeLogPath)

// --- Output -----------------------------------------------------------------

const generated = new Date().toISOString()
const lines = []
lines.push('# KovitoBoard Diagnostic Report')
lines.push('')
lines.push(`**Generated:** ${generated}`)
lines.push('')
lines.push('## Environment')
lines.push('')
lines.push(`- KovitoBoard: ${kbVersion ?? '(unknown)'}`)
lines.push(`- Node.js: ${nodeVersion}`)
lines.push(`- OS: ${platform}`)
lines.push(`- Claude Code: ${claudeVersion}`)
lines.push(`- tmux: ${tmuxVersion}`)
lines.push('')
lines.push('## Project')
lines.push('')
lines.push(`- Project root (resolved): ${projectRoot}`)
if (settingProjectPath) {
  lines.push(`- setting.json project.path: ${settingProjectPath}`)
}
lines.push(`- Onboarding: ${onboardingState}`)
lines.push('')
lines.push('## Recent server log')
lines.push('')
if (!activeLogPath) {
  lines.push(`No log file found under ${projectRoot}/.kovitoboard/logs/. Run KB at least once to create one.`)
} else {
  lines.push(`Source: \`${activeLogPath}\``)
  lines.push(`Lines: last ${(logTail || []).length} of file`)
  lines.push('')
  lines.push('```json')
  if (logTail && logTail.length > 0) {
    for (const l of logTail) lines.push(l)
  } else {
    lines.push('(empty)')
  }
  lines.push('```')
}
lines.push('')
lines.push('## Notes')
lines.push('')
lines.push('Please review the log content above before posting to GitHub Issues.')
lines.push('Home directory paths are masked as `~`, but other potentially sensitive')
lines.push('information (e.g., file paths, hostnames in custom data) may remain.')
lines.push('')

process.stdout.write(lines.join('\n'))

// Exit code 1 only when every information source failed.
if (acquired.total > 0 && acquired.failed >= acquired.total) {
  process.exit(1)
}
