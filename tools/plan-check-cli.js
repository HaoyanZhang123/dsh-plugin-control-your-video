#!/usr/bin/env node
/**
 * plan-check 命令行入口：读一份 plan.md，跑检查，输出报告。
 *
 * 用法：
 *   node tools/plan-check-cli.js <作品夹或 plan.md> [--json] [--strict]
 *
 * 退出码：有红 = 1，否则 0。红灯非零退出，所以它能当门禁。
 * 黄灯与 info 不影响退出码：它们代表"可以进，但要在对话里说清"。
 *
 * `--strict` 把黄灯也算失败，给只想全绿的人用；默认不开，因为
 * 语义完整度本来就不该由机器一票否决。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspectPlan, createFsAssetExists } from './plan-check.js';

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function resolvePlanPath(arg) {
  const p = resolve(arg);
  if (!existsSync(p)) die(`路径不存在：${p}`);
  const st = statSync(p);
  if (st.isDirectory()) {
    const candidate = join(p, 'plan.md');
    if (!existsSync(candidate)) die(`目录里没有 plan.md：${p}`);
    return candidate;
  }
  return p;
}

/** 文件核对：相对 plan.md 所在目录判断在不在；绝对路径直接看。 */
function makeAssetExists(baseDir) {
  return createFsAssetExists(baseDir, { existsSync, resolve });
}

const LEVEL_LABEL = { red: '✗ 红', yellow: '△ 黄', info: '· 记录' };

function printReport(result, file) {
  const lines = [];
  lines.push(`plan-check: ${file}`);
  lines.push('');

  lines.push(
    result.state
      ? `  状态：${result.state.状态} · ${result.state.修订} · ${result.state.日期}`
      : '  状态：（缺，建议补 `> 状态：草稿|待审|已定稿 · rN · YYYY-MM-DD`）',
  );
  lines.push('');

  lines.push('  统计：');
  for (const [k, v] of Object.entries(result.stats)) {
    lines.push(`    ${k}: ${v === null ? '（未声明）' : v}`);
  }
  lines.push('');

  if (result.assets.items.length) {
    const byState = { ready: [], planned: [], blocked: [], unknown: [] };
    for (const item of result.assets.items) byState[item.state].push(item);
    lines.push('  素材：');
    for (const state of ['ready', 'planned', 'blocked', 'unknown']) {
      if (!byState[state].length) continue;
      const label = { ready: '已具备', planned: '待产出', blocked: '阻塞', unknown: '未核' }[state];
      lines.push(`    ${label} ${byState[state].length}：`);
      for (const item of byState[state]) {
        lines.push(`      ${item.label}${item.ref ? ` → ${item.ref}` : ''}（${item.reason}）`);
      }
    }
    lines.push('');
  }

  for (const level of ['red', 'yellow', 'info']) {
    const group = result.findings.filter((f) => f.level === level);
    if (!group.length) continue;
    lines.push(`  ${LEVEL_LABEL[level]} ${group.length} 条`);
    for (const f of group) lines.push(`    [${f.code}] ${f.message}`);
    lines.push('');
  }

  if (!result.findings.length) {
    lines.push('  ✓ 机械项全通过。');
    lines.push('');
  }

  lines.push(`  结论：${result.pass ? '机械项通过' : '不许进制作'}（红 ${result.red} / 黄 ${result.yellow} / 记录 ${result.info}）`);
  if (result.pass) {
    lines.push('');
    lines.push('  注意：机器只判覆盖、时长、文件与最小字段。');
    lines.push('        创意、叙事、声音、专业可执行性仍必须人审——pass 不代表方案对。');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const strict = args.includes('--strict');
  const target = args.find((a) => !a.startsWith('--'));

  if (!target) {
    die('用法：node tools/plan-check-cli.js <作品夹或 plan.md> [--json] [--strict]');
  }

  const file = resolvePlanPath(target);
  const text = readFileSync(file, 'utf8');
  const result = inspectPlan(text, { assetExists: makeAssetExists(dirname(file)) });

  const pass = result.pass && !(strict && result.yellow > 0);

  if (json) {
    process.stdout.write(`${JSON.stringify({ file, pass, ...result }, null, 2)}\n`);
  } else {
    process.stdout.write(printReport(result, file));
  }

  process.exit(pass ? 0 : 1);
}

main();
