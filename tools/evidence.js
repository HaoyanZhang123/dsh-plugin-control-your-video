#!/usr/bin/env node
/**
 * evidence.js — control-your-video 的证据索引与方案检查工具
 *
 * 五个动作合成一个脚本：extract / measure / recall / gc / plan-check。
 * 接口定义见 docs/编写规范.md §1.5 与 §1.6；用法见 tools/evidence.md。
 *
 * 设计约束（都来自规范，不是可选项）：
 *   - 索引是一个 JSON 数组，字段名固定，不改名。
 *   - 去重键 (revision, shot, t, purpose)：同键只存一份。
 *   - 重渲不覆盖旧证据：新修订另起条目，旧条目标 superseded，旧文件不删。
 *   - 默认只返回 current。
 *   - gc 只清 superseded，且必须显式确认。
 *
 * 依赖：Node 18+（内置 fetch 不需要，只用 fs/path/crypto/child_process）；
 *       extract 与部分 measure 需要本机已装 ffmpeg / ffprobe。
 *       本模块不安装任何东西，找不到工具就如实失败。
 *
 * 不做什么：不抽全片、不预抽、不判断画面好坏、不替用户下结论。
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { checkPlan } from './plan-check.js';

/** plan-check 的严重度标签，与 tools/plan-check.js 里的一致。 */
const SEVERITY_RED = 'red';
const SEVERITY_YELLOW = 'yellow';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** §1.5 规定的用途枚举。写错用途等于用错尺子，所以这里挡住。 */
const PURPOSES = ['look', 'seam', 'text', 'motion', 'sync', 'mix', 'cover'];

/** §1.5 规定的状态枚举。 */
const STATUSES = ['current', 'superseded'];

/** 索引文件名，相对证据目录。 */
const INDEX_NAME = 'index.json';
const LOCAL_INPUT = ['-protocol_whitelist', 'file,pipe', '-format_whitelist',
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,mp3,aac,flac,ogg'];

/** gc 的回收目录（不真删，留一条后悔路）。 */
const TRASH_DIR = '_trash';

// ── 基础工具 ────────────────────────────────────────────────────────────────

function die(message, code = 1) {
  process.stderr.write(`evidence: ${message}\n`);
  process.exit(code);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** 秒，保留一位小数。规范里 t 就是一位小数。 */
function toTenths(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) die(`--t 必须是 >= 0 的数字，收到 ${value}`);
  return Math.round(n * 10) / 10;
}

/** 本地时间 ISO 串，带时区偏移。 */
function nowIso() {
  const d = new Date();
  const pad = (v, w = 2) => String(Math.abs(v)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** 源文件 sha256，流式读，避免大文件吃内存。 */
async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** 原子写：先写临时文件再 rename，避免中途失败把索引写坏。 */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/** 找 ffmpeg/ffprobe。找不到就如实失败，不假装成功。 */
function requireTool(name) {
  const probe = spawnSync(name, ['-version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    die(`找不到 ${name}。这个动作需要本机已装 ${name}（本工具不负责安装）。`);
  }
}

/** 跑一条外部命令，失败时把 stderr 带出来。 */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}：${(r.stderr || '').trim().slice(0, 800)}`);
  return r;
}

// ── 索引读写 ────────────────────────────────────────────────────────────────

function indexPath(dir) {
  return path.join(dir, INDEX_NAME);
}

async function readIndex(dir) {
  const file = indexPath(dir);
  const info = await fsp.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) die('证据索引必须是普通文件。');
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    die(`读不到 ${file}：${err.message}`);
  }
  if (raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die(`${file} 不是合法 JSON：${err.message}。索引坏了不要猜，先手工修或从备份恢复。`);
  }
  if (!Array.isArray(parsed)) die(`${file} 顶层必须是数组（规范 §1.5）。`);
  for (const [i, entry] of parsed.entries()) {
    for (const key of ['id', 'file', 'revision', 'shot', 't', 'purpose', 'status']) {
      if (!(key in entry)) die(`${file} 第 ${i + 1} 条缺字段 ${key}，索引已走形。`);
    }
  }
  return parsed;
}

async function writeIndex(dir, entries) {
  await writeJsonAtomic(indexPath(dir), entries);
}

/** 确保证据目录存在。只建这一层，不建全片结构。 */
async function ensureDir(dir) {
  if (!dir) die('缺少 --dir（作品文件夹下的 work/evidence）。');
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * 去重键：同一 (revision, shot, t, purpose) 只存一份。
 * 返回命中的 current 条目或 undefined。
 */
function findDuplicate(entries, revision, shot, t, purpose, sheet = false) {
  return entries.find(
    (e) =>
      isSheet(e) === sheet &&
      e.revision === revision &&
      Number(e.shot) === Number(shot) &&
      Math.abs(Number(e.t) - Number(t)) < 0.05 &&
      e.purpose === purpose &&
      e.status === 'current',
  );
}

/** 新修订到手后，把同 (shot, t, purpose) 的旧修订标 superseded（旧文件不删）。 */
function supersedeOlder(entries, revision, shot, t, purpose, sheet = false) {
  let changed = 0;
  for (const e of entries) {
    if (
      isSheet(e) === sheet &&
      e.revision !== revision &&
      Number(e.shot) === Number(shot) &&
      Math.abs(Number(e.t) - Number(t)) < 0.05 &&
      e.purpose === purpose &&
      e.status === 'current'
    ) {
      e.status = 'superseded';
      changed += 1;
    }
  }
  return changed;
}

/** 拼 id：r{修订}-s{镜号}-{t}s-{用途}[派生后缀]。 */
function makeId(revision, shot, t, purpose, derivedSuffix = '') {
  const rev = String(revision).startsWith('r') ? String(revision) : `r${revision}`;
  const shotNo = String(Number(shot)).padStart(2, '0');
  return `${rev}-s${shotNo}-${toTenths(t).toFixed(1)}s-${purpose}${derivedSuffix}`;
}

// ── 动作：extract ───────────────────────────────────────────────────────────

/**
 * 从成片抽一帧（可裁剪）并写入证据目录与索引。
 *
 * 为什么必须从成片抽：规范与口径都要求"抽帧必须从成片 MP4 抽，不能用预览页"。
 * 预览页与编码后的成片不是同一份事实。
 */
async function actionExtract(opts) {
  requireTool('ffmpeg');
  const dir = opts.dir;
  await ensureDir(dir);
  if (!opts.source) die('缺少 --source（成片或素材的绝对/相对路径）。');
  if (!fs.existsSync(opts.source)) die(`--source 不存在：${opts.source}`);
  if (!opts.revision) die('缺少 --revision（如 r1、r2）。');
  if (!opts.shot) die('缺少 --shot（镜号，整数）。');
  const t = toTenths(opts.t === undefined ? NaN : opts.t);
  if (!opts.purpose) die(`缺少 --purpose（${PURPOSES.join(' / ')}）。`);
  if (!PURPOSES.includes(opts.purpose)) {
    die(`--purpose 只能是 ${PURPOSES.join(' / ')}，收到 ${opts.purpose}。用途写错，这条证据就答不了对的问题。`);
  }

  const entries = await readIndex(dir);
  const dup = findDuplicate(entries, opts.revision, opts.shot, t, opts.purpose);
  if (dup && !opts.force) {
    log(`已存在同键证据，复用不重抽：${dup.id}（要重抽加 --force）`);
    return;
  }

  const cropSuffix = opts.crop ? '-crop' : '';
  const id = makeId(opts.revision, opts.shot, t, opts.purpose, cropSuffix);
  const fileName = `${id}.png`;
  const filePath = path.join(dir, fileName);

  const args = ['-y', '-ss', String(t), ...LOCAL_INPUT, '-i', opts.source, '-frames:v', '1'];
  if (opts.crop) {
    // x,y,w,h 物理像素
    const parts = String(opts.crop).split(',').map((v) => Number(v.trim()));
    if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
      die('--crop 要写成 x,y,w,hh（四个整数）。');
    }
    args.push('-vf', `crop=${parts[2]}:${parts[3]}:${parts[0]}:${parts[1]}`);
  }
  const temporary = path.join(dir, `.frame-${randomUUID()}.png`);
  args.push('-q:v', '2', temporary);
  try {
    run('ffmpeg', args);
    if (!fs.existsSync(temporary)) throw new Error('ffmpeg 未生成预期的抽帧文件。');
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }

  const sourceSha = await sha256(opts.source);

  if (dup && opts.force) {
    const i = entries.indexOf(dup);
    entries[i] = {
      ...dup,
      file: fileName,
      source_sha256: sourceSha,
      created: nowIso(),
      question: opts.question || dup.question,
      finding: '',
      status: 'current',
    };
    await writeIndex(dir, entries);
    log(`重抽完成：${id}（finding 已清空，需要重新看一遍）`);
    return;
  }

  const superseded = supersedeOlder(entries, opts.revision, opts.shot, t, opts.purpose);

  entries.push({
    id,
    file: fileName,
    revision: String(opts.revision),
    shot: Number(opts.shot),
    t,
    purpose: opts.purpose,
    source_sha256: sourceSha,
    derived_from: opts.derivedFrom || (opts.crop ? null : null),
    created: nowIso(),
    // 问题必须现在写。写不出问题的取证，本来就不该发生。
    question: opts.question || '',
    finding: '',
    status: 'current',
  });

  await writeIndex(dir, entries);
  log(`已抽取：${fileName}`);
  if (!opts.question) log('注意：没写 --question。这条证据暂时回答不了任何问题，看之前先补上。');
  if (superseded) log(`已把 ${superseded} 条同键的旧修订标为 superseded（旧文件保留）。`);
}

// ── 动作：sheet（联系表） ────────────────────────────────────────────────────

/** 带 span 的是联系表；它和同键的单帧证据互不替代。 */
function isSheet(entry) {
  return typeof entry.span === 'number';
}

/**
 * 把一段时间里的若干帧拼成一张联系表。
 *
 * 为什么需要它：单帧看不出运动。判"这一段动得顺不顺""节奏对不对"要看到连续变化，
 * 而一次一帧地抽既慢又会丢掉帧间的顺序关系。联系表是**导航级**证据——它让你知道
 * 该回看哪几秒、这段时间里发生了什么，但它仍然不能代替连续观看。
 */
async function actionSheet(opts) {
  requireTool('ffmpeg');
  const dir = opts.dir;
  await ensureDir(dir);
  if (!opts.source) die('缺少 --source（成片或素材的绝对/相对路径）。');
  if (!fs.existsSync(opts.source)) die(`--source 不存在：${opts.source}`);
  if (!opts.revision) die('缺少 --revision（如 r1、r2）。');
  if (!opts.shot) die('缺少 --shot（镜号，整数）。');

  const t = toTenths(opts.t === undefined ? NaN : opts.t);
  const span = Number(opts.span === undefined ? 2 : opts.span);
  if (!Number.isFinite(span) || span <= 0 || span > 30) {
    die('--span 是这张表覆盖的秒数，取 0—30（默认 2）。');
  }
  const count = Number(opts.count === undefined ? 6 : opts.count);
  if (!Number.isInteger(count) || count < 2 || count > 12) {
    die('--count 是抽几帧，取 2—12（默认 6）。');
  }
  const cols = Number(opts.cols === undefined ? 3 : opts.cols);
  if (!Number.isInteger(cols) || cols < 1 || cols > count) {
    die('--cols 是列数，取 1—count（默认 3）。');
  }
  const purpose = opts.purpose || 'motion';
  if (!PURPOSES.includes(purpose)) {
    die(`--purpose 只能是 ${PURPOSES.join(' / ')}，收到 ${opts.purpose}。`);
  }

  const rows = Math.ceil(count / cols);
  const id = makeId(opts.revision, opts.shot, t, purpose, `-sheet${count}x${cols}`);
  const fileName = `${id}.png`;
  const filePath = path.join(dir, fileName);

  const entries = await readIndex(dir);
  const existing = entries.find((e) => e.id === id && e.status === 'current');
  if (existing && !opts.force) {
    log(`已存在这张联系表，复用不重抽：${id}（要重抽加 --force）`);
    return;
  }

  // 每格 480 宽：单张看得清，整张又能被一次读完。
  const tileWidth = 480;
  const filter = `fps=${(count / span).toFixed(6)},showinfo,scale=${tileWidth}:-2,`
    + `tile=${cols}x${rows}:nb_frames=${count}:padding=4:margin=6`;
  const temporary = path.join(dir, `.sheet-${randomUUID()}.png`);
  let result;
  try {
    result = run('ffmpeg', [
      // -copyts：让每格的时间点是成片里的绝对时间，不是从 0 开始的相对时间。
      '-y', '-copyts', '-ss', String(t), '-t', String(span), ...LOCAL_INPUT, '-i', opts.source,
      '-vf', filter, '-frames:v', '1', temporary,
    ]);
    if (!fs.existsSync(temporary)) throw new Error('ffmpeg 未生成预期的联系表文件。');
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }

  // 帧的真实时间点来自 showinfo：有了它，第几格对应第几秒不用猜。
  const times = [...String(result.stderr || '').matchAll(/pts_time:\s*(-?[0-9.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((v) => Number.isFinite(v))
    .slice(0, count);

  const sourceSha = await sha256(opts.source);
  const entry = {
    id,
    file: fileName,
    revision: String(opts.revision),
    shot: Number(opts.shot),
    t,
    purpose,
    span,
    count,
    cols,
    times,
    source_sha256: sourceSha,
    derived_from: null,
    created: nowIso(),
    question: opts.question || '',
    finding: '',
    status: 'current',
  };

  const superseded = supersedeOlder(entries, opts.revision, opts.shot, t, purpose, true);
  if (existing) {
    entries[entries.indexOf(existing)] = { ...entry, question: opts.question || existing.question };
  } else {
    entries.push(entry);
  }
  await writeIndex(dir, entries);

  log(`已生成联系表：${fileName}`);
  log(`  覆盖 ${t}—${(t + span).toFixed(1)} 秒，${count} 帧，格 ${cols}×${rows}`
    + (times.length === count ? '' : `（实际只取到 ${times.length} 帧）`));
  if (times.length) log(`  各格时间：${times.map((v) => v.toFixed(2)).join(' / ')} 秒`);
  log('  它用来导航和看变化，不能当成连续播放的结论。');
  if (!opts.question) log('注意：没写 --question。这张表暂时回答不了任何问题，看之前先补上。');
  if (superseded) log(`已把 ${superseded} 条同键的旧修订标为 superseded（旧文件保留）。`);
}

// ── 动作：measure ───────────────────────────────────────────────────────────

/** 用 ffprobe 取时长与流信息。 */
function probeMedia(file) {
  requireTool('ffprobe');
  const r = run('ffprobe', [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-print_format', 'json',
    file,
  ]);
  try {
    return JSON.parse(r.stdout);
  } catch {
    die('ffprobe 输出不是 JSON，无法解析。');
  }
}

/**
 * 确定性测量。只测与当前风险有关且工具可用的项，不做"能测就全测"。
 *
 * kind：
 *   duration  时长与流（不需要 ffmpeg，用 ffprobe）
 *   black     黑帧区间（ffmpeg blackdetect）
 *   loudness  整片或一段的积分响度与真峰（ffmpeg ebur128, 单遍）
 *   silence   静音区间（ffmpeg silencedetect）
 */
async function actionMeasure(opts) {
  const dir = opts.dir;
  await ensureDir(dir);
  if (!opts.source) die('缺少 --source。');
  if (!fs.existsSync(opts.source)) die(`--source 不存在：${opts.source}`);
  // 测量可能发生在"还没定修订"的时候，不该因为少了修订就拒绝调用。
  // 缺省记为 r-unset，条目里一眼能看出"这次没挂到具体修订上"。
  // 不用 r? 之类带 ? 的写法：? 在 Windows 文件名里非法。
  if (!opts.revision) opts.revision = 'r-unset';
  const shot = opts.shot ? Number(opts.shot) : 0;
  const kind = opts.kind || 'duration';
  const t = opts.t === undefined ? 0 : toTenths(opts.t);
  const purpose = opts.purpose || (kind === 'loudness' || kind === 'silence' ? 'mix' : 'seam');
  if (!PURPOSES.includes(purpose)) {
    die(`--purpose 只能是 ${PURPOSES.join(' / ')}，收到 ${purpose}。`);
  }

  const entries = await readIndex(dir);
  const id = makeId(opts.revision, shot, t, purpose, `-${kind}`);
  const fileName = `${id}.json`;
  const filePath = path.join(dir, fileName);

  let result;

  if (kind === 'duration') {
    const info = probeMedia(opts.source);
    const v = (info.streams || []).find((s) => s.codec_type === 'video');
    const a = (info.streams || []).find((s) => s.codec_type === 'audio');
    result = {
      kind,
      // 容器时长与视频流时长分开报：容器 Duration 完整、视频流可能缺后半段，这是两个事实。
      container_duration_s: Number(info.format?.duration ?? NaN),
      video_duration_s: v ? Number(v.duration ?? NaN) : null,
      video_codec: v?.codec_name ?? null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      nb_frames: v?.nb_frames ?? null,
      has_audio: Boolean(a),
      audio_duration_s: a ? Number(a.duration ?? NaN) : null,
      audio_codec: a?.codec_name ?? null,
      measured_at: nowIso(),
    };
  } else if (kind === 'black') {
    requireTool('ffmpeg');
    const r = spawnSync(
      'ffmpeg',
      [...LOCAL_INPUT, '-i', opts.source, '-vf', 'blackdetect=d=0.04:pix_th=0.10', '-an', '-f', 'null', '-'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    if (r.error || r.status !== 0) die('黑帧测量失败：' + (r.error?.message ?? r.stderr?.trim()));
    const lines = (r.stderr || '').split('\n').filter((l) => l.includes('black_start'));
    const spans = [];
    for (const line of lines) {
      const m = line.match(/black_start:([\d.]+)\s+black_end:([\d.]+)/);
      if (m) spans.push({ start_s: Number(m[1]), end_s: Number(m[2]), len_s: Number(m[2]) - Number(m[1]) });
    }
    result = {
      kind,
      spans,
      longest_s: spans.reduce((a, s) => Math.max(a, s.len_s), 0),
      // 有意淡入淡出会触发，所以这里只给事实，不给"有黑帧=缺陷"的结论。
      note: '黑场可能是有意的淡入淡出，判定要结合该镜的目的，不能只看这一项。',
      measured_at: nowIso(),
    };
  } else if (kind === 'loudness') {
    requireTool('ffmpeg');
    const args = [...LOCAL_INPUT, '-i', opts.source];
    if (opts.from !== undefined) args.push('-ss', String(Number(opts.from)));
    if (opts.to !== undefined) args.push('-to', String(Number(opts.to)));
    args.push('-af', 'ebur128=peak=true', '-f', 'null', '-');
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) die('音频测量失败：' + (r.error?.message ?? r.stderr?.trim()));
    const err = r.stderr || '';
    const summary = err.slice(err.lastIndexOf('Summary'));
    const I = summary.match(/I:\s*(-?[\d.]+)\s*LUFS/);
    const TP = summary.match(/Peak:\s*(-?[\d.]+)\s*dBFS/);
    const LRA = summary.match(/LRA:\s*(-?[\d.]+)\s*LU/);
    if (!I) die('没从 ffmpeg 输出里读到积分响度。这条测量不算完成，别用猜的数字填 finding。');
    result = {
      kind,
      integrated_lufs: Number(I[1]),
      true_peak_dbfs: TP ? Number(TP[1]) : null,
      lra_lu: LRA ? Number(LRA[1]) : null,
      range: { from_s: opts.from ?? 0, to_s: opts.to ?? null },
      // 响度达标不等于听感对，这条必须在结果里一起给出去。
      note: '响度是交付门槛，不是好听程度。达标不等于混音对，也不能代替真听一遍。',
      measured_at: nowIso(),
    };
  } else if (kind === 'silence') {
    requireTool('ffmpeg');
    const r = spawnSync(
      'ffmpeg',
      [...LOCAL_INPUT, '-i', opts.source, '-af', 'silencedetect=noise=-50dB:d=0.3', '-f', 'null', '-'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    if (r.error || r.status !== 0) die('音频测量失败：' + (r.error?.message ?? r.stderr?.trim()));
    const err = r.stderr || '';
    const spans = [];
    let start = null;
    for (const line of err.split('\n')) {
      const s = line.match(/silence_start:\s*(-?[\d.]+)/);
      const e = line.match(/silence_end:\s*(-?[\d.]+)/);
      if (s) start = Number(s[1]);
      if (e) {
        spans.push({ start_s: start ?? 0, end_s: Number(e[1]) });
        start = null;
      }
    }
    result = { kind, spans, measured_at: nowIso() };
  } else {
    die(`--kind 只能是 duration / black / loudness / silence，收到 ${kind}。`);
  }

  await fsp.writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const sourceSha = await sha256(opts.source);
  const dup = findDuplicate(entries, opts.revision, shot, t, purpose);
  const superseded = supersedeOlder(entries, opts.revision, shot, t, purpose);

  if (dup) {
    // 同一键已有条目：只更新文件与哈希，finding 清空——旧结论对应的是旧读数。
    Object.assign(dup, {
      file: fileName,
      source_sha256: sourceSha,
      created: nowIso(),
      finding: '',
    });
    await writeIndex(dir, entries);
    log(`重测完成：${dup.id}（finding 已清空）`);
  } else {
    entries.push({
      id,
      file: fileName,
      revision: String(opts.revision),
      shot,
      t,
      purpose,
      source_sha256: sourceSha,
      derived_from: null,
      created: nowIso(),
      question: opts.question || '',
      finding: '',
      status: 'current',
    });
    await writeIndex(dir, entries);
    log(`已测量：${fileName}`);
  }
  if (superseded) log(`已把 ${superseded} 条同键的旧修订标为 superseded。`);

  // 把读数直接打出来，方便当场写 finding。
  log(JSON.stringify(result, null, 2));
}

// ── 动作：recall ────────────────────────────────────────────────────────────

/**
 * 按镜头 / 时间 / 修订 / 状态查证据。默认只返回 current。
 * 对照改前时显式传 --status superseded 或 --status all。
 */
async function actionRecall(opts) {
  const dir = opts.dir;
  if (!dir) die('缺少 --dir。');
  const entries = await readIndex(dir);

  const status = opts.status || 'current';
  if (!['current', 'superseded', 'all'].includes(status)) {
    die('--status 只能是 current / superseded / all。');
  }
  if (opts.purpose && !PURPOSES.includes(opts.purpose)) {
    die(`--purpose 只能是 ${PURPOSES.join(' / ')}。`);
  }

  let hit = entries;
  if (status !== 'all') hit = hit.filter((e) => e.status === status);
  if (opts.revision) hit = hit.filter((e) => String(e.revision) === String(opts.revision));
  if (opts.shot !== undefined) hit = hit.filter((e) => Number(e.shot) === Number(opts.shot));
  if (opts.purpose) hit = hit.filter((e) => e.purpose === opts.purpose);
  if (opts.from !== undefined) hit = hit.filter((e) => Number(e.t) >= Number(opts.from));
  if (opts.to !== undefined) hit = hit.filter((e) => Number(e.t) <= Number(opts.to));
  if (opts.id) hit = hit.filter((e) => e.id === opts.id);

  hit = hit.slice().sort((a, b) => Number(a.t) - Number(b.t) || Number(a.shot) - Number(b.shot));

  if (opts.format === 'id') {
    for (const e of hit) log(e.id);
    return;
  }
  if (hit.length === 0) {
    log('没有匹配的证据。');
    return;
  }
  for (const e of hit) {
    log(`${e.id}  [${e.status}]  ${e.revision} / s${e.shot} / ${e.t}s / ${e.purpose}`);
    log(`    file: ${e.file}`);
    if (e.question) log(`    问：${e.question}`);
    // 空 finding 就是没看过。这里必须区分，不能糊成"已检查"。
    log(`    结论：${e.finding ? e.finding : '（未填 · 这条不算看过）'}`);
  }
}

// ── 动作：gc ────────────────────────────────────────────────────────────────

/**
 * 清理 superseded 条目与文件。
 *
 * 两条底线：
 *   1. 只清 superseded，绝不碰 current。
 *   2. 必须 --yes 才真动；不带 --yes 只做预演（列出来但不删）。
 * 文件不是直接删，而是移到 _trash/<时间戳>/，留一条后悔路。
 */
async function actionGc(opts) {
  const dir = opts.dir;
  if (!dir) die('缺少 --dir。');
  const entries = await readIndex(dir);

  const doomed = entries.filter((e) => e.status === 'superseded');
  const kept = entries.filter((e) => e.status !== 'superseded');

  if (doomed.length === 0) {
    log('没有 superseded 条目，不用清。');
    return;
  }

  log(`将清理 ${doomed.length} 条 superseded，保留 ${kept.length} 条 current：`);
  for (const e of doomed) log(`  - ${e.id} (${e.file})`);

  // current 与 superseded 文件同名时（同一 id 被复用），保 current 的。
  const keepFiles = new Set(kept.map((e) => e.file));
  const movable = doomed.filter((e) => !keepFiles.has(e.file));

  if (!opts.yes) {
    log('\n这是预演。确认无误后加 --yes 再跑一次。');
    return;
  }

  const stamp = nowIso().replace(/[:+]/g, '-').replace(/T/, '_');
  const trash = path.join(dir, TRASH_DIR, stamp);
  await fsp.mkdir(trash, { recursive: true });

  let moved = 0;
  for (const e of movable) {
    const from = path.join(dir, e.file);
    if (!fs.existsSync(from)) continue;
    await fsp.rename(from, path.join(trash, e.file));
    moved += 1;
  }

  await writeIndex(dir, kept);
  log(`\n已清理 ${doomed.length} 条索引，移走 ${moved} 个文件到 ${path.relative(dir, trash)}/。`);
  log('这些文件没被删掉；确认不再需要后再手工删那个目录。');
}

// ── plan-check：开工前的方案检查 ─────────────────────────────────────────────

/**
 * 检查一份 plan.md 是不是完整到可以开工。
 *
 * 与 evidence 的四个取证动作不同：它不看画面、不出证据条目，
 * 只把 docs/编写规范.md §1.6 的硬规则变成能跑的判断。
 * 判定逻辑全在 tools/plan-check.js，本函数只负责读文件与印结论。
 */
async function actionPlanCheck(opts) {
  let target = opts.dir || opts.plan;
  if (!target) die('缺少 --dir（作品夹）或 --plan（plan.md 路径）。');

  if (!fs.existsSync(target)) die(`路径不存在：${target}`);
  if (fs.statSync(target).isDirectory()) {
    target = path.join(target, 'plan.md');
    if (!fs.existsSync(target)) die(`目录里没有 plan.md。`);
  }

  const text = fs.readFileSync(target, 'utf8');
  const result = checkPlan(text);

  log(`plan-check: ${target}`);
  log('');
  if (result.state) {
    log(`  状态：${result.state.状态} · ${result.state.修订} · ${result.state.日期}`);
  } else {
    log('  状态：（缺）');
  }
  log('');
  for (const [k, v] of Object.entries(result.stats)) log(`  ${k}: ${v}`);
  log('');

  const reds = result.findings.filter((f) => f.level === SEVERITY_RED);
  const yellows = result.findings.filter((f) => f.level === SEVERITY_YELLOW);
  if (reds.length) {
    log(`  ✗ 红 ${reds.length} 条（不许进制作）`);
    for (const f of reds) log(`    [${f.code}] ${f.message}`);
    log('');
  }
  if (yellows.length) {
    log(`  △ 黄 ${yellows.length} 条（可以进，但要说清）`);
    for (const f of yellows) log(`    [${f.code}] ${f.message}`);
    log('');
  }
  if (!reds.length && !yellows.length) log('  ✓ 全项通过。');
  log('');
  log(`  结论：${result.pass ? '可以进制作' : '不许进制作'}`);

  if (!result.pass) process.exitCode = 1;
}

// ── 参数解析 ────────────────────────────────────────────────────────────────

const BOOL_FLAGS = new Set(['yes', 'force']);

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (BOOL_FLAGS.has(key)) {
      opts[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) die(`${arg} 后面缺值。`);
    opts[key] = next;
    i += 1;
  }
  return { action: positional[0], opts };
}

function usage() {
  process.stdout.write(
    [
      'evidence.js — 证据索引与方案检查工具（extract / sheet / measure / recall / gc / plan-check）',
      '',
      '用法：',
      '  node tools/evidence.js extract --dir <work/evidence> --source <成片> \\',
      '      --revision r3 --shot 4 --t 12.4 --purpose look \\',
      '      [--question "12.4 秒这条字幕有没有压到人脸？"] [--crop x,y,w,h] [--force]',
      '',
      '  node tools/evidence.js sheet --dir <work/evidence> --source <成片> \\',
      '      --revision r3 --shot 4 --t 12.4 --span 2 --count 6 [--cols 3] \\',
      '      [--purpose motion] [--question "这一段进入时人物有没有停住？"] [--force]',
      '',
      '  node tools/evidence.js measure --dir <work/evidence> --source <成片> \\',
      '      --revision r3 --shot 4 --kind duration|black|loudness|silence [--t 0] [--purpose mix]',
      '',
      '  node tools/evidence.js recall --dir <work/evidence> [--shot 4] [--revision r3] \\',
      '      [--purpose look] [--status current|superseded|all] [--from 10] [--to 14] [--id <id>]',
      '',
      '  node tools/evidence.js gc --dir <work/evidence> [--yes]',
      '',
      '  node tools/evidence.js plan-check --dir <作品夹>',
      '',
      'plan-check 只读 plan.md，不碰证据索引；有红时退出码 1，可当开工门禁。',
      '',
      `用途枚举：${PURPOSES.join(' / ')}`,
      '状态枚举：current / superseded',
      '',
      '字段定义见 docs/编写规范.md §1.5。',
      '',
    ].join('\n'),
  );
}

// ── 入口 ────────────────────────────────────────────────────────────────────

async function main() {
  const { action, opts } = parseArgs(process.argv.slice(2));
  if (!action || action === 'help' || opts.help) {
    usage();
    process.exit(action ? 0 : 1);
  }

  const table = {
    extract: actionExtract,
    sheet: actionSheet,
    measure: actionMeasure,
    recall: actionRecall,
    gc: actionGc,
    'plan-check': actionPlanCheck,
  };

  const fn = table[action];
  if (!fn) {
    usage();
    die(`未知动作 ${action}。只有 extract / sheet / measure / recall / gc / plan-check 六个。`);
  }

  await fn(opts);

  // 显式退出：spawnSync 的子进程句柄不该拖着主进程。
  // 用 exitCode 而不是硬写 0：plan-check 有红时会置 1，不能被这里抹掉。
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => die(`未处理的错误：${err?.stack || err}`));
