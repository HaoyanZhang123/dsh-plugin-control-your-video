/**
 * Regression tests for the project-reference format C06 accepts (CR-13-2).
 *
 * The bug these lock down: `assertProjectId` required a hyphenated shape (`prj-1`) while C10
 * issues `prj_` + 16 uppercase alphanumerics. Every real `advanceProjectPin` therefore threw,
 * so C13's pin sync could never run — and the comment above the pattern claimed it matched C10.
 *
 * Two things must stay true: C10's real shape is accepted, and the check remains a FORMAT check
 * that still rejects malformed references (it must not become "accept anything").
 *
 * @module tests/unit/tools-project-id.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { assertProjectId } from '../../tools/index.js'

test('project id: the shape C10 actually issues is accepted', () => {
  // Real id observed in a C10 project directory.
  assert.equal(assertProjectId('prj_WSTYAFER4BEG21TP'), 'prj_WSTYAFER4BEG21TP')
  assert.equal(assertProjectId('prj_14Z5EVKQV2J2Z3A9'), 'prj_14Z5EVKQV2J2Z3A9')
})

test('project id: the legacy hyphenated form still reads, so old records survive', () => {
  assert.equal(assertProjectId('prj-1'), 'prj-1')
  assert.equal(assertProjectId('project-locked'), 'project-locked')
})

test('project id: malformed references are still refused', () => {
  const refused = ['', 'prj_', 'prj_short', 'bad id', 'prj_WSTYAFER4BEG21TP ', '../escape', 'prj_志']
  for (const value of refused) {
    assert.throws(() => assertProjectId(value), /合法的项目 ID/, `应当拒绝: ${JSON.stringify(value)}`)
  }
  assert.throws(() => assertProjectId(undefined), /合法的项目 ID/)
  assert.throws(() => assertProjectId(42), /合法的项目 ID/)
})

test('project id: a space inside the id is rejected, not trimmed into validity', () => {
  assert.throws(() => assertProjectId('prj_WSTYAFER4BEG21TP '), /合法的项目 ID/)
  assert.throws(() => assertProjectId(' prj_WSTYAFER4BEG21TP'), /合法的项目 ID/)
})
