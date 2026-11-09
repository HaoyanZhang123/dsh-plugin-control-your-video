/**
 * Unit tests for tool pins and the responsibility boundary of CR-6 (user decision, 2026-11-08).
 *
 * The six decisions and where each is proven here:
 *
 * 1. C10 owns project version facts and emits the change event — out of scope for C06, so nothing here
 *    reads or writes project state;
 * 2. C06 owns saving, validating and the history of pins — every test below;
 * 3. C13 owns the sync: it listens to C10 and calls `advancePin` — the `advance*` tests model exactly that;
 * 4. no silent overwrite; an old project version keeps pointing at its own pin, and a new pin proves
 *    nothing about tool availability — `bind`/`advance`/`rechoose` + the `toolAvailable` assertion;
 * 5. open/resume must re-check rather than rely only on events — the `recheck` tests;
 * 6. C06 must not advance a project version before C13 syncs — the "C06 never invents a version" tests.
 *
 * @module tests/unit/tools-pins.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PinCheck,
  PinState,
  SupersedeReason,
  advancePin,
  assertProjectId,
  assertProjectVersion,
  bindPin,
  findPin,
  normalizePin,
  pinHistory,
  pinsForProject,
  recheckPin,
  rechooseBuild,
} from '../../tools/pins.js'

const T1 = '2026-11-08T01:00:00.000Z'
const T2 = '2026-11-08T02:00:00.000Z'
const T3 = '2026-11-08T03:00:00.000Z'

/** Bind the first pin for a project version. */
function bind(pins, projectVersion, version, at = T1) {
  return bindPin(pins, { projectId: 'project-abc', projectVersion, version, at }).pins
}

test('pins: the first pin is active and carries only a reference plus bookkeeping', () => {
  const { pins, pin, idempotent } = bindPin([], {
    projectId: 'project-abc',
    projectVersion: 'v-1',
    version: '1.0.0',
    at: T1,
  })
  assert.equal(pins.length, 1)
  assert.equal(idempotent, false)
  assert.equal(pin.state, PinState.ACTIVE)
  assert.equal(pin.projectId, 'project-abc')
  assert.equal(pin.projectVersion, 'v-1')
  assert.equal(pin.version, '1.0.0')
  assert.equal(pin.supersedes, null)
  assert.equal(pin.supersededBy, null)
})

test('pins: binding the same association twice is idempotent, so a retried sync cannot duplicate', () => {
  const once = bind([], 'v-1', '1.0.0')
  const twice = bindPin(once, { projectId: 'project-abc', projectVersion: 'v-1', version: '1.0.0', at: T2 })
  assert.equal(twice.idempotent, true)
  assert.equal(twice.pins.length, 1)
})

test('pins: binding a DIFFERENT build to an existing version is refused, never silently overwritten', () => {
  const pins = bind([], 'v-1', '1.0.0')
  assert.throws(
    () => bindPin(pins, { projectId: 'project-abc', projectVersion: 'v-1', version: '2.0.0', at: T2 }),
    (error) => {
      assert.equal(error.code, 'CONFLICT')
      assert.equal(error.details.existingVersion, '1.0.0')
      assert.equal(error.details.requestedVersion, '2.0.0')
      return true
    },
  )
  // The original record is untouched.
  assert.equal(findPin(pins, 'project-abc', 'v-1').version, '1.0.0')
})

test('pins: advancing supersedes the old pin but keeps it, so the old version still resolves', () => {
  const pins = bind([], 'v-1', '1.0.0')
  const advanced = advancePin(pins, {
    projectId: 'project-abc',
    fromProjectVersion: 'v-1',
    toProjectVersion: 'v-2',
    version: '1.5.0',
    at: T2,
  })
  assert.equal(advanced.idempotent, false)
  assert.equal(advanced.pin.projectVersion, 'v-2')
  assert.equal(advanced.pin.version, '1.5.0')
  assert.equal(advanced.superseded.state, PinState.SUPERSEDED)
  assert.equal(advanced.superseded.supersededBy, advanced.pin.pinId)
  assert.equal(advanced.superseded.supersedeReason, SupersedeReason.PROJECT_VERSION_CHANGED)

  // BOTH answers still exist: this is the CR-6 item 4 requirement.
  const old = findPin(advanced.pins, 'project-abc', 'v-1')
  assert.notEqual(old, null)
  assert.equal(old.version, '1.0.0')
  assert.equal(old.state, PinState.SUPERSEDED)
  assert.equal(findPin(advanced.pins, 'project-abc', 'v-2').version, '1.5.0')
})

test('pins: advancing without the predecessor is refused instead of guessed', () => {
  assert.throws(
    () =>
      advancePin([], {
        projectId: 'project-abc',
        fromProjectVersion: 'v-1',
        toProjectVersion: 'v-2',
        version: '1.5.0',
        at: T2,
      }),
    (error) => {
      assert.equal(error.code, 'NOT_FOUND')
      assert.match(error.message, /拒绝按猜测推进/)
      return true
    },
  )
})

test('pins: advancing to the same project version is refused, because that is a re-choice not a move', () => {
  const pins = bind([], 'v-1', '1.0.0')
  assert.throws(
    () =>
      advancePin(pins, {
        projectId: 'project-abc',
        fromProjectVersion: 'v-1',
        toProjectVersion: 'v-1',
        version: '1.5.0',
        at: T2,
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('pins: advancing onto a version that already holds another build is refused', () => {
  let pins = bind([], 'v-1', '1.0.0')
  pins = bindPin(pins, { projectId: 'project-abc', projectVersion: 'v-2', version: '2.0.0', at: T2 }).pins
  assert.throws(
    () =>
      advancePin(pins, {
        projectId: 'project-abc',
        fromProjectVersion: 'v-1',
        toProjectVersion: 'v-2',
        version: '1.5.0',
        at: T3,
      }),
    (error) => error.code === 'CONFLICT',
  )
})

test('pins: re-choosing a build for one version keeps the old record and requires a reason', () => {
  const pins = bind([], 'v-1', '1.0.0')
  assert.throws(
    () => rechooseBuild(pins, { projectId: 'project-abc', projectVersion: 'v-1', version: '1.5.0', at: T2 }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  const recho = rechooseBuild(pins, {
    projectId: 'project-abc',
    projectVersion: 'v-1',
    version: '1.5.0',
    at: T2,
    note: '用户选择改用 1.5.0 重新制作这一版',
  })
  assert.equal(recho.pin.version, '1.5.0')
  assert.equal(recho.superseded.version, '1.0.0')
  assert.equal(recho.superseded.supersedeReason, SupersedeReason.USER_RECHOSE_BUILD)
  // The old association is still on record.
  const history = pinHistory(recho.pins, 'project-abc')
  assert.equal(history.length, 2)
  assert.equal(history[0].version, '1.0.0')
})

test('pins: recheck reports CURRENT when the pin matches the project version the project is at', () => {
  const pins = bind([], 'v-2', '1.5.0')
  const check = recheckPin(pins, { projectId: 'project-abc', currentProjectVersion: 'v-2' })
  assert.equal(check.check, PinCheck.CURRENT)
  assert.equal(check.pin.version, '1.5.0')
  // A pin is a statement about which build was used, never about whether it still works.
  assert.equal(check.toolAvailable, null)
})

test('pins: recheck reports STALE when C13 has not synced the new version yet, and does not repair it', () => {
  const pins = bind([], 'v-1', '1.0.0')
  const before = JSON.stringify(pins)
  const check = recheckPin(pins, { projectId: 'project-abc', currentProjectVersion: 'v-2' })
  assert.equal(check.check, PinCheck.STALE)
  assert.equal(check.pin, null)
  assert.deepEqual(check.staleVersions, ['v-1'])
  assert.match(check.note, /等待 C13 同步/)
  assert.match(check.note, /不自行推进 projectVersion/)
  // The check is read-only: the pins are byte-identical afterwards.
  assert.equal(JSON.stringify(pins), before)
})

test('pins: recheck reports MISSING when nothing was ever pinned', () => {
  const check = recheckPin([], { projectId: 'project-abc', currentProjectVersion: 'v-1' })
  assert.equal(check.check, PinCheck.MISSING)
  assert.equal(check.pin, null)
  assert.equal(check.toolAvailable, null)
})

test('pins: recheck reports AHEAD only when the caller supplies an ordering, never by guessing', () => {
  const pins = bind([], 'v-5', '1.0.0')
  // Without a comparator C06 cannot rank opaque version references, so it must not claim AHEAD.
  assert.equal(recheckPin(pins, { projectId: 'project-abc', currentProjectVersion: 'v-2' }).check, PinCheck.STALE)
  // With one, it can say the sync order looks wrong.
  const ahead = recheckPin(pins, {
    projectId: 'project-abc',
    currentProjectVersion: 'v-2',
    isVersionNewer: () => true,
  })
  assert.equal(ahead.check, PinCheck.AHEAD)
  assert.match(ahead.note, /同步顺序可疑/)
})

test('pins: a superseded pin never hides the answer for its own version', () => {
  let pins = bind([], 'v-1', '1.0.0')
  pins = advancePin(pins, {
    projectId: 'project-abc',
    fromProjectVersion: 'v-1',
    toProjectVersion: 'v-2',
    version: '1.5.0',
    at: T2,
  }).pins
  pins = advancePin(pins, {
    projectId: 'project-abc',
    fromProjectVersion: 'v-2',
    toProjectVersion: 'v-3',
    version: '2.0.0',
    at: T3,
  }).pins

  // Three versions, three answers, oldest preserved.
  assert.equal(findPin(pins, 'project-abc', 'v-1').version, '1.0.0')
  assert.equal(findPin(pins, 'project-abc', 'v-2').version, '1.5.0')
  assert.equal(findPin(pins, 'project-abc', 'v-3').version, '2.0.0')
  assert.equal(pinHistory(pins, 'project-abc').length, 3)
})

test('pins: pins of different projects never mix', () => {
  let pins = bind([], 'v-1', '1.0.0')
  pins = bindPin(pins, { projectId: 'project-xyz', projectVersion: 'v-1', version: '2.0.0', at: T2 }).pins
  assert.equal(pinsForProject(pins, 'project-abc').length, 1)
  assert.equal(pinsForProject(pins, 'project-xyz').length, 1)
  assert.equal(findPin(pins, 'project-abc', 'v-1').version, '1.0.0')
  assert.equal(findPin(pins, 'project-xyz', 'v-1').version, '2.0.0')
})

test('pins: CR-6 item 6 — this module rejects anything that would let C06 invent a project version', () => {
  // A missing or empty project version is refused: there is nothing to reference.
  for (const bad of [undefined, null, '', '   ', 42]) {
    assert.throws(
      () => bindPin([], { projectId: 'project-abc', projectVersion: bad, version: '1.0.0', at: T1 }),
      (error) => error.code === 'VALIDATION_FAILED',
      `projectVersion ${JSON.stringify(bad)} should be refused`,
    )
  }
  // A pin id / project id is a pure dimension: no tool derived value is ever a project version.
  assert.throws(() => assertProjectVersion(''), (error) => error.code === 'VALIDATION_FAILED')
})

test('pins: a project id is format-checked but never resolved, so C06 cannot read project facts', () => {
  assert.equal(assertProjectId('project-abc'), 'project-abc')
  for (const bad of ['', 'UPPER', 'a/b', '../etc', 123, null]) {
    assert.throws(() => assertProjectId(bad), (error) => error.code === 'VALIDATION_FAILED', String(bad))
  }
})

test('pins: a corrupt pin record is an error, not silently repaired or dropped', () => {
  assert.throws(() => normalizePin({ projectId: 'project-abc' }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(
    () => normalizePin({ projectId: 'project-abc', projectVersion: 'v-1', version: '1.0.0', at: T1, state: 'weird' }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  const ok = normalizePin({
    projectId: 'project-abc',
    projectVersion: 'v-1',
    version: '1.0.0',
    at: T1,
    state: PinState.SUPERSEDED,
  })
  assert.equal(ok.state, PinState.SUPERSEDED)
})

test('pins: the input array is never mutated (callers keep their previous state on refusal)', () => {
  const original = bind([], 'v-1', '1.0.0')
  const snapshot = JSON.stringify(original)
  advancePin(original, {
    projectId: 'project-abc',
    fromProjectVersion: 'v-1',
    toProjectVersion: 'v-2',
    version: '1.5.0',
    at: T2,
  })
  assert.equal(JSON.stringify(original), snapshot)
})
