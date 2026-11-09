/**
 * The one on-disk layout for a project directory, and the guards that keep writes inside it.
 *
 * Layout is CT-02 §2 verbatim. Nothing else in this module set may build a path by hand: a later
 * card asks {@link ProjectPaths} for it, so "the project directory" can never mean two different
 * things in two modules. Renaming a project changes its display name only — never its id, its
 * directory name or a stored relative path (CT-02 §2 "项目 ID 与文件名分离，改名不改 ID").
 *
 * All user data lives under a caller-supplied root. C10 does not choose the root: CT-00 §4 names
 * the default, the user may change it in preferences, and the host half (C11) injects it.
 *
 * Every project directory is named by the project ID, so a display name containing `..`, a
 * colon or a reserved device name cannot influence where files are written.
 *
 * @module core/project/paths
 */

import fs from 'node:fs'
import path from 'node:path'
import { PathGuard, assertSafeRelativePath, ValidationError } from '../../base/index.js'
import { assertId } from './ids.js'

/** Files and directories inside one project directory, relative to the project root. */
export const PROJECT_LAYOUT = Object.freeze({
  /** project identity, phase, execution state, series relation, work position */
  projectFile: 'project.json',
  briefDir: 'brief',
  materialsDir: 'materials',
  materialsIndex: 'materials/index.json',
  materialsFilesDir: 'materials/files',
  decisionsDir: 'decisions',
  decisionsIndex: 'decisions/index.json',
  plansDir: 'plans',
  recipesDir: 'recipes',
  evidenceDir: 'evidence',
  workDir: 'work',
  workPositionFile: 'work/position.json',
  versionsDir: 'versions',
  versionsIndex: 'versions/index.json',
  currentDir: 'versions/current',
  candidatesDir: 'versions/candidates',
  finalDir: 'versions/final',
  mediaDir: 'media',
  packagesDir: 'packages',
  recoveryFile: 'recovery.json',
})

/** Files at the projects root (not inside a project directory). */
export const ROOT_LAYOUT = Object.freeze({
  registryFile: 'index.json',
  globalProductionLock: 'lock.global-production.json',
})

/** Directories every project directory gets on creation, in creation order. */
export const PROJECT_SUBDIRS = Object.freeze([
  PROJECT_LAYOUT.briefDir,
  PROJECT_LAYOUT.materialsDir,
  PROJECT_LAYOUT.materialsFilesDir,
  PROJECT_LAYOUT.decisionsDir,
  PROJECT_LAYOUT.plansDir,
  PROJECT_LAYOUT.recipesDir,
  PROJECT_LAYOUT.evidenceDir,
  PROJECT_LAYOUT.workDir,
  PROJECT_LAYOUT.versionsDir,
  PROJECT_LAYOUT.currentDir,
  PROJECT_LAYOUT.candidatesDir,
  PROJECT_LAYOUT.finalDir,
  PROJECT_LAYOUT.mediaDir,
  PROJECT_LAYOUT.packagesDir,
])

/** Whether an absolute path currently exists (any file type). */
export function pathExists(absolute) {
  try {
    fs.statSync(absolute)
    return true
  } catch {
    return false
  }
}

/**
 * Paths inside one project directory.
 *
 * Every accessor validates the id and re-confines the result, so a corrupt `project.json` that
 * stores `"../../escape"` as a relative path cannot turn into a write outside the project.
 */
export class ProjectPaths {
  /**
   * @param {string} projectsRoot absolute path of the projects container
   * @param {string} projectId
   */
  constructor(projectsRoot, projectId) {
    if (typeof projectsRoot !== 'string' || !path.isAbsolute(projectsRoot)) {
      throw new ValidationError('项目根目录必须是绝对路径', { field: 'projectsRoot' })
    }
    this.projectsRoot = path.resolve(projectsRoot)
    this.projectId = assertId(projectId, 'project', 'projectId')
    /** Absolute path of this project's directory. */
    this.dir = path.join(this.projectsRoot, this.projectId)
    this.guard = new PathGuard(this.projectsRoot, { label: 'projects' })
  }

  /**
   * Prefix a project-relative path with the project id, validating both parts.
   * @param {string} relative project-relative path, posix separators
   * @returns {string} root-relative path, posix separators
   */
  relative(relative) {
    const safe = assertSafeRelativePath(relative ?? '', { allowEmpty: true })
    return safe.length === 0 ? this.projectId : `${this.projectId}/${safe}`
  }

  /**
   * Absolute path of a project-relative path, proven to be inside the projects root.
   * @param {string} relative
   * @param {{ mustExist?: boolean, kind?: 'file' | 'directory' }} [options]
   * @returns {string}
   */
  resolve(relative, options) {
    return this.guard.resolve(this.relative(relative), options)
  }

  /**
   * Absolute path of a project-relative path, created as a directory if absent.
   * @param {string} relative
   * @returns {string}
   */
  ensureDir(relative) {
    const absolute = this.resolve(relative)
    fs.mkdirSync(absolute, { recursive: true })
    return absolute
  }

  /** @param {string} relative @returns {boolean} */
  exists(relative) {
    try {
      return pathExists(this.resolve(relative))
    } catch {
      return false
    }
  }

  /** Absolute path of `project.json`. */
  projectFile() {
    return this.resolve(PROJECT_LAYOUT.projectFile)
  }

  /** Absolute path of the recovery marker. */
  recoveryFile() {
    return this.resolve(PROJECT_LAYOUT.recoveryFile)
  }

  /** Absolute path of the saved work position. */
  workPositionFile() {
    return this.resolve(PROJECT_LAYOUT.workPositionFile)
  }

  /** Absolute directory of one candidate version. */
  candidateDir(candidateId) {
    return this.resolve(`${PROJECT_LAYOUT.candidatesDir}/${assertId(candidateId, 'candidate', 'candidateId')}`)
  }

  /** Absolute directory holding one material's bytes. */
  materialDir(materialId) {
    return this.resolve(`${PROJECT_LAYOUT.materialsFilesDir}/${assertId(materialId, 'material', 'materialId')}`)
  }
}

/**
 * Paths at the projects container root: the registry and the global production lock.
 * @param {string} projectsRoot
 */
export function createRootPaths(projectsRoot) {
  if (typeof projectsRoot !== 'string' || !path.isAbsolute(projectsRoot)) {
    throw new ValidationError('项目根目录必须是绝对路径', { field: 'projectsRoot' })
  }
  const root = path.resolve(projectsRoot)
  const guard = new PathGuard(root, { label: 'projects-root' })
  return {
    root,
    guard,
    registryPath: () => guard.resolve(ROOT_LAYOUT.registryFile),
    globalLockPath: () => guard.resolve(ROOT_LAYOUT.globalProductionLock),
    /** @param {string} projectId */
    projectDir(projectId) {
      return new ProjectPaths(root, projectId).dir
    },
    /** @param {string} projectId */
    projectPaths(projectId) {
      return new ProjectPaths(root, projectId)
    },
  }
}
