import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const MAX_PLAN_BYTES = 512 * 1024;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const APPROVE = '认可并授权所述范围 / Approve this scope';
const DECLINE = '返回修改 / Request changes';

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

async function recipeAssets(root, spec, signal) {
  const paths = new Set(spec.shots.map(shot => shot.visual?.path).filter(Boolean));
  if (spec.audio?.path) paths.add(spec.audio.path);
  const files = [];
  for (const path of paths) files.push({ path, digest: await fingerprint(root, path, signal) });
  return files;
}

async function assertRecipeAssets(root, plan, signal) {
  for (const file of plan.assets) {
    if (await fingerprint(root, file.path, signal) !== file.digest) {
      throw new Error(`The approved source changed: ${file.path}.`);
    }
  }
}

function assertLayout(plan, spec, sampleShots, sampleMaxSeconds) {
  if (!Array.isArray(plan.shots) || !plan.shots.length || spec.shots.length !== plan.shots.length) {
    throw new Error('The recipe must implement every planned shot exactly once.');
  }
  for (const [index, shot] of plan.shots.entries()) {
    const actual = spec.shots[index];
    if (comparableShotId(shot.id) !== comparableShotId(actual.id)
      || Math.abs(shot.duration - (actual.durationSec ?? actual.duration)) > 0.001) {
      throw new Error(`Recipe shot ${actual.id} does not match the order, ID and duration in plan.md.`);
    }
  }
  if (!Array.isArray(sampleShots) || !sampleShots.length || new Set(sampleShots).size !== sampleShots.length) {
    throw new Error('Select unique shot IDs for the sample.');
  }
  const actualIds = new Set(spec.shots.map(shot => shot.id));
  if (sampleShots.some(id => !actualIds.has(id))) throw new Error('The sample contains an unplanned shot.');
  const selected = spec.shots.filter(shot => sampleShots.includes(shot.id));
  if (sampleMaxSeconds !== undefined) {
    const fps = spec.canvas?.fps;
    const requestedFrames = Math.floor(sampleMaxSeconds * fps + 1e-6);
    const selectedFrames = selected.reduce((sum, shot) => sum + Math.round(shot.durationSec * fps), 0);
    if (!Number.isSafeInteger(requestedFrames) || requestedFrames < 1 || requestedFrames >= selectedFrames) {
      throw new Error('The sample time limit must cover one or more frames and end before its selected shots.');
    }
  }
  if (sampleShots.length === actualIds.size && sampleMaxSeconds === undefined) {
    throw new Error('Use a representative subset of shots or specify a shorter sample time limit.');
  }
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
  if (answer?.id !== id || answer.selected?.length !== 1 || answer.selected[0] !== APPROVE || answer.custom) {
    return null;
  }
  return { ...receipt, questionId: id, at: new Date().toISOString() };
}

function projectKey(root) {
  return digestText(process.platform === 'win32' ? root.toLowerCase() : root);
}

function blankState() {
  return { creative: null, plan: null, sample: null, acceptedSample: null, full: null };
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
  return value;
}

function requireCreative(state) {
  if (!state.creative) throw new Error('The user must confirm the creative direction first.');
  return state.creative;
}

async function requirePlan(root, state) {
  const creative = requireCreative(state);
  const current = await loadPlan(root);
  if (!state.plan || state.plan.digest !== current.digest || state.plan.creativeDigest !== creative.digest) {
    throw new Error('The current complete plan version needs user approval.');
  }
  return state.plan;
}

async function requireSample(root, state, signal) {
  const plan = await requirePlan(root, state);
  const sample = state.sample;
  if (!sample || sample.planDigest !== plan.digest || await fingerprint(root, sample.path, signal) !== sample.digest) {
    throw new Error('The current plan has no intact rendered sample.');
  }
  return sample;
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

function summary(state) {
  const { creative, plan, sample, acceptedSample, full } = state;
  return {
    creative: creative && { direction: creative.direction, digest: creative.digest },
    plan: plan && { digest: plan.digest, sampleShots: plan.sampleShots },
    sample: sample && { path: sample.path, digest: sample.digest },
    acceptedSample: acceptedSample?.digest ?? null,
    full: full && { path: full.path, digest: full.digest },
  };
}

async function prepareRender(render, root, spec, shotIds, prefix, signal, sampleMaxSeconds) {
  const file = `output/${prefix}-${randomUUID()}.mp4`;
  const result = await render({ projectRoot: root, spec, shotIds, outputPath: file, signal,
    ...(sampleMaxSeconds === undefined ? {} : { sampleMaxSeconds }),
  });
  signal?.throwIfAborted();
  const digest = await fingerprint(root, file, signal);
  return { path: file, digest, duration: result.durationSec ?? result.duration, media: result.verified ?? null };
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

export function createWorkflow({ store, requestApproval, inspectPlan, validateSpec, render, locks = new Set() }) {
  return async function workflow(project, args, ctx) {
    identity(ctx);
    const root = project.root;
    return withProjectLock(locks, root, async key => {
      const state = store.get(key) ?? blankState();
      const save = async next => {
        ctx.signal?.throwIfAborted();
        await store.put(key, assertStoredWorkflow(next));
      };
      const ask = (title, detail, showPlan) => askOnce(requestApproval, ctx, title, detail, showPlan);
      const renderFile = (spec, shots, prefix, limit) => prepareRender(render, root, spec, shots, prefix, ctx.signal, limit);
      switch (args.action) {
        case 'status': {
          const result = summary(state);
          if (state.plan) {
            try { await requirePlan(root, state); } catch { result.plan.stale = true; }
          }
          return result;
        }
        case 'creative': {
          const direction = requireText(args.direction, 'Creative direction');
          const digest = digestText(direction);
          if (state.creative?.digest === digest) return { approved: true, digest };
          const receipt = await ask('确认这个创意方向？ / Confirm this creative direction?', direction);
          if (!receipt) return { approved: false };
          await save({ ...blankState(), creative: { direction, digest, receipt } });
          return { approved: true, digest };
        }
        case 'save_plan':
          requireCreative(state);
          return savePlan(root, args.text);
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
          const spec = validateSpec(args.spec, root);
          assertLayout(report, spec, args.sampleShots, args.sampleMaxSeconds);
          const assets = await recipeAssets(root, spec, ctx.signal);
          const previous = state.plan;
          if (previous?.digest === current.digest && sameValue(previous.spec, spec)
            && sameValue(previous.sampleShots, args.sampleShots) && previous.sampleMaxSeconds === (args.sampleMaxSeconds ?? null)
            && sameValue(previous.assets, assets)) {
            return { approved: true, digest: current.digest };
          }
          const detail = `${current.text}\n\n---\n\n版本 / Version: \`${current.digest}\`\n\n小样镜头 / Sample shots: ${args.sampleShots.join(', ')}${args.sampleMaxSeconds === undefined ? '' : `，最长 ${args.sampleMaxSeconds} 秒`}\n\n制作参数 / Production recipe\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``;
          const receipt = await ask('批准这个完整方案版本并制作小样？ / Approve this plan version for sample production?', detail, true);
          if (!receipt) return { approved: false };
          if ((await loadPlan(root)).digest !== current.digest) throw new Error('plan.md changed while awaiting approval.');
          const plan = { ...current, creativeDigest: creative.digest, spec, sampleShots: args.sampleShots, sampleMaxSeconds: args.sampleMaxSeconds ?? null, assets, receipt };
          await assertRecipeAssets(root, plan, ctx.signal);
          await save({ ...blankState(), creative, plan });
          return { approved: true, digest: current.digest };
        }
        case 'render_sample': {
          const plan = await requirePlan(root, state);
          await assertRecipeAssets(root, plan, ctx.signal);
          let spec = plan.spec;
          if (args.changes !== undefined) {
            requireText(args.feedback, 'Sample feedback');
            if (args.changes.some(change => !plan.sampleShots.some(id => String(id) === String(change.id)))) {
              throw new Error('Sample corrections must target sampled shots.');
            }
            const lastRecipe = state.sample?.planDigest === plan.digest ? state.sample.spec : spec;
            spec = validateSpec(revisedRecipe(lastRecipe, args.changes), root);
          }
          const media = await renderFile(spec, plan.sampleShots, 'sample', plan.sampleMaxSeconds ?? undefined);
          await requirePlan(root, state);
          await assertRecipeAssets(root, plan, ctx.signal);
          const sample = { ...media, spec, planDigest: plan.digest };
          await save({ ...state, sample, acceptedSample: null, full: null });
          return { ...media, project: root, needsSampleApproval: true };
        }
        case 'approve_sample': {
          const sample = await requireSample(root, state, ctx.signal);
          if (state.acceptedSample?.digest === sample.digest) return { approved: true, path: sample.path };
          const detail = `项目 / Project: ${root}\n小样 / Sample: ${sample.path}\n方案 / Plan: ${sample.planDigest}\n小样校验 / Sample SHA-256: ${sample.digest}\n\n认可后将允许制作完整成片。Approval allows full production.`;
          const receipt = await ask('认可当前小样并开始全片制作？ / Accept this sample and allow full production?', detail);
          if (!receipt) return { approved: false };
          await requireSample(root, state, ctx.signal);
          await save({ ...state, acceptedSample: { digest: sample.digest, receipt } });
          return { approved: true, path: sample.path };
        }
        case 'render_full':
        case 'revise_full': {
          const sample = await requireSample(root, state, ctx.signal);
          if (state.acceptedSample?.digest !== sample.digest) throw new Error('The user must accept the current sample first.');
          await assertRecipeAssets(root, state.plan, ctx.signal);
          let spec = state.full?.spec ?? sample.spec;
          if (args.action === 'revise_full') {
            if (!state.full) throw new Error('Render the complete video before revising it.');
            requireText(args.feedback, 'User feedback');
            spec = validateSpec(revisedRecipe(spec, args.changes), root);
          }
          const media = await renderFile(spec, undefined, 'video');
          await requireSample(root, state, ctx.signal);
          await assertRecipeAssets(root, state.plan, ctx.signal);
          await save({ ...state, full: { ...media, spec, planDigest: sample.planDigest } });
          return { ...media, project: root };
        }
        default:
          throw new Error('Unknown video workflow action.');
      }
    });
  };
}

export { askOnce, existingProjectFile, projectFile };
