/**
 * Timecode and frame arithmetic for the workbench UI.
 *
 * Frame counts are the only time authority the UI displays. Seconds are formatted only when a
 * human asked for seconds, so "45.0s" and "00:00:45:00" can never be confused (CT-04 §2).
 *
 * Pure functions only: no DOM, no Date, no locale-dependent formatting.
 *
 * @module ui/client/model/timecode
 */

export const SUPPORTED_FPS = Object.freeze([24, 25, 30, 50, 60])
export const DEFAULT_FPS = 25

/** @param {unknown} value @param {number} [fallback] */
export function normalizeFps(value, fallback = DEFAULT_FPS) {
  const fps = Number(value)
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) return fallback
  return Math.round(fps)
}

/**
 * Round a frame number into the valid range and keep it an integer.
 * @param {unknown} frame
 * @param {number} [maxFrame]
 */
export function clampFrame(frame, maxFrame) {
  const value = Number(frame)
  const safe = Number.isFinite(value) ? Math.round(value) : 0
  if (safe < 0) return 0
  if (Number.isFinite(maxFrame) && maxFrame >= 0) return Math.min(safe, Math.round(maxFrame))
  return safe
}

/**
 * Frame number → `HH:MM:SS:FF` (SMPTE-style, non-drop).
 * @param {number} frame
 * @param {number} fps
 */
export function framesToTimecode(frame, fps = DEFAULT_FPS) {
  const rate = normalizeFps(fps)
  const total = clampFrame(frame)
  const frames = total % rate
  const totalSeconds = Math.floor(total / rate)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}:${pad(frames, 2)}`
}

/**
 * Parse `HH:MM:SS:FF`, `MM:SS:FF`, `SS:FF` or plain seconds (`12.5s`). Returns null when the
 * text cannot be read as time, because silently guessing would move the playhead somewhere real.
 * @param {string} text
 * @param {number} fps
 * @returns {{ frame: number, error: null } | { frame: 0, error: string }}
 */
export function timecodeToFrames(text, fps = DEFAULT_FPS) {
  const rate = normalizeFps(fps)
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return { frame: 0, error: '时间码为空' }
  if (raw.endsWith('s') && !raw.includes(':')) {
    const seconds = Number(raw.slice(0, -1))
    if (!Number.isFinite(seconds) || seconds < 0) return { frame: 0, error: '秒数无法识别' }
    return { frame: Math.round(seconds * rate), error: null }
  }
  const parts = raw.split(':')
  if (parts.length > 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return { frame: 0, error: '时间码格式应为 HH:MM:SS:FF' }
  }
  const numbers = parts.map((part) => Number(part))
  while (numbers.length < 4) numbers.unshift(0)
  const [hours, minutes, seconds, frames] = numbers
  if (minutes > 59 || seconds > 59 || frames >= rate) {
    return { frame: 0, error: `分秒需小于 60，帧需小于 ${rate}` }
  }
  return { frame: ((hours * 60 + minutes) * 60 + seconds) * rate + frames, error: null }
}

/** Seconds (human) for a frame count, rounded to one decimal. */
export function framesToSeconds(frame, fps = DEFAULT_FPS) {
  return Math.round((clampFrame(frame) / normalizeFps(fps)) * 10) / 10
}

/** `3.2s` / `45.0s` — deliberately not a timecode. */
export function formatDuration(frame, fps = DEFAULT_FPS) {
  return `${framesToSeconds(frame, fps).toFixed(1)}s`
}

/** `00:00:12:08 / 00:00:45:00` */
export function formatProgress(frame, total, fps) {
  return `${framesToTimecode(frame, fps)} / ${framesToTimecode(total, fps)}`
}

/** Step by frames, stopping at zero. */
export function stepFrame(frame, delta, maxFrame) {
  return clampFrame(clampFrame(frame) + Math.round(Number(delta) || 0), maxFrame)
}

/** Percentage of a total, 0–100, one decimal; total 0 → 0. */
export function percentOf(frame, total) {
  const t = Number(total)
  if (!Number.isFinite(t) || t <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((clampFrame(frame) / t) * 1000) / 10))
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}
