#!/usr/bin/env node
/**
 * production.js — control-your-video 的受控本地制作适配器
 *
 * 只做一件事：把**一份显式结构化的制作规格（spec）**渲染成真实的 MP4，并用
 * ffprobe 验证它确实是它声称的那样。它不决定镜号、不绑 plan、不审批、不管用户
 * 文件夹怎么组织——那些在上层。
 *
 * 设计约束（硬性的，不是可选项）：
 *
 *   1. 只吃结构数据。调用方不能传命令、脚本、FFmpeg filter 字符串、可执行文件
 *      路径、URL。所有 filter 由本模块按枚举和数值自己拼。
 *   2. 素材只能是**已经复制进作品夹的文件**（photo / video）或**内置参数化程序
 *      动画**（四种原创 pattern，逐帧在 Node 里生成后走管道）。没有网络源。
 *   3. 路径安全：素材路径必须是相对 projectRoot 的相对路径，不允许绝对路径、
 *      `..`、URL、盘符；解析后（含 realpath）必须仍在 projectRoot 内。
 *   4. 资源上限写死在 CAPS 里，超了直接拒绝，不做"尽力而为"。
 *   5. **绝不覆盖旧版**：输出文件已存在就报 E_OUTPUT_EXISTS。渲染先写同目录的
 *      临时文件，ffprobe 全项通过后才 rename 到目标名。
 *   6. 可取消：接受 AbortSignal，取消时杀掉子进程并清掉半成品。
 *
 * 为什么这么严：适配器是"模型能真的把片子渲出来"的唯一入口。一旦它可以接受
 * 任意 filter 或任意可执行文件，它就从适配器变成了 shell。
 *
 * 本机实测约束（ffmpeg 9.0.1 / Windows）：不指定 fontfile 的 drawtext 会直接崩
 * 溃（缺 fontconfig 配置），而 filter 参数里的绝对 Windows 路径无法转义。所以
 * 字体和字稿一律先复制/写进临时工作目录，filter 里只用相对文件名，并且字稿走
 * `textfile=` + `expansion=none`，这样 `%`、`:`、中文、换行都不会被当成表达式。
 *
 * 依赖：本机已装 ffmpeg 与 ffprobe。本模块不安装、不下载任何东西。
 */

import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { once } from 'node:events';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── 版本与上限 ──────────────────────────────────────────────────────────────

/** spec 的版本号。不认识就拒绝，不做兼容猜测。 */
export const PRODUCTION_SPEC_VERSION = 1;

/** 资源上限。超限一律拒绝。 */
export const CAPS = Object.freeze({
  width: { min: 160, max: 1920 },
  height: { min: 144, max: 1080 },
  fps: { min: 12, max: 60 },
  shots: { min: 1, max: 120 },
  shotDurationSec: { min: 0.2, max: 60 },
  totalDurationSec: { max: 600 },
  textLines: { min: 1, max: 6 },
  textLineChars: { max: 120 },
  textSizeScale: { min: 0.5, max: 3 },
  proceduralSpeed: { min: 0.25, max: 4 },
  assetBytes: { max: 256 * 1024 * 1024 },
  shotTimeoutMs: 180000,
  renderTimeoutMs: 900000,
  probeTimeoutMs: 60000,
});

/** 内置原创程序动画。名字是白名单，不是自由字符串。 */
export const PROCEDURAL_PATTERNS = Object.freeze([
  'gradient-drift',
  'bars-sweep',
  'grid-drift',
  'pulse-field',
]);

/** 视觉来源。 */
const VISUAL_KINDS = ['photo', 'video', 'procedural'];

/** 照片的镜头运动。pan/zoom 只对照片开放，且必须 cover。 */
const PHOTO_MOTIONS = ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right'];

/** 铺满方式。 */
const FITS = ['cover', 'contain'];

/** 声音模式。 */
const AUDIO_MODES = ['none', 'tone', 'asset', 'video'];

/** 屏上字位置。 */
const TEXT_POSITIONS = ['bottom', 'top', 'center'];

/** 允许的素材扩展名。别的一律拒绝，免得 ffmpeg 去解一个我们没想过的东西。 */
const IMAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const AUDIO_EXTENSIONS = Object.freeze(['.m4a', '.aac', '.mp3', '.wav', '.flac', '.ogg', '.opus']);

/**
 * 扩展名 → 强制 demuxer。
 *
 * 为什么要强制：ffmpeg 认的是内容不是扩展名。一个改名成 .mp4 的播放列表
 * （concat / HLS / DASH）会让 ffmpeg 去解引用的别的本地文件或网络地址。强制
 * demuxer 之后，内容对不上就解不出流，直接失败——它不能"顺着内容走"。
 * 再配合 `-protocol_whitelist file,pipe`，协议面也只剩本地文件与管道。
 */
const DEMUXERS = Object.freeze({
  '.jpg': 'image2',
  '.jpeg': 'image2',
  '.png': 'image2',
  '.webp': 'image2',
  '.bmp': 'image2',
  '.mp4': 'mov',
  '.m4v': 'mov',
  '.mov': 'mov',
  '.webm': 'webm',
  '.mkv': 'matroska',
  '.m4a': 'mov',
  '.aac': 'aac',
  '.mp3': 'mp3',
  '.wav': 'wav',
  '.flac': 'flac',
  '.ogg': 'ogg',
  '.opus': 'ogg',
});

/** 所有子进程都只允许这两个协议：本地文件与管道。网络协议一个都不给。 */
const PROTOCOL_WHITELIST = 'file,pipe';

/** 音频素材既可以是纯音频容器，也可以是**带音轨的视频容器**（独立字幕任务要用）。 */
const AUDIO_ASSET_EXTENSIONS = Object.freeze([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

/** 允许出现在 spec 里的顶层字段。多余字段一律拒绝（拼错字段名不该静默生效）。 */
const SPEC_KEYS = ['version', 'canvas', 'audio', 'shots'];
const CANVAS_KEYS = ['width', 'height', 'fps'];
const AUDIO_KEYS = {
  none: ['mode'],
  tone: ['mode', 'frequencyHz', 'gainDb'],
  asset: ['mode', 'path', 'loop', 'gainDb'],
  video: ['mode', 'shotId', 'gainDb'],
};
const SHOT_KEYS = ['id', 'durationSec', 'visual', 'text'];
const VISUAL_KEYS = {
  photo: ['kind', 'path', 'fit', 'motion', 'background'],
  video: ['kind', 'path', 'startSec', 'fit', 'motion', 'loop', 'background'],
  procedural: ['kind', 'pattern', 'colors', 'speed'],
};
const TEXT_KEYS = ['lines', 'position', 'startSec', 'endSec', 'sizeScale', 'color', 'box'];

const RENDER_OPTION_KEYS = ['projectRoot', 'spec', 'shotIds', 'range', 'sampleMaxSeconds', 'outputPath', 'signal'];

const DEFAULT_BACKGROUND = '#000000';
const DEFAULT_TEXT_COLOR = '#FFFFFF';

/** 系统字体候选，按优先级。找不到就 E_FONT，不静默丢字幕。 */
const FONT_CANDIDATES = Object.freeze({
  win32: [
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\msyhbd.ttc',
    'C:\\Windows\\Fonts\\Deng.ttf',
    'C:\\Windows\\Fonts\\simsun.ttc',
  ],
  darwin: [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
  ],
  linux: [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/arphic/uming.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ],
});

// ── 错误 ────────────────────────────────────────────────────────────────────

/**
 * 适配器只会抛这一种错。`code` 是稳定的机器可读分类，`details` 里放诊断信息。
 * 上层据此决定"是让模型改 spec"还是"告诉用户环境缺东西"。
 */
export class ProductionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProductionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 定长小数：只用于拼 filter，避免 0.30000000000000004 这种。 */
function fmt(value) {
  return String(Number(Number(value).toFixed(3)));
}

function toEven(value) {
  const n = Math.round(value);
  return n % 2 === 0 ? n : n + 1;
}

function tail(text, limit = 800) {
  const s = String(text ?? '').trim();
  return s.length <= limit ? s : `…${s.slice(-limit)}`;
}

/** 键排序后的 JSON，用于取稳定的 spec 指纹。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

// ── 路径安全 ────────────────────────────────────────────────────────────────

/**
 * 把调用方给的相对路径解析到 projectRoot 里面。
 * 解析是纯字符串层面的第一道门；realpath 的第二道门在校验素材时做。
 */
function localSegments(relative, field) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new ProductionError('E_PATH', `${field} 必须是非空字符串`);
  }
  if (relative.includes('\0')) {
    throw new ProductionError('E_PATH', `${field} 含 NUL 字符`);
  }
  if (/[\u0000-\u001f\u007f]/.test(relative)) {
    throw new ProductionError('E_PATH', `${field} 含控制字符`);
  }
  if (relative.includes(':')) {
    throw new ProductionError('E_PATH', `${field} 看起来是 URL；只接受作品夹内的本地文件`);
  }
  if (/^[A-Za-z]:/.test(relative) || relative.startsWith('\\') || relative.startsWith('/')) {
    throw new ProductionError('E_PATH', `${field} 必须是相对 projectRoot 的路径，不能是绝对路径`);
  }
  if (path.isAbsolute(relative)) {
    throw new ProductionError('E_PATH', `${field} 必须是相对路径`);
  }

  const segments = relative.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) {
    throw new ProductionError('E_PATH', `${field} 没有指向任何文件`);
  }
  if (segments.includes('..')) {
    throw new ProductionError('E_PATH', `${field} 不能包含 ..`);
  }

  return segments;
}

function resolveInsideRoot(rootAbs, relative, field) {
  const segments = localSegments(relative, field);
  const resolved = path.resolve(rootAbs, ...segments);
  const rel = path.relative(rootAbs, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ProductionError('E_PATH', `${field} 解析后越出了 projectRoot`);
  }
  return resolved;
}

/** 相对路径统一用正斜杠输出/记录，便于跨平台读。 */
function toPosixRelative(rootAbs, absPath) {
  return path.relative(rootAbs, absPath).split(path.sep).join('/');
}

// ── 规格校验 ────────────────────────────────────────────────────────────────

/**
 * 校验并规范化一份制作规格。
 *
 * 纯结构校验不需要 projectRoot；给了 projectRoot 就顺带确认每个素材真的在里面、
 * 扩展名对、没超过大小上限。
 *
 * @param {unknown} spec
 * @param {{ projectRoot?: string }} [options]
 * @returns {{ ok: true, errors: [], spec: object }
 *         | { ok: false, errors: Array<{ code: string, path: string, message: string }>, spec: null }}
 */
export function validateProductionSpec(spec, options = {}) {
  if (!isPlainObject(options)) {
    throw new ProductionError('E_OPTIONS', 'validateProductionSpec 的第二个参数必须是对象');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'projectRoot') {
      throw new ProductionError('E_OPTIONS', `validateProductionSpec 不认识选项 ${key}`);
    }
  }

  const errors = [];
  const add = (code, at, message) => errors.push({ code, path: at, message });

  if (!isPlainObject(spec)) {
    add('E_SPEC', '', 'spec 必须是对象');
    return { ok: false, errors, spec: null };
  }

  for (const key of Object.keys(spec)) {
    if (!SPEC_KEYS.includes(key)) {
      add('E_SPEC', key, `不认识的字段；只接受 ${SPEC_KEYS.join(' / ')}`);
    }
  }

  if (spec.version !== PRODUCTION_SPEC_VERSION) {
    add('E_SPEC', 'version', `必须是 ${PRODUCTION_SPEC_VERSION}，收到 ${JSON.stringify(spec.version)}`);
  }

  // ── canvas ──
  const canvas = { width: 0, height: 0, fps: 0 };
  if (!isPlainObject(spec.canvas)) {
    add('E_SPEC', 'canvas', '必须是对象 { width, height, fps }');
  } else {
    for (const key of Object.keys(spec.canvas)) {
      if (!CANVAS_KEYS.includes(key)) add('E_SPEC', `canvas.${key}`, `不认识的字段；只接受 ${CANVAS_KEYS.join(' / ')}`);
    }
    const readInt = (key, min, max) => {
      const value = spec.canvas[key];
      if (!Number.isInteger(value)) {
        add('E_SPEC', `canvas.${key}`, `必须是整数，收到 ${JSON.stringify(value)}`);
        return null;
      }
      if (value < min || value > max) {
        add('E_SPEC', `canvas.${key}`, `必须在 ${min}…${max} 之间，收到 ${value}`);
        return null;
      }
      return value;
    };
    canvas.width = readInt('width', CAPS.width.min, CAPS.width.max);
    canvas.height = readInt('height', CAPS.height.min, CAPS.height.max);
    canvas.fps = readInt('fps', CAPS.fps.min, CAPS.fps.max);
    if (canvas.width !== null && canvas.width % 2 !== 0) {
      add('E_SPEC', 'canvas.width', `必须是偶数（H.264 yuv420p 要求），收到 ${canvas.width}`);
      canvas.width = null;
    }
    if (canvas.height !== null && canvas.height % 2 !== 0) {
      add('E_SPEC', 'canvas.height', `必须是偶数（H.264 yuv420p 要求），收到 ${canvas.height}`);
      canvas.height = null;
    }
  }
  const canvasOk = canvas.width && canvas.height && canvas.fps;

  // ── audio ──
  let audio = null;
  if (!isPlainObject(spec.audio)) {
    add('E_SPEC', 'audio', '必须是对象，如 { mode: "none" }');
  } else if (!AUDIO_MODES.includes(spec.audio.mode)) {
    add('E_SPEC', 'audio.mode', `必须是 ${AUDIO_MODES.join(' / ')} 之一`);
  } else {
    const mode = spec.audio.mode;
    for (const key of Object.keys(spec.audio)) {
      if (!AUDIO_KEYS[mode].includes(key)) {
        add('E_SPEC', `audio.${key}`, `mode=${mode} 时不接受这个字段；只接受 ${AUDIO_KEYS[mode].join(' / ')}`);
      }
    }
    if (mode === 'none') {
      audio = { mode: 'none' };
    } else if (mode === 'tone') {
      const frequencyHz = spec.audio.frequencyHz;
      const gainDb = spec.audio.gainDb;
      let ok = true;
      if (!isFiniteNumber(frequencyHz) || frequencyHz < 20 || frequencyHz > 20000) {
        add('E_SPEC', 'audio.frequencyHz', '必须是 20…20000 之间的数字');
        ok = false;
      }
      if (!isFiniteNumber(gainDb) || gainDb < -60 || gainDb > 0) {
        add('E_SPEC', 'audio.gainDb', '必须是 -60…0 之间的数字');
        ok = false;
      }
      if (ok) audio = { mode: 'tone', frequencyHz, gainDb };
    } else if (mode === 'video') {
      // 保留所选视频镜的**源音轨**：不做外挂文件，起点自动跟着那一镜走。
      let ok = true;
      if (!Number.isInteger(spec.audio.shotId) || spec.audio.shotId < 1) {
        add('E_SPEC', 'audio.shotId', '必须是一个存在的视频镜号（整数）');
        ok = false;
      }
      const gainDb = spec.audio.gainDb === undefined ? 0 : spec.audio.gainDb;
      if (!isFiniteNumber(gainDb) || gainDb < -60 || gainDb > 0) {
        add('E_SPEC', 'audio.gainDb', '必须是 -60…0 之间的数字');
        ok = false;
      }
      if (ok) audio = { mode: 'video', shotId: spec.audio.shotId, gainDb };
    } else {
      let ok = true;
      if (!checkPathSyntax(spec.audio.path, 'audio.path', add)) ok = false;
      const loop = spec.audio.loop;
      if (loop !== undefined && typeof loop !== 'boolean') {
        add('E_SPEC', 'audio.loop', '必须是布尔值');
        ok = false;
      }
      const gainDb = spec.audio.gainDb === undefined ? 0 : spec.audio.gainDb;
      if (!isFiniteNumber(gainDb) || gainDb < -60 || gainDb > 0) {
        add('E_SPEC', 'audio.gainDb', '必须是 -60…0 之间的数字');
        ok = false;
      }
      if (ok) audio = { mode: 'asset', path: spec.audio.path, loop: loop === true, gainDb };
    }
  }

  // ── shots ──
  const shots = [];
  if (!Array.isArray(spec.shots)) {
    add('E_SPEC', 'shots', '必须是数组');
  } else if (spec.shots.length < CAPS.shots.min || spec.shots.length > CAPS.shots.max) {
    add('E_SPEC', 'shots', `镜数必须在 ${CAPS.shots.min}…${CAPS.shots.max} 之间，收到 ${spec.shots.length}`);
  } else {
    const seenIds = new Set();
    let cursorFrames = 0;
    spec.shots.forEach((rawShot, index) => {
      const at = `shots[${index}]`;
      if (!isPlainObject(rawShot)) {
        add('E_SPEC', at, '必须是对象');
        return;
      }
      for (const key of Object.keys(rawShot)) {
        if (!SHOT_KEYS.includes(key)) add('E_SPEC', `${at}.${key}`, `不认识的字段；只接受 ${SHOT_KEYS.join(' / ')}`);
      }

      const id = rawShot.id;
      if (!Number.isInteger(id) || id < 1) {
        add('E_SPEC', `${at}.id`, `镜号必须是 >= 1 的整数，收到 ${JSON.stringify(id)}`);
      } else if (seenIds.has(id)) {
        add('E_SPEC', `${at}.id`, `镜号 ${id} 重复`);
      } else {
        seenIds.add(id);
      }

      const durationSec = rawShot.durationSec;
      if (
        !isFiniteNumber(durationSec) ||
        durationSec < CAPS.shotDurationSec.min ||
        durationSec > CAPS.shotDurationSec.max
      ) {
        add(
          'E_SPEC',
          `${at}.durationSec`,
          `必须在 ${CAPS.shotDurationSec.min}…${CAPS.shotDurationSec.max} 秒之间，收到 ${JSON.stringify(durationSec)}`,
        );
      }

      const visual = validateVisual(rawShot.visual, `${at}.visual`, add);
      const text = validateText(rawShot.text, `${at}.text`, durationSec, add);

      if (!canvasOk || visual === null || !isFiniteNumber(durationSec)) return;

      const frameCount = Math.max(1, Math.round(durationSec * canvas.fps));
      const actualDurationSec = frameCount / canvas.fps;
      const startSec = cursorFrames / canvas.fps;
      cursorFrames += frameCount;

      let normText = text;
      if (text) {
        const lastFrameStart = Math.max(0, actualDurationSec - 1 / canvas.fps);
        const startSecT = Math.min(text.startSec, lastFrameStart);
        const endSecT = Math.min(text.endSec, actualDurationSec);
        if (endSecT <= startSecT) {
          add('E_SPEC', `${at}.text`, '按帧取整后文本时长为 0，把时间窗放宽一点');
          normText = null;
        } else {
          normText = { ...text, startSec: startSecT, endSec: endSecT };
        }
      }

      shots.push({
        id,
        durationSec,
        durationSecActual: actualDurationSec,
        fullDurationSec: actualDurationSec,
        frameCount,
        startSec,
        visual,
        text: normText,
      });
    });
  }

  if (shots.length > 0) {
    const totalDurationSec = shots.reduce((sum, shot) => sum + shot.durationSecActual, 0);
    if (totalDurationSec > CAPS.totalDurationSec.max) {
      add(
        'E_SPEC',
        'shots',
        `总时长 ${fmt(totalDurationSec)}s 超过上限 ${CAPS.totalDurationSec.max}s；用 shotIds 只渲小样也行`,
      );
    }
  }

  // ── 素材存在性（只在给了 projectRoot 时做）──
  const projectRoot = options.projectRoot;
  if (projectRoot !== undefined) {
    const rootAbs = assertProjectRoot(projectRoot);
    if (shots.length > 0) {
      for (const [index, shot] of shots.entries()) {
        const v = shot.visual;
        if (v.kind === 'photo' || v.kind === 'video') {
          checkAsset(rootAbs, v.path, `shots[${index}].visual.path`, v.kind === 'photo' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS, add);
        }
      }
      if (audio?.mode === 'asset') {
        checkAsset(rootAbs, audio.path, 'audio.path', AUDIO_ASSET_EXTENSIONS, add);
      } else if (audio?.mode === 'video') {
        const source = shots.find((shot) => shot.id === audio.shotId);
        if (!source) {
          add('E_SPEC', 'audio.shotId', `spec 里没有镜号 ${audio.shotId}`);
        } else if (source.visual.kind !== 'video') {
          add(
            'E_SPEC',
            'audio.shotId',
            `镜号 ${audio.shotId} 的视觉来源是 ${source.visual.kind}，没有源音轨；audio.mode="video" 只能指向 video 镜`,
          );
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, spec: null };

  const totalFrames = shots.reduce((sum, shot) => sum + shot.frameCount, 0);
  return {
    ok: true,
    errors: [],
    spec: {
      version: PRODUCTION_SPEC_VERSION,
      canvas: { ...canvas },
      audio,
      shots,
      totalFrames,
      totalDurationSec: totalFrames / canvas.fps,
    },
  };
}

function validateVisual(raw, at, add) {
  if (!isPlainObject(raw)) {
    add('E_SPEC', at, '必须是对象');
    return null;
  }
  const kind = raw.kind;
  if (!VISUAL_KINDS.includes(kind)) {
    add('E_SPEC', `${at}.kind`, `必须是 ${VISUAL_KINDS.join(' / ')} 之一`);
    return null;
  }
  const allowed = VISUAL_KEYS[kind];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) add('E_SPEC', `${at}.${key}`, `kind=${kind} 时不接受这个字段；只接受 ${allowed.join(' / ')}`);
  }

  const background = raw.background === undefined ? DEFAULT_BACKGROUND : parseColor(raw.background, `${at}.background`, add);

  if (kind === 'procedural') {
    if (!PROCEDURAL_PATTERNS.includes(raw.pattern)) {
      add('E_SPEC', `${at}.pattern`, `必须是内置 pattern 之一：${PROCEDURAL_PATTERNS.join(' / ')}`);
      return null;
    }
    if (!isPlainObject(raw.colors)) {
      add('E_SPEC', `${at}.colors`, '必须是 { base, accent }');
      return null;
    }
    for (const key of Object.keys(raw.colors)) {
      if (key !== 'base' && key !== 'accent') add('E_SPEC', `${at}.colors.${key}`, '只接受 base / accent');
    }
    const base = parseColor(raw.colors.base, `${at}.colors.base`, add);
    const accent = parseColor(raw.colors.accent, `${at}.colors.accent`, add);
    const speed = raw.speed === undefined ? 1 : raw.speed;
    if (
      !isFiniteNumber(speed) ||
      speed < CAPS.proceduralSpeed.min ||
      speed > CAPS.proceduralSpeed.max
    ) {
      add('E_SPEC', `${at}.speed`, `必须是 ${CAPS.proceduralSpeed.min}…${CAPS.proceduralSpeed.max} 之间的数字`);
      return null;
    }
    if (!base || !accent) return null;
    return { kind: 'procedural', pattern: raw.pattern, colors: { base, accent }, speed };
  }

  // photo / video
  if (!checkPathSyntax(raw.path, `${at}.path`, add)) return null;
  const fit = raw.fit === undefined ? 'cover' : raw.fit;
  if (!FITS.includes(fit)) {
    add('E_SPEC', `${at}.fit`, `必须是 ${FITS.join(' / ')} 之一`);
    return null;
  }
  const motion = raw.motion === undefined ? 'none' : raw.motion;

  if (kind === 'photo') {
    if (!PHOTO_MOTIONS.includes(motion)) {
      add('E_SPEC', `${at}.motion`, `必须是 ${PHOTO_MOTIONS.join(' / ')} 之一`);
      return null;
    }
    if (motion !== 'none' && fit !== 'cover') {
      add('E_SPEC', `${at}.motion`, 'pan/zoom 只在 fit="cover" 下有意义；contain 会露出背景');
      return null;
    }
    return { kind: 'photo', path: raw.path, fit, motion, background: background || DEFAULT_BACKGROUND };
  }

  if (motion !== 'none') {
    add('E_SPEC', `${at}.motion`, 'video 只支持 motion="none"；要给视频加推拉请在剪辑层做');
    return null;
  }
  const startSec = raw.startSec === undefined ? 0 : raw.startSec;
  if (!isFiniteNumber(startSec) || startSec < 0 || startSec > 600) {
    add('E_SPEC', `${at}.startSec`, '必须是 0…600 之间的数字');
    return null;
  }
  const loop = raw.loop === undefined ? false : raw.loop;
  if (typeof loop !== 'boolean') {
    add('E_SPEC', `${at}.loop`, '必须是布尔值');
    return null;
  }
  if (loop && startSec !== 0) {
    add('E_SPEC', `${at}.startSec`, 'loop=true 时 startSec 必须是 0');
    return null;
  }
  return { kind: 'video', path: raw.path, startSec, fit, motion: 'none', loop, background: background || DEFAULT_BACKGROUND };
}

function validateText(raw, at, durationSec, add) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    add('E_SPEC', at, '必须是对象或 null');
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!TEXT_KEYS.includes(key)) add('E_SPEC', `${at}.${key}`, `不认识的字段；只接受 ${TEXT_KEYS.join(' / ')}`);
  }
  if (!Array.isArray(raw.lines)) {
    add('E_SPEC', `${at}.lines`, '必须是字符串数组');
    return null;
  }
  if (raw.lines.length < CAPS.textLines.min || raw.lines.length > CAPS.textLines.max) {
    add('E_SPEC', `${at}.lines`, `行数必须在 ${CAPS.textLines.min}…${CAPS.textLines.max} 之间`);
    return null;
  }
  const lines = [];
  let linesOk = true;
  raw.lines.forEach((line, i) => {
    if (typeof line !== 'string') {
      add('E_SPEC', `${at}.lines[${i}]`, '必须是字符串');
      linesOk = false;
      return;
    }
    if (/[\r\n]/.test(line)) {
      add('E_SPEC', `${at}.lines[${i}]`, '一行就是一行，不要在里面换行');
      linesOk = false;
      return;
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) {
      add('E_SPEC', `${at}.lines[${i}]`, '含控制字符');
      linesOk = false;
      return;
    }
    if (line.length > CAPS.textLineChars.max) {
      add('E_SPEC', `${at}.lines[${i}]`, `单行最多 ${CAPS.textLineChars.max} 字`);
      linesOk = false;
      return;
    }
    if (line.trim().length === 0) {
      add('E_SPEC', `${at}.lines[${i}]`, '不能是空行');
      linesOk = false;
      return;
    }
    lines.push(line);
  });
  if (!linesOk) return null;

  const position = raw.position === undefined ? 'bottom' : raw.position;
  if (!TEXT_POSITIONS.includes(position)) {
    add('E_SPEC', `${at}.position`, `必须是 ${TEXT_POSITIONS.join(' / ')} 之一`);
    return null;
  }

  const dur = isFiniteNumber(durationSec) ? durationSec : 0;
  const startSec = raw.startSec === undefined ? 0 : raw.startSec;
  const endSec = raw.endSec === undefined ? dur : raw.endSec;
  if (!isFiniteNumber(startSec) || startSec < 0) {
    add('E_SPEC', `${at}.startSec`, '必须是非负数字');
    return null;
  }
  if (!isFiniteNumber(endSec)) {
    add('E_SPEC', `${at}.endSec`, '必须是数字');
    return null;
  }
  if (dur > 0 && startSec >= dur) {
    add('E_SPEC', `${at}.startSec`, `必须小于这一镜的时长 ${fmt(dur)}s`);
    return null;
  }
  if (dur > 0 && endSec > dur + 1e-9) {
    add('E_SPEC', `${at}.endSec`, `不能超过这一镜的时长 ${fmt(dur)}s`);
    return null;
  }
  if (endSec <= startSec) {
    add('E_SPEC', `${at}.endSec`, '必须大于 startSec');
    return null;
  }

  const sizeScale = raw.sizeScale === undefined ? 1 : raw.sizeScale;
  if (
    !isFiniteNumber(sizeScale) ||
    sizeScale < CAPS.textSizeScale.min ||
    sizeScale > CAPS.textSizeScale.max
  ) {
    add('E_SPEC', `${at}.sizeScale`, `必须是 ${CAPS.textSizeScale.min}…${CAPS.textSizeScale.max} 之间的数字`);
    return null;
  }

  const color = raw.color === undefined ? DEFAULT_TEXT_COLOR : parseColor(raw.color, `${at}.color`, add);
  if (!color) return null;

  const box = raw.box === undefined ? true : raw.box;
  if (typeof box !== 'boolean') {
    add('E_SPEC', `${at}.box`, '必须是布尔值');
    return null;
  }

  return { lines, position, startSec, endSec, sizeScale, color, box };
}

function parseColor(value, at, add) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    add('E_SPEC', at, `颜色必须是 #RRGGBB，收到 ${JSON.stringify(value)}`);
    return null;
  }
  return value.toUpperCase();
}

function assertProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new ProductionError('E_PATH', 'projectRoot 必须是非空字符串（作品夹的绝对或相对路径）');
  }
  let abs;
  try {
    abs = fs.realpathSync(path.resolve(projectRoot));
  } catch {
    throw new ProductionError('E_PATH', `projectRoot 不存在：${projectRoot}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) throw new ProductionError('E_PATH', `projectRoot 不是目录：${abs}`);
  return abs;
}

function checkPathSyntax(value, field, add) {
  try {
    localSegments(value, field);
    return true;
  } catch (error) {
    add(error.code, field, error.message);
    return false;
  }
}

async function prepareOutputDirectory(root, outputPath) {
  const components = localSegments(outputPath, 'outputPath').slice(0, -1);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    await fsp.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fsp.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ProductionError('E_PATH', '输出路径必须使用项目内的普通目录。');
    }
  }
}

function checkAsset(rootAbs, relative, field, allowedExtensions, add) {
  let abs;
  try {
    abs = resolveInsideRoot(rootAbs, relative, field);
  } catch (err) {
    add(err.code || 'E_PATH', field, err.message);
    return;
  }
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    add('E_ASSET', field, `素材不存在：${relative}（要先把文件复制进作品夹）`);
    return;
  }
  const rel = path.relative(rootAbs, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    add('E_PATH', field, `素材解析后越出了 projectRoot：${relative}`);
    return;
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) {
    add('E_ASSET', field, `不是普通文件：${relative}`);
    return;
  }
  const ext = path.extname(real).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    add('E_ASSET', field, `扩展名 ${ext || '(无)'} 不在允许范围：${allowedExtensions.join(' ')}`);
    return;
  }
  if (stat.size > CAPS.assetBytes.max) {
    add(
      'E_ASSET',
      field,
      `素材 ${(stat.size / 1024 / 1024).toFixed(1)} MiB 超过上限 ${CAPS.assetBytes.max / 1024 / 1024} MiB`,
    );
  }
}

// ── 工具探测 ────────────────────────────────────────────────────────────────

/** 找 ffmpeg / ffprobe。找不到就 E_TOOL，不换别的可执行文件。 */
function requireTool(command, label) {
  const probe = spawnSyncSafe(command, ['-version']);
  if (!probe.ok) {
    throw new ProductionError(
      'E_TOOL',
      `找不到可用的 ${label}（${command}）。这台机器需要已安装 ffmpeg/ffprobe；适配器不会下载或替换它。`,
    );
  }
}

function spawnSyncSafe(command, args) {
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    return { ok: !result.error && result.status === 0 };
  } catch {
    return { ok: false };
  }
}

/** 探一个系统字体，复制进工作目录，返回 filter 里可用的相对文件名。 */
async function prepareFont(workDir) {
  const candidates = FONT_CANDIDATES[process.platform] || FONT_CANDIDATES.linux;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const ext = path.extname(candidate).toLowerCase() || '.ttf';
    const fileName = `font${ext}`;
    await fsp.copyFile(candidate, path.join(workDir, fileName));
    return { file: fileName, source: candidate };
  }
  throw new ProductionError(
    'E_FONT',
    '没有找到可用的中文字体。字幕需要一台带中文字体的机器；适配器不会静默丢掉屏上字。',
    { searched: candidates },
  );
}

// ── 程序动画 ────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const SIN_TABLE = (() => {
  const size = 4096;
  const table = new Float64Array(size);
  for (let i = 0; i < size; i += 1) table[i] = Math.sin((i / size) * TAU);
  return table;
})();

/** 查表版 sin，参数单位是"圈"（1 = 2π）。逐帧逐像素调用，省掉 Math.sin 的开销。 */
function sinTurns(turns) {
  const wrapped = turns - Math.floor(turns);
  return SIN_TABLE[(wrapped * SIN_TABLE.length) | 0];
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function mix(base, accent, amount) {
  const a = clamp01(amount);
  return base + (accent - base) * a;
}

/**
 * 四种原创程序动画。全部是确定性函数：同一帧号永远得到同一画面。
 * 不读素材、不联网、不随机。
 */
const PATTERN_RENDERERS = {
  'gradient-drift': (ctx, time) => {
    const { width: w, height: h, buffer, base, accent, speed } = ctx;
    const phase = time * 0.35 * speed;
    for (let y = 0; y < h; y += 1) {
      const v = h > 1 ? y / (h - 1) : 0;
      for (let x = 0; x < w; x += 1) {
        const u = w > 1 ? x / (w - 1) : 0;
        const g = 0.5 + 0.5 * sinTurns(u * 1.15 + v * 0.45 + phase);
        const i = (y * w + x) * 3;
        buffer[i] = mix(base[0], accent[0], g);
        buffer[i + 1] = mix(base[1], accent[1], g);
        buffer[i + 2] = mix(base[2], accent[2], g);
      }
    }
  },

  'bars-sweep': (ctx, time) => {
    const { width: w, height: h, buffer, base, accent, speed } = ctx;
    const barPx = Math.max(6, Math.round(w / 14));
    const period = barPx * 2;
    const offset = Math.floor(((time * speed * w * 0.22) % period + period) % period);
    for (let y = 0; y < h; y += 1) {
      const v = h > 1 ? y / (h - 1) : 0;
      const dim = 0.55 + 0.45 * v;
      for (let x = 0; x < w; x += 1) {
        const local = (x + offset) % period;
        // 2px 软边，避免采样后出现锯齿割裂感。
        const edge = Math.min(local < barPx ? local : period - local, 2) / 2;
        const g = local < barPx ? 0.25 + 0.75 * edge : 0.08;
        const i = (y * w + x) * 3;
        buffer[i] = mix(base[0], accent[0], g * dim);
        buffer[i + 1] = mix(base[1], accent[1], g * dim);
        buffer[i + 2] = mix(base[2], accent[2], g * dim);
      }
    }
  },

  'grid-drift': (ctx, time) => {
    const { width: w, height: h, buffer, base, accent, speed } = ctx;
    const gap = Math.max(12, Math.round(w / 16));
    const lineWidth = Math.max(1, Math.round(gap / 8));
    const ox = Math.floor(((time * speed * gap * 0.9) % gap + gap) % gap);
    const oy = Math.floor(((time * speed * gap * 0.5) % gap + gap) % gap);
    for (let y = 0; y < h; y += 1) {
      const ly = (y + oy) % gap;
      const onRow = ly < lineWidth;
      for (let x = 0; x < w; x += 1) {
        const lx = (x + ox) % gap;
        const onCol = lx < lineWidth;
        const g = onRow || onCol ? 0.85 : 0.12;
        const i = (y * w + x) * 3;
        buffer[i] = mix(base[0], accent[0], g);
        buffer[i + 1] = mix(base[1], accent[1], g);
        buffer[i + 2] = mix(base[2], accent[2], g);
      }
    }
  },

  'pulse-field': (ctx, time) => {
    const { width: w, height: h, buffer, base, accent, speed } = ctx;
    const phase = time * speed * 0.8;
    const cx = w / 2;
    const cy = h / 2;
    const norm = 1 / Math.max(w, h);
    for (let y = 0; y < h; y += 1) {
      const dy = (y - cy) * norm;
      for (let x = 0; x < w; x += 1) {
        const dx = (x - cx) * norm;
        const d = Math.sqrt(dx * dx + dy * dy) * 2;
        const rings = 0.5 + 0.5 * sinTurns(d * 3 - phase);
        const vignette = clamp01(1 - d * 0.75);
        const g = rings * vignette;
        const i = (y * w + x) * 3;
        buffer[i] = mix(base[0], accent[0], g);
        buffer[i + 1] = mix(base[1], accent[1], g);
        buffer[i + 2] = mix(base[2], accent[2], g);
      }
    }
  },
};

function createPatternState(shot, canvas) {
  const renderer = PATTERN_RENDERERS[shot.visual.pattern];
  if (!renderer) throw new ProductionError('E_SPEC', `未知的程序动画 ${shot.visual.pattern}`);
  return {
    renderer,
    width: canvas.width,
    height: canvas.height,
    base: hexToRgb(shot.visual.colors.base),
    accent: hexToRgb(shot.visual.colors.accent),
    speed: shot.visual.speed,
    buffer: Buffer.alloc(canvas.width * canvas.height * 3),
  };
}

// ── filter 拼装（全部由本模块按枚举/数值生成）────────────────────────────────

function fitParts(fit, width, height, background) {
  if (fit === 'cover') {
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
    ];
  }
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x${background.slice(1)}`,
  ];
}

function textFontSize(canvasHeight, sizeScale) {
  const base = Math.round(canvasHeight * 0.055 * sizeScale);
  return Math.max(10, Math.min(Math.round(canvasHeight * 0.4), base));
}

function drawTextFilter(shot, canvas, fontFileName, textFileName, offsetSec = 0) {
  const t = shot.text;
  const fontSize = textFontSize(canvas.height, t.sizeScale);
  const margin = Math.round(canvas.height * 0.05);
  const y =
    t.position === 'top'
      ? String(margin)
      : t.position === 'center'
        ? '(h-text_h)/2'
        : `h-text_h-${margin}`;

  const options = [
    `fontfile=${fontFileName}`,
    `textfile=${textFileName}`,
    'expansion=none',
    `fontcolor=0x${t.color.slice(1)}`,
    `fontsize=${fontSize}`,
    `line_spacing=${Math.round(fontSize * 0.35)}`,
    'x=(w-text_w)/2',
    `y=${y}`,
  ];
  if (t.box) {
    options.push('box=1', 'boxcolor=black@0.5', `boxborderw=${Math.round(fontSize * 0.45)}`);
  }
  // 截取代表区间时，片段内的 t 从 0 重新开始；屏上字的时间窗要减掉这段偏移。
  const textStart = Math.max(0, t.startSec - offsetSec);
  const textEnd = Math.max(0, t.endSec - offsetSec);
  if (textEnd <= textStart) return null;
  options.push(`enable='between(t,${fmt(textStart)},${fmt(textEnd)})'`);
  return `drawtext=${options.join(':')}`;
}

function buildShotFilter(shot, canvas, fontFileName, textFileName, offsetFrames = 0) {
  const { width, height, fps } = canvas;
  const frames = Math.round((shot.fullDurationSec ?? shot.durationSecActual) * fps);
  const dur = shot.fullDurationSec ?? shot.durationSecActual;
  const offsetSec = offsetFrames / fps;
  const v = shot.visual;
  const parts = [];

  if (v.kind === 'photo') {
    if (v.motion === 'pan-left' || v.motion === 'pan-right') {
      const ow = toEven(Math.max(width, Math.round(width * 1.14)));
      const oh = toEven(Math.max(height, Math.round(height * 1.14)));
      const local = offsetSec > 0 ? `(t+${fmt(offsetSec)})` : 't';
      const expr = v.motion === 'pan-right' ? `${local}/${fmt(dur)}` : `(1-${local}/${fmt(dur)})`;
      parts.push(`scale=${ow}:${oh}:force_original_aspect_ratio=increase`);
      parts.push(`crop=${width}:${height}:x='(in_w-out_w)*${expr}':y='(in_h-out_h)/2'`);
    } else {
      parts.push(...fitParts(v.fit, width, height, v.background));
    }
    if (v.motion === 'zoom-in' || v.motion === 'zoom-out') {
      const pos = offsetFrames > 0 ? `(on+${offsetFrames})` : 'on';
      const expr = v.motion === 'zoom-in' ? `1+0.15*${pos}/${frames}` : `max(1.15-0.15*${pos}/${frames},1)`;
      parts.push(
        `zoompan=z='${expr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`,
      );
    }
  } else if (v.kind === 'video') {
    parts.push(...fitParts(v.fit, width, height, v.background));
    parts.push(`fps=${fps}`);
  }

  parts.push('setsar=1');
  if (shot.text) {
    const drawText = drawTextFilter(shot, canvas, fontFileName, textFileName, offsetSec);
    if (drawText) parts.push(drawText);
  }
  return parts.join(',');
}

// ── 子进程 ──────────────────────────────────────────────────────────────────

function describeToolFailure(command, err) {
  const stderr = tail(err?.stderr || '');
  const stdout = tail(err?.stdout || '');
  return { stderr, stdout, detail: stderr || stdout || err?.message || String(err) };
}

function mapExecError(command, err) {
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    return new ProductionError('E_CANCELLED', '渲染已被取消');
  }
  if (err?.killed === true && err?.signal) {
    return new ProductionError('E_TIMEOUT', `${path.basename(command)} 超时被终止`);
  }
  if (err?.code === 'ENOENT') {
    return new ProductionError('E_TOOL', `无法启动 ${path.basename(command)}：${err.message}`);
  }
  const { detail } = describeToolFailure(command, err);
  return new ProductionError('E_RENDER', `${path.basename(command)} 失败：${detail}`, {
    exitCode: err?.code ?? null,
    signal: err?.signal ?? null,
  });
}

/** 跑一个不喂 stdin 的工具，收尾时把错误翻成 ProductionError。 */
async function runTool(command, args, { cwd, timeoutMs, signal }) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      signal,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { stdout };
  } catch (err) {
    throw mapExecError(command, err);
  }
}

/**
 * 跑一个要喂 stdin 的工具（程序动画的逐帧管道）。
 * 一边写帧一边等 drain，ffmpeg 提前退出或取消时及时收手。
 */
function runWithStdin(command, args, { cwd, timeoutMs, signal, writeFrames }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProductionError('E_CANCELLED', '渲染已被取消'));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      finish(reject, new ProductionError('E_TIMEOUT', `${path.basename(command)} 超时被终止`));
    }, timeoutMs);

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      finish(reject, new ProductionError('E_CANCELLED', '渲染已被取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 64000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish(reject, new ProductionError('E_TOOL', `无法启动 ${path.basename(command)}：${err.message}`));
    });

    const feeding = (async () => {
      try {
        await writeFrames(child.stdin);
      } catch (err) {
        // ffmpeg 先死了就会 EPIPE；错误交给 close 分支统一判定。
        try {
          child.stdin.destroy();
        } catch {
          /* ignore */
        }
        if (err instanceof ProductionError) throw err;
        if (signal?.aborted) throw new ProductionError('E_CANCELLED', '渲染已被取消');
        throw new ProductionError('E_RENDER', `写入 ${path.basename(command)} 的输入失败：${err.message}`);
      }
    })();
    feeding.catch(() => {});

    child.on('close', async (code) => {
      if (settled) return;
      let feedError = null;
      try {
        await feeding;
      } catch (err) {
        feedError = err;
      }
      if (signal?.aborted) {
        finish(reject, new ProductionError('E_CANCELLED', '渲染已被取消'));
        return;
      }
      if (feedError) {
        finish(reject, feedError);
        return;
      }
      if (code === 0) {
        finish(resolve, { stderr });
        return;
      }
      finish(
        reject,
        new ProductionError('E_RENDER', `${path.basename(command)} 退出码 ${code}：${tail(stderr)}`, {
          exitCode: code,
        }),
      );
    });
  });
}

async function writeFrames(stream, state, frameCount, fps, signal, offsetFrames = 0) {
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (signal?.aborted) throw new ProductionError('E_CANCELLED', '渲染已被取消');
    // 取代表区间时，程序动画要接着原来的时间线走，不能从头播一遍。
    state.renderer(state, (frame + offsetFrames) / fps);
    if (!stream.write(state.buffer)) {
      await once(stream, 'drain');
    }
  }
  stream.end();
}

// ── 探测与验证 ──────────────────────────────────────────────────────────────

async function probeMedia(filePath, deps) {
  const { stdout } = await runTool(
    deps.ffprobe,
    [
      '-v',
      'error',
      '-protocol_whitelist',
      PROTOCOL_WHITELIST,
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { cwd: deps.cwd, timeoutMs: CAPS.probeTimeoutMs, signal: deps.signal },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ProductionError('E_VERIFY', 'ffprobe 输出的不是 JSON，无法验证成片');
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  return {
    formatName: String(parsed.format?.format_name ?? ''),
    durationSec: Number(parsed.format?.duration),
    video: streams.find((s) => s.codec_type === 'video') || null,
    audio: streams.find((s) => s.codec_type === 'audio') || null,
    size: Number(parsed.format?.size),
  };
}

function parseRational(value) {
  const [num, den] = String(value ?? '').split('/');
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return NaN;
  return n / d;
}

function assertFrameRate(probe, fps, label) {
  const actual = parseRational(probe.video?.avg_frame_rate) || parseRational(probe.video?.r_frame_rate);
  if (!Number.isFinite(actual)) return;
  if (Math.abs(actual - fps) > 0.01) {
    throw new ProductionError('E_VERIFY', `${label} 帧率是 ${actual}，应为 ${fps}`);
  }
}

/** 中间片段必须严格等于期望帧数；差一帧就说明素材不够长或 filter 吞了帧。 */
async function verifyShotSegment(filePath, shot, canvas, deps) {
  const probe = await probeMedia(filePath, deps);
  if (!probe.video) throw new ProductionError('E_VERIFY', `镜头 ${shot.id} 的片段里没有视频流`);
  if (probe.video.codec_name !== 'h264') {
    throw new ProductionError('E_VERIFY', `镜头 ${shot.id} 的片段编码是 ${probe.video.codec_name}，应为 h264`);
  }
  if (Number(probe.video.width) !== canvas.width || Number(probe.video.height) !== canvas.height) {
    throw new ProductionError(
      'E_VERIFY',
      `镜头 ${shot.id} 的片段是 ${probe.video.width}x${probe.video.height}，应为 ${canvas.width}x${canvas.height}`,
    );
  }
  if (probe.audio) throw new ProductionError('E_VERIFY', `镜头 ${shot.id} 的片段不该带声音`);

  const frames = Number(probe.video.nb_frames);
  if (Number.isFinite(frames) && frames > 0 && frames !== shot.frameCount) {
    if (shot.visual.kind === 'video') {
      throw new ProductionError(
        'E_ASSET',
        `镜头 ${shot.id} 的素材只够 ${frames} 帧，这一镜要 ${shot.frameCount} 帧。` +
          '素材不够长：要么加 loop: true，要么把 durationSec 改短。',
      );
    }
    throw new ProductionError(
      'E_VERIFY',
      `镜头 ${shot.id} 渲染出 ${frames} 帧，应为 ${shot.frameCount} 帧`,
    );
  }
  assertFrameRate(probe, canvas.fps, `镜头 ${shot.id} 的片段`);
  return probe;
}

/** 成片验证：容器、编码、时长、声音有无，必须与声明逐项对上。 */
function verifyFinalProbe(probe, expectation) {
  const problems = [];
  if (!probe.formatName.includes('mp4')) {
    problems.push(`容器是 ${probe.formatName || '(未知)'}，应为 mp4`);
  }
  if (!probe.video) {
    problems.push('没有视频流');
  } else {
    if (probe.video.codec_name !== 'h264') problems.push(`视频编码是 ${probe.video.codec_name}，应为 h264`);
    if (Number(probe.video.width) !== expectation.width || Number(probe.video.height) !== expectation.height) {
      problems.push(`画面是 ${probe.video.width}x${probe.video.height}，应为 ${expectation.width}x${expectation.height}`);
    }
  }
  if (expectation.hasAudio && !probe.audio) problems.push('声明有声音，成片里没有音频流');
  if (!expectation.hasAudio && probe.audio) problems.push('声明无声音，成片里却有音频流');
  if (expectation.hasAudio && probe.audio && probe.audio.codec_name !== 'aac') {
    problems.push(`音频编码是 ${probe.audio.codec_name}，应为 aac`);
  }
  const toleranceSec = Math.max(0.2, 2 / expectation.fps);
  if (!Number.isFinite(probe.durationSec) || Math.abs(probe.durationSec - expectation.durationSec) > toleranceSec) {
    problems.push(
      `时长是 ${Number.isFinite(probe.durationSec) ? probe.durationSec.toFixed(3) : '无法读取'}s，` +
        `应为 ${expectation.durationSec.toFixed(3)}s（容差 ${toleranceSec.toFixed(2)}s）`,
    );
  }
  if (problems.length > 0) {
    throw new ProductionError('E_VERIFY', `成片没通过验证：${problems.join('；')}`, { problems });
  }
  assertFrameRate(probe, expectation.fps, '成片');
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/**
 * 每个输入前的统一前缀：只允许本地文件与管道两种协议。
 * 网络协议（http/tcp/rtmp/…）一个都不放行，所以即便素材里藏了远程引用也取不到。
 */
function inputPrelude(demuxer, extra = []) {
  const args = ['-protocol_whitelist', PROTOCOL_WHITELIST];
  if (demuxer === 'mov') args.push('-enable_drefs', '0');
  if (demuxer) args.push('-f', demuxer);
  args.push(...extra);
  return args;
}

/** 扩展名决定的 demuxer。没有登记过的扩展名在校验阶段就已经被拒了。 */
function demuxerFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const demuxer = DEMUXERS[ext];
  if (!demuxer) {
    throw new ProductionError('E_ASSET', `没有为扩展名 ${ext || '(无)'} 登记 demuxer，拒绝交给 ffmpeg 猜`);
  }
  return demuxer;
}

function buildShotArgs(shot, canvas, work, deps, outFile) {
  const base = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
  const encode = [
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    deps.preset,
    '-crf',
    String(deps.crf),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(canvas.fps),
    '-frames:v',
    String(shot.frameCount),
    outFile,
  ];

  const v = shot.visual;
  if (v.kind === 'video') {
    const pre = [];
    if (v.loop) pre.push('-stream_loop', '-1');
    const startSec = v.startSec + (shot.offsetFrames ?? 0) / canvas.fps;
    if (startSec > 0) pre.push('-ss', fmt(startSec));
    const input = [...base, ...inputPrelude(demuxerFor(deps.assetAbs), pre), '-i', deps.assetAbs];
    input.push('-t', fmt(shot.durationSecActual + 1));
    input.push('-vf', deps.filter);
    return { args: [...input, ...encode], feed: null };
  }

  if (v.kind === 'photo') {
    const input = [
      ...base,
      ...inputPrelude(demuxerFor(deps.assetAbs), ['-pattern_type', 'none', '-loop', '1', '-framerate', String(canvas.fps)]),
      '-i',
      deps.assetAbs,
      '-vf',
      deps.filter,
    ];
    return { args: [...input, ...encode], feed: null };
  }

  // procedural：帧在 Node 里画，走 rgb24 管道。
  const args = [
    '-hide_banner',
    '-y',
    '-loglevel',
    'error',
    ...inputPrelude('rawvideo', [
      '-pixel_format',
      'rgb24',
      '-video_size',
      `${canvas.width}x${canvas.height}`,
      '-framerate',
      String(canvas.fps),
    ]),
    '-i',
    'pipe:0',
    '-vf',
    deps.filter,
    ...encode,
  ];
  return { args, feed: deps.feed };
}

/**
 * 把一份 spec（或它的一部分镜头）渲染成一个真实 MP4。
 *
 * @param {{
 *   projectRoot: string,
 *   spec: object,
 *   shotIds?: number[],
 *   outputPath: string,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<object>} 见 README / 上层文档里的结果形状
 */
export async function renderProduction(options) {
  if (!isPlainObject(options)) {
    throw new ProductionError('E_OPTIONS', 'renderProduction 需要一个对象参数');
  }
  for (const key of Object.keys(options)) {
    if (!RENDER_OPTION_KEYS.includes(key)) {
      throw new ProductionError(
        'E_OPTIONS',
        `不认识的选项 ${key}；只接受 ${RENDER_OPTION_KEYS.join(' / ')}。适配器不接受自定义可执行文件或 filter。`,
      );
    }
  }

  const { projectRoot, spec, shotIds, range, sampleMaxSeconds, outputPath, signal } = options;

  if (signal !== undefined && signal !== null) {
    if (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
      throw new ProductionError('E_OPTIONS', 'signal 必须是 AbortSignal');
    }
  }
  if (signal?.aborted) throw new ProductionError('E_CANCELLED', '渲染已被取消');

  const rootAbs = assertProjectRoot(projectRoot);
  const validation = validateProductionSpec(spec, { projectRoot: rootAbs });
  if (!validation.ok) {
    throw new ProductionError('E_SPEC', '制作规格不合法，先修 spec 再渲染', {
      errors: validation.errors,
    });
  }
  const normalized = validation.spec;

  // ── 输出路径 ──
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new ProductionError('E_PATH', 'outputPath 必须是相对 projectRoot 的 .mp4 路径');
  }
  if (path.extname(outputPath).toLowerCase() !== '.mp4') {
    throw new ProductionError('E_PATH', `outputPath 必须以 .mp4 结尾，收到 ${outputPath}`);
  }
  const outAbs = resolveInsideRoot(rootAbs, outputPath, 'outputPath');
  if (fs.existsSync(outAbs)) {
    throw new ProductionError(
      'E_OUTPUT_EXISTS',
      `输出已存在，不覆盖旧版：${outputPath}。改一个新路径（例如 work/r2.mp4）再渲。`,
    );
  }
  let outStat = null;
  try {
    outStat = fs.statSync(outAbs);
  } catch {
    /* 不存在是正常情况 */
  }
  if (outStat?.isDirectory()) {
    throw new ProductionError('E_PATH', `输出路径是一个目录：${outputPath}`);
  }

  // ── 选镜与取样窗口 ──
  const picked = selectShots(normalized, shotIds);
  const window = computeWindow(picked, normalized.canvas.fps, range, sampleMaxSeconds);
  const shots = window.shots;
  if (shots.length === 0) {
    throw new ProductionError('E_OPTIONS', '取样窗口没有落在任何镜头上');
  }
  const selectedFrames = window.endFrame - window.startFrame;
  const selectedDurationSec = selectedFrames / normalized.canvas.fps;

  // ── 工具 ──
  requireTool('ffmpeg', 'ffmpeg');
  requireTool('ffprobe', 'ffprobe');

  await prepareOutputDirectory(rootAbs, outputPath);

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cyv-production-'));
  const partialPath = path.join(
    path.dirname(outAbs),
    `.${path.basename(outAbs)}.partial-${process.pid}-${randomBytes(4).toString('hex')}.mp4`,
  );
  const deadline = Date.now() + CAPS.renderTimeoutMs;

  try {
    // 素材与声音先解析成绝对路径（已经过校验，这里只是取值）。
    const assetPaths = new Map();
    for (const shot of shots) {
      const v = shot.visual;
      if (v.kind !== 'procedural' && !assetPaths.has(v.path)) {
        assetPaths.set(v.path, resolveInsideRoot(rootAbs, v.path, 'visual.path'));
      }
    }
    if (normalized.audio.mode === 'asset' && !assetPaths.has(normalized.audio.path)) {
      assetPaths.set(normalized.audio.path, resolveInsideRoot(rootAbs, normalized.audio.path, 'audio.path'));
    }

    const needsText = shots.some((shot) => shot.text);
    const font = needsText ? await prepareFont(workDir) : null;

    const deps = {
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      cwd: workDir,
      signal,
      preset: 'veryfast',
      crf: 20,
    };

    const segmentFiles = [];
    for (const member of window.members) {
      const shot = member.shot;
      if (Date.now() > deadline) {
        throw new ProductionError('E_TIMEOUT', `整片渲染超过 ${CAPS.renderTimeoutMs / 1000}s 上限`);
      }
      if (signal?.aborted) throw new ProductionError('E_CANCELLED', '渲染已被取消');

      let textFile = null;
      if (shot.text) {
        textFile = `text-${shot.id}.txt`;
        await fsp.writeFile(path.join(workDir, textFile), `${shot.text.lines.join('\n')}\n`, 'utf8');
      }

      const segment = {
        ...shot,
        frameCount: member.frames,
        durationSecActual: member.frames / normalized.canvas.fps,
        fullDurationSec: shot.durationSecActual,
        offsetFrames: member.offsetFrames,
      };
      const filter = buildShotFilter(segment, normalized.canvas, font?.file ?? null, textFile, segment.offsetFrames);
      const outFile = `shot-${shot.id}-${member.index}.mp4`;
      const assetAbs = shot.visual.kind === 'procedural' ? null : assetPaths.get(shot.visual.path);
      if (shot.visual.kind !== 'procedural' && !assetAbs) {
        throw new ProductionError('E_ASSET', `镜头 ${shot.id} 的素材路径没有解析出来`);
      }

      const feedState =
        shot.visual.kind === 'procedural' ? createPatternState(segment, normalized.canvas) : null;

      const plan = buildShotArgs(
        segment,
        normalized.canvas,
        workDir,
        { ...deps, assetAbs, filter, feed: feedState },
        outFile,
      );

      if (plan.feed) {
        await runWithStdin(deps.ffmpeg, plan.args, {
          cwd: workDir,
          timeoutMs: CAPS.shotTimeoutMs,
          signal,
          writeFrames: (stream) =>
            writeFrames(
              stream,
              plan.feed,
              segment.frameCount,
              normalized.canvas.fps,
              signal,
              segment.offsetFrames,
            ),
        });
      } else {
        await runTool(deps.ffmpeg, plan.args, {
          cwd: workDir,
          timeoutMs: CAPS.shotTimeoutMs,
          signal,
        });
      }

      const segmentPath = path.join(workDir, outFile);
      if (!fs.existsSync(segmentPath)) {
        throw new ProductionError('E_RENDER', `镜头 ${shot.id} 没有产出文件`);
      }
      await verifyShotSegment(segmentPath, segment, normalized.canvas, deps);
      segmentFiles.push(outFile);
    }

    // ── 拼接 + 声音 + 落盘 ──
    const listName = 'segments.txt';
    await fsp.writeFile(
      path.join(workDir, listName),
      segmentFiles.map((file) => `file '${file}'`).join('\n') + '\n',
      'utf8',
    );

    const muxArgs = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      ...inputPrelude('concat', ['-safe', '1']),
      '-i',
      listName,
    ];

    const audioProbe = { mode: normalized.audio.mode };
    let audioMap = '1:a:0';
    if (normalized.audio.mode === 'tone') {
      muxArgs.push(
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${fmt(normalized.audio.frequencyHz)}:sample_rate=48000:duration=${fmt(
          selectedDurationSec,
        )}`,
      );
      const gain = Number((10 ** (normalized.audio.gainDb / 20)).toFixed(4));
      muxArgs.push('-af', `volume=${gain}`);
      audioProbe.frequencyHz = normalized.audio.frequencyHz;
      audioProbe.gainDb = normalized.audio.gainDb;
    } else if (normalized.audio.mode === 'asset' || normalized.audio.mode === 'video') {
      const audio = normalized.audio;
      const fromShot = audio.mode === 'video' ? normalized.shots.find(shot => shot.id === audio.shotId) : null;
      const declared = fromShot ? fromShot.visual.path : audio.path;
      const audioAbs = assetPaths.get(declared) ?? resolveInsideRoot(rootAbs, declared, 'audio.path');
      assetPaths.set(declared, audioAbs);
      const input = [];
      if (audio.loop) input.push('-stream_loop', '-1');
      if (fromShot?.visual.startSec) input.push('-ss', fmt(fromShot.visual.startSec));
      muxArgs.push(...inputPrelude(demuxerFor(audioAbs), input), '-i', audioAbs);
      muxArgs.push('-filter_complex', assembleAudio(window.members, normalized.canvas.fps, audio, fromShot));
      audioMap = '[cyv_audio]';
      audioProbe.path = declared;
      audioProbe.loop = audio.loop ?? false;
    }

    muxArgs.push('-map', '0:v:0');
    let hasAudio = false;
    if (normalized.audio.mode !== 'none') {
      hasAudio = true;
      muxArgs.push('-map', audioMap, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
    } else {
      muxArgs.push('-an');
    }

    const specSha256 = sha256Hex(
      canonicalJson({
        version: normalized.version,
        canvas: normalized.canvas,
        audio: normalized.audio,
        shots: normalized.shots,
        shotIds: shots.map((shot) => shot.id),
        startFrame: window.startFrame, endFrame: window.endFrame,
      }),
    );
    const revision = `r-${specSha256.slice(0, 12)}`;

    muxArgs.push(
      '-c:v',
      'copy',
      '-t',
      fmt(selectedDurationSec),
      '-movflags',
      '+faststart',
      '-metadata',
      `comment=cyv-production spec=${specSha256} shots=${shots.map((s) => s.id).join(',')}`,
      partialPath,
    );

    await runTool(deps.ffmpeg, muxArgs, {
      cwd: workDir,
      timeoutMs: Math.max(30000, Math.min(CAPS.renderTimeoutMs, deadline - Date.now())),
      signal,
    });

    // ── 验证 ──
    const finalProbe = await probeMedia(partialPath, { ...deps, cwd: path.dirname(partialPath) });
    verifyFinalProbe(finalProbe, {
      width: normalized.canvas.width,
      height: normalized.canvas.height,
      fps: normalized.canvas.fps,
      durationSec: selectedDurationSec,
      hasAudio,
    });

    const head = Buffer.alloc(12);
    const fd = await fsp.open(partialPath, 'r');
    try {
      await fd.read(head, 0, 12, 0);
    } finally {
      await fd.close();
    }
    const hasFtyp = head.subarray(4, 8).toString('latin1') === 'ftyp';
    if (!hasFtyp) throw new ProductionError('E_VERIFY', '成片开头没有 ftyp box，不是一个正常的 MP4');

    // Publish only verified bytes and refuse to replace a concurrently created result.
    signal?.throwIfAborted();
    try {
      await fsp.link(partialPath, outAbs);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new ProductionError('E_OUTPUT_EXISTS', `输出已存在，不覆盖旧版：${outputPath}`);
      }
      throw new ProductionError('E_RENDER', `把成片放到 ${outputPath} 失败：${err.message}`);
    }

    const stat = await fsp.stat(outAbs);
    const assets = [];
    for (const [declared, abs] of assetPaths) {
      const used = shots.some(
        (shot) => shot.visual.kind !== 'procedural' && shot.visual.path === declared,
      ) || audioProbe.path === declared;
      if (!used) continue;
      const assetStat = await fsp.stat(abs);
      assets.push({
        path: declared.split(/[\\/]+/).join('/'),
        sha256: await sha256File(abs),
        bytes: assetStat.size,
      });
    }

    let cursorFrames = 0;
    const shotReport = window.members.map(({ shot, frames }) => {
      const entry = {
        id: shot.id,
        startSec: cursorFrames / normalized.canvas.fps,
        durationSec: frames / normalized.canvas.fps,
        frameCount: frames,
      };
      cursorFrames += frames;
      return entry;
    });

    return {
      ok: true,
      path: outAbs,
      relativePath: toPosixRelative(rootAbs, outAbs),
      durationSec: selectedDurationSec,
      frameCount: selectedFrames,
      width: normalized.canvas.width,
      height: normalized.canvas.height,
      fps: normalized.canvas.fps,
      audio: audioProbe,
      shots: shotReport,
      bytes: stat.size,
      sha256: await sha256File(outAbs),
      specSha256,
      revision,
      assets,
      font: font ? { source: path.basename(font.source) } : null,
      verified: {
        ftyp: true,
        container: 'mp4',
        videoCodec: finalProbe.video?.codec_name ?? null,
        audioCodec: finalProbe.audio?.codec_name ?? null,
        probedDurationSec: Number(finalProbe.durationSec.toFixed(3)),
        probedFrameRate: parseRational(finalProbe.video?.avg_frame_rate) || null,
      },
    };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(partialPath, { force: true }).catch(() => {});
  }
}

/** 只接受显式镜号列表；不传就整条片按 spec 顺序渲。 */
function selectShots(normalized, shotIds) {
  if (shotIds === undefined || shotIds === null) return normalized.shots;
  if (!Array.isArray(shotIds) || shotIds.length === 0) {
    throw new ProductionError('E_OPTIONS', 'shotIds 必须是非空数组；不给就是整片');
  }
  const known = new Map(normalized.shots.map((shot) => [shot.id, shot]));
  const wanted = new Set();
  for (const id of shotIds) {
    if (!Number.isInteger(id)) {
      throw new ProductionError('E_OPTIONS', `shotIds 里只能是整数镜号，收到 ${JSON.stringify(id)}`);
    }
    if (!known.has(id)) {
      throw new ProductionError('E_OPTIONS', `spec 里没有镜号 ${id}`);
    }
    if (wanted.has(id)) {
      throw new ProductionError('E_OPTIONS', `shotIds 里镜号 ${id} 重复`);
    }
    wanted.add(id);
  }
  return normalized.shots.filter((shot) => wanted.has(shot.id));
}

function computeWindow(picked, fps, range, maximumSeconds) {
  const totalFrames = picked.reduce((sum, shot) => sum + shot.frameCount, 0);
  let startFrame = 0;
  let endFrame = totalFrames;
  if (range !== undefined) {
    if (!isPlainObject(range) || Object.keys(range).some(key => !['startSec', 'endSec'].includes(key))
      || !isFiniteNumber(range.startSec) || !isFiniteNumber(range.endSec)
      || range.startSec < 0 || range.endSec <= range.startSec || range.endSec > totalFrames / fps) {
      throw new ProductionError('E_OPTIONS', 'range 需是所选镜头范围内的 {startSec,endSec}。');
    }
    startFrame = Math.round(range.startSec * fps);
    endFrame = Math.round(range.endSec * fps);
  }
  if (maximumSeconds !== undefined) {
    if (!isFiniteNumber(maximumSeconds) || maximumSeconds < 1 / fps) {
      throw new ProductionError('E_OPTIONS', '小样时长上限至少为一帧。');
    }
    endFrame = Math.min(endFrame, startFrame + Math.floor(maximumSeconds * fps + 1e-6));
  }
  const members = [];
  let cursor = 0;
  for (const shot of picked) {
    const first = Math.max(cursor, startFrame);
    const stop = Math.min(cursor + shot.frameCount, endFrame);
    if (stop > first) members.push({ shot, index: members.length, frames: stop - first, offsetFrames: first - cursor });
    cursor += shot.frameCount;
  }
  return { members, shots: members.map(member => member.shot), startFrame, endFrame };
}

function assembleAudio(members, fps, audio, fromShot) {
  const filters = [];
  if (fromShot) filters.push('atrim=duration=' + fmt(fromShot.durationSecActual), 'asetpts=PTS-STARTPTS',
    'adelay=' + Math.round(fromShot.startSec * 48000) + 'S:all=1');
  if (!audio.loop || fromShot) filters.push('apad');
  if (audio.gainDb) filters.push('volume=' + fmt(10 ** (audio.gainDb / 20)));
  const split = members.length > 1;
  const labels = members.map((_, index) => 'a' + index);
  const layout = 'aformat=sample_rates=48000:channel_layouts=stereo';
  filters.unshift(layout);
  const first = '[1:a:0]' + filters.join(',');
  const trim = (member, input, output) => input + 'atrim=start=' + fmt(member.shot.startSec + member.offsetFrames / fps)
    + ':duration=' + fmt(member.frames / fps) + ',asetpts=PTS-STARTPTS' + output;
  if (!split) return trim(members[0], first + ',', '[cyv_audio]');
  const sources = labels.map(label => '[' + label + ']').join('');
  const trimmed = members.map((member, index) => trim(member, '[' + labels[index] + ']', '[trim' + index + ']'));
  const concat = members.map((_, index) => '[trim' + index + ']').join('') + 'concat=n=' + members.length + ':v=0:a=1[cyv_audio]';
  return [first + ',asplit=' + members.length + sources, ...trimmed, concat].join(';');
}
