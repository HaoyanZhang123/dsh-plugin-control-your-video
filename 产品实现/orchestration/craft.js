/**
 * Motion terms, craft recipes, narrative seams and time remapping — bound to real objects.
 *
 * The rule that keeps this honest: a term choice is bound to an object, a scope and a version, and
 * an AI may not add, delete or swap it later. A craft recipe must express medium, stroke, order,
 * texture, light, scale and subject identity — a palette swap or a filter is refused, because both
 * produce "a different colour" rather than "a different craft" (C13 card §4.9, CT-14 §7–§8).
 *
 * Deliberate stillness is legal. Nothing in this module requires motion per second, and a silent or
 * abstract work is not forced to acquire a story.
 *
 * @module orchestration/craft
 */

import { Clock, ConflictError, ValidationError } from '../base/index.js'
import { assertAudioKeepsMovieTime, createTimeRemap, listMotionTerms } from '../media/index.js'
import {
  ORCH_DOCUMENT,
  OrchestrationDocument,
  appendJournal,
  copy,
  optionalText,
  orchestrationId,
  requireOneOf,
  requireText,
  requireTextList,
} from './ids.js'

/** Aspects a CraftRecipe must express. Colour alone is not in the list. */
export const CraftAspect = Object.freeze({
  MEDIUM: 'medium',
  STROKE: 'stroke',
  PRESSURE_EDGE: 'pressure-edge',
  DRAW_ORDER: 'draw-order',
  TEXTURE: 'texture',
  LIGHT: 'light',
  SCALE: 'scale',
  SUBJECT_IDENTITY: 'subject-identity',
})

/** Narrative seams a work may choose. Each carries its own applicability conditions. */
export const NarrativeSeamKind = Object.freeze({
  FOREGROUND_CONTINUATION: 'foreground-continuation',
  PERSISTENT_SUBJECT: 'persistent-subject',
  SELECTIVE_EXPANSION: 'selective-expansion',
  REGISTRATION_BREAKDOWN: 'registration-breakdown',
  CONTINUOUS_SPACE: 'continuous-space',
  LAYERED_DEPTH: 'layered-depth',
})

/** What the craft layer can and cannot claim. */
export const CRAFT_CAPABILITIES = Object.freeze({
  motionTerms: {
    supported: ['按名称／别名／分类真实示例选择术语', '选择绑定对象、范围与计划版本'],
    limits: ['研究索引不等于正式效果', 'AI 不能擅自增删换术语'],
  },
  craftRecipe: {
    supported: ['媒介、笔触、顺序、纹理、光线、尺度与主体身份', '主体部位／视角／变换映射'],
    limits: ['不只换色或叠滤镜冒充风格', '不证明最终观感'],
  },
  narrativeSeam: {
    supported: ['按作品选择承接方式并记录适用／禁用条件'],
    limits: ['不强迫所有作品有故事、角色或持续运动', '保留与静默是合法选择'],
  },
  timeRemap: {
    supported: ['变速与定格用 TimeRemapSpec 表达', '音轨保持真实时间'],
    limits: ['不承诺逐帧 VFR 精度', '编码后结果仍需检查'],
  },
})

/**
 * @param {string} projectId
 * @returns {any}
 */
function emptyCraftBook(projectId) {
  return {
    kind: ORCH_DOCUMENT.craft.kind,
    projectId,
    version: 1,
    termSelections: [],
    craftRecipes: [],
    seams: [],
    remaps: [],
    journal: [],
  }
}

/**
 * The craft book of one project.
 */
export class CraftBook {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.craft, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => emptyCraftBook(this.projectId))
  }

  /** @returns {any} */
  read() {
    return this.load().value
  }

  /**
   * The terms a surface may offer: real ids, aliases and examples, never an invented catalogue.
   * @returns {any[]}
   */
  availableTerms() {
    return listMotionTerms()
  }

  /**
   * Bind one motion term to an object, a scope and a plan version.
   * @param {object} input
   * @param {string} input.term a real term id from {@link CraftBook#availableTerms}
   * @param {string} input.objectId
   * @param {string} input.scope
   * @param {string} input.planVersion
   * @param {any} input.motionSpec the MotionSpec that will enter recipe and plan
   * @param {string} [input.chosenBy]
   * @returns {{ selection: any, recipeFragment: any, revision: string }}
   */
  selectMotionTerm(input = {}) {
    const term = requireText(input.term, 'term', 80)
    const known = this.availableTerms().find((entry) => entry.id === term)
    if (known === undefined) throw new ValidationError('未知运动术语，不能绑定', { field: 'term', term })
    const motionSpec = input.motionSpec
    if (motionSpec === null || typeof motionSpec !== 'object') {
      throw new ValidationError('术语选择需要对应 MotionSpec', { field: 'motionSpec' })
    }
    if (motionSpec.term !== term) {
      throw new ValidationError('MotionSpec 的术语与选择不一致', { field: 'motionSpec.term', expected: term })
    }
    const objectId = requireText(input.objectId, 'objectId', 200)
    const scope = requireText(input.scope, 'scope', 300)
    const planVersion = requireText(input.planVersion, 'planVersion', 120)
    const { value, revision } = this.load()
    const existing = value.termSelections.find((entry) => entry.objectId === objectId && entry.scope === scope)
    if (existing !== undefined && existing.term !== term) {
      // Swapping a term is a user decision, not an AI convenience.
      throw new ConflictError('该对象与范围已有术语选择，AI 不能擅自更换', {
        objectId,
        scope,
        currentTerm: existing.term,
        action: '需要用户明确换用新术语并记录授权',
      })
    }
    const selection = {
      selectionId: orchestrationId('termSelection', `${this.projectId}:${objectId}:${scope}`),
      term,
      label: known.label,
      aliases: known.zhAliases,
      objectId,
      scope,
      planVersion,
      motionSpec: copy(motionSpec),
      chosenBy: optionalText(input.chosenBy, 'chosenBy', 60) ?? 'user',
      lockedAgainstAiChange: true,
      at: this.clock.iso(),
    }
    if (existing === undefined) value.termSelections.push(selection)
    else value.termSelections[value.termSelections.indexOf(existing)] = { ...existing, ...selection }
    value.journal = appendJournal(value.journal, { action: 'motion-term-selected', term, objectId, at: selection.at })
    const written = this.document.write(value, revision)
    return {
      selection: copy(selection),
      // The fragment is what the recipe and the CompositionPlan must carry.
      recipeFragment: { objectId, scope, term, motionSpec: copy(motionSpec), planVersion },
      revision: written.revision,
    }
  }

  /**
   * Record a craft recipe. At least four aspects must be expressed and the medium is mandatory.
   * @param {object} input
   * @param {string} input.subject
   * @param {object} input.aspects keyed by {@link CraftAspect}
   * @param {object} [input.subjectMap] `{parts, viewpoints, referenceId, beforeAfter}`
   * @param {string[]} [input.references]
   * @returns {{ recipe: any, revision: string }}
   */
  recordCraftRecipe(input = {}) {
    const aspects = input.aspects ?? {}
    const expressed = Object.values(CraftAspect).filter((aspect) => {
      const raw = aspects[aspect]
      if (typeof raw === 'string') return raw.trim().length > 0
      if (Array.isArray(raw)) return raw.length > 0
      return raw !== null && raw !== undefined && typeof raw === 'object' && Object.keys(raw).length > 0
    })
    if (!expressed.includes(CraftAspect.MEDIUM)) {
      throw new ValidationError('工艺配方必须声明媒介；只换色或叠滤镜不算工艺', { field: 'aspects.medium' })
    }
    if (expressed.length < 4) {
      throw new ValidationError('工艺配方至少需要四项真实工艺差异', {
        field: 'aspects',
        expressed,
        action: '补充笔触、绘制顺序、纹理、光线、尺度或主体身份',
      })
    }
    const subjectMap = input.subjectMap ?? null
    if (subjectMap !== null && (typeof subjectMap.referenceId !== 'string' || subjectMap.referenceId.length === 0)) {
      throw new ValidationError('主体映射需要参考身份', { field: 'subjectMap.referenceId' })
    }
    const { value, revision } = this.load()
    const recipe = {
      recipeId: orchestrationId('craft', `${this.projectId}:${value.craftRecipes.length}`),
      subject: requireText(input.subject, 'subject', 300),
      aspects: Object.fromEntries(expressed.map((aspect) => [aspect, aspects[aspect]])),
      notJustPalette: true,
      subjectMap,
      references: requireTextList(input.references, 'references', 32),
      at: this.clock.iso(),
    }
    value.craftRecipes.push(recipe)
    const written = this.document.write(value, revision)
    return { recipe: copy(recipe), revision: written.revision }
  }

  /**
   * Record a narrative seam with its conditions, or record that none is used.
   * @param {object} input
   * @param {string} input.kind one of {@link NarrativeSeamKind}
   * @param {string} input.appliesWhen
   * @param {string} input.disabledWhen
   * @param {string} [input.carriedObject]
   * @param {string[]} [input.evidenceRefs]
   * @returns {{ seam: any, revision: string }}
   */
  recordSeam(input = {}) {
    const kind = requireOneOf(input.kind, NarrativeSeamKind, 'kind')
    const { value, revision } = this.load()
    const seam = {
      seamId: orchestrationId('seam', `${this.projectId}:${value.seams.length}:${kind}`),
      kind,
      appliesWhen: requireText(input.appliesWhen, 'appliesWhen', 500),
      disabledWhen: requireText(input.disabledWhen, 'disabledWhen', 500),
      carriedObject: optionalText(input.carriedObject, 'carriedObject', 300),
      evidenceRefs: requireTextList(input.evidenceRefs, 'evidenceRefs', 16),
      // The seam is chosen by the work, not imposed on it.
      forced: false,
      at: this.clock.iso(),
    }
    value.seams.push(seam)
    const written = this.document.write(value, revision)
    return { seam: copy(seam), revision: written.revision }
  }

  /**
   * Declare that this work uses no narrative seam, and why. Stillness and silence are legal.
   * @param {object} input
   * @param {string} input.reason
   * @returns {{ declaration: any, revision: string }}
   */
  declareNoSeam(input = {}) {
    const { value, revision } = this.load()
    const declaration = {
      seamId: orchestrationId('seam', `${this.projectId}:none:${value.seams.length}`),
      kind: null,
      declared: 'none',
      reason: requireText(input.reason, 'reason', 500),
      forced: false,
      at: this.clock.iso(),
    }
    value.seams.push(declaration)
    const written = this.document.write(value, revision)
    return { declaration: copy(declaration), revision: written.revision }
  }

  /**
   * Record a time remap produced by C12's TimeRemapSpec, keeping the audio on movie time.
   * @param {object} input
   * @param {string} input.id remap identity
   * @param {string} input.mode one of C12 `REMAP_MODES`
   * @param {Array<{atSceneFrame: number, speed: number, interpolation?: string}>} input.speedKeys
   * @param {number} [input.sceneFrames]
   * @param {boolean} [input.deliberateHold] true when a freeze is intentional
   * @param {any} [input.plan] the CompositionPlan, so the audio protection is really checked
   * @param {string[]} [input.evidenceRefs]
   * @returns {{ remap: any, revision: string }}
   */
  recordTimeRemap(input = {}) {
    const remap = createTimeRemap({
      id: input.id,
      mode: input.mode,
      speedKeys: input.speedKeys,
      sceneFrames: input.sceneFrames,
      supportsReverse: input.supportsReverse === true,
    })
    // C12 owns the audio-time truth. With a plan in hand the protection is really checked against
    // its audio objects; without one, the record says so instead of implying it was verified.
    const audioCheck =
      input.plan === undefined || input.plan === null ? null : assertAudioKeepsMovieTime(input.plan, remap)
    // A TimeRemapSpec carries resolver functions, so only its declared facts are stored: a document
    // must never depend on a closure that cannot be read back.
    const spec = {
      id: remap.id,
      targetObjectRef: remap.targetObjectRef,
      mode: remap.mode,
      speedKeys: copy(remap.speedKeys),
      sceneFrames: remap.sceneFrames,
      totalMovieFrames: remap.totalMovieFrames,
      eventToMovieFrameResolverVersion: remap.eventToMovieFrameResolverVersion,
    }
    const { value, revision } = this.load()
    const record = {
      recordId: orchestrationId('craft', `${this.projectId}:remap:${value.remaps.length}`),
      remap: spec,
      deliberateHold: input.deliberateHold === true,
      evidenceRefs: requireTextList(input.evidenceRefs, 'evidenceRefs', 16),
      audioKeepsMovieTime: audioCheck === null ? true : audioCheck.untouched === true,
      verifiedAgainstPlan: audioCheck !== null,
      at: this.clock.iso(),
    }
    value.remaps.push(record)
    const written = this.document.write(value, revision)
    return { remap: copy(record), revision: written.revision }
  }

  /**
   * Guard for "no universal motion rule": the work must not be forced into continuous movement.
   * @param {object} input
   * @param {boolean} [input.stillByDesign]
   * @param {boolean} [input.silentByDesign]
   * @returns {{ ok: boolean, requirements: string[] }}
   */
  describeMotionPolicy(input = {}) {
    const requirements = []
    if (input.stillByDesign === true) requirements.push('刻意静止需要声明并验收，不需要补动效')
    if (input.silentByDesign === true) requirements.push('无声音作品不被强加音轨或旁白')
    return { ok: true, requirements, universalMotionRule: false }
  }
}
