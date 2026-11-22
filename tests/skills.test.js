import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * 知识层的结构回归。
 *
 * 这些不是"检查 Skill 写得好不好"（那要靠自然语言任务），而是把 V3 重排之后必须成立的
 * 几条机制事实钉住：能被发现、能被读到、不把作者机器的路径带进发布包。
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const skillsDir = join(root, 'skills');
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATALOG_LIMIT = 500;
const PRIVATE_PATH = /resources\/research|已确认资产|packages\/control-your-video|planning\/产品框架/;

async function loadSkills() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const skills = [];
  for (const dir of dirs) {
    const file = join(skillsDir, dir, 'SKILL.md');
    const text = await readFile(file, 'utf8');
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    skills.push({ dir, file, text, frontmatter: front?.[1] ?? '', body: text.slice(front?.[0]?.length ?? 0) });
  }
  return skills;
}

const field = (frontmatter, name) => {
  const match = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
};

test('every skill is discoverable: directory name, frontmatter name and description', async () => {
  const skills = await loadSkills();
  assert.ok(skills.length >= 5, '至少要有几条知识入口');

  for (const skill of skills) {
    assert.ok(skill.frontmatter, `${skill.dir}: 缺 frontmatter`);
    assert.equal(field(skill.frontmatter, 'name'), skill.dir, `${skill.dir}: name 必须与目录名逐字一致`);
    assert.match(skill.dir, KEBAB, `${skill.dir}: 目录名必须是 kebab-case`);

    const description = field(skill.frontmatter, 'description');
    assert.ok(description && description.length > 40, `${skill.dir}: description 太短，触发面不够`);
    assert.ok(description.length <= CATALOG_LIMIT, `${skill.dir}: description 超过目录上限 ${CATALOG_LIMIT}`);
    assert.match(description, /不[负责管]/, `${skill.dir}: description 里要有一句负向边界`);
  }
});

test('the catalog is small enough to stay a judgement list, not a directory dump', async () => {
  const skills = await loadSkills();
  const bodies = skills.map(skill => skill.body.length);
  assert.ok(skills.length <= 12, `入口数量 ${skills.length} 已经多到需要重新分组了`);
  assert.ok(bodies.every(size => size <= 12000), '单份正文过长会被压缩掐头去尾，该往 references 搬');
  // 两族入口必须自己就有专业内容，不是空壳路由。
  for (const name of ['video-craft', 'video-types']) {
    const skill = skills.find(entry => entry.dir === name);
    assert.ok(skill, `缺知识族入口 ${name}`);
    assert.ok(skill.body.length >= 3000, `${name} 的正文太短，像空壳`);
    assert.match(skill.body, /references\//, `${name} 必须给出按需参考索引`);
  }
});

test('every referenced file exists and every reference is reachable from its skill body', async () => {
  const skills = await loadSkills();
  for (const skill of skills) {
    const dir = join(skillsDir, skill.dir, 'references');
    const actual = await readdir(dir).catch(() => []);
    const cited = new Set([...skill.body.matchAll(/references\/([a-z0-9-]+\.md)/g)].map(match => match[1]));

    for (const file of cited) {
      assert.ok(actual.includes(file), `${skill.dir}: 正文引用了不存在的 ${file}`);
    }
    // 目录只认单层；模型看不到没被正文提到的文件，所以"孤儿参考"等于死文件。
    for (const file of actual) {
      assert.ok(cited.has(file), `${skill.dir}: ${file} 没有被正文提到，模型不会去读它`);
    }

    // 参考之间也会互相指路。指向不存在的文件，模型就会去找一个不存在的东西。
    // 跨入口的指路要写明是哪个入口（例如 `video-craft/references/x.md`），否则按本份解析。
    const known = new Set(skills.map(entry => entry.dir));
    for (const reference of actual) {
      const text = await readFile(join(dir, reference), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        for (const match of line.matchAll(/references\/([a-z0-9-]+\.md)/g)) {
          const prefix = line.slice(Math.max(0, match.index - 60), match.index);
          const owner = [...prefix.matchAll(/(?<![a-z0-9-])(video-[a-z0-9-]+)/g)].map(item => item[1]).pop();
          const ownerDir = owner && known.has(owner) ? owner : skill.dir;
          const pool = ownerDir === skill.dir
            ? actual
            : await readdir(join(skillsDir, ownerDir, 'references')).catch(() => []);
          assert.ok(pool.includes(match[1]),
            `${skill.dir}/${reference}: 指向不存在的 ${ownerDir}/references/${match[1]}`);
        }
      }
    }
  }
});

test('no shipped knowledge points at a skill entry that no longer exists', async () => {
  const skills = await loadSkills();
  const known = new Set(skills.map(skill => skill.dir));
  const retired = ['video-visual', 'video-motion', 'video-sound', 'video-edit', 'video-script',
    'video-code-visual', 'video-prompting'];
  const stale = [];
  for (const skill of skills) {
    const files = [['SKILL.md', skill.text]];
    const dir = join(skillsDir, skill.dir, 'references');
    for (const reference of await readdir(dir).catch(() => [])) {
      files.push([`references/${reference}`, await readFile(join(dir, reference), 'utf8')]);
    }
    for (const [name, text] of files) {
      for (const old of retired) {
        if (new RegExp(`\\b${old}\\b`).test(text)) stale.push(`${skill.dir}/${name} → ${old}`);
      }
      for (const [, cited] of text.matchAll(/(?<![a-z0-9-])(video-[a-z0-9-]+)/g)) {
        if (retired.includes(cited)) continue;
        assert.ok(known.has(cited), `${skill.dir}/${name}: 指向不存在的入口 ${cited}`);
      }
    }
  }
  assert.deepEqual(stale, [], '旧入口名已经合并，正文里不能再让模型去找它们');
});

test('every reference states when to read it', async () => {
  const skills = await loadSkills();
  for (const skill of skills) {
    const dir = join(skillsDir, skill.dir, 'references');
    for (const file of await readdir(dir).catch(() => [])) {
      const lines = (await readFile(join(dir, file), 'utf8')).split(/\r?\n/);
      assert.match(lines[0] ?? '', /^# \S/, `${skill.dir}/${file}: 第一行要是中文标题`);
      assert.match(lines[2] ?? '', /^> 何时读[:：]/, `${skill.dir}/${file}: 第三行要写"何时读、为了什么"`);
    }
  }
});

test('the shipped knowledge carries no machine-specific paths', async () => {
  const offenders = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = await readFile(full, 'utf8');
      if (PRIVATE_PATH.test(text)) offenders.push(relative(root, full));
    }
  };
  await walk(skillsDir);
  await walk(join(root, 'docs'));
  for (const top of ['README.md', 'README.zh.md']) {
    const text = await readFile(join(root, top), 'utf8');
    if (PRIVATE_PATH.test(text)) offenders.push(top);
  }
  assert.deepEqual(offenders, [], '本机私有路径只能留在 PROVENANCE.md');
});

test('the preset still mounts every skill from the package directory', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /customSkillDirs/, '预设要通过 customSkillDirs 挂载包内 skills/');
  assert.match(patch, /dsh-plugin-control-your-video\/package\.json/, '挂载路径要从包根解析，不能写死本机目录');
  assert.doesNotMatch(patch, /video-(visual|motion|sound|edit|script|code-visual|prompting)\b/,
    '预设与人设里不该再出现已合并的旧入口名');
});
