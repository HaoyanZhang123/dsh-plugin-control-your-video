#!/usr/bin/env node
/**
 * plan-check 命令行入口：读一份 plan.md，跑检查，输出报告。
 *
 * 用法：
 *   node tools/plan-check.js <作品夹或 plan.md> [--json]
 *
 * 退出码：有红 = 1，否则 0。红灯非零退出，所以它能当门禁。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkPlan } from './plan-check.js';

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

function printReport(result, file) {
  const lines = [];
  lines.push(`plan-check: ${file}`);
  lines.push('');

  if (result.state) {
    lines.push(`  状态：${result.state.状态} · ${result.state.修订} · ${result.state.日期}`);
  } else {
    lines.push('  状态：（缺）');
  }
  lines.push('');

  lines.push('  统计：');
  for (const [k, v] of Object.entries(result.stats)) {
    lines.push(`    ${k}: ${v}`);
  }
  lines.push('');

  const reds = result.findings.filter((f) => f.level === 'red');
  const yellows = result.findings.filter((f) => f.level === 'yellow');

  if (reds.length) {
    lines.push(`  ✗ 红 ${reds.length} 条（不许进制作）`);
    for (const f of reds) lines.push(`    [${f.code}] ${f.message}`);
    lines.push('');
  }
  if (yellows.length) {
    lines.push(`  △ 黄 ${yellows.length} 条（可以进，但要说清）`);
    for (const f of yellows) lines.push(`    [${f.code}] ${f.message}`);
    lines.push('');
  }
  if (!reds.length && !yellows.length) {
    lines.push('  ✓ 全项通过。');
    lines.push('');
  }

  lines.push(`  结论：${result.pass ? '可以进制作' : '不许进制作'}`);
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));

  if (!target) {
    die('用法：node tools/plan-check.js <作品夹或 plan.md> [--json]');
  }

  const file = resolvePlanPath(target);
  const text = readFileSync(file, 'utf8');
  const result = checkPlan(text);

  if (json) {
    process.stdout.write(`${JSON.stringify({ file, ...result }, null, 2)}\n`);
  } else {
    process.stdout.write(printReport(result, file));
  }

  process.exit(result.pass ? 0 : 1);
}

main();
