# 帧驭 MotionHarness 官网拆解（MH1）

> 取证时间：2026-11-11 · 全站为纯 JS 渲染 SPA，本报告结论来自三类证据：
> ① headless Chrome + CDP 抓取的渲染后 DOM 文本；② 站点 JS 包内置的界面文案表（`site-page-BNU1-ELX.js` / `main-HiGcBKPY.js`，可提取 1685 条中英对照字符串）；③ 实拍截图。
> 凡属推断，正文直接标注「推断」。

---

## §0 三句话

**它是什么**：一个「CLI + Studio + 打包格式」的动画工程工具链——Agent 写 React/Three.js/Canvas/GSAP 源码，Studio 提供图层/参数/关键帧/曲线编辑，输出视频与 `.vmg`/`.mhc` 工程包。品牌名「帧驭 MotionHarness」，域名 `motionharness.top`，浙ICP备2026009289号-2。

**给谁用**：会用编程 Agent（Claude Code / Cursor 一类）做动效个人创作者与小团队，且已经在达芬奇里剪片；不是给纯 GUI 用户的 After Effects 替代品。

**和我们的插件有什么关系**：它不是插件，是**竞品级的容器与契约设计**。它把「源码 / 作品数据 / 素材」三层分开、用秒制时间驱动、用 `prepareFrame(time)` 一个函数定义可编辑性——这三条正是我们要在自己的插件里解决「Agent 改完人还能改」的核心命题，可以直接对照抄结构、而不是抄功能。

---

## §1 七章逐节拆解

`/home/` 的 `#act1`~`#act7` 不是七个独立 section，而是同一个 `<section class="tour">` 里七个空的 `<span class="tour-anchor">`，锚点 top 依次是 901/1801/2701/3601/4501/5401/6301（等距 900px）。七张卡片全部在 DOM 里常驻，靠滚动位置切换高亮——所以静态抓只拿得到屏幕上那一张。下表是从 `textContent`（含隐藏节点）逐章切出来的。

顶部章节条把 7 章分成两段：`01 开放工作台 02 03 04 | PRO 05 06 07`，底部进度轨两端写 `STANDARD` … `PRO`。**前四章标 STANDARD，后三章标 PRO**（`span.tour-eyebrow` 内的徽标文字）。全站没有任何价格，所以 STANDARD/PRO 至少在官网语境里是**能力分层**，不是套餐（见 §4）。

| # | 章节 | 层级 | 原文关键句 | 分步演示（DOM 原文） | 隐含的技术要求 |
|---|---|---|---|---|---|
| 01 | 开放工作台 | STANDARD | 「只保留核心契约，React、Three.js、Canvas、GSAP 都由 Agent 自由发挥。预览、导出、标记和版本交给 MotionHarness，Agent 少做重复工作。」 | 01 一句话交给 Agent / 02 技术栈随意选 / 03 只守核心契约 / 04 省下重复工作 | 必须有**唯一契约**才能"随意选栈"。页面同屏给出契约代码与 `mh.json`（见 §1 附注）。真实约束比"随意"窄得多 |
| 02 | AI 标记 | STANDARD | 「一键添加AI标记，想改什么画面、想改什么目标，顺口的事儿。」 | 01 点击画面添加标记 / 02 在标记里写修改意见 / 03 保存标记交给 Agent / 04 查看修改结果 / 05 在时间线上打标记 / 06 按标记切换画面风格 | 标记必须能**定位到画面元素或时间点**，并且能被 Agent 通过 CLI 读出来。文字抓不到 UI，但 i18n 里有 `点击画面、图层或参数，添加修改要求`、`Add AI marker to timeline at playhead (M)`，说明标记支持**三类锚点：画布 / 图层 / 参数**，外加时间线标记 |
| 03 | 版本管理 | STANDARD | 「你调过的参数和 Agent 做过的修改，都能在创作历史里查看，全部可回溯，人与AI真正协作」 | 01 打开版本 / 02 每轮修改都有记录 / 03 一键撤回 / 04 马上对比 | "谁改了什么"要求**变更来源可归因**（人 / Agent 两条写路径），"撤回"要求快照可恢复。i18n 侧对应 `Checkpoint`（`checkpoint requires the current runnable source and data`），且 `Project packages do not include checkpoint history`——历史不进 .vmg 包 |
| 04 | 导出与工程 | STANDARD | 「不仅支持常规视频导出，也可以把源码、作品数据和素材一起打包成 .vmg 文件，方便把工程交于他人。」 | 01 导出视频 / 02 保存工程副本 / 03 代码和素材一起打包 | 打包格式要有**版本化容器**并带素材校验。i18n 里 `.vmg` 出现 21 次，另有 `导出工程（.vmg）` / `保存工程副本（.vmg）` 两个入口，语义不同（导出 vs 存副本） |
| 05 | 界面编辑 | PRO | 「把需求告诉编程 Agent，让它创建 MotionHarness 动画工程。打开 Studio 就能选图层、调整开放的参数和拖动关键帧，接着改这段动画。」 | 01 让 Agent 拆分参数 / 02 图层管理 / 03 修改参数 / 04 拖动关键帧 / 05 调节曲线 | 只暴露**被声明为可编辑的参数**（"开放的参数"），不是全部源码变量。需要参数 schema + 关键帧轨道 + 曲线编辑器三件套 |
| 06 | 代码与参数隔离 | PRO | 「代码与参数隔离：你手调的参数写进作品数据，无需写回源码，从底层解决 Agent 修改与用户编辑的冲突。工程也因此更适合做成模板，配合**即将上线**的模板社区，让有价值的创意流动起来。」 | 01 源码、参数、素材分开放 / 02 手调参数不写回源码 / 03 Agent 改源码互不冲突 / 04 做成模板 流动起来 | 这是全站技术含量最高的一章，也是最实的一章。它是**数据分层**而非并发控制（§6 展开）。认知到"模板 = 同一份源码 + 每人自己的参数"这一步，说明产品设计是想清楚了的 |
| 07 | 达芬奇桥接 | PRO | 「MotionHarness与达芬奇工程双向连接 使用MCP 一句话产出口播带动效视频」+「动效片段与普通视频片段具备相同的编辑性，同时可快速找到对应的MotionHarness工程进行修改。」 | 01 从 Studio 发送 / 02 从片段打开工程 / 03 改好再更新 | 需要给素材写**溯源元数据**（哪段 media 来自哪个 MH 工程），并保证"更新影响该素材在工程中的全部引用"。i18n 原文：`Updating affects every use of this media in the current DaVinci Resolve project` |

### §1 附注：契约与工程清单（页面上真实出现的代码）

第 01 章的同屏演示给了两块硬信息，这是全站最有价值的技术披露：

```js
// src/scene.js  —— "只守核心契约"里的那个契约
export default function ({ root, width, height }) {
  const scene = build(root, width, height);
  return {
    prepareFrame(time) { scene.seek(time); },
    dispose() { scene.destroy(); },
  };
}
```

```json
// mh.json
{ "projectType": "standard", "entry": "src/scene.js",
  "width": 1920, "height": 1080, "duration": 8, "fps": 30 }
```

三个可直接抄的结论：

1. **入场签名的参数是 `{ root, width, height }`**，返回值只有两个方法：`prepareFrame(time)` 与 `dispose()`。也就是说"可编辑"的最小定义是「能按任意时间点 seek 到确定画面」，而不是"能播"。
2. `prepareFrame(time)` 收的是 **time（秒级浮点）**，不是帧号 `frame`。这一条把"秒制时间"落到了 API 层面，见 §3。
3. `mh.json` 里有 `projectType: "standard"` —— 与七章徽标同名。所以 STANDARD/PRO 很可能是**工程类型**（`projectType`）而非账号套餐；i18n 也能佐证：`已创建 Pro 工程 · 保留 Standard 原件`、`Split the character's position and size into adjustable parameters as a Pro project`。**推断：同一份动画可以从 Standard 工程"升级"为 Pro 工程，Standard 原件保留。**

---

## §2 首页开场动画的机制

### 入口与结构

`/` 是一个占满视口的暗色剧场（`scrollHeight` 10800px，即 9 章 × 1200px）。首屏是一个 WebGL 线框测地球（icosphere），中央写着「点击 驾驭动态」，右上角常驻「跳过动画 / EN / 声音」。点击必须用真实鼠标事件——我先后试了 `.click()` 和 `dispatchEvent`，都没能穿过闸门，最后用 CDP `Input.dispatchMouseEvent` 的 `mousePressed`/`mouseReleased` 才进去。进去后 HUD 立刻变成「暂停播放 / 跳过动画 / EN / 声音」，说明它本质是**一段带着播放控制的演出**，不是滚动驱动的章节阅读。

![](C:/Users/18149/AppData/Local/Temp/mh/s5.png)

进入后的九个章节（HUD 右下的伪 MoE 面板始终显示）：

| 阶段 | HUD 标记 | 画面在演什么 | 证据 |
|---|---|---|---|
| 01 PROMPT | `frame 000` 起 | 中文指令「请以帧驭 MotionHarness 的 Logo 为范本，制作一条开场动效」以打字机方式出现 | DOM 里该句重复出现两次（一处带 `To Agent：` 前缀），并被逐 token 包进 `span` |
| 02 TOKENS | `tokens 00` | 句子被切成 **15 个 token**：请/以/帧/驭/Motion/Harness/的/Logo/为/范本/，/制作/一条/开场/动效 | DOM 结构为 `请00000以00000帧00000…`，`00000` 是 token id 的占位 span |
| 03 TOKEN IDS | 同上 | 15 个 token 变成五位整数：11053 / 15576 / 97920 / 72911 / 56929 / 46496 / 51960 / 31593 / 59798 / 75683 / 33203 / 24035 / 78767 / 56655 / 27742 | 截图与 DOM 数字一致 |
| 04 EMBEDDING | `frame 049` | 15 行 × 16 列浮点矩阵，表头写 `token_id → E[token_id] ∈ ℝ⁴⁰⁹⁶ · 显示前 16 维` | 见下图，右侧竖标 `04 EMBEDDING` |
| 05 EXPERTS | `experts 6/32` | 32 个专家里 top-2 路由亮起 | HUD 计数器从 `0/32` 涨到 `6/32` |
| 06 WEAVE | `layers 03/10 · frame 113` | 线框图形被"编织"成几何层，右侧出现图层栈 L00~L09，左下浮出 `compose.ts` 源码 | 见下图 |
| 07 BOUNCE | — | 球形元素落地回弹，`bounce(3)` 生效 | `compose.ts` 第 05 行 |
| 08 COMPOSE | `layers 10/10 · frame 157` | 十层合成，Logo 成形（三个胶囊 + 橙色太阳圆） | 见下图 |
| 09 LOGO | — | 收尾 | — |

![](C:/Users/18149/AppData/Local/Temp/mh/x03.png)

### 它到底在演示什么

**结论：它把「一条自然语言指令 → 一条动画」包装成了一次「LLM 前向推理」的样子。** 但这个类比是**装饰性的**，不是真的：

- `d_model 4096`、`experts 0/32 · top-2`、`layers 00/10` 三个数字，与真实 MoE 模型对不上（10 层太浅、32 专家倒是合理），它们的真实含义是**动画自身的三个维度**：4096 是编出来的维度、32 是"专家"、**10 就是那十个图层 L00~L09**。`experts` 计数器一路涨到 `6/32`、`layers` 涨到 `10/10`，是动画进度条换了个皮肤。
- 十个图层名是真实的图层命名法，不是占位符：`L00plate.bg` / `L01rock.shards` / `L02halftone.grid` / `L03strips.slant` / `L04stroke.a` / `L05stroke.b` / `L06stroke.c` / `L07sun.orange` / `L08construct.lines` / `L09type.overlay` —— plate / rock / halftone / strips / strokes / sun / lines / type，正是画面里那几种元素的分类。
- 真正暴露产品设计的是左下角那份 **`compose.ts`**，它是"用代码写动效"的作者侧 API 演示：

```ts
01  mh.layer("plate.bg").fill("#0c0c0d").grain(.12)
02  mh.layer("rock.shards").tex("rock_dark").skew(22)
03  mh.layer("halftone").dots({ size: 9, alpha: .5 })
04  mh.layer("strips").tex("stone").skew(22)
05  const ball = mh.ball(.27).drop().bounce(3)
06  …
    mh.layer("stroke.a").trail(ball)
    mh.layer("sun").fill("#FF6A1A")
    mh.compose(layers).render()
```

这份代码在 06 WEAVE 时只写到第 5 行（`layers 03/10`），到 08 COMPOSE 时已经写满（`layers 10/10`）——**代码是随动画进度"被写出来"的，而不是先写好再播放**。这是一个很强的叙事选择：它在告诉你「Agent 写的是这一层代码，你看到的是它的执行结果」。

![](C:/Users/18149/AppData/Local/Temp/mh/x06.png)
![](C:/Users/18149/AppData/Local/Temp/mh/x08.png)

### 一段必须说清的话

`mh.layer()/mh.ball()/mh.compose()` 这套 DSL，**在站点任何文档里都找不到**。`/guide/` 五节没有一行 API 说明，全站也没有 SDK 文档入口（§6 细说）。所以这份 `compose.ts` 只能算**品牌叙事的道具**：它证明了"存在一套作者侧作者 API"这个产品意图，但不能作为可依赖的接口契约。谁要照着它写代码，会失败。

---

## §3 使用文档五节拆解

`/guide/` 的结构是 `01 安装与打开(#install) / 02 与 Agent 一起编辑(#agent) / 03 导出与分发(#export) / 04 桥接组件安装(#davinci) / 05 工程与时间(#project)`。全文 1394 字符，非常短——它是**入门五步**，不是参考手册。

### 01 安装与打开

- 双路径：`A Agent 调用`（复制一段提示词给你的编程 Agent）与 `B NPM`。
- 提示词原文：「请安装 MotionHarness（帧驭）的 CLI：`npm install -g @motionharness/cli`。运行 `mh doctor`，并阅读 `mh skill`。后续我会提供相关的需求，用于创建可编辑的动画工程」。
- NPM 页给出三行：`mh doctor` / `mh new ./my-motion` / `mh open ./my-motion --browser`。**注意 `mh new` 是官网正文里新出现、此前清单里没有的命令。**
- 平台：`Windows 10/11 (x64) · macOS (Apple Silicon) · Node.js 22.15+ · Chrome`。
- 一句关键的话：「命令返回后，工程会继续运行。关闭终端不会关闭 Studio。」——说明 **Studio 是一个常驻本地服务 + 浏览器界面**，CLI 只是启动器。这解释了 `.vmg` 为什么能"解包后打开"：它就是那个本地服务的工程目录。

### 02 与 Agent 一起编辑

原文只有两段，但信息密度最高：

> 「让 Agent 先阅读 `mh skill`，再描述想要的动画。Agent 修改 React 源码，你在 Studio 中调整开放的参数；**两边操作同一份工程**。」
> 旁边给出目录结构：`src/` React 源码 · `document.json` 作品数据 · 素材原件（随工程保存），以及命令 `mh inspect --project ./my-motion`。

**这句话的工程含义，逐层拆：**

1. **"同一份工程"是文件系统级共享，不是同步协议。** Agent 用 `Edit` 改磁盘上的 `src/*.jsx`，Studio 读写同一目录下的 `document.json`。没有消息队列、没有 CRDT、没有服务端。所以它天生只能做**单机、单人、顺序协作**——这也正好解释了 i18n 里那句警告：「多个 Agent 会收到同一批标记，请避免同时修改同一工程」。
2. **两条写路径被物理隔开，冲突才可能"不发生"。** Agent 只碰 `src/`，人只碰 `document.json`，素材各自加。三者交集为空，所以"Agent 改源码"和"人调参数"在字节层面永远不会写同一行——这是**用数据布局消灭冲突**，不是用锁或合并算法解决冲突。
3. **`open` 这个形容词是契约，不是形容词。** "开放的参数"意味着源码里必须显式声明哪些变量暴露给 Studio（`keyframeable`、参数 schema、默认值）。没声明的参数，人在 Studio 里看不到。所以 Agent 的工作量其实有两份：写动画 + **写参数暴露层**。第 05 章那步「让 Agent 拆分参数」就是这个意思。
4. **`document.json` 是"人改的东西"的唯一真相。** 它存的是参数值与关键帧，不含源码。所以 `mh inspect --project` 才能让 Agent 读到"人调了什么"——Agent 读 JSON，人读画面，两边认知对齐的媒介是这个文件。
5. **`mh skill` 是给 Agent 的说明书**，说明产品把"Agent 该怎么用我"当一等公民设计（一个能被 Agent 读取的 skill 文档），而不是写给人看的手册。这是"Agent 原生"这个口号里唯一有实体的部分。

### 03 导出与分发

- `mh render motion.mp4 --project ./my-motion` → 出片
- `mh pack motion.vmg --project ./my-motion` → 打包
- `mh unpack motion.vmg ./another-motion` → 解包
- `mh open ./another-motion --browser` → 打开
- 原文：「完整工程使用 `.vmg`，可继续编辑与分发。」

i18n 补充了官网正文没说的部分，很重要：**导出格式其实有两种**。
- `MotionHarness · 工程`：`{ "projectType": ... }` 源码工程，说明写的是「保留原始源码与工程数据，可交给 Agent 继续修改设计与功能。**需要完整源码和源码打包服务**」。
- `MHC · 即用工程`：`包含已编译的动画，可直接在支持 MHC 的编辑器中打开，继续调整参数、素材和关键帧；**不包含原始源码**`。

也就是说：`.vmg` 给协作者（能继续改代码），`.mhc` 给终端用户/模板买家（只能调参数）。**这个二分是产品商业化的地基**，但官网 `/guide/` 一个字都没提，只在首页第 04 章说"打包成 .vmg"。

### 04 桥接组件安装

- 「当前支持 **macOS 与 DaVinci Resolve Studio**，需启用本机外部脚本访问。」
- `mh bridge davinci install` / `mh bridge davinci doctor`
- 「桥接组件需要 Node.js 22.18+ 和 FFmpeg / ffprobe；**透明视频导出需要 FFmpeg 7 或更新版本**。」
- 「在达芬奇偏好设置中，将外部脚本使用设为"本地"。安装后保存工程并重启达芬奇。」
- 「侧栏入口是可选的。在**特效库**中搜索 MotionHarness，将桥接组件拖到已关联的动效片段上。也可以从"工作区 → 脚本 → Utility → MotionHarness 桥接组件"打开和更新工程。」

这里有一处**官网自相矛盾**，必须记下来：首页 hero 给的是 `Windows / macOS` 两个下载按钮（平台清单也写 Windows 10/11 x64），但 `/guide/` 第 04 节明写桥接「当前支持 macOS」。**Windows 用户装得上 CLI，但用不了达芬奇桥接。** 官网没有在 Windows 按钮旁做任何提示。

i18n 侧还能看出桥接的真实形态：它是一个 **DaVinci 特效（Effect）**，不是菜单脚本。原文 `Search for MotionHarness Bridge Component in the DaVinci Resolve Effects Library and drag it onto this animation clip to open the project from the inspector`。做法是**把动效渲染成带溯源元数据的视频素材**投进时间线，桥接组件挂在片段上，从检查器反查源工程。这与"双向连接"的说法一致：正向发素材，反向开工程。

### 05 工程与时间

全文只有两句：

> 「源码、作品数据与素材分开保存。动画由统一的**秒制时间**驱动，预览与导出使用相同的创作语义。」
> 「官网展示预设的创作流程。安装后，可在本地工程中与 Agent 协作。」

**"秒制时间"到底是什么：**

它不是"用秒当单位显示"，而是**时间的唯一权威是秒，帧只是采样网格**。证据是站点 JS 里那三条文案：

- `动画时间以秒为准，调整 FPS 不改变时长或关键帧时间。`（Animation uses seconds. Changing FPS does not change duration or keyframe times.）
- `设置输出尺寸与采样范围。修改 FPS 不改变作品的秒数时间。`
- `导出时长至少需要 1 帧（{0} 秒）` / `帧率必须在 1 到 120 之间` / `时长必须在 0 到 3600 秒之间`

配合 `prepareFrame(time)` 收浮点秒、`scene.seek(time)` 的实现，整条链是：**关键帧存秒 → 任意时刻可求值 → 导出时按目标 fps 去"采样"这条连续时间轴**。

**和帧制的区别（这条对我们最关键）：**

| 维度 | 帧制（我们的插件常见做法） | 秒制（MotionHarness） |
|---|---|---|
| 关键帧存储 | 帧号整数，如 `kf.frame = 96` | 秒，如 `kf.time = 3.2` |
| 改 fps 的后果 | 关键帧绝对位置不变 → 动画**时长与节奏整体漂移**。24→30fps 时，原来 4 秒的动画变成 3.2 秒，缓动全错 | 时长与节奏不变，只是采样点变密。**同一份工程可以同时出 24/25/30/60fps 的片** |
| 预览/导出一致性 | 预览常按屏幕刷新率跑，导出按 fps 逐帧，容易出现"预览顺、导出顿" | 预览与导出调用同一个 `prepareFrame(time)`，唯一差异是采样步长——这正是"预览与导出使用相同的创作语义"的物理含义 |
| 变速/时间重映射 | 帧号难以表达非线性映射 | 天然支持：文案里有 `播放时间 → 内容时间（秒）`、`速度点 · {0} 秒`、`定格请使用时间曲线`、`非线性时间映射` |
| 渲染确定性 | 依赖真实时间累加，容易受掉帧影响 | 每帧独立求值（`seek`），可**确定性逐帧导出**——文案原文：`当前浏览器不支持 MotionHarness 确定性逐帧导出` |

一句话：**帧制把"时间"记成了"第几格"，秒制把"帧"降级为"取景的密度"。** 后者才能在"Agent 改代码、人拖关键帧、导出给达芬奇、再出竖屏版"这条链上不返工。唯一代价是任何求值都必须**纯函数化**——`prepareFrame` 不能有状态、不能依赖上一帧，这也是契约里为什么只给 `prepareFrame` 和 `dispose` 两个方法。

---

## §4 账号与定价

`/account/` 全文（渲染后）只有这些：

> `MOTION HARNESS / WEB AGENT` · `Motion Hub`
> 「功能尚未开放，你可以先登录账户。」
> 「**CLI 已开放**」 · 「下载和使用 CLI 无需登录。」
> 「WEB AGENT 账户 / 登录你的账户 / 首次登录会创建账户。Web Agent 功能尚未开放。」
> 「使用 GitHub 登录」「使用 Google 登录」
> 「请记住本次使用的登录方式，不同第三方账号对应独立的帧驭账户。」

能查实的与查不到的：

| 问题 | 结论 | 依据 |
|---|---|---|
| 注册要什么 | 只要 GitHub 或 Google 账号，**没有邮箱注册、没有密码框**。页面只有一个 `select.language-switcher` 和一个"加入内测群"按钮，无任何表单字段 | DOM `input/button/select` 全量枚举，仅 2 个元素 |
| 有没有免费额度 | **页面上完全没有提**。全站无 `¥`/`$`/`元/月`/`免费试用`/`价格` 任何字样（对 `body.textContent` 全量正则） | 关键词搜索为空 |
| 登录端点 | `https://api.motionharness.top/auth/github/start`、`/auth/google/start`；站点 API base 硬编码 `https://api.motionharness.top`，且构建时校验必须为 HTTPS 纯 origin | JS 包内的 origin 校验与 `a[href]` |
| STANDARD / PRO 是什么 | **官网没有解释**。它只作为两个空标签出现：① 七章徽标（1-4 = STANDARD，5-7 = PRO）；② 首页进度轨两端。**没有任何对比表、价格或功能清单** | `span.tour-eyebrow`、`em` in `.tour-progress` |
| 我的判断 | STANDARD/PRO 是**工程/编辑能力分层**，不是订阅套餐。三条证据：`mh.json` 的 `projectType: "standard"`；文案 `已创建 Pro 工程 · 保留 Standard 原件`；`该字段包含 PRO 动画，请在 PRO 中调整`、`模板尚未提供这个控件，可在 PRO 中查看工程`。**推断：Standard = 模板/轻编辑（只能调预设控件），Pro = 完整 Studio（图层、关键帧、曲线、桥接）。** 是否收费、收多少，官网一个字没说 | 交叉推断 |

**结论**：这是一次**未商业化的公开发布**。账号系统壳子搭好了、第三方登录通了、API 域也上线了，但"Web Agent"这个真正的付费功能明确挂着"尚未开放"，模板社区写着"即将上线"。目前唯一能白嫖（也是唯一存在）的就是 CLI。内测群的入口是微信群/QQ群/Discord（`api.motionharness.top/community/config.json` 下发二维码，包含 `wechat` / `qq` / `discord` 三个字段；页面另有 `discord.gg/wzhwJAp8Q4`）。

---

## §5 技术名词总表

标「站」= 官网正文出现；标「包」= 只出现在站点 JS 的界面文案里（用户实际用到 Studio 时会看到）；标「芯」= 包内代码/校验逻辑暴露。

| 名词 | 出处 | 在什么上下文出现 | 说明 |
|---|---|---|---|
| React | 站 | 第 01 章技术栈标签；guide 02「Agent 修改 React 源码」 | 工程脚手架就是 React 应用，Studio 是它的宿主 |
| Three.js / Canvas 2D / GSAP | 站 | 第 01 章标签页切换 | 三种可选的渲染/补间方案，与 React 并列 |
| `src/scene.js` | 站 | 契约代码与 `mh.json` 的 `entry` | 动画的唯一入口模块 |
| `mh.json` | 站 | 第 01 章配图 | 工程清单：type/entry/width/height/duration/fps |
| `projectType` | 站 | `mh.json` 字段，值 `standard` | 与 STANDARD/PRO 徽标同名，指工程类型 |
| `document.json` | 站+包 | guide 02 目录图；包内 `参数 · document.json` | 作品数据：参数值与关键帧，人的写入口 |
| 素材原件 / `assets/` | 站+包 | guide 02；`assets must be an array` | 三层分离的第三层 |
| `.vmg` | 站 | 命令、第 04 章 | 完整可编辑工程包（源码+数据+素材） |
| `.mhc` | 包 | `MHC · 即用工程` | **编译后的即用工程，不含源码**，只能调参数/素材/关键帧 |
| Studio | 站 | guide 02「你在 Studio 中调整」 | 浏览器里的编辑器，本地服务常驻 |
| `prepareFrame(time)` / `dispose()` | 站 | 契约代码 | 可编辑性的最小 API：按秒 seek / 释放 |
| 秒制时间 | 站 | guide 05 | 时间权威是秒，帧是采样网格 |
| FPS / 输出 FPS | 站+包 | `mh.json`；导出面板 | 1–120，改它不改时长与关键帧时间 |
| 关键帧 | 站+包 | 第 05 章「拖动关键帧」 | 存秒不存帧；有唯一 ID，禁重复 |
| 曲线 / 缓动 / 贝塞尔 | 站+包 | 第 05 章「调节曲线」 | `Easing curve: time on horizontal, progress on vertical`；预设可转贝塞尔调手柄 |
| 时间曲线 / 速度点 / 定格 | 包 | `播放时间 → 内容时间（秒）` | **完整时间重映射**：非线性映射、变速、冻结帧 |
| 图层 / 组 | 站+包 | 第 05 章「图层管理」；L00~L09 | 有父子组；拖拽只能同组内换序；`工程根容器和摄影机不能删除` |
| 摄影机 / 作品镜头 | 包 | `The camera affects previews and exports` | 有输出镜头概念，受 SDK 版本约束 |
| AI 标记 | 站 | 第 02 章全章 | 锚点三类：画布/图层/参数 + 时间线标记（快捷键 M） |
| 版本 / Checkpoint | 站+包 | 第 03 章；`Checkpoint history` | 快照含代码与作品数据，**不进 .vmg 包** |
| 导出格式族 | 包 | MP4 / PNG 序列 / 单帧 PNG / GIF / WebP / APNG / WAV / **ProRes** | 透明视频与音频混音都在射程内 |
| 运动模糊 / 采样 / 快门 | 包 | `Live preview excludes export motion blur` | **实时预览不含运动模糊，只有导出才有**；采样数换平滑度换时间 |
| 逐帧耗时报告 | 包 | `Record per-frame timings`；`工程指纹` | 可导出/导入性能报告做对比，带工程指纹与导出设置校验 |
| 确定性逐帧导出 | 包 | `deterministic MotionHarness frame-by-frame export` | 与秒制+seek 直接相关，是整条时间设计的落点 |
| Render Graph / Pass | 芯 | `Render Graph 至少需要一个 Pass`、循环依赖检测 | 内部有渲染图调度，非简单后处理链 |
| WebGL2 | 芯 | `当前浏览器无法创建 WebGL2 渲染设备` | 渲染后端；GPU 层/纹理/预合成 |
| DOM 预合成到纹理 | 芯 | `Precompose DOM to texture` | 把 DOM 层烘成纹理再参与合成，第 01 章"DOM 当图层"的实现手段 |
| SDK 版本锁 | 包 | `保留工程锁定的 SDK 版本`、`需要 SDK {0}` | 工程绑定 SDK 版本，升级安装器不改变工程锁定版本 |
| Skill 版本 | 包 | `需要 Skill {0}` | **Agent 技能包也有版本要求**，与 SDK 并列校验 |
| 宿主协议 / 渲染协议 | 包 | `Incompatible host protocol` / `rendering protocol` | 工程与运行时有协议版本握手 |
| 桥接组件 | 站+包 | guide 04；`MotionHarness Bridge Component` | 达芬奇**特效**，拖到片段上，从检查器打开源工程 |
| MCP | 站 | 仅第 07 章标题 | 「使用MCP 一句话产出口播带动效视频」——**全站仅此一处，无任何文档** |
| FFmpeg / ffprobe | 站 | guide 04 | 桥接依赖；透明视频要 FFmpeg 7+ |
| DaVinci Resolve Studio | 站 | guide 04 | 需开启「外部脚本使用 = 本地」 |
| 工程指纹 | 包 | `Missing project fingerprint` | 性能报告与工程内容一致性校验 |
| `/v1/events` | 芯 | 站点 API 路径常量 | 埋点上报 |
| `community/config.json` | 芯 | `api.motionharness.top/community/config.json` | 下发微信群/QQ群/Discord 二维码，带缓存过期 |
| 模板社区 / 模板库 | 站+包 | 「即将上线」；`MotionHarness 模板库` | 明确未上线 |

---

## §6 哪些是营销话术，哪些是有工程实质的承诺

这一节不客气。判断标准只有一条：**能不能在站点自己的文案或代码里找到与口号匹配的机制**。找到了就算实质，找不到就算话术。

### A. 有工程实质（可以照着学，也可以当成竞品威胁）

**1. 三层数据分离 + 秒制时间 —— 全站最硬的东西。**
`src/`（源码）/ `document.json`（作品数据）/ `assets/`（素材）三级分家，配套秒制时间与 `prepareFrame(time)`。这不是口号，因为站点 JS 里有一整套**工程校验器**在替它兜底：`工程不允许保存素材路径；请使用 resourceId 和宿主资源绑定`、`素材 SHA-256 无效`、`关键帧 ID {0} 重复`、`渲染效果必须引用精确的效果 ID 和版本`、`keyframeable 必须是布尔值`。一个会校验 `keyframeable` 布尔类型、要求效果带版本号的系统，是真的把"可编辑性"当数据模型在建模，不是当文案在写。

**2. "手调参数不写回源码" —— 真的，而且方向正确。**
它的实现是数据分层而非并发控制（§3 已拆）。作为工程方案它成立且优雅：冲突在字节层面被消除。这一条我可以直接借鉴。

**3. 确定性逐帧导出。**
`当前浏览器不支持 MotionHarness 确定性逐帧导出` 这句报错说明它真的在做「同一时间输入 → 同一像素输出」，并为此锁浏览器帧率、锁鼠标状态（`Could not lock browser capture frame rate and cursor settings`）。这是把"预览即导出"从愿望变成约束的关键一步，也是绝大多数网页动效工具做不到的。

**4. 导出侧的专业度超出预期。**
MP4 / PNG 序列 / GIF / WebP / APNG / WAV 混音 / **ProRes** 七种输出；运动模糊只在导出生效（`实时预览不包含导出运动模糊`）；快门角度 + 每帧采样数；逐帧耗时报告可导出再导入对比（带工程指纹校验）。这套东西是给真正要交片的人准备的，不是给 demo 准备的。

**5. 版本与 SDK 双锁。**
工程锁 SDK 版本（升级安装器不动工程锁）、Agent 技能锁 Skill 版本、宿主协议/渲染协议双向握手。这是长期维护多版本工程才会有的设计。

**6. `.vmg` / `.mhc` 的双格式交付。**
「给协作者源码工程，给终端用户编译工程」——这是模板生意的正确切法，比"一键分享"高级得多。

### B. 是营销话术（别被带走）

**1. 「Agent 原生」——目前只是"给 Agent 写了一段安装提示词"。**
站点没有任何 Agent 运行时、没有 agent 协议、没有工具调用清单。所谓 Agent 原生 = ① 官网提供一段可复制的提示词；② `mh skill` 让 Agent 读说明书；③ CLI 可被 Agent 调用。这三件事任何 CLI 工具都能做到。真正决定体验的是你**自带哪个编程 Agent**（Claude Code / Cursor / Codex），不是 MotionHarness。

**2. 「技术栈随意选 / 不限技术栈」——不随意。**
`prepareFrame(time)` + `dispose()` + `mh.json` 已经把它钉死成"必须能按时间点无状态 seek 的 React 组件"。GSAP 那种"播放器推进时间线"的写法要改造成可 seek，Three.js 要自己保证资源释放，Canvas 要自己处理 DPR 与尺寸。而且 `mh.json` 里 `width/height/duration/fps` 是硬参数。**"随意"指的是渲染层，不是结构层。**

**3. 「从底层解决 Agent 修改与用户编辑的冲突」——"冲突"这个词用得太满。**
它解决的是**写冲突**（两人不写同一文件），没解决**语义冲突**：Agent 改了 `src/scene.js` 里某个参数的名字或删了图层，你 `document.json` 里指向它的关键帧就悬空了。证据是文案自己承认了这个洞：`对应图层已不存在，可在 PRO 中查看工程`、`对应属性已不存在`、`目标图层已不存在，等待 Agent 验证并完成此请求`。所以它是"把冲突从高频变低频"，不是"从底层解决"。

**4. 「多个 Agent 协作」——文案自己否了。**
`多个 Agent 会收到同一批标记，请避免同时修改同一工程`。也就是说并发场景直接劝退。而第 03 章「人与AI真正协作」正是拿这一点当卖点。**单机顺序协作**才是真实能力边界。

**5. 「MCP / 一句话产出口播带动效视频」——全站只有一句标题，零文档、零实现证据。**
`MCP` 在整站只出现在第 07 章的 H2 里，`/guide/` 的桥接章节从头到尾讲的是 CLI + 达芬奇脚本 + FFmpeg，没有任何 MCP server、工具列表、endpoint 或示例。**这是本次拆解里营销与工程落差最大的一处。** 口播带动效意味着语音识别/对齐/字幕驱动，站点没有任何相关产物。

**6. 「Web Agent / 模板社区」——自己写了"尚未开放""即将上线"。**
`Web Agent 功能尚未开放`（`/account/` 正文）、`模板社区 · 即将上线`（第 06 章）。这两句话很诚实，但也意味着**官网当前的"账号 + 模板 + 社区"整条叙事是空的**，能用的只有本地 CLI。

**7. 十章的伪 MoE（`d_model 4096` / `experts 0/32 · top-2`）——纯装饰。**
它是把动画进度伪装成模型推理的视觉隐喻。`layers 00/10` 恰好对应十个图层，`experts` 计数器只是进度条。**不要从这三个数字里推断任何模型能力。** 它演示的不是"AI 在生成"，而是"这条动画是用代码一层层搭出来的"——后者才是真话。

**8. STANDARD / PRO 无任何解释。**
两个徽标、零对比表、零价格。这不像套餐，更像工程能力分层（§4 推断）。**但它把分层信息藏在一个标签里、让用户自己猜，这本身是信息披露上的话术式处理。**

### C. 官网自相矛盾 / 需要官网答案的地方

1. **平台口径打架**：hero 给 `Windows / macOS` 两个按钮、平台清单写 `Windows 10/11 (x64)`，但 guide 04 明写桥接「当前支持 macOS」。Windows 用户买了/装了却用不了桥接，官网无一字提示。
2. **`/guide/` 只说 `.vmg`，不提 `.mhc`**：两套交付格式里，真正面向"模板售卖"的那一套（MHC）在唯一的使用文档里完全缺席。
3. **开放文档为零**：没有 SDK 文档、没有 API 文档、没有 changelog、没有示例工程下载。`/` 和 `/home/` 都是营销页，`/guide/` 五节合计约 1400 字符。**唯一"文档"是 `mh skill`（要装 CLI 才能读）和散落在 JS 包里的界面文案。** 对"Agent 原生"这个定位来说，这是最大的短板：Agent 需要可读的契约，而契约只存在于示例代码截图里。
4. **无外部代码仓库**：全站外链只有 `discord.gg/wzhwJAp8Q4`、`beian.miit.gov.cn`、`react.dev/errors`、`jcgt.org`（一篇渲染论文，说明有图形学底子）。**没有 GitHub、没有 npmjs 页面链接**，尽管包名是 `@motionharness/cli`。

### D. 一句话总结

**它的时间模型、数据分层、导出管线是当真做的，值得作为我们插件的设计参照；它的"Agent 原生""MCP""模板社区"目前是叙事，不是能力。** 判断一家工具成熟度最快的办法是看它敢不敢写失败路径——MotionHarness 写了大量失败文案（协议不兼容、SDK 版本不符、素材 SHA 校验失败、GPU 渲染目标丢失），这是工程团队而不是市场团队留下的痕迹。所以：**内核可信，外围未完成。**
