/**
 * The C10 journey test: create → material use → autosave → exit → continue.
 *
 * This is the card's minimum test 1 (§6.1) and the G1-core journey. It runs through the PUBLIC
 * facade and its bound stores, because that is what C11/C13 will actually call: if this file had
 * to reach into an internal module for a normal operation, the facade would be incomplete.
 *
 * It does not substitute for a user clicking through a UI — there is no UI in this card. What it
 * proves is that the state a UI would render is real, persisted, and correct after an exit.
 *
 * @module tests/integration/project-journey.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTempDir, Clock } from '../../base/index.js'
import * as core from '../../core/project/index.js'

const temp = createTempDir({ label: 'journey' })
const projectsRoot = temp.dir('projects')
test.after(() => temp.dispose())

/** A real file on disk, so its hash is a real content hash. */
function writeRealFile(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, text, 'utf8')
  return file
}

test('journey: create a project, record a material use, autosave, exit, and continue', async () => {
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })

  // ---- 1. create from a central start area (the UI part is C11; the facts are here) ---------
  const created = core.createProject({
    projectsRoot,
    title: '开场三秒',
    coreGoal: '用已有素材做一个三秒开场',
    clock,
  })
  const projectId = created.project.projectId
  assert.equal(created.project.phase, core.ProjectPhase.INTAKE)

  const session = await core.openSession({ projectsRoot, projectId, clock })
  const paths = session.paths

  // ---- 2. add a real material and a natural-language use, with no pre-approval form ----------
  const sourceFile = writeRealFile(temp.dir('user-assets'), 'opening.txt', '这是开场要用的真实素材内容。')
  const added = core.addMaterial({
    projectPaths: paths,
    sourceFile,
    kind: core.MaterialKind.TEXT,
    rightsStatus: core.RightsStatus.USER_PROVIDED,
    observation: core.MaterialObservation.OBSERVED_FULL,
    clock,
  })
  const materialId = added.material.materialId
  assert.ok(core.isId(materialId, 'material'))
  // The hash is computed from the PUBLISHED bytes, not from the buffer the caller passed.
  assert.match(added.material.contentSha256, /^[a-f0-9]{64}$/, '内容哈希必须来自真实字节')
  assert.equal(added.material.byteSize, Buffer.byteLength('这是开场要用的真实素材内容。', 'utf8'))
  assert.equal(added.material.rightsStatus, core.RightsStatus.USER_PROVIDED)
  assert.equal(added.material.observation, core.MaterialObservation.OBSERVED_FULL)

  const recorded = core.recordUse({
    projectPaths: paths,
    materialId,
    userText: '只用在开场前三秒，不要出现在结尾。',
    projectVersion: 'proj-v1',
    clock,
  })
  // The user's words are stored verbatim; nothing paraphrases them into a schema.
  assert.equal(recorded.use.userText, '只用在开场前三秒，不要出现在结尾。')

  // ---- 3. autosave the work position -------------------------------------------------------
  const saved = core.saveWorkPosition(
    paths.dir,
    {
      projectId,
      // A fresh project genuinely has no version yet; an empty id is the honest value.
      versionId: '',
      playheadFrame: 42,
      selectedObjectId: 'obj_opening',
      workSurface: 'creation',
      panelState: { right: 'properties' },
    },
    { clock },
  )
  assert.equal(saved.projectId, projectId)
  assert.ok(fs.existsSync(paths.workPositionFile()), '保存位置必须真实落盘')

  // ---- 4. simulate a clean exit ------------------------------------------------------------
  core.markCleanPause(paths.dir, { reason: '用户退出', projectId }, { clock })

  // ---- 5. continue: reopen from disk and check the real state ------------------------------
  const reopened = core.openProject({ projectsRoot, projectId, clock })
  assert.equal(reopened.project.title, '开场三秒')

  const recovery = core.inspectRecovery({
    projectDir: paths.dir,
    projectsRoot,
    projectId,
    materialCheck: () => [],
    toolCheck: () => [],
    clock,
  })
  assert.equal(recovery.canContinue, true, `应当可以继续：${JSON.stringify(recovery.needsHandling)}`)
  assert.equal(recovery.position.playheadFrame, 42)
  assert.equal(recovery.position.selectedObjectId, 'obj_opening')
  assert.equal(recovery.position.workSurface, 'creation')
})

test('journey: a material whose bytes were deleted outside the product needs handling', async () => {
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
  const created = core.createProject({ projectsRoot, title: '缺件测试', clock })
  const session = await core.openSession({ projectsRoot, projectId: created.project.projectId, clock })
  const paths = session.paths

  const sourceFile = writeRealFile(temp.dir('user-assets'), 'later-deleted.txt', '会被删除的素材')
  const added = core.addMaterial({
    projectPaths: paths,
    sourceFile,
    kind: core.MaterialKind.TEXT,
    rightsStatus: core.RightsStatus.USER_PROVIDED,
    observation: core.MaterialObservation.UNREAD,
    clock,
  })

  // The user deletes the stored body outside the product. This is normal, not an exception.
  const storedDir = path.join(paths.dir, core.PROJECT_LAYOUT.materialsFilesDir, added.material.materialId)
  for (const name of fs.readdirSync(storedDir)) {
    fs.rmSync(path.join(storedDir, name), { force: true })
  }

  const check = core.verifyAvailability({ projectPaths: paths, clock })
  assert.equal(check.ok, false, '缺件时检查结果不得报告 ok')
  assert.ok(check.needsAttention.length > 0, '必须报告缺件')
  const missing = check.items.find((entry) => entry.available === false)
  assert.ok(missing, '必须报告缺件')
  assert.equal(missing.materialId, added.material.materialId)
  assert.ok(
    [core.NeedsAttentionCode.MATERIAL_MISSING, core.NeedsAttentionCode.MATERIAL_UNREADABLE].includes(missing.code),
    `缺件原因码应当明确，实际 ${missing.code}`,
  )
})

test('journey: a project directory that disappeared is reported as needing handling', async () => {
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
  const created = core.createProject({ projectsRoot, title: '目录移动', clock })
  const projectDir = created.paths.dir

  // Simulate the user moving the folder away between sessions.
  const movedTo = temp.dir('moved-away')
  fs.cpSync(projectDir, path.join(movedTo, 'project'), { recursive: true })
  fs.rmSync(projectDir, { recursive: true, force: true })

  const recovery = core.inspectRecovery({
    projectsRoot,
    projectId: created.project.projectId,
    projectDir,
    materialCheck: () => [],
    toolCheck: () => [],
    clock,
  })
  assert.equal(recovery.canContinue, false)
  const codes = recovery.needsHandling.map((item) => item.code)
  assert.ok(codes.includes(core.NeedsAttentionCode.PROJECT_DIR_MISSING), `实际原因码 ${codes.join(',')}`)
  // Every needs-handling entry must tell the user what to do, not only that something is wrong.
  for (const item of recovery.needsHandling) {
    assert.ok(String(item.action ?? '').length > 0, `${item.code} 缺少可执行的下一步`)
  }
})

test('journey: the three axes are visible and separate for a real project', () => {
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
  const created = core.createProject({ projectsRoot, title: '三轴', clock })
  const state = core.describeState({
    projectsRoot,
    projectId: created.project.projectId,
    confirmations: { confirmed: 0, total: 2 },
  })
  assert.equal(state.phase, 'intake')
  assert.equal(state.execution, 'idle')
  assert.equal(state.confirmation, 'undecided')
  assert.equal(typeof state.label, 'string')
})

test('journey: the public facade exposes a frozen interface version and admits its own limits', () => {
  assert.equal(core.PROJECT_CORE_INTERFACE_VERSION, '1.0.0')
  for (const [name, capability] of Object.entries(core.PROJECT_CORE_CAPABILITIES)) {
    assert.ok(capability.supported.length > 0, `${name} 未声明支持范围`)
    assert.ok(capability.limits.length > 0, `${name} 未声明限制`)
  }
})

test('journey: a relative projects root is refused instead of resolved against the cwd', () => {
  assert.throws(() => core.requireAbsoluteRoot('relative/projects'), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => core.requireAbsoluteRoot(''), (error) => error.code === 'VALIDATION_FAILED')
  assert.equal(core.requireAbsoluteRoot(projectsRoot), path.resolve(projectsRoot))
})
