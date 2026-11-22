// 用**已安装 DSH**的真实技能注册表与文件系统 provider，实证本包的技能能不能被发现。
//
// 为什么单独一个脚本：`preset-check.cjs` 只检查 skill-filesystem 模块能解析——它无法复现
// 预设里 `customSkillDirs` 的加载基址，因此"技能到底会不会出现在目录里"这一环一直是推断。
// 这里绕开基址问题，直接把已安装的 skills/ 当成 customSkillDirs 挂上去，问注册表要结果。
//
// 用法（Windows Desktop，必须用宿主的 Node 运行，因为包在 app.asar 里）：
//   set ELECTRON_RUN_AS_NODE=1
//   "<安装目录>\DeepSeek Harness.exe" tests\skill-discovery.cjs <DSH 包目录> [skills 目录]
//
// 默认 skills 目录是包内 `skills/`。通过条件：
//   - 发现的技能集合与磁盘上含 SKILL.md 的目录**完全一致**
//   - 每个技能的 name 与目录名一致、描述非空且不超过 500 字符
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const CATALOG_LIMIT = 500;

function fail(message) {
  console.error(`skill discovery: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const installed = process.argv[2] || process.env.DSH_INSTALL_DIR;
  if (!installed) throw new Error('Pass the installed DSH package directory as the first argument.');
  const skillsDir = path.resolve(process.argv[3] || path.join(__dirname, '..', 'skills'));

  const dsh = createRequire(path.join(installed, 'package.json'));
  const { Context } = dsh('@deepseek-ai/cordis');
  const registry = dsh('@deepseek-ai/dsh-skill');
  const SkillRegistry = registry.SkillRegistry ?? registry.default;
  const filesystem = await import(pathToFileURL(dsh.resolve('@deepseek-ai/dsh-skill-filesystem')).href);
  const plugin = filesystem.apply ? filesystem : filesystem.default;

  const onDisk = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();

  const ctx = new Context();
  await ctx.plugin(SkillRegistry);
  await ctx.plugin(plugin, {
    includeDefaultRoots: false,
    customSkillDirs: [skillsDir],
    watch: false,
    dshHome: process.env.DSH_HOME,
  });

  const skills = await ctx.skills.list();
  const found = skills.map(skill => skill.name).sort();

  console.log(`skill discovery: ${skillsDir}`);
  for (const skill of skills) {
    const description = skill.description ?? '';
    console.log(`  - ${skill.name}  (${description.length} chars)`);
  }

  const missing = onDisk.filter(name => !found.includes(name));
  const extra = found.filter(name => !onDisk.includes(name));
  if (missing.length) fail(`not discovered: ${missing.join(', ')}`);
  if (extra.length) fail(`discovered but not on disk: ${extra.join(', ')}`);
  for (const skill of skills) {
    if (!skill.description?.trim()) fail(`${skill.name}: empty description`);
    else if (skill.description.length > CATALOG_LIMIT) fail(`${skill.name}: description over ${CATALOG_LIMIT}`);
  }

  await ctx.fiber?.dispose?.();
  if (!process.exitCode) console.log(`skill discovery: ${skills.length} of ${onDisk.length} skills discovered and well-formed`);
}

main().catch(error => {
  console.error('skill discovery: FAILED');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
