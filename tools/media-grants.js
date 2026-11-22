/**
 * 可复用的 Host 媒体授权（media grant）。
 *
 * 一份 grant 绑定：本项目的真实根目录（持久化键就是它的摘要）、提供方的具体型号、
 * 同一个用途、同一种货币、以及累计费用上限。在该范围内用户可以反复调用、重试、
 * 批量按镜头粒度调用；换型号、换用途、换数据范围或超出累计上限都要新的授权。
 * 上限可以在同一范围内上调，但不会把已占用费用归零。
 *
 * 费用按保守占用记账：派发前把 provider.estimate 的估价记成这笔操作的 reservation，
 * 完成后也不退还（没有确定退款金额）。派发结果不明时占用保留，grant 转入需对账状态，
 * 之后该 grant 不再派发。旧的 executeOneMediaRequest / generate_one_asset 一次性语义
 * 不受影响，本文件不改动任何他人文件。
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { askOnce, digestText } from './workflow.js';
import { discoverMediaModels } from './capabilities.js';

const VERSION = 1;
const HEX = /^[a-f0-9]{64}$/;
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 用户给的 operationId 只作重试去重键，永不参与文件名。 */
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const CURRENCY = /^[A-Z]{3}$/;
const MAX_PROMPT = 10000;
const MAX_LABEL = 200;
const HELD = new Set(['dispatching', 'completed', 'unknown']);
const STATES = new Set(['active', 'needs_reconciliation']);
const RECEIPT_KINDS = ['model-and-scope', 'cumulative-cost'];

/** 这些参数意味着上传文件或素材；当前提供方只有提示词通道，一律拒绝。 */
const UPLOAD_KEYS = [
  'files', 'file', 'uploads', 'upload', 'attachments', 'attachment', 'assets', 'asset',
  'source', 'sources', 'path', 'paths', 'image', 'images', 'video', 'audio', 'bytes',
  'input', 'inputs', 'reference', 'references',
];

/** 进程内互斥与结果不明的即时屏蔽：store 写失败时仍然阻止继续派发。 */
const busy = new Set();
const blocked = new Set();

function rootOf(project) {
  const raw = project?.root;
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\u0000')) {
    throw new Error('Media approvals need the real project root handed over by the Host.');
  }
  return resolve(raw);
}

/** 持久化键：项目真实根的摘要（纯 hex，独立表的键，不含分隔符）。 */
function keyOf(root) {
  const normalized = resolve(root);
  return digestText(process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, label, limit = MAX_LABEL) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`${label} must be nonempty text of at most ${limit} characters.`);
  }
  return value;
}

function purposeOf(value) {
  const purpose = text(value, 'Purpose').trim();
  if (/[\u0000-\u001f\u007f]/.test(purpose)) throw new Error('Purpose must stay on one line.');
  return purpose;
}

function assertLive(execution) {
  const session = execution?.agent?.session;
  const id = session?.header?.id ?? session?.id;
  if (typeof id !== 'string' || !id || session?.header?.origin === 'subagent') {
    throw new Error('Media approvals require a live root video session.');
  }
  if (typeof execution?.callId !== 'string' || !execution.callId) {
    throw new Error('Missing Host tool call identity.');
  }
}

function assertNoUpload(args) {
  for (const key of UPLOAD_KEYS) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    throw new Error(`This contract transmits prompt text only; "${key}" is not accepted. `
      + 'Uploading files or project assets needs a separate approval design.');
  }
}

function requireStore(store) {
  if (typeof store?.get !== 'function' || typeof store?.put !== 'function') {
    throw new Error('Media approvals require the Host store (get/put).');
  }
  return store;
}

async function readRecord(store, root) {
  const key = keyOf(root);
  const value = await store.get(key);
  if (value === undefined || value === null) return { version: VERSION, projectDigest: key, grants: {}, operations: {} };
  const record = assertStoredMediaGrant(value);
  if (record.projectDigest !== key) throw new Error('Stored media approvals do not belong to this project root.');
  return record;
}

function saveRecord(store, root, record) {
  return store.put(keyOf(root), assertStoredMediaGrant(record));
}

async function locked(root, operation) {
  const key = keyOf(root);
  if (busy.has(key)) throw new Error('Another media operation is running for this project.');
  busy.add(key);
  try {
    return await operation();
  } finally {
    busy.delete(key);
  }
}

function assertReceipt(receipt) {
  if (!plain(receipt) || !RECEIPT_KINDS.includes(receipt.kind)) {
    throw new Error('Invalid media approval record: receipt.');
  }
  for (const field of ['sessionId', 'callId', 'questionId']) text(receipt[field], `receipt ${field}`, 400);
  if (typeof receipt.at !== 'string' || Number.isNaN(Date.parse(receipt.at))) {
    throw new Error('Invalid media approval record: receipt timestamp.');
  }
}

function assertGrant(id, grant) {
  if (!GRANT_ID.test(id) || !plain(grant) || grant.id !== id) throw new Error('Invalid media approval record: grant id.');
  for (const field of ['provider', 'model']) text(grant[field], `grant ${field}`);
  if (!CURRENCY.test(grant.currency)) throw new Error('Invalid media approval record: currency.');
  if (purposeOf(grant.purpose) !== grant.purpose) throw new Error('Invalid media approval record: purpose.');
  if (!Number.isSafeInteger(grant.costLimit) || grant.costLimit < 0) throw new Error('Invalid media approval record: cost limit.');
  if (!Number.isSafeInteger(grant.spent) || grant.spent < 0 || grant.spent > grant.costLimit) {
    throw new Error('Invalid media approval record: spent budget.');
  }
  if (!STATES.has(grant.state)) throw new Error('Invalid media approval record: grant state.');
  if (!Array.isArray(grant.receipts) || grant.receipts.length !== 2) {
    throw new Error('Media approval record: a grant needs its two Host receipts.');
  }
  for (const receipt of grant.receipts) assertReceipt(receipt);
  const kinds = new Set(grant.receipts.map(receipt => receipt.kind));
  if (RECEIPT_KINDS.some(kind => !kinds.has(kind))) {
    throw new Error('Media approval record: receipts do not cover model scope and cumulative cost.');
  }
}

function assertOperation(operationId, operation, grants) {
  if (!OPERATION_ID.test(operationId) || RESERVED.has(operationId) || !plain(operation)) {
    throw new Error('Invalid media approval record: operation.');
  }
  if (!Object.hasOwn(grants, operation.grantId)) throw new Error('Media approval record: operation without its grant.');
  if (!HEX.test(operation.promptDigest ?? '')) throw new Error('Invalid media approval record: prompt digest.');
  if (!Number.isSafeInteger(operation.reserved) || operation.reserved < 0) {
    throw new Error('Invalid media approval record: reservation.');
  }
  if (!GRANT_ID.test(operation.artifactKey ?? '')) throw new Error('Invalid media approval record: artifact key.');
  if (!HELD.has(operation.state)) throw new Error('Invalid media approval record: operation state.');
  if (operation.state === 'completed') text(operation.path, 'completed artifact path', 400);
  if (operation.state === 'unknown' && typeof operation.unknownReason !== 'string') {
    throw new Error('Invalid media approval record: unknown outcome needs a reason.');
  }
}

/**
 * 校验一条持久化的媒体授权记录。除结构外还检查项目摘要、每笔操作所属的 grant，
 * 以及 spent 恰好等于仍被占用的 reservation 之和（改账、改上限即拒）。
 */
export function assertStoredMediaGrant(value) {
  if (!plain(value) || value.version !== VERSION) throw new Error('Invalid or unsupported media approval record.');
  if (!HEX.test(value.projectDigest ?? '')) throw new Error('Invalid media approval record: project digest.');
  if (!plain(value.grants) || !plain(value.operations)) throw new Error('Invalid media approval record: layout.');
  for (const [id, grant] of Object.entries(value.grants)) assertGrant(id, grant);
  const held = new Map();
  for (const [id, operation] of Object.entries(value.operations)) {
    assertOperation(id, operation, value.grants);
    if (HELD.has(operation.state)) held.set(operation.grantId, (held.get(operation.grantId) ?? 0) + operation.reserved);
  }
  for (const [id, grant] of Object.entries(value.grants)) {
    if (grant.spent !== (held.get(id) ?? 0)) {
      throw new Error('Media approval budget record does not add up for grant ' + id + '.');
    }
  }
  return value;
}

function blockedError(grantId, detail) {
  return new Error(`Media approval ${grantId} is blocked pending reconciliation: ${detail} `
    + 'No further request is dispatched for this approval until the held cost and any provider charge '
    + 'are reconciled outside this tool.');
}

/** 结果不明：保留占用、把 grant 转入需对账状态；返回要抛出的错误。 */
async function markUnknown({ store, root, record, grantId, operationId, reason, detail }) {
  const grant = record.grants[grantId];
  const operation = record.operations[operationId];
  blocked.add(grantId);
  let persisted = true;
  try {
    await saveRecord(store, root, {
      ...record,
      grants: { ...record.grants, [grantId]: { ...grant, state: 'needs_reconciliation' } },
      operations: {
        ...record.operations,
        [operationId]: {
          ...operation, state: 'unknown', unknownReason: reason, unknownAt: new Date().toISOString(),
        },
      },
    });
  } catch {
    persisted = false;
  }
  return blockedError(grantId, `operation ${operationId} (${reason}) reserved ${operation.reserved} ${grant.currency}. `
    + detail + (persisted ? '' : ' The block could not be persisted and is enforced in this process only.'));
}

function scopeQuestions({ provider, model, purpose, currency, costLimit }) {
  return {
    model: [
      `提供方 / Provider: ${provider}`,
      `具体型号 / Model: ${model}`,
      `用途 / Purpose: ${purpose}`,
      '',
      '只发送本项目、这个用途的提示词文本；不上传文件、素材或成片。提示词会发到所选服务。',
      'Only project prompt text for this purpose is sent; no files or assets are uploaded.',
      '提示词里若有敏感数据（个人信息、未公开素材等），需要另行单独授权。',
      'Sensitive data inside a prompt needs its own separate authorization.',
    ].join('\n'),
    cost: [
      `提供方 / Provider: ${provider}`,
      `具体型号 / Model: ${model}`,
      `用途 / Purpose: ${purpose}`,
      '',
      `累计费用上限 / Cumulative ceiling: ${costLimit} ${currency} 的最小货币单位 / minor units`,
      '每次调用前按提供方估价占用。估价超过余量时停止。同一范围上调上限会保留已占用费用。',
      'Each dispatch holds the estimate; a raised ceiling never refunds what is already held.',
    ].join('\n'),
  };
}

async function askScope(requestApproval, execution, fields) {
  const detail = scopeQuestions(fields);
  const model = await askOnce(requestApproval, execution,
    '批准这个具体型号的媒体授权？ / Approve this model authorization?', detail.model);
  if (!model) return null;
  const cost = await askOnce(requestApproval, execution,
    '是否授权这个累计费用上限？ / Approve this cumulative spending ceiling?', detail.cost);
  if (!cost) return null;
  return [
    { kind: RECEIPT_KINDS[0], ...model },
    { kind: RECEIPT_KINDS[1], ...cost },
  ];
}

function sameScope(grant, fields) {
  return grant.provider === fields.provider && grant.model === fields.model
    && grant.currency === fields.currency && grant.purpose === fields.purpose;
}

function summary(grant) {
  return {
    approved: true,
    grantId: grant.id,
    provider: grant.provider,
    model: grant.model,
    currency: grant.currency,
    costLimit: grant.costLimit,
    purpose: grant.purpose,
    state: grant.state,
    remaining: grant.costLimit - grant.spent,
    ...(grant.state === 'needs_reconciliation' ? { needsReconciliation: true } : {}),
  };
}

/**
 * 新动作 approve_media：先问模型与用途（含数据范围说明），再单独问累计费用上限。
 * 同范围再次批准只上调上限、沿用原 grant 与已占用费用；范围不变则不重复询问。
 */
export async function approveMediaGrant({ project, args = {}, execution, requestApproval, providers = [], store }) {
  if (typeof requestApproval !== 'function') throw new Error('Approvals require the Host question service.');
  requireStore(store);
  assertLive(execution);
  assertNoUpload(args);
  const root = rootOf(project);

  const fields = {
    provider: typeof args.provider === 'string' ? args.provider.trim() : '',
    model: typeof args.model === 'string' ? args.model.trim() : '',
    currency: typeof args.currency === 'string' ? args.currency.trim() : '',
    purpose: purposeOf(args.purpose),
  };
  text(fields.provider, 'Provider');
  text(fields.model, 'Model');
  if (!CURRENCY.test(fields.currency)) throw new Error('Set the currency as a three-letter uppercase code.');
  if (!Number.isSafeInteger(args.costLimit) || args.costLimit < 0) {
    throw new Error('Set the cumulative spending ceiling in the smallest currency unit.');
  }
  const configured = discoverMediaModels(Array.isArray(providers) ? providers : []);
  if (!configured.some(entry => entry.provider === fields.provider && entry.model === fields.model)) {
    throw new Error('No matching media model is configured by the Host.');
  }

  return locked(root, async () => {
    const record = await readRecord(store, root);
    const existing = Object.values(record.grants).find(grant => sameScope(grant, fields));
    if (existing) {
      if (existing.state !== 'active') return { ...summary(existing), reused: true };
      if (existing.costLimit === args.costLimit) return { ...summary(existing), reused: true };
      if (args.costLimit < existing.spent) {
        throw new Error(`This approval already holds ${existing.spent} ${existing.currency}; `
          + 'the ceiling cannot be set below the cost already committed.');
      }
      const receipts = await askScope(requestApproval, execution, { ...fields, costLimit: args.costLimit });
      if (!receipts) return { approved: false };
      const grant = {
        ...existing, costLimit: args.costLimit, receipts, updatedAt: new Date().toISOString(),
      };
      await saveRecord(store, root, { ...record, grants: { ...record.grants, [grant.id]: grant } });
      return { ...summary(grant), reused: true, updated: true };
    }

    const receipts = await askScope(requestApproval, execution, { ...fields, costLimit: args.costLimit });
    if (!receipts) return { approved: false };
    const grant = {
      id: randomUUID(), ...fields, costLimit: args.costLimit, receipts, spent: 0,
      state: 'active', createdAt: new Date().toISOString(),
    };
    await saveRecord(store, root, { ...record, grants: { ...record.grants, [grant.id]: grant } });
    return summary(grant);
  });
}

function scopeMismatch(grant, provided) {
  if (grant.provider !== provided.provider) return `This approval covers provider ${grant.provider}.`;
  if (grant.model !== provided.model) return `This approval covers model ${grant.model}.`;
  if (grant.currency !== provided.currency) return `This approval covers ${grant.currency}.`;
  if (grant.purpose !== provided.purpose) {
    return `This approval is for purpose "${grant.purpose}"; another purpose needs its own authorization.`;
  }
  return null;
}

function replay(operation, grant) {
  return {
    path: operation.path,
    provider: grant.provider,
    model: grant.model,
    grantId: grant.id,
    operationId: operation.operationId,
    purpose: grant.purpose,
    currency: grant.currency,
    costLimit: grant.costLimit,
    reserved: operation.reserved,
    remaining: grant.costLimit - grant.spent,
    replayed: true,
  };
}

/**
 * 新 generate_one_asset：在已批准范围内重复调用。
 * 同一 operationId 与同一提示词回放已完成结果；参数变了明确拒绝。
 */
export async function generateFromMediaGrant({ project, args = {}, execution, providers = [], store, saveArtifact, readArtifactDigest }) {
  if (typeof saveArtifact !== 'function' || typeof readArtifactDigest !== 'function') {
    throw new Error('Media dispatch requires the Host artifact writer and verifier.');
  }
  requireStore(store);
  assertLive(execution);
  assertNoUpload(args);
  const root = rootOf(project);
  const signal = execution.signal;

  const grantId = typeof args.grantId === 'string' ? args.grantId.trim() : '';
  if (!GRANT_ID.test(grantId)) throw new Error('Pass the grantId returned by approve_media.');
  const operationId = typeof args.operationId === 'string' ? args.operationId.trim() : '';
  if (!OPERATION_ID.test(operationId) || RESERVED.has(operationId)) {
    throw new Error('Use an operation ID of 1-64 letters, digits, dots, dashes or underscores.');
  }
  const prompt = args.text;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) {
    throw new Error(`Supply the prompt text for this asset (up to ${MAX_PROMPT} characters).`);
  }
  const provided = {
    provider: typeof args.provider === 'string' ? args.provider.trim() : '',
    model: typeof args.model === 'string' ? args.model.trim() : '',
    currency: typeof args.currency === 'string' ? args.currency.trim() : '',
    purpose: purposeOf(args.purpose),
  };

  return locked(root, async () => {
    const record = await readRecord(store, root);
    const grant = Object.hasOwn(record.grants, grantId) ? record.grants[grantId] : null;
    if (!grant) {
      throw new Error('No media approval with this ID exists for this project; approvals cannot be reused across projects.');
    }
    const promptDigest = digestText(prompt);
    const existing = Object.hasOwn(record.operations, operationId) ? record.operations[operationId] : null;
    if (existing) {
      const sameRequest = existing.grantId === grantId && existing.promptDigest === promptDigest
        && grant.provider === provided.provider && grant.model === provided.model
        && grant.currency === provided.currency && grant.purpose === provided.purpose;
      if (!sameRequest) {
        throw new Error('This operation ID already carried a different request; use a new operation ID for changed text, grant, model or purpose.');
      }
      if (existing.state === 'completed') {
        const actual = await readArtifactDigest(existing.path).catch(() => null);
        signal?.throwIfAborted();
        if (!HEX.test(existing.artifactDigest ?? '') || actual !== existing.artifactDigest) {
          throw new Error('The saved media asset is missing or changed. Restore that file to reuse it. The original request will not be sent again.');
        }
        return replay(existing, grant);
      }
      throw await markUnknown({
        store, root, record, grantId, operationId,
        reason: existing.state === 'dispatching' ? 'interrupted-before-result' : 'previous-unknown-outcome',
        detail: `Operation ${operationId} was already reserved (${existing.state}).`,
      });
    }

    if (grant.state !== 'active' || blocked.has(grantId)) {
      throw blockedError(grantId, 'this approval needs cost reconciliation first.');
    }
    const mismatch = scopeMismatch(grant, provided);
    if (mismatch) throw new Error(mismatch);
    // 上一次派发在写回结果前中断：即使换 operationId 也不能再派发。
    const interrupted = Object.values(record.operations)
      .find(operation => operation.grantId === grantId && operation.state === 'dispatching');
    if (interrupted) {
      throw await markUnknown({
        store, root, record, grantId, operationId: interrupted.operationId,
        reason: 'interrupted-before-result',
        detail: 'An earlier dispatch was interrupted before a definitive result and may have reached the provider.',
      });
    }

    const adapter = (Array.isArray(providers) ? providers : [])
      .find(entry => entry.id === grant.provider
        && Array.isArray(entry.models) && entry.models.some(model => model.id === grant.model));
    if (!adapter) throw new Error('This media model is not configured by the Host right now; nothing was sent.');

    const remaining = grant.costLimit - grant.spent;
    const artifactKey = randomUUID();
    const request = {
      operationId: artifactKey, provider: grant.provider, model: grant.model, currency: grant.currency,
      costLimit: grant.costLimit, purpose: grant.purpose, prompt,
    };
    let estimate;
    try {
      estimate = await adapter.estimate(request, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error('The media cost estimate failed, so nothing was sent and no budget was held; this approval can be retried.', { cause: error });
    }
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(estimate) || estimate < 0) {
      throw new Error('The media cost estimate could not be verified, so nothing was sent and no budget was held.');
    }
    if (estimate > remaining) {
      throw new Error(`The estimated cost ${estimate} ${grant.currency} exceeds the remaining budget `
        + `${remaining} ${grant.currency} of this approval; nothing was sent.`);
    }

    // Record the reservation and provider request ID in one durable write before dispatch.
    const reserved = {
      ...record,
      grants: { ...record.grants, [grantId]: { ...grant, spent: grant.spent + estimate } },
      operations: {
        ...record.operations,
        [operationId]: {
          operationId, grantId, promptDigest, reserved: estimate, artifactKey,
          state: 'dispatching', startedAt: new Date().toISOString(),
        },
      },
    };
    await saveRecord(store, root, reserved);

    try {
      signal?.throwIfAborted();
    } catch (error) {
      await saveRecord(store, root, record).catch(() => {});
      throw error;
    }

    let result;
    try {
      result = await adapter.generate(request, { signal, maxCost: estimate });
    } catch (error) {
      throw await markUnknown({
        store, root, record: reserved, grantId, operationId, reason: 'provider',
        detail: 'The provider returned no definitive result for this request.',
      });
    }

    let path;
    let artifactDigest;
    try {
      path = await saveArtifact(result, artifactKey);
      if (typeof path !== 'string' || !path.trim()) throw new Error('Missing Host artifact path.');
      artifactDigest = await readArtifactDigest(path);
      if (!HEX.test(artifactDigest ?? '')) throw new Error('Missing Host artifact digest.');
    } catch (error) {
      throw await markUnknown({
        store, root, record: reserved, grantId, operationId, reason: 'artifact',
        detail: 'The generated artifact could not be saved.',
      });
    }

    const completed = {
      ...reserved,
      operations: {
        ...reserved.operations,
        [operationId]: { ...reserved.operations[operationId], state: 'completed', path,
          artifactDigest, completedAt: new Date().toISOString() },
      },
    };
    try {
      await saveRecord(store, root, completed);
    } catch {
      const error = await markUnknown({
        store, root, record: reserved, grantId, operationId, reason: 'record',
        detail: 'The artifact was saved but its completion record could not be written.',
      });
      throw new Error(`${error.message} Saved artifact: ${path}`, { cause: error });
    }

    const current = completed.grants[grantId];
    return {
      path,
      provider: current.provider,
      model: current.model,
      grantId,
      operationId,
      purpose: current.purpose,
      currency: current.currency,
      costLimit: current.costLimit,
      reserved: estimate,
      remaining: current.costLimit - current.spent,
      replayed: false,
    };
  });
}
