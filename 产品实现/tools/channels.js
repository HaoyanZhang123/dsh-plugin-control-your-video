/**
 * ToolExecutionProtocol channels: MCP, CLI and IPC.
 *
 * CT-14 §3 requires seven behaviours from ANY tool execution, and this module makes them structural
 * rather than advisory:
 *
 * 1. read the actual description, schema, version and permissions;
 * 2. query the real state and save a baseline BEFORE modifying;
 * 3. prefer a dedicated structured tool;
 * 4. arbitrary code execution only inside CT-12's user permission and real isolation;
 * 5. read back the object, version, media and actual effect AFTER;
 * 6. a failure is never silently skipped, and an unknown state is never repeated;
 * 7. non-destructive first, keeping candidates, call identity, dedupe and recovery.
 *
 * What this module does NOT do: it does not spawn processes, open sockets or call MCP servers. Those
 * are C12's adapters. C06 owns the *declaration, permission and lifecycle envelope* — which channel a
 * capability uses, what it may touch, what its schema fingerprint is, and whether a previously
 * verified fingerprint still holds after a tool update (C06 §4.4).
 *
 * MCP is supported but is NOT a product prerequisite ("MCP 不是必须采用的产品前提"): a CLI-only tool
 * declares a `cli` channel and is managed identically.
 *
 * @module tools/channels
 */

import { ValidationError, invariant } from '../base/index.js'
import { ChannelKind, PermissionKind, assertEnum, isStructuredChannel } from './schema.js'
import { contentHash } from '../base/index.js'

/**
 * @typedef {object} ChannelDeclaration
 * @property {string} kind one of `ChannelKind`
 * @property {boolean} structured whether a machine-readable description/schema can be read
 * @property {string[]} permissions one of `PermissionKind`
 * @property {string|null} entrypoint how the channel is reached, e.g. a command or a server name
 * @property {string|null} serverName for MCP, the declared server identity
 * @property {string|null} socketPath for IPC, the declared endpoint
 */

/**
 * Normalize and validate one channel declaration.
 *
 * The point of validating this instead of accepting free-form metadata is that the permission list is
 * what a later execution gate consults: a capability that declares no `filesystem` permission cannot
 * be handed a filesystem scope, and that check is only possible if the declaration is closed.
 *
 * @param {unknown} input
 * @param {string} [field]
 * @returns {Readonly<ChannelDeclaration>}
 */
export function normalizeChannel(input, field = 'channel') {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const kind = assertEnum(record.kind, ChannelKind, `${field}.kind`)
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.map((value, index) => assertEnum(value, PermissionKind, `${field}.permissions[${index}]`))
    : []
  if (permissions.length === 0) {
    // A capability that declares no permission is claiming it touches nothing, which is only true of
    // a pure description read. Refusing here keeps that claim from being made by omission.
    throw new ValidationError(`${field} 必须声明至少一项权限`, { field })
  }
  const declaration = {
    kind,
    structured: isStructuredChannel(kind),
    permissions,
    entrypoint: optionalText(record.entrypoint, `${field}.entrypoint`),
    serverName: optionalText(record.serverName, `${field}.serverName`),
    socketPath: optionalText(record.socketPath, `${field}.socketPath`),
  }
  if (kind === ChannelKind.MCP && declaration.serverName === null) {
    throw new ValidationError(`${field}：MCP 通道必须声明 serverName`, { field })
  }
  if (kind === ChannelKind.IPC && declaration.socketPath === null && declaration.entrypoint === null) {
    throw new ValidationError(`${field}：IPC 通道必须声明 socketPath 或 entrypoint`, { field })
  }
  if (kind === ChannelKind.CLI && declaration.entrypoint === null) {
    throw new ValidationError(`${field}：CLI 通道必须声明 entrypoint`, { field })
  }
  if (kind === ChannelKind.CLI) {
    // A CLI entrypoint is resolved by the adapter when it spawns. Requiring a BARE COMMAND NAME means a
    // catalog can never redirect that spawn to an arbitrary binary with a path or `..`, and keeps the
    // "which program will actually run" question answerable from the declaration alone.
    if (!/^[A-Za-z0-9._-]+$/.test(declaration.entrypoint)) {
      throw new ValidationError(`${field}：CLI entrypoint 必须是可执行文件名，不能是路径`, {
        field: `${field}.entrypoint`,
        value: declaration.entrypoint.slice(0, 60),
      })
    }
  }
  return Object.freeze(declaration)
}

/**
 * A stable fingerprint of a tool's description/schema, used to detect capability drift.
 *
 * Why a fingerprint and not a version number: C06 §4.4 says a tool whose schema or capabilities
 * changed after an update must be re-verified, and "不能因工具名相同就沿用旧可用状态". A tool can keep
 * its version while its declared tool list changes (or the reverse), so the fingerprint covers what
 * actually matters: the observable structured surface.
 *
 * @param {object} description
 * @param {string} description.version exact build reported by the tool
 * @param {Array<{ name: string, inputSchema?: unknown, description?: string }>} [description.tools]
 * @param {string[]} [description.capabilities]
 * @returns {{ fingerprint: string, components: Record<string, string> }}
 */
export function schemaFingerprint(description) {
  if (description === null || typeof description !== 'object') {
    throw new ValidationError('需要工具描述才能计算 schema 指纹', { field: 'description' })
  }
  const version = typeof description.version === 'string' ? description.version : 'unknown'
  const tools = Array.isArray(description.tools)
    ? description.tools
        .filter((tool) => tool !== null && typeof tool === 'object' && typeof tool.name === 'string')
        .map((tool) => ({
          // Only the SHAPE is fingerprinted. A description string changing is cosmetic; a schema
          // change is behavioural, and both are recorded so the receipt can say which moved.
          name: tool.name,
          schema: tool.inputSchema ?? null,
          descriptionHash: typeof tool.description === 'string' ? contentHash(tool.description) : null,
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    : []
  const capabilities = Array.isArray(description.capabilities)
    ? [...description.capabilities].filter((value) => typeof value === 'string').sort()
    : []
  const payload = { version, tools, capabilities }
  const fingerprint = contentHash(payload)
  return {
    fingerprint,
    components: {
      version,
      toolCount: String(tools.length),
      toolNames: tools.map((tool) => tool.name).join(','),
      capabilityCount: String(capabilities.length),
    },
  }
}

/**
 * Compare a fingerprint recorded at verification time with one observed now.
 *
 * Reported as an explicit verdict so the caller can show "工具更新后需要重新验证" instead of guessing.
 *
 * @param {string|null} recorded
 * @param {string|null} observed
 * @returns {{ changed: boolean, reason: string|null }}
 */
export function fingerprintChange(recorded, observed) {
  if (recorded === null || recorded === undefined) {
    return { changed: true, reason: '没有上一次验证的指纹' }
  }
  if (observed === null || observed === undefined) {
    return { changed: false, reason: '本次没有读到描述，无法比较' }
  }
  if (recorded === observed) return { changed: false, reason: null }
  return { changed: true, reason: '工具描述／schema 与上次验证时不同，必须重新验证' }
}

/**
 * Assert a capability may act with the permissions it declares.
 *
 * This is the gate that makes "安装或执行不得自动读取无关用户文件、凭据或项目" checkable at the call
 * site: the caller states which permissions the operation actually needs, and a declaration that does
 * not include them is refused instead of being trusted.
 *
 * @param {ChannelDeclaration} channel
 * @param {string[]} requiredPermissions
 * @returns {{ ok: true, declared: string[] }}
 */
export function assertPermissions(channel, requiredPermissions) {
  invariant(channel !== null && typeof channel === 'object', '需要通道声明')
  const declared = new Set(channel.permissions ?? [])
  const missing = []
  for (const permission of requiredPermissions ?? []) {
    assertEnum(permission, PermissionKind, 'requiredPermissions')
    if (!declared.has(permission)) missing.push(permission)
  }
  if (missing.length > 0) {
    throw new ValidationError('工具通道没有声明执行该动作所需的权限', {
      channel: channel.kind,
      missing,
      declared: [...declared],
    })
  }
  return { ok: true, declared: [...declared] }
}

/**
 * Refuse an arbitrary-code request when a structured route exists.
 *
 * "专用结构化工具优先，任意代码执行只是补充" is only meaningful if the fallback is refused when the
 * structured route is available. A caller that genuinely needs code execution must say so explicitly
 * and carry the CT-12 authorization id.
 *
 * @param {object} input
 * @param {ChannelDeclaration} input.channel
 * @param {boolean} input.wantsArbitraryCode
 * @param {string|null} [input.codeAuthorizationId] CT-12 authorization for code execution
 * @returns {{ route: 'structured'|'arbitrary-code', reason: string }}
 */
export function resolveExecutionRoute(input) {
  const channel = input?.channel
  invariant(channel !== null && typeof channel === 'object', '需要通道声明')
  if (input?.wantsArbitraryCode !== true) {
    return { route: 'structured', reason: isStructuredChannel(channel.kind) ? '通道可读结构化描述' : '标准参数调用' }
  }
  if (isStructuredChannel(channel.kind)) {
    // The structured route is available AND the caller asked for code: refuse rather than downgrade.
    throw new ValidationError('该通道有结构化工具可用，不应使用任意代码执行', {
      channel: channel.kind,
      action: '请改用结构化调用；任意代码执行只在没有结构化替代且用户明确授权时使用',
    })
  }
  if (typeof input?.codeAuthorizationId !== 'string' || input.codeAuthorizationId.length === 0) {
    throw new ValidationError('任意代码执行需要 CT-12 的明确授权记录', {
      field: 'codeAuthorizationId',
      action: '请先取得用户对代码执行的授权',
    })
  }
  return { route: 'arbitrary-code', reason: `没有结构化替代，且携带授权 ${input.codeAuthorizationId}` }
}

/**
 * Build the before/after state envelope a caller must fill in around an execution.
 *
 * Returning a structured envelope rather than trusting prose is what makes "执行后读回真实结果"
 * assertable: a caller that never fills `after` cannot claim the call succeeded.
 *
 * @param {object} input
 * @param {string} input.callId a caller-stable identity, so a retry can be de-duplicated
 * @param {string} input.toolId
 * @param {unknown} input.beforeState the real state observed before changing anything
 * @returns {{ callId: string, toolId: string, beforeState: unknown, afterState: null, startedAt: string|null }}
 */
export function beginExecution(input) {
  if (typeof input?.callId !== 'string' || input.callId.length === 0) {
    throw new ValidationError('执行需要 callId，以便失败后去重', { field: 'callId' })
  }
  if (input?.beforeState === undefined) {
    // "修改前查询真实状态并保存基线" is a precondition, not an optional nicety.
    throw new ValidationError('执行前必须保存真实状态基线', { field: 'beforeState' })
  }
  return {
    callId: input.callId,
    toolId: String(input.toolId ?? ''),
    beforeState: input.beforeState,
    afterState: null,
    startedAt: null,
    result: null,
    failure: null,
  }
}

/**
 * Close an execution envelope with the real read-back.
 *
 * A failure may leave `afterState` null, and that is recorded as `stateUnknown: true` rather than
 * being smoothed over: "失败不静默跳过，状态未知不重复" (CT-14 §3.6).
 *
 * @param {object} envelope a value from {@link beginExecution}
 * @param {object} input
 * @param {unknown} [input.afterState] the real state read back after the call
 * @param {unknown} [input.result] the real result
 * @param {unknown} [input.failure] what failed
 * @param {string|null} [input.completedAt] ISO timestamp supplied by the caller's clock
 * @returns {object}
 */
export function endExecution(envelope, input = {}) {
  invariant(envelope !== null && typeof envelope === 'object', '需要执行envelope')
  const hasAfter = input.afterState !== undefined
  return {
    ...envelope,
    afterState: hasAfter ? input.afterState : null,
    result: input.result ?? null,
    failure: input.failure ?? null,
    stateUnknown: !hasAfter,
    completedAt: typeof input.completedAt === 'string' ? input.completedAt : null,
    /** A caller must not treat an incomplete envelope as success; tests assert this flag. */
    complete: hasAfter,
  }
}

/**
 * Describe what a user would be granting for one channel, in product language.
 *
 * Keeps the permission vocabulary from leaking into user-facing text while still telling the user
 * what the tool may touch.
 *
 * @param {ChannelDeclaration} channel
 * @returns {{ kind: string, structured: boolean, permissions: string[], summary: string }}
 */
export function describeChannel(channel) {
  invariant(channel !== null && typeof channel === 'object', '需要通道声明')
  const labels = {
    [PermissionKind.FILESYSTEM]: '读写本机文件',
    [PermissionKind.NETWORK]: '联网',
    [PermissionKind.PROCESS]: '启动外部进程',
    [PermissionKind.MEDIA]: '处理媒体文件',
    [PermissionKind.ENVIRONMENT]: '修改环境',
    [PermissionKind.EXTERNAL_SERVICE]: '访问外部服务',
  }
  const permissions = (channel.permissions ?? []).map((permission) => labels[permission] ?? permission)
  return {
    kind: channel.kind,
    structured: channel.structured === true,
    permissions,
    summary: `${channel.kind.toUpperCase()} 通道；会${permissions.join('、')}`,
  }
}

/** @param {unknown} value @param {string} field @returns {string|null} */
function optionalText(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field })
  }
  return value
}
