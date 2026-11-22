import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkflow, digestText } from '../tools/workflow.js';
import { executeOneMediaRequest } from '../tools/capabilities.js';

const canvas = { width: 640, height: 360, fps: 24 };
const shots = [{ id: 'S01', duration: 1, text: 'one' }, { id: 'S02', duration: 2, text: 'two' }];
const spec = { canvas, shots };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cyv-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'output'));
  await mkdir(join(root, 'work'));
  const saved = new Map();
  const store = { get: key => saved.get(key), put: async (key, value) => { saved.set(key, value); } };
  const questions = [];
  const produced = [];
  const externalCalls = [];
  let reply = true;
  let pending;
  let onQuestion;
  let externalDuration = null;
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
  const registerExternal = async ({ projectRoot, sourcePath, outputPath, expectation }) => {
    externalCalls.push({ sourcePath, outputPath, expectation });
    const bytes = await readFile(join(projectRoot, sourcePath));
    const artifact = { durationSec: externalDuration ?? expectation.durationSec,
      verified: { container: 'mp4', videoCodec: 'h264' },
      sha256: createHash('sha256').update(bytes).digest('hex') };
    try {
      await writeFile(join(projectRoot, outputPath), bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw Object.assign(new Error('Output exists; refusing to replace it.'), {
          code: 'E_OUTPUT_EXISTS', details: { artifact },
        });
      }
      throw error;
    }
    return artifact;
  };
  const planShots = { current: shots };
  const storeDependencies = { store, requestApproval, registerExternal,
    inspectPlan: () => ({ pass: true, shots: planShots.current }), validateSpec: value => value, render };
  const context = { agent: { session: { header: { id: 'root' } } }, callId: 'trusted-call', signal: new AbortController().signal };
  let workflow = createWorkflow(storeDependencies);
  const projectKey = () => digestText(process.platform === 'win32' ? root.toLowerCase() : root);
  return {
    root, saved, questions, produced, externalCalls, context, planShots, projectKey,
    invoke: (action, args = {}, caller = context) => workflow({ root }, { ...args, action }, caller),
    reply: value => { reply = value; },
    hold: value => {
      pending = value;
      return new Promise(resolve => { onQuestion = resolve; });
    },
    setExternalDuration: value => { externalDuration = value; },
    restart: () => { workflow = createWorkflow(storeDependencies); },
  };
}

async function approvedPlan(f) {
  await f.invoke('creative', { direction: 'Intent and constraints' });
  await f.invoke('save_plan', { text: '# Complete plan\nAll shots and one selected for the sample.' });
  await f.invoke('approve_plan', { spec, sampleShots: ['S01'] });
}

const externalRoute = {
  engine: '本地 HTML 动画 + 编码工程',
  inputs: ['assets/source.txt'],
  canvas: { width: 1280, height: 720, fps: 30 },
  audio: 'required',
};

async function externalPlan(f) {
  await f.invoke('creative', { direction: 'Intent and constraints' });
  await f.invoke('save_plan', { text: '# Complete plan\nExternal route, all shots.' });
  await f.invoke('approve_plan', { external: externalRoute, sampleShots: ['S01'], sampleMaxSeconds: 0.5 });
}

async function writeSource(f, name, bytes) {
  const target = join(f.root, name);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, bytes);
  return name;
}

test('requires all three Host decisions and preserves the full revised video', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('save_plan', { text: '# Early' }), /creative direction/);
  await f.invoke('creative', { direction: 'Intent and constraints' });
  await f.invoke('save_plan', { text: '# Complete plan\nTest content' });
  await assert.rejects(f.invoke('render_sample'), /还没有批准过这份方案/);
  assert.equal(f.produced.length, 0);
  f.reply(false);
  assert.deepEqual(await f.invoke('approve_plan', { spec, sampleShots: ['S01'] }), { approved: false });
  await assert.rejects(f.invoke('render_sample'), /还没有批准过这份方案/);
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
  // The earlier complete version stays on disk; nothing overwrites it.
  assert.ok(await readFile(join(f.root, full.path)));
  assert.ok(await readFile(join(f.root, revision.path)));
});

test('same shot IDs and durations with a changed plan body must be approved again', async t => {
  const f = await fixture(t);
  await approvedPlan(f);
  await f.invoke('render_sample');
  await f.invoke('approve_sample');
  const asked = f.questions.length;
  // Same shots, same durations, different creative content and execution text.
  await f.invoke('save_plan', { text: '# Complete plan\nAll shots, but the second shot now means something else.' });
  const before = await f.invoke('status');
  assert.equal(before.plan.stale, true);
  assert.equal(before.plan.state, 'stale');
  assert.match(before.plan.reason, /plan\.md 在批准后被改动/);
  assert.equal(before.sample.state, 'blocked');
  await assert.rejects(f.invoke('render_sample'), /plan\.md 在批准后被改动/);
  await assert.rejects(f.invoke('render_full'), /plan\.md 在批准后被改动/);
  // The approval is not silently inherited from the matching shot table: the user is asked.
  const approving = await f.invoke('approve_plan', { spec, sampleShots: ['S01'] });
  assert.equal(f.questions.length, asked + 1);
  assert.equal(approving.needsUser, true);
  assert.equal(approving.approved, true);
  const after = await f.invoke('status');
  assert.equal(after.plan.state, 'approved');
  assert.equal(after.sample.state, 'outdated');
  assert.match(after.sample.reason, /较早批准的制作范围/);
});

test('rewriting the same plan text and re-approving the same scope are idempotent', async t => {
  const f = await fixture(t);
  await f.invoke('creative', { direction: 'Intent and constraints' });
  const written = await f.invoke('save_plan', { text: '# Complete plan\nStable body.' });
  const again = await f.invoke('save_plan', { text: '# Complete plan\nStable body.' });
  assert.equal(again.digest, written.digest);
  assert.equal(again.unchanged, true);
  const first = await f.invoke('approve_plan', { spec, sampleShots: ['S01'] });
  assert.equal(first.approved, true);
  const asked = f.questions.length;
  const second = await f.invoke('approve_plan', { spec, sampleShots: ['S01'] });
  assert.equal(second.reused, true);
  assert.equal(second.needsUser, false);
  assert.equal(f.questions.length, asked);
  await f.invoke('render_sample');
  await f.invoke('approve_sample');
  const accepted = f.questions.length;
  assert.equal((await f.invoke('approve_sample')).reused, true);
  assert.equal(f.questions.length, accepted);
  // Restating the same recipe with properties in a different order is not a new decision.
  const reordered = { shots: shots.map(shot => ({ text: shot.text, duration: shot.duration, id: shot.id })), canvas };
  const reasked = f.questions.length;
  const same = await f.invoke('approve_plan', { spec: reordered, sampleShots: ['S01'] });
  assert.equal(same.reused, true);
  assert.equal(same.needsUser, false);
  assert.equal(f.questions.length, reasked);
});

test('tampered samples and mismatched artifacts block production', async t => {
  const f = await fixture(t);
  await approvedPlan(f);
  const sample = await f.invoke('render_sample');
  assert.equal((await f.invoke('status')).sample.state, 'ready');
  await writeFile(join(f.root, sample.path), 'different bytes');
  const tampered = await f.invoke('status');
  assert.equal(tampered.sample.state, 'tampered');
  assert.match(tampered.sample.reason, /样片文件在登记后被改动/);
  await assert.rejects(f.invoke('approve_sample'), /样片文件在登记后被改动/);
  await assert.rejects(f.invoke('render_full'), /样片文件在登记后被改动/);
});

test('re-approving the same plan text with a new recipe or sample selection retires the old sample and recipe', async t => {
  const f = await fixture(t);
  await approvedPlan(f);
  await f.invoke('render_sample');
  await f.invoke('approve_sample');
  const firstFull = await f.invoke('render_full');
  assert.deepEqual(f.produced.at(-1).recipe.shots, shots);

  // Same plan.md text, same shot IDs and durations — only the recipe changed.
  const recipeB = { canvas, shots: [shots[0], { ...shots[1], text: 'rewritten look' }] };
  const asked = f.questions.length;
  const reapproved = await f.invoke('approve_plan', { spec: recipeB, sampleShots: ['S01'] });
  assert.equal(f.questions.length, asked + 1);
  assert.equal(reapproved.needsUser, true);
  const afterRecipe = await f.invoke('status');
  assert.equal(afterRecipe.plan.state, 'approved');
  assert.equal(afterRecipe.sample.state, 'outdated');
  assert.equal(afterRecipe.fullState, 'outdated');
  await assert.rejects(f.invoke('render_full'), /样片/);
  assert.ok(await readFile(join(f.root, firstFull.path)));

  // The new full render starts from the new sample's recipe, never from the earlier spec.
  await f.invoke('render_sample');
  assert.deepEqual(f.produced.at(-1).recipe.shots, recipeB.shots);
  await f.invoke('approve_sample');
  await f.invoke('render_full');
  assert.deepEqual(f.produced.at(-1).recipe.shots, recipeB.shots);

  // Same text again, only the sample selection changed.
  const beforeSelection = f.questions.length;
  await f.invoke('approve_plan', { spec: recipeB, sampleShots: ['S02'] });
  assert.equal(f.questions.length, beforeSelection + 1);
  const afterSelection = await f.invoke('status');
  assert.equal(afterSelection.sample.state, 'outdated');
  await assert.rejects(f.invoke('render_full'), /样片/);
  await f.invoke('render_sample');
  assert.deepEqual(f.produced.at(-1).shotIds, ['S02']);

  // Switching the same plan to a self-chosen route also retires the built-in sample.
  await mkdir(join(f.root, 'assets'));
  await writeSource(f, 'assets/source.txt', 'dependency');
  await f.invoke('approve_plan', { external: externalRoute, sampleShots: ['S01'], sampleMaxSeconds: 0.5 });
  const afterRoute = await f.invoke('status');
  assert.equal(afterRoute.plan.route, 'external');
  assert.equal(afterRoute.sample.state, 'outdated');
  await assert.rejects(f.invoke('render_full'), /prepare_run/);
});

test('an interrupted publication can be resumed without overwriting anything', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'assets'));
  await writeSource(f, 'assets/source.txt', 'pinned dependency');
  await externalPlan(f);
  const sampleRun = await f.invoke('prepare_run', { stage: 'sample' });
  await writeSource(f, 'work/sample.mp4', 'sample bytes');
  // Simulate a crash after the helper published the file but before the run was recorded.
  await writeFile(join(f.root, sampleRun.outputPath), 'sample bytes', { flag: 'wx' });
  const adopted = await f.invoke('register_artifact', { runId: sampleRun.runId, source: 'work/sample.mp4' });
  assert.equal(adopted.digest, digestText('sample bytes'));
  assert.equal(adopted.path, sampleRun.outputPath);
  assert.deepEqual(adopted.verified, { container: 'mp4', videoCodec: 'h264' });
  assert.equal((await f.invoke('status')).sample.state, 'ready');
  // A different file already sitting at the target is never replaced.
  await f.invoke('approve_sample');
  const fullRun = await f.invoke('prepare_run', { stage: 'full' });
  await writeFile(join(f.root, fullRun.outputPath), 'someone else', { flag: 'wx' });
  await writeSource(f, 'work/full.mp4', 'my full bytes');
  await assert.rejects(f.invoke('register_artifact', { runId: fullRun.runId, source: 'work/full.mp4' }),
    /登记目标已存在且不是这次候选原件/);
  assert.equal(await readFile(join(f.root, fullRun.outputPath), 'utf8'), 'someone else');
  await assert.rejects(f.invoke('register_artifact', { runId: fullRun.runId, source: 'work/full.mp4' }), /已被替代/);
});

test('a newly accepted sample under the same approval never reuses the earlier complete recipe', async t => {
  const f = await fixture(t);
  await approvedPlan(f);
  await f.invoke('render_sample');
  await f.invoke('approve_sample');
  await f.invoke('render_full');
  // A local subtitle-style correction to the sample recipe, then a fresh sample is accepted.
  await f.invoke('render_sample', { feedback: 'Fix the first caption', changes: [{ id: 'S01', text: 'revised caption' }] });
  const revised = f.produced.at(-1).recipe;
  assert.equal(revised.shots[0].text, 'revised caption');
  // The earlier complete version no longer matches the accepted sample.
  assert.equal((await f.invoke('status')).fullState, 'outdated');
  await f.invoke('approve_sample');
  const full = await f.invoke('render_full');
  assert.equal(f.produced.at(-1).recipe.shots[0].text, 'revised caption');
  assert.notEqual(full.path, f.produced.at(-2).outputPath);
});

test('external route runs sample, full and revision through prepared runs', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'assets'));
  await writeSource(f, 'assets/source.txt', 'pinned dependency');
  await externalPlan(f);
  assert.match(f.questions.at(-1).detail, /自选本机/);
  assert.match(f.questions.at(-1).detail, /assets\/source\.txt/);
  // The built-in recipe actions refuse to quietly replace the approved route.
  await assert.rejects(f.invoke('render_sample'), /prepare_run/);

  const sampleRun = await f.invoke('prepare_run', { stage: 'sample' });
  assert.equal(sampleRun.stage, 'sample');
  assert.deepEqual(sampleRun.expectation, { width: 1280, height: 720, fps: 30, durationSec: 0.5, audio: 'required' });
  assert.match(sampleRun.outputPath, /^output\/sample-[0-9a-f-]{36}\.mp4$/);
  assert.deepEqual(sampleRun.shots, [{ id: 'S01', durationSec: 1 }]);
  const repeated = await f.invoke('prepare_run', { stage: 'sample' });
  assert.equal(repeated.runId, sampleRun.runId);
  assert.equal(repeated.reused, true);
  assert.equal((await f.invoke('status')).run.runId, sampleRun.runId);
  await assert.rejects(f.invoke('prepare_run', { stage: 'full' }), /样片/);
  await writeSource(f, 'work/sample-a.mp4', 'external sample bytes');
  const registered = await f.invoke('register_artifact', { runId: sampleRun.runId, source: 'work/sample-a.mp4' });
  assert.equal(registered.needsSampleApproval, true);
  assert.equal(registered.digest, digestText('external sample bytes'));
  assert.ok(await readFile(join(f.root, registered.path)));
  assert.equal(f.externalCalls.at(-1).sourcePath, 'work/sample-a.mp4');
  const repeatedRegister = await f.invoke('register_artifact', { runId: sampleRun.runId, source: 'work/sample-a.mp4' });
  assert.equal(repeatedRegister.reused, true);
  assert.equal(f.externalCalls.length, 1);
  await writeSource(f, 'work/sample-b.mp4', 'a different file');
  await assert.rejects(f.invoke('register_artifact', { runId: sampleRun.runId, source: 'work/sample-b.mp4' }),
    /另一份成片/);

  await f.invoke('approve_sample');
  const fullRun = await f.invoke('prepare_run', { stage: 'full' });
  assert.deepEqual(fullRun.expectation, { width: 1280, height: 720, fps: 30, durationSec: 3, audio: 'required' });
  assert.match(fullRun.outputPath, /^output\/video-[0-9a-f-]{36}\.mp4$/);
  await writeSource(f, 'work/full-a.mp4', 'external full bytes');
  const full = await f.invoke('register_artifact', { runId: fullRun.runId, source: 'work/full-a.mp4' });
  assert.equal((await f.invoke('status')).fullState, 'current');
  assert.ok(await readFile(join(f.root, full.path)));
  // A second full version is a new file; the earlier one is preserved.
  const fullRun2 = await f.invoke('prepare_run', { stage: 'full' });
  assert.notEqual(fullRun2.runId, fullRun.runId);
  await writeSource(f, 'work/full-b.mp4', 'newer external full bytes');
  const full2 = await f.invoke('register_artifact', { runId: fullRun2.runId, source: 'work/full-b.mp4' });
  assert.notEqual(full2.path, full.path);
  assert.ok(await readFile(join(f.root, full.path)));

  await assert.rejects(f.invoke('prepare_run', { stage: 'revision' }), /feedback/);
  const revisionRun = await f.invoke('prepare_run', { stage: 'revision', feedback: 'Shorten the second title' });
  assert.equal(revisionRun.stage, 'revision');
  assert.equal((await f.invoke('prepare_run', { stage: 'revision', feedback: 'Shorten the second title' })).runId,
    revisionRun.runId);
  // Different revision feedback is a different intent: it gets its own run.
  const otherRevision = await f.invoke('prepare_run', { stage: 'revision', feedback: 'Change the first title' });
  assert.notEqual(otherRevision.runId, revisionRun.runId);
  await writeSource(f, 'work/revision.mp4', 'revised external full bytes');
  await assert.rejects(f.invoke('register_artifact', { runId: revisionRun.runId, source: 'work/revision.mp4' }),
    /已被替代/);
  const revision = await f.invoke('register_artifact', { runId: otherRevision.runId, source: 'work/revision.mp4' });
  assert.notEqual(revision.path, full2.path);
  assert.ok(await readFile(join(f.root, full2.path)));
});

test('prepared runs detect replacement, plan changes and registration mismatches', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'assets'));
  await writeSource(f, 'assets/source.txt', 'pinned dependency');
  await externalPlan(f);
  const sampleRun = await f.invoke('prepare_run', { stage: 'sample' });
  await writeSource(f, 'work/sample.mp4', 'sample bytes');
  await f.invoke('register_artifact', { runId: sampleRun.runId, source: 'work/sample.mp4' });
  await f.invoke('approve_sample');
  const fullRun = await f.invoke('prepare_run', { stage: 'full' });
  await assert.rejects(f.invoke('prepare_run', { stage: 'revision', feedback: 'unused yet' }), /完整成片/);
  await writeSource(f, 'work/full.mp4', 'full bytes');
  await f.setExternalDuration(9);
  await assert.rejects(f.invoke('register_artifact', { runId: fullRun.runId, source: 'work/full.mp4' }),
    /时长与这个阶段按镜头推导的期望相差过大/);
  f.setExternalDuration(null);
  // A rejected registration settles its run, so the same stage is prepared again as a new run.
  const fullRunAgain = await f.invoke('prepare_run', { stage: 'full' });
  assert.notEqual(fullRunAgain.runId, fullRun.runId);
  await assert.rejects(f.invoke('register_artifact', { runId: fullRun.runId, source: 'work/full.mp4' }), /已被替代/);
  await writeSource(f, 'assets/source.txt', 'changed dependency');
  await assert.rejects(f.invoke('register_artifact', { runId: fullRunAgain.runId, source: 'work/full.mp4' }),
    /批准时固定的项目输入在批准后被改动/);
  await writeSource(f, 'assets/source.txt', 'pinned dependency');
  await assert.rejects(f.invoke('register_artifact', { runId: 'no-such-run', source: 'work/full.mp4' }), /没有这个制作任务/);
  await assert.rejects(f.invoke('register_artifact', { runId: fullRunAgain.runId, source: '../outside.mp4' }),
    /project-relative|outside/);
  // A changed approved scope replaces the run even if the same stage is retried.
  await f.invoke('save_plan', { text: '# Complete plan\nExternal route, re-approved body.' });
  await f.invoke('approve_plan', { external: externalRoute, sampleShots: ['S01'], sampleMaxSeconds: 0.5 });
  await assert.rejects(f.invoke('register_artifact', { runId: fullRunAgain.runId, source: 'work/full.mp4' }),
    /plan\.md 在批准后被改动|不同的批准范围/);
});

test('legacy rc.4 receipts stay readable but need one explicit review', async t => {
  const f = await fixture(t);
  await f.invoke('creative', { direction: 'Intent and constraints' });
  const plan = await f.invoke('save_plan', { text: '# Complete plan\nLegacy body.' });
  const creative = f.saved.values().next().value.creative;
  const legacy = {
    creative,
    plan: {
      digest: plan.digest,
      creativeDigest: creative.digest,
      creativeCore: [['S01', 1], ['S02', 2]],
      creativeCoreDigest: digestText(JSON.stringify([['S01', 1], ['S02', 2]])),
      spec, sampleShots: ['S01'], sampleMaxSeconds: null, assets: [],
      receipt: { sessionId: 'root', callId: 'old-call', questionId: 'old-question' },
    },
    sample: null, acceptedSample: null, full: null,
  };
  f.saved.set(f.projectKey(), legacy);
  const frozen = JSON.stringify(legacy);
  const status = await f.invoke('status');
  assert.equal(status.plan.state, 'legacy');
  assert.equal(status.plan.needsReview, true);
  assert.match(status.plan.reason, /旧版本记录/);
  await f.invoke('read_plan');
  await f.invoke('check_plan');
  assert.equal(JSON.stringify(f.saved.get(f.projectKey())), frozen);
  await assert.rejects(f.invoke('render_sample'), /旧版本记录/);
  await assert.rejects(f.invoke('prepare_run', { stage: 'sample' }), /旧版本记录/);

  // A declined review is recorded, and a later change of mind can still approve the same version.
  f.reply(false);
  const asked = f.questions.length;
  assert.deepEqual(await f.invoke('approve_plan', { spec, sampleShots: ['S01'] }), { approved: false });
  assert.equal(f.questions.length, asked + 1);
  assert.equal((await f.invoke('status')).plan.state, 'legacy');
  f.reply(true);
  const rechecked = await f.invoke('approve_plan', { spec, sampleShots: ['S01'] });
  assert.equal(rechecked.recheckedLegacy, true);
  assert.equal(rechecked.needsUser, true);
  const approved = await f.invoke('status');
  assert.equal(approved.plan.state, 'approved');
  assert.equal(approved.plan.needsReview, false);
  assert.equal(approved.legacyReview.declined, false);
});

test('approve_plan takes exactly one route and pins declared inputs', async t => {
  const f = await fixture(t);
  await f.invoke('creative', { direction: 'Intent and constraints' });
  await f.invoke('save_plan', { text: '# Complete plan' });
  await assert.rejects(f.invoke('approve_plan', { spec, external: externalRoute, sampleShots: ['S01'] }), /一个制作路线/);
  await assert.rejects(f.invoke('approve_plan', { sampleShots: ['S01'] }), /一个制作路线/);
  await assert.rejects(f.invoke('approve_plan', { external: { ...externalRoute, audio: 'mono' }, sampleShots: ['S01'] }),
    /none, optional or required/);
  await assert.rejects(f.invoke('approve_plan', { external: { ...externalRoute, inputs: ['assets/missing.txt'] }, sampleShots: ['S01'] }),
    /assets\/missing\.txt/);
  await mkdir(join(f.root, 'assets'));
  await writeSource(f, 'assets/source.txt', 'dependency');
  await assert.rejects(f.invoke('approve_plan', { external: { ...externalRoute, inputs: ['C:\\outside.txt'] }, sampleShots: ['S01'] }),
    /project-relative/);
  await assert.rejects(f.invoke('approve_plan', { external: externalRoute, sampleShots: ['S03'] }), /unplanned/);
  await assert.rejects(f.invoke('approve_plan', { external: externalRoute, sampleShots: ['S01', 'S02'] }), /subset|time limit/);
  const approved = await f.invoke('approve_plan', { external: externalRoute, sampleShots: ['S01'], sampleMaxSeconds: 0.4 });
  assert.equal(approved.approved, true);
  const stored = f.saved.get(f.projectKey());
  assert.equal(stored.plan.route, 'external');
  assert.deepEqual(stored.plan.external.inputs.map(file => file.path), ['assets/source.txt']);
  assert.equal(stored.plan.external.inputs[0].digest, digestText('dependency'));
});

test('membership and simultaneous operations are checked before rendering', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('creative', { direction: 'Other' }, {
    ...f.context, agent: { session: { header: { id: 'child', origin: 'subagent' } } },
  }), /live root/);
  await f.invoke('creative', { direction: 'Intent and constraints' });
  await f.invoke('save_plan', { text: '# Complete plan' });
  await assert.rejects(f.invoke('approve_plan', { spec: { canvas, shots: shots.slice(1) }, sampleShots: ['S02'] }), /every planned shot/);
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

test('status keeps its older top-level shape while showing what is current', async t => {
  const f = await fixture(t);
  const empty = await f.invoke('status');
  assert.equal(empty.plan, null);
  assert.equal(empty.sample, null);
  assert.equal(empty.full, null);
  assert.equal(empty.acceptedSample, null);
  await approvedPlan(f);
  await f.invoke('render_sample');
  assert.equal((await f.invoke('status')).acceptedSample, null);
  await f.invoke('approve_sample');
  const accepted = await f.invoke('status');
  assert.equal(accepted.acceptedSample, accepted.sample.digest);
  assert.equal(accepted.sampleState, 'accepted');
  assert.equal(accepted.planState, 'approved');
  assert.equal(accepted.full, null);
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
