/**
 * Public interface of CREATION-ORCHESTRATION.
 *
 * This module is the one place a UI, a later card or a receipt reads C13 from. It deliberately
 * exposes *stores* (each bound to one project) rather than global singletons, because every fact
 * here belongs to a project and every write goes through C10's project documents.
 *
 * What this interface does not contain matters as much as what it does: no Team, Fork, independent
 * critic, per-shot agent or sub-agent spawner, and no generative media or ASR path. The card forbids
 * those organizations, so there is no function to call that would create them.
 *
 * @module orchestration/index
 */

import { Clock, ValidationError } from '../base/index.js'
import { CreationBrief, ResearchLog } from './brief.js'
import { DirectionSet, PlanBaseline, ReferenceScopes, SeriesShares } from './direction.js'
import { MethodLibrary } from './methods.js'
import { PinSync } from './pins.js'
import { PreviewSurface } from './preview.js'
import { ProductionRun } from './production.js'
import { CraftBook } from './craft.js'
import { UnitRegistry } from './units.js'
import { VistaLedger } from './vista.js'

export {
  BriefSource,
  BriefStatus,
  BRIEF_CAPABILITIES,
  BRIEF_LIMITS,
  CapabilityKind,
  CreationBrief,
  GapStatus,
  ResearchAuthorization,
  ResearchLog,
  adoptCapabilityGap,
  appendAssistantMessage,
  composeCapabilities,
  legacyUiStateStanding,
  migrateLegacyUiState,
  readAssistantThread,
} from './brief.js'
export {
  BLOCKING_PLAN_ITEM_KINDS,
  ChangeActor,
  DIRECTION_CAPABILITIES,
  DirectionSet,
  DirectionState,
  PlanBaseline,
  PlanItemKind,
  ReferenceAspect,
  ReferenceScopes,
  SeriesShares,
  SeriesUpdateStatus,
  TemplateDeclaredBy,
} from './direction.js'
export {
  ORCH_DOCUMENT,
  ORCH_ID_NAMESPACE,
  ORCH_SCHEMA_VERSION,
  OrchestrationDocument,
  orchestrationId,
  readOrchestrationDocument,
  readProjectJson,
  writeOrchestrationDocument,
} from './ids.js'
export {
  CRAFT_CAPABILITIES,
  CraftAspect,
  CraftBook,
  NarrativeSeamKind,
} from './craft.js'
export {
  ConvergenceStage,
  FAULT_ENTRY_FIELDS,
  GapPriority,
  METHOD_CAPABILITIES,
  METHOD_PACK_SECTIONS,
  METHOD_PACK_VERSION,
  MethodLibrary,
} from './methods.js'
export {
  PIN_SYNC_CAPABILITIES,
  PinSync,
  PinSyncIssue,
} from './pins.js'
export {
  PREVIEW_CAPABILITIES,
  PREVIEW_HISTORY_LIMIT,
  PreviewSurface,
} from './preview.js'
export {
  PRODUCTION_CAPABILITIES,
  PRODUCTION_TRANSITIONS,
  ProductionRun,
  TakeoverCause,
  initialCutGate,
  productionGate,
} from './production.js'
export {
  UNIT_CAPABILITIES,
  UNIT_PARTS,
  UNIT_PROFILE_VERSION,
  UnitBase,
  UnitCondition,
  UnitOperation,
  UnitRegistry,
  assertUnitComplete,
  describeUnitProfileMatrix,
  humanResultView,
  productionView,
  recoveryView,
  resolveUnitProfile,
  validateUnit,
} from './units.js'
export {
  InspectionKind,
  MechanismState,
  RecoveryCause,
  VISTA_CAPABILITIES,
  VistaLedger,
  VistaMechanism,
} from './vista.js'

/**
 * Version of the frozen C13 interface.
 *
 * Changing this string means at least one exported shape changed and C14/C15/C16 must re-check
 * their integration, exactly like the other module versions in this package.
 */
export const ORCHESTRATION_INTERFACE_VERSION = '1.0.0'

/**
 * What C13 can honestly claim today, and where every claim stops.
 *
 * Data rather than prose: a receipt, a test or a later card reads this instead of trusting a comment.
 */
export const ORCHESTRATION_CAPABILITIES = Object.freeze({
  brief: {
    supported: ['四类来源分开保存的简报', '授权范围内的研究记录', '能力组合与工具缺口提出'],
    limits: ['AI 写入永远是推断，不会变成用户要求', '缺口不自动采用、不安装、不联网'],
  },
  directions: {
    supported: ['实质方向、组合新候选、方案项三态门禁', '基线变化保留旧确认并给出重核范围'],
    limits: ['只有用户能决定方案项', 'AI 自主不等于外观确认'],
  },
  units: {
    supported: ['确定性 UnitProfile', '五件套递归门禁', '文件与哈希复核', '三视图投影'],
    limits: ['结构完整不等于好看', '条件靠如实声明，谎报会掩盖缺失证据'],
  },
  production: {
    supported: ['同一制作子 Agent 身份', '单项目单写入与全局完整制作锁', '暂停／取消／失败／未知状态', '完整初版门'],
    limits: ['不提供多 Agent 制作接口', '不承诺原帧续渲', '程序通过不等于用户验收'],
  },
  vista: {
    supported: ['七类机制的执行记录与门禁判定', 'C16 同任务基线配置'],
    limits: ['机制执行不等于增益已证实', '没有音频听辨通道，AI 听音恒为未执行'],
  },
  methods: {
    supported: ['自写方法包、MethodRoute、故障手册、ReferenceAnalysis、有界收敛'],
    limits: ['不加载外部 Skill，不新增专业 Agent', '收敛未达成时交用户决定'],
  },
  craft: {
    supported: ['术语绑定对象／范围／版本', '工艺配方、叙事承接、TimeRemapSpec'],
    limits: ['AI 不能擅自增删换术语', '不强迫持续运动，不恢复声音生成／旁白／ASR'],
  },
  pins: {
    supported: ['项目版本变化后推进 pin', '打开／恢复时显式复核', 'stale 与引用不符都报需要处理'],
    limits: ['不复制项目事实到 pin', '不自动猜测修复，不修改 C06 校验规则'],
  },
  preview: {
    supported: ['过期帧段与有效帧', '当前计划／上一版计划标识', '过期时拒绝“已生效”'],
    limits: ['只描述真实渲染结果，不重新渲染'],
  },
  legacyUiState: {
    supported: ['C11 的简报与助手消息迁入项目事实', '原文件保留并标记只读'],
    limits: ['不修改 ui/ 代码', '损坏文件不猜测性修复，只报需要处理'],
  },
})

/**
 * Build the C13 stores for one project.
 *
 * One call, one project: nothing here is global, so two projects can never share a brief, a unit
 * registry or a production run by accident.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @param {any} [input.pinSource] C06 tool state, for pin synchronisation
 * @returns {any}
 */
export function createOrchestrationKit(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('createOrchestrationKit 需要 C10 ProjectPaths', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const kit = {
    interfaceVersion: ORCHESTRATION_INTERFACE_VERSION,
    capabilities: ORCHESTRATION_CAPABILITIES,
    clock,
    projectId: paths.projectId,
    paths,
    brief: new CreationBrief({ paths, clock }),
    research: new ResearchLog({ paths, clock }),
    directions: new DirectionSet({ paths, clock }),
    baseline: new PlanBaseline({ paths, clock }),
    series: new SeriesShares({ paths, clock }),
    references: new ReferenceScopes({ paths, clock }),
    units: new UnitRegistry({ paths, clock }),
    production: new ProductionRun({ paths, clock }),
    vista: new VistaLedger({ paths, clock }),
    methods: new MethodLibrary({ paths, clock }),
    craft: new CraftBook({ paths, clock }),
    preview: new PreviewSurface({ paths, clock }),
    pins: new PinSync({ paths, clock, pinSource: input.pinSource ?? null }),
  }
  return Object.freeze(kit)
}
