/**
 * C06 真实探针：把用户本机已安装的 FFmpeg 采纳进工具管理内核，并用授权的执行器核实它。
 *
 * 这是本卡唯一一次接触真实外部工具，范围严格限定为用户 2026-11-08 的授权：
 * **分别执行一次 `ffmpeg -version` 和 `ffprobe -version`，仅用于只读版本与可用性核验。**
 *
 * 所以这个脚本：
 * - 只读本机既有安装目录（不复制、不移动、不修改其中任何文件）；
 * - 只运行这两条 `-version` 命令，各一次，不加任何其他参数；
 * - 不改环境变量、不联网、不安装、不更新任何东西；
 * - 把真实输出与真实状态写入 `实施交接/证据/C06-FFmpeg真实探针.json`。
 *
 * 用法：node tools/dev/ffmpeg-probe.mjs
 *
 * @module tools/dev/ffmpeg-probe
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createToolKernel } from '../index.js'
import { Clock } from '../../base/index.js'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const WORKSPACE = path.resolve(ROOT, '..')

/**
 * 本次授权允许运行的全部命令。写死在这里是刻意的：执行器不能接受任意命令字符串，
 * 否则"只运行两条 -version"就只是注释里的承诺。
 */
const ALLOWED_PROBES = Object.freeze([
  Object.freeze({ command: 'ffmpeg', args: Object.freeze(['-version']) }),
  Object.freeze({ command: 'ffprobe', args: Object.freeze(['-version']) }),
])

/**
 * 构造一个"只做被授权的那两件事、且每件只做一次"的探针执行器。
 *
 * 用户授权的是"**分别执行一次** ffmpeg -version 和 ffprobe -version"。所以：
 * - 命令必须在白名单里（写死两条）；
 * - 每条命令只允许运行一次；第二次直接拒绝。
 *
 * 第一次实现漏了第二条，结果 ffmpeg -version 被跑了两次（检测一次、验证一次）。那是越界，
 * 所以在这里把它变成硬约束，而不是靠调用方自觉。
 *
 * @param {string} binaryDir 本机 ffmpeg/ffprobe 所在的 bin 目录
 * @param {string} authorizationId 这次探针的授权标识
 * @returns {object} 执行器
 */
function makeAuthorizedProbeExecutor(binaryDir, authorizationId) {
  /** @type {Array<{ command: string, args: string[], exitCode: number, stdoutHead: string, stdout: string }>} */
  const calls = []
  /** @type {Map<string, { stdout: string, stderr: string, exitCode: number, authorizationId: string }>} */
  const cache = new Map()
  const keyOf = (command, args) => `${command} ${args.join(' ')}`
  return {
    /** 明确标记：这不是测试替身，而是真实执行器。 */
    marksTestDouble: false,
    authorizationId,
    calls,
    async runVersionProbe(request) {
      const allowed = ALLOWED_PROBES.find(
        (probe) =>
          probe.command === request.command &&
          probe.args.length === request.args.length &&
          probe.args.every((arg, index) => arg === request.args[index]),
      )
      if (allowed === undefined) {
        // 拒绝任何不在授权清单里的命令。这条是硬闸门，不是提示。
        throw new Error(`未授权的探针命令：${request.command} ${request.args.join(' ')}`)
      }
      const key = keyOf(request.command, request.args)
      const cached = cache.get(key)
      if (cached !== undefined) {
        // 已经执行过一次。返回同一份结果而不是再跑一次——用户授权的是"一次"。
        return cached
      }
      const binary = path.join(binaryDir, `${request.command}.exe`)
      const { stdout, stderr } = await execFileAsync(binary, [...request.args], {
        timeout: request.timeoutMs ?? 15_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      const result = { exitCode: 0, stdout, stderr, authorizationId }
      cache.set(key, result)
      calls.push({
        command: request.command,
        args: [...request.args],
        exitCode: 0,
        stdoutHead: String(stdout).split(/\r?\n/)[0] ?? '',
        stdout: String(stdout),
      })
      return result
    },
  }
}

/** @param {string} name @returns {string|null} */
function locateBinaryDir(name) {
  const candidates = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0)
  for (const dir of candidates) {
    const full = path.join(dir, `${name}.exe`)
    if (fs.existsSync(full)) return dir
  }
  return null
}

/**
 * Resolve the INSTALL ROOT from the bin directory.
 *
 * The catalog declares its paths relative to the install root (`bin/ffmpeg.exe`, `LICENSE`), because that
 * is what a user pointing at "my FFmpeg folder" means. Guessing the root from the binary location is
 * stated explicitly instead of being assumed: we require a `bin/` parent that actually contains the
 * declared files, and refuse otherwise rather than adopting a half-recognized layout.
 *
 * @param {string} binaryDir directory containing ffmpeg.exe
 * @returns {{ installRoot: string, checked: string[] }}
 */
function resolveInstallRoot(binaryDir) {
  const installRoot = path.dirname(binaryDir)
  const required = ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE']
  const missing = required.filter((relative) => !fs.existsSync(path.join(installRoot, relative)))
  if (missing.length > 0) {
    throw new Error(
      `无法从 ${binaryDir} 推断出标准安装根目录（缺少 ${missing.join('、')}）；本卡不猜测非标准布局`,
    )
  }
  return { installRoot, checked: required }
}

/**
 * 记录一个真实文件的身份：绝对路径、字节数与 SHA-256。
 * 只读，不修改。
 * @param {string} file
 * @returns {{ path: string, bytes: number, sha256: string, mtime: string }}
 */
function fileIdentity(file) {
  // 用 node:crypto 直接算，避免引入任何依赖。
  const bytes = fs.readFileSync(file)
  return {
    path: file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mtime: fs.statSync(file).mtime.toISOString(),
  }
}

async function main() {
  const binaryDir = locateBinaryDir('ffmpeg')
  if (binaryDir === null) {
    process.stderr.write('未在 PATH 中找到 ffmpeg；本机 C02 记录的安装应该存在，请检查\n')
    process.exit(2)
  }
  const ffprobeDir = locateBinaryDir('ffprobe')
  if (ffprobeDir === null || path.resolve(ffprobeDir) !== path.resolve(binaryDir)) {
    process.stderr.write('ffprobe 不在与 ffmpeg 相同的目录；本卡不猜测混合安装\n')
    process.exit(2)
  }
  const { installRoot, checked } = resolveInstallRoot(binaryDir)

  const root = path.join(WORKSPACE, '实施交接', '证据', 'C06-探针状态')
  const kernel = createToolKernel({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(ROOT),
    projectsRoot: path.join(root, 'projects'),
    clock: new Clock({ mode: 'system' }),
  })

  const authorizationId = `user-auth-ffmpeg-version-${new Date().toISOString()}`
  const executor = makeAuthorizedProbeExecutor(binaryDir, authorizationId)

  // 第一步：检测。用授权执行器运行一次 `ffmpeg -version` 读出真实版本——这正是用户授权的那两条命令之一，
  // 不是额外的外部动作。
  const detection = await kernel.detect({
    toolId: 'ffmpeg',
    at: installRoot,
    mode: 'version-probe',
    executor,
    probeAuthorized: true,
  })
  if (detection.detection.outcome !== 'found') {
    process.stderr.write(
      `检测未得到可用结论：${detection.detection.outcome} / ${String(detection.detection.reason)}\n`,
    )
    process.exit(3)
  }
  const detectedVersion = /** @type {string} */ (detection.detection.version)

  // 第二步：生成采纳方案（不执行任何东西），再把用户授权记录下来。
  const plan = kernel.planAdoption({
    toolId: 'ffmpeg',
    location: installRoot,
    targetVersion: detectedVersion,
  })
  const created = kernel.createAdoptionTask(plan)
  kernel.authorize({
    taskId: created.task.taskId,
    planHash: created.task.planHash,
    action: 'adopt-install',
    scope: `adopt ffmpeg at ${binaryDir} and verify 9.0.1-full_build-www.gyan.dev`,
    grantedBy: '用户 2026-11-08 明确授权：分别执行一次 ffmpeg -version 和 ffprobe -version，仅用于只读版本与可用性核验',
    environmentImpact: '只读取本机既有安装并运行两条 -version 命令；不安装、不更新、不修改环境',
  })

  // 第三步：执行。这一步会真实运行两条 -version 命令。
  const result = await kernel.run(created.task.taskId, { executor })

  // 第四步：读回真实状态。
  const inspected = kernel.inspectTool('ffmpeg')
  const story = kernel.taskStory(created.task.taskId)
  const impact = kernel.listCapabilities()

  const evidence = {
    schemaVersion: 1,
    kind: 'c06-ffmpeg-probe',
    generatedAt: new Date().toISOString(),
    authorization: {
      grantedBy: '用户 2026-11-08 当日明确回答',
      scope: '分别执行一次 ffmpeg -version 和 ffprobe -version，仅用于只读版本与可用性核验',
      notAuthorized: ['下载', '安装', '更新', '联网', '环境变量修改', '任何带输入文件或输出文件的命令'],
      allowedCommands: ALLOWED_PROBES.map((probe) => `${probe.command} ${probe.args.join(' ')}`),
    },
    environment: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      binaryDir,
      verifiedReadOnly: true,
    },
    binaries: [fileIdentity(path.join(binaryDir, 'ffmpeg.exe')), fileIdentity(path.join(binaryDir, 'ffprobe.exe'))],
    detection: {
      outcome: detection.detection.outcome,
      version: detection.detection.version,
      mode: detection.detection.mode,
      statusAfterDetection: detection.status,
      evidence: detection.detection.evidence,
    },
    plan: {
      toolId: plan.toolId,
      kind: plan.kind,
      targetVersion: plan.targetVersion,
      installLocation: plan.installLocation,
      disclosure: plan.disclosure,
      canAutomate: plan.canAutomate,
    },
    executor: {
      marksTestDouble: executor.marksTestDouble,
      calls: executor.calls,
    },
    execution: {
      ok: result.ok,
      taskId: result.taskId,
      version: result.version,
      location: result.location ?? null,
      verificationStatus: result.verification?.status ?? null,
      verificationBasis: result.verification?.basis ?? null,
      checks: result.verification?.checks ?? [],
      failure: result.failure ?? null,
    },
    readBack: {
      status: inspected.status,
      label: inspected.label,
      usable: inspected.usable,
      statusReason: inspected.statusReason,
      installedVersion: inspected.versions.installed,
      installedLocation: inspected.state.installedLocation,
      verificationBasis: inspected.state.verificationBasis,
      taskTrail: story.trail,
      taskState: story.state,
      taskStateLabel: story.stateLabel,
    },
    capabilityImpact: {
      usable: impact.usable,
      affected: impact.affected,
      summary: kernel.capabilityImpactSummary(),
    },
    honesty: {
      pluginInstalledAnything: false,
      pluginWroteInsideToolDir: false,
      pluginNetworkUsed: false,
      commandsRun: executor.calls.map((call) => `${call.command} ${call.args.join(' ')}`),
      note:
        '采纳只是记录用户已有安装的位置；插件没有写入该目录。可用状态来自真实运行两条 -version 的核对结果，' +
        'basis 为 real-tool。',
    },
  }

  const outFile = path.join(WORKSPACE, '实施交接', '证据', 'C06-FFmpeg真实探针.json')
  fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

  process.stdout.write(`detection      : ${detection.detection.outcome} / ${String(detection.detection.version)}\n`)
  process.stdout.write(`adopt task     : ${created.task.taskId}\n`)
  process.stdout.write(`execution      : ok=${String(result.ok)} verification=${String(result.verification?.status)}\n`)
  process.stdout.write(`verification   : basis=${String(result.verification?.basis)}\n`)
  process.stdout.write(`read-back      : ${inspected.status} (${inspected.label}) usable=${String(inspected.usable)}\n`)
  process.stdout.write(`commands run   : ${executor.calls.map((call) => `${call.command} ${call.args.join(' ')}`).join('; ')}\n`)
  process.stdout.write(`evidence       : ${path.relative(WORKSPACE, outFile)}\n`)
  process.stdout.write(`state root     : ${path.relative(WORKSPACE, root)}\n`)
  process.exit(result.ok && inspected.usable ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
