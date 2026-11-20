/**
 * plan.md 契约测试。
 *
 * 这些用例锁的是**契约**，不是某一份样本的文字：
 *   - 同一份方案，用表格写和用逐镜小节写，机器读出来的镜头列表必须一致；
 *   - 旧 11 列计划继续能过（兼容）；
 *   - 缺镜、时长对不上、把拟制作当阻塞、把虚构资源放过 —— 四种错必须各自被抓住；
 *   - 机器判不了的语义，必须留在 review 里明白写着"仍需人审"。
 *
 * 跑法：node --test tests/plan-contract.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPlan, checkPlan } from '../tools/plan-check.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'plan-check-fixtures');

function readFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** 真实文件核对器：相对 fixtures 目录判断。 */
function fixtureAssets() {
  return (relPath) => existsSync(resolve(FIXTURES, relPath));
}

/** 什么都没有的核对器：模拟"素材一个都没拿到"。 */
function noAssets() {
  return () => false;
}

function codes(result, level = null) {
  return result.findings.filter((f) => !level || f.level === level).map((f) => f.code);
}

function hasCode(result, level, code) {
  return result.findings.some((f) => f.level === level && f.code === code);
}

// ── 一、两种表达：表格与逐镜小节 ────────────────────────────────────────────

test('表格表达：换成自定列名的镜头表仍能被认出', () => {
  const result = inspectPlan(readFixture('flexible-table-plan.md'));

  assert.equal(result.pass, true, `不该有红：${JSON.stringify(result.findings.filter((f) => f.level === 'red'))}`);
  assert.deepEqual(
    result.shots.map((s) => s.id),
    [1, 2, 3, 4],
    '`S01…S04` 要规范化成整数 1…4',
  );
  assert.deepEqual(
    result.shots.map((s) => s.durationSec),
    [8, 9, 10, 8],
    '`0:08` / `9s` / `10 秒` / `8` 都要读成同一个秒数单位',
  );
  for (const shot of result.shots) {
    assert.equal(typeof shot.durationSec, 'number');
    assert.equal(shot.duration, shot.durationSec, 'duration 与 durationSec 必须是同一个数');
    assert.ok(shot.content.length > 0, '画面列要读出来');
    assert.ok(shot.route.length > 0, '路线列要读出来');
  }
});

test('逐镜小节表达：`### 镜 1` + `- 字段：值` 也能表达完整方案', () => {
  const result = inspectPlan(readFixture('flexible-block-plan.md'));

  assert.equal(result.pass, true, `不该有红：${JSON.stringify(result.findings.filter((f) => f.level === 'red'))}`);
  assert.deepEqual(result.shots.map((s) => s.id), [1, 2, 3]);
  assert.deepEqual(result.shots.map((s) => s.durationSec), [4, 5.5, 6]);
  assert.equal(result.shots[1].content.includes('铁门'), true, '画面要从 `- 画面：` 读出来');
  assert.equal(result.shots[0].source, 'block', '来源要标成 block，便于排查解析问题');
});

test('两种表达读到的是同一批镜头：混合写法不会重复计数', () => {
  const mixed = [
    '> 状态：待审 · r1 · 2026-11-20',
    '',
    '| 镜号 | 时长 | 画面 | 做法 |',
    '|---|---|---|---|',
    '| 1 | 3 秒 | 空房间，窗帘在动 | 实拍 `素材/a.mp4` |',
    '| 2 | 4 秒 | 桌上的杯子 | 实拍 `素材/b.mp4` |',
    '',
    '### 镜 2 · 杯子补充说明',
    '- 画面：杯子里的水在晃',
    '- 声音：很轻的水声',
    '',
    '### 镜 3 · 收尾',
    '- 时长：2 秒',
    '- 画面：画面渐黑',
    '- 做法：代码渲染 `work/out.html`',
    '',
    '全片 9 秒，共 3 镜。',
  ].join('\n');

  const result = inspectPlan(mixed);
  assert.deepEqual(result.shots.map((s) => s.id), [1, 2, 3], '同号的表行与小节要合并成一条');
  assert.equal(result.shots[1].sound, '很轻的水声', '表里没写的字段由小节补上');
  assert.equal(result.stats.镜数, 3);
});

// ── 二、旧计划兼容 ──────────────────────────────────────────────────────────

test('旧 11 列计划仍然通过（向后兼容）', () => {
  const result = inspectPlan(readFixture('valid-plan.md'), { assetExists: fixtureAssets() });

  assert.equal(result.pass, true, `旧计划不该被新契约挡住：${JSON.stringify(result.findings.filter((f) => f.level === 'red'))}`);
  assert.deepEqual(result.shots.map((s) => s.id), [1, 2, 3]);
  assert.deepEqual(result.shots.map((s) => s.durationSec), [3, 5, 4]);
  assert.equal(result.state.状态, '待审');
  assert.equal(result.state.修订, 'r1');
  assert.equal(result.declared.totalSeconds, 12);
});

test('checkPlan 保留旧返回形状，evidence/index 不用改', () => {
  const result = checkPlan(readFixture('valid-plan.md'), { assetExists: fixtureAssets() });

  for (const key of ['state', 'stats', 'findings', 'red', 'yellow', 'pass']) {
    assert.ok(key in result, `旧调用方要能读到 ${key}`);
  }
  assert.equal(typeof result.pass, 'boolean');
  assert.equal(typeof result.red, 'number');
  assert.equal(typeof result.yellow, 'number');
  assert.equal(Array.isArray(result.findings), true);
  assert.equal(result.findings.every((f) => ['red', 'yellow', 'info'].includes(f.level)), true);
  // 旧接口的旧统计字段仍在，CLI 与 evidence 直接遍历 stats 不会崩。
  for (const k of ['镜数', '镜头合计秒', '素材未到', '缺动源镜数']) {
    assert.ok(k in result.stats, `stats.${k} 要保留`);
  }
});

test('旧格式反样本：把"全片分配"当明细，仍会被抓成缺镜', () => {
  const result = inspectPlan(readFixture('invalid-plan.md'));

  assert.equal(result.pass, false);
  assert.equal(hasCode(result, 'red', 'coverage-incomplete'), true, '声明 42 镜却只有 2 镜明细，必须红');
  assert.equal(result.shots.length, 2);
  assert.ok(result.declared.shotCount >= 40, '分配表里的镜数要当声明');
});

// ── 三、覆盖 ────────────────────────────────────────────────────────────────

test('缺镜：声明 4 镜只写 2 镜 → 红', () => {
  const result = inspectPlan(readFixture('missing-shots-plan.md'));

  assert.equal(result.pass, false);
  assert.equal(hasCode(result, 'red', 'coverage-incomplete'), true);
  assert.equal(result.coverage.shots, 2);
  assert.equal(result.coverage.declared, 4);
});

test('一个逐镜明细都认不出来 → 红 shots-missing', () => {
  const text = ['> 状态：草稿 · r1 · 2026-11-20', '', '# 方案', '', '就拍一个海边的空镜，大概五秒。'].join('\n');
  const result = inspectPlan(text);

  assert.equal(result.pass, false);
  assert.equal(hasCode(result, 'red', 'shots-missing'), true);
  assert.equal(result.shots.length, 0);
});

test('镜号断档与重复 → 红，且不伪造编号', () => {
  const text = [
    '| 镜号 | 时长 | 画面 | 做法 |',
    '|---|---|---|---|',
    '| 1 | 3 秒 | 第一个画面 | 实拍 `素材/a.mp4` |',
    '| 3 | 3 秒 | 第三个画面 | 实拍 `素材/b.mp4` |',
    '| 3 | 3 秒 | 又写了一次三 | 实拍 `素材/c.mp4` |',
    '',
    '全片 9 秒，共 3 镜。',
  ].join('\n');
  const result = inspectPlan(text);

  assert.equal(hasCode(result, 'red', 'coverage-gap'), true, '缺第 2 镜要报');
  assert.equal(hasCode(result, 'red', 'shot-duplicate'), true, '重复的 3 要报');
  assert.deepEqual(result.coverage.missingIds, [2]);
});

test('非整数镜号：保留原串报黄，不强行编号', () => {
  const text = [
    '| 镜号 | 时长 | 画面 | 做法 |',
    '|---|---|---|---|',
    '| 1a | 3 秒 | 第一个画面 | 实拍 `素材/a.mp4` |',
    '| 2-3 | 3 秒 | 一个区间，不该被当成第 2 镜 | 实拍 `素材/b.mp4` |',
  ].join('\n');
  const result = inspectPlan(text);

  assert.equal(result.shots[0].id, null);
  assert.equal(result.shots[0].label, '1a');
  assert.equal(result.shots[1].id, null, '`2-3` 是区间，不能被压成第 2 镜');
  assert.equal(hasCode(result, 'yellow', 'shot-id-noninteger'), true);
});

// ── 四、时长 ────────────────────────────────────────────────────────────────

test('时长对不上：声明 30 秒、合计 18 秒 → 红', () => {
  const result = inspectPlan(readFixture('duration-mismatch-plan.md'), { assetExists: noAssets() });

  assert.equal(result.pass, false);
  assert.equal(hasCode(result, 'red', 'duration-mismatch'), true);
  assert.equal(result.stats.镜头合计秒, 18);
  assert.equal(result.stats.声明总时长秒, 30);
});

test('单镜缺时长 / 时长为 0 → 红，适配器拿到的必须是 null 不是 0', () => {
  const text = [
    '| 镜号 | 时长 | 画面 | 做法 |',
    '|---|---|---|---|',
    '| 1 | 待定 | 空房间 | 实拍 `素材/a.mp4` |',
    '| 2 | 3 秒 | 桌上的杯子 | 实拍 `素材/b.mp4` |',
  ].join('\n');
  const result = inspectPlan(text);

  assert.equal(result.shots[0].durationSec, null, '读不出时长要给 null，不能兜底成 0');
  assert.equal(hasCode(result, 'red', 'shot-duration-missing'), true);
  assert.equal(result.pass, false);
});

test('时长容差内（±10%）不报红', () => {
  const text = [
    '| 项目 | 值 |',
    '|---|---|',
    '| 总时长 | 10 秒 |',
    '',
    '| 镜号 | 时长 | 画面 | 做法 |',
    '|---|---|---|---|',
    '| 1 | 5.2 秒 | 甲 | 实拍 `素材/a.mp4` |',
    '| 2 | 5.4 秒 | 乙 | 实拍 `素材/b.mp4` |',
  ].join('\n');
  const result = inspectPlan(text);

  assert.equal(hasCode(result, 'red', 'duration-mismatch'), false, '10.6 对 10 秒在 10% 内');
});

// ── 五、素材三态：已有 / 待产出 / 阻塞 ──────────────────────────────────────

test('全场拟制作：路径写了就不阻断', () => {
  const result = inspectPlan(readFixture('planned-assets-plan.md'), { assetExists: noAssets() });

  assert.equal(result.pass, true, `待产出素材不该被机械阻断：${JSON.stringify(result.findings.filter((f) => f.level === 'red'))}`);
  assert.equal(result.assets.planned > 0, true);
  assert.equal(result.assets.blocked, 0);
  assert.equal(result.stats.素材未到, 0, '素材未到只数真阻塞，不数待产出');
});

test('缺素材：标成已有却找不到、或写着"缺"没来源 → 红', () => {
  const result = inspectPlan(readFixture('missing-assets-plan.md'), { assetExists: noAssets() });

  assert.equal(result.pass, false);
  assert.equal(result.assets.blocked > 0, true);
  assert.equal(hasCode(result, 'red', 'asset-blocked'), true, '状态写着"缺"要红');
  assert.equal(hasCode(result, 'red', 'asset-missing'), true, '标成已有但文件不存在，要按虚构资源报');
});

test('标成已有且文件真的在 → ready，不报红', () => {
  const result = inspectPlan(readFixture('valid-plan.md'), { assetExists: fixtureAssets() });

  assert.equal(result.assets.blocked, 0);
  assert.equal(result.assets.ready > 0, true);
  assert.equal(hasCode(result, 'red', 'asset-blocked'), false);
});

test('不给 assetExists 就不碰文件系统：路径一律记 unknown，不阻断', () => {
  const result = inspectPlan(readFixture('missing-assets-plan.md'));

  assert.equal(result.assets.unknown > 0, true);
  assert.equal(
    result.findings.filter((f) => f.level === 'red' && f.code === 'asset-missing').length,
    0,
    '没有核对能力时不能断言文件缺失',
  );
});

test('assetExists 抛错被吞掉，不炸整个检查', () => {
  const result = inspectPlan(readFixture('planned-assets-plan.md'), {
    assetExists: () => {
      throw new Error('boom');
    },
  });
  assert.equal(typeof result.pass, 'boolean');
});

// ── 六、最小字段 ────────────────────────────────────────────────────────────

test('空白路线 / 空白画面 → 红；裸类别词 → 只黄', () => {
  const text = [
    '| 镜号 | 时长 | 画面 | 做法 |',
    '|---|---|---|---|',
    '| 1 | 3 秒 | 空房间 |  |',
    '| 2 | 3 秒 |  | 档案片＋调色 |',
    '| 3 | 3 秒 | 手按下开关 | 档案片（Prelinger: 001234） |',
  ].join('\n');
  const result = inspectPlan(text);

  assert.equal(hasCode(result, 'red', 'shot-route-empty'), true);
  assert.equal(hasCode(result, 'red', 'shot-content-empty'), true);
  assert.equal(hasCode(result, 'yellow', 'shot-route-vague'), true, '裸类别词只报黄，不阻断');
  assert.equal(result.pass, false);
});

test('动源不在七类里只报黄，不再有占比门槛', () => {
  const rows = [];
  for (let i = 1; i <= 6; i += 1) {
    rows.push(`| ${i} | 2 秒 | 第 ${i} 个画面 | 实拍 \`素材/${i}.mp4\` | 静止 |`);
  }
  const text = ['| 镜号 | 时长 | 画面 | 做法 | 动源 |', '|---|---|---|---|---|', ...rows].join('\n');
  const result = inspectPlan(text);

  assert.equal(hasCode(result, 'yellow', 'shots-motion-contract'), false, '动源占比门槛必须已经去掉');
  assert.equal(result.pass, true, '6 镜全静止不该被拦');
});

// ── 七、语义仍需人审 ────────────────────────────────────────────────────────

test('pass=true 也始终要求人审，并点出语义判断的范围', () => {
  const result = inspectPlan(readFixture('flexible-table-plan.md'), { assetExists: () => true });

  assert.equal(result.pass, true);
  assert.equal(result.review.required, true, '机械通过不等于方案正确');
  assert.equal(typeof result.review.note, 'string');
  assert.match(result.review.note, /语义|人审|审阅/);
});

test('固定十节不是必需：章节名与顺序自由', () => {
  const text = [
    '> 状态：待审 · r1 · 2026-11-20',
    '',
    '## 我要做什么',
    '一支 6 秒的片。',
    '',
    '## 预算',
    '| 项目 | 值 |',
    '|---|---|',
    '| 总时长 | 6 秒 |',
    '',
    '## 怎么拍',
    '| Shot | Length | Scene | Approach |',
    '|---|---|---|---|',
    '| 1 | 3 秒 | 窗 | 实拍 `素材/win.mp4` |',
    '| 2 | 3 秒 | 门 | 实拍 `素材/door.mp4` |',
  ].join('\n');
  const result = inspectPlan(text, { assetExists: () => true });

  assert.equal(result.pass, true, `不该因为缺"一、总述"这类固定节而报红：${JSON.stringify(result.findings)}`);
  assert.equal(result.findings.some((f) => f.code.startsWith('section-missing')), false, '固定十节要求必须已经去掉');
});

test('入口兼容：CLI 与 evidence 依赖的字段一个不少', () => {
  const result = inspectPlan(readFixture('valid-plan.md'), { assetExists: fixtureAssets() });
  for (const key of ['pass', 'findings', 'shots', 'stats', 'state', 'declared', 'coverage', 'assets', 'review']) {
    assert.ok(key in result, `inspectPlan 要返回 ${key}`);
  }
  for (const shot of result.shots) {
    for (const key of ['id', 'label', 'order', 'duration', 'durationSec']) {
      assert.ok(key in shot, `每条镜头要有 ${key}`);
    }
    assert.equal(Number.isInteger(shot.id), true, 'id 一律整数，FFmpeg 适配器可直接用');
    assert.equal(Number.isInteger(shot.order), true);
  }
  assert.deepEqual(
    result.shots.map((s) => s.order),
    [1, 2, 3],
    'order 从 1 连续',
  );
});

// ── 八、走真实文件的路径也不能红 ────────────────────────────────────────────

test('柔性样本在真实文件核对下仍然通过（CLI 走的是这条路）', () => {
  for (const name of ['flexible-table-plan.md', 'flexible-block-plan.md', 'planned-assets-plan.md']) {
    const result = inspectPlan(readFixture(name), { assetExists: fixtureAssets() });
    assert.equal(
      result.pass,
      true,
      `${name} 在真实文件核对下不该有红：${JSON.stringify(result.findings.filter((f) => f.level === 'red'))}`,
    );
    assert.equal(result.assets.blocked, 0, `${name} 不该有阻塞素材`);
  }
});

test('样本里的素材占位文件仍在（删掉会让柔性样本在 CLI 上变红）', () => {
  const referenced = [
    '素材/机房/led-close.mp4',
    '素材/机房/racks-wide.mp4',
    '素材/机房/switch-raw.mp4',
    '素材/雨/roof.mp4',
    '素材/巷/subject-walk.mp4',
    '素材/工厂/dawn-wide.mp4',
    '素材/工厂/screw-close.mp4',
  ];
  const check = fixtureAssets();
  const missing = referenced.filter((p) => !check(p));
  assert.deepEqual(
    missing,
    [],
    `这些占位文件被删了：${missing.join('、')}。它们不是视频，是让"实拍素材已存在"这句话可核的占位；重新建零字节文件即可。`,
  );
});
