# evidence.js 接口说明

`tools/evidence.js` 是 control-your-video 的证据索引工具。四个动作合成一个脚本：**extract / measure / recall / gc**，不拆成四个工具。

索引字段定义在 [编写规范](../docs/编写规范.md) §1.5。本文件只写**怎么用**与**为什么这么设计**。

## 一句话

只存被看过的帧；结论必须来自真实证据；重渲不覆盖旧证据；默认只查当前有效的那些。

## 两个入口，一份逻辑

同一个 `evidence.js` 有两个入口：

| 入口 | 谁用 | 怎么调 |
|---|---|---|
| `evidence` 工具 | 模型 | 工具调用，参数有 schema；插件薄壳只做参数转发 |
| `node tools/evidence.js …` | 人、排障、独立脚本 | 命令行，见本文《四个动作》 |

业务逻辑只有一份，薄壳不重复任何规则。薄壳在 [包根 index.js](../index.js)。

调用工具时要给 `dir` 的绝对路径；若同时给 `workspace`，`dir` 与 `source` 可写相对于该工作区的路径。

## 为什么是一个工具而不是四个

注册成四个工具，每个都要在每请求的 schema 里占位置、都要在模型侧判断"这次该调哪个"。而这四个动作用的是同一个索引、同一套字段、同一条规则，拆开后规则要写四遍，四遍一定会漂。合成一个工具、四个 action，规则只写一遍。

（2026-11-18 决定：注册为插件工具。此前"先用脚本、按触发条件再提升"的建议已被这个决定取代。）

## 前置条件

| 动作 | 需要 |
|---|---|
| `extract` | 本机已装 `ffmpeg` |
| `measure`（`duration`） | 本机已装 `ffprobe` |
| `measure`（`black` / `loudness` / `silence`） | 本机已装 `ffmpeg` |
| `recall` / `gc` | 无（只读索引与文件） |

**找不到工具就如实失败，不降级假装成功。** 这是规范 §7 第 8 条：没有输入就说没有输入。

运行环境：Node 18+。只用内置模块（`fs` / `path` / `crypto` / `child_process`），无第三方依赖、不联网、不安装任何东西。

## 五个动作

### extract — 抽一帧（可裁剪）并写入索引

```bash
node tools/evidence.js extract \
  --dir  <作品>/work/evidence \
  --source <作品>/out/r3.mp4 \
  --revision r3 --shot 4 --t 12.4 --purpose look \
  --question "12.4 秒这条字幕有没有压到人脸？" \
  [--crop 900,420,320,240] \
  [--derived-from r3-s04-12.4s-look] \
  [--force]
```

| 参数 | 说明 |
|---|---|
| `--dir` | 证据目录，`<作品>/work/evidence`。不存在就建这一层 |
| `--source` | 取证源文件。**必须是成片 MP4，不能用预览页**——预览页与编码后的成片不是同一份事实 |
| `--revision` | 修订号，`r3` 或 `3` 都接受，内部统一成 `r3` |
| `--shot` | 镜号，整数 |
| `--t` | 秒，非负，内部取一位小数 |
| `--purpose` | 七选一：`look` / `seam` / `text` / `motion` / `sync` / `mix` / `cover` |
| `--question` | 这条证据要回答的那一个问题。**建议每次都写**；不写会提示"暂时回答不了任何问题" |
| `--crop` | `x,y,w,h` 物理像素。带裁剪时 id 自动加 `-crop` 后缀 |
| `--derived-from` | 派生图的父条目 id |
| `--force` | 同键已存在时强制重抽（会清空该条的 `finding`，因为旧结论对应的是旧读图） |

行为：

- 输出文件名固定为 `<id>.png`。
- 写了 `source_sha256`（对被取证的源文件做流式 sha256）。
- **去重**：同 `(revision, shot, t, purpose)` 已有 `current` 条目时，默认复用、不重抽。
- **不覆盖旧证据**：新修订会抽取成功，同时把同 `(shot, t, purpose)` 的**其它修订**的 `current` 条目改成 `superseded`；**旧文件留在原地不删**。

### sheet — 把一段时间拼成联系表（看变化，不是看单帧）

```bash
node tools/evidence.js sheet \
  --dir  <作品>/work/evidence \
  --source <作品>/out/r3.mp4 \
  --revision r3 --shot 4 --t 12.4 --span 2 --count 6 [--cols 3] \
  --purpose motion \
  --question "这一段主体有没有停住？" \
  [--force]
```

**为什么需要它**：单帧看不出运动。判"这一段动得顺不顺""节奏对不对"要看连续变化，而一次一帧地抽既慢又会丢掉帧间的顺序关系。一张联系表把一段时间摊开成网格，一次就能读完。

| 参数 | 说明 |
|---|---|
| `--t` | 覆盖区间的起点（秒），与 extract 的含义不同：这里是一段的开始 |
| `--span` | 覆盖多少秒，`0—30`（默认 2） |
| `--count` | 抽几帧，`2—12`（默认 6）。格数 = count |
| `--cols` | 列数，`1—count`（默认 3）；行数自动算 |
| `--purpose` | 七选一；不给时默认 `motion`（联系表最常用于判运动） |

行为：

- 文件名 `<id>.png`，id 带 `-sheet{count}x{cols}` 后缀，例如 `r3-s04-12.4s-motion-sheet6x3.png`。
- **每格是真实时间点**，来自 ffmpeg 的 `showinfo`：输出会把 `--t` 起各格的实际秒数打出来，同时写进条目的 `times`。用 `-copyts` 保证是成片里的绝对时间，不是从 0 开始的相对时间。
- 条目比 extract 多三个字段：`span`、`count`、`cols`（外加 `times` 数组）。
- **和同键单帧互不替代**：去重时会区分"是不是联系表"，两者各存一份。
- 同参数重复执行默认复用；`--force` 重抽覆盖同一条（不新增一条），并清空 `finding`。
- 每格 480 宽，整张通常是 1500×600 量级，能被一次读完。

**它不能干什么**：它是导航级证据。联系表能告诉你"该回看哪几秒""这段时间里发生了什么"，但**不能代替连续播放**——运镜顺不顺、闪烁是否真的在闪、节奏对不对，仍然要靠连续片段或用户观看。

### measure — 确定性测量

```bash
node tools/evidence.js measure \
  --dir <作品>/work/evidence --source <作品>/out/r3.mp4 \
  --revision r3 --shot 4 --kind duration

node tools/evidence.js measure \
  --dir <作品>/work/evidence --source <作品>/out/r3.mp4 \
  --revision r3 --shot 0 --kind loudness --purpose mix [--from 0 --to 24]
```

| `--kind` | 测什么 | 输出字段 |
|---|---|---|
| `duration` | 时长与流信息 | `container_duration_s`、`video_duration_s`、`width`、`height`、`nb_frames`、`has_audio`、`audio_duration_s`、codec |
| `black` | 黑帧区间 | `spans`、`longest_s` |
| `loudness` | 积分响度与真峰（EBU R128 单遍） | `integrated_lufs`、`true_peak_dbfs`、`lra_lu` |
| `silence` | 静音区间 | `spans` |

设计要点：

- **容器时长与视频流时长分开报**。容器 `Duration` 完整、视频流可能只有前半段，是两个事实；合成一个"时长"会掩盖问题。
- **读数原样输出**，不在这一层下"有没有问题"的结论。黑场可能是有意的淡入淡出；响度达标不等于混音对。每条结果都自带 `note` 说明这一层能证明什么。
- 读不到积分响度就**直接失败**，不填一个猜的数字。这是规范 §7 第 8 条的落地。
- 测量结果存成 `<id>-<kind>.json`，与抽帧共用同一套索引（`purpose` 默认 `seam`，响度与静音默认 `mix`）。

### recall — 按镜头 / 时间 / 修订 / 状态查

```bash
node tools/evidence.js recall --dir <作品>/work/evidence
node tools/evidence.js recall --dir <作品>/work/evidence --shot 4 --purpose look
node tools/evidence.js recall --dir <作品>/work/evidence --from 10 --to 14
node tools/evidence.js recall --dir <作品>/work/evidence --status superseded   # 对照改前
node tools/evidence.js recall --dir <作品>/work/evidence --id r3-s04-12.4s-look
```

| 参数 | 说明 |
|---|---|
| `--status` | `current`（默认）／`superseded`／`all`。**默认只返回 current** |
| `--revision` | 只查某一修订 |
| `--shot` | 只查某一镜 |
| `--purpose` | 只查某一用途 |
| `--from` / `--to` | 时间区间（秒，含端点） |
| `--id` | 精确查某一条 |
| `--format` | `id` 时只打印 id 列表，方便贴进修改单 |

`finding` 为空时明确打印"（未填 · 这条不算看过）"——**"有文件"不等于"看过"**，这一条必须在输出里区分开。

### gc — 清 superseded

```bash
node tools/evidence.js gc --dir <作品>/work/evidence          # 预演，只列不删
node tools/evidence.js gc --dir <作品>/work/evidence --yes    # 真清
```

两条底线：

1. **只清 `superseded`，绝不碰 `current`。**
2. **不带 `--yes` 只预演。** 带 `--yes` 时文件不是直接删，而是移到 `_trash/<时间戳>/`；索引里对应条目移除。确认不再需要后再手工删那个目录。

为什么不去标、不直删：`superseded` 的价值就是能拿回来对照"改前是什么样"。直删等于把这条后悔路一起删了。

## 索引形态

`<作品>/work/evidence/index.json`：一个 JSON 数组。

```json
[
  {
    "id": "r3-s04-12.4s-look",
    "file": "r3-s04-12.4s-look.png",
    "revision": "r3",
    "shot": 4,
    "t": 12.4,
    "purpose": "look",
    "source_sha256": "…",
    "derived_from": null,
    "created": "2026-11-18T02:30:00+08:00",
    "question": "12.4 秒这条字幕有没有压到人脸？",
    "finding": "",
    "status": "current"
  }
]
```

- 字段名逐字按规范 §1.5，**不改名、不翻译**。这是本规范里唯一允许英文键名的接口，因为它要给脚本读。
- 联系表多四个字段：`span`（覆盖秒数）、`count`（格数）、`cols`（列数）、`times`（每格的绝对秒数）。它们只出现在 `sheet` 写的条目上，读的人是 video-review。
- 索引坏了（非法 JSON、顶层不是数组、缺必需字段）时**直接报错退出，不猜、不自动修复**。坏索引自动"修好"过一次，后面所有结论都不可信。

## 写作纪律（脚本挡不住的，靠正文）

脚本能保证的：去重、不覆盖、默认只查 current、缺工具就失败。
脚本**不能**保证的：

- `question` 是不是一个能回答的问题（"这镜好不好"不是）；
- `finding` 是不是真看过才写的；
- 该不该取这条证据（取多了会让证据库膨胀）。

这三条归 `video-review` 的正文与 `references/observation-checklist.md` 管，不归脚本管。

## 验证到哪为止

- `sheet` 与 `extract`：已在真实 2 秒测试片上跑过（`tests/evidence-sheet.test.js`），覆盖出图、PNG 签名、每格绝对时间、与单帧互不覆盖、`--force` 重抽、参数拒绝。
- `measure` / `recall` / `gc`：本轮没有自动化用例。参数按 Node 语义与 ffmpeg/ffprobe 文档写，但未在真实成片上逐个验证。
- `--t` 的定位精度取决于 `ffmpeg -ss` 的位置（放 `-i` 前是快速定位）与关键帧间隔，可能与"刚好 12.4 秒"有偏差；差多少未测。联系表的每格时间同理——它给的是**实际取到的那一帧**的时间，不是请求的时间。
- `loudness` 用的是单遍 `ebur128`，与 `loudnorm` 的两遍做法（先测 `measured_*` 再归一化）不是一回事——本工具只负责**测**，不负责**改**。
- `gc` 的 `_trash` 目录不会自动清理，长期会占空间。
