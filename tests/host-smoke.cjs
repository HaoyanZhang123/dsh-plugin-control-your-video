// Runs against the installed DSH provider, with isolated storage and scripted human answers.
const assert = require('node:assert/strict');
const { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const installed = process.argv[2] || process.env.DSH_INSTALL_DIR;
if (!installed) throw new Error('Pass the installed DSH package directory.');
const fromDsh = createRequire(join(installed, 'package.json'));
const { Context } = fromDsh('@deepseek-ai/cordis');
const { createScope, scopeTarget } = fromDsh('@deepseek-ai/dsh-scope');
const { ToolsService } = fromDsh('@deepseek-ai/dsh-tools');
const nativeExecutor = fromDsh('@deepseek-ai/dsh-tool-executor-native');
const { UserQuestionService } = fromDsh('@deepseek-ai/dsh-user-questions');
const { entryListSchema, applyEntryPatches } = fromDsh('@deepseek-ai/cordis-plugin-include');
const fromInclude = createRequire(fromDsh.resolve('@deepseek-ai/cordis-plugin-include'));
const yaml = fromInclude('js-yaml');
const fromCandidate = createRequire(join(__dirname, '..', 'package.json'));
const load = file => import(pathToFileURL(join(__dirname, '..', file)).href);
const modulePlugin = name => {
  const loaded = fromDsh(name);
  return loaded.apply ? loaded : loaded.default;
};

async function main() {
  const fixture = await mkdtemp(join(tmpdir(), 'cyv-dsh-smoke-'));
  const ctx = new Context();
  const agents = new Map();
  const questions = [];
  const mediaProviders = [];
  let approve = true;
  try {
    const patch = yaml.load(await readFile(join(__dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema });
    const rows = applyEntryPatches([], patch);
    const main = rows.find(row => row.config?.id === 'control-your-video');
    const research = rows.find(row => row.config?.id === 'control-your-video-research');
    assert.ok(main && research);
    for (const row of [...rows, ...main.config.plugins, ...research.config.plugins]) {
      if (row.name === 'cordis:group') continue;
      if (row.name.startsWith('dsh-plugin-control-your-video')) fromCandidate.resolve(row.name);
      else fromDsh.resolve(row.name);
    }
    // The video preset must inherit the shipped standard tool list, not replace it.
    const videoRows = new Set(main.config.plugins.map(row => row.id));
    for (const row of ['tool-pwsh', 'tool-bash', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-schedule',
      'tool-todo', 'tool-web', 'present', 'tool-plugin-manager', 'delegation', 'tool-ask-user']) {
      assert.ok(videoRows.has(row), `standard row ${row} should stay in the video preset`);
    }
    assert.ok(videoRows.has('controlled-video'));
    assert.ok(!research.config.plugins.some(row => row.name === 'dsh-plugin-control-your-video'));
    // The shipped patch must stay additive. rc.1 shipped its own `.../policy` row and a
    // `native-executor` row to narrow the inherited tool list; 0.4.0 ships neither, so a
    // reappearing one would silently turn this preset back into the restricted composition.
    const candidateRows = [...main.config.plugins, ...research.config.plugins]
      .filter(row => row.name.startsWith('dsh-plugin-control-your-video'))
      .map(row => row.name);
    assert.deepEqual(candidateRows.sort(), ['dsh-plugin-control-your-video'],
      'the video preset should add only the video plugin row, not a policy or executor row');
    assert.ok(!main.config.plugins.some(row => row.name === '@deepseek-ai/dsh-tool-executor-native'),
      'the video preset must not mount its own tool executor');
    assert.ok(!main.config.plugins.some(row => /\/policy$/.test(row.name)),
      'the video preset must not mount the legacy narrowing policy');
    console.log('Installed DSH patch parser: candidate entries and all module exports resolved.');
    await ctx.plugin({ apply(runtime) {
      runtime.provide('systemPrompt', { tools() {}, section() {} });
      runtime.provide('agents', agents);
      runtime.provide('workingDirectory', { get: () => fixture });
      runtime.provide('controlYourVideoMediaProviders', mediaProviders);
      runtime.on('user-questions/request', ({ questions: items }) => {
        questions.push(...items);
        return { answers: items.map(item => ({ id: item.id, selected: approve ? [item.intent.approve] : [] })) };
      });
    } });
    await ctx.plugin(ToolsService);
    await ctx.plugin(UserQuestionService);
    await ctx.plugin(modulePlugin('@deepseek-ai/dsh-storage'));
    await ctx.plugin(modulePlugin('@deepseek-ai/dsh-storage-json'), { root: join(fixture, 'isolated-host-data') });
    await ctx.plugin(modulePlugin('@deepseek-ai/dsh-storage-domain'), { backend: 'json' });
    await ctx.plugin(await load('tools/host-store.js'));
    await ctx.plugin(nativeExecutor);
    let host;
    await ctx.plugin({ inject: ['tools'], apply(runtime) { host = runtime; } });
    const stubTool = (name, execute) => ({ name, description: name,
      parameters: { type: 'object', additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute });
    // Stand-ins for the modules the real standard preset mounts. The preset under
    // test must not narrow them away: the video preset inherits the standard list.
    // `schedule_create`, `workflow` and `subagent_fork` are here because rc.1 blocked
    // exactly those names; 0.4.0 must expose them like any other standard tool.
    const present = () => 'ok';
    const standardTools = ['pwsh', 'bash', 'read', 'write', 'edit', 'subagent', 'subagent_fork',
      'workflow', 'schedule_create', 'todo_write', 'ask_user_question', 'progress_update',
      'load_workspace_dependencies'];
    await ctx.plugin({ inject: ['tools'], apply(runtime) {
      for (const name of standardTools) runtime.tools.register(stubTool(name, present));
    } });
    const preset = {};
    const presetScope = createScope(ctx, preset);
    // `tools/preset-policy.js` is no longer a row of the shipped preset (see the row
    // assertions above). It is still a resolvable export kept for older installs, so it
    // must stay loadable and inert: a policy that starts guarding or restricting again
    // would re-create the rc.1 restricted composition the preset no longer has.
    const legacyPolicy = await load('tools/preset-policy.js');
    assert.equal(typeof legacyPolicy.apply, 'function');
    assert.deepEqual(legacyPolicy.inject, ['tools']);
    const touched = [];
    const inertTarget = new Proxy({}, { get: (_t, prop) => { touched.push(String(prop)); return () => { touched.push(String(prop)); }; } });
    await legacyPolicy.apply(inertTarget);
    assert.deepEqual(touched, [], 'the legacy policy export must stay a no-op and touch no service');
    const agent = { id: 'cyv-host-smoke', session: { header: { id: 'cyv-host-smoke' } } };
    const sessionScope = createScope(ctx, agent, { parent: preset });
    agent.ctx = sessionScope.ctx;
    agents.set(agent.id, agent);
    const assemblyOnly = process.argv.includes('--assembly-only') || process.argv.includes('--policy-only');
    if (!assemblyOnly) await presetScope.ctx.plugin(await load('index.js'));
    await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' });
    const signal = new AbortController().signal;
    let next = 0;
    async function run(name, args, caller = agent) {
      const batch = await host.tools.execute({ agent: caller, signal,
        calls: [{ type: 'tool_call', id: `call-${++next}`, name, arguments: JSON.stringify(args) }] });
      return batch.results[0].result;
    }
    for (const name of standardTools) {
      assert.ok(host.tools.get(name, agent), `${name} should be available in the video preset`);
    }
    for (const name of ['schedule_create', 'workflow', 'subagent_fork']) {
      const result = await run(name, {});
      assert.equal(result.isError, false,
        `${name} was blocked by rc.1 and must run under the additive 0.4.0 preset: ${JSON.stringify(result.content)}`);
    }
    // rc.1 blocked a tool registered on the agent after `agent/created`; 0.4.0 adds
    // nothing and removes nothing, so such a registration must still execute.
    await sessionScope.ctx.plugin({ inject: ['tools'], apply(runtime) {
      runtime.tools.register(stubTool('late_assembly_probe', present));
    } });
    const late = await run('late_assembly_probe', {});
    assert.equal(late.isError, false, JSON.stringify(late.content));
    assert.doesNotMatch(JSON.stringify(late.content), /outside the controlled video preset/i);
    if (assemblyOnly) {
      console.log('Installed DSH registry/executor: the additive preset keeps the standard tools and blocks no late registration.');
      return;
    }
    for (const name of ['cyv', 'evidence']) {
      assert.ok(host.tools.get(name, agent), `${name} should be added by the video plugin`);
    }
    console.log('Installed DSH registry/executor: the video preset exposes the standard tools plus cyv and evidence.');

    const call = async (action, extra = {}) => {
      const result = await run('cyv', { action, project: 'host-demo', ...extra });
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    assert.equal(host.tools.get('cyv', agent).name, 'cyv');
    const project = await call('create');
    approve = false;
    assert.equal((await call('creative', { direction: 'A test only.' })).approved, false);
    assert.equal((await run('cyv', { action: 'render_sample', project: 'host-demo' })).isError, true);
    approve = true;
    assert.equal((await call('creative', { direction: 'A test only.' })).approved, true);
    assert.equal(questions.length, 2);
    assert.ok(project.root.startsWith(fixture));
    assert.deepEqual(await call('media_models'), { models: [] });
    console.log('Installed DSH question service and durable store: decline and approval reached the gate through structured test answers.');

    const text = `# 秩序出现

全片时长：2 秒。镜头总数：2 镜。冷蓝底，金色元素从分散变成对齐。声音使用低音调测试同步。

### 镜 1

- 时长：1 秒
- 画面：深蓝底上的金色条从画面边缘掠过，营造分散感。
- 声音：低音测试音从片头开始。
- 目的：观众先感到画面还没有稳定方向。
- 做法：用程序动画 bars-sweep 生成 24 帧，叠加字幕「开场」，FFmpeg 编码。

### 镜 2

- 时长：1 秒
- 画面：相同金色元素规整排列，保持夜蓝色底。
- 声音：同一低音测试音延续至片尾。
- 目的：让观众看出对齐已经完成。
- 做法：用程序动画 grid-drift 生成 24 帧，叠加字幕「成形」，FFmpeg 编码。
`;
    const spec = {
      version: 1, canvas: { width: 320, height: 180, fps: 24 },
      audio: { mode: 'tone', frequencyHz: 220, gainDb: -20 },
      shots: ['bars-sweep', 'grid-drift'].map((pattern, index) => ({
        id: index + 1, durationSec: 1,
        visual: { kind: 'procedural', pattern, colors: { base: '#0B1020', accent: '#E0B060' } },
        text: { lines: [index ? '成形' : '开场'] },
      })),
    };
    await call('save_plan', { text });
    const inspected = await call('check_plan');
    assert.equal(inspected.pass, true, JSON.stringify(inspected.findings));
    assert.equal((await run('cyv', { action: 'render_sample', project: 'host-demo' })).isError, true);
    assert.equal((await call('approve_plan', { spec, sampleShots: [1] })).approved, true);
    const sample = await call('render_sample');
    assert.ok(sample.duration > 0.9 && sample.duration < 1.1);
    assert.equal((await run('cyv', { action: 'render_full', project: 'host-demo' })).isError, true);
    assert.equal((await call('approve_sample')).approved, true);
    const full = await call('render_full');
    const revision = await call('revise_full', { feedback: '更换末镜的字幕。', changes: [{ id: 2, text: '定型' }] });
    assert.ok(full.duration > 1.9 && full.duration < 2.1);
    assert.equal(full.duration, revision.duration);
    assert.notEqual(full.digest, revision.digest);
    assert.notEqual(full.path, revision.path);
    assert.equal(full.media.videoCodec, 'h264');
    assert.equal(full.media.audioCodec, 'aac');
    const key = createHash('sha256').update(process.platform === 'win32' ? project.root.toLowerCase() : project.root).digest('hex');
    const recordPath = join(fixture, 'isolated-host-data', 'control_your_video_approvals', 'projects', `${key}.json`);
    const recorded = JSON.parse(await readFile(recordPath, 'utf8')).record;
    assert.equal(recorded.acceptedSample.digest, sample.digest);
    assert.equal(recorded.full.digest, revision.digest);
    assert.equal(recorded.plan.receipt.sessionId, agent.id);
    const media = await run('evidence', { action: 'measure', project: 'host-demo', source: full.path, kind: 'duration' });
    assert.equal(media.isError, false, JSON.stringify(media.content));
    const frame = await run('evidence', { action: 'extract', project: 'host-demo', source: full.path,
      revision: 'r1', shot: 1, t: 0.5, purpose: 'look' });
    assert.equal(frame.isError, false, JSON.stringify(frame.content));
    console.log(`Real FFmpeg through DSH: representative sample ${sample.duration}s, full ${full.duration}s, separate revised full ${revision.duration}s (${full.media.videoCodec}/${full.media.audioCodec}); a real frame and media measurement persisted.`);
    const clip = join(fixture, '收到的片段.mp4');
    await copyFile(join(project.root, full.path), clip);
    await call('create', { project: 'independent-caption' });
    const imported = await call('import_assets', { project: 'independent-caption', sources: [clip] });
    assert.equal(imported.imported.length, 1);
    const existingSource = imported.imported[0].dest;
    const independent = await call('subtitle_edit', { project: 'independent-caption', source: existingSource, text: '仅测试字幕' });
    assert.equal(independent.verified.audioCodec, 'aac');
    assert.equal((await call('status', { project: 'independent-caption' })).creative, null);
    assert.deepEqual(await readFile(clip), await readFile(join(project.root, full.path)));
    const saved = await call('save_experience', { source: revision.path, title: '动画节奏样例', scene: 'motion', notes: '适用于当前可视化片段。' });
    assert.equal(saved.ok, true);
    assert.equal((await stat(join(project.root, revision.path))).isFile(), true);
    const remembered = await call('read_experience', { query: '动画节奏样例' });
    assert.equal(remembered.hits.length, 1);
    console.log('Existing media was copied into a separate project, captioned with audio, and kept intact. Experience was saved and then searched only after structured test permission.');

    const externalProject = await call('create', { project: 'external-local' });
    const externalCall = (action, extra = {}) => call(action, { project: 'external-local', ...extra });
    const deniedExternal = async (action, extra = {}) => {
      const result = await run('cyv', { project: 'external-local', action, ...extra });
      assert.equal(result.isError, true, JSON.stringify(result.content));
    };
    await externalCall('creative', { direction: '本地自选程序图形，沿用既定的两镜顺序。' });
    const externalPlan = text
      .replace('声音使用低音调测试同步。', '全片有意使用静默。')
      .replace('低音测试音从片头开始。', '无音轨。')
      .replace('同一低音测试音延续至片尾。', '保持静默。')
      .replace('用程序动画 bars-sweep 生成 24 帧，叠加字幕「开场」，FFmpeg 编码。', '以本机外部命令合成第一秒测试图形。')
      .replace('用程序动画 grid-drift 生成 24 帧，叠加字幕「成形」，FFmpeg 编码。', '以同一外部方式生成第二秒并导出完整文件。');
    await externalCall('save_plan', { text: externalPlan });
    await deniedExternal('prepare_run', { stage: 'sample' });
    const external = { engine: 'allowlisted local FFmpeg fixture command outside cyv render',
      canvas: { width: 320, height: 180, fps: 24 }, audio: 'none' };
    assert.equal((await externalCall('approve_plan', { external, sampleShots: [1] })).approved, true);
    const sampleRun = await externalCall('prepare_run', { stage: 'sample' });
    assert.equal(sampleRun.expectation.durationSec, 1);
    await deniedExternal('prepare_run', { stage: 'full' });
    await mkdir(join(externalProject.root, 'work'), { recursive: true });
    const renderIndependently = (relativeFile, duration, marker) => {
      // Draw frames independently of cyv's FFmpeg recipes. Use FFmpeg only as the MP4 encoder.
      const width = 320;
      const height = 180;
      const fps = 24;
      const frames = Buffer.alloc(width * height * 3 * fps * duration, 18);
      for (let frame = 0; frame < fps * duration; frame++) {
        const left = 16 + frame * 4;
        const start = frame * width * height * 3;
        for (let y = 56; y < 120; y++) {
          for (let x = left; x < left + 48; x++) {
            const pixel = start + (y * width + x) * 3;
            frames[pixel] = marker;
            frames[pixel + 1] = 142;
            frames[pixel + 2] = 62;
          }
        }
      }
      return execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '320x180',
        '-framerate', '24', '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(externalProject.root, relativeFile),
      ], { input: frames, windowsHide: true, timeout: 30000 });
    };
    renderIndependently('work/preview.mp4', 1, 220);
    const sourcePreview = await readFile(join(externalProject.root, 'work/preview.mp4'));
    const registeredSample = await externalCall('register_artifact', { runId: sampleRun.runId, source: 'work/preview.mp4' });
    assert.equal(registeredSample.verified.decodedFrameCount, 24);
    assert.equal(registeredSample.verified.seekSeconds.length, 3);
    assert.deepEqual(await readFile(join(externalProject.root, 'work/preview.mp4')), sourcePreview);
    await deniedExternal('prepare_run', { stage: 'full' });
    assert.equal((await externalCall('approve_sample')).approved, true);
    const fullRun = await externalCall('prepare_run', { stage: 'full' });
    assert.equal(fullRun.expectation.durationSec, 2);
    await deniedExternal('register_artifact', { runId: fullRun.runId, source: 'work/preview.mp4' });
    renderIndependently('work/complete.mp4', 2, 220);
    const registeredFull = await externalCall('register_artifact', { runId: fullRun.runId, source: 'work/complete.mp4' });
    assert.equal(registeredFull.verified.decodedFrameCount, 48);
    const priorOutput = await readFile(join(externalProject.root, registeredFull.path));
    const revisionRun = await externalCall('prepare_run', { stage: 'revision', feedback: 'Change only the fixture animation.' });
    renderIndependently('work/revised.mp4', 2, 100);
    const registeredRevision = await externalCall('register_artifact', { runId: revisionRun.runId, source: 'work/revised.mp4' });
    assert.notEqual(registeredRevision.path, registeredFull.path);
    assert.notEqual(registeredRevision.digest, registeredFull.digest);
    assert.equal(registeredRevision.verified.decodedFrameCount, 48);
    assert.deepEqual(await readFile(join(externalProject.root, registeredFull.path)), priorOutput);
    console.log('External local CLI through DSH: explicit run, 24-frame decoded sample, three seek points, approved 48-frame full and separate full revision.');

    let sent = 0;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/jn14AAAAASUVORK5CYII=', 'base64');
    mediaProviders.push({ id: 'mock-local', models: [{ id: 'fixture-image', capabilities: ['image'] }],
      estimate: async () => 2,
      generate: async (_request, options) => {
        sent += 1;
        assert.equal(options.maxCost, 2);
        return { mime: 'image/png', bytes: png };
      },
    });
    const selection = { provider: 'mock-local', model: 'fixture-image', currency: 'CNY', purpose: '制作隔离测试用图像' };
    const beforeGrant = questions.length;
    const mediaGrant = await externalCall('approve_media', { ...selection, costLimit: 4 });
    assert.equal(mediaGrant.approved, true);
    assert.equal(questions.length, beforeGrant + 2);
    const dispatch = { ...selection, grantId: mediaGrant.grantId, operationId: 'fixture-request-one', text: '测试图 A' };
    const first = await externalCall('generate_one_asset', dispatch);
    const replay = await externalCall('generate_one_asset', dispatch);
    assert.equal(replay.path, first.path);
    await deniedExternal('generate_one_asset', { ...dispatch, text: '与同一操作不一致的文本' });
    const second = await externalCall('generate_one_asset', { ...dispatch, operationId: 'fixture-request-two', text: '测试图 B' });
    assert.notEqual(first.path, second.path);
    assert.deepEqual(await readFile(join(externalProject.root, first.path)), png);
    await deniedExternal('generate_one_asset', { ...dispatch, operationId: 'fixture-request-three' });
    assert.equal(sent, 2);
    assert.equal(questions.length, beforeGrant + 2);
    const mediaRecords = join(fixture, 'isolated-host-data', 'control_your_video_media_grants', 'grants');
    const [mediaRecordFile] = await readdir(mediaRecords);
    const storedMedia = JSON.parse(await readFile(join(mediaRecords, mediaRecordFile), 'utf8')).record;
    assert.equal(storedMedia.grants[mediaGrant.grantId].spent, 4);
    assert.equal(storedMedia.operations['fixture-request-one'].artifactDigest, createHash('sha256').update(png).digest('hex'));
    assert.equal(storedMedia.operations['fixture-request-two'].state, 'completed');
    assert.equal(externalProject.root, join(fixture, 'external-local'));
    await rename(externalProject.root, join(fixture, 'retired-external-fixture'));
    await externalCall('create');
    await deniedExternal('generate_one_asset', dispatch);
    assert.equal(sent, 2);
    const standalone = await externalCall('generate_one_asset', { ...selection, costLimit: 2, text: '独立单次测试' });
    assert.deepEqual(await readFile(join(externalProject.root, standalone.path)), png);
    assert.equal(sent, 3);
    assert.equal(questions.length, beforeGrant + 4);
    console.log('Mock media provider through DSH: separate scope/cost approvals, durable budget and asset digest, idempotent dispatch, no grant reuse after project replacement, and compatible single dispatch.');
  } finally {
    await ctx.fiber.dispose();
    await rm(fixture, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
