import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  approveMediaGrant, approveMediaFromReceipt, generateFromMediaGrant, assertStoredMediaGrant,
} from '../tools/media-grants.js';
import { digestText } from '../tools/workflow.js';

const SCOPE = { provider: 'fixture', model: 'model-a', currency: 'CNY', costLimit: 10, purpose: '封面静帧' };
const TEXT = '画一张封面静帧';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cyv-grant-'));
  const other = await mkdtemp(join(tmpdir(), 'cyv-grant-other-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]));
  const saved = new Map();
  let failPut;
  const store = {
    get: async key => saved.get(key),
    put: async (key, value) => {
      if (failPut?.(value)) throw new Error('store write failed');
      saved.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
  const questions = [];
  let answers = [];
  const requestApproval = async ({ questions: [item] }) => {
    questions.push(item);
    const yes = answers.shift() ?? true;
    return { answers: [{ id: item.id, selected: yes ? [item.intent.approve] : [] }] };
  };
  const dispatch = [];
  const artifacts = [];
  const provider = {
    id: 'fixture',
    models: [{ id: 'model-a', capabilities: ['image'] }, { id: 'model-b', capabilities: ['image'] }],
    estimate: overrides.estimate ?? (() => 4),
    generate: overrides.generate ?? (async () => {
      dispatch.push(1);
      return { mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
    }),
  };
  const providers = [provider];
  let saveFails = false;
  const saveArtifact = async (result, operationId) => {
    if (saveFails) throw new Error('disk full');
    artifacts.push({ operationId, result });
    const relative = `assets/generated-${operationId}.png`;
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, relative), result.bytes, { flag: 'wx' });
    return relative;
  };
  const execution = {
    agent: { session: { header: { id: 'root-session' } } },
    callId: 'trusted-call',
    signal: new AbortController().signal,
  };
  const readArtifactDigest = async path => digestText(await readFile(join(root, path)));
  const call = (fn, project, args) => fn({ project, args, execution, requestApproval, providers, store, saveArtifact, readArtifactDigest,
    ...(overrides.resolvePlanDigest ? { resolvePlanDigest: overrides.resolvePlanDigest } : {}) });
  return {
    root, other, saved, questions, dispatch, artifacts, providers,
    approve: (args = {}, project = { root }) => call(approveMediaGrant, project, { ...SCOPE, ...args }),
    generate: (args = {}, project = { root }) => call(generateFromMediaGrant, project, {
      ...SCOPE, text: TEXT, operationId: 'take-01', ...args,
    }),
    approveFromReceipt: (declaration = {}, receipt, extra = {}, project = { root }) => approveMediaFromReceipt({
      project, declaration: { ...SCOPE, ...declaration }, execution, providers, store, receipt, ...extra,
    }),
    setPlanDigest: fn => { overrides.resolvePlanDigest = fn; },
    answer: (...values) => { answers = values; },
    failPutOn: predicate => { failPut = predicate; },
    failArtifact: value => { saveFails = value; },
    record: () => [...saved.values()][0],
    grant: () => Object.values([...saved.values()][0]?.grants ?? {})[0],
    operations: () => Object.values([...saved.values()][0]?.operations ?? {}),
  };
}

async function approved(f) {
  const result = await f.approve();
  assert.equal(result.approved, true);
  return result.grantId;
}

test('a grant takes the model/scope question and a separate cumulative cost question', async t => {
  const f = await fixture(t);
  f.answer(false, true);
  assert.deepEqual(await f.approve(), { approved: false });
  assert.equal(f.questions.length, 1);
  assert.match(f.questions[0].detail, /fixture/);
  assert.match(f.questions[0].detail, /model-a/);
  assert.match(f.questions[0].detail, /封面静帧/);
  assert.match(f.questions[0].detail, /不上传文件|no files/i);
  assert.match(f.questions[0].detail, /敏感|Sensitive/i);
  assert.equal(f.saved.size, 0);

  f.answer(true, false);
  assert.deepEqual(await f.approve(), { approved: false });
  assert.equal(f.questions.length, 3);
  assert.match(f.questions[2].detail, /累计费用上限|Cumulative ceiling/);
  assert.match(f.questions[2].detail, /10 CNY/);
  assert.deepEqual(new Set(f.questions.map(item => item.id)).size, 3);
  assert.equal(f.saved.size, 0);
});

test('the persisted key is a plain hex digest and receipts are real Host receipts', async t => {
  const f = await fixture(t);
  const result = await f.approve();
  assert.match(result.grantId, /^[0-9a-f-]{36}$/);
  assert.equal(result.remaining, 10);
  assert.equal([...f.saved.keys()][0], digestText(process.platform === 'win32' ? f.root.toLowerCase() : f.root));
  const grant = f.grant();
  assert.equal(grant.state, 'active');
  assert.equal(grant.spent, 0);
  assert.deepEqual(grant.receipts.map(receipt => receipt.kind), ['model-and-scope', 'cumulative-cost']);
  assert.deepEqual(new Set(grant.receipts.map(receipt => receipt.questionId)), new Set(f.questions.map(item => item.id)));
  assert.doesNotMatch(JSON.stringify(grant), new RegExp(TEXT));

  const again = await f.approve();
  assert.deepEqual({ id: again.grantId, reused: again.reused }, { id: result.grantId, reused: true });
  assert.equal(f.questions.length, 2);
  assert.notEqual((await f.approve({ model: 'model-b' })).grantId, result.grantId);
  assert.notEqual((await f.approve({ purpose: '片头动效' })).grantId, result.grantId);
});

test('authorization refuses unknown models, bad amounts, empty purpose and uploads', async t => {
  const f = await fixture(t);
  await assert.rejects(f.approve({ model: 'model-z' }), /No matching media model/);
  await assert.rejects(f.approve({ currency: 'cny' }), /three-letter/);
  await assert.rejects(f.approve({ costLimit: 1.5 }), /cumulative spending ceiling/);
  await assert.rejects(f.approve({ purpose: ' ' }), /Purpose/);
  await assert.rejects(f.approve({ purpose: '两行\n用途' }), /one line/);
  await assert.rejects(f.approve({ files: ['a.png'] }), /prompt text only/);
  await assert.rejects(f.approve({ source: 'assets/a.png' }), /prompt text only/);
  assert.equal(f.questions.length, 0);
  assert.equal(f.saved.size, 0);
});

test('dispatch holds the estimate, passes it as maxCost and keeps the rest available', async t => {
  const f = await fixture(t);
  const grantId = await approved(f);
  const result = await f.generate({ grantId, operationId: 'shot-01' });
  assert.equal(result.provider, 'fixture');
  assert.equal(result.model, 'model-a');
  assert.equal(result.reserved, 4);
  assert.equal(result.remaining, 6);
  assert.equal(result.replayed, false);
  const [operation] = f.operations();
  assert.equal(operation.state, 'completed');
  assert.equal(operation.reserved, 4);
  assert.match(operation.artifactKey, /^[0-9a-f-]{36}$/);
  assert.match(result.path, new RegExp(operation.artifactKey));
  assert.equal(f.artifacts[0].operationId, operation.artifactKey);
  assert.equal(f.dispatch.length, 1);
  assert.equal((await f.generate({ grantId, operationId: 'shot-02' })).remaining, 2);
});

test('a replay of one operation ID returns the completed result with no second charge', async t => {
  const f = await fixture(t);
  const grantId = await approved(f);
  const first = await f.generate({ grantId });
  const replay = await f.generate({ grantId });
  assert.deepEqual(replay, { ...first, replayed: true });
  await writeFile(join(f.root, first.path), 'different bytes');
  await assert.rejects(f.generate({ grantId }), /saved media asset is missing or changed/);
  assert.equal(f.dispatch.length, 1);
  assert.equal(f.artifacts.length, 1);
  assert.equal(f.grant().spent, 4);
});

test('a changed prompt, model, purpose or grant under the same operation ID is refused', async t => {
  const f = await fixture(t);
  const grantId = await approved(f);
  await f.generate({ grantId, operationId: 'op-1' });
  await assert.rejects(f.generate({ grantId, operationId: 'op-1', text: '另一段提示词' }), /different request/);
  await assert.rejects(f.generate({ grantId, operationId: 'op-1', model: 'model-b' }), /different request/);
  await assert.rejects(f.generate({ grantId, operationId: 'op-1', purpose: '片头动效' }), /different request/);
  const second = await f.approve({ purpose: '片头动效' });
  await assert.rejects(f.generate({ grantId: second.grantId, operationId: 'op-1' }), /different request/);
  assert.equal(f.dispatch.length, 1);
  assert.equal(f.grant().spent, 4);
});

test('swapping model, purpose, provider or project is refused before any dispatch', async t => {
  const f = await fixture(t);
  const grantId = await approved(f);
  await assert.rejects(f.generate({ grantId, model: 'model-b' }), /covers model model-a/);
  await assert.rejects(f.generate({ grantId, purpose: '片头动效' }), /another purpose/);
  await assert.rejects(f.generate({ grantId, provider: 'other' }), /covers provider/);
  await assert.rejects(f.generate({ grantId, currency: 'USD' }), /covers CNY/);
  await assert.rejects(f.generate({ grantId }, { root: f.other }), /No media approval with this ID/);
  await assert.rejects(f.generate({ grantId: 'nope' }), /grantId returned by approve_media/);
  assert.equal(f.questions.length, 2);
  assert.equal(f.dispatch.length, 0);
});

test('a raised ceiling keeps what is already committed and cannot drop below it', async t => {
  let estimate = 4;
  const f = await fixture(t, { estimate: () => estimate });
  const grantId = await approved(f);
  await f.generate({ grantId, operationId: 'first' });
  const raised = await f.approve({ costLimit: 6 });
  assert.equal(raised.grantId, grantId);
  assert.equal(raised.updated, true);
  assert.equal(raised.remaining, 2);
  assert.equal(f.grant().spent, 4);
  assert.equal(f.grant().costLimit, 6);
  assert.equal(f.questions.length, 4);
  await assert.rejects(f.approve({ costLimit: 3 }), /already holds 4 CNY/);

  estimate = 2;
  assert.equal((await f.generate({ grantId, operationId: 'second' })).remaining, 0);
  await assert.rejects(f.generate({ grantId, operationId: 'third' }), /exceeds the remaining budget/);
  assert.equal(f.dispatch.length, 2);
  assert.equal(f.operations().length, 2);
});

test('the cumulative ceiling stops dispatch, while a zero estimate still fits a used-up ceiling', async t => {
  let estimate = 4;
  let estimateFails = false;
  const f = await fixture(t, { estimate: () => { if (estimateFails) throw new Error('pricing unavailable'); return estimate; } });
  const grantId = await approved(f);
  estimate = 11;
  await assert.rejects(f.generate({ grantId, operationId: 'big' }), /exceeds the remaining budget/);
  assert.equal(f.grant().spent, 0);

  estimateFails = true;
  await assert.rejects(f.generate({ grantId, operationId: 'retry' }), /estimate failed/);
  assert.equal(f.grant().spent, 0);
  assert.equal(f.operations().length, 0);

  estimate = 10;
  estimateFails = false;
  assert.equal((await f.generate({ grantId, operationId: 'fill' })).remaining, 0);
  await assert.rejects(f.generate({ grantId, operationId: 'full' }), /exceeds the remaining budget/);
  estimate = 0;
  const free = await f.generate({ grantId, operationId: 'free' });
  assert.equal(free.remaining, 0);
  assert.equal(free.reserved, 0);
  assert.equal(f.dispatch.length, 2);
});

test('an unclear provider outcome blocks the grant and keeps the held cost', async t => {
  let fail = true;
  const f = await fixture(t, {
    generate: async () => {
      if (fail) throw new Error('socket hang up');
      return { mime: 'image/png', bytes: new Uint8Array([9]) };
    },
  });
  const grantId = await approved(f);
  await assert.rejects(f.generate({ grantId, operationId: 'maybe-sent' }), /blocked pending reconciliation/);
  const grant = f.grant();
  assert.equal(grant.state, 'needs_reconciliation');
  assert.equal(grant.spent, 4);
  const [operation] = f.operations();
  assert.equal(operation.state, 'unknown');
  assert.equal(operation.reserved, 4);
  assert.equal(operation.unknownReason, 'provider');

  fail = false;
  await assert.rejects(f.generate({ grantId, operationId: 'fresh' }), /blocked pending reconciliation/);
  await assert.rejects(f.generate({ grantId, operationId: 'maybe-sent' }), /blocked pending reconciliation/);
  assert.equal(f.artifacts.length, 0);
  const bypass = await f.approve({ costLimit: 20 });
  assert.equal(bypass.needsReconciliation, true);
  assert.equal(bypass.costLimit, 10);
  assert.equal(f.questions.length, 2);
});

test('a reserved dispatch found on reload blocks the grant even for a new operation ID', async t => {
  const f = await fixture(t);
  const grantId = await approved(f);
  const record = f.record();
  const interruptedId = 'crash-01';
  f.saved.set([...f.saved.keys()][0], {
    ...record,
    grants: { [grantId]: { ...record.grants[grantId], spent: 4 } },
    operations: {
      [interruptedId]: {
        operationId: interruptedId, grantId, promptDigest: digestText(TEXT), reserved: 4,
        artifactKey: '6f1c5c1e-0b0e-4c0f-9a4f-1c2d3e4f5a6b', state: 'dispatching',
      },
    },
  });
  await assert.rejects(f.generate({ grantId, operationId: interruptedId }), /blocked pending reconciliation/);
  await assert.rejects(f.generate({ grantId, operationId: 'brand-new' }), /blocked pending reconciliation/);
  const grant = f.grant();
  assert.equal(grant.state, 'needs_reconciliation');
  assert.equal(grant.spent, 4);
  assert.equal(f.operations().length, 1);
  assert.equal(f.dispatch.length, 0);
});

test('an unsaveable artifact or unwritable completion is an unclear outcome', async t => {
  const f = await fixture(t);
  const grantId = await approved(f);
  f.failArtifact(true);
  await assert.rejects(f.generate({ grantId, operationId: 'save-fail' }), /could not be saved/);
  assert.equal(f.grant().state, 'needs_reconciliation');
  assert.equal(f.grant().spent, 4);

  const g = await fixture(t);
  const otherGrant = await approved(g);
  g.failPutOn(value => value.operations?.['written']?.state === 'completed');
  await assert.rejects(g.generate({ grantId: otherGrant, operationId: 'written' }), /Saved artifact: assets\//);
  assert.equal(g.grant().state, 'needs_reconciliation');
  await assert.rejects(g.generate({ grantId: otherGrant, operationId: 'next' }), /blocked pending reconciliation/);
});

test('concurrent dispatches and approvals for one project are refused', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let first = true;
  const f = await fixture(t, {
    estimate: async () => {
      if (first) { first = false; await held; }
      return 2;
    },
  });
  const grantId = await approved(f);
  const running = f.generate({ grantId, operationId: 'serial-1' });
  await assert.rejects(f.generate({ grantId, operationId: 'serial-2' }), /Another media operation is running/);
  await assert.rejects(f.approve({ costLimit: 12 }), /Another media operation is running/);
  release();
  assert.equal((await running).remaining, 8);
});

test('the persisted record is tamper-evident', async t => {
  const f = await fixture(t);
  const grantId = await approved(f);
  await f.generate({ grantId, operationId: 'op-1' });
  const record = f.record();
  assert.equal(assertStoredMediaGrant(record), record);
  assert.throws(() => assertStoredMediaGrant({
    ...record, grants: { [grantId]: { ...record.grants[grantId], spent: 0 } },
  }), /does not add up/);
  assert.throws(() => assertStoredMediaGrant({
    ...record, operations: { 'op-1': { ...record.operations['op-1'], reserved: 1 } },
  }), /does not add up/);
  assert.throws(() => assertStoredMediaGrant({
    ...record, operations: { 'op-1': { ...record.operations['op-1'], grantId: 'x' } },
  }), /without its grant/);
  assert.throws(() => assertStoredMediaGrant({
    ...record, grants: { [grantId]: { ...record.grants[grantId], receipts: record.grants[grantId].receipts.slice(1) } },
  }), /two Host receipts/);
  assert.throws(() => assertStoredMediaGrant({ ...record, projectDigest: 'not-hex' }), /project digest/);
  assert.throws(() => assertStoredMediaGrant({ ...record, version: 9 }), /unsupported/);
});

test('the old one-shot media tool keeps its own semantics', async () => {
  const { executeOneMediaRequest } = await import('../tools/capabilities.js');
  let calls = 0;
  const provider = { id: 'fixture', models: [{ id: 'model-a' }], estimate: () => 4, generate: () => ++calls };
  const request = { operationId: 'legacy', provider: 'fixture', model: 'model-a', currency: 'CNY', costLimit: 5, prompt: 'x' };
  const approved = { ...request };
  assert.equal(await executeOneMediaRequest({ providers: [provider], request, approved }), 1);
  await assert.rejects(executeOneMediaRequest({ providers: [provider], request, approved }), /approval/);
  assert.equal(calls, 1);
});

const planReceipt = extra => ({
  sessionId: 'root-session', callId: 'trusted-call', questionId: 'cyv-plan-1',
  at: new Date().toISOString(), ...extra,
});

test('a plan approval receipt mints both required receipts without asking again', async t => {
  const f = await fixture(t);
  const result = await f.approveFromReceipt({}, planReceipt());

  assert.equal(result.approved, true);
  assert.equal(result.planBound, undefined, '没有方案摘要时不假装绑定');
  assert.equal(f.questions.length, 0, '同一条批准不应该再问一次');

  const grant = f.grant();
  assert.deepEqual(grant.receipts.map(r => r.kind), ['model-and-scope', 'cumulative-cost']);
  assert.deepEqual(grant.receipts.map(r => r.questionId), ['cyv-plan-1', 'cyv-plan-1']);
  assert.equal(grant.mintedFrom, 'plan-approval');
  assert.equal(grant.spent, 0);
  assertStoredMediaGrant(f.record());

  await assert.rejects(
    () => f.approveFromReceipt({ model: 'model-z' }, planReceipt()),
    /No matching media model/);
  await assert.rejects(
    () => f.approveFromReceipt({}, { sessionId: 'root-session', callId: 'trusted-call', at: new Date().toISOString() }),
    /receipt/);
});

test('a plan-bound grant stops dispatching once the plan changes', async t => {
  const f = await fixture(t);
  const planDigest = 'a'.repeat(64);
  const approved = await f.approveFromReceipt({}, planReceipt(), { planDigest });
  assert.equal(approved.approved, true);
  assert.equal(approved.planBound, true);
  assert.equal(f.grant().planDigest, planDigest);

  f.setPlanDigest(async () => 'b'.repeat(64));
  await assert.rejects(() => f.generate({ grantId: approved.grantId }), /方案在批准后被改动/);
  assert.equal(f.dispatch.length, 0, '失效的授权一次都不该派发出去');

  f.setPlanDigest(async () => planDigest);
  const ok = await f.generate({ grantId: approved.grantId });
  assert.match(ok.path, /^assets\/generated-/);
  assert.equal(f.dispatch.length, 1);
});

test('a plan-bound grant fails closed when the plan digest cannot be verified', async t => {
  const f = await fixture(t);
  const approved = await f.approveFromReceipt({}, planReceipt(), { planDigest: 'c'.repeat(64) });
  await assert.rejects(() => f.generate({ grantId: approved.grantId }), /current plan digest/);
  assert.equal(f.dispatch.length, 0);
});

