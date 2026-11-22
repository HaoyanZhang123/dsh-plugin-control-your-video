# 变更记录

## Changelog

本文件按版本分节。每节先写完整中文，再写完整英文；两份各自独立可读，不逐句对照。

Each version has two independent sections: a complete Chinese version first, then a complete English version. Entries are not sentence-by-sentence translations.

---

## 0.6.0 · 2026-11-22

### 中文

这一版重排**专业知识层**，并补上三处真正影响创作能力的东西：审美判断原本被写成"只能人判"，无旁白只有否定没有替代，模型选型要在方案之外再问两次。范围对照上一个公开发布版 `0.5.0`。

**变更概览**：新增 5 项 · 优化 6 项 · 合并 7 个入口

**新增**

- **两条知识族**：`video-craft` 管"观众看到与听到的这一层"（症状分诊、叙事、视觉、运动、声音、剪辑、屏上文字、跨域裁决、审美判断写法）；`video-types` 管"怎么做出来、每条路线会怎么坏"（代码、实拍、三维、生成式、混合媒体）。两者各自带专业判断与按需索引，不是空壳路由。
- **审美判断通道**：`video-review` 原先把"这镜好不好""有没有质感"判为"无判据、只能人判"，实际等于取消了专业评价。现在要求先拆成可观察的判断，再给一条含判断／依据／因果／可反驳条件／置信度／替代路线与代价的结论，只把"满不满意、值不值得发、要不要接受这个代价"留给用户。
- **无旁白与纯视觉叙事**：新增 `video-craft/references/visual-storytelling.md`。此前只写了"这条片本来没有人声就不写"，没有给出画面、屏上字、声音三通道的分工与四种推进结构。
- **方案内媒体授权**：`approve_plan` 可带 `media[]`（型号、用途、货币、累计上限）。同一条宿主批准收据派生出授权必需的两条 receipt，不再单独问一次选型；用户批准时在问题正文里看得到型号、上限与"只发提示词文本"的数据范围。授权记住批准时的方案摘要，方案一改即失效；无法核对摘要时拒绝派发。
- **联系表取证**：`evidence` 新增 `sheet` 动作，把一段时间抽成一张网格图并记录每格的真实绝对时间。单帧看不出运动，这是"主动审美判断"最便宜的落地方式。

**优化**

- **编写规范去模板化**：删掉"五节骨架 / ≤150 行 / 3 示例 1 反例 / references 头两行固定格式"这组硬要求，保留并强化与代码耦合的五个共享接口、数值三问与"已被否掉的口径"清单。
- **人设（Persona）**：改为技术中立（内置 FFmpeg 是兜底之一，不是主路线）；模型随完整方案一次确认；补"要给有依据的专业判断，但不能替用户决定满意"；补"没看过、没听过要如实说，别把静帧当成看过成片"；局部任务走各自短路径。
- **数值冲突归一**：中文行高的 1.7–1.8（阅读型正文）与代码渲染的 1.15（撞行事故线）明确分家；Carbon 的产品 UI 时长表标注为"借快慢语义、不搬毫秒 token"；修正"24 fps 下 1 拍 = 12 帧"缺 BPM 条件的错误。
- **私人路径移出发布包**：17 份文件里的本机资产路径全部迁到仓库根 `PROVENANCE.md`（不随包发布）；`docs/编写规范.md` 不再要求写工作区相对路径。
- **型号快照移出 `skills/`**：5 份模型文档移到 `docs/model-notes/`，明确是带日期的历史快照、不作能力声明。
- **`video-library` 与工具对齐**：旧参考按内容类型分目录，而工具按七类**使用场景**落盘——照着参考写会被工具拒绝。现在正文与工具一致，并区分项目素材、跨作品经验库、用户自己的研究库。

**合并的入口**

`video-visual`、`video-motion`、`video-sound`、`video-edit`、`video-script` 并入 `video-craft`；`video-code-visual`、`video-prompting` 并入 `video-types`。当前共 8 个注册入口、48 份按需参考。旧名字不再注册，迁移对照表在 `PROVENANCE.md`。

**重要说明**

- **兼容**：项目状态仍存在宿主存储域，键与字段不变，旧项目的批准记录可读；`plan.md` 契约与 `plan-check` 规则未改，旧方案仍能通过；经验库数据与目录不变；旧模型授权记录只增字段、不改语义。**唯一可见的不兼容是 Skill 名字变化。**
- **升级需要重启并新开会话**：`cordis.patch.yml`、Skill 目录与文档都有改动。链接安装的旧版要先把依赖指向本包目录或新安装包。
- **审批仍是流程约束，不是不可绕过的运行时门禁**：`tools/preset-policy.js` 仍是空实现，标准 Shell 与文件工具仍在。
- **生成模型仍只支持提示词文本**：参考图、首尾帧、图生视频没有通道，需要时必须如实说明并商量替代。
- **验证范围**：Windows 11、Node 24.22.1、FFmpeg/FFprobe 9.0.1。`npm test` 123/123 通过（含真实媒体用例与新增的结构、接线、联系表测试）；22 个脚本通过语法检查；预设 28 项挂载成功、另 2 项按平台或配置禁用；隔离宿主冒烟通过真实 DSH 执行器贯通七个节点。真实 Desktop 手动安装、完整真实作品、多平台与多用户验收仍未完成。

### English

This release reorganizes the **professional knowledge layer** and fixes three things that actually limited capability: aesthetic judgement had been written as "only a human can answer", no-narration had only a prohibition and no path, and model selection asked outside the plan twice. Scope is compared against the previous public release `0.5.0`.

**At a glance**: 5 additions · 6 improvements · 7 entries merged

**Additions**

- **Two knowledge families.** `video-craft` covers *what the audience sees and hears* (symptom triage, narrative, visuals, motion, sound, editing, on-screen text, cross-domain arbitration, and how to phrase an aesthetic judgement). `video-types` covers *how it gets made and how each route breaks* (code, real footage, 3D, generative, mixed media). Both carry real judgement plus an on-demand index; neither is an empty router.
- **A channel for aesthetic judgement.** `video-review` used to classify "does this shot feel good" and "does it have texture" as unanswerable without criteria, which in practice cancelled professional evaluation. It now requires decomposing the question into observable judgements, then stating one conclusion with judgement, evidence, cause, falsifying condition, confidence, and an alternative with its cost — leaving only satisfaction, publish-worthiness and accepting the cost to the user.
- **No-narration and pure visual storytelling.** New `video-craft/references/visual-storytelling.md`. Previously the guidance only said "if the film has no voice, do not write one" and never assigned the work across picture, on-screen text and sound, nor offered sequencing structures.
- **Media authorization inside the plan.** `approve_plan` accepts `media[]` (model, purpose, currency, cumulative ceiling). The single Host approval receipt derives both receipts a grant requires, so selection is not asked a second time; the approval body itself shows the model, the ceiling and the "prompt text only" data scope. The grant remembers the plan digest it was issued against, stops dispatching once the plan changes, and refuses to dispatch when the digest cannot be verified.
- **Contact-sheet evidence.** A new `evidence` action `sheet` samples a time range into one grid image and records each cell's real, absolute timestamp. A single frame cannot show motion; this is the cheapest way to make active aesthetic judgement possible.

**Improvements**

- **Writing conventions de-templated.** Removed the mandated five-section skeleton, the ≤150-line ceiling, the three-examples-plus-one-counterexample quota and the fixed reference header format. Kept and strengthened the five code-coupled interfaces, the three questions every number must answer, and the list of already-rejected framings.
- **Persona.** Technology-neutral (the bundled FFmpeg route is one fallback, not the main road); the model is confirmed once with the complete plan; added "give a grounded professional judgement, but do not decide satisfaction for the user"; added "say plainly what you have not watched or heard, and never treat stills as having watched the film"; local tasks get their own short paths.
- **Conflicting numbers reconciled.** Chinese line-height 1.7–1.8 (reading text) and 1.15 (code-rendered collision threshold) are explicitly separated; the product-UI duration table is marked as borrowing the semantics of speed, not its millisecond tokens; the claim "one beat = 12 frames at 24 fps" is corrected to state that it depends on BPM.
- **Private paths removed from the shipped package.** Machine-specific asset paths in 17 files moved to `PROVENANCE.md` at the repository root (not shipped); `docs/编写规范.md` no longer asks anyone to write workspace-relative paths.
- **Model snapshots moved out of `skills/`.** Five model notes now live in `docs/model-notes/`, explicitly dated historical snapshots and not capability claims.
- **`video-library` aligned with the tool.** The old references organized a library by content type while the tool writes seven **use-case** directories — following the references produced entries the tool rejects. The text now matches the tool and separates project assets, the cross-project library, and the user's own research library.

**Merged entries**

`video-visual`, `video-motion`, `video-sound`, `video-edit` and `video-script` are folded into `video-craft`; `video-code-visual` and `video-prompting` into `video-types`. Eight registered entries and 48 on-demand references remain. The old names are no longer registered; the migration table is in `PROVENANCE.md`.

**Important notes**

- **Compatibility.** Project state still lives in the Host store with unchanged keys and fields, so existing approval records remain readable; the `plan.md` contract and the `plan-check` rules are unchanged, so existing plans still pass; library data and directories are untouched; existing media grant records only gain an optional field. **The one visible incompatibility is the renamed skills.**
- **Upgrading needs a restart and a new session.** `cordis.patch.yml`, the skill directories and the documentation all changed. A linked installation must be repointed at this package directory or the new archive first.
- **Approval is still a process constraint, not an unbypassable runtime gate.** `tools/preset-policy.js` remains a no-op and the standard shell and file tools remain available.
- **Generative models still accept prompt text only.** Reference images, first/last frames and image-to-video have no channel; when a work needs them the assistant must say so and discuss an alternative.
- **Verification scope.** Windows 11, Node 24.22.1, FFmpeg/FFprobe 9.0.1. `npm test` passes 123/123 including real-media cases and the new structural, wiring and contact-sheet tests; 22 scripts pass a syntax check; 28 preset rows mount with 2 disabled by platform or configuration; the isolated Host smoke test drives the real DSH executor through seven milestones. Manual installation in Desktop, a complete real work, other platforms and multi-user use remain unverified.

---

## 0.5.0 · 2026-11-22

### 中文

这一版把**自选制作路线、生成模型授权与结果恢复**接入同一条项目工作流。除了随包的 FFmpeg 路线，助手也可以用本机代码、图形或剪辑工具制作实际 MP4，再由 `cyv` 校验并登记为小样、全片或完整修订版。范围对照上一个公开发布版 `0.4.0`。

**变更概览**：新增 4 项 · 优化 2 项

**新增**

- **外部本地制作路线**：`approve_plan` 可固定外部路线、关键输入、画幅、帧率与音轨要求；`prepare_run` 和 `register_artifact` 分别管理制作阶段与结果登记。登记的 MP4 需通过完整解码、首中尾定位和文件摘要校验，成功后另存，不覆盖旧结果。
- **项目级模型授权**：`approve_media` 分别确认具体模型、用途、提示词传输范围和累计预算。同一项目在同一授权范围内可自主安排调用与重试；更换项目、模型、用途或扩大传输与付费范围时需要重新确认。
- **可恢复的授权与工件记录**：宿主独立保存预算占用、操作摘要和工件指纹。相同操作标识重放原结果，不重复生成或计费；费用或交付结果不明时保留占用并停止该授权下的继续派发。
- **扩展验证**：自动测试增至 104 项；隔离宿主冒烟新增外部本地路线和模拟媒体提供方，另通过两次真实 JSON 存储重开验证预算、重放和阻断状态可恢复。

**优化**

- **方案批准绑定完整执行范围**：批准身份覆盖完整方案、所选制作路线、固定输入与小样镜头选择。相同批准重放不重复询问；关键内容改变时不继承旧认可。历史批准记录仍可读取，但无法证明绑定时需在下一次正式制作前重审。
- **创作意图与方案使用同一份 `plan.md`**：减少意图摘要和制作方案分置造成的断链；意图提问收敛为会改变方向的关键问题。README、插件详情、验收记录与验证指南同步到本版行为。

**重要说明**

- **没有连接真实生成服务。** 所有模型授权与计费行为均通过隔离宿主中的模拟提供方验证，本次没有产生真实上传或费用。实际提供方必须可靠执行每笔 `maxCost`；同一 Profile 被多个进程同时打开时的计费互斥未验证。
- **审批是 `cyv` 路径的流程约束，不是不可绕过的运行时门禁。** 标准 Shell 与文件工具仍保留，独立创作可以不经 `cyv`。`plan-check` 判结构、时长和素材可核实性，不判方案或成片是否好看。
- **升级后需要重启并新开会话。** `cordis.patch.yml` 有改动；链接安装的旧版需先把依赖指向 0.5.0。旧项目、旧成片与经验库保留，不需要清理。
- **研究资产不随包分发。** OpenMotion、卡字、代码画风图鉴和真实感开关的暂存资料不属于本安装包，也不构成随包 MIT 内容。
- **来源关系**：本版由已验收的本地候选 `0.4.0-rc.4.v2.2` 转为公开正式版；发布前仅更新版本、文档与发布说明，并修正意图 Skill 的提问约束，不改变制作和授权逻辑。
- **验证范围**：Windows 11、DSH Desktop `0.2.2-rc.5`、Node 24.22.1、FFmpeg/FFprobe 9.0.1；104/104 自动测试通过，19 个脚本语法检查通过，预设 28 项挂载成功、另 2 项按平台或配置禁用。本版真实 Desktop 手动安装、完整真实作品、多平台与多用户验收仍未完成。

### English

This release brings **external production routes, generation-model grants and recoverable results** into one project workflow. Alongside the bundled FFmpeg route, the assistant can use local code, graphics tools or an editor to produce real MP4 files, then have `cyv` validate and register them as samples, full videos or complete revisions. The comparison baseline is the previous public release, `0.4.0`.

**Summary**: Added 4 · Improved 2

**Added**

- **External local production**: `approve_plan` can pin the external route, key inputs, dimensions, frame rate and audio requirements. `prepare_run` and `register_artifact` manage production stages and result registration. An MP4 must pass full decoding, first/middle/last positioning and file-digest checks; accepted results are saved separately without replacing older ones.
- **Project-scoped model grants**: `approve_media` separately confirms the concrete model, purpose, prompt-transfer scope and cumulative budget. Repeated calls and retries within the same project and grant are Agent-managed. Changing the project, model, purpose, transfer scope or spending scope requires a new decision.
- **Recoverable grant and artifact records**: the Host stores committed budget, operation digests and artifact fingerprints independently. Replaying an operation ID returns its original result without another generation or charge. An unclear charge or delivery outcome keeps the commitment and blocks further dispatch under that grant.
- **Expanded verification**: the automated suite now has 104 tests. Isolated Host smoke adds the external local route and a mocked media provider; two additional reopenings of real JSON storage verify that budget, replay and blocked states survive.

**Improved**

- **Plan approval binds the complete execution scope**: the approved identity covers the full plan, selected route, pinned inputs and sample-shot choice. Replaying the same approval does not ask again; material changes do not inherit it. Older records remain readable, but an approval whose binding cannot be established must be reviewed before the next formal production.
- **Creative intent and the production plan share `plan.md`**: this removes the handoff gap between separate intent and plan files. Intent questions focus on decisions that change the direction. The README, plugin details, engineering record and acceptance guide now match this release.

**Important Notes**

- **No real generation service was contacted.** Model grants and billing behaviour were verified only with a mocked provider in an isolated Host; no real upload or charge occurred. A real provider must reliably enforce each call's `maxCost`. Billing mutual exclusion across multiple processes using the same Profile remains untested.
- **Approvals constrain the `cyv` workflow; they are not an unbypassable runtime gate.** The standard shell and file tools remain available for independent work. `plan-check` checks structure, duration and verifiable assets, not creative or visual quality.
- **Restart and open a new session after upgrading.** `cordis.patch.yml` changed, and linked installations must first be repointed at 0.5.0. Keep old projects, videos and the experience library; no cleanup is required.
- **Research assets are not bundled.** The staged OpenMotion, kazi, awesome-code-animation and zhenshi-kaiguan materials are not part of this installation package and are not relicensed as bundled MIT content.
- **Provenance**: this public release comes from the accepted local candidate `0.4.0-rc.4.v2.2`. Release preparation changed the version, documentation and release notes, and tightened the intent Skill's question guidance; it did not change the production or grant logic.
- **Verification scope**: Windows 11, DSH Desktop `0.2.2-rc.5`, Node 24.22.1 and FFmpeg/FFprobe 9.0.1. All 104 automated tests passed, 19 scripts passed syntax checks, and 28 preset rows mounted with two more disabled by platform or configuration. Manual Desktop installation, a complete real production, other platforms and multi-user acceptance remain outstanding for this version.

---

## 0.4.0 · 2026-11-21

### 中文

V1.3 正式版。0.3.0 把流程写成规则，这一版把规则做成可执行的制作链：创意、完整方案、小样、成片与修订各自落到文件与宿主记录上，并随包提供一条本机 FFmpeg 制作路线。范围对照上一个公开发布版 `0.3.0`。

**变更概览**：新增 9 项 · 优化 3 项 · 修复 3 项

**新增**

- **三个受控确认点落到宿主记录**：创意方向、完整方案版本、代表性小样。答案由 DSH 的用户问答服务取得并存进宿主的 JSON 存储，方案认可绑定 `plan.md` 内容摘要、制作清单与小样镜头选择，小样认可绑定样片的 SHA-256。改动文件或换一版方案，旧认可自动失效。
- **`cyv` 工具**：项目新建与打开、素材复制、创意与方案、检查、小样与全片、修订、局部字幕、本机能力探测、插件内参考读取、经验库收录与检索都走这一个入口。
- **本机 FFmpeg 受控制作链**：程序画面（四种生成图案）、项目内照片、既有视频三种画面来源，可叠字幕，音频支持无声、程序音调、素材音轨与沿用镜头原声；能出代表性小样、完整成片和完整修订版，渲染前校验清单并加项目锁。
- **项目文件夹与素材副本**：项目是工作区里的普通文件夹；导入的素材复制进 `assets/` 并留哈希，原件不动。同名文件不被覆盖，后到的一份自动改名并保留两份；不安全路径与符号链接被拒，导入失败整批回滚。
- **可选的经验库**：默认不建、不预铺占位文件；按使用场景归类，读库与收录都要用户明确同意，收录发生在交付之后。
- **`plan-check` 契约检查**：不再要求固定十节与旧 11 列；认镜头表或逐镜小节两种写法，查缺镜、单镜与合计时长、可核实素材（已有／待产出／真缺三态）。
- **可选生成模型接口**：宿主插件可提供模型服务；单次素材任务分别确认选型与费用上限，一次授权只对一次调用有效。
- **公开资料核对预设**：把独立查证公开资料的活儿交给一个单独的预设，它只做网页检索与读取、文件查看、待办与提问，不承担创意和制作。
- **测试**：`npm test` 覆盖方案检查、项目创建与素材导入、审批绑定、本机制作与经验库；`tests/host-smoke.cjs` 用已安装的 DSH 与真实 FFmpeg 跑通小样、全片、与旧版并列的完整修订、导入片段的独立字幕与经验收录检索。

**优化**

- **视频预设改为“标准工具清单 + 插件工具”**：与标准预设一样的 Shell、文件读写、后台任务、计划模式、子代理与工作流全部保留，再叠加 `cyv` 与 `evidence`。此前的工具收窄只存在于 0.4.0-rc.1 候选包，正式版取消。
- **文档改为正式版口径**：README 中英双语、`docs/DETAIL.md`、`docs/工程验收.md`、`docs/验证指南.md` 与 locale 一起重写，安装、审批边界与验证范围的说法对齐实际行为。
- **修订交付**：每次修订另存完整新版并保留旧版，认可状态与文件版本继续绑定，可按文件比较新旧。

**修复**

- **rc.1 的“视频预设限制通用执行入口和子代理”说法**：那是 rc.1 候选包当时的临时收窄，不是正式版行为。正式版保留标准工具的完整能力，`tools/preset-policy.js` 为空实现，不设插件级的全局门禁。
- **0.3.0 的 `plan-check` 会拦下所有旧 `plan.md`**：现按契约检查，旧 11 列格式不再被强制，缺的是覆盖、时长与素材可核实性。
- **过时的状态描述**：README、DETAIL 与 locale 里“本地验收候选、真实用户验收待进行”的写法已按正式版与用户的实际使用结果更新。

**重要说明**

- **审批是流程约束，不是不可绕过的运行时门禁**。标准 Shell 与文件工具就在预设里，理论上可以不经 `cyv` 直接渲染；这套确认保证的是“用户批准过的内容版本才继续”，不是“技术上无法绕过”。文档避免使用“不可绕过”的表述。
- **`plan-check` 判结构、时长与可核实素材，不判创意好坏**。`pass` 仍需要人审；机器检查不能替代你的眼睛和耳朵。
- **生成模型接口未接真实服务**。仓库里的测试不连接任何真实提供方，模型选型与费用也仍需你逐次确认。
- **验证范围**：本机为 Windows 11、DSH Desktop `0.2.2-rc.5`、Node 24.22.1、FFmpeg/FFprobe 9.0.1。用户在 0.4.0-rc.3 上完成了真实最小正片，核心 Skill 达到可用目标——这是用户反馈，事件细节（片名、技术路线、时长）未在本仓库记录。没有 A/B 对照，也没有多题材、多平台或多人使用的验证。
- **升级**：`cordis.patch.yml` 有改动，装完必须按宿主提示重启并**新开会话**才生效。从 0.3.0 的旧链接安装（`npm link`、本地目录链接或指向旧路径的 `file:` 依赖）升级时，先把依赖换成 0.4.0 的安装包或本包目录再重启，否则会话里仍是旧版。旧版本目录、项目文件夹与经验库都不属于需要清理的文件，保留即可回退。

### English

Release V1.3. 0.3.0 wrote the workflow down as rules; this version turns those rules into a production chain — creative direction, complete plan, sample, full video and revisions each bind to a file and a Host-recorded decision — and ships one local FFmpeg route for making the picture. Compared against the last public release, `0.3.0`.

**Summary**: Added 9 · Improved 3 · Fixed 3

**Added**

- **Three Host-recorded checkpoints**: creative direction, complete plan version, and representative sample. Answers come from the DSH user-question service and are stored in the Host's JSON storage; a plan approval binds to the `plan.md` digest, production recipe and sample shot choice, and a sample approval binds to the sample file's SHA-256. Change the file or approve another plan version and the old approval stops applying.
- **The `cyv` tool**: project creation and opening, media import, creative decision and plan, checks, sample and full render, revisions, standalone caption work, local capability probing, in-plugin reference reading, and library save/search all enter through this one tool.
- **A controlled local FFmpeg route**: procedural graphics (four generated patterns), project photos, or existing video for the picture, with optional captions; audio can be silent, a generated tone, a supplied track, or each shot's own sound. It renders representative samples, complete videos and complete revisions, validating the recipe first and holding a per-project lock.
- **Project folders with copied media.** The plugin copies imported media into `assets/` and records file hashes. If names clash, it renames the later copy and keeps both files. It rejects unsafe paths and symbolic links, and rolls back a failed import.
- **An optional experience library**: nothing is created by default and no placeholder files are laid down; entries are organised by use case, and both searching and saving need your explicit consent, with saving happening only after delivery.
- **A contract-based `plan-check`**: the fixed ten sections and old eleven columns are no longer required. It accepts a shot table or per-shot subsections, and checks missing shots, per-shot and total duration, and whether each asset is verifiable (present, planned, or genuinely missing).
- **An optional generation-model interface**: a Host plugin can supply model providers. A standalone media task gets separate approvals for model choice and a spending cap, and one approval applies to exactly one call.
- **A preset for fact-checking public material**: independent verification of public sources goes to a separate preset that does web search and page reading, file viewing, todos and questions, and does not take on creative or production work.
- **Tests**: `npm test` covers plan validation, project creation and media import, approval binding, local production and the experience library; `tests/host-smoke.cjs` runs a sample, a full video, a complete revision beside the old one, a standalone caption job on imported footage, and a library save and search against an installed DSH and a real FFmpeg.

**Improved**

- **The video preset is now "the standard tool list plus plugin tools"**: the same shell, file access, background jobs, plan mode, subagents and workflows as the standard preset, with `cyv` and `evidence` added on top. The earlier narrowing existed only in the 0.4.0-rc.1 candidate package and is gone from the release.
- **Documentation rewritten for a release**: the bilingual README, `docs/DETAIL.md`, `docs/工程验收.md`, `docs/验证指南.md` and the locale entries were revised together so installation, approval boundaries and verification scope match actual behaviour.
- **Revision delivery**: every revision is saved as a complete new version while the old one is kept, approvals stay bound to file versions, and the two can be compared file by file.

**Fixed**

- **The rc.1 claim that "the video preset limits general-purpose execution and delegation"**: that was a temporary narrowing in the rc.1 candidate package, not release behaviour. The release keeps the standard tools' full capability, and `tools/preset-policy.js` is a no-op that sets no plugin-wide gate.
- **0.3.0's `plan-check` rejected every old `plan.md`**: it now checks the contract instead. The old eleven-column format is no longer mandatory; what matters is shot coverage, duration and verifiable assets.
- **Stale status wording**: "local acceptance candidate" and "user acceptance still pending" in the README, DETAIL and locale now reflect the release and the user's actual result.

**Important Notes**

- **Approval is a workflow constraint, not an unbypassable runtime gate.** The standard shell and file tools are mounted in the preset, so the local route can in principle be driven without going through `cyv`. What the checkpoints guarantee is that only a content version you approved moves on — not that bypassing is technically impossible, and the documentation avoids claiming otherwise.
- **`plan-check` judges structure, duration and verifiable assets, not creative quality.** A `pass` still needs human review; a machine check cannot replace your eyes and ears.
- **The generation-model interface has not been connected to a real service.** The tests in this repository contact no real provider, and model choice and cost still need your per-call approval.
- **Verification scope**: this machine is Windows 11 with DSH Desktop `0.2.2-rc.5`, Node 24.22.1 and FFmpeg/FFprobe 9.0.1. The user completed a real minimal film on 0.4.0-rc.3 and reported that the core Skills met the goal — a user report; event details (title, technique, duration) are not recorded in this repository. There is no A/B comparison, and no multi-genre, cross-platform or multi-person verification.
- **Upgrading**: `cordis.patch.yml` changed, so a restart per the Host prompt and a **new session** are required. When upgrading from a 0.3.0 link (`npm link`, a linked local directory, or a `file:` dependency pointing at the old path), repoint the dependency at the 0.4.0 package or this package directory before restarting, or the session keeps running the old build. Your previous version directories, project folders and experience library are not files to clean up — keeping them is what lets you roll back.

## 0.4.0-rc.3 · 本地候选（未公开发布）

### 中文

- 取代 rc.1 的工具收窄：预设改为标准工具清单加 `cyv` 与 `evidence`，Shell、文件读写、后台任务、计划模式、子代理与工作流全部保留。`tools/preset-policy.js` 改为空实现。
- `plan-check` 从固定模板改为契约检查，旧格式 `plan.md` 不再被无条件拦截。
- 这是正式 0.4.0 的来源候选包，行为与 0.4.0 一致；当时未公开发布。

### English

- Replaces rc.1's tool narrowing: the preset is now the standard tool list plus `cyv` and `evidence`, keeping the shell, file access, background jobs, plan mode, subagents and workflows. `tools/preset-policy.js` became a no-op.
- `plan-check` moved from a fixed template to a contract check, so plans written in the old format are no longer rejected outright.
- This is the candidate package 0.4.0 was built from and behaves the same; it was never published.

## 0.4.0-rc.2 · 本地候选（未公开发布）

### 中文

- 取消 rc.1 的工具收窄，预设改回标准工具清单：Shell、文件读写、后台任务、计划模式、子代理与工作流连同 `cyv`、`evidence` 一起挂载。
- 未公开发布。rc.2 已具备正式版的基本行为，后续 rc.3 在此基础上修整。

### English

- Drops rc.1's tool narrowing and restores the standard tool list: the shell, file access, background jobs, plan mode, subagents and workflows are mounted alongside `cyv` and `evidence`.
- Never published. rc.2 already behaves essentially like the release; rc.3 refined it.

## 0.4.0-rc.1 · 本地候选（未公开发布，工具范围已被后续候选取代）

### 中文

- 完整作品经创意、实际方案版本、小样三次认可。由宿主保存结构化用户答复并核对文件版本。
- 支持灵活的逐镜计划、当前素材副本、FFmpeg 小样与完整视频、恢复后继续和完整新版交付。项目文件与可选的按场景经验库分别存放。
- 提供隔离的宿主与真实媒体测试，以及[用户验收指南](docs/验证指南.md)。
- **这次候选包的预设收窄过工具范围**：只挂了只读图片访问与一个研究子代理，没有通用 Shell 与写入。该收窄在 rc.3 已取消，正式 0.4.0 不限制通用工具。围绕这一版跑的隔离执行器测试只证明当时那个受限预设的行为，不能当作正式版的门禁证据。

### English

- Complete video projects get three scoped decisions for the creative direction, plan version, and representative sample. The Host records structured answers and checks artifact versions.
- Supports flexible shot-by-shot plans, copied project media, FFmpeg samples and full videos, resumable approval state, and separate complete revisions. The optional experience library is organized by use case.
- Includes isolated Host and real media verification and a [user acceptance guide](docs/验证指南.md).
- **This candidate package narrowed its preset's tool list**: only read-only image access and one research subagent were mounted, with no general shell or writes. That was dropped in rc.3, and release 0.4.0 does not restrict the general tools. Isolated-executor tests run against this build only describe that restricted preset; they are not evidence about the release's gates.

## 0.3.0 · 2026-11-19

### 中文

这一版改的是**流程本身**。起因是一次真实使用复盘：两支片都没按预期停下来讨论方案，而是两分半从零做到整片脚本，方案最后才补。

**变更概览**：新增 5 项 · 优化 4 项 · 修复 3 项

**新增**

- **三个必经确认点**：意图确认后、完整方案后、小样后。写进 Preset 的 persona——停下来＝这一轮结束、交出回合、等用户下一句；用户没回话就不做下一步。
- **完整方案定义**（`docs/编写规范.md` §1.6）：`plan.md` 必须十节齐全——状态行、总述（散文，≤1000 字）、总览、阶段、视觉系统、声音、节奏与转场、标题与封面、制作路径、素材需求表、镜头表。
- **阶段层**：片 → 阶段 → 镜。每阶段八列：阶段、起止、时长、主题、风格、视觉变化、镜数、做什么。镜是执行单位，阶段是叙事单位。
- **镜头第 11 字段「动源」**：每镜必须声明这一镜的动从哪来，七类选一——主体位移、运镜、切点、转场、元素动效、整段特效、静止。
- **`plan-check` 门禁**：`evidence` 工具新增动作（也可独立跑 `tools/plan-check-cli.js`）。查 12 项，红灯非零退出，**有红不许进制作**。

**优化**

- `video-plan` 重写：删掉"方案不必四节全出""够用就停"，改成十节全出；加"定动源前必须先加载 video-motion"。
- `video-motion` 扩写：新增 §1.5「动源」，七类判据、碎动与整段特效的分界、实测动源与声明不一致怎么判；新增第六种 PPT 病因「动源与声明不符」。
- `video-motion` 的 description 改写：触发面从"用户抱怨像 PPT 时"扩到"要给镜头定动源、写动源列时"，修掉它此前在两支真实片里**从未被触发**的问题。
- `video-review` 观察清单新增「五之二」：报"这一段在动"之前必须同时给运动面积、最大连通块、连通块数量三个量，并与方案声明的动源对账。

**修复**

- **禁止清单 §7-3 自相矛盾**：原来把"请用户确认后再继续"列为不合格，使任何暂停写法都会被判死；改为「每一步都拍板」禁止，但三个确认点是必经的。
- **旧口径把碎动判成"在动"**：原「任一块变化即算这一帧有变化」的口径下，一个光点飘过就让整帧算通过。实测《万年归唐》小样按旧口径 `longest_static = 0.0s` 全项通过，而同一支片 55.7% 的帧是"高面积碎动"——变化散成 8 团以上、每团不到画面 2%，主体纹丝不动。
- `video-edit` 补方案阶段的分工表：阶段的「风格」与「视觉变化」由它定，具体帧号归制作阶段。

**重要说明**

- `plan-check` 会拦下按旧规范写的所有 `plan.md`。已有的在制作品需要按 §1.6 补齐十节、补动源列、补素材需求表，否则过不了门禁。
- 动源契约里"爽片主体位移或运镜 ≥30%"是方向性数值，**未在真实成片上校准**。
- `plan-check` 只认中文节标题；它判"写没写、齐不齐"，不判"方案好不好"。

### English

This release changes **the workflow itself**. It comes from a post-mortem of real use: two films skipped the planning conversation entirely — going from zero to a finished script in two and a half minutes, with the plan written last.

**Summary**: Added 5 · Improved 4 · Fixed 3

**Added**

- **Three mandatory checkpoints**: after intent confirmation, after the complete plan, and after the sample. Written into the preset persona — stopping means the turn ends, the floor is handed over, and nothing further happens until the user replies.
- **A definition of "complete plan"** (`docs/编写规范.md` §1.6): `plan.md` must contain all ten sections — state line, prose overview (≤1000 characters), at-a-glance table, stages, visual system, sound, rhythm and transitions, title and cover, production path, asset requirements, and the shot table.
- **A stage layer**: film → stage → shot. Eight columns per stage: stage, time range, duration, theme, style, visual change, shot count, purpose. Shots are execution units; stages are narrative units.
- **An eleventh shot field, "motion source"**: every shot must declare where its motion comes from — subject movement, camera move, cut, transition, element animation, full-frame effect, or still.
- **A `plan-check` gate**: a new action on the `evidence` tool (also runnable standalone via `tools/plan-check-cli.js`). Twelve checks; any red exits non-zero, and red means production cannot start.

**Improved**

- `video-plan` rewritten: removed "the plan need not have all four sections" and "stop when it is good enough"; the plan is now all ten sections. Added "load `video-motion` before assigning motion sources".
- `video-motion` expanded with §1.5 on motion sources: criteria for the seven types, the line between scattered micro-motion and full-frame effects, and how to judge when measured motion contradicts the declaration. A sixth "looks like a slide deck" cause was added: motion source does not match what was declared.
- `video-motion` description rewritten so it triggers when motion sources are being assigned — it had **never been triggered** across both real films.
- `video-review` observation checklist gained a section requiring three motion numbers (area, largest connected component, component count) alongside any claim that a segment "is moving", cross-checked against the declared motion source.

**Fixed**

- **Self-contradicting prohibition (§7-3)**: "ask the user to confirm before continuing" was listed as unacceptable, which killed any pause instruction. Now only per-step approval is prohibited; the three checkpoints are mandatory.
- **The old metric counted scattered micro-motion as motion**: "any block changed counts as this frame changing" let a single drifting light pass. Measured on the 《万年归唐》 sample, the old gate reported `longest_static = 0.0s` and passed everything, while 55.7% of the same film's frames were high-area scattered motion — changes split across 8+ components, none larger than 2% of the frame, with the subject motionless.
- `video-edit` gained an explicit division-of-labour table: per-stage style and visual change belong to it; frame-level timing belongs to production.

**Important Notes**

- `plan-check` will reject every `plan.md` written under the old spec. Works in progress must be brought up to §1.6 — ten sections, motion-source column, asset requirements table — or they will not pass the gate.
- The "subject movement or camera move ≥30%" figure in the genre contract is directional and **has not been calibrated against real finished films**.
- `plan-check` only recognises Chinese section headings, and judges completeness, not quality.

---

## 0.2.1 · 2026-11-19

### 中文

文档版。不新增能力，修掉"打开插件第一眼看得到的地方说的是错的"，并把上手路径补全。

**变更概览**：新增 3 项 · 优化 3 项 · 修复 4 项

**新增**

- 英文 `README.md` 与中文 `README.zh.md` 双语互链，配 1600×800 封面横幅；封面由真实成片静帧合成，生成脚本随包。
- 四张真实成片截图（1280×720，合计 411 KB），出自那次 5 分 12 秒全量实测。
- `video-library` 正文补"库还没建"的判据与话术：不建空目录、不铺占位文件、不为读库而建库。

**优化**

- README 重写为可执行的路径：60 秒上手五步、第一轮会看到什么、你的资产库放在哪、它不做什么。
- `docs/DETAIL.md` 补"你的资产库放在哪"一节，把运行时库与作品文件夹的分工写清。
- 已知限制改成更难被误读的写法：明确写出"没人连看过一遍"与"资产库复用从未验证"。

**修复**

- `locale/zh.json` 与 `locale/en.json` 写着"创作、提示词与声音三个方法技能"，那是 0.1.0 的架构，实为 13 个。
- `docs/DETAIL.md` 状态段仍写"尚未实测……下一步是装配后验证"，而 0.2.0 已在真实成片上跑通全量流程。
- `docs/DETAIL.md` 参考份数写 59 份，实为 48 份。
- 三处指向不随包分发文件的死链（`planning/夜间产出报告.md` 被 `DETAIL.md` 与 `编写规范.md` 引用，包内不存在）。

**重要说明**

- 本版无能力变更，不需要迁移。升级后技能正文即时生效，`cordis.patch.yml` 未改，无需重装重启。
- 资产库与素材**不随包分发**。用户自己的库由第一支片开始时从零长出。

### English

A documentation release. No new capability; it fixes where the plugin's first visible surface said something untrue, and completes the getting-started path.

**Summary**: Added 3 · Improved 3 · Fixed 4

**Added**

- Linked English `README.md` and Chinese `README.zh.md`, with a 1600×800 cover banner composed from real stills of a delivered film; the generator script ships with the package.
- Four real stills (1280×720, 411 KB total) taken from the full end-to-end run.
- `video-library` body now states what to do when the library does not exist yet: no empty directories, no placeholder files, and never build a library just to read it.

**Improved**

- README rewritten as an executable path: five-step quick start, what the first round returns, where your asset library lives, and what the plugin deliberately does not do.
- `docs/DETAIL.md` gained a "where your asset library lives" section separating the runtime library from project folders.
- The limitations section is harder to misread: it now states plainly that nobody watched the film straight through, and that library reuse has never been verified.

**Fixed**

- `locale/zh.json` and `locale/en.json` advertised "three method skills" — the 0.1.0 architecture. There are thirteen.
- `docs/DETAIL.md` still claimed "not yet tested … next step is post-install verification", while 0.2.0 had already run a full workflow on a real film.
- `docs/DETAIL.md` counted 59 on-demand references; the real number is 48.
- Three dead links pointing at files that are not distributed with the package (`planning/夜间产出报告.md` was cited by both `DETAIL.md` and `编写规范.md`).

**Important Notes**

- No capability change, so no migration. Skill bodies take effect immediately after upgrade; `cordis.patch.yml` is unchanged, so no reinstall or restart is needed.
- The asset library and any footage are **not** distributed with the package. Your own library grows from scratch when your first film starts.

---

## 0.2.0 · 2026-11-19

首个对外版本。基于一次全量实测（5 分 12 秒 B 站科普片）暴露的问题修正。

### 修复

- **Preset 增加 `plugin_manager` 工具**：此前装完就锁死，核对装配必须换会话；现在在本 Preset 内即可检查 bundle 与插件行（无 profileContext 时自动禁用）。
- **`evidence measure` 不再强制 `revision`**：缺省记为 `r-unset`。此前 schema 未标必填、脚本却拒绝调用，第一次测量必然失败。（不用 `r?`：`?` 在 Windows 文件名里非法。）
- **镜头时长以实测为准**：`docs/编写规范.md` §1.1 增加"实测优先、超 15% 回填总时长"的规则；`video-plan` §2 第 3 步增加回填与复核动画覆盖的对账点。此前只校验"合计对不对"，造出过 6.5 秒空转镜。
- **节奏结论必须先写口径**：`video-review/references/observation-checklist.md` 新增第五节，规定采样分辨率、分块方式、变化门限、判定规则四项必须与结论同时给出。此前同一支片能测出 12.5 秒与 0.57 秒两个相反结论。

### 新增

- `LICENSE`（MIT）、`README`、`CHANGELOG`。

### 已知限制

见 README "已知限制"。要点：仅一次全量实测、无 A/B 对照；听感与连续观看未验证；生成模型、Remotion、Canva 未测。

## 0.1.0 · 2026-11-18

- 首个可运行版本：Preset 装配、13 个 Skill、48 份参考、68 个测试用例、`evidence` 工具（extract / measure / recall / gc）。
- 本地目录安装时不再依赖 `@deepseek-ai/dsh-tools`（该包只存在于 DSH 安装目录，从链接位置解析不到，会导致 Preset 激活失败）；改用 `ctx.tools.register` 接受的普通定义对象。
