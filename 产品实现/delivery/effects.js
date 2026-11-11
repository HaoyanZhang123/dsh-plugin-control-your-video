/**
 * The pure effect library: candidates, an empty-project reproduction gate, versions and protection.
 *
 * What a "effect" is here is narrower than "an asset": only a real visual or sound effect enters,
 * and it enters as a PACKAGE — declarative source (the CompositionPlan fragment that produces the
 * pixels), the inputs it needs, the fonts and tool versions, its parameters and output spec, and a
 * rights declaration. A method, a prompt, a case study or a lesson is NOT an effect, and this module
 * has no state in which one could be stored as one.
 *
 * The reproduction gate is the only way to `ADOPTED`: the package is re-executed in an EMPTY project
 * with its own inputs, the result is probed, and the checks are recorded. A failed reproduction keeps
 * the candidate and the reason. "Same on every machine" is never claimed: a different tool build
 * requires re-validation, and the record says which build produced the passing run.
 *
 * Cross-project use is a reference, not a copy: it names the effect id and its exact version, so a
 * later update creates a NEW version while old projects keep the version they used, and deleting a
 * project can never delete an effect that another project references.
 *
 * @module delivery/effects
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
  sha256,
  writeFileAtomic,
} from '../base/index.js'
import { createMediaRuntime, probeMedia } from '../media/index.js'
import {
  DELIVERY_LIMITS,
  EFFECTS_DOCUMENT,
  EffectKind,
  EffectState,
  assertEnumValue,
  assertOptionalText,
  assertText,
  clip,
  copy,
  effectIdFor,
  effectVersionIdFor,
  slugOf,
} from './ids.js'

/** Document kind of one effect package declaration. */
export const EFFECT_DECLARATION_KIND = 'effect-package'

/** Fields a declaration must carry; a missing one is refused, not defaulted. */
const REQUIRED_DECLARATION_FIELDS = Object.freeze([
  'name',
  'kind',
  'version',
  'params',
  'output',
  'source',
  'rights',
])

/**
 * Read the effects index, or an empty one.
 * @param {string} effectsRoot absolute
 * @returns {{ doc: any, revision: string|null }}
 */
function readEffectIndex(effectsRoot) {
  const indexPath = path.join(effectsRoot, 'index.json')
  if (!fs.existsSync(indexPath)) {
    return {
      doc: { kind: EFFECTS_DOCUMENT.kind, effects: [], references: [] },
      revision: null,
    }
  }
  const bytes = fs.readFileSync(indexPath)
  if (bytes.length > 8 * 1024 * 1024) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '效果库索引过大', { details: { bytes: bytes.length } })
  }
  const parsed = JSON.parse(bytes.toString('utf8'))
  if (parsed?.kind !== EFFECTS_DOCUMENT.kind) {
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, '效果库索引 kind 不符', { details: { kind: String(parsed?.kind) } })
  }
  return {
    doc: {
      kind: EFFECTS_DOCUMENT.kind,
      revision: parsed.revision ?? null,
      effects: Array.isArray(parsed.effects) ? parsed.effects : [],
      references: Array.isArray(parsed.references) ? parsed.references : [],
    },
    revision: typeof parsed.revision === 'string' ? parsed.revision : null,
  }
}

/**
 * Write the effects index via the same envelope discipline as project documents.
 * @param {string} effectsRoot
 * @param {any} doc
 * @returns {void}
 */
function writeEffectIndex(effectsRoot, doc) {
  writeFileAtomic(path.join(effectsRoot, 'index.json'), `${JSON.stringify(doc, null, 2)}\n`)
}

/**
 * Copy one input into the effect package and hash it.
 * @param {object} input
 * @param {string} input.packageDir absolute effect version directory
 * @param {{ name: string, content?: string, sourcePath?: string }} input.file
 * @returns {{ path: string, bytes: number, sha256: string }}
 */
function writePackageInput(input) {
  const name = assertText(input.file.name, 'input.name', 120)
  const relative = `inputs/${path.basename(name).replace(/[^0-9A-Za-z._-]/g, '_')}`
  const absolute = path.join(input.packageDir, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  let bytes
  if (typeof input.file.content === 'string') {
    bytes = Buffer.from(input.file.content, 'utf8')
  } else if (typeof input.file.sourcePath === 'string' && path.isAbsolute(input.file.sourcePath)) {
    if (!fs.existsSync(input.file.sourcePath)) {
      throw new NotFoundError('效果输入文件不存在', { sourcePath: input.file.sourcePath })
    }
    bytes = fs.readFileSync(input.file.sourcePath)
  } else {
    throw new ValidationError('效果输入必须提供内容或一个绝对路径', { field: 'inputs' })
  }
  writeFileAtomic(absolute, bytes)
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes) }
}

/**
 * Probe a sound file without opening a player.
 * @param {string} ffprobePath
 * @param {string} file
 * @returns {{ audio: any, format: any }}
 */
function probeSound(ffprobePath, file) {
  const probed = probeMedia(ffprobePath, file)
  return { audio: probed.audio ?? null, format: probed.format ?? null }
}

/**
 * The effect library of one workbench instance.
 *
 * @param {{ effectsRoot: string, clock?: any }} input
 * @returns {any}
 */
export function createEffectLibrary(input) {
  const effectsRoot = input?.effectsRoot
  if (typeof effectsRoot !== 'string' || !path.isAbsolute(effectsRoot)) {
    throw new ValidationError('效果库需要绝对的库根目录', { field: 'effectsRoot' })
  }
  const clock = input.clock ?? new Clock()
  fs.mkdirSync(effectsRoot, { recursive: true })

  /** @param {any} update */
  function save(update) {
    const { doc } = readEffectIndex(effectsRoot)
    update(doc)
    writeEffectIndex(effectsRoot, doc)
  }

  return {
    clock,
    root: effectsRoot,
    /** Every effect, newest last. */
    list(filter = {}) {
      const { doc } = readEffectIndex(effectsRoot)
      return doc.effects
        .filter((effect) => (filter.state === undefined ? true : effect.state === filter.state))
        .map((effect) => copy(effect))
    },
    /** @param {string} effectId */
    get(effectId) {
      const { doc } = readEffectIndex(effectsRoot)
      const found = doc.effects.find((effect) => effect.effectId === assertText(effectId, 'effectId', 120))
      return found === undefined ? null : copy(found)
    },
    /**
     * Add a candidate. Nothing is adopted here: a candidate must pass the reproduction gate first.
     *
     * @param {object} request
     * @param {string} request.projectId the source project (provenance, not ownership)
     * @param {string} request.name
     * @param {string} request.kind one of `EffectKind`
     * @param {string} request.version
     * @param {any} [request.sourcePlan] normalized CompositionPlan that produces the visual effect
     * @param {{ name: string, content?: string, sourcePath?: string }[]} [request.inputs]
     * @param {Array<{ family: string, file?: string|null, note?: string }>} [request.fonts]
     * @param {any} request.params
     * @param {{ width?: number, height?: number, fps?: string, frames?: number, codec?: string }} request.output
     * @param {{ declaration: string, note?: string }} request.rights
     * @param {{ toolId: string, version: string, build?: string|null }[]} [request.tools]
     * @returns {any}
     */
    addCandidate(request = {}) {
      const name = assertText(request.name, 'effect.name', 120)
      const kind = assertEnumValue(request.kind, EffectKind, 'effect.kind')
      const version = assertText(request.version, 'effect.version', 40)
      const createdAt = clock.iso()
      const slug = slugOf(name)
      const effectId = effectIdFor({ projectId: assertText(request.projectId, 'effect.projectId', 120), slug, createdAt })
      const { doc } = readEffectIndex(effectsRoot)
      if (doc.effects.length >= DELIVERY_LIMITS.maxEffects) {
        throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '效果库数量达到上限', {
          details: { limit: DELIVERY_LIMITS.maxEffects },
        })
      }
      if (doc.effects.some((effect) => effect.effectId === effectId)) {
        throw new ConflictError('效果已存在', { effectId })
      }
      const relativeDir = `${slug}/v${version}`
      const packageDir = path.join(effectsRoot, ...relativeDir.split('/'))
      if (fs.existsSync(packageDir)) {
        throw new ConflictError('同名同版本的效果包目录已存在，拒绝覆盖', { packageDir: relativeDir })
      }
      /** @type {Array<{ path: string, bytes: number, sha256: string, role: string }>} */
      const files = []
      const inputs = []
      try {
        fs.mkdirSync(packageDir, { recursive: true })
        if (kind === EffectKind.VISUAL) {
          if (request.sourcePlan === null || typeof request.sourcePlan !== 'object') {
            throw new ValidationError('视觉效果必须提供产生画面的 CompositionPlan 源文件', { field: 'sourcePlan' })
          }
          const planBytes = Buffer.from(`${JSON.stringify(request.sourcePlan, null, 2)}\n`, 'utf8')
          writeFileAtomic(path.join(packageDir, 'source', 'plan.json'), planBytes)
          files.push({
            path: 'source/plan.json',
            bytes: planBytes.length,
            sha256: sha256(planBytes),
            role: 'source',
          })
        }
        for (const file of Array.isArray(request.inputs) ? request.inputs : []) {
          const written = writePackageInput({ packageDir, file })
          inputs.push({ name: file.name, ...written })
          files.push({ path: written.path, bytes: written.bytes, sha256: written.sha256, role: 'input' })
        }
        const declaration = {
          kind: EFFECT_DECLARATION_KIND,
          effectId,
          name,
          kind,
          version,
          slug,
          createdAt,
          source: { projectId: request.projectId, versionId: request.versionId ?? null },
          params: request.params ?? {},
          output: request.output ?? {},
          fonts: Array.isArray(request.fonts) ? request.fonts : [],
          tools: Array.isArray(request.tools) ? request.tools : [],
          inputs,
          sourceFiles: files.filter((entry) => entry.role === 'source').map((entry) => entry.path),
          rights: {
            declaration: assertText(request.rights?.declaration, 'effect.rights.declaration', 200),
            note: assertOptionalText(request.rights?.note, 'effect.rights.note', 400),
          },
          usage: {
            conditions: [
              '由原制作子 Agent 按项目适配后使用，不把效果当作可自由再分发素材',
              '不同机器/工具版本需要重新复现，不承诺无条件像素一致',
            ],
          },
        }
        for (const field of REQUIRED_DECLARATION_FIELDS) {
          if (declaration[field] === undefined || declaration[field] === null) {
            throw new ValidationError('效果声明缺少必需字段', { field })
          }
        }
        const declarationBytes = Buffer.from(`${JSON.stringify(declaration, null, 2)}\n`, 'utf8')
        writeFileAtomic(path.join(packageDir, 'effect.json'), declarationBytes)
        files.push({
          path: 'effect.json',
          bytes: declarationBytes.length,
          sha256: sha256(declarationBytes),
          role: 'declaration',
        })
      } catch (error) {
        try {
          fs.rmSync(packageDir, { recursive: true, force: true })
        } catch {
          // Report the real failure; a cleanup error must not replace it.
        }
        throw error
      }
      const versionId = effectVersionIdFor(effectId, version)
      /** @type {any} */
      const effect = {
        effectId,
        slug,
        name,
        kind,
        state: EffectState.CANDIDATE,
        version,
        versionId,
        currentVersionId: versionId,
        packageDir: relativeDir,
        source: { projectId: String(request.projectId), versionId: request.versionId ?? null },
        files,
        inputs,
        fonts: Array.isArray(request.fonts) ? request.fonts : [],
        tools: Array.isArray(request.tools) ? request.tools : [],
        params: request.params ?? {},
        output: request.output ?? {},
        rights: declarationSafeRights(request),
        createdAt,
        updatedAt: createdAt,
        versions: [{ version, versionId, createdAt, files, fingerprint: sha256(files.map((entry) => `${entry.path}:${entry.sha256}`).join('\n')) }],
        reproduction: null,
        note: '候选：必须先在空项目复现并通过检查，才能成为正式效果',
      }
      save((doc2) => {
        doc2.effects.push(effect)
      })
      return copy(effect)
    },
    /**
     * Re-execute the effect package in an EMPTY project and only then decide adoption.
     *
     * @param {object} request
     * @param {string} request.effectId
     * @param {string} request.emptyProjectDir absolute directory that must contain no project facts
     * @param {any} request.toolchain resolved external toolchain
     * @param {{ maxDeviationSeconds?: number }} [request.options]
     * @returns {any} the effect record after the attempt (state tells the outcome)
     */
    reproduce(request = {}) {
      const { doc } = readEffectIndex(effectsRoot)
      const index = doc.effects.findIndex((effect) => effect.effectId === assertText(request.effectId, 'effectId', 120))
      if (index === -1) throw new NotFoundError('效果不存在', { effectId: request.effectId })
      const effect = doc.effects[index]
      if (effect.state === EffectState.ADOPTED) {
        throw new ConflictError('效果已经是正式收录状态；需要再次验证请形成新版本', { effectId: effect.effectId })
      }
      const emptyProjectDir = request.emptyProjectDir
      if (typeof emptyProjectDir !== 'string' || !path.isAbsolute(emptyProjectDir)) {
        throw new ValidationError('空项目复现需要一个绝对的空项目目录', { field: 'emptyProjectDir' })
      }
      fs.mkdirSync(emptyProjectDir, { recursive: true })
      const factsPath = path.join(emptyProjectDir, 'project.json')
      const versionsPath = path.join(emptyProjectDir, 'versions', 'index.json')
      if (fs.existsSync(factsPath) || fs.existsSync(versionsPath)) {
        throw new ConflictError('复现目录里已有项目事实，不是空项目', {
          field: 'emptyProjectDir',
          action: '换一个空目录，避免在真实项目里试跑效果',
        })
      }
      const attemptAt = clock.iso()
      const packageDir = path.join(effectsRoot, ...effect.packageDir.split('/'))
      /** @type {any[]} */
      const checks = []
      let observed = null
      let failure = null
      try {
        // Package integrity first: an effect whose files changed is not the effect that was declared.
        for (const entry of effect.files) {
          const absolute = path.join(packageDir, entry.path)
          checks.push({
            id: `file:${entry.path}`,
            status: fs.existsSync(absolute) && sha256(fs.readFileSync(absolute)) === entry.sha256 ? 'ok' : 'failed',
            detail: entry.path,
          })
        }
        for (const input of effect.inputs) {
          const absolute = path.join(packageDir, input.path)
          checks.push({
            id: `input:${input.name}`,
            status: fs.existsSync(absolute) && sha256(fs.readFileSync(absolute)) === input.sha256 ? 'ok' : 'failed',
            detail: `必要输入 ${input.name}`,
          })
        }
        const toolchain = request.toolchain
        if (toolchain === undefined || toolchain === null) {
          throw new WorkbenchError(ErrorCode.EXTERNAL_FAILURE, '空项目复现需要已解析的工具链', {
            details: { action: '先解析 FFmpeg/FFprobe，再复现' },
          })
        }
        if (effect.kind === EffectKind.VISUAL) {
          const planStored = JSON.parse(fs.readFileSync(path.join(packageDir, 'source', 'plan.json'), 'utf8'))
          const expected = effect.output ?? {}
          const workRoot = path.join(emptyProjectDir, 'effect-work')
          fs.mkdirSync(workRoot, { recursive: true })
          const media = createMediaRuntime({
            toolchain,
            workRoot,
            materialRoot: packageDir,
            clock,
          })
          const adapter = media.adapters.ffmpeg
          const outputPath = path.join(emptyProjectDir, 'effect-output.mp4')
          const result = adapter.renderFinal(planStored, planStored.outputSpec, { outputPath })
          const probed = adapter.probeResult(result.file)
          observed = {
            width: probed.video?.width ?? null,
            height: probed.video?.height ?? null,
            nbFrames: probed.video?.nbFrames ?? null,
            durationSeconds: probed.format?.durationSeconds ?? null,
            pixelFormat: probed.video?.pixelFormat ?? null,
          }
          checks.push({
            id: 'spec',
            status:
              (expected.width === undefined || probed.video?.width === expected.width) &&
              (expected.height === undefined || probed.video?.height === expected.height)
                ? 'ok'
                : 'failed',
            detail: `实测 ${String(probed.video?.width)}×${String(probed.video?.height)}（声明 ${String(expected.width)}×${String(expected.height)}）`,
          })
          checks.push({
            id: 'frame-count',
            status: expected.frames === undefined || probed.video?.nbFrames === expected.frames ? 'ok' : 'failed',
            detail: `实测 ${String(probed.video?.nbFrames)} 帧（声明 ${String(expected.frames)} 帧）`,
          })
          const tolerance = Number(request.options?.maxDeviationSeconds ?? 0.05)
          checks.push({
            id: 'duration',
            status:
              expected.durationSeconds === undefined ||
              (typeof probed.format?.durationSeconds === 'number' &&
                Math.abs(probed.format.durationSeconds - Number(expected.durationSeconds)) <= tolerance)
                ? 'ok'
                : 'failed',
            detail: `实测 ${String(probed.format?.durationSeconds)}s（声明 ${String(expected.durationSeconds)}s，容差 ${tolerance}s）`,
          })
        } else {
          const input = effect.inputs[0]
          if (input === undefined) throw new ValidationError('声音效果缺少音频输入', { field: 'inputs' })
          const copied = path.join(emptyProjectDir, 'effect-input-sound', path.basename(input.path))
          fs.mkdirSync(path.dirname(copied), { recursive: true })
          fs.copyFileSync(path.join(packageDir, input.path), copied)
          const probedSound = probeSound(toolchain.ffprobe.path, copied)
          observed = {
            sampleRate: probedSound.audio?.sampleRate ?? null,
            channels: probedSound.audio?.channels ?? null,
            durationSeconds: probedSound.format?.durationSeconds ?? null,
            sha256: sha256(fs.readFileSync(copied)),
          }
          const expected = effect.output ?? {}
          checks.push({
            id: 'audio-stream',
            status: probedSound.audio === null ? 'failed' : 'ok',
            detail: probedSound.audio === null ? '没有音频流' : `${String(probedSound.audio.codec)} ${String(probedSound.audio.sampleRate)}Hz/${String(probedSound.audio.channels)}ch`,
          })
          checks.push({
            id: 'audio-spec',
            status:
              (expected.sampleRate === undefined || probedSound.audio?.sampleRate === Number(expected.sampleRate)) &&
              (expected.channels === undefined || probedSound.audio?.channels === Number(expected.channels))
                ? 'ok'
                : 'failed',
            detail: `声明 ${String(expected.sampleRate)}Hz/${String(expected.channels)}ch`,
          })
          checks.push({
            id: 'duration',
            status:
              typeof probedSound.format?.durationSeconds === 'number' &&
              (expected.durationSeconds === undefined ||
                Math.abs(probedSound.format.durationSeconds - Number(expected.durationSeconds)) <= 0.05)
                ? 'ok'
                : 'failed',
            detail: `实测 ${String(probedSound.format?.durationSeconds)}s`,
          })
          // No listening channel exists on this host; the record says so instead of implying a listen.
          checks.push({
            id: 'listen',
            status: 'not-checked',
            detail: '本机没有听辨通道；声音效果只验证文件规格、时长与输入完整，实际听感需要用户听',
          })
        }
      } catch (error) {
        failure = { reason: String(error?.message ?? error), code: String(error?.code ?? 'REPRODUCE_FAILED') }
      }
      const failedChecks = checks.filter((check) => check.status === 'failed').map((check) => check.id)
      const passed = failure === null && failedChecks.length === 0 && checks.length > 0
      const attempt = {
        at: attemptAt,
        toolchain: request.toolchain === undefined || request.toolchain === null
          ? null
          : {
              ffmpeg: {
                version: request.toolchain.ffmpeg?.version ?? null,
                build: request.toolchain.ffmpeg?.build ?? null,
              },
              ffprobe: { version: request.toolchain.ffprobe?.version ?? null },
            },
        emptyProjectDir,
        checks,
        observed,
        failure,
        passed,
      }
      if (passed) {
        effect.state = EffectState.ADOPTED
        effect.reproducedAt = attemptAt
        effect.reproduction = {
          attempts: [...(effect.reproduction?.attempts ?? []), attempt],
          ok: true,
          adoptedAt: attemptAt,
        }
        effect.note = '已在空项目复现并通过检查，正式收录'
      } else {
        effect.state = EffectState.REPRODUCE_FAILED
        effect.reproduction = {
          attempts: [...(effect.reproduction?.attempts ?? []), attempt],
          ok: false,
          reason: failure === null ? `检查未通过：${failedChecks.join('、')}` : failure.reason,
        }
        effect.note = '复现未通过：保留候选和具体原因，不进入正式收录'
      }
      effect.updatedAt = clock.iso()
      save((doc2) => {
        doc2.effects[index] = effect
      })
      return copy(effect)
    },
    /**
     * Reference an adopted effect version from a project (cross-project use, never a copy).
     * @param {{ effectId: string, version?: string, projectId: string, note?: string }} request
     * @returns {any}
     */
    reference(request = {}) {
      const { doc } = readEffectIndex(effectsRoot)
      const effect = doc.effects.find((entry) => entry.effectId === assertText(request.effectId, 'effectId', 120))
      if (effect === undefined) throw new NotFoundError('效果不存在', { effectId: request.effectId })
      if (effect.state !== EffectState.ADOPTED) {
        throw new ConflictError('只有正式收录并通过空项目复现的效果才能被项目引用', {
          effectId: effect.effectId,
          state: effect.state,
        })
      }
      const version = assertOptionalText(request.version, 'version', 40) ?? effect.version
      const versionEntry = (effect.versions ?? []).find((entry) => entry.version === version)
      if (versionEntry === undefined) throw new NotFoundError('效果的该版本不存在', { effectId: effect.effectId, version })
      const references = doc.references ?? []
      const existing = references.find(
        (entry) =>
          entry.effectId === effect.effectId &&
          entry.version === version &&
          entry.projectId === request.projectId,
      )
      if (existing !== undefined) return copy(existing)
      const record = {
        refId: `ref_${effect.effectId.slice(-8)}_${version.replace(/[^0-9A-Za-z]/g, '')}_${String(request.projectId).replace(/[^0-9A-Za-z]/g, '')}`,
        effectId: effect.effectId,
        version,
        versionId: versionEntry.versionId,
        projectId: assertText(request.projectId, 'projectId', 120),
        note: assertOptionalText(request.note, 'note', 400),
        at: clock.iso(),
      }
      save((doc2) => {
        doc2.references = [...(doc2.references ?? []), record]
      })
      return copy(record)
    },
    /**
     * Update an effect by forming a NEW version; existing references keep their old version.
     *
     * @param {object} request
     * @param {string} request.effectId
     * @param {string} request.version the new version label
     * @param {any} [request.params]
     * @param {any} [request.output]
     * @param {any} [request.sourcePlan]
     * @param {{ name: string, content?: string, sourcePath?: string }[]} [request.inputs]
     * @param {any} [request.rights]
     * @returns {any}
     */
    update(request = {}) {
      const { doc } = readEffectIndex(effectsRoot)
      const index = doc.effects.findIndex((effect) => effect.effectId === assertText(request.effectId, 'effectId', 120))
      if (index === -1) throw new NotFoundError('效果不存在', { effectId: request.effectId })
      const effect = doc.effects[index]
      const version = assertText(request.version, 'version', 40)
      if ((effect.versions ?? []).some((entry) => entry.version === version)) {
        throw new ConflictError('该版本已存在；更新必须形成新的版本', { effectId: effect.effectId, version })
      }
      const relativeDir = `${effect.slug}/v${version}`
      const packageDir = path.join(effectsRoot, ...relativeDir.split('/'))
      if (fs.existsSync(packageDir)) {
        throw new ConflictError('同名同版本的效果包目录已存在，拒绝覆盖', { packageDir: relativeDir })
      }
      const createdAt = clock.iso()
      /** @type {any[]} */
      const files = []
      /** @type {any[]} */
      const inputs = []
      try {
        fs.mkdirSync(packageDir, { recursive: true })
        if (effect.kind === EffectKind.VISUAL) {
          const plan = request.sourcePlan ?? readPreviousPlan(effectsRoot, effect)
          const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8')
          writeFileAtomic(path.join(packageDir, 'source', 'plan.json'), planBytes)
          files.push({ path: 'source/plan.json', bytes: planBytes.length, sha256: sha256(planBytes), role: 'source' })
        }
        for (const file of Array.isArray(request.inputs) ? request.inputs : []) {
          const written = writePackageInput({ packageDir, file })
          inputs.push({ name: file.name, ...written })
          files.push({ path: written.path, bytes: written.bytes, sha256: written.sha256, role: 'input' })
        }
        const declaration = {
          kind: EFFECT_DECLARATION_KIND,
          effectId: effect.effectId,
          name: effect.name,
          kind: effect.kind,
          version,
          slug: effect.slug,
          createdAt,
          source: effect.source,
          params: request.params ?? effect.params,
          output: request.output ?? effect.output,
          fonts: Array.isArray(request.fonts) ? request.fonts : effect.fonts,
          tools: effect.tools,
          inputs,
          sourceFiles: files.filter((entry) => entry.role === 'source').map((entry) => entry.path),
          rights: request.rights ?? effect.rights,
          supersedes: effect.version,
        }
        const declarationBytes = Buffer.from(`${JSON.stringify(declaration, null, 2)}\n`, 'utf8')
        writeFileAtomic(path.join(packageDir, 'effect.json'), declarationBytes)
        files.push({ path: 'effect.json', bytes: declarationBytes.length, sha256: sha256(declarationBytes), role: 'declaration' })
      } catch (error) {
        try {
          fs.rmSync(packageDir, { recursive: true, force: true })
        } catch {
          // Keep the real failure visible.
        }
        throw error
      }
      const versionId = effectVersionIdFor(effect.effectId, version)
      effect.versions = [
        ...(effect.versions ?? []),
        { version, versionId, createdAt, files, fingerprint: sha256(files.map((entry) => `${entry.path}:${entry.sha256}`).join('\n')) },
      ]
      effect.version = version
      effect.versionId = versionId
      effect.currentVersionId = versionId
      effect.packageDir = relativeDir
      effect.files = files
      effect.inputs = inputs
      effect.params = request.params ?? effect.params
      effect.output = request.output ?? effect.output
      effect.state = EffectState.CANDIDATE
      effect.reproduction = null
      effect.note = '新版本必须重新在空项目复现；旧项目仍引用旧版本'
      effect.updatedAt = createdAt
      save((doc2) => {
        doc2.effects[index] = effect
      })
      const references = (doc.references ?? []).filter((entry) => entry.effectId === effect.effectId)
      return {
        effect: copy(effect),
        referencesKeepingOldVersion: references.map((entry) => ({
          projectId: entry.projectId,
          version: entry.version,
        })),
      }
    },
    /**
     * Withdraw an effect. Refused while any project references it; files are kept either way.
     * @param {{ effectId: string, reason?: string }} request
     * @returns {any}
     */
    withdraw(request = {}) {
      const { doc } = readEffectIndex(effectsRoot)
      const index = doc.effects.findIndex((effect) => effect.effectId === assertText(request.effectId, 'effectId', 120))
      if (index === -1) throw new NotFoundError('效果不存在', { effectId: request.effectId })
      const references = (doc.references ?? []).filter((entry) => entry.effectId === request.effectId)
      if (references.length > 0) {
        throw new ConflictError('效果仍被项目引用，不能下架；先处理引用', {
          effectId: request.effectId,
          references,
        })
      }
      const effect = doc.effects[index]
      effect.state = EffectState.WITHDRAWN
      effect.note = `已下架：${assertOptionalText(request.reason, 'reason', 200) ?? '未写原因'}；包文件保留，不删除`
      effect.updatedAt = clock.iso()
      save((doc2) => {
        doc2.effects[index] = effect
      })
      return copy(effect)
    },
    /** Every reference of one effect, or every reference of one project. */
    listReferences(filter = {}) {
      const { doc } = readEffectIndex(effectsRoot)
      return (doc.references ?? [])
        .filter((entry) => (filter.effectId === undefined ? true : entry.effectId === filter.effectId))
        .filter((entry) => (filter.projectId === undefined ? true : entry.projectId === filter.projectId))
        .map((entry) => copy(entry))
    },
    /** Facts a UI can show without opening every package. */
    describe() {
      const { doc } = readEffectIndex(effectsRoot)
      return {
        effects: doc.effects.length,
        candidates: doc.effects.filter((effect) => effect.state === EffectState.CANDIDATE).length,
        adopted: doc.effects.filter((effect) => effect.state === EffectState.ADOPTED).length,
        reproduceFailed: doc.effects.filter((effect) => effect.state === EffectState.REPRODUCE_FAILED).length,
        withdrawn: doc.effects.filter((effect) => effect.state === EffectState.WITHDRAWN).length,
        references: (doc.references ?? []).length,
        note: '只有空项目复现通过的效果才算正式收录；失败保留候选与原因',
      }
    },
    /** The whole index as a bounded, read-only view. */
    snapshot() {
      const { doc } = readEffectIndex(effectsRoot)
      return {
        generation: doc.revision,
        effects: doc.effects.slice(-30).map((effect) => ({
          effectId: effect.effectId,
          name: effect.name,
          kind: effect.kind,
          version: effect.version,
          state: effect.state,
          references: (doc.references ?? []).filter((entry) => entry.effectId === effect.effectId).length,
          reproducedAt: effect.reproducedAt ?? null,
          note: clip(effect.note, 160),
        })),
        references: (doc.references ?? []).slice(-30).map((entry) => ({
          effectId: entry.effectId,
          version: entry.version,
          projectId: entry.projectId,
          at: entry.at,
        })),
        honest: {
          noArbitraryCodeExecution: true,
          listeningChannel: false,
          note: '效果以声明式源文件复现，不执行任意源码；本机没有听辨通道，声音效果需用户实际听',
        },
      }
    },
  }

  /**
   * Read the previous version's plan so an update that omits `sourcePlan` keeps the same source.
   * @param {string} root
   * @param {any} effect
   * @returns {any}
   */
  function readPreviousPlan(root, effect) {
    const absolute = path.join(root, ...effect.packageDir.split('/'), 'source', 'plan.json')
    if (!fs.existsSync(absolute)) {
      throw new NotFoundError('效果包内缺少 source/plan.json，更新无法沿用旧源文件', { effectId: effect.effectId })
    }
    return JSON.parse(fs.readFileSync(absolute, 'utf8'))
  }
}

/**
 * The rights block a stored record keeps, derived from the request without inventing a licence.
 * @param {any} request
 * @returns {{ declaration: string, note: string|null }}
 */
function declarationSafeRights(request) {
  return {
    declaration: String(request?.rights?.declaration ?? 'self-authored'),
    note: request?.rights?.note ?? null,
  }
}

/** The library's own interface version, re-exported for a dependent card to compare. */
export const EFFECTS_INTERFACE_VERSION = '1.0.0'
