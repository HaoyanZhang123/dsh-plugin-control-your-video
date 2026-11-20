/**
 * plan-check：在开工之前机械检查一份 plan.md 够不够开工。
 *
 * 这个文件在 0.3.0 里是一套固定模板：状态行、十节、11 列镜头表、七类动源、
 * ≥30% 动源占比、素材末列必须全 ✅。它能把旧格式的片子挡住，但也会把
 * 一份真正写清楚了、只是换了表达方式的方案挡住——而用户确认过：
 * **所有镜头必须详细、专业、可执行，但不强制旧 11 列、七种动源或动作比例。**
 *
 * 所以这里改成"契约检查"而不是"模板检查"：
 *
 *   1. 章节怎么排、表格怎么列，由方案自己决定；只要机器能认出「逐镜明细」。
 *   2. 认两种表达：镜头表（列名可换）与逐镜小节（`### 镜 01` + `- 时长：…`）。
 *   3. 只判机器判得了的东西：覆盖（有没有缺镜）、时长（单镜与合计）、
 *      文件（引用的东西在不在）、最小字段（编号/时长/画面/路线至少写没写）。
 *   4. 素材分三态：**已有**（文件在）、**待产出**（路径或路线明确，允许还不存在）、
 *      **阻塞**（当成已有却找不到，或关键条件没定）。待产出不再机械阻断。
 *   5. 语义（创意、叙事、声音设计、专业可执行性）永远需要人/Agent 审，
 *      `review.required` 恒为 true，`pass` 只代表机械项通过。
 *
 * 兼容：`checkPlan(text)` 保留旧返回形状，`tools/evidence.js` 与 `index.js`
 * 不用改。新代码请用 `inspectPlan(text, { assetExists })`。
 */

/** 红 = 不许进制作；黄 = 可以进，但要在对话里说清；info = 只记录，不影响结论。 */
const SEVERITY = { RED: 'red', YELLOW: 'yellow', INFO: 'info' };

/** 七类动源。只用来「认得出来」和「报未知」，不再作门槛。 */
const MOTION_SOURCES = [
  '主体位移',
  '运镜',
  '切点',
  '转场',
  '元素动效',
  '整段特效',
  '静止',
];

/** 裸类别词：单独出现不算「路线指得到东西」。只报黄，不阻断。 */
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

/** 「这一项以后再做」的痕迹。它不再触发红灯，而是把素材判成「待产出」。 */
const PLANNED_MARKERS = [
  '拟制作',
  '拟生成',
  '待制作',
  '待生成',
  '待产出',
  '将生成',
  '后期生成',
  '计划生成',
  '计划制作',
  '待补',
  '补帧',
  '渲染',
  '生成',
  '制作',
  '产出',
];

/** 估算/待定的痕迹。0.4 起不再触发红灯，只作为审阅提示记进 `review.pendingMarkers`。 */
const PENDING_MARKERS = ['（估）', '(估)', 'TBD', '待定', '稍后补', '未定'];

/** 素材行的「已具备」写法。 */
const READY_MARKERS = ['✅', '☑', '已有', '已获得', '已取得', '已拿到', '已就绪', '就绪', '可读取', '已复制', 'ready'];

/** 素材行的「真缺」写法。 */
const BLOCKED_MARKERS = ['缺', '未定', '待寻', '待找', '待确认', '无来源', '找不到', '未获得', '未有', 'TBD', '待定', '稍后'];

/** 列名同义词。只认「这一列管什么」，不认固定列序与固定列数。 */
const ROLE_KEYS = {
  id: ['镜号', '镜头号', '编号', '序号', '镜次', 'shot', 'no.', 'id'],
  duration: ['时长', '秒数', '长度', 'length', 'duration', 'dur', 'sec', '秒'],
  content: ['画面', '内容', '描述', '动作', '视觉', '镜头表现', 'scene', 'visual', 'action', 'content'],
  camera: ['镜头', '运镜', '景别'],
  sound: ['声音', '音频', '配音', '音效', 'sound', 'audio'],
  text: ['屏上字', '字幕', '文字', '文案', 'on-screen'],
  route: ['做法', '制作', '路线', '实现', '技术', '工艺', '手段', 'how', 'approach', 'method'],
  asset: ['素材', '资产', '文件', '资源', '来源', '从哪来', '要什么', 'asset', 'source', 'file'],
  status: ['拿到', '状态', '就绪', '具备', '有无', 'status', 'ready'],
  purpose: ['目的', '作用', '为什么', '意图', 'purpose', 'why'],
  keep: ['保留', '不变', '约束', 'keep', 'constraint'],
  motion: ['动源', '运动来源', 'motion'],
  count: ['镜数', '镜头数', '数量', 'count'],
  stage: ['阶段', '段落', '段', 'stage', 'act'],
};

/** 时长里出现的「秒」单位写法。 */
const DURATION_CELL_RE = /^\s*(?:约|大约|approx\.?|~|≈|<|>)?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|秒)?\s*$/i;

/** 认文件引用：带常见扩展名的相对路径。 */
const FILE_EXT = 'mp4|mov|mxf|mkv|webm|avi|png|jpe?g|webp|gif|svg|tiff?|wav|mp3|flac|aac|m4a|ogg|html|css|js|mjs|py|blend|glb|gltf|ttf|otf|woff2?|srt|ass|vtt|json|psd|aep|prproj|fcpxml|edl';
const FILE_REF_RE = new RegExp(
  String.raw`[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5./\\-]*\.(?:${FILE_EXT})`,
  'gi',
);

const STATE_RE = /^>\s*状态[:：]\s*(草稿|待审|已定稿)\s*[·・]\s*(r[\w.-]+)\s*[·・]\s*(\d{4}-\d{2}-\d{2})/m;

// ── Markdown 基础解析 ───────────────────────────────────────────────────────

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

/** 从一段 markdown 里找出所有表格，返回 { headers, rows, startLine }。 */
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

/** 每个表头归到哪些角色。一个表头可能同时命中多个角色（如「镜头时长」）。 */
function tableRoles(headers) {
  return headers.map((raw) => {
    const h = (raw || '').toLowerCase();
    const roles = [];
    for (const [role, keys] of Object.entries(ROLE_KEYS)) {
      if (keys.some((k) => h.includes(k.toLowerCase()))) roles.push(role);
    }
    // 「镜头」既是 id 的近义词也是摄影机表现；没有「镜号」时优先当 id。
    return roles;
  });
}

function firstIndex(roles, role) {
  return roles.findIndex((r) => r.includes(role));
}

function cellAt(row, idx) {
  return idx >= 0 && idx < row.length ? (row[idx] || '').trim() : '';
}

// ── 值解析 ──────────────────────────────────────────────────────────────────

/**
 * 把镜号规范成整数：`1`、`01`、`S01`、`镜 1`、`第1镜`、`#1`、`Shot 3` → 对应整数。
 *
 * 只认这几种装饰写法。`1a`、`1-2`、`一` 一律返回 null，由调用方报黄灯——
 * 宁可不编号，也不能把 `1a` 悄悄当成第 1 镜去做片。
 */
function normalizeShotId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(?:镜号?|第|shot|s|#|no\.?)?\s*#?\s*0*(\d+)\s*(?:镜|号)?$/i);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** 从 `1 · 雨落在铁皮上` 这种带标题的镜号里取前面那截编号。 */
function leadingShotToken(label) {
  const m = String(label ?? '').match(/^\s*((?:镜号?|第|shot)?\s*#?\s*[A-Za-z]?\s*\d+)/i);
  return m ? m[1] : String(label ?? '');
}

/**
 * 单元格/小节标题 → 整数镜号。
 *
 * 先整串试；整串不是纯编号时，再只取分隔符（`·`、`—`、`：`、空格）前的那截。
 * `1-2`（区间）与 `1a`（变体）都返回 null——它们不是"一个镜头"的编号，
 * 强行取前面的数字会让两条不同的镜头在制作时撞号。
 */
function idFromLabel(label) {
  const direct = normalizeShotId(label);
  if (direct !== null) return direct;
  const s = String(label ?? '').trim();
  if (/^\s*\d+\s*[-–—~至到]\s*\d+\s*$/.test(s)) return null;
  if (!/[·—–\-|:：]\s*\S/.test(s) && !/\s{2,}\S/.test(s)) return null;
  return normalizeShotId(leadingShotToken(s));
}

/** 读一段时长文本，返回秒数；读不出返回 null。支持 `约 3 秒`、`3.5s`、`0:03`、`1 分 2 秒`。 */
function parseDurationSeconds(cell) {
  const s = String(cell ?? '')
    .trim()
    .replace(/\s+/g, '');
  if (!s) return null;
  const m1 = s.match(/(\d+):(\d+(?:\.\d+)?)/);
  if (m1) return Number(m1[1]) * 60 + Number(m1[2]);
  const m2 = s.match(/(?:(\d+(?:\.\d+)?)分)?(\d+(?:\.\d+)?)秒?/);
  if (m2 && (m2[1] || m2[2])) return Number(m2[1] || 0) * 60 + Number(m2[2]);
  const m3 = s.match(DURATION_CELL_RE);
  if (m3) return Number.parseFloat(m3[1]);
  const m4 = s.match(/(\d+(?:\.\d+)?)/);
  return m4 ? Number.parseFloat(m4[1]) : null;
}

/** 从一段文字里读「总时长」声明，返回秒数或 null。 */
function parseDeclaredTotal(text) {
  const patterns = [
    /\|\s*总时长\s*\|\s*([^|\n]+)\|/,
    /总时长\s*[:：]\s*([^\n]+)/,
    /全片\s*(?:约|大约)?\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\b/i,
    /片长\s*[:：]\s*([^\n]+)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const v = parseDurationSeconds(m[1]);
    if (v && v > 0) return v;
  }
  return null;
}

/** 从一段文字里读「总镜数」声明，返回整数或 null。 */
function parseDeclaredShotCount(text) {
  const patterns = [
    /\|\s*总镜数\s*\|\s*([^|\n]+)\|/,
    /总镜数\s*[:：]\s*([^\n]+)/,
    /全片\s*(\d+)\s*镜/,
    /共\s*(\d+)\s*镜/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const n = Number.parseInt((m[1].match(/\d+/) || [])[0] || '', 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/**
 * 判「路线」这一格是不是只写了裸类别词。
 * 只用来报黄：类别词不是错，但它指不到具体文件、工具或条目。
 */
function isBareCategory(cell) {
  const raw = (cell || '').trim();
  if (!raw) return true;
  const parens = raw.match(/[（(]([^）)]*)[）)]/g) || [];
  if (parens.some((p) => p.replace(/[（()）]/g, '').trim().length >= 3)) return false;
  if (FILE_REF_RE.test(raw)) {
    FILE_REF_RE.lastIndex = 0;
    return false;
  }
  FILE_REF_RE.lastIndex = 0;
  const parts = raw
    .replace(/[（(][^）)]*[）)]/g, '')
    .split(/[+＋、，,/／]|与|和/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every((p) => BARE_CATEGORY.includes(p));
}

// ── 逐镜解析：表格表达 ──────────────────────────────────────────────────────

/**
 * 找「逐镜明细表」。
 *
 * 只要求：有编号列，且有时长列或（画面列＋路线/声音列）。
 * 素材需求表因此不会被误认：它有「镜号」但没有时长、没有画面、没有路线。
 */
function findShotTables(tables) {
  const out = [];
  for (const table of tables) {
    const roles = tableRoles(table.headers);
    const idIdx = firstIndex(roles, 'id');
    if (idIdx < 0) continue;
    const durIdx = firstIndex(roles, 'duration');
    const contentIdx = firstIndex(roles, 'content');
    const routeIdx = firstIndex(roles, 'route');
    const soundIdx = firstIndex(roles, 'sound');
    const looksLikeShots = durIdx >= 0 || (contentIdx >= 0 && (routeIdx >= 0 || soundIdx >= 0));
    if (!looksLikeShots) continue;
    out.push({ ...table, roles });
  }
  return out;
}

function shotsFromTable(table) {
  const { rows, roles } = table;
  const idIdx = firstIndex(roles, 'id');
  const durIdx = firstIndex(roles, 'duration');
  const contentIdx = firstIndex(roles, 'content');
  const routeIdx = firstIndex(roles, 'route');
  const soundIdx = firstIndex(roles, 'sound');
  const textIdx = firstIndex(roles, 'text');
  const purposeIdx = firstIndex(roles, 'purpose');
  const motionIdx = firstIndex(roles, 'motion');
  const assetIdx = firstIndex(roles, 'asset');
  const statusIdx = firstIndex(roles, 'status');

  const shots = [];
  for (const row of rows) {
    if (!row.some((c) => c)) continue;
    const label = cellAt(row, idIdx);
    const contentParts = [contentIdx, firstIndex(roles, 'camera')]
      .filter((i) => i >= 0)
      .map((i) => cellAt(row, i))
      .filter(Boolean);
    shots.push({
      label,
      id: idFromLabel(label),
      durationText: cellAt(row, durIdx),
      duration: parseDurationSeconds(durIdx >= 0 ? row[durIdx] : ''),
      content: contentParts.join('；'),
      route: [cellAt(row, routeIdx), cellAt(row, assetIdx)].filter(Boolean).join('；'),
      routeText: cellAt(row, routeIdx),
      assetText: cellAt(row, assetIdx),
      sound: cellAt(row, soundIdx),
      text: cellAt(row, textIdx),
      purpose: cellAt(row, purposeIdx),
      motion: cellAt(row, motionIdx),
      status: cellAt(row, statusIdx),
      source: 'table',
    });
  }
  return shots;
}

// ── 逐镜解析：小节表达 ──────────────────────────────────────────────────────

const BLOCK_HEADING_RE = /^(#{1,6})\s*(?:镜|镜头|镜头号|shot)\s*[:：#]?\s*([A-Za-z]?\s*\d+[A-Za-z]?(?:-\d+)?[^\n]*)$/i;
const BLOCK_BOLD_RE = /^\s*(?:\d+[.)]\s*)?\*\*\s*(?:镜|镜头|shot)\s*([A-Za-z]?\s*\d+[A-Za-z]?)\s*[·：:]?\s*([^*]*)\*\*\s*$/i;
const FIELD_LINE_RE =
  /^\s*(?:[-*+]|\d+[.)])?\s*\**\s*(镜号|时长|画面|内容|描述|动作|镜头|运镜|景别|声音|音频|配音|音效|屏上字|字幕|文字|做法|制作|路线|实现|技术|工艺|手段|素材|资产|文件|来源|状态|目的|作用|动源|运动来源|保留|约束)\s*\**\s*[：:]\s*(.*)$/i;

const FIELD_TO_ROLE = [
  [/^(镜号)$/i, 'label'],
  [/^(时长)$/i, 'duration'],
  [/^(画面|内容|描述|动作|镜头|运镜|景别)$/i, 'content'],
  [/^(声音|音频|配音|音效)$/i, 'sound'],
  [/^(屏上字|字幕|文字)$/i, 'text'],
  [/^(做法|制作|路线|实现|技术|工艺|手段)$/i, 'route'],
  [/^(素材|资产|文件|来源)$/i, 'asset'],
  [/^(状态)$/i, 'status'],
  [/^(目的|作用)$/i, 'purpose'],
  [/^(动源|运动来源)$/i, 'motion'],
  [/^(保留|约束)$/i, 'keep'],
];

function fieldRole(name) {
  const hit = FIELD_TO_ROLE.find(([re]) => re.test(name.trim()));
  return hit ? hit[1] : null;
}

/**
 * 认 `### 镜 01 · 灯亮`（或加粗的 `**镜 1**`）后面跟一串 `- 字段：值` 的表达。
 * 只把写明「镜」的标题当逐镜小节，避免把「## 三、阶段」误认成镜头。
 */
function shotsFromBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(BLOCK_HEADING_RE);
    const bold = !heading && line.match(BLOCK_BOLD_RE);
    if (!heading && !bold) continue;
    const level = heading ? heading[1].length : 0;
    const label = heading ? heading[2] : bold[1];
    const fields = {};
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const nextHeading = lines[j].match(/^(#{1,6})\s/);
      if (heading && nextHeading && nextHeading[1].length <= level) break;
      if (!heading && BLOCK_HEADING_RE.test(lines[j])) break;
      if (!heading && /^\s*#{1,6}\s/.test(lines[j])) break;
      const fm = lines[j].match(FIELD_LINE_RE);
      if (fm) {
        const role = fieldRole(fm[1]);
        if (role && role !== 'label') {
          fields[role] = fields[role] ? `${fields[role]}；${fm[2].trim()}` : fm[2].trim();
        }
      }
    }
    blocks.push({ label: label.trim(), fields });
    i = j - 1;
  }
  return blocks.map(({ label, fields }) => ({
    label,
    id: idFromLabel(label),
    durationText: fields.duration || '',
    duration: parseDurationSeconds(fields.duration || ''),
    content: fields.content || '',
    route: [fields.route, fields.asset].filter(Boolean).join('；'),
    routeText: fields.route || '',
    assetText: fields.asset || '',
    sound: fields.sound || '',
    text: fields.text || '',
    purpose: fields.purpose || '',
    motion: fields.motion || '',
    status: fields.status || '',
    source: 'block',
  }));
}

/**
 * 合并两种表达：同一条镜头在表和块里都出现时，表里的值优先，空字段由块补。
 *
 * 只在「表行 ← 小节」这个方向合并；**表里自己重复的行不合并**，
 * 因为重复镜号是要报红的错误，不能被解析层悄悄吃掉。
 */
function mergeShotSources(fromTables, fromBlocks) {
  const merged = fromTables.slice();
  const byId = new Map();
  for (const shot of merged) {
    if (shot.id !== null && !byId.has(shot.id)) byId.set(shot.id, shot);
  }
  for (const shot of fromBlocks) {
    const target = shot.id !== null ? byId.get(shot.id) : null;
    if (!target) {
      merged.push(shot);
      if (shot.id !== null) byId.set(shot.id, shot);
      continue;
    }
    for (const key of ['content', 'route', 'sound', 'text', 'purpose', 'motion', 'status', 'assetText', 'routeText']) {
      if (!target[key] && shot[key]) target[key] = shot[key];
    }
    if (target.duration === null && shot.duration !== null) {
      target.duration = shot.duration;
      target.durationText = shot.durationText;
    }
  }
  return merged.map((s, i) => ({ ...s, order: i + 1 }));
}

// ── 素材解析 ────────────────────────────────────────────────────────────────

/** 一段文本里出现的文件引用。 */
function fileRefs(text) {
  const out = [];
  const s = String(text || '');
  FILE_REF_RE.lastIndex = 0;
  let m;
  while ((m = FILE_REF_RE.exec(s)) !== null) {
    out.push(m[0]);
  }
  FILE_REF_RE.lastIndex = 0;
  return out;
}

function hasAnyMarker(text, markers) {
  const s = String(text || '');
  return markers.some((m) => s.includes(m));
}

/**
 * 把素材行/镜头行判成 ready / planned / blocked / unknown。
 *
 * - ready：明确说已有，或 assetExists 说文件在。
 * - planned：写着「拟制作/待生成/渲染/制作…」，或有明确路线；文件不存在也不算阻塞。
 * - blocked：当成已有的文件找不到，或状态是「缺/待定」且没有路线。
 * - unknown：没给 assetExists，机器无法核文件；不影响结论。
 */
function classifyAsset({ statusText, context, ref, assetExists }) {
  const status = String(statusText || '');
  const ctx = `${status} ${context || ''}`;
  if (hasAnyMarker(status, READY_MARKERS)) {
    if (ref && typeof assetExists === 'function') {
      let exists = false;
      try {
        exists = Boolean(assetExists(ref));
      } catch {
        exists = false;
      }
      if (!exists) {
        return { state: 'blocked', reason: `计划里标为已有，但文件不存在：${ref}` };
      }
    }
    return { state: 'ready', reason: '计划里标为已具备' };
  }
  if (hasAnyMarker(ctx, PLANNED_MARKERS)) {
    return { state: 'planned', reason: '计划里写了待制作/生成路径' };
  }
  if (hasAnyMarker(status, BLOCKED_MARKERS)) {
    return { state: 'blocked', reason: '素材状态是「缺/待定」' };
  }
  if (ref && typeof assetExists === 'function') {
    let exists = false;
    try {
      exists = Boolean(assetExists(ref));
    } catch {
      exists = false;
    }
    return exists
      ? { state: 'ready', reason: '文件存在' }
      : { state: 'blocked', reason: `引用的文件不存在，也没有写制作路径：${ref}` };
  }
  return { state: 'unknown', reason: '没有提供文件核对能力，未核' };
}

function findMaterialTables(tables) {
  return tables.filter((t) => {
    const roles = tableRoles(t.headers);
    const hasAsset = firstIndex(roles, 'asset') >= 0;
    const hasStatus = firstIndex(roles, 'status') >= 0;
    const isShotTable = firstIndex(roles, 'id') >= 0 && firstIndex(roles, 'duration') >= 0;
    return (hasAsset || hasStatus) && !isShotTable;
  });
}

// ── 主检查 ──────────────────────────────────────────────────────────────────

function round1(n) {
  return Number(Number(n).toFixed(1));
}

/**
 * 检查一份 plan.md，返回结构化的机械结论。
 *
 * @param {string} text plan.md 正文
 * @param {{ assetExists?: (relPath: string) => boolean }} [options]
 *   `assetExists` 同步判断「相对路径的文件在不在」。不传就不碰文件系统，
 *   路径引用一律记 unknown，不阻断。
 */
export function inspectPlan(text, options = {}) {
  const src = String(text ?? '');
  const assetExists = typeof options.assetExists === 'function' ? options.assetExists : null;
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : 0.1;

  const findings = [];
  const add = (level, code, message, shotId) => {
    const finding = { level, code, message };
    if (shotId !== undefined && shotId !== null) finding.shotId = shotId;
    findings.push(finding);
  };

  const tables = findTables(src);
  const shotTables = findShotTables(tables);
  const blockShots = shotsFromBlocks(src);
  const tableShots = shotTables.flatMap((t) => shotsFromTable(t));
  const shots = mergeShotSources(tableShots, blockShots);

  // ① 状态行：认得出来就记；没有只报黄（表达自由，状态行仍是审批绑定的锚点）。
  const stateMatch = src.match(STATE_RE);
  if (!stateMatch) {
    add(SEVERITY.YELLOW, 'state-missing', '没有状态行。建议加 `> 状态：草稿|待审|已定稿 · rN · YYYY-MM-DD`，审批要绑版本。');
  }

  // ② 覆盖：至少有一条逐镜明细，且声明数与明细数对得上，编号不断档不重复。
  if (shots.length === 0) {
    add(
      SEVERITY.RED,
      'shots-missing',
      '没有认出任何逐镜明细。需要镜头表（有编号列与时长/画面列）或 `### 镜 1` + `- 时长：…` 的逐镜小节。',
    );
  }

  const declared = { totalSeconds: parseDeclaredTotal(src), shotCount: parseDeclaredShotCount(src) };

  // 阶段表里的「镜数」「时长」也当声明：防止「全片 42 镜」只写 2 行明细。
  const stageTables = tables.filter((t) => {
    const roles = tableRoles(t.headers);
    return firstIndex(roles, 'count') >= 0 && firstIndex(roles, 'id') < 0;
  });
  let stageShotSum = 0;
  let stageSeconds = 0;
  let stageRows = 0;
  for (const t of stageTables) {
    const roles = tableRoles(t.headers);
    const countIdx = firstIndex(roles, 'count');
    const durIdx = firstIndex(roles, 'duration');
    for (const row of t.rows) {
      if (!row.some((c) => c)) continue;
      stageRows += 1;
      const n = Number.parseInt((cellAt(row, countIdx).match(/\d+/) || [])[0] || '', 10);
      if (Number.isInteger(n)) stageShotSum += n;
      const d = parseDurationSeconds(cellAt(row, durIdx));
      if (d !== null) stageSeconds += d;
    }
  }

  const declaredShots = declared.shotCount ?? (stageShotSum > 0 ? stageShotSum : null);
  if (declaredShots && shots.length > 0) {
    if (declaredShots > shots.length) {
      add(
        SEVERITY.RED,
        'coverage-incomplete',
        `计划声明 ${declaredShots} 镜，但只有 ${shots.length} 镜有逐镜明细，缺 ${declaredShots - shots.length} 镜。`,
      );
    } else if (declaredShots < shots.length) {
      add(
        SEVERITY.YELLOW,
        'coverage-extra',
        `逐镜明细有 ${shots.length} 镜，声明的总镜数是 ${declaredShots}。以哪个为准要写清。`,
      );
    }
  }

  const seenIds = new Map();
  const missingIds = [];
  for (const shot of shots) {
    if (shot.id === null) {
      add(
        SEVERITY.YELLOW,
        'shot-id-noninteger',
        `第 ${shot.order} 条明细的镜号「${shot.label || '（空）'}」不是整数。下游按整数编号制作，建议改成 1、2、3… 或 S01 这种能唯一解析的写法。`,
        null,
      );
      continue;
    }
    if (seenIds.has(shot.id)) {
      add(SEVERITY.RED, 'shot-duplicate', `镜号 ${shot.id} 出现了不止一次。`, shot.id);
    } else {
      seenIds.set(shot.id, shot);
    }
  }
  if (seenIds.size > 0 && shots.every((s) => s.id !== null)) {
    const ids = [...seenIds.keys()].sort((a, b) => a - b);
    const max = ids[ids.length - 1];
    for (let i = 1; i <= max; i += 1) {
      if (!seenIds.has(i)) missingIds.push(i);
    }
    if (missingIds.length) {
      add(SEVERITY.RED, 'coverage-gap', `镜号断档：缺第 ${missingIds.join('、')} 镜。`);
    }
  }

  // ③ 每条明细的最小字段：编号、时长、画面/动作、制作路线。
  const soundDeclaredSomewhere =
    shots.some((s) => s.sound) ||
    /(^|\n)#{1,6}\s*[^\n]*声音/.test(src) ||
    /\|\s*声音\s*\|/.test(src);
  for (const shot of shots) {
    const who = shot.id !== null ? `第 ${shot.id} 镜` : `第 ${shot.order} 条明细`;
    if (shot.duration === null) {
      add(SEVERITY.RED, 'shot-duration-missing', `${who}没有可读的时长（要能读成秒，如「3 秒」「3.5s」「0:03」）。`, shot.id);
    } else if (!(shot.duration > 0)) {
      add(SEVERITY.RED, 'shot-duration-invalid', `${who}的时长是 ${shot.duration}，必须大于 0。`, shot.id);
    } else if (shot.duration > 120) {
      add(SEVERITY.YELLOW, 'shot-duration-long', `${who}有 ${shot.duration} 秒，单镜超过两分钟，确认不是把整段当一镜。`, shot.id);
    }
    if (!shot.content.trim()) {
      add(SEVERITY.RED, 'shot-content-empty', `${who}没有写画面/动作/内容，无法执行。`, shot.id);
    }
    const routeText = (shot.routeText || '').trim();
    if (!routeText.trim() && !shot.assetText.trim()) {
      add(SEVERITY.RED, 'shot-route-empty', `${who}没有写制作路线（做法/技术/素材来源），关键路径不明确。`, shot.id);
    } else if (!shot.assetText.trim() && isBareCategory(routeText) && !hasAnyMarker(routeText, PLANNED_MARKERS)) {
      add(
        SEVERITY.YELLOW,
        'shot-route-vague',
        `${who}的路线只写了类别词（如「档案片＋调色」）。类别词可以写，但要补具体文件、工具或条目。`,
        shot.id,
      );
    }
    if (!shot.purpose) {
      add(SEVERITY.YELLOW, 'shot-purpose-missing', `${who}没写这一镜的目的，验收时没有判据。`, shot.id);
    }
    if (shot.motion && !MOTION_SOURCES.some((s) => shot.motion.includes(s))) {
      add(SEVERITY.YELLOW, 'shot-motion-unknown', `${who}的动源「${shot.motion}」不在七类里（不影响开工，只是下游对不上）。`, shot.id);
    }
  }
  if (shots.length > 0 && !soundDeclaredSomewhere) {
    add(SEVERITY.YELLOW, 'plan-sound-undeclared', '全篇没有找到声音/音频相关字段或小节。无声也是一种选择，但要明写。');
  }

  // ④ 时长：单镜合计对声明的总时长；有阶段表时再交叉一次。
  const shotTotal = shots.reduce((sum, s) => sum + (s.duration && s.duration > 0 ? s.duration : 0), 0);
  const declaredTotal = declared.totalSeconds;
  let durationDiff = null;
  if (declaredTotal && shotTotal > 0) {
    durationDiff = Math.abs(declaredTotal - shotTotal) / declaredTotal;
    if (durationDiff > tolerance) {
      add(
        SEVERITY.RED,
        'duration-mismatch',
        `镜头合计 ${round1(shotTotal)}s，声明总时长 ${round1(declaredTotal)}s，差 ${(durationDiff * 100).toFixed(1)}%，超过 ±${Math.round(tolerance * 100)}%。`,
      );
    }
  }
  if (stageSeconds > 0 && shotTotal > 0) {
    const d = Math.abs(stageSeconds - shotTotal) / stageSeconds;
    if (d > tolerance) {
      add(
        SEVERITY.RED,
        'duration-stage-mismatch',
        `阶段表合计 ${round1(stageSeconds)}s，镜头合计 ${round1(shotTotal)}s，差 ${(d * 100).toFixed(1)}%。`,
      );
    }
  }
  if (!declaredTotal) {
    add(SEVERITY.INFO, 'duration-total-undeclared', '没有读到全片总时长，无法核对镜头合计；建议在总览里写明。');
  }

  // ⑤ 素材三态：已有 / 待产出 / 阻塞。
  const assetItems = [];
  const materialTables = findMaterialTables(tables);
  let materialRows = 0;

  for (const table of materialTables) {
    const roles = tableRoles(table.headers);
    const idIdx = firstIndex(roles, 'id');
    const assetIdx = firstIndex(roles, 'asset');
    const statusIdx = firstIndex(roles, 'status');
    for (const row of table.rows) {
      if (!row.some((c) => c)) continue;
      materialRows += 1;
      const want = cellAt(row, assetIdx);
      const statusText = cellAt(row, statusIdx);
      const context = row.filter((c) => c).join(' ');
      // 文件引用可能写在「要什么」「从哪来」「许可」任何一列，整行一起扫。
      const refs = [...new Set(fileRefs(context))];
      const label = `素材行「${want || cellAt(row, idIdx) || materialRows}」`;
      if (refs.length === 0) {
        const classified = classifyAsset({ statusText, context, ref: null, assetExists });
        if (classified.state === 'ready') {
          add(SEVERITY.YELLOW, 'asset-ready-without-path', `${label}标为已具备，但没写具体文件或条目，核不了。`);
        } else if (classified.state === 'blocked') {
          add(SEVERITY.RED, 'asset-blocked', `${label}${classified.reason}，也没写从哪来。`);
        } else if (classified.state === 'planned') {
          if (!want.trim()) add(SEVERITY.RED, 'asset-no-route', `${label}既没有素材描述也没有制作路线。`);
        }
        assetItems.push({ label, ref: null, want, ...classified });
        continue;
      }
      for (const ref of refs) {
        const classified = classifyAsset({ statusText, context, ref, assetExists });
        assetItems.push({ label, ref, want, ...classified });
        if (classified.state === 'blocked') {
          add(SEVERITY.RED, 'asset-blocked', `${label}：${classified.reason}。要么补上文件，要么写清待制作路径。`);
        } else if (classified.state === 'unknown') {
          add(SEVERITY.INFO, 'asset-unverified', `${label}引用 ${ref}，没有文件核对能力，未核存在性。`);
        }
      }
    }
  }

  // 镜头行里出现的文件引用也要核：当成已有却找不到，就是虚构资源。
  for (const shot of shots) {
    const context = [shot.routeText, shot.assetText, shot.route].filter(Boolean).join(' ');
    const refs = [...new Set(fileRefs(context))];
    for (const ref of refs) {
      if (assetItems.some((a) => a.ref === ref && a.state !== 'unknown')) continue;
      const classified = classifyAsset({ statusText: shot.status, context, ref, assetExists });
      assetItems.push({ label: shot.id !== null ? `第 ${shot.id} 镜` : `第 ${shot.order} 条明细`, ref, want: ref, ...classified });
      if (classified.state === 'blocked') {
        add(
          SEVERITY.RED,
          'asset-missing',
          `第 ${shot.id !== null ? `${shot.id} 镜` : `${shot.order} 条明细`}引用的 ${ref} ${classified.reason}。`,
          shot.id,
        );
      } else if (classified.state === 'unknown') {
        add(SEVERITY.INFO, 'asset-unverified', `第 ${shot.id !== null ? `${shot.id} 镜` : `${shot.order} 条明细`}引用 ${ref}，未核存在性。`, shot.id);
      }
    }
  }

  const assetCount = (state) => assetItems.filter((a) => a.state === state).length;

  const red = findings.filter((f) => f.level === SEVERITY.RED).length;
  const yellow = findings.filter((f) => f.level === SEVERITY.YELLOW).length;
  const info = findings.filter((f) => f.level === SEVERITY.INFO).length;

  const stats = {
    镜数: shots.length,
    镜头合计秒: round1(shotTotal),
    阶段数: stageRows,
    阶段合计秒: round1(stageSeconds),
    声明总时长秒: declaredTotal === null ? null : round1(declaredTotal),
    时长差百分比: durationDiff === null ? null : Number((durationDiff * 100).toFixed(1)),
    已具备素材: assetCount('ready'),
    待产出素材: assetCount('planned'),
    阻塞素材: assetCount('blocked'),
    未核素材: assetCount('unknown'),
    素材行数: materialRows,
    素材未到: assetCount('blocked'),
    缺时长镜数: shots.filter((s) => s.duration === null).length,
    空白路线镜数: shots.filter((s) => !(s.routeText.trim() || s.assetText.trim())).length,
    裸类别词镜数: shots.filter((s) => s.routeText.trim() && isBareCategory(s.routeText) && !hasAnyMarker(s.routeText, PLANNED_MARKERS))
      .length,
    缺目的镜数: shots.filter((s) => !s.purpose).length,
    主体位移或运镜镜数: shots.filter((s) => s.motion && (s.motion.includes('主体位移') || s.motion.includes('运镜'))).length,
    缺动源镜数: shots.filter((s) => !s.motion).length,
  };

  return {
    pass: red === 0,
    findings,
    shots: shots.map((s) => ({
      id: s.id,
      label: s.label,
      order: s.order,
      duration: s.duration,
      durationSec: s.duration,
      content: s.content,
      route: s.route,
      sound: s.sound,
      motion: s.motion,
      source: s.source,
    })),
    stats,
    state: stateMatch ? { 状态: stateMatch[1], 修订: stateMatch[2], 日期: stateMatch[3] } : null,
    declared: { totalSeconds: declaredTotal, shotCount: declaredShots },
    coverage: {
      shots: shots.length,
      declared: declaredShots,
      missingIds,
      nonIntegerIds: shots.filter((s) => s.id === null).length,
    },
    assets: {
      ready: assetCount('ready'),
      planned: assetCount('planned'),
      blocked: assetCount('blocked'),
      unknown: assetCount('unknown'),
      items: assetItems,
    },
    review: {
      required: true,
      note: '机器只判覆盖、时长、文件与最小字段。创意、叙事、声音设计、专业可执行性属于语义判断，必须由人或 Agent 审阅；pass=true 不代表方案一定对。',
      // 缺时长/缺画面/缺路线的镜头已经各自报了红；这里只是给审阅一个先看哪几条的入口。
      unresolvedShots: shots
        .filter((s) => s.duration === null || !s.content.trim() || !(s.routeText.trim() || s.assetText.trim()))
        .map((s) => s.id ?? s.label),
      // 旧版会因为出现「（估）/TBD/待定」直接报红；现在只记录，交给人判断是否真的没想清。
      pendingMarkers: PENDING_MARKERS.filter((m) => src.includes(m)),
    },
    red,
    yellow,
    info,
  };
}

/**
 * 旧接口：保留 0.3.0 的返回形状，供 `tools/evidence.js`、`index.js`
 * 与已有命令行继续使用。新代码请直接用 `inspectPlan`。
 */
export function checkPlan(text, options = {}) {
  const result = inspectPlan(text, options);
  return {
    state: result.state,
    stats: result.stats,
    findings: result.findings,
    red: result.red,
    yellow: result.yellow,
    pass: result.pass,
    // 新信息的直通，旧调用方不用也读得到。
    shots: result.shots,
    assets: result.assets,
    declared: result.declared,
    coverage: result.coverage,
    review: result.review,
  };
}

/**
 * 给调用方拼一个文件核对器：相对 plan.md 所在目录判断文件在不在。
 *
 * `plan-check.js` 本身不 import `node:fs`——保持纯函数、能在任何环境（含测试）
 * 里跑。需要核真实文件的地方（CLI、evidence、FFmpeg 适配器）自己把
 * `existsSync` 与 `resolve` 注进来。
 */
export function createFsAssetExists(baseDir, { existsSync, resolve: resolvePath }) {
  if (typeof existsSync !== 'function' || typeof resolvePath !== 'function') {
    throw new Error('createFsAssetExists 需要注入 { existsSync, resolve }，保持本模块本身不碰文件系统。');
  }
  return (relPath) => {
    try {
      return Boolean(existsSync(resolvePath(baseDir, relPath)));
    } catch {
      return false;
    }
  };
}

export { SEVERITY, MOTION_SOURCES };
