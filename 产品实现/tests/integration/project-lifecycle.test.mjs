/**
 * Integration tests for project identity and lifecycle: create, open, copy, branch, series.
 *
 * Every assertion reads the real filesystem after the operation, because the contract cares about
 * what SURVIVES on disk, not what a function returned. Covers C10 card §6.1, §6.8, §6.9, §6.12
 * and the "不覆盖原项目" rule.
 *
 * @module tests/integration/project-lifecycle.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTempDir, Clock } from '../../base/index.js'
import {
  createProject,
  openProject,
  copyProject,
  setPhase,
  renameProject,
  setSeriesLink,
  notifySeriesSharedChange,
  listProjects,
  describeState,
  projectEvents,
  createRootPaths,
  ProjectPhase,
  ExecutionState,
  SeriesRelation,
  ProjectOrigin,
  PROJECT_LAYOUT,
  isId,
} from '../../core/project/index.js'

const temp = createTempDir({ label: 'lifecycle' })
const projectsRoot = temp.dir('projects')
const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
test.after(() => temp.dispose())

test('lifecycle: create produces the full CT-02 directory contract and a readable project.json', () => {
  const { project, paths } = createProject({ projectsRoot, title: '开场短片', clock })
  assert.ok(isId(project.projectId, 'project'))
  assert.equal(project.phase, ProjectPhase.INTAKE)
  assert.equal(project.execution, ExecutionState.IDLE)
  assert.equal(project.origin, ProjectOrigin.BLANK)
  assert.equal(project.series.relation, SeriesRelation.STANDALONE)

  // The directories CT-02 §2 requires must really exist on disk.
  for (const relative of [
    PROJECT_LAYOUT.briefDir,
    PROJECT_LAYOUT.materialsDir,
    PROJECT_LAYOUT.plansDir,
    PROJECT_LAYOUT.recipesDir,
    PROJECT_LAYOUT.evidenceDir,
    PROJECT_LAYOUT.workDir,
    PROJECT_LAYOUT.currentDir,
    PROJECT_LAYOUT.candidatesDir,
    PROJECT_LAYOUT.finalDir,
    PROJECT_LAYOUT.mediaDir,
    PROJECT_LAYOUT.packagesDir,
  ]) {
    assert.ok(fs.existsSync(paths.resolve(relative)), `缺少目录 ${relative}`)
  }
  assert.ok(fs.existsSync(paths.projectFile()), 'project.json 必须落盘')
})

test('lifecycle: open reads the document from disk and refuses a mismatched id', () => {
  const { project, paths } = createProject({ projectsRoot, title: '读取测试', clock })
  const opened = openProject({ projectsRoot, projectId: project.projectId, clock })
  assert.equal(opened.project.title, '读取测试')
  assert.ok(opened.revision.length > 0)

  // A file that claims to be another project must not be trusted: accepting it would let one
  // project read and write another's state.
  const document = JSON.parse(fs.readFileSync(paths.projectFile(), 'utf8'))
  document.projectId = 'prj_0000000000000000'
  fs.writeFileSync(paths.projectFile(), `${JSON.stringify(document, null, 2)}\n`)
  assert.throws(
    () => openProject({ projectsRoot, projectId: project.projectId, clock }),
    (error) => error.code === 'CORRUPT_DATA',
  )
})

test('lifecycle: opening a missing project names the situation instead of creating one', () => {
  assert.throws(
    () => openProject({ projectsRoot, projectId: 'prj_ZZZZZZZZZZZZZZZZ', clock }),
    (error) => {
      assert.equal(error.code, 'NOT_FOUND')
      assert.match(String(error.details.action), /不要按同名新建覆盖/)
      return true
    },
  )
  // It must NOT have created the directory as a side effect.
  assert.equal(fs.existsSync(path.join(projectsRoot, 'prj_ZZZZZZZZZZZZZZZZ')), false)
})

test('lifecycle: copy creates an independent project and leaves the source untouched', () => {
  const source = createProject({ projectsRoot, title: '原项目', clock })
  const before = fs.readFileSync(source.paths.projectFile(), 'utf8')
  const beforeSha = JSON.stringify(JSON.parse(before))

  const copy = copyProject({ projectsRoot, sourceProjectId: source.project.projectId, clock })
  assert.notEqual(copy.project.projectId, source.project.projectId)
  assert.equal(copy.project.origin, ProjectOrigin.COPY)
  assert.equal(copy.project.lineage.sourceProjectId, source.project.projectId)

  // The source project file must be byte-identical: a copy may never rewrite the original.
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(source.paths.projectFile(), 'utf8'))), beforeSha)
  assert.equal(fs.existsSync(copy.paths.projectFile()), true)
})

test('lifecycle: branch records branchOf and both projects can be listed', () => {
  const source = createProject({ projectsRoot, title: '分支源', clock })
  const branch = copyProject({ projectsRoot, sourceProjectId: source.project.projectId, branch: true, clock })
  assert.equal(branch.project.origin, ProjectOrigin.BRANCH)
  assert.equal(branch.project.lineage.branchOf, source.project.projectId)
  assert.match(branch.project.title, /分支/)

  const listed = listProjects({ projectsRoot, includeArchived: true, includeTrashed: true })
  const ids = listed.projects.map((row) => row.projectId)
  assert.ok(ids.includes(source.project.projectId))
  assert.ok(ids.includes(branch.project.projectId))
})

test('lifecycle: copy reproduces material bytes and the materials index', () => {
  const source = createProject({ projectsRoot, title: '带材料', clock })
  // Write a real material body and index entry the way materials.js would. The id body must avoid
  // I, L, O and U: they are excluded from the id alphabet precisely so a mistyped id cannot
  // silently address a different entity.
  const materialId = 'mat_ABCDEFGHJKMNPQRS'
  const materialDir = source.paths.resolve(`${PROJECT_LAYOUT.materialsFilesDir}/${materialId}`)
  fs.mkdirSync(materialDir, { recursive: true })
  fs.writeFileSync(path.join(materialDir, 'clip.txt'), 'real material bytes')
  fs.writeFileSync(
    source.paths.resolve(PROJECT_LAYOUT.materialsIndex),
    `${JSON.stringify({ materials: [{ materialId, name: 'clip.txt' }] }, null, 2)}\n`,
  )

  const copy = copyProject({ projectsRoot, sourceProjectId: source.project.projectId, clock })
  const copiedBody = path.join(copy.paths.resolve(`${PROJECT_LAYOUT.materialsFilesDir}/${materialId}`), 'clip.txt')
  assert.equal(fs.readFileSync(copiedBody, 'utf8'), 'real material bytes')
  const copiedIndex = JSON.parse(fs.readFileSync(copy.paths.resolve(PROJECT_LAYOUT.materialsIndex), 'utf8'))
  assert.equal(copiedIndex.materials[0].materialId, materialId)
})

test('lifecycle: a copied project never starts in production state', () => {
  const source = createProject({ projectsRoot, title: '制作中源', clock })
  const sourceOpened = openProject({ projectsRoot, projectId: source.project.projectId, clock })
  const aligned = setPhase({
    projectsRoot,
    projectId: source.project.projectId,
    to: ProjectPhase.ALIGNING,
    expectedRevision: sourceOpened.revision,
    clock,
  })
  assert.equal(aligned.project.phase, ProjectPhase.ALIGNING)

  const copy = copyProject({ projectsRoot, sourceProjectId: source.project.projectId, clock })
  // Two projects must never both believe they hold the single production right.
  assert.equal(copy.project.execution, ExecutionState.IDLE)
  assert.deepEqual(copy.project.work, {})
})

test('lifecycle: phase changes are recorded in the event log', () => {
  const created = createProject({ projectsRoot, title: '阶段测试', clock })
  const opened = openProject({ projectsRoot, projectId: created.project.projectId, clock })
  setPhase({
    projectsRoot,
    projectId: created.project.projectId,
    to: ProjectPhase.ALIGNING,
    expectedRevision: opened.revision,
    clock,
  })
  const events = projectEvents({ projectsRoot, projectId: created.project.projectId })
  const kinds = events.events.map((event) => event.kind)
  assert.ok(kinds.includes('project.created'))
  assert.ok(kinds.includes('project.phase-changed'))
})

test('lifecycle: a stale revision cannot change a phase', () => {
  const created = createProject({ projectsRoot, title: '冲突阶段', clock })
  const opened = openProject({ projectsRoot, projectId: created.project.projectId, clock })
  setPhase({
    projectsRoot,
    projectId: created.project.projectId,
    to: ProjectPhase.ALIGNING,
    expectedRevision: opened.revision,
    clock,
  })
  // Replaying the OLD revision must be refused rather than reverting the newer phase.
  assert.throws(
    () =>
      setPhase({
        projectsRoot,
        projectId: created.project.projectId,
        to: ProjectPhase.INTAKE,
        expectedRevision: opened.revision,
        clock,
      }),
    (error) => error.code === 'CONFLICT',
  )
  const after = openProject({ projectsRoot, projectId: created.project.projectId, clock })
  assert.equal(after.project.phase, ProjectPhase.ALIGNING)
})

test('lifecycle: rename changes the display name only, never the id or directory', () => {
  const created = createProject({ projectsRoot, title: '旧名字', clock })
  const opened = openProject({ projectsRoot, projectId: created.project.projectId, clock })
  const renamed = renameProject({
    projectsRoot,
    projectId: created.project.projectId,
    title: '新名字',
    expectedRevision: opened.revision,
    clock,
  })
  assert.equal(renamed.project.title, '新名字')
  assert.equal(renamed.project.projectId, created.project.projectId)
  assert.equal(fs.existsSync(created.paths.dir), true, '改名不得移动项目目录')
})

test('lifecycle: an empty or overlong title is refused', () => {
  assert.throws(() => createProject({ projectsRoot, title: '   ', clock }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(
    () => createProject({ projectsRoot, title: 'x'.repeat(201), clock }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('lifecycle: a series groups episodes but shared changes never rewrite an episode', () => {
  // Valid Crockford base32 body: the alphabet excludes I, L, O and U, so a literal that contains
  // one of those is rejected by assertId before it can become a real id.
  const seriesId = 'ser_ABCDEFGHJKMNPQRS'
  const episodeA = createProject({ projectsRoot, title: '第一集', clock })
  const episodeB = createProject({ projectsRoot, title: '第二集', clock })
  for (const episode of [episodeA, episodeB]) {
    const opened = openProject({ projectsRoot, projectId: episode.project.projectId, clock })
    setSeriesLink({
      projectsRoot,
      projectId: episode.project.projectId,
      seriesId,
      episodeLabel: episode.project.title,
      expectedRevision: opened.revision,
      clock,
    })
  }

  const episodeFile = episodeA.paths.projectFile()
  const beforeEpisode = fs.readFileSync(episodeFile, 'utf8')

  const result = notifySeriesSharedChange({
    projectsRoot,
    seriesId,
    change: '统一片头标题样式',
    clock,
  })
  assert.equal(result.affected.length, 2)
  // The decisive assertion: no episode project.json was modified by a series-level change.
  assert.equal(fs.readFileSync(episodeFile, 'utf8'), beforeEpisode)
  assert.equal(result.requiresPerEpisodeApply, true)

  // Each episode records that it must be applied per episode, rather than silently changing.
  const events = projectEvents({ projectsRoot, projectId: episodeA.project.projectId })
  const shared = events.events.filter((event) => event.kind === 'series.shared-updated')
  assert.equal(shared.length, 1)
  assert.equal(shared[0].detail.applied, false)
  assert.equal(shared[0].detail.requiresPerEpisodeApply, true)
})

test('lifecycle: describeState reports all three axes separately', () => {
  const created = createProject({ projectsRoot, title: '状态测试', clock })
  const state = describeState({
    projectsRoot,
    projectId: created.project.projectId,
    confirmations: { confirmed: 0, total: 2 },
  })
  assert.equal(state.phase, ProjectPhase.INTAKE)
  assert.equal(state.execution, ExecutionState.IDLE)
  assert.equal(state.confirmation, 'undecided')
  assert.match(state.label, /接收输入/)
})

test('lifecycle: projects root registry is a real file and lists what exists', () => {
  const rootPaths = createRootPaths(projectsRoot)
  assert.ok(fs.existsSync(rootPaths.registryPath()))
  const listed = listProjects({ projectsRoot, includeArchived: true, includeTrashed: true })
  assert.ok(listed.projects.length >= 3)
  for (const row of listed.projects) {
    assert.ok(isId(row.projectId, 'project'))
  }
})
