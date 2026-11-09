/**
 * Record the observations I actually made of the real renders.
 *
 * The split matters: extraction (deterministic derivatives) and observation (a model looking at
 * them) are different acts, and this file records only the second. It cites the derivative file,
 * its hash, the frame index and the region for every claim, marks what was NOT watched, and never
 * records audio as heard because this host has no listening channel.
 *
 * The findings below are the ones this session's model reported after viewing the PNGs; they are
 * copied here verbatim from that viewing, not inferred from the plan.
 *
 * Usage: node orchestration/dev/record-observation.mjs --root <evidence dir> [--project <id>]
 *
 * @module orchestration/dev/record-observation
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Clock, sha256File } from '../../base/index.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { InspectionKind, RecoveryCause, VistaLedger } from '../../orchestration/vista.js'
import { UnitBase, UnitCondition, UnitOperation, UnitRegistry, resolveUnitProfile } from '../../orchestration/units.js'
import { CraftBook } from '../../orchestration/craft.js'
import { ProductionRun } from '../../orchestration/production.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = path.resolve(HERE, '../..')

/** @param {string} flag @param {string|null} fallback */
function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : fallback
}

/** What the model reported after viewing, grouped by the file it was looking at. */
const FINDINGS = Object.freeze([
  {
    derivative: 'unit-f150.png',
    view: '整帧 1280×720，第 150 帧（5.000s，30fps）',
    observed:
      '彩条背景＋右侧绿色方格程序图案；左上角程序计数器显示 150 与 00:00:04.000；中上部白色大字“可追溯的每一次修改”；底部字幕“程序视觉、已有素材与用户音频，在同一条时间线上协作。”位于半透明黑条内；左下角另有一层“已有素材片段”文字被字幕条部分覆盖。',
    issues: ['字幕条覆盖了左下角“已有素材片段”的后半段，属于层叠顺序，不是裁切'],
  },
  {
    derivative: 'unit-f150-subtitle-region.png',
    view: '原比例区域 1080×76，取自第 150 帧的 obj-subtitle-S02 box（x=100,y=590）',
    observed: '字幕文本完整落在半透明黑条内，左侧留白约 90px，右侧文字与条右缘之间仍有可见间隙；字形为中国大陆简体，未见缺字或方框。',
    issues: [],
  },
  {
    derivative: 'unit-contact-sheet.png',
    view: '5 帧概览（0/60/120/180/240 帧拼版，每格 512px 宽）',
    observed:
      '0～120 帧是深色场景（星点、细小标题），从约 120 帧开始彩条场景叠加进入，180 帧与 240 帧已是彩条场景；转场是两场景叠加过渡而不是硬切；每格底部字幕都在同一位置，未见跳位。',
    issues: [],
  },
  {
    derivative: 'repair-f150.png',
    view: '修复后整帧 1280×720，第 150 帧',
    observed: '与修复前同一帧相比，只有底部字幕换成“…在同一条时间线上协作。（修订）”；大字、程序计数器、方格图案与彩条位置一致；未看到其他区域发生位移或颜色变化。',
    issues: ['修订后字幕右缘距背景条右缘约 5–10px，未越界但已接近边缘'],
  },
  {
    derivative: 'repair-f150-subtitle-region.png',
    view: '修复后原比例区域 1080×76，同一 box',
    observed: '“（修订）”四字完整可见，仍在半透明黑条范围内；黑条宽度没有随文字变长而增加。',
    issues: ['背景条宽度固定，长文本再增加就会越出黑条——这是本次真实观察到的边界'],
  },
  {
    derivative: 'cut-f150.png',
    view: '交付规格 1920×1080，第 150 帧',
    observed: '内容与 720p 单元同帧一致，按 1.5 倍整体放大；字幕仍在画面内且未裁切，程序计数器仍在左上角；文字边缘看起来比 720p 版本略软（只能算观察印象，未做量化测量）。',
    issues: ['字体随画幅整体放大而非按新画幅重排，锐度需人眼确认'],
  },
])

function main() {
  const root = path.resolve(arg('--root', path.join(PRODUCT_ROOT, 'evidence', 'c13-render')))
  const renderIndex = JSON.parse(fs.readFileSync(path.join(root, 'render-index.json'), 'utf8'))
  const projectId = arg('--project', renderIndex.projectId)
  const observationsDir = path.join(root, 'observation')
  const inputs = JSON.parse(fs.readFileSync(path.join(observationsDir, 'inputs.json'), 'utf8'))
  const clock = new Clock({ mode: 'frozen', start: 1_780_000_100_000 })
  const paths = new ProjectPaths(path.join(root, 'projects'), projectId)

  // Re-running this recorder must not append a second copy of the same observations. The files it
  // owns are removed first; renders and the project document are never touched.
  if (process.argv.includes('--reset')) {
    for (const relative of ['evidence/vista.json', 'recipes/units.json', 'work/work-package.json']) {
      const absolute = paths.resolve(relative)
      if (fs.existsSync(absolute)) fs.rmSync(absolute)
    }
  }

  const byName = new Map(inputs.derivatives.map((entry) => [entry.name, entry]))
  /** A render is a RESULT identity; its name is the file basename. */
  const renderRef = (file) => `evd:${path.basename(file)}`
  const refFor = (name) => {
    const entry = byName.get(name)
    if (entry === undefined) throw new Error(`缺少派生文件记录：${name}`)
    return `evd:${name.replace(/\.png$/, '')}`
  }

  const ledger = new VistaLedger({ paths, clock })
  const producerSessionId = 'maker-C13-real-001'
  ledger.bindProducer(producerSessionId)

  // ---- evidence identity: renders are results, extracted frames are derived -----------------
  for (const key of ['unit', 'repair', 'cut']) {
    const render = renderIndex.renders[key]
    ledger.registerIdentity({ evidenceRef: renderRef(render.file), role: 'result', sha256: render.sha256 })
  }
  for (const derivative of inputs.derivatives) {
    ledger.registerIdentity({
      evidenceRef: refFor(derivative.name),
      role: 'derived',
      sha256: derivative.sha256,
      derivedFrom: renderRef(derivative.source),
      transform: derivative.filter,
    })
  }

  // ---- the looking itself ------------------------------------------------------------------
  const observationIds = []
  for (const finding of FINDINGS) {
    const derivative = byName.get(finding.derivative)
    const recorded = ledger.recordObservation({
      producerSessionId,
      model: 'deepseek-v4.1-flash',
      inputViews: [derivative.view, `${derivative.width}×${derivative.height} PNG`],
      evidenceRefs: [refFor(finding.derivative)],
      observedScope: finding.view,
      issues: finding.issues,
      mediaVersion: derivative.source,
      note: finding.observed,
    })
    observationIds.push(recorded.observation.observationId)
  }

  // ---- one question-driven inspection with its own wider view -----------------------------
  const inspection = ledger.requestInspection({
    producerSessionId,
    question: '修订后字幕右缘是否越出半透明背景条',
    kind: InspectionKind.ORIGINAL_RATIO,
    evidenceRefs: [refFor('repair-f150-subtitle-region.png')],
    returnedScope: '原比例 1080×76 区域（非全帧）',
  })

  // ---- prediction → render → observation → decision ---------------------------------------
  const loop = ledger.openLoop({
    producerSessionId,
    prediction: {
      target: 'obj-subtitle-S02 文本',
      scope: '第 75–167 帧',
      preserve: ['大字', '程序计数器', '彩条与方格', '音轨字节'],
      expectedChange: '底部字幕文本出现“（修订）”，其余画面不变',
      baseline: 'unit-001-master.mp4',
      check: '同一帧 150 的原比例区域对照',
    },
  })
  const closed = ledger.closeLoop({
    loopId: loop.loop.loopId,
    action: '用 createRepairOperation 替换 S02 文本并真实重渲',
    observation: {
      observedChange: '仅底部署名行文本变化，其余对象位置与颜色一致（第 150 帧对照）',
      unexpected: ['修订后字幕右缘距背景条右缘只剩约 5–10px', '背景条宽度固定，不随文本长度变化'],
      measurements: null,
      unobserved: ['整片连续播放未看', '转场段落未逐帧看', '音频未听'],
    },
    decision: {
      choice: '接受本次修复，记录边缘余量为已知问题',
      by: 'ai',
      reason: '目标达成且未牵连其他对象；边缘余量不足以判定为缺陷，交用户审片确认',
      evidenceRefs: [refFor('repair-f150.png'), refFor('repair-f150-subtitle-region.png')],
    },
  })

  // ---- layered memory and a real recovery -------------------------------------------------
  ledger.setMemory({
    project: ['交付规格 1920×1080/30fps', '字幕位置固定在下三分之一'],
    work: ['已知问题：字幕条宽度固定', '下一步：用户审片'],
    recoveryRefs: [refFor('unit-f150.png'), refFor('repair-f150-subtitle-region.png')],
  })
  const recovery = ledger.recordRecovery({
    producerSessionId,
    cause: RecoveryCause.COMPACTION,
    checks: { baseline: true, version: true, evidence: true, openWork: true },
    packet: { baseline: 'unit-001-master + repair-002', position: '修复后待审片', openWork: ['用户审片'] },
  })

  // ---- multiscale strategy and tool governance --------------------------------------------
  const efficiency = ledger.recordEfficiency({
    producerSessionId,
    strategy: ['multi-frame-overview', 'full-frame', 'original-ratio-region'],
    rounds: 3,
    metrics: {
      tokens: null,
      waitMs: null,
      storageBytes: inputs.derivatives.reduce((sum, entry) => sum + entry.bytes, 0),
    },
    evidenceRefs: inputs.derivatives.map((entry) => refFor(entry.name)).slice(0, 8),
  })
  ledger.recordToolCall({
    toolId: 'ffmpeg',
    toolVersion: renderIndex.toolchain.ffmpeg.version,
    readOnly: false,
    permission: '抽帧与裁区域（写派生文件）',
    result: `${inputs.derivatives.length} 个 PNG`,
    outcomeKnown: true,
  })
  ledger.recordToolCall({
    toolId: 'read_image',
    toolVersion: 'session-model',
    readOnly: true,
    permission: '把本地 PNG 送入当前会话模型',
    result: '读取 5 张图',
    outcomeKnown: true,
  })

  const gate = ledger.gate()

  // ---- the unit itself, with honest observation coverage ----------------------------------
  const profile = resolveUnitProfile({
    base: UnitBase.TEMPORAL_MOTION,
    operation: UnitOperation.CREATE,
    conditions: [UnitCondition.SUBTITLE],
  })
  const unitFile = 'media/unit-001-master.mp4'
  const unit = {
    unitManifest: {
      unitId: 'unit-001-real',
      projectId,
      base: profile.base,
      operation: profile.operation,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      target: '9 秒双场景单元（C02 结构，C12 FFmpeg 适配器真实渲染）',
      spec: { width: 1280, height: 720, frames: 270, fps: 30 },
      status: 'produced',
      source: 'C13 真实渲染走查',
    },
    unitOutput: {
      files: [
        { role: 'master', path: unitFile, sha256: renderIndex.renders.unit.sha256 },
        { role: 'repaired', path: 'media/unit-001-repair-002.mp4', sha256: renderIndex.renders.repair.sha256 },
      ],
      readableWhole: true,
      evidence: [
        {
          kind: 'full-playback',
          ref: refFor('unit-contact-sheet.png'),
          executed: true,
          observationState: 'not-observed',
          note: '程序已解码 270 帧；AI 未连续观看整片',
        },
        { kind: 'start-frame', ref: refFor('unit-f000-overview.png'), executed: true, observationState: 'observed' },
        { kind: 'mid-frame', ref: refFor('unit-f150.png'), executed: true, observationState: 'observed' },
        { kind: 'end-frame', ref: refFor('unit-f230.png'), executed: true, observationState: 'observed' },
        {
          kind: 'adjacent-context',
          ref: refFor('unit-contact-sheet.png'),
          executed: true,
          observationState: 'observed',
        },
        { kind: 'target-aspect-render', ref: refFor('cut-f150.png'), executed: true, observationState: 'observed' },
        {
          kind: 'text-region-detail',
          ref: refFor('unit-f150-subtitle-region.png'),
          executed: true,
          observationState: 'observed',
        },
      ],
      checks: [
        { name: '整片可解码 270 帧', executed: true, passed: true },
        { name: '规格与 outputSpec 一致', executed: true, passed: true },
      ],
    },
    productionRecipe: {
      authorizedInputs: ['RENDER-LAB/01-corpus 的 3 段用户音频', 'C02 已验收单元结构'],
      methods: ['c12-ffmpeg-composition@1.0.0'],
      tools: [`ffmpeg@${renderIndex.toolchain.ffmpeg.version}`],
      parameters: {
        planId: renderIndex.plan.planId,
        planVersion: renderIndex.plan.planVersion,
        totalFrames: renderIndex.plan.totalFrames,
      },
      execution: { executed: true, taskId: 'c13-real-render' },
      fixed: ['270 帧结构', '字幕位置', '音轨字节'],
      variable: ['字幕文本'],
    },
    humanResultPack: {
      slots: [
        { name: '单元成片', value: unitFile },
        { name: '交付规格整片', value: 'media/initial-cut-1080p.mp4' },
        { name: '修复对照', value: 'media/unit-001-repair-002.mp4' },
      ],
      knownIssues: ['修订后字幕右缘距背景条右缘约 5–10px', '背景条宽度固定，长文本会越界', '1080p 文字锐度未量化'],
      unverified: ['整片连续播放的节奏', '音频听感（未听）', '观众是否接受彩条测试画面'],
      choices: [
        { id: 'accept', label: '接受本次修复' },
        { id: 'bar-autosize', label: '改为背景条按文本自适应' },
      ],
    },
    continuationContract: {
      directReuse: '同一 plan 与适配器可直接复现',
      adaptByContent: '换画幅走 createAdaptOperation 重新排版',
      recreate: '换运行时需重新渲染并复查字幕安全区',
      reverify: '任何字幕长度变化都要重新看原比例区域',
      dependsOn: ['RENDER-LAB/01-corpus', 'C12 FFmpeg 适配器'],
      invalidWhen: ['字体更换', '画幅比例变化', '字幕文案长度大幅增加'],
    },
  }
  const registry = new UnitRegistry({ paths, clock })
  const registered = registry.register({ unit, profile })

  // ---- craft: the term bound to this unit is recorded, not implied --------------------------
  const craft = new CraftBook({ paths, clock })
  const term = craft.availableTerms()[0]

  // ---- production run, paused for the user review ----------------------------------------
  const run = new ProductionRun({ paths, clock })
  run.begin({
    producerSessionId,
    projectVersion: `rev-${renderIndex.plan.planVersion}`,
    baselineRef: 'baseline-real-1',
    scope: '完整初版',
    authorizedInputs: ['corpus 音频'],
  })
  run.update({ producerSessionId, patch: { currentUnit: 'unit-001-real', nextAction: '等待用户审片' } })
  run.savePosition({ producerSessionId, savedPosition: '修复后整片已渲染，等待用户审片', currentUnit: 'unit-001-real' })
  const paused = run.pause({ reason: '等待用户审片' })

  const report = {
    schemaVersion: 1,
    kind: 'c13-observation-record',
    generatedAt: clock.iso(),
    projectId,
    producerSessionId,
    model: 'deepseek-v4.1-flash',
    render: {
      unit: renderIndex.renders.unit,
      repair: renderIndex.renders.repair,
      cut: renderIndex.renders.cut,
    },
    inputs: inputs.derivatives.map((entry) => ({
      name: entry.name,
      sha256: entry.sha256,
      frame: entry.frame,
      region: entry.region,
      view: entry.view,
      width: entry.width,
      height: entry.height,
    })),
    findings: FINDINGS,
    observationIds,
    inspectionId: inspection.inspection.inspectionId,
    loop: {
      loopId: closed.loop.loopId,
      prediction: closed.loop.prediction,
      observation: closed.loop.observation,
      decision: closed.loop.decision,
    },
    recovery: { recoveryId: recovery.recovery.recoveryId, ok: recovery.recovery.ok },
    efficiency: {
      efficiencyId: efficiency.efficiency.efficiencyId,
      rounds: efficiency.efficiency.rounds,
      strategy: efficiency.efficiency.strategy,
    },
    vista: gate,
    unit: {
      unitId: registered.unitId,
      status: registered.status,
      missing: registered.validation.missing,
      unobserved: registered.validation.unobserved,
    },
    craftTerm: { term: term.id, label: term.label },
    production: { execution: paused.run.execution, savedPosition: paused.run.savedPosition },
    notObserved: ['整片连续播放', '转场逐帧', '任何音频（宿主无听辨通道）'],
    boundary: '以上为模型真实看图后的记录；不构成用户审片，也不证明观感合格',
  }
  fs.writeFileSync(path.join(observationsDir, 'observed.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`observation ids: ${observationIds.length}\n`)
  process.stdout.write(`vista gate: ${gate.executed}/${gate.total}, gainProven=${gate.gainProven}\n`)
  process.stdout.write(`unit: ${registered.status}, unobserved=${registered.validation.unobserved.join('|') || 'none'}\n`)
  process.stdout.write(`written: ${path.join(observationsDir, 'observed.json')}\n`)
}

main()
