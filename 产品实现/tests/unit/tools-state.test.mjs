/**
 * Unit tests for status derivation — the heart of "状态真实性" (C06 §4.2).
 *
 * These tests exist because the status a user sees must FOLLOW from evidence, not be asserted by a
 * caller. Each case pins one rule: an unverified install is not available, a verification of another
 * build does not count, a test double never becomes a real-tool claim, and an unknown state is never
 * silently retried.
 *
 * @module tests/unit/tools-state.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveToolStatus, describeState, pinBlockingUpgrade } from '../../tools/state.js'
import { requireTool } from '../../tools/catalog.js'
import { createDefaultCatalog } from '../../tools/packs.js'
import {
  DetectionOutcome,
  ToolStatus,
  VerificationBasis,
  VerificationStatus,
  userStatusLabel,
  simplifiedUserState,
} from '../../tools/schema.js'

const catalog = createDefaultCatalog()
const ffmpeg = requireTool(catalog, 'ffmpeg')
const editly = requireTool(catalog, 'editly')

/** A state document as the store would have it, with overrides. */
function state(overrides = {}) {
  return {
    toolId: 'ffmpeg',
    detection: null,
    detectionInFlight: false,
    installs: [],
    currentBuild: null,
    previousBuild: null,
    verification: null,
    pins: [],
    lastTaskId: null,
    unknownReason: null,
    ...overrides,
  }
}

/** A passed, real-tool verification for the given build. */
function passedVerification(version, overrides = {}) {
  return {
    status: VerificationStatus.PASSED,
    basis: VerificationBasis.REAL_TOOL,
    version,
    schemaFingerprint: 'fp-1',
    at: '2026-11-08T00:00:00.000Z',
    checks: [{ id: 'version', ok: true, detail: 'ok' }],
    reason: null,
    ...overrides,
  }
}

const BUILD = '9.0.1-full_build-www.gyan.dev'

test('state: nothing detected and nothing installed reads not-installed, with the reason stated', () => {
  const derived = deriveToolStatus({ tool: ffmpeg, state: state() })
  assert.equal(derived.status, ToolStatus.NOT_INSTALLED)
  assert.match(derived.reason, /尚未检测|没有已安装记录/)
})

test('state: detection in flight reads checking and never available, whatever the previous answer was', () => {
  const installedAndVerified = state({
    currentBuild: { version: BUILD, buildSegment: BUILD },
    verification: passedVerification(BUILD),
    detectionInFlight: true,
  })
  const derived = deriveToolStatus({ tool: ffmpeg, state: installedAndVerified })
  assert.equal(derived.status, ToolStatus.CHECKING)
  assert.equal(derived.status === ToolStatus.AVAILABLE, false)
})

test('state: an inconclusive detection is unknown, NOT not-installed', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({
      detection: {
        outcome: DetectionOutcome.INCONCLUSIVE,
        version: null,
        mode: 'files-only',
        at: '',
        location: null,
        reason: '读不了清单',
      },
    }),
  })
  assert.equal(derived.status, ToolStatus.UNKNOWN)
  assert.match(derived.reason, /读不了清单/)
})

test('state: a detection error is unknown and carries the real reason', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({
      detection: { outcome: DetectionOutcome.ERROR, version: null, mode: 'version-probe', at: '', location: null, reason: 'xc' },
      unknownReason: '探针失败（EACCES）',
    }),
  })
  assert.equal(derived.status, ToolStatus.UNKNOWN)
  assert.match(derived.reason, /EACCES/)
})

test('state: installed but never verified is installed-unverified, never available', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({ currentBuild: { version: BUILD, buildSegment: BUILD } }),
  })
  assert.equal(derived.status, ToolStatus.INSTALLED_UNVERIFIED)
  assert.equal(userStatusLabel(derived.status).label, '已安装未验证')
  assert.equal(userStatusLabel(derived.status).usable, false)
})

test('state: installed + passed real verification + in range reads available', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({
      currentBuild: { version: BUILD, buildSegment: BUILD },
      verification: passedVerification(BUILD),
    }),
  })
  assert.equal(derived.status, ToolStatus.AVAILABLE)
  assert.equal(userStatusLabel(derived.status).label, '可用')
  assert.equal(userStatusLabel(derived.status).usable, true)
})

test('state: a verification of a DIFFERENT build does not make the current build available', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({
      currentBuild: { version: BUILD, buildSegment: BUILD },
      verification: passedVerification('9.0.0-other_build'),
    }),
  })
  assert.equal(derived.status, ToolStatus.INSTALLED_UNVERIFIED)
  assert.match(derived.reason, /不是当前构建/)
})

test('state: a test-double verification never yields available, because it proves the logic only', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({
      currentBuild: { version: BUILD, buildSegment: BUILD },
      verification: passedVerification(BUILD, { basis: VerificationBasis.TEST_DOUBLE }),
    }),
  })
  assert.equal(derived.status, ToolStatus.INSTALLED_UNVERIFIED)
  assert.match(derived.reason, /测试替身/)
})

test('state: a declared-only verification leaves it unverified rather than badged as checked', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({
      currentBuild: { version: BUILD, buildSegment: BUILD },
      verification: passedVerification(BUILD, { basis: VerificationBasis.DECLARED_ONLY }),
    }),
  })
  assert.equal(derived.status, ToolStatus.INSTALLED_UNVERIFIED)
})

test('state: a failed verification is verification-failed, which is not the same as never verified', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({
      currentBuild: { version: BUILD, buildSegment: BUILD },
      verification: passedVerification(BUILD, { status: VerificationStatus.FAILED, reason: '缺少 ffprobe' }),
    }),
  })
  assert.equal(derived.status, ToolStatus.VERIFICATION_FAILED)
  assert.equal(userStatusLabel(derived.status).label, '验证失败')
  assert.match(derived.reason, /ffprobe/)
})

test('state: an inconclusive verification keeps it unverified instead of declaring the tool broken', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({
      currentBuild: { version: BUILD, buildSegment: BUILD },
      verification: passedVerification(BUILD, {
        status: VerificationStatus.INCONCLUSIVE,
        basis: VerificationBasis.DECLARED_ONLY,
        reason: '需要授权运行工具',
      }),
    }),
  })
  assert.equal(derived.status, ToolStatus.INSTALLED_UNVERIFIED)
  assert.notEqual(derived.status, ToolStatus.VERIFICATION_FAILED)
})

test('state: a version below the supported minimum is needs-update; above the maximum is incompatible', () => {
  const below = deriveToolStatus({
    tool: ffmpeg,
    state: state({ currentBuild: { version: '8.1.0', buildSegment: '8.1.0' }, verification: passedVerification('8.1.0') }),
  })
  assert.equal(below.status, ToolStatus.NEEDS_UPDATE)
  assert.match(below.reason, /最低支持版本/)

  const above = deriveToolStatus({
    tool: ffmpeg,
    state: state({ currentBuild: { version: '10.0.0', buildSegment: '10.0.0' }, verification: passedVerification('10.0.0') }),
  })
  assert.equal(above.status, ToolStatus.INCOMPATIBLE)
  assert.match(above.reason, /最高支持版本/)

  // Both share the ONE user label the UI blueprint fixes, so a surface cannot invent a sixth state.
  assert.equal(simplifiedUserState(below.status), 'needs-update-or-incompatible')
  assert.equal(simplifiedUserState(above.status), simplifiedUserState(below.status))
})

test('state: an out-of-range version is not rescued by a passed verification', () => {
  const derived = deriveToolStatus({
    tool: ffmpeg,
    state: state({ currentBuild: { version: '8.1.0', buildSegment: '8.1.0' }, verification: passedVerification('8.1.0') }),
  })
  assert.equal(derived.status, ToolStatus.NEEDS_UPDATE)
  assert.notEqual(derived.status, ToolStatus.AVAILABLE)
})

test('state: a changed schema fingerprint invalidates a previous verification', () => {
  const current = state({
    currentBuild: { version: BUILD, buildSegment: BUILD },
    verification: passedVerification(BUILD),
  })
  const unchanged = deriveToolStatus({ tool: ffmpeg, state: current, expectSchemaFingerprint: 'fp-1' })
  assert.equal(unchanged.status, ToolStatus.AVAILABLE)

  const drifted = deriveToolStatus({ tool: ffmpeg, state: current, expectSchemaFingerprint: 'fp-2' })
  assert.equal(drifted.status, ToolStatus.INSTALLED_UNVERIFIED)
  assert.match(drifted.reason, /schema|重新验证/)
})

test('state: a research candidate is never usable even when installed and verified', () => {
  const derived = deriveToolStatus({
    tool: editly,
    state: state({
      toolId: 'editly',
      currentBuild: { version: '0.5.0', buildSegment: '0.5.0' },
      verification: passedVerification('0.5.0'),
    }),
  })
  assert.equal(derived.status, ToolStatus.RESEARCH_CANDIDATE)
  assert.equal(userStatusLabel(derived.status).usable, false)
  assert.match(userStatusLabel(derived.status).label, /不可用于制作/)
})

test('state: describeState never leaks internal hashes and does not claim verification it lacks', () => {
  const described = describeState(
    state({ currentBuild: { version: BUILD, buildSegment: BUILD }, verification: passedVerification(BUILD) }),
  )
  assert.equal(described.installedVersion, BUILD)
  assert.equal(described.verified, true)
  assert.equal(described.verificationBasis, 'real-tool')
  assert.equal(JSON.stringify(described).includes('checks'), false)
})

test('state: a project pin on another build blocks an upgrade; a pin on the same build does not', () => {
  const pinned = state({ pins: [{ projectId: 'project-abc', version: '9.0.0' }] })
  assert.equal(pinBlockingUpgrade(pinned, BUILD).blocked, true)
  assert.equal(pinBlockingUpgrade(pinned, '9.0.0').blocked, false)
  assert.equal(pinBlockingUpgrade(state(), BUILD).blocked, false)
})
