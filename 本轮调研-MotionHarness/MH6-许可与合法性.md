# MH6 · 许可与合法性：能不能用 MotionHarness

> 调研时间：2026-11-11 21:20–22:00（Asia/Shanghai）。
> 本文只陈述**事实**与**风险判断**，不构成法律意见。事实给来源与抓取时间；抓不到的写「未找到」；判断与事实在 §6 分开列。
> 方法：`npm view` / 直接下载 tarball 解包读原文 / headless Chrome（CDP）抓官网 / 公开法规原文。

---

## §0 三句话结论

1. **它不是「MIT 之外的另一个许可证」，它是「没有任何许可证」。** 从 `0.0.26` 起（含当前 `0.1.4`），CLI、SDK、四个平台二进制包的 `license` 字段都是 `UNLICENSED`，而包内 `LICENSE` 正文写的是 `Copyright 2026 MH contributors. All rights reserved.` 加 `no open-source license is granted ... Use is subject to a separate authorization from the applicable rights holders.`。所以真正的问题不是「MIT 兼容不兼容」，而是**「我们有没有被授权使用」**——公开渠道上，这份授权至今一个字的文本都没有。
2. **合法面只有两条，且都不在「打包」里。** ①把 MH 当成用户自己安装、自己负责取得授权的外部程序，我们只调用（路径 A）；②不看它的代码，只按公开文档与可观察行为独立重写（路径 B，最安全）。**用它的 SDK（路径 C）与 CLI 同许可**，一旦进入我们依赖树，就当场击穿「严格 MIT」。
3. **「用它出的片能不能发 B 站」目前没有合同答案。** `/terms`、`/privacy`、`/legal`、`/eula` 全部 404；页脚只有 `浙ICP备2026009289号-2` 与 `© 2026 MOTION HARNESS`。没有价格页、没有水印声明、没有商用授权、没有输出物归属条款。剩下的只有法律默认规则（著作权默认归创作者）和一个空白的免责/责任空间——这对「发片」够用，对「商业交付」不够用。

---

## §1 `UNLICENSED` 在 npm 语境下的确切含义

### 1.1 官方定义原文

npm 官方文档 `package.json` 的 `license` 一节，最后一段（抓取 2026-11-11，<https://docs.npmjs.com/cli/v11/configuring-npm/package-json#license>）：

> Finally, if you do not wish to grant others the right to use a private or unpublished package under any terms:
>
> ```json
> {
>   "license": "UNLICENSED"
> }
> ```
>
> Consider also setting `"private": true` to prevent accidental publication.

这一段有三个可用的信息：

| 要点 | 出处 | 含义 |
|---|---|---|
| `UNLICENSED` 的含义是「不愿按任何条款授予他人使用权利」 | npm docs 原文 | 它是**拒绝授权的声明**，不是「某种你可以自由使用的许可证」 |
| npm 把它预设给「private or unpublished package」 | npm docs 原文 | MH 的包是**公开发布**的，场景与字段错配——说明作者是用它表达「专有」，不是漏写 |
| `UNLICENSED` 不是 SPDX 标识符 | SPDX 许可证列表 <https://spdx.org/licenses/> 中无此项 | 合规扫描工具会报 invalid；与之最像的 `Unlicense` 是「放弃全部权利、进入公共领域」，**语义完全相反** |

### 1.2 四个概念的关系（这是最容易搞混的地方）

| 状态 | 法律含义 | npm 上的表现 | MH 属不属于 |
|---|---|---|---|
| **没有 LICENSE 文件** | 著作权默认保留全部权利，等于未授权；但属于「未声明」，留有「是否构成默示许可」的争议空间 | `license` 字段缺失，`npm` 只给 warning | 否 |
| **`"license": "UNLICENSED"`** | 元数据层面的「未授权」告知。**它本身不产生也不消灭任何权利**，只是把「没授权」写明白 | 字段存在 | 是 |
| **专有软件（proprietary）** | 法律状态描述：权利人保留全部权利，使用需另行取得许可 | 通常伴随一份专有 LICENSE 正文 | 是 |
| **All rights reserved** | 同上，伯尔尼公约体系下的惯用表述。中国法下**不需要写这句话**，没写也照样保留 | 文本表述 | 是（正文首行） |

**关键结论（事实层）**：MH 的 `UNLICENSED` 不是模糊地带，而是被包内 `LICENSE` 正文**补强的明示拒绝授权**。三者齐全——字段写 `UNLICENSED`、正文写 `All rights reserved`、正文还额外写「使用需另行取得权利人授权」。这不是「作者懒得选许可证」，这是一份**主动写出来的专有声明**。

由此推出一个反直觉但重要的事实：**「下载了、装上了、能跑」不等于「被授权使用」**。在著作权法下，复制（下载安装即复制）与使用本就属于权利人专有权利范围；没有许可，就只有法定例外可依（见 §3 路径 B 的《计算机软件保护条例》第十七条）。

---

## §2 实际条款：抓到的原文与抓取记录

### 2.1 官网抓取结果（headless Chrome，2026-11-11 21:22–21:35）

| URL | HTTP | 内容要点 |
|---|---|---|
| `https://motionharness.top/` | 200 | 首屏动画站，仅 3 个外链：`/guide/`、`/account/`、logo |
| `https://motionharness.top/home/` | 200 | 落地页：功能分镜、`STANDARD`/`PRO` 对照区、安装提示、页脚 |
| `https://motionharness.top/guide/` | 200 | 使用文档：安装、与 Agent 协作、导出与分发、达芬奇桥接、工程与时间 |
| `https://motionharness.top/account/` | 200 | 登录页，仅 GitHub / Google 两个入口 |
| `/terms` `/privacy` `/legal` `/eula` `/terms-of-service` `/agreement` | **404 ×6** | 全部不存在 |
| `/robots.txt`、`/sitemap.xml`、`/index.html` | 404 | 未配置 |

站点是 SPA（`assets/site-page-*.js` 559 KB + `assets/main-*.js` 776 KB）。把两个 bundle 全文下载后做字符串检索，结果：

| 检索词 | 命中数 |
|---|---|
| `Terms`、`Privacy`、`EULA`、`license` | **0** |
| `价格`、`订阅`、`购买`、`免费` | **0** |
| `商用`、`版权`、`水印` | **0** |

（`授权` 命中 29 处，全部是「字体授权提示」「素材授权/重新关联」「CLI 设备授权（OAuth 设备码）」这类 UI 文案，与许可条款无关。）

**页脚唯一存在的法律文本，四页完全一致（原文）**：

```
帧驭 / MOTION HARNESS
浙ICP备2026009289号-2
© 2026 MOTION HARNESS
```

备案号指向 `https://beian.miit.gov.cn/`。**站点未公示经营主体全称**——只有一个中文品牌名「帧驭」、一个英文名 `MOTION HARNESS` 和一个备案号。

### 2.2 `STANDARD` / `PRO` 到底是什么（这是本次调研最容易误判的一处）

**未找到任何价格、额度、订阅周期、水印说明。** 从站点 bundle 里能还原出的定义是：

```js
// main-HiGcBKPY.js
var In = { standard: 'STANDARD', pro: 'PRO' }
// 七项功能分属两档：
// STANDARD: 开放工作台 / AI 标记 / 版本管理 / 导出与工程
// PRO:      界面编辑 / 代码与参数隔离 / 达芬奇桥接
```

在 Studio 内部，`PRO` 表现为**功能门**，原文文案包括：

> `在 PRO 中查看` / `在 PRO 中调整` / `此项已设置动画，需在 PRO 中调整。` / `在 PRO 中编辑{0}` / `此模板尚未配置标准界面`

同时 CLI 的 npm README 写着 `A new Pro project needs registry access to its matching @motionharness/sdk`。

**所以能确定的只有**：`STANDARD` / `PRO` 是**产品档位（功能门）**，不是许可档位；`PRO` 解锁界面编辑、模板编辑、达芬奇桥接。**不能确定的**：哪一档能商用、输出物归谁、有没有水印、要不要付费、付费给谁。这些**在公开渠道一个字都没有**。

### 2.3 包内 LICENSE 原文（`npm pack` 解包，2026-11-11）

`@motionharness/cli@0.1.4` 的 `package/LICENSE` 全文（关键三段，逐字）：

```
MotionHarness
Copyright 2026 MH contributors. All rights reserved.

Unless a file is expressly covered by a separate license, no open-source license
is granted for MotionHarness-authored material by this repository or distribution.
Use is subject to a separate authorization from the applicable rights holders.

The standalone FFmpeg rebuild materials identified in
products/cli/release/media/LICENSE carry the 0BSD license. ...
This scoped grant does not cover the MotionHarness host, SDK, Studio or other
application source.

Third-party software, fonts, assets and adapted components remain subject to
their respective licenses and notices, including THIRD_PARTY_NOTICES.md,
SHADCN_PROVENANCE.md, OPENFX_LICENSE and adjacent font license files where
provided. ...

Rights already granted for previously distributed versions, including under the
Apache License, Version 2.0, are unaffected.
```

`@motionharness/sdk@0.1.4` 的 `NOTICE`（同批解包）：

```
MotionHarness-authored material is subject to the accompanying LICENSE notice.
...
This SDK distribution contains public document, component and extension type
contracts. It does not contain the private CLI, editor or engine implementation.
```

两处要点：①**FFmpeg 是独立的 0BSD 授权材料**（不是 LGPL 传染进主机程序，且明确 `This scoped grant does not cover the MotionHarness host`）；②**最后一句是本次调研最有操作价值的一句**：历史上按 Apache-2.0 发出的版本，其授权不受本次收紧影响。

### 2.4 版本史实测：`0.0.25` 是最后一个 Apache-2.0 版本

| 版本 | 发布时间（UTC） | `license` 字段 | tarball 内 LICENSE |
|---|---|---|---|
| `cli@0.0.11` … `0.0.23` | 2026-09-28 … 10-23 | `Apache-2.0` | 完整 Apache 2.0 正文 |
| **`cli@0.0.25`** | **2026-10-31T18:51Z** | **`Apache-2.0`** | **完整 Apache 2.0 正文** |
| `cli@0.0.26` | 2026-11-08T21:39Z | `UNLICENSED` | 上方专有声明 |
| `cli@0.1.0` … `0.1.4` | 2026-11-10 … 11-11 | `UNLICENSED` | 同上 |

同批实测：`@motionharness/cli-win32-x64@0.0.25`、`cli-darwin-arm64@0.0.25`、`@motionharness/sdk@0.0.25` 的 `license` 也全部是 `Apache-2.0`；`0.1.4` 时全部为 `UNLICENSED`。

> 与同目录 `01-能融进什么-判断.md` 的口径差异：那边写「CLI 0.0.11–0.0.20 Apache-2.0」，**实测边界应更正为 `0.0.25`**（`0.0.24` 不存在，直接跳到 `0.0.25`）。

### 2.5 包的物理形态（决定「能不能随包分发」）

| 包 | 版本 | unpacked | 文件数 | 说明 |
|---|---|---|---|---|
| `@motionharness/cli` | 0.1.4 | 25,551 B | 6 | 只有 `bin/mh` 启动器与两个解析脚本，`engines.node >= 22.15.0` |
| `cli-win32-x64` | 0.1.4 | **163,122,122 B** | 4 | 内含 `MotionHarness.exe` + 内嵌 runtime 资源（首次运行解压到 `%LOCALAPPDATA%\mh\cache-v2\runtime\<sha256>\`） |
| `cli-darwin-arm64` | 0.1.4 | 148,134,455 B | — | 同上 |
| `cli-linux-x64` | 0.1.4 | 64,210,044 B | — | 同上 |
| `@motionharness/sdk` | 0.1.4 | 293,367 B | 79 | 纯 JS + `.d.ts` 契约层；peer 依赖 `react >=19 <20`、`three 0.180.0`、`@react-three/fiber 9.8.1` |

**事实**：真正的引擎在 148–163 MB 的平台二进制里，不是 npm 上的 JS。所谓「装个包」实际是装一个完整的桌面级程序。这也决定了：任何「把 MH 塞进我们插件」的方案，物理上就是分发一个 163 MB 的专有二进制。

### 2.6 CLI 的运行时行为（npm README 原文，与我们有关的三段）

> The public CLI collects anonymous usage events by default: command and run outcomes, Studio control clicks and keys outside text editors, versions, system details, and the coding agent when identifiable. An installation uses a random local ID. Source code, projects, assets, paths, command arguments, and typed text are not uploaded.

> `@motionharness/cli-win32-x64` contains `MotionHarness.exe` ... The npm command verifies the platform package and its version.

> The macOS and Windows packages include standalone LGPL FFmpeg and ffprobe, extracted automatically on first use. Corresponding sources, licenses and the rebuild recipe are included under licenses/media in the runtime resource directory reported by `mh doctor`.

即：**默认开启匿名遥测**（命令名、结果、版本、系统信息、可识别的编码 Agent；不含源码/素材/路径/参数/输入文本）。**未找到**关闭遥测的公开命令行开关——README 里 `MH_NO_UPDATE_NOTIFIER` 关的是「更新提示」，不是遥测；Studio 侧的「off switch」在 README 中出现于 AI 标记 hook 段落，未明确覆盖遥测。首启会解压 runtime 并写出 `licenses/media`（第三方许可文本）。抓到的页面里没有任何隐私政策解释这些数据的保存期限与跨境路径。

---

## §3 三条路径逐条判断

| 路径 | 合法性（按现有公开文本的字面） | 风险 | 前提条件 |
|---|---|---|---|
| **A. 当外部工具调用**<br>用户自己 `npm i -g @motionharness/cli`，我们调 `mh render` | **灰，但结构上最干净。** 我们不复制、不分发、不链接其代码；「使用」发生在用户机器上、由用户自己安装。与用户既有裁定「薄插件核心＋用户自装外部能力」完全对齐 | ①**许可真空而非许可冲突**：MH 无权可依，理论上「未经授权使用」的责任落在使用者（用户）身上，我们是「教唆/帮助」的边缘；②**版本漂移**：20 个版本、0.0.26→0.1.4 不到三天发 6 版、四平台分包、`latest` 可能不含用户平台（README 原文承认）；③**无输出契约**：`mh render` 的 stdout/退出码/文件名未声明为稳定 API，我们解析它等于解析一个随时会变的私有实现；④**默认遥测**；⑤环境依赖重（Node ≥22.15、pnpm 10、Chrome；桥接还要 Resolve Studio + FFmpeg 7） | 不打包、不 vendor、不改写其二进制、不把 `.vmg` 等私有格式硬编码进我们的核心；启动前探测 `mh doctor`；仅在用户显式启用时调用；文档写清「由用户自行安装并遵守其条款」 |
| **B. 学设计自己实现**<br>看文档、界面、行为，用我们自己的栈重写 | **最高。** 依据《计算机软件保护条例》**第十七条**：「为了学习和研究软件内含的设计思想和原理，通过安装、显示、传输或者存储软件等方式使用软件的，可以不经软件著作权人许可，不向其支付报酬。」<br>第六条：「本条例对软件著作权的保护不延及开发软件所用的**思想、处理过程、操作方法或者数学概念**等。」 | ①**界面复刻**：功能与流程不受保护，但逐像素复刻 Studio 的布局/配色/图标/文案，可能被主张美术作品实质性相似；②**私有格式逆向**（读 `.vmg`、`document.json` 结构）属互操作灰区；③**字符串与文案**受保护，不能照抄中文界面用语；④「小题大做」风险：重写成本 vs 收益 | clean-room：只看**公开文档 + 可观察行为**，不看反编译产物；保留设计决策记录（证明独立完成）；UI 不逐像素复刻、命名与文案原创；格式不自研兼容层 |
| **C. 用它的 SDK**<br>`@motionharness/sdk` | **与 CLI 完全同许可**（`UNLICENSED` + 「no open-source license is granted」）。SDK 的 `NOTICE` 只说明它「只含公开契约、不含私有实现」，**这不构成授权**。 | ①**直接击穿严格 MIT**：SDK 是 JS + `.d.ts`，`import` 进我们的包 = 专有代码进入 MIT 分发物，MIT 声明覆盖不到，必须在 LICENSE 里加例外——那就不再是「严格 MIT」；②peer 依赖把 `react@19` / `three@0.180.0` / `@react-three/fiber@9.8.1` 钉死，绑架我们的技术栈；③**唯一例外**：若走「optional/peer + 运行时探测 + 用户自装、我们不打包」，则与路径 A 同构，仍需律师定性 | 取得**书面授权**；或改为路径 A 的「用户自装、我们只探测」形态；不要写进 `dependencies` |

### 关于「学界面行为和数据模型算不算侵权」

这是路径 B 的核心问题，事实边界如下：

- **不受保护**：功能需求（「要有时间线」「要有 AI 标记」）、交互流程、数据结构的思想、操作方法。依据《计算机软件保护条例》第六条。
- **受保护**：源代码文本、具体的界面美术呈现（图标、配色、排版的具体表达）、界面文案措辞、文档文字。
- **灰区**：`.vmg` 工程格式的字段名与目录布局（`src/` + `document.json` + 素材原件）——它既是「数据组织方法」（偏思想），也可能是「具体表达」。风险不高，但不是零。
- **降风险的做法**：把「我们要什么功能」写在自己的需求文档里，再从零设计；不要对着它的截图调 CSS；不要复用它的字符串。

---

## §4 对「严格 MIT」目标的影响

用户的目标是**插件本体与随包内容严格 MIT**，且已明确「外部工具本体不随插件打包，不因其许可当然需要重实现」。按这个约束逐条对账：

| 动作 | 是否污染严格 MIT | 理由 |
|---|---|---|
| 调用用户自装的 `mh` 进程 | **不污染** | 我们不复制、不分发、不链接其代码。外部进程调用是「使用服务/工具」，不是「包含代码」 |
| 按文档与行为独立重写 | **不污染** | 产出物 100% 自有代码 |
| `import '@motionharness/sdk'` | **污染** | 专有 JS 进入我们的依赖树与分发物，MIT 无法覆盖 |
| vendor 任何 `@motionharness/*` 文件 | **污染** | 同上，且是最赤裸的再分发 |
| 把 `.vmg` 模板 / 示例动画 / Logo / 官网插图放进 repo 或安装包 | **污染** | 这些是它自己的资产，另受著作权保护（站点 bundle 检索确认：**没有任何条款允许复用**） |
| 从 `0.0.25`（Apache-2.0）抄代码 | **污染（较轻但确实污染）** | Apache-2.0 允许改与再分发，但被抄部分须继续 Apache-2.0 并保留声明/NOTICE。放进 MIT 包 = 许可不一致，`LICENSE` 必须加例外 → 不再是「严格 MIT」 |

**三条红线（建议直接写进团队规约）**

1. `package.json` 的 `dependencies` / `devDependencies` 里**永不出现** `@motionharness/*`。需要探测就 `spawn`/`which`，不 `import`。
2. 仓库里**永不出现**它的二进制、`.vmg`、模板、Logo、示例动画、界面截图（截图只进调研文档，不进包）。
3. 内部文档与代码里，**不出现**它的私有格式解析器。适配层只认「命令 + 输出文件路径」，不认内部结构。

**一个必须承认的代价**：路径 A 的「干净」建立在「MH 侧无权可依」之上。这不是我们造成的风险，但风险确实由使用它的用户承担——所以在产品文案里必须写清「MotionHarness 是其权利人所有的专有软件，需用户自行安装并遵守其条款，本插件不随附、不分发、不提供其授权」。这句话既是免责，也是「薄插件」定位的自证。

---

## §5 中国的合规面

**事实：这是中国境内主体运营的站点。** `浙ICP备2026009289号-2` 是工信部**非经营性互联网信息服务备案**编号（浙江省），`-2` 表示同一主体下的第二个网站。四页页脚一致，无经营主体全称、无统一社会信用代码。

| 面 | 事实 | 风险判断 |
|---|---|---|
| **备案性质** | 只有 ICP **备案**号，未见**经营性 ICP 许可证**（增值电信业务经营许可证） | 若将来对 `PRO` 收费，属经营性服务需相应资质。目前无价格页，无法确认其资质状态——**未找到** |
| **合同对象** | 无 ToS、无 EULA、无隐私政策、无主体名称 | **这是最实质的缺陷**：无法形成可执行的服务合同，没有 SLA、没有责任限制、没有数据条款。要发票/要授权书时「找谁签」都不清楚 |
| **数据流向** | CLI 默认上报匿名事件到其服务端；`/account/` 用 GitHub / Google OAuth 登录，登录接口在 `api.motionharness.top` | 我们与用户在境内 → 不构成「数据出境」。但若插件分发给**境外用户**并触发 MH，则境外用户的命令元数据流向境内服务器，对 GDPR 等语境属「向中国传输」，需告知 |
| **内容合规** | 成片由代码渲染，但「Agent 写代码 → 渲染」是否属「AI 生成合成内容」是灰区 | 《人工智能生成合成内容标识办法》**2025-09-01 施行**，要求文本/图片/音频/视频类 AI 生成内容同时具备**显式 + 隐式**标识（视频需在起始画面加提示）。B 站等平台已上线申报通道。若被认定适用，**发片前必须标识** |
| **账号与实名** | `/account/` 原文：「首次登录会创建账户」「下载和使用 CLI 无需登录」「Web Agent 功能尚未开放」 | 登录即建号但**无条款勾选、无隐私告知**。我们若在插件里引导用户去注册，等于把用户送进一个无条款的环境 |
| **发票/付款** | 无价格页、无支付入口、无主体 | 现阶段**不可能取得发票**；也无法签授权协议（无主体名称） |

**额外一条**：`/account/` 明写「下载和使用 CLI 无需登录」——这是个**对我们有利的事实**：路径 A 不需要用户注册 MH 账号，也就不会把用户的身份信息交给对方。

---

## §6 事实 / 风险判断 / 必须问律师

### 6.1 这些是事实（可复现，附出处）

1. `@motionharness/cli@0.1.4`、`@motionharness/sdk@0.1.4`、四个 `cli-<platform>@0.1.4` 的 `license` 字段均为 `UNLICENSED`（`npm view`）。
2. 包内 `LICENSE` 正文含 `All rights reserved` 与 `no open-source license is granted ... Use is subject to a separate authorization from the applicable rights holders`，并声明历史上 Apache-2.0 版本的授权不受影响（tarball 解包）。
3. `0.0.25` 及更早（含平台包与 SDK）为 `Apache-2.0`，tarball 内是完整 Apache 2.0 正文；`0.0.26` 起转为上述专有声明（20 个版本逐一核对）。
4. 官网 `/terms` `/privacy` `/legal` `/eula` `/terms-of-service` `/agreement` `/robots.txt` `/sitemap.xml` 全部 404（2026-11-11 21:2x）。
5. 首页、`/home/`、`/guide/`、`/account/` 页脚唯一法律文本是 `浙ICP备2026009289号-2` + `© 2026 MOTION HARNESS`，无主体全称。
6. 站点两个 JS bundle 全文检索 `Terms`/`Privacy`/`EULA`/`license`/`价格`/`订阅`/`购买`/`免费`/`商用`/`版权`/`水印` 命中均为 0。
7. `STANDARD`/`PRO` 是功能档位（`In={standard:'STANDARD',pro:'PRO'}`），不是许可档位；无价格页。
8. CLI 默认上报匿名遥测，明确不上传源码/素材/路径/参数/输入文本（npm README）。
9. 引擎在 148–163 MB 平台二进制内，npm 主包仅 25 KB 启动器。
10. 《计算机软件保护条例》第十七条、《人工智能生成合成内容标识办法》（2025-09-01 施行）现行有效。

### 6.2 这些是我的风险判断（不是法律结论）

1. **「许可真空」比「许可冲突」更棘手**：MIT/Apache 的冲突可以靠合规流程解，而「没有授权文本」意味着任何使用都缺少可援引的依据，只能靠法定例外与「用户自行负责」的结构设计。
2. 路径 A 在结构上**不污染**严格 MIT；但「我们的插件自动调用一个未授权软件」在极端情况下可能被主张帮助性责任。**这是概率判断，不是事实。**
3. 路径 C **一定**破坏严格 MIT，无论怎么写 LICENSE 例外——加了例外就不是「严格 MIT」了。
4. 路径 B 的**技术风险低于法律风险**：真正的坑不在「抄了代码」，而在「界面做得太像」与「私有格式逆向」。
5. `0.0.25` 的 Apache-2.0 是一个**可用但别用**的后门：能合法读、合法改、合法分发，代价是 Apache 声明必须保留，与「严格 MIT」互斥。用它做**学习参考**（读后重写、不复制）是性价比最高的用法。
6. 版本漂移是路径 A 的**最高频实际风险**（不是法律风险）：不到三天 6 个版本、CLI 未承诺 API 稳定、`latest` 可能缺平台包。
7. 无 ToS + 有账号体系 + 默认遥测，这个组合对一个「要商用的创作工具」是**不正常的**，更像内测期未收尾。它随时可能补上条款，而补上的条款大概率比我方假设更严。

### 6.3 这些必须问律师（建议原样带走）

1. 用户自行安装 MH、我们仅在其机器上调用 `mh` 命令行（不复制、不分发、不链接其代码），是否构成对该软件的「使用」而需要 MH 权利人授权？我们的插件是否可能被认定为帮助侵权或共同侵权？
2. 《计算机软件保护条例》第十七条的「学习和研究」例外，是否覆盖「为设计自有产品而观察其界面与行为、阅读其公开文档」？边界在哪？
3. 我们独立实现相同功能集（图层/关键帧/时间线/AI 标记/版本历史/达芬奇桥接），界面布局与交互流程近似到什么程度构成「实质性相似」？中国法院对 GUI 的保护路径（美术作品 / 不正当竞争）如何适用？
4. 实现 `.vmg` 工程包的读写（互操作）是否受保护？是否落入「操作方法」例外？
5. `0.0.25` 的 Apache-2.0 是否允许我们阅读后据以重写而不复制代码？「参考实现后独立重写」在 Apache-2.0 的 derivative work 认定中如何处理？
6. 若以 optional peer 方式让用户自装 SDK、我们不打包不分发，是否仍需授权？「不分发但 import」与「分发」在法律上如何区分？
7. 在无 ToS、无 EULA、无隐私政策的情况下，用户经 GitHub/Google 登录即建号，双方成立什么法律关系？我们引导用户注册是否产生连带责任？
8. 《人工智能生成合成内容标识办法》是否适用于「由编程 Agent 编写源码、再由确定性渲染器输出的视频」？标识义务人是服务提供者、工具方，还是发布者？
9. 在 README / 文档里写「支持 MotionHarness」「works with MotionHarness」，是否构成商标性使用或不当背书？描述性合理使用的边界？
10. 若将来商业化分发插件（哪怕只对内部团队），是否需要与 MH 签署书面授权/分销协议？其未公示经营主体名称，是否影响协议可执行性与争议管辖？

---

### 附：一句话给产品决策

**能用，但只能当「用户自己的外部工具」用，且必须假设它明天就改条款、改 CLI、改格式。** 任何把 MH 拉进我们仓库、依赖树、安装包的方案，都会让「严格 MIT」这个目标当场失效；而完全独立重写（路径 B）在《计算机软件保护条例》第十七条下有明确的学习研究空间，只要我们守住「只看行为、不看代码、不逐像素复刻」这三条。
