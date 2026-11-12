# MotionHarness 调研｜Lead 一线取证（一手材料，已核实）

> 2026-11-11。本文记录 Lead 亲自从**官网 bundle**、**npm 包**、**TypeScript 类型定义**里挖到的事实。
> 每条都有出处。这是八路调研的"地基材料"，其余报告在此之上解读。

---

## 零、三句话

1. **它是一个"帧契约 + 工程分层 + 人机协作"的套件**，不是渲染器，也不是动效库。
2. **它的核心契约小到只有两个方法**：`prepareFrame(time)` / `dispose()`。框架无关。
3. **许可发生了变化**：早期版本是 **Apache-2.0（真开源）**，0.0.26 起转为 **UNLICENSED（专有）**；但
   *"previously distributed versions under Apache-2.0 are unaffected"* 是它 LICENSE 里自己写的原话。

---

## 一、许可状态（逐版本实测，这条最重要）

| 包 | 版本区间 | license |
|---|---|---|
| `@motionharness/sdk` | 0.0.11 → **0.0.25** | **Apache-2.0** ✅ |
| `@motionharness/sdk` | 0.0.26 → 0.1.4（当前） | UNLICENSED ❌ |
| `@motionharness/cli` | 0.0.11 → 0.0.20 | **Apache-2.0** ✅ |
| `@motionharness/cli` | 0.0.26 → 0.1.4（当前） | UNLICENSED ❌ |
| `@base_bit/vmg-cli` | 0.0.14 | **Apache-2.0** ✅ |
| `@motionharness/bridge-davinci` | 0.1.4 | 待核 |

**0.1.4 的 LICENSE 原文（`@motionharness/sdk/package/LICENSE`）**：

> MotionHarness / Copyright 2026 MH contributors. All rights reserved.
> No open-source license is granted for MotionHarness-authored material by this
> repository or distribution. Use is subject to a separate authorization from the
> applicable rights holders.
>
> Third-party software, fonts, assets and adapted components remain subject to
> their respective licenses and notices, including THIRD_PARTY_NOTICES.md,
> SHADCN_PROVENANCE.md, OPENFX_LICENSE and adjacent font license files…
>
> **Rights already granted for previously distributed versions, including under the
> Apache License, Version 2.0, are unaffected.**

**0.0.25 的 NOTICE 原文（这是关键边界）**：

> SDK files extracted from MotionHarness Kit retain their existing Apache License,
> Version 2.0 notices. **This SDK distribution contains public document, component
> and extension type contracts. It does not contain the private CLI, editor or
> engine implementation.**

### 结论
- **Apache-2.0 的 0.0.25 SDK（85,634 B）已下载核实**：LICENSE 是完整 11,357 B Apache 2.0 全文，NOTICE 688 B，`THIRD_PARTY_NOTICES.md` 列出了全部第三方（`its-fine` MIT / `@webgpu/types` BSD-3 / React MIT / `@react-three/fiber` MIT / three.js MIT）。
- **Apache 给的是"公开契约层"**：document 类型、component 契约、extension 契约。
- **它明确不含**：私有 CLI、编辑器、引擎实现。
- **所以**：我们能合法读、用、改、分发的是 **SDK 的类型与契约层**；**引擎本体仍然拿不到**（要么用当前 UNLICENSED 版本当外部工具，要么自己实现）。

**这个区分极其重要**：它决定了"融进来"的边界——
- 「学它的数据模型」→ 完全合法（Apache）
- 「用它的 SDK 类型」→ 合法（Apache，留 NOTICE）
- 「用它的引擎」→ 只能当外部工具，不能随包

---

## 二、核心契约：它守的那个"核心"是什么

### `mh.json`（工程配置，官网 bundle 原文）
```json
{ "projectType": "standard", "entry": "src/scene.js",
  "width": 1920, "height": 1080, "duration": 8, "fps": 30 }
```

### `src/scene.js`（场景契约，Agent 要写的就是这个）
```js
import * as THREE from 'three';
import './style.css';

export default function ({ root, width, height }) {
  const scene = build(root, width, height);
  return {
    prepareFrame(time) { scene.seek(time); },
    dispose()    { scene.destroy(); },
  };
}
```

**两个方法。就这样。**

### 它支持的技术栈（bundle 原文，`Nr` 数组）
| 栈 | 示例行 |
|---|---|
| Three.js | `import * as THREE from 'three';` |
| GSAP | `import { gsap } from 'gsap';` |
| Canvas 2D | `const ctx = canvas.getContext('2d');` |
| React | `import { createRoot } from 'react-dom/client';` |

**框架无关**。这是它比 `gongnyang` 的 `window.__seek(sec)` 更干净的地方：
后者是**全局函数**，前者是**模块导出 + 生命周期**。

### 分工边界（官网 bundle 原文）
- **MotionHarness 负责**：`预览` `导出视频` `AI 标记` `版本` `工程打包`
- **你的工程负责**（原先要自己做的五件事）：`搭预览服务` `逐帧导出` `音画合成` `任意时间定位` `工程打包`

> **这就是它卖的东西**：把"搭预览服务 / 逐帧导出 / 音画合成 / 任意时间定位 / 工程打包"这五件脏活接走，
> 让你只写 `prepareFrame(time)`。

---

## 三、工程三平面模型（bundle 原文，不是装饰）

```
bg    → 素材 · assets/         city.webp / girl.svg / score.wav
actor → 源码绘制 · src/        React 组件
fg    → 参数 · document.json   "02 主角": { "scale": 520, "x": 380 }
```

两句 UI 提示语（决定了整个「代码与参数隔离」的语义）：
- 人调参时：「**手调参数：源码未改动**」
- Agent 改码时：「**Agent 改源码：参数保留**」

**机制**：`document.json` 以**图层名（中文）为 key**，只存数值参数；`src/` 从 `document.json` 读值。
- 人调参 → 只写 `document.json`，源码字节不变
- Agent 改源码 → 只改 `src/`，参数还在

**这正是我们引入 `web-scene` 后缺的那一环**：场景是文件，人调的参数存哪？它给了答案。

---

## 四、AI 标记：真实数据模型

### 官网演示里的简化版（bundle）
```js
{ n: 6, at: '00:00.00', kind: '画面',   text: '…', state: 'done' }
{ n: 5, at: '00:02.28', kind: '区间',   text: '这段标题动画节奏放慢一点', state: 'todo' }
{ n: 4, at: '00:05.80', kind: '时间点', text: '字幕出现得太突然，淡入长一点', state: 'todo' }
```

### SDK 里的真实类型 `TimeMarker`（`time-markers.d.ts`，Apache-2.0）
| 字段 | 含义 |
|---|---|
| `id` / `number` | 稳定 id / 内核发放的显示编号（`#7`，全项目唯一不复用） |
| `label` / `notes` | 标题 / 备注 |
| `attachments` | 附件（`AssetReference` 或 `{ $asset, kind:'file', name }`） |
| `color` / `kind` / `origin` | 颜色 / 分类 / 来源（`agent` 或 `user`） |
| `lineageId` | 血缘（同一请求的多次修改） |
| **`target`** | **`instance` / `component` / `timing` / `parameter` 四级语义定位** |
| **`anchor`** | **画布像素坐标：点，或矩形（x/y 为左上角）** |
| `context` | `{ documentRevision, name, componentId, value, field }` |
| `requestVersion` | 内核维护的指令版本，**独立于 document revision** |
| `intent` | `delete-instance` / `delete-standard-audio` / `pro-edit` |
| `completion` | `{ requestVersion, summary }` |
| `timeSpace` | **`project` / `source` / `object` 三种时间空间** |

**它自己的注释（原文）**：
> 「Stable semantic location; **coordinates alone never identify an object**.」
> 「For canvas annotations, time, anchor, annotated screenshot and notes are primary;
> an optionally associated target and its context are hints.」
> 「Interpretation and animation decisions belong to the Agent.」

**这三句是整份设计里最值钱的**：
1. 坐标不能单独定位对象 → 必须有语义 target
2. 画布批注以「时间 + 锚点 + 截图 + 备注」为主，target 只是提示
3. **"解释和动画决策属于 Agent"** —— 它把创造性决策明确交给了模型

---

## 四·五、从 155.6 MB 原生二进制里挖到的真实模板（官网从未公开）

Windows 包 `MotionHarness.exe`（163,109,376 B）内含 `mh new` 的完整工程模板。

### Standard 工程的 `mh.json`（原文）
```json
{ "version": 3, "projectType": "standard", "runtimeVersion": 1,
  "entry": "src/scene.js", "width": 1280, "height": 720, "duration": 4, "fps": 30 }
```

### Standard 工程的 `src/scene.js`（原文，完整可运行）
```js
export default function ({ root }) {
  root.style.cssText += ';background:#141414;color:#fff;display:grid;place-items:center;font:80px system-ui';
  const title = document.createElement('div');
  title.textContent = 'MotionHarness';
  root.append(title);
  return {
    prepareFrame(time) {
      const progress = Math.min(1, time / 0.8);
      title.style.opacity = String(progress);
      title.style.transform = `translateY(${40 * (1 - progress) ** 3}px)`;
    },
    dispose() { title.remove(); },
  };
}
```

**这就是最小可运行单元**：一个 `root`，两个方法，纯 `time` 函数，无累加。

### Pro 工程的 manifest（原文）
```json
{ "version": 3, "projectType": "pro", "runtimeVersion": 1, "entry": "src/project.ts" }
```

### Pro 工程的 `package.json`（原文）
```json
{ "name": "mh-composition", "private": true, "type": "module",
  "dependencies": { "@motionharness/sdk": "0.0.8", "react": "19.2.8", "react-dom": "19.2.8" },
  "devDependencies": { "@types/react": "19.2.14", "typescript": "5.9.3" } }
```

**关键细节：它自己的官方模板锁的是 `@motionharness/sdk@0.0.8`——一个 Apache-2.0 版本。**
当前发布 0.1.4 是 UNLICENSED，但模板依赖的是 Apache 那批。

### `.vmg` 打包格式（从错误信息还原）
`.vmg` 是 **ZIP**，且带严格完整性校验。二进制里的校验错误原文：

```
Invalid file index
Indexed file is missing
Original asset identity differs from its content
Indexed file size or SHA-256 differs
Duplicate file declaration
File index does not cover exactly the archive payload
manifest projectType and mh.json projectType differ
Unsupported React project manifest
ZIP contains unindexed local data
Unindexed ZIP data between records
Overlapping ZIP records
ZIP local size/CRC differs
ZIP local and central names/extra differ
ZIP64 is not supported
Truncated ZIP name
Non-ASCII ZIP names require the UTF-8 flag
```

**它在打包层做的保证，和我们 27,000 行治理代码同级别**：资产身份 + SHA-256 + 逐条 ZIP 记录对齐 +
manifest 交叉校验。**这不是一个随手做的项目。**

### 技术栈坐实
| 项 | 证据 |
|---|---|
| 语言 | **Rust**（原生二进制，非 Electron/Node） |
| 浏览器驱动 | **`chromiumoxide`**（24 次命中），**不是 Playwright/Puppeteer** |
| 视频 | 内嵌 LGPL FFmpeg/ffprobe，首用自动解压；`palettegen`/`paletteuse` 做 GIF 透明 |
| 工程依赖 | pnpm 10+ |
| Studio | 本地 Web 服务 + 浏览器（`mh open` 返回 URL） |

---

## 五、SDK 的能力清单（`index.d.ts` 总导出面，Apache-2.0）

这是**我们上一轮列出的缺口清单的镜像**：

| 导出 | 对应我们的缺口 |
|---|---|
| `motion.js`：`spring` / `inertia` / `oscillate` / `noise` / `dampedFollow` / `springFollow` | 我们完全没有（只有 fade-in） |
| `easing.js`：`cubicBezier` / `evaluateEasing` / 15 个命名缓动 | 我们所有动效 easing 都写死 `linear` |
| `mask.js`：`Mask` / `maskCoverage`，mode `alpha`/`luminance`/`clip` | 我们无遮罩（`mask` 命中 0） |
| `camera.js`：`CAMERA_COMPONENT_ID = 'mh.camera'`，`{ zoom, x, y, rotation }` | 我们无 camera（命中 0） |
| `time-remap.js`：纯可 seek 的时间重映射 + 曲线切片 | 我们有 `remap.js` 但**没有任何适配器接它** |
| `time-markers.js`：`TimeMarker` 全模型 | 我们有 `editing/annotations.js` 但不可达 |
| `effects.js`：`createEffect` / `EFFECT_DEFINITIONS` / `EffectStack` | 我们有效果库但空 |
| `text.js` / `counter.js` / `sequence.js` / `geometry.js` / `path.js` / `path-follow.js` | 我们排版极弱 |
| `three.js` / `authoring-runtime.js`（`Layer` `GpuCanvas` `Sequence` `useFrame` `useTime`） | 我们无 |
| `basic-graphic.js` / `basic-media.js` / `basic-container.js` | 对象类型的可扩展契约 |
| `control-panel.js`：`ControlPanel` / `ControlGroup` | 参数面板契约 |

### 时间模型（`motion.d.ts` 的注释，原文）
> 「**Stateless motion** in MotionHarness seconds. Options describe the complete curve at each
> evaluation; changing them does not resume a hidden simulation.」
> 「Seeded 1D smooth value noise; **independent of evaluation order and FPS**.」
> 「**Reconstructs from start on every call: no playback memory or wall-clock delta.**」
> 「Each interval holds its endpoint source value; the last partial interval is evaluated
> independently, so **seek order and output FPS cannot change the curve**.」

**这是"时间纯函数"的教科书级实现**，而且它把"确定性"写进了每个函数的语义：
- 无状态（stateless）
- 种子化噪声（seeded, 不依赖求值顺序）
- 固定采样网格（fixed sampling grid）
- 任意 seek 不改变结果

**它的时间单位是"秒"，但确定性与 FPS 无关** —— 这解决了我上一轮的担忧（秒制会不会引入浮点漂移）。
它的答案：**只要每个采样点都由纯函数从 `t` 重算，秒制和帧制在确定性上等价。**

---

## 六、`mh` CLI 命令面（官网 + 类型定义 + 二进制实测）

| 命令 | 作用 |
|---|---|
| `mh doctor` | 环境自检 |
| `mh skill` | 输出给 Agent 阅读的 skill 文档（**这是它把知识投递给模型的方式**） |
| `mh inspect --project ./x` | 检查工程 |
| `mh render motion.mp4 --project ./x` | 渲染 |
| `mh pack motion.vmg --project ./x` | 打包工程 |
| `mh unpack motion.vmg ./y` | 解包 |
| `mh open ./x --browser` | 打开 Studio |
| `mh bridge davinci install` / `doctor` | 达芬奇桥接 |

平台：Windows 10/11 x64、macOS Apple Silicon、Node 22.15+、Chrome
桥接需 Node 22.18+ 与 FFmpeg/ffprobe；**透明视频导出需 FFmpeg 7+**

### 二进制里还原出的 Usage 原文
```
Usage: mh unpack <input.vmg> <new-directory>
Usage: mh pack <output.vmg> [--project <directory>]
Usage: mh daemon start|status|logs|stop
Usage: mh update [--check] [--output-format json|text] [--timeout-seconds 120]
Usage: mh studio sessions | control --file <request.json> [--project <directory>]
```

### 完整 Studio HTTP 路由（从二进制字符串还原，非文档）
```
/api/preview/prepare      /api/preview/capture     /api/preview/ack
/api/exports/prepare      /api/exports/plan        /api/exports/capabilities/export//frame
/api/markers              /api/marker-context
/api/state                /api/capabilities        /api/describe
/api/assets/device        /api/assets/device/info  /api/browser-assets/discover/platform/
/api/checkpoints/         /api/candidates//probe   /api/migrate
/api/studio/sessions      /api/studio/control      /api/studio/attach
/api/studio/preferences   /api/studio/report       /api/studio/welcome/acknowledge
/api/project/launch       /api/project/download
/api/bridge/davinci/      /api/image-tools         /api/batch
```

**这张表证实了五件事：**

1. **渲染是「prepare → capture → ack」三段式**，不是一次性 `render`。
   这对应 README 里的 "frame barrier"：每一帧要等所有异步生产者就绪才呈现。
2. **`/api/checkpoints/`**：版本管理是真有快照点，不是只存 diff。
3. **`/api/candidates//probe`**：有"候选探查"，与我们的 `editing/candidates.js` 同一概念。
4. **`/api/markers` 与 `/api/marker-context` 分离**：标记本体与"标记当时看到的上下文"是两份数据。
   **这是让 Agent 准确理解意见的关键设计。**
5. **它是一个本地 HTTP 服务**，所以外部可以用 HTTP 接入，而不只是 CLI。

---

## 七、项目成熟度（客观）

- 首个版本 `0.0.11`：**2026-09-28**
- 最新 `0.1.4`：**2026-11-11**（就是今天）
- **6 周、21 个版本、仍在 0.1.x**
- 官网有「加入内测群」入口
- 达芬奇桥接**仅 macOS**
- 有 STANDARD / PRO 两档

**这不是一个成熟产品，是一个高速迭代中的早期项目。** 这既是机会（形态还没定型）也是风险（API 会变）。

---

## 八、必须纠正的一条

**官网首页那 12 行 `mh.layer(...).fill(...)...` 不是它的真实 API。**

证据：bundle 里 `Yg` 数组被逐字符 `slice` 后放进 `<li>`（打字机效果），`Zg` 是语法高亮函数；
全文检索 `window.mh` / `globalThis.mh` / `MH_RUNTIME` **全部 0 命中**。

**它是官网用来"演"的技术感装饰**，配合 `d_model 4096 / experts 32 / top-2` 那套伪 MoE 面板。
真实 API 在 `@motionharness/sdk` 的类型定义里（本文第五、六节）。

**区分"演示代码"和"真实契约"，是这次调研最重要的一条纪律。**
