/**
 * plan-check：在开工之前机械检查一份 plan.md 合不合格。
 *
 * 只做一件事：把 `docs/编写规范.md` §1.6 里写死的硬规则，变成能跑的判断。
 * 为什么需要它：只写规范靠自觉，已经证明拦不住（2026-11-19 两支真实片的
 * plan 覆盖率只有 10%、做法列全是类别词、没有动源字段，全程没有任何一道门）。
 *
 * 不判审美、不判内容好不好。只判"方案是不是完整到可以开工"。
 */

/** 红 = 不许进制作；黄 = 可以进但要在对话里说清。 */
const SEVERITY = { RED: 'red', YELLOW: 'yellow' };

/** 六种动源 + 静止。与 docs/编写规范.md §1.1 第 11 字段一致。 */
const MOTION_SOURCES = [
  '主体位移',
  '运镜',
  '切点',
  '转场',
  '元素动效',
  '整段特效',
  '静止',
];

/** 裸类别词：只写这些不算"做法指得到东西"。 */
const BARE_CATEGORY = [
  '档案片',
  '素材',
  '实拍',
  '生成',
  '调色',
  '剪辑',
  '混合',
  '代码',
  '稍后',
  '待定',
];

/** 估算/待定的痕迹。 */
const PENDING_MARKERS = ['（估）', '(估)', 'TBD', '待定', '稍后补', '未定'];

/** §1.6 要求的十节，按出现顺序认。 */
const REQUIRED_SECTIONS = [
  { key: 'state', label: '状态行', test: (t) => /^>\s*状态[:：]/m.test(t) },
  { key: 'overview', label: '一、总述', test: (t) => /^##{1,3}\s*一[、.]\s*总述/m.test(t) },
  { key: 'glance', label: '二、总览', test: (t) => /^##{1,3}\s*二[、.]\s*总览/m.test(t) },
  { key: 'stages', label: '三、阶段', test: (t) => /^##{1,3}\s*三[、.]\s*阶段/m.test(t) },
  { key: 'shots', label: '十、镜头表', test: (t) => /^##{1,3}\s*十[、.]\s*镜头表|^##{1,3}\s*镜头$/m.test(t) },
  { key: 'materials', label: '九、素材需求表', test: (t) => /^##{1,3}\s*九[、.]\s*素材需求/m.test(t) },
];

/** 阶段表八列的表头关键字。 */
const STAGE_COLUMNS = ['阶段', '起止', '时长', '主题', '风格', '视觉变化', '镜数', '做什么'];

const STATE_RE = /^>\s*状态[:：]\s*(草稿|待审|已定稿)\s*·\s*(r[\w-]+)\s*·\s*(\d{4}-\d{2}-\d{2})/m;

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isTableSep(line) {
  return /^\|[\s:|-]+\|$/.test(line.trim()) && line.includes('-');
}

/** 从一段 markdown 里找出所有表格，返回 { headers, rows }。 */
function findTables(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitRow(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        rows.push(splitRow(lines[j]));
        j += 1;
      }
      tables.push({ headers, rows, startLine: i + 1 });
      i = j;
    } else {
      i += 1;
    }
  }
  return tables;
}

/**
 * 取某一节的正文。
 * 只在这一节出现的层级上停：`##` 开头的小节遇到下一个 `##` 才结束，
 * 不会在 `###` 子标题上被截断——真实的 plan 会把镜头表放在 `###` 下面。
 */
function sectionText(text, re) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let level = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (start === -1) {
      if (re.test(lines[i])) {
        start = i;
        level = m ? m[1].length : 0;
      }
      continue;
    }
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return start === -1 ? '' : lines.slice(start + 1, end).join('\n');
}

/**
 * 判「做法」这一格是不是只写了裸类别词。
 *
 * "档案片＋调色" → 拆成 ["档案片","调色"]，两个都在黑名单里 → 裸类别词，算不合格。
 * "档案片（Prelinger: xxx）" → 全角括号里有具体条目 → 合格。
 * "实拍素材 led-close.mp4 ＋冷蓝微调" → 有文件名，不是裸词 → 合格。
 */
function isBareCategory(cell) {
  const raw = (cell || '').trim();
  if (!raw) return true;
  // 带括号注释的，先把括号里的内容拿出来看：括号里有具体东西就不算裸词。
  const parens = raw.match(/[（(]([^）)]*)[）)]/g) || [];
  if (parens.some((p) => p.replace(/[（()）]/g, '').trim().length >= 3)) return false;
  // 去掉括号后按分隔符拆成若干词，逐个比对。
  const parts = raw
    .replace(/[（(][^）)]*[）)]/g, '')
    .split(/[+＋、，,/／]|与|和/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every((p) => BARE_CATEGORY.includes(p));
}
function readSeconds(cell) {
  if (!cell) return null;
  const m = cell.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number.parseFloat(m[1]);
}

/**
 * 主检查。返回 { findings: [{level, code, message}], stats }。
 * 纯函数：不读文件、不写文件，方便单测。
 */
export function checkPlan(text) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });

  // ① 状态行
  const stateMatch = text.match(STATE_RE);
  if (!stateMatch) {
    add(SEVERITY.RED, 'state-missing', '缺状态行。要写成 `> 状态：草稿|待审|已定稿 · rN · YYYY-MM-DD`。');
  }

  // ② §1.6 的十节里必须出现的几节
  for (const sec of REQUIRED_SECTIONS) {
    if (sec.key === 'state') continue;
    if (!sec.test(text)) {
      add(SEVERITY.RED, `section-missing:${sec.key}`, `缺「${sec.label}」一节（见 docs/编写规范.md §1.6）。`);
    }
  }

  // ③ 总述长度
  const overview = sectionText(text, /^##{1,3}\s*一[、.]\s*总述/);
  if (overview) {
    const chars = overview.replace(/\s/g, '').length;
    if (chars === 0) {
      add(SEVERITY.RED, 'overview-empty', '「总述」这一节是空的。');
    } else if (chars > 1000) {
      add(SEVERITY.YELLOW, 'overview-long', `「总述」${chars} 字，超过 1000 字上限。`);
    }
  }

  // ④ 阶段表：八列 + 时长合计
  const stagesText = sectionText(text, /^##{1,3}\s*三[、.]\s*阶段/);
  let stageTotal = 0;
  let stageRows = 0;
  if (stagesText) {
    const tables = findTables(stagesText);
    const stageTable = tables.find((t) => t.headers.some((h) => h.includes('阶段')));
    if (!stageTable) {
      add(SEVERITY.RED, 'stages-no-table', '「三、阶段」里没有找到阶段表。');
    } else {
      const missing = STAGE_COLUMNS.filter((c) => !stageTable.headers.some((h) => h.includes(c)));
      if (missing.length) {
        add(SEVERITY.RED, 'stages-columns', `阶段表缺列：${missing.join('、')}。`);
      }
      stageRows = stageTable.rows.filter((r) => r.some((c) => c)).length;
      const durIdx = stageTable.headers.findIndex((h) => h.includes('时长'));
      for (const row of stageTable.rows) {
        const v = readSeconds(row[durIdx]);
        if (v !== null) stageTotal += v;
      }
      if (stageRows === 0) add(SEVERITY.RED, 'stages-empty', '阶段表没有数据行。');
    }
  }

  // ⑤ 镜头表：覆盖率、动源、做法、动源契约
  // 认两个位置：§1.6 的「十、镜头表」，或旧结构里任意一个「镜头」小节。
  let shotsText = sectionText(text, /^##{1,3}\s*十[、.]\s*镜头表|^##{1,3}\s*镜头表/);
  if (!shotsText) {
    // 退路：全文找第一张带「镜号」的表，用它上一级标题后的内容
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i]) && lines.slice(i, i + 4).join('\n').includes('镜号')) {
        shotsText = sectionText(text, new RegExp(`^${lines[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
        break;
      }
    }
  }
  let shotCount = 0;
  let shotTotal = 0;
  let missingMotion = 0;
  let bareHowTo = 0;
  let bigMotion = 0;
  if (shotsText) {
    const tables = findTables(shotsText);
    const shotTable = tables.find((t) => t.headers.some((h) => h.includes('镜号')));
    if (!shotTable) {
      add(SEVERITY.RED, 'shots-no-table', '「镜头表」里没有找到以「镜号」开头的表。');
    } else {
      const hIdx = shotTable.headers.findIndex((h) => h.includes('镜号'));
      const durIdx = shotTable.headers.findIndex((h) => h.includes('时长'));
      const howIdx = shotTable.headers.findIndex((h) => h.includes('做法'));
      const srcIdx = shotTable.headers.findIndex((h) => h.includes('动源'));
      if (durIdx < 0) add(SEVERITY.RED, 'shots-no-duration', '镜头表缺「时长」列。');
      if (howIdx < 0) add(SEVERITY.RED, 'shots-no-howto', '镜头表缺「做法」列。');
      if (srcIdx < 0) {
        add(SEVERITY.RED, 'shots-no-motion', '镜头表缺「动源」列（§1.1 第 11 字段，必填）。');
      }
      for (const row of shotTable.rows) {
        if (!row.some((c) => c)) continue;
        shotCount += 1;
        if (durIdx >= 0) {
          const v = readSeconds(row[durIdx]);
          if (v !== null) shotTotal += v;
        }
        if (srcIdx >= 0) {
          const cell = (row[srcIdx] || '').trim();
          if (!cell) {
            missingMotion += 1;
          } else if (!MOTION_SOURCES.some((s) => cell.includes(s))) {
            add(SEVERITY.YELLOW, 'shots-motion-unknown', `第 ${row[hIdx] || '?'} 镜的动源「${cell}」不在七类里。`);
          } else if (cell.includes('主体位移') || cell.includes('运镜')) {
            bigMotion += 1;
          }
        }
        if (howIdx >= 0) {
          const cell = (row[howIdx] || '').trim();
          if (!cell) {
            add(SEVERITY.RED, 'shots-howto-empty', `第 ${row[hIdx] || '?'} 镜的「做法」是空的。`);
          } else if (isBareCategory(cell)) {
            bareHowTo += 1;
          }
        }
      }
      if (shotCount > 0 && missingMotion > 0) {
        add(SEVERITY.RED, 'shots-motion-missing', `${missingMotion} 镜没写动源。`);
      }
      if (bareHowTo > 0) {
        add(
          SEVERITY.RED,
          'shots-howto-bare',
          `${bareHowTo} 镜的「做法」只写了类别词（如"档案片＋调色"）。类别词可以写，但必须附具体条目名或工具名。`,
        );
      }
      // 动源契约：主体位移+运镜占比
      if (shotCount >= 5) {
        const ratio = bigMotion / shotCount;
        if (ratio < 0.3) {
          add(
            SEVERITY.YELLOW,
            'shots-motion-contract',
            `主体位移/运镜只占 ${(ratio * 100).toFixed(1)}%（${bigMotion}/${shotCount}）。爽片类片型契约要求 ≥30%，非爽片可忽略本条。`,
          );
        }
      }
    }
  }

  // ⑥ 时长合计对账
  if (stageTotal > 0 && shotTotal > 0) {
    const diff = Math.abs(stageTotal - shotTotal) / stageTotal;
    if (diff > 0.1) {
      add(
        SEVERITY.RED,
        'duration-mismatch',
        `镜头表合计 ${shotTotal.toFixed(1)}s，阶段表合计 ${stageTotal.toFixed(1)}s，差 ${(diff * 100).toFixed(1)}%，超过 ±10%。`,
      );
    }
  }

  // ⑦ 估算/待定痕迹
  for (const marker of PENDING_MARKERS) {
    if (text.includes(marker)) {
      add(SEVERITY.RED, 'pending-marker', `检出「${marker}」。方案里不留待定，定不了说明还没想清楚。`);
    }
  }

  // ⑧ 素材需求表末列
  const matText = sectionText(text, /^##{1,3}\s*九[、.]\s*素材需求/);
  let matMissing = 0;
  let matRows = 0;
  if (matText) {
    const tables = findTables(matText);
    const matTable = tables.find((t) => t.headers.some((h) => h.includes('镜号')));
    if (!matTable) {
      add(SEVERITY.RED, 'materials-no-table', '「九、素材需求表」里没有找到表。');
    } else {
      const gotIdx = matTable.headers.findIndex((h) => h.includes('拿到'));
      if (gotIdx < 0) {
        add(SEVERITY.RED, 'materials-no-status', '素材需求表缺「拿到没有」列。');
      } else {
        for (const row of matTable.rows) {
          if (!row.some((c) => c)) continue;
          matRows += 1;
          if (!(row[gotIdx] || '').includes('✅')) matMissing += 1;
        }
        if (matMissing > 0) {
          add(SEVERITY.RED, 'materials-not-ready', `${matMissing} 条素材还没拿到（末列不是 ✅）。`);
        }
      }
    }
  }

  const red = findings.filter((f) => f.level === SEVERITY.RED).length;
  const yellow = findings.filter((f) => f.level === SEVERITY.YELLOW).length;

  return {
    state: stateMatch ? { 状态: stateMatch[1], 修订: stateMatch[2], 日期: stateMatch[3] } : null,
    stats: {
      阶段数: stageRows,
      镜数: shotCount,
      阶段合计秒: Number(stageTotal.toFixed(1)),
      镜头合计秒: Number(shotTotal.toFixed(1)),
      主体位移或运镜镜数: bigMotion,
      缺动源镜数: missingMotion,
      裸类别词镜数: bareHowTo,
      素材行数: matRows,
      素材未到: matMissing,
    },
    findings,
    red,
    yellow,
    pass: red === 0,
  };
}
