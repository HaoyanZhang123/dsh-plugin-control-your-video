/**
 * Shared setup for C15's integration tests: isolated workspace, a finalized project, tools.
 *
 * Every test gets its own temp root, so "清理测试不得触碰真实用户项目" is structural: the tests
 * cannot reach the user's data directory because nothing here knows where it is.
 *
 * @module tests/integration/delivery-test-helpers
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Clock } from '../base/index.js'
import {
  createDecisionLog,
  createProject,
  createVersionStore,
} from '../core/project/index.js'
import { normalizePlan, resolveToolchain } from '../media/index.js'
import { writePlanSnapshot } from '../editing/index.js'
import { buildDeliveryUnitPlan } from '../delivery/fixtures/unit.js'

/**
 * Create an isolated workspace and register cleanup.
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @returns {string} absolute root
 */
export function makeWorkspace(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `c15-${label}-`))
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

/** A fixed clock so two runs of the suite produce identical timestamps in records. */
export function fixedClock() {
  return new Clock({ now: () => Date.parse('2026-11-10T00:00:00.000Z') })
}

/**
 * A font file the FFmpeg adapter can really use. Returns `null` when this machine has none, so a
 * test that needs pixels can skip instead of pretending.
 * @returns {string|null}
 */
export function availableFont() {
  const candidates = [
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', 'arial.ttf'),
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', 'seguisb.ttf'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

/**
 * Resolve the external toolchain, or `null` when it is not available (the caller then skips).
 * @returns {any|null}
 */
export function availableToolchain() {
  try {
    return resolveToolchain({ allowPathLookup: true })
  } catch {
    return null
  }
}

/**
 * Create one project with a normalized fixture plan, a user confirmation and a final version.
 *
 * @param {object} input
 * @param {string} input.root projects root
 * @param {string} input.fontFile absolute font path
 * @param {any} [input.clock]
 * @param {string} [input.title]
 * @returns {{ paths: any, project: any, decisions: any, versions: any, plan: any, snapshot: any,
 *   finalVersion: any, confirmation: any }}
 */
export function createFinalizedProject(input) {
  const clock = input.clock ?? fixedClock()
  const created = createProject({ projectsRoot: input.root, title: input.title ?? 'C15 测试项目', origin: 'blank', clock })
  const paths = created.paths
  const decisions = createDecisionLog({ paths, clock })
  const versions = createVersionStore({ paths, clock })
  const plan = normalizePlan(
    buildDeliveryUnitPlan({ fontFile: input.fontFile, projectId: created.project.projectId }),
    { now: () => clock.iso() },
  )
  const snapshot = writePlanSnapshot({ paths, ownerId: 'c15-test', plan, clock })
  versions.ensureCurrent({ actor: 'system', label: '测试当前版本' })
  versions.updateCurrentContent({ content: { planRef: snapshot.planRef, planVersion: plan.planVersion } })
  const current = versions.getCurrent()
  const confirmation = decisions.recordConfirmation({
    actor: 'user',
    objectId: `movie:${created.project.projectId}`,
    aspect: 'final-cut',
    scope: 'whole',
    versionId: current.versionId,
    state: 'confirmed',
    humanResponse: '测试里模拟用户验收；真实使用时这句话必须来自用户本人',
  })
  const finalVersion = versions.finalize({
    actor: 'user',
    confirmationRef: confirmation.confirmationId,
    label: '测试定稿',
  })
  return { paths, project: created.project, decisions, versions, plan, snapshot, finalVersion, confirmation }
}
