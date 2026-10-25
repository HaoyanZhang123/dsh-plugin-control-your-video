// Capability detection: everything the plugin can use on this machine, plus what is missing.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface Capabilities {
  node: { available: boolean; version: string }
  ffmpeg: { available: boolean; path: string | null }
  ffprobe: { available: boolean; path: string | null }
  browser: { available: boolean; path: string | null; kind: 'chrome' | 'edge' | null }
  missing: string[]
  checked_at: string
}

function which(cmd: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [cmd] : ['-v', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0]
    return first ?? null
  } catch {
    return null
  }
}

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

export function detectCapabilities(): Capabilities {
  const ffmpeg = which('ffmpeg')
  const ffprobe = which('ffprobe')
  let browser: string | null = null
  let kind: 'chrome' | 'edge' | null = null
  for (const c of CANDIDATES) {
    if (existsSync(c)) {
      browser = c
      kind = c.toLowerCase().includes('msedge') ? 'edge' : 'chrome'
      break
    }
  }
  const missing: string[] = []
  if (!ffmpeg) missing.push('ffmpeg')
  if (!ffprobe) missing.push('ffprobe')
  if (!browser) missing.push('browser')
  return {
    node: { available: true, version: process.version },
    ffmpeg: { available: Boolean(ffmpeg), path: ffmpeg },
    ffprobe: { available: Boolean(ffprobe), path: ffprobe },
    browser: { available: Boolean(browser), path: browser, kind },
    missing,
    checked_at: new Date().toISOString(),
  }
}
