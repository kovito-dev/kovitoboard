#!/usr/bin/env node
/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Gate CI on dependency advisories that can actually be acted on.
 *
 * `npm audit --audit-level=high` on its own fails the build for every
 * high-severity advisory, including ones with no fixed release published. Such
 * an advisory cannot be resolved by a version bump or an `overrides` pin, so a
 * plain threshold check would block every pull request in the repository for as
 * long as upstream takes to ship a patch -- with no action available to unblock
 * it other than weakening the gate itself.
 *
 * This splits the report in two:
 *
 *   - Actionable (a fixed release exists): fails the build. Someone can raise
 *     the floor today, so the red check is a request they can satisfy.
 *   - Unactionable (`fixAvailable: false`): reported in full and loudly, but
 *     does not fail. There is no fix to apply, so blocking would only punish
 *     unrelated work.
 *
 * Advisories below the threshold are listed as a tail count so they stay
 * visible without gating, matching the project's "minimal maintenance, severe
 * vulnerabilities excepted" policy.
 */

import { execFileSync } from 'node:child_process'

const BLOCKING_SEVERITIES = new Set(['high', 'critical'])

/**
 * `npm audit` exits non-zero whenever it finds anything, so a non-zero exit is
 * the normal path rather than an error. The JSON report is still on stdout; a
 * genuine failure (no network, malformed lockfile) leaves stdout empty, which
 * is the case worth rethrowing.
 */
function readAuditReport() {
  try {
    return execFileSync('npm', ['audit', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    if (error.stdout) return error.stdout
    throw error
  }
}

/**
 * A `via` entry is either a package name (an indirect path to the real
 * advisory) or the advisory object itself. Only the latter carries a title and
 * a URL worth printing.
 */
function describeAdvisories(vulnerability) {
  return vulnerability.via
    .filter((entry) => typeof entry === 'object' && entry !== null)
    .map((entry) => `${entry.title ?? 'advisory'} (${entry.url ?? 'no url'})`)
}

/**
 * `fixAvailable` is `false`, `true`, or an object naming the release to move
 * to. The object form flags whether reaching it crosses a major boundary,
 * which changes how much work the fix is -- worth surfacing, but it is still a
 * fix, so it still gates.
 */
function describeFix(fixAvailable) {
  if (fixAvailable === false) return null
  if (fixAvailable === true) return 'a fixed release exists'
  const major = fixAvailable.isSemVerMajor ? ', crosses a major version' : ''
  return `fixed in ${fixAvailable.name} ${fixAvailable.version}${major}`
}

function printGroup(heading, entries) {
  console.log(`\n${heading}`)
  for (const entry of entries) {
    const fix = describeFix(entry.fixAvailable)
    console.log(`  - ${entry.name} (${entry.severity}) — ${fix ?? 'no fixed release published'}`)
    for (const advisory of describeAdvisories(entry)) {
      console.log(`      ${advisory}`)
    }
  }
}

const report = JSON.parse(readAuditReport())
const vulnerabilities = Object.values(report.vulnerabilities ?? {})

const severe = vulnerabilities.filter((entry) => BLOCKING_SEVERITIES.has(entry.severity))
const actionable = severe.filter((entry) => entry.fixAvailable !== false)
const unactionable = severe.filter((entry) => entry.fixAvailable === false)
const belowThreshold = vulnerabilities.length - severe.length

if (unactionable.length > 0) {
  printGroup(
    `${unactionable.length} high-severity advisory/advisories with no fixed release (reported, not blocking):`,
    unactionable,
  )
}

if (belowThreshold > 0) {
  console.log(`\n${belowThreshold} advisory/advisories below the high threshold (reported, not blocking).`)
}

if (actionable.length === 0) {
  console.log('\nNo actionable high-severity advisories. Dependency audit passed.')
  process.exit(0)
}

printGroup(
  `${actionable.length} actionable high-severity advisory/advisories — raise the floor in package.json:`,
  actionable,
)
console.log('\nRun `npm audit fix` for fixes inside the current ranges, or pin the')
console.log('patched version through `overrides` when the copy is transitive.')
process.exit(1)
