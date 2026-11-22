import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../index.js';

/**
 * 工具装配层的接线回归。
 *
 * 单测跑的是 tools/ 里的函数，宿主冒烟跑的是真实 DSH；中间这一层（index.js 注册的
 * 工具、闭包与存储适配器）只有后者能覆盖，而后者要装 DSH 才能跑。这里用一个最小假宿主
 * 把这一层钉住——它抓的是"某个闭包变量被重构掉但仍在用"这类运行时错误。
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/jn14AAAAASUVORK5CYII=',
  'base64',
);

async function harness(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'cyv-wiring-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const agent = { id: 'agent-1', session: { header: { id: 'session-1', origin: 'root' } } };
  const definitions = [];
  const approvals = new Map();
  const grants = new Map();
  let sends = 0;

  const providers = [{
    id: 'mock', models: [{ id: 'fixture-image', capabilities: ['image'] }],
    estimate: async () => 2,
    generate: async () => { sends += 1; return { mime: 'image/png', bytes: PNG }; },
  }];

  const ctx = {
    get: name => (name === 'controlYourVideoMediaProviders' ? providers : undefined),
    tools: { register: definition => definitions.push(definition) },
    userQuestions: {
      ask: async request => {
        const [item] = request.questions;
        return { answers: [{ id: item.id, selected: [item.intent.approve] }] };
      },
    },
    workingDirectory: { get: () => workspace },
    controlYourVideoStore: {
      get: key => approvals.get(key),
      put: async (key, value) => { approvals.set(key, value); },
      mediaGrants: {
        get: key => grants.get(key),
        put: async (key, value) => { grants.set(key, value); },
      },
      locks: new Set(),
    },
    agents: { get: id => (id === agent.id ? agent : undefined) },
  };

  await apply(ctx);
  const cyv = definitions.find(definition => definition.name === 'cyv');
  const evidence = definitions.find(definition => definition.name === 'evidence');
  assert.ok(cyv, 'cyv 工具要注册出来');
  assert.ok(evidence, 'evidence 工具要注册出来');

  const execution = { agent, callId: 'call-1', signal: new AbortController().signal };
  const call = async (action, args = {}) => {
    const result = await cyv.execute({ action, ...args }, execution);
    return JSON.parse(result);
  };

  return { workspace, call, evidence, execution, sends: () => sends, grants };
}
test('the registered cyv tool carries a media grant from approval all the way to a saved asset', async t => {
  const f = await harness(t);
  await f.call('create', { project: 'film' });

  const approved = await f.call('approve_media', {
    project: 'film', provider: 'mock', model: 'fixture-image', purpose: '接线测试图', currency: 'CNY', costLimit: 4,
  });
  assert.equal(approved.approved, true);

  const generated = await f.call('generate_one_asset', {
    project: 'film', provider: 'mock', model: 'fixture-image', purpose: '接线测试图', currency: 'CNY',
    costLimit: 4, grantId: approved.grantId, operationId: 'wiring-one', text: '接线测试',
  });
  assert.match(generated.path, /^assets\/generated-[0-9a-f-]+\.png$/);
  assert.equal(f.sends(), 1);
  assert.deepEqual(await readFile(join(f.workspace, 'film', generated.path)), PNG);

  // 同 operationId 与同文本回放，不再派发。
  const replay = await f.call('generate_one_asset', {
    project: 'film', provider: 'mock', model: 'fixture-image', purpose: '接线测试图', currency: 'CNY',
    costLimit: 4, grantId: approved.grantId, operationId: 'wiring-one', text: '接线测试',
  });
  assert.equal(replay.path, generated.path);
  assert.equal(f.sends(), 1);
});

test('the registered evidence tool exposes the contact sheet action', async t => {
  const f = await harness(t);
  const params = f.evidence.parameters;
  assert.ok(params.properties.action.enum.includes('sheet'), 'sheet 要出现在动作枚举里');
  for (const key of ['span', 'count', 'cols']) {
    assert.ok(params.properties[key], `${key} 要能被模型填`);
  }

  await f.call('create', { project: 'film' });
  const failure = await f.evidence.execute({
    action: 'sheet', project: 'film', source: 'nope.mp4', revision: 'r1', shot: 1, t: 0,
  }, f.execution).then(() => null, error => error.message);
  assert.ok(failure, '没有源文件时必须失败');
  assert.doesNotMatch(failure, /未知动作|只有 extract/);
});
