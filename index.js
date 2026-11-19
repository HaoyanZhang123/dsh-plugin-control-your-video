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

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function run(argv, workspace) {
  // 子进程要一个真实工作目录；默认用宿主进程的 cwd，给了 workspace 就用它。
  const result = spawnSync(process.execPath, [SCRIPT, ...argv], {
    cwd: workspace || process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, text: `无法运行 evidence.js：${result.error.message}` };
  }

  const parts = [];
  if (result.signal) parts.push(`进程被信号终止：${result.signal}`);
  parts.push(`exit=${result.status === null ? 'null' : result.status}`);
  if (result.stderr && result.stderr.trim()) parts.push(`--- stderr ---\n${clip(result.stderr.trim())}`);
  if (result.stdout && result.stdout.trim()) parts.push(`--- stdout ---\n${clip(result.stdout.trim())}`);
  if (!result.stdout?.trim() && !result.stderr?.trim()) parts.push('（无输出）');

  return { ok: result.status === 0, text: parts.join('\n') };
}

/** 模型可见的参数 schema（JSON Schema，按 ctx.tools.register 接受的形状）。 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'dir'],
  properties: {
    action: {
      type: 'string',
      enum: ['extract', 'measure', 'recall', 'gc', 'plan-check'],
      description:
        'extract 抽帧并登记；measure 做时长/黑帧/响度等确定性测量；recall 按条件找回旧证据；gc 清理 superseded 条目；plan-check 开工前检查 plan.md 是否完整（读作品文件夹，不看画面）。',
    },
    dir: {
      type: 'string',
      description:
        'plan-check 给作品文件夹（含 plan.md）；其余动作给证据目录，通常是作品文件夹里的 work/evidence。给绝对路径。',
    },
    workspace: {
      type: 'string',
      description:
        '可选：工作区绝对路径。给了它，dir 与 source 可以写相对于该工作区的路径。不给就按绝对路径处理。',
    },
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
    yes: {
      type: 'boolean',
      description: 'gc 必填的确认开关：不带它只预演，不真的移动文件。',
    },
  },
};

const DESCRIPTION =
  '从成片取真实画面与确定性测量，并维护作品内的证据索引。用于审片取证、修改前后对照、找回之前看过的帧。' +
  '只记录被看过的那一帧，不预抽全片，不判断画面好坏。';

export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.register({
    name: 'evidence',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const argv = buildArgv(args.action, args);
      return run(argv, args.workspace).text;
    },
  });
}
