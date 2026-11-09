/**
 * Unit tests for the workbench layout, search, keyboard and formatting models.
 *
 * These are the behaviours a real window, a real search box and a real keyboard depend on, tested
 * without a browser so a regression is visible before anyone opens the panel.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveLayout, resolveSurfaceVisibility, fitCanvas, LAYOUT_BREAKPOINTS } from '../../ui/client/model/layout.js'
import { searchProjects, groupByPhase, normalize, projectSearchText } from '../../ui/client/model/search.js'
import { resolveKeyAction, isTypingTarget, KEY_ACTIONS, SHORTCUT_HELP } from '../../ui/client/model/keyboard.js'
import { formatBytes, formatRelative, shortId, middleTruncate, formatMinuteSeconds } from '../../ui/client/model/format.js'
import { phaseLabel, toolStateLabel, isAttentionExecution } from '../../ui/client/model/labels.js'

test('layout keeps the canvas usable at every width', () => {
  const wide = resolveLayout(1600, 980)
  assert.equal(wide.mode, 'wide')
  assert.equal(wide.showLeft, true)
  assert.equal(wide.showRight, true)
  assert.ok(wide.canvasMinWidth > 0)

  const medium = resolveLayout(1100, 900)
  assert.equal(medium.mode, 'medium')
  assert.equal(medium.showLeft, true)
  assert.equal(medium.showRight, true)
  assert.ok(medium.leftWidth < wide.leftWidth)

  const narrow = resolveLayout(900, 800)
  assert.equal(narrow.mode, 'narrow')
  assert.equal(narrow.showLeft, false)
  assert.equal(narrow.showRight, true)

  const tiny = resolveLayout(700, 700)
  assert.equal(tiny.showLeft, false)
  assert.equal(tiny.showRight, false)
  assert.ok(tiny.canvasMinWidth >= 280)
  assert.ok(LAYOUT_BREAKPOINTS.wide > LAYOUT_BREAKPOINTS.medium)
})

test('surface visibility hides empty tracks instead of drawing them', () => {
  const silent = resolveSurfaceVisibility({ hasNarration: false, hasSubtitles: false, hasSound: false })
  assert.equal(silent.narration, false)
  assert.equal(silent.subtitles, false)
  assert.equal(silent.sound, false)
  assert.equal(silent.markers, true)
  const full = resolveSurfaceVisibility({
    hasNarration: true,
    hasSubtitles: true,
    hasSound: true,
    hasTransitions: true,
  })
  assert.equal(full.narration, true)
  assert.equal(full.transitions, true)
})

test('canvas fitting preserves 16:9 and letterboxes the remainder', () => {
  const fit = fitCanvas(1000, 300, 16 / 9)
  assert.equal(fit.height, 252)
  assert.equal(fit.width, 448)
  assert.ok(fit.letterboxX >= 0)
  assert.ok(fit.letterboxY >= 0)
})

const projects = [
  { projectId: 'p1', title: '机械键盘解释片', phaseLabel: '制作中', executionLabel: '已暂停', updatedAt: '2026-11-08T10:00:00.000Z', tags: ['键盘'] },
  { projectId: 'p2', title: '城市夜行', phaseLabel: '初版待审', executionLabel: '等待你的决定', updatedAt: '2026-11-07T10:00:00.000Z', tags: [] },
  { projectId: 'p3', title: '键盘声音测试', phaseLabel: '接收输入', executionLabel: '空闲', updatedAt: '2026-11-06T10:00:00.000Z', tags: ['音频'] },
]

test('search matches title, status and tags; all words must hit', () => {
  assert.deepEqual(searchProjects(projects, '键盘').map((p) => p.projectId), ['p3', 'p1'])
  assert.deepEqual(searchProjects(projects, '暂停').map((p) => p.projectId), ['p1'])
  assert.deepEqual(searchProjects(projects, '键盘 音频').map((p) => p.projectId), ['p3'])
  assert.deepEqual(searchProjects(projects, '不存在的词'), [])
  assert.deepEqual(searchProjects(projects, '   ').map((p) => p.projectId), ['p1', 'p2', 'p3'])
  assert.match(projectSearchText(projects[0]), /制作中/)
  assert.equal(normalize('　Ａ  B '), 'ａ b')
})

test('search ranks a title prefix above a tag-only hit', () => {
  const ranked = searchProjects([
    { projectId: 'a', title: '别的项目', tags: ['键盘'], updatedAt: '2026-11-01T00:00:00.000Z' },
    { projectId: 'b', title: '键盘结构', tags: [], updatedAt: '2026-10-01T00:00:00.000Z' },
  ], '键盘')
  assert.equal(ranked[0].projectId, 'b')
})

test('phase grouping keeps the documented display order', () => {
  const groups = groupByPhase([
    { phase: 'completed', phaseLabel: '已完成' },
    { phase: 'intake', phaseLabel: '接收输入' },
    { phase: 'drawing' },
  ])
  assert.deepEqual(groups.map((group) => group.phase), ['intake', 'completed', 'drawing'])
})

test('keyboard maps keys and never steals typing', () => {
  assert.deepEqual(
    resolveKeyAction({ key: ' ' }, { typing: false }),
    { action: KEY_ACTIONS.PLAY_PAUSE, preventDefault: true },
  )
  assert.equal(resolveKeyAction({ key: ' ' }, { typing: true }).action, null)
  assert.equal(resolveKeyAction({ key: 'a' }, { typing: true }).action, null)
  assert.equal(resolveKeyAction({ key: 'ArrowLeft' }).action, KEY_ACTIONS.FRAME_PREV)
  assert.equal(resolveKeyAction({ key: 'ArrowRight', shiftKey: true }).action, KEY_ACTIONS.JUMP_NEXT_10)
  assert.equal(resolveKeyAction({ key: 'i' }).action, KEY_ACTIONS.MARK_IN)
  assert.equal(resolveKeyAction({ key: 'o' }).action, KEY_ACTIONS.MARK_OUT)
  assert.equal(resolveKeyAction({ key: 'm' }).action, KEY_ACTIONS.ADD_MARKER)
  assert.equal(resolveKeyAction({ key: 'z', ctrlKey: true }).action, KEY_ACTIONS.UNDO)
  assert.equal(resolveKeyAction({ key: 'z', ctrlKey: true, shiftKey: true }).action, KEY_ACTIONS.REDO)
  assert.equal(resolveKeyAction({ key: 'f', ctrlKey: true }).action, KEY_ACTIONS.FIND)
  assert.equal(resolveKeyAction({ key: 'Escape' }, { typing: true }).action, KEY_ACTIONS.ESCAPE)
  assert.equal(resolveKeyAction({ key: 'Delete' }, { hasSelection: false }).action, null)
  assert.equal(resolveKeyAction({ key: 'Delete' }, { hasSelection: true }).action, KEY_ACTIONS.DELETE_SELECTION)
  assert.equal(resolveKeyAction({ key: ' ' }, { composing: true }).action, null)
  assert.ok(SHORTCUT_HELP.length >= 8)
})

test('typing detection covers inputs, textareas and contenteditable', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true)
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isTypingTarget(null), false)
})

test('formatting is deterministic and unit-correct', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(3.5 * 1024 * 1024), '3.5 MB')
  assert.equal(formatMinuteSeconds(75), '01:15')
  assert.equal(shortId('project_ab12cd34ef'), 'ab12cd34')
  assert.equal(middleTruncate('a-very-long-file-name-for-testing.png', 20).includes('…'), true)
  const now = Date.parse('2026-11-08T12:00:00.000Z')
  assert.equal(formatRelative('2026-11-08T11:59:30.000Z', now), '刚刚')
  assert.equal(formatRelative('2026-11-08T11:30:00.000Z', now), '30 分钟前')
  assert.equal(formatRelative('2026-11-07T10:00:00.000Z', now), '昨天')
})

test('labels fall back honestly instead of inventing states', () => {
  assert.equal(phaseLabel('producing'), '制作中')
  assert.equal(phaseLabel('something-new'), 'something-new')
  assert.equal(toolStateLabel('not-installed'), '未安装')
  assert.equal(isAttentionExecution('needs-attention'), true)
  assert.equal(isAttentionExecution('idle'), false)
})
