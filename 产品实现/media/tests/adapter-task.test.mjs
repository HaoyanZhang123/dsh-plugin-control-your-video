/**
 * Render task lifecycle: real positions, honest unknown state, no double execution.
 * @module media/tests/adapter-task
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTaskStore, defineAdapter, ADAPTER_INTERFACE_VERSION, NO_AUTO_RETRY_STATES } from '../render/adapter.js'
import { frozenClock, makeTempDir, cleanup } from './helpers.mjs'

const store = () => {
  const dir = makeTempDir('c12-tasks-')
  return { dir, tasks: createTaskStore({ workRoot: dir, clock: frozenClock() }) }
}

test('a task starts queued, runs, records progress and completes', () => {
  const { dir, tasks } = store()
  try {
    const task = tasks.create({ id: 'task-1', adapterId: 'ffmpeg-adapter', tier: 'final', planFingerprint: 'abc', totalFrames: 270 })
    assert.equal(task.state, 'queued')
    task.begin()
    task.progress({ framesDone: 100, phase: 'encode' })
    assert.equal(task.snapshot().framesDone, 100)
    task.complete({ file: 'out.mp4' })
    const snapshot = task.snapshot()
    assert.equal(snapshot.state, 'completed')
    assert.equal(snapshot.framesDone, 270)
    assert.ok(snapshot.stateHistory.length >= 3)
    assert.ok(fs.existsSync(path.join(dir, 'tasks', 'task-1.json')), '任务记录必须落盘')
  } finally {
    cleanup(dir)
  }
})

test('progress cannot exceed the plan and cannot be written by a stopped task', () => {
  const { dir, tasks } = store()
  try {
    const task = tasks.create({ id: 'task-2', adapterId: 'ffmpeg-adapter', tier: 'final', planFingerprint: 'abc', totalFrames: 100 })
    task.begin()
    task.progress({ framesDone: 500 })
    assert.equal(task.snapshot().framesDone, 100)
    task.pause({ lastFrame: 40, partialOutputPath: '/tmp/x.mp4' })
    assert.throws(() => task.progress({ framesDone: 50 }), /只有运行中的任务/)
  } finally {
    cleanup(dir)
  }
})

test('pausing keeps the real position and never claims it can resume from that frame', () => {
  const { dir, tasks } = store()
  try {
    const task = tasks.create({ id: 'task-3', adapterId: 'ffmpeg-adapter', tier: 'final', planFingerprint: 'abc', totalFrames: 270 })
    task.begin()
    task.pause({ lastFrame: 137, tempDir: 'run-temp' })
    const snapshot = task.snapshot()
    assert.equal(snapshot.state, 'paused')
    assert.equal(snapshot.savedWork.lastFrame, 137)
    assert.match(snapshot.savedWork.note, /不承诺/)
    task.resume({ userAction: '用户确认继续' })
    assert.equal(task.snapshot().state, 'running')
  } finally {
    cleanup(dir)
  }
})

test('an unknown state refuses to continue without an explicit user acknowledgement', () => {
  const { dir, tasks } = store()
  try {
    const task = tasks.create({ id: 'task-4', adapterId: 'ffmpeg-adapter', tier: 'final', planFingerprint: 'abc' })
    task.begin()
    task.markUnknown('进程被杀，输出是否完整未知')
    assert.throws(() => task.resume({}), /用户确认/)
    assert.throws(() => task.resume({ acknowledgeUnknown: true }), /用户确认/)
    task.resume({ acknowledgeUnknown: true, userAction: '用户检查后确认继续' })
    assert.equal(task.snapshot().state, 'running')
    assert.ok(NO_AUTO_RETRY_STATES.includes('unknown'))
  } finally {
    cleanup(dir)
  }
})

test('a finished task cannot be cancelled twice, and a failure keeps its cause', () => {
  const { dir, tasks } = store()
  try {
    const completed = tasks.create({ id: 'task-5', adapterId: 'ffmpeg-adapter', tier: 'final', planFingerprint: 'abc' })
    completed.begin()
    completed.complete({})
    assert.throws(() => completed.cancel(), /已结束/)
    const failed = tasks.create({ id: 'task-6', adapterId: 'ffmpeg-adapter', tier: 'final', planFingerprint: 'def' })
    failed.begin()
    failed.fail({ message: 'FFmpeg 退出码 1', code: 'FFMPEG_FAILED' })
    assert.equal(failed.snapshot().state, 'failed')
    assert.equal(failed.snapshot().failure.code, 'FFMPEG_FAILED')
  } finally {
    cleanup(dir)
  }
})

test('the same plan and tier cannot run twice at once', () => {
  const { dir, tasks } = store()
  try {
    const task = tasks.create({ id: 'task-7', adapterId: 'ffmpeg-adapter', tier: 'final', planFingerprint: 'same' })
    task.begin()
    assert.throws(
      () => tasks.assertNotRunning({ adapterId: 'ffmpeg-adapter', tier: 'final', planFingerprint: 'same' }),
      /已经在进行/,
    )
    assert.doesNotThrow(() => tasks.assertNotRunning({ adapterId: 'ffmpeg-adapter', tier: 'preview', planFingerprint: 'same' }))
  } finally {
    cleanup(dir)
  }
})

test('an adapter missing a required method cannot register', () => {
  assert.throws(
    () => defineAdapter({ id: 'x', version: '1', capabilities: () => ({ interfaceVersion: ADAPTER_INTERFACE_VERSION }) }),
    /缺少必需方法/,
  )
})
