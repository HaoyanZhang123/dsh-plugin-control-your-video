# 变更记录

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
