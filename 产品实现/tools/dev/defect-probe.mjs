/**
 * C06 缺陷复现探针：把独立审计报告指出的缺陷逐条复现成可执行证据。
 *
 * 为什么需要这个文件：129 个用例全绿却漏掉了这些缺陷，说明**测试本身有盲区**。复现脚本先用
 * "错误输入"把缺陷逼出来，修复后再跑一遍必须全部消失 —— 这样修复是可验证的，不是靠声明。
 *
 * 用法：node tools/dev/defect-probe.mjs
 * 退出码：0 = 全部已修复（无缺陷复现）；1 = 仍有缺陷复现。
 *
 * @module tools/dev/defect-probe
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock, sha256 } from '../../base/index.js'
import { buildCatalog } from '../catalog.js'
import { ToolPaths } from '../paths.js'
import { ToolStateStore, deriveToolStatus } from '../state.js'
import { TaskStore } from '../tasks.js'
import { ToolLifecycle } from '../install.js'
import { createToolKernel } from '../index.js'
import { CatalogClass, TaskState, ToolStatus, VerificationStatus } from '../schema.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const TOOLS = path.join(ROOT, 'tools')

const scratch = path.join(os.tmpdir(), `dsh-avw-c06-defects-${process.pid}`)
fs.mkdirSync(scratch, { recursive: true })

/** @type {Array<{ id: string, title: string, reproduced: boolean, detail: string }>} */
const findings = []
/** @param {string} id @param {string} title @param {boolean} reproduced @param {string} detail */
const record = (id, title, reproduced, detail) => {
  findings.push({ id, title, reproduced, detail })
  const mark = reproduced ? 'REPRODUCED' : 'fixed     '
  process.stdout.write(`${mark}  ${id}  ${title}\n           ${detail}\n`)
}

/** A frozen-but-advancing clock. */
const clock = () => new Clock({ mode: 'manual', start: 1_700_000_000_000, stepMs: 1 })

/**
 * A tool fixture whose version check expects exactly `1.0.0`.
 * @param {string} expectedBuild
 */
function makeCatalog(expectedBuild = '1.0.0') {
  return buildCatalog({
    packs: [
      {
        packId: 'demo-pack',
        version: '1.0.0',
        displayName: 'Demo pack',
        pluginCode: { license: 'MIT', components: ['adapter'] },
        tools: [
          {
            toolId: 'demo-tool',
            displayName: 'Demo tool',
            supportClass: 'external',
            catalogClass: 'official',
            channel: 'cli',
            supportedVersions: '>=1.0.0 <2.0.0',
            permissions: ['filesystem', 'process'],
            detection: { mode: 'files-only', manifestFiles: ['manifest.json'], executables: ['bin/demo.exe'] },
            verificationChecks: [
              { id: 'manifest', kind: 'file-exists', relativePath: 'manifest.json', description: 'manifest' },
              {
                id: 'version',
                kind: 'version-match',
                expectedBuild,
                command: 'demo',
                args: ['--version'],
                description: 'version matches',
              },
            ],
            license: {
              spdx: 'Apache-2.0',
              class: 'external',
              conditions: ['不随插件包分发'],
              evidenceRef: 'fixture',
            },
            effects: { effects: [], network: false, dataSubmission: false, registration: false, fee: null },
            source: { kind: 'manual-only', publisher: 'fixture' },
            manualGuidance: { steps: ['自行安装 demo'] },
            rollback: { strategy: 'previous-build', retainedVersions: 1, instructions: '切换回上一个版本' },
          },
        ],
        capabilities: [
          {
            capabilityId: 'demo-cap',
            displayName: 'Demo capability',
            userOutcome: 'do the thing',
            requires: [{ toolId: 'demo-tool' }],
          },
        ],
      },
    ],
  })
}

/** An install directory containing just enough to be located. */
function makeInstall(label) {
  const root = path.join(scratch, `install-${label}-${Math.random().toString(16).slice(2, 8)}`)
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":"1.0.0"}')
  fs.writeFileSync(path.join(root, 'bin', 'demo.exe'), 'demo-binary')
  return root
}

/** A paths + stores + lifecycle bundle in a fresh directory. */
function makeContext(catalog = makeCatalog()) {
  const root = path.join(scratch, `ctx-${Math.random().toString(16).slice(2, 8)}`)
  const paths = new ToolPaths({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(root, 'plugin'),
    projectsRoot: path.join(root, 'projects'),
  })
  paths.assertIsolated()
  paths.ensureLayout()
  const c = clock()
  const states = new ToolStateStore(paths, { clock: c })
  const tasks = new TaskStore(paths, { clock: c })
  const lifecycle = new ToolLifecycle({ paths, catalog, tasks, states, clock: c })
  return { root, paths, catalog, states, tasks, lifecycle }
}

/** Plan + authorize an adoption. */
function authorizedAdoption(context, install, version = '1.0.0') {
  const plan = context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: version })
  const created = context.lifecycle.createAdoptionTask(plan)
  context.tasks.authorize({
    taskId: created.task.taskId,
    planHash: created.task.planHash,
    action: 'adopt-install',
    scope: `adopt demo-tool ${version}`,
    grantedBy: '用户回答',
  })
  return created.task
}

/** An executor that reports a caller-chosen version banner, and is properly authorized. */
function authorizedLyingExecutor(reported) {
  return {
    marksTestDouble: false,
    // A valid authorization id, so V-01's version comparison runs rather than being blocked by V-02's gate.
    authorizationId: 'auth-probe-legit',
    async runVersionProbe() {
      return { exitCode: 0, stdout: `demo version ${reported}`, authorizationId: 'auth-probe-legit' }
    },
  }
}

// -------------------------------------------------------------------------------------------
// V-01: 版本核对是子串匹配，错误版本会被判为一致
// -------------------------------------------------------------------------------------------
async function probeV01() {
  const context = makeContext()
  const install = makeInstall('v01')
  const task = authorizedAdoption(context, install, '1.0.0')
  // "11.0.0" 里包含 "1.0.0"；"1.0.0-rc1" 里也包含 "1.0.0"。执行器带合法授权，所以版本比对本身会被执行。
  const result = await context.lifecycle.runAdoption(task.taskId, { executor: authorizedLyingExecutor('11.0.0') })
  const checks = result.verification?.checks ?? []
  const versionCheck = checks.find((check) => check.id === 'version')
  const reproduced = versionCheck?.ok === true
  // 再验一次预发布后缀：1.0.0-rc1 不得等同于 1.0.0。
  const rcContext = makeContext()
  const rcInstall = makeInstall('v01rc')
  const rcTask = authorizedAdoption(rcContext, rcInstall, '1.0.0')
  const rcResult = await rcContext.lifecycle.runAdoption(rcTask.taskId, {
    executor: authorizedLyingExecutor('1.0.0-rc1'),
  })
  const rcCheck = (rcResult.verification?.checks ?? []).find((check) => check.id === 'version')
  const rcReproduced = rcCheck?.ok === true
  record(
    'V-01',
    '版本核对使用子串匹配（11.0.0 / 1.0.0-rc1 被判为符合 1.0.0）',
    reproduced || rcReproduced,
    `11.0.0 → ${String(versionCheck?.detail)}；1.0.0-rc1 → ${String(rcCheck?.detail)}`,
  )
}

// -------------------------------------------------------------------------------------------
// V-02: 验证路径没有执行器闸门（detect 有，verify 没有）
// -------------------------------------------------------------------------------------------
async function probeV02() {
  const context = makeContext()
  const install = makeInstall('v02')
  const task = authorizedAdoption(context, install, '1.0.0')
  // 一个没有 marksTestDouble、没有 authorizationId 的裸对象。
  const naked = {
    async runVersionProbe() {
      return { exitCode: 0, stdout: 'demo version 1.0.0' }
    },
  }
  let accepted = false
  let detail = ''
  try {
    const result = await context.lifecycle.runAdoption(task.taskId, { executor: naked })
    accepted = result.ok === true || result.verification?.basis === 'real-tool'
    detail = `result.ok=${String(result.ok)} basis=${String(result.verification?.basis)}`
  } catch (error) {
    detail = `已被拒绝：${error.code ?? ''} ${error.message}`
  }
  record('V-02', '验证路径未校验执行器授权（裸对象即可被采信为 real-tool）', accepted, detail)
}

// -------------------------------------------------------------------------------------------
// V-05: markDetectionStarted 无清理，检测失败即永久卡在 checking
// -------------------------------------------------------------------------------------------
async function probeV05() {
  const root = path.join(scratch, `v05-${Math.random().toString(16).slice(2, 8)}`)
  const kernel = createToolKernel({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(ROOT),
    projectsRoot: path.join(root, 'projects'),
    clock: clock(),
  })
  let threw = false
  try {
    // 相对路径是非法参数，应在任何状态写入之前被拒绝。
    await kernel.detect({ toolId: 'ffmpeg', at: 'relative/path' })
  } catch {
    threw = true
  }
  const status = kernel.describe().toolStatuses.ffmpeg
  const inFlight = kernel.states.read('ffmpeg').detectionInFlight
  const reproduced = threw && (inFlight === true || status === ToolStatus.CHECKING)
  record(
    'V-05',
    '检测参数非法后工具永久卡在 checking（检测未清理进行中标记）',
    reproduced,
    `抛出=${String(threw)} inFlight=${String(inFlight)} status=${String(status)}`,
  )
}

// -------------------------------------------------------------------------------------------
// V-06: 终态可被反向改写（取消的任务能变 completed）
// -------------------------------------------------------------------------------------------
function probeV06() {
  const context = makeContext()
  const install = makeInstall('v06')
  const task = authorizedAdoption(context, install, '1.0.0')
  context.lifecycle.cancel(task.taskId, { reason: '用户取消' })
  let becameCompleted = false
  let detail = ''
  try {
    context.tasks.transition(task.taskId, TaskState.COMPLETED)
    becameCompleted = context.tasks.read(task.taskId).state === TaskState.COMPLETED
    detail = `取消后 transition('completed') -> ${context.tasks.read(task.taskId).state}`
  } catch (error) {
    detail = `已被拒绝：${error.code ?? ''} ${error.message}`
  }
  record('V-06', '终态任务可被反向改写（取消后能变成已完成）', becameCompleted, detail)
}

// -------------------------------------------------------------------------------------------
// V-07: 研究候选可进入采纳流程
// -------------------------------------------------------------------------------------------
function probeV07() {
  const root = path.join(scratch, `v07-${Math.random().toString(16).slice(2, 8)}`)
  const kernel = createToolKernel({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(ROOT),
    projectsRoot: path.join(root, 'projects'),
    clock: clock(),
  })
  const install = makeInstall('v07-editly')
  let planBuilt = false
  let detail = ''
  try {
    const plan = kernel.planAdoption({ toolId: 'editly', location: install, targetVersion: '0.5.0' })
    planBuilt = plan?.kind === 'adopt'
    detail = `成功生成采纳方案：kind=${String(plan?.kind)}，披露字段 ${Object.keys(plan?.disclosure ?? {}).length} 个`
  } catch (error) {
    detail = `已被拒绝：${error.code ?? ''} ${error.message}`
  }
  record('V-07', '研究候选可进入采纳流程（流程层未拦截）', planBuilt, detail)
}

// -------------------------------------------------------------------------------------------
// V-08: schema 指纹漂移检测无产品调用方（死代码）
// -------------------------------------------------------------------------------------------
function probeV08() {
  // 判据是"产品路径上是否有地方把实时读到的描述算成指纹再传给推导"，而不是统计字面量出现次数：
  // index.js 的 BUG 修复后是 statusOf/detect 接收 description 并自己算指纹，这是真正的产品接线。
  const indexText = fs.readFileSync(path.join(TOOLS, 'index.js'), 'utf8')
  const wired =
    /schemaFingerprint\(\{/.test(indexText) && /statusOf\(\s*id,\s*\{\s*description/.test(indexText.replace(/\s+/g, ' '))
  // 还要确认它真的被用作 expectSchemaFingerprint 的输入。
  const feedsDerivation = /expectSchemaFingerprint:\s*expectedFingerprint/.test(indexText)
  const reproduced = !(wired && feedsDerivation)
  record(
    'V-08',
    'schema 指纹漂移检测无产品调用方（只有单测传参）',
    reproduced,
    `产品路径自行计算指纹=${String(wired)}，并作为推导输入=${String(feedsDerivation)}`,
  )
}

// -------------------------------------------------------------------------------------------
// V-09: CT-14 ToolExecutionProtocol 无产品调用方
// -------------------------------------------------------------------------------------------
function probeV09() {
  /** @type {string[]} */
  const unused = []
  for (const fn of ['beginExecution', 'endExecution', 'resolveExecutionRoute', 'assertPermissions']) {
    let callers = 0
    for (const name of fs.readdirSync(TOOLS).filter((n) => n.endsWith('.js'))) {
      if (name === 'channels.js' || name === 'index.js') continue
      const text = fs.readFileSync(path.join(TOOLS, name), 'utf8')
      callers += (text.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) ?? []).length
    }
    if (callers === 0) unused.push(fn)
  }
  record(
    'V-09',
    'ToolExecutionProtocol 的函数无产品调用方',
    unused.length > 0,
    unused.length === 0 ? '全部已接线' : `零调用方：${unused.join('、')}`,
  )
}

// -------------------------------------------------------------------------------------------
// 测试盲区: 进程扫描不递归，漏掉 tools/dev/
// -------------------------------------------------------------------------------------------
function probeScanGap() {
  const ISOLATION_TEST = path.join(ROOT, 'tests', 'integration', 'tools-isolation-impact.test.mjs')
  const text = fs.readFileSync(ISOLATION_TEST, 'utf8')
  // 守卫测试自己的 collectModuleFiles 只 readdirSync，不递归。
  const nonRecursive = /function collectModuleFiles\(\)[\s\S]*?readdirSync\(TOOLS_SRC\)/.test(text)
  // 而 dev/ 下确实有 child_process。
  const devHasSpawn = fs
    .readdirSync(path.join(TOOLS, 'dev'))
    .filter((name) => name.endsWith('.mjs'))
    .some((name) => fs.readFileSync(path.join(TOOLS, 'dev', name), 'utf8').includes("from 'node:child_process'"))
  const reproduced = nonRecursive && devHasSpawn
  record(
    'SCAN',
    '进程／网络扫描不递归，漏掉 tools/dev/ 的真实 spawn',
    reproduced,
    `测试不递归=${String(nonRecursive)}，dev/ 含 child_process=${String(devHasSpawn)}`,
  )
}

async function main() {
  process.stdout.write('C06 缺陷复现探针\n')
  process.stdout.write(`${'='.repeat(70)}\n`)
  try {
    await probeV01()
    await probeV02()
    await probeV05()
    probeV06()
    probeV07()
    probeV08()
    probeV09()
    probeScanGap()
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  const reproduced = findings.filter((finding) => finding.reproduced)
  process.stdout.write(`${'='.repeat(70)}\n`)
  process.stdout.write(`仍可复现的缺陷：${reproduced.length} / ${findings.length}\n`)
  if (reproduced.length > 0) {
    process.stdout.write(`列出：${reproduced.map((finding) => finding.id).join('、')}\n`)
  }
  process.exit(reproduced.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(2)
})
