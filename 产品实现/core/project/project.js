/**
 * Project identity, lifecycle and the registry: create, open, copy, branch, series.
 *
 * This module owns the answer to "which projects exist and what is this one", and nothing else.
 * Materials, decisions, versions, locks and recovery live in sibling modules and are composed by
 * `core/project/index.js`; keeping this file to identity + lifecycle is what stops a second
 * parallel source of project truth from appearing (CT-03 §1).
 *
 * Lifecycle facts encoded here, each from a contract clause:
 * - a project id is stable forever; a display name may change freely and never moves files
 *   (CT-02 §2 "项目 ID 与文件名分离，改名不改 ID");
 * - copying and branching produce a NEW project that keeps its origin and source ids, and never
 *   modifies the source project (C10 card §1 "保留来源"; §6.8 "不覆盖原项目");
 * - a series groups episodes but each episode is an independent project, so changing series
 *   shared settings must never silently rewrite an episode (C10 card §6.9);
 * - archive / recycle-bin are phases, and references are checked before a destructive move
 *   (C10 card §4.1).
 *
 * @module core/project/project
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  ConflictError,
  ErrorCode,
  NotFoundError,
  ValidationError,
  WorkbenchError,
  readJson,
  writeJsonAtomic,
} from '../../base/index.js'
import { newId, assertId, isId } from './ids.js'
import {
  SCHEMA_VERSION,
  CURRENT_SCHEMA_GENERATION,
  ProjectPhase,
  ExecutionState,
  SeriesRelation,
  ProjectOrigin,
  assertEnum,
  assertPhaseTransition,
  summarizeProjectState,
} from './schema.js'
import { PROJECT_LAYOUT, PROJECT_SUBDIRS, ProjectPaths, createRootPaths, pathExists } from './paths.js'
import { readDocument, writeDocument, stripEnvelope, ensureDirectory } from './store.js'
import { appendEvents, buildEvent, readEvents, ProjectEventKind } from './events.js'

/** Longest accepted project title; a longer one is refused rather than truncated silently. */
export const MAX_PROJECT_TITLE = 200

/**
 * A project document as stored in `project.json`.
 * @typedef {object} ProjectRecord
 * @property {string} projectId
 * @property {string} title
 * @property {string} origin one of ProjectOrigin
 * @property {string} phase one of ProjectPhase
 * @property {string} execution one of ExecutionState
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} coreGoal the one-sentence goal the work is judged against
 * @property {{relation: string, seriesId?: string, episodeLabel?: string}} series
 * @property {{sourceProjectId?: string, sourceVersionId?: string, copiedAt?: string, branchOf?: string}} lineage
 * @property {{versionId?: string, objectId?: string, playheadFrame?: number, surface?: string}} work
 * @property {string[]} tags
 * @property {string} [archivedAt]
 * @property {string} [trashedAt]
 */

/**
 * Validate a project title.
 * @param {unknown} title
 * @returns {string}
 */
export function validateTitle(title) {
  if (typeof title !== 'string') throw new ValidationError('项目标题必须是文本', { field: 'title' })
  const trimmed = title.trim()
  if (trimmed.length === 0) throw new ValidationError('项目标题不能为空', { field: 'title' })
  if (trimmed.length > MAX_PROJECT_TITLE) {
    throw new ValidationError(`项目标题过长（${trimmed.length} > ${MAX_PROJECT_TITLE}）`, { field: 'title' })
  }
  // A title is display text, not a path, but a control character would still corrupt a listing.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ValidationError('项目标题包含控制字符', { field: 'title' })
  }
  return trimmed
}

/**
 * Build the document for a brand-new project.
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.coreGoal]
 * @param {string} [input.origin]
 * @param {{relation: string, seriesId?: string, episodeLabel?: string}} [input.series]
 * @param {{sourceProjectId?: string, sourceVersionId?: string, branchOf?: string}} [input.lineage]
 * @param {Clock} [input.clock]
 * @returns {ProjectRecord}
 */
function buildProjectDocument(input) {
  const clock = input.clock ?? new Clock()
  const now = clock.iso()
  return {
    projectId: newId('project'),
    title: validateTitle(input.title),
    coreGoal: typeof input.coreGoal === 'string' ? input.coreGoal.trim() : '',
    origin: assertEnum(input.origin ?? ProjectOrigin.BLANK, ProjectOrigin, 'origin'),
    phase: ProjectPhase.INTAKE,
    execution: ExecutionState.IDLE,
    createdAt: now,
    updatedAt: now,
    series: input.series ?? { relation: SeriesRelation.STANDALONE },
    lineage: input.lineage ?? {},
    work: {},
    tags: [],
  }
}

/**
 * Create a project directory and its `project.json`.
 *
 * Real work performed, in order: make every subdirectory CT-02 §2 names, write `project.json`,
 * write an empty registry-visible event, and record the project in the root registry. A failure
 * part-way removes only the directory this call created, never an existing project.
 *
 * @param {object} options
 * @param {string} options.projectsRoot absolute path of the projects container
 * @param {string} options.title
 * @param {string} [options.coreGoal]
 * @param {string} [options.origin]
 * @param {{relation: string, seriesId?: string, episodeLabel?: string}} [options.series]
 * @param {{sourceProjectId?: string, sourceVersionId?: string, branchOf?: string}} [options.lineage]
 * @param {Clock} [options.clock]
 * @returns {{ project: ProjectRecord, paths: ProjectPaths }}
 */
export function createProject(options) {
  const root = createRootPaths(options.projectsRoot)
  ensureDirectory(root.root, { kind: 'projects-root' })
  const clock = options.clock ?? new Clock()

  const document = buildProjectDocument(options)
  const paths = new ProjectPaths(root.root, document.projectId)

  // A generated id collision is astronomically unlikely but would silently merge two projects,
  // so it is checked rather than assumed.
  if (pathExists(paths.dir)) {
    throw new ConflictError('项目目录已存在，拒绝覆盖', { projectId: document.projectId, stage: 'create' })
  }

  const createdDir = paths.dir
  try {
    ensureDirectory(createdDir, { kind: 'project' })
    for (const subdir of PROJECT_SUBDIRS) {
      ensureDirectory(path.join(createdDir, subdir), { kind: 'project-subdir' })
    }
    writeDocument(paths.projectFile(), document, { kind: 'project', schemaKey: 'project', clock, createOnly: true })
    appendEvents(createdDir, [
      buildEvent({
        kind: ProjectEventKind.PROJECT_CREATED,
        projectId: document.projectId,
        actor: 'user',
        detail: { title: document.title, origin: document.origin },
      }),
    ], { clock, nextSequence: 0 })
    registerProject(root.root, document, { clock })
  } catch (error) {
    // Roll back ONLY our own half-created directory: writing into a foreign existing project
    // would be far worse than leaving a broken one behind.
    try {
      fs.rmSync(createdDir, { recursive: true, force: true })
    } catch {
      // Leaving a partial directory is reported by the caller's error; masking it here is worse.
    }
    throw error
  }

  return { project: document, paths }
}

/**
 * Read one project's document plus the metadata a caller needs to act.
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {Clock} [options.clock]
 * @returns {{ project: ProjectRecord, paths: ProjectPaths, revision: string, bytes: number, migrated: boolean }}
 */
export function openProject(options) {
  const root = createRootPaths(options.projectsRoot)
  const paths = new ProjectPaths(root.root, options.projectId)
  if (!pathExists(paths.dir)) {
    throw new NotFoundError('项目目录不存在', {
      projectId: paths.projectId,
      action: '检查项目是否被移动、归档或删除；不要按同名新建覆盖',
    })
  }
  const stored = readDocument(paths.projectFile(), {
    kind: 'project',
    expectedGeneration: CURRENT_SCHEMA_GENERATION,
  })
  const project = /** @type {ProjectRecord} */ (stored.value)
  if (project.projectId !== paths.projectId) {
    // A mismatched id means the file belongs to another project; trusting it would let one
    // project read and write another's state.
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, '项目文件内的标识与目录不一致', {
      details: { expected: paths.projectId, found: String(project.projectId), action: '拒绝打开，请检查项目目录是否被手工改动' },
    })
  }
  assertEnum(project.phase, ProjectPhase, 'project.phase')
  assertEnum(project.execution, ExecutionState, 'project.execution')
  return { project, paths, revision: stored.revision, bytes: stored.bytes, migrated: stored.migrated }
}

/**
 * Apply a change to a project document with a revision check.
 *
 * Every mutation goes through here so the single-writer contract is enforced in one place:
 * a caller that read revision R and writes against R gets a `VERSION_CONFLICT` when another
 * writer already advanced it (CT-02 §3; 03 §3.8).
 *
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {string} options.expectedRevision
 * @param {(project: ProjectRecord) => ProjectRecord | void} mutate
 * @param {Clock} [options.clock]
 * @returns {{ project: ProjectRecord, revision: string }}
 */
export function updateProject(options) {
  const opened = openProject(options)
  const clock = options.clock ?? new Clock()
  const draft = structuredClone(opened.project)
  const result = options.mutate(draft)
  const next = result === undefined ? draft : result
  if (next === null || typeof next !== 'object') {
    throw new ValidationError('项目变更必须返回项目对象')
  }
  if (next.projectId !== opened.project.projectId) {
    throw new ValidationError('项目标识不可修改', { field: 'projectId' })
  }
  if (next.phase !== opened.project.phase) {
    // Phase changes go through setPhase so the transition table is always consulted.
    throw new ValidationError('阶段必须通过 setPhase 修改', { field: 'phase' })
  }
  writeDocument(opened.paths.projectFile(), stripEnvelope(next), {
    kind: 'project',
    schemaKey: 'project',
    expectedRevision: options.expectedRevision,
    clock,
  })
  syncRegistryRow(options.projectsRoot, next, clock)
  return { project: next, revision: options.expectedRevision }
}

/**
 * Change a project's phase, refusing an illegal transition.
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {string} options.to
 * @param {string} options.expectedRevision
 * @param {Clock} [options.clock]
 * @returns {{ project: ProjectRecord, from: string, to: string, revision: string }}
 */
export function setPhase(options) {
  const opened = openProject(options)
  const from = opened.project.phase
  const to = assertEnum(options.to, ProjectPhase, 'phase.to')
  assertPhaseTransition(from, to)
  if (from === to) {
    return { project: opened.project, from, to, revision: opened.revision }
  }
  const clock = options.clock ?? new Clock()
  const next = structuredClone(opened.project)
  next.phase = to
  if (to === ProjectPhase.ARCHIVED) next.archivedAt = clock.iso()
  if (to === ProjectPhase.RECYCLE_BIN) next.trashedAt = clock.iso()
  if (to !== ProjectPhase.ARCHIVED) delete next.archivedAt
  if (to !== ProjectPhase.RECYCLE_BIN) delete next.trashedAt
  writeDocument(opened.paths.projectFile(), stripEnvelope(next), {
    kind: 'project',
    schemaKey: 'project',
    expectedRevision: options.expectedRevision,
    clock,
  })
  const eventKind =
    to === ProjectPhase.ARCHIVED
      ? ProjectEventKind.PROJECT_ARCHIVED
      : to === ProjectPhase.RECYCLE_BIN
        ? ProjectEventKind.PROJECT_TRASHED
        : ProjectEventKind.PROJECT_PHASE_CHANGED
  appendEvents(
    opened.paths.dir,
    [buildEvent({ kind: eventKind, projectId: opened.project.projectId, actor: 'user', detail: { from, to } })],
    { clock },
  )
  syncRegistryRow(options.projectsRoot, next, clock)
  return { project: next, from, to, revision: options.expectedRevision }
}

/**
 * Record the execution state. `unknown` is accepted on purpose and is what a caller writes when
 * it cannot know the truth; it is then shown as paused and never auto-retried (CT-03 §2).
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {string} options.state
 * @param {string} options.expectedRevision
 * @param {Clock} [options.clock]
 * @returns {{ project: ProjectRecord, state: string, revision: string }}
 */
export function setExecutionState(options) {
  const opened = openProject(options)
  const state = assertEnum(options.state, ExecutionState, 'execution')
  const clock = options.clock ?? new Clock()
  const next = structuredClone(opened.project)
  next.execution = state
  writeDocument(opened.paths.projectFile(), stripEnvelope(next), {
    kind: 'project',
    schemaKey: 'project',
    expectedRevision: options.expectedRevision,
    clock,
  })
  if (state === ExecutionState.UNKNOWN) {
    const unknownEvent = buildEvent({
      kind: ProjectEventKind.EXECUTION_UNKNOWN,
      projectId: opened.project.projectId,
      actor: 'system',
      detail: {},
    })
    appendEvents(opened.paths.dir, [unknownEvent], { clock })
  }
  syncRegistryRow(options.projectsRoot, next, clock)
  return { project: next, state, revision: options.expectedRevision }
}

/**
 * Rename a project: display name only. The id and directory never change.
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {string} options.title
 * @param {string} options.expectedRevision
 * @param {Clock} [options.clock]
 */
export function renameProject(options) {
  const title = validateTitle(options.title)
  const opened = openProject(options)
  if (opened.project.title === title) {
    return { project: opened.project, revision: opened.revision }
  }
  const clock = options.clock ?? new Clock()
  const next = structuredClone(opened.project)
  next.title = title
  writeDocument(opened.paths.projectFile(), stripEnvelope(next), {
    kind: 'project',
    schemaKey: 'project',
    expectedRevision: options.expectedRevision,
    clock,
  })
  appendEvents(
    opened.paths.dir,
    [
      buildEvent({
        kind: ProjectEventKind.PROJECT_RENAMED,
        projectId: opened.project.projectId,
        actor: 'user',
        detail: { from: opened.project.title, to: title },
      }),
    ],
    { clock },
  )
  syncRegistryRow(options.projectsRoot, next, clock)
  return { project: next, revision: options.expectedRevision }
}

/**
 * Refresh a project's registry row after a change that the listing shows.
 *
 * The registry is a convenience index (see {@link reconcileRegistry}), but a row that keeps
 * showing an old title, phase, execution state or series after the project itself changed is a
 * lie in the project list. Failing to update it is tolerated: the row can always be repaired from
 * `project.json`, so a registry write problem must never fail the real project change.
 *
 * @param {string} projectsRoot
 * @param {ProjectRecord} project
 * @param {Clock} clock
 */
function syncRegistryRow(projectsRoot, project, clock) {
  try {
    const root = createRootPaths(projectsRoot)
    if (!pathExists(root.root)) return
    registerProject(root.root, project, { clock })
  } catch {
    // The project change already succeeded and is the source of truth; a stale index row is
    // repaired by reconcileRegistry on the next listing.
  }
}

/**
 * Copy a project, or branch it, into a new independent project.
 *
 * The new project keeps the source project id and version in `lineage`, so "where did this come
 * from" is answerable later, and the SOURCE project is never written to (C10 card §6.8).
 *
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.sourceProjectId
 * @param {string} [options.title]
 * @param {boolean} [options.branch] true records `branchOf`, otherwise `sourceProjectId`
 * @param {string} [options.sourceVersionId]
 * @param {boolean} [options.copyMaterials] default true; copies material bytes
 * @param {Clock} [options.clock]
 * @returns {{ project: ProjectRecord, paths: ProjectPaths, copiedMaterials: number, copiedVersions: number }}
 */
export function copyProject(options) {
  const source = openProject({
    projectsRoot: options.projectsRoot,
    projectId: options.sourceProjectId,
    clock: options.clock,
  })
  const root = createRootPaths(options.projectsRoot)
  const clock = options.clock ?? new Clock()
  const branch = options.branch === true
  const title = options.title === undefined ? `${source.project.title}${branch ? '（分支）' : '（副本）'}` : options.title

  const created = createProject({
    projectsRoot: root.root,
    title,
    coreGoal: source.project.coreGoal,
    origin: branch ? ProjectOrigin.BRANCH : ProjectOrigin.COPY,
    series: { ...source.project.series },
    lineage: branch
      ? {
          branchOf: source.project.projectId,
          sourceProjectId: source.project.projectId,
          sourceVersionId: options.sourceVersionId,
        }
      : {
          sourceProjectId: source.project.projectId,
          sourceVersionId: options.sourceVersionId,
          copiedAt: clock.iso(),
        },
    clock,
  })

  let copiedMaterials = 0
  let copiedVersions = 0
  try {
    if (options.copyMaterials !== false) copiedMaterials = copyMaterialsTree(source.paths, created.paths)
    copiedVersions = copyVersionsTree(source.paths, created.paths)
    copyJsonIfPresent(source.paths, created.paths, PROJECT_LAYOUT.materialsIndex)
    copyJsonIfPresent(source.paths, created.paths, PROJECT_LAYOUT.decisionsIndex)
    copyJsonIfPresent(source.paths, created.paths, PROJECT_LAYOUT.versionsIndex)

    // The copied project starts at the same phase but is never "in production": two projects must
    // not both believe they hold the single global production right (CT-02 §4).
    const opened = openProject({ projectsRoot: root.root, projectId: created.project.projectId })
    const next = structuredClone(opened.project)
    next.phase = source.project.phase === ProjectPhase.RECYCLE_BIN ? ProjectPhase.INTAKE : source.project.phase
    next.execution = ExecutionState.IDLE
    next.work = {}
    writeDocument(opened.paths.projectFile(), stripEnvelope(next), {
      kind: 'project',
      schemaKey: 'project',
      expectedRevision: opened.revision,
      clock,
    })

    appendEvents(
      created.paths.dir,
      [
        buildEvent({
          kind: branch ? ProjectEventKind.PROJECT_BRANCHED : ProjectEventKind.PROJECT_COPIED,
          projectId: next.projectId,
          actor: 'user',
          detail: {
            sourceProjectId: source.project.projectId,
            copiedMaterials,
            copiedVersions,
            branch,
          },
        }),
      ],
      { clock },
    )
    registerProject(root.root, next, { clock })
    return { project: next, paths: created.paths, copiedMaterials, copiedVersions }
  } catch (error) {
    try {
      fs.rmSync(created.paths.dir, { recursive: true, force: true })
    } catch {
      // Report the original failure; the leftover copy is visible in the registry as absent.
    }
    throw error
  }
}

/**
 * Copy material bytes from one project to another.
 * @param {ProjectPaths} from
 * @param {ProjectPaths} to
 * @returns {number}
 */
function copyMaterialsTree(from, to) {
  const sourceDir = from.resolve(PROJECT_LAYOUT.materialsFilesDir)
  if (!pathExists(sourceDir)) return 0
  const targetDir = to.ensureDir(PROJECT_LAYOUT.materialsFilesDir)
  let count = 0
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    // Only directories named by a material id are copied; an unexpected entry is skipped rather
    // than followed, so a stray link cannot be traversed.
    if (!entry.isDirectory() || !isId(entry.name, 'material')) continue
    fs.cpSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), { recursive: true })
    count += 1
  }
  return count
}

/**
 * Copy candidate version directories from one project to another.
 * @param {ProjectPaths} from
 * @param {ProjectPaths} to
 * @returns {number}
 */
function copyVersionsTree(from, to) {
  const sourceDir = from.resolve(PROJECT_LAYOUT.candidatesDir)
  if (!pathExists(sourceDir)) return 0
  const targetDir = to.ensureDir(PROJECT_LAYOUT.candidatesDir)
  let count = 0
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isId(entry.name, 'candidate')) continue
    fs.cpSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), { recursive: true })
    count += 1
  }
  return count
}

/**
 * Copy one state file verbatim when it exists.
 * @param {ProjectPaths} from
 * @param {ProjectPaths} to
 * @param {string} relative
 */
function copyJsonIfPresent(from, to, relative) {
  const source = from.resolve(relative)
  if (!pathExists(source)) return
  const target = to.resolve(relative)
  ensureDirectory(path.dirname(target), { kind: 'copy-target' })
  fs.copyFileSync(source, target)
}

/**
 * Link a project into a series, or unlink it.
 *
 * A series is an optional grouping; joining one never changes the episode's own content, and an
 * episode keeps its own project id (CT-03 §1 "Series…每集独立项目").
 *
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {string} [options.seriesId]
 * @param {string} [options.episodeLabel]
 * @param {string} options.expectedRevision
 * @param {Clock} [options.clock]
 */
export function setSeriesLink(options) {
  const opened = openProject(options)
  const clock = options.clock ?? new Clock()
  const next = structuredClone(opened.project)
  let detail
  let kind
  if (options.seriesId === undefined || options.seriesId === null) {
    next.series = { relation: SeriesRelation.STANDALONE }
    kind = ProjectEventKind.SERIES_UNLINKED
    detail = { from: opened.project.series }
  } else {
    const seriesId = assertId(options.seriesId, 'series', 'seriesId')
    next.series = { relation: SeriesRelation.EPISODE, seriesId }
    if (typeof options.episodeLabel === 'string') next.series.episodeLabel = options.episodeLabel
    kind = ProjectEventKind.SERIES_LINKED
    detail = { seriesId, episodeLabel: next.series.episodeLabel ?? '' }
  }
  writeDocument(opened.paths.projectFile(), stripEnvelope(next), {
    kind: 'project',
    schemaKey: 'project',
    expectedRevision: options.expectedRevision,
    clock,
  })
  // The registry row must follow, or "which episodes belong to this series" would go stale and
  // a series-level change would silently affect nobody.
  syncRegistryRow(options.projectsRoot, next, clock)
  appendEvents(
    opened.paths.dir,
    [buildEvent({ kind, projectId: opened.project.projectId, actor: 'user', detail })],
    { clock },
  )
  return { project: next, revision: options.expectedRevision }
}

/**
 * Record that a series-level shared setting changed, WITHOUT touching any episode.
 *
 * This exists so "共享变化不静默覆盖单集" is a code path rather than a promise: the function
 * returns the list of episodes that would be affected and leaves them unmodified, so a caller has
 * to show the change and let the user apply it per episode.
 *
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.seriesId
 * @param {string} options.change summary of what changed at series level
 * @param {Clock} [options.clock]
 * @returns {{ affected: Array<{ projectId: string, title: string }>, applied: 0, requiresPerEpisodeApply: true }}
 */
export function notifySeriesSharedChange(options) {
  const seriesId = assertId(options.seriesId, 'series', 'seriesId')
  // Read the registry DIRECTLY rather than through listProjects: the listing hides archived and
  // trashed projects by default, and an archived episode still belongs to the series. Filtering
  // through the listing would silently drop it from the affected set.
  const registry = readRegistry(options.projectsRoot)
  const affected = registry.projects
    .filter((project) => project.series?.seriesId === seriesId)
    .map((project) => ({ projectId: project.projectId, title: project.title }))
  const clock = options.clock ?? new Clock()
  for (const episode of affected) {
    const paths = new ProjectPaths(path.resolve(options.projectsRoot), episode.projectId)
    if (!pathExists(paths.dir)) continue
    appendEvents(
      paths.dir,
      [
        buildEvent({
          kind: ProjectEventKind.SERIES_SHARED_UPDATED,
          projectId: episode.projectId,
          actor: 'system',
          detail: { seriesId, change: String(options.change ?? ''), applied: false, requiresPerEpisodeApply: true },
        }),
      ],
      { clock },
    )
  }
  return { affected, applied: 0, requiresPerEpisodeApply: true }
}

/**
 * Absolute path of the root registry file.
 * @param {string} projectsRoot
 * @returns {string}
 */
export function registryPath(projectsRoot) {
  return createRootPaths(projectsRoot).registryPath()
}

/**
 * Read the root registry, returning an empty one when it does not exist yet.
 * @param {string} projectsRoot
 * @returns {{ schemaVersion: number, schemaGeneration: number, revision: string, projects: Array<any> }}
 */
export function readRegistry(projectsRoot) {
  const filePath = registryPath(projectsRoot)
  if (!pathExists(filePath)) {
    return {
      schemaVersion: SCHEMA_VERSION.registry,
      schemaGeneration: CURRENT_SCHEMA_GENERATION,
      revision: '',
      projects: [],
    }
  }
  const stored = readDocument(filePath, { kind: 'registry', expectedGeneration: CURRENT_SCHEMA_GENERATION })
  const value = stored.value
  return {
    schemaVersion: stored.schemaVersion,
    schemaGeneration: stored.schemaGeneration,
    revision: stored.revision,
    projects: Array.isArray(value.projects) ? value.projects : [],
  }
}

/**
 * Insert or update one project's registry row.
 *
 * The registry is a convenience index, not a source of truth: a row that disagrees with
 * `project.json` is corrected from the project file by {@link reconcileRegistry}, and a missing
 * row never means a missing project.
 *
 * @param {string} projectsRoot
 * @param {ProjectRecord} project
 * @param {{ clock?: Clock }} [options]
 */
export function registerProject(projectsRoot, project, options = {}) {
  const clock = options.clock ?? new Clock()
  const current = readRegistry(projectsRoot)
  const row = {
    projectId: project.projectId,
    title: project.title,
    phase: project.phase,
    execution: project.execution,
    origin: project.origin,
    series: project.series,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
  const projects = current.projects.filter((entry) => entry.projectId !== project.projectId)
  projects.push(row)
  projects.sort((a, b) => String(a.projectId).localeCompare(String(b.projectId)))
  const filePath = registryPath(projectsRoot)
  ensureDirectory(path.dirname(filePath), { kind: 'projects-root' })
  writeDocument(
    filePath,
    { projects },
    {
      kind: 'registry',
      schemaKey: 'registry',
      expectedRevision: current.revision === '' ? undefined : current.revision,
      clock,
      createOnly: current.revision === '',
    },
  )
  return row
}

/**
 * List projects, optionally filtered, newest first.
 *
 * Reads the registry for speed but repairs an obviously stale row from the real project file when
 * asked, so a user never sees a project listed as `producing` after a crash left it `paused`.
 *
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} [options.phase]
 * @param {string} [options.seriesId]
 * @param {boolean} [options.includeArchived] default false
 * @param {boolean} [options.includeTrashed] default false
 * @param {boolean} [options.reconcile] default false
 * @param {Clock} [options.clock]
 * @returns {{ projects: Array<any>, skipped: Array<{ projectId: string, reason: string }> }}
 */
export function listProjects(options) {
  const registry = readRegistry(options.projectsRoot)
  const skipped = []
  const results = []
  for (const row of registry.projects) {
    if (!isId(row?.projectId, 'project')) {
      skipped.push({ projectId: String(row?.projectId ?? ''), reason: 'invalid-id' })
      continue
    }
    if (options.phase !== undefined && row.phase !== options.phase) {
      const includeArchived = options.includeArchived === true && row.phase === ProjectPhase.ARCHIVED
      const includeTrashed = options.includeTrashed === true && row.phase === ProjectPhase.RECYCLE_BIN
      if (!includeArchived && !includeTrashed) continue
    }
    if (options.seriesId !== undefined && row.series?.seriesId !== options.seriesId) continue
    if (options.includeArchived !== true && row.phase === ProjectPhase.ARCHIVED) {
      if (options.phase !== ProjectPhase.ARCHIVED) continue
    }
    if (options.includeTrashed !== true && row.phase === ProjectPhase.RECYCLE_BIN) {
      if (options.phase !== ProjectPhase.RECYCLE_BIN) continue
    }
    results.push(options.reconcile === true ? reconcileRow(options.projectsRoot, row, skipped) : row)
  }
  results.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return { projects: results, skipped }
}

/**
 * Rebuild one registry row from the real project file.
 * @param {string} projectsRoot
 * @param {any} row
 * @param {Array<{ projectId: string, reason: string }>} skipped
 * @returns {any}
 */
function reconcileRow(projectsRoot, row, skipped) {
  try {
    const opened = openProject({ projectsRoot, projectId: row.projectId })
    return {
      ...row,
      title: opened.project.title,
      phase: opened.project.phase,
      execution: opened.project.execution,
      series: opened.project.series,
      updatedAt: opened.project.updatedAt,
    }
  } catch (error) {
    // An unreadable project stays listed with its registry values but is marked, so the user can
    // see it needs handling instead of it silently disappearing from the list.
    skipped.push({ projectId: String(row.projectId), reason: error?.code ?? 'unknown' })
    return { ...row, unreadable: true }
  }
}

/**
 * Report the three axes plus the derived single-line state for one project.
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {{confirmed: number, total: number}} [options.confirmations]
 * @returns {ReturnType<typeof summarizeProjectState> & { projectId: string, title: string }}
 */
export function describeState(options) {
  const opened = openProject(options)
  const summary = summarizeProjectState({
    phase: opened.project.phase,
    execution: opened.project.execution,
    confirmations: options.confirmations,
  })
  return { projectId: opened.project.projectId, title: opened.project.title, ...summary }
}

/**
 * Read the event log of one project.
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {object} [options.filter]
 */
export function projectEvents(options) {
  const opened = openProject(options)
  return readEvents(opened.paths.dir, options.filter ?? {})
}

/**
 * Write the registry file directly, used by tests and by the recovery repair path.
 * @param {string} projectsRoot
 * @param {any} body
 * @param {{ clock?: Clock, expectedRevision?: string }} [options]
 */
export function writeRegistry(projectsRoot, body, options = {}) {
  const filePath = registryPath(projectsRoot)
  ensureDirectory(path.dirname(filePath), { kind: 'projects-root' })
  return writeDocument(filePath, body, {
    kind: 'registry',
    schemaKey: 'registry',
    expectedRevision: options.expectedRevision,
    clock: options.clock,
  })
}

/**
 * Read a raw JSON file, exported for callers that must inspect an unrelated state file.
 * @param {string} filePath
 * @returns {unknown}
 */
export function readRawJson(filePath) {
  return readJson(filePath)
}

/** Re-exported so a caller can write an unrelated atomic file without importing base directly. */
export { writeJsonAtomic }
