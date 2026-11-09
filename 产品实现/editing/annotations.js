/**
 * Object- and range-anchored annotations: what the user said, on which object, aspect, scope and
 * version, with the old reference kept traceable after the work moves on.
 *
 * An annotation is discussion, not a modification authorization (CT-05 §3: "引用到对话只定位讨论，
 * 不构成修改授权"). It stores an immutable snapshot of the anchored object at the annotated version
 * so a later reader can relocate "what it looked like then", and it refuses to invent native
 * objects inside a flattened video or a Canvas drawing.
 *
 * @module editing/annotations
 */

import { Clock, ValidationError, contentHash } from '../base/index.js'
import { newId } from '../core/project/ids.js'
import { createVersionStore } from '../core/project/index.js'
import { buildObjectRegistry, describeFlattened, frameSizeOf } from '../media/index.js'
import {
  EDITING_DOCUMENT,
  EDITING_LAYOUT,
  assertFrame,
  assertRef,
  assertRefList,
  assertText,
  copy,
  corrupt,
  optionalText,
  planOfVersion,
  readEditingDocument,
  writeEditingDocument,
} from './ids.js'

/** What an annotation is about, at user-visible granularity. */
export const AnnotationAspect = Object.freeze({
  TEXT: 'text',
  LAYOUT: 'layout',
  COLOR: 'color',
  OPACITY: 'opacity',
  TIMING: 'timing',
  ANIMATION: 'animation',
  TRANSITION: 'transition',
  SOUND: 'sound',
  COMPOSITION: 'composition',
  FLATTENED_CLIP: 'flattened-clip',
  CANVAS_REGION: 'canvas-region',
  WHOLE_FILM: 'whole-film',
})

/** Annotation lifecycle. `resolved` never means the edit was accepted. */
export const AnnotationStatus = Object.freeze({
  OPEN: 'open',
  ADDRESSED: 'addressed',
  RESOLVED: 'resolved',
})

/** Which aspects are honest for each object kind (never a generic "anything" list). */
const ASPECTS_BY_KIND = Object.freeze({
  solid: [AnnotationAspect.COLOR, AnnotationAspect.OPACITY, AnnotationAspect.LAYOUT],
  'text-native': [AnnotationAspect.TEXT, AnnotationAspect.LAYOUT, AnnotationAspect.COLOR, AnnotationAspect.ANIMATION],
  subtitle: [
    AnnotationAspect.TEXT,
    AnnotationAspect.LAYOUT,
    AnnotationAspect.COLOR,
    AnnotationAspect.TIMING,
    AnnotationAspect.ANIMATION,
  ],
  image: [AnnotationAspect.LAYOUT, AnnotationAspect.COLOR, AnnotationAspect.OPACITY, AnnotationAspect.TIMING],
  'video-source-with-offset': [AnnotationAspect.TIMING, AnnotationAspect.LAYOUT, AnnotationAspect.OPACITY],
  'flattened-video': [AnnotationAspect.FLATTENED_CLIP, AnnotationAspect.TIMING],
  'program-pattern': [AnnotationAspect.COLOR, AnnotationAspect.OPACITY, AnnotationAspect.COMPOSITION],
  'program-counter': [AnnotationAspect.TEXT, AnnotationAspect.LAYOUT, AnnotationAspect.COLOR, AnnotationAspect.TIMING],
  'canvas-program-animation': [AnnotationAspect.CANVAS_REGION, AnnotationAspect.TIMING],
  'audio-continuous': [AnnotationAspect.SOUND, AnnotationAspect.TIMING],
})

/** Aspects that require an explicit region rectangle. */
const REGION_ASPECTS = new Set([AnnotationAspect.FLATTENED_CLIP, AnnotationAspect.CANVAS_REGION])

/** Aspects that require an explicit time range. */
const RANGE_ASPECTS = new Set([AnnotationAspect.TIMING, AnnotationAspect.WHOLE_FILM, AnnotationAspect.FLATTENED_CLIP])

/** Editable property an aspect must actually be able to touch, when the plan exposes one. */
const PROP_FOR_ASPECT = Object.freeze({
  [AnnotationAspect.TEXT]: 'text',
  [AnnotationAspect.COLOR]: 'color',
  [AnnotationAspect.OPACITY]: 'opacity',
  [AnnotationAspect.TIMING]: 'durationFrames',
})

/** Empty annotations document. @param {string} projectId */
export function emptyAnnotationsDocument(projectId) {
  return { kind: EDITING_DOCUMENT.annotations, projectId, annotations: [] }
}

/**
 * Open the annotation store of one project.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {{
 *   projectId: string,
 *   addAnnotation: (input: object) => object,
 *   getAnnotation: (annotationId: string) => object|null,
 *   listAnnotations: (filter?: object) => object[],
 *   addReply: (input: object) => object,
 *   setStatus: (input: object) => object,
 *   reopenReference: (annotationId: string, currentPlan: object) => object,
 *   describe: () => object,
 * }}
 */
export function createAnnotationStore(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('批注存储需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const versions = createVersionStore({ paths, clock })
  const file = EDITING_LAYOUT.annotationsFile

  /** @returns {{ doc: any, revision: string|null }} */
  function read() {
    const stored = readEditingDocument(
      paths,
      file,
      EDITING_DOCUMENT.annotations,
      () => emptyAnnotationsDocument(paths.projectId),
    )
    return { doc: stored.value, revision: stored.revision }
  }

  /** @param {any} doc @param {string|null} revision */
  function save(doc, revision) {
    return writeEditingDocument(paths, file, doc, revision, clock, '批注')
  }

  /**
   * Assert a version exists in C10 and that the supplied plan really is that version's plan.
   * @param {string} versionId
   * @param {any} plan
   * @returns {{ version: any, planVerified: boolean, planRef: string|null }}
   */
  function assertVersionPlan(versionId, plan) {
    const version = versions.getVersion(versionId)
    if (version === null) throw new ValidationError('批注绑定的版本不存在', { versionId })
    const snapshot = planOfVersion(paths, version)
    if (snapshot === null) {
      // No plan reference on that version: accept the caller's snapshot but state that it is
      // unverified instead of claiming the anchor was checked against the stored version.
      return { version, planVerified: false, planRef: null }
    }
    if (contentHash(plan) !== snapshot.fingerprint) {
      throw new ValidationError('提交的计划不是该版本的快照，不能把批注锚到别的画面状态', {
        versionId,
        versionPlanRef: snapshot.planRef,
      })
    }
    return { version, planVerified: true, planRef: snapshot.planRef }
  }

  /**
   * Resolve the object or structure an annotation points at.
   * @param {any} plan
   * @param {string|null} objectId
   * @param {{ transitionId?: string, sceneId?: string }} [structure]
   * @returns {any}
   */
  function resolveAnchor(plan, objectId, structure) {
    if (structure?.transitionId !== undefined) {
      const transition = (plan.transitions ?? []).find((entry) => entry.id === structure.transitionId)
      if (transition === undefined) throw new ValidationError('计划中没有这个转场', { transitionId: structure.transitionId })
      return {
        anchorKind: 'transition',
        target: transition,
        aspectKinds: [AnnotationAspect.TRANSITION, AnnotationAspect.TIMING],
      }
    }
    if (structure?.sceneId !== undefined) {
      const scene = (plan.scenes ?? []).find((entry) => entry.id === structure.sceneId)
      if (scene === undefined) throw new ValidationError('计划中没有这个场景', { sceneId: structure.sceneId })
      return {
        anchorKind: 'scene',
        target: scene,
        aspectKinds: [AnnotationAspect.COMPOSITION, AnnotationAspect.TIMING],
      }
    }
    if (objectId === null || objectId === 'movie') {
      return {
        anchorKind: 'movie',
        target: null,
        aspectKinds: [
          AnnotationAspect.WHOLE_FILM,
          AnnotationAspect.COMPOSITION,
          AnnotationAspect.TIMING,
        ],
      }
    }
    const registry = buildObjectRegistry(plan)
    const object = plan.objects.find((entry) => entry.id === objectId)
    if (object === undefined) throw new ValidationError('计划中没有这个对象，不能虚构锚点', { objectId })
    const record = registry.get(objectId)
    return {
      anchorKind: object.kind === 'flattened-video'
        ? 'flattened-clip'
        : object.kind === 'canvas-program-animation'
          ? 'canvas-region'
          : 'object',
      target: object,
      record,
      aspectKinds: ASPECTS_BY_KIND[object.kind] ?? [],
    }
  }

  /**
   * Snapshot the anchor state, so an old annotation can still say what it referred to.
   * @param {any} anchor
   * @returns {any}
   */
  function snapshotOf(anchor) {
    if (anchor.anchorKind === 'movie') {
      return { anchorKind: 'movie', objectId: 'movie', snapshot: null }
    }
    const target = anchor.target
    if (anchor.anchorKind === 'transition' || anchor.anchorKind === 'scene') {
      return { anchorKind: anchor.anchorKind, objectId: target.id, snapshot: copy(target) }
    }
    return {
      anchorKind: anchor.anchorKind,
      objectId: target.id,
      snapshot: {
        kind: target.kind,
        sceneId: target.sceneId ?? null,
        params: copy(target.params ?? {}),
        timeline: copy(target.timeline),
        editableProps: [...(target.editableProps ?? [])],
        hitTest: target.hitTest,
      },
    }
  }

  /**
   * Add one annotation bound to a real object/range, a real version and a real plan state.
   *
   * @param {object} input
   * @param {string} input.versionId
   * @param {any} input.plan the normalized plan of that version
   * @param {string} [input.objectId] object id, or `movie` for a whole-film note
   * @param {string} [input.aspect] one of {@link AnnotationAspect}
   * @param {string} [input.scope] `object` | `range` | `part` | `whole`
   * @param {{ startFrame: number, endFrameExclusive: number }} [input.range]
   * @param {{ x: number, y: number, width: number, height: number }} [input.region]
   * @param {string} [input.transitionId]
   * @param {string} [input.sceneId]
   * @param {string} input.body the user's words, stored verbatim
   * @param {string} input.author
   * @param {string} [input.actor] `user` | `ai` | `system`; defaults to `user`
   * @param {string[]} [input.evidenceRefs]
   * @returns {object}
   */
  function addAnnotation(input = {}) {
    const versionId = assertRef(input.versionId, 'versionId')
    const aspect = assertText(input.aspect, 'aspect', 60)
    if (Object.values(AnnotationAspect).includes(aspect) === false) {
      throw new ValidationError('未知批注方面', { aspect })
    }
    const body = assertText(input.body, 'body')
    const author = assertText(input.author, 'author', 120)
    const actor = input.actor ?? 'user'
    if (!['user', 'ai', 'system'].includes(actor)) throw new ValidationError('批注者类型不合法', { actor })
    const scope = input.scope ?? (input.range === undefined ? 'object' : 'range')
    if (!['object', 'range', 'part', 'whole'].includes(scope)) {
      throw new ValidationError('批注范围不合法', { scope })
    }
    const plan = input.plan
    if (plan === null || typeof plan !== 'object') throw new ValidationError('批注需要该版本的计划快照', { field: 'plan' })
    const bound = assertVersionPlan(versionId, plan)
    const anchor = resolveAnchor(plan, input.objectId ?? null, {
      transitionId: input.transitionId,
      sceneId: input.sceneId,
    })
    if (!anchor.aspectKinds.includes(aspect)) {
      throw new ValidationError('该对象类型不能这样批注', {
        aspect,
        objectKind: anchor.anchorKind,
        allowedAspects: anchor.aspectKinds,
      })
    }
    if (PROP_FOR_ASPECT[aspect] !== undefined) {
      const props = anchor.target?.editableProps ?? []
      if (props.includes(PROP_FOR_ASPECT[aspect]) === false) {
        throw new ValidationError('该方面在当前对象的可编辑表里不存在，不能假装可改', {
          aspect,
          objectId: input.objectId ?? null,
          editableProps: props,
        })
      }
    }
    if (REGION_ASPECTS.has(aspect)) {
      if (anchor.anchorKind === 'flattened-clip') {
        const flattened = describeFlattened(plan, anchor.target.id)
        if (flattened.internalObjects !== 0) throw new ValidationError('压平视频没有内部原生对象', { objectId: anchor.target.id })
      }
      if (input.region === undefined) {
        throw new ValidationError('该方面批注需要明确的画面区域', { aspect })
      }
    }

    const frameSize = frameSizeOf(plan)
    let region = null
    if (input.region !== undefined) {
      const values = ['x', 'y', 'width', 'height'].map((key) => Number(input.region[key]))
      if (values.some((value) => !Number.isFinite(value)) || values[2] <= 0 || values[3] <= 0) {
        throw new ValidationError('批注区域必须是正尺寸的矩形', { region: input.region })
      }
      const [x, y, width, height] = values
      if (x < 0 || y < 0 || x + width > frameSize.width || y + height > frameSize.height) {
        throw new ValidationError('批注区域超出画面', { region: input.region, frameSize })
      }
      region = { x, y, width, height }
    }

    let range = null
    if (input.range !== undefined) {
      const start = assertFrame(input.range.startFrame, 'range.startFrame')
      const end = assertFrame(input.range.endFrameExclusive, 'range.endFrameExclusive')
      if (end <= start) throw new ValidationError('批注时间范围必须非空', { start, end })
      if (end > plan.timebase.totalFrames) {
        throw new ValidationError('批注时间范围超出整片时长', { end, totalFrames: plan.timebase.totalFrames })
      }
      range = { startFrame: start, endFrameExclusive: end }
    }
    if (RANGE_ASPECTS.has(aspect) && range === null) {
      throw new ValidationError('该方面批注需要明确时间范围', { aspect })
    }
    if (anchor.anchorKind === 'object' && range === null) {
      range = {
        startFrame: anchor.target.timeline.startFrame,
        endFrameExclusive: anchor.target.timeline.endFrameExclusive,
      }
    }

    const { doc, revision } = read()
    const at = clock.iso()
    const snapshot = snapshotOf(anchor)
    const flattened = anchor.anchorKind === 'flattened-clip' ? describeFlattened(plan, anchor.target.id) : null
    /** @type {any} */
    const annotation = {
      annotationId: newId('annotation'),
      projectId: paths.projectId,
      objectId: snapshot.objectId,
      anchorKind: snapshot.anchorKind,
      anchorSnapshot: snapshot.snapshot,
      aspect,
      scope,
      range,
      region,
      body,
      author,
      actor,
      createdAt: at,
      versionId,
      versionRef: {
        versionId,
        label: bound.version.label ?? '',
        planRef: bound.planRef,
        planVersion: plan.planVersion,
        planFingerprint: contentHash(plan),
        planVerified: bound.planVerified,
      },
      flattened: flattened === null ? null : {
        internalObjects: flattened.internalObjects,
        selectable: [...flattened.selectable],
        claim: flattened.claim,
      },
      status: AnnotationStatus.OPEN,
      resolution: null,
      replies: [],
      evidenceRefs: assertRefList(input.evidenceRefs, 'evidenceRefs'),
    }
    doc.annotations.push(annotation)
    save(doc, revision)
    return copy(annotation)
  }

  /**
   * One annotation or `null`.
   * @param {string} annotationId
   * @returns {object|null}
   */
  function getAnnotation(annotationId) {
    const id = assertRef(annotationId, 'annotationId')
    const { doc } = read()
    const found = doc.annotations.find((entry) => entry.annotationId === id) ?? null
    return found === null ? null : copy(found)
  }

  /**
   * Annotations, optionally filtered by object, aspect, status or version.
   * @param {{ objectId?: string, aspect?: string, status?: string, versionId?: string }} [filter]
   * @returns {object[]}
   */
  function listAnnotations(filter = {}) {
    const { doc } = read()
    return doc.annotations
      .filter((entry) => (filter.objectId === undefined ? true : entry.objectId === filter.objectId))
      .filter((entry) => (filter.aspect === undefined ? true : entry.aspect === filter.aspect))
      .filter((entry) => (filter.status === undefined ? true : entry.status === filter.status))
      .filter((entry) => (filter.versionId === undefined ? true : entry.versionId === filter.versionId))
      .map((entry) => copy(entry))
  }

  /**
   * Append one reply to an annotation's discussion thread. The original body is never rewritten.
   * @param {object} input
   * @param {string} input.annotationId
   * @param {string} input.text
   * @param {string} input.author
   * @param {string} [input.actor]
   * @returns {object}
   */
  function addReply(input = {}) {
    const annotationId = assertRef(input.annotationId, 'annotationId')
    const text = assertText(input.text, 'text')
    const author = assertText(input.author, 'author', 120)
    const actor = input.actor ?? 'user'
    if (!['user', 'ai', 'system'].includes(actor)) throw new ValidationError('批注者类型不合法', { actor })
    const { doc, revision } = read()
    const annotation = doc.annotations.find((entry) => entry.annotationId === annotationId)
    if (annotation === undefined) throw new ValidationError('批注不存在', { annotationId })
    annotation.replies.push({ at: clock.iso(), text, author, actor })
    save(doc, revision)
    return copy(annotation)
  }

  /**
   * Move an annotation to a lifecycle state. `resolved` is discussion state, not user acceptance.
   * @param {object} input
   * @param {string} input.annotationId
   * @param {string} input.status one of {@link AnnotationStatus}
   * @param {string} [input.note]
   * @param {string} [input.actor]
   * @returns {object}
   */
  function setStatus(input = {}) {
    const annotationId = assertRef(input.annotationId, 'annotationId')
    const status = assertText(input.status, 'status', 40)
    if (Object.values(AnnotationStatus).includes(status) === false) {
      throw new ValidationError('未知批注状态', { status })
    }
    const actor = input.actor ?? 'user'
    const note = optionalText(input.note, 'note')
    const { doc, revision } = read()
    const annotation = doc.annotations.find((entry) => entry.annotationId === annotationId)
    if (annotation === undefined) throw new ValidationError('批注不存在', { annotationId })
    annotation.status = status
    annotation.resolution = status === AnnotationStatus.RESOLVED
      ? { at: clock.iso(), by: actor, note }
      : null
    save(doc, revision)
    return copy(annotation)
  }

  /**
   * Relocate an old reference: is the anchored object still there, and what changed since?
   *
   * This is deliberately read-only. It answers "what did this note point at" without pretending the
   * old note applies to the new state.
   *
   * @param {string} annotationId
   * @param {any} currentPlan
   * @returns {object}
   */
  function reopenReference(annotationId, currentPlan) {
    const id = assertRef(annotationId, 'annotationId')
    const annotation = getAnnotation(id)
    if (annotation === null) throw new ValidationError('批注不存在', { annotationId: id })
    if (currentPlan === null || typeof currentPlan !== 'object') {
      throw new ValidationError('重新定位需要当前计划', { field: 'currentPlan' })
    }
    if (annotation.anchorKind === 'movie') {
      return {
        annotationId: id,
        anchorKind: 'movie',
        stillMatches: true,
        objectPresent: true,
        fieldsChanged: [],
        historicalVersionId: annotation.versionId,
        currentPlanVersion: currentPlan.planVersion,
        note: '整片批注：没有对象身份可失配；仍按原版本定位',
      }
    }
    let present = null
    if (annotation.anchorKind === 'transition') {
      present = (currentPlan.transitions ?? []).find((entry) => entry.id === annotation.objectId) ?? null
    } else if (annotation.anchorKind === 'scene') {
      present = (currentPlan.scenes ?? []).find((entry) => entry.id === annotation.objectId) ?? null
    } else {
      present = (currentPlan.objects ?? []).find((entry) => entry.id === annotation.objectId) ?? null
    }
    if (present === null) {
      return {
        annotationId: id,
        anchorKind: annotation.anchorKind,
        stillMatches: false,
        objectPresent: false,
        fieldsChanged: [],
        historicalVersionId: annotation.versionId,
        currentPlanVersion: currentPlan.planVersion,
        note: '当时锚定的对象已不在当前计划里；旧批注仍指向当时版本，不能套到别的对象',
      }
    }
    const fieldsChanged = []
    if (annotation.anchorKind === 'object') {
      const before = annotation.anchorSnapshot
      if (before.kind !== present.kind) fieldsChanged.push('kind')
      if (before.sceneId !== (present.sceneId ?? null)) fieldsChanged.push('sceneId')
      if (contentHash(before.params) !== contentHash(present.params)) fieldsChanged.push('params')
      if (contentHash(before.timeline) !== contentHash(present.timeline)) fieldsChanged.push('timeline')
    } else if (contentHash(annotation.anchorSnapshot) !== contentHash(present)) {
      fieldsChanged.push('structure')
    }
    return {
      annotationId: id,
      anchorKind: annotation.anchorKind,
      stillMatches: fieldsChanged.length === 0,
      objectPresent: true,
      fieldsChanged,
      historicalVersionId: annotation.versionId,
      currentPlanVersion: currentPlan.planVersion,
      note: fieldsChanged.length === 0
        ? '对象仍在且未变，旧批注可以直接重新定位'
        : '对象仍在但与批注时不同；旧引用指向当时版本，当前差异需要重新核对',
    }
  }

  /**
   * Counts for a projection or receipt.
   * @returns {{ annotations: number, open: number, resolved: number, flattened: number, versions: string[] }}
   */
  function describe() {
    const { doc } = read()
    const open = doc.annotations.filter((entry) => entry.status === AnnotationStatus.OPEN).length
    const resolved = doc.annotations.filter((entry) => entry.status === AnnotationStatus.RESOLVED).length
    return {
      annotations: doc.annotations.length,
      open,
      resolved,
      flattened: doc.annotations.filter((entry) => entry.flattened !== null).length,
      versions: [...new Set(doc.annotations.map((entry) => entry.versionId))],
    }
  }

  return {
    projectId: paths.projectId,
    addAnnotation,
    getAnnotation,
    listAnnotations,
    addReply,
    setStatus,
    reopenReference,
    describe,
  }
}
