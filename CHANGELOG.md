# 变更记录

## Changelog

本文件按版本分节。每节先写完整中文，再写完整英文；两份各自独立可读，不逐句对照。

Each version has two independent sections: a complete Chinese version first, then a complete English version. Entries are not sentence-by-sentence translations.

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
