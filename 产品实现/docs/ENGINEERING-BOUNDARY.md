# 工程边界与共享治理

> C04 产物。说明根文件归属、写入范围、并发与回退规则，供 C10、C06、C11、C12、C13、C14、C15、C16 直接遵守。

## 1. 根文件归属（由 C04 独占）

| 文件／目录 | 归属 | 其他任务卡可以做什么 |
|---|---|---|
| `package.json` | C04 | 只读；需要新增脚本时提变更请求 |
| `pnpm-lock.yaml` | C04 | 只读；由 C04 重新生成 |
| `pnpm-workspace.yaml` | C04 | 只读；`packages` 必须保持为空 |
| `cordis.patch.yml` | C04 | 只读；真实宿主入口出现时才由 C04 加行 |
| `base/` | C04 | 只读；只通过 `base/index.js` 门面使用 |
| `tests/` 共享工具 | C04 | 只读；模块自己的测试放各自路径 |
| `scripts/` | C04 | 只读 |
| `docs/`（本目录） | C04 | 只读；`docs/dependency-admission.json` 是唯一的依赖准入事实来源 |

**依赖准入的唯一事实来源是 `docs/dependency-admission.json`**（手写、只读）。`docs/DEPENDENCY-LEDGER.md` 是**生成物**，不构成准入依据——否则脚本会把自己写出的内容当作自己的授权，形成自清除门禁。`build.mjs`、`static-check.mjs` 只读该 JSON；任何脚本都不得写入它。

**业务范围不在本目录**：`core/`、`tools/`、`ui/`、`media/`、`orchestration/`、`editing/`、`delivery/`、`acceptance/`、`contracts/` 按 CT-00 §3 属其他任务卡。它们由各自责任卡创建，C04 不预先建立空目录。

## 2. 目录现状与预留

当前实际存在的只有：

```text
产品实现/
├─ base/                  共享工程原语（C04）
├─ scripts/               构建、测试、检查、证据脚本（C04）
├─ tests/                 分层测试：unit / contract / integration / acceptance（C04）
├─ docs/                  工程边界、依赖台账、测试策略（C04）
├─ evidence/              脚本生成的构建/测试/故障证据（C04，可重建）
├─ package.json           根清单（C04）
├─ pnpm-lock.yaml         锁文件（C04）
├─ pnpm-workspace.yaml    工作区配置（C04）
├─ cordis.patch.yml       组合补丁层（C04）
├─ LICENSE / README.md
```

后续卡在自己的路径下新增文件，**不修改上表根文件**。存在共享根文件冲突时走总控与本卡。

## 3. 分层测试职责（CT-11 §2）

| 层 | 目录 | 由谁写 | 能证明什么 | 不能证明什么 |
|---|---|---|---|---|
| 单元 | `tests/unit/` | C04（原语）与各卡（自己的纯函数） | 模式、时间、锁、迁移、脱敏等纯逻辑 | 页面、作品、跨模块流程 |
| 契约 | `tests/contract/` | C04（公共契约）与各卡 | 接口形状、版本、错误码、边界 | 跨模块真实流程 |
| 集成 | `tests/integration/` | 各卡（在自己路径建立后） | 多模块共同工作 | 审美、真实作品、长期体验 |
| 真实产品验收 | `tests/acceptance/` | C16 | 用户真实可完成旅程 | 用户审美判断（属用户） |

**当前 `acceptance` 层按设计失败**：没有可运行产品，也没有用户验收。测试进程本身以退出码 1 失败（真实断言失败，不是跳过），`scripts/test.mjs` 按设计将其归一为退出码 3 以便上层区分"设计内失败"与"意外失败"——这样门禁无法被绕过。

## 4. 并发与单写入者

- 同一任务卡同一时刻只有一个执行对话（03 §3）。
- 运行时层面：全局制作锁 `lock.global-production.json` 与项目修改锁 `lock.project-edit.<scopeId>.json` 由 `base/locks.js` 提供。
- 锁记录含拥有者 PID＋实例 ID＋主机、任务 ID、项目版本、获取时间与心跳；PID 复用不会被误判为存活。
- 陈旧锁只报“需要处理”，**不自动删除**；接管必须由用户在明确界面确认后传入 `stealStale: true` 并记录理由。
- 锁只证明声明的写入权，不证明外部进程已停止；继续前仍须查真实任务状态（CT-02 §4）。

## 5. 文件版本冲突与陈旧写入

- 所有持久写入使用 `writeFileAtomic`／`writeJsonAtomic`：同目录临时文件 → 回读校验 → fsync → 原子 rename → 发布后复核哈希。
- 失败时旧版本保持原样（已用真实磁盘满／权限不足故障验证）。
- 遇到版本冲突（`ErrorCode.VERSION_CONFLICT`）时：读取最新内容、说明冲突、基于当前版本重做，不覆盖他人新结果。
- 已知限制：Windows 上目录 `fsync` 返回 EPERM，因此**不承诺目录项持久性**，只承诺文件内容持久性。该限制写入 `DURABILITY_LIMITS` 并可被测试读取。
- 临时目录由 `TempDir` 管理并写入 marker；`findStaleTempDirs` 识别遗留目录但**只报告不删除**（清理必须可归属且显式）。
- 脚本必须在 `process.exit()` **之前** `dispose()`，否则 `finally` 被跳过并泄漏目录；`scripts/lib/temp-disposition.mjs` 统一处理，清理失败即使脚本失败。
- `cleanStaleTempFiles` 只删除**拥有者进程已退出**的 `*.tmp-write`；活进程的临时文件一律保留，避免清理反而破坏进行中的写入。

## 6. 回退

| 变更 | 回退方法 |
|---|---|
| 新增依赖 | 从 `package.json` 移除 → 重新生成锁文件 → 重建 `docs/DEPENDENCY-LEDGER.md`；不删除用户数据 |
| 修改根清单 | 保留上一版 `package.json` 与 `pnpm-lock.yaml`；两者必须成对回退 |
| 修改 `base/` | 保留上一版文件；`base/` 无运行时状态，直接回退即可 |
| 生成物 | `evidence/` 全部可重建，可删除；不参与发布产物 |
| 宿主入口 | `cordis.patch.yml` 保持空列表即“不贡献任何 Loader 行”，是安全状态 |

## 7. 质量门（后续卡必须通过）

```text
node scripts/verify.mjs
```

必须全绿（`acceptance` 按设计失败除外）。它依次运行：

1. `build` —— 宿主清单契约、入口存在性、依赖准入；
2. `lint` —— 静态规则 S1～S13；
3. `format` —— 格式检查 F1～F8；
4. `deps` —— 依赖准入与 MIT 台账；
5. `test:unit`／`test:contract`／`test:integration`；
6. `failure-lab` —— 11 项故障与回退实证。

失败时不得以“其余都通过”合并。

## 8. 未建立的部分与责任

| 缺口 | 责任卡 | 当前状态 |
|---|---|---|
| 宿主半入口 `lib/index.js` | C11 及后续 | 不存在；`cordis.patch.yml` 为空列表 |
| client 半与 UI | C11 | 不存在；未声明 `dsh.client` |
| 项目／材料／版本核心 | C10 | 不存在 |
| 工具管理内核 | C06 | 不存在 |
| 媒体运行时与渲染 | C12 | 不存在 |
| 真实作品与验收 | C13／C14／C15／C16 | 不存在 |
| 实际插件发布包与整体 MIT | C16 | 不存在；**不得宣称插件 MIT 已达成** |

## 9. 不受工作区沙箱保护

Host 插件代码在宿主进程内运行，**不受 DSH 工作区沙箱限制**（C01 证据：`dsh-plugin-manager:31`）。因此 `base/` 提供的路径限制、脱敏与写入保护是产品自身的必需防线，不能把宿主沙箱当作安全保证（CT-12 §8）。
