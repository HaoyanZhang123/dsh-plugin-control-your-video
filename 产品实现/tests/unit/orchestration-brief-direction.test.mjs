/**
 * Unit tests for the brief, research authorization, directions and the plan baseline.
 *
 * These tests are about separations that must not collapse: user requirement vs AI inference, source
 * claim vs verified fact, direction A vs direction B, "presented together" vs "confirmed together",
 * and "AI allowed to decide" vs "user decided". Several of them assert a REFUSAL, because the refusal
 * is the feature.
 *
 * @module tests/unit/orchestration-brief-direction.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import {
  BriefSource,
  CreationBrief,
  ResearchLog,
  adoptCapabilityGap,
  composeCapabilities,
  legacyUiStateStanding,
  migrateLegacyUiState,
  readAssistantThread,
} from '../../orchestration/brief.js'
import {
  DirectionSet,
  PlanBaseline,
  ReferenceScopes,
  SeriesShares,
  TemplateDeclaredBy,
} from '../../orchestration/direction.js'

const temp = createTempDir({ label: 'orchestration-brief-direction' })
test.after(() => temp.dispose())

const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
let counter = 0

/** @returns {{ root: string, paths: any }} */
function makeProject() {
  counter += 1
  const root = temp.dir(`root-${counter}`)
  const created = createProject({ projectsRoot: root, title: `简报 ${counter}`, clock })
  return { root, paths: new ProjectPaths(root, created.project.projectId) }
}

test('brief: four sources stay separate and an AI inference never becomes a requirement', () => {
  const { paths } = makeProject()
  const brief = new CreationBrief({ paths, clock })
  brief.addEntry({ source: BriefSource.USER, text: '要一个 12 秒的水墨短片' })
  brief.addEntry({ source: BriefSource.SOURCE, text: '参考片说明写的是 24 格' })
  brief.addEntry({ source: BriefSource.AI, text: '可能适合留白构图' })
  brief.addEntry({ source: BriefSource.UNKNOWN, text: '是否需要字幕尚不清楚' })

  const summary = brief.summary()
  assert.deepEqual(summary.counts, { user: 1, source: 1, ai: 1, unknown: 1, removed: 0 })
  assert.equal(summary.userRequirements[0].text.includes('水墨'), true)
  assert.equal(summary.aiInferences[0].source, BriefSource.AI)
  // The AI edit path keeps the source: editing an inference does not promote it.
  const edited = brief.editEntry({ entryId: summary.aiInferences[0].entryId, text: '可能适合大量留白', actor: 'user' })
  assert.equal(edited.entry.source, BriefSource.AI)
  assert.equal(brief.summary().counts.user, 1)
  assert.equal(edited.entry.history.length, 1)
})

test('brief: removal is a soft delete and open unknowns are visible', () => {
  const { paths } = makeProject()
  const brief = new CreationBrief({ paths, clock })
  const added = brief.addEntry({ source: BriefSource.UNKNOWN, text: '配乐是否要原创' })
  assert.equal(brief.openUnknowns().length, 1)
  brief.removeEntry({ entryId: added.entry.entryId, reason: '用户已决定不要配乐' })
  assert.equal(brief.summary().counts.unknown, 0)
  assert.equal(brief.summary().counts.removed, 1)
  assert.throws(() => brief.editEntry({ entryId: added.entry.entryId, text: '改一下' }), /已删除/)
})

test('research: no source can be recorded without a user-granted scope', () => {
  const { paths } = makeProject()
  const research = new ResearchLog({ paths, clock })
  assert.throws(() => research.recordSource({ title: '参考片', location: '内网链接', claim: '节奏偏慢' }), /研究范围/)
  assert.throws(
    () => research.recordAuthorization({ scope: '只看公开页面', humanResponse: '可以', grantedBy: 'ai' }),
    /只能由用户授予/,
  )
  const granted = research.recordAuthorization({ scope: '只看公开页面', humanResponse: '可以先看公开资料', grantedBy: 'user' })
  assert.equal(granted.authorization.state, 'granted')
  const recorded = research.recordSource({ title: '参考片', location: '公开页面', claim: '节奏偏慢' })
  research.recordObservation({
    sourceId: recorded.source.sourceId,
    view: '前 20 秒',
    note: '镜头整体偏静态',
    unverified: ['音频是否同步未验证'],
  })
  const summary = research.summary()
  assert.equal(summary.sources, 1)
  assert.equal(summary.observations, 1)
  assert.equal(summary.unknown.length, 1)
})

test('capability: gaps are proposed only, and adoption needs an authorization reference', () => {
  const plan = composeCapabilities({
    task: '水墨短片',
    needs: [
      { need: '字体排版', kind: 'tool', candidates: ['字体 A', '字体 B'], available: false, preferred: '字体 A', fallback: '字体 B', minimalValidation: '先渲染一行字看裁切' },
      { need: '合成', kind: 'tool', candidates: ['ffmpeg'], available: true },
    ],
  })
  assert.equal(plan.gaps.length, 1)
  assert.equal(plan.gaps[0].status, 'proposed')
  assert.equal(plan.gaps[0].autoAdopted, false)
  assert.equal(plan.requiresAuthorization, true)
  assert.throws(() => adoptCapabilityGap(plan.gaps[0], { option: '字体 A' }), /authorizationRef/)
  const adopted = adoptCapabilityGap(plan.gaps[0], { option: '字体 A', authorizationRef: 'aut_test', authorizationScope: '本次项目' })
  assert.equal(adopted.status, 'authorized')
  assert.equal(adopted.autoAdopted, false)
  assert.throws(() => adoptCapabilityGap(plan.gaps[0], { option: '字体 C', authorizationRef: 'aut_test' }), /只能采用/)
})

test('directions: a combination must add something real, not just concatenate names', () => {
  const { paths } = makeProject()
  const directions = new DirectionSet({ paths, clock })
  const a = directions.addProposal({ title: '方向甲：单色水墨', route: '整片单色，只用浓淡', experience: '安静' })
  const b = directions.addProposal({ title: '方向乙：朱红点睛', route: '大面积墨色＋一处朱红', experience: '有冲击' })

  assert.throws(
    () =>
      directions.combine({
        directionIds: [a.direction.directionId, b.direction.directionId],
        title: '甲＋乙',
        route: '两者结合',
        experience: '既安静又有冲击',
        newElements: [],
      }),
    /真实新增/,
  )
  const combined = directions.combine({
    directionIds: [a.direction.directionId, b.direction.directionId],
    title: '方向丙：墨底朱红只出现一次',
    route: '全片墨色，结尾一次朱红扩散',
    experience: '安静为主，收束时收紧注意力',
    newElements: ['朱红只在结尾出现一次，并承担叙事转折'],
    reviewedParts: ['整片节奏', '结尾构图'],
  })
  assert.equal(combined.direction.combination.sources.length, 2)
  assert.equal(combined.direction.combination.newElements.length, 1)
  // Source versions are pinned, so a later revision cannot silently change what this was built from.
  assert.equal(typeof combined.direction.combination.sources[0].version, 'number')

  const revised = directions.revise({ directionId: a.direction.directionId, reason: '收窄时长', patch: { route: '整片单色，只用浓淡，控制在 12 秒' } })
  assert.equal(revised.direction.version, 2)
  assert.equal(revised.direction.history.length, 1)
})

test('baseline: key items block production until the user decides', () => {
  const { paths } = makeProject()
  const baseline = new PlanBaseline({ paths, clock })
  const goal = baseline.addItem({ kind: 'core-goal', title: '12 秒水墨短片', detail: '无对白' })
  const auth = baseline.addItem({ kind: 'authorization', title: '允许开始制作' })
  const deliver = baseline.addItem({ kind: 'delivery-spec', title: '1920×1080、25fps、MP4' })

  const blocked = baseline.gate()
  assert.equal(blocked.ok, false)
  assert.equal(blocked.blockers.some((blocker) => blocker.kind === 'core-goal'), true)

  // AI cannot decide a plan item, and cannot create one already decided.
  assert.throws(() => baseline.addItem({ kind: 'structure', title: '三段式', state: 'decided' }), /不能以“已定”状态新建/)
  assert.throws(() => baseline.setItemState({ itemId: goal.item.itemId, state: 'decided', actor: 'ai' }), /只有用户能决定/)

  baseline.setItemState({ itemId: goal.item.itemId, state: 'decided', actor: 'user', reason: '用户确认目标' })
  baseline.setItemState({ itemId: deliver.item.itemId, state: 'ai-allowed', actor: 'ai', authorizationRef: 'aut_1', reason: '交付规格沿用常规' })
  const stillBlocked = baseline.gate()
  assert.equal(stillBlocked.ok, false, '授权项仍未定，不能开始完整制作')

  baseline.setItemState({ itemId: auth.item.itemId, state: 'decided', actor: 'user', reason: '用户同意开始' })
  assert.equal(baseline.gate().ok, true)
})

test('baseline revision: an edit to a decided item reopens it and declares the recheck scope', () => {
  const { paths } = makeProject()
  const baseline = new PlanBaseline({ paths, clock })
  const goal = baseline.addItem({ kind: 'core-goal', title: '12 秒水墨短片' })
  baseline.setItemState({ itemId: goal.item.itemId, state: 'decided', actor: 'user' })
  const revised = baseline.revise({ changes: [{ itemId: goal.item.itemId, patch: { detail: '改为 15 秒' } }], reason: '用户要求加长' })
  assert.equal(revised.baselineVersion, 1)
  assert.deepEqual(revised.recheckScope, [goal.item.itemId])
  const item = baseline.read().items.find((entry) => entry.itemId === goal.item.itemId)
  assert.equal(item.state, 'undecided', '改过的已定项必须重新确认')
})

test('template: fixed slots cannot be adapted and adaptation stays a candidate', () => {
  const { paths } = makeProject()
  const baseline = new PlanBaseline({ paths, clock })
  assert.throws(
    () => baseline.adaptTemplate({ adaptations: [{ slot: '开场构图', value: '换成俯拍' }] }),
    /没有已绑定模板/,
  )
  baseline.bindTemplate({
    templateId: 'tpl-series-opener',
    declaredBy: TemplateDeclaredBy.USER,
    fixedSlots: ['片头 Logo 位置', '品牌色'],
    variableSlots: ['开场构图', '音乐长度'],
    source: '用户确认的系列片头模板',
  })
  assert.throws(
    () => baseline.adaptTemplate({ adaptations: [{ slot: '品牌色', value: '改为橙红' }] }),
    /固定槽位不允许适配/,
  )
  const adapted = baseline.adaptTemplate({ adaptations: [{ slot: '开场构图', value: '俯拍水面' }] })
  assert.equal(adapted.appliedAsCandidate, true)
  assert.equal(adapted.confirmed, false, '应用模板不等于效果确认')
})

test('series: an update is proposed, then adopted explicitly per project', () => {
  const { paths } = makeProject()
  const series = new SeriesShares({ paths, clock })
  const proposed = series.proposeUpdate({ seriesId: 'ser_demo', summary: '统一片头颜色', changes: ['片头底色由米白改为宣纸白'] })
  assert.equal(proposed.update.status, 'pending-user-adoption')
  assert.equal(proposed.update.appliedAutomatically, false)
  assert.throws(() => series.assertAdopted(proposed.update.updateId, paths.projectId), /没有采用/)
  series.adoptUpdate({ updateId: proposed.update.updateId, projectIds: [paths.projectId], scope: '仅片头', authorizationRef: 'aut_2' })
  const adopted = series.assertAdopted(proposed.update.updateId, paths.projectId)
  assert.equal(adopted.authorizationRef, 'aut_2')
})

test('reference scope: an aspect outside the named range is refused', () => {
  const { paths } = makeProject()
  const references = new ReferenceScopes({ paths, clock })
  const scope = references.defineScope({
    source: '用户提供的参考片',
    rights: '仅用于本项目参考，不复制发行',
    aspects: ['visual', 'shot'],
    excluded: ['sound'],
  })
  assert.equal(references.allows(scope.scope.scopeId, 'visual'), true)
  assert.equal(references.allows(scope.scope.scopeId, 'sound'), false)
  assert.throws(() => references.assertAllows(scope.scope.scopeId, 'sound'), /不在用户授权的参考复刻范围内/)
  const attached = references.attachAnalysis(scope.scope.scopeId, 'ran_1')
  assert.equal(attached.scope.analysisRequired, false)
})

test('legacy ui-state: the brief and queued messages move into project facts once', () => {
  const { root, paths } = makeProject()
  const dataRoot = path.join(root, 'data')
  const uiState = path.join(dataRoot, 'ui-state')
  fs.mkdirSync(uiState, { recursive: true })
  const projectId = paths.projectId
  fs.writeFileSync(
    path.join(uiState, `${projectId}.json`),
    JSON.stringify({ surface: 'creation', brief: { user: '想要一个关于雨的短片', source: '参考片说明写 30 秒', ai: '可能适合冷色' } }),
    'utf8',
  )
  fs.writeFileSync(
    path.join(uiState, `${projectId}.assistant.json`),
    JSON.stringify({
      messages: [
        { messageId: 'msg_0001', at: '2026-11-01T00:00:00.000Z', author: 'user', text: '先看方向', refs: [], status: 'queued-for-orchestration' },
      ],
      nextSeq: 2,
    }),
    'utf8',
  )

  const first = migrateLegacyUiState({ paths, dataRoot, clock })
  assert.equal(first.status, 'completed')
  assert.equal(first.uiReadOnly, true)
  assert.equal(first.record.briefEntriesWritten, 3)
  assert.equal(first.record.messagesWritten, 1)
  assert.equal(first.record.originalsKept, true)

  const brief = new CreationBrief({ paths, clock }).summary()
  assert.equal(brief.counts.user, 1)
  assert.equal(brief.counts.source, 1)
  assert.equal(brief.counts.ai, 1)
  assert.equal(brief.userRequirements[0].provenance.origin, 'legacy-ui-state')

  const thread = readAssistantThread({ paths, clock })
  assert.equal(thread.messages.length, 1)
  assert.equal(thread.messages[0].status, 'received')
  assert.equal(thread.messages[0].legacyStatus, 'queued-for-orchestration')

  // The legacy files are still there, untouched: migration never deletes user text.
  assert.equal(fs.existsSync(path.join(uiState, `${projectId}.json`)), true)

  const second = migrateLegacyUiState({ paths, dataRoot, clock })
  assert.equal(second.status, 'already-migrated')
  assert.equal(new CreationBrief({ paths, clock }).summary().counts.user, 1, '重复迁移不能产生重复条目')

  const standing = legacyUiStateStanding({ paths, clock })
  assert.equal(standing.readOnly, true)
})

test('legacy ui-state: a broken file is reported and nothing is guessed', () => {
  const { root, paths } = makeProject()
  const dataRoot = path.join(root, 'data')
  const uiState = path.join(dataRoot, 'ui-state')
  fs.mkdirSync(uiState, { recursive: true })
  const broken = path.join(uiState, `${paths.projectId}.assistant.json`)
  fs.writeFileSync(broken, '{ not json', 'utf8')

  const result = migrateLegacyUiState({ paths, dataRoot, clock })
  assert.equal(result.status, 'needs-handling')
  assert.equal(result.uiReadOnly, false)
  assert.equal(result.needsHandling.length, 1)
  assert.equal(result.needsHandling[0].code, 'legacy-unreadable')
  // The unreadable file is kept byte for byte.
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ not json')
  assert.equal(readAssistantThread({ paths, clock }).messages.length, 0)
})
