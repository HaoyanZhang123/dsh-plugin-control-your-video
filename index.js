/**
 * control-your-video 的 evidence 工具（薄壳）。
 *
 * 只做三件事：把模型给的参数翻成命令行、跑 tools/evidence.js、把结果收成一段文本。
 * 业务逻辑全在 tools/evidence.js，本文件不重复任何规则；脚本也能人手直接跑。
 *
 * 为什么要这层壳：模型不必知道脚本在包里的哪个相对路径，也不必自己拼参数名。
 *
 * 为什么不用 `defineTool`：本包以本地链接方式装在 profile 里，
 * `@deepseek-ai/dsh-tools` 只存在于 dsh 安装目录，从链接位置解析不到，
 * import 失败会让整个 Preset 激活失败。这里按 `ctx.tools.register` 接受的
 * 普通定义对象来写（parameters 用 JSON Schema），与本机其他可用插件一致。
 */

import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createWorkflow, askOnce, existingProjectFile, withProjectLock } from './tools/workflow.js';
import { discoverLocalCapabilities, discoverMediaModels, executeOneMediaRequest } from './tools/capabilities.js';

const executeFile = promisify(execFile);

/** 包内脚本位置：本文件在包根，脚本在 tools/ 下。 */
const SCRIPT = fileURLToPath(new URL('./tools/evidence.js', import.meta.url));

/** 与脚本保持一致的枚举，只用于给模型看；真正的校验在脚本里。 */
const PURPOSES = ['look', 'seam', 'text', 'motion', 'sync', 'mix', 'cover'];
const KINDS = ['duration', 'black', 'loudness', 'silence'];
const STATUSES = ['current', 'superseded', 'all'];

/** 每个动作接受的 flag。超出的参数直接忽略，避免转发出脚本不认识的东西。 */
const FLAGS = {
  extract: ['dir', 'source', 'revision', 'shot', 't', 'purpose', 'question', 'crop', 'force'],
  measure: ['dir', 'source', 'revision', 'shot', 'kind', 't', 'purpose'],
  recall: ['dir', 'shot', 'revision', 'purpose', 'status', 'from', 'to', 'id'],
  gc: ['dir', 'yes'],
  'plan-check': ['dir'],
};

/** 无值开关。 */
const BOOLEAN_FLAGS = new Set(['force', 'yes']);

/** 输出上限：超过就截断并显式说明，不把整段日志倒进上下文。 */
const MAX_OUTPUT = 4000;

const TIMEOUT_MS = 120000;

function buildArgv(action, args) {
  const allowed = FLAGS[action];
  if (!allowed) throw new Error(`未知动作 ${action}；只有 extract / measure / recall / gc / plan-check。`);

  const argv = [action];
  for (const key of allowed) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    if (BOOLEAN_FLAGS.has(key)) {
      if (value === true) argv.push(`--${key}`);
      continue;
    }
    argv.push(`--${key}`, String(value));
  }

  if (!args.dir) throw new Error('缺少 dir：要给作品文件夹（plan-check）或证据目录（其余动作）的绝对路径。');
  if ((action === 'extract' || action === 'measure') && !args.source) {
    throw new Error(`action=${action} 需要 source：要给被取证的成片路径。`);
  }

  return argv;
}

function clip(text) {
  if (!text) return '';
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n\n[已截断：原文 ${text.length} 字符，只保留前 ${MAX_OUTPUT}]`;
}

async function run(argv, workspace, signal) {
  try {
    const { stdout, stderr } = await executeFile(process.execPath, [SCRIPT, ...argv], {
      cwd: workspace,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      signal,
      windowsHide: true,
    });
    return clip(stdout.trim() || stderr.trim());
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(clip(error.stderr?.trim() || error.stdout?.trim() || error.message), { cause: error });
  }
}

/** 模型可见的参数 schema（JSON Schema，按 ctx.tools.register 接受的形状）。 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'project'],
  properties: {
    action: {
      type: 'string',
      enum: ['extract', 'measure', 'recall', 'plan-check'],
      description: '抽帧、测量时长/黑帧/响度、查本项目证据或检查当前计划。',
    },
    project: { type: 'string', description: '相对于当前工作区的已存在作品目录。' },
    source: {
      type: 'string',
      description: 'extract 与 measure 必填：被取证的成片或素材路径。',
    },
    revision: {
      type: 'string',
      description:
        '修订标识，例如 r3。同一修订内证据可互相对照；重渲后要换新修订。measure 不给时记为 r-unset（表示"这次没挂到具体修订上"）。',
    },
    shot: {
      type: 'integer',
      description: '镜号，与作品 plan.md 的镜号一致。recall 时用它缩小范围。',
    },
    t: {
      type: 'number',
      description: '时间点（秒）。extract 时是要取的那一秒；measure 时视 kind 需要。',
    },
    purpose: {
      type: 'string',
      enum: PURPOSES,
      description: '这次取证的用途，决定条目的去重键与后续筛选。',
    },
    question: {
      type: 'string',
      description: 'extract 可选：这次要看的问题，写进条目，方便日后知道为什么看这一帧。',
    },
    crop: {
      type: 'string',
      description: 'extract 可选：裁剪区域，格式 x,y,w,h，基于原帧像素。裁剪是派生图，会标来源。',
    },
    kind: {
      type: 'string',
      enum: KINDS,
      description: 'measure 必填：要测什么。',
    },
    from: { type: 'number', description: 'recall 可选：时间下界（秒）。' },
    to: { type: 'number', description: 'recall 可选：时间上界（秒）。' },
    status: {
      type: 'string',
      enum: STATUSES,
      description: 'recall 可选：默认只返回 current。',
    },
    id: { type: 'string', description: 'recall 可选：按条目 id 取单条。' },
    force: { type: 'boolean', description: 'extract 可选：同键已存在时覆盖重取。默认不覆盖。' },
  },
};

const DESCRIPTION =
  '从成片取真实画面与确定性测量，并维护作品内的证据索引。用于审片取证、修改前后对照、找回之前看过的帧。' +
  '只记录被看过的那一帧，不预抽全片，不判断画面好坏。';

const TEXT = { type: 'string' };
const TEXT_LIST = { type: 'array', items: TEXT };
const ACTIONS = [
  'create', 'open', 'import_assets', 'status', 'creative', 'save_plan', 'read_plan',
  'check_plan', 'approve_plan', 'render_sample', 'approve_sample', 'render_full',
  'revise_full', 'local_capabilities', 'media_models', 'subtitle_edit', 'save_experience',
  'read_reference', 'read_experience', 'list_assets', 'generate_one_asset',
];

const WORKFLOW_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ACTIONS },
    project: { ...TEXT, description: '当前工作区下的作品目录。项目动作必填。' },
    sources: { ...TEXT_LIST, description: '仅填当前用户提供或明确授权的现有本地素材路径。' },
    direction: { ...TEXT, description: 'creative 待用户确认的创意方向和关键保留项。' },
    text: { ...TEXT, description: 'save_plan 的完整 Markdown 或局部字幕文字。' },
    spec: { type: 'object', additionalProperties: true, description: 'approve_plan 的 FFmpeg 制作清单。先看 local_capabilities。' },
    sampleShots: { type: 'array', items: { type: 'integer' }, description: '最能验证方案关键效果的镜头 ID。' },
    sampleMaxSeconds: { type: 'number', description: '可选的小样时长上限。包含所有镜头时必填，须短于所选镜头总时长。' },
    feedback: { ...TEXT, description: '该轮已澄清的用户反馈。' },
    changes: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['id', 'text'],
        properties: { id: { type: 'integer' }, text: TEXT },
      },
    },
    source: { ...TEXT, description: '字幕或可选经验沉淀所用的项目内相对文件路径。' },
    title: TEXT,
    scene: { ...TEXT, description: '条目按这个使用场景归类。' },
    notes: { ...TEXT, description: '适用条件、推荐理由、验证程度。' },
    resolution: { type: 'string', enum: ['fail', 'skip', 'keep-both', 'replace', 'merge'] },
    query: { ...TEXT, description: '用户允许查阅历史库后要找的具体内容。' },
    provider: TEXT,
    model: TEXT,
    currency: TEXT,
    costLimit: { type: 'integer', description: '此操作授权的最小货币单位数，例如分。' },
    counter: { ...TEXT, description: '该经验的适用边界或反例。' },
  },
};

export const inject = ['tools', 'userQuestions', 'workingDirectory', 'controlYourVideoStore', 'agents'];

function hostProjectScope(ctx, execution) {
  const agent = execution.agent;
  if (!agent || ctx.agents.get(agent.id) !== agent || agent.session.header.origin === 'subagent') {
    throw new Error('This action requires a live root video session.');
  }
  return ctx.workingDirectory.get(agent.session);
}

async function ensurePlainDirectories(root, directories) {
  let current = root;
  for (const part of directories) {
    current = join(current, part);
    await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Expected an ordinary project directory.');
  }
  return current;
}

const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.wav', '.mp3', '.aac', '.flac', '.m4a', '.ogg']);

const RECIPE_GUIDE = {
  version: 1,
  canvas: { width: 640, height: 360, fps: 24 },
  audio: { mode: 'none' },
  shots: [{
    id: 1, durationSec: 2,
    visual: { kind: 'procedural', pattern: 'gradient-drift', colors: { base: '#0B1020', accent: '#E0B060' }, speed: 1 },
    text: { lines: ['示例字幕'], position: 'bottom' },
  }],
  alternatives: {
    visual: ['procedural: gradient-drift, bars-sweep, grid-drift, pulse-field', 'photo: path, fit, motion', 'video: path, startSec, fit, loop'],
    audio: ['none', 'tone: frequencyHz, gainDb', 'asset: path, loop'],
    fit: ['cover', 'contain'],
  },
};

async function editLocalSubtitle(project, args, execution, requestApproval, production) {
  if (!args.text?.trim() || args.text.length > 500) throw new Error('Provide the exact replacement caption.');
  const input = existingProjectFile(project.root, args.source);
  const { stdout } = await executeFile('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
    'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', '-i', input,
  ], { signal: execution.signal, timeout: 10000, windowsHide: true, maxBuffer: 64 * 1024 });
  const info = JSON.parse(stdout);
  const video = info.streams?.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('The source must already contain video.');
  const duration = Number(info.format?.duration);
  const [frames, seconds] = video.r_frame_rate.split('/').map(Number);
  const fps = Math.round(frames / seconds);
  if (duration < 0.2 || !Number.isFinite(duration) || duration > 60) {
    throw new Error('The first local subtitle adapter supports an existing clip up to 60 seconds.');
  }
  const recipe = {
    version: 1,
    canvas: { width: video.width, height: video.height, fps },
    audio: info.streams.some(stream => stream.codec_type === 'audio') ? { mode: 'asset', path: args.source } : { mode: 'none' },
    shots: [{ id: 1, durationSec: duration, visual: { kind: 'video', path: args.source }, text: { lines: args.text.split(/\r?\n/) } }],
  };
  const checked = production.validateProductionSpec(recipe, { projectRoot: project.root });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  const grant = await askOnce(requestApproval, execution, '在现有片段上制作这条字幕？ / Add this caption to the existing clip?',
    `${input}\n\n${args.text}\n\n另存完整视频。The original stays in place.`);
  if (!grant) return { approved: false };
  return production.renderProduction({ projectRoot: project.root, spec: recipe,
    outputPath: `output/subtitle-${randomUUID()}.mp4`, signal: execution.signal });
}

async function generateOneAsset(project, args, execution, requestApproval, providers) {
  const selected = discoverMediaModels(providers).find(model => model.provider === args.provider && model.model === args.model);
  if (!selected) throw new Error('No matching media model is configured.');
  if (!args.text?.trim() || args.text.length > 10000) throw new Error('Supply a standalone media request.');
  if (!/^[A-Z]{3}$/.test(args.currency) || !Number.isSafeInteger(args.costLimit) || args.costLimit < 0) {
    throw new Error('Set a currency and one-request spending cap.');
  }
  const request = { operationId: randomUUID(), provider: selected.provider, model: selected.model,
    currency: args.currency, costLimit: args.costLimit, prompt: args.text };
  const modelReceipt = await askOnce(requestApproval, execution, '这项独立素材任务是否采用该模型？ / Use this model for the standalone asset?',
    `${request.provider} / ${request.model}\n${request.prompt}\n\n提示词将发送到所选服务。The prompt will be sent to this service.`);
  if (!modelReceipt) return { approved: false };
  const costReceipt = await askOnce(requestApproval, execution, '是否授权这一次外部调用的费用？ / Approve the cost of this single dispatch?',
    `${request.provider} / ${request.model}\n${request.costLimit} ${request.currency} 的最小货币单位 / minor units`);
  if (!costReceipt) return { approved: false };
  const result = await executeOneMediaRequest({ providers, request, approved: { ...request }, signal: execution.signal });
  execution.signal?.throwIfAborted();
  const types = { 'image/png': '.png', 'image/jpeg': '.jpg', 'audio/wav': '.wav', 'video/mp4': '.mp4' };
  if (!Object.hasOwn(types, result?.mime) || !(result.bytes instanceof Uint8Array) || !result.bytes.byteLength
    || result.bytes.byteLength > 256 * 1024 * 1024) throw new Error('The media provider returned an unsupported or oversized artifact.');
  const dest = await ensurePlainDirectories(project.root, ['assets']);
  const name = `generated-${request.operationId}${types[result.mime]}`;
  await writeFile(join(dest, name), result.bytes, { flag: 'wx', signal: execution.signal });
  return { path: `assets/${name}`, provider: request.provider, model: request.model };
}

async function saveApprovedExperience(project, workspace, args, execution, requestApproval) {
  const { copyExperienceAsset, libraryRoot, saveExperience } = await import('./tools/experience-library.js');
  if (!args.title?.trim() || !args.scene?.trim() || !args.notes?.trim()) throw new Error('Name the entry, scene and applicable conditions.');
  const source = existingProjectFile(project.root, args.source);
  const location = await libraryRoot(workspace);
  const scope = args.resolution === 'merge' ? 'library-write' : 'library-asset-copy';
  const receipt = await askOnce(requestApproval, execution, '将已交付作品的这个经验收录到本地库？ / Save this reusable item after delivery?',
    `${args.title}\n${args.scene}\n${args.notes}\n${source}\n${location}\n${args.resolution ?? 'conflict report'}`);
  if (!receipt) return { approved: false };
  const approval = { approved: true, grantedBy: 'host', scope, at: receipt.at, note: receipt.questionId };
  const input = { project, path: args.source, scene: args.scene, title: args.title,
    oneLine: args.title, source: `${project.relative ?? project.root} / ${args.source}`,
    appliesWhen: args.notes, observable: `现有作品内的素材 ${args.source}`,
    counter: args.counter ?? '其他作品与使用环境尚未核实', validated: '用户选择从当前已交付作品收录' };
  if (scope === 'library-write') return saveExperience(workspace, input, approval, { resolution: args.resolution });
  return copyExperienceAsset(workspace, input, approval, { resolution: args.resolution });
}

export async function apply(ctx) {
  const [{ openProject, importAssets, listAssets }, { inspectPlan }, production] = await Promise.all([
    import('./tools/project.js'), import('./tools/plan-check.js'), import('./tools/production.js'),
  ]);
  const store = ctx.controlYourVideoStore;
  const requestApproval = request => ctx.userQuestions.ask(request);
  const workflow = createWorkflow({
    store, requestApproval, inspectPlan,
    validateSpec(spec, projectRoot) {
      const result = production.validateProductionSpec(spec, { projectRoot });
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      return spec;
    },
    render: production.renderProduction,
    locks: store.locks,
  });
  const exclusive = (project, callback) => withProjectLock(store.locks, project.root, callback);
  const open = (workspace, path, create = false) => {
    if (!path || isAbsolute(path)) throw new Error('Name a project folder relative to the current workspace.');
    return openProject(workspace, path, { create });
  };
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };

  ctx.tools.register({
    name: 'cyv',
    description: '受控视频创作。状态、项目和素材、创意/完整方案/小样确认、真实制作与局部字幕。按用户选择的阶段执行。',
    parameters: WORKFLOW_PARAMETERS,
    output,
    async execute(args, execution) {
      const workspace = hostProjectScope(ctx, execution);
      if (args.action === 'local_capabilities') {
        return JSON.stringify({ ...await discoverLocalCapabilities(execution.signal), recipe: RECIPE_GUIDE });
      }
      if (args.action === 'media_models') {
        return JSON.stringify({ models: discoverMediaModels(ctx.get('controlYourVideoMediaProviders') ?? []) });
      }
      if (args.action === 'read_reference') {
        const path = args.source ?? '';
        if (!/^(?:docs\/[^/\\:.]+|skills\/[a-z0-9-]+\/(?:SKILL|references\/[a-z0-9-]+))\.md$/iu.test(path)) {
          throw new Error('Unknown reference path. Use the whole relative path, for example '
            + '`docs/编写规范.md`, `skills/video-plan/SKILL.md`, or `skills/video-plan/references/sample.md`; '
            + 'only .md files inside docs/ and skills/ are readable.');
        }
        try {
          return (await readFile(new URL(path, import.meta.url), 'utf8')).slice(0, 32000);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          throw new Error(`No such reference: ${path}. The path must contain at least the top folder, the Skill name and, for references, the file name.`);
        }
      }
      if (args.action === 'read_experience') {
        if (!args.query?.trim()) throw new Error('Specify the prior knowledge the user authorized.');
        const { libraryRoot, searchLibrary } = await import('./tools/experience-library.js');
        const location = await libraryRoot(workspace);
        const receipt = await askOnce(requestApproval, execution, '允许查找相关历史经验？ / Allow this search of your own experience library?',
          `${location}\n${args.query}`);
        if (!receipt) return JSON.stringify({ approved: false });
        return JSON.stringify(await searchLibrary(workspace, args.query, { scene: args.scene }));
      }
      const project = await open(workspace, args.project, args.action === 'create');
      if (args.action === 'create' || args.action === 'open') return JSON.stringify({ root: project.root });
      if (args.action === 'list_assets') return JSON.stringify(await listAssets(project));
      if (args.action === 'generate_one_asset') {
        return exclusive(project, async () => JSON.stringify(await generateOneAsset(project, args, execution, requestApproval,
          ctx.get('controlYourVideoMediaProviders') ?? [])));
      }
      if (args.action === 'import_assets') {
        if (!args.sources?.length || args.sources.length > 100) throw new Error('Choose 1–100 current project inputs.');
        if (args.sources.some(source => typeof source !== 'string' || /[\r\n\x00]/.test(source))) {
          throw new Error('Invalid source path.');
        }
        const sources = args.sources.map(path => resolve(workspace, path));
        const receipt = await askOnce(requestApproval, execution, '将这些素材复制到本项目？ / Copy these inputs into this project?',
          `${project.root}\n\n${sources.join('\n')}`);
        if (!receipt) return JSON.stringify({ copied: false });
        return exclusive(project, async () => JSON.stringify(await importAssets(project,
          sources.map(path => ({ path, authorized: true })), { cwd: workspace, signal: execution.signal })));
      }
      if (args.action === 'subtitle_edit') {
        return exclusive(project, async () => JSON.stringify(await editLocalSubtitle(project, args, execution, requestApproval, production)));
      }
      if (args.action === 'save_experience') {
        return exclusive(project, () => withProjectLock(store.locks, workspace, async () =>
          JSON.stringify(await saveApprovedExperience(project, workspace, args, execution, requestApproval))));
      }
      if (args.action === 'approve_plan') {
        const ready = await discoverLocalCapabilities(execution.signal);
        if (!ready.localProduction || (args.spec?.audio?.mode !== 'none' && !ready.aac)) {
          throw new Error('The local FFmpeg/FFprobe encoders required by this plan are unavailable.');
        }
      }
      return JSON.stringify(await workflow(project, args, execution));
    },
  });

  ctx.tools.register({
    name: 'evidence',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output,
    timeoutMs: TIMEOUT_MS,
    async execute(args, execution) {
      const project = await open(hostProjectScope(ctx, execution), args.project);
      if (args.action === 'plan-check') return JSON.stringify(await workflow(project, { action: 'check_plan' }, execution));
      if (args.action === 'gc') throw new Error('Evidence cleanup is available in the standalone tool.');
      if (args.revision && !/^[A-Za-z0-9_-]{1,60}$/.test(args.revision)) throw new Error('Invalid revision ID.');
      return exclusive(project, async () => {
        const dir = await ensurePlainDirectories(project.root, ['work', 'evidence']);
        let source;
        if (args.source) {
          source = existingProjectFile(project.root, args.source);
          if (!MEDIA_EXTENSIONS.has(extname(source).toLowerCase())) throw new Error('Expected a local media file.');
        }
        const argv = buildArgv(args.action, { ...args, dir, source });
        return run(argv, project.root, execution.signal);
      });
    },
  });
}
