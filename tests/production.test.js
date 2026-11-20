import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { renderProduction, validateProductionSpec } from '../tools/production.js';

const execute = promisify(execFile);
const available = ['ffmpeg', 'ffprobe'].every(name => {
  try { execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true }); return true; }
  catch { return false; }
});
const fixtureSpec = {
  version: 1, canvas: { width: 320, height: 180, fps: 24 },
  audio: { mode: 'tone', frequencyHz: 220, gainDb: -18 },
  shots: ['gradient-drift', 'bars-sweep'].map((pattern, index) => ({
    id: index + 1, durationSec: 1,
    visual: { kind: 'procedural', pattern, colors: { base: '#0B1020', accent: '#E0B060' } },
  })),
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'cyv-real-production-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  return root;
}

async function imageHash(file, at) {
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file,
    '-map', '0:v:0', '-frames:v', '1', '-f', 'md5', '-']);
  assert.match(stdout, /^MD5=[a-f0-9]{32}/);
  return stdout;
}

test('production accepts only constrained typed recipes', () => {
  assert.equal(validateProductionSpec(fixtureSpec).ok, true);
  assert.equal(validateProductionSpec({ ...fixtureSpec, shell: 'unused' }).ok, false);
  const spec = structuredClone(fixtureSpec);
  spec.shots[0].visual = { kind: 'video', path: 'https://example.invalid/source.mp4' };
  assert.equal(validateProductionSpec(spec).ok, false);
});

test('renders a partial shot, full film, and new full revision', { skip: !available }, async t => {
  const projectRoot = await workspace(t);
  const spec = structuredClone(fixtureSpec);
  spec.shots[1].text = { lines: ['成形 100%'] };
  const sample = await renderProduction({ projectRoot, spec, shotIds: [1], sampleMaxSeconds: 0.5, outputPath: 'output/sample.mp4' });
  assert.equal(sample.frameCount, 12);
  assert.equal(sample.shots[0].durationSec, 0.5);
  const full = await renderProduction({ projectRoot, spec, outputPath: 'output/full.mp4' });
  assert.equal(full.frameCount, 48);
  assert.equal(full.verified.videoCodec, 'h264');
  assert.equal(full.verified.audioCodec, 'aac');
  const before = await readFile(full.path);
  spec.shots[1].text.lines = ['完成 100%'];
  const revision = await renderProduction({ projectRoot, spec, outputPath: 'output/revision.mp4' });
  assert.equal(revision.frameCount, 48);
  assert.notEqual(revision.sha256, full.sha256);
  assert.deepEqual(await readFile(full.path), before);
  assert.equal(await imageHash(full.path, 0.5), await imageHash(revision.path, 0.5));
  assert.notEqual(await imageHash(full.path, 1.5), await imageHash(revision.path, 1.5));
  await assert.rejects(renderProduction({ projectRoot, spec, outputPath: 'output/full.mp4' }), { code: 'E_OUTPUT_EXISTS' });
});

test('writes one final output when concurrent renders use the same target', { skip: !available }, async t => {
  const projectRoot = await workspace(t);
  const options = { projectRoot, spec: fixtureSpec, shotIds: [1], outputPath: 'output/single.mp4' };
  const results = await Promise.allSettled([renderProduction(options), renderProduction(options)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'E_OUTPUT_EXISTS');
  assert.ok((await stat(join(projectRoot, options.outputPath))).size > 0);
});

test('demuxes declared formats and rejects a mislabeled input', { skip: !available }, async t => {
  const projectRoot = await workspace(t);
  await writeFile(join(projectRoot, 'assets', 'invalid.mp4'), 'not an MP4');
  const spec = structuredClone(fixtureSpec);
  spec.shots[0].visual = { kind: 'video', path: 'assets/invalid.mp4' };
  const outputPath = 'output/rejected.mp4';
  await assert.rejects(renderProduction({ projectRoot, spec, shotIds: [1], outputPath }), { code: 'E_RENDER' });
  await assert.rejects(stat(join(projectRoot, outputPath)), { code: 'ENOENT' });
});

test('renders a real project photo with a bounded shot window', { skip: !available }, async t => {
  const projectRoot = await workspace(t);
  const photo = join(projectRoot, 'assets', '现场 100%.png');
  await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gold:s=320x180',
    '-frames:v', '1', '-threads', '1', photo]);
  const spec = structuredClone(fixtureSpec);
  spec.shots[0].visual = { kind: 'photo', path: 'assets/现场 100%.png', motion: 'zoom-in' };
  const render = await renderProduction({ projectRoot, spec, shotIds: [1], range: { startSec: 0.25, endSec: 0.75 },
    outputPath: 'output/still.mp4' });
  assert.equal(render.frameCount, 12);
  assert.equal(render.shots[0].durationSec, 0.5);
  assert.equal(render.assets[0].path, 'assets/现场 100%.png');
});

test('rejects an already cancelled render', async t => {
  const projectRoot = await workspace(t);
  await assert.rejects(renderProduction({ projectRoot, spec: fixtureSpec, outputPath: 'cancelled.mp4',
    signal: AbortSignal.abort() }), { code: 'E_CANCELLED' });
});
