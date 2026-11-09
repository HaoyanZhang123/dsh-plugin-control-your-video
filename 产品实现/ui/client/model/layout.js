/**
 * Layout policy for the workbench inside one DSH main panel.
 *
 * The Host owns the left sidebar and right dock geometry; inside the panel the workbench decides
 * how structure / canvas / properties / timeline share the available width. This policy is pure so
 * the narrow-window behaviour can be tested without a browser (C11 card §4.6, UI 蓝图 §13.3).
 *
 * @module ui/client/model/layout
 */

export const LAYOUT_BREAKPOINTS = Object.freeze({
  wide: 1280,
  medium: 1024,
  narrow: 860,
})

/**
 * @param {number} width available panel width in CSS pixels
 * @param {number} [height] available panel height, used only for timeline hints
 * @returns {{
 *   mode: 'wide'|'medium'|'narrow',
 *   showLeft: boolean,
 *   showRight: boolean,
 *   leftWidth: number,
 *   rightWidth: number,
 *   timelineHeight: number,
 *   canvasMinWidth: number,
 *   compactTopbar: boolean,
 *   note: string,
 * }}
 */
export function resolveLayout(width, height) {
  const w = Number.isFinite(width) && width > 0 ? width : LAYOUT_BREAKPOINTS.wide
  const h = Number.isFinite(height) && height > 0 ? height : 900
  if (w >= LAYOUT_BREAKPOINTS.wide) {
    return {
      mode: 'wide',
      showLeft: true,
      showRight: true,
      leftWidth: Math.min(280, Math.max(232, Math.round(w * 0.17))),
      // The assistant shares this column; below ~320px its composer and message refs become unreadable.
      rightWidth: Math.min(380, Math.max(340, Math.round(w * 0.24))),
      timelineHeight: h < 760 ? 210 : 252,
      canvasMinWidth: 480,
      compactTopbar: false,
      note: '左结构 + 中画面 + 右属性 + 下时间',
    }
  }
  if (w >= LAYOUT_BREAKPOINTS.medium) {
    return {
      mode: 'medium',
      showLeft: true,
      showRight: true,
      leftWidth: 232,
      rightWidth: 300,
      timelineHeight: h < 720 ? 190 : 226,
      canvasMinWidth: 420,
      compactTopbar: true,
      note: '结构收窄，右侧保留常用属性',
    }
  }
  if (w >= LAYOUT_BREAKPOINTS.narrow) {
    return {
      mode: 'narrow',
      showLeft: false,
      showRight: true,
      leftWidth: 0,
      rightWidth: 272,
      timelineHeight: 200,
      canvasMinWidth: 320,
      compactTopbar: true,
      note: '窄窗口：结构收进抽屉，画面保持可操作',
    }
  }
  return {
    mode: 'narrow',
    showLeft: false,
    showRight: false,
    leftWidth: 0,
    rightWidth: 0,
    timelineHeight: 180,
    canvasMinWidth: 280,
    compactTopbar: true,
    note: '很窄：左右都收进抽屉，中央画面优先',
  }
}

/**
 * Which surfaces/panels a given work form needs. Empty tracks/panels must be hidden, not drawn
 * (C11 card §4.4, UI 蓝图 §13.1).
 * @param {object} form
 * @param {boolean} [form.hasNarration]
 * @param {boolean} [form.hasSubtitles]
 * @param {boolean} [form.hasSound]
 * @param {boolean} [form.hasVisual]
 */
export function resolveSurfaceVisibility(form = {}) {
  return {
    narration: form.hasNarration === true,
    subtitles: form.hasSubtitles === true,
    sound: form.hasSound === true,
    visual: form.hasVisual !== false,
    markers: true,
    transitions: form.hasTransitions === true,
  }
}

/** Fit a 16:9 canvas inside a stage box without upscaling past 1:1 of the panel. */
export function fitCanvas(stageWidth, stageHeight, aspect = 16 / 9, padding = 24) {
  const maxW = Math.max(80, Number(stageWidth) - padding * 2)
  const maxH = Math.max(45, Number(stageHeight) - padding * 2)
  const byWidth = { width: maxW, height: maxW / aspect }
  const byHeight = { width: maxH * aspect, height: maxH }
  const chosen = byWidth.height <= byHeight.height ? byWidth : byHeight
  return {
    width: Math.max(1, Math.round(chosen.width)),
    height: Math.max(1, Math.round(chosen.height)),
    letterboxX: Math.round((maxW - chosen.width) / 2),
    letterboxY: Math.round((maxH - chosen.height) / 2),
  }
}
