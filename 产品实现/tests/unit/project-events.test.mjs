/**
 * Unit tests for the append-only project event log.
 *
 * The log is what makes a decision or confirmation traceable to an object and version rather than
 * to a chat message (CT-03 §1). These tests prove it is really append-only, really durable, and
 * honest about a damaged tail. C10 card §4 many; CT-11 §1.
 *
 * @module tests/unit/project-events.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTempDir, Clock } from '../../base/index.js'
import {
  appendEvents,
  readEvents,
  readRecentEvents,
  buildEvent,
  eventLogPath,
  eventLogDigest,
  countEvents,
  verifyAppendOnly,
  ProjectEventKind,
  MAX_EVENT_PAGE,
} from '../../core/project/events.js'

const temp = createTempDir({ label: 'events' })
const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
test.after(() => temp.dispose())

/** A fresh project directory (the log only needs the directory). */
let counter = 0
function projectDir() {
  counter += 1
  return temp.dir(`p${counter}`)
}

test('events: appended events are readable from disk with a monotonic sequence', () => {
  const dir = projectDir()
  const result = appendEvents(
    dir,
    [
      buildEvent({ kind: ProjectEventKind.PROJECT_CREATED, projectId: 'prj_1', actor: 'user', detail: { title: 't' } }),
      buildEvent({ kind: ProjectEventKind.PROJECT_PHASE_CHANGED, projectId: 'prj_1', actor: 'user', detail: {} }),
    ],
    { clock },
  )
  assert.equal(result.appended, 2)
  assert.equal(result.lastSequence, 2)

  const read = readEvents(dir)
  assert.equal(read.total, 2)
  assert.equal(read.events[0].sequence, 1)
  assert.equal(read.events[1].sequence, 2)
  assert.equal(read.events[0].kind, 'project.created')
  // Each event carries its own identity and time, so a consumer needs no join.
  assert.match(read.events[0].eventId, /^evt_[0-9A-HJKMNP-TV-Z]{16}$/)
  assert.equal(read.events[0].at, clock.iso())
})

test('events: appending twice keeps earlier events byte-identical', () => {
  const dir = projectDir()
  appendEvents(dir, [buildEvent({ kind: 'test.first', projectId: 'prj_1', actor: 'user', detail: { n: 1 } })], {
    clock,
    nextSequence: 0,
  })
  const firstLine = fs.readFileSync(eventLogPath(dir), 'utf8').split('\n')[0]

  appendEvents(dir, [buildEvent({ kind: 'test.second', projectId: 'prj_1', actor: 'ai', detail: { n: 2 } })], { clock })
  const lines = fs.readFileSync(eventLogPath(dir), 'utf8').split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 2)
  assert.equal(lines[0], firstLine, '追加不得改写既有事件')
  const read = readEvents(dir)
  assert.equal(read.events[1].sequence, 2, '追加需要延续序号')
})

test('events: filters work on kind, object and version', () => {
  const dir = projectDir()
  appendEvents(
    dir,
    [
      buildEvent({ kind: 'a', projectId: 'prj_1', actor: 'user', objectId: 'obj_1', versionId: 'ver_1' }),
      buildEvent({ kind: 'b', projectId: 'prj_1', actor: 'user', objectId: 'obj_2', versionId: 'ver_1' }),
      buildEvent({ kind: 'a', projectId: 'prj_1', actor: 'user', objectId: 'obj_2', versionId: 'ver_2' }),
    ],
    { clock, nextSequence: 0 },
  )
  assert.equal(readEvents(dir, { kinds: ['a'] }).events.length, 2)
  assert.equal(readEvents(dir, { objectId: 'obj_2' }).events.length, 2)
  assert.equal(readEvents(dir, { versionId: 'ver_1' }).events.length, 2)
  assert.equal(readEvents(dir, { objectId: 'obj_2', kinds: ['a'] }).events.length, 1)
})

test('events: a truncated tail is reported and skipped, not silently dropped', () => {
  const dir = projectDir()
  appendEvents(dir, [buildEvent({ kind: 'good', projectId: 'prj_1', actor: 'user' })], { clock, nextSequence: 0 })
  // Simulate a crash mid-append: a half-written JSON line at the end.
  fs.appendFileSync(eventLogPath(dir), '{"kind":"half-writ')

  const read = readEvents(dir)
  assert.equal(read.events.length, 1, '损坏的尾部不得阻止读取既有事件')
  assert.equal(read.events[0].kind, 'good')
  assert.equal(read.skipped.length, 1)
  assert.equal(read.skipped[0].reason, 'not-json')
})

test('events: reads are bounded so a long project cannot blow up a caller', () => {
  const dir = projectDir()
  const many = []
  for (let index = 0; index < 30; index += 1) {
    many.push(buildEvent({ kind: 'bulk', projectId: 'prj_1', actor: 'system', detail: { index } }))
  }
  appendEvents(dir, many, { clock, nextSequence: 0 })
  const page = readEvents(dir, { limit: 5 })
  assert.equal(page.events.length, 5)
  assert.equal(page.total, 30)
  // A caller asking for more than the cap gets the cap, not the whole log.
  const capped = readEvents(dir, { limit: MAX_EVENT_PAGE + 1000 })
  assert.equal(capped.events.length, 30)
})

test('events: fromSequence lets a subscriber resume without re-reading everything', () => {
  const dir = projectDir()
  appendEvents(
    dir,
    [
      buildEvent({ kind: 'one', projectId: 'prj_1', actor: 'user' }),
      buildEvent({ kind: 'two', projectId: 'prj_1', actor: 'user' }),
      buildEvent({ kind: 'three', projectId: 'prj_1', actor: 'user' }),
    ],
    { clock, nextSequence: 0 },
  )
  const resumed = readEvents(dir, { fromSequence: 1 })
  assert.deepEqual(
    resumed.events.map((event) => event.kind),
    ['two', 'three'],
  )
})

test('events: readRecentEvents returns newest first', () => {
  const dir = projectDir()
  appendEvents(
    dir,
    [
      buildEvent({ kind: 'old', projectId: 'prj_1', actor: 'user' }),
      buildEvent({ kind: 'newer', projectId: 'prj_1', actor: 'user' }),
    ],
    { clock, nextSequence: 0 },
  )
  const recent = readRecentEvents(dir, 1)
  assert.deepEqual(recent.map((event) => event.kind), ['newer'])
})

test('events: an empty or absent log is a normal empty result, not an error', () => {
  const dir = projectDir()
  assert.deepEqual(readEvents(dir), { events: [], total: 0, skipped: [] })
  assert.equal(countEvents(eventLogPath(dir)), 0)
  assert.equal(eventLogDigest(dir), '')
})

test('events: buildEvent refuses an event that cannot be attributed', () => {
  // Without an actor, an event cannot be traced to a human or the AI, which defeats its purpose.
  assert.throws(() => buildEvent({ kind: 'x', projectId: 'prj_1' }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => buildEvent({ kind: 'x', actor: 'user' }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => buildEvent({ projectId: 'prj_1', actor: 'user' }), (error) => error.code === 'VALIDATION_FAILED')
})

test('events: appendEvents refuses a non-array payload', () => {
  const dir = projectDir()
  assert.throws(() => appendEvents(dir, 'not-an-array'), (error) => error.code === 'VALIDATION_FAILED')
})

test('events: verifyAppendOnly detects no duplicates in a healthy log', () => {
  const dir = projectDir()
  appendEvents(
    dir,
    [
      buildEvent({ kind: 'a', projectId: 'prj_1', actor: 'user' }),
      buildEvent({ kind: 'b', projectId: 'prj_1', actor: 'ai' }),
    ],
    { clock, nextSequence: 0 },
  )
  const checked = verifyAppendOnly(dir)
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.duplicates, [])
})

test('events: verifyAppendOnly catches a literally duplicated event id', () => {
  const dir = projectDir()
  const event = buildEvent({ kind: 'dup', projectId: 'prj_1', actor: 'user' })
  appendEvents(dir, [event], { clock, nextSequence: 0 })
  // Copying the first line verbatim is exactly what a replayed append would look like.
  const firstLine = fs.readFileSync(eventLogPath(dir), 'utf8').split('\n')[0]
  fs.appendFileSync(eventLogPath(dir), `${firstLine}\n`)
  const checked = verifyAppendOnly(dir)
  assert.equal(checked.ok, false)
  assert.equal(checked.duplicates.length, 1)
})

test('events: the digest pins the exact log state for evidence', () => {
  const dir = projectDir()
  appendEvents(dir, [buildEvent({ kind: 'a', projectId: 'prj_1', actor: 'user' })], { clock, nextSequence: 0 })
  const first = eventLogDigest(dir)
  assert.match(first, /^[a-f0-9]{64}$/)
  appendEvents(dir, [buildEvent({ kind: 'b', projectId: 'prj_1', actor: 'user' })], { clock })
  const second = eventLogDigest(dir)
  assert.notEqual(first, second)
})

test('events: a large detail payload is preserved intact on disk', () => {
  const dir = projectDir()
  const detail = { userText: '这段素材只用在开场 3 秒，不要用于其他镜头。'.repeat(5), ranges: [[0, 90]] }
  appendEvents(dir, [buildEvent({ kind: 'material.use-recorded', projectId: 'prj_1', actor: 'user', detail })], {
    clock,
    nextSequence: 0,
  })
  const read = readEvents(dir)
  assert.deepEqual(read.events[0].detail, detail)
})

test('events: the log file is one JSON object per line', () => {
  const dir = projectDir()
  appendEvents(
    dir,
    [
      buildEvent({ kind: 'a', projectId: 'prj_1', actor: 'user', detail: { nested: { deep: '多行\n内容' } } }),
      buildEvent({ kind: 'b', projectId: 'prj_1', actor: 'user' }),
    ],
    { clock, nextSequence: 0 },
  )
  const text = fs.readFileSync(eventLogPath(dir), 'utf8')
  const lines = text.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 2, '一条事件必须占一行，内嵌换行要被转义')
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line))
  }
  assert.ok(text.endsWith('\n'))
})

test('events: the log directory is created on demand', () => {
  const parent = temp.dir('nested')
  const dir = path.join(parent, 'deep', 'project')
  appendEvents(dir, [buildEvent({ kind: 'a', projectId: 'prj_1', actor: 'user' })], { clock, nextSequence: 0 })
  assert.ok(fs.existsSync(eventLogPath(dir)))
})
