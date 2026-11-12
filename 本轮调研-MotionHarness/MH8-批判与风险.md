# MH8 · 批判与风险：MotionHarness 是不是我们的解药

> 角色：反方。本文是这轮调研里唯一被要求挑刺的一份。
> 方法：本机实测（Windows 10/11 x64，Node v24.22.1，npm 11.19.1，2026-11-11 21:40–22:50）+ 反编译官网站点 bundle + npm registry 原始元数据 + GitHub API + 官方示例工程实测解包。
> 事实与判断分开标注：`【实测】` `【反编译】` `【元数据】` `【推断】`。
> **我先说清楚一件事：本文会推翻任务书里给定的两条前提，也会推翻我自己先前的两条猜测。** 该给的证据都在正文里。

---

## §0 一句话立场

**MotionHarness 大概率是个认真做的项目，但它解决的是「Agent 产出的动效工程怎么被人类编辑和交付」，而我们卡住的是「动效本身为什么丑」——这两件事之间没有因果关系。**

买它，我们多一个 163 MB 的闭源依赖，少零个问题。

但反方不等于无脑唱衰。有两件事我要先认：**第一，Windows 上它是能跑真出片的；第二，「秒制会引入漂移」这条担忧是错的。** 这两条后面都有实测。

---

## §1 宣称 vs 实际：官网七章逐条定性

官网 `/home/` 的七个 act 对应七条能力主张（`【反编译】main-HiGcBKPY.js`，`Fn=[开放工作台, AI 标记, 版本管理, 导出与工程, 界面编辑, 代码与参数隔离, 达芬奇桥接]`）。逐条对：

| # | 官网主张 | 我的定性 | 依据 |
|---|---|---|---|
| 01 | 开放工作台 · 一句话交给 Agent · 技术栈随意选 | **已发布，但只对 Standard 成立** | `mh new` 建出 `src/scene.js` + 172 B `mh.json`，`mh render` 出片【实测】 |
| 02 | AI 标记 · 点画面写意见交给 Agent | **已发布（命令行面）** | `mh marker list/complete`、`mh hook install --agent codex\|claude-code\|kimi-code` 均在 `--help` 里【实测】 |
| 03 | 版本管理 · 每轮有记录 · 一键撤回 | **已发布** | `mh checkpoint create/list/restore`、`mh history`【实测】 |
| 04 | 导出与工程 · 视频 / `.vmg` 打包 | **已发布，且是七条里最实的一条** | 见 §1.3 实测矩阵 |
| 05 | 界面编辑 · 选图层 / 改参数 / 拖关键帧 | **已发布，但前提极重** | 只有 Pro 工程有"参数"这个东西，且必须由源码 `field.*` 声明出来【实测】 |
| 06 | 代码与参数隔离 · 手调参数不写回源码 | **已发布** | `document.json` 与 `src/` 分离，`revision` 独立【实测】 |
| 07 | 达芬奇桥接 · 双向连接 | **已发布，但只对 macOS** | Windows 上 `mh bridge davinci install` 直接 `EBADPLATFORM wanted {"os":"darwin"}`【实测】 |
| — | **Transformer 面板**（`tokens 00 · d_model 4096` / `experts 0/32 · top-2` / `layers 00/10`） | **纯营销装饰** | 【反编译】见 §1.1 |
| — | **Web Agent / Motion Hub** | **愿景** | `/account/` 页面自认"功能尚未开放，你可以先登录账户"【实测】 |
| — | **模板社区** | **愿景** | bundle 原文"模板社区 · 即将上线"、"配合即将上线的模板社区"【反编译】 |
| — | **加入内测群** | **渠道状态说明** | 见 §1.2 |

### 1.1 那套 Transformer 面板：装饰，有源码级证据

这是任务书点名要查的，结论是铁的。`main-HiGcBKPY.js` 第 716,358 字节处的真实代码：

```js
let i = Math.round($(e, ...Q.tokens) * h.tokenCount),        // tokens
    a = V ? Math.round($(e, 25, 31) * V.active.length) : 0,   // experts
    o = Math.round($(e, 41, 63) * 10),                        // layers
    s = `tokens ${pad(i)} · d_model 4096\nexperts ${a}/32 · top-2\nlayers ${pad(o)}/10 · frame ${pad(Math.floor(e*2.4))}`
```

拆开看：

- `e` 是**页面滚动位置换算出的动画时间轴秒数**，不是任何模型的推理步数。
- `tokens`、`experts`、`layers` 三个数字**全部来自同一个 `e`**，只是套了不同的缓动窗口 `$(e, a, b)`（线性归一化后 clamp 到 0–1）。三个数字必然同增同减，任何一个"归零"其他两个也会。
- `d_model 4096`、`top-2`、`/32`、`/10` 是**模板字符串里的字面量**，永远不会变。
- `frame` 用 `e * 2.4`——**2.4 fps**。任何真实视频管线都不会是 2.4 fps。
- `EMBEDDING LOOKUP` 面板同理：`token_id → E[token_id] ∈ ℝ⁴⁰⁹⁶ · 显示前 16 维` 这一整句是**硬编码字符串**，下面那 16 个数字是 `Math.sin()` 之类的确定性伪随机。

**没有任何 tokenizer，没有任何权重，没有一次模型请求。** 整站网络请求只有 `api.motionharness.top/v1/events`（一个统计打点）和两个静态 JS。

这条为什么重要：**它说明这个团队的官网表达优先级高于工程诚实度。** 一个真在做 Transformer 的团队，不会把 `d_model` 写死成字面量再配一个 2.4 fps 的假帧号。这不是"没做完"，这是"做了一套看起来像在做 AI 的视觉"。对我们要做的判断是：**官网的可信度折扣要打得很深，一切以 CLI 实测为准。**

（顺带：官网演示区域自己写着"官网展示预设的创作流程"——`/guide/` 末段原文。也就是说连他们自己都承认那是预录脚本，不是实时生成。）

### 1.2 「加入内测群」意味着什么

bundle 里的完整文案（`site-page-BNU1-ELX.js`）：

> `MotionHarness 微信内测群二维码` / `MotionHarness QQ 内测群二维码` / `MotionHarness Discord 社群二维码` / `如果微信二维码过期 请添加运营微信或加入 QQ 群` / `有效期至 {0}` / `二维码已过期`

微信 + QQ + Discord 三渠道并行，二维码带**有效期**，还准备了"过期就加运营微信"的兜底。

这说明三件事：

1. **没有自助发布渠道。** 一个已经能在 npm 上 `npm i -g` 的产品，如果真有稳定用户，不会把"加微信群"当作主要支持入口。
2. **二维码会过期**意味着这个群是**滚动维护的、规模有限的**。
3. **它是国内团队做国内生意**（浙 ICP 备 2026009289 号-2），但产品说明、SDK README、CLI 帮助**全英文**，官网中英双语。这个错位本身值得记一笔：**工程面向国际，运营面向微信群。**

### 1.3 有没有我们可验证的产物

**有，但很薄，而且薄得有点难堪。**

- **npm 下载量**【元数据，`api.npmjs.org`】：`@motionharness/cli` 2026-10-01→11-11 累计 **2,795 次**，其中 **517 次集中在 0.1.0 发布当天（2026-11-10）**，日常只有个位数到十几。`cli-win32-x64` 同期 1,449 次。这个量级对应的真实用户规模，大概是"一个几十人内测群"。
- **GitHub**【元数据，GitHub API】：`VibeMG` 组织 2026-09-12 创建，**公开仓库只有 1 个**：`awesome-vmg`，**1 star**，Apache-2.0，29 MB。而 npm `repository` 字段指向的 `VibeMG/vibe-motion-graphics` —— **404**。也就是说**开源地址是死的，闭源产品是活的**。
- **`awesome-vmg` 里有 4 个完整示例工程**：`native-ai-flow`、`iphone-duo-unfold-2d`、`portrait-quote-glass`、`evergrande-business-atlas`，各带 `README.md` + `_vmgskill.md` 改作指南，其中两个带 `.vmg` 源码包。**这是全项目唯一可下载、可验证的产物。**

**然后我实测了它能不能用。**

我下载了 `native-ai-flow.vmg`（2,344,239 B，SHA-256 `05a21d58…66ff64`，**与 README 记录的校验值完全一致**，包本身没坏），然后用四个版本的 CLI 去解：

| CLI 版本 | 该版本的许可 | `mh unpack` 结果 |
|---|---|---|
| 0.1.4（当前） | UNLICENSED | `{"error":"Invalid project payload path: .gitignore"}` |
| 0.1.0 | UNLICENSED | 同上 |
| 0.0.26 | UNLICENSED | 同上 |
| 0.0.25 | Apache-2.0 | 同上 |

我把 `.gitignore` 从 `manifest.json` 里摘掉重新打包，它接着报 `README.md`——**这是一个白名单式路径校验，在拒绝自家格式的自家产物。**

**换句话说：官方发布的唯一样例，官方自己的 CLI 现在解不开。**

而且这不是我环境的问题——**那个示例工程的 README 自己写着**：

> 上述为使用步骤，**本次未在VMG CLI中实际执行**。
> 未执行依赖安装、类型检查、CLI解包/构建、浏览器编辑或视频导出，因此**不标记为运行验收通过**。

官方发了一个自己没跑过的样例包，而这个包确实跑不起来。

**再公平一点：它自己的 `.vmg` 往返是通的。** 我用 0.1.4 建工程 → `mh pack` → `mh unpack` → `mh render`，全过，`integrity.verified: true`，17 个文件。**所以不是"打包功能坏了"，是"格式在 40 天里换了至少两代，老包没人管了"。** 这恰好是 §2 第 2 条要说的事。

---

## §2 八条硬伤，逐条判真伪

### ① 仅 macOS 桥接 → **真，但结论要改写**

**任务书的表述是错的**，我必须纠正：**MotionHarness 的 CLI / SDK / 渲染在 Windows 上完全可用。**

`mh doctor` 输出 `{"ok":true, ...}`，自带 `ffmpeg.exe` / `ffprobe.exe`，`exportCapabilities` 里 `proRes:true`、`hevc:true`、`motionBlur:true`。`@motionharness/cli-win32-x64` 是一个 163,122,122 B 的 `MotionHarness.exe`。

只有**桥接**是 macOS 专属，且是硬拦截不是文档限流：

```
npm error notsup Unsupported platform for @motionharness/bridge-davinci@0.1.4:
wanted {"os":"darwin","cpu":"arm64,x64"} (current: {"os":"win32","cpu":"x64"})
```

**判：这条硬伤只对"达芬奇桥接"成立，对"能不能出片"不成立。** 桥接归零，产品不归零。

### ② 0.1.x + 6 周 → **真，而且是八条里最硬的一条**

元数据比任务书给的更难看：

- **是 20 个版本，不是 21 个**，且 **`0.0.24` 缺号**（发布了又撤，或跳号）。
- 首版 `0.0.11` @ 2026-09-28T12:58Z，最新 `0.1.4` @ 2026-11-11T12:57Z，**整 44 天**。
- `0.0.26` @ 11-08 → `0.1.0` @ 11-10，**两天之内跨大版本并改名**；`0.1.0` 到 `0.1.4` 是 **11-10 到 11-11 两天五个版本**。
- **包里还发生过一次品牌级迁移**：更早叫 `@base_bit/vmg-cli@0.0.14`（2026-09-12→09-28，Apache-2.0，**只有 darwin-arm64 平台包**），现在叫 `@motionharness/cli`。保留的 `vmg` 命令一跑就打印 `vmg 已更名为 mh;本命令继续可用,建议改用 mh`，然后尝试**自动联网迁移安装**。

**后果已经在 §1.3 演示过了：官方自己的示例包在四个版本上都解不开。** 这不是"API 可能会变"，是"API 已经在变，而且旧的没兜住"。

**判：真。而且这不是"初期不稳定"的中性描述，是有实证的格式断裂。** 语义化版本里 0.1.x 的含义就是"公开 API 随时可能不兼容地变"，而它连 0.x 内部都断过一次。

### ③ UNLICENSED → **真，而且有"中途收回授权"的实证**

任务书只说了"现在是 UNLICENSED"。更严重的是**它曾经是 Apache-2.0，是在有了用户之后收回的**：

| 版本区间 | license 字段 |
|---|---|
| `0.0.11` → `0.0.25`（2026-09-28 → 2026-10-31，**14 个版本**） | **Apache-2.0** |
| `0.0.26` → `0.1.4`（2026-11-08 → 2026-11-11，**6 个版本**） | **UNLICENSED** |

包内 `LICENSE` 正文（1,021 B，全文我读了）：

> Copyright 2026 MH contributors. All rights reserved.
> Unless a file is expressly covered by a separate license, **no open-source license is granted** for MotionHarness-authored material by this repository or distribution. **Use is subject to a separate authorization from the applicable rights holders.**
> …
> Rights already granted for previously distributed versions, including under the Apache License, Version 2.0, are unaffected.

它甚至专门写了最后那句来承认"老的 Apache 版本仍归 Apache"——**这说明改许可是一个深思熟虑的动作，不是疏忽。**

**判：真。而且比"哪天可能收费"更现实的风险是：我们现在拿到的授权，文本上不存在。** 公开渠道找不到 `/terms`、`/privacy`、`/eula`（MH6 已核）。「使用需另行授权」而我们没有那份授权——这是法务口径问题，不是技术问题。

### ④ React 源码即工程，是否倒退 → **真，是倒退，理由是"可复用性方向反了"**

这条我要讲细，因为它最容易被"它也能改参数啊"糊过去。

**它的 Pro 工程结构是这样**（`mh new --type pro` 生成，我逐字读了）：

```
mh.json          101 B   ← {"version":3,"projectType":"pro","entry":"src/project.ts"}
src/project.ts   212 B   ← defineComposition({id,component,width,height,fps,duration})
src/Poster.tsx   1656 B  ← defineComponent({parameters:{...}})
src/Title.tsx    951 B   ← 同上
package.json              ← react 19.2.8 / @motionharness/sdk 0.1.4（版本钉死）
```

**"Studio 里能调的参数"，全部来自源码里那几行 `field.*` 声明。** 看 `Title.tsx`：

```tsx
parameters: {
  text: field.text({ label: '文字', default: '标题' }),
  color: field.color({ label: '颜色', default: '#60a5fa' }),
  fontSize: field.number({ label: '字号', default: 48, min: 12, max: 240, animatable: true }),
  ...basicTransformParameters({ animations: { y: {...}, opacity: {...} } }),
}
```

**Agent 没写 `field.text`，人就在 Studio 里没有那个滑块。**

这就是关键：**MH 的参数面板不是"从成品里提取出来的"，是"写代码时顺手声明出来的"。** 它要求生成方在**第一次写的时候**就预判"人类以后会想改哪几个数"。预判不到的，人类就只能回去改代码。

对照 637 张卡（`【实测】index.json`）：

| 维度 | 637 卡 | MotionHarness |
|---|---|---|
| 参数来源 | 卡片自带，**2,686 条**（均 4.22 条/张），每条带 `default` / `range` / `note` | 源码里 `field.*` 现声明 |
| 拿到手就能改吗 | **能**，改 `params` 默认值即可 | 不能，要先读懂并改 `defineComponent` |
| 复用单位 | 一张卡 = 一个动效 | 一个工程 = 一次生成 |
| 第二次做同类动效 | **换参数** | **重新生成一份代码** |
| 谁承担正确性 | 卡作者（有人写过 `goodExample` / `badExample` / `avoid`） | 每次生成的 Agent |

**判：真，是倒退。** 不是"React 不好"，是**它的复用粒度是"工程"，我们的复用粒度是"动效"**。我们要 100 条片子里的 100 个相似但不相同的开场，MH 会给我们 100 个 React 工程；637 卡给我们 1 张卡 + 100 组参数。

还有一条更扎心的：`mh new` 生成的**默认示例**是——

```js
prepareFrame(time) {
  const progress = Math.min(1, time / 0.8);
  title.style.opacity = String(progress);
  title.style.transform = `translateY(${40 * (1 - progress) ** 3}px)`;
}
```

**官方脚手架给的第一段动画，就是 fade-in + 上浮。** 我们这轮的核心矛盾原话是"引擎只会 fade-in，所以丑"。**MotionHarness 的默认产出，正是那个东西。**

### ⑤ 「技术栈随意选」 → **半真：话是真的，但它和"改参数不用改代码"二选一**

原文（`【反编译】`，act1 的 body）：

> **不限技术栈 让Agent放开创作** —— "只保留核心契约，**React、Three.js、Canvas、GSAP** 都由 Agent 自由发挥。预览、导出、标记和版本交给 MotionHarness，Agent 少做重复工作。"

这话不假，但只对 **Standard** 成立。SDK README 原话：

> **Standard** uses a default factory returning `prepareFrame(time)` and `dispose()`, **without a React dependency**. … The component and parameter APIs below **belong to Pro projects**.

而 Standard 的 `standard.d.ts` 里，`StandardSceneContext` 只有 `{root, width, height, pixelRatio, media}`——**没有 Layer，没有 parameter，没有 field。**

**所以这个二选一是硬性的：**

| | Standard | Pro |
|---|---|---|
| 技术栈 | 真·随意（HTML/CSS/Canvas/SVG/Three/GSAP/任意框架） | 锁死 React 19.2.8 + three 0.180.0 + @react-three/fiber 9.8.1（peer 依赖精确到补丁号） |
| Studio 可编辑参数 | **没有** | 有 |
| 拖关键帧 / 调曲线 | **没有** | 有 |
| 我们想要的 | —— | 只有这边有，但这边锁死 |

**判：半真。** 如果它为真，"随意"的那一半没有参数面板；如果它为假，"随意"是营销话术。**我们不能同时拿到"Agent 随便写"和"人在面板上调"。** 而任务书里我们想要的，恰恰是后者。

### ⑥ 秒制会引入浮点误差 / 音画漂移 → **假。我用实测证伪了，这条我原来也担心，是我错了**

这是本文唯一一条"反方自我否决"。设计如下实验：`duration:10`、`fps:29.97`、挂一条 48 kHz 立体声 10 s 音轨，渲染后 ffprobe：

```
video: r_frame_rate=2997/100, nb_frames=300, duration=10.010010
audio: duration=10.010000, nb_frames=471
```

**视频和音频都精确对齐到 10.010 s，一帧不差。** 300 帧 ÷ 29.97 = 10.01001…，音轨被裁到同一长度。

再看整帧控制：

| 设置 | 输出 |
|---|---|
| 4 s @ 30 fps | 120 帧，4.000000 s |
| 10 s @ 30 fps | 300 帧，10.000000 s |
| 3.35 s @ 30 fps | **101 帧**，3.366667 s（向上取整，语义明确） |
| 0.0333 s @ 30 fps | 1 帧 |

**时间模型是"秒进、帧出、边界声明清楚"**，不是"秒制浮点漂移"。而且它的设计文档里把这件事写死了：`sampleVelocity` / `dampedFollow` / `springFollow` 的 `step` 默认 `1/60` 秒、**"与作品 FPS 无关"**、**"任意定位得到同一结果"**、**"不积累隐藏模拟状态"**。

**判：假。秒制不是风险，反而比我们现在的 12 个零散 `toFixed(6)` 更规矩。** 这条从批评清单里划掉。

（顺带记一个真问题：**确定性剪不出来。** 同一工程连渲两次，字节级 SHA-256 完全相同——这很好，但 `buildId` 两次不同。也就是说**输出确定性有，构建标识不确定**。做缓存比对时要按文件哈希，别按 `buildId`。）

### ⑦ Transformer 面板是装饰 → **真，且是本文最硬的一条**

见 §1.1，源码级证据。

**那它在做什么？** 我的判断：**在做"可信度表演"。** 一个 6 周的项目，最缺的不是功能是信任；而"Transformer / 专家 / 层"这套视觉符号，是 2026 年最容易换到信任的符号。用滚动时间轴驱动三个必然同增同减的计数器，成本几乎为零，观感收益极高。

**判：真。含义不是"它技术差"，而是"它的对外表达不能作为采购依据"。** 我们后面所有的判断，只认 CLI 行为。

### ⑧ 达芬奇桥接的实际工作量，对我们解决什么 → **真，但它的价值对我们的问题等于零**

桥接解决的是这个问题（原文）："动效片段与普通视频片段具备相同的编辑性，**可以快速找到对应的工程进行修改**"——**剪辑时间线上的往返（round-trip）**。

它要求：DaVinci **Studio**（付费版）、开本机外部脚本、装 FFmpeg 7+、装 macOS 专属组件、拖到已关联片段上。

**我们不是剪片，是出片。** 我们缺的是"画面出来就是对的"，不是"剪到一半能回去改工程"。**这条能力对我们不是打折，是无关。**

**判：真，但这条硬伤应该直接删掉——它不是"用不了"，是"用不上"。** 为一个我们用不上的能力去承担 §2②③ 的风险，账算不过来。

### 附：三条顺手测出来的实现瑕疵（不进八条，但会咬人）

**a) `png-sequence` 导出不带 alpha。** 我渲 `alpha.zip`，解出来是 `frame-000001.png …`，ffprobe 报 `pix_fmt=rgb24`。而它的文档在讲透明时写的是"透明用 PNG、无损动画或 ProRes 4444"。**序列这条路透明是丢的**，要透明得走单帧 PNG 或 MOV。这是那种"照文档做，交付时才发现抠不出来"的坑。

**b) `buildId` 不稳定，文件哈希稳定。** 同一工程连渲两次，两个 mp4 的 SHA-256 **完全相同**（`2f7489f0…405062`），但返回的 `buildId` 两次不同（`92e46f48…` / `cc237ceb…`）。**做缓存、做"这版是不是那版"的比对，必须按文件哈希，按 `buildId` 会永远判不等。**

**c) 它硬依赖系统 Chrome。** 二进制里写着 `Chrome/Chromium was not found. Install …`，找的是 `Chrome/Application/chrome.exe`。这台机器有，所以没暴露。**换一台没装 Chrome 的构建机，它会直接停在"请安装 Chrome"。** 这不是缺陷，是要写进部署前置条件的一条。

---

## §3 我们的真实需求对照（最狠的一节）

### 3.1 先把病因说准

上一轮的结论是：**「引擎只会 fade-in，所以丑」。**

这句话我要把它拆得更狠一点，因为它太容易被误读成"引擎能力不足，换个引擎就好了"。

**"只会 fade-in"不是能力缺失，是判断缺失。** 一个引擎能画 `opacity: 0→1`，就同样能画 `cubic-bezier(.22,1,.36,1)` 的 0→1。技术上零差别。丑的原因是**没人告诉它"这里应该用 expo-out 而不是 linear，时长应该 240 ms 而不是 800 ms，而且后面要跟一个 60 ms 的 overshoot"**。

**这是知识问题，不是渲染问题。**

### 3.2 MotionHarness 解决的是哪个问题

它解决的是：**"Agent 写完一段 React 动效之后，人类怎么不改代码就微调、怎么交付、怎么回溯、怎么跟剪辑软件对接。"**

它**不解决**的是：**"这段动效本身该怎么设计。"**

证据链完整：

1. **它自己一个效果都不含。** 七章全在流程侧：工作台、标记、版本、导出、界面编辑、参数隔离、桥接。没有一条是"这个动效怎么做"。SDK 的 `document.json` 是空骨架。
2. **SDK 的 `effects` 是滤镜，不是动效设计。** 我列了全部效果名：`blur` / `backdrop-blur` / `shadow` / `inner-shadow` / `glow` / `grain` / `gradient` / `gradient-overlay` / `vignette` / `brightness` / `contrast` / `saturation` / `hue` / `sepia` / `grayscale` / `color-adjust` / `texture-overlay` / `svg-distortion` / `mask` / `effect-mask` / `blend-mode`。**这是一套后处理图层属性，不是"动效库"。**
3. **缓动只有 15 条具名曲线**：`linear, ease, quad-in, quad-out, ease-in, ease-out, ease-in-out, smooth, sine-in-out, power2-in-out, power4-out, power4-in-out, expo-in-out, step-start, step-end`（另有 `cubicBezier()` 可自定义）。**15 条曲线不构成设计判断。**
4. **`mh new` 的默认示例就是 fade-in + translateY**（见 §2④）。它连"什么算好"都没表态。

**所以我可以下这个判断：MotionHarness 把"动效丑"这个问题完整地留给了我们，只是给了我们一个更好的容器来装它。**

### 3.3 637 张卡里，我们真正有的东西

`【实测】index.json` 全量统计：

| 项 | 数量 |
|---|---|
| 动效卡 | **637** + 11 recipe = 648 |
| 参数条目 | **2,686**（均 4.22 条/张，每条 `default` + `range` + `note`） |
| 带 `snippet` | **637/637**，全部有可执行片段 |
| 带 `goodExample` / `badExample` / `avoid` | **637/637** |
| runtime 分布 | gsap 213 · svg 128 · css 103 · webgl 114 · canvas 79 |
| 已渲染成品 | 139（`done`）· 未渲染 509（`planned`） |
| 带 `useWhen` / `pairsWith` | 637/637 |

**看第三、四、七行。** 这才是那个东西的价值所在：

`goodExample` 写的是「纸 crumple：**550 ms 内折 6 道，再 400 ms 展开**」；`badExample` 写的是「**折得太慢、展开太快，而且没有回到零**」；`avoid` 写的是「**不要用弹簧曲线做折纸**」；`params` 写的是「折叠时长 default `0.55s`，range `0.4~0.8s`」。

**这就是"判断"的物化形态。** 一个 Agent 读到这四条，就知道该给多长、不该给多长、什么时候别用。这比任何渲染器都更接近"引擎只会 fade-in"这个病的病灶。

而且它和我们已有的路径完全对齐：卡是 `HTML + lib/stage.js + __seek(sec)`，`stage.js` 第一条注释就写着「渲染：`?render=1` 之后外部逐帧调 `window.__seek(sec)`」，`Math.random` / `Date.now` 被明令禁止（用 `Motion.rand(seed)`）。**逐帧确定性是设计目标，不是巧合。**

### 3.4 引入 MH，是多一个依赖还是少一个问题

**账要这么算：**

| 我们现在有的 | MH 能替换吗 |
|---|---|
| 637 卡 + 2,686 参数 + 每张的判断说明 | **不能。它零效果。** |
| `__seek` 逐帧确定性取帧 | 能（它有 `prepareFrame(time)` 契约，设计更严格） |
| FFmpeg 收帧 → 成片 | 能（它自带 ffmpeg + h264/hevc/prores 编码器，实测可用） |
| Remotion 已经装好（`remotion-adapter.js` 在位） | 部分重叠 |
| 版本管理 / 标注数据模型（`versions.js` 1,312 行、`annotations.js` 561 行） | **不能，我们已经更强** |

**也就是说：它唯一能替换的，是我们本来就已经能跑的那一段（取帧 + 编码）；它替换不了的，是我们真正缺的那一段（动效判断）。**

**引入 MH = 依赖 +1（163 MB 闭源、无授权、格式 40 天断两次、遥测无开关）；问题 −0。**

### 3.5 如果 MH 明天消失了

**片子照做。** 这句话我能负责，因为我们的路径**不经过它**：637 卡 → headless Chrome → `__seek(f/30)` → PNG → FFmpeg → 成片。这条链上没有一个字节来自 MotionHarness。

反过来说，**如果哪天我们真把它接进了主链，那"它明天消失"就变成一个 fatal 事件**——因为 `@motionharness/sdk` 是闭源二进制的一部分（`cli-win32-x64` 里那个 163 MB 的 `.exe`），没有源码可救。

**这是这篇文章最重要的一条风险，比任何技术缺陷都重要：它的失败模式不是"变慢变差"，是"整个运行时不能重建"。**

（公平起见：它**离线可用**。我把 `MH_API_BASE_URL` 和 npm registry 都指向死端口，`mh new` 和 `mh render` **全部照常成功**【实测】。所以"停服"不会立刻杀死已装环境，"删包"才会。但记住 §2③——**我们本来就没有使用授权**，删不删包不由我们决定。）

---

## §4 替代方案对照

| 方案 | 它解决的 | 我们的接入成本 | 对我们的价值 |
|---|---|---|---|
| **`web-scene` + 637 卡**（现有） | 动效知识 + 逐帧确定性 + 参数化 | **0**（已跑通） | **最高。这是主线，不该被动。** |
| **Remotion**（已装，`remotion-adapter.js` 在位） | React 声明式视频、成熟的渲染管线 | **0**（已有适配器） | 中高。**如果真要走 React 路线，它比 MH 更该选**：成熟、许可清晰、生态大。 |
| **Motion Canvas** | TS 生成式动画、强类型时间轴 | 中（要重写卡片） | 低。它的心智模型是"写代码生成动画"，和"改参数出片"相反。 |
| **Theatre.js** | **可视化时间轴 / 关键帧编辑器**（这才是"Studio"那部分） | 中（要接 React 或 vanilla） | 中。**MH 的第 05 章，Theatre.js 做得更深、而且开源。** |
| **Rive** | 运行时状态机动画、交互式 | 高（要 .riv 资产，要美术） | 低。它是给 App 交互用的，不是给成片。 |
| **Lottie** | AE 导出、体积小 | 高（要 AE） | 低。我们要"Agent 生成"，Lottie 是"人做完导出"。 |

**MH 相对它们的独特性，只有两条：**

1. **AI 标记 → 标记被 Agent 读走 → 回写代码**（`mh marker` + `mh hook install`，把待处理标记注入每次用户消息）。
2. **源码 / 参数 / 素材三分，手调参数不写回源码**（`document.json` 与 `src/` 隔离）。

**这两条值多少钱？**

MH5 已经算过了：`editing/annotations.js` 561 行已经有对象锚定、帧范围、12 种 aspect；`media/plan.js` 867 行已经让参数成为独立于渲染器的数据。**我们缺的是两端接线（UI 入口 + 模型读入口），不是能力。** 成本估的是 +2 人日。

**所以这两条独特性的定价是：约 2 人日。** 而买 MH 的代价是 §2②③⑦⑧ 那一串。

**结论：独特性真实存在，但对我们的定价低于自建成本。** 这不是"它不好"，是"它卖的东西我们已经自己造了一半，剩下一半两天能补完"。

---

## §5 冷静清单：引入 MH 前你必须先确认的事

1. **先确认它是不是在解决我们的问题**——它是"动效工程的工作流"，不是"动效设计的知识库"；它一个效果都不含，`mh new` 的默认示例就是 fade-in。
2. **先确认我们到底是 Standard 还是 Pro**——"技术栈随意"（Standard）和"面板改参数"（Pro）**互斥**，不能同时要；而我们想要的是后者。
3. **先确认授权从哪来**——`0.0.26` 起是 `UNLICENSED`，包内 LICENSE 明写"使用需另行授权"，而公开渠道没有那份授权文本，也没有 `/terms`。
4. **先确认 40 天两代格式断裂我们扛不扛**——官方自己的示例包在 0.1.4 / 0.1.0 / 0.0.26 / 0.0.25 上**全部解包失败**。
5. **先确认遥测接不接受**——二进制里硬编码 `https://api.motionharness.top/v1/events`，事件含 `installation.first_run` / `project_id` / `project_type` / `asset_size_bucket`，**没找到任何全局关闭开关**（只有 `MH_TELEMETRY_ENDPOINT` 改地址）。
6. **先确认达芬奇桥接要不要**——Windows 上硬拦截 `EBADPLATFORM`；而且我们出片不剪片，这条能力对我们等于零。
7. **先确认它会不会进主链**——一旦 `@motionharness/sdk` 进了依赖树，我们就失去了"自己重建"的能力；它**离线可用**（实测），但**不可重建**（163 MB 闭源二进制）。
8. **最后确认一句：如果把它整个删掉，我们的片子还做不做得出？** 今天答案是"做得出，因为我们根本没用它"——**请让这个答案一直成立。**

---

## 结语：我作为反方，最后要说的两句公道话

**第一句：这个项目很可能是好的，但对我们不是解药。**

它有真东西：`prepareFrame(time)` 的确定性契约写得比我们规矩（"任意定位得同一结果、不积累隐藏状态"）、打包完整性校验是真的（`sha256` 逐文件）、Windows 上真能出片、离线真能跑、ProRes 4444/422 与 HEVC 出口齐（`prores_ks` + `h264_mf` 硬件编码）、`motionBlur` 用 `shutterAngle` 语义而不是拍脑袋的像素值。**这些是做过功课的痕迹。**

（也顺手记一条它没说的：`mh doctor` 报 `"color":"rec709"`、`"sourcePrecision":"rgba8"`——**是 8-bit SDR 管线，没有 HDR**。这点对交付规格有要求时要提前知道。）

**第二句：它解决的问题是真的，只是不是我们的问题。**

"Agent 写完代码，人类怎么不改代码就微调"——这是 2026 年所有 AI 创作工具的真痛点。它选了这条路，而且选得不蠢（源码/参数隔离是对的解法）。**但我们现在的阶段是"画面还没出来"，不是"画面出来后不好改"。** 一个给已经能出片的人用的工具，救不了还卡在"只会 fade-in"的人。

**所以我的建议不是"否定它"，是"把它放在错误的优先级上会亏"。**

它在我们的路线图里应该是这样的位置：**一个值得每两个月回来看一眼的参照物，不是一条要现在接进来的依赖。** 等我们自己的 637 卡跑通、参数面板立起来、`__seek` 收帧稳定之后，如果那时候还缺"AI 标记回写"和"面板编辑"，再回来看它第 05、06 两章怎么做的——**到那时它是老师，不是零件。**

而现在接它，是用一个 40 天、无授权、格式断过两次、连自家示例都解不开的闭源依赖，去换两条我们两天能自己写完的接线。**这笔账不划算。**

---

> **本文的自我修正记录**（反方也要能被反驳）：
> 1. 任务书说"仅 macOS 桥接"，我实测证明**只有桥接是 macOS，CLI/渲染在 Windows 完全可用**——原判断过重。
> 2. 我原以为秒制会导致音画漂移，实测 29.97 fps 下音视频精确对齐 10.010 s——**这条批评是错的，已撤回**。
> 3. 我原以为"技术栈随意选"是纯营销话术，实测它是真的，只是**与参数面板互斥**——判断从"假"改成"半真"。
> 4. 我原以为它是纯云端依赖，实测**完全离线可用**（死端口下照常出片）——风险从"停服即死"下调为"不可重建"。
