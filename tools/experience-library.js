/**
 * experience-library.js — 跨作品经验库的**底层本地 API**。
 *
 * 产品边界（01 §主题11、19 §E3）：
 *   - 沉淀是作品交付后的**可选**动作；不自动入库，不自动跨项目读取。
 *   - 按**使用场景**分类，不按 jpg/mp4/js 这种文件类型分类。
 *   - 复制进库，项目里保留独立原件；库与项目是两个位置。
 *   - 记录来源与适用条件；一次成功不等于普遍正确，所以状态默认"待验证"。
 *   - 重复内容只**报告冲突**，给出保留/合并/替换的选项，绝不自动删除或覆盖。
 *
 * 权限边界（本文件的核心约束）：
 *   写库的每个入口都必须收到宿主给的**显式批准**对象。代码无法证明用户真的点过头，
 *   所以这里只做两件事：把"没有批准就写不进去"做成硬失败；把批准原样记进入库记录，
 *   便于事后审计是谁、在什么时候、凭什么写入。真正的门禁由宿主完成。
 *
 * 不做什么：不扫描私人库、不读未授权目录、不建数据库、不做语义检索服务、
 * 不把库内容打包进插件、不替用户判断哪条更好。
 */

import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { ProjectError, isInside, normalizeRelative, sha256File } from './project.js';

/** COPYFILE_EXCL：目标已存在就失败，绝不静默覆盖。 */
const COPYFILE_EXCL = fsConstants.COPYFILE_EXCL;

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 库根目录：沿用 video-library 与 DETAIL.md 约定的 `<工作区>/control-your-video/`。 */
export const LIBRARY_DIR = 'control-your-video';

/** 按使用场景分类（03 §6 的七类）。key 稳定，label 是落盘的目录名。 */
export const SCENES = Object.freeze({
  story: '叙事与剧本',
  visual: '视觉与美术',
  character: '角色与场景',
  motion: '镜头与运动',
  codefx: '代码动画与特效',
  sound: '声音与配乐',
  edit: '剪辑与后期',
});

/** 库条目的状态枚举（编写规范 §1.4 第 6 字段）。 */
export const STATUSES = Object.freeze(['待验证', '在用', '已废']);

/** 索引文件名，一行一条。 */
export const INDEX_FILE = 'index.md';

const SIDECAR_EXT = '.md';

// ── 错误 ────────────────────────────────────────────────────────────────────

/**
 * 库相关错误的 code：
 *   E_LIBRARY_APPROVAL   没有宿主显式批准（写库被拒）
 *   E_LIBRARY_WORKSPACE  工作区不存在/不是目录
 *   E_LIBRARY_ENTRY      条目字段不合格
 *   E_LIBRARY_SCENE      场景名不认识
 *   E_LIBRARY_PATH       库内路径越界或经过符号链接
 *   E_LIBRARY_SOURCE     来源文件不可用（不在项目内、不存在、是链接）
 */
export class LibraryError extends ProjectError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'LibraryError';
  }
}

// ── 基础 ────────────────────────────────────────────────────────────────────

function isoDate(now = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isoNow() {
  return new Date().toISOString();
}

async function statOrNull(p) {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function readTextOrNull(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

/** 工作区必须是已存在的目录；返回真实路径。 */
export async function resolveWorkspace(workspace) {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new LibraryError('E_LIBRARY_WORKSPACE', '缺少 workspace：要给工作区绝对路径。');
  }
  const abs = path.resolve(workspace.trim());
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new LibraryError('E_LIBRARY_WORKSPACE', `工作区不存在：${abs}`, { workspace: abs });
    throw err;
  }
  if (!st.isDirectory()) throw new LibraryError('E_LIBRARY_WORKSPACE', `工作区不是目录：${abs}`, { workspace: abs });
  return fsp.realpath(abs);
}

/**
 * 库根（`<工作区>/control-your-video`）。默认**不创建**：
 * 新用户没有库是正常状态，不该为了"看起来完整"预建空目录与占位文件。
 */
export async function libraryRoot(workspace) {
  const ws = await resolveWorkspace(workspace);
  return path.join(ws, LIBRARY_DIR);
}

/** 解析库内相对路径，逐段拒绝符号链接，并证明没跑出库根。 */
export async function resolveLibraryPath(workspace, relativePath = '', { mustExist = false } = {}) {
  const ws = await resolveWorkspace(workspace);
  const root = path.join(ws, LIBRARY_DIR);
  const segments = normalizeRelative(relativePath, '库内路径');
  const full = path.join(root, ...segments);
  if (!isInside(root, full)) {
    throw new LibraryError('E_LIBRARY_PATH', `路径跑出库根：${relativePath}`, { root, relative: relativePath });
  }

  // 已存在的每一段都不能是链接；工作区本身已 realpath，库根之下不会被顶层链接带偏。
  let cursor = ws;
  for (const seg of [LIBRARY_DIR, ...segments]) {
    cursor = path.join(cursor, seg);
    const st = await statOrNull(cursor);
    if (!st) break;
    if (st.isSymbolicLink()) {
      throw new LibraryError('E_LIBRARY_PATH', `库内路径经过符号链接，拒绝跟随：${cursor}`, { path: cursor });
    }
  }
  if (mustExist) {
    const st = await statOrNull(full);
    if (!st) throw new LibraryError('E_LIBRARY_PATH', `库内路径不存在：${full}`, { path: full });
  }
  return { path: full, relative: segments.join('/'), root };
}

/**
 * 场景归一化：接受 key（sound）、已知中文目录名（声音与配乐），也接受调用方给的自定义场景名。
 *
 * 为什么允许自定义：03 §6 的七类只是**建议目录**，用户没有批准固定的分类法；
 * 01 §11-5 只要求"按使用场景分类"。所以认识的名字照旧归类，不认识的名字
 * 收拾成安全目录名后按自定义场景落盘，并标 custom:true，便于事后统一。
 */
export function normalizeScene(scene) {
  const raw = String(scene ?? '').trim();
  if (!raw) {
    throw new LibraryError(
      'E_LIBRARY_SCENE',
      `缺少 scene。按使用场景分类，可选：${Object.keys(SCENES).join(' / ')}（或对应中文目录名），也可以给自定义场景名。`,
    );
  }
  if (SCENES[raw]) return { key: raw, label: SCENES[raw], custom: false };
  const hit = Object.entries(SCENES).find(([, label]) => label === raw);
  if (hit) return { key: hit[0], label: hit[1], custom: false };

  const label = sanitizeSlug(raw);
  if (label === '' || label === '.' || label === '..' || /[<>:"/\\|?*]/.test(label)) {
    throw new LibraryError('E_LIBRARY_SCENE', `场景名不能用：${raw}。换成普通的场景词，例如「开场设计」。`, { scene: raw });
  }
  return { key: `custom:${label}`, label, custom: true };
}

// ── 宿主显式批准 ────────────────────────────────────────────────────────────

/**
 * 校验宿主给的批准对象。
 *
 * 期望形状（宿主构造，不由模型自由生成）：
 *   { approved: true, grantedBy: 'host', scope: 'library-write', at: '2026-11-20T…', note?: '' }
 *
 * 代码能保证的：没有这个对象，写库直接失败，不会留下半条记录。
 * 代码**不能**保证：这个对象真的来自用户点击。宿主必须自己管住谁能造它。
 */
export function assertApproval(approval, action) {
  if (!approval || typeof approval !== 'object' || approval.approved !== true) {
    throw new LibraryError(
      'E_LIBRARY_APPROVAL',
      `写库需要宿主的显式批准（${action}）。这不是模型能自己声明的事：先向用户说明要记什么、放哪个场景、适用条件是什么，得到同意后再由宿主传入 approval。`,
      { action },
    );
  }
  if (typeof approval.grantedBy !== 'string' || approval.grantedBy.trim() === '') {
    throw new LibraryError('E_LIBRARY_APPROVAL', '批准对象缺少 grantedBy：写清是谁批准的（通常是宿主/用户），便于事后审计。', {
      action,
    });
  }
  if (approval.scope !== undefined && approval.scope !== action) {
    throw new LibraryError(
      'E_LIBRARY_APPROVAL',
      `批准范围不匹配：这次是 ${action}，批准对象写的是 ${String(approval.scope)}。不做范围外写入。`,
      { action, scope: approval.scope },
    );
  }
  return {
    approved: true,
    grantedBy: approval.grantedBy.trim(),
    scope: action,
    at: typeof approval.at === 'string' && approval.at.trim() !== '' ? approval.at : isoNow(),
    note: typeof approval.note === 'string' ? approval.note : '',
  };
}

// ── 索引 ────────────────────────────────────────────────────────────────────

/**
 * 读索引。不存在 = 库还没建（正常）；损坏行 = 单独报出，不静默重排覆盖。
 * 一行格式：`- 日期 · 一句话 · 相对路径 · 状态`
 */
export async function readLibraryIndex(workspace) {
  const root = await libraryRoot(workspace);
  const file = path.join(root, INDEX_FILE);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { root, file, exists: false, entries: [], malformed: [] };
    }
    throw err;
  }

  const entries = [];
  const malformed = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || !t.startsWith('-')) return;
    const parts = t
      .slice(1)
      .split('·')
      .map((s) => s.trim());
    if (parts.length !== 4 || parts.some((p) => p === '')) {
      malformed.push({ line: i + 1, text: t });
      return;
    }
    const [date, oneLine, rel, status] = parts;
    entries.push({ date, oneLine, path: rel.replace(/\\/g, '/'), status, line: i + 1 });
  });

  return { root, file, exists: true, entries, malformed };
}

/**
 * 只读索引做一次筛选（一行一条扫完，不整库通读、不打开条目正文）。
 * 这是"要复用以前的做法"时唯一该走的入口。
 */
export async function searchLibrary(workspace, query = '', { scene = null, status = null } = {}) {
  const index = await readLibraryIndex(workspace);
  const q = String(query ?? '').trim().toLowerCase();
  const sceneInfo = scene ? normalizeScene(scene) : null;

  const hits = index.entries.filter((e) => {
    if (status && e.status !== status) return false;
    if (e.status === '已废') return false; // 已废的条目不当现行做法读
    if (sceneInfo && !e.path.startsWith(`${sceneInfo.label}/`)) return false;
    if (!q) return true;
    return `${e.oneLine} ${e.path}`.toLowerCase().includes(q);
  });

  return {
    exists: index.exists,
    root: index.root,
    query: String(query ?? ''),
    hits,
    malformed: index.malformed,
    note: index.exists ? undefined : '库还没建。这是新用户的正常状态，不是缺陷；直接照常做事，不要预建空目录。',
  };
}

// ── 条目校验与渲染 ──────────────────────────────────────────────────────────

function requireText(value, field, { max = 400 } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new LibraryError('E_LIBRARY_ENTRY', `缺字段「${field}」：这一项空着，条目就不该入库。`, { field });
  if (s.length > max) throw new LibraryError('E_LIBRARY_ENTRY', `字段「${field}」太长（${s.length} > ${max}），压成一句再说。`, { field });
  return s;
}

/** 中文标题也要能当文件名：非法字符换掉、保留中文、限长。 */
export function sanitizeSlug(input) {
  const cleaned = String(input ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-. ]+$/g, '')
    .slice(0, 60);
  return cleaned || `entry-${Date.now().toString(36)}`;
}

/**
 * 校验并归一化一条经验。**纯函数，不写盘**——这是"先给用户看预览与推荐理由"的那一步。
 *
 * 字段对齐编写规范 §1.4：一句话 / 可检验特征 / 适用条件 / 反例或失效条件 / 出处 / 日期与状态。
 */
export function prepareEntry(input = {}) {
  const oneLine = requireText(input.oneLine ?? input.summary, '一句话', { max: 200 });
  const scene = normalizeScene(input.scene);
  const appliesWhen = requireText(input.appliesWhen ?? input.condition ?? input.notes, '适用条件', { max: 400 });
  const source = requireText(input.source, '出处', { max: 300 });
  const warnings = [];

  // 可检验特征与失效条件是"这条值不值得信"的两根柱子。调用方漏填时不编内容，
  // 而是写清"没写"，并把状态压回待验证——允许入库，但不许冒充已验证。
  const observable = optionalText(input.observable ?? input.checkable, '可检验特征', warnings);
  const counter = optionalText(input.counter ?? input.failure, '反例或失效条件', warnings);

  let status = String(input.status ?? '待验证').trim();
  if (!STATUSES.includes(status)) {
    throw new LibraryError('E_LIBRARY_ENTRY', `状态只能是 ${STATUSES.join(' / ')}，收到 ${status}。`, { field: '状态' });
  }
  if (warnings.length > 0 && status !== '待验证') {
    warnings.push(`缺字段时状态只能是「待验证」，已把「${status}」压回待验证。`);
    status = '待验证';
  }

  const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : oneLine;
  const slug = sanitizeSlug(input.slug ?? title);
  const date =
    typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date.trim()) ? input.date.trim() : isoDate();
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';

  return {
    scene,
    title,
    slug,
    date,
    status,
    oneLine,
    observable,
    appliesWhen,
    counter,
    source,
    reason,
    validated: typeof input.validated === 'string' ? input.validated.trim() : typeof input.verification === 'string' ? input.verification.trim() : '',
    warnings,
    kind: input.kind === 'asset' ? 'asset' : 'method',
    asset: input.asset ?? null,
  };
}

/** 可选文本：没给就写一句"没写"，同时留一条警告，不编内容。 */
function optionalText(value, field, warnings) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s === '') {
    warnings.push(`缺「${field}」：已写明未提供，状态压回待验证。`);
    return `（未提供：${field}还没写，这条不能当已验证的做法复用）`;
  }
  if (s.length > 400) {
    throw new LibraryError('E_LIBRARY_ENTRY', `字段「${field}」太长（${s.length} > 400），压成一句再说。`, { field });
  }
  return s;
}

/** 一条条目的 Markdown 正文（字段顺序固定，便于人读与后续解析）。 */
export function renderEntry(entry, { approval = null } = {}) {
  const lines = [];
  lines.push(`# ${entry.title}`);
  lines.push('');
  lines.push(`- 一句话：${entry.oneLine}`);
  lines.push(`- 可检验特征：${entry.observable}`);
  lines.push(`- 适用条件：${entry.appliesWhen}`);
  lines.push(`- 反例或失效条件：${entry.counter}`);
  lines.push(`- 出处：${entry.source}`);
  if (entry.validated) lines.push(`- 验证程度：${entry.validated}`);
  if (entry.asset) lines.push(`- 入库副本：${entry.asset.dest}`);
  lines.push(`- ${entry.date} · ${entry.status}`);
  if (entry.reason) {
    lines.push('');
    lines.push(`> 推荐理由：${entry.reason}`);
  }
  if (approval) {
    lines.push('');
    lines.push(
      `<!-- 入库授权：${approval.grantedBy} · ${approval.at} · scope=${approval.scope}${approval.note ? ` · ${approval.note}` : ''} -->`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ── 索引写入 ────────────────────────────────────────────────────────────────

function indexLine(entry, relPath) {
  return `- ${entry.date} · ${entry.oneLine} · ${relPath} · ${entry.status}`;
}

/** 追加一行；索引不存在就新建（只在真的写了一条之后才建库）。 */
async function appendIndexLine(root, line) {
  const file = path.join(root, INDEX_FILE);
  const existing = (await readTextOrNull(file)) ?? '';
  const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  await writeAtomic(file, `${prefix}${line}\n`);
}

/** 重写某条路径对应的索引行（用于 replace/merge），其余行原样保留。 */
async function replaceIndexLine(root, relPath, line) {
  const file = path.join(root, INDEX_FILE);
  const raw = (await readTextOrNull(file)) ?? '';
  const lines = raw === '' ? [] : raw.replace(/\n+$/, '').split(/\r?\n/);
  let replaced = false;
  const out = lines.map((l) => {
    const t = l.trim();
    if (!t.startsWith('-')) return l;
    const parts = t
      .slice(1)
      .split('·')
      .map((s) => s.trim());
    if (parts.length === 4 && parts[2] === relPath) {
      replaced = true;
      return line;
    }
    return l;
  });
  if (!replaced) out.push(line);
  await writeAtomic(file, `${out.join('\n')}\n`);
}

// ── 写库：方法/经验 ─────────────────────────────────────────────────────────

/**
 * 把一条经验写进库（方法卡）。必须带宿主批准。
 *
 * 冲突处理：同路径已存在、或同"一句话"已存在 → 不覆盖，返回 { status:'conflict' }。
 * 由用户决定，代码只接受显式的 resolution：
 *   'fail'（默认，只报冲突）/ 'skip' / 'keep-both' / 'replace' / 'merge'
 */
export async function saveExperience(workspace, input, approval, options = {}) {
  const granted = assertApproval(approval, 'library-write');
  const entry = prepareEntry(input);
  const { resolution = 'fail' } = options;
  if (!['fail', 'skip', 'keep-both', 'replace', 'merge'].includes(resolution)) {
    throw new LibraryError('E_LIBRARY_ENTRY', `不认识的 resolution：${resolution}。只有 fail/skip/keep-both/replace/merge。`);
  }

  const root = await libraryRoot(workspace);
  const relPath = `${entry.scene.label}/${entry.slug}${SIDECAR_EXT}`;
  const target = (await resolveLibraryPath(workspace, relPath)).path;

  const index = await readLibraryIndex(workspace);
  const samePath = index.entries.find((e) => e.path === relPath);
  const sameLine = index.entries.find((e) => e.oneLine === entry.oneLine && e.path !== relPath);
  const existingText = await readTextOrNull(target);

  const conflicts = [];
  if (samePath || existingText !== null) {
    conflicts.push({
      type: samePath ? 'same-path' : 'file-exists',
      existing: samePath ?? { path: relPath },
      candidate: { path: relPath, oneLine: entry.oneLine },
      options: ['keep-both', 'replace', 'skip'],
    });
  }
  if (sameLine) {
    conflicts.push({
      type: 'same-one-line',
      existing: sameLine,
      candidate: { path: relPath, oneLine: entry.oneLine },
      options: ['merge', 'keep-both', 'skip'],
    });
  }

  if (conflicts.length > 0 && (resolution === 'fail' || resolution === 'skip')) {
    return {
      ok: false,
      status: 'conflict',
      root,
      conflicts,
      hint:
        resolution === 'fail'
          ? '库里有相似条目。把冲突给用户看，由用户决定保留/合并/替换；代码不替你删也不替你覆盖。'
          : '按你的选择跳过，本次没有写入。',
    };
  }

  if (resolution === 'replace' && (samePath || existingText !== null)) {
    await writeAtomic(target, renderEntry(entry, { approval: granted }));
    if (samePath) await replaceIndexLine(root, relPath, indexLine(entry, relPath));
    else await appendIndexLine(root, indexLine(entry, relPath));
    return { ok: true, status: 'replaced', root, entry: { ...entry, path: relPath }, approval: granted, conflicts };
  }

  if (resolution === 'merge' && sameLine) {
    const existingPath = sameLine.path;
    const file = (await resolveLibraryPath(workspace, existingPath)).path;
    const before = (await readTextOrNull(file)) ?? '';
    const merged = `${before}${before.endsWith('\n') ? '' : '\n'}\n## 补充（${entry.date}）\n\n- 新增出处：${entry.source}\n- 补充适用条件：${entry.appliesWhen}\n`;
    await writeAtomic(file, merged);
    return { ok: true, status: 'merged', root, entry: { ...entry, path: existingPath }, approval: granted, conflicts };
  }

  if (resolution === 'keep-both' && conflicts.length > 0) {
    const rel = await uniqueSlugPath(workspace, entry.scene.label, entry.slug);
    const file = (await resolveLibraryPath(workspace, rel)).path;
    await writeAtomic(file, renderEntry({ ...entry, title: `${entry.title}（另存）` }, { approval: granted }));
    await appendIndexLine(root, indexLine(entry, rel));
    return { ok: true, status: 'kept-both', root, entry: { ...entry, path: rel }, approval: granted, conflicts };
  }

  await writeAtomic(target, renderEntry(entry, { approval: granted }));
  await appendIndexLine(root, indexLine(entry, relPath));
  return {
    ok: true,
    status: conflicts.length > 0 ? 'created-with-notes' : 'created',
    root,
    entry: { ...entry, path: relPath },
    approval: granted,
    conflicts,
  };
}

/** 同名条目已存在时找一个不撞的路径。 */
async function uniqueSlugPath(workspace, sceneLabel, slug) {
  for (let i = 2; i <= 999; i += 1) {
    const rel = `${sceneLabel}/${slug} (${i})${SIDECAR_EXT}`;
    const { path: abs } = await resolveLibraryPath(workspace, rel);
    if ((await statOrNull(abs)) === null) return rel;
  }
  throw new LibraryError('E_LIBRARY_ENTRY', `同名条目太多，找不到可用的名字：${slug}`);
}

// ── 写库：按场景复制资产 ────────────────────────────────────────────────────

/**
 * 从项目里复制一份资产进库，项目原件不动。
 *
 * 只在宿主显式批准后调用；来源必须是项目内的普通文件。
 * 重复判定看 sha256（同场景内）；同名不同内容也算冲突。都只报告，不自动覆盖/删除。
 */
export async function copyExperienceAsset(workspace, input = {}, approval, options = {}) {
  const granted = assertApproval(approval, 'library-asset-copy');
  const { resolution = 'fail' } = options;
  if (!['fail', 'skip', 'keep-both', 'replace'].includes(resolution)) {
    throw new LibraryError('E_LIBRARY_ENTRY', `不认识的 resolution：${resolution}。这里只有 fail/skip/keep-both/replace。`);
  }

  const projectRoot = input.project && (input.project.root || input.project);
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new LibraryError('E_LIBRARY_SOURCE', '缺少 project：要给资产所在的项目根（openProject 的返回值即可）。');
  }
  const projectReal = await fsp.realpath(path.resolve(projectRoot)).catch(() => {
    throw new LibraryError('E_LIBRARY_SOURCE', `项目根不存在：${projectRoot}`);
  });

  const relSource = String(input.path ?? '').trim();
  if (!relSource) throw new LibraryError('E_LIBRARY_SOURCE', '缺少 path：要给项目内的相对路径（例如 assets/机房.jpg）。');

  const srcAbs = path.resolve(projectReal, ...normalizeRelative(relSource, '项目内相对路径'));
  if (!isInside(projectReal, srcAbs)) {
    throw new LibraryError('E_LIBRARY_SOURCE', `来源跑出项目根：${relSource}`, { path: srcAbs });
  }
  const srcStat = await statOrNull(srcAbs);
  if (!srcStat) throw new LibraryError('E_LIBRARY_SOURCE', `来源不存在：${srcAbs}`, { path: srcAbs });
  if (srcStat.isSymbolicLink()) throw new LibraryError('E_LIBRARY_SOURCE', `来源是符号链接，拒绝：${srcAbs}`, { path: srcAbs });
  if (!srcStat.isFile()) throw new LibraryError('E_LIBRARY_SOURCE', `来源不是普通文件：${srcAbs}`, { path: srcAbs });

  const scene = normalizeScene(input.scene);
  const sha = await sha256File(srcAbs);
  const baseName = path.basename(srcAbs);
  const root = await libraryRoot(workspace);
  const sceneRel = `${scene.label}/${baseName}`;
  const sceneAbs = path.join(root, ...sceneRel.split('/'));
  const existingSameName = await statOrNull(sceneAbs);

  // 冲突判定（只读）：同场景内按内容哈希比，不看扩展名，也不比条目的 Markdown 正文。
  const conflicts = [];
  const index = await readLibraryIndex(workspace);
  const sceneDirAbs = path.join(root, scene.label);
  const sidecarAbsSet = new Set(
    index.entries.filter((e) => e.path.startsWith(`${scene.label}/`)).map((e) => path.join(root, ...e.path.split('/'))),
  );
  const sceneFiles = (await statOrNull(sceneDirAbs)) ? await fsp.readdir(sceneDirAbs, { withFileTypes: true }).catch(() => []) : [];
  for (const ent of sceneFiles) {
    if (!ent.isFile()) continue;
    const candidateAbs = path.join(sceneDirAbs, ent.name);
    if (sidecarAbsSet.has(candidateAbs)) continue;
    const st = await statOrNull(candidateAbs);
    if (!st || !st.isFile() || st.size !== srcStat.size) continue;
    if ((await sha256File(candidateAbs)) === sha) {
      conflicts.push({
        type: 'same-content',
        existing: { path: `${scene.label}/${ent.name}` },
        candidate: { path: sceneRel, sha256: sha },
        options: ['keep-both', 'replace', 'skip'],
      });
      break;
    }
  }
  if (existingSameName && conflicts.length === 0) {
    conflicts.push({
      type: 'same-name-different-content',
      existing: { path: sceneRel },
      candidate: { path: sceneRel, sha256: sha },
      options: ['keep-both', 'replace', 'skip'],
    });
  }

  if (conflicts.length > 0 && (resolution === 'fail' || resolution === 'skip')) {
    return {
      ok: false,
      status: 'conflict',
      root,
      conflicts,
      hint:
        resolution === 'fail'
          ? '库里已经有同样或同名内容。把冲突给用户看，由用户决定保留/合并/替换；代码不自动删、不自动盖。'
          : '按你的选择跳过，本次没有复制。',
    };
  }

  // 先校验条目字段，避免"文件复制完了才发现条件没写"留下孤儿。
  const entry = prepareEntry({
    ...input,
    kind: 'asset',
    oneLine: input.oneLine ?? `按场景复用的素材：${baseName}`,
    observable: input.observable ?? `画面/声音里出现的这份素材（sha256 ${sha.slice(0, 12)}…）`,
    source: input.source ?? `项目 ${path.basename(projectReal)} · ${relSource}`,
    slug: input.slug ?? path.parse(baseName).name,
    title: input.title ?? baseName,
    asset: { dest: sceneRel, sha256: sha, bytes: srcStat.size, copiedAt: isoNow(), project: path.basename(projectReal) },
  });

  let destRel = sceneRel;
  if (conflicts.length > 0 && resolution === 'keep-both') {
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length);
    for (let i = 2; i <= 999; i += 1) {
      const candidate = `${scene.label}/${stem} (${i})${ext}`;
      if ((await statOrNull(path.join(root, ...candidate.split('/')))) === null) {
        destRel = candidate;
        break;
      }
    }
  }

  const destAbs = (await resolveLibraryPath(workspace, destRel)).path;
  await fsp.mkdir(path.dirname(destAbs), { recursive: true });
  // 只有用户明确选了 replace 且确实要盖同一份文件时才允许覆盖；其余一律 EXCL，撞了就报冲突。
  const allowOverwrite = resolution === 'replace' && destRel === sceneRel && Boolean(existingSameName);
  await fsp.copyFile(srcAbs, destAbs, allowOverwrite ? 0 : COPYFILE_EXCL).catch((err) => {
    if (err && err.code === 'EEXIST') {
      throw new LibraryError('E_LIBRARY_ENTRY', `目标已存在，拒绝覆盖：${destAbs}。先把冲突交给用户决定。`, { path: destAbs });
    }
    throw err;
  });

  const copiedSha = await sha256File(destAbs);
  if (copiedSha !== sha) {
    await fsp.rm(destAbs, { force: true });
    throw new LibraryError('E_LIBRARY_SOURCE', `复制后哈希不一致，已放弃：${srcAbs}`, { path: srcAbs });
  }

  const finalEntry = { ...entry, asset: { ...entry.asset, dest: destRel } };
  // 说明卡不能和资产本身撞成同一个文件（例如资产正好是 x.md、slug 也是 x）。
  let sidecarRel = `${scene.label}/${finalEntry.slug}${SIDECAR_EXT}`;
  if (path.resolve(root, ...sidecarRel.split('/')) === destAbs) {
    sidecarRel = `${scene.label}/${finalEntry.slug}--entry${SIDECAR_EXT}`;
  }
  const sidecarAbs = (await resolveLibraryPath(workspace, sidecarRel)).path;
  if (resolution === 'replace' || (await statOrNull(sidecarAbs)) === null) {
    await writeAtomic(sidecarAbs, renderEntry(finalEntry, { approval: granted }));
  }
  if (index.entries.some((e) => e.path === sidecarRel)) {
    await replaceIndexLine(root, sidecarRel, indexLine(finalEntry, sidecarRel));
  } else {
    await appendIndexLine(root, indexLine(finalEntry, sidecarRel));
  }

  return {
    ok: true,
    status: conflicts.length > 0 ? (resolution === 'replace' ? 'replaced' : 'kept-both') : 'created',
    root,
    conflicts,
    entry: { ...finalEntry, path: sidecarRel },
    asset: { source: srcAbs, dest: destAbs, destRelative: destRel, sha256: sha, bytes: srcStat.size },
    approval: granted,
  };
}

/**
 * 一次只读的库概况（给模型判断"库现在是什么状态"，不整库读进来）。
 */
export async function inspectLibrary(workspace) {
  const root = await libraryRoot(workspace);
  const index = await readLibraryIndex(workspace);
  const rootStat = await statOrNull(root);
  const exists = Boolean(rootStat && rootStat.isDirectory());
  const scenes = {};

  if (exists) {
    for (const [key, label] of Object.entries(SCENES)) {
      const dirStat = await statOrNull(path.join(root, label));
      if (!dirStat || !dirStat.isDirectory()) continue;
      const files = await fsp.readdir(path.join(root, label)).catch(() => []);
      scenes[key] = { label, files: files.filter((f) => !f.startsWith('.')).length };
    }
  }

  return {
    exists,
    root,
    entries: index.entries.length,
    malformed: index.malformed,
    scenes,
    note: exists ? undefined : '库还没建。这是正常状态，不预建空目录、不铺占位文件。',
  };
}
