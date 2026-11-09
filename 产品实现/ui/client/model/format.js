/**
 * Deterministic display formatting for the workbench.
 *
 * The UI keeps numbers honest: byte counts are rounded with a unit, dates are ISO facts rendered
 * in the viewer's locale, and "几秒前" is computed from an explicit `now` so tests can pin it.
 *
 * @module ui/client/model/format
 */

/** 0 B / 1.4 KB / 3.7 MB / 1.2 GB */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}

/** ISO → `2026-11-08 21:48` local; invalid → the raw text so an unknown value stays visible. */
export function formatDateTime(iso) {
  const date = new Date(iso)
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return String(iso ?? '—')
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** ISO → `21:48` local. */
export function formatTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Relative age with an explicit now (ms). `刚刚 / 3 分钟前 / 昨天 / 3 天前 / 具体日期`. */
export function formatRelative(iso, now = Date.now()) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const diff = Math.max(0, now - date.getTime())
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return formatDateTime(iso).slice(0, 10)
}

/** `proj_9f3a…` → `9f3a…`; a short id is still unique enough to talk about. */
export function shortId(id) {
  const text = String(id ?? '')
  const match = /^[a-z]+_([a-z0-9]+)$/i.exec(text)
  if (match) return match[1].slice(0, 8)
  return text.slice(0, 8)
}

/** Join non-empty parts with ` · `. */
export function joinMeta(parts) {
  return (Array.isArray(parts) ? parts : []).filter((part) => typeof part === 'string' && part.length > 0).join(' · ')
}

/** `rev-1a2b3c4d5e6f` → `rev-1a2b3c`; long hashes stay traceable but fit a label. */
export function shortRevision(revision) {
  const text = String(revision ?? '')
  if (text.length === 0) return '—'
  return text.length > 14 ? `${text.slice(0, 14)}…` : text
}

/** 45 seconds → `00:45`; used where a timecode's frame field would be noise. */
export function formatMinuteSeconds(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

/** Truncate a filename in the middle, preserving the extension. */
export function middleTruncate(text, max = 34) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const dot = value.lastIndexOf('.')
  const extension = dot > 0 && value.length - dot <= 8 ? value.slice(dot) : ''
  const head = Math.max(4, Math.floor((max - extension.length - 1) / 2))
  const tail = Math.max(4, max - extension.length - head - 1)
  return `${value.slice(0, head)}…${value.slice(-tail)}${extension}`
}
