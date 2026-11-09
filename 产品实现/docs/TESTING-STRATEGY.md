# 测试策略与证据格式

> C04 产物。定义分层测试、证据格式与"什么不算通过"，供后续卡直接遵守（CT-11）。

## 1. 四层测试与禁止替代关系

| 层 | 命令 | 允许证明 | **禁止**用它替代 |
|---|---|---|---|
| 单元 | `node scripts/test.mjs unit` | 纯函数、时间、锁、迁移、脱敏、路径规则 | 页面、作品、跨模块流程 |
| 契约 | `node scripts/test.mjs contract` | 宿主清单契约、公开接口形状、错误码、依赖边界 | 跨模块真实流程 |
| 集成 | `node scripts/test.mjs integration` | 多模块共同工作（锁＋原子写＋故障注入） | 审美、真实作品、长期体验 |
| 真实产品验收 | `node scripts/test.mjs acceptance` | 用户能真实完成的旅程 | 用户审美判断（必须由用户作出） |

**当前 `acceptance` 按设计失败**：无产品可验收。测试进程本身以退出码 1 失败（真实断言失败）；`scripts/test.mjs` 把这一层按设计归一为退出码 3，用于区分"设计内失败"和"意外失败"。它不是跳过。任何让它在无产品时变绿的改动都是门禁绕过。

## 2. 什么不算通过

- 退出码 0：只说明命令成功，不说明功能可用；
- 覆盖率数字：不说明用户体验；
- 构建成功：不说明插件能被宿主加载；
- 测试全绿：不说明真实作品可播放、可修改、可交付；
- AI 自检通过：不等于 AI 实际看过／听过，也不等于用户验收。

CT-11 §1 的追踪链必须保留：功能编号 → 用户入口 → 契约条目 → 实现文件 → 测试用例 → 程序结果 → AI 实际视听 → 用户验收。

## 3. 证据格式

脚本生成的证据在 `evidence/`（可重建，不进入发布产物）：

| 文件 | 生成者 | 内容 |
|---|---|---|
| `build-record.json` | `scripts/build.mjs` | 清单检查逐项结果、产物哈希、产品面声明 |
| `test-summary.json` | `scripts/test.mjs` | 各层状态、文件数、退出码、证据路径 |
| `test-runs/<layer>.junit.xml` | `scripts/test.mjs` | 每层 JUnit 机器可读结果 |
| `verify-summary.json` | `scripts/verify.mjs` | 质量门全步骤结果与耗时 |
| `clean-verify.json` | `scripts/verify-clean.mjs` | 隔离环境复制、安装状态与逐步骤结果 |
| `failure-lab.json` | `scripts/failure-lab.mjs` | 11 项故障注入的实际观测值 |
| `dependency-report.json` | `scripts/deps-report.mjs` | 依赖判定与严格 MIT 闭包状态 |

证据里出现布尔字段时，**`true` 必须由实际测量得到**，不得预置。

## 4. 测试环境

| 项 | 值 | 说明 |
|---|---|---|
| 时钟 | `TZ=UTC` | 环境证据跨时区可比较 |
| 临时根 | 受管 `TempDir`，位于系统 TEMP 下的 `dsh-avw-*` | 测试不写工作区；可整体删除 |
| 并发 | 默认 `--test-concurrency=1` | 锁与文件测试需要确定性顺序 |
| Node | 24.21.0（宿主捆绑）与 24.22.1（本机） | 两者都已实际运行同一套测试 |

`TempDir` 会写入 marker 文件；`findStaleTempDirs` 能识别遗留目录，但**只报告不删除**（清理必须可归属且显式）。

## 5. 媒体与真实结果

本卡没有任何媒体断言，因为本卡不产出媒体。后续卡必须遵守：

- 真实媒体检查不能只依赖快照；
- 需要容差时必须预先写出理由和范围，不能事后放宽；
- 编码前源帧与编码后解码分别检查（CT-06 §7）；
- 动态必须连续播放；静帧只作定位；
- 未看／未听必须结构化标记，不能省略（CT-07 §6）。

## 6. 故障注入

`base/faults.js` 提供命名接缝。当前已接线的真实接缝：

| 接缝 | 位置 | 用途 |
|---|---|---|
| `atomic-write:before-write` | `writeFileAtomic` | 权限不足、写前失败 |
| `atomic-write:during-write` | `writeFileAtomic` | 写入中途失败 |
| `atomic-write:before-rename` | `writeFileAtomic` | 磁盘满、发布前失败 |
| `lock:before-acquire` | `acquireLock` | 锁获取失败 |

规则：

1. 故障默认关闭；启用必须显式 `enableFaultInjection({ allow: true })`；
2. 每次注入都记录触发次数，测试断言"确实触发了一次"，避免假注入；
3. 用完必须 `disableFaultInjection()`，否则会污染后续测试；
4. 故障只证明注入范围，不外推未注入的故障（CT-11 §5）。

## 7. 返工规则

- 缺陷记录：版本、对象、操作、预期、实际、证据、影响范围、责任卡、回退、重新验证范围；
- 修复只改目标与必要牵连；
- 返工后重跑受影响层与相邻集成，不默认历史测试仍有效；
- 不得以"主要功能正常"跳过缺陷（CT-11 §8）。
