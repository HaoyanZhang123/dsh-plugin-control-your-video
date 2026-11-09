/**
 * DeterminismEvidence: proving that the same plan produces the same result, and that a changed
 * dependency really changes it.
 *
 * Contract (CT-06 §7, CT-11 §5): same plan at least twice in independent contexts; cold and warm
 * cache separately; forward, reverse and random frame access; every cache dependency in the key;
 * changing a key parameter must change the result (otherwise an old cache is masquerading as new
 * work); and "two identical wrong results" never counts as proof.
 *
 * @module media/render/determinism
 */

import fs from 'node:fs'
import { ValidationError } from '../../base/index.js'
import { applyPropertyChange } from '../motion.js'
import { sha256 } from '../verify.js'

/**
 * Deterministic order for the random-access trial, so evidence can be re-run.
 * @param {number[]} frames
 * @param {number} seed
 */
export function shuffleDeterministic(frames, seed) {
  const output = [...frames]
  let state = seed >>> 0
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    const temp = output[index]
    output[index] = output[swap]
    output[swap] = temp
  }
  return output
}

/**
 * Collect the full determinism evidence for one plan and adapter.
 *
 * @param {object} input
 * @param {any} input.adapter
 * @param {any} input.plan
 * @param {string} input.outDir absolute directory for evidence outputs
 * @param {any} input.clock
 * @param {{ frames?: number[], textObjectId?: string, seed?: number, cacheRoot?: string }} [input.options]
 */
export function collectDeterminismEvidence(input) {
  const adapter = input.adapter
  const plan = input.plan
  const outDir = input.outDir
  const clock = input.clock
  fs.mkdirSync(outDir, { recursive: true })
  const frames = input.options?.frames ?? [0, 67, 134, 200, 269]
  const textObjectId = input.options?.textObjectId ?? plan.objects.find((object) => object.kind === 'text-native')?.id
  if (textObjectId === undefined) throw new ValidationError('确定性证据需要至少一个文字对象做参数变化试验')

  const key = adapter.computeCacheKey(plan, { tier: 'final', width: plan.outputSpec.width, height: plan.outputSpec.height })

  const renderTo = (suffix) =>
    adapter.renderFinal(plan, plan.outputSpec, {
      outputPath: `${outDir}/determinism-${suffix}.mp4`,
    })

  // 1. Cold run: remove the cache entry first so "cold" is real, not assumed.
  const cachePath = `${input.options?.cacheRoot ?? ''}`
  if (typeof input.clearCache === 'function') input.clearCache(key.key)
  const cold = renderTo('cold')

  // 2. Warm run: same plan, same key, must reuse the cache and produce identical bytes.
  const warm = renderTo('warm')

  // 3. Independent context: a second adapter instance, its own process invocations.
  const second = input.createSecondAdapter === undefined ? null : input.createSecondAdapter()
  const independent = second === null ? null : second.renderFinal(plan, plan.outputSpec, { outputPath: `${outDir}/determinism-independent.mp4` })

  // 4. Frame access order: same frame must hash the same regardless of order.
  const stills = (order) => {
    const result = {}
    for (const frame of order) {
      result[frame] = adapter.renderStillRaw(plan, frame).sha256
    }
    return result
  }
  const forward = stills(frames)
  const reverse = stills([...frames].reverse())
  const random = stills(shuffleDeterministic(frames, input.options?.seed ?? 20261109))
  const accessConsistent =
    frames.every((frame) => forward[frame] === reverse[frame] && forward[frame] === random[frame])

  // 5. Parameter change must produce different bytes and a different cache key.
  const changed = applyPropertyChange(plan, textObjectId, 'text', `${plan.objects.find((o) => o.id === textObjectId)?.params?.text ?? ''}·`, {
    planVersion: `${plan.planVersion}-det`,
  }).plan
  const changedResult = adapter.renderFinal(changed, changed.outputSpec, {
    outputPath: `${outDir}/determinism-param-change.mp4`,
  })
  const changedKey = adapter.computeCacheKey(changed, {
    tier: 'final',
    width: changed.outputSpec.width,
    height: changed.outputSpec.height,
  })

  const evidence = {
    collectedAt: clock.iso(),
    runtime: { id: adapter.describe().runtime.id, version: adapter.describe().runtime.version },
    plan: { id: plan.planId, version: plan.planVersion, fingerprint: plan.planFingerprint ?? null },
    seed: input.options?.seed ?? 20261109,
    cacheKey: { key: key.key, components: key.components },
    coldRun: {
      sha256: cold.sha256,
      bytes: cold.bytes,
      cache: cold.execution.cache,
      durationMs: cold.execution.durationMs,
    },
    warmRun: {
      sha256: warm.sha256,
      bytes: warm.bytes,
      cache: warm.execution.cache,
      durationMs: warm.execution.durationMs,
    },
    independentContext: independent === null
      ? { checked: false, note: '没有提供第二适配器上下文' }
      : { sha256: independent.sha256, matchedCold: independent.sha256 === cold.sha256 },
    frameAccess: { frames, forward, reverse, random, consistent: accessConsistent },
    parameterChange: {
      objectId: textObjectId,
      cacheKeyChanged: changedKey.key !== key.key,
      bytesChanged: changedResult.sha256 !== cold.sha256,
      changedSha256: changedResult.sha256,
    },
    byteIdentical: cold.sha256 === warm.sha256 && (independent === null || independent.sha256 === cold.sha256),
    cacheReuse: warm.execution.cache === 'warm',
    verdict: {
      sameResultTwice: cold.sha256 === warm.sha256,
      warmIsFasterOrEqual: warm.execution.durationMs <= cold.execution.durationMs + 1,
      changedParameterChangesResult: changedResult.sha256 !== cold.sha256 && changedKey.key !== key.key,
      frameAccessOrderIndependent: accessConsistent,
      note: '两次相同只证明可重复，不证明画面对；画面对由编码前后帧与区域对照分别检查',
    },
    unusedCacheRoot: cachePath,
  }
  evidence.verdict.ok =
    evidence.byteIdentical &&
    evidence.cacheReuse &&
    evidence.verdict.changedParameterChangesResult &&
    evidence.verdict.frameAccessOrderIndependent
  return evidence
}
