# dsh-plugin-control-your-video

> 在 DSH 内管理 AI 视频项目：独立项目、不可变版本、用户审阅决定、受管本地渲染，以及四区 Workbench（总览／创作／审阅／资产）。

## 安装

发布后推荐在 DSH → Plugins → Add plugin 填 npm 包名：

```text
dsh-plugin-control-your-video
```

本地开发时填这个包的绝对路径：

```text
<workspace>/projects/dsh-plugin-control-your-video/plugin
```

也可以使用 GitHub 仓库中的源码构建 tarball，再在 Add plugin 中填 tarball 的绝对路径。

## 开发

```bash
cd <workspace>/projects/dsh-plugin-control-your-video/plugin
pnpm install
pnpm build       # 生成 lib/host 与 lib/client.js
pnpm test        # 5 个 store 级测试
pnpm typecheck
```

构建产物在 `lib/`；源码在 `src/`。不要手改 `lib/`。

## 能力与边界

- 已实测：Windows x64、DSH 0.2.1-rc.3。
- 生产运行时只使用 Node 内建模块；TypeScript／esbuild 是开发依赖。
- 渲染适配是本机 headless Chrome + FFmpeg，不是 HyperFrames 官方渲染器。
- 缺 browser／ffmpeg／ffprobe 时，项目浏览、审阅记录和保存恢复仍可用；渲染返回 `CAPABILITY_MISSING`。
- 未验证：macOS／Linux、跨机恢复、整机断电耐久性、真实远端 exactly-once、声音审听。

## 文档

- [docs/CONTRACTS.md](docs/CONTRACTS.md)：命令、主体／来源、scope、版本、任务、路由与错误码。
- [docs/USAGE-RECOVERY.md](docs/USAGE-RECOVERY.md)：安装、使用、恢复、停用与回滚。
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)：实测兼容矩阵与未验证项。

## License

MIT License，见 [LICENSE](LICENSE)。
