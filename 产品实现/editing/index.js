/**
 * EDITING-REVIEW public entry surface.
 *
 * This is the only supported import path for C14. Later cards (C15, C16) call
 * `createEditingKit` and use the annotation, session, AI-handoff, candidate, history and projection
 * stores; they must not import `editing/*.js` internals, so an internal refactor cannot break them.
 *
 * What this surface deliberately does NOT contain matters as much as what it does: no spawner for a
 * new making agent, no "edit anything" API, no fourth version class, no whole-film rollback and no
 * silent fallback when a preview is missing. The product forbids those organizations, so there is no
 * function to call that would create one.
 *
 * @module editing/index
 */

import { Clock, ValidationError } from '../base/index.js'
import { EDITING_INTERFACE_VERSION } from './ids.js'
import { createAnnotationStore } from './annotations.js'
import { createCandidateReview } from './candidates.js'
import { createComparisonStore } from './comparisons.js'
import { createHistoryView } from './history.js'
import { createAiEditing } from './producer.js'
import { createDirectEditing } from './sessions.js'

export {
  EDITING_DOCUMENT,
  EDITING_INTERFACE_VERSION,
  EDITING_LAYOUT,
  MAX_EDIT_REF_LENGTH,
  MAX_EDIT_TEXT_LENGTH,
  assertFrame,
  assertPlanRef,
  assertPositiveInt,
  assertRef,
  assertRefList,
  assertText,
  copy,
  describePlan,
  framesInRanges,
  newEditingId,
  optionalRef,
  optionalText,
  planOfVersion,
  planRelativePath,
  readPlanSnapshot,
  writePlanSnapshot,
} from './ids.js'
export {
  AnnotationAspect,
  AnnotationStatus,
  createAnnotationStore,
  emptyAnnotationsDocument,
} from './annotations.js'
export {
  EDITABLE_PRODUCTION_STATES,
  NEEDS_CHECK_STATES,
  PAUSE_FIRST_STATES,
  describeEditingLock,
  ensureEditingAllowed,
  ensurePlanningAllowed,
  inspectEditingState,
  pauseProductionForEditing,
  withEditingWrite,
} from './guard.js'
export {
  TIMING_INTENTS,
  UNOBSERVED_PROPERTIES,
  affectedWindows,
  analyzeScope,
  applyDirectIntent,
  assertPlan,
  buildComparison,
  describeEditScope,
  describeTimingImpact,
} from './scope.js'
export {
  IGNORED_OBJECT_FIELDS,
  IGNORED_PLAN_FIELDS,
  assertComparablePlan,
  assertFieldScope,
  describeFieldDiff,
  diffPlanFields,
} from './field-diff.js'
export {
  EditSessionStatus,
  createDirectEditing,
  emptySessionsDocument,
} from './sessions.js'
export { createComparisonStore, emptyComparisonsDocument } from './comparisons.js'
export {
  EditRequestStatus,
  PRODUCER_RETURN_CONTRACT,
  createAiEditing,
  emptyRequestsDocument,
} from './producer.js'
export { PartialAdoptionStatus, createCandidateReview } from './candidates.js'
export { createCandidateLinks, emptyCandidateLinksDocument } from './links.js'
export { createHistoryView } from './history.js'
export {
  EDITING_PROJECTION_KIND,
  EDITING_PROJECTION_VERSION,
  PROJECTION_LIMITS,
  buildEditingProjection,
  latestEditingProjection,
  publishEditingProjection,
} from './projection.js'

/** Interface version of this module (exported above from `ids.js`). */

/**
 * What C14 can honestly claim today, and where every claim stops.
 *
 * Data rather than prose, so a receipt, a test or a later card reads it instead of trusting a
 * comment.
 */
export const EDITING_CAPABILITIES = Object.freeze({
  annotations: {
    supported: ['对象／范围／整片批注绑定版本并保存当时对象快照', '旧引用重新定位并报告对象是否仍在、哪些字段变了', '压平视频只允许片段／范围／区域批注'],
    limits: ['不构成修改授权（引用到对话只定位讨论）', '不提供逐字 ASR 批注', 'Canvas 只能区域命中，不能声称逐粒子'],
  },
  directEdit: {
    supported: ['确定性属性／文字／对象时间／转场重叠／场景时长修改', '工作草稿自动保存、撤销、重做、放弃', '形成真实候选且不覆盖当前版本'],
    limits: ['不支持任意 HTML/Canvas 语义编辑', '声明可编辑但适配器不读的属性会明确警告，不谎称像素已变', '场景时长变化会把后续场景与对象整体顺延，这是声明过的语义牵连'],
  },
  scopeProtection: {
    supported: ['完整字段级计划比较（box／motion／zIndex／derivedFrom／timeline／params 及全部对象字段）', '目标／保留／必要牵连逐项列出', '相邻、未选、输出与声音清单未被改', '共享组件实例默认不扩散'],
    limits: ['字段级比较证明计划语义未被误改，局部保护的像素证明仍要另走编码前区域对照', '像素对照只证明目标区域变化与邻居未变，不等于编码后文件逐像素一致'],
  },
  aiEdit: {
    supported: ['同一制作子 Agent 工作包、派发前暂停制作', '真实候选、原新对照、已知问题与实际检查范围返回', '基础版本变化后拒绝静默应用', '越界返回记失败而非裁剪成候选'],
    limits: ['不创建新制作 Agent、无 Fork／独立审校', '本环境未调用真实模型生成内容；候选内容来自真实计划与渲染，AI 看听须另行记录'],
  },
  candidates: {
    supported: ['接受为当前（非定稿）、否定、放弃、重新核对', '部分采用形成新候选并列出依赖重检项', '局部确认绑定对象／方面／范围／版本'],
    limits: ['候选接受不等于整片验收或效果沉淀', '缺预览的候选接受需用户明确确认', '部分采用不提前标完成'],
  },
  history: {
    supported: ['创作期历史只读复制', '回退成为当前版本并保留旧当前为历史', '局部回退形成候选并列出依赖'],
    limits: ['定稿后历史只读，不能把定稿变回可编辑当前版', '结项删除历史后不显示恢复入口', '不承诺找回已删除历史'],
  },
  projection: {
    supported: ['只读编辑投影发布到项目事件流', '携带源修订号，前端可判断过期'],
    limits: ['投影是缓存不是事实源', '领域视图已注册但外壳页面挂载尚未获准；不画假按钮、不删“尚未接入”标注'],
  },
})

/**
 * Build the EDITING-REVIEW stores for one project.
 *
 * One call, one project: nothing here is global, so two projects cannot share an annotation, a
 * session or a candidate by accident.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {any}
 */
export function createEditingKit(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('createEditingKit 需要 C10 ProjectPaths', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const kit = {
    interfaceVersion: EDITING_INTERFACE_VERSION,
    capabilities: EDITING_CAPABILITIES,
    clock,
    projectId: paths.projectId,
    paths,
    annotations: createAnnotationStore({ paths, clock }),
    sessions: createDirectEditing({ paths, clock }),
    ai: createAiEditing({ paths, clock }),
    candidates: createCandidateReview({ paths, clock }),
    history: createHistoryView({ paths, clock }),
    comparisons: createComparisonStore({ paths, clock }),
  }
  return Object.freeze(kit)
}
