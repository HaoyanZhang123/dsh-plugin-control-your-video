# MH3 — MotionHarness 的技术架构还原（JS 逆向 + 本机 runtime 取证）

> 调研对象：`motionharness.top`（帧驭 MotionHarness）
> 许可状态：**UNLICENSED**。本文为只读研究记录，不含任何拷贝进本仓库的源码；所有引用均为分析用途的字段名、类型签名与原文短句。
> 姊妹文档：`MH2-npm与CLI.md`（CLI 命令面、SDK 导出面）、`MH4-渲染与时间模型.md`。本文补充 MH2 未覆盖的**网站 bundle 逆向**、**渲染管线物理实现**、**代码/参数隔离机制**、**技术栈清单**，并在时间模型处给出与我们的 `CompositionPlan` 的正面对照。

---

## §0 三句话

1. **技术架构**：MotionHarness 是一个 **Rust 原生守护进程**，它内嵌一个 Vite/React 前端（Studio）与编辑内核（Core），通过 `chromiumoxide` 用 CDP 驱动本机 Chrome 打开工程页面，**按秒 seek 到每一帧、截一张完整 PNG**，再把 PNG 序列喂给内置的 LGPL FFmpeg 编码成 MP4/ProRes；Node.js 只作为"瞬时构建工具"存在。
2. **哪些是代码实证**：渲染管线的每一环（Rust daemon、chromiumoxide、逐帧 PNG、FFmpeg、8-bit RGBA→Rec.709）、时间模型的浮点秒、`document.json` 的完整 TypeScript 接口、`TimeMarker` 全字段、"代码与参数隔离"的双文件合并方式、全部依赖版本——**均来自官方发布的类型定义、Skill 文档与 runtime 清单原文**，不是从 minified 代码猜的。
3. **哪些是推测**：宿主与 Studio 之间的**私有 IPC 协议格式**、`document.json` 里 `settings` 的精确子字段（被 `CompositionSchema` 间接引用）、原生二进制内部模块划分、营销页 HUD 数字（`d_model 4096`/`top-2`）的真实含义——这些只能给强推断或明确标为不可知。

---

## §1 网站 bundle 分析

### 1.1 文件与体积（实测）

| 文件 | 磁盘字节 | 字符数 | 说明 |
| --- | --- | --- | --- |
| `site-page-BNU1-ELX.js` | 559,627 | 491,476 | 100 行；Studio 前端主体 + 全量 i18n 词典 |
| `main-HiGcBKPY.js` | 776,135 | 770,440 | 4,719 行；**营销首页开场动画**（three.js 重型） |
| `index.html` | 980 | — | 只挂两个 module script |
| `site-page-Bal5kV6Z.css` | 518,637 | — | Studio 样式（`studio-*` 前缀为主） |
| `main-DjJD-nM4.css` | 84,378 | — | 营销页样式（`tv-*` / `ts-*` 前缀） |

**两个 bundle 的分工和直觉相反**：`site-page` 才是 Studio 本体（含全部 3,908 条 i18n 词条），`main` 是首页那条开场动画。判断依据是 `site-page` 里有 90 处 `keyframe`、181 处 `flag`（面板开关）、51 处 `秒`，以及成体系的校验错误文案；而 `main` 里有 138 处 `webgl`、72 处 `fragmentShader`。

**sourcemap 不可得**：两个 `.js.map` 均 404，bundle 尾部无 `sourceMappingURL`。所以路线 A 的天花板就是"读 minified 字符串"——但因为 i18n 词典和模板字符串被原样保留，天花板意外地高。

### 1.2 最高价值的命中：i18n 词典即功能清单

`site-page` 里内联了 **3,908 条去重后的 `中文键: \`English\`` 对**（中文键 3,886 条）。这不是营销文案，而是**产品每一个边界条件的报错原文**，等于一份免费的产品规格书；按主题切片即可还原功能面。其中导出性能报告那一簇直接暴露了管线阶段划分：

```text
处理 {0} · 截图 {1} · 解码 {2} · 编码延迟 {3}
采样起点后：开始 {0} / 图像就绪 {1} / 编码产出 {2} · PNG {3} B · 编码包 {4} B
图像逐帧写入文件，单帧耗时包含写入等待。
本机单帧处理统计至提交给编码器；音频混音单独记录。
```

"截图""PNG 字节数""编码包字节数"同时出现且**逐帧**统计——已排除"实时录屏"和"GPU 直出"两种可能。

### 1.3 渲染无关但架构关键的命中

**首页开场动画的真实实现**（`main`，偏移 710,372 附近）。它是一段被内联的 HTML 骨架 + 一份 fluent DSL 源码串：

```js
Yg = [
  `mh.layer("plate.bg").fill("#0c0c0d").grain(.12)`,
  `mh.layer("rock.shards").tex("rock_dark").skew(22)`,
  `mh.layer("halftone").dots({ size: 9, alpha: .5 })`,
  `mh.layer("strips").tex("stone").skew(22)`,
  `const ball = mh.ball(.27).drop().bounce(3)`,
  `mh.layer("stroke.a").trail(ball, 1)`,
  `mh.layer("stroke.b").trail(ball, 2)`,
  `mh.layer("stroke.c").trail(ball, 3)`,
  `mh.layer("sun").from(ball).fill("#FF6A1A")`,
  `mh.layer("lines").stroke(1).accents("#FF6A1A")`,
  `mh.layer("type").text(BLOCKS).track(.42)`,
  `mh.compose(layers).render()`,
]
```

这十二行就是首页十个图层的**作者视角**（`plate.bg / rock.shards / halftone / strips / stroke.a-c / sun / lines / type`）。注意这是**营销页自绘的伪 API**——`mh.` 前缀是品牌叙事，不是真 SDK（真 SDK 是 §6.1 的 `defineComponent`/`Layer`）；真入口名也不是 `compose.ts`，而是 `mh.json` 的 `entry`。它被渲染成"左侧代码打字、右侧画面同步生长"的动效。

同页还有一条**秒制时间轴表**（偏移 641,819），格式 `[起秒, 止秒]`：

```js
Q = {
  tokens:[3,8.5], ids:[9.5,15], embed:[15,23], dissolve:[23.2,26.6],
  expertWake:[25.2,26.4,29.2,31.2], code:[39.5,41,64,66],
  fieldReveal:[22.4,31], expertLight:[27,.6], collapse:[65,72],
  decay:[74.5,79], logo:[76,79.5], logoShift:[76.2,80],
  wordmark:[76.7,80.2], arc:[81,83], term:[82.2,83.4],
  sceneEnd:80.5, end:84
}
```

**这是整条 84 秒开场动画的分镜表，单位是秒。** 官方自己写首页也用秒制，和 SDK 的时间模型完全一致——这是个有说服力的旁证。

**"tokens / experts / layers" 三块面板的数据源**（偏移 716,372）：

```js
`tokens ${String(i).padStart(2,'0')} · d_model 4096\nexperts ${a}/${V?V.NCELL:32} · top-2\nlayers ${String(o).padStart(2,'0')}/10 · frame ${String(Math.floor(e*2.4)).padStart(3,'0')}`
```

`frame` 是 `e*2.4`（每秒 2.4 "帧"）。**结论：`d_model 4096` 与 `top-2` 是营销 HUD 的装饰数字，不是产品参数。** 排除依据：`experts 12/32` 的分母来自常量 `V.NCELL:32`，分子来自 `Math.round($(e,25,31)*V.active.length)`，纯按时间插值。

### 1.4 "未上线功能"的泄露

bundle 里有几条明确的**未发布**痕迹：

```text
模板社区还没上线，之后可以在这里找模板、分享模板。
打开本地 MHC 工程暂未开放
工程与历史待开放
模板尚未提供这个控件，可在 PRO 中查看工程。
```

`MHC`（预编译工程格式）是已实现导出、但本地打开入口尚未开放的状态。

### 1.5 API 端点与版本

- bundle 内 `/api/` 命中 **0 次**。前端不直连业务 API，全部走宿主 IPC。
- 唯一的服务端地址不在 bundle 里，而在 runtime README：`https://api.motionharness.top/v1/events`（匿名遥测，可用 `MH_TELEMETRY_ENDPOINT` 覆盖）。
- bundle 内 `0.1.`/`0.2.` 版本字面量 0 命中；版本由宿主注入。

---

## §2 源码仓库可达性（路线 B 结论：不可达，且是"私有"而非"限流"）

GitHub 仓库 `VibeMG/vibe-motion-graphics` **确实存在，但是私有的**。证据是 npm 元数据自己写明的：

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/VibeMG/vibe-motion-graphics.git",
  "directory": "products/cli"
}
```

而匿名侧所有入口均拒绝：

| # | 路径 | 结果 |
| --- | --- | --- |
| B1 | `api.github.com/repos/VibeMG/vibe-motion-graphics` | **404**（非 403 限流） |
| B2 | `github.com/VibeMG/vibe-motion-graphics`（网页） | 连接被意外关闭 |
| B3 | `codeload.github.com/.../tar.gz/refs/heads/main` | **404** |
| B4 | `git ls-remote` | `remote: Repository not found.` |
| B5 | `github.com/.../archive/refs/heads/main.zip` | **404** |
| B6 | `ghproxy.net` 镜像 | 403 |
| B7 | `api.github.com/orgs/VibeMG` / `/users/VibeMG` | 403（此时确为限流） |

**关键区分**：`git ls-remote` 返回 `Repository not found` 而非认证提示，API 返回 404 而非 403——这是**私有仓库对匿名者的标准响应**，再试不会成功。

**但路线 C 打开了更可靠的门**：`@motionharness/cli` 在 npm 上**公开可下载**，其内嵌 runtime payload 带着**未混淆的 SDK 类型定义与作者文档**。这条路比逆向 bundle 强得多——本报告 §3–§8 主要建立在它上面。

---

## §3 渲染管线还原

### 3.1 实证链条

四段原文，逐段锁定（`package.json` 的 description 也自述为 "Rust MotionHarness daemon and transient JavaScript build tooling"）：

**(1) 谁是宿主** — runtime `README.md`：
> "The executable contains the Rust daemon and embeds Studio, Core and transient Builder tooling. macOS and Windows also embed standalone LGPL FFmpeg/ffprobe. Linux uses FFmpeg/ffprobe on PATH. **CDP uses chromiumoxide.**"

**(2) 谁在渲染** — `skills/mh-author/SKILL.md` 与 `pro/references/rendering.md`：
> "`time` is absolute project seconds: repeated, backward and skipped times must give the same frame."
> "Every animation is driven entirely by MotionHarness time. A 3-second composition samples 90 frames at 30 FPS and 180 at 60 FPS. Seeking back to a time must reproduce its frame independently of playback history."

**(3) 帧怎么出来** — 同上：
> "**PNG captures a complete browser frame without FFmpeg. MP4 sends complete PNG frames directly to native FFmpeg for H.264 or H.265 encoding.**"

**(4) 色彩与位深** — 同上：
> "The native encoder converts sRGB capture to Rec.709 and preserves straight alpha. **The capture source is 8-bit RGBA**; a ProRes container does not increase the precision of the authored image."

配套的 CLI 命令形状（`rendering.md`）：

```sh
mh preview --time <seconds> --output <output.png>
mh render .tmp/output.mp4 --json '{"start":2,"duration":1}'
mh render .tmp/overlay.mov --json '{"codec":"prores-4444","alpha":"straight"}'
```

### 3.2 文字版流程图

```
┌─ Agent 侧 ────────────────────────────────────────────────────┐
│ mh new / mh render / mh preview  （Node 薄壳 → 原生二进制）      │
└───────────────────────────┬───────────────────────────────────┘
                            │ argv + env
┌───────────────────────────▼───────────────────────────────────┐
│ Rust daemon  (MotionHarness.exe / MotionHarness)              │
│  · 会话管理（30 min idle 回收；空 daemon 10 min 退出）           │
│  · 资源解包：<payload-sha256>/ 到 %LOCALAPPDATA%\mh\cache-v2    │
│  · 起 vite/rolldown 构建（Node 只在这时被调用）                  │
│  · chromiumoxide (CDP) 驱动本机 Chrome                          │
└──────┬────────────────────────────────────┬───────────────────┘
       │ HTTP/静态服务                        │ CDP
┌──────▼──────────────┐          ┌──────────▼───────────────────┐
│ Studio (React 19)   │          │ 工程页面 (隔离进程)             │
│ site-page-*.js      │          │ src/*.tsx → 构建产物            │
│ · 面板/时间线/标记   │          │ · three.js / R3F / Canvas 2D   │
│ · 与用户交互         │          │ · 只认 MH 秒，seek 幂等         │
└─────────────────────┘          └──────────┬───────────────────┘
                                            │ 每帧：setTime(t) → 等 GPU 屏障
                                            │       → 页面级截图 (8-bit RGBA)
                                 ┌──────────▼───────────────────┐
                                 │ 逐帧 PNG（完整浏览器帧）        │
                                 └──────────┬───────────────────┘
                                            │ 管道
                                 ┌──────────▼───────────────────┐
                                 │ 原生 FFmpeg（内置 LGPL 构建）   │
                                 │ H.264 / HEVC / ProRes 4444    │
                                 │ sRGB → Rec.709, straight alpha│
                                 └──────────┬───────────────────┘
                                            ▼
                                    .mp4 / .mov / .gif / .webp
                                    / .apng / .png / .zip / .wav
```

### 3.3 bundle 侧的交叉印证（与上面完全一致）

`site-page` 里的报错文案独立复现了同一套结构：

| 文案 | 指向 |
| --- | --- |
| `导出浏览器在捕获前已关闭` / `导出渲染器长时间没有进展` | **可关闭的浏览器实例 + 带看门狗的渲染器**，是独立组件 |
| `宿主截图尺寸与导出请求不一致` | 截图由**宿主**发起，且尺寸要协商校验 |
| `无法锁定浏览器捕获帧率和鼠标策略` | 需要**固定帧率、禁用输入干扰** |
| `当前浏览器不支持 MotionHarness 确定性逐帧导出` | "确定性"是产品的第一性约束 |
| `准备帧时 WebGL 上下文已丢失` / `GPU 输入属于另一帧或已过期` | 每帧有**独立的 GPU 作用域** |
| `帧纹理已过期；请在 draw 中等待 snapshot() 完成` | SDK 暴露的是 `snapshot()` 而非 `toDataURL()` |

`当前工程运行页需要支持页面隔离的桌面 Chromium 浏览器（131 或更新版本）` 尤其重要——工程页面跑在**独立的、需要 Chromium 131+ 隔离能力**的进程里，这是"确定性"的工程前提（隔离同源干扰与用户当前页面的状态污染）。

### 3.4 为什么不用 Remotion / Puppeteer

- 两个 bundle 里 `remotion` / `puppeteer` / `chromium`(字符串) / `ffmpeg` 命中数**全为 0**；runtime 依赖清单里也没有 puppeteer / playwright。
- `README.md` 明说 CDP 走 **Rust 的 chromiumoxide**，Node 只在构建时出现。

所以：**它不是 Remotion 那套（React 组件 + 内置渲染器），也不是 Puppeteer 逐帧（Node 侧控制）。它是"原生守护进程 + CDP + 逐帧 PNG + FFmpeg"的自研管线。** 与 Remotion 最本质的差别在**帧的产出方式**：Remotion 取 canvas/`toDataURL`，MH 走**页面级截图**——因此能捕获 CSS、SVG、DOM 文字、iframe 等一切非 canvas 内容，代价是每帧一次全页合成。

---

## §4 时间模型对照：浮点秒 vs 我们的 `CompositionPlan`

### 4.1 它的模型（实证）

**核心原则**（官网原文 + i18n 双份确认）：
> "源码、作品数据与素材分开保存。动画由统一的秒制时间驱动，预览与导出使用相同的创作语义。"
> `动画时间以秒为准，调整 FPS 不改变时长或关键帧时间。`
> `修改 FPS 不改变作品的秒数时间。`

**类型定义**（`@motionharness/sdk`）：

```ts
export interface InstanceTiming {
  start: number;
  duration?: number;  // Input seconds before timeRemap at the window start. Omitted means zero.
  offset?: number;
}
export interface CompositionSchema {
  settings: { width: number; height: number; fps: number; duration: number };
}
```

`duration` 是**秒**。`mh.json` 同样：

```json
{ "projectType": "standard", "entry": "src/scene.js",
  "width": 1920, "height": 1080, "duration": 8, "fps": 30 }
```

**帧只是采样结果，不是一等公民**：3 秒是真相，90/180 是投影。**约束**：时长 `0–3600 秒`、FPS `1–120`；`导出帧范围超出数值精度` 说明出帧时**显式做了浮点到整数的越界检查**。**seek 幂等是硬契约**——只要 `f(t)` 是纯函数，就能任意顺序、任意并发地采样。

### 4.2 我们的模型

我们的 `CompositionPlan` 用**整数帧 + 有理数帧率**：时间不是浮点秒，而是"第 N 帧"这个精确整数；帧率以有理数保存（如 30000/1001），任意时刻都能用整数运算精确表达，不存在 `0.1+0.2` 问题。

### 4.3 正面对照

| 维度 | MotionHarness（浮点秒） | 我们（整数帧 + 有理数） |
| --- | --- | --- |
| 时间的真身 | `number` 秒（IEEE-754 双精度） | 整数帧号 + 有理数 fps |
| 精确性 | 受浮点误差影响；靠出帧时校验兜底 | 天生精确，无累积误差 |
| 帧边界判定 | `floor(t * fps)` 有边界歧义风险 | `n` 就是 `n`，无歧义 |
| 变速/时间重映射 | 天然连续，曲线形状任意 | 需换算，非整数倍速要落到帧上 |
| 音频对齐 | 天然对齐（音频本就是连续时间） | 需 48000/fps 的采样换算 |
| 改 FPS | 时长不变（明确承诺） | 时长不变（帧号需重算） |
| NTSC 29.97 | 只能靠小数近似 | `30000/1001` 精确 |
| 与人类沟通 | 「第 2.28 秒」直接可读 | 「第 68 帧」需换算 |
| 渲染器实现 | 需浮点容差比较，易出 off-by-one | 整数索引，天然稳定 |

**它的选择只在它的语境里对**：MH 的核心场景是"Agent 写代码 + 用户拖参数"，时间必须对人类和 LLM 都可读，且要支持任意时间曲线、音频拉伸、变速重映射——浮点秒最自然；它用出帧时的整数化检查把风险挡在边界上。**我们的选择代价不同**：整数帧在帧精确剪辑、与达芬奇的帧对齐、多次往返不漂移上更优，代价是连续域操作来回换算、有理数 fps 跨工具易被"简化"成小数。

**真正值得抄的一点**：它把"**FPS 是输出设置、秒是创作语义**"划得非常干净，并写进了 UI 文案和文档。我们若把 `CompositionPlan` 里的"创作时间"与"输出帧率"显式分层（而非让帧号既当创作单位又当输出单位），就能同时拿到两边优点：内部整数无误差，对外可自由改帧率。这是本次调研对我们最有直接价值的一条。

---

## §5 `document.json` 字段还原

这次拿到了**完整 TypeScript 接口**（`@motionharness/core` 的 `dist/composition/document.d.ts`），不是推断。

### 5.1 顶层结构

```ts
export interface CompositionDocument {
  version: 1 | 2 | 3 | 4;
  compositionId: string;
  rootInstanceId: string;
  revision: number;
  settings: CompositionSchema["settings"];        // { width, height, fps, duration }
  instances: Record<string, CompositionInstance>;
  layerOrder?: string[];                          // 前到后的层级显示顺序
  cameraInstanceId?: string;
  assetLibrary?: AssetLibrary;
  timeMarkers?: Record<string, TimeMarker>;       // AI 标记就存在这里
  markerTypes?: Record<string, string>;           // 颜色 → 标记类型名
  title?: string;
}
```

### 5.2 实例（图层）结构

```ts
export interface CompositionInstance {
  componentId: string;
  name?: string;                    // 保存的图层名，与列表位置、渲染内容无关
  visible?: boolean;                // 缺省即可见；不是动画轨道
  values: Record<string, ParameterValue>;      // 参数的当前值 ← 用户手调的结果
  tracks: Record<string, {                     // 参数 → 关键帧轨道
    keyframes: ParameterKeyframe[];
    loop?: AnimationLoop;
  }>;
  drivers?: Record<string, "keyframes" | "static">;
  timing: InstanceTiming;           // { start, duration?, offset? } 全秒
  timeRemap?: TimeRemap;            // 时间重映射曲线
  sounds?: InstanceReference[];     // 非视觉子实例（音频）
  elements?: InstanceReference[];   // 宿主渲染的视觉子内容（仅合成根接受）
  linkedVideo?: true;
  fadeWindow?: { start: number; end?: number };
}

export interface ParameterKeyframe {
  id: string;
  time: number;                     // 秒
  value: EditableValue;
  easing: ParameterEasing;          // 命名缓动 或 {type:'cubic-bezier', x1,y1,x2,y2}
}
```

### 5.3 值域

```ts
type EditableValue = null | GeometryValue | EffectInstance[] | TableRow[]
                   | string | number | boolean | TransformValue | AssetReference;
type ParameterKind = "geometry" | "effects" | "table" | "text" | "color" | "number"
                   | "boolean" | "select" | "component" | "component-list"
                   | "transform" | "asset";
```

### 5.4 设计上值得注意的四点

1. **`values` 与 `tracks` 分离**：静态值和关键帧动画不共用一个容器。这直接支撑了"参数隔离"——`values` 是用户领地，`tracks` 是动画领地。
2. **`revision` + `expectedRevision` 的乐观并发**：文档里每一个编辑函数签名都带 `expectedRevision: number`。这是它敢让 Agent 和人同时改同一文件的前提（对应 i18n 的 `外部工程已变化；当前修改仍保留，请处理冲突`）。
3. **`drivers` 区分计算驱动与静态**：对应 `计算驱动的输出为只读；请先烘焙再添加关键帧`。计算得出的值不能直接打关键帧，必须先 bake。
4. **`visible` 不是动画轨道**：注释明写 `not an animation track`。删除请求走的是标记的 `intent`，不是把 `visible` 设 false（见 §7）。

---

## §6 「代码与参数隔离」机制还原

这是它最核心的工程承诺，也是我们最该学的一节。它在官网被拆成四句话：

> `源码、参数、素材分开放`
> `手调参数不写回源码`
> `参数与源码同时生效，互不覆盖`
> `Agent 改源码：参数保留`

### 6.1 机制：三个文件，两条写路径

```
project/
├── mh.json          ← 工程清单（settings、entry、audio[]），少量人可改
├── src/             ← Agent 领地：React/TSX 源码，声明"开放哪些参数"
└── document.json    ← 用户领地：参数值、关键帧、时间、标记、层级顺序
```

**源码只声明"参数的形状"，不存值**：

```tsx
const Title = defineComponent({
  id: 'title',
  parameters: {
    text: field.text({ label: '标题', default: '新品发布' }),
    ...basicTransformParameters({ animations: { y: { keyframes: [...] } } }),
  },
  component(values) {
    return <Layer bindings="parameters" value={basicTransformValue(values)}><h1>{values.text}</h1></Layer>;
  },
});
```

`field.text({label, default})` 声明的是**类型 + 默认值 + 展示名**。用户拖动后，真实值写进 `document.json` 的 `instances[id].values['text']`，**源码里的 `default: '新品发布'` 一个字都不改**。合并语义即：

```ts
最终值 = document.json.instances[id].values[p]
       ?? schema.components[componentId].parameters[p].default
```

**document 优先、源码默认值兜底**。两侧互不覆盖：Agent 改 `default` 只影响"从未被用户碰过的参数"，用户改值只写 document。这正是 `参数与源码同时生效，互不覆盖` 的实现。

### 6.2 为什么这个设计成立：`componentId` 是稳定锚点

`CompositionInstance` 存的是 `componentId`（字符串），不是组件引用、文件路径或 JSX 树位置。作者文档要求：

> "`field.component` references the reusable component definition, not a string lookup or a JSON tree. **Keep declaration IDs stable across implementation changes.**"

只要 Agent 重写 `Title` 的内部实现、换布局、甚至换渲染技术（DOM→Canvas），只要 `id: 'title'` 与参数名不变，用户调过的值就**自动继续生效**。这是"隔离"成立的真正原因：**锚点不是代码位置，是声明式 ID**。

但 `Keep declaration IDs stable` 只是文档纪律，不是运行时保证——**这是我们视角下的明确脆弱点**：ID 一旦被 Agent 改掉，用户参数会静默丢失，且据现有证据没有迁移机制兜底。

### 6.3 边界情况：参数被删了怎么办

bundle 里有对应的失败态文案，说明它是显式处理的而不是崩溃：

```text
找不到参数 / Unknown parameter
编辑目标为未知参数或结构参数
对应属性已不存在，可在 PRO 中查看工程。
此图层未定义该参数，已保留原值
```

### 6.4 "开放参数"是产品概念，不只是技术概念

> `界面可调整的内容，由工程开放的参数决定。需要增加新效果时，可以继续让 Agent 修改。`

**Studio 里能点什么，完全由源码里的 `field.*` 声明决定。** 没声明的属性在 UI 上不存在（`此图层未开放画布拖动，已开放的参数可在属性面板编辑` / `虚线框表示已选中，但此对象的变换由代码计算或未开放拖动`）。这把"Agent 该写多少"从技术限制变成了可协商的产品决策——这条比机制本身更值得借鉴。

### 6.5 与 Standard / Pro 双模式的关系

| | Standard | Pro |
| --- | --- | --- |
| 源码形态 | 一个 `export default function({root,...})` 返回 `{prepareFrame, dispose}` | `defineComponent` + `defineComposition` |
| 需要 SDK | **不需要** | 必须 |
| 可调参数 | 无（画面由源码决定） | 有，`field.*` 声明 |
| 时间线 | 只有音频轨 | 完整图层/关键帧 |
| 说法 | `Standard 的画面、尺寸、时长和声音由工程源码决定，请让 Agent 修改源码来调整。` | — |

**Standard 是"隔离"的退化情形**：没有 `document.json` 的编辑语义，一切归源码。这解释了它为何敢把"改参数"当 Pro 的卖点——升级 Pro 就是把"隐式在代码里的量"显式化成 `field.*` 声明。转换是**手动的**：`There is no automatic converter, mode switch or bidirectional synchronization.`

---

## §7 「AI 标记」机制还原

### 7.1 存储：`document.json` 的 `timeMarkers`

标记不是旁路文件，就存在文档里（`CompositionDocument.timeMarkers?: Record<string, TimeMarker>`），因此天然跟随 `.vmg` 打包、Checkpoint 快照、revision 冲突检测。

### 7.2 完整类型（实证，`@motionharness/sdk/dist/time-markers.d.ts`）

```ts
export type TimeMarker = {
  id: string;
  readonly number?: number;        // 内核发放的展示编号 "#7"，全工程唯一、永不复用
  label: string;
  notes?: string;
  attachments?: readonly MarkerAttachment[];   // 用户加的文件，按 1 起编号
  screenshot?: AssetReference<'image'>;        // 宿主截的帧，Studio 里隐藏，与用户附件严格分离
  color?: string;                  // #RRGGBB
  kind?: string;                   // 由 markerTypes 调色板解析
  origin?: string;                 // 'user' | 'agent' | ...
  lineageId?: string;
  target?: MarkerTarget;
  anchor?: MarkerAnchor;           // 全局合成像素坐标（点 或 矩形）
  readonly requestVersion?: number;// 内核持有，独立于 document revision
  readonly context?: MarkerContext; // { documentRevision, name, componentId, value, field }
  readonly intent?: { kind:'delete-instance'; restoreVisible: boolean }
                  | { kind:'delete-standard-audio'; ...; restoreMuted: boolean|null }
                  | ProEditIntent;
  onResolve?: 'keep' | 'delete';
  readonly completion?: { requestVersion: number; summary?: string };
} & (
  | { timeSpace:'project'; start:number; end?:number }
  | { timeSpace:'source';  start:number; end?:number;
      source:{ instanceId:string; asset:AssetReference<'audio'|'video'>; stream:number; duration:number } }
  | { timeSpace:'object';  target: MarkerTarget }        // 无时间关联，纯对象备注
);
```

### 7.3 定位方式：语义 ID 优先，坐标只是提示

`MarkerTarget` 是**语义定位**：

```ts
type MarkerTarget =
  | { kind:'instance';  instanceId: string }
  | { kind:'component'; componentId: string }
  | { kind:'timing';    instanceId: string; channel: 'timing' | 'time-remap' }
  | { kind:'parameter'; instanceId: string; parameter: string;
      effectId?: string; name?: string; rowId?: string; column?: string };
```

类型注释里有一句我认为是全案最关键的设计说明：

> `/** Stable semantic location; coordinates alone never identify an object. */`

而 `anchor`（画面坐标）的注释明确它只是"箭头尖端在哪/矩形框住哪些像素"，且是**全局合成像素、与命中对象的 transform 无关**。两者是**分工**而非冗余：语义 ID 说"改谁"，坐标说"改哪里"。

UI 文案与之呼应：

> `AI 优先根据时间、画面位置和备注定位，关联对象仅供参考。`
> `画面坐标和时间会跟随标记保存。`

**这是个很聪明的取舍**：Agent 不需要解析画面就能知道改哪个参数（省 tokens、抗误判），坐标仍保留供人复核。

### 7.4 三条时间语义：project / source / object

| `timeSpace` | 含义 | 典型场景 |
| --- | --- | --- |
| `project` | 工程时间轴上的秒 | "2 秒切到全息三维场景" |
| `source` | 素材原件内的时间（带 `stream` 选音视频轨） | "这段配乐第 3 秒的鼓点太抢" |
| `object` | 无时间，纯对象备注 | "把这个组件圆角改大" |

三者不能混，因为一个素材实例在工程时间线上可能**出现多次**（时间重映射/循环），标记必须说清指的是"第 2 秒"还是"原件里第 2 秒"。

### 7.5 Agent 怎么读到：两条路

**路一：CLI 轮询（被动）** —— `mh marker list` 读、`mh marker complete` 回写。`requestVersion` 由内核持有、独立于 `document.revision`，完成时须**原样回传**，过期直接拒——防止 Agent 处理了一个已被用户改过的标记。

**路二：Agent Hook 自动注入（主动）** —— `mh hook install --agent codex`（也支持 `claude-code` / `kimi-code`）。README 原文：`Each new user message can then include the current MotionHarness project's pending markers and layer deletion requests. **This does not start conversations.**` bundle 侧对应文案：

```
在你向 Agent 发送新消息时，自动提供当前工程的待处理 AI 标记，包括图层删除请求。不会主动发起对话。
支持 Codex、Claude Code 和 Kimi Code。
多个 Agent 会收到同一批标记，请避免同时修改同一工程。
```

**这是个很克制的设计**：Hook 只在**用户发消息时**顺带注入，绝不主动唤起 Agent——避免"AI 自己跟自己聊"的失控与计费意外。

### 7.6 把"删除图层"也建模成标记

`intent.kind = 'delete-instance'` 且带 `restoreVisible: boolean`。UI 文案：

> `此标记用于删除图层。Agent 验证图层已删除后会自动清理；取消标记会恢复原可见状态。`

**这解决了一个真问题**：用户想删的图层，其结构由组件代码定义（`此图层的结构由组件代码定义`），Studio 不能直接删。于是"删除"被降级成"一条待办意图 + 一个可撤销的可视状态"，等 Agent 改完代码再确认。审核闭环（`Agent 确认 AI 标记` / `已接通`）也建在同一个对象上。

### 7.7 `onResolve` 与 `completion`

`onResolve: 'keep' | 'delete'` 让每条标记单独设置"AI 处理完是否保留"（`勾选后，Agent 确认完成任务时仍保留这条标记；未勾选则自动移除。`）；`completion: { requestVersion, summary? }` 让完成记录带版本号，防止对旧指令误确认。

---

## §8 技术栈清单（全部为 runtime `package.json` 实证）

### 8.1 前端 / 编辑内核

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| `react` / `react-dom` | 19.2.8 | Studio 与工程页面 |
| `three` | 0.180.0 | 3D 与 GLSL 渲染 |
| `@react-three/fiber` | 9.8.1 | three 的 React 绑定 |
| `@dimforge/rapier3d-compat` | 0.12.0 | 3D 物理 |
| `@tweenjs/tween.js` | 23.1.3 | 补间 |
| `zustand` | 5.0.15 | 状态管理 |
| `@soundtouchjs/core` + `interpolation-strategy-lanczos` | 2.1.1 | **变速不变调**（对应"保持音高"文案） |
| `mediabunny` | 1.60.0 | 媒体封装/解封装（WebCodecs 生态） |
| `fflate` | 0.8.3 | ZIP（`.vmg` 打包） |
| `meshoptimizer` | 0.22.0 | 网格压缩 |
| `radix-ui` | 1.6.7 | 无障碍 UI 原语（全套 `@radix-ui/*`） |
| `lucide-react` / `tailwind-merge` / `clsx` / `cva` | — | 图标与样式组合 |

### 8.2 构建（"瞬时 Builder"）

`vite 8.2.2` · `rolldown 1.2.5`（+ win32-x64-msvc binding） · `esbuild 0.28.1` · `lightningcss 1.33.0` · `postcss 8.5.26` · `typescript 5.9.3` · `jiti` / `yaml` / `nanoid` / `picomatch` / `tinyglobby`

### 8.3 内部包（monorepo 结构）

| 包 | 版本 | 位置 |
| --- | --- | --- |
| `@motionharness/core` | 1.0.0 | 编辑内核（document/composition/keyframes/markers/audio…） |
| `@motionharness/sdk` | 0.1.4 | 作者 API（`defineComponent`/`field`/`Layer`/`three`/`host`） |
| `@motionharness/project-format` | 1.0.0 | `mh.json`、`.vmg`/`.mhc` 归档 |
| `@motionharness/builder` | 1.0.0 | 构建与诊断 |
| `@motionharness/studio` | 1.0.0 | Studio 前端 |
| `@motionharness/ui` | 1.0.0 | 设计系统 |

**版本号断层**：内部包全 `1.0.0`、SDK `0.1.4`——内部包走独立版本线，SDK 是唯一对外发布的。

### 8.4 宿主侧（非 JS）

| 组件 | 证据 |
| --- | --- |
| Rust daemon | `The executable contains the Rust daemon` |
| chromiumoxide (CDP) | `CDP uses chromiumoxide` |
| 内置 FFmpeg / ffprobe（LGPL） | `include standalone LGPL FFmpeg and ffprobe` |
| 原生 PNG/APNG/WAV 写入器 | `PNG, APNG, PNG sequences and WAV use native writers` |
| 原生编码器 sRGB→Rec.709 | `The native encoder converts sRGB capture to Rec.709` |

### 8.5 关于 `GSAP`

**GSAP 不是它的依赖。** runtime 依赖清单里没有 gsap；两个 bundle 里 `gsap` 各只有 2 处命中，且都在**营销文案/示例代码**里：

```js
Nr = [{name:`Three.js`, style:`hologram`, line:`import * as THREE from 'three';`},
      {name:`GSAP`,     style:`paper`,    line:`import { gsap } from 'gsap';`},
      {name:`Canvas 2D`,style:`battle`,   line:`const ctx = canvas.getContext('2d');`},
      {name:`React`,    style:`pixel`,    line:`import { createRoot } from 'react-dom/client';`}]
```

它的实际含义是**"你的 Agent 想用什么就用什么"**：

> `只保留核心契约，React、Three.js、Canvas、GSAP 都由 Agent 自由发挥。预览、导出、标记和版本交给 MotionHarness，Agent 少做重复工作。`

这条对我们是重要情报：**它没有锁定动画库，而是锁定"时间必须由 MH 驱动"这一条契约**。任何动画库只要能被 `seek(t)` 驱动就合法。

---

## §9 明确区分：实证 / 强推断 / 猜测

### 9.1 实证（有原文或类型定义直接支撑，可直接引用）

| 结论 | 出处 |
| --- | --- |
| 宿主是 Rust 原生二进制，内嵌 Studio/Core/Builder；CDP 走 chromiumoxide | runtime `README.md`；`package.json` description |
| 逐帧产出完整浏览器 PNG，再交原生 FFmpeg；捕获源 8-bit RGBA，编码转 Rec.709 | `rendering.md` 两段原文 |
| 时间单位是秒、FPS 只是采样率；3 秒 @30/60fps = 90/180 帧；seek 必须幂等 | `InstanceTiming` 类型；`mh.json`；`rendering.md`；i18n 三处 |
| `document.json` 全部字段 | `document.d.ts` |
| `TimeMarker` 全部字段与三种 `timeSpace` | `time-markers.d.ts` |
| 参数值与源码默认值分离、document 优先 | `document.d.ts` + `authoring.md` + i18n |
| 内部包六个、版本线分离（内部 1.0.0 / SDK 0.1.4） | runtime `package.json` |
| GSAP 不是依赖，只是可选项 | 依赖清单 + 营销文案 |
| `d_model 4096` / `top-2` 是装饰数据 | `main` 中 `Math.floor(e*2.4)` 拼装串 |
| 仓库私有（非限流）；npm 包公开，latest 0.1.4 | npm `repository` 字段 + `git ls-remote` + registry 元数据 |

### 9.2 强推断（证据充分但未直接读到实现）

| 推断 | 依据 | 置信度 |
| --- | --- | --- |
| 每帧流程 = `setTime(t)` → 等 GPU 屏障 → CDP 截图 | `snapshot()`、`FrameScopePort.wait({mode:'capture'})`、`GPU 输入属于另一帧或已过期` 三处互锁 | 高 |
| 宿主与 Studio 之间是私有 IPC（非 HTTP REST、非 WS） | 全 bundle `WebSocket`/`postMessage`/`fetch(` 基本为 0；报错用语是 `工程宿主地址无效`、`与工程的连接已中断，正在重新连接…` | 高 |
| `.vmg` = ZIP，含 `manifest.json` + `work/{mh.json,document.json,src/,assets/}` | `fflate` 依赖 + `CompositionPackageManifest{format:'mh-project',version:2}` + MH2 已整理的 ZIP 校验文案 | 高 |
| `.mhc` = 预编译产物（不含源码），在浏览器内存中运行 | `包含已编译的动画……不包含原始源码` + `文件留在浏览器内存中，不会上传到服务器` + `工程超过当前 64 MiB 限制` | 高 |
| 截图走 CDP `Page.captureScreenshot` 或 `Page.startScreencast` | chromiumoxide 只提供这两条路径；`宿主截图尺寸与导出请求不一致` 说明有尺寸协商 | 中高 |
| 渲染是串行的单浏览器实例 | `允许捕获当前运行标签页` 单数语义；`导出渲染器长时间没有进展` 的看门狗 | 中 |

### 9.3 猜测（明确无证据，不可当事实用）

- **`d_model` / `top-2` 是否真的对应内部某种 MoE 或分块调度**：无证据。目前证据只支持"装饰数字"。bundle 里确实有 `当前预计分块数量：{0} 块/帧` 这类分块语义，但那是 GPU 渲染分块，与 `d_model` 无关。
- **原生二进制的模块划分**（daemon 是否复用同一进程做编码）：无法看二进制内部，只能从"Render renderer stopped making progress"推测有独立工作线程。
- **任务里提到的 `L00plate.bg` … `L09type.overlay` 这组类名**：我在两个 bundle 与两个 CSS 里对 `L0x`、`l0x`、`data-layer` 全部做过检索，**0 命中**。实际存在的是 `plate.bg / rock.shards / halftone / strips / stroke.a-c / sun / lines / type` 这九个语义名（§1.3），以及 CSS 里的 `ts-plate`、`tv-plate-bracket`、`tv-vapor-sun`。**`L00`–`L09` 的编号写法未能实证，可能来自其他文档的转述。**
- **`compose.ts` 是否为真实文件名**：`compose.ts` 只在营销页的代码面板标题里出现（`agent ▸ compose.ts`），是叙事道具；真实入口按 `mh.json` 的 `entry` 字段，默认 `src/scene.js`（Standard）或 `src/project.tsx`（Pro）。
- **遥测字段的具体内容**：README 说采集"command and run outcomes, Studio control clicks and keys outside text editors, versions, system details"，但具体 schema 未公开。

### 9.4 对我方最重要的一条结论

它整条管线的**唯一硬契约**是：**画面必须是 `f(t)` 的纯函数，t 以秒表示，seek 幂等。** 围绕这一条，它把"预览/导出/标记/版本"全部收进宿主，把"画什么"完全让给 Agent 和任意前端技术。这个切分方式比它选的任何具体技术都更值得学——因为**它允许未来换掉 three.js、换掉 React、甚至换掉 Chrome，而产品承诺不变**。
