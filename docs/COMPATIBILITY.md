# 兼容矩阵（实测，不推测）

| 项 | 实测值 | 说明 |
|---|---|---|
| DSH | 0.2.1-rc.3（Electron 44.7.0） | 唯一实际安装并运行的宿主版本 |
| 平台 | Windows 10/11 x64 | 唯一实际测试平台；macOS/Linux 未测试（UNVERIFIED） |
| Node | 24.x（随宿主） | 插件只使用 Node 内建模块 |
| 浏览器（渲染适配） | 本机 Chrome / Edge（自动检测） | headless seek + 截图；缺失时渲染不可用，其它功能可用 |
| ffmpeg / ffprobe | 9.0.1-full（PATH） | 用于编码、探测、抽帧、整合；缺失时返回 CAPABILITY_MISSING |
| 生产运行时依赖 | 无第三方 npm 运行时依赖 | 仅 `node:*` 内建 |
| 开发依赖 | typescript 5.9.3、esbuild 0.28.2、@types/node | 只在构建/测试使用，不进包 |
| 状态 schema | `schema_version: 1` | 遇到更高版本拒绝读取（SCHEMA_UNSUPPORTED），不降级猜测 |
| 包 | `dsh-plugin-control-your-video@0.1.11` | 由本仓库源码构建；发布包哈希在构建产物中生成，不写入源码仓库 |

## 升级兼容

- 0.1.0 → 0.1.11 全程在同一 dev profile 上覆盖安装，项目数据（state.json 与 objects/）保持不变；每次安装后 `/studio/health` 与既有项目状态均可读。
- 升级不迁移、不重写既有状态；只有新增字段。旧项目直接可用。

## 不支持 / 未验证

- 跨机恢复（依赖本机浏览器与 ffmpeg 路径）——UNVERIFIED。
- 整机断电耐久性——未验证（只验证了进程被强杀后的恢复与对账）。
- 真实远端 exactly-once、多人协作、云同步——不在 v0.1 范围。
- 声音审听——测试素材无音轨，未验证。
