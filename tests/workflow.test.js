import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkflow } from '../tools/workflow.js';
import { executeOneMediaRequest } from '../tools/capabilities.js';

const shots = [{ id: 'S01', duration: 1, text: 'one' }, { id: 'S02', duration: 2, text: 'two' }];
const spec = { shots };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cyv-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'output'));
  const saved = new Map();
  const store = { get: key => saved.get(key), put: async (key, value) => saved.set(key, value) };
  const questions = [];
  const produced = [];
  let reply = true;
  let pending;
  let onQuestion;
  const requestApproval = async ({ questions: [item] }) => {
    questions.push(item);
    onQuestion?.();
    if (pending) await pending;
    return { answers: [{ id: item.id, selected: reply ? [item.intent.approve] : [] }] };
  };
  const render = async ({ spec: recipe, shotIds, outputPath }) => {
    await writeFile(join(root, outputPath), JSON.stringify({ recipe, shotIds }), { flag: 'wx' });
    produced.push({ recipe, shotIds, outputPath });
    return { duration: 3 };
  };
  const storeDependencies = { store, requestApproval, inspectPlan: () => ({ pass: true, shots }), validateSpec: value => value, render };
  const context = { agent: { session: { header: { id: 'root' } } }, callId: 'trusted-call', signal: new AbortController().signal };
  let workflow = createWorkflow(storeDependencies);
  return {
    root, saved, questions, produced, context,
    invoke: (action, args = {}, caller = context) => workflow({ root }, { ...args, action }, caller),
    reply: value => { reply = value; },
    hold: value => {
      pending = value;
      return new Promise(resolve => { onQuestion = resolve; });
    },
    restart: () => { workflow = createWorkflow(storeDependencies); },
  };
}

async function approvedPlan(f) {
  await f.invoke('creative', { direction: 'Intent and constraints' });
  await f.invoke('save_plan', { text: '# Complete plan\nAll shots and one selected for the sample.' });
  await f.invoke('approve_plan', { spec, sampleShots: ['S01'] });
}

test('requires all three Host decisions and preserves the full revised video', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('save_plan', { text: '# Early' }), /creative direction/);
  await f.invoke('creative', { direction: 'Intent and constraints' });
  await f.invoke('save_plan', { text: '# Complete plan\nTest content' });
  await assert.rejects(f.invoke('render_sample'), /plan version/);
  assert.equal(f.produced.length, 0);
  f.reply(false);
  assert.deepEqual(await f.invoke('approve_plan', { spec, sampleShots: ['S01'] }), { approved: false });
  await assert.rejects(f.invoke('render_sample'), /plan version/);
  f.reply(true);
  await f.invoke('approve_plan', { spec, sampleShots: ['S01'] });
  assert.match(f.questions.at(-1).detail, /# Complete plan/);
  assert.match(f.questions.at(-1).detail, /Production recipe/);
  const sample = await f.invoke('render_sample');
  assert.equal(sample.needsSampleApproval, true);
  assert.deepEqual(f.produced[0].shotIds, ['S01']);
  await assert.rejects(f.invoke('render_full'), /accept the current sample/);
  await f.invoke('approve_sample');
  f.restart();
  const full = await f.invoke('render_full');
  const revision = await f.invoke('revise_full', { feedback: 'Edit the second title', changes: [{ id: 'S02', text: 'updated' }] });
  assert.notEqual(revision.path, full.path);
  assert.deepEqual(f.produced.at(-1).recipe.shots, [shots[0], { ...shots[1], text: 'updated' }]);
  assert.equal(f.produced.at(-1).shotIds, undefined);
});

test('a different plan version and a changed sample require their own judgment', async t => {
  const f = await fixture(t);
  await approvedPlan(f);
  const sample = await f.invoke('render_sample');
  await f.invoke('approve_sample');
  await writeFile(join(f.root, sample.path), 'different bytes');
  await assert.rejects(f.invoke('render_full'), /intact rendered sample/);
  await f.invoke('save_plan', { text: '# A different plan' });
  assert.equal((await f.invoke('status')).plan.stale, true);
  await assert.rejects(f.invoke('render_sample'), /needs user approval/);
  assert.equal(f.produced.length, 1);
});

test('membership and simultaneous operations are checked before rendering', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('creative', { direction: 'Other' }, {
    ...f.context, agent: { session: { header: { id: 'child', origin: 'subagent' } } },
  }), /live root/);
  await f.invoke('creative', { direction: 'Intent and constraints' });
  await f.invoke('save_plan', { text: '# Complete plan' });
  await assert.rejects(f.invoke('approve_plan', { spec: { shots: shots.slice(1) }, sampleShots: ['S02'] }), /every planned shot/);
  await assert.rejects(f.invoke('approve_plan', { spec, sampleShots: ['S03'] }), /unplanned/);
  let finish;
  const asked = f.hold(new Promise(resolve => { finish = resolve; }));
  const approval = assert.rejects(f.invoke('approve_plan', { spec, sampleShots: ['S01'] }), /plan.md changed/);
  await asked;
  await assert.rejects(f.invoke('status'), /another video operation/i);
  await writeFile(join(f.root, 'plan.md'), '# Externally changed');
  finish();
  await approval;
});

test('media dispatch enforces model identity and cost before calling the adapter', async () => {
  let calls = 0;
  const provider = { id: 'fixture', models: [{ id: 'model' }], estimate: () => 4, generate: () => ++calls };
  const request = { operationId: 'op', provider: 'fixture', model: 'model', currency: 'CNY', costLimit: 3 };
  await assert.rejects(executeOneMediaRequest({ providers: [provider], request }), /approval/);
  await assert.rejects(executeOneMediaRequest({ providers: [provider], request, approved: request }), /over budget/);
  assert.equal(calls, 0);
  const affordable = { ...request, costLimit: 5 };
  assert.equal(await executeOneMediaRequest({ providers: [provider], request: affordable, approved: affordable }), 1);
  await assert.rejects(executeOneMediaRequest({ providers: [provider], request: affordable, approved: affordable }), /approval/);
  assert.equal(calls, 1);
});
