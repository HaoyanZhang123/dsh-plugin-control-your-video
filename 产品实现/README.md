# AI 视频创作工作台｜工程底座（ENGINEERING-BASE）

> 本目录是 C04 建立的**唯一工程底座**。它提供根清单、锁文件、共享构建与测试入口、依赖准入、日志脱敏、路径限制、临时目录、原子写与故障注入基础。
>
> **它不是产品。** 这里没有页面、没有渲染、没有项目业务，也没有任何“已完成功能”。业务范围由 C10／C06／C11／C12／C13／C14／C15 在自己的路径下实现。

## 1. 给后续开发对话的最小说明

只通过 `base/index.js` 使用共享能力，不要导入 `base/` 内部文件：

```js
import {
  PathGuard, writeFileAtomic, writeJsonAtomic, readJson, sha256File,
  createTempDir, createRedactor, createMemoryLogger,
  Clock, createSeededRandom, buildCacheKey,
  acquireLock, withLock,
} from 'dsh-plugin-control-your-video/base'
```

根文件（`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml`、`scripts/`、`tests/`、`base/`）由 C04 独占。其他任务卡不得新建或修改这些文件；需要改动时走总控。

## 2. 命令

| 命令 | 作用 | 是否可离线 |
|---|---|---|
| `node scripts/build.mjs` | 校验宿主清单契约、入口存在性、依赖准入；生成 `evidence/build-record.json` | 是 |
| `node scripts/test.mjs unit` | 单元测试 | 是 |
| `node scripts/test.mjs contract` | 契约测试（CT-01／CT-10 边界） | 是 |
| `node scripts/test.mjs integration` | 集成测试（锁、原子写、故障注入） | 是 |
| `node scripts/test.mjs acceptance` | 真实产品验收；**当前按设计不可运行并以失败退出** | 否 |
| `node scripts/static-check.mjs` | 静态规则检查（见第 5 节） | 是 |
| `node scripts/format.mjs --check` | 格式检查 | 是 |
| `node scripts/deps-report.mjs --check` | 依赖准入与 MIT 台账 | 是 |
| `node scripts/verify.mjs` | 一次跑完全部质量门 | 是 |

全部命令只需要 Node 内置模块，**不需要联网，不需要 `pnpm install`**（依赖闭包为空）。

## 3. 环境基线

| 项 | 基线 | 说明 |
|---|---|---|
| Node | 声明 `>=24.21.0 <25`；宿主捆绑 `24.21.0`，本机验证 `24.22.1` | 同一主版本内验证 |
| 包管理 | pnpm（锁文件 `lockfileVersion: '9.0'`） | 宿主捆绑 11.28.5，本机 11.21.0 |
| 宿主 | DSH Desktop `0.2.2-rc.1` | `engines.dsh` 精确声明；升级须重跑 C01 与 C04 检查 |
| 平台 | Windows x64（当前验证环境） | 其他平台未验证 |

## 4. 已实现的安全与质量基础

| 能力 | 模块 | 已实测内容 |
|---|---|---|
| 路径限制 | `base/paths.js` | 拒绝 `..`、绝对路径、驱动器、UNC、ADS、保留名、尾随空格／点；解析真实路径后拒绝 junction 逃逸 |
| 原子写 | `base/atomic-write.js` | 同目录临时文件 → 回读校验 → fsync → 原子 rename → 发布后复核；失败保留旧版本 |
| 临时目录 | `base/tempdir.js` | 受管目录、marker、自查尺寸、可关闭、陈旧目录只报告不删除 |
| 故障注入 | `base/faults.js` | 磁盘满、权限不足、文件占用、IO 错误、崩溃中途；真实接缝触发并记录次数 |
| 日志脱敏 | `base/logger.js` + `base/redact.js` | JSON 行日志；令牌、Bearer、JWT、私钥、URL 凭据、键名敏感值全部脱敏；真实根路径替换为占位符 |
| 确定性 | `base/determinism.js` | 可注入时钟、种子随机、稳定序列化、含全部依赖的缓存键、精确有理数时间、重叠转场总时长 |
| 锁 | `base/locks.js` | 全局制作锁＋项目修改锁；拥有者身份、心跳、陈旧检测；陈旧锁只报“需要处理”，不自动删除 |
| 错误 | `base/errors.js` | 稳定错误码；序列化不含 cause 与堆栈；外部失败默认不可重试 |

## 5. 静态规则（`scripts/static-check.mjs`）

S1 无 `require()`／S2 base 内禁止直接用 `Date.now()`／S3 禁止 `Math.random()`／S4 禁止绝对路径字面量／S5 禁止 `ctx.homePaths`、`ctx.userApproval`、`ctx.on('dispose')`／S6 base 内禁止 `console.*`／S7 文件头注释／S8 TODO 须带责任卡／S9 禁止秘密字面量／S10 UTF-8 无 BOM 且单尾换行／S11 禁止 `eval`／S12 导入须在依赖台账登记／S13 豁免必须写明理由。

单行可豁免，格式为 `// dsh-allow S2: 理由`，豁免会出现在检查输出中以便复核。

## 6. 明确未做的部分

- 没有 Host 半入口（`lib/index.js` 由后续卡实现），`cordis.patch.yml` 目前是空列表；
- 没有 client 半，未声明 `dsh.client`，也未在宿主中注册或加载验证；
- 没有 UI、渲染、项目业务、工具管理；
- `acceptance` 层不可运行：没有可运行产品，也没有用户验收；
- 实际插件发布包不存在，**插件整体 MIT 未达成**（CT-10 §6）。
