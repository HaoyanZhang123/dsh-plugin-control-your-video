# D — 渲染能力审计与三条技术路线评估

> 审计时间：2026-11-11（Asia/Shanghai）。范围：`产品实现\media\` 全部源码（只读）＋ 本机真实技术验证。
> 结论分级：**实测**（本机跑出来）/ **读码**（file:line 可查）/ **未确认**（无法证明）。
> 全文只写一个文件；临时脚本与截图在 `C:\Users\18149\AppData\Local\Temp\dsh-audit\`。

---

## 0. 一句话结论

引擎的短板**不在"三种运动"**，而在**没有"镜头"和"图层"这两个概念**：CompositionPlan 的对象模型里 `camera` 出现 0 次、`mask` 0 次、`blend` 0 次（全量 grep，见 §1.3），所以任何"推拉摇移、遮罩、混合模式"都无处安放，不是参数缺失而是结构缺失。

而用户那三个 three.js 网页证明了另一件事：**好看的画面本身是一个"时间的纯函数"，不需要被塞进 CompositionPlan 的对象列表里**。我实测确认这条路可复现、可并行、且一天能跑完全片（§3）。因此推荐（§4）是**路线乙作为画面层，保留 CompositionPlan 作为时间/音频/字幕层**，而不是继续给滤镜图加参数。

---

## 1. 任务一：现有引擎的精确能力矩阵

### 1.1 先纠正一个前提：运动术语是 7 个，但只有 3 个能用

任务书说"只有 `fade-in/fade-out/hold` 三种运动"。**对适配器成立，对计划词汇不成立**：

| 层 | 事实 | 证据 |
|---|---|---|
| 计划词汇层 | 定义了 **7** 个术语：`fade-in` `fade-out` `slide-in` `scale-in` `pulse` `loop-rotate` `hold` | `motion.js:29-86` |
| 适配器能力层 | 三个适配器**全部只声明 3 个**：`fade-in` `fade-out` `hold` | `ffmpeg-adapter.js:53`、`remotion-adapter.js:38`、`hyperframes-adapter.js:42` |
| 强制层 | 计划里写了第 4 个术语 → `validateCommon` 直接报错，不许渲染 | `adapter.js:344-353` |

也就是说 `slide-in` / `scale-in` / `pulse` / `loop-rotate` 是**计划层的死词汇**：写了必然被拒。更糟的是这四个里有两个就算放行也**不会动**：

- `loop-rotate`：`push()` 里 `rotation` 被硬编码为 `0`（`motion.js:181`），术语声明 `from:0,to:360`（`motion.js:70-77`）从来没被读取。
- `spec.loop`：只被复制进返回值（`motion.js:194`），**从未参与关键帧计算**；`pulse` 的 `from:1,to:1.06` 只在 enter 阶段生效（`motion.js:161-169`），所以"脉动"实际是"入场时放大一次"。

**这一条修正很重要**：如果按"再加 5 种运动"去修，会白白重写一套已经在的词汇表；真正要做的是"让术语连到渲染器"。

### 1.2 能力矩阵（12 维度）

判据：**能** = 有一个适配器真能渲出来且计划能表达；**近似** = 只能用别的机制凑，语义有损；**不能** = 计划里没有这个字段，或适配器明示不支持。

| # | 维度 | 判定 | 具体状态 | 证据 |
|---|---|---|---|---|
| 1 | 硬切（零帧切换） | **能** | `cut` 走 `concat=n=2`，不产生重叠帧 | `ffmpeg-adapter.js:309-311` |
| 2 | 推/拉（zoom） | **不能** | 无 `zoompan`，无随时间变化的 `scale`；`scale` 只在素材导入时静态 fit | `ffmpeg-adapter.js:266-268`（`force_original_aspect_ratio`），全库 `zoompan` 命中 0 |
| 3 | 摇/移（pan） | **不能** | 无 `crop` 的关键帧表达式；`overlay` 的 x/y 取自对象静态 `box` | `ffmpeg-adapter.js:250`、`:274` |
| 4 | 环绕 / 手持 / FOV | **不能** | 全库 `camera` 命中 **0**；无 3D 概念 | 全量 grep（§1.3） |
| 5 | 多轨 | **近似** | 有 `tracks` 概念但**只登记影片级对象**（字幕/音频），场景内对象靠数组顺序叠 | `plan.js:504-538`（movie 对象必须挂 track）；`ffmpeg-adapter.js:226` 按 `plan.objects` 顺序画 |
| 6 | opacity | **能** | 对象静态 `params.opacity` → `colorchannelmixer=aa=` | `ffmpeg-adapter.js:269-270` |
| 7 | blend mode | **不能** | 无 `blend=` 滤镜，全库 `blend` 命中 **0** | 全量 grep（§1.3） |
| 8 | z-order | **近似（且不一致）** | HyperFrames 按 `zIndex` 排序；FFmpeg **忽略 `zIndex`**，只按计划数组顺序 | `hyperframes-adapter.js:116` vs `ffmpeg-adapter.js:226`（无 sort） |
| 9 | blur / 色调 | **不能** | `boxblur` `gblur` `eq` `hue` `curves` `lut3d` `colorbalance` 命中 **0** | 全量 grep |
| 10 | 矩形遮罩 | **不能** | 无 `mask`、无 `crop` 关键帧、无 `geq` | 全量 grep |
| 11 | 形状 / 路径遮罩 / alpha matte | **不能** | `alphamerge` `maskedmerge` 命中 **0**；`clipPath` 命中 **0** | 全量 grep |
| 12 | 字距 / 行距 / 竖排 | **不能** | `drawtext` 参数只有 `fontfile/textfile/fontsize/fontcolor/x/y/box/alpha/enable` | `ffmpeg-adapter.js:165-178` |
| 13 | 描边 / 投影 / 渐变 | **不能** | 无 `borderw`（`boxborderw` 是背景框内边距，不是描边）；`shadowcolor` `gradient` 命中 **0** | `ffmpeg-adapter.js:174` |
| 14 | 逐字动画 | **不能** | 无词级时间，且产品**主动禁止**声明 `wordLevel` | `sound.js:82`、`sound.js:99-113`、`plan.js:607-614` |
| 15 | 转场种类 | **近似（3/约50）** | `xfade` 只用了 `fade` 与 `wipeleft` 两个名字 | `ffmpeg-adapter.js:319` |
| 16 | 程序化图案 | **近似（3 种）** | 只有 lavfi 的 `life` / `cellauto` / `mandelbrot` | `ffmpeg-adapter.js:56`、`:237-245` |
| 17 | 自定义 shader | **不能** | 无任何 GLSL/shader 通道；`canvas-program-animation` 类型在计划里存在但**三适配器全不支持** | `plan.js:93-98` vs `FFMPEG_OBJECT_KINDS`（8 项，不含它） |
| 18 | 音频驱动动画 | **不能** | 无频谱、无包络、无 `astats` 回传 | 全量 grep |
| 19 | 响度标准化 | **不能** | 音频链只有 `atrim/asetpts/aresample/aformat/volume/adelay/amix`，**无 `loudnorm`** | `ffmpeg-adapter.js:370-390`；`loudnorm` 命中 0 |
| 20 | 频谱 | **不能** | 无 `showspectrum` / `showwaves` | 全量 grep |
| 21 | 变速 | **近似** | `TimeRemapSpec` 完整（速度键、linear/step、双向解析）但**没有任何适配器实现它** | `remap.js:39-227`；`remap.js:46-48` |
| 22 | 定格（speed=0） | **近似** | 引擎能算，渲染器不接 | `remap.js:209-212` |
| 23 | 反向 | **不能** | 显式要求 `supportsReverse:true`，无人声明 | `remap.js:46-48` |
| 24 | 时间重映射衔接转场 | **未确认** | 无适配器实现，无法判断 `xfade` offset 与重映射的相位关系 | — |
| 25 | LUT / 调色 | **不能** | `lut3d` `zscale` `colorspace` 全 0；`bt709` 只在测试 fixture 里出现 | `c12-unit.js:94` |
| 26 | 色彩空间保证 | **近似** | 每场景强制 `format=yuv420p`，末尾再 `format=yuv420p,setsar=1`；无显式 `colorspace` 滤镜 | `ffmpeg-adapter.js:292`、`:352` |

### 1.3 "不能"的取证方式

对 `产品实现\media` 下全部 `.js`（排除 `node_modules` 与 `evidence`）做全量正则计数，以下符号**命中数均为 0**：

```
loudnorm 0   boxblur 0   gblur 0   alphamerge 0   geq 0   maskedmerge 0
blend= 0     unsharp 0   lut3d 0   zscale 0       letter-spacing 0
shadow 0     gradient 0  zoompan 0 rotate= 0      vignette 0   noise= 0
clipPath 0   camera 0    mask 0     blend 0
```

`keyframe` 有 12 次命中，但**全部不是可编辑关键帧**：9 次在 `motion.js` 指"编译出来的逐帧数组"（`motion.js:140-183`），3 次在 `hyperframes-adapter.js` 指 CSS `@keyframes`（`:251`、`:258`）。**引擎没有"关键帧"这个可作者化的概念**——这句话是整个审计里最该记住的一条。

### 1.4 10 种对象类型里，2 种无人能画

| 计划声明的 10 种 | FFmpeg | Remotion | HyperFrames |
|---|---|---|---|
| `solid` `text-native` `subtitle` `image` `video-source-with-offset` `program-pattern` `program-counter` `audio-continuous` | ✅ | ✅ | ✅ |
| `canvas-program-animation` | ❌ | ❌ | ❌ |
| `flattened-video` | ❌ | ❌ | ❌ |

证据：三个适配器的 kind 白名单都是同样 8 项（`ffmpeg-adapter.js:38-49`、`remotion-adapter.js:23-32`、`hyperframes-adapter.js:27-36`），而计划允许 10 项（`plan.js:41-105`）。FFmpeg 在 `ffmpeg-adapter.js:290` 对未知类型直接抛错。**这两个类型是死类型**，写进计划会被 `validateCommon` 拒（`adapter.js:336-343`）。

### 1.5 三个适配器其实是同一个天花板

| | FFmpeg | Remotion | HyperFrames |
|---|---|---|---|
| 运动 | 3 | 3 | 3 |
| 转场 | 3 | 3 | 3 |
| 对象 | 8 | 8 | 8 |
| 实现方式 | 滤镜图（`overlay`/`drawtext`/`xfade`） | React 组件 + 内联样式 | 生成 HTML + GSAP `seek` |
| 确定性自述 | 未声明 | "帧内容应一致，字节不承诺"（`remotion-adapter.js:131-134`） | 同（`hyperframes-adapter.js:433`） |
| 续渲 | 不支持 | 不支持 | 不支持 |

**关键判断：三个"独立"适配器的能力完全相同，因为它们共享同一个对象模型。** 换适配器不会变好，这是路线甲必须扩计划本身的原因。

### 1.6 现有最早熟、最容易兑现的两块能力

1. **时间层是完整且正确的**：整数帧＋有理数时长（`plan.js:145-156`）、场景起点由重叠派生（`plan.js:187-229`）、总时长计算而非猜测、转场重叠不得吃掉整个左场景（`plan.js:204-206`）。`remap.js` 更是有双向括号解（`:145-159`，40 次二分）和单调性检查（`:99-105`）。**这块不该推翻。**
2. **确定性校验是真实存在的**：`checks.js` 有区域变化阈值（`:26-27`）、`countColorRuns`（`:38`）、编码前后对照、音频过零率检测（`:294-349`）。这些是路线乙的现成验收工具。

---

## 2. 任务二：三条技术路线

### 2.1 路线甲：扩现有 CompositionPlan

**要改什么**（这是工程量的大头，不是加字段本身）：

| 改动 | 位置 | 性质 |
|---|---|---|
| 新增 `camera` / `transform` 通道 | `plan.js:41-105` 加 kind，或加 `object.transform` | 破坏 schema，需 `PLAN_SCHEMA_VERSION` 升级（`plan.js:24-27` 只认 `1.0.0`） |
| 新增 `mask` / `blend` / `blur` / `grading` 字段 | `plan.js` 校验器 + `diffPlans` 的字段列表（`plan.js:754`） | 每加一个字段，`diffPlans`/`assertRepairScope` 都要同步 |
| 关键帧模型 | 全新模块（现在没有） | 需要 `keyframes: [{frame, value}]` + 每帧求值 + 与 `timeline` 的优先级规则 |
| 术语连到渲染器 | `motion.js:181` 修 `rotation`、`:194` 接 `loop` | 2 处小修，收益立刻可见 |
| 三适配器 capabilities | `ffmpeg-adapter.js:50-56`、`remotion-adapter.js:35-38`、`hyperframes-adapter.js:39-42` | 每加一个维度 ×3 |
| FFmpeg 滤镜图 | `ffmpeg-adapter.js:216-294` 每个对象的绘制分支 | 每个新维度都要写一条新滤镜链 |

**Remotion 能顶住吗？** 能，而且它是三条里最不需要担心的：Remotion 就是 React，`transform`/`filter`/`mask`/`mixBlendMode`/`clipPath`/字体排版全是 CSS 原生能力，写进 `templates/remotion/src/Unit.jsx` 即可。**但有个讽刺的结论**：既然 Remotion 能靠 CSS 顶住，那"用 CSS/Web 表达画面"才是自然形态，而把它硬压回 CompositionPlan 的扁平字段表，是把富表达能力降维成贫字段——这正是路线乙的论据。

**FFmpeg 滤镜图会不会爆炸？** 会，而且已经有爆炸前科。`ffmpeg-adapter.js:300-302` 的注释记录了一次真实事故：

> `xfade` 的 offset 按**累积流**计算，用上一场景局部时长"恰好对一个转场正确，把后面每个都截短了（D3：声明 1464 帧，实际渲出 696 帧）"

这是一个"单通道、线性、3 种转场"的图就已经出错的实证。加 mask（`alphamerge`）、blend（`blend`）、每对象 blur、逐帧关键帧表达式（`zoompan` 的 `z='...'` 表达式）之后，图会变成：对象数 × 维度数的链式叠加，每层都要重新算 label、算 `enable` 时间窗、算 PTS 重基。**且 filter_complex 无静态校验器**——错一个 label 就是运行时失败或无输出，只能靠渲完回头看帧（`checks.js` 正是为此存在）。

更硬的成本：`ffmpeg-adapter.js` 已 1028 行，只支持 8 种对象 3 种运动。按同样密度加 5 个维度，预计到 2500–3500 行，并且**每加一个维度都要在 3 个适配器里实现 3 遍、语义还要一致**（现在 `zIndex` 已经不一致了，见 §1.2 #8）。

**多久能到"能做出像样的镜头运动"？** 我的判断是 **12–18 人日**，且到不了"像样"：

| 里程碑 | 人日 | 结果 |
|---|---|---|
| 修死术语（`rotation`/`loop`）+ 放开 4 个术语到 FFmpeg | 3–4 | 有旋转和循环缩放，仍无镜头 |
| 加 `transform` + 关键帧插值（推/拉/摇） | 6–8 | 有二维护关键帧，难写难调 |
| 加 `xfade` 全部转场名 + `eq`/`curves` 调色 | 2 | 廉价收益，实际最划算 |
| 加 mask/blend | 5–8 | 滤镜图复杂度再上一档 |

**结论**：路线甲能修好"转场单调"和"死术语"，这两件事**便宜且应该做**（约 5 人日，见 §5）。但它修不出"镜头"，因为镜头是三维的，而滤镜图是二维的——这条路的天花板是"更好的 PPT"，不是"用户那三个网页的画面"。

### 2.2 路线乙：Web 场景路线（把"一个 Web 场景"当成片的最小单位）

**这是我最推荐的路线，而且它不是新发明——产品里已经有它的雏形。**

`hyperframes-adapter.js:332-396` 生成的模板已经是"纯时间函数"：

- `gsap.timeline({ paused: true })`（`:365`）
- `window.__timelines['main'] = timeline`（`:393`），注释 `:334` 明写「HyperFrames seeks the timeline registered on `window.__timelines[compositionId]`」
- 图案不用 `Math.random`，用自写 LCG（`:347-351`），按 `drawPatternAt(timeSeconds)` 重算（`:358-361`）

**也就是说"逐帧 seek + 时间纯函数"这个机制已经被产品接受了**，只是它驱动的是"生成的 HTML + 8 种对象"，而不是"一个真正的场景"。

**需要什么**：不需要 Playwright/Puppeteer 包。实测本机：

| 项 | 实测结果 |
|---|---|
| node | `v24.22.1`（自带全局 `WebSocket` 与 `fetch`） |
| 全局 npm 包 | 只有 `@deepseek-ai/dsh`、`agent-desktop`、`pnpm` —— **无 playwright、无 puppeteer** |
| 浏览器二进制 | Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`；Edge 同在；`ms-playwright` 缓存里有 `chromium-1194` |
| 现成 CDP 脚本 | `RENDER-LAB\12-preview-parity\cdp-shot.mjs` 已用"手写 WebSocket + CDP"截过图 |
| 现成 puppeteer-core | `RENDER-LAB\04-hyperframes\node_modules\puppeteer-core` 在 |

我用**零依赖 CDP**（`fetch` 拿 `/json/list` + 全局 `WebSocket` 发 `Page.captureScreenshot` / `Runtime.evaluate`）跑通了全部实验，见 §3。结论：**依赖成本接近 0**。

**确定性怎么保证？** 这是路线乙最容易被质疑、但我实测通过的环节。

| 实验 | 结果 | 判定 |
|---|---|---|
| `花园.html?t=0.42&freeze=1`，同进程连拍 2 张 | sha256 **完全相同**（`eb146c05d316e809`，576 557 B） | ✅ |
| 同参数**另起一个 Chrome 进程**再拍 | sha256 **仍为** `eb146c05d316e809` | ✅ **跨进程一致** |
| `t=0.77` | `d68ac53bef0260de`，与 0.42 不同 | ✅ 证明 `t` 真被吃进 |
| 换后端 swiftshader / d3d11 / basic-render，同 t 各拍 2 张 | 三者各自内部一致 | ✅ 同后端可复现 |
| 三种后端**之间**比较 | `6e1b02b6` / `fb16b775` / `1ba814b2` **互不相同** | ⚠️ 跨机器像素级一致**不成立** |

**所以准确的说法是**：确定性成立在"同机同后端"这一级，够用来做渲染验收（两次渲同一帧应一致），不够用来做"字节级跨机可复现"。`remotion-adapter.js:131-134` 和 `hyperframes-adapter.js:433` 的自述恰好也是这个粒度——**产品现有承诺不需要改，这条路线不需要放宽任何标准**。

`海滩3渲2.html` 更麻烦，但也能制住。它没有 `setTime`，主循环用 `new Clock().getDelta()` 累加墙钟时间。我在页面加载**前**注入：

```js
let t = 0
Object.defineProperty(performance, 'now', { value: () => t })
window.requestAnimationFrame = (cb) => { window.__RAF_Q.push(cb) }
window.__pump = (d) => { t += d; /* 手动执行队列 */ }
```

实测：泵 6 帧 → `__UMI__.elapsed = 0.16666666666666669`；泵 12 帧 → `0.36666666666666664`。**时间被精确接管**。跨进程同样 24 帧 → sha 均为 `2cff47828364101d`，`drawCalls=258` 也相同。**但没有回卷能力**：把时钟重置到 0 再泵 6 帧，`elapsed` 仍是 0.366 而非 0.166 —— 内部累加器与模拟状态不可逆。含义是：**只能顺序渲染，不能随机访问某一帧**。这对"顺序出片"完全够用，对"拖动时间轴预览"不够。

**性能如何（48 秒 30fps = 1440 帧）？** 实测同一台机器、`花园.html`、1280×720：

| 后端 | 实际渲染器 | CDP 截图 | 页内 `toDataURL` | 1440 帧（页内） |
|---|---|---|---|---|
| swiftshader | SwiftShader Vulkan | 788.1 ms/帧 | 178.2 ms/帧 | ≈ 4.3 分钟 |
| **d3d11** | **Intel Arc B370** | 259.1 ms/帧 | **11.5 ms/帧** | **≈ 17 秒** |
| disabled-gpu | Microsoft Basic Render | 411.1 ms/帧 | 93.7 ms/帧 | ≈ 2.3 分钟 |

**关键结论：慢的不是渲染，是取帧通道。** CDP `Page.captureScreenshot` 每帧要传 571 KB PNG，占了 259 ms 里的绝大部分；页内 `canvas.toDataURL()` 只要 11.5 ms。所以正确的实现是**页内取帧 + 逐帧写文件（或走 `Page.setDownloadBehavior`），CDP 只负责控制和断言**。

（如实说明：这三个数是在 1280×720 上测的，1080p 会按像素数上升约 2.25 倍，仍在一分钟内。另外 `花园.html` 的 `setPixelRatio` 被钳到 `min(dpr,1.5)`，且 `antialias:!1`，所以 720p 的成本不代表 4K。）

**与现有 CompositionPlan 怎么衔接？** 这是这条路线的真正设计点。不要试图把场景塞进 `objects[]`：

| 层 | 归谁 | 理由 |
|---|---|---|
| 时间基、场景切分、转场重叠、总帧数 | **CompositionPlan（保留）** | `plan.js` 已正确，且 `checks.js` 的验收建立其上 |
| 音频、字幕窗口、字幕-音频漂移检查 | **CompositionPlan（保留）** | `sound.js:135-203` 是现成的、且有真实 probe 时长 |
| 画面 | **Web 场景（新）** | 一个场景 = 一个可 seek 的 Web 文档 |
| 合成与编码 | **FFmpeg（保留）** | 帧序列 → `-framerate 30 -i %06d.png` → 叠字幕轨 → 编码 |

具体形态：新增一种对象类型（建议 `web-scene`），字段只有 `{ sceneId, src, seekMode: 'setTime'|'pump', readyProbe, params }`；适配器按帧循环 `setTime(f/fps)` → 取帧。**CompositionPlan 的其余部分一行不用改**，`deriveLayout`、`checkSubtitleAudioRelation`、`assertRepairScope` 全部继续有效。

**那三个 html 能不能直接被驱动？**

| 文件 | 自带驱动接口 | 可直接驱动？ | 实测证据 |
|---|---|---|---|
| `花园.html` | `window.__YOI__`：`setTime(t)` `renderNow()` `freeze()` `setShot(name)` `setGirl()` `getState()`；URL `?t= &freeze=1&notitle=1&noveil=1&shot=` | **能，零改造** | `getState()` 返回 `{"time":0.42,"frozen":true,"drawCalls":1,"errors":[],"ready":true}`；`sameInstantEqual=true` |
| `海滩3渲2.html` | `window.__UMI__`：`ready/renderer/scene/camera/controls/ctx/VIEWS/setView/snapshotStats`；URL `?solo= &view= &cam=x,y,z,radius,theta,phi & raw=1 & exp/sat/contrast/outline/bloom` | **能，但要注入时钟覆写**（无 `setTime`） | 注入后 `elapsed` 精确等于 帧数×1/30；跨进程同帧 sha 一致 |
| `深海.html` | `window.__ABYSSAL__`：`ready/stage/previousStage/time/transitioning/drawCalls/scene/camera/renderer/post/world/setView/setStage/beginDive/setCameraView/getDebug` | **不能直接**，有 `time` 字段但无 `setTime` | 连拍 2 张 sha 不同（`e8cbd9f7…` vs `c73ae955…`）；需补一个 `setTime` 或注入时钟 |

三个文件都**完全自包含**（0 处 `<script src>`、0 处外部 `import`、0 处 http 资源，只有 1 个 `www.w3.org` 是 SVG 命名空间字符串），体积 679–898 KB，three.js 被内联压缩进同一个 IIFE。这意味着**不需要网络、不需要 npm、不会破坏"外部工具不入包"约束**——它们就是用户自己的文件。

### 2.3 路线丙：外部工具

先厘清约束的**真实**边界。`RENDER-LAB\00-auth\授权与版本锁定记录.md:30` 的原文是：

> 「不把 Remotion / HyperFrames / FFmpeg 标为 MIT，**不随任何包分发**。」

**约束是"不分发"，不是"不能用"**。Remotion 现在就能用（`remotion-adapter.js` 已在，只在 `index.js:214-228` 检测到渲染工作区时才注册）。所以路线丙不是"能不能引进"，而是"引进哪个、值不值"。

| 候选 | 能做出好画面？ | 接入代价 | 许可状况（实测 / 已锁定记录） |
|---|---|---|---|
| **Remotion 4.0.541** | **能**（React+CSS 全能力：mask/blend/filter/任意 SVG/three.js 也能塞） | 低——适配器已在（`remotion-adapter.js:107-399`），只需扩 `Unit.jsx` 与 capabilities | `"SEE LICENSE IN LICENSE.md"`——**非 SPDX、非 MIT**（`00-auth:38`）。个人/小团队免费，公司需付费许可。**不分发即可** |
| **HyperFrames 0.9.19** | 中（HTML+GSAP，能力等同 Remotion 的子集，但多了 `seek` 契约） | 低——适配器已在 | `Apache-2.0`（`00-auth:39`），最宽松 |
| **Rive** | 能（矢量骨骼动画质量高） | 高：要 `.riv` 编辑器产出的资产，代码里只能播放不能生成；`@rive-app/canvas` 需联网取 runtime | runtime 为 MIT，**编辑器为商业订阅**（未确认具体条款） |
| **Lottie** | 中（适合图标/转场点缀，不适合主画面） | 中：`lottie-web` MIT，但要有 After Effects 或 Figma 产出 JSON | `lottie-web` MIT；AE 本体商业（未确认版本） |
| **Blender** | **能**（真正的 3D、真镜头、真材质） | **很高**：Python 脚本 + 无头渲染 + 资产管线；单帧 ray/path tracing 成本高；确定性需固定 seed/采样 | GPL——**GPL 传染风险对闭源插件最危险**，只能"调用外部进程"不能链接 |
| **After Effects 脚本 (ExtendScript)** | **能**（行业标准） | **极高**：需装 AE（订阅制）、Windows 上需 `aerender`、脚本模型古老、无法无头免费 | 商业订阅，**不可分发**，且每次渲染吃满一台机器 |
| **DaVinci Resolve 脚本** | 能（调色最强） | 高：需装 Resolve（免费版可用）、Python API、`resolve` 需 GUI 会话 | 免费版可商用但**脚本 API 需 Studio 版的部分能力**（未确认边界） |

**路线丙的真实定位**：Remotion **已经在这条路上**，它就是"路线乙的一个特例"——Remotion 的本质也是"Web 场景 + 无头 Chromium 逐帧"。所以路线丙的价值不是"再引入一个工具"，而是"**别再找第四个渲染器了，把 Chromium 本身就当成渲染器**"。用户那三个 html 恰好证明了这一点：它们不需要 Remotion、不需要 Blender，一个浏览器就够。

### 2.4 三条路线对照

| | 甲：扩 CompositionPlan | 乙：Web 场景 | 丙：外部工具 |
|---|---|---|---|
| **能做出什么** | 更好的图文排版、更多转场、基础推拉 | **用户那三个 html 的画面原样进片**；真 3D、真镜头、真光 | Remotion 路线的全部；Blender 上限最高 |
| **做不到什么** | 三维镜头、环绕、景深、粒子；本质仍是二维叠加 | 需要人写场景；"一句话生成"仍靠外部模型；随机访问单帧（`海滩`/`深海`）受限 | Blender/AE 工程量大到一个人扛不住；GPL/订阅风险 |
| **工程量（人日）** | 12–18（到"像样"仍不够） | **8–12**（含新 kind、取帧器、FFmpeg 收帧、验收） | Remotion 已付；Blender/AE 各 30+ |
| **主要风险** | 滤镜图复杂度爆炸（已有 D3 事故前科）；三适配器 ×N 维度的一致性维护 | 场景要人写；`深海` 需补 `setTime`；跨机器像素不一致 | 许可与分发；GPL 传染；外部进程不可控 |
| **与"一个人用"匹配** | 中（维护成本压在一个人身上，越加越重） | **高**（场景是文件，坏了换文件） | Remotion 高；Blender/AE 低 |

---

## 3. 任务三：技术验证记录（可复现）

所有脚本在 `C:\Users\18149\AppData\Local\Temp\dsh-audit\`：`analyze-html.mjs`、`probe-determinism.mjs`、`probe2.mjs`、`probe3.mjs`；截图在 `shots\`；结果在 `determinism-report.json`、`probe3.json`。**未修改任何现有文件。**

### 3.1 环境探测（实测）

```
node v24.22.1 / npm 11.19.1
npm ls -g --depth=0  →  @deepseek-ai/dsh@0.2.1-rc.2, agent-desktop@1.0.2, pnpm@11.21.0
                        （无 playwright、无 puppeteer）
Chrome  C:\Program Files\Google\Chrome\Application\chrome.exe        FOUND
Edge    C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe  FOUND
ms-playwright\chromium-1194\chrome-win\chrome.exe                     FOUND
workspace: RENDER-LAB\04-hyperframes\node_modules\puppeteer-core       FOUND
```

### 3.2 三个 html 的技术构成（实测）

| 项 | 海滩3渲2 | 深海 | 花园 |
|---|---|---|---|
| 字节 / 行数 / 最长行 | 898 206 / 4 768 / 284 563 | 792 243 / 4 843 / 143 611 | 679 658 / 4 592 / 117 779 |
| `<script src>` | 0 | 0 | 0 |
| 远程 `import` | 0 | 0 | 0 |
| 外部主机 | 仅 `www.w3.org` | 同 | 同 |
| 内联 three.js | 是（单 IIFE） | 是 | 是 |
| `ShaderMaterial` 次数 | 22 | 17 | 16 |
| `onBeforeCompile` | 9 | 8 | 3 |
| bloom/composite | 10 | 8 | 9 |
| 渲染循环 | `requestAnimationFrame(Ex)` + `Clock.getDelta()` | rAF | rAF + `?t=` 可定帧 |
| 全局接口 | `__UMI__` | `__ABYSSAL__` | `__YOI__` |

`海滩3渲2.html` 的 `window.__UMI__` 原文（压缩后一字未改）：

```js
window.__UMI__={ready:!1,renderer:Vt,scene:hi,camera:vn,controls:Ci,ctx:fo,
 get groups(){...}, get terrain(){...}, materials:zu, textures:Bu,
 get drawCalls(){...}, get triangles(){...}, get elapsed(){return ho},
 VIEWS:Ou, setView(r){...}, snapshotStats(){...}};requestAnimationFrame(Ex);
```

`花园.html` 的驱动面原文：

```js
var rr={version:kl,ready:!1,shots:[...],
 setTime(i){return zi=Dt(Number(i)||0,0,.9999)*zn,Aa.set(zi/zn),Yn=0,ir(0),rr.getState()},
 setShot(i,t=!0){...}, setGirl(i){...}, focusGirl(){...},
 freeze(i=!0){...}, renderNow:ir, getState(){...}};
window.__YOI__=rr;
```

### 3.3 逐帧截图确定性（实测）

```
WEBGL[swiftshader] {"vendor":"Google Inc. (Google)","renderer":"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)","version":"WebGL 2.0 (OpenGL ES 3.0 Chromium)"}
GARDEN run1 ready=true shotA=eb146c05d316e809/576557B shotB=eb146c05d316e809/576557B sameInstantEqual=true
GARDEN state {"version":"1.0.0","time":0.42,"phase":"blue-hour","shot":"establish","frozen":true,"camera":[10.308340453003117,42.19434849632435,64.06150380154637],"drawCalls":1,"fps":60,"frames":1,"errors":[],"storyTime":0,"ready":true}
GARDEN run2 shotA=eb146c05d316e809 shotB=eb146c05d316e809 sameInstantEqual=true
GARDEN crossProcessEqual=true
GARDEN t=0.77 shotA=d68ac53bef0260de differsFromT042=true
DEEP  two consecutive shots A=e8cbd9f7007bf4ba B=c73ae955179850f3 equal=false
BEACH harness {"umi":true,"ready":false,"queued":1,"err":null}
BEACH elapsed after 6 pumps=0.16666666666666669 after 12=0.36666666666666664
BEACH same-step(24) run1 elapsed=0.7666666666666666 sha=2cff47828364101d calls=258
BEACH same-step(24) run2 elapsed=0.7666666666666666 sha=2cff47828364101d calls=258
BEACH crossProcessEqual=true
```

吞吐：

```
swiftshader   cdpMs=788.1  urlMs=178.2  jpgMs=166.6  sameT=true
d3d11(hw)     cdpMs=259.1  urlMs= 11.5  jpgMs= 11.3  sameT=true   gl="ANGLE (Intel, Intel(R) Arc(TM) B370 GPU ...)"
disabled-gpu  cdpMs=411.1  urlMs= 93.7  jpgMs= 88.8  sameT=true
GARDEN throughput: 40 frames in 31.88s = 797.0 ms/frame（CDP 路径）；1440 帧 ≈ 19.1 分钟
```

### 3.4 Remotion 在本机的位置与版本

| 项 | 值 | 证据 |
|---|---|---|
| 声明版本 | `4.0.541` | `remotion-adapter.js:115`、`index.js:227` |
| 许可 | `"SEE LICENSE IN LICENSE.md"`（非 SPDX，非 MIT） | `RENDER-LAB\00-auth\授权与版本锁定记录.md:38` |
| 实际安装 | `RENDER-LAB\03-remotion\`（`package.json`、`package-lock.json` 139 KB、`remotion.config.js`） | 目录实存 |
| 已产出成片 | `05-output\remotion\C02Unit-remotion-v2-yuv420p-1280x720-30fps.mp4`（2 631 424 B）等 3 个 | 文件实存 |
| 冷/热两次渲染 | `10-determinism\parity\remotion-cold.mp4` 与 `remotion-warm.mp4` **均为 2 631 424 B** | 字节一致 |
| 注册条件 | 只有检测到 `renderWorkspace.browserExecutable` 才注册；否则 `available:false` | `index.js:214-228` |

---

## 4. 任务四：技术推荐

### 推荐：路线乙为主，路线甲做两处"便宜的补丁"，放弃路线丙的扩张

**理由（三条，都可查）：**

1. **画面质量的差距不在参数维度上。** 用户嫌丑，而他手上好看的三个网页没有一个用"关键帧"描述画面——它们的画面是 `time` 的纯函数（`花园.html` 的 `setTime`、`海滩` 的 `elapsed`）。想把这种画面塞进"对象 + 属性 + 转场"的扁平表，是范式错配，不是字段不够。
2. **路线乙的确定性已被实测证明，且产品已有的承诺不需要放宽。** `花园.html` 同进程/跨进程 sha 全等；`海滩` 注入时钟后跨进程 sha 全等。现有适配器自述的确定性粒度就是"帧内容一致、字节不承诺"（`remotion-adapter.js:131-134`），**恰好一致**。
3. **路线乙的机制在产品里已经存在。** `hyperframes-adapter.js:365-396` 就是 `timeline.seek(t)` + 时间纯函数。路线乙不是换框架，是**把这个已经跑通的机制从"生成的 HTML"升级到"真场景"**，并且提供了"新增一种 `web-scene` 对象类型"这个最小侵入点。

**具体落地顺序（建议，非承诺）：**

| 步 | 内容 | 人日 | 产出可验证 |
|---|---|---|---|
| 1 | 新增 `web-scene` kind + 页内取帧器（CDP 控制、`toDataURL` 取帧、逐帧落 PNG） | 3–4 | 能渲出 `花园.html` 的 48 秒序列，sha 可复现 |
| 2 | FFmpeg 收帧：`-framerate 30 -i %06d.png` + 叠现有字幕轨 + 音频链 | 2 | 成片与现有 `sound.js` 字幕窗口对齐 |
| 3 | `setTime` 探测协议：约定 `window.__SCENE__ = { ready, setTime, getState }`；缺 `setTime` 的用时钟注入 fallback | 2 | `深海.html` 被驱动（当前拍两张不一致） |
| 4 | 路线甲的两个便宜补丁（见下） | 3 | 转场从 3 种到 20+、`rotation` 真的转 |
| 5 | 验收：两次渲染同帧 sha 对比、字幕漂移检查、`probe` 声明/实测并列 | 2 | 复用 `checks.js` |

**路线甲只做两件事（合计约 5 人日，收益最大）：**

- `ffmpeg-adapter.js:319` 的 `xfadeTransition` 从二选一放开到 `xfade` 的名字表（`fade/wipeleft/wiperight/wipeup/wipedown/slideleft/smoothleft/circleopen/pixelize/radial/hblur` …）。**一行改动，转场从 3 种到 20 多种**，且 `xfade` 的 offset 语义已经踩平（`ffmpeg-adapter.js:300-302` 的事故注释）。
- `motion.js:181` 把 `rotation` 从硬编码 0 改为真正求值、`motion.js:194` 让 `loop` 参与关键帧。**两行改动，救活 4 个死术语中的 2 个。**

**明确不建议做的：**

- 不要给 FFmpeg 滤镜图加 mask/blend/blur/关键帧表达式。这一步会让 `ffmpeg-adapter.js`（已 1028 行）在两年内变成不可维护的单体，而收益是"更精致的 PPT"。
- 不要引入 Blender / After Effects / DaVinci。理由不是学不会，是**它们都要一个"人"来产出资产**，而用户的需求是"一句话生成"。他的三个 html 恰好是这条路线的产物，直接复用比换工具划算。
- 不要试图统一三适配器的能力表。`zIndex` 已经在 FFmpeg（忽略）与 HyperFrames（排序）之间不一致（§1.2 #8），继续加维度只会让不一致变成 N 处。

### 什么情况下我会改主意

| 触发条件 | 改到 | 为什么 |
|---|---|---|
| 用户真正想要的其实**不是** 3D 场景，而是"图文排版更高级"（能忍住不加 3D） | **路线甲全量** | 那 12–18 人日就值，因为需求本身是二维的 |
| `花园.html` 这类场景**无法被参数化**（每个镜头都得手改 html，不能由数据驱动） | **路线丙 Remotion** | Remotion 有 props 机制（`remotion-adapter.js:238-250` 已传参），能数据驱动；裸 html 不能 |
| 需要**随机访问任意帧**（时间轴拖动预览、逐帧调整） | 路线乙只保留 `花园` 类（有 `setTime`），`海滩`/`深海` 类降级为"只能线性渲" | 实测已证明内部累加器不可回卷 |
| 需要**跨机器字节级可复现**（多人协作/CI 校验） | 路线丙 Blender（固定采样）或接受"同机可复现" | 实测三种 GPU 后端 sha 互不相同 |
| 发现 Chromium 逐帧在目标分辨率下 **> 1 秒/帧**（如 4K + 重后处理） | 重新评估：降分辨率渲染 + 上采样，或 Blender 离线 | 实测 720p/hw 是 11.5 ms，4K 约 9 倍像素，仍在 100 ms 级，但有后处理放大风险 |
| 分发形态变成"要打包给别人的插件" | **路线乙反而更安全**（场景是纯 HTML/JS，无 GPL、无订阅） | 三个 html 自包含、零外部依赖 |

---

## 5. 未确认清单（不要当成结论用）

| # | 未确认项 | 为什么未确认 |
|---|---|---|
| 1 | `canvas-program-animation` 与 `flattened-video` 为何在 schema 里却无人支持 | 只看到现象（`plan.js:93-105` vs 三适配器白名单），没找到设计记录 |
| 2 | `remap.js` 的能力为何没有适配器实现 | `remap.js` 完整、`index.js:62` 已导出，但三适配器无引用；是"未接线"还是"故意不做"读不出来 |
| 3 | `深海.html` 能否通过补 `setTime` 变成确定性 | 它有 `time` 字段与 `getDebug`，但无写入接口；未尝试注入 |
| 4 | 1080p / 4K 下的逐帧成本 | 只测了 1280×720 |
| 5 | 跨机器（不同 GPU 型号）的像素差异幅度 | 只测了同一台机器的三种后端 |
| 6 | Remotion 商业许可对"个人创作者"的确切边界 | `00-auth:38` 只锁定 registry 字段 `"SEE LICENSE IN LICENSE.md"`，未读 LICENSE 正文 |
| 7 | Rive / DaVinci 的确切许可与无头能力 | 未联网核实，只按已知情况列为"未确认" |
| 8 | `花园.html` 的 `getState().drawCalls === 1` 是否意味着后处理被合并为单 pass | 数值异常小，可能是统计口径（`info.autoReset`）而非真实 pass 数 |
| 9 | 三个 html 的源出处与可修改性（是否用户自己写的） | 未问；影响"能否改造成 `__SCENE__` 协议"的成本 |
