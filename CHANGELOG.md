# 变更记录

## Changelog

本文件按版本分节。每节先写完整中文，再写完整英文；两份各自独立可读，不逐句对照。

Each version has two independent sections: a complete Chinese version first, then a complete English version. Entries are not sentence-by-sentence translations.

---

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
