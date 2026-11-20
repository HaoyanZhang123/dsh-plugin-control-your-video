/**
 * project.test.js — 作品夹与经验库的自动化回归。
 *
 * 只用临时夹具（os.tmpdir 下的独立目录），不碰任何真实工作区、私人库或配置目录。
 * 断言的是**可观察的文件系统事实**：原件哈希变没变、副本在不在、清单怎么写、
 * 失败后有没有半截文件、越界与符号链接有没有被挡住。
 *
 * 跑法：node --test tests/project.test.js
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  PROVENANCE_FILE,
  ProjectError,
  assertPathInProject,
  importAssets,
  isInside,
  listAssets,
  openProject,
  readProvenance,
  resolveProjectPath,
  sanitizeName,
  verifyAssets,
} from '../tools/project.js';

import {
  LIBRARY_DIR,
  LibraryError,
  SCENES,
  copyExperienceAsset,
  inspectLibrary,
  readLibraryIndex,
  resolveLibraryPath,
  saveExperience,
  searchLibrary,
} from '../tools/experience-library.js';

// ── 夹具 ────────────────────────────────────────────────────────────────────

const tempRoots = [];

async function makeTemp(label) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cyv-${label}-`));
  const real = await fsp.realpath(dir);
  tempRoots.push(real);
  return real;
}

after(async () => {
  for (const dir of tempRoots) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function sha256(file) {
  const hash = createHash('sha256');
  const buf = await fsp.readFile(file);
  hash.update(buf);
  return hash.digest('hex');
}

async function writeFileDeep(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
  return file;
}

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(current, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const ent of entries) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(path.join(current, ent.name), rel);
      else out.push(rel);
    }
  }
  await walk(dir, '');
  return out.sort();
}

/** Windows 上普通用户可能没有创建符号链接的权限；没权限就跳过相关断言。 */
async function trySymlink(target, link, type) {
  try {
    await fsp.symlink(target, link, type);
    return true;
  } catch (err) {
    if (['EPERM', 'EACCES', 'UNKNOWN', 'ENOSYS'].includes(err.code)) return false;
    throw err;
  }
}

function assertProjectError(fn, code) {
  return assert.rejects(fn, (err) => {
    assert.ok(err instanceof ProjectError, `期望 ProjectError，收到 ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}: ${err.message}`);
    return true;
  });
}

// ── 项目：新建 / 打开 ───────────────────────────────────────────────────────

test('新建项目：建出轻量目录，返回可用句柄，重复打开幂等', async () => {
  const ws = await makeTemp('ws-new');
  const project = await openProject(ws, 'projects/机房科普', { create: true });

  assert.equal(project.created, true);
  assert.equal(project.name, '机房科普');
  assert.equal(project.relative, 'projects/机房科普');
  assert.deepEqual(project.missingDirs, []);
  for (const dir of Object.values(project.dirs)) {
    assert.ok(fs.statSync(dir).isDirectory(), `${dir} 应该是目录`);
  }
  assert.ok(fs.existsSync(project.projectFile));

  const again = await openProject(ws, 'projects/机房科普', { create: true });
  assert.equal(again.created, false, '第二次不应算新建');
  assert.equal(again.root, project.root);
});

test('打开不存在的项目：不给 create 就明确失败，不悄悄建目录', async () => {
  const ws = await makeTemp('ws-missing');
  await assertProjectError(() => openProject(ws, 'projects/不存在'), 'E_MISSING');
  assert.equal(fs.existsSync(path.join(ws, 'projects/不存在')), false);
});

test('项目名：非法字符、保留名、点结尾都拒绝；中文名照常可用', async () => {
  const ws = await makeTemp('ws-name');
  await assertProjectError(() => openProject(ws, 'projects/..', { create: true }), 'E_PATH_ESCAPE');
  await assertProjectError(() => openProject(ws, '', { create: true }), 'E_PROJECT_PATH');
  await assertProjectError(() => openProject(ws, '../逃出工作区', { create: true }), 'E_PATH_ESCAPE');
  await assertProjectError(() => openProject(ws, 'projects/CON', { create: true }), 'E_PROJECT_NAME');
  await assertProjectError(() => openProject(ws, 'projects/结尾点.', { create: true }), 'E_PROJECT_NAME');
  await assertProjectError(() => openProject(ws, 'projects/a:b', { create: true }), 'E_PROJECT_NAME');
  await assertProjectError(() => openProject(ws, path.join(ws, 'abs'), { create: true }), 'E_PATH_ABSOLUTE');

  const ok = await openProject(ws, 'projects/第一天 的片子', { create: true });
  assert.ok(fs.statSync(ok.root).isDirectory());
});

test('工作区不存在：E_WORKSPACE，不替用户造工作区', async () => {
  const ws = await makeTemp('ws-absent');
  const gone = path.join(ws, '没有这个工作区');
  await assertProjectError(() => openProject(gone, 'projects/x', { create: true }), 'E_WORKSPACE');
  assert.equal(fs.existsSync(gone), false);
});

test('sanitizeName：保留中文，换掉非法字符与保留名，不产生空名', () => {
  assert.equal(sanitizeName('机房 a/b:c?.jpg'), '机房 a-b-c-.jpg');
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('   '), 'item');
  assert.ok(sanitizeName('x'.repeat(400)).length <= 120);
});

// ── 路径范围 ────────────────────────────────────────────────────────────────

test('resolveProjectPath：拒绝 .. 与绝对路径，正常相对路径落在项目内', async () => {
  const ws = await makeTemp('ws-resolve');
  const project = await openProject(ws, 'projects/p', { create: true });

  const inside = await resolveProjectPath(project, 'assets/素材.mp4');
  assert.equal(inside.root, project.root);
  assert.ok(isInside(project.root, inside.path));
  assert.equal(inside.exists, false);

  await assertProjectError(() => resolveProjectPath(project, '../外边.txt'), 'E_PATH_ESCAPE');
  await assertProjectError(() => resolveProjectPath(project, 'a/../../外边.txt'), 'E_PATH_ESCAPE');
  await assertProjectError(() => resolveProjectPath(project, 'C:/Windows/win.ini'), 'E_PATH_ABSOLUTE');
  await assertProjectError(() => resolveProjectPath(project, '/etc/passwd'), 'E_PATH_ABSOLUTE');
});

test('assertPathInProject：项目外的绝对路径与指向项目外的链接都拒绝', async () => {
  const ws = await makeTemp('ws-assert');
  const project = await openProject(ws, 'projects/p', { create: true });
  const outside = await writeFileDeep(path.join(ws, 'outside.txt'), 'not yours');

  await assertProjectError(() => assertPathInProject(project, outside), 'E_PATH_ESCAPE');

  const ok = await writeFileDeep(path.join(project.dirs.assets, 'inside.txt'), 'mine');
  const result = await assertPathInProject(project, ok);
  assert.equal(result.exists, true);
  assert.equal(result.real, ok);
});

test('项目内符号链接：拒绝跟随，即使目标在项目外', async () => {
  const ws = await makeTemp('ws-link');
  const project = await openProject(ws, 'projects/p', { create: true });
  const outsideDir = await writeFileDeep(path.join(ws, 'private', 'secret.txt'), 'private');

  const made = await trySymlink(path.dirname(outsideDir), path.join(project.dirs.assets, '偷渡'), 'dir');
  if (!made) return; // 本机没有创建链接的权限时跳过，不把环境限制当通过

  await assertProjectError(() => resolveProjectPath(project, 'assets/偷渡/secret.txt'), 'E_SYMLINK');
  await assertProjectError(() => assertPathInProject(project, path.join(project.dirs.assets, '偷渡')), 'E_SYMLINK');
});

// ── 复制素材 ────────────────────────────────────────────────────────────────

test('复制单文件：副本进 assets/，原件字节与时间不变，清单记录来源与哈希', async () => {
  const ws = await makeTemp('ws-copy');
  const project = await openProject(ws, 'projects/p', { create: true });
  const original = await writeFileDeep(path.join(ws, '用户素材', '机房 空镜.jpg'), 'JPEG-BYTES-001');
  const before = { sha: await sha256(original), mtime: fs.statSync(original).mtimeMs };

  const result = await importAssets(project, [original]);
  assert.equal(result.ok, true);
  assert.equal(result.imported.length, 1);

  const copied = path.join(project.root, result.imported[0].dest);
  assert.equal(await fsp.readFile(copied, 'utf8'), 'JPEG-BYTES-001');
  assert.equal(result.imported[0].sha256, before.sha);
  assert.equal(result.imported[0].source, original);
  assert.equal(fs.statSync(original).mtimeMs, before.mtime, '原件 mtime 不应被改动');
  assert.equal(await sha256(original), before.sha, '原件内容不应被改动');

  const manifest = await readProvenance(project);
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].source, original);
  assert.equal(manifest.assets[0].dest, result.imported[0].dest);
  assert.ok(fs.existsSync(path.join(project.dirs.assets, PROVENANCE_FILE)));
});

test('复制目录：中文相对路径完整保留，清单逐文件登记', async () => {
  const ws = await makeTemp('ws-dir');
  const project = await openProject(ws, 'projects/p', { create: true });
  const srcDir = path.join(ws, '外景素材');
  await writeFileDeep(path.join(srcDir, '第一天', '开场 01.mp4'), 'VIDEO-ONE');
  await writeFileDeep(path.join(srcDir, '第一天', '开场 02.mp4'), 'VIDEO-TWO');
  await writeFileDeep(path.join(srcDir, '说明.txt'), '说明文字');

  const result = await importAssets(project, [srcDir]);
  assert.equal(result.ok, true);
  assert.equal(result.imported.length, 3);

  const rels = result.imported.map((i) => i.dest).sort();
  assert.deepEqual(rels, [
    'assets/外景素材/第一天/开场 01.mp4',
    'assets/外景素材/第一天/开场 02.mp4',
    'assets/外景素材/说明.txt',
  ]);
  for (const rel of rels) {
    assert.ok(fs.existsSync(path.join(project.root, ...rel.split('/'))), `${rel} 应该存在`);
  }
});

test('重名：两份都留，后来的自动改名，谁都不被覆盖', async () => {
  const ws = await makeTemp('ws-dup');
  const project = await openProject(ws, 'projects/p', { create: true });
  const a = await writeFileDeep(path.join(ws, 'a', '同名.txt'), 'AAA');
  const b = await writeFileDeep(path.join(ws, 'b', '同名.txt'), 'BBB');

  const result = await importAssets(project, [a, b]);
  assert.equal(result.imported.length, 2);
  const dests = result.imported.map((i) => i.dest).sort();
  assert.deepEqual(dests, ['assets/同名 (2).txt', 'assets/同名.txt']);

  const contents = [];
  for (const rel of dests) contents.push(await fsp.readFile(path.join(project.root, ...rel.split('/')), 'utf8'));
  assert.deepEqual(contents.sort(), ['AAA', 'BBB']);
});

test('同一份素材复制两次：第二次 skipped，不长出多余副本', async () => {
  const ws = await makeTemp('ws-idem');
  const project = await openProject(ws, 'projects/p', { create: true });
  const src = await writeFileDeep(path.join(ws, 'once.mp4'), 'ONCE');

  const first = await importAssets(project, [src]);
  assert.equal(first.imported.length, 1);

  const second = await importAssets(project, [src]);
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.skipped[0].reason, 'already-imported');

  const files = await listFilesRecursive(project.dirs.assets);
  assert.deepEqual(files, [PROVENANCE_FILE, 'once.mp4']);
});

test('原件删除后项目副本仍可自证完整（断网/原路径变化）', async () => {
  const ws = await makeTemp('ws-offline');
  const project = await openProject(ws, 'projects/p', { create: true });
  const src = await writeFileDeep(path.join(ws, '临时盘', 'take.mp4'), 'TAKE-1');

  await importAssets(project, [src]);
  await fsp.rm(path.dirname(src), { recursive: true, force: true });
  assert.equal(fs.existsSync(src), false);

  const verified = await verifyAssets(project);
  assert.equal(verified.ok, true);
  assert.equal(verified.checked, 1);

  const listed = await listAssets(project);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].source, src, '副本仍记得它从哪来');
});

test('副本被改动：verifyAssets 报 changed，不冒充完整', async () => {
  const ws = await makeTemp('ws-tamper');
  const project = await openProject(ws, 'projects/p', { create: true });
  const src = await writeFileDeep(path.join(ws, 'take.mp4'), 'TAKE-1');
  const result = await importAssets(project, [src]);
  const copied = path.join(project.root, ...result.imported[0].dest.split('/'));
  await fsp.writeFile(copied, 'TAMPERED');

  const verified = await verifyAssets(project);
  assert.equal(verified.ok, false);
  assert.equal(verified.changed.length, 1);
});

test('失败保护：一条素材缺失 → 整批不落盘，原件不动，目录干净', async () => {
  const ws = await makeTemp('ws-atomic');
  const project = await openProject(ws, 'projects/p', { create: true });
  const good = await writeFileDeep(path.join(ws, 'good.mp4'), 'GOOD');
  const missing = path.join(ws, '缺的这一份.mp4');

  await assertProjectError(() => importAssets(project, [good, missing]), 'E_SOURCE_MISSING');

  const files = await listFilesRecursive(project.dirs.assets);
  assert.deepEqual(files, [], '失败后不应留下任何副本或临时目录');

  const manifest = await readProvenance(project);
  assert.equal(manifest.assets.length, 0);
  assert.equal(await fsp.readFile(good, 'utf8'), 'GOOD');
});

test('两次不同来源的复制：清单是追加而不是覆盖，旧副本仍在', async () => {
  const ws = await makeTemp('ws-append');
  const project = await openProject(ws, 'projects/p', { create: true });
  const a = await writeFileDeep(path.join(ws, 'a.mp4'), 'AAA');
  const b = await writeFileDeep(path.join(ws, 'b.mp4'), 'BBB');

  await importAssets(project, [a]);
  await importAssets(project, [b]);

  const manifest = await readProvenance(project);
  assert.equal(manifest.assets.length, 2);
  assert.deepEqual(
    manifest.assets.map((x) => x.source).sort(),
    [a, b].sort(),
  );
  assert.equal(await fsp.readFile(path.join(project.root, 'assets', 'a.mp4'), 'utf8'), 'AAA');
});

test('目标名里的路径分隔与父级符号被收拾平，不会写到 assets/ 之外', async () => {
  const ws = await makeTemp('ws-evilname');
  const project = await openProject(ws, 'projects/p', { create: true });
  const src = await writeFileDeep(path.join(ws, 'in.mp4'), 'IN');

  const result = await importAssets(project, [{ path: src, as: '../../逃出/evil.mp4' }]);
  const dest = result.imported[0].dest;
  assert.ok(dest.startsWith('assets/'), `dest 应在 assets/ 下，实际 ${dest}`);
  assert.equal(dest.includes('..'), false);
  assert.ok(fs.existsSync(path.join(project.root, ...dest.split('/'))));
  assert.equal(fs.existsSync(path.join(project.root, '逃出')), false);
});

test('副本被删除：verifyAssets 报 missing，不是静默通过', async () => {
  const ws = await makeTemp('ws-gone');
  const project = await openProject(ws, 'projects/p', { create: true });
  const src = await writeFileDeep(path.join(ws, 'take.mp4'), 'TAKE');
  const result = await importAssets(project, [src]);
  await fsp.rm(path.join(project.root, ...result.imported[0].dest.split('/')));

  const verified = await verifyAssets(project);
  assert.equal(verified.ok, false);
  assert.equal(verified.missing.length, 1);
  assert.equal(verified.checked, 1);
});

test('清单写不进去时不留孤儿副本：磁盘保持原样', async () => {
  const ws = await makeTemp('ws-nomanifest');
  const project = await openProject(ws, 'projects/p', { create: true });
  // 把清单位置做成目录：读取会失败，写入更不可能成功。
  await fsp.mkdir(path.join(project.dirs.assets, PROVENANCE_FILE), { recursive: true });
  const src = await writeFileDeep(path.join(ws, 'take.mp4'), 'TAKE');

  await assert.rejects(() => importAssets(project, [src]));
  const files = await listFilesRecursive(project.dirs.assets);
  assert.deepEqual(files.filter((f) => f.endsWith('.mp4')), [], '不应留下已复制的素材');
  assert.deepEqual(files.filter((f) => f.startsWith('.import-')), [], '不应留下暂存目录');
});

test('非原子模式：坏的那条进 failures，好的照常进，结果不谎报全成', async () => {
  const ws = await makeTemp('ws-partial');
  const project = await openProject(ws, 'projects/p', { create: true });
  const good = await writeFileDeep(path.join(ws, 'good.mp4'), 'GOOD');

  const result = await importAssets(project, [good, { path: path.join(ws, '缺失.mp4') }], { atomic: false });
  assert.equal(result.ok, false);
  assert.equal(result.imported.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'E_SOURCE_MISSING');
});

test('取消信号：复制中途被取消 → 抛 E_ABORTED 并回滚，不留半截副本', async () => {
  const ws = await makeTemp('ws-abort');
  const project = await openProject(ws, 'projects/p', { create: true });
  const a = await writeFileDeep(path.join(ws, 'a.mp4'), 'AAA');
  const b = await writeFileDeep(path.join(ws, 'b.mp4'), 'BBB');

  const controller = new AbortController();
  controller.abort('用户取消');

  await assertProjectError(() => importAssets(project, [a, b], { signal: controller.signal }), 'E_ABORTED');
  assert.deepEqual(await listFilesRecursive(project.dirs.assets), [], '取消后不应留下副本或暂存目录');
  assert.equal(await fsp.readFile(a, 'utf8'), 'AAA');
});

test('来源清单损坏：拒绝覆盖，明确报 E_MANIFEST', async () => {
  const ws = await makeTemp('ws-manifest');
  const project = await openProject(ws, 'projects/p', { create: true });
  await fsp.writeFile(path.join(project.dirs.assets, PROVENANCE_FILE), '{ 这不是 json');

  await assertProjectError(() => readProvenance(project), 'E_MANIFEST');
  const src = await writeFileDeep(path.join(ws, 'x.mp4'), 'X');
  await assertProjectError(() => importAssets(project, [src]), 'E_MANIFEST');

  const raw = await fsp.readFile(path.join(project.dirs.assets, PROVENANCE_FILE), 'utf8');
  assert.equal(raw, '{ 这不是 json', '坏清单必须原样留着，等人工处理');
});

test('素材本身是符号链接：拒绝，不跟随到项目外', async () => {
  const ws = await makeTemp('ws-srclink');
  const project = await openProject(ws, 'projects/p', { create: true });
  const real = await writeFileDeep(path.join(ws, 'private', 'real.mp4'), 'PRIVATE');
  const link = path.join(ws, '看起来是素材.mp4');
  const made = await trySymlink(real, link, 'file');
  if (!made) return;

  await assertProjectError(() => importAssets(project, [link]), 'E_SYMLINK');
  assert.deepEqual(await listFilesRecursive(project.dirs.assets), []);
});

test('显式标为未授权的素材：直接拒绝，不因为路径存在就复制', async () => {
  const ws = await makeTemp('ws-auth');
  const project = await openProject(ws, 'projects/p', { create: true });
  const src = await writeFileDeep(path.join(ws, 'not-authorized.mp4'), 'NOPE');

  await assertProjectError(() => importAssets(project, [{ path: src, authorized: false }]), 'E_NOT_AUTHORIZED');
  assert.deepEqual(await listFilesRecursive(project.dirs.assets), []);
});

test('sources 为空：明确报错，不当成功', async () => {
  const ws = await makeTemp('ws-empty');
  const project = await openProject(ws, 'projects/p', { create: true });
  await assertProjectError(() => importAssets(project, []), 'E_SOURCES');
});

test('项目内的相对素材路径：给了 root 才能解析，没 root 不猜当前目录', async () => {
  const ws = await makeTemp('ws-relative');
  const project = await openProject(ws, 'projects/p', { create: true });
  await writeFileDeep(path.join(project.dirs.assets, '已有.mp4'), 'EXISTING');

  await assertProjectError(() => importAssets(project, [{ path: 'assets/已有.mp4' }]), 'E_SOURCE_RELATIVE');

  const result = await importAssets(project, [{ path: 'assets/已有.mp4', root: project.root }]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'already-in-project');
});

test('并发导入两份不同素材：清单合并两条，不是后写覆盖前写', async () => {
  const ws = await makeTemp('ws-concurrent');
  const project = await openProject(ws, 'projects/p', { create: true });
  const a = await writeFileDeep(path.join(ws, 's1.mp4'), 'ONE');
  const b = await writeFileDeep(path.join(ws, 's2.mp4'), 'TWO');

  const [r1, r2] = await Promise.all([importAssets(project, [a]), importAssets(project, [b])]);
  assert.equal(r1.imported.length, 1);
  assert.equal(r2.imported.length, 1);

  const manifest = await readProvenance(project);
  assert.equal(manifest.assets.length, 2, '两个会话各登记一条，谁都不许被覆盖');
  assert.deepEqual(manifest.assets.map((x) => x.source).sort(), [a, b].sort());

  const files = (await listFilesRecursive(project.dirs.assets)).filter((f) => f.endsWith('.mp4'));
  assert.deepEqual(files, ['s1.mp4', 's2.mp4']);
  // 锁文件必须收干净
  assert.deepEqual(
    (await listFilesRecursive(project.dirs.assets)).filter((f) => f.includes('.lock') || f.startsWith('.import-')),
    [],
  );
});

test('索引里已有同一份素材时并发导入：两边都 skipped，不会各建一份', async () => {
  const ws = await makeTemp('ws-concurrent-same');
  const project = await openProject(ws, 'projects/p', { create: true });
  const a = await writeFileDeep(path.join(ws, 'same.mp4'), 'SAME');
  await importAssets(project, [a]);

  const [r1, r2] = await Promise.all([importAssets(project, [a]), importAssets(project, [a])]);
  assert.equal(r1.imported.length + r2.imported.length, 0);
  assert.equal(r1.skipped.length + r2.skipped.length, 2);
  assert.equal((await readProvenance(project)).assets.length, 1);
  assert.deepEqual((await listFilesRecursive(project.dirs.assets)).filter((f) => f.endsWith('.mp4')), ['same.mp4']);
});

// ── 经验库：权限与写入 ──────────────────────────────────────────────────────

const APPROVAL = { approved: true, grantedBy: 'host:test', scope: 'library-write' };
const ASSET_APPROVAL = { approved: true, grantedBy: 'host:test', scope: 'library-asset-copy' };

const ENTRY = {
  scene: 'sound',
  title: '机房开场用低频电流声垫底',
  oneLine: '开场先只给低频电流声，人声进来再推音乐',
  observable: '前 2 秒没有 200Hz 以上持续能量；人声进来那一帧音乐同时起',
  appliesWhen: '室内机械题材且有旁白',
  counter: '街头工地题材会被环境声吃掉，反而不安静',
  source: 'S-01 开场 r2→r3 的一次修改（2026-11-17）',
};

test('没有宿主批准：写库直接失败，连库目录都不建', async () => {
  const ws = await makeTemp('lib-noapprove');
  await assert.rejects(
    () => saveExperience(ws, ENTRY, null),
    (err) => err instanceof LibraryError && err.code === 'E_LIBRARY_APPROVAL',
  );
  await assert.rejects(
    () => saveExperience(ws, ENTRY, { approved: false, grantedBy: 'host' }),
    (err) => err.code === 'E_LIBRARY_APPROVAL',
  );
  await assert.rejects(
    () => copyExperienceAsset(ws, { project: ws, path: 'x' }, null),
    (err) => err.code === 'E_LIBRARY_APPROVAL',
  );

  assert.equal(fs.existsSync(path.join(ws, LIBRARY_DIR)), false, '被拒的写入不应留下空库');
});

test('批准范围不匹配：拒绝跨范围写入', async () => {
  const ws = await makeTemp('lib-scope');
  await assert.rejects(
    () => saveExperience(ws, ENTRY, { approved: true, grantedBy: 'host', scope: 'library-asset-copy' }),
    (err) => err.code === 'E_LIBRARY_APPROVAL',
  );
});

test('写一条经验：按场景落盘、索引一行、字段齐全、批准可追溯', async () => {
  const ws = await makeTemp('lib-save');
  const result = await saveExperience(ws, ENTRY, APPROVAL);

  assert.equal(result.status, 'created');
  const file = path.join(ws, LIBRARY_DIR, ...result.entry.path.split('/'));
  const text = await fsp.readFile(file, 'utf8');
  for (const expected of ['一句话', '可检验特征', '适用条件', '反例或失效条件', '出处', '待验证']) {
    assert.ok(text.includes(expected), `条目里应有「${expected}」`);
  }
  assert.ok(text.includes('入库授权：host:test'), '批准记录必须留痕');

  const index = await fsp.readFile(path.join(ws, LIBRARY_DIR, 'index.md'), 'utf8');
  const line = index.trim().split(/\r?\n/)[0];
  assert.match(line, /^- \d{4}-\d{2}-\d{2} · .+ · 声音与配乐\/.+\.md · 待验证$/);
});

test('条目字段不全：缺适用条件/出处拒绝；缺可检验特征或反例则不编内容、压回待验证', async () => {
  const ws = await makeTemp('lib-incomplete');
  await assert.rejects(
    () => saveExperience(ws, { ...ENTRY, appliesWhen: '' }, APPROVAL),
    (err) => err.code === 'E_LIBRARY_ENTRY',
  );
  await assert.rejects(
    () => saveExperience(ws, { ...ENTRY, source: '  ' }, APPROVAL),
    (err) => err.code === 'E_LIBRARY_ENTRY',
  );
  await assert.rejects(
    () => saveExperience(ws, { ...ENTRY, scene: '   ' }, APPROVAL),
    (err) => err.code === 'E_LIBRARY_SCENE',
  );
  await assert.rejects(
    () => saveExperience(ws, { ...ENTRY, status: '随便写' }, APPROVAL),
    (err) => err.code === 'E_LIBRARY_ENTRY',
  );
  assert.equal(fs.existsSync(path.join(ws, LIBRARY_DIR)), false);

  // 缺「反例」不阻断，但必须写明未提供，且状态不许冒充在用
  const partial = await saveExperience(ws, { ...ENTRY, counter: '', status: '在用' }, APPROVAL);
  assert.equal(partial.status, 'created');
  assert.equal(partial.entry.status, '待验证', '缺字段时不许保持「在用」');
  const text = await fsp.readFile(path.join(ws, LIBRARY_DIR, ...partial.entry.path.split('/')), 'utf8');
  assert.ok(text.includes('未提供'), '缺的内容要写明未提供，而不是编一个出来');
  assert.ok(text.includes('待验证'));
});

test('自定义场景：七类之外的场景名照场景落盘，不被硬拒绝', async () => {
  const ws = await makeTemp('lib-customscene');
  const result = await saveExperience(ws, { ...ENTRY, scene: '开场设计' }, APPROVAL);
  assert.equal(result.status, 'created');
  assert.ok(result.entry.path.startsWith('开场设计/'), `实际路径 ${result.entry.path}`);

  const hits = await searchLibrary(ws, '', { scene: '开场设计' });
  assert.equal(hits.hits.length, 1);
});

test('重复条目：默认报冲突，不动已有文件；keep-both 才另存一条', async () => {
  const ws = await makeTemp('lib-conflict');
  const first = await saveExperience(ws, ENTRY, APPROVAL);
  const file = path.join(ws, LIBRARY_DIR, ...first.entry.path.split('/'));
  const before = await fsp.readFile(file, 'utf8');

  const conflict = await saveExperience(ws, { ...ENTRY, source: '另一支片' }, APPROVAL);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 'conflict');
  assert.ok(conflict.conflicts.some((c) => c.type === 'same-path' || c.type === 'same-one-line'));
  assert.equal(await fsp.readFile(file, 'utf8'), before, '冲突时不得改动原条目');

  const kept = await saveExperience(ws, { ...ENTRY, source: '另一支片' }, APPROVAL, { resolution: 'keep-both' });
  assert.equal(kept.status, 'kept-both');
  assert.notEqual(kept.entry.path, first.entry.path);

  const index = await readLibraryIndex(ws);
  assert.equal(index.entries.length, 2);
});

test('索引损坏行：单独报出，不当成条目，也不静默重写', async () => {
  const ws = await makeTemp('lib-badindex');
  await fsp.mkdir(path.join(ws, LIBRARY_DIR), { recursive: true });
  await fsp.writeFile(path.join(ws, LIBRARY_DIR, 'index.md'), '- 这不是合法的一行\n- 2026-11-18 · 有效条目 · methods/x.md · 待验证\n');

  const index = await readLibraryIndex(ws);
  assert.equal(index.entries.length, 1);
  assert.equal(index.malformed.length, 1);
});

// ── 经验库：按场景复制资产 ──────────────────────────────────────────────────

test('复制资产进库：按场景分类、项目原件保留、来源与哈希可查', async () => {
  const ws = await makeTemp('lib-asset');
  const project = await openProject(ws, 'projects/p', { create: true });
  const original = await writeFileDeep(path.join(project.dirs.assets, '机房 空镜.jpg'), 'JPEG-ASSET');
  const before = await sha256(original);

  const result = await copyExperienceAsset(
    ws,
    { project, path: 'assets/机房 空镜.jpg', scene: 'visual', oneLine: '机房空镜作视觉底', appliesWhen: '室内机械题材', counter: '明亮办公室题材不适用', source: '机房科普片 r1' },
    ASSET_APPROVAL,
  );

  assert.equal(result.ok, true);
  assert.equal(result.asset.destRelative, `${SCENES.visual}/机房 空镜.jpg`);
  assert.equal(await fsp.readFile(result.asset.dest, 'utf8'), 'JPEG-ASSET');
  assert.equal(await sha256(original), before, '项目原件必须保留且未改');
  assert.ok(fs.existsSync(original), '项目里那份原件还在');

  const sidecar = path.join(ws, LIBRARY_DIR, ...result.entry.path.split('/'));
  const text = await fsp.readFile(sidecar, 'utf8');
  assert.ok(text.includes('入库副本：视觉与美术/机房 空镜.jpg'));
  assert.ok(text.includes('入库授权：host:test'));
});

test('库里已有同内容资产：报冲突不复制第二份；keep-both 才并列一份', async () => {
  const ws = await makeTemp('lib-asset-dup');
  const project = await openProject(ws, 'projects/p', { create: true });
  await writeFileDeep(path.join(project.dirs.assets, 'b.jpg'), 'SAME-BYTES');

  const input = { project, path: 'assets/b.jpg', scene: 'visual', appliesWhen: '室内', counter: '户外不适用', source: '片 A' };
  const first = await copyExperienceAsset(ws, input, ASSET_APPROVAL);
  assert.equal(first.ok, true);

  const conflict = await copyExperienceAsset(ws, { ...input, source: '片 B' }, ASSET_APPROVAL);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 'conflict');
  assert.ok(conflict.conflicts.some((c) => c.type === 'same-content'));

  const kept = await copyExperienceAsset(ws, { ...input, source: '片 B' }, ASSET_APPROVAL, { resolution: 'keep-both' });
  assert.equal(kept.ok, true);
  assert.equal(kept.asset.destRelative, `${SCENES.visual}/b (2).jpg`);
});

test('资产来源越界：项目外的文件不能借项目名义入库', async () => {
  const ws = await makeTemp('lib-asset-escape');
  const project = await openProject(ws, 'projects/p', { create: true });
  const outside = await writeFileDeep(path.join(ws, 'private.mp4'), 'PRIVATE');

  await assert.rejects(
    () => copyExperienceAsset(ws, { project, path: outside, scene: 'visual', appliesWhen: 'x', counter: 'y', source: 'z' }, ASSET_APPROVAL),
    (err) => err.code === 'E_LIBRARY_SOURCE' || err.code === 'E_PATH_ABSOLUTE',
  );
  await assert.rejects(
    () => copyExperienceAsset(ws, { project, path: '../private.mp4', scene: 'visual', appliesWhen: 'x', counter: 'y', source: 'z' }, ASSET_APPROVAL),
    (err) => err.code === 'E_LIBRARY_SOURCE' || err.code === 'E_PATH_ESCAPE',
  );
});

test('库内路径经过符号链接：拒绝，不跟随到库外', async () => {
  const ws = await makeTemp('lib-link');
  const project = await openProject(ws, 'projects/p', { create: true });
  await writeFileDeep(path.join(project.dirs.assets, 'a.jpg'), 'A');
  const outsideDir = await writeFileDeep(path.join(ws, 'elsewhere', 'keep.txt'), 'KEEP');

  await fsp.mkdir(path.join(ws, LIBRARY_DIR), { recursive: true });
  const made = await trySymlink(path.dirname(outsideDir), path.join(ws, LIBRARY_DIR, SCENES.visual), 'dir');
  if (!made) return;

  await assert.rejects(
    () => resolveLibraryPath(ws, `${SCENES.visual}/keep.txt`),
    (err) => err.code === 'E_LIBRARY_PATH',
  );
});

test('资产是 .md 时：说明卡不会把资产本身覆盖掉', async () => {
  const ws = await makeTemp('lib-md');
  const project = await openProject(ws, 'projects/p', { create: true });
  await writeFileDeep(path.join(project.dirs.assets, '开场结构.md'), '# 原始笔记\n不改我');

  const result = await copyExperienceAsset(
    ws,
    { project, path: 'assets/开场结构.md', scene: 'story', appliesWhen: '长片开场', counter: '短片不适用', source: '片 A' },
    ASSET_APPROVAL,
  );
  assert.equal(result.ok, true);
  assert.notEqual(result.entry.path, result.asset.destRelative, '说明卡不能和资产同路径');

  const assetText = await fsp.readFile(result.asset.dest, 'utf8');
  assert.equal(assetText, '# 原始笔记\n不改我', '入库的资产必须保持原字节');
  const sidecar = await fsp.readFile(path.join(ws, LIBRARY_DIR, ...result.entry.path.split('/')), 'utf8');
  assert.ok(sidecar.includes('一句话'));
});

// ── 经验库：读 ──────────────────────────────────────────────────────────────

test('库还没建：exists=false，不预建目录，并给出正常状态提示', async () => {
  const ws = await makeTemp('lib-fresh');
  const info = await inspectLibrary(ws);
  assert.equal(info.exists, false);
  assert.equal(info.entries, 0);
  assert.match(info.note, /还没建/);
  assert.equal(fs.existsSync(path.join(ws, LIBRARY_DIR)), false);

  const search = await searchLibrary(ws, '低频');
  assert.equal(search.exists, false);
  assert.equal(search.hits.length, 0);
});

test('检索：按场景筛、跳过已废条目、只匹配索引行不读正文', async () => {
  const ws = await makeTemp('lib-search');
  await saveExperience(ws, ENTRY, APPROVAL);
  await saveExperience(
    ws,
    {
      ...ENTRY,
      scene: 'visual',
      title: '暗背景不要用蓝紫',
      oneLine: '暗背景里蓝紫会抢主体',
      slug: '暗背景不要用蓝紫',
    },
    APPROVAL,
  );
  await saveExperience(
    ws,
    {
      ...ENTRY,
      scene: 'edit',
      title: '旧接缝做法',
      oneLine: '旧接缝做法已经不够好',
      slug: '旧接缝做法',
      status: '已废',
    },
    APPROVAL,
  );

  const all = await searchLibrary(ws);
  assert.equal(all.hits.length, 2, '已废条目默认不出现');

  const visual = await searchLibrary(ws, '', { scene: '视觉与美术' });
  assert.equal(visual.hits.length, 1);
  assert.ok(visual.hits[0].path.startsWith(`${SCENES.visual}/`));

  const sound = await searchLibrary(ws, '低频', { scene: 'sound' });
  assert.equal(sound.hits.length, 1);
});
