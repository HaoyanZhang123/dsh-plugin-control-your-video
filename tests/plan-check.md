# plan-check 契约与测试用例

## 这份文档管什么

`tools/plan-check.js` 把"方案能不能开工"里**机器判得了的部分**变成能跑的判断。
它不判创意好不好、叙事对不对、声音设计专不专业——那些永远要人/Agent 审。

0.3.0 的旧版是一套固定模板：状态行、固定十节、11 列镜头表、七类动源、
主体位移/运镜占比 ≥30%、素材末列必须全 ✅。它挡得住旧格式的坏方案，
但也会挡住一份写清楚了、只是换了表达方式的方案。用户确认过：
**所有镜头必须详细、专业、可执行，但不强制旧 11 列、七种动源或动作比例。**
所以 0.4 起改成契约检查。

## 怎么跑

```bash
node --test tests/plan-contract.test.js                    # 契约测试（25 条）
node tools/plan-check-cli.js <作品夹或 plan.md>             # 人读的报告
node tools/plan-check-cli.js <路径> --json                  # 机器读
node tools/plan-check-cli.js <路径> --strict                # 黄灯也算失败
node tools/evidence.js plan-check --dir <作品夹>            # 走统一入口
```

退出码：**有红 = 1，否则 0**。黄灯与 info 不改退出码，因为
"可以进，但要说清"不该由脚本一票否决。

## 接口

```js
import { inspectPlan, checkPlan } from './tools/plan-check.js';

const r = inspectPlan(text, { assetExists: (rel) => fs.existsSync(path.resolve(base, rel)) });
```

- `inspectPlan(text, { assetExists?, tolerance? })` — **同步纯函数**。
  不传 `assetExists` 就完全不碰文件系统，路径引用一律记 `unknown`，不阻断。
  函数抛错会被吞掉，按"文件不在"处理，不会炸整个检查。
- `checkPlan(text, options)` — **保留的旧接口**，返回旧形状
  `{ state, stats, findings, red, yellow, pass }`，并顺带透出新字段。
  `tools/evidence.js` 与 `index.js` 走的就是它，不用改。

返回：

```js
{
  pass,                     // 机械项通过；不代表方案对
  findings: [{ level: 'red'|'yellow'|'info', code, message, shotId? }],
  shots: [{ id, label, order, duration, durationSec, content, route, sound, motion, source }],
  stats, state,
  declared: { totalSeconds, shotCount },
  coverage: { shots, declared, missingIds, nonIntegerIds },
  assets: { ready, planned, blocked, unknown, items: [{ label, ref, want, state, reason }] },
  review: { required: true, note, unresolvedShots, pendingMarkers },
  red, yellow, info,
}
```

### 镜头编号与时长（FFmpeg 适配器的依赖面）

| 字段 | 形状 | 约定 |
|---|---|---|
| `id` | 整数或 `null` | `1`、`01`、`S01`、`镜 1`、`第1镜`、`#1`、`Shot 3` 都规范化成整数；`1a`、`1-2` 返回 `null` 并报黄灯 `shot-id-noninteger`，**不伪造编号** |
| `label` | 字符串 | 方案里的原样写法，如 `S01`、`1 · 雨落在铁皮上` |
| `order` | 整数 | 按方案出现顺序，从 1 连续 |
| `duration` / `durationSec` | number 或 `null` | 两个名字是同一个数（秒）；读不出为 `null`，适配器必须当阻塞，**不要兜底成 0** |

同一份方案的表格表达与小节表达读到的是同一批镜头；表里写了、小节补充的字段会合并，
但**表内自己重复的行不合并**——重复镜号是要报红的错误，不能被解析层吃掉。

## 认哪些表达

| 表达 | 例子 | 机器怎么认 |
|---|---|---|
| 镜头表 | `\| Shot \| Length \| Scene \| Approach \|` | 有编号列，且有时长列或（画面列＋路线/声音列） |
| 逐镜小节 | `### 镜 1 · 标题` + `- 时长：4 秒` | 标题里带「镜/镜头/shot」+ 编号，下面跟字段行 |
| 加粗镜号 | `**镜 2**` + `- 画面：…` | 同上 |

列名只认"这一列管什么"，不认列序与列数：`时长/秒数/Length/duration`、
`画面/内容/Scene/Visual`、`做法/路线/实现/Approach`、`素材/来源/Asset` 都行。

**不认**的表达：整段散文里一句"就拍一个海边空镜"——没有逐镜明细，报红 `shots-missing`。

## 机器判什么

| 检查 | 码 | 灯 |
|---|---|---|
| 一个逐镜明细都认不出来 | `shots-missing` | 红 |
| 声明 N 镜、只有 M<N 镜明细 | `coverage-incomplete` | 红 |
| 镜号断档 | `coverage-gap` | 红 |
| 镜号重复 | `shot-duplicate` | 红 |
| 镜号不是整数 | `shot-id-noninteger` | 黄 |
| 单镜读不出时长 / ≤0 | `shot-duration-missing` / `shot-duration-invalid` | 红 |
| 镜头合计与声明总时长差 > ±10%（可调 `tolerance`） | `duration-mismatch` | 红 |
| 阶段表合计与镜头合计差 > ±10% | `duration-stage-mismatch` | 红 |
| 单镜没写画面/动作 | `shot-content-empty` | 红 |
| 单镜没写制作路线 | `shot-route-empty` | 红 |
| 路线只写裸类别词 | `shot-route-vague` | 黄 |
| 单镜没写目的 | `shot-purpose-missing` | 黄 |
| 无状态行 | `state-missing` | 黄 |
| 全篇没提声音 | `plan-sound-undeclared` | 黄 |
| 动源不在七类里 | `shot-motion-unknown` | 黄 |
| 素材标为已有但文件不存在 | `asset-missing` / `asset-blocked` | 红 |
| 素材状态写着"缺/待定"且没来源 | `asset-blocked` | 红 |
| 已具备但没写具体文件，核不了 | `asset-ready-without-path` | 黄 |
| 路径引用但没给 `assetExists` | `asset-unverified` | info |

**已经去掉的**：固定十节、11 列、七类动源必填、动源占比门槛、素材末列必须全 ✅、
出现「（估）/TBD/待定」就红。这些要么是表达自由，要么根本不是机器该判的。

## 素材三态

| 状态 | 判据 | 结论 |
|---|---|---|
| `ready` 已具备 | 状态列写"已有/✅/已获得…"，且 `assetExists` 确认文件在 | 不阻断 |
| `planned` 待产出 | 有路径或路线，写着"拟制作/待生成/渲染/制作…" | **不阻断**——文件还不存在是正常的 |
| `blocked` 阻塞 | 标成已有但文件找不到；或状态"缺/待定"且没来源 | 红 |
| `unknown` 未核 | 给了路径但没给 `assetExists` | info，不阻断 |

"计划具备可执行路径"不等于"素材已经存在"。把待产出当阻塞，会逼 Agent 去伪造文件；
把虚构资源放过，才会让片子做到一半崩。所以这两件事分开判。

## 固定样本

都在 `tests/plan-check-fixtures/`，说明见那里的 `README.md`。

| 文件 | 期望 |
|---|---|
| `valid-plan.md`（旧 11 列） | exit 0，`pass=true`，`shots=[1,2,3]`，时长 `[3,5,4]` |
| `flexible-table-plan.md`（自定列名表） | exit 0，`shots=[1,2,3,4]`，`S01…S04` → `1…4` |
| `flexible-block-plan.md`（逐镜小节） | exit 0，`shots=[1,2,3]`，时长 `[4,5.5,6]` |
| `planned-assets-plan.md`（全是拟制作） | exit 0，`assets.planned>0`、`blocked=0` |
| `missing-shots-plan.md`（声明 4 镜写 2 镜） | exit 1，红 `coverage-incomplete` |
| `duration-mismatch-plan.md`（声明 30 合计 18） | exit 1，红 `duration-mismatch` |
| `missing-assets-plan.md`（虚构/真缺素材） | exit 1，红 `asset-missing` + `asset-blocked` |
| `invalid-plan.md`（旧反样本） | exit 1，红 `coverage-incomplete` |

`素材/` 下是零字节占位文件，只为让"标为已有"的路径真的存在。别播放、别测量。

## 已知局限（不要当成 bug）

1. **不判创意好坏**。它回答"写没写、齐不齐、对不对得上"，不回答"这个方案好不好"。
   `pass=true` 也必须人审，`review.required` 恒为 `true`。
2. **中文/英文列名靠同义词表认**。写了一个完全没见过的列名（比如 `Visual beat`），
   可能认不出是画面列；这时会报 `shot-content-empty`，请改用常见词或补同义词。
3. **总时长靠正则读**。"全片 35 秒"能认，"约莫半分钟出头"认不出——认不出只报 info，
   不会红，但也就没核对。
4. **文件核对是同步存在性检查**，不验证文件能不能解码、是不是真的视频。
   那是 `evidence` 的 `measure` 动作的事。
5. **一个镜头的"路线"必须是字段值**。写在整段散文里的技术说明读不到，
   因为那已经超出"最小字段"能机械判的范围。
6. **`pass=true` 不等于 CLI 退出 0**。CLI 传了真实文件核对器，
   标为"已有"却找不到文件时会红；测试里用 `assetExists` 注入决定核不核。
   两者跑的是同一份判定逻辑，只是输入不同。
7. **样本目录里的 `素材/*.mp4` 是零字节占位**。删掉它们，
   柔性样本会在 CLI 上变红——那是正确行为，测试里有一条专门盯着这件事。

## 这条检查拦的是什么

2026-11-19 两支真实片，旧规范下都算"合格"：一支方案覆盖率 10%（11/110 镜），
另一支行 100% 但方案是事后补的。旧门禁对这两支都报红，
但它同时也会拦住一份用别的方式写清楚的方案——那部分 0.4 已经放开。
现在拦的是：缺镜、时长对不上、路线空白、把虚构资源当已有。
