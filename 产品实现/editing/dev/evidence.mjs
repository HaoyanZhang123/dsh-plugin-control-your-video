/**
 * C14 evidence run: real project, real FFmpeg renders, real candidate and real AI-return candidate.
 *
 * What it produces under 实施交接/证据/C14-证据:
 * - editing-evidence.json: machine-checkable facts (toolchain, plan diffs, region checks, audio
 *   identity, versions, candidate decisions, annotations, partial confirmation, AI request);
 * - summary.md: a human-readable account that separates program checks, AI observation and user
 *   acceptance;
 * - the original and edited mp4s, so the user can actually open both.
 *
 * It does NOT claim AI saw or heard anything, and it does not ask the harness to generate media.
 *
 * Usage: node editing/dev/evidence.mjs
 *
 * @module editing/dev/evidence
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createVersionStore } from '../../core/project/versions.js'
import { createDecisionLog } from '../../core/project/decisions.js'
import { createOrchestrationKit } from '../../orchestration/index.js'
import {
  checkRepairProtection,
  createFfmpegAdapter,
  diffPlans,
  extractAudioPcm,
  probeMedia,
  repairRegionPlan,
  resolveToolchain,
} from '../../media/index.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'
import { createEditingKit } from '../../editing/index.js'
import { writePlanSnapshot } from '../../editing/ids.js'
import { publishEditingProjection } from '../../editing/projection.js'
import { applyDirectIntent } from '../../editing/scope.js'
import { assertFieldScope, diffPlanFields } from '../../editing/field-diff.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = path.resolve(HERE, '..', '..')
const WORKSPACE_ROOT = path.resolve(PRODUCT_ROOT, '..')
const CORPUS = path.resolve(PRODUCT_ROOT, '..', 'RENDER-LAB', '01-corpus')
const OUT = path.join(WORKSPACE_ROOT, '实施交接', '证据', 'C14-证据')
const fontFile = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc')

if (!fs.existsSync(fontFile)) throw new Error(`缺少系统中文字体：${fontFile}`)
if (!fs.existsSync(CORPUS)) throw new Error(`缺少 C02 固定语料：${CORPUS}`)
const clock = new Clock({ mode: 'system' })
const toolchain = resolveToolchain({ allowPathLookup: true })
const workRoot = path.join(PRODUCT_ROOT, 'editing', 'dev', '_tmp-evidence', 'work')
fs.rmSync(path.dirname(workRoot), { recursive: true, force: true })
fs.mkdirSync(workRoot, { recursive: true })
const projectsRoot = path.join(PRODUCT_ROOT, 'editing', 'dev', '_tmp-evidence', 'projects')
const adapter = createFfmpegAdapter({ toolchain, workRoot, clock, materialRoot: CORPUS })
fs.mkdirSync(OUT, { recursive: true })

const created = createProject({ projectsRoot, title: 'C14 编辑证据', clock })
const paths = new ProjectPaths(projectsRoot, created.project.projectId)
const versions = createVersionStore({ paths, clock })
const decisions = createDecisionLog({ paths, clock })
const current = versions.ensureCurrent({ actor: 'user' })
const basePlan = normalizePlan(buildC12UnitPlan({ fontFile }), { now: () => clock.iso() })
const baseSnapshot = writePlanSnapshot({ paths, ownerId: 'evidence-base', plan: basePlan, clock })
versions.updateCurrentContent({ content: { planRef: baseSnapshot.planRef } }, { actor: 'system' })
const kit = createEditingKit({ paths, clock })
const orchestration = createOrchestrationKit({ paths, clock })
orchestration.production.begin({
  producerSessionId: 'c14-evidence-producer',
  projectVersion: 'v1',
  baselineRef: 'baseline-1',
})
const mediaDir = paths.resolve('media')
fs.mkdirSync(mediaDir, { recursive: true })

/** Render one plan, copy it into the project media dir and hash/probe it. @param {any} plan @param {string} name */
function renderIntoProject(plan, name) {
  const renderPath = path.join(workRoot, `${name}.mp4`)
  const result = adapter.renderFinal(plan, plan.outputSpec, { outputPath: renderPath })
  const projectFile = path.join(mediaDir, `${name}.mp4`)
  fs.copyFileSync(result.file, projectFile)
  const probed = probeMedia(adapter.ffprobePath, projectFile)
  return {
    name,
    projectRelative: `media/${name}.mp4`,
    absolute: projectFile,
    bytes: fs.statSync(projectFile).size,
    sha256: result.sha256,
    planVersion: plan.planVersion,
    fps: `${probed.video.avgRate?.numerator ?? '?'}/${probed.video.avgRate?.denominator ?? '?'}`,
    width: probed.video.width,
    height: probed.video.height,
    frames: probed.video.nbFrames,
    durationSeconds: probed.format.durationSeconds,
    videoCodec: probed.video.codec,
    pixelFormat: probed.video.pixelFormat,
    audioCodec: probed.audio?.codec ?? null,
    audioChannels: probed.audio?.channels ?? null,
    renderMs: result.execution?.durationMs ?? null,
  }
}

/** Audio PCM identity between two rendered files. @param {string} left @param {string} right */
function audioIdentity(left, right) {
  const a = extractAudioPcm({ ffmpegPath: adapter.ffmpegPath, file: left, sampleRate: 48000, channels: 2 })
  const b = extractAudioPcm({ ffmpegPath: adapter.ffmpegPath, file: right, sampleRate: 48000, channels: 2 })
  return { beforeSha256: a.sha256, afterSha256: b.sha256, identical: a.sha256 === b.sha256 }
}

// 1) Original render.
const baseRender = renderIntoProject(basePlan, 'c14-base-original')

// 2) Direct edit: one subtitle text change, real candidate, accepted as current.
const session = kit.sessions.beginSession({
  target: '只改 S02 字幕文本',
  scope: 'object',
  targetObjectIds: ['obj-subtitle-S02'],
  plan: basePlan,
})
const edited = kit.sessions.applyEdit({
  sessionId: session.sessionId,
  intent: {
    kind: 'replace-text',
    objectId: 'obj-subtitle-S02',
    text: '程序视觉、已有素材与用户音频，在同一条时间线上协作。（修订）',
  },
})
const editedPlan = kit.sessions.readPlanSnapshotOf(kit.sessions.getSession(session.sessionId).steps[1].planRef).plan
const editedRender = renderIntoProject(editedPlan, 'c14-candidate-text')
const textAudio = audioIdentity(baseRender.absolute, editedRender.absolute)
const textRegions = repairRegionPlan(basePlan, editedPlan, { targetObjectId: 'obj-subtitle-S02', frame: 100 })
const textProtection = checkRepairProtection({
  adapter,
  beforePlan: basePlan,
  afterPlan: editedPlan,
  regions: { ...textRegions, frames: [100, 140, 155] },
  media: { beforeAudioSha256: textAudio.beforeSha256, afterAudioSha256: textAudio.afterSha256 },
})
kit.sessions.attachPreview({
  sessionId: session.sessionId,
  mediaRef: editedRender.projectRelative,
  coveredRange: { startFrame: 0, endFrameExclusive: editedPlan.timebase.totalFrames },
})
const formed = kit.sessions.formCandidate({ sessionId: session.sessionId })
const accepted = kit.candidates.acceptCandidate({ candidateId: formed.candidate.candidateId })
const currentAfterText = versions.getCurrent()
const textLink = kit.candidates.describeCandidate(formed.candidate.candidateId).link

// 3) Annotation bound to the accepted plan version, and a partial confirmation.
const annotation = kit.annotations.addAnnotation({
  versionId: currentAfterText.versionId,
  plan: editedPlan,
  objectId: 'obj-subtitle-S02',
  aspect: 'text',
  body: '这一句字幕改短一点，不要把两行挤在一起',
  author: '用户',
  evidenceRefs: [editedRender.projectRelative],
})
const partialConfirmation = kit.candidates.recordPartialConfirmation({
  objectId: 'obj-subtitle-S02',
  aspect: 'object-edit',
  scope: 'part',
  versionId: currentAfterText.versionId,
  humanResponse: '这一条字幕先认可，其它镜头继续看',
  candidateId: formed.candidate.candidateId,
})

// 4) AI complex modification on the SAME production sub-agent: one subtitle color change.
const aiRequest = kit.ai.planAiEdit({
  instruction: '把 S02 字幕改成暖黄色，其它不动',
  target: 'S02 字幕颜色',
  scope: 'object',
  targetObjectIds: ['obj-subtitle-S02'],
  plan: editedPlan,
})
const dispatched = kit.ai.dispatchToProducer({
  requestId: aiRequest.request.requestId,
  producerSessionId: 'c14-evidence-producer',
})
const returnedStep = kit.sessions.readPlanSnapshotOf(textLink.planRef)
const returnedPlan = applyDirectIntent({
  plan: returnedStep.plan,
  intent: { kind: 'set-property', objectId: 'obj-subtitle-S02', prop: 'color', value: '#ffd166' },
}).plan
const returnedRender = renderIntoProject(returnedPlan, 'c14-candidate-ai-color')
const aiAudio = audioIdentity(baseRender.absolute, returnedRender.absolute)
const aiRegions = repairRegionPlan(returnedStep.plan, returnedPlan, { targetObjectId: 'obj-subtitle-S02', frame: 100 })
const aiProtection = checkRepairProtection({
  adapter,
  beforePlan: returnedStep.plan,
  afterPlan: returnedPlan,
  regions: { ...aiRegions, frames: [100, 140] },
  media: { beforeAudioSha256: aiAudio.beforeSha256, afterAudioSha256: aiAudio.afterSha256 },
})
const aiReturned = kit.ai.recordProducerReturn({
  requestId: aiRequest.request.requestId,
  producerSessionId: 'c14-evidence-producer',
  plan: returnedPlan,
  previewRef: returnedRender.projectRelative,
  checkScope: ['plan-diff', 'scope-protection', 'render-result', 'region-compare'],
  knownIssues: [],
  actualChecks: ['plan-diff', 'region-compare', 'audio-identity'],
  evidenceRefs: [returnedRender.projectRelative],
})

// 5) Projection and evidence files.
const projection = publishEditingProjection({ paths, clock }).projection
fs.writeFileSync(path.join(OUT, 'projection.json'), `${JSON.stringify(projection, null, 2)}\n`, 'utf8')
for (const name of ['c14-base-original', 'c14-candidate-text', 'c14-candidate-ai-color']) {
  fs.copyFileSync(path.join(mediaDir, `${name}.mp4`), path.join(OUT, `${name}.mp4`))
}
const history = kit.history.listHistory()

// Field-level negative demonstration: move a NEIGHBOUR's box only, which C12 diffPlans cannot see.
const negativeNext = JSON.parse(JSON.stringify(editedPlan))
const neighbour = negativeNext.objects.find((entry) => entry.id === 'obj-sceneB-bg')
neighbour.box = { ...neighbour.box, x: neighbour.box.x + 12 }
const legacyNegative = diffPlans(editedPlan, negativeNext)
const fieldNegative = diffPlanFields(editedPlan, negativeNext)
const fieldCheck = assertFieldScope(fieldNegative, { targetObjectIds: ['obj-subtitle-S02'] })

const evidence = {
  schemaVersion: 1,
  kind: 'c14-editing-evidence',
  generatedAt: clock.iso(),
  toolchain: {
    ffmpeg: { path: toolchain.ffmpeg.path, version: toolchain.ffmpeg.version },
    ffprobe: { path: toolchain.ffprobe.path, version: toolchain.ffprobe.version },
    source: toolchain.source,
  },
  corpus: { video: 'RENDER-LAB/01-corpus/video/src-existing-1280x720-30fps-12s.mp4', audio: 'RENDER-LAB/01-corpus/audio/user-audio-continuous-9s-48k-stereo.wav' },
  projectId: paths.projectId,
  plan: {
    planId: basePlan.planId,
    basePlanVersion: basePlan.planVersion,
    editedPlanVersion: editedPlan.planVersion,
    returnedPlanVersion: returnedPlan.planVersion,
    totalFrames: basePlan.timebase.totalFrames,
    fps: `${basePlan.timebase.fpsNumerator}/${basePlan.timebase.fpsDenominator}`,
    output: `${basePlan.outputSpec.width}x${basePlan.outputSpec.height} ${basePlan.outputSpec.pixelFormat}`,
  },
  renders: { base: baseRender, textEdit: editedRender, aiColorEdit: returnedRender },
  scope: {
    direct: {
      sessionId: session.sessionId,
      changedObjectIds: edited.scope.changedObjectIds,
      changedFieldsByObject: edited.scope.changedFieldsByObject,
      protectedObjectIds: edited.scope.protectedObjectIds.length,
      audioProtected: edited.scope.audioProtected,
      timing: edited.scope.timing.totalFrames,
      candidateId: formed.candidate.candidateId,
      candidateAcceptedVersionId: accepted.version.versionId,
      currentPlanRef: currentAfterText.content.planRef,
    },
    protection: {
      text: {
        ok: textProtection.ok,
        targetChangedEverywhere: textProtection.targetChangedEverywhere,
        neighboursProtectedEverywhere: textProtection.neighboursProtectedEverywhere,
        audio: textProtection.audio,
        frames: textProtection.frames.map((frame) => ({ frame: frame.frame, targetChanged: frame.target.changed })),
        note: textProtection.note,
      },
      aiColor: {
        ok: aiProtection.ok,
        targetChangedEverywhere: aiProtection.targetChangedEverywhere,
        neighboursProtectedEverywhere: aiProtection.neighboursProtectedEverywhere,
        audio: aiProtection.audio,
        frames: aiProtection.frames.map((frame) => ({ frame: frame.frame, targetChanged: frame.target.changed })),
        note: aiProtection.note,
      },
    },
  },
  fieldProtection: {
    textEdit: {
      changedFieldsByObject: edited.scope.changedFieldsByObject,
      changedObjectIds: edited.scope.changedObjectIds,
      ok: edited.scope.ok,
    },
    aiCandidate: {
      changedFieldsByObject: aiReturned.scope.changedFieldsByObject,
      changedObjectIds: aiReturned.scope.changedObjectIds,
    },
    negativeNeighbourBox: {
      objectId: 'obj-sceneB-bg',
      field: 'box',
      legacyDiffChangedObjectIds: legacyNegative.changedObjectIds,
      legacyDiffSawIt: legacyNegative.changedObjectIds.includes('obj-sceneB-bg'),
      fieldDiffFields: fieldNegative.changedFieldsByObject['obj-sceneB-bg'] ?? null,
      refused: fieldCheck.ok === false,
      violations: fieldCheck.violations,
    },
    rule: '保护判断使用完整字段级比较（box／motion／zIndex／derivedFrom／timeline／params 及全部对象字段），不再调用 C12 diffPlans',
  },
  annotations: {
    annotationId: annotation.annotationId,
    objectId: annotation.objectId,
    aspect: annotation.aspect,
    versionId: annotation.versionId,
    planVerified: annotation.versionRef.planVerified,
    range: annotation.range,
  },
  partialConfirmation: {
    confirmationId: partialConfirmation.confirmation.confirmationId,
    state: partialConfirmation.confirmation.state,
    scope: partialConfirmation.confirmation.scope,
    wholeFilmAccepted: partialConfirmation.wholeFilmAccepted,
    candidateAccepted: partialConfirmation.candidateAccepted,
  },
  ai: {
    requestId: aiRequest.request.requestId,
    instruction: aiRequest.request.instruction,
    requestStatus: aiReturned.request.status,
    producerSessionId: dispatched.request.producerSessionId,
    producerRunId: dispatched.request.producerRunId,
    productionPausedForEditing: dispatched.production.paused,
    candidateId: aiReturned.candidate.candidateId,
    comparisonId: aiReturned.candidate.diffRef,
    realComparison: aiReturned.comparison.realComparison,
    baseStillCurrent: aiReturned.request.result.baseStillCurrent,
    knownIssues: aiReturned.request.result.knownIssues,
    checkScope: aiReturned.request.result.checkScope,
    actualChecks: aiReturned.request.result.actualChecks,
    aiViewed: aiReturned.request.result.aiViewed,
    aiListened: aiReturned.request.result.aiListened,
  },
  versions: {
    before: current.versionId,
    afterTextAccept: currentAfterText.versionId,
    candidates: versions.describe().candidates,
    final: versions.describe().finalVersionId,
    historyEntries: history.entries.length,
    historyReadOnly: history.readOnly,
  },
  projection: {
    file: '实施交接/证据/C14-证据/projection.json',
    candidates: projection.summary.candidates,
    annotations: projection.summary.annotations,
    partialConfirmations: projection.summary.partialConfirmations,
    honest: projection.honest,
  },
  media: {
    files: [
      { name: 'c14-base-original.mp4', role: 'source', sha256: baseRender.sha256 },
      { name: 'c14-candidate-text.mp4', role: 'result', sha256: editedRender.sha256 },
      { name: 'c14-candidate-ai-color.mp4', role: 'result', sha256: returnedRender.sha256 },
    ],
  },
  limits: [
    '区域对照用编码前合成帧，证明构图内目标变化与邻居未变，不证明编码后文件逐像素一致',
    '整片哈希不作为局部保护判据；音轨只到 PCM 哈希一致，不做听辨',
    'AI 未看、未听；程序检查与 AI 视听、用户验收三列分开',
    '本证据是技术夹具单元，不是按用户简报创作的作品',
    '未验证自由交互播放、长项目与真实宿主子 Agent 的模型调用',
  ],
  aiObservation: { viewed: false, listened: false, note: '没有图像/音频输入被模型观察；本脚本也不冒充看过听过' },
  humanAcceptance: { accepted: false, note: '用户尚未验收；程序通过不等于人类验收' },
}

fs.writeFileSync(path.join(OUT, 'editing-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
fs.writeFileSync(path.join(OUT, 'summary.md'), summary(evidence), 'utf8')
process.stdout.write(`evidence: ${path.join(OUT, 'editing-evidence.json')}\n`)
process.stdout.write(`media: ${['c14-base-original', 'c14-candidate-text', 'c14-candidate-ai-color'].map((name) => `${name}.mp4`).join(', ')}\n`)
process.stdout.write(`projection: candidates=${projection.summary.candidates} annotations=${projection.summary.annotations}\n`)

/** @param {any} evidence */
function summary(e) {
  return [
    '# C14 编辑证据摘要',
    '',
    `生成时间：${e.generatedAt}`,
    `项目：${e.projectId}`,
    '',
    '## 真实媒体',
    '',
    '| 文件 | 角色 | 帧 | 时长 | SHA-256 |',
    '|---|---|---:|---:|---|',
    `| c14-base-original.mp4 | 原版 | ${e.renders.base.frames} | ${e.renders.base.durationSeconds}s | ${e.renders.base.sha256} |`,
    `| c14-candidate-text.mp4 | 字幕修订候选 | ${e.renders.textEdit.frames} | ${e.renders.textEdit.durationSeconds}s | ${e.renders.textEdit.sha256} |`,
    `| c14-candidate-ai-color.mp4 | AI 候选（颜色） | ${e.renders.aiColorEdit.frames} | ${e.renders.aiColorEdit.durationSeconds}s | ${e.renders.aiColorEdit.sha256} |`,
    '',
    '## 局部保护（编码前区域对照）',
    '',
    `- 文字候选：目标区在 ${e.scope.protection.text.frames.length} 帧都变化=${e.scope.protection.text.targetChangedEverywhere}；邻居受保护=${e.scope.protection.text.neighboursProtectedEverywhere}；音轨 PCM 相同=${e.scope.protection.text.audio.identical}；结论=${e.scope.protection.text.ok}`,
    `- 颜色候选：目标区在 ${e.scope.protection.aiColor.frames.length} 帧都变化=${e.scope.protection.aiColor.targetChangedEverywhere}；邻居受保护=${e.scope.protection.aiColor.neighboursProtectedEverywhere}；音轨 PCM 相同=${e.scope.protection.aiColor.audio.identical}；结论=${e.scope.protection.aiColor.ok}`,
    '',
    '## 字段级保护（不依赖 C12 diffPlans）',
    '',
    `- 文字候选改到的字段：${JSON.stringify(e.fieldProtection.textEdit.changedFieldsByObject)}`,
    `- AI 候选改到的字段：${JSON.stringify(e.fieldProtection.aiCandidate.changedFieldsByObject)}`,
    `- 负向例（只挪邻居 obj-sceneB-bg 的 box）：C12 diffPlans 看到它=${e.fieldProtection.negativeNeighbourBox.legacyDiffSawIt}；字段比较报出=${JSON.stringify(e.fieldProtection.negativeNeighbourBox.fieldDiffFields)}；范围拒绝=${e.fieldProtection.negativeNeighbourBox.refused}`,
    '',
    '## 版本与决定',
    '',
    `- 起点版本 ${e.versions.before} → 接受文字候选后 ${e.versions.afterTextAccept}；未定稿`,
    `- 直接修改只改 ${e.scope.direct.changedObjectIds.join('、')}，保护 ${e.scope.direct.protectedObjectIds} 个对象`,
    `- 局部确认 ${e.partialConfirmation.confirmationId} 状态 ${e.partialConfirmation.state}；整片验收=${e.partialConfirmation.wholeFilmAccepted}`,
    `- AI 请求 ${e.ai.requestId} 由 ${e.ai.producerSessionId} 返回候选 ${e.ai.candidateId}；基础仍是当前=${e.ai.baseStillCurrent}`,
    '',
    '## 不能声称',
    '',
    ...e.limits.map((line) => `- ${line}`),
    '',
  ].join('\n')
}
