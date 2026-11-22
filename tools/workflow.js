import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const MAX_PLAN_BYTES = 512 * 1024;
const MAX_RUNS = 20;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const STAGES = ['sample', 'full', 'revision'];
const AUDIO_INTENTS = ['none', 'optional', 'required'];
const APPROVE = '认可并授权所述范围 / Approve this scope';
const DECLINE = '返回修改 / Request changes';
const NEED_REVIEW = '这条批准来自旧版本记录：它只绑定了镜号、顺序与时长，无法证明原收据对应的正文。'
  + '当前记录仍可查看，但在一次显式重审之前不再沿用。';

export function digestText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function requireText(value, label, limit = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`${label} must be nonempty text of at most ${limit} characters.`);
  }
  return value;
}

function shortDigest(digest) {
  return typeof digest === 'string' ? digest.slice(0, 12) : '(none)';
}

function identity(ctx) {
  const id = ctx.agent?.session?.header?.id ?? ctx.agent?.session?.id;
  if (typeof id !== 'string' || ctx.agent.session.header?.origin === 'subagent') {
    throw new Error('Video production requires a live root session.');
  }
  if (typeof ctx.callId !== 'string') throw new Error('Missing Host tool call identity.');
  return { sessionId: id, callId: ctx.callId };
}

function isInside(root, target) {
  const delta = relative(root, target);
  return delta !== '' && delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

function projectFile(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || /[:\x00]/.test(path)) {
    throw new Error('Use a project-relative path.');
  }
  const target = join(root, path);
  if (!isInside(root, target)) throw new Error('Path is outside the project.');
  return target;
}

function existingProjectFile(root, path) {
  const target = projectFile(root, path);
  const actual = realpathSync(target);
  if (!isInside(root, actual) || !statSync(actual).isFile()) {
    throw new Error('Expected a regular file within the project.');
  }
  return actual;
}

async function fingerprint(root, path, signal) {
  const actual = existingProjectFile(root, path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(actual, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

async function pinnedDigest(root, path, signal, label) {
  try {
    return await fingerprint(root, path, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'ENOENT') throw new Error(`${label}不存在或不可读：${path}`);
    throw error;
  }
}

async function loadPlan(root) {
  const actual = existingProjectFile(root, 'plan.md');
  const info = await lstat(actual);
  if (info.size > MAX_PLAN_BYTES) throw new Error('plan.md exceeds 512 KiB.');
  const source = await readFile(actual);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
  return { text, digest: createHash('sha256').update(source).digest('hex') };
}

async function savePlan(root, text) {
  requireText(text, 'plan.md', MAX_PLAN_BYTES);
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) throw new Error('plan.md exceeds 512 KiB.');
  const path = projectFile(root, 'plan.md');
  const temporary = projectFile(root, `.cyv-plan-${randomUUID()}.tmp`);
  await writeFile(temporary, text, { flag: 'wx' });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path, digest: digestText(text) };
}

function planReport(inspectPlan, root, text) {
  return inspectPlan(text, {
    assetExists(path) {
      try {
        existingProjectFile(root, path);
        return true;
      } catch {
        return false;
      }
    },
  });
}

function comparableShotId(id) {
  const number = /^(?:s|shot[- ]?)?(\d+)$/i.exec(String(id));
  return number ? String(Number(number[1])) : String(id).toLowerCase();
}

function shotFrames(durationSec, fps) {
  const frames = Math.round(durationSec * fps);
  if (!Number.isSafeInteger(frames) || frames < 1) {
    throw new Error('镜头时长与帧率推导不出一帧以上的画面。');
  }
  return frames;
}

/** Only user-supplied project material is pinned for the FFmpeg route; build artifacts are not. */
function materialPath(value) {
  return typeof value === 'string' && /^assets\//i.test(value.split(String.fromCharCode(92)).join('/'));
}

async function recipeAssets(root, spec, signal) {
  const paths = new Set();
  for (const shot of spec.shots) if (materialPath(shot.visual?.path)) paths.add(shot.visual.path);
  if (materialPath(spec.audio?.path)) paths.add(spec.audio.path);
  const files = [];
  for (const path of paths) files.push({ path, digest: await fingerprint(root, path, signal) });
  return files;
}

/**
 * Every input this approval depends on: user material for the built-in recipe, and
 * the explicitly declared existing project dependencies of a self-chosen route.
 */
async function assertPinnedInputs(root, plan, signal) {
  for (const file of plan.assets ?? []) {
    const digest = await pinnedDigest(root, file.path, signal, '项目素材');
    if (digest !== file.digest) {
      throw new Error('项目素材在批准后被改动：' + file.path + '。重新复制素材或走一次方案确认。');
    }
  }
  for (const file of plan.external?.inputs ?? []) {
    const digest = await pinnedDigest(root, file.path, signal, '批准时固定的项目输入');
    if (digest !== file.digest) {
      throw new Error('批准时固定的项目输入在批准后被改动：' + file.path + '。重新批准当前版本。');
    }
  }
}

function approvalShots(report) {
  const shots = Array.isArray(report?.shots) ? report.shots : [];
  if (!shots.length) throw new Error('方案里没有读到镜头，无法固定批准快照。');
  return shots.map((shot, index) => {
    const duration = Number(shot.duration ?? shot.durationSec);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('方案里有镜头没有可读的时长，无法固定批准快照。');
    }
    return { id: shot.id ?? null, order: Number.isInteger(shot.order) ? shot.order : index + 1, duration };
  });
}

function assertSampleSelection(shots, sampleShots, sampleMaxSeconds, fps) {
  if (!Array.isArray(sampleShots) || !sampleShots.length) {
    throw new Error('Select unique shot IDs for the sample.');
  }
  const keys = sampleShots.map(comparableShotId);
  if (new Set(keys).size !== keys.length) throw new Error('Select unique shot IDs for the sample.');
  for (const key of keys) {
    if (!shots.some(shot => comparableShotId(shot.id) === key)) {
      throw new Error('The sample contains an unplanned shot.');
    }
  }
  const selected = shots.filter(shot => keys.includes(comparableShotId(shot.id)));
  if (sampleMaxSeconds !== undefined && sampleMaxSeconds !== null) {
    if (typeof sampleMaxSeconds !== 'number' || !Number.isFinite(sampleMaxSeconds) || sampleMaxSeconds <= 0) {
      throw new Error('Sample time limit must be a positive number of seconds.');
    }
    const requested = Math.floor(sampleMaxSeconds * fps + 1e-6);
    const selectedFrames = selected.reduce((sum, shot) => sum + shotFrames(shot.duration, fps), 0);
    if (!Number.isSafeInteger(requested) || requested < 1 || requested >= selectedFrames) {
      throw new Error('The sample time limit must cover one or more frames and end before its selected shots.');
    }
  }
  if (selected.length === shots.length && (sampleMaxSeconds === undefined || sampleMaxSeconds === null)) {
    throw new Error('Use a representative subset of shots or specify a shorter sample time limit.');
  }
}

function assertRecipeLayout(shots, spec, sampleShots, sampleMaxSeconds) {
  if (spec.shots.length !== shots.length) {
    throw new Error('The recipe must implement every planned shot exactly once.');
  }
  for (const [index, shot] of shots.entries()) {
    const actual = spec.shots[index];
    if (comparableShotId(shot.id) !== comparableShotId(actual.id)
      || Math.abs(shot.duration - (actual.durationSec ?? actual.duration)) > 0.001) {
      throw new Error(`Recipe shot ${actual.id} does not match the order, ID and duration in plan.md.`);
    }
  }
  assertSampleSelection(shots, sampleShots, sampleMaxSeconds, spec.canvas.fps);
}

function validateExternal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('external must be an object { engine, inputs?, canvas, audio }.');
  }
  const allowed = ['engine', 'inputs', 'canvas', 'audio'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`external does not accept ${key}; use ${allowed.join(' / ')}.`);
  }
  const engine = requireText(value.engine, 'external.engine', 500).trim();
  if (!value.canvas || typeof value.canvas !== 'object' || Array.isArray(value.canvas)) {
    throw new Error('external.canvas must be { width, height, fps }.');
  }
  for (const key of Object.keys(value.canvas)) {
    if (!['width', 'height', 'fps'].includes(key)) throw new Error(`external.canvas does not accept ${key}.`);
  }
  const { width, height, fps } = value.canvas;
  if (!Number.isSafeInteger(width) || width < 16 || width > 16384) {
    throw new Error('external.canvas.width must be an integer from 16 to 16384.');
  }
  if (!Number.isSafeInteger(height) || height < 16 || height > 16384) {
    throw new Error('external.canvas.height must be an integer from 16 to 16384.');
  }
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 1 || fps > 240) {
    throw new Error('external.canvas.fps must be a number from 1 to 240.');
  }
  if (!AUDIO_INTENTS.includes(value.audio)) {
    throw new Error('external.audio must be none, optional or required.');
  }
  const raw = value.inputs === undefined ? [] : value.inputs;
  if (!Array.isArray(raw) || raw.length > 100) throw new Error('external.inputs must be up to 100 project-relative paths.');
  const inputPaths = [];
  for (const path of raw) {
    if (typeof path !== 'string' || !path.trim() || /[\r\n\x00]/.test(path)
      || isAbsolute(path) || path.includes(':')) {
      throw new Error('external.inputs entries must be project-relative paths inside this project.');
    }
    const normalized = path.split(String.fromCharCode(92)).join('/');
    if (normalized.split('/').includes('..')) {
      throw new Error('external.inputs must not leave the project: ' + normalized);
    }
    if (inputPaths.includes(normalized)) throw new Error('external.inputs repeats ' + normalized + '.');
    inputPaths.push(normalized);
  }
  return { engine, canvas: { width, height, fps }, audio: value.audio, inputPaths };
}

function routeCanvas(plan) {
  return plan.route === 'external' ? plan.external.canvas : plan.spec.canvas;
}

function routeAudio(plan) {
  if (plan.route === 'external') return plan.external.audio;
  return plan.spec.audio?.mode === 'none' ? 'none' : 'required';
}

function planShotsOf(plan) {
  return Array.isArray(plan?.shots) ? plan.shots : [];
}

function executionDescriptor(plan) {
  if (plan.route === 'external') {
    return {
      route: 'external',
      engine: plan.external.engine,
      canvas: plan.external.canvas,
      audio: plan.external.audio,
      inputs: plan.external.inputs,
    };
  }
  return { route: 'ffmpeg', spec: plan.spec };
}

/**
 * Stable JSON: object keys sorted recursively, array order kept. Two specs that differ
 * only in property order hash the same, so re-stating one shape is not a new approval.
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Digest of everything the approved scope actually executes. */
function executionDigestOf(plan) {
  return digestText(stableJson(executionDescriptor(plan)));
}

function canonicalShots(plan) {
  return planShotsOf(plan).map(shot => ({
    id: shot.id ?? null,
    order: shot.order ?? null,
    duration: shot.duration,
    content: typeof shot.content === 'string' ? shot.content : '',
    route: typeof shot.route === 'string' ? shot.route : '',
  }));
}

/**
 * Everything the approved scope actually depends on, including the plan snapshot
 * text, the shot table read from it, the chosen execution route and its pinned
 * inputs, and the sample selection. A digest over this is what samples, complete
 * versions and prepared runs are bound to.
 */
function bindingPayload(plan) {
  return {
    plan: plan.digest,
    shots: canonicalShots(plan),
    route: plan.route,
    execution: executionDigestOf(plan),
    assets: plan.assets ?? [],
    sampleShots: plan.sampleShots,
    sampleMaxSeconds: plan.sampleMaxSeconds ?? null,
    creative: plan.creativeDigest,
  };
}

function bindingDigestOf(plan) {
  return digestText(stableJson(bindingPayload(plan)));
}

/**
 * A v2 approval proves its own binding: the snapshot text hashes to the recorded
 * plan digest, and the binding digest covers route, execution, sample scope and
 * the creative decision. Anything else is a visible legacy record, not an approval.
 */
function isBoundPlan(plan) {
  try {
    return Boolean(plan) && plan.version === 2 && typeof plan.text === 'string'
      && HEX_DIGEST.test(plan.digest) && digestText(plan.text) === plan.digest
      && HEX_DIGEST.test(plan.bindingDigest) && bindingDigestOf(plan) === plan.bindingDigest
      && Boolean(plan.receipt) && ['ffmpeg', 'external'].includes(plan.route)
      && Array.isArray(plan.sampleShots) && Array.isArray(plan.shots);
  } catch {
    return false;
  }
}

function approvalError(evaluated) {
  return evaluated.reason || '当前方案没有有效批准。';
}

/** Read-only evaluation shared by status, rendering and registration. */
async function evaluatePlan(root, state) {
  if (!state.creative) return { ok: false, reason: '还没有确认创意方向。' };
  const plan = state.plan;
  if (!plan) return { ok: false, reason: '还没有批准过这份方案。' };
  if (!isBoundPlan(plan)) return { ok: false, legacy: true, reason: NEED_REVIEW };
  if (plan.creativeDigest !== state.creative.digest) {
    return { ok: false, reason: '创意方向在批准后变了。先确认当前方向，再重审方案。' };
  }
  let current;
  try {
    current = await loadPlan(root);
  } catch (error) {
    return { ok: false, reason: '读不到 plan.md：' + error.message };
  }
  if (current.digest !== plan.digest) {
    return {
      ok: false,
      changed: true,
      reason: `plan.md 在批准后被改动（当前 ${shortDigest(current.digest)}，批准 ${shortDigest(plan.digest)}）。`
        + '重新批准当前版本后才能继续。',
    };
  }
  return { ok: true, plan, current };
}

async function requireApprovedPlan(root, state) {
  const evaluated = await evaluatePlan(root, state);
  if (!evaluated.ok) throw new Error(approvalError(evaluated));
  return evaluated.plan;
}

async function requireSample(root, state, signal) {
  const plan = await requireApprovedPlan(root, state);
  const sample = state.sample;
  if (!sample) throw new Error('当前方案还没有样片文件：先制作一次样片。');
  if (sample.bindingDigest !== plan.bindingDigest) {
    throw new Error('现有样片对应的是较早批准的制作范围（配方或样片选择已变），重新制作样片。');
  }
  let digest;
  try {
    digest = await fingerprint(root, sample.path, signal);
  } catch {
    signal?.throwIfAborted();
    throw new Error('样片文件不可读或已被删除：' + sample.path);
  }
  if (digest !== sample.digest) throw new Error('样片文件在登记后被改动：' + sample.path + '。重新制作样片。');
  return sample;
}

async function requireAcceptedSample(root, state, signal) {
  const sample = await requireSample(root, state, signal);
  const accepted = state.acceptedSample;
  if (!accepted || accepted.digest !== sample.digest || accepted.bindingDigest !== sample.bindingDigest) {
    throw new Error('The user must accept the current sample first.');
  }
  return sample;
}

function selectedPlanShots(plan) {
  const keys = new Set((plan.sampleShots ?? []).map(comparableShotId));
  return planShotsOf(plan).filter(shot => keys.has(comparableShotId(shot.id)));
}

/** Expected physical result of a stage, derived from the approved shot table and fps. */
function stageExpectation(plan, stage) {
  const canvas = routeCanvas(plan);
  const fps = canvas.fps;
  const chosen = stage === 'sample' ? selectedPlanShots(plan) : planShotsOf(plan);
  if (!chosen.length) throw new Error('批准快照里没有可用于这个阶段的镜头。');
  const selectedFrames = chosen.reduce((sum, shot) => sum + shotFrames(shot.duration, fps), 0);
  let frames = selectedFrames;
  if (stage === 'sample' && plan.sampleMaxSeconds !== null && plan.sampleMaxSeconds !== undefined) {
    frames = Math.min(selectedFrames, Math.max(1, Math.floor(plan.sampleMaxSeconds * fps + 1e-6)));
  }
  return {
    width: canvas.width,
    height: canvas.height,
    fps,
    durationSec: frames / fps,
    audio: routeAudio(plan),
  };
}

function revisedRecipe(spec, changes) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('Name the shots and adjustments.');
  const updates = new Map();
  for (const change of changes) {
    if (!['string', 'number'].includes(typeof change.id) || updates.has(String(change.id))) {
      throw new Error('Invalid or repeated shot ID.');
    }
    if (typeof change.text !== 'string' || change.text.length > 200) {
      throw new Error('The supported edit is replacement of on-screen text, up to 200 characters.');
    }
    updates.set(String(change.id), change.text);
  }
  const shots = spec.shots.map(shot => {
    const key = String(shot.id);
    if (!updates.has(key)) return shot;
    const text = updates.get(key);
    updates.delete(key);
    if (spec.version !== 1) return { ...shot, text };
    return { ...shot, text: text.trim() ? { ...shot.text, lines: text.split(/\r?\n/) } : null };
  });
  if (updates.size) throw new Error('An edited shot is not part of the current approved timeline.');
  return { ...spec, shots };
}

async function askOnce(requestApproval, ctx, question, detail, showPlan = false) {
  const receipt = identity(ctx);
  const id = `cyv-${randomUUID()}`;
  const item = {
    id,
    question,
    detail,
    options: [{ label: APPROVE }, { label: DECLINE }],
    intent: showPlan ? { kind: 'plan-review', approve: APPROVE }
      : { kind: 'approval', approve: APPROVE, reject: DECLINE },
  };
  ctx.signal?.throwIfAborted();
  const result = await requestApproval({ agent: ctx.agent, signal: ctx.signal, questions: [item] });
  ctx.signal?.throwIfAborted();
  const answer = result?.answers?.length === 1 ? result.answers[0] : null;
  if (answer?.id !== id || answer?.selected?.length !== 1 || answer.selected[0] !== APPROVE || answer.custom) {
    return null;
  }
  return { ...receipt, questionId: id, at: new Date().toISOString() };
}

function projectKey(root) {
  return digestText(process.platform === 'win32' ? root.toLowerCase() : root);
}

function blankState() {
  return { version: 2, creative: null, plan: null, sample: null, acceptedSample: null, full: null, runs: {}, legacyReview: null };
}

/** Adds in-memory defaults for an older record without writing anything back. */
function normalizeState(raw) {
  const state = raw && typeof raw === 'object' ? raw : blankState();
  return {
    version: state.version === 2 ? 2 : (state.version ?? 1),
    creative: state.creative ?? null,
    plan: state.plan ?? null,
    sample: state.sample ?? null,
    acceptedSample: state.acceptedSample ?? null,
    full: state.full ?? null,
    runs: state.runs && typeof state.runs === 'object' && !Array.isArray(state.runs) ? state.runs : {},
    legacyReview: state.legacyReview ?? null,
  };
}

export function assertStoredWorkflow(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'creative')) {
    throw new Error('Invalid production approval record.');
  }
  for (const fact of [value.creative, value.plan, value.acceptedSample].filter(Boolean)) {
    if (!fact.receipt || typeof fact.receipt.sessionId !== 'string'
      || typeof fact.receipt.callId !== 'string' || typeof fact.receipt.questionId !== 'string') {
      throw new Error('Approval record has no Host receipt.');
    }
  }
  for (const record of [value.creative, value.plan, value.sample, value.acceptedSample, value.full].filter(Boolean)) {
    if (!HEX_DIGEST.test(record.digest)) throw new Error('Invalid production approval digest.');
  }
  if (value.version === 2) {
    if (value.plan && !isBoundPlan(value.plan)) {
      throw new Error('Production approval snapshot does not match its digest binding.');
    }
    for (const run of Object.values(value.runs ?? {})) {
      if (!run || typeof run !== 'object' || !STAGES.includes(run.stage)
        || !['pending', 'completed', 'superseded'].includes(run.status)
        || typeof run.runId !== 'string' || !HEX_DIGEST.test(run.planDigest ?? '')
        || !HEX_DIGEST.test(run.executionDigest ?? '')) {
        throw new Error('Invalid production run record.');
      }
    }
  }
  return value;
}

function requireCreative(state) {
  if (!state.creative) throw new Error('The user must confirm the creative direction first.');
  return state.creative;
}

function planView(state, evaluated) {
  const plan = state.plan;
  return {
    digest: plan?.digest ?? null,
    route: plan?.route ?? null,
    sampleShots: plan?.sampleShots ?? null,
    sampleMaxSeconds: plan?.sampleMaxSeconds ?? null,
    approvedAt: plan?.approvedAt ?? null,
    engine: plan?.route === 'external' ? plan.external.engine : null,
    state: !plan ? 'none' : evaluated.ok ? 'approved' : evaluated.legacy ? 'legacy' : 'stale',
    stale: Boolean(plan) && !evaluated.ok,
    needsReview: Boolean(plan) && !evaluated.ok,
    reason: evaluated.ok ? null : approvalError(evaluated),
    legacyReview: state.legacyReview ?? null,
  };
}

async function evaluateSample(root, state, evaluated, signal) {
  const sample = state.sample;
  if (!sample) return { state: 'none', reason: '还没有样片文件。' };
  if (!evaluated.ok) {
    return { state: 'blocked', reason: '当前方案没有有效批准，样片不能沿用：' + approvalError(evaluated) };
  }
  if (sample.bindingDigest !== evaluated.plan.bindingDigest) {
    return { state: 'outdated', reason: '样片对应的是较早批准的制作范围（配方或样片选择已变），需要重新制作。' };
  }
  let digest;
  try {
    digest = await fingerprint(root, sample.path, signal);
  } catch {
    signal?.throwIfAborted();
    return { state: 'missing', reason: '样片文件不在了：' + sample.path };
  }
  if (digest !== sample.digest) {
    return { state: 'tampered', reason: '样片文件在登记后被改动：' + sample.path };
  }
  const accepted = Boolean(state.acceptedSample) && state.acceptedSample.digest === sample.digest
    && state.acceptedSample.bindingDigest === sample.bindingDigest;
  return { state: accepted ? 'accepted' : 'ready', accepted, reason: accepted ? null : '样片还没有被用户认可。' };
}

function fullView(state, evaluated) {
  const full = state.full;
  if (!full) return null;
  const current = evaluated.ok && full.bindingDigest === evaluated.plan.bindingDigest
    && Boolean(state.acceptedSample) && state.acceptedSample.digest === full.sampleDigest
    && state.acceptedSample.bindingDigest === full.bindingDigest;
  return {
    path: full.path,
    digest: full.digest,
    durationSec: full.durationSec ?? null,
    route: full.route ?? null,
    state: current ? 'current' : 'outdated',
    reason: current ? null : '这份完整成片对应较早的批准范围或样片；另存新版即可，旧文件保留。',
  };
}

function runReceipt(run, extra = {}) {
  return {
    runId: run.runId,
    stage: run.stage,
    expectation: run.expectation,
    outputPath: run.outputPath,
    planDigest: run.planDigest,
    executionDigest: run.executionDigest,
    sampleDigest: run.sampleDigest,
    shots: run.shots,
    createdAt: run.createdAt,
    ...extra,
  };
}

function withRun(runs, run) {
  const next = { ...runs, [run.runId]: run };
  // Completed runs back the current sample/full identity, so only superseded ones expire.
  const superseded = Object.values(next).filter(candidate => candidate.status === 'superseded').map(candidate => candidate.runId);
  for (const id of superseded.slice(0, Math.max(0, superseded.length - MAX_RUNS))) delete next[id];
  return next;
}

function pendingRunView(state) {
  const runs = Object.values(state.runs ?? {}).filter(run => run.status === 'pending');
  if (!runs.length) return null;
  const run = runs[runs.length - 1];
  return { runId: run.runId, stage: run.stage, expectation: run.expectation, outputPath: run.outputPath, createdAt: run.createdAt };
}

async function prepareRender(render, root, spec, shotIds, prefix, signal, sampleMaxSeconds) {
  const file = `output/${prefix}-${randomUUID()}.mp4`;
  const result = await render({ projectRoot: root, spec, shotIds, outputPath: file, signal,
    ...(sampleMaxSeconds === undefined ? {} : { sampleMaxSeconds }),
  });
  signal?.throwIfAborted();
  const digest = await fingerprint(root, file, signal);
  const durationSec = result.durationSec ?? result.duration;
  return { path: file, digest, duration: durationSec, durationSec, media: result.verified ?? null };
}

export async function withProjectLock(locks, root, operation) {
  const key = projectKey(root);
  if (locks.has(key)) throw new Error('Another video operation is running for this project.');
  locks.add(key);
  try {
    return await operation(key);
  } finally {
    locks.delete(key);
  }
}

export function createWorkflow({ store, requestApproval, inspectPlan, validateSpec, render, registerExternal, locks = new Set() }) {
  return async function workflow(project, args, ctx) {
    identity(ctx);
    const root = project.root;
    return withProjectLock(locks, root, async key => {
      const state = normalizeState(store.get(key));
      const save = async next => {
        ctx.signal?.throwIfAborted();
        // A record is only upgraded once it carries a self-proving snapshot; legacy
        // records stay as they are so opening or showing status never rewrites them.
        const record = isBoundPlan(next.plan) ? { ...next, version: 2 } : next;
        await store.put(key, assertStoredWorkflow(record));
      };
      const ask = (title, detail, showPlan) => askOnce(requestApproval, ctx, title, detail, showPlan);
      const renderFile = (spec, shots, prefix, limit) => prepareRender(render, root, spec, shots, prefix, ctx.signal, limit);
      switch (args.action) {
        case 'status': {
          const evaluated = await evaluatePlan(root, state);
          const sample = await evaluateSample(root, state, evaluated, ctx.signal);
          const full = fullView(state, evaluated);
          const recent = pendingRunView(state);
          return {
            creative: state.creative && { direction: state.creative.direction, digest: state.creative.digest },
            // Older callers read `plan`/`sample`/`full` and get null when nothing exists yet.
            plan: state.plan ? planView(state, evaluated) : null,
            sample: state.sample ? {
              path: state.sample.path ?? null,
              digest: state.sample.digest ?? null,
              route: state.sample.route ?? null,
              durationSec: state.sample.durationSec ?? null,
              planDigest: state.sample.planDigest ?? null,
              ...sample,
            } : null,
            // Kept for older callers: the accepted sample digest, or null.
            acceptedSample: sample.accepted ? state.sample?.digest ?? null : null,
            full: full && { path: full.path, digest: full.digest },
            ...(full ? { fullState: full.state, fullReason: full.reason } : {}),
            run: recent,
            planState: state.plan ? planView(state, evaluated).state : null,
            sampleState: state.sample ? sample.state : null,
            legacyReview: state.legacyReview ?? null,
          };
        }
        case 'creative': {
          const direction = requireText(args.direction, 'Creative direction');
          const digest = digestText(direction);
          if (state.creative?.digest === digest) return { approved: true, digest, reused: true };
          const receipt = await ask('确认这个创意方向？ / Confirm this creative direction?', direction);
          if (!receipt) return { approved: false };
          // A new creative direction starts a new approval history; the old record stays readable
          // only through the decision that replaced it.
          await save({ ...blankState(), creative: { direction, digest, receipt },
            legacyReview: state.legacyReview ?? null });
          return { approved: true, digest };
        }
        case 'save_plan': {
          requireCreative(state);
          requireText(args.text, 'plan.md', MAX_PLAN_BYTES);
          const current = await loadPlan(root).catch(() => null);
          if (current && current.digest === digestText(args.text)) {
            return { path: projectFile(root, 'plan.md'), digest: current.digest, unchanged: true };
          }
          return savePlan(root, args.text);
        }
        case 'read_plan':
          return loadPlan(root);
        case 'check_plan': {
          const current = await loadPlan(root);
          return { ...planReport(inspectPlan, root, current.text), digest: current.digest };
        }
        case 'approve_plan': {
          const creative = requireCreative(state);
          const current = await loadPlan(root);
          const report = planReport(inspectPlan, root, current.text);
          if (!report.pass) return { approved: false, report };
          const shots = approvalShots(report);
          const hasSpec = args.spec !== undefined && args.spec !== null;
          const hasExternal = args.external !== undefined && args.external !== null;
          if (hasSpec === hasExternal) {
            throw new Error('approve_plan 需要且只接受一个制作路线：args.spec（内置 FFmpeg）或 args.external（自选本机路线）。');
          }
          let plan;
          if (hasSpec) {
            const spec = validateSpec(args.spec, root);
            assertRecipeLayout(shots, spec, args.sampleShots, args.sampleMaxSeconds);
            const assets = await recipeAssets(root, spec, ctx.signal);
            plan = { version: 2, digest: current.digest, text: current.text, route: 'ffmpeg', spec, external: null,
              sampleShots: [...args.sampleShots], sampleMaxSeconds: args.sampleMaxSeconds ?? null,
              assets, shots, creativeDigest: creative.digest, receipt: null, approvedAt: null, bindingDigest: null };
          } else {
            const external = validateExternal(args.external);
            assertSampleSelection(shots, args.sampleShots, args.sampleMaxSeconds, external.canvas.fps);
            const inputs = [];
            for (const path of external.inputPaths) {
              inputs.push({ path, digest: await pinnedDigest(root, path, ctx.signal, '批准时固定的项目输入') });
            }
            plan = { version: 2, digest: current.digest, text: current.text, route: 'external', spec: null,
              external: { engine: external.engine, inputs, canvas: external.canvas, audio: external.audio },
              sampleShots: [...args.sampleShots], sampleMaxSeconds: args.sampleMaxSeconds ?? null,
              assets: [], shots, creativeDigest: creative.digest, receipt: null, approvedAt: null, bindingDigest: null };
          }
          plan.bindingDigest = bindingDigestOf(plan);
          const previous = state.plan;
          if (previous && isBoundPlan(previous) && previous.bindingDigest === plan.bindingDigest) {
            // Same snapshot, same route, same sample scope: this exact scope is already approved.
            return { approved: true, digest: current.digest, route: plan.route, needsUser: false, reused: true,
              note: '同一方案正文、同一制作范围与样片选择：沿用这次批准。' };
          }
          const legacy = Boolean(previous) && !isBoundPlan(previous);
          const detail = approvalDetail(current, plan);
          const receipt = await ask('批准这个完整方案版本并制作小样？ / Approve this plan version for sample production?', detail, true);
          if (!receipt) {
            if (legacy) {
              await save({ ...state, legacyReview: {
                planDigest: previous.digest ?? null, askedAt: new Date().toISOString(), declined: true } });
            }
            return { approved: false };
          }
          if ((await loadPlan(root)).digest !== current.digest) throw new Error('plan.md changed while awaiting approval.');
          const approved = { ...plan, receipt, approvedAt: receipt.at };
          approved.bindingDigest = bindingDigestOf(approved);
          await assertPinnedInputs(root, approved, ctx.signal);
          await save({ ...state, creative, plan: approved,
            ...(legacy ? { legacyReview: { planDigest: previous.digest ?? null, askedAt: receipt.at, declined: false } } : {}) });
          return { approved: true, digest: current.digest, route: plan.route, needsUser: true,
            ...(legacy ? { recheckedLegacy: true } : {}) };
        }
        case 'render_sample': {
          const plan = await requireApprovedPlan(root, state);
          if (plan.route !== 'ffmpeg') {
            throw new Error('这个方案批准的是自选本机路线：用 prepare_run 准备、register_artifact 登记实际成片。');
          }
          await assertPinnedInputs(root, plan, ctx.signal);
          let spec = plan.spec;
          if (args.changes !== undefined) {
            requireText(args.feedback, 'Sample feedback');
            if (args.changes.some(change => !plan.sampleShots.some(id => String(id) === String(change.id)))) {
              throw new Error('Sample corrections must target sampled shots.');
            }
            const lastRecipe = state.sample?.bindingDigest === plan.bindingDigest ? state.sample.spec : spec;
            spec = validateSpec(revisedRecipe(lastRecipe, args.changes), root);
          }
          const execution = executionDigestOf(plan);
          const media = await renderFile(spec, plan.sampleShots, 'sample', plan.sampleMaxSeconds ?? undefined);
          const after = await requireApprovedPlan(root, state);
          if (after.bindingDigest !== plan.bindingDigest) {
            throw new Error('渲染期间批准范围变了，这次结果没有记为当前样片。');
          }
          await assertPinnedInputs(root, after, ctx.signal);
          const sample = { ...media, spec, route: 'ffmpeg', planDigest: plan.digest, bindingDigest: plan.bindingDigest,
            executionDigest: execution,
            width: routeCanvas(plan).width, height: routeCanvas(plan).height, fps: routeCanvas(plan).fps,
            audio: routeAudio(plan), runId: null };
          await save({ ...state, sample, acceptedSample: null });
          return { ...media, project: root, needsSampleApproval: true };
        }
        case 'approve_sample': {
          const sample = await requireSample(root, state, ctx.signal);
          await assertPinnedInputs(root, state.plan, ctx.signal);
          if (state.acceptedSample?.digest === sample.digest && state.acceptedSample?.bindingDigest === sample.bindingDigest) {
            return { approved: true, path: sample.path, reused: true };
          }
          const detail = `项目 / Project: ${root}\n小样 / Sample: ${sample.path}\n方案 / Plan: ${state.plan.digest}\n`
            + `小样校验 / Sample SHA-256: ${sample.digest}\n`
            + (sample.route === 'external' ? `路线 / Route: 自选本机 · ${state.plan.external.engine}\n` : '')
            + '\n认可后将允许制作完整成片。Approval allows full production.';
          const receipt = await ask('认可当前小样并开始全片制作？ / Accept this sample and allow full production?', detail);
          if (!receipt) return { approved: false };
          const confirmed = await requireSample(root, state, ctx.signal);
          await assertPinnedInputs(root, state.plan, ctx.signal);
          await save({ ...state, acceptedSample: { digest: confirmed.digest, planDigest: confirmed.planDigest,
            bindingDigest: confirmed.bindingDigest, path: confirmed.path, runId: confirmed.runId ?? null, receipt } });
          return { approved: true, path: confirmed.path };
        }
        case 'render_full':
        case 'revise_full': {
          const plan = await requireApprovedPlan(root, state);
          if (plan.route !== 'ffmpeg') {
            throw new Error('这个方案批准的是自选本机路线：用 prepare_run（stage=full / revision）与 register_artifact。');
          }
          const sample = await requireAcceptedSample(root, state, ctx.signal);
          await assertPinnedInputs(root, plan, ctx.signal);
          // A complete version is only a base for this exact accepted sample: re-making and
          // re-accepting a different sample under the same binding retires the older spec.
          const currentFull = state.full?.bindingDigest === plan.bindingDigest
            && state.full?.sampleDigest === sample.digest;
          let spec = currentFull ? state.full.spec : sample.spec;
          if (args.action === 'revise_full') {
            if (!currentFull) {
              throw new Error('Render the complete video for this accepted sample before revising it.');
            }
            requireText(args.feedback, 'User feedback');
            spec = validateSpec(revisedRecipe(spec, args.changes), root);
          }
          const execution = executionDigestOf(plan);
          const media = await renderFile(spec, undefined, 'video');
          const after = await requireAcceptedSample(root, state, ctx.signal);
          if (after.digest !== sample.digest) throw new Error('渲染期间样片变了，这次结果没有记为完整成片。');
          if ((await requireApprovedPlan(root, state)).bindingDigest !== plan.bindingDigest) {
            throw new Error('渲染期间批准范围变了，这次结果没有记为完整成片。');
          }
          await assertPinnedInputs(root, plan, ctx.signal);
          const full = { ...media, spec, route: 'ffmpeg', planDigest: plan.digest, bindingDigest: plan.bindingDigest,
            sampleDigest: sample.digest, executionDigest: execution, runId: null };
          await save({ ...state, full });
          return { ...media, project: root };
        }
        case 'prepare_run': {
          const plan = await requireApprovedPlan(root, state);
          if (plan.route !== 'external') {
            throw new Error('内置 FFmpeg 路线直接用 render_sample 与 render_full；prepare_run 只用于自选本机路线。');
          }
          if (typeof registerExternal !== 'function') {
            throw new Error('The Host did not provide external artifact registration for this session.');
          }
          if (!STAGES.includes(args.stage)) throw new Error('prepare_run 的 stage 必须是 sample / full / revision。');
          const stage = args.stage;
          await assertPinnedInputs(root, plan, ctx.signal);
          let sampleDigest = null;
          let feedback = null;
          if (stage !== 'sample') {
            const sample = await requireAcceptedSample(root, state, ctx.signal);
            sampleDigest = sample.digest;
          }
          if (stage === 'revision') {
            if (!state.full || state.full.bindingDigest !== plan.bindingDigest
              || state.full.sampleDigest !== sampleDigest) {
              throw new Error('先按当前批准与当前样片登记一份完整成片，再准备修订。');
            }
            feedback = requireText(args.feedback, 'Revision feedback');
          }
          const expectation = stageExpectation(plan, stage);
          const execution = executionDigestOf(plan);
          const pending = Object.values(state.runs).find(run => run.status === 'pending'
            && run.stage === stage && run.bindingDigest === plan.bindingDigest
            && run.sampleDigest === sampleDigest && run.feedback === feedback
            && sameValue(run.expectation, expectation));
          if (pending) return runReceipt(pending, { reused: true });
          const runId = randomUUID();
          const run = {
            runId,
            stage,
            status: 'pending',
            planDigest: plan.digest,
            bindingDigest: plan.bindingDigest,
            executionDigest: execution,
            sampleDigest,
            expectation,
            outputPath: `output/${stage === 'sample' ? 'sample' : 'video'}-${runId}.mp4`,
            shots: (stage === 'sample' ? selectedPlanShots(plan) : planShotsOf(plan))
              .map(shot => ({ id: shot.id, durationSec: shot.duration })),
            feedback,
            createdAt: new Date().toISOString(),
          };
          const runs = { ...state.runs };
          for (const [id, other] of Object.entries(runs)) {
            if (other.status === 'pending') runs[id] = { ...other, status: 'superseded', supersededAt: new Date().toISOString() };
          }
          await save({ ...state, runs: withRun(runs, run) });
          return runReceipt(run);
        }
        case 'register_artifact': {
          if (typeof registerExternal !== 'function') {
            throw new Error('The Host did not provide external artifact registration for this session.');
          }
          const runId = requireText(args.runId, 'register_artifact.runId', 200);
          const run = state.runs[runId];
          if (!run) throw new Error('没有这个制作任务：先 prepare_run，再用它返回的 runId 登记成片。');
          const source = requireText(args.source, 'register_artifact.source', 1000);
          existingProjectFile(root, source); // must be an existing regular file inside the project
          const plan = await requireApprovedPlan(root, state);
          if (plan.route !== 'external') {
            throw new Error('内置 FFmpeg 路线不需要登记外部成片。');
          }
          if (run.bindingDigest !== plan.bindingDigest || run.planDigest !== plan.digest
            || run.executionDigest !== executionDigestOf(plan)) {
            throw new Error('这个 run 是在不同的批准范围下准备的，已被替代：重新 prepare_run。');
          }
          if (run.stage !== 'sample') {
            await requireAcceptedSample(root, state, ctx.signal);
            if (run.sampleDigest !== state.sample.digest) {
              throw new Error('这个 run 对应的样片已被替代：重新 prepare_run。');
            }
            if (run.stage === 'revision' && (!state.full || state.full.bindingDigest !== plan.bindingDigest
              || state.full.sampleDigest !== run.sampleDigest)) {
              throw new Error('这个修订任务对应的完整成片已不在当前批准与样片下：重新 prepare_run。');
            }
          }
          await assertPinnedInputs(root, plan, ctx.signal);
          const sourceDigest = await pinnedDigest(root, source, ctx.signal, '待登记成片');
          if (run.status === 'completed') {
            if (run.artifact.sourceDigest !== sourceDigest) {
              throw new Error('这个 run 已完成并登记了另一份成片；换文件要重新 prepare_run。');
            }
            const published = await fingerprint(root, run.artifact.path, ctx.signal).catch(() => null);
            if (published !== run.artifact.digest) throw new Error('已登记的成片文件被改动或不在原位：' + run.artifact.path);
            return { ...run.artifact, runId, stage: run.stage, project: root, reused: true };
          }
          if (run.status !== 'pending') throw new Error('这个 run 已被替代：重新 prepare_run。');
          let result;
          try {
            result = await registerExternal({ projectRoot: root, sourcePath: source, outputPath: run.outputPath,
              expectation: run.expectation, signal: ctx.signal });
          } catch (error) {
            ctx.signal?.throwIfAborted();
            if (error?.code !== 'E_OUTPUT_EXISTS') throw error;
            // Recover a prior publication only with fresh technical evidence for those same bytes.
            const existing = await fingerprint(root, run.outputPath, ctx.signal).catch(() => null);
            const reverified = error.details?.artifact;
            if (!reverified?.verified || reverified.sha256 !== existing || existing !== sourceDigest) {
              await save({ ...state, runs: withRun(state.runs, { ...run, status: 'superseded',
                supersededAt: new Date().toISOString() }) });
              throw new Error('登记目标已存在且不是这次候选原件，不覆盖旧成品；重新 prepare_run 会得到一个新区段。',
                { cause: error });
            }
            result = reverified;
          }
          ctx.signal?.throwIfAborted();
          const confirmed = await requireApprovedPlan(root, state);
          if (confirmed.bindingDigest !== plan.bindingDigest) {
            throw new Error('登记期间批准范围变了，没有把这个文件记为当前成片。');
          }
          if (run.stage !== 'sample') await requireAcceptedSample(root, state, ctx.signal);
          await assertPinnedInputs(root, confirmed, ctx.signal);
          if (await pinnedDigest(root, source, ctx.signal, '待登记成片') !== sourceDigest) {
            throw new Error('登记期间源文件发生变化，没有把这个文件记为当前成片。');
          }
          const published = await fingerprint(root, run.outputPath, ctx.signal);
          if (!result || !result.verified) {
            throw new Error('外部成片没有通过技术验证，没有更新当前状态。');
          }
          if (typeof result.sha256 !== 'string' || result.sha256 !== published) {
            throw new Error('发布文件指纹与验证结果不一致，没有更新当前状态。');
          }
          // Adoption copies bytes without re-encoding, so the published file must be the source.
          if (published !== sourceDigest) {
            throw new Error('发布文件与候选原件字节不一致，没有更新当前状态。');
          }
          const durationSec = Number(result.durationSec);
          if (!Number.isFinite(durationSec) || durationSec <= 0) {
            throw new Error('外部成片没有可用的时长，没有更新当前状态。');
          }
          const tolerance = Math.max(0.5, 3 / run.expectation.fps);
          if (Math.abs(durationSec - run.expectation.durationSec) > tolerance) {
            await save({ ...state, runs: withRun(state.runs, { ...run, status: 'superseded',
              supersededAt: new Date().toISOString() }) });
            throw new Error('外部成片时长与这个阶段按镜头推导的期望相差过大，没有更新当前状态；重新 prepare_run。');
          }
          const artifact = { path: run.outputPath, digest: published, durationSec, source, sourceDigest,
            verified: result.verified, runId, bindingDigest: plan.bindingDigest, at: new Date().toISOString() };
          const completed = { ...run, status: 'completed', artifact, completedAt: artifact.at };
          if (run.stage === 'sample') {
            const sample = { path: artifact.path, digest: artifact.digest, durationSec,
              width: run.expectation.width, height: run.expectation.height, fps: run.expectation.fps,
              audio: run.expectation.audio, planDigest: plan.digest, bindingDigest: plan.bindingDigest,
              route: 'external', executionDigest: run.executionDigest, runId, verified: result.verified };
            await save({ ...state, sample, acceptedSample: null, runs: withRun(state.runs, completed) });
            return { ...artifact, stage: 'sample', needsSampleApproval: true,
              outputPath: artifact.path, expectation: run.expectation, project: root };
          }
          const full = { path: artifact.path, digest: artifact.digest, durationSec,
            width: run.expectation.width, height: run.expectation.height, fps: run.expectation.fps,
            audio: run.expectation.audio, planDigest: plan.digest, bindingDigest: plan.bindingDigest,
            sampleDigest: run.sampleDigest, route: 'external', executionDigest: run.executionDigest,
            runId, verified: result.verified };
          await save({ ...state, full, runs: withRun(state.runs, completed) });
          return { ...artifact, stage: run.stage, expectation: run.expectation, project: root };
        }
        default:
          throw new Error('Unknown video workflow action.');
      }
    });
  };
}

function approvalDetail(current, plan) {
  const sampleLine = `小样镜头 / Sample shots: ${plan.sampleShots.join(', ')}`
    + (plan.sampleMaxSeconds === null ? '' : `，最长 ${plan.sampleMaxSeconds} 秒`);
  if (plan.route === 'external') {
    const inputs = plan.external.inputs.length
      ? plan.external.inputs.map(file => `- ${file.path} (${shortDigest(file.digest)})`).join('\n')
      : '- （未声明固定输入 / none declared）';
    return `${current.text}\n\n---\n\n版本 / Version: \`${current.digest}\`\n\n`
      + `路线 / Route: 自选本机 · ${plan.external.engine}\n`
      + `画幅 / Canvas: ${plan.external.canvas.width}x${plan.external.canvas.height} @ ${plan.external.canvas.fps}fps\n`
      + `声音 / Audio: ${plan.external.audio}\n\n`
      + `固定输入 / Pinned inputs\n\n${inputs}\n\n${sampleLine}`;
  }
  return `${current.text}\n\n---\n\n版本 / Version: \`${current.digest}\`\n\n${sampleLine}`
    + `\n\n制作参数 / Production recipe\n\n\`\`\`json\n${JSON.stringify(plan.spec, null, 2)}\n\`\`\``;
}

export { askOnce, existingProjectFile, projectFile };
