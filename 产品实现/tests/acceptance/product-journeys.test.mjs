/**
 * Acceptance layer: REAL product journeys.
 *
 * This file exists so the layer is not silently absent, and it FAILS BY DESIGN while there is
 * no product to accept. That is the point: the task card forbids "骨架能构建、覆盖率或命令成功
 * 冒充产品功能完成". A passing acceptance run must mean a user could actually do the thing.
 *
 * Every test here is marked `todo` with the owning card, so the gap is visible in test output
 * rather than hidden in a document. When a product surface exists, the owning card replaces
 * the todo with a real journey and records actual user acceptance separately.
 *
 * @module tests/acceptance/product-journeys.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Why the acceptance layer cannot run yet. Kept as data so the runner and the receipt can
 * quote the same reason instead of two drifting copies.
 */
export const ACCEPTANCE_BLOCKERS = Object.freeze({
  productSurface:
    '宿主半（lib/index.js）与 client 半尚不存在；cordis.patch.yml 为空列表，插件未在 DSH 中注册或加载。',
  projectCore: '项目、材料、确认、版本与存储核心由 C10 实现，当前不存在。',
  productUi: '四入口与创作／作品工作面由 C11 实现，当前不存在可点击页面。',
  mediaRuntime: 'CompositionPlan、渲染与媒体由 C12 实现，当前没有真实作品产出链路。',
  humanAcceptance: '没有真实作品，因此没有任何可由用户观看／听辨并确认的对象。',
})

test('acceptance: a real product exists to accept', () => {
  assert.fail(
    `无法执行真实产品验收：${ACCEPTANCE_BLOCKERS.productSurface} ` +
      '本层按设计失败，避免用工程骨架冒充产品完成。',
  )
})

test('acceptance: a user can create, save and continue a project (C10)', { todo: 'C10 交付后实现真实旅程' }, () => {})

test('acceptance: a user can reach the four entries and two surfaces (C11)', { todo: 'C11 交付后实现真实旅程' }, () => {})

test('acceptance: a user can produce a complete first cut (C12/C13)', { todo: 'C12/C13 交付后实现真实旅程' }, () => {})

test('acceptance: a user can modify, compare and accept a candidate (C14)', { todo: 'C14 交付后实现真实旅程' }, () => {})

test('acceptance: a user can export deliverables and a project package (C15)', { todo: 'C15 交付后实现真实旅程' }, () => {})
