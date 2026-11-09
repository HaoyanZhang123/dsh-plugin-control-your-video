/**
 * Affected-capability reporting: what the creation surface is told when a tool is missing or failed.
 *
 * The product rule is narrow: while the user is creating, a tool problem must NOT become a maintenance
 * task. The creation surface receives (C06 §4.1, §4.5; UI §11.1 "创作中缺工具时只报告受影响能力和已保存
 * 结果"):
 *
 * - which capabilities are affected,
 * - what in the user's work still stands (their project results are untouched),
 * - the one next step (go to the tool page), and
 * - nothing else — no install dialog, no progress bar, no log.
 *
 * This module never touches a project. It cannot, by construction: it imports no project module and takes
 * no project path — only an optional reference to a project id, which it never resolves. That is
 * deliberate, because "工具缺失时保留项目结果" is easiest to guarantee by having no code path that could
 * delete one (C06 §7.9).
 *
 * @module tools/impact
 */

import { ValidationError } from '../base/index.js'
import { CapabilityState, CatalogClass, IMPACT_LABELS, ImpactCode, ToolStatus } from './schema.js'

/**
 * Map a tool status to the impact code the creation surface shows.
 *
 * Every status maps to exactly one code, including the happy path (`null`), so a caller cannot end up with
 * an unlabelled degraded state.
 *
 * @param {string} status
 * @returns {string|null}
 */
export function impactCodeForStatus(status) {
  switch (status) {
    case ToolStatus.AVAILABLE:
      return null
    case ToolStatus.NOT_INSTALLED:
      return ImpactCode.TOOL_NOT_INSTALLED
    case ToolStatus.NEEDS_UPDATE:
      return ImpactCode.TOOL_NEEDS_UPDATE
    case ToolStatus.INCOMPATIBLE:
      return ImpactCode.TOOL_INCOMPATIBLE
    case ToolStatus.VERIFICATION_FAILED:
      return ImpactCode.TOOL_VERIFICATION_FAILED
    case ToolStatus.INSTALLED_UNVERIFIED:
      return ImpactCode.TOOL_INSTALLED_UNVERIFIED
    case ToolStatus.RESEARCH_CANDIDATE:
      return ImpactCode.TOOL_RESEARCH_CANDIDATE
    case ToolStatus.CHECKING:
    case ToolStatus.UNKNOWN:
      return ImpactCode.TOOL_STATE_UNKNOWN
    default:
      return ImpactCode.TOOL_STATE_UNKNOWN
  }
}

/**
 * Compute the impact report for a set of capabilities.
 *
 * @param {object} input
 * @param {object} input.catalog
 * @param {Record<string, string>} input.statusByToolId status per tool id
 * @param {{ projectId?: string, capabilityIds?: string[], includeResearch?: boolean }} [input.scope]
 * @returns {{
 *   capabilities: Array<object>,
 *   affected: string[],
 *   usable: string[],
 *   anyAffected: boolean,
 *   projectFactsUntouched: true,
 *   projectRef: { projectId: string }|null,
 *   nextStep: string|null,
 * }}
 */
export function computeImpact(input) {
  const catalog = input?.catalog
  if (catalog === null || typeof catalog !== 'object' || !(catalog.capabilityIndex instanceof Map)) {
    throw new ValidationError('computeImpact 需要目录', { field: 'catalog' })
  }
  const statusByToolId = input?.statusByToolId ?? {}
  const wanted = Array.isArray(input?.scope?.capabilityIds) ? new Set(input.scope.capabilityIds) : null
  const projectRef =
    typeof input?.scope?.projectId === 'string' && input.scope.projectId.length > 0
      ? { projectId: input.scope.projectId }
      : null

  /** @type {Array<object>} */
  const capabilities = []
  /** @type {string[]} */
  const affected = []
  /** @type {string[]} */
  const usable = []

  for (const [capabilityId, entry] of catalog.capabilityIndex) {
    if (wanted !== null && !wanted.has(capabilityId)) continue
    // Capabilities that live in a research pack are never part of the official capability set: they have
    // no usable tool and showing them here would imply they were available (UI §11.1).
    if (entry.catalogClass !== CatalogClass.OFFICIAL && input?.includeResearch !== true) continue
    const capability = entry.capability
    /** @type {Array<{ toolId: string, displayName: string, status: string, code: string, label: string }>} */
    const blockers = []
    /** @type {Array<{ toolId: string, status: string }>} */
    const pending = []
    for (const requirement of capability.requires) {
      const status = statusByToolId[requirement.toolId] ?? ToolStatus.NOT_INSTALLED
      if (status === ToolStatus.AVAILABLE) continue
      if (status === ToolStatus.CHECKING) {
        pending.push({ toolId: requirement.toolId, status })
        continue
      }
      if (requirement.optional) continue
      const code = impactCodeForStatus(status)
      blockers.push({
        toolId: requirement.toolId,
        displayName: toolDisplayName(catalog, requirement.toolId),
        status,
        code,
        label: IMPACT_LABELS[code] ?? '所需工具当前不可用',
      })
    }

    let state
    const requiredCount = capability.requires.filter((requirement) => !requirement.optional).length
    if (blockers.length === 0 && pending.length === 0) state = CapabilityState.AVAILABLE
    else if (blockers.length === 0) state = CapabilityState.UNKNOWN
    else if (blockers.length === requiredCount) state = CapabilityState.UNAVAILABLE
    else state = CapabilityState.PARTIALLY_AVAILABLE

    const entryReport = {
      capabilityId,
      displayName: capability.displayName,
      userOutcome: capability.userOutcome,
      surface: capability.surface ?? null,
      state,
      blockers,
      pending,
      /** What still stands in the user's project. Tools never own project facts (C06 §4.1). */
      preserved: '你的项目、已保存版本和已有结果都保留，不受工具状态影响',
    }
    capabilities.push(entryReport)
    if (state === CapabilityState.AVAILABLE) usable.push(capabilityId)
    else affected.push(capabilityId)
  }

  return {
    capabilities,
    affected,
    usable,
    anyAffected: affected.length > 0,
    projectFactsUntouched: true,
    // Only a reference: this module never reads or writes anything about the project itself (CR-5).
    projectRef,
    // One next step, in product language. Maintenance belongs to the tool page, not the creation flow.
    nextStep: affected.length === 0 ? null : '去「工具」页查看并处理受影响的能力',
  }
}

/**
 * The single short message a creation surface may show.
 *
 * Kept to one string on purpose: a longer block would be a maintenance UI embedded in creation, which
 * UI §11.1 and MIT P3 §3.3.7 forbid.
 *
 * @param {object} impact a value from {@link computeImpact}
 * @returns {string|null}
 */
export function impactSummary(impact) {
  if (impact?.anyAffected !== true) return null
  const names = impact.capabilities
    .filter((capability) => capability.state !== CapabilityState.AVAILABLE)
    .map((capability) => capability.displayName)
  const shown = names.slice(0, 3).join('、')
  const more = names.length > 3 ? ` 等 ${names.length} 项` : ''
  return `部分能力当前不可用：${shown}${more}。你的项目与已保存结果都已保留；处理请到「工具」页。`
}

/**
 * The user-facing name of a tool, falling back to the id so a missing catalog entry is visible instead of
 * silently blank.
 * @param {object} catalog
 * @param {string} toolId
 * @returns {string}
 */
function toolDisplayName(catalog, toolId) {
  const definition = catalog.toolIndex.get(toolId)?.definition
  return definition?.displayName ?? toolId
}

/**
 * Describe what a tool's failure does and does NOT affect, for the tool page's detail area.
 *
 * @param {object} catalog
 * @param {string} toolId
 * @returns {{ capabilities: string[], preserved: string }}
 */
export function capabilitiesUsingTool(catalog, toolId) {
  const names = []
  for (const pack of catalog.packs) {
    for (const capability of pack.capabilities) {
      if (capability.requires.some((requirement) => requirement.toolId === toolId)) {
        names.push(capability.displayName)
      }
    }
  }
  return {
    capabilities: [...new Set(names)],
    preserved: '该工具的状态只影响上面这些能力；项目、版本与已有媒体结果不受影响',
  }
}
