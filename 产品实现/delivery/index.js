/**
 * DELIVERY-EFFECTS public surface: the only entry point later cards (C16) and the Host use.
 *
 * Importing `delivery/*.js` internals is acceptable for this card's tests but not for product code,
 * so an internal refactor cannot break a caller that only used this surface.
 *
 * The two shapes mirror C10's convention: free functions for work that owns no state
 * (`executeDelivery`, `inspectProjectPackage`, `evaluateClosure`, `permanentlyDeleteProject`), and
 * bound kits (`createDeliveryKit`) for per-project stores that must not be re-scoped per call.
 *
 * @module delivery/index
 */

import { Clock, ValidationError } from '../base/index.js'
import { planOfVersion } from '../editing/index.js'
import { DELIVERY_INTERFACE_VERSION, DELIVERY_LAYOUT, DeliveryFailure, DeliveryState, ItemKind, ItemState } from './ids.js'
import { createDeliveryExporter, createDeliveryStore } from './delivery.js'
import { createEffectLibrary } from './effects.js'
import { createClosureStore } from './closure.js'
import { ITEM_EXTENSION, defaultFileStem, describeSpec, resolveOutputPath } from './specs.js'
import { DELIVERY_LIMITS, newDeliveryId, assertDeliveryId, copy } from './ids.js'

export * from './ids.js'
export {
  declareSpec,
  declareCoverSpec,
  declareSubtitleSpec,
  declareUnsupportedSpec,
  SPEC_PRESETS,
  buildSubtitleDocument,
  subtitleCues,
  srtTimestamp,
  checkFreeSpace,
  resolveOutputPath,
} from './specs.js'
export { createDeliveryStore, createDeliveryExporter } from './delivery.js'
export {
  exportProjectPackage,
  inspectProjectPackage,
  importProjectPackage,
  listPackageRecords,
  mapPackageTarget,
  PACKAGE_TRANSPORT,
} from './package.js'
export { createEffectLibrary, EFFECT_DECLARATION_KIND, EFFECTS_INTERFACE_VERSION } from './effects.js'
export {
  evaluateClosure,
  planCleanupScope,
  createClosureStore,
  permanentlyDeleteProject,
} from './closure.js'
export {
  DELIVERY_PROJECTION_KIND,
  DELIVERY_PROJECTION_VERSION,
  DELIVERY_PROJECTION_LIMITS,
  buildDeliveryProjection,
  publishDeliveryProjection,
  latestDeliveryProjection,
} from './projection.js'
export { DELIVERY_INTERFACE_VERSION } from './ids.js'

/**
 * What this range can honestly claim, and where every claim stops.
 *
 * Data rather than prose, so a receipt or a later card reads it instead of trusting a comment.
 */
export const DELIVERY_CAPABILITIES = Object.freeze({
  finalize: {
    supported: [
      '用户验收引用 + C10 finalize（AI 不能定稿，代码级拒绝）',
      '交付记录绑定定稿版本，不反向改变项目版本',
    ],
    limits: ['定稿只由用户本人确认；本模块不产生确认，只读取确认引用', '定稿后继续改必须形成新候选，不就地改写定稿'],
  },
  export: {
    supported: [
      '多规格逐条渲染、逐条探测、逐条报告成功/失败',
      '同名不覆盖（改名或失败二选一，没有覆盖策略）',
      '导出后检查可读性、规格、时长、帧数与音频存在性',
      '第二画幅由真实 AdaptOperation 生成并记录重排/保留结果',
      '封面抽帧与字幕文件基于同一份定稿计划',
    ],
    limits: [
      '前端只渲染 FFmpeg 滤镜图能表达的对象的；其他运行时不注册就明确不可用',
      '单独的声音母版导出尚未实现，交付清单里显示为“不可用”而不是成功',
      '像素级“非拉伸”对照需要 C12 的色条夹具，本卡只证明对象级重排与规格/时长实测',
      '导出成功不等于发布：本模块没有任何网络发布动作',
    ],
  },
  projectPackage: {
    supported: [
      '目录包 + 清单 + 逐文件哈希 + 版本/计划/配方/适配记录/素材',
      '导入前不受信筛查：路径、链接、条目数、单条与总量、压缩比',
      '不覆盖同名项目；包被改动、格式过新、缺件、已导入都报告并拒绝',
      '导入后建立新项目并核对定稿版本与计划可读',
    ],
    limits: [
      '不解压任何归档格式；恶意归档在“不解压”这一层被挡住',
      '字体是外部依赖，包不携带字体本体；导入时无法检查就报告“未检查”',
      '事件日志不进包：它是运行记录，不是迁移事实源',
    ],
  },
  effects: {
    supported: [
      '只收真实视觉/声音效果：声明式源文件 + 必要输入 + 字体 + 工具版本 + 参数 + 输出规格 + 权利声明',
      '空项目复现通过才正式收录；失败保留候选与原因',
      '明确版本；项目按版本引用；更新形成新版本，旧项目保持原引用',
      '项目清理不删除效果；被引用的效果拒绝下架',
    ],
    limits: [
      '不执行任意源码，也不把方法/提示词/案例当作效果',
      '本机无听辨通道：声音效果只验证文件规格与输入完整，听感需要用户听',
      '换机器/换工具版本必须重新复现，不承诺无条件像素/采样一致',
    ],
  },
  closure: {
    supported: [
      '七步顺序检查：定稿 → 导出 → 效果 → 最终工程 → 展示范围 → 用户确认 → 清理',
      '清理范围由磁盘事实生成，含保留清单与共享引用；确认绑定范围指纹',
      '未确认不删除；确认后只删范围内的路径，受保护路径拒绝删除',
      '归档、回收区、恢复与永久删除（永久删除需第二次用户确认且无共享引用）',
    ],
    limits: [
      '候选“记录”仍留在 C10 版本索引（C10 无受控删除 API，已提变更请求）；只删其预览/差异文件',
      '永久删除写删除记录到项目根目录之外；不承诺找回已删内容',
      '结项后继续修改必须从最终版形成新候选并重新走同一流程',
    ],
  },
  projection: {
    supported: ['只读 delivery.projection 事件：交付、包、效果、结项步骤与范围摘要', '携带源文档修订号'],
    limits: ['投影是缓存不是事实源', '投影不含绝对路径与私人内容；可点操作仍要真实交互接入'],
  },
})

/** Interface version, re-exported above from `ids.js` for a single import point. */

/**
 * Build the per-project DELIVERY-EFFECTS stores.
 *
 * One call, one project. `toolchain` is required for a real exporter; without it the kit still
 * records, packages and evaluates, and `exporter` is `null` rather than a fake renderer.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @param {any} [input.toolchain] result of `resolveToolchain`
 * @param {string} [input.effectsRoot] absolute effect-library root (user data, not the plugin)
 * @returns {any}
 */
export function createDeliveryKit(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('createDeliveryKit 需要 C10 ProjectPaths', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const kit = {
    interfaceVersion: DELIVERY_INTERFACE_VERSION,
    capabilities: DELIVERY_CAPABILITIES,
    clock,
    projectId: paths.projectId,
    paths,
    store: createDeliveryStore({ paths, clock }),
    exporter: input.toolchain === undefined || input.toolchain === null
      ? null
      : createDeliveryExporter({ paths, clock, toolchain: input.toolchain }),
    effects: typeof input.effectsRoot === 'string' && input.effectsRoot.length > 0
      ? createEffectLibrary({ effectsRoot: input.effectsRoot, clock })
      : null,
    closure: createClosureStore({ paths, clock }),
  }
  return kit
}

/**
 * Plan one delivery: which specs, which files, which names, what conflicts — WITHOUT rendering.
 *
 * This is what the user sees before an export starts (版本、规格、文件名、位置、同名处理).
 *
 * @param {object} input
 * @param {any} input.paths
 * @param {any} input.versions C10 version store
 * @param {any} input.finalVersion C10 final version
 * @param {any[]} input.specs from `declareSpec` / `declareCoverSpec` / `declareSubtitleSpec`
 * @param {'refuse'|'rename'} [input.policy]
 * @param {string} [input.outputDir] absolute; defaults to the project's delivery/outputs
 * @param {string} [input.deliveryId] pre-minted id, so a caller can name the output folder before
 *   the plan exists (used by the evidence run); omitted means PROJECT-CORE mints one
 * @param {any} [input.clock]
 * @returns {any} delivery record (state `planned`)
 */
export function planDelivery(input) {
  const paths = input?.paths
  const finalVersion = input?.finalVersion
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('交付计划需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  if (finalVersion === null || typeof finalVersion !== 'object' || finalVersion.class !== 'final') {
    throw new ValidationError('只有用户验收的定稿版本才能计划交付', { field: 'finalVersion', code: DeliveryFailure.NOT_FINALIZED })
  }
  if (typeof finalVersion.confirmationRef !== 'string' || finalVersion.confirmationRef.length === 0) {
    throw new ValidationError('定稿版本缺少用户验收引用', { field: 'finalVersion.confirmationRef' })
  }
  const specs = Array.isArray(input.specs) ? input.specs : []
  if (specs.length === 0) throw new ValidationError('交付计划至少需要一个规格', { field: 'specs' })
  if (specs.length > DELIVERY_LIMITS.maxSpecs) {
    throw new ValidationError('交付规格过多', { field: 'specs', limit: DELIVERY_LIMITS.maxSpecs })
  }
  const ids = new Set()
  for (const spec of specs) {
    if (typeof spec?.specId !== 'string' || spec.specId.length === 0) {
      throw new ValidationError('每个规格都需要 specId', { field: 'specs' })
    }
    if (ids.has(spec.specId)) throw new ValidationError('规格 id 重复', { field: 'specs', specId: spec.specId })
    ids.add(spec.specId)
  }
  const clock = input.clock ?? new Clock()
  const policy = input.policy ?? 'rename'
  if (!['refuse', 'rename'].includes(policy)) {
    throw new ValidationError('未知同名处理策略', { field: 'policy', received: String(policy) })
  }
  const outputDir = typeof input.outputDir === 'string' && input.outputDir.length > 0
    ? input.outputDir
    : paths.resolve(DELIVERY_LAYOUT.outputsDir)
  const bound = planOfVersion(paths, finalVersion)
  if (bound === null) {
    throw new ValidationError('定稿版本没有关联的 CompositionPlan，不能计划交付', { field: 'finalVersion', code: DeliveryFailure.NO_FINAL_PLAN })
  }
  const extensionOf = (kind) => ITEM_EXTENSION[kind] ?? '.bin'
  // The delivery id is minted BEFORE the item names, so the names the user is shown are exactly
  // the names the exporter will write — a preview that displays a different file name is a lie.
  const deliveryId = input.deliveryId === undefined
    ? newDeliveryId()
    : assertDeliveryId(input.deliveryId, 'deliveryId')
  const items = specs.map((spec) => {
    const stem = defaultFileStem({ deliveryId, specId: spec.specId })
    const kind = spec.kind ?? ItemKind.VIDEO
    const preview = kind === ItemKind.AUDIO
      ? { ok: false, reason: 'NOT_IMPLEMENTED', existing: '' }
      : resolveOutputPath({ dir: outputDir, stem, extension: extensionOf(kind), policy })
    return {
      itemId: `itm_${spec.specId}`,
      specId: spec.specId,
      kind,
      label: spec.label ?? spec.specId,
      description: describeSpec(spec),
      state: preview.ok === false && preview.reason === 'NAME_CONFLICT' ? ItemState.FAILED : ItemState.PLANNED,
      plannedFile: preview.ok === true ? preview.file : null,
      renamed: preview.ok === true ? preview.renamed : null,
      file: null,
      spec: null,
      checks: [],
      checksOk: null,
      failure: preview.ok === false && preview.reason === 'NAME_CONFLICT'
        ? {
            code: DeliveryFailure.NAME_CONFLICT,
            message: '同名文件已存在，按“不覆盖”策略这一项会在开始前就停止',
            detail: { existing: preview.existing, policy },
          }
        : null,
      adaptation: null,
      adaptationRef: null,
      notes: [],
    }
  })
  const record = {
    deliveryId,
    projectId: paths.projectId,
    state: DeliveryState.PLANNED,
    createdAt: clock.iso(),
    updatedAt: clock.iso(),
    finalVersionId: finalVersion.versionId,
    confirmationRef: finalVersion.confirmationRef,
    planRef: bound.planRef,
    planVersion: bound.planVersion,
    planFingerprint: bound.fingerprint,
    policy,
    outputDir,
    specs: specs.map((spec) => copy(spec)),
    items,
    counts: {
      total: items.length,
      exported: 0,
      failed: items.filter((item) => item.state === ItemState.FAILED).length,
      notImplemented: items.filter((item) => item.kind === ItemKind.AUDIO).length,
    },
    honest: {
      exportIsNotPublication: true,
      noNetworkAction: true,
      previewIsNotDelivery: true,
      note: '这里是导出计划：还没有写任何文件；真正导出会逐条渲染、逐条检查并分别报告',
    },
  }
  if (input.persist !== false) {
    const store = input.store ?? createDeliveryStore({ paths, clock })
    return store.insert(record)
  }
  return copy(record)
}

/**
 * Execute a planned delivery: render/prepare every item, verify it, and report per item.
 *
 * A failed item never aborts the others: each spec is a separate promise to the user, and a partial
 * delivery is reported as partial (state `partial`) instead of being hidden behind one error.
 *
 * @param {object} input
 * @param {any} input.paths
 * @param {any} input.store delivery store (from `createDeliveryStore`)
 * @param {any} input.exporter delivery exporter (from `createDeliveryExporter`)
 * @param {string} input.deliveryId
 * @param {any} input.finalVersion
 * @param {any} [input.clock]
 * @returns {any} final delivery record
 */
export function executeDelivery(input) {
  const store = input?.store
  const exporter = input?.exporter
  if (store === null || typeof store?.update !== 'function') {
    throw new ValidationError('执行交付需要交付记录存储', { field: 'store' })
  }
  if (exporter === null || typeof exporter?.renderVideoSpec !== 'function') {
    throw new ValidationError('执行交付需要已解析工具链的导出器', { field: 'exporter' })
  }
  const deliveryId = assertDeliveryId(input.deliveryId, 'deliveryId')
  const current = store.get(deliveryId)
  if (current === null) throw new ValidationError('交付记录不存在', { field: 'deliveryId', deliveryId })
  const clock = input.clock ?? store.clock
  const record = store.update(deliveryId, (existing) => ({
    ...existing,
    state: DeliveryState.RUNNING,
    startedAt: clock.iso(),
  }))
  const specs = Array.isArray(record.specs) ? record.specs : []
  const policy = record.policy ?? 'rename'
  const outputDir = record.outputDir
  /** @type {any[]} */
  const results = []
  for (const item of record.items) {
    if (item.state === ItemState.FAILED && item.failure?.code === DeliveryFailure.NAME_CONFLICT) {
      results.push({ ...item, notes: [...(item.notes ?? []), '计划阶段已判定同名冲突，未开始导出'] })
      continue
    }
    const spec = specs.find((entry) => entry.specId === item.specId) ?? {
      specId: item.specId,
      kind: item.kind,
      label: item.label,
    }
    if (item.kind === ItemKind.VIDEO) {
      results.push(exporter.renderVideoSpec({
        deliveryId,
        finalVersion: input.finalVersion,
        spec,
        outputDir,
        policy,
      }))
    } else if (item.kind === ItemKind.SUBTITLES) {
      const paths = input.paths ?? storePathsFor(store)
      const bound = planOfVersion(paths, input.finalVersion)
      if (bound === null) {
        results.push({
          ...item,
          state: ItemState.FAILED,
          failure: { code: DeliveryFailure.NO_FINAL_PLAN, message: '定稿版本没有关联的 CompositionPlan，无法生成字幕' },
        })
      } else {
        results.push(exporter.exportSubtitles({
          plan: bound.plan,
          outputDir,
          deliveryId,
          spec,
          policy,
        }))
      }
    } else if (item.kind === ItemKind.COVER) {
      const sourceItem = results.find(
        (entry) =>
          entry.kind === ItemKind.VIDEO &&
          entry.state === ItemState.EXPORTED &&
          entry.specId === spec.fromSpecId,
      )
      if (sourceItem === undefined) {
        results.push({
          ...item,
          state: ItemState.FAILED,
          failure: {
            code: DeliveryFailure.SPEC_INVALID,
            message: `封面来源规格 ${String(spec.fromSpecId)} 没有成功导出，封面无法生成`,
          },
        })
      } else {
        results.push(exporter.exportCover({
          sourceFile: sourceItem.file.path,
          frame: spec.frame ?? 0,
          outputDir,
          deliveryId,
          spec,
          policy,
        }))
      }
    } else {
      results.push({
        ...item,
        state: ItemState.NOT_IMPLEMENTED,
        failure: spec.reason === undefined
          ? { code: DeliveryFailure.SPEC_INVALID, message: '本规格在本卡中没有实现' }
          : { code: 'NOT_IMPLEMENTED', message: spec.reason },
      })
    }
  }
  const exported = results.filter((item) => item.state === ItemState.EXPORTED).length
  const failed = results.filter((item) => item.state === ItemState.FAILED).length
  const notImplemented = results.filter((item) => item.state === ItemState.NOT_IMPLEMENTED).length
  const state = failed > 0 && exported > 0
    ? DeliveryState.PARTIAL
    : failed > 0
      ? DeliveryState.FAILED
      : DeliveryState.COMPLETE
  const finalRecord = store.update(deliveryId, (existing) => ({
    ...existing,
    state,
    items: results,
    finishedAt: clock.iso(),
    counts: { total: results.length, exported, failed, notImplemented },
    honest: {
      ...existing.honest,
      perSpecReport: true,
      note:
        state === DeliveryState.COMPLETE
          ? '全部可用规格已导出并逐条检查通过；导出成功不等于发布'
          : state === DeliveryState.PARTIAL
            ? '部分规格成功、部分失败；失败项保留真实原因，不能计入交付完成'
            : '没有成功导出的规格：导出失败时不得清理任何历史',
    },
  }))
  return finalRecord
}

/**
 * The project paths a store is bound to, used only when a caller passes the store instead of paths.
 * @param {any} store
 * @returns {any}
 */
function storePathsFor(store) {
  return store?.paths ?? null
}

/** Re-export of the store check so a caller does not have to guess. */
export function assertDeliveryStore(store) {
  if (store === null || typeof store?.list !== 'function') {
    throw new ValidationError('需要交付记录存储', { field: 'store' })
  }
  return store
}
