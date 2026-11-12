# A｜能力实测：`产品实现` 这个插件真正做到了什么

> 对象：`产品实现/`（`dsh-plugin-control-your-video` 0.2.0，`产品实现/package.json:2-3`）。只读审计，未改源码、未跑写盘脚本。判据：是否被 `ui/host/` 装配、是否有测试、是否有实测产物，不看注释自称。行数用 node 遍历 `.js/.mjs/.jsx`，跳过 `node_modules` 与符号链接（`acceptance/` 下有自引用目录副本，PowerShell 递归会陷入）。`acceptance/` 575 个 JS 文件中仅 52 个在 `scripts/`（10,822 行）是手写脚本，其余为安装副本，不计入。产品代码 **66,700 行**，剔除 `dev/`、`fixtures/`、`templates/`、`evidence/` 与产物 `ui/plugin/client.js` 后 **51,935 行**；`tests/` 约 1.6 万行。

## 1. 装配事实：只有一条真入口

| 事实 | 证据 |
| --- | --- |
| 主入口是 UI 宿主 | `产品实现/package.json:7` → `ui/plugin/host.js:11` |
| `apply()` 只注册一个前缀路由 | `ui/host/index.js:50-55` |
| Host 只依赖三个门面 | `ui/host/service.js:22-49`：`base`、`core/project`、`tools`。**无** media / orchestration / editing / delivery |
| 19 条路由无一条涉渲染 | `ui/host/routes.js:84-107` |
| 客户端只注册四个面板 | `ui/client/app.js:13-18`、`:182-196` |
| 领域视图进普通对象而非插槽 | `ui/client/domains/creation/index.js:18`（"NOT a new slot"）、`:22` |

装上后用户拿到的是**项目档案 + 素材登记 + 工具状态 + 偏好**。代码自证：`ui/client/actions.js:148` `composition: { available: false, reason: 'C12 尚未接入合成对象与画面' }`。

**判定总表**

| 模块 | 行数 | 判定 |
| --- | ---: | --- |
| `base` | 2,860 | 真实可运行 · 已接线 |
| `core/project` | 10,414 | 真实可运行 · 已接线 |
| `tools` | 8,918 | 真实可运行 · 已接线（页面只读） |
| `ui` | 12,865 | 真实可运行 · 作品面与时间线空缺 |
| `media` | 11,298 | 真实可运行 · 未接线（仅脚本） |
| `orchestration` | 8,207 | 可运行 · 未接线 |
| `editing` | 6,251 | 可运行 · 未接线 |
| `delivery` | 5,887 | 可运行 · 未接线 |

## 2. 逐模块判定

### 2.1 `base/`（2,860 行）— 真实可运行

原子写 `base/atomic-write.js:140`、`:222`；锁 `base/locks.js:309`、`:425`；路径/脱敏/确定性/故障注入 见 `base/index.js:39-48`、`:26-38`、`:71-81`、`:83-96`。

- 接线：Host 直接 import（`ui/host/service.js:22`），`editing/history.js:11` 等广泛引用；`tests/unit/atomic-write.test.mjs`、`tests/integration/locks.test.mjs`。
- 保护：写入要么完整要么不存在；两写者不同时改同一数据；日志无密钥与绝对路径。
- 复杂度：纯防御。`locks.js:309-425` 在跟"进程可能已死"搏斗。

### 2.2 `core/project/`（10,414 行；剔除 dev 10,085）— 可运行且已接线

`project.js:138`/`:190` 生命周期；`versions.js:345`；`decisions.js:457`；`recovery.js:355`；`write-guard.js:102`；`production-lock.js:66`；`events.js:109`；`store.js:150`；接口 `index.js:244`、能力表 `:253`、`openSession` `:338`。

- 接线：Host import 20 余导出（`ui/host/service.js:23-48`），`bootstrap()` 真读注册表/位置/恢复/偏好（`:445-467`）；8 个单测约 3,300 行。
- 保护：事实单一来源；写前必须持修订号；AI 不能写"用户已确认"；断电后能判断该不该继续。
- 复杂度：`materials.js`(1,576) 是真业务；`versions.js`(1,312)、`recovery.js`(1,210)、`decisions.js`(1,405) 是状态机与拒绝对话——**占本模块 38%，对应 UI 0 个按钮**。

### 2.3 `editing/`（6,251 行；剔除 dev 5,584）— 可运行但未接线

门面 `editing/index.js:158`；`annotations.js:111`、`sessions.js:62`、`candidates.js:55`、`producer.js:71`、`history.js:26`、`guard.js:52`、`field-diff.js:129`、`projection.js:65`。

- 未接线：`ui/host/` 无一处 import；`createEditingKit` 只在测试里调（`tests/integration/editing-sessions.test.mjs:47`、`editing-ai.test.mjs:55`、`editing-render.test.mjs:69`）。UI 唯一接触面 `ui/client/domains/review/index.js:57` 读 `editing.projection`，而写入口 `editing/projection.js:65` 产品内无调用者（自述 `editing/index.js:143`）。
- 保护：修改不顺手改掉未点名对象；AI 不覆盖当前版本；定稿后历史只读。
- 复杂度：`sessions.js`(751) 核心是"每步过锁、过生产暂停、过范围检查"（`sessions.js:12-16`）；`guard.js`(251)、`scope.js`(624) 是纯守卫。

### 2.4 `orchestration/`（8,207 行；剔除 dev 6,027）— 可运行但未接线

门面与 11 个 store `orchestration/index.js:193`、`:205-215`；`production.js:156`、`craft.js:91`、`preview.js:49`、`projection.js:49`。

- 未接线：被 `editing/guard.js:23`、`editing/producer.js` 引用，有 4 单测 + 1 契约测试，但 Host 不 import。UI 消费的 `creation.projection` 发布点仅 `orchestration/dev/publish-projection.mjs:15`（一个 `dev/` 脚本）。
- 保护：创作意图三源不混（用户说的/材料主张的/AI 推断的）；预览过期可算。
- 复杂度：`vista.js`(740)、`methods.js`(558)、`craft.js`(342) 是真领域建模，但 2,180 行 `dev/` 脚本说明它们只能被脚本串起来。

### 2.5 `media/`（11,298 行；剔除 dev 9,311）— 真实可运行，只能脚本调

`plan.js:630`、`:168`；运行时 `media/index.js:201`；三适配器 `render/ffmpeg-adapter.js`(1,028)、`render/remotion-adapter.js:80`、`render/hyperframes-adapter.js`(684)；`probe.js:80`；`verify.js:82`、`:130`；能力声明 `media/index.js:160-199`。

- 证据：真出过片——`实施交接/证据/C16-证据/11-交付/` 16:9 33.85 MB、9:16 28.88 MB，`C12-证据/` 7 个 mp4，均由 `acceptance/mixed-project/scripts/render.mjs:73-90` 直接 `createMediaRuntime` 产出；Host 无渲染路由。
- 保护：计划不合规不渲；渲完能解码回比；"只改这个对象"能像素级证明。
- 复杂度：`verify.js`(443)、`checks.js`(420) 全篇解码 RGB24/s16le 差分；`ffmpeg-adapter.js` 复杂度来自 `drawtext`/`xfade` 拼接——**已知有缺陷**（§8）。

### 2.6 `delivery/`（5,887 行；剔除 dev 4,571）— 可运行但未接线

`delivery/index.js:150`、`:191`、`:315`；`delivery.js:117`、`:221`；`package.js:180`、`:395`；`effects.js:150`；`specs.js:66`；`closure.js:210`、`:676`。

- 未接线：4 集成测试 + 1 契约（`tests/contract/delivery-api-contract.test.mjs:47`）；Host 不 import。UI"交付"只开说明弹窗（`ui/client/views/project.js:318`、`:281`），`/effects` 返回硬编码空数组（`ui/host/service.js:600`）。
- 保护：导出成功 ≠ 已发布；清理范围须先被用户原话确认；删除只动点名路径。
- 复杂度：`closure.js`(751) 是纯流程闸门，业务内核 `specs.js`(349) 最短。

### 2.7 `tools/`（8,918 行；剔除 dev 7,772）— 可运行且已接线

`tools/index.js:97`、`:194`、`:234`；状态推导 `:135-150`；隔离断言 `:109`；`install.js:74`、`detect.js:459`、`catalog.js:583`。

- 接线：`ui/host/service.js:49` import、`:588-597` 暴露；UI 有真实工具页（`ui/client/views/tools.js:77`）。但只读——"插件不下载、不安装、不更新工具"（`tools.js:55`），安装校验只能由测试/脚本走 `install.js:74`。
- 保护："可用"只能从记录事实推出；工具目录与项目目录物理隔离。
- 复杂度：`install.js`(1,051)、`state.js`(735) 主体是"什么情况下不许说可用"。

### 2.8 `ui/`（12,865 行；剔除产物与 dev 5,725）— 可运行，作品面是空壳

`app.js:13-18`、`:182-196`；35 个动作 `actions.js:48-447`；17 个 HTTP 方法 `api.js:70-87`；`views/project.js:326`、`views/creation.js:204`、`views/work.js:86`、`views/preferences.js:69`。

- 空壳证据：`work.js:108-110` 播放/上一镜头/下一帧全 `disabled: true`；`:71`"尚无合成画面"；`:131`"还没有可编辑的时间线"；`actions.js:465`、`:469` 只弹提示。
- 保护：不假装——没有的能力画说明，不画假按钮。
- 复杂度：一半在"如何诚实表示缺失"；`ui/` 中 7,140 行是 `dev/` 脚本与 `client.js` 产物。

### 2.9 一个结构性观察：代码分成两簇，中间没有边

上半簇是 `base` → `core/project` → `tools`，Host 只认识它们；下半簇是 `media` ← `orchestration` / `editing` / `delivery`，彼此依赖很深（`orchestration/craft.js` 引 media，`editing/history.js:12` 同时引 core 与 media，`delivery/closure.js` 同时引 editing 与 media），但**没有任何一条边指向上半簇的 `ui/host/`**。所以这不是"功能还没写完"，而是一次有意的分层交付：先把"事实与保证"做实并验收，把"创作与出片"留在了 Node 侧。理解这一点，才能解释为什么 12,483 行防御性代码和一个能出 33 MB 成片的渲染器可以同时存在于同一个包里而互不相见。

## 3. Q1｜真正能点的 16 件事

| # | 位置 | 真发生了什么 |
| --- | --- | --- |
| 1-2 | 新建项目 `views/home.js:27`；开始创作 `home.js:117` | 写真实项目目录（`actions.js:102`），并上传已选文件（`home.js:73-77`） |
| 3-4 | 添加材料 `home.js:115`、`creation.js:147`；点选对象 `creation.js:83` | base64 落盘 + SHA-256（`actions.js:237`）；选中态+播放头落盘（`:169`） |
| 5 | 写用途→记录用途 `project.js:64` | 真实写入用途（`actions.js:263`） |
| 6 | 简报三段文本 `creation.js:124` | UI 状态落盘（`actions.js:328`，标"界面草稿"） |
| 7-8 | 助手保存 `project.js:178`；引用当前对象 `project.js:176` | 真存消息（`actions.js:211`），状态 `queued-for-orchestration`（`ui/host/service.js:648`） |
| 9-11 | 面切换/右栏三 tab `project.js:201`；"版本" `:317`；"交付" `:318` | 面板落盘；只读事件列表（弹窗自写"接受／回退按钮：未接入" `:240`）；说明弹窗 |
| 12-13 | 导入项目 `home.js:28`；偏好五组 `preferences.js:69` | 弹窗说未接入（`ui/host/service.js:604-609`）；写全局偏好（`actions.js:394`） |
| 14-16 | 工具详情 `tools.js:60`；效果页 `effects.js:31`；搜索/返回/Esc `actions.js:423` | 只读状态与指引；空态 + gap 卡片；本地状态 |

**不存在**：播放、拖时间线、改时长、加转场、改文字、调图层、渲染、导出、接受候选、回退。四个领域视图虽有挂载点（`creation.js:211`、`project.js:123`、`effects.js:55`），但读的 `creation/editing/delivery.projection` 在产品内无一处被写（发布点仅 `orchestration/dev/publish-projection.mjs:15`、`delivery/dev/self-check.mjs:54`），故实际是空态。

## 4. Q2｜端到端 6 环，断 4 环

| 环 | 入口 | 状态 |
| --- | --- | --- |
| ① 创建项目 | `core/project/project.js:138` ← `ui/host/service.js:474` ← `actions.js:102` | 通 |
| ② 导入素材 | `core/project/index.js:147-159` ← `service.js:532` ← `actions.js:237` | 通（≤64 MB，`service.js:52`） |
| ③ 编排 | `orchestration/index.js:193` | **断**：无路由；实际由 `acceptance/mixed-project/scripts/build-plan.mjs:25` 产 JSON |
| ④ 渲染 | `media/index.js:201` → `render.mjs:73-90` | **断**：仅脚本 |
| ⑤ 评审 | `editing/index.js:158` | **断**：无路由，投影无人发布 |
| ⑥ 导出 | `delivery/index.js:315` | **断**：无路由；`/import-check` 返回 `supported:false`（`service.js:604`） |

断点全在 `ui/host/service.js:22-49` 的 import 边界上。

## 5. Q3｜防御性代码 12,483 行，占 18.7%

| 层 | 文件 | 行数 |
| --- | --- | ---: |
| 工程保证 | `base/{atomic-write,determinism,locks,paths,errors,redact,tempdir,faults,logger}.js` | 2,747 |
| 工程保证 | `core/project/{versions,recovery,write-guard,production-lock,store,migrations,schema,ids,paths}.js` | 4,541 |
| 小计 A | | **7,288** |
| 审计/守卫 | `core/project/{decisions,events}.js`；`tools/{pins,version,log,state,paths}.js` | 3,871 |
| 审计/守卫 | `editing/{guard,history}.js`；`delivery/closure.js` | 1,324 |
| 小计 B | | **5,195** |
| **合计** | | **12,483** |

占 66,700 行的 **18.7%**、占 51,935 行的 **24.0%**；只算 A 层则 10.9% / 14.0%。对照：直接产出画面的 `media/render/` 三适配器合计 2,111 行（1,028+399+684），**比 `versions.js`+`recovery.js`（2,522）还少**。

## 6. Q4｜UI 能不能改变画面

**不能，这条路径不存在。** ① 接口层：`ui/host/routes.js:84-107` 19 条路由无一条接收计划或渲染参数；`createMediaRuntime` 只在三脚本被调（`render.mjs:73`、`probe-ffmpeg-defects.mjs:105`、`probe-media-fit.mjs:104`）。② 客户端层：`actions.js` 35 个动作无一改画面。③ 表现层：会改画面的控件全 `disabled`（`views/work.js:108-110`）。

事实链路：人改 `build-plan.mjs` → `project/plans/*.plan.json` → `render.mjs` → mp4 → 人看 → 再改脚本；UI 只记住"在哪个项目、放了哪些素材、写了什么想法"。计划在 `acceptance/mixed-project/project/plans/`（`build-plan.mjs:33`），项目数据在 `$DSH_HOME/data/ai-video-workbench/projects/`（`ui/host/service.js:92-93`）——**验收计划与 UI 项目互不相识**。

## 7. Q5｜产品，还是验收过的基础设施 + 人肉脚本

**后者，且它对这点是自觉的。** 基础设施向：`base`+`core/project`+`tools` 三层（22,192 行）被真实装配，6+8+7 个单测文件，能承受故障注入与断电推演；`media` 确实渲染、解码、比对过真实字节。人肉脚本向：验收脚本 52 个、10,822 行全是 `node .../scripts/xxx.mjs` 手工串；成片路径硬编码本机绝对路径（`render.mjs:27-29`，换机即断，可移植性**未确认**）；交付包不是 `executeDelivery` 产的，而是 `deliver.mjs:30-40` 直接 `spawnSync('ffmpeg', …)`。反证：装上插件能做的止于 Q1 那 16 件，一条片子都出不来。

## 8. 如果是你来判：还差什么（按影响排序）

1. **没有渲染入口接进产品**——UI 与 media 零调用（`ui/host/service.js:22-49`、`routes.js:84-107`），"点一下出片"不存在。
2. **FFmpeg 适配器三个实测缺陷未修**：多 `xfade` 的 `offset` 基准错致成片截短 52%（1,464→696 帧）、非首场景文字晚 122 帧、`rgba()` 抛错（`实施交接/证据/C16-证据/03-实测缺陷与限制.md` §2–§4），备用渲染路径不可用。
3. **`fit`/`box` 被渲染层忽略**：同对象改属性两次渲染逐字节相同（同上 §1），"把图缩小放角落"是假的。
4. **时间线与合成对象不存在**——`views/work.js:108-110`、`:131`，即使渲染接通也无对象可驱动。
5. **评审闭环缺交互**：接受/回退只在 `editing/index.js:158` 的 kit 里，UI 只有无人发布的只读投影（`domains/review/index.js:57`）；`project.js:240` 自写"未接入"。
6. **助手只存不发**：一律 `queued-for-orchestration`（`ui/host/service.js:648`），编排由人改脚本承担。
7. **音画无联动**：复杂修改后画面切点 216/522/768 → 216/552/798，冲击音仍在旧帧，`diffPlans` 还报 `audioUnchanged: true`（同上 §6）。
8. **工程与产品重心错配**：防御性 18.7%，`versions`+`recovery`+`decisions` 共 3,927 行对应 UI 0 按钮；"让画面变好看"的能力在 `media/index.js:160-199` 被自己列为限制项（L2/L3）。

## 附：未确认

- Remotion 全片渲染在他机的可复现性（`render.mjs:27-29` 硬编码本机路径）。
- `acceptance/` 证据是否由可重复 CI 产出，还是逐次手工运行后归档（523 个 JS 是安装副本）。
- `media/templates` 曾缺于发布包（C16 D5，P0）；当前 `package.json:31` 已含，`C16R-证据/01-P0-安装与导出.json` 与 `01-P0-安装副本出片.mp4`（6,089 字节）指向已修复——是否经第二台机器验证未确认。
