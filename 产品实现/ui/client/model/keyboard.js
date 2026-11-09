/**
 * Keyboard policy for the workbench panel.
 *
 * The mapping is a pure function so it can be tested without a browser, and so a future change is
 * visible as a data change rather than hidden inside an event handler (C11 card §4.6, §6.7).
 *
 * Two rules matter more than the keys themselves:
 * - typing always wins: while the user is in an input/textarea/contenteditable, ordinary keys are
 *   not stolen (only Escape is offered, because leaving a temporary area must always work);
 * - every action names whether it must preventDefault, so Space never scrolls the panel by accident.
 *
 * @module ui/client/model/keyboard
 */

/** Keys the workbench owns. Kept as data so help text and tests read the same table. */
export const KEY_ACTIONS = Object.freeze({
  PLAY_PAUSE: 'play-pause',
  FRAME_PREV: 'frame-prev',
  FRAME_NEXT: 'frame-next',
  JUMP_PREV_10: 'jump-prev-10',
  JUMP_NEXT_10: 'jump-next-10',
  GO_START: 'go-start',
  GO_END: 'go-end',
  MARK_IN: 'mark-in',
  MARK_OUT: 'mark-out',
  ADD_MARKER: 'add-marker',
  UNDO: 'undo',
  REDO: 'redo',
  FIND: 'find',
  DELETE_SELECTION: 'delete-selection',
  ESCAPE: 'escape',
  HELP: 'help',
  SAVE: 'save',
})

/** Human-readable shortcut list for the help overlay. */
export const SHORTCUT_HELP = Object.freeze([
  { keys: 'Space', action: '播放 / 暂停' },
  { keys: '← / →', action: '逐帧' },
  { keys: 'Shift + ← / →', action: '10 帧' },
  { keys: 'Home / End', action: '到开头 / 结尾' },
  { keys: 'I / O', action: '设入点 / 出点' },
  { keys: 'M', action: '加标记' },
  { keys: 'Ctrl + Z / Ctrl + Shift + Z', action: '撤销 / 重做' },
  { keys: 'Ctrl + F', action: '查找' },
  { keys: 'Delete', action: '删除所选对象' },
  { keys: 'Esc', action: '关闭当前临时区域' },
  { keys: '?', action: '显示快捷键' },
])

/**
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean }} event
 * @param {{ typing?: boolean, composing?: boolean, hasSelection?: boolean }} [context]
 * @returns {{ action: string | null, preventDefault: boolean }}
 */
export function resolveKeyAction(event, context = {}) {
  const key = String(event?.key ?? '')
  const ctrl = event?.ctrlKey === true || event?.metaKey === true
  const shift = event?.shiftKey === true
  const typing = context.typing === true

  if (context.composing === true) return { action: null, preventDefault: false }
  if (typing && key !== 'Escape') return { action: null, preventDefault: false }
  if (key === 'Escape') return { action: KEY_ACTIONS.ESCAPE, preventDefault: false }

  if (ctrl && (key === 'z' || key === 'Z')) {
    return { action: shift ? KEY_ACTIONS.REDO : KEY_ACTIONS.UNDO, preventDefault: true }
  }
  if (ctrl && (key === 'y' || key === 'Y')) return { action: KEY_ACTIONS.REDO, preventDefault: true }
  if (ctrl && (key === 'f' || key === 'F')) return { action: KEY_ACTIONS.FIND, preventDefault: true }
  if (ctrl && (key === 's' || key === 'S')) return { action: KEY_ACTIONS.SAVE, preventDefault: true }
  if (ctrl || event?.altKey === true) return { action: null, preventDefault: false }

  switch (key) {
    case ' ':
    case 'Spacebar':
      return { action: KEY_ACTIONS.PLAY_PAUSE, preventDefault: true }
    case 'ArrowLeft':
      return shift
        ? { action: KEY_ACTIONS.JUMP_PREV_10, preventDefault: true }
        : { action: KEY_ACTIONS.FRAME_PREV, preventDefault: true }
    case 'ArrowRight':
      return shift
        ? { action: KEY_ACTIONS.JUMP_NEXT_10, preventDefault: true }
        : { action: KEY_ACTIONS.FRAME_NEXT, preventDefault: true }
    case 'Home':
      return { action: KEY_ACTIONS.GO_START, preventDefault: true }
    case 'End':
      return { action: KEY_ACTIONS.GO_END, preventDefault: true }
    case 'i':
    case 'I':
      return { action: KEY_ACTIONS.MARK_IN, preventDefault: true }
    case 'o':
    case 'O':
      return { action: KEY_ACTIONS.MARK_OUT, preventDefault: true }
    case 'm':
    case 'M':
      return { action: KEY_ACTIONS.ADD_MARKER, preventDefault: true }
    case '?':
      return { action: KEY_ACTIONS.HELP, preventDefault: true }
    case 'Delete':
    case 'Backspace':
      return context.hasSelection === true
        ? { action: KEY_ACTIONS.DELETE_SELECTION, preventDefault: true }
        : { action: null, preventDefault: false }
    default:
      return { action: null, preventDefault: false }
  }
}

/** Whether an element is a text-entry target. Kept tolerant of missing DOMs for unit tests. */
export function isTypingTarget(element) {
  if (element === null || element === undefined) return false
  const tag = String(element.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (element.isContentEditable === true) return true
  return element.getAttribute?.('role') === 'textbox'
}
