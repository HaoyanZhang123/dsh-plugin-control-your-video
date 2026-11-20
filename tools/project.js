/**
 * project.js — 作品文件夹的安全新建/导入、当前素材复制与来源清单。
 *
 * 只做一件产品要求里写死的事（01 §主题09、19 §C1）：
 * 用户为**这一次作品**提供的素材，复制进作品夹内部，原件一个字节都不动，
 * 并且说得出"这份副本是从哪个原件来的、什么时候来的、校验值是多少"。
 *
 * 三条硬约束，代码里都得有对应：
 *   1. 原件只读：本模块对素材只做 lstat/read/hash，从不写、不删、不改名。
 *   2. 范围可证：项目内路径一律先证明"真实路径没跑出项目根"，
 *      符号链接一律不跟（拒绝链接逃逸）。
 *   3. 失败不留半截：一批素材要么整批进去，要么一个文件都不留；来源清单最后原子写。
 *
 * 不做什么：不判断素材好不好、不判断授权是否真实（宿主负责核实用户本次确实授权）、
 * 不建数据库、不做版本管理、不把私人库的东西塞进插件包。
 */

import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 轻量标准目录（03 §6 的示意，按需扩展，不强制更多）。 */
export const LAYOUT = Object.freeze({
  assets: 'assets',
  work: 'work',
  output: 'output',
});

/** 来源清单：跟着副本走，改项目时不会先丢。下划线开头，避免和普通素材撞名。 */
export const PROVENANCE_FILE = '_sources.json';

/** 项目自身的一行元数据，放在 work/ 里，不是第二份策划文件。 */
export const PROJECT_META_FILE = 'project.json';

const LEDGER_VERSION = 1;

/** 单个目录素材最多展开多少个文件；超过就如实拒绝，避免一次复制拖死上下文与磁盘。 */
const MAX_FILES_PER_SOURCE = 5000;

/** 目录素材的最大嵌套层数。 */
const MAX_DEPTH = 32;

/** Windows 保留设备名：这些名字做文件名在 Windows 上根本建不出来。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 文件名里不能出现的字符（Windows 口径，跨平台一起收）。 */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

const IS_WINDOWS = process.platform === 'win32';

// ── 错误类型 ────────────────────────────────────────────────────────────────

/**
 * 带机器可读 code 的错误。宿主/测试按 code 分支，不靠中文文案匹配。
 *
 * code 一览：
 *   E_PROJECT / E_WORKSPACE / E_PROJECT_PATH / E_PROJECT_NAME   参数与项目名问题
 *   E_MISSING / E_NOT_DIRECTORY / E_PATH_ABSOLUTE / E_PATH_ESCAPE / E_SYMLINK
 *   E_SOURCES / E_SOURCE_MISSING / E_SOURCE_TYPE / E_SOURCE_RELATIVE / E_SOURCE_EMPTY
 *   E_NOT_AUTHORIZED / E_NAME_EXHAUSTED / E_MANIFEST / E_TOO_MANY / E_TOO_DEEP / E_LOCKED
 */
export class ProjectError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    this.details = details;
  }
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** 相对路径统一成 posix 形式，清单可移植。 */
function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

/** 大小写口径：Windows 上文件名不区分大小写，占名判重必须跟着来。 */
function nameKey(name) {
  return IS_WINDOWS ? String(name).toLowerCase() : String(name);
}

/** 词法判断 target 是否在 root 之内（不解析符号链接；链接在别处单独判）。 */
export function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !rel.startsWith('../');
}

/**
 * 把任意用户/模型给的名字收拾成能在本机落盘的名字。
 *
 * 不做的：不改中文、不做音译、不改大小写。中文目录名是有效需求，不是问题。
 */
export function sanitizeName(input, fallback = 'item') {
  let name = String(input ?? '').replace(INVALID_NAME_CHARS, '-');
  // `..` 在这里没有路径含义，但留着会让文件名长得像一次越界尝试；直接压平。
  name = name.replace(/\.{2,}/g, '-');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/[. ]+$/, '');
  name = name.replace(/^[- ]+/, '');
  if (!name || name === '.' || name === '..') name = fallback;

  const ext = path.extname(name);
  let base = ext ? name.slice(0, -ext.length) : name;
  const suffix = ext;
  if (base.length + suffix.length > 120) base = base.slice(0, Math.max(1, 120 - suffix.length));
  name = `${base}${suffix}`;

  if (WINDOWS_RESERVED.test(name) || WINDOWS_RESERVED.test(base)) name = `_${name}`;
  return name;
}

/** 项目路径的每一段都必须是一个说得清的名字，不能是保留设备名或带非法字符。 */
function assertSafeSegment(segment) {
  if (!segment || segment === '.' || segment === '..') {
    throw new ProjectError('E_PROJECT_PATH', `项目路径里出现空段或 . / ..：${segment || '(空)'}`);
  }
  if (INVALID_NAME_CHARS.test(segment)) {
    throw new ProjectError('E_PROJECT_NAME', `项目路径段含非法字符：${segment}。改用普通名字，别带 <>:"/\\|?*。`);
  }
  if (/[. ]$/.test(segment)) {
    throw new ProjectError('E_PROJECT_NAME', `项目路径段不能以点或空格结尾：${segment}（Windows 会悄悄吞掉）。`);
  }
  if (WINDOWS_RESERVED.test(segment)) {
    throw new ProjectError('E_PROJECT_NAME', `项目路径段是 Windows 保留名：${segment}。换一个名字。`);
  }
}

/**
 * 把相对路径拆成段，同时挡住绝对路径与 .. 逃逸。
 * 没有容忍：给了绝对路径就报错，让调用方显式决定是 workspace 相对还是素材绝对路径。
 */
export function normalizeRelative(relativePath, label = '相对路径') {
  if (typeof relativePath !== 'string') {
    throw new ProjectError('E_PROJECT_PATH', `${label}必须是字符串，收到 ${typeof relativePath}。`);
  }
  const raw = relativePath.trim();
  if (raw === '') return [];
  if (raw.includes('\u0000')) throw new ProjectError('E_PROJECT_PATH', `${label}含 NUL 字符，拒绝。`);
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw new ProjectError('E_PATH_ABSOLUTE', `${label}必须是相对路径，收到绝对路径：${raw}`);
  }
  const segments = [];
  for (const seg of raw.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new ProjectError('E_PATH_ESCAPE', `${label}含 ..，会跑出项目根：${raw}`);
    }
    segments.push(seg);
  }
  return segments;
}

/** 项目根的真实绝对路径；接受 {root} 对象或字符串。 */
async function realRoot(project) {
  const raw = typeof project === 'string' ? project : (project && (project.root || project.rootReal || project.path));
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ProjectError('E_PROJECT', '缺少项目路径：传 openProject() 的返回值，或项目根的绝对路径。');
  }
  const abs = path.resolve(raw);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new ProjectError('E_MISSING', `项目不存在：${abs}。新建时传 create:true。`, { root: abs });
    throw err;
  }
  if (!st.isDirectory()) throw new ProjectError('E_NOT_DIRECTORY', `项目根不是目录：${abs}`, { root: abs });
  return fsp.realpath(abs);
}

async function statOrNull(p) {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function exists(p) {
  return (await statOrNull(p)) !== null;
}

/** 流式 sha256，大文件不进内存。 */
export async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** 原子写 JSON：先临时文件再 rename，中途断电不会把来源清单写坏。 */
async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 取清单锁：跨进程也要顶住两个会话同时往同一个项目里放素材。
 *
 * 用 `wx` 独占创建锁文件，抢不到就退避重试；锁超过 30 秒没动就当成上次崩掉留下的，
 * 清掉再来。**锁只保护"读清单—写清单"这一小段**，复制大文件仍然在锁外做，
 * 免得一个慢复制把别的会话堵死。
 */
async function withManifestLock(assetsDir, fn) {
  const lockPath = path.join(assetsDir, `${PROVENANCE_FILE}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle = null;

  while (handle === null) {
    try {
      handle = await fsp.open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const st = await statOrNull(lockPath);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await removeQuietly(lockPath);
        continue;
      }
      if (Date.now() > deadline) {
        throw new ProjectError(
          'E_LOCKED',
          `来源清单被另一个进程占用超过 ${LOCK_TIMEOUT_MS / 1000} 秒：${lockPath}。等它结束再试；确认没有别的会话在写这个项目后，可手工删掉这个锁文件。`,
          { lock: lockPath },
        );
      }
      await sleep(25 + Math.floor(Math.random() * 50));
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await removeQuietly(lockPath);
  }
}

function isoNow() {
  return new Date().toISOString();
}

// ── 路径范围证明 ────────────────────────────────────────────────────────────

/**
 * 把项目内的相对路径解析成绝对路径，并证明它真的在项目根之内。
 *
 * 证明方式：逐段 lstat。任何一段是符号链接就拒绝（不跟随、不"再检查一次目标"），
 * 因为链接可能指向项目外，也可能在检查与使用之间被换掉。拒绝比事后补救便宜。
 *
 * @param {string|{root:string}} project  项目根（openProject 返回值或绝对路径）
 * @param {string} relativePath           项目内相对路径，空串代表根
 * @returns {Promise<{path:string, relative:string, root:string, exists:boolean}>}
 */
export async function resolveProjectPath(project, relativePath = '') {
  const root = await realRoot(project);
  const segments = normalizeRelative(relativePath, '项目内路径');

  const full = path.join(root, ...segments);
  if (!isInside(root, full)) {
    throw new ProjectError('E_PATH_ESCAPE', `路径跑出项目根：${relativePath}（项目根 ${root}）`, { root, relative: relativePath });
  }

  let cursor = root;
  let resolvedExists = true;
  for (let i = 0; i < segments.length; i += 1) {
    cursor = path.join(cursor, segments[i]);
    const st = await statOrNull(cursor);
    if (!st) {
      resolvedExists = false;
      break;
    }
    if (st.isSymbolicLink()) {
      throw new ProjectError(
        'E_SYMLINK',
        `项目内路径经过符号链接，拒绝跟随：${cursor}。请改用真实路径，或把文件放进项目里。`,
        { path: cursor, root },
      );
    }
    if (i < segments.length - 1 && !st.isDirectory()) {
      throw new ProjectError('E_NOT_DIRECTORY', `路径中间不是目录：${cursor}`, { path: cursor });
    }
  }

  return {
    path: full,
    relative: segments.join('/'),
    root,
    exists: resolvedExists && (await exists(full)),
  };
}

/**
 * 反过来验一个绝对路径：它真在项目里吗？真实路径（解析链接后）也必须在。
 * 宿主拿到模型给的一个路径时，用它做最后一道范围检查。
 */
export async function assertPathInProject(project, absolutePath) {
  const root = await realRoot(project);
  const abs = path.resolve(String(absolutePath ?? ''));
  if (!isInside(root, abs)) {
    throw new ProjectError('E_PATH_ESCAPE', `路径不在项目内：${abs}（项目根 ${root}）`, { root, path: abs });
  }
  let real = null;
  const st = await statOrNull(abs);
  if (st && st.isSymbolicLink()) {
    throw new ProjectError('E_SYMLINK', `路径是符号链接，拒绝：${abs}`, { path: abs });
  }
  if (st) {
    real = await fsp.realpath(abs);
    if (!isInside(root, real)) {
      throw new ProjectError('E_SYMLINK', `路径的真实位置跑出项目根：${abs} → ${real}`, { path: abs, real, root });
    }
  }
  return { path: abs, real, root, exists: Boolean(st) };
}

// ── 来源清单 ────────────────────────────────────────────────────────────────

/**
 * 读来源清单。文件不存在 = 还没复制过任何素材，正常。
 * 文件坏了 = 拒绝继续（不静默重建、不覆盖），因为清单本身就是"这些副本从哪来"的证据。
 */
export async function readProvenance(project) {
  const root = await realRoot(project);
  const file = path.join(root, LAYOUT.assets, PROVENANCE_FILE);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: LEDGER_VERSION, assets: [] };
    throw err;
  }
  if (raw.trim() === '') return { version: LEDGER_VERSION, assets: [] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProjectError(
      'E_MANIFEST',
      `来源清单不是合法 JSON，拒绝覆盖：${file}（${err.message}）。先手工修，或从备份恢复。`,
      { file },
    );
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.assets)) {
    throw new ProjectError('E_MANIFEST', `来源清单结构不对，应为 {version, assets: []}：${file}`, { file });
  }
  return parsed;
}

// ── 打开 / 新建项目 ─────────────────────────────────────────────────────────

/**
 * 打开项目；create:true 时新建（已存在则补齐缺失目录，幂等）。
 *
 * 新建只建空目录和一个 work/project.json，不写 plan.md——方案是创作内容，
 * 不能由工具凭空造一份"看起来像方案"的空壳。
 *
 * @param {string} workspace        工作区绝对路径（必须已存在）
 * @param {string} relativeProject  工作区内的项目相对路径，例如 `projects/机房科普`
 * @param {{create?: boolean}} [options]
 */
export async function openProject(workspace, relativeProject, options = {}) {
  const { create = false } = options;

  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new ProjectError('E_WORKSPACE', '缺少 workspace：要给工作区绝对路径。');
  }
  const wsAbs = path.resolve(workspace.trim());
  let wsStat;
  try {
    wsStat = await fsp.stat(wsAbs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new ProjectError('E_WORKSPACE', `工作区不存在：${wsAbs}`, { workspace: wsAbs });
    throw err;
  }
  if (!wsStat.isDirectory()) throw new ProjectError('E_WORKSPACE', `工作区不是目录：${wsAbs}`, { workspace: wsAbs });
  const wsReal = await fsp.realpath(wsAbs);

  const segments = normalizeRelative(relativeProject, '项目相对路径');
  if (segments.length === 0) {
    throw new ProjectError('E_PROJECT_PATH', 'relativeProject 不能为空：整个工作区不能直接当作品夹。');
  }
  for (const seg of segments) assertSafeSegment(seg);

  const { path: root } = await resolveProjectPath(wsReal, segments.join('/'));

  let created = false;
  let rootStat = await statOrNull(root);
  if (rootStat && !rootStat.isDirectory()) {
    throw new ProjectError('E_NOT_DIRECTORY', `项目路径已存在但不是目录：${root}`, { root });
  }
  if (!rootStat) {
    if (!create) {
      throw new ProjectError('E_MISSING', `项目不存在：${root}。要新建，传 { create: true }。`, { root });
    }
    await fsp.mkdir(root, { recursive: true });
    created = true;
    rootStat = await fsp.stat(root);
  }

  const dirs = {
    assets: path.join(root, LAYOUT.assets),
    work: path.join(root, LAYOUT.work),
    output: path.join(root, LAYOUT.output),
  };

  const missingBefore = [];
  for (const [key, dir] of Object.entries(dirs)) {
    const st = await statOrNull(dir);
    if (!st) missingBefore.push(key);
    else if (!st.isDirectory()) throw new ProjectError('E_NOT_DIRECTORY', `项目内的 ${key}/ 不是目录：${dir}`, { path: dir });
  }
  // 只在 create 时补目录：单纯"打开"不改磁盘。
  const createdDirs = [];
  if (create && missingBefore.length > 0) {
    for (const key of missingBefore) {
      await fsp.mkdir(dirs[key], { recursive: true });
      createdDirs.push(key);
    }
  }
  const missingDirs = [];
  for (const key of missingBefore) {
    if (createdDirs.includes(key)) continue;
    const st = await statOrNull(dirs[key]);
    if (!st) missingDirs.push(key);
  }

  const projectFile = path.join(dirs.work, PROJECT_META_FILE);
  let meta = null;
  if (create) {
    await fsp.mkdir(dirs.work, { recursive: true });
    const existing = await fsp.readFile(projectFile, 'utf8').catch(() => null);
    if (existing) {
      try {
        meta = JSON.parse(existing);
      } catch {
        meta = null; // 元数据坏了不阻塞；清单和素材才是真证据
      }
    }
    if (!meta) {
      meta = {
        version: 1,
        name: segments[segments.length - 1],
        relative: segments.join('/'),
        created: isoNow(),
        layout: { ...LAYOUT },
      };
      await writeJsonAtomic(projectFile, meta);
    }
  }

  const manifest = await readProvenance(root);

  return {
    root,
    rootReal: root,
    workspace: wsReal,
    name: segments[segments.length - 1],
    relative: segments.join('/'),
    created,
    createdDirs,
    dirs,
    missingDirs,
    projectFile,
    manifestPath: path.join(dirs.assets, PROVENANCE_FILE),
    manifest,
  };
}

// ── 素材复制 ────────────────────────────────────────────────────────────────

/**
 * 打包一批素材。每条可以是字符串（绝对路径）或对象：
 *   { path, root?, as?, note?, license?, authorized? }
 *
 * 传进这个函数这件事本身，就是"宿主已核实这些是用户为本次作品明确授权的素材"的声明。
 * 显式写 authorized:false 的会被直接拒绝（用于宿主自己标错的兜底）。
 */
function normalizeSources(sources) {
  const arr = Array.isArray(sources) ? sources : [sources];
  const out = [];
  for (const raw of arr) {
    if (raw === null || raw === undefined) continue;
    const item = typeof raw === 'string' ? { path: raw } : raw;
    if (typeof item.path !== 'string' || item.path.trim() === '') {
      throw new ProjectError('E_SOURCES', '每条素材都要给 path（文件或目录的绝对路径）。');
    }
    if (item.authorized === false) {
      throw new ProjectError(
        'E_NOT_AUTHORIZED',
        `素材被标为未授权，拒绝复制：${item.path}。只复制用户本次明确提供或授权的素材。`,
        { path: item.path },
      );
    }
    out.push({
      path: item.path.trim(),
      root: typeof item.root === 'string' ? item.root : null,
      as: typeof item.as === 'string' && item.as.trim() !== '' ? item.as.trim() : null,
      note: typeof item.note === 'string' ? item.note : '',
      license: typeof item.license === 'string' ? item.license : null,
      authorized: item.authorized ?? null,
    });
  }
  if (out.length === 0) {
    throw new ProjectError('E_SOURCES', 'sources 为空：要给出本次用户明确授权的素材路径列表。');
  }
  return out;
}

async function walkFiles(dirAbs, rootAbs, out, depth, counter) {
  if (depth > MAX_DEPTH) {
    throw new ProjectError('E_TOO_DEEP', `素材目录嵌套超过 ${MAX_DEPTH} 层，拒绝展开：${dirAbs}`);
  }
  const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const abs = path.join(dirAbs, ent.name);
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) {
      throw new ProjectError(
        'E_SYMLINK',
        `素材目录里有符号链接，拒绝跟随：${abs}。链接可能指到项目外，先换成真实文件。`,
        { path: abs },
      );
    }
    if (st.isDirectory()) {
      await walkFiles(abs, rootAbs, out, depth + 1, counter);
      continue;
    }
    if (!st.isFile()) continue; // 管道、设备这类一律跳过，不复制
    counter.count += 1;
    if (counter.count > MAX_FILES_PER_SOURCE) {
      throw new ProjectError('E_TOO_MANY', `素材目录文件数超过 ${MAX_FILES_PER_SOURCE}，拒绝一次展开：${rootAbs}`);
    }
    out.push({ srcAbs: abs, rel: path.relative(rootAbs, abs) });
  }
}

async function expandSource(item, options) {
  let abs;
  if (item.root) {
    const r = await resolveProjectPath(item.root, item.path);
    abs = r.path;
  } else if (path.isAbsolute(item.path)) {
    abs = path.resolve(item.path);
  } else if (options.cwd) {
    abs = path.resolve(options.cwd, item.path);
  } else {
    throw new ProjectError(
      'E_SOURCE_RELATIVE',
      `素材路径要给绝对路径（或同时给 root / cwd）：${item.path}。不确定当前目录时不要猜。`,
      { path: item.path },
    );
  }

  let st;
  try {
    st = await fsp.lstat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ProjectError('E_SOURCE_MISSING', `素材不存在：${abs}（原件未动，本次没有复制任何内容）`, { path: abs });
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new ProjectError('E_SYMLINK', `素材本身是符号链接，拒绝跟随：${abs}。请给出真实文件路径。`, { path: abs });
  }

  const displayName = sanitizeName(item.as ?? path.basename(abs), 'asset');

  if (st.isFile()) {
    return {
      root: abs,
      kind: 'file',
      name: displayName,
      note: item.note,
      license: item.license,
      files: [{ srcAbs: abs, rel: displayName, sha256: await sha256File(abs), bytes: st.size }],
    };
  }

  if (st.isDirectory()) {
    const found = [];
    await walkFiles(abs, abs, found, 0, { count: 0 });
    if (found.length === 0) {
      throw new ProjectError('E_SOURCE_EMPTY', `素材目录里没有文件：${abs}`, { path: abs });
    }
    const files = [];
    for (const f of found) {
      const fst = await fsp.stat(f.srcAbs);
      files.push({
        srcAbs: f.srcAbs,
        rel: toPosix(f.rel),
        sha256: await sha256File(f.srcAbs),
        bytes: fst.size,
      });
    }
    return { root: abs, kind: 'dir', name: displayName, note: item.note, license: item.license, files };
  }

  throw new ProjectError('E_SOURCE_TYPE', `不是普通文件或目录，拒绝复制：${abs}`, { path: abs });
}

/** 这份素材是不是上次已经整份进来过（按来源根 + 每个文件的相对路径与哈希判）。 */
function findImported(manifest, expanded) {
  const candidates = (manifest.assets || []).filter((a) => a.sourceRoot === expanded.root && a.kind === expanded.kind);
  if (candidates.length < expanded.files.length) return null;
  for (const file of expanded.files) {
    const hit = candidates.find((a) => a.source === file.srcAbs && a.sha256 === file.sha256);
    if (!hit) return null;
  }
  return candidates[0];
}

/**
 * 挑一个落盘名：保持了原名（含中文）优先，撞名时按 Windows 习惯加 (2)、(3)。
 * 永远不覆盖已有文件，也永远不占用来源清单自己的名字。
 */
async function pickDestName(assetsDir, desired, kind, taken) {
  const reserved = new Set([nameKey(PROVENANCE_FILE)]);
  const candidates = [];
  if (kind === 'file') {
    const ext = path.extname(desired);
    const base = ext ? desired.slice(0, -ext.length) : desired;
    candidates.push(desired);
    for (let i = 2; i <= 999; i += 1) candidates.push(`${base} (${i})${ext}`);
  } else {
    candidates.push(desired);
    for (let i = 2; i <= 999; i += 1) candidates.push(`${desired}-${i}`);
  }

  for (const name of candidates) {
    const key = nameKey(name);
    if (reserved.has(key) || taken.has(key)) continue;
    if (await exists(path.join(assetsDir, name))) continue;
    taken.add(key);
    return name;
  }
  throw new ProjectError('E_NAME_EXHAUSTED', `同名文件太多，找不到可用名字：${desired}`, { desired });
}

async function removeQuietly(p, { recursive = false } = {}) {
  try {
    if (recursive) await fsp.rm(p, { recursive: true, force: true });
    else await fsp.unlink(p);
  } catch {
    /* 回滚尽力而为；失败不掩盖原始错误 */
  }
}

/**
 * 把素材复制进项目 assets/，原件保持不动。
 *
 * 行为要点：
 *   - 先展开、校验、哈希，全部通过后才开始写盘（atomic 默认 true）。
 *   - 先复制到 assets/.import-* 暂存区，校验哈希后再就位；任何一步失败整批回滚。
 *   - 同一份素材第二次调用直接 skipped（already-imported），不会长出一堆副本。
 *   - 同名不同内容 → 自动改名，两份都留；不覆盖、不静默丢。
 *   - 来源清单最后一步原子写，写失败同样回滚。
 *
 * @param {string|{root:string}} project
 * @param {Array<string|object>} sources
 * @param {{atomic?:boolean, cwd?:string, note?:string}} [options]
 */
export async function importAssets(project, sources, options = {}) {
  const { atomic = true, cwd = null, note = '', signal = null } = options;
  const root = await realRoot(project);
  const requested = normalizeSources(sources);
  const assetsDir = path.join(root, LAYOUT.assets);
  const manifest = await readProvenance(root);

  const checkAborted = () => {
    if (signal?.aborted) {
      throw new ProjectError('E_ABORTED', '复制被取消；已回滚，原件未动。', { reason: String(signal.reason ?? 'aborted') });
    }
  };

  const skipped = [];
  const failures = [];
  const expanded = [];

  // ① 展开 + 校验（只读原件）
  for (const item of requested) {
    checkAborted();
    try {
      expanded.push(await expandSource(item, { cwd }));
    } catch (err) {
      if (atomic) throw err;
      failures.push({ source: item.path, code: err.code || 'E_UNKNOWN', message: err.message });
    }
  }

  // ② 先去重：已整份进来过的直接跳过
  const pending = [];
  for (const src of expanded) {
    if (isInside(assetsDir, src.root)) {
      skipped.push({ source: src.root, reason: 'already-in-project' });
      continue;
    }
    const dup = findImported(manifest, src);
    if (dup) {
      skipped.push({ source: src.root, dest: dup.dest, reason: 'already-imported' });
      continue;
    }
    pending.push(src);
  }

  const baseResult = {
    ok: failures.length === 0,
    root,
    assetsDir,
    manifestPath: path.join(assetsDir, PROVENANCE_FILE),
    imported: [],
    skipped,
    failures,
  };
  if (pending.length === 0) return baseResult;

  await fsp.mkdir(assetsDir, { recursive: true });

  // 暂存区按调用隔离：并发会话各用各的目录，不会互相删对方的半成品。
  const stageRoot = path.join(assetsDir, `.import-${process.pid}-${randomBytes(6).toString('hex')}`);
  await fsp.mkdir(stageRoot, { recursive: true });

  const imported = [];
  const placedFiles = [];
  const placedDirs = [];

  try {
    // ③ 复制到暂存区并校验哈希（锁外做，慢复制不堵别的会话）
    const stagedSources = [];
    for (let idx = 0; idx < pending.length; idx += 1) {
      checkAborted();
      const src = pending[idx];
      const stageDir = path.join(stageRoot, String(idx));
      await fsp.mkdir(stageDir, { recursive: true });

      const staged = [];
      for (const file of src.files) {
        checkAborted();
        const stageFile = path.join(stageDir, file.rel);
        await fsp.mkdir(path.dirname(stageFile), { recursive: true });
        await fsp.copyFile(file.srcAbs, stageFile);
        const copied = await sha256File(stageFile);
        if (copied !== file.sha256) {
          throw new ProjectError(
            'E_COPY_MISMATCH',
            `复制后哈希不一致，已放弃这一批：${file.srcAbs}（原件 ${file.sha256.slice(0, 12)}… / 副本 ${copied.slice(0, 12)}…）`,
            { path: file.srcAbs },
          );
        }
        staged.push({ ...file, stageFile });
      }
      stagedSources.push({ src, staged });
    }

    // ④ 就位 + 记清单：这一段持锁，因为要基于**最新**清单去重、挑名字、追加条目。
    //    两个会话同时导入时，后进的那个会重新判重，不会拿旧清单覆盖别人的登记。
    const next = await withManifestLock(assetsDir, async () => {
      const fresh = await readProvenance(root);
      const taken = new Set();
      const merged = [...(fresh.assets || [])];
      const placed = [];

      try {
        for (const { src, staged } of stagedSources) {
          checkAborted();
          const dup = findImported(fresh, src);
          if (dup) {
            skipped.push({ source: src.root, dest: dup.dest, reason: 'already-imported' });
            continue;
          }

          const destName = await pickDestName(assetsDir, src.name, src.kind, taken);
          const destAbs = path.join(assetsDir, destName);

          if (src.kind === 'file') {
            await fsp.rename(staged[0].stageFile, destAbs);
            placedFiles.push(destAbs);
            placed.push(destAbs);
          } else {
            await fsp.mkdir(destAbs, { recursive: true });
            placedDirs.push(destAbs);
            placed.push(destAbs);
            for (const file of staged) {
              const target = path.join(destAbs, file.rel);
              await fsp.mkdir(path.dirname(target), { recursive: true });
              await fsp.rename(file.stageFile, target);
              placedFiles.push(target);
              placed.push(target);
            }
          }

          const importedAt = isoNow();
          for (const file of staged) {
            const target = src.kind === 'file' ? destAbs : path.join(destAbs, file.rel);
            const entry = {
              source: file.srcAbs,
              sourceRoot: src.root,
              kind: src.kind,
              dest: toPosix(path.relative(root, target)),
              sha256: file.sha256,
              bytes: file.bytes,
              importedAt,
              note: note || '',
            };
            merged.push(entry);
            imported.push(entry);
          }
        }

        const value = {
          ...fresh,
          version: LEDGER_VERSION,
          updatedAt: isoNow(),
          assets: merged,
        };
        // 清单最后写：写失败就回滚这一批，不留"有文件没来源"的状态。
        await writeJsonAtomic(path.join(assetsDir, PROVENANCE_FILE), value);
        return value;
      } catch (err) {
        for (const target of placed.reverse()) await removeQuietly(target);
        throw err;
      }
    });

    baseResult.imported = imported;
    baseResult.manifest = next;
    baseResult.ok = failures.length === 0;
  } catch (err) {
    await removeQuietly(stageRoot, { recursive: true });
    for (const file of placedFiles.reverse()) await removeQuietly(file);
    for (const dir of placedDirs.reverse()) await removeQuietly(dir, { recursive: true });
    throw err;
  }

  await removeQuietly(stageRoot, { recursive: true });
  return baseResult;
}

/**
 * 核对项目内副本：文件还在不在、内容还是不是当初那份。
 * 原件被删、被移动、网络盘断开之后，项目副本照样能验、能用——这是"断网/原路径变化"的验收点。
 */
export async function verifyAssets(project) {
  const root = await realRoot(project);
  const manifest = await readProvenance(root);
  const missing = [];
  const changed = [];
  let checked = 0;

  for (const entry of manifest.assets || []) {
    checked += 1;
    const abs = path.resolve(root, entry.dest || '');
    if (!isInside(root, abs)) {
      changed.push({ ...entry, reason: 'dest-outside-project' });
      continue;
    }
    const st = await statOrNull(abs);
    if (!st || !st.isFile()) {
      missing.push(entry);
      continue;
    }
    const actual = await sha256File(abs);
    if (actual !== entry.sha256) changed.push({ ...entry, actual });
  }

  return {
    ok: missing.length === 0 && changed.length === 0,
    checked,
    missing,
    changed,
    manifestPath: path.join(root, LAYOUT.assets, PROVENANCE_FILE),
  };
}

/** 只列出项目里有哪些副本（给模型/宿主做"我手头有什么"的一次性回看）。 */
export async function listAssets(project) {
  const root = await realRoot(project);
  const manifest = await readProvenance(root);
  return (manifest.assets || []).map((a) => ({
    dest: a.dest,
    source: a.source,
    bytes: a.bytes,
    sha256: a.sha256,
    importedAt: a.importedAt,
    note: a.note || '',
  }));
}
