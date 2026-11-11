/**
 * Integration tests for the editable project package: export → inspect → import → keep editing.
 *
 * The package is treated as untrusted input, so the tests also feed it hostile manifests, a tampered
 * byte, a missing file, a newer format version, a same-name project and a second import of the same
 * package. None of those may result in an overwrite or a silent success.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createProject, openSession } from '../../core/project/index.js'
import { readPlanSnapshot } from '../../editing/index.js'
import {
  exportProjectPackage,
  importProjectPackage,
  inspectProjectPackage,
  listPackageRecords,
} from '../../delivery/index.js'
import { availableFont, availableToolchain, createFinalizedProject, fixedClock, makeWorkspace } from '../delivery-test-helpers.mjs'

/**
 * Export one package from a finalized project under an isolated root.
 * @param {import('node:test').TestContext} t
 * @param {{ title?: string }} [options]
 */
function setupPackage(t, options = {}) {
  const root = makeWorkspace(t, 'package')
  const clock = fixedClock()
  const project = createFinalizedProject({
    root,
    fontFile: availableFont() ?? path.join('fonts', 'arial.ttf'),
    clock,
    title: options.title,
  })
  const toolchain = availableToolchain()
  const record = exportProjectPackage({
    paths: project.paths,
    finalVersion: project.finalVersion,
    destinationDir: path.join(root, 'packages'),
    toolchainInfo: toolchain === null
      ? null
      : { version: toolchain.ffmpeg.version, build: toolchain.ffmpeg.build, source: toolchain.ffmpeg.source },
    clock,
  })
  return { root, clock, project, record, toolchain }
}

test('export → inspect → import → keep editing, with no overwrite and a real final version', async (t) => {
  const { root, clock, project, record } = setupPackage(t, { title: '往返测试项目' })
  assert.equal(record.direction, 'export')
  assert.equal(record.state, 'exported')
  assert.equal(fs.existsSync(path.join(record.packageDir, 'manifest.json')), true)
  assert.equal(fs.existsSync(path.join(record.packageDir, 'RECOVERY.md')), true)
  assert.equal(fs.existsSync(path.join(record.packageDir, 'USAGE.md')), true)
  const manifest = JSON.parse(fs.readFileSync(path.join(record.packageDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.kind, 'project-package')
  assert.equal(manifest.source.projectId, project.paths.projectId)
  assert.equal(manifest.source.title, '往返测试项目')
  assert.equal(manifest.source.finalVersionId, project.finalVersion.versionId)
  assert.equal(manifest.honest.archiveExtractionImplemented, false)
  assert.ok(manifest.files.length >= 4)
  for (const exclusion of manifest.exclusions) {
    assert.equal(fs.existsSync(path.join(record.packageDir, exclusion.path)), false, `不应打包 ${exclusion.path}`)
  }

  const inspection = inspectProjectPackage({ packageDir: record.packageDir, projectsRoot: root, clock })
  assert.equal(inspection.ok, true)
  assert.equal(inspection.verdict, 'importable')
  assert.equal(inspection.problems.length, 0)
  assert.equal(inspection.entries.every((entry) => entry.ok === true), true)
  assert.equal(inspection.honest.noCodeExecution, true)

  const imported = importProjectPackage({
    projectsRoot: root,
    packageDir: record.packageDir,
    inspection,
    title: '导入后的项目',
    clock,
  })
  assert.equal(imported.state, 'imported')
  assert.notEqual(imported.projectId, project.paths.projectId)

  const session = await openSession({ projectsRoot: root, projectId: imported.projectId, clock })
  assert.equal(session.project.phase, 'intake')
  assert.equal(session.project.origin, 'import')
  assert.equal(session.project.lineage.sourceProjectId, project.paths.projectId)
  assert.equal(session.project.lineage.importedFromPackage, manifest.packageId)
  assert.equal(session.versions.getFinal().versionId, project.finalVersion.versionId)
  const plan = readPlanSnapshot(session.paths, String(manifest.plan.planRef))
  assert.equal(plan.planVersion, project.plan.planVersion)
  assert.equal(plan.fingerprint, manifest.plan.fingerprint)
  assert.equal(imported.editable.planReadable, true)

  // The import record is stored in the NEW project, not in the source project.
  assert.equal(listPackageRecords(session.paths).some((entry) => entry.direction === 'import'), true)
  assert.equal(listPackageRecords(project.paths).some((entry) => entry.direction === 'import'), false)
})

test('a tampered byte is reported as a hash mismatch and import stays refused', async (t) => {
  const { root, record } = setupPackage(t)
  const victim = path.join(record.packageDir, 'project', 'versions', 'index.json')
  const original = fs.readFileSync(victim, 'utf8')
  fs.writeFileSync(victim, original.replace('"currentVersionId"', '"currentVersionId"  '))
  const inspection = inspectProjectPackage({ packageDir: record.packageDir, projectsRoot: root })
  assert.equal(inspection.ok, false)
  assert.equal(inspection.verdict, 'rejected')
  assert.ok(inspection.problems.some((problem) => problem.code === 'HASH_MISMATCH'))
  assert.throws(
    () => importProjectPackage({ projectsRoot: root, packageDir: record.packageDir, inspection }),
    /通过的包检查结果/,
  )
})

test('a missing declared file, a newer format and an oversized total are all refused', (t) => {
  const { root, record } = setupPackage(t)
  const manifestPath = path.join(record.packageDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  // Missing: declare a file that does not exist.
  const missingVersion = { ...manifest, files: [...manifest.files, { path: 'project/recipes/missing.json', kind: 'recipe', bytes: 10, sha256: 'a'.repeat(64) }] }
  fs.writeFileSync(manifestPath, `${JSON.stringify(missingVersion, null, 2)}\n`)
  const missingInspection = inspectProjectPackage({ packageDir: record.packageDir })
  assert.equal(missingInspection.ok, false)
  assert.ok(missingInspection.problems.some((problem) => problem.code === 'MISSING_FILE'))

  // Too new.
  const tooNew = { ...manifest, packageFormatVersion: 99 }
  fs.writeFileSync(manifestPath, `${JSON.stringify(tooNew, null, 2)}\n`)
  const tooNewInspection = inspectProjectPackage({ packageDir: record.packageDir })
  assert.ok(tooNewInspection.problems.some((problem) => problem.code === 'FORMAT_TOO_NEW'))

  // Oversized total.
  const tooLarge = { ...manifest, totals: { files: manifest.files.length, bytes: 9 * 1024 * 1024 * 1024 } }
  fs.writeFileSync(manifestPath, `${JSON.stringify(tooLarge, null, 2)}\n`)
  const tooLargeInspection = inspectProjectPackage({ packageDir: record.packageDir })
  assert.ok(tooLargeInspection.problems.some((problem) => problem.code === 'TOO_LARGE'))

  // A broken JSON manifest is a corrupt package, not an empty one.
  fs.writeFileSync(manifestPath, '{"kind":"project-package",')
  assert.throws(() => inspectProjectPackage({ packageDir: record.packageDir }), /不是有效 JSON/)
})

test('hostile paths in an untrusted package are screened before anything is read or written', (t) => {
  const root = makeWorkspace(t, 'hostile')
  const hostileDir = path.join(root, 'hostile-package')
  fs.mkdirSync(hostileDir, { recursive: true })
  const files = [
    { path: '../escape.txt', kind: 'material-bytes', bytes: 10, sha256: '0'.repeat(64) },
    { path: 'C:/Windows/System32/config', kind: 'material-bytes', bytes: 10, sha256: '0'.repeat(64) },
    { path: '/absolute.txt', kind: 'material-bytes', bytes: 10, sha256: '0'.repeat(64) },
    { path: 'project/../../outside.txt', kind: 'material-bytes', bytes: 10, sha256: '0'.repeat(64) },
    { path: 'README', kind: 'material-bytes', bytes: 10, sha256: '0'.repeat(64) },
  ]
  const manifest = {
    kind: 'project-package',
    transport: 'folder-bundle',
    packageFormatVersion: 1,
    packageId: 'pkg_hostile',
    source: { projectId: 'prj_h', title: '恶意包', finalVersionId: 'ver_h', confirmationRef: 'cnf_h' },
    files,
    totals: { files: files.length, bytes: 50 },
  }
  fs.writeFileSync(path.join(hostileDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const inspection = inspectProjectPackage({ packageDir: hostileDir })
  assert.equal(inspection.ok, false)
  const reasons = inspection.problems.filter((problem) => problem.code === 'UNTRUSTED_ENTRY').map((problem) => problem.detail)
  assert.ok(reasons.some((reason) => reason === '../escape.txt'))
  assert.ok(inspection.problems.some((problem) => problem.code === 'UNEXPECTED_PREFIX'))
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false, '筛查阶段不得写出包外任何文件')
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false)
})

test('same-name project blocks the import until the user gives a new name; a second import is refused', async (t) => {
  const { root, record, project } = setupPackage(t, { title: '同名项目' })
  createProject({ projectsRoot: root, title: '同名项目', clock: fixedClock() })
  const inspection = inspectProjectPackage({ packageDir: record.packageDir, projectsRoot: root })
  assert.equal(inspection.ok, true, '同名不是包本身损坏；它是需要用户命名的冲突')
  assert.ok(inspection.conflicts.sameTitle.length >= 1, '源项目和新建的同名项目都应被识别')
  assert.throws(
    () => importProjectPackage({ projectsRoot: root, packageDir: record.packageDir, inspection }),
    /同名项目/,
  )
  const imported = importProjectPackage({ projectsRoot: root, packageDir: record.packageDir, inspection, title: '导入（改名）' })
  assert.notEqual(imported.projectId, project.paths.projectId)

  const secondInspection = inspectProjectPackage({ packageDir: record.packageDir, projectsRoot: root })
  assert.equal(secondInspection.ok, false)
  assert.ok(secondInspection.problems.some((problem) => problem.code === 'ALREADY_IMPORTED'))
})

test('export refuses without a final version and without a user acceptance reference', (t) => {
  const root = makeWorkspace(t, 'package-gate')
  const clock = fixedClock()
  const created = createProject({ projectsRoot: root, title: '未定稿', clock })
  assert.throws(
    () => exportProjectPackage({ paths: created.paths, finalVersion: null, destinationDir: path.join(root, 'p'), clock }),
    /定稿版本/,
  )
  assert.throws(
    () => exportProjectPackage({
      paths: created.paths,
      finalVersion: { class: 'final', versionId: 'ver_x' },
      destinationDir: path.join(root, 'p'),
      clock,
    }),
    /验收引用/,
  )
})
