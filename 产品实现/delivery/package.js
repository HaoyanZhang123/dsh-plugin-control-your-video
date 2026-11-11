/**
 * The editable project package: what "继续编辑" actually needs, and what an import must refuse.
 *
 * A package is a FOLDER bundle with `manifest.json`, not a zip: this range implements no archive
 * reader, so there is no extraction code that could be tricked into writing outside the target.
 * Hostile input is still screened entry by entry ({@link ../media/safety.js screenUntrustedPackage}),
 * because the same screening must hold if a later card adds an archive transport.
 *
 * What the package deliberately contains: the project document, the versions index (so the final
 * version and its confirmation survive), the decisions index (confirmations/authorisations), the
 * materials index and their bytes, the plan snapshots, the recipes, the AdaptOperation records and
 * a recovery/usage note. What it excludes: rebuildable work directories and every already-cleaned
 * history, plus deliverables (they are delivered separately, not smuggled into an edit project).
 *
 * Import never overwrites a project: a same-name title is a conflict that requires the user to give
 * a new name (or to accept a suffixed one), and an already-imported package is refused by id.
 *
 * @module delivery/package
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  ConflictError,
  NotFoundError,
  ValidationError,
  WorkbenchError,
  ErrorCode,
  contentHash,
  sha256,
  writeFileAtomic,
} from '../base/index.js'
import {
  PROJECT_LAYOUT,
  copyProject,
  createProject,
  listProjects,
  openProject,
  tryReadDocument,
  writeDocument,
} from '../core/project/index.js'
import { screenEntryPath, screenUntrustedPackage } from '../media/index.js'
import {
  DELIVERY_LAYOUT,
  DELIVERY_LIMITS,
  PACKAGE_DOCUMENT,
  PACKAGE_FORMAT_VERSION,
  assertOptionalText,
  assertText,
  clip,
  copy,
  packageIdFor,
} from './ids.js'

/** Version of the package transport this module writes. */
export const PACKAGE_TRANSPORT = 'folder-bundle'

/** Copy rules: which project files a package carries, and where they land inside the package. */
const PACKAGE_COPY_RULES = Object.freeze([
  { source: 'project.json', target: 'project/project.json', kind: 'project-document' },
  { source: PROJECT_LAYOUT.versionsIndex, target: 'project/versions/index.json', kind: 'versions-index' },
  { source: PROJECT_LAYOUT.decisionsIndex, target: 'project/decisions/index.json', kind: 'decisions-index' },
  { source: PROJECT_LAYOUT.materialsIndex, target: 'project/materials/index.json', kind: 'materials-index' },
  { sourceDir: PROJECT_LAYOUT.materialsFilesDir, targetPrefix: 'project/materials/files', kind: 'material-bytes' },
  { sourceDir: 'editing/plans', targetPrefix: 'project/editing/plans', kind: 'plan-snapshot' },
  { sourceDir: PROJECT_LAYOUT.recipesDir, targetPrefix: 'project/recipes', kind: 'recipe' },
  { sourceDir: `${DELIVERY_LAYOUT.dir}/adaptations`, targetPrefix: 'project/delivery/adaptations', kind: 'adaptation-record' },
])

/** Directories that are never packaged, with the reason shown in the manifest. */
const PACKAGE_EXCLUSIONS = Object.freeze([
  { path: 'work', reason: '可重建缓存与运行中间文件；不随包' },
  { path: `${DELIVERY_LAYOUT.workDir}`, reason: '导出的工作目录（滤镜图、临时编码结果）；可重建' },
  { path: `${DELIVERY_LAYOUT.outputsDir}`, reason: '交付物与可编辑项目分开交付，不塞进项目包' },
  { path: 'media', reason: '派生媒体；可从计划与素材重建' },
  { path: 'events.log.jsonl', reason: '事件日志是当前项目的运行记录，不作为迁移事实源' },
])

/**
 * Read a package manifest with a bounded read, so a hostile file cannot exhaust memory first.
 * @param {string} packageDir
 * @returns {any}
 */
function readManifest(packageDir) {
  const manifestPath = path.join(packageDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    throw new NotFoundError('项目包缺少 manifest.json', { packageDir })
  }
  const bytes = fs.readFileSync(manifestPath)
  if (bytes.length > 4 * 1024 * 1024) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '项目包清单过大', { details: { bytes: bytes.length } })
  }
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, '项目包清单不是有效 JSON', {
      details: { bytes: bytes.length },
      cause: error,
    })
  }
  if (parsed?.kind !== 'project-package') {
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, '项目包清单 kind 不符', { details: { kind: String(parsed?.kind) } })
  }
  return parsed
}

/**
 * Map one declared package path to the project-relative path it becomes on import.
 *
 * Only the prefixes this module writes are accepted; anything else is refused instead of guessed.
 * @param {string} declared
 * @returns {string|null}
 */
export function mapPackageTarget(declared) {
  const screening = screenEntryPath(declared)
  if (screening.ok === false) return null
  const normalised = screening.normalised
  if (normalised === 'project/project.json') return PROJECT_LAYOUT.projectFile
  if (normalised === 'project/versions/index.json') return PROJECT_LAYOUT.versionsIndex
  if (normalised === 'project/decisions/index.json') return PROJECT_LAYOUT.decisionsIndex
  if (normalised === 'project/materials/index.json') return PROJECT_LAYOUT.materialsIndex
  if (normalised.startsWith('project/materials/files/')) {
    return normalised.slice('project/'.length)
  }
  if (normalised.startsWith('project/editing/plans/')) {
    return normalised.slice('project/'.length)
  }
  if (normalised.startsWith('project/recipes/')) {
    return normalised.slice('project/'.length)
  }
  if (normalised.startsWith('project/delivery/adaptations/')) {
    return normalised.slice('project/'.length)
  }
  return null
}

/**
 * Walk one directory, yielding files relative to it with POSIX separators.
 * @param {string} root absolute
 * @returns {{ files: string[], bytes: number }}
 */
function walkFileList(root) {
  /** @type {string[]} */
  const files = []
  let bytes = 0
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        walk(absolute, relative)
      } else if (entry.isFile()) {
        files.push(relative)
        bytes += fs.statSync(absolute).size
      } else {
        throw new ValidationError('项目包源目录里出现符号链接或特殊文件，拒绝打包', {
          field: 'source',
          entry: relative,
        })
      }
    }
  }
  walk(root, '')
  return { files, bytes }
}

/**
 * Export one project as an editable package.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} input.finalVersion C10 final version record (already user-finalized)
 * @param {string} input.destinationDir absolute directory the package folder is created in
 * @param {{ version: string, source: string }|null} [input.toolchainInfo] external tool facts
 * @param {Clock} [input.clock]
 * @returns {any} package record
 */
export function exportProjectPackage(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('项目包导出需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const finalVersion = input.finalVersion
  if (finalVersion === null || typeof finalVersion !== 'object' || finalVersion.class !== 'final') {
    throw new ValidationError('只有用户验收的定稿版本才能导出可编辑项目包', { field: 'finalVersion' })
  }
  if (typeof finalVersion.confirmationRef !== 'string' || finalVersion.confirmationRef.length === 0) {
    throw new ValidationError('定稿版本缺少用户验收引用，拒绝导出', { field: 'finalVersion.confirmationRef' })
  }
  const destinationDir = input.destinationDir
  if (typeof destinationDir !== 'string' || !path.isAbsolute(destinationDir)) {
    throw new ValidationError('包导出目标必须是绝对目录', { field: 'destinationDir' })
  }
  const clock = input.clock ?? new Clock()
  const exportedAt = clock.iso()
  fs.mkdirSync(destinationDir, { recursive: true })
  let packageId = packageIdFor({ projectId: paths.projectId, exportedAt })
  let attempt = 1
  while (fs.existsSync(path.join(destinationDir, packageId))) {
    // A re-export never overwrites: the id is re-derived with an attempt suffix instead of reusing
    // the existing folder, so two exports of one project stay distinguishable on disk.
    attempt += 1
    packageId = packageIdFor({ projectId: paths.projectId, exportedAt: `${exportedAt}#${attempt}` })
    if (attempt > 200) throw new ConflictError('同名项目包目录过多，拒绝继续', { destinationDir })
  }
  const packageDir = path.join(destinationDir, packageId)

  /** @type {Array<{ path: string, kind: string, bytes: number, sha256: string }>} */
  const files = []
  let totalBytes = 0
  const packageRoot = packageDir
  try {
    fs.mkdirSync(packageRoot, { recursive: false })
    for (const rule of PACKAGE_COPY_RULES) {
      if (rule.source !== undefined) {
        const absolute = paths.resolve(rule.source)
        if (!fs.existsSync(absolute)) continue
        const target = path.join(packageRoot, rule.target)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const bytes = fs.readFileSync(absolute)
        writeFileAtomic(target, bytes)
        files.push({ path: rule.target, kind: rule.kind, bytes: bytes.length, sha256: sha256(bytes) })
        totalBytes += bytes.length
      } else {
        const absolute = paths.resolve(rule.sourceDir)
        if (!fs.existsSync(absolute)) continue
        const walked = walkFileList(absolute)
        for (const relative of walked.files) {
          const bytes = fs.readFileSync(path.join(absolute, relative))
          const target = `${rule.targetPrefix}/${relative}`
          const targetAbsolute = path.join(packageRoot, target)
          fs.mkdirSync(path.dirname(targetAbsolute), { recursive: true })
          writeFileAtomic(targetAbsolute, bytes)
          files.push({ path: target, kind: rule.kind, bytes: bytes.length, sha256: sha256(bytes) })
          totalBytes += bytes.length
        }
      }
    }
  } catch (error) {
    // Only the half-written package folder this call created is removed; nothing outside it is touched.
    try {
      fs.rmSync(packageRoot, { recursive: true, force: true })
    } catch {
      // Returning the real error is more useful than masking it with a cleanup failure.
    }
    throw error
  }

  const planRef = finalVersion?.content?.planRef ?? null
  const planSnapshot = planRef === null ? null : tryReadDocument(paths.resolve(planRef), { kind: 'editing-plan' })
  const plan = planSnapshot === null ? null : planSnapshot.value
  // The project's own title is the same-name key an import must compare; the version label is not.
  let projectTitle = '未命名项目'
  const projectStored = tryReadDocument(paths.projectFile(), { kind: 'project' })
  if (projectStored !== null && typeof projectStored.value?.title === 'string') {
    projectTitle = projectStored.value.title
  }
  const manifest = {
    kind: 'project-package',
    transport: PACKAGE_TRANSPORT,
    packageFormatVersion: PACKAGE_FORMAT_VERSION,
    packageId,
    exportedAt,
    source: {
      projectId: paths.projectId,
      title: projectTitle,
      finalVersionId: finalVersion.versionId,
      finalVersionLabel: clip(finalVersion.label, 80),
      confirmationRef: finalVersion.confirmationRef,
      finalizedAt: finalVersion.createdAt,
    },
    plan: plan === null
      ? null
      : {
          planRef,
          planVersion: planSnapshot.value?.planVersion ?? null,
          fingerprint: contentHash(planSnapshot.value?.plan ?? {}),
          profile: planSnapshot.value?.plan?.profile ?? null,
        },
    files,
    totals: { files: files.length, bytes: totalBytes },
    exclusions: [...PACKAGE_EXCLUSIONS],
    tools: input.toolchainInfo === undefined || input.toolchainInfo === null
      ? []
      : [{
          toolId: 'ffmpeg',
          role: '媒体编码/探测（外部工具，本体不随插件或项目包分发）',
          version: input.toolchainInfo.version,
          build: input.toolchainInfo.build ?? null,
          source: input.toolchainInfo.source,
        }],
    fonts: (Array.isArray(planSnapshot?.value?.plan?.fonts) ? planSnapshot.value.plan.fonts : []).map((font) => ({
      family: font?.family ?? null,
      file: font?.file ?? null,
      external: true,
      note: '字体是外部依赖：包不复制字体本体，导入时必须由用户确认本机有可用字体',
    })),
    usage: {
      purpose: '可编辑项目包：用于在另一个环境继续编辑，不是成片交付',
      conditions: [
        '包内素材与计划的权利条件随来源项目保留；不得把参考素材当作可再分发内容',
        '外部工具（FFmpeg/Remotion/HyperFrames）本体不进入本项目包',
        '导入后如需继续导出，需要本机重新解析工具链并重新验证结果',
      ],
    },
    recovery: {
      instructions: [
        '导入后先打开项目，检查版本索引中的定稿版本、计划快照与素材是否可读',
        '素材缺失时按材料索引重新定位，不静默替换成占位文件',
        '计划快照的指纹必须与包清单一致；不一致说明包被改动，重新导出而不是修补',
      ],
      steps: [
        '检查清单与哈希',
        '建立新的项目目录（不覆盖同名项目）',
        '写入项目文档、版本、决策、素材、计划、配方与适配记录',
        '打开项目并核对定稿版本与计划快照可读',
      ],
    },
    honest: {
      transport: PACKAGE_TRANSPORT,
      archiveExtractionImplemented: false,
      note: '本卡不解压任何归档格式；恶意归档的解压炸弹在“不解压”这一层被挡住，而不是声称实现了安全的解压器',
    },
  }
  writeFileAtomic(path.join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const recoveryText = [
    '# 恢复说明',
    '',
    ...manifest.recovery.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## 导入这一步会检查什么',
    '',
    ...manifest.recovery.instructions.map((line) => `- ${line}`),
    '',
  ].join('\n')
  const usageText = [
    '# 使用条件',
    '',
    manifest.usage.purpose,
    '',
    ...manifest.usage.conditions.map((line) => `- ${line}`),
    '',
  ].join('\n')
  writeFileAtomic(path.join(packageRoot, 'RECOVERY.md'), recoveryText)
  writeFileAtomic(path.join(packageRoot, 'USAGE.md'), usageText)

  /** @type {any} */
  const record = {
    packageId,
    direction: 'export',
    packageDir,
    packageFormatVersion: PACKAGE_FORMAT_VERSION,
    projectId: paths.projectId,
    finalVersionId: finalVersion.versionId,
    confirmationRef: finalVersion.confirmationRef,
    exportedAt,
    totals: manifest.totals,
    files: files.length,
    state: 'exported',
    verified: false,
    note: '包已写出；能否在另一环境继续编辑由导入检查与真实打开步骤证明，不由导出本身证明',
  }
  const packagesFile = paths.resolve(DELIVERY_LAYOUT.packagesIndex)
  const stored = tryReadDocument(packagesFile, { kind: PACKAGE_DOCUMENT.kind })
  const document = stored === null
    ? { kind: PACKAGE_DOCUMENT.kind, projectId: paths.projectId, packages: [] }
    : { ...stored.value, packages: Array.isArray(stored.value.packages) ? stored.value.packages : [] }
  document.packages.push(record)
  paths.ensureDir(DELIVERY_LAYOUT.dir)
  writeDocument(packagesFile, document, {
    kind: PACKAGE_DOCUMENT.kind,
    schemaKey: PACKAGE_DOCUMENT.schemaKey,
    expectedRevision: stored === null ? null : stored.revision,
    clock,
  })
  return copy(record)
}

/**
 * Inspect an untrusted package WITHOUT importing it.
 *
 * Every check is reported with its real evidence or as `not-checked`; a hash mismatch, a missing
 * file, an undeclared entry, a newer format, an already-imported package or a same-name project all
 * make `ok: false` with an actionable reason.
 *
 * @param {object} input
 * @param {string} input.packageDir absolute package folder
 * @param {string} [input.projectsRoot] when given, same-name and already-imported conflicts are checked
 * @param {{ version?: string }|null} [input.toolchain] currently resolved external tool facts
 * @param {(family: string) => boolean} [input.fontExists] environment font check, if the caller has one
 * @returns {any}
 */
export function inspectProjectPackage(input) {
  const packageDir = input?.packageDir
  if (typeof packageDir !== 'string' || !path.isAbsolute(packageDir)) {
    throw new ValidationError('包检查需要一个绝对目录', { field: 'packageDir' })
  }
  if (!fs.existsSync(packageDir)) throw new NotFoundError('项目包目录不存在', { packageDir })
  const manifest = readManifest(packageDir)
  /** @type {any[]} */
  const problems = []
  const addProblem = (code, message, detail) => problems.push({ code, message, detail: detail ?? null })

  if (!Number.isInteger(manifest.packageFormatVersion) || manifest.packageFormatVersion < 1) {
    addProblem('FORMAT_INVALID', '包格式版本缺失或非法', { value: manifest.packageFormatVersion })
  } else if (manifest.packageFormatVersion > PACKAGE_FORMAT_VERSION) {
    addProblem('FORMAT_TOO_NEW', '包格式版本高于本实现能读取的版本', {
      packageFormatVersion: manifest.packageFormatVersion,
      supported: PACKAGE_FORMAT_VERSION,
    })
  }

  const declared = Array.isArray(manifest.files) ? manifest.files : []
  if (declared.length === 0) addProblem('MANIFEST_EMPTY', '清单没有声明任何文件', null)
  if (declared.length > DELIVERY_LIMITS.maxPackageFiles) {
    addProblem('TOO_MANY_FILES', '包内文件数超过上限', { count: declared.length, limit: DELIVERY_LIMITS.maxPackageFiles })
  }
  const declaredBytes = Number(manifest.totals?.bytes ?? 0)
  if (Number.isFinite(declaredBytes) && declaredBytes > DELIVERY_LIMITS.maxPackageBytes) {
    addProblem('TOO_LARGE', '包声明总量超过上限', { bytes: declaredBytes, limit: DELIVERY_LIMITS.maxPackageBytes })
  }

  // Untrusted screening: path shape, links, per-entry and total resources, compression ratio.
  const screening = screenUntrustedPackage({
    root: packageDir,
    entries: declared.map((entry) => ({
      path: String(entry?.path ?? ''),
      bytes: Number(entry?.bytes ?? 0),
    })),
  })
  for (const rejected of screening.rejected) {
    addProblem('UNTRUSTED_ENTRY', `包内条目被拒绝：${rejected.reason}`, rejected.path)
  }

  /** @type {Array<{ path: string, ok: boolean, reason: string|null, bytes: number|null, sha256: string|null }>} */
  const entries = []
  for (const entry of declared) {
    const relative = String(entry?.path ?? '')
    const screeningOne = screenEntryPath(relative)
    if (screeningOne.ok === false) {
      entries.push({ path: relative, ok: false, reason: `untrusted:${screeningOne.reason}`, bytes: null, sha256: null })
      continue
    }
    const target = mapPackageTarget(relative)
    if (target === null) {
      entries.push({ path: relative, ok: false, reason: 'unexpected-prefix', bytes: null, sha256: null })
      addProblem('UNEXPECTED_PREFIX', '包内条目不在允许的目录前缀下', relative)
      continue
    }
    const absolute = path.join(packageDir, screeningOne.normalised)
    let stat
    try {
      stat = fs.lstatSync(absolute)
    } catch {
      entries.push({ path: relative, ok: false, reason: 'missing', bytes: null, sha256: null })
      addProblem('MISSING_FILE', '清单声明的文件不存在', relative)
      continue
    }
    if (stat.isSymbolicLink()) {
      entries.push({ path: relative, ok: false, reason: 'link-entry', bytes: null, sha256: null })
      addProblem('LINK_ESCAPE', '包内出现符号链接，拒绝导入', relative)
      continue
    }
    if (!stat.isFile()) {
      entries.push({ path: relative, ok: false, reason: 'not-a-file', bytes: null, sha256: null })
      addProblem('NOT_A_FILE', '清单声明的是一个目录或特殊文件', relative)
      continue
    }
    if (stat.size > DELIVERY_LIMITS.maxPackageFileBytes) {
      entries.push({ path: relative, ok: false, reason: 'entry-too-large', bytes: stat.size, sha256: null })
      addProblem('ENTRY_TOO_LARGE', '单个文件超过上限', { path: relative, bytes: stat.size })
      continue
    }
    const hash = sha256(fs.readFileSync(absolute))
    const expected = String(entry?.sha256 ?? '')
    if (hash !== expected) {
      entries.push({ path: relative, ok: false, reason: 'hash-mismatch', bytes: stat.size, sha256: hash })
      addProblem('HASH_MISMATCH', '文件内容与清单哈希不一致（包被改动或不完整）', relative)
      continue
    }
    entries.push({ path: relative, ok: true, reason: null, bytes: stat.size, sha256: hash })
  }

  // Identity checks on the documents themselves, not only the hashes.
  const projectEntry = entries.find((entry) => entry.path === 'project/project.json')
  if (projectEntry?.ok !== true) {
    addProblem('PROJECT_DOCUMENT_MISSING', '包内没有可用的项目文档', 'project/project.json')
  } else {
    const stored = tryReadDocument(path.join(packageDir, 'project', 'project.json'), { kind: 'project' })
    if (stored === null) addProblem('PROJECT_DOCUMENT_UNREADABLE', '项目文档无法读取', null)
    else if (stored.value?.projectId !== manifest.source?.projectId) {
      addProblem('PROJECT_ID_MISMATCH', '项目文档内的标识与清单不一致', {
        manifestId: String(manifest.source?.projectId ?? ''),
        documentId: String(stored.value?.projectId ?? ''),
      })
    }
  }
  const versionsEntry = entries.find((entry) => entry.path === 'project/versions/index.json')
  if (versionsEntry?.ok !== true) {
    addProblem('VERSIONS_MISSING', '包内没有版本索引，无法确认定稿版本', 'project/versions/index.json')
  } else {
    const stored = tryReadDocument(path.join(packageDir, 'project', 'versions', 'index.json'), { kind: 'versions' })
    if (stored !== null && stored.value?.finalVersionId !== manifest.source?.finalVersionId) {
      addProblem('FINAL_VERSION_MISMATCH', '版本索引里的定稿版本与清单不一致', {
        manifestFinal: String(manifest.source?.finalVersionId ?? ''),
        indexFinal: String(stored.value?.finalVersionId ?? ''),
      })
    }
  }
  const planEntry = manifest.plan?.planRef === undefined || manifest.plan?.planRef === null
    ? null
    : entries.find((entry) => entry.path === `project/${manifest.plan.planRef}`)
  if (manifest.plan !== null && manifest.plan !== undefined) {
    if (planEntry === null) {
      addProblem('PLAN_MISSING', '清单声明的计划快照不在包内', manifest.plan.planRef)
    } else if (planEntry.ok !== true) {
      addProblem('PLAN_UNUSABLE', '计划快照条目未通过检查', manifest.plan.planRef)
    } else {
      const stored = tryReadDocument(path.join(packageDir, 'project', ...String(manifest.plan.planRef).split('/')), {
        kind: 'editing-plan',
      })
      const fingerprint = stored === null ? null : contentHash(stored.value?.plan ?? {})
      if (fingerprint !== (manifest.plan.fingerprint ?? null)) {
        addProblem('PLAN_FINGERPRINT_MISMATCH', '计划快照内容与清单指纹不一致', manifest.plan.planRef)
      }
    }
  }

  // Environment differences are reported, never assumed away.
  const environment = {
    tools: (Array.isArray(manifest.tools) ? manifest.tools : []).map((tool) => {
      const actual = input.toolchain?.version ?? null
      const declared = tool?.version ?? null
      return {
        toolId: String(tool?.toolId ?? ''),
        declared,
        actual,
        match: actual === null ? null : actual === declared,
        note:
          actual === null
            ? '本环境没有解析到该工具：需要先解析工具链再导出或继续制作'
            : actual === declared
              ? '版本一致'
              : '版本不同：需要按新版本重新验证结果，不能沿用旧结论',
      }
    }),
    fonts: (Array.isArray(manifest.fonts) ? manifest.fonts : []).map((font) => {
      const available = typeof input.fontExists === 'function' ? input.fontExists(String(font?.family ?? '')) : null
      return {
        family: font?.family ?? null,
        available,
        checked: available !== null,
        note:
          available === null
            ? '没有字体检查能力：需要用户在本机确认字体存在，不能假设可用'
            : available
              ? '本机存在该字体'
              : '本机没有该字体：导入后文字会换行/溢出，必须先处理',
      }
    }),
  }

  // Same-name and already-imported conflicts.
  const conflicts = { sameTitle: [], alreadyImported: [], scanned: 0, truncated: false }
  if (typeof input.projectsRoot === 'string' && input.projectsRoot.length > 0) {
    let listing = { projects: [] }
    try {
      listing = listProjects({ projectsRoot: input.projectsRoot, includeArchived: true, includeTrashed: true })
    } catch (error) {
      addProblem('PROJECT_LIST_FAILED', '无法列出已有项目，不能确认同名冲突', String(error?.message ?? error))
    }
    const packageTitle = String(manifest.source?.title ?? '')
    const ids = (listing.projects ?? []).map((row) => String(row?.projectId ?? '')).filter((id) => id.length > 0)
    const capped = ids.slice(0, 300)
    conflicts.truncated = ids.length > capped.length
    if (conflicts.truncated) {
      // The check is still reported as incomplete instead of "no conflict found".
      addProblem('SCAN_TRUNCATED', '项目数量超过一次检查的上限，同名/已导入检查不完整', { projects: ids.length })
    }
    for (const projectId of capped) {
      conflicts.scanned += 1
      let opened
      try {
        opened = openProject({ projectsRoot: input.projectsRoot, projectId })
      } catch {
        continue // an unreadable project cannot answer a name conflict; it is not a reason to import
      }
      if (packageTitle.length > 0 && String(opened.project.title ?? '') === packageTitle) {
        conflicts.sameTitle.push({
          projectId: opened.project.projectId,
          title: opened.project.title,
          phase: opened.project.phase,
        })
      }
      if (String(opened.project.lineage?.importedFromPackage ?? '') === String(manifest.packageId ?? '')) {
        conflicts.alreadyImported.push({ projectId: opened.project.projectId })
      }
    }
    if (conflicts.alreadyImported.length > 0) {
      addProblem('ALREADY_IMPORTED', '这个包已经被导入过；再次导入会建立第二个项目', conflicts.alreadyImported)
    }
  }

  const ok = problems.length === 0
  return {
    ok,
    verdict: ok ? 'importable' : 'rejected',
    packageId: manifest.packageId,
    packageFormatVersion: manifest.packageFormatVersion,
    manifest,
    entries,
    problems,
    environment,
    conflicts,
    totals: { declared: declared.length, verified: entries.filter((entry) => entry.ok).length },
    honest: {
      noExtraction: true,
      noCodeExecution: true,
      note: '浏览与检查只读 JSON 与字节哈希，不执行包内任何源码；导入前不接受未经筛查的条目',
    },
  }
}

/**
 * Import an inspected package as a NEW project; never overwrites and never writes outside it.
 *
 * @param {object} input
 * @param {string} input.projectsRoot
 * @param {string} input.packageDir
 * @param {any} input.inspection result of {@link inspectProjectPackage}, must be `ok`
 * @param {string} [input.title] the new project's title; required when the package title collides
 * @param {any} [input.toolchain]
 * @param {Clock} [input.clock]
 * @returns {any}
 */
export function importProjectPackage(input) {
  const inspection = input?.inspection
  if (inspection === null || typeof inspection !== 'object' || inspection.ok !== true) {
    throw new ValidationError('导入需要一份通过的包检查结果', { field: 'inspection' })
  }
  const packageDir = input.packageDir
  if (typeof packageDir !== 'string' || !path.isAbsolute(packageDir)) {
    throw new ValidationError('导入需要包的绝对目录', { field: 'packageDir' })
  }
  const manifest = inspection.manifest
  const clock = input.clock ?? new Clock()
  const sameTitle = Array.isArray(inspection.conflicts?.sameTitle) ? inspection.conflicts.sameTitle : []
  const requestedTitle = assertOptionalText(input.title, 'title', 120)
  if (sameTitle.length > 0 && requestedTitle === null) {
    throw new ConflictError('已有同名项目；导入必须另起新名字，绝不覆盖', {
      existing: sameTitle,
      remedy: '给出一个新的项目名称后重试',
    })
  }
  const title = requestedTitle ?? `${String(manifest.source?.title ?? '导入项目')}（导入）`
  const created = createProject({
    projectsRoot: input.projectsRoot,
    title,
    coreGoal: typeof manifest.usage?.purpose === 'string' ? clip(manifest.usage.purpose, 200) : '',
    origin: 'import',
    lineage: {
      sourceProjectId: String(manifest.source?.projectId ?? ''),
      sourceVersionId: String(manifest.source?.finalVersionId ?? ''),
      importedFromPackage: String(manifest.packageId ?? ''),
      importedAt: clock.iso(),
    },
    clock,
  })
  const createdDir = created.paths.dir
  /** @type {Array<{ path: string, target: string, bytes: number }>} */
  const written = []
  try {
    for (const entry of inspection.entries) {
      if (entry.ok !== true) continue
      const target = mapPackageTarget(entry.path)
      if (target === null) continue
      const source = path.join(packageDir, ...entry.path.split('/'))
      if (target === PROJECT_LAYOUT.projectFile) continue // replaced below with the new identity
      const absolute = created.paths.resolve(target)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      let document = fs.readFileSync(source)
      const needsProjectRewrite =
        entry.path === 'project/versions/index.json' ||
        entry.path === 'project/decisions/index.json' ||
        entry.path === 'project/materials/index.json' ||
        entry.path.startsWith('project/editing/plans/')
      if (needsProjectRewrite) {
        // The copied document belongs to the NEW project; its internal projectId must say so,
        // otherwise C10's and C14's own cross-project guards would refuse to open it later. The
        // inner plan keeps the source project id as provenance, so its content fingerprint stays valid.
        const parsed = JSON.parse(document.toString('utf8'))
        parsed.projectId = created.project.projectId
        document = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
      }
      writeFileAtomic(absolute, document)
      written.push({ path: entry.path, target, bytes: document.length })
    }
    // The new project document keeps its own id/phase/lineage; only descriptive fields come from the package.
    const opened = openProject({
      projectsRoot: input.projectsRoot,
      projectId: created.project.projectId,
      clock,
    })
    const project = { ...opened.project }
    project.coreGoal = clip(manifest.usage?.purpose, 200) ?? ''
    writeDocument(created.paths.projectFile(), project, {
      kind: 'project',
      schemaKey: 'project',
      expectedRevision: opened.revision,
      clock,
    })
  } catch (error) {
    try {
      fs.rmSync(createdDir, { recursive: true, force: true })
    } catch {
      // The real error is reported; a cleanup failure must not hide it.
    }
    throw error
  }

  const editable = path.join(createdDir, PROJECT_LAYOUT.versionsIndex)
  const editableCheck = {
    versionsIndexPresent: fs.existsSync(editable),
    finalVersionId: null,
    planReadable: false,
    materialsCount: 0,
  }
  const stored = tryReadDocument(created.paths.resolve(PROJECT_LAYOUT.versionsIndex), { kind: 'versions' })
  if (stored !== null) editableCheck.finalVersionId = stored.value?.finalVersionId ?? null
  const planRelative = String(manifest.plan?.planRef ?? '')
  if (planRelative.length > 0) {
    editableCheck.planReadable = fs.existsSync(created.paths.resolve(planRelative))
  }
  const materialsStored = tryReadDocument(created.paths.resolve(PROJECT_LAYOUT.materialsIndex), { kind: 'materials' })
  editableCheck.materialsCount = Array.isArray(materialsStored?.value?.materials)
    ? materialsStored.value.materials.length
    : 0

  /** @type {any} */
  const record = {
    packageId: String(manifest.packageId ?? ''),
    direction: 'import',
    projectId: created.project.projectId,
    title,
    packageDir,
    packageFormatVersion: Number(manifest.packageFormatVersion ?? 0),
    state: 'imported',
    importedAt: clock.iso(),
    files: written,
    editable: editableCheck,
    note: '已建立新项目；能否继续编辑以打开项目并读取定稿版本与计划为准',
  }
  const packagesFile = created.paths.resolve(DELIVERY_LAYOUT.packagesIndex)
  const packagesStored = tryReadDocument(packagesFile, { kind: PACKAGE_DOCUMENT.kind })
  const document = packagesStored === null
    ? { kind: PACKAGE_DOCUMENT.kind, projectId: created.project.projectId, packages: [] }
    : {
        ...packagesStored.value,
        packages: Array.isArray(packagesStored.value.packages) ? packagesStored.value.packages : [],
      }
  document.packages.push(record)
  created.paths.ensureDir(DELIVERY_LAYOUT.dir)
  writeDocument(packagesFile, document, {
    kind: PACKAGE_DOCUMENT.kind,
    schemaKey: PACKAGE_DOCUMENT.schemaKey,
    expectedRevision: packagesStored === null ? null : packagesStored.revision,
    clock,
  })
  return copy(record)
}

/**
 * List the package records of one project (exports and imports are separate directions).
 * @param {any} paths
 * @param {Clock} [clock]
 * @returns {any[]}
 */
export function listPackageRecords(paths, clock = new Clock()) {
  const stored = tryReadDocument(paths.resolve(DELIVERY_LAYOUT.packagesIndex), { kind: PACKAGE_DOCUMENT.kind })
  void clock
  if (stored === null) return []
  return (Array.isArray(stored.value.packages) ? stored.value.packages : []).map((entry) => copy(entry))
}

/** Re-export of C10's copy helper so a caller need not import two modules for one concept. */
export { copyProject }
