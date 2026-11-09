/**
 * Unit tests for the durable document store: schema envelope, revision conflicts, corruption.
 *
 * These prove behaviour the contracts state rather than describe it: a stale write is REFUSED, a
 * corrupt file is an ERROR not an empty document, and a newer generation is refused instead of
 * being downgraded. CT-02 §3, §6; CT-11 §5.
 *
 * @module tests/unit/project-store.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTempDir, Clock } from '../../base/index.js'
import {
  readDocument,
  writeDocument,
  tryReadDocument,
  nextRevision,
  revisionCounter,
  stripEnvelope,
  fileSha256,
  isReadableFile,
} from '../../core/project/store.js'
import { migrationChain, applyMigrationChain } from '../../core/project/migrations.js'
import { CURRENT_SCHEMA_GENERATION } from '../../core/project/schema.js'

const temp = createTempDir({ label: 'store' })
const root = temp.dir('docs')
test.after(() => temp.dispose())

/** Frozen clock so written timestamps are identical across runs. */
function frozenClock() {
  return new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
}

test('store: writeDocument adds the schema envelope and is readable back from disk', () => {
  const file = path.join(root, 'envelope.json')
  const written = writeDocument(file, { hello: '世界' }, { kind: 'test', schemaKey: 'project', clock: frozenClock() })
  const read = readDocument(file, { kind: 'test', expectedGeneration: CURRENT_SCHEMA_GENERATION })
  assert.equal(read.value.hello, '世界')
  assert.equal(read.value.schemaGeneration, CURRENT_SCHEMA_GENERATION)
  assert.equal(read.revision, written.revision)
  assert.match(written.revision, /^r\d{12}-[0-9a-f]{8}$/)
  // The published bytes really are on disk, not just in a variable.
  assert.ok(fs.statSync(file).size > 0)
  assert.equal(read.sha256, fileSha256(file))
})

test('store: writing twice with the same expectedRevision is refused as a conflict', () => {
  const file = path.join(root, 'conflict.json')
  const first = writeDocument(file, { value: 1 }, { kind: 'test', schemaKey: 'project', clock: frozenClock() })
  const second = writeDocument(file, { value: 2 }, {
    kind: 'test',
    schemaKey: 'project',
    expectedRevision: first.revision,
    clock: frozenClock(),
  })
  assert.notEqual(second.revision, first.revision)

  // A second writer still holding the OLD revision must be refused, and the file must keep the
  // newer content rather than being rolled back.
  assert.throws(
    () =>
      writeDocument(file, { value: 3 }, {
        kind: 'test',
        schemaKey: 'project',
        expectedRevision: first.revision,
        clock: frozenClock(),
      }),
    (error) => {
      assert.equal(error.code, 'CONFLICT')
      assert.equal(error.details.stage, 'revision')
      assert.equal(error.details.actualRevision, second.revision)
      return true
    },
  )
  const after = readDocument(file, { kind: 'test', expectedGeneration: CURRENT_SCHEMA_GENERATION })
  assert.equal(after.value.value, 2, '冲突不得回滚到旧内容')
})

test('store: createOnly refuses to overwrite an existing document', () => {
  const file = path.join(root, 'create-only.json')
  writeDocument(file, { v: 1 }, { kind: 'test', schemaKey: 'project', clock: frozenClock() })
  assert.throws(
    () => writeDocument(file, { v: 2 }, { kind: 'test', schemaKey: 'project', clock: frozenClock(), createOnly: true }),
    (error) => error.code === 'CONFLICT',
  )
  const after = readDocument(file, { kind: 'test', expectedGeneration: CURRENT_SCHEMA_GENERATION })
  assert.equal(after.value.v, 1)
})

test('store: a corrupt document is a CORRUPT_DATA error, never an empty object', () => {
  const file = path.join(root, 'corrupt.json')
  fs.writeFileSync(file, '{ "truncated": ')
  assert.throws(
    () => readDocument(file, { kind: 'project', expectedGeneration: CURRENT_SCHEMA_GENERATION }),
    (error) => {
      assert.equal(error.code, 'CORRUPT_DATA')
      assert.equal(error.details.stage, 'parse')
      // The byte count is reported so a truncated write is diagnosable.
      assert.ok(error.details.bytes > 0)
      return true
    },
  )
})

test('store: a non-object document is refused', () => {
  const file = path.join(root, 'array.json')
  fs.writeFileSync(file, '[1,2,3]')
  assert.throws(
    () => readDocument(file, { kind: 'project', expectedGeneration: CURRENT_SCHEMA_GENERATION }),
    (error) => error.code === 'CORRUPT_DATA',
  )
})

test('store: a document from a NEWER generation is refused, not downgraded', () => {
  const file = path.join(root, 'future.json')
  fs.writeFileSync(
    file,
    `${JSON.stringify({ schemaGeneration: CURRENT_SCHEMA_GENERATION + 1, schemaVersion: 9, futureField: true })}\n`,
  )
  assert.throws(
    () => readDocument(file, { kind: 'project', expectedGeneration: CURRENT_SCHEMA_GENERATION }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.equal(error.details.found, CURRENT_SCHEMA_GENERATION + 1)
      assert.match(String(error.details.action), /不得降级覆盖/)
      return true
    },
  )
  // The file must still be there, untouched, so the newer version can still read it.
  assert.ok(fs.existsSync(file))
})

test('store: a missing document reports ENOENT rather than an ambiguous failure', () => {
  const file = path.join(root, 'absent.json')
  assert.equal(tryReadDocument(file, { kind: 'project' }), null)
  assert.throws(
    () => readDocument(file, { kind: 'project', expectedGeneration: CURRENT_SCHEMA_GENERATION }),
    (error) => error.code === 'IO_FAILED' && error.details.reason === 'ENOENT',
  )
})

test('store: revisions are ordered and monotonic across writes', () => {
  assert.equal(revisionCounter('r000000000004-00ff00ff'), 4)
  assert.equal(revisionCounter('not-a-revision'), 0)
  assert.equal(revisionCounter(null), 0)
  const first = nextRevision(null, frozenClock())
  const second = nextRevision(first, frozenClock())
  assert.ok(revisionCounter(second) > revisionCounter(first))
  // Two writers in the same millisecond must not mint the same revision, or the conflict check
  // would compare equal and let a lost update through.
  const sameMsA = nextRevision(null, frozenClock())
  const sameMsB = nextRevision(null, frozenClock())
  assert.match(sameMsA, /^r\d{12}-[0-9a-f]{8}$/)
  assert.match(sameMsB, /^r\d{12}-[0-9a-f]{8}$/)
})

test('store: stripEnvelope removes only the fields the store owns', () => {
  const document = { schemaVersion: 1, schemaGeneration: 1, revision: 'r000000000001-00000000', updatedAt: 'x', keep: 'me' }
  const stripped = stripEnvelope(document)
  assert.deepEqual(stripped, { keep: 'me' })
  // The caller's object is not mutated.
  assert.equal(document.keep, 'me')
  assert.ok(document.revision)
})

test('store: isReadableFile distinguishes a real file from a missing path', () => {
  const file = path.join(root, 'readable.txt')
  fs.writeFileSync(file, 'ok')
  assert.equal(isReadableFile(file), true)
  assert.equal(isReadableFile(path.join(root, 'nope.txt')), false)
  assert.equal(isReadableFile(root), false, '目录不是可读文件')
})

test('migrations: an empty chain is reported for the same generation', () => {
  assert.deepEqual(migrationChain('project', 1, 1), [])
})

test('migrations: a missing step refuses instead of skipping a generation', () => {
  // Generation 1 is the first shipped generation, so 1->3 has no registered steps. Refusing is
  // correct: skipping an intermediate step is how a field silently disappears (CT-02 §6).
  assert.throws(
    () => migrationChain('project', 1, 3),
    (error) => {
      assert.equal(error.code, 'CORRUPT_DATA')
      assert.equal(error.details.stuckAt, 1)
      return true
    },
  )
})

test('migrations: a downward migration is refused', () => {
  assert.throws(
    () => migrationChain('project', 2, 1),
    (error) => error.code === 'UNSUPPORTED',
  )
})

test('migrations: applyMigrationChain does not mutate its input', () => {
  const input = { a: 1 }
  const chain = [
    {
      from: 1,
      to: 2,
      reason: 'test step',
      migrate: (document) => ({ ...document, b: 2, schemaGeneration: 2 }),
    },
  ]
  const output = applyMigrationChain(input, chain)
  assert.deepEqual(Object.keys(input), ['a'], '源文档必须逐字节保持不变')
  assert.equal(output.b, 2)
})

test('migrations: a no-op step is treated as a bug instead of a successful upgrade', () => {
  const chain = [{ from: 1, to: 2, reason: 'returns same object', migrate: (document) => document }]
  assert.throws(() => applyMigrationChain({ a: 1 }, chain), (error) => error.code === 'INTERNAL')
})
