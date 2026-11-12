# MH4 · 渲染与时间模型：逐项对照 CompositionPlan

> 范围：只谈**时间**与**渲染**两块，以及透明视频这一个渲染能力。工程结构（源码/数据/素材三分）只谈它的渲染后果，不重复 `01-能融进什么-判断.md` 已做的 SDK 能力排序。
> 方法：读我们自己的实现（`产品实现/media/**`、`产品实现/core/project/**`）+ 本机只读实测（`ffmpeg` 9.0.1）。MotionHarness 侧全部是二手或推断，来源标注到行。

## 证据等级

| 标记 | 含义 | 本次占比 |
|---|---|---|
| 【实测】 | 本机跑命令得到，可复现 | 透明视频全部、ffmpeg 能力全部 |
| 【复核】 | 别人实测过的我复核到代码行 | 我们的时间基/对象/转场/运动术语/remap |
| 【二手】 | 来自同轮别的分册（`00-Lead一线取证.md`） | MH 技术栈、SDK 时间模型注释原文 |
| 【推断】 | 我的工程判断，无一手证据 | MH 渲染管线的接线细节 |

**结论先说**：秒制不是威胁，因为**它已经进来了**——我们选定的路线乙所依赖的 `lib/stage.js` 就是 `gsap.timeline({paused:true})` + `tl.seek(sec)`。真正的问题不是"换不换秒制"，而是**帧与秒的缝合面被放在哪里**。今天它被放在 12 个零散 `toFixed(6)` 上，这才是要改的东西。

---

## 一、时间模型对照

### 1.1 我们这边的真实状态（先纠正一个流行误解）

背景里说我们"整数帧 + 有理数，为帧精确做了很多工作"。这句话在**计划层**成立，在**渲染层不成立**。三处证据：

| 位置 | 事实 | 含义 |
|---|---|---|
| [`media/remap.js:88`](../产品实现/media/remap.js#L88) | `roundDeterministic(cumulative[i].movieFrames + advanced, 6)` | 重映射内部**影片帧本身是浮点数**，被 round 到 1e-6 |
| [`media/render/ffmpeg-adapter.js:94`](../产品实现/media/render/ffmpeg-adapter.js#L94) | `Number(((frames*den)/num).toFixed(6)).toString()` | 交给 FFmpeg 的是**六位小数秒字符串** |
| [`media/render/hyperframes-adapter.js:51`](../产品实现/media/render/hyperframes-adapter.js#L51) | 同上一行的另一份拷贝 | 同一转换被复制了 3 份 |

也就是说：**"帧精确"是计划层的性质，到了滤镜图和 CSS 里，我们和秒制系统一样在传十进制秒。** 我们的理性并没有比 MH 多保留一位精度，只是**多保留了一个整数帧号作为主语**。这个区别很重要，但它保的是**可审计性**，不是精度。

顺带一个反直觉发现：`remap.js` 是一个**没有调用者、却带着否决权**的模块。全文只有一个适配器命中 `timeRemap`，而且是注释（[`ffmpeg-adapter.js:355`](../产品实现/media/render/ffmpeg-adapter.js#L355)）；同时 `assertAudioKeepsMovieTime`（[`remap.js:238`](../产品实现/media/remap.js#L238)）会对**任何**带 `timeRemap` 字段的对象直接抛错。今天就算有人想接它，外向路径是封死的。

### 1.2 十个维度逐项对照

| 维度 | 我们（帧 + 有理数） | MotionHarness（秒制） | 谁更优 | 换的代价 |
|---|---|---|---|---|
| **时间基精度** | `fpsNumerator/Denominator` 两个正整数 + 帧号整数，`Rational` 用 GCD 归约（[`base/determinism.js:184`](../产品实现/base/determinism.js#L184)）。区间半开 `[start,end)` | 浮点秒（double）。SDK 注释原文："stateless motion… **reconstructs from start on every call**"【二手】 | **我们**（表示层）；**打平**（有效精度，因为出口都是 6 位小数秒） | 低。只需在唯一出口把 `k·den/num` 序列化，不必改语义 |
| **非整数帧率** | 30000/1001 可表达，`Rational.toFrames()` 用整数乘除（`determinism.js:226`）。但**全仓库无 29.97 用例**：`30000`/`1001` 在 `plan.js`/`remotion-adapter.js`/`checks.js` 里 0 命中【实测 grep】 | 天然无此概念，秒就是一秒 | **我们**（表达）；**都不优**（都没验证） | 零（不动它） |
| **VFR** | 不支持：帧号连续且等距，无法表达"第 37 帧时长 1/48 秒" | 理论上可以（每个采样点自带 t），但无证据；MH 的 `exports` 是按固定 fps 栅格出帧【推断】 | **都不支持** | 换过去也不会得到 VFR。不要为这个理由换 |
| **变速 / 重映射** | `remap.js` 完整：梯形面积积分、双向括号解（bisection 40 次）、单调性检查、`hold` 是合法创作决策。**但无任何适配器接** | SDK 有 `time-remap.js`："纯可 seek 的时间重映射 + 曲线切片"【二手】 | **MH**（它接了） | 中。我们不是缺算法，是缺**一个消费者**。换的代价不在时间模型，在接线 |
| **音画同步** | 音轨锁影片时间（`assertAudioKeepsMovieTime`）；`adelay` 用**整数毫秒**（[`ffmpeg-adapter.js:368`](../产品实现/media/render/ffmpeg-adapter.js#L368)），`aresample=48000` | 秒制 + 音轨独立时间线【推断】 | **我们**（结构上正确）；精度上两者都被采样网格限制 | 换秒制**不会**改善音画同步，反而多一次浮点乘法 |
| **随机访问（seek）** | 计划层任意帧可解（纯函数）；渲染层 FFmpeg 用 `trim/setpts` 分段。Remotion 侧 `useCurrentFrame()` 是整数帧 | 一等公民：整个 SDK 围绕 `t` 的纯函数设计，"**seek order and output FPS cannot change the curve**"【二手】 | **MH** | 中。但我们的 `__seek`（`stage.js:72`）已经是同一个东西 |
| **预览与导出一致性** | 弱：预览=Remotion/HyperFrames，导出=FFmpeg，**三适配器三套代码**，D1/D2/D3 全是这个结构病的症状 | 强：同一份 React 组件同一个时间函数，`/api/preview/capture` 与 `/api/exports/…/frame` 走同一条取帧路【二手，路由名实证】 | **MH** | 高，但**这就是路线乙已经在付的代价** |
| **跨工具交换** | 帧号 + 有理数可无损进 EDL（CMX3600 是帧制）、OTIO、FFmpeg；进 CSS/GSAP 必须转秒 | 秒可无损进 OTIO/AAF/CSS/GSAP；进 EDL 必须按帧率取整 | **打平**（各有各的母语） | 低。交换层做双向转换即可 |
| **关键帧 / 曲线** | **无关键帧概念**：`keyframe` 12 次命中全是编译出来的逐帧数组（[`motion.js:140`](../产品实现/media/motion.js#L140) `const keyframes = []`） | 有关键帧、曲线、`cubicBezier`、spring/inertia/noise【二手】 | **MH** | 这是**能力**差距，不是**时间模型**差距。别混为一谈 |
| **可审计性（谁错了）** | 强：帧号是整数，`1464→696` 是一眼能算的整数恒等式（这正是 D3 被抓出来的原因） | 弱：浮点秒的错误表现为"慢了 0.03 秒"，需要反推 | **我们** | 换秒制会**永久失去**这个诊断通道 |

### 1.3 特别分析 A：秒制在"音画同步"上的代价

不是"浮点误差"，是**量化格点变了**。三种情况算一遍（48 kHz）：

| 帧率 | 每帧样本数 `48000·den/num` | 是否整数 | 后果 |
|---|---|---|---|
| 25 | 1920 | 整数 | 帧边界与采样边界重合，零代价 |
| 30 | 1600 | 整数 | 同上 |
| 30000/1001（29.97） | 1601.6 | **非整数** | 帧边界落在样本之间。一帧内你无法既不重复也不丢弃样本 |

结论：**音画同步的瓶颈从来不是"秒 vs 帧"，而是"采样网格 vs 帧网格是否整除"。** 29.97 下两者本来就不整除，换秒制不会让它变好，也不会变坏——只要音轨继续按**样本数**定位，而不是按帧号乘出来的秒定位。

我们今天的实际精度是**1 毫秒**（`Math.round(...*1000)` 的 `adelay`）。1 ms = 0.03 帧@30fps，够用；但若以后做 60/120 fps 或音效对点，应改为对齐到样本（16 samples@48k ≈ 0.333 ms）。**这一条无论换不换秒制都该改**，它与 MH 无关。

真正的秒制代价是另一件事：**音轨和画面失去共同的整数分母**。今天我们可以说"第 312 帧"，音轨说"第 312×1600 个样本"，两者是同一个整数的两个视图，可互相验算。换成秒之后，"第 312 帧"变成 `10.410000`，而它对应的样本是 `499680`——两个数之间只剩一次乘法维持关系，**任何一方被独立舍入，关系就断了**。这就是 `remap.js` 里那句注释在守的东西（`remap.js:6-7`：音轨保持 MOVIE time，变速绝不能悄悄加速用户的声音）。

### 1.4 特别分析 B：秒制在"逐帧确定性"上的代价——会不会退回浮点累加误差？

**答案：不会，前提是三条同时成立；破一条就会退。**

| 条件 | 我们的现状 | 破了会怎样 |
|---|---|---|
| ① **绝不累加**：`t_k = k·den/num` 由整数帧号一次性算出 | 计划层满足 | `t += 1/30` 循环 1000 次后误差 ~1e-13，但 GSAP 一旦把它当"当前时间"喂给下一帧就会滚雪球 |
| ② **存储仍是整数帧**，秒只是投递格式 | 满足（plan 里没有秒字段） | 若把秒写回 plan，就再也算不回原帧号 |
| ③ **序列化步长远大于量化步长** | 6 位小数 = 1e-6 步长；30fps 帧间距 0.0333 → **安全系数 33000 倍** | 若降到 3 位小数（1e-3），与 120fps 的 0.00833 只差 8 倍，边界帧会撞车 |

补充一个真实存在的反例，用来证明这条不是空话：`lib/stage.js` 的 **live 预览**模式用的是墙钟累加——

```js
const loop = (now) => { if (t0===null) t0=now; const t=((now-t0)/1000)%(DUR+tail); seek(Math.min(t,DUR)); ... }
```
（[`stage.js:65`](../已确认资产/01-作品与案例/10-gongnyang-awesome-ai-motion/lib/stage.js#L65)）

这是**允许漂移**的，因为它只服务人眼预览。而 `?render=1` 走的是 `window.__seek(sec)`，**不经过任何累加**（`stage.js:12`、`stage.js:72`）。同一个文件里同时存在"允许漂移的预览"和"必须确定的导出"，而它们共享同一个 `seek` 函数——**这正是 MH 那句"预览与导出使用相同的创作语义"的具体形态，而且我们手上这 637 张卡已经做到了。**

于是结论变成一个精确的工程判断：

> **秒制只在"投递"这一层是安全的；一旦它变成"状态"，确定性就没了。**
> MH 的做法是把秒做成**纯函数入参**（每次从 t 重算，不留 playback memory）【二手】——它不是"用秒存储"，是"用秒求值"。

我们该学的是这个区分，而不是"把帧改成秒"。

---

## 二、工程结构对照

### 2.1 三分法与单源法，各自在保护什么

| | MH：`src/` React 源码 + `document.json` + 素材原件 | 我们：CompositionPlan 单一事实源 + 版本 + 哈希 |
|---|---|---|
| **权威在哪** | 三分，各有各的权威：代码管"怎么动"，`document.json` 管"多大/在哪"，素材管"是什么" | 一处：plan 管**全部**声明（对象、时间、参数、转场） |
| **手调参数写回源码吗** | 不写。`document.json` 以**图层名（中文）为 key**，只存数值；`src/` 从它读值【二手】 | 不存在这个问题：没有"源码"这一层，参数本来就在 plan 里 |
| **它为什么能做到"不写回源码"** | 因为代码被写成了 `f(props, t)` 的形状。手感好的滑块改的是 props，不是 JSX。**只要组件是 props 驱动的，"不写回"就是免费得到的** | — |
| **我们为什么能做到局部保护/差异/回退** | — | 因为**只有一个可比较对象**。`planFingerprint`（语义哈希，剔 `normalizedAt`/`lockedAt`）+ `diffById`（按 id 比 `kind/overlapFrames/fromScene/toScene`）+ `versions.js` 的 `createVersionStore` + `production-lock` + `write-guard` 的 `.locks`/execution marker |
| **结构性优势** | 技术栈可换、Agent 可自由发挥、工程可移交（`.vmg` 打包带 asset 身份 + SHA-256 + ZIP 逐条对齐【二手】） | 可**证明**"只改了该改的"（`checkRepairProtection`）；可**回退**；可**缓存键**（`buildCacheKey` 纳入全部依赖）；崩溃后 `unknown` 状态**永不自动重试** |
| **结构性弱点** | 三分之间的一致性靠约定，不靠证据。"代码读了 `document.json` 里不存在的 key"这类错误在它那边是运行时才发现的 | **代码无处安放**。今天的 10 种对象全是"声明式参数"，一旦要"场景是程序"，plan 里没有位置放程序 |

一句话：**MH 的三分法买的是"可迁移"，我们的单源法买的是"可证明"。** 这两者不是同一根轴上的强弱，是两个不同的正交收益。

### 2.2 能不能取二者之长：CompositionPlan 保留为事实源，同时允许"场景是代码"

能。而且不需要发明新东西——**只要把"场景代码"降格成一种素材（material），而不是升格成第二个事实源。**

这是关键的一句：MH 的三分法之所以危险，是因为代码**平级**于数据；我们要的是代码**从属**于数据。具体设计：

```jsonc
{
  "kind": "web-scene",                    // 第 11 种对象
  "id": "sc07-hero",
  "scope": "scene",
  "hit": "web-iframe",
  "timeline": { "startFrame": 240, "durationFrames": 90 },   // ← plan 说了算
  "authored": {
    "codeRoot": "materials/web/sc07-hero",                  // 素材根下的一个目录
    "codeHash": "sha256:…",                                 // 内容寻址，不可变
    "entry": "index.html",
    "assets": [{ "file": "logo.svg", "sha256": "…" }]
  },
  "params": {                             // ← 人/Agent 唯一可写的地方
    "base":    { "scale": 1.0, "x": 640, "y": 360 },        // 人拖的
    "offset":  { "rotation": 0 },                            // 代码派生的叠加
    "seed": 20261111,
    "aspect": "16:9"
  },
  "editableProps": ["params.base.*", "params.seed", "opacity", "scale"]
}
```

配四条规则，就能同时拿到两边的收益：

| 规则 | 拿到 MH 的什么 | 保住我们的什么 |
|---|---|---|
| **R1 · 代码不可变、参数可变**：`codeHash` 一旦写进 plan 就是常量；任何调参只改 `params`，plan 版本 +1 | "手调参数不写回源码"的**全部好处** | 差异/回退仍是一份 JSON 的差异与回退 |
| **R2 · 代码以哈希入指纹**：`planFingerprint` 已剔 `normalizedAt`/`lockedAt`；把 `codeHash` 与 `params` 的哈希一起算进去 | — | 缓存键完备（`buildCacheKey` 的既有纪律）；"画面变了但指纹没变"不会发生 |
| **R3 · 换代码 = 换素材，不是改源码**：升级场景要提交新的 `codeHash` + 新版本，旧 hash 永久可回溯 | 工程可移交 | 回退 = 把 `codeHash` 指回旧值，**不需要 git revert**。这比 MH 强 |
| **R4 · 时间只由 plan 给**：`__seek(t)` 的 `t` 由 plan 的帧号算出，场景**不许自己决定时长** | — | 保住"帧号是主语"；场景内部爱用秒随便用，出不了自己的框 |

R1+R3 这两条合起来，就是我要的答案：**"场景是代码"成立，但代码在 plan 里只是一个哈希，和人家的 `image` 对象里的 `sourceFile` 同构。** MH 用三个目录表达三分，我们用**一个对象 + 一个哈希**表达同样的隔离，而且顺带得到了它没有的回退能力。

代价也要说清楚：`web-scene` 的 `params` 是**自由 JSON**，`editableProps` 只能写成 `params.base.*` 这种通配，**plan 校验器无法验证内部字段**。这是一处必须承认的"校验真空"，缓解办法是让场景自带 `params.schema.json` 并纳入 `codeHash`，在 `validatePlan` 时对它做一次 schema 校验。否则 `04-逐项验收闭环.md` 那套"每个字段都有人验"的纪律会在这一格断掉。

**另一个必须一起做的东西：确定性的边界要写进对象。** `web-scene` 要带 `determinism: { seed, fontsPinned: true, assetHashLocked: true }`，并在渲染前**断言**：无网络请求、无 `Date.now`、无未固定字体。`stage.js` 已经在守这条（`document.fonts.ready` 才置 `__ready`，`Math.random` 被 `Motion.rand(seed)` 取代），但它守的是"这批卡"的自觉，不是契约。做成对象字段，才是工程。

### 2.3 三分法真正的代价（我们不该照抄的地方）

| 代价 | 说明 |
|---|---|
| **一致性只靠约定** | 代码读了 `document.json` 里没有的 key → 运行时才炸。我们的 `validatePlan` 在渲染前就能拒 |
| **"工程"不可证明** | `.vmg` 能证明"包是完整的"（SHA-256、ZIP 对齐），但证明不了"这次改动只改了该改的"。我们的 `checkRepairProtection` 是在证明后者 |
| **透明的参数边界反而变模糊** | 参数在 JSON，但"这个参数的合法范围"在代码里（或更糟，只在人的脑子里）。MH 用 `control-panel.js` 的 `ControlPanel/ControlGroup` 补这一块【二手】——这说明它自己也遇到了这个洞 |

---

## 三、渲染管线对照

### 3.1 三条管线 + 它那一条

| | 载体 | 谁决定像素 | 时间怎么进 | 产物 |
|---|---|---|---|---|
| **我们的 FFmpeg** | 滤镜图字符串 | FFmpeg 原生滤镜（`drawtext`/`overlay`/`xfade`） | 秒字符串（`toFixed(6)`）+ `enable='gte(t,a)*lt(t,b)'` | mp4（`yuv420p`，`format=yuv420p` 硬转，`ffmpeg-adapter.js:352`） |
| **我们的 Remotion** | React 组件（`Unit.jsx`） | 浏览器 + Remotion 合成器 | **整数帧**`useCurrentFrame()`，`fps={rate}` 传 `num/den` 浮点比（`Root.jsx:10-16`） | mp4 |
| **我们的 HyperFrames** | 生成的 HTML + CSS 动画 + 内联脚本 | 浏览器（无 transition 原语，crossfade 用两段 CSS 动画叠同一窗口，`hyperframes-adapter.js:8-10`） | 秒（`seconds()` 同款实现） | mp4 |
| **MH** | React 源码 + `document.json` | Chrome（`chromiumoxide` 驱动，24 次命中）【二手】 | 秒，纯函数 `f(props, t)` | 逐帧捕获 → 内嵌 LGPL FFmpeg 编码【二手+推断】 |

MH 那条管线的**接线细节是推断，但两端有实证**：一端是 `chromiumoxide`（浏览器驱动坐实，不是 Playwright/Puppeteer）；另一端是内嵌 FFmpeg（含 `palettegen`/`paletteuse` 做 GIF 透明）+ Studio 路由里成对出现的 `/api/preview/capture` 与 `/api/exports/capabilities/export//frame`【二手，路由名来自二进制字符串】。**"浏览器逐帧取图 → FFmpeg 收帧编码"这个形状，证据链是完整的**；中间怎么调度帧、怎么保证不卡在 `requestAnimationFrame`，我看不到，标【推断】。

顺便指出一处我们自己的隐患：`Root.jsx` 把 `fps={fpsNumerator/fpsDenominator}` 直接传给 Remotion。Remotion 的 `fps` 按官方文档要求是**整数**，29.97 传进去会不成立【推断，本机未装 remotion，`video-config.js` 不存在，无法验证】。这不是秒制问题，是**我们自己的有理数时间基在 React 渲染器里没有落点**——一处今天没人踩、但一定会踩的坑。

### 3.2 关键判断：它的"React 源码即动画"和我们的"Web 场景即画面"，是同一条路还是两条路？

**同一条路，两台车。** 判据是三个"是不是":

| 判据 | MH | 我们（路线乙） | 结论 |
|---|---|---|---|
| 像素是不是一个浏览器画的？ | 是（Chrome） | 是（Chrome，`__seek` 后截图） | 同 |
| 帧是不是"设定时间 → 等一帧 → 取图"？ | 是（按 fps 栅格捕获） | 是（`__seek(k/fps)` → `page.screenshot`） | 同 |
| 时间是不是从外部注入、而不是自己播放？ | 是（纯函数从 t 重算，无 playback memory） | 是（`?render=1` 关掉自动播放，只认 `__seek`） | 同 |
| 动画的**载体**是什么？ | React 组件树（声明式，props 驱动，每帧重渲染） | GSAP 命令式时间线（`tl.seek`，DOM 已在，只改属性） | **异** |
| 谁定义"有哪些参数"？ | `document.json` + ControlPanel | 卡片自己的 HTML `data-*` + 我们的 plan | **异** |

**差异的意义（这是本节最该记住的一句）**：React 逐帧重渲染是"每帧重新算一遍虚拟 DOM 再 diff 到真实 DOM"，GSAP seek 是"DOM 不动，只按曲线改属性"。对**确定性**而言，GSAP 的 `seek` 天然更强——它没有 effect 清理、没有 layout 抖动、没有 `useState` 的时间依赖；React 那条路要确定性，必须**人为禁掉** `useEffect`/`useState`/`useLayoutEffect`，这靠纪律而不是靠结构。Remotion 自己的文档就在反复强调这点。

所以：**它没有"解决得更好"，它是用更强的纪律换来了同样的确定性，代价是每帧一次 React 协调。**

### 3.3 该不该直接用它的形态？

**不该，理由不是"我们更好"，是"换过去的收益为负"**：

| 换过去要付 | 具体 |
|---|---|
| 637 张卡要重写成 React 组件 | MIT 授权允许改，但**授权允许改 ≠ 值得改**。而且卡片是"效果示范"，价值在版式与曲线，重写就把调好的版式丢了 |
| 丢掉 `?embed=1` / `data-size` 竖版 | `stage.js:14-17`、`stage.js:25`：卡片已支持 `720x1280` 与无页眉页脚模式。React 化要重做 |
| 丢掉"改一行 HTML 就能试" | 调试手感是隐性成本，但它是真的 |
| 多一层失真 | 我们已有的 `__seek` 实测"同帧 sha 一致"；再包一层 React 不增加确定性，只增加失败面 |
| 许可证 | MH6 已判：当外部工具调用最干净，抄设计自研次之，**逆向 `.vmg` 有灰区**。依赖它的运行时会把灰区变成硬依赖 |

**但它有一样东西我们确实没有，且值得抄形态（不是抄代码）**：它把"参数面板"做成了**契约**（`ControlPanel` / `ControlGroup`）而不是"渲染时临时读的字段"。这意味着**参数的可编辑范围与渲染读取是同一份声明**。我们的对应物是 `OBJECT_KINDS[kind].editableProps`——已经有了，但只到"属性名"这一层，没有"范围/步长/单位/在哪个面板显示"。这是 §5"只学一件事"的候选之一，但我最后没选它，理由在第五节。

---

## 四、透明视频

### 4.1 对我们到底有什么价值

先把"价值"和"交付格式"分开。我们成片是 mp4（无 alpha），这是**对的**——没有播放器会把带 alpha 的 mp4 当回事。所以透明视频的价值全在**中间态**：

| 场景 | 是否需要 alpha | 今天怎么做的 | 值不值得做 |
|---|---|---|---|
| **叠加到实拍上**（片头字、下三分之一、粒子） | 是 | **做不了**：路线乙的 PNG 序列在收帧时被 `format=yuv420p` 拍平 | **最值得**。这是产品能力缺口，不是格式偏好 |
| **转场素材**（wipe 的遮罩、扫光） | 是 | `wipe` 是滤镜图里的表达式，不是带 alpha 的素材 | 中。做成素材后转场可复用、可预览 |
| **给达芬奇/剪辑软件的图层** | 是 | `flattened-video` 只能压平进去 | 中。MH 桥接达芬奇要 FFmpeg 7+ 正是为这个【二手】 |
| **最终交付** | 否 | mp4 | **不值得**。别为了"支持透明"去改交付格式 |

一句话：**透明视频对我们不是"导出选项"，是"镜头内合成的必要条件"。** 而它恰好是路线乙**已经付过成本**的东西——我们本来就在逐帧拿 PNG（PNG 天然带 alpha），今天只是主动把它拍平了。所以这条能力的边际成本接近零，**不做才是浪费**。

### 4.2 本机实测（FFmpeg 9.0.1-full_build-www.gyan.dev）

MH 要求"透明视频导出需 FFmpeg 7+"。本机版本：**9.0.1**，满足。但这只是版本号，我实测了三种 alpha 编码是否真的把 alpha 写进文件：

| 编码 | 命令要点 | `pix_fmt`（ffprobe 实测） | alpha 平面实测 | 可用性 |
|---|---|---|---|---|
| `prores_ks` | `-profile:v 4444`，输入 `yuva444p10le` | **`yuva444p12le`** | `alphaextract` 成功，源 alpha 0.5 → 字节 **126/127**（12 bit 量化） | **可用，首选** |
| `qtrle` | 输入 `argb` | **`argb`** | `alphaextract` 成功，0.5 → **127**（全一致） | **可用，兼容性最好**（QuickTime Animation，老剪辑软件都吃） |
| `libvpx-vp9` | 输入 `yuva420p`，显式 `-pix_fmt yuva420p -auto-alt-ref 0 -lossless 1` | 报告 `yuv420p`，但流上带 `TAG:alpha_mode=1` | **`alphaextract` 报错（exit −22）**；文件里查不到 ASCII `AlphaMode` | **存疑，本次不可用** |
| `ffv1`（参照） | 输入 `rgba` | 支持（`-h encoder=ffv1` 列 rgba） | 未逐帧比对 | 可用（无损归档用，不当交付格式） |

编码器可用性（`ffmpeg -encoders` 实测）：`prores`、`prores_ks`、`qtrle`、`libvpx-vp9`、`ffv1`、`png`、`apng`、`libwebp`/`libwebp_anim` 全部在列。
滤镜（`ffmpeg -filters` 实测）：`alphaextract`、`alphamerge`、`overlay`、`xfade`、`setpts`、**`zoompan`**、**`loudnorm`** 全部存在。

**两个必须点出来的事**：

1. **`zoompan` 和 `loudnorm` 在本机 FFmpeg 里是有的。** 我们"无 zoompan、无 loudnorm"是**代码里没写**（grep 命中 0），不是工具不支持。这两条今天从"能力缺口"降级为"没人接的现成能力"——性质完全不同，优先级完全不同。
2. **VP9 alpha 这条坑是真的**：WebM 的 alpha 不是独立平面，是 BlockAdditional 里的附加流；`-pix_fmt yuva420p` 不显式给，libvpx-vp9 会**静默降级成 yuv420p**（我第一次跑就是这样，输出 `pix_fmt=yuv420p`，不报错）。给了显式参数后 `alpha_mode=1` 写进去了，但本机 `alphaextract` 仍失败。**结论：透明视频走 ProRes 4444 / qtrle，别赌 VP9。**

对路线乙的直接含义，一句话：**PNG 序列已经带 alpha，收帧时不要 `format=yuv420p`。** 要保持 alpha，就用 `-c:v prores_ks -profile:v 4444`（或 `qtrle`）直出，需要 mp4 时再另走一条拍平的路。这一条不该等到"以后做透明视频"才做，因为它决定了中间态是"带 alpha 的帧"还是"已拍平的帧"，**改晚了要重渲所有素材**。

---

## 五、结论

### 5.1 如果只能学一件事

**学它"唯一语义、唯一通路"这条架构约束——具体做法是把"画面层的时间注入"收敛成一个函数，并由预览和导出共享同一个实例。**

理由不是它更快或更强，而是**我们已知的三个缺陷全是这条约束的违反**：

| 缺陷 | 根因（按结构归类，非按代码） | 违反了什么 |
|---|---|---|
| D1 `fit`/`box` 被忽略，改属性两次渲染逐字节相同 | 计划层声明了 `fit`，渲染层自己另算了一遍布局——**存在第二条推导** | 唯一通路 |
| D2 非首场景文字晚 `sceneStartFrame` 帧（实测 122） | `enable='gte(t,a)*lt(t,b)'` 的 `a/b` 由 `seconds(startFrame)` 算，但场景链起点与全局 `t` 不同源 | 唯一语义 |
| D3 多 xfade offset 基准错，1464→696 帧 | 每个 xfade 的 `offset` 是**相对前一条已拼接流的累计时长**，而代码按"场景绝对起点"给 | 唯一语义 |
| D4 `rgba()` 抛错 | 颜色字符串有两个解析入口 | 唯一通路 |

注意 D2/D3 的共同点：**它们都不是"算错了"，是"算了两遍，两遍不同源"**。这正是 MH 那句"预览与导出使用相同的创作语义"要防的东西。它用秒制统一来实现这一点，我们用帧制统一也能实现——**统一是目的，单位只是手段。** 这才是"只学一件事"的正确读法。

（不选"参数面板契约"当那一件事，是因为它是**能力**增益；而唯一通路是**缺陷**根除。在 D1–D4 还开着的今天，先止血。）

### 5.2 哪一部分绝不能换

| 不能换 | 为什么 |
|---|---|
| **整数帧 + `fpsNumerator/Denominator` 作为计划层主语** | D3 能被抓住，靠的是 `1464→696` 这个**整数恒等式**。换成浮点秒，同样的错误表现为"时长短了 24.53 秒"，需要反推才能定位到"第三个 xfade 的 offset 基准"。**这是可审计性，不是保守** |
| **`[start,end)` 半开区间 + 转场重叠为正整数** | 半开区间让"相邻场景无缝、无重叠帧"成为**默认**而不是**特例**；重叠必须是正整数，让"重叠 0.5 帧"这种无法渲染的诉求在校验期就被拒（`plan.js:339`） |
| **`deriveLayout` 派生而非存储** | 场景起点 = 前一场终点 − 重叠，一处推导（`plan.js:158-166`）。今天 D3 的错正出在"派生规则对、使用处没走它" |
| **`planFingerprint` + `diffById` + 版本 Store + `production-lock` + `write-guard`** | 这是"可证明"的全部本钱。MH 的三分法**没有对应物**，抄不到，丢了补不回来 |
| **`unknown` 状态永不自动重试**（`ADAPTER_INTERFACE_VERSION`/`NO_AUTO_RETRY_STATES`） | "可能已经渲染过的任务不能再渲染一次"。这是数据安全，不是洁癖 |
| **音轨锁影片时间**（`assertAudioKeepsMovieTime`） | 变速不悄悄加速人声。这条必须在，哪怕 remap 今天没接 |
| **三个适配器共享同一对象模型（可交叉验证）** | 三份实现能力逐字相同（8 种对象 / 3 种转场 / 3 个术语，见 [`ffmpeg`](../产品实现/media/render/ffmpeg-adapter.js#L53) [`remotion`](../产品实现/media/render/remotion-adapter.js#L38) [`hyperframes`](../产品实现/media/render/hyperframes-adapter.js#L42)）。这让"同一个 plan 三个引擎出同一帧"成为验证手段。**换成单运行时，等于把三路交叉验证降级成单一真相——那不是简化，是失去裁判** |

关于最后一条要补一个限定：**"能力完全相同"在今天不是优点，是贫血的证据**——三个适配器都只认 8 种对象、3 个术语，说明它们共享的不只是对象模型，还有**同一份贫乏**。所以正确的说法是：**保留"三个实现共享同一份声明"这个结构，但让这份声明变厚**，而不是"因为都一样所以砍掉两个"。

### 5.3 哪一部分应该立刻换

**立刻换 FFmpeg 侧的"场景拼接方式"：从"全局 xfade offset"改成"逐区间 frame-accurate overlay"。**

| | 今天 | 换成 |
|---|---|---|
| 怎么拼 | 一条滤镜链，场景 A `[v]` 与 B 用 `xfade=offset=<绝对秒>` 叠加，offset 依赖前序累计时长 | 每个重叠区间内，A、B 两路各自按**帧号**对齐（`trim` + `setpts` 到同一区间），用加权 `blend`/`overlay` 输出该区间的帧 |
| D2 会不会复发 | 会（`enable` 表达式与场景链起点不同源） | 不会：`enable` 只在一个区间内有效，区间边界由帧号裁出来 |
| D3 会不会复发 | 会（offset 基准错） | 不会：**没有全局 offset 这个概念了**，误差无处累积 |
| 代价 | — | 一条场景链变成 N 条短链 + N−1 个区间合成；滤镜图更长，但**可分段验证**（每段能单独出帧比对） |

为什么这一条排第一：**它是唯一一个"换掉之后 D2+D3 同时结构性消失"的改动**，而且它不依赖路线乙完成——今天就能做，做完路线乙接手时正好复用同一套"区间 + 帧号"的心智模型。相比之下，"把 12 处 `toFixed(6)` 收敛成一个 `frameToSecondsExact()`"虽然也对，但它是卫生工作，不消除任何已知缺陷。

**排第二（紧随其后，必须同一批做）**：把 `web-scene` 落地时，收帧**不要** `format=yuv420p`（§4.2）。这是唯一一个"做晚了要重渲全部素材"的决定，所以它的时间窗口比它的优先级更紧。

### 5.4 一张决策表收尾

| 问题 | 答案 | 依据强度 |
|---|---|---|
| 换秒制做时间基？ | **不换。** 秒只做投递格式，不做存储格式 | 强（§1.4 三条件 + D3 可审计性） |
| 秒制会退回浮点累加吗？ | **不会**，只要不累加、不进 plan、不降精度。反例是 `stage.js` 的 live 预览墙钟，它被隔离在 render 模式之外 | 强（实测代码） |
| 把场景代码放进 plan？ | **放，但只放 `codeHash` + `params`**（§2.2 R1–R4） | 中（设计判断，无一手对照） |
| 直接采用它的 React 形态？ | **不采用。** 同一条路，GSAP `seek` 更适合我们的 637 张卡 | 中（推断：React 逐帧的确定性靠纪律） |
| 做透明视频？ | **做，且只做中间态。** ProRes 4444 / qtrle；VP9 alpha 本机实测不可用 | 强（§4.2 实测） |
| 换掉拼接方式？ | **立刻换**（§5.3） | 强（D2/D3 根因同源） |
| remap 接不接？ | **接，但要先解开 `assertAudioKeepsMovieTime` 的否决**——它今天禁止任何对象携带 `timeRemap` | 强（`remap.js:247-252` 实测） |

---

## 附 A · 实证索引

| 结论 | 位置 | 手段 |
|---|---|---|
| 重映射内部帧是 6 位小数浮点 | [`media/remap.js:88`](../产品实现/media/remap.js#L88) | 读码 |
| 渲染层收的是 6 位小数秒字符串（3 份拷贝） | [`ffmpeg-adapter.js:94`](../产品实现/media/render/ffmpeg-adapter.js#L94)、[`hyperframes-adapter.js:51`](../产品实现/media/render/hyperframes-adapter.js#L51) | 读码 |
| 音轨用整数毫秒延迟 | [`ffmpeg-adapter.js:368`](../产品实现/media/render/ffmpeg-adapter.js#L368) | 读码 |
| `timeRemap` 在渲染层只命中一行且是注释 | `media/render/*.js` grep，唯一命中 `ffmpeg-adapter.js:355` | grep |
| 任何对象带 `timeRemap` 会被抛错 | [`remap.js:247`](../产品实现/media/remap.js#L247) | 读码 |
| 三适配器能力表逐字相同（8/3/3） | [`ffmpeg:53`](../产品实现/media/render/ffmpeg-adapter.js#L53)、[`remotion:38`](../产品实现/media/render/remotion-adapter.js#L38)、[`hyperframes:42`](../产品实现/media/render/hyperframes-adapter.js#L42) | grep |
| `canvas-program-animation`/`flattened-video` 不在任何适配器清单 | 同上三处 | grep |
| `zoompan`/`letter-spacing`/`loudnorm`/`blend` 代码命中 0 | `media/**`、`core/project/**` | grep |
| `keyframe` 12 次全是编译数组 | [`motion.js:140`](../产品实现/media/motion.js#L140) | 读码 + grep |
| `web-scene` / `__seek` 在产品实现里命中 0（路线乙未落地） | `media/**` | grep |
| `gsap` 12 处命中；卡片 `stage.js` 用 `tl.seek(sec)` + `FPS=30` 写死 | [`stage.js:11`](../已确认资产/01-作品与案例/10-gongnyang-awesome-ai-motion/lib/stage.js#L11)、[`stage.js:44`](../已确认资产/01-作品与案例/10-gongnyang-awesome-ai-motion/lib/stage.js#L44) | 读码 |
| live 预览用墙钟累加、render 模式走 `__seek` | [`stage.js:65`](../已确认资产/01-作品与案例/10-gongnyang-awesome-ai-motion/lib/stage.js#L65)、[`stage.js:12`](../已确认资产/01-作品与案例/10-gongnyang-awesome-ai-motion/lib/stage.js#L12) | 读码 |
| Remotion `fps` 传 `num/den` 浮点比 | `templates/remotion/src/Root.jsx:10-16` | 读码 |
| FFmpeg **9.0.1**（> MH 要求的 7+） | `ffmpeg -version` | 实测 |
| `prores_ks` → `yuva444p12le`，alpha 0.5→126/127 | `ffmpeg` 编码 + `ffprobe` + `alphaextract` 读字节 | 实测 |
| `qtrle` → `argb`，alpha 0.5→127 | 同上 | 实测 |
| `libvpx-vp9` alpha 失败（`alpha_mode=1` 但 `alphaextract` exit −22） | 同上 | 实测 |
| `zoompan`/`loudnorm`/`xfade`/`alphaextract` 滤镜本机存在 | `ffmpeg -filters` | 实测 |
| 30000/1001 全仓库无用例 | `plan.js`/`remotion-adapter.js`/`checks.js` grep 0 命中 | grep |

## 附 B · 未验证/存疑，别当成结论用

1. **MH 的帧调度细节**：怎么保证"设 t → 取到该 t 的像素"而不卡 `requestAnimationFrame` 半帧。`/api/preview/capture` 的存在说明它有专门通路，但抓帧时序未知。**标【推断】**。
2. **MH 是否逐帧重渲染 React 还是缓存**："stateless, reconstructs from start on every call"是 SDK 动画函数层的描述，不等于 UI 层每帧重建组件树。**两者可以并存，我按前者推断，可能不准。**
3. **Remotion 是否接受非整数 `fps`**：本机未装 remotion（`video-config.js` 不存在），只有官方文档印象。**若这条成立，则我们的 `Root.jsx` 在 29.97 项目上会炸**——建议单独用一次真渲染验证，成本约 10 分钟。
4. **MH 的音频时间线是否也走秒**：`time-remap.js` 的切片语义只谈画面，音频侧无证据。
5. **VP9 alpha 的失败可能是我的测试方式问题**（`alphaextract` 对 WebM 附加流支持不佳），不代表 WebM 本身不能带 alpha。**要下结论需要一次真实播放器验证**（把 webm 叠到实拍上用浏览器/达芬奇看）。已按"不可用"执行，但标注为"本次不可用"而非"永远不可用"。
6. **`web-scene` 的 `params` 校验真空**：这是设计缺陷不是实测，缓解方案（场景自带 `params.schema.json` 入 `codeHash`）未验证可行性。
7. **6 位小数会不会在 1000fps 以上撞车**：本文只论证了 30/60/120 fps 安全（安全系数 33000/16000/8000 倍），更高帧率未验证。
