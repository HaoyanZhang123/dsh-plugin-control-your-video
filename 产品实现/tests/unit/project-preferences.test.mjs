/**
 * Unit tests for core/project/preferences.js.
 *
 * The claims being pinned (CT-03 §7, C10 card §4.1):
 * - exactly five groups exist, and a sixth/unknown group is refused;
 * - the two scopes stay separate ON DISK, and a resolution states which scope won;
 * - a project override wins over global and is reported as `project-override`, while a global
 *   change never shows up as a project override;
 * - blanket authorization cannot be expressed as a preference, by key OR by value;
 * - a corrupt file is REPORTED and preserved, never silently reset to `{}`.
 *
 * Real files in a managed temp directory are used, because "the two scopes stay separate on disk"
 * is a claim about bytes, not about an in-memory object.
 *
 * @module tests/unit/project-preferences.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, createTempDir } from '../../base/index.js'
import { ProjectPaths } from '../../core/project/paths.js'
import {
  NeedsAttentionCode,
  PreferenceGroup,
  PreferenceScope,
} from '../../core/project/schema.js'
import { newId } from '../../core/project/ids.js'
import { ProjectEventKind, readEvents } from '../../core/project/events.js'
import {
  BLANKET_AUTHORIZATION_REFUSAL,
  DEFAULT_PREFERENCES,
  GLOBAL_PREFERENCES_FILE_NAME,
  PREFERENCE_KEYS,
  PREFERENCE_SPEC,
  PROJECT_PREFERENCES_PATH,
  PreferenceKey,
  ResolvedPreferenceSource,
  SCOPE_LABELS,
  assertPreferenceKey,
  assertPreferenceValue,
  clearProjectOverride,
  describePreferencesHealth,
  globalPreferencesPath,
  preferenceGroupOf,
  projectPreferencesPath,
  readGlobalPreferences,
  readProjectPreferences,
  resolve,
  resolveAllPreferences,
  resolvePreference,
  setGlobal,
  setGlobalPreference,
  setProject,
  setProjectPreference,
} from '../../core/project/preferences.js'

const temp = createTempDir({ label: 'project-preferences' })
test.after(() => temp.dispose())

/** A frozen clock so revisions and timestamps are stable. */
const frozenClock = () => new Clock({ mode: 'frozen', start: 1_700_000_000_000 })

/**
 * Create a project plus its own settings directory (so each test is isolated on disk).
 * @param {string} label
 * @returns {{ paths: ProjectPaths, globalPath: string, settingsDir: string }}
 */
function freshEnvironment(label) {
  const root = temp.dir(`projects-${label}`)
  const settingsDir = temp.dir(`settings-${label}`)
  const paths = new ProjectPaths(root, newId('project'))
  fs.mkdirSync(paths.dir, { recursive: true })
  return { paths, globalPath: globalPreferencesPath(settingsDir), settingsDir }
}

test('groups: exactly the five frozen groups exist', () => {
  const groups = new Set(Object.values(PreferenceGroup))
  assert.deepEqual(
    [...groups].sort(),
    ['creation', 'data-authorization', 'notification', 'storage', 'workspace'],
  )
  assert.equal(groups.size, 5)

  for (const key of PREFERENCE_KEYS) {
    assert.ok(groups.has(PREFERENCE_SPEC[key].group), `偏好键 ${key} 必须属于五个组之一`)
    assert.equal(preferenceGroupOf(key), PREFERENCE_SPEC[key].group)
  }
  const usedGroups = new Set(PREFERENCE_KEYS.map((key) => PREFERENCE_SPEC[key].group))
  assert.equal(usedGroups.size, 5, '五个组都必须有可用的默认偏好')
})

test('groups: a sixth or unknown group is refused', () => {
  const unknownGroups = ['blanket.all', 'approval.unrestricted', 'security.none', 'creationx.a']
  for (const key of unknownGroups) {
    assert.throws(
      () => preferenceGroupOf(key),
      (error) => error.code === 'VALIDATION_FAILED' && /不在允许取值内/.test(error.message),
      `应拒绝未知分组: ${key}`,
    )
  }
  assert.throws(() => preferenceGroupOf('nogroupdot'), { code: 'VALIDATION_FAILED' })
  assert.throws(() => preferenceGroupOf(''), { code: 'VALIDATION_FAILED' })
  assert.throws(() => preferenceGroupOf(42), { code: 'VALIDATION_FAILED' })
})

test('groups: a known group with an unknown name is refused', () => {
  assert.throws(() => assertPreferenceKey('creation.not-a-real-preference'), {
    code: 'VALIDATION_FAILED',
  })
  assert.throws(() => assertPreferenceKey('notification.always-allow'), {
    code: 'VALIDATION_FAILED',
  })
})

test('defaults: the canonical table is documented and used when nothing is stored', () => {
  const { globalPath, paths } = freshEnvironment('defaults')
  for (const key of PREFERENCE_KEYS) {
    const resolved = resolvePreference({ key, globalPath, projectPaths: paths })
    assert.equal(resolved.source, ResolvedPreferenceSource.DEFAULT)
    assert.equal(resolved.value, DEFAULT_PREFERENCES[key])
    assert.equal(resolved.label, SCOPE_LABELS.default)
    assert.equal(resolved.ok, true)
  }
  assert.equal(DEFAULT_PREFERENCES[PreferenceKey.CREATION_ASPECT_RATIO], '16:9')
  assert.equal(DEFAULT_PREFERENCES[PreferenceKey.CREATION_FRAME_RATE], 30)
  assert.equal(DEFAULT_PREFERENCES[PreferenceKey.DATA_AUTHORIZATION_DEFAULT], 'ask-each-time')
  assert.equal(DEFAULT_PREFERENCES[PreferenceKey.WORKSPACE_CONFIRM_BEFORE_DESTRUCTIVE], true)
})

test('scopes: the global file and the project override are two different real files', () => {
  const { globalPath, paths } = freshEnvironment('two-files')
  setGlobalPreference({
    key: PreferenceKey.CREATION_ASPECT_RATIO,
    value: '9:16',
    globalPath,
    clock: frozenClock(),
  })
  setProjectPreference({
    key: PreferenceKey.NOTIFICATION_VERBOSITY,
    value: 'detailed',
    projectPaths: paths,
    clock: frozenClock(),
  })

  assert.ok(fs.existsSync(globalPath))
  assert.equal(path.basename(globalPath), GLOBAL_PREFERENCES_FILE_NAME)
  const projectFile = projectPreferencesPath(paths)
  assert.ok(fs.existsSync(projectFile))
  assert.notEqual(projectFile, globalPath)
  assert.ok(
    projectFile.startsWith(paths.dir),
    '项目覆盖必须保存在项目目录内，才能随项目一起移动',
  )
  assert.equal(PROJECT_PREFERENCES_PATH, 'preferences/preferences.json')

  const globalDocument = JSON.parse(fs.readFileSync(globalPath, 'utf8'))
  const projectDocument = JSON.parse(fs.readFileSync(projectFile, 'utf8'))
  assert.equal(globalDocument.kind, 'global-preferences')
  assert.equal(projectDocument.kind, 'project-preferences')
  assert.equal(projectDocument.projectId, paths.projectId)
  assert.deepEqual(Object.keys(globalDocument.values), [PreferenceKey.CREATION_ASPECT_RATIO])
  assert.deepEqual(Object.keys(projectDocument.values), [PreferenceKey.NOTIFICATION_VERBOSITY])
  assert.equal(projectDocument.values[PreferenceKey.CREATION_ASPECT_RATIO], undefined)
})

test('resolve: a project override wins over global and reports its scope', () => {
  const { globalPath, paths } = freshEnvironment('override-wins')
  const key = PreferenceKey.CREATION_ASPECT_RATIO
  setGlobalPreference({ key, value: '9:16', globalPath, clock: frozenClock() })
  setProjectPreference({ key, value: '1:1', projectPaths: paths, clock: frozenClock() })

  const resolved = resolvePreference({ key, globalPath, projectPaths: paths })
  assert.equal(resolved.value, '1:1', '项目覆盖优先')
  assert.equal(resolved.source, ResolvedPreferenceSource.PROJECT_OVERRIDE)
  assert.equal(resolved.label, '仅本项目')
  assert.equal(resolved.projectValue, '1:1')
  assert.equal(resolved.globalValue, '9:16')
  assert.equal(resolved.defaultValue, '16:9')

  // Global-only resolution of the same key still sees the global value.
  const globalOnly = resolvePreference({ key, globalPath })
  assert.equal(globalOnly.value, '9:16')
  assert.equal(globalOnly.source, ResolvedPreferenceSource.GLOBAL)
})

test('resolve: a global change never appears as a project override', () => {
  const { globalPath, paths } = freshEnvironment('global-not-project')
  const key = PreferenceKey.NOTIFICATION_ON_COMPLETION
  setGlobalPreference({ key, value: false, globalPath, clock: frozenClock() })

  const resolved = resolvePreference({ key, globalPath, projectPaths: paths })
  assert.equal(resolved.source, ResolvedPreferenceSource.GLOBAL)
  assert.equal(resolved.value, false)
  assert.equal(resolved.projectValue, undefined, '全局修改不得被记成项目覆盖')
  assert.equal(readProjectPreferences(paths).exists, false, '项目文件不应因为全局修改而被创建')

  const projectDocument = readProjectPreferences(paths)
  assert.deepEqual(projectDocument.values, {})
  const resolvedForOtherKey = resolvePreference({
    key: PreferenceKey.NOTIFICATION_VERBOSITY,
    globalPath,
    projectPaths: paths,
  })
  assert.equal(resolvedForOtherKey.source, ResolvedPreferenceSource.DEFAULT, '另一项仍是内置默认')
})

test('resolve: clearing a project override falls back to global, then to default', () => {
  const { globalPath, paths } = freshEnvironment('clear')
  const key = PreferenceKey.CREATION_FRAME_RATE
  setGlobalPreference({ key, value: 25, globalPath, clock: frozenClock() })
  setProjectPreference({ key, value: 60, projectPaths: paths, clock: frozenClock() })
  assert.equal(
    resolvePreference({ key, globalPath, projectPaths: paths }).source,
    ResolvedPreferenceSource.PROJECT_OVERRIDE,
  )

  const cleared = clearProjectOverride({ key, projectPaths: paths, clock: frozenClock() })
  assert.equal(cleared.removed, true)
  assert.equal(cleared.previousValue, 60)

  const afterClear = resolvePreference({ key, globalPath, projectPaths: paths })
  assert.equal(afterClear.value, 25)
  assert.equal(afterClear.source, ResolvedPreferenceSource.GLOBAL)

  // Clearing again is refused: "cleared" and "never set" are different facts.
  assert.throws(() => clearProjectOverride({ key, projectPaths: paths, clock: frozenClock() }), {
    code: 'NOT_FOUND',
  })

  const { globalPath: emptyGlobal, paths: otherPaths } = freshEnvironment('clear-default')
  const fallback = resolvePreference({ key, globalPath: emptyGlobal, projectPaths: otherPaths })
  assert.equal(fallback.source, ResolvedPreferenceSource.DEFAULT)
  assert.equal(fallback.value, 30)
})

test('blanket authorization: a value that would allow everything is refused', () => {
  const { globalPath, paths } = freshEnvironment('blanket-value')
  const blanketValues = ['always-allow', '*', 'unrestricted', 'allow-all', 'any']
  for (const value of blanketValues) {
    assert.throws(
      () =>
        setGlobalPreference({
          key: PreferenceKey.DATA_AUTHORIZATION_DEFAULT,
          value,
          globalPath,
          clock: frozenClock(),
        }),
      (error) => error.code === 'VALIDATION_FAILED' && error.message === BLANKET_AUTHORIZATION_REFUSAL,
      `应拒绝“永远允许一切”的取值: ${value}`,
    )
    assert.throws(
      () =>
        setProjectPreference({
          key: PreferenceKey.DATA_AUTHORIZATION_EXTERNAL_SERVICE,
          value,
          projectPaths: paths,
          clock: frozenClock(),
        }),
      (error) => error.message === BLANKET_AUTHORIZATION_REFUSAL,
    )
  }
  assert.equal(fs.existsSync(globalPath), false, '被拒绝的写入不得创建全局文件')
  assert.equal(readProjectPreferences(paths).exists, false, '被拒绝的写入不得创建项目文件')
})

test('blanket authorization: a wildcard key is refused', () => {
  const { globalPath, paths } = freshEnvironment('blanket-key')
  for (const key of ['data-authorization.*', 'data-authorization.all', 'creation.any-style']) {
    assert.throws(
      () => setGlobalPreference({ key, value: 'deny', globalPath, clock: frozenClock() }),
      { code: 'VALIDATION_FAILED' },
    )
    assert.throws(
      () => setProjectPreference({ key, value: 'deny', projectPaths: paths, clock: frozenClock() }),
      { code: 'VALIDATION_FAILED' },
    )
  }
  assert.equal(fs.existsSync(globalPath), false)
})

test('data-authorization: only the two honest choices are accepted', () => {
  const { globalPath } = freshEnvironment('data-auth')
  for (const value of ['ask-each-time', 'deny']) {
    const written = setGlobalPreference({
      key: PreferenceKey.DATA_AUTHORIZATION_DEFAULT,
      value,
      globalPath,
      clock: frozenClock(),
    })
    assert.equal(written.value, value)
    assert.equal(written.scope, PreferenceScope.GLOBAL)
  }
  assert.throws(
    () =>
      setGlobalPreference({
        key: PreferenceKey.DATA_AUTHORIZATION_DEFAULT,
        value: 'allow',
        globalPath,
        clock: frozenClock(),
      }),
    { code: 'VALIDATION_FAILED' },
  )
})

test('corrupt global file: reported as PREFERENCES_CORRUPT and left untouched', () => {
  const { globalPath, paths } = freshEnvironment('corrupt-global')
  fs.mkdirSync(path.dirname(globalPath), { recursive: true })
  const brokenText = '{"schemaVersion":1,"values":{"creation.aspect-ratio":"9:16"'
  fs.writeFileSync(globalPath, brokenText, 'utf8')
  const before = fs.readFileSync(globalPath, 'utf8')

  const read = readGlobalPreferences(globalPath)
  assert.equal(read.ok, false)
  assert.equal(read.corrupt, true)
  assert.equal(read.code, NeedsAttentionCode.PREFERENCES_CORRUPT)
  assert.deepEqual(read.values, {}, '损坏文件不得被当成空偏好静默使用')
  assert.match(read.reason, /损坏/)

  const resolved = resolvePreference({
    key: PreferenceKey.CREATION_ASPECT_RATIO,
    globalPath,
    projectPaths: paths,
  })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.corrupt, true)
  assert.equal(resolved.code, NeedsAttentionCode.PREFERENCES_CORRUPT)

  const health = describePreferencesHealth({ globalPath, projectPaths: paths })
  assert.equal(health.ok, false)
  assert.deepEqual(health.needsAttention, [NeedsAttentionCode.PREFERENCES_CORRUPT])

  // Writing over a corrupt file would destroy the user's data: it must be refused.
  assert.throws(
    () =>
      setGlobalPreference({
        key: PreferenceKey.CREATION_ASPECT_RATIO,
        value: '1:1',
        globalPath,
        clock: frozenClock(),
      }),
    { code: 'CORRUPT_DATA' },
  )

  assert.equal(fs.readFileSync(globalPath, 'utf8'), before, '损坏文件必须原样保留，不得删除或改写')
})

test('corrupt project file: reported, preserved, and a project write is refused', () => {
  const { paths } = freshEnvironment('corrupt-project')
  const projectFile = projectPreferencesPath(paths)
  fs.mkdirSync(path.dirname(projectFile), { recursive: true })
  fs.writeFileSync(projectFile, 'not json at all', 'utf8')
  const before = fs.readFileSync(projectFile, 'utf8')

  const read = readProjectPreferences(paths)
  assert.equal(read.ok, false)
  assert.equal(read.code, NeedsAttentionCode.PREFERENCES_CORRUPT)
  assert.throws(
    () =>
      setProjectPreference({
        key: PreferenceKey.WORKSPACE_SHOW_ADVANCED_PANELS,
        value: true,
        projectPaths: paths,
        clock: frozenClock(),
      }),
    { code: 'CORRUPT_DATA' },
  )
  assert.equal(fs.readFileSync(projectFile, 'utf8'), before)
})

test('corrupt values: an invalid stored value is corruption, not an empty preference set', () => {
  const { globalPath } = freshEnvironment('corrupt-values')
  fs.mkdirSync(path.dirname(globalPath), { recursive: true })
  fs.writeFileSync(
    globalPath,
    `${JSON.stringify(
      {
        kind: 'global-preferences',
        schemaVersion: 1,
        schemaGeneration: 1,
        revision: 'r000000000001-00000000',
        values: { 'creation.frame-rate': 'sixty' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const read = readGlobalPreferences(globalPath)
  assert.equal(read.ok, false)
  assert.equal(read.code, NeedsAttentionCode.PREFERENCES_CORRUPT)
  assert.deepEqual(read.values, {})
})

test('events: a project preference change appends PREFERENCES_CHANGED, a global one does not', () => {
  const { globalPath, paths } = freshEnvironment('events')
  const globalWrite = setGlobalPreference({
    key: PreferenceKey.CREATION_ASPECT_RATIO,
    value: '21:9',
    globalPath,
    clock: frozenClock(),
  })
  assert.equal(globalWrite.event, null, '全局修改没有项目可归属，不得伪造项目事件')
  assert.deepEqual(readEvents(paths.dir).events, [])

  setProjectPreference({
    key: PreferenceKey.WORKSPACE_SHOW_ADVANCED_PANELS,
    value: true,
    projectPaths: paths,
    projectVersion: 'v2',
    reason: '用户在设置里打开高级面板',
    clock: frozenClock(),
  })
  clearProjectOverride({
    key: PreferenceKey.WORKSPACE_SHOW_ADVANCED_PANELS,
    projectPaths: paths,
    clock: frozenClock(),
  })

  const { events, skipped } = readEvents(paths.dir, {
    kinds: [ProjectEventKind.PREFERENCES_CHANGED],
  })
  assert.deepEqual(skipped, [])
  assert.equal(events.length, 2)
  assert.equal(events[0].projectId, paths.projectId)
  assert.equal(events[0].actor, 'user')
  assert.equal(events[0].scope, PreferenceScope.PROJECT)
  assert.equal(events[0].detail.key, PreferenceKey.WORKSPACE_SHOW_ADVANCED_PANELS)
  assert.equal(events[0].detail.value, true)
  assert.equal(events[0].detail.projectVersion, 'v2')
  assert.equal(events[0].detail.reason, '用户在设置里打开高级面板')
  assert.equal(events[1].detail.removed, true)
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2],
  )
})

test('revisions: two writers cannot silently overwrite each other', () => {
  const { globalPath } = freshEnvironment('revision')
  const first = setGlobalPreference({
    key: PreferenceKey.CREATION_ASPECT_RATIO,
    value: '9:16',
    globalPath,
    clock: frozenClock(),
  })
  const second = setGlobalPreference({
    key: PreferenceKey.CREATION_FRAME_RATE,
    value: 25,
    globalPath,
    clock: frozenClock(),
  })
  assert.notEqual(first.revision, second.revision)
  assert.equal(second.previousValue, undefined)

  const read = readGlobalPreferences(globalPath)
  assert.equal(read.revision, second.revision)
  assert.equal(read.values[PreferenceKey.CREATION_ASPECT_RATIO], '9:16', '先前写入必须保留')
  assert.equal(read.values[PreferenceKey.CREATION_FRAME_RATE], 25)
})

test('resolveAll: every key resolves with its own stated source', () => {
  const { globalPath, paths } = freshEnvironment('resolve-all')
  setGlobalPreference({
    key: PreferenceKey.CREATION_ASPECT_RATIO,
    value: '9:16',
    globalPath,
    clock: frozenClock(),
  })
  setProjectPreference({
    key: PreferenceKey.CREATION_FRAME_RATE,
    value: 60,
    projectPaths: paths,
    clock: frozenClock(),
  })

  const all = resolveAllPreferences({ globalPath, projectPaths: paths })
  assert.equal(all.ok, true)
  assert.equal(all.values[PreferenceKey.CREATION_ASPECT_RATIO], '9:16')
  assert.equal(all.sources[PreferenceKey.CREATION_ASPECT_RATIO], ResolvedPreferenceSource.GLOBAL)
  assert.equal(all.values[PreferenceKey.CREATION_FRAME_RATE], 60)
  assert.equal(
    all.sources[PreferenceKey.CREATION_FRAME_RATE],
    ResolvedPreferenceSource.PROJECT_OVERRIDE,
  )
  assert.equal(
    all.sources[PreferenceKey.NOTIFICATION_VERBOSITY],
    ResolvedPreferenceSource.DEFAULT,
  )
  assert.equal(all.items.length, PREFERENCE_KEYS.length)
  for (const item of all.items) {
    assert.ok(PreferenceGroup[Object.keys(PreferenceGroup).find((name) => PreferenceGroup[name] === item.group)])
  }
})

test('locked preferences refuse to be turned off instead of being silently ignored', () => {
  const { globalPath } = freshEnvironment('locked')
  assert.throws(
    () =>
      setGlobalPreference({
        key: PreferenceKey.NOTIFICATION_NEEDS_ATTENTION,
        value: false,
        globalPath,
        clock: frozenClock(),
      }),
    (error) => error.code === 'VALIDATION_FAILED' && /不可关闭/.test(error.message),
    '“需要处理”通知不能被关掉',
  )
  assert.equal(fs.existsSync(globalPath), false)
})

test('validation: illegal values for each kind are refused with the real field named', () => {
  assert.throws(() => assertPreferenceValue(PreferenceKey.CREATION_ASPECT_RATIO, '2:1'), {
    code: 'VALIDATION_FAILED',
  })
  assert.throws(() => assertPreferenceValue(PreferenceKey.CREATION_FRAME_RATE, 30.5), {
    code: 'VALIDATION_FAILED',
  })
  assert.throws(() => assertPreferenceValue(PreferenceKey.NOTIFICATION_ON_COMPLETION, 'yes'), {
    code: 'VALIDATION_FAILED',
  })
  assert.throws(() => assertPreferenceValue(PreferenceKey.STORAGE_PROJECTS_ROOT, 'relative/dir'), {
    code: 'VALIDATION_FAILED',
  })
  assert.throws(
    () => assertPreferenceValue(PreferenceKey.STORAGE_CACHE_RETENTION_DAYS, 99_999),
    { code: 'VALIDATION_FAILED' },
  )
  assert.throws(() => assertPreferenceValue(PreferenceKey.CREATION_STYLE_PRESET, undefined), {
    code: 'VALIDATION_FAILED',
  })
  assert.throws(
    () => assertPreferenceValue(PreferenceKey.CREATION_STYLE_PRESET, 'x'.repeat(500)),
    { code: 'RESOURCE_LIMIT' },
  )
  // The legal ones really are accepted.
  assert.equal(assertPreferenceValue(PreferenceKey.CREATION_ASPECT_RATIO, '21:9'), '21:9')
  assert.equal(assertPreferenceValue(PreferenceKey.STORAGE_PROJECTS_ROOT, null), null)
  const absoluteRoot = path.resolve('projects-root-sample')
  assert.ok(path.isAbsolute(absoluteRoot))
  assert.equal(assertPreferenceValue(PreferenceKey.STORAGE_PROJECTS_ROOT, absoluteRoot), absoluteRoot)
})

test('paths: the global path is caller-supplied and must be absolute', () => {
  assert.throws(() => globalPreferencesPath('settings'), { code: 'VALIDATION_FAILED' })
  assert.throws(() => globalPreferencesPath(''), { code: 'VALIDATION_FAILED' })
  assert.throws(() => globalPreferencesPath(123), { code: 'VALIDATION_FAILED' })

  const { globalPath } = freshEnvironment('absolute')
  assert.ok(path.isAbsolute(globalPath))
  assert.equal(path.dirname(globalPath), path.dirname(globalPath))
  assert.throws(() => readGlobalPreferences('settings/preferences.json'), {
    code: 'VALIDATION_FAILED',
  })
  assert.throws(() => resolvePreference({ key: PreferenceKey.CREATION_ASPECT_RATIO }), {
    code: 'VALIDATION_FAILED',
  })
})

test('missing files: absence is a normal answer, not an error and not a created file', () => {
  const { globalPath, paths } = freshEnvironment('missing')
  const global = readGlobalPreferences(globalPath)
  assert.equal(global.ok, true)
  assert.equal(global.exists, false)
  assert.deepEqual(global.values, {})

  const project = readProjectPreferences(paths)
  assert.equal(project.ok, true)
  assert.equal(project.exists, false)

  const health = describePreferencesHealth({ globalPath, projectPaths: paths })
  assert.equal(health.ok, true)
  assert.deepEqual(health.needsAttention, [])
  assert.equal(fs.existsSync(globalPath), false)
  assert.equal(fs.existsSync(projectPreferencesPath(paths)), false)
})

test('project isolation: another project’s override file is refused, not applied', () => {
  const { paths: first } = freshEnvironment('isolation-a')
  const { paths: second } = freshEnvironment('isolation-b')
  setProjectPreference({
    key: PreferenceKey.WORKSPACE_SHOW_ADVANCED_PANELS,
    value: true,
    projectPaths: first,
    clock: frozenClock(),
  })
  const source = projectPreferencesPath(first)
  const target = projectPreferencesPath(second)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)

  const read = readProjectPreferences(second)
  assert.equal(read.ok, false)
  assert.equal(read.code, NeedsAttentionCode.PREFERENCES_CORRUPT)
})

test('short names resolve/setGlobal/setProject are the same one implementation', () => {
  assert.equal(resolve, resolvePreference)
  assert.equal(setGlobal, setGlobalPreference)
  assert.equal(setProject, setProjectPreference)

  const { globalPath, paths } = freshEnvironment('aliases')
  setGlobal({ key: PreferenceKey.CREATION_ASPECT_RATIO, value: '9:16', globalPath, clock: frozenClock() })
  setProject({
    key: PreferenceKey.CREATION_ASPECT_RATIO,
    value: '1:1',
    projectPaths: paths,
    clock: frozenClock(),
  })
  const resolved = resolve({
    key: PreferenceKey.CREATION_ASPECT_RATIO,
    globalPath,
    projectPaths: paths,
  })
  assert.equal(resolved.value, '1:1')
  assert.equal(resolved.source, ResolvedPreferenceSource.PROJECT_OVERRIDE)
})
