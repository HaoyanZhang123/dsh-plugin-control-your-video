# 依赖准入与 MIT 台账

> 本文件由 `scripts/deps-report.mjs` 依据实际 `package.json`、`pnpm-lock.yaml` 与已安装包生成；
> 未安装或无许可证证据的包标为未核实，不假定为 MIT。
> 严格 MIT 只覆盖插件随包内容；宿主与用户独立安装的外部工具另记使用条件（CT-10 §1～§2）。

## 1. 边界分类（CT-10 §1）

| 边界 | 含义 | 是否纳入严格 MIT 门禁 |
|---|---|---|
| `with-pack` | 随插件包分发的依赖与代码 | 是 |
| `build-test-only` | 只在构建／测试时使用，不进入产物 | 否，但须检查是否被带入成品 |
| `host-provided` | 由 DSH 宿主提供（peer） | 否，宿主不纳入插件 MIT 判定 |
| `external-tool` | 用户独立安装的外部工具或服务 | 否，另记使用条件 |

## 2. 直接依赖

当前**零第三方依赖**：`package.json` 没有任何 dependencies／devDependencies／peerDependencies／optionalDependencies，
因此随包依赖闭包为空，没有需要逐项核对许可的第三方代码。

## 3. 传递依赖

传递闭包为空：没有已安装的间接依赖。

## 4. 构建与测试工具边界（CT-10 §3 / P4）

| 工具 | 版本 | 来源 | 边界 | 是否进入发布产物 |
|---|---|---|---|---|
| Node.js | 宿主捆绑 24.21.0；本机验证 24.22.1 | 宿主运行时／本机安装 | `host-provided`（运行时） | 否 |
| pnpm | 本机 11.21.0；宿主捆绑 11.28.5 | 本机安装 | `build-test-only` | 否 |
| `node:test` | 与 Node 同版本 | Node 内置模块 | `build-test-only` | 否 |
| 本项目 `scripts/*.mjs` | 见版本库 | 自写，MIT | 插件自有 P0 | 仅 `lib/` 产物进入，脚本不进入 |

> 本工程不使用 ESLint、Prettier、Vitest、esbuild 或任何第三方构建／测试包；
> 静态检查、格式化检查、测试运行与清单校验全部由 `scripts/` 下的自写脚本和 Node 内置模块完成。
> 这是有意的取舍：以零依赖换取可审计的 MIT 边界与离线可复现，代价是自写工具的功能少于成熟工具。

## 5. 未核实与需人工判断

- 当前没有第三方依赖，因此本工程内不存在“未核实许可证”的包。
- 外部工具**不随插件包分发**（CT-10 §2），因此不纳入严格 MIT 门禁。
- 外部工具是否存在于本机属于**环境事实**，不是本台账的许可结论。本机实测状态见下方第 5.1 节。
- 实际发布包尚不存在，因此不得宣称“插件整体 MIT 已达成”（CT-10 §6）。

### 5.1 外部工具：本机实测状态（不是许可判定）

> 由 `scripts/failure-lab.mjs` 实际探测生成，随 `evidence/failure-lab.json` 更新。
> 存在与否只说明本机环境，不改变“不随包、不适用插件 MIT”的边界。

| 外部工具 | 本机探测结果 | 是否随插件包 | 插件 MIT 判定 |
|---|---|---|---|
| FFmpeg | 本机检测到：ffmpeg version 9.0.1-full_build-www.gyan.dev Copyrigh… | 否 | 不适用（外部能力） |
| FFprobe | 本机检测到：ffprobe version 9.0.1-full_build-www.gyan.dev Copyrig… | 否 | 不适用（外部能力） |
| Remotion | 未探测（未安装、未运行；采用前须另行授权） | 否 | 不适用（外部能力） |
| HyperFrames | 未探测（未安装、未运行；采用前须另行授权） | 否 | 不适用（外部能力） |

## 6. 更新规则

1. 准入事实的唯一来源是 `docs/dependency-admission.json`（手写、只读）。本台账是**生成物**，
   不构成准入依据；`scripts/build.mjs` 与 `scripts/static-check.mjs` 只读该 JSON。
2. 新增依赖先在 `docs/dependency-admission.json` 登记，再修改 `package.json`；否则构建失败。
3. 依赖升级必须重新生成锁文件并复查传递闭包，不能只改版本号。
4. 任何 `with-pack` 边界的依赖必须为严格 MIT；Apache／BSD／ISC 等不能写成 MIT（CT-10 §1）。
5. 扫描结果不替代人工覆盖判断；发布前仍须按实际产物逐件核对（CT-10 §6）。
