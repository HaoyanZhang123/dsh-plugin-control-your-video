import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../tools/evidence.js', import.meta.url));
const available = ['ffmpeg', 'ffprobe'].every(name => {
  try { execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true }); return true; }
  catch { return false; }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cyv-sheet-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'clip.mp4');
  await execute('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc=size=320x180:rate=24:duration=2', '-pix_fmt', 'yuv420p', source]);
  const evidence = join(root, 'evidence');
  await mkdir(evidence);
  return { root, source, evidence, index: join(evidence, 'index.json') };
}

function run(args) {
  return execute(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });
}

const readIndex = async file => JSON.parse(await readFile(file, 'utf8'));

test('sheet builds one contact sheet and records the real frame times', { skip: !available }, async t => {
  const f = await fixture(t);
  const { stdout } = await run(['sheet', '--dir', f.evidence, '--source', f.source,
    '--revision', 'r1', '--shot', '2', '--t', '0.4', '--span', '1', '--count', '6', '--cols', '3',
    '--purpose', 'motion', '--question', '这一段主体有没有停住？']);

  assert.match(stdout, /已生成联系表/);
  assert.match(stdout, /覆盖 0.4—1.4 秒，6 帧，格 3×2/);

  const [entry] = await readIndex(f.index);
  assert.equal(entry.id, 'r1-s02-0.4s-motion-sheet6x3');
  assert.equal(entry.purpose, 'motion');
  assert.equal(entry.span, 1);
  assert.equal(entry.count, 6);
  assert.equal(entry.cols, 3);
  assert.equal(entry.times.length, 6, '每格的真实时间点要记下来');
  const times = entry.times.map(Number);
  assert.ok(times.every((v, i) => i === 0 || v > times[i - 1]), '时间点必须递增');
  assert.ok(times[0] >= 0.4 && times[0] < 0.4 + 0.2, '第一格要落在起点附近，且是成片里的绝对时间');
  assert.ok(times.at(-1) <= 1.4 + 1e-6, '最后一格不能越过覆盖区间');
  assert.equal(entry.finding, '');
  assert.equal(entry.status, 'current');
  assert.equal(entry.question, '这一段主体有没有停住？');

  const file = join(f.evidence, entry.file);
  const info = await stat(file);
  assert.ok(info.size > 0, '联系表文件要真的写出来');
  const header = (await readFile(file)).subarray(0, 8);
  assert.deepEqual([...header], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], '必须是真 PNG');
});

test('a sheet and a single frame at the same key do not replace each other', { skip: !available }, async t => {
  const f = await fixture(t);
  await run(['sheet', '--dir', f.evidence, '--source', f.source,
    '--revision', 'r1', '--shot', '1', '--t', '0.5', '--span', '1', '--purpose', 'motion']);
  await run(['extract', '--dir', f.evidence, '--source', f.source,
    '--revision', 'r1', '--shot', '1', '--t', '0.5', '--purpose', 'motion']);

  const entries = await readIndex(f.index);
  assert.equal(entries.length, 2, '同键的单帧与联系表是两种证据，各存一份');
  assert.equal(entries.filter(e => typeof e.span === 'number').length, 1);
  assert.equal(entries.filter(e => typeof e.span !== 'number').length, 1);
});

test('re-running the same sheet reuses it unless --force is given', { skip: !available }, async t => {
  const f = await fixture(t);
  const args = ['sheet', '--dir', f.evidence, '--source', f.source,
    '--revision', 'r1', '--shot', '1', '--t', '0.2', '--span', '0.8', '--count', '4', '--cols', '2'];

  await run(args);
  const second = await run(args);
  assert.match(second.stdout, /已存在这张联系表，复用不重抽/);
  assert.equal((await readIndex(f.index)).length, 1);

  await run([...args, '--force']);
  const entries = await readIndex(f.index);
  assert.equal(entries.length, 1, '重抽覆盖同一条，不是新增一条');
});

test('sheet rejects parameters that cannot make a readable grid', { skip: !available }, async t => {
  const f = await fixture(t);
  await assert.rejects(
    () => run(['sheet', '--dir', f.evidence, '--source', f.source, '--revision', 'r1', '--shot', '1',
      '--t', '0', '--count', '2', '--cols', '5']),
    error => /列数/.test(String(error.stderr)),
  );
  await assert.rejects(
    () => run(['sheet', '--dir', f.evidence, '--source', f.source, '--revision', 'r1', '--shot', '1',
      '--t', '0', '--span', '60']),
    error => /秒数/.test(String(error.stderr)),
  );
});
