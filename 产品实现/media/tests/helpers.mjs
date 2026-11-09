/**
 * Shared helpers for the C12 media tests.
 *
 * The corpus is the C02 fixed corpus (read-only). A test that needs a real file must say so and
 * must fail loudly when the corpus is missing, rather than passing on an empty fixture.
 *
 * @module media/tests/helpers
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveToolchain } from '../toolchain.js'
import { Clock } from '../../base/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_ROOT = path.resolve(HERE, '..')
const PRODUCT_ROOT = path.resolve(MODULE_ROOT, '..')

/** Absolute path of the C02 fixed corpus. */
export function corpusRoot() {
  return path.resolve(process.env.C12_CORPUS ?? path.join(PRODUCT_ROOT, '..', 'RENDER-LAB', '01-corpus'))
}

/** Absolute path of the CJK font the renderer must use, resolved from the OS environment. */
export function fontFile() {
  if (typeof process.env.C12_FONT === 'string' && process.env.C12_FONT.length > 0) return process.env.C12_FONT
  const systemDrive = process.env.SystemDrive
  const windir =
    process.env.WINDIR ?? process.env.SystemRoot ?? (systemDrive ? path.join(systemDrive, 'Windows') : null)
  return windir === null ? null : path.join(windir, 'Fonts', 'msyh.ttc')
}

/** A frozen clock, so evidence and plans cannot differ between runs. */
export function frozenClock() {
  return new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 9) })
}

/** A fresh temp directory that the test owns. */
export function makeTempDir(prefix = 'c12-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** The real toolchain, or null when FFmpeg is not installed (tests then skip with a reason). */
export function tryToolchain() {
  try {
    return resolveToolchain({ allowPathLookup: true })
  } catch {
    return null
  }
}

/** Whether the corpus file exists. */
export function corpusFile(...parts) {
  const file = path.join(corpusRoot(), ...parts)
  return fs.existsSync(file) ? file : null
}

/** Remove a temp directory, ignoring Windows sharing violations from a just-closed file. */
export function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // A leftover temp directory is not a test failure; the OS can collect it.
  }
}
