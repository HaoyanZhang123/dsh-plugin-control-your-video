/**
 * User-facing words for every state the workbench renders.
 *
 * One table per concept, so two panels cannot invent two spellings for the same Host fact, and so
 * "未接入" can never be worded like "已完成" (C11 card §4.6, §6.10).
 *
 * @module ui/client/model/labels
 */

export const SURFACE_LABELS = Object.freeze({ creation: '创作', work: '作品' })

export const PHASE_FALLBACK = Object.freeze({
  intake: '接收输入',
  aligning: '对齐方向',
  'ready-for-production': '可以开始完整制作',
  producing: '制作中',
  'initial-review': '初版待审',
  finalizing: '定稿处理',
  completed: '已完成',
  archived: '已归档',
  'recycle-bin': '回收区',
})

export const EXECUTION_FALLBACK = Object.freeze({
  idle: '空闲',
  'waiting-user': '等待你的决定',
  'waiting-authorization': '等待授权',
  running: '执行中',
  pausing: '正在暂停',
  paused: '已暂停',
  cancelling: '正在取消',
  cancelled: '已取消',
  failed: '失败',
  'needs-attention': '需要处理',
  unknown: '状态未知',
  done: '已完成',
})

export const TOOL_STATE_LABELS = Object.freeze({
  usable: '可用',
  'not-installed': '未安装',
  'outdated': '需更新或不兼容',
  'installed-unverified': '已安装未验证',
  'verification-failed': '验证失败',
  unknown: '未检查',
})

export const SAVE_STATE_LABELS = Object.freeze({
  idle: '未修改',
  saving: '正在保存…',
  saved: '已自动保存',
  error: '保存失败',
})

export const RECOVERY_LABELS = Object.freeze({
  'can-continue': '可以继续',
  'needs-handling': '需要处理',
})

export const ASSISTANT_STATUS_LABELS = Object.freeze({
  'queued-for-orchestration': '已保存，等待制作编排接入',
  answered: '已回复',
})

export const MATERIAL_KIND_LABELS = Object.freeze({
  image: '图像',
  video: '视频',
  audio: '音频',
  text: '文本',
  font: '字体',
  document: '文档',
  other: '其他',
})

export const MATERIAL_OBSERVATION_LABELS = Object.freeze({
  unread: '未读',
  unreadable: '不可读',
  'observed-partial': '未完整观察',
  'observed-full': '已完整观察',
  unknown: '观察状态未知',
})

export const PREFERENCE_GROUP_LABELS = Object.freeze({
  creation: '创作方式',
  notification: '通知',
  'data-authorization': '数据与授权',
  storage: '存储',
  workspace: '工作区',
})

export const PREFERENCE_LABELS = Object.freeze({
  'creation.aspect-ratio': '默认画幅',
  'creation.frame-rate': '默认帧率',
  'creation.style-preset': '默认风格',
  'notification.on-completion': '完成时通知',
  'notification.needs-attention': '需要处理时通知（不可关闭）',
  'notification.verbosity': '通知详细程度',
  'data-authorization.default': '默认数据授权',
  'data-authorization.external-service': '外部服务授权',
  'data-authorization.upload-materials': '材料提交授权',
  'storage.projects-root': '项目根目录',
  'storage.cache-retention-days': '缓存保留天数',
  'workspace.show-advanced-panels': '显示高级面板',
  'workspace.confirm-before-destructive': '危险动作前确认',
})

export const WAITING_KIND_LABELS = Object.freeze({
  'waiting-user': '等待你的决定',
  'needs-attention': '需要处理',
  recovery: '恢复差异',
  tool: '缺工具',
  candidate: '必要候选',
})

/**
 * Capabilities this card does NOT implement. They are rendered as explicit gaps with the owning
 * card, never as disabled-but-looks-finished controls (C11 card §6.10).
 */
export const INTEGRATION_GAPS = Object.freeze({
  composition: {
    owner: 'C12',
    title: '合成、渲染与对象映射',
    message: '真实画面、时间线和原生对象由 C12 接入；当前项目还没有可编辑的合成计划。',
  },
  orchestration: {
    owner: 'C13',
    title: '创作编排与连续制作',
    message: '方向、方案、早期单元和项目助手的回答由 C13 接入；当前只能保存你的要求与引用。',
  },
  review: {
    owner: 'C14',
    title: '审阅、候选与回退',
    message: '新旧对照、候选接受与局部回退由 C14 接入。',
  },
  delivery: {
    owner: 'C15',
    title: '交付、项目包与结项',
    message: '交付、项目包与结项的只读视图已接入；导出、确认与清理等可点操作仍未接入。',
  },
})

/** @param {string} phase */
export function phaseLabel(phase) {
  return PHASE_FALLBACK[phase] ?? String(phase ?? '未知阶段')
}

/** @param {string} execution */
export function executionLabel(execution) {
  return EXECUTION_FALLBACK[execution] ?? String(execution ?? '未知状态')
}

/** @param {string} status */
export function toolStateLabel(status) {
  return TOOL_STATE_LABELS[status] ?? String(status ?? '未检查')
}

/** @param {string} kind */
export function waitingKindLabel(kind) {
  return WAITING_KIND_LABELS[kind] ?? '需要你处理'
}

/** Whether an execution state should be shown with the "needs attention" tone. */
export function isAttentionExecution(execution) {
  return execution === 'needs-attention' || execution === 'failed' || execution === 'unknown'
}
