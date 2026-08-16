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

import { spawnSync } from 'node:child_process'

const BLOCKING_SEVERITIES = new Set(['high', 'critical'])

function fail(message) {
  console.error(`\nDependency audit did not complete: ${message}`)
  console.error('Treating this as a failure -- a gate that cannot read the')
  console.error('advisory list must not report the dependencies as clean.')
  process.exit(1)
}

/**
 * `npm audit` exits non-zero whenever it finds anything, so a non-zero exit is
 * the normal path rather than an error signal, and the exit code alone cannot
 * separate "found advisories" from "could not look".
 *
 * Operational failures are JSON too: an unreachable registry prints an object
 * carrying `error` and no `vulnerabilities`. Parsing that as a report would
 * read as zero advisories and pass the gate, so every unexpected shape has to
 * fail closed instead of falling through to the success path.
 */
function readAuditReport() {
  const result = spawnSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (result.error) fail(`npm could not be run (${result.error.message})`)
  if (result.signal) fail(`npm was terminated by ${result.signal}`)
  if (!result.stdout?.trim()) {
    fail(`npm produced no report (exit ${result.status})\n${result.stderr ?? ''}`)
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    fail(`npm produced output that is not JSON (exit ${result.status})`)
  }

  if (report.error) {
    const detail = report.error.summary ?? report.error.code ?? JSON.stringify(report.error)
    fail(`npm reported an error instead of a report (${detail})`)
  }
  // `vulnerabilities` and `metadata` are both present on every successful
  // report, including a clean one, where `vulnerabilities` is an empty object.
  if (typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    fail('the report has no `vulnerabilities` section')
  }
  if (typeof report.metadata !== 'object' || report.metadata === null) {
    fail('the report has no `metadata` section')
  }

  return report
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

const report = readAuditReport()
const vulnerabilities = Object.values(report.vulnerabilities)

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
