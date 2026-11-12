# E｜运行时可见性：装进 DSH 之后，模型到底能看见什么、能调用什么

> 审计对象：`产品实现/`（包名 `dsh-plugin-control-your-video`，v0.2.0，本地未发布）  
> 审计方式：只读静态核对（源码 + 交接契约 + 验收证据）+ 一次本机 profile 现状核对  
> 结论口径：**已核**＝在所读文件中可见且无相反证据；**推断**＝由结构推出；**未确认**＝本卡不足以判定。

---

## 0. 结论速览

| 问题 | 判定 | 一句话依据 |
|---|---|---|
| 插件怎么装进 DSH | cordis patch 一行 + 同包双半（Host＋client） | `cordis.patch.yml:28-30`；`package.json:7-9,45-52` |
| 注册给模型的工具／命令／skill | **0 个** | 全 `产品实现/**` 检索 `ctx.tools`／`defineTool`／`tools.register`／`ctx.agents`／`ctx.llm` → **0 命中** |
| 插件给宿主的能力面 | 一个 HTTP 前缀路由（19 条接口） | `ui/host/index.js:17,50-57`；`ui/host/routes.js:18,84-107` |
| 这些路由给谁用 | 浏览器 UI（同源带凭证），不是模型 | `routes.js:4-6,110-117`；`ui/client/api.js:22-34` |
| 模型能否触达插件 | **不能**（无工具、无 URL 深链、路由需宿主会话认证） | 见 §1.2、§3.2 |
| 模型手上的创作知识 | 镜头语言／参考案例／视觉规范／资产检索 **全部"无运行时投递"** | §2 |
| 创作实际发生在哪 | **插件外**：DSH 对话里的模型写脚本、跑 `node`、import 插件库模块 | `回执\C16R-回执.md:414-430`；`acceptance/mixed-project/scripts/build-plan.mjs:21-35` |
| 当前本机装没装 | **没装进当前 desktop profile** | `E:\DSH\.dsh\profiles\desktop\package.json` 的 13 个依赖、16 个 bundle 均无此包 |

---

## 一、插件向宿主暴露了什么

### 1.1 装载机制：cordis patch 一行，双半同包

| 环节 | 事实 | 证据 |
|---|---|---|
| 组合入口 | `dsh.bundle.patch` 指向 `./cordis.patch.yml` | `产品实现/package.json:45-48` |
| 实际注册行 | `insert: [{ id: ai-video-workbench, name: dsh-plugin-control-your-video }]` | `产品实现/cordis.patch.yml:28-30` |
| 为什么必须写包名 | client 半只挂在"说明符＝包名"的那一行；子路径说明符拿不到 client 半 | `cordis.patch.yml:24-27`；C01 `A-6`（`C01-DSH能力矩阵.md:229-231`） |
| Host 入口 | `main` = `./ui/plugin/host.js`，11 行转发到 `ui/host/index.js` | `package.json:7-9`；`ui/plugin/host.js:11` |
| client 声明 | `dsh.client = { platform: 'web', inject: [] }` | `package.json:49-52` |
| client 入口 | `./client` → `ui/plugin/client.js`（228,625 B，构建产物） | `package.json:12`；`ui/dev/build-client.mjs:26` |

补充事实：`cordis.patch.yml` 文件头仍写着"intentionally an EMPTY LIST"，同时又启用了行（`:4` 与 `:28-30` 自相矛盾）；`产品实现/README.md:68-69` 与 `docs/ENGINEERING-BOUNDARY.md:102-103` 仍声明"没有 Host 半入口、patch 为空列表"。三处文档停留在 C04 时代，**以代码为准**。

### 1.2 关键判定：**这个插件没有给模型注册任何东西**

四道互相独立的证据，指向同一结论。

| # | 证据类型 | 事实 | 位置 |
|---|---|---|---|
| 1 | 检索（正查） | `ctx.tools`、`defineTool`、`tools.register`、`ctx.agents`、`ctx.llm`、`ctx.commands`、`ctx.skills` 在 `产品实现/**` 全树 **0 命中** | 本次 grep（`产品实现`，全部文件） |
| 2 | Host 半自述 | 注释直言"Host 半真正 inject 的服务"，列表只有两项：`webServer`、`connection` | `ui/host/index.js:16-17` |
| 3 | `apply` 唯一副作用 | 整个 Host 半只有一个注册动作：`ctx.webServer.register({kind:'prefix', ...})` | `ui/host/index.js:50-57` |
| 4 | client 半注入面 | client 半 `inject: ['slots']`，只做 `sidebar.panellist` + `main` 的 slot 注册 | `ui/client/app.js:151,184-195` |

宿主侧确实**有**给模型注册工具的公开能力，是插件没用，不是宿主不支持：

> `ctx.tools.register(defineTool({...}))`；`name`/`description`/`parameters`/`output.schema`/`render` 全部由插件提供，**自动进入系统提示词组装**；可选 `{ when }` 每步重算、返回 false 即从模型可见集合与执行集合中排除。  
> —— `实施交接/证据/C01-DSH能力矩阵.md:842-847`（引 `dsh-tools:30,45-64,69`）

因此本卡给**确定判定**：

> **DSH 里的模型对这个插件是"零可见"的。** 没有工具名、没有工具描述、没有参数 schema、没有提示词段、没有命令、没有 skill。模型既不知道它存在，也无法调用它。

### 1.3 `ui/host/routes.js` 的 19 条路由，以及谁能访问

前缀：`/api/ai-video-workbench`（`routes.js:18`）。全部接口：

| 方法 | 路径 | 语义 | 面向 |
|---|---|---|---|
| GET | `/health` | 服务名 + 三个接口版本 | 探活 |
| GET | `/bootstrap` | 首页所需一切（项目、等待项、偏好、工具、限额） | UI |
| GET/POST | `/projects` | 列表／新建 | UI |
| POST | `/projects/open` | 打开并返回项目全量描述 | UI |
| POST | `/projects/position` | 保存工作位置（工作面／播放头／面板） | UI |
| POST | `/projects/materials` | 上传材料（base64，≤64 MiB） | UI |
| POST | `/projects/material-use` | 记录材料用途 | UI |
| POST/GET | `/projects/ui-state` | 插件私有 UI 状态读写 | UI |
| GET/POST | `/projects/assistant` | 助手消息读／写 | UI |
| GET | `/projects/events` | 项目事件流（最近 N 条） | UI |
| GET/POST | `/preferences` | 偏好读取／设置 | UI |
| GET | `/tools`、`/tools/inspect` | 外部工具（ffmpeg／Remotion 等）状态与详情 | UI |
| GET | `/effects` | 效果库（当前恒为空数组） | UI |
| GET | `/import-check` | 项目包导入检查（当前恒 `supported:false`） | UI |

访问控制：宿主 web server 对插件**不做任何认证**，每个请求都过插件自己的 `authorize`，失败则 403 且不碰项目数据（`routes.js:4-6,110-117`；`ui/host/index.js:34-45`）。浏览器侧同源 `fetch` 带 `credentials:'same-origin'`（`ui/client/api.js:22-34`）。

**要害**：这是一张"页面数据接口表"，不是"能力表"。没有任何一条接口接受"意图／指令"并执行创作；它们只读写项目记录。**给模型用还是给浏览器用**的答案是后者，而且没有第二种消费者。

### 1.4 `ui/plugin/client.js` 到底是什么

| 事实 | 证据 |
|---|---|
| 它是**构建产物**，不是源文件；首行写明"由 ui/dev/build-client.mjs 生成；不要手改" | `ui/plugin/client.js:1-8` |
| 生成方式是**固定顺序拼接 + 剥掉 `export` 关键字**，没有打包器、没有 JSX、没有 React 运行时 | `ui/dev/build-client.mjs:1-17,30-60,62-68` |
| 内容是 `React.createElement`（别名 `h`）的组件树 + 一份 CSS 字符串 | `ui/client/app.js:71-85`；`ui/client/styles.js`（28,285 B） |
| 行数／字节 | 4,921 行 / 228,625 B |

体量构成（源目录 `产品实现/ui/client/` 合计 229,548 B）：

| 分类 | 字节 | 占比 | 性质 |
|---|---|---|---|
| `views/` + `domains/` | 138,438 | **60.3%** | 展示逻辑：面板、树、卡片、表格、"只读投影" |
| `app/api/store/actions/ui/hooks` | 37,599 | 16.4% | 外壳与状态机（含真实的保存/恢复动作） |
| `styles.js` | 28,285 | **12.3%** | 纯 CSS |
| `model/` | 25,226 | 11.0% | 纯函数：时间码、键盘映射、搜索、布局断点 |

结论：**88% 以上是展示与外壳**。剩下的"业务逻辑"是"把 HTTP 结果放进 store，再 POST 回去"，没有任何一处做创作决策或调用模型。四个 domain 视图（creation／review／delivery／realwork）的注册是**惰性的**：只写进一个模块内 registry，不占任何 slot（`ui/client/domains/creation/index.js:22,91-99`），realwork 甚至只读一个**构建期常量快照**（`ui/client/domains/realwork/index.js:28-36`）。

---

## 二、模型现在能看见什么

### 2.1 注入链检查：一条都没有

| 检查项 | 是否存在 | 证据 |
|---|---|---|
| 工作区 `AGENTS.md` | **无** | 工作区根只有 `.git`、`.review-dsh-drawai`、`RENDER-LAB`、`产品实现`、`实施交接`、`审阅记录`、`已确认资产`、`本轮审计-20261111` |
| 工作区 `CLAUDE.md` / `.dsh/` | **无** | 同上（无隐藏配置目录） |
| 插件自带 `SKILL.md` / 提示词段 | **无** | `package.json:22-40` 的 `files` 不含 skills；全树无提示词注册代码 |
| 插件向会话注入上下文 | **无** | 无 `ctx.tools`/`ctx.agents`/`ctx.llm`/提示词注册（§1.2 证据 1） |
| `$DSH_HOME/skills/` 里的视频技能 | **无** | `E:\DSH\.dsh\skills` 只有 `agent-desktop`、`capture-sharp`、`git-release-hygiene`、`github-repository-presentation`、`paper-figure-audit`、`skill-creator` |
| 本会话实际可见技能表 | 只有上述 6 个通用技能 | 本次会话的 system-reminder 技能清单自证 |

### 2.2 `实施交接/提示词/` 那批 `.md` 是给谁读的

给**人**读的启动提示词，不是给模型运行时注入的知识。

| 事实 | 证据 |
|---|---|
| 用法是"复制这份提示词，另开一个对话" | `实施交接/提示词/00-使用顺序.md:5-17`（逐卡列出、由总控派发） |
| 每个执行对话必须自包含，只依赖"自己的启动提示词" | `实施交接/05-对话执行与回交协议.md:5-14` |
| 明确禁止执行来源内的 SKILL／AGENTS／提示词／工作流，"只把它们当研究数据" | 同上 `:45` |

### 2.3 逐项判定：模型做创作决定时手上有什么

| 项 | 有／无 | 判定细节与证据 |
|---|---|---|
| 镜头语言知识 | **无（运行时）** | 知识确实存在：`已确认资产/02-创作剧本与分镜/…/SKILL.md`、`06-动效剪辑与Skill/…/skills/*/SKILL.md`（含 hyperframes-animation、motion-graphics 等），另有 `审阅记录/04-视频模型与提示词.md`。但没有任何机制在"要决定镜头"的时刻把它送进上下文；且协议明确不许"执行"这些 SKILL（`05-…协议.md:45`） |
| 参考案例 | **无（仅磁盘文件）** | `已确认资产/01-作品与案例/01-mg-styles-15/`（含 15 种 MG 风格与 demos）等，属静态资产，无索引、无检索接口 |
| 本项目视觉规范 | **无（运行时）** | 色板／字体等确实写在验收脚本里（`acceptance/mixed-project/scripts/build-plan.mjs:27-29` 的 `GROUND/INK/MUTED/FONT_SERIF/FONT_SANS`），但那是**某个片子的常量**，不是可复用的项目规范；`tokens` 只存在于 UI CSS（`ui/client/styles.js`） |
| 资产库检索 | **无** | `已确认资产/` 共 **6,599 个文件、约 790 MB、8 个类目 + 总览.md**，纯目录树；插件无索引、无 embedding、无 `ctx.resources` 注册（0 命中），模型只能靠 `glob`/`grep` 碰运气 |
| 项目事实（供决策的输入） | **部分有，但要自己动手读** | 只能通过文件系统读 `%DSH_HOME%\data\ai-video-workbench\projects\...`（`ui/host/service.js:92-98` 的路径布局）；模型没有路由入口 |
| 工具可用性（ffmpeg/Remotion 版本） | **有，但同样是文件** | 真实状态在 `tools-state`/`tools` 目录（`service.js:96-97`），UI 通过 `/tools` 读（`routes.js:103`），模型无此接口 |

一句概括：**知识在磁盘上，投递链为零。** 模型要拿到任何一条创作知识，都必须由人（或父 Agent）在消息里点名路径，或模型自己猜着去 `glob`。这与"把创造性决策留给模型"所需的"正确时刻拿到正确知识"正好相反。

---

## 三、宿主能力的真实边界

### 3.1 CT-01 划的边界：哪些核过、哪些没核

| CT-01 条目 | 内容 | 现状 |
|---|---|---|
| §3 公开能力表（`:52-61`） | 面板、右栏、bottom、通知、页面位置、Host 服务、文件对话框 | 只覆盖 **UI 与文件**；没有一行讲"模型如何调用插件" |
| §4 生命周期（`:73-85`） | 只用 `ctx.effect` disposer；禁 `ctx.on('dispose')`；退出 5s/10s 有界 | 已核（C01 §C 系列） |
| §5 权限（`:89-94`） | `danger-full-access` ≠ 用户授权；插件 Host 代码不受沙箱；审批是 `ctx.approval` | 已核 |
| §6 公开接口清单（`:96-104`） | **列了 `ctx.tools`、`ctx.agents`、`ctx.llm`、`ctx.webServer`** | 只"列为可用"，**没有一条验证门** |
| §7 实际验证门（`:114-121`） | 6 条，全是"能注册/能加载/能承载 UI/能恢复/不用内部 API" | **没有任何一条测工具注册、Agent 委派、提示词注入** |
| 禁用清单（`:106-112`） | `ctx.homePaths`、`ctx.userApproval`、`ctx.on('dispose')`、Electron 私有 API | 已核 |

C01 自己也把"未核"写明了：插件作者 API 清单（`C01:887`）包含 `ctx.tools`/`ctx.agents`/`ctx.llm`，但同一份文件的"最小后续验证"表（`C01:918-935`）里，**关于工具注册与提示词装配的验证项一条都没有**；未决项 `U1`/`U15`（共享模块表）、`U8`（真实工具面）也仍是未知。

**这就是本次问题的结构性根源**：交接契约把"插件能注册工具"当成背景知识，却把验证预算全给了 UI 与文件。于是实现只做了 CT-01 §7 要求的六件事。

### 3.2 插件能不能注册工具给模型？能。模型现在怎么触达？不能。

| 项 | 判定 | 依据 |
|---|---|---|
| DSH 支持插件注册工具 | **支持（已核，文档级）** | `ctx.tools.register(defineTool({...}))`，schema 与描述自动进系统提示词（`C01:842-847`） |
| 支持条件启用（按步骤） | 支持：`register(def, { when })` 每步重算 | `C01:846` |
| 支持把图片作为工具结果 | 支持：`render` 可返回 `{type:'image', attachment}` | `C01:842` |
| 本插件注册了吗 | **没有** | §1.2 四条证据 |
| 模型能否通过 HTTP 触达 | **不能** | ①路由需宿主会话认证（`ui/host/index.js:34-45`）；②无 URL 深链（CT-01 §3；C01 `A-2`）；③模型没有"同源带凭证 fetch"的能力，`web_fetch` 是宿主外的独立请求 |
| 模型能否通过 MCP 触达 | 技术上可以另配 MCP server，但**本插件没有 MCP 端点**：`package.json:8-21` 无 `./mcp` 导出；插件内的 `mcp` 只是"外部工具通道"的一种**声明**，模块自述"不启动进程、不开 socket、不调用 MCP 服务器" | `package.json:8-21`；`tools/channels.js:15-20` |
| 结论 | **模型→插件：链路不存在。插件→模型：没有说一句话。** |  |

### 3.3 "模型做创作"实际发生在插件外

| 环节 | 谁做 | 证据 |
|---|---|---|
| 写 `CompositionPlan` | **执行验收对话的模型**，写成 Node 脚本 | `产品实现/acceptance/mixed-project/scripts/build-plan.mjs:1-35`（头注释自述这是 C16 混合片的计划构建器；`import ... from '../../../media/index.js'`） |
| 跑它 | 同一个模型，在 DSH 会话里用 shell 跑 `node <脚本>` | `实施交接/回执/C16R-回执.md:414-430`（逐条列出 `node 产品实现/acceptance/c16r/scripts/*.mjs`） |
| 插件在其中的角色 | **被 import 的库**（`media`、`orchestration`、`editing`、`delivery`），不是被调用的服务 | `build-plan.mjs:25`；`orchestration/index.js:193-219` |
| Host 半用到了哪些库 | 只用了 `core/project` + `tools` | `ui/host/service.js:22-49`（import 清单） |
| 用不到的库 | `media`、`editing`、`delivery`、`orchestration` 在 `ui/` 下**零 import** | 本次 grep（`ui/**` 对这四个包的 import → 1 命中，且是 service.js 的 tools） |

也就是说：**创作能力全在插件里（以库形式），但插件的运行时接口（路由）没有把它们接出来。** 模型想用这些能力，只能像 C16 那样"把工作区当项目目录，把插件源码当 SDK"，绕过宿主。

同一份 C13 模块还明确封死了"多 Agent 制作"（`orchestration/index.js:8-10`、`CT-08:7-12`），并规定工作包由插件持久化（`CT-08:27-44`）——现在**工作包没有运行时接口**，只在脚本里手工构造。

### 3.4 UI 与 DSH 对话是什么关系

| 事实 | 证据 |
|---|---|
| UI = 宿主 sidebar 的 4 个入口 + main 里的 4 个整页 | `ui/client/app.js:13-18,183-196` |
| 没有任何 URL 路由，刷新回默认（用户已接受） | C01 `A-2`；CT-01 §3 |
| UI 里的"助手"面板**不是对话**：点"保存到项目"只把消息写盘，标记 `queued-for-orchestration`，并自注"C13 接入后从这里继续，不会假装已经回答" | `ui/host/service.js:630-653`（`:648` 状态、`:649` 自注）；`ui/client/views/project.js:129-178` |
| 真正的模型对话是 DSH 自己的聊天面板，插件够不到它的消息流 | 全树无 `conversation.*` slot 注册（`app.js` 只注册 `sidebar.panellist`/`main`） |
| 用户的现实路径 | 要么在 UI 里点（插件记事实，没人创作），要么在对话里说（模型动手写脚本，插件不知情）。两条路**互不相通** |

---

## 四、判定

**这个插件现在对模型是不透明的。**

它把 90% 的"专业能力"（项目核心、工具内核、渲染、编排、审阅、交付）实现成了**只读库**，把运行时接口收缩成一张给浏览器看的 HTTP 数据表，并且**一条工具都没注册**。于是模型看它，看到的是一个不存在的插件：不知道名字、不知道能干什么、不知道有什么参数、不知道何时该用。反过来，插件看模型，也只看到"人类在 UI 里点出来的记录"——它甚至无法区分一条 brief 是用户写的还是"AI 推断"的（两者都是人在 `uiState.brief` 里打的字，`ui/client/actions.js:327-336`）。

这不只是"少了一组工具"，而是**责任错位**：模型现在能创作（C16 确实出了片），但它是靠"读工作区 + 写脚本 + 跑 node"完成的，等于把 DSH 当编辑器、把插件源码当 SDK。这条路可行，代价是：进程与状态不受插件治理（锁、单写入者、恢复、证据链全部旁路）、用户看不到模型在决定什么、每次创作都要重新发明脚手架。而"把创造性决策留给模型"要求的前提恰恰相反——模型要在正确的时刻拿到项目事实、镜头知识、资产检索、方法包，并通过**受治理的窄接口**把决定写回项目。

用一句话说：**插件是为"人操作 UI"建的，模型被留在了门外；现在门外的人能干活，是因为门没锁（工作区可写），不是因为有门。**

---

## 五、要让模型成为创作主体，运行时必须补的五件事

| # | 必须补什么（一句话） | 依据 |
|---|---|---|
| 1 | **注册一组 `ctx.tools`**：`project.open`／`brief.write`／`plan.compose`／`render.preview`／`evidence.read` 等，把 19 条路由里的读写语义改造成带 JSON Schema 的工具，描述里写清"什么时刻该用"。 | `C01:842-847` 证明可行且描述自动进系统提示词；现状 0 命中（§1.2） |
| 2 | **把"正确时刻"变成工具边界**：用 `{ when }` 让工具按阶段出现（方向未定→只给方向工具；有基线→才给渲染工具），并让每次返回都带当前阶段与下一步可选动作。 | `C01:846`（按步骤计算）；`CT-13:55-65` 的阶段门 G0–G4 现在只写在纸上 |
| 3 | **知识要有投递物，不能只有磁盘**：把镜头语言、视觉规范、方法包做成 `ctx.resources`（可 pin、可按 id 取）或工具结果，而不是让模型 `glob` 790 MB。 | `已确认资产/` 6,599 文件无索引；`C01:887` 列 `ctx.resources` 为公开面；`05-…协议.md:45` 现在只允许"当研究数据" |
| 4 | **工作包与制作身份要有运行时接口**：`workPackage` 的读写、`producerSessionId` 的绑定、单项目锁的获取/释放都得是工具，否则模型永远在锁外创作。 | `CT-08:27-44`（工作包字段）、`CT-08:96-103`（实测要求）；现状 `ui/host` 零 import orchestration |
| 5 | **把 UI 助手与真实对话接成一条**：`postAssistant` 必须真的触发模型并把回复写回同一线程（现在恒为 `queued-for-orchestration`），同时把 UI 的动作记成模型可见的事件。 | `ui/host/service.js:648-649`；`ui/client/views/project.js:143` 的"消息和引用会真实保存，制作编排由 C13 接入后继续" |

---

## 六、未确认与限制

| 项 | 状态 |
|---|---|
| 本机 GUI（`http://127.0.0.1:29941`）是否加载了本插件 | **未确认**。`/api/ai-video-workbench/health` 返回 **401**（宿主连接层先拒绝），无法区分"路由不存在"与"路由存在但未授权"；profile 依赖与 bundle 列表都不含此包，倾向"未安装" |
| `ctx.tools` 在本机的**运行**行为（描述是否真的进提示词、`when` 时序） | **未确认**（C01 为静态文档级证据，本次未做运行探针） |
| 验收隔离 profile 里插件是否真跑起来 | 已核有安装副本（`acceptance/c16r/profiles/p0-install/node_modules/dsh-plugin-control-your-video/`），其 `cordis.patch.yml` 与源一致（30 行、同一 insert），但组件行为由 `C16R-证据/01-P0-安装与导出.json` 记录，本卡未复跑 |
| `ui/host/service.js:300-324` 有两份同名 `preferenceSnapshot` 定义（后定义覆盖前定义） | 已核为事实，属实现遗留；不影响本报告结论 |
| 文档漂移（`README.md:68-72`、`docs/ENGINEERING-BOUNDARY.md:102-108` 仍称"无 Host 半、patch 为空"） | 已核；说明"插件到底暴露了什么"在项目内部也没有单一事实来源 |
