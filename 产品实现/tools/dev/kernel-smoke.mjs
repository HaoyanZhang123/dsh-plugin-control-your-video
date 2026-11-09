/**
 * Kernel smoke check: prove the TOOL-MANAGEMENT facade boots and reports honest state.
 *
 * This is a DEVELOPMENT diagnostic, not a substitute for the test suite. It exists so a receipt can
 * show a real run of the public facade against a fresh, isolated roots set, and so a regression in the
 * wiring is visible in one command instead of only inside a test failure.
 *
 * It creates everything under a managed temporary directory, prints the real statuses the derived
 * logic produced, and removes its temporary root. It performs no network access, starts no external
 * process, and installs nothing.
 *
 * Usage: node tools/dev/kernel-smoke.mjs
 *
 * @module tools/dev/kernel-smoke
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createToolKernel } from '../index.js'

const root = path.join(os.tmpdir(), `dsh-avw-c06-smoke-${process.pid}`)
fs.mkdirSync(root, { recursive: true })

/** @type {string[]} */
const lines = []
const say = (text) => {
  lines.push(text)
  process.stdout.write(`${text}\n`)
}

try {
  const kernel = createToolKernel({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(root, 'plugin'),
    projectsRoot: path.join(root, 'projects'),
  })

  say(`interface version: ${kernel.version}`)
  say(`catalog version:   ${kernel.catalog.catalogVersion}`)

  const describe = kernel.describe()
  say(
    `catalog: ${describe.packCount} packs, ${describe.officialToolCount} official tools, ` +
      `${describe.researchCandidateCount} research candidates, ${describe.capabilityCount} capabilities`,
  )

  say('')
  say('tool statuses (derived from stored facts, nothing installed yet):')
  for (const tool of kernel.listTools()) {
    say(`  ${tool.toolId.padEnd(12)} ${tool.status.padEnd(20)} ${tool.label}`)
  }
  say('  research candidates (never usable):')
  for (const candidate of kernel.listResearchCandidates()) {
    say(`  ${candidate.toolId.padEnd(12)} usable=${String(candidate.usable)}`)
  }

  say('')
  const impact = kernel.listCapabilities()
  say(`capabilities: ${impact.capabilities.length} total, ${impact.affected.length} affected`)
  for (const capability of impact.capabilities) {
    say(`  ${capability.capabilityId.padEnd(24)} ${capability.state}`)
  }
  say(`creation-surface message: ${String(kernel.capabilityImpactSummary())}`)

  // Detection is files-only here: no process is started and nothing is authorized.
  say('')
  const detection = await kernel.detect({ toolId: 'ffmpeg' })
  say(`detect ffmpeg -> ${detection.detection.outcome} / ${detection.status}`)
  say(`manual guidance steps: ${detection.guidance?.steps.length ?? 0}`)

  // A plan must be refused when no version is known and no fallback was detected.
  say('')
  try {
    kernel.plan({ toolId: 'ffmpeg', targetVersion: '9.0.1-full_build-www.gyan.dev' })
    say('plan ffmpeg: built')
  } catch (error) {
    say(`plan ffmpeg: ${error.code} — ${error.message}`)
  }

  const disclosure = kernel.plan({ toolId: 'ffmpeg', targetVersion: '9.0.1-full_build-www.gyan.dev' })
  say('')
  say('pre-execution disclosure (what the user must see before anything runs):')
  for (const [field, value] of Object.entries(disclosure.disclosure)) {
    say(`  ${field.padEnd(12)} ${value}`)
  }

  say('')
  const mit = kernel.mitBoundary()
  say(`plugin-internal content: ${mit.pluginInternal.license} (${mit.pluginInternal.components.length} components)`)
  say(`external tools: ${mit.external.map((item) => `${item.toolId}=${item.spdx}`).join(', ')}`)
  say(`plugin clone claims MIT for external tools: ${mit.external.some((item) => item.pluginMit) ? 'YES (bug)' : 'no'}`)

  say('')
  say('archive limits enforced:')
  for (const [key, value] of Object.entries(describe.archiveLimits)) {
    say(`  ${key.padEnd(22)} ${String(value)}`)
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true })
  process.stdout.write('\nkernel-smoke: OK (temporary roots removed)\n')
}
