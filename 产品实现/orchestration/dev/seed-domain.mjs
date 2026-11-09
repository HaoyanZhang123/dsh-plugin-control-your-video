/**
 * Seed the evidence project with the C13 facts this session actually produced, so the domain view
 * shows real content instead of a canned fixture.
 *
 * Every brief line is quoted from this session's own authorizations or from the handoff package;
 * every direction is one of the three this session proposed; the plan items stay UNDECIDED on
 * purpose, because the user has not confirmed this project's baseline — the view must show the
 * blocker rather than a green "ready".
 *
 * Usage: node orchestration/dev/seed-domain.mjs --root <projects root> --project <prj_…>
 *
 * @module orchestration/dev/seed-domain
 */

import path from 'node:path'

import { Clock } from '../../base/index.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { BriefSource, CreationBrief } from '../../orchestration/brief.js'
import { DirectionSet, PlanBaseline } from '../../orchestration/direction.js'
import { PreviewSurface } from '../../orchestration/preview.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'

/** @param {string} flag @param {string|null} fallback */
function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function main() {
  const root = arg('--root')
  const projectId = arg('--project')
  if (root === null || projectId === null) throw new Error('需要 --root 与 --project')
  const clock = new Clock({ mode: 'system' })
  const paths = new ProjectPaths(path.resolve(root), projectId)

  const brief = new CreationBrief({ paths, clock })
  const existing = brief.summary().counts
  if (existing.user + existing.source + existing.ai + existing.unknown === 0) {
    brief.addEntry({ source: BriefSource.USER, text: '用已就位的渲染工作区出真实单元与成片' })
    brief.addEntry({ source: BriefSource.USER, text: '不得冒称已听音频，不得用文字摘要冒充实看图' })
    brief.addEntry({ source: BriefSource.SOURCE, text: 'C02 核验记录：该 9 秒单元已由用户实际看过并听过（限当前样片）' })
    brief.addEntry({ source: BriefSource.AI, text: '推断：彩条测试画面适合当门禁证据，不适合当审美样片' })
    brief.addEntry({ source: BriefSource.UNKNOWN, text: '领域视图的最终面位由谁裁定尚未确定' })
  }

  const directions = new DirectionSet({ paths, clock })
  if (directions.list().length === 0) {
    const first = directions.addProposal({
      title: '方向甲：真实单元照原样交付',
      route: '直接渲染 C02 结构，字幕文案不动',
      experience: '最短路径拿到可播整片',
      tradeoffs: ['没有修改闭环证据'],
      unknowns: ['观众是否接受测试画面'],
      proposedBy: 'ai',
    })
    const second = directions.addProposal({
      title: '方向乙：真实单元＋一次字幕修订',
      route: '渲染后只改 S02 字幕并重渲，其余不动',
      experience: '能看到修改只影响目标对象',
      highlights: ['形成预期—实际—决定的真实闭环'],
      tradeoffs: ['字幕条宽度固定，长文本会顶到边缘'],
      unknowns: ['修订后右缘余量是否够'],
      proposedBy: 'ai',
    })
    directions.combine({
      directionIds: [first.direction.directionId, second.direction.directionId],
      title: '方向丙：修订后再出交付规格整片',
      route: '先修订 S02，再按 1920×1080 交付规格重渲整片',
      experience: '同一条内容既有修改证据又有交付规格',
      newElements: ['把交付规格渲染放在修订之后，让整片包含修订'],
      reviewedParts: ['字幕区', '整片规格'],
      proposedBy: 'ai',
    })
  }

  const baseline = new PlanBaseline({ paths, clock })
  if (baseline.read().items.length === 0) {
    baseline.addItem({ kind: 'core-goal', title: '9 秒双场景单元与交付规格整片', detail: '以 C02 已验收结构为内容' })
    baseline.addItem({ kind: 'structure', title: '两场景＋叠加转场，270 帧' })
    baseline.addItem({ kind: 'delivery-spec', title: '1920×1080、30fps、H.264/AAC' })
    baseline.addItem({ kind: 'authorization', title: '允许把成片交给用户审片' })
  }

  const previews = new PreviewSurface({ paths, clock })
  if (previews.latest() === null) {
    const windir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
    const base = normalizePlan(buildC12UnitPlan({ fontFile: path.join(windir, 'Fonts', 'msyh.ttc') }))
    previews.recordPreview({ basePlan: { ...base, planVersion: 'plan-v1' }, coveredRange: null, file: 'media/unit-001-master.mp4', taskId: 'c13-real-render' })
  }

  process.stdout.write(`seeded ${projectId}\n`)
  process.stdout.write(`brief: ${JSON.stringify(brief.summary().counts)}\n`)
  process.stdout.write(`directions: ${directions.list().length}\n`)
  process.stdout.write(`plan items: ${baseline.read().items.length}, gate ok=${baseline.gate().ok}\n`)
  process.stdout.write(`preview plan: ${previews.latest()?.planVersion}\n`)
}

main()
