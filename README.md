# AI Video Studio v0.1（本地内测）

DSH 内的视频创作工作台插件：项目、版本、决定、受管渲染任务与四区 Workbench（总览／创作／审阅／资产）。
**本地内测版：源码公开，安装包需自行构建；不改日常 profile。** 当前版本 `0.1.11`。

## 安装（专用 profile）

```bash
export DSH_HOME="<专用 profile home>"
# 使用你本机 DSH 提供的 CLI/启动器执行；不要把本机路径写进仓库
<DSH_CLI> plugin --profile ai-video-studio-dev add <ai-video-studio-0.1.11.tgz 绝对路径>
```

源码仓库不包含构建产物；安装前先执行 `pnpm install && pnpm build && pnpm pack`。

首次创建 profile 时需补两项（都已写进 `docs/USAGE-RECOVERY.md`）：

1. `package.json → dsh.profile.bundles` 加入 `@deepseek-ai/dsh-web-app`（否则插件停在 waiting for service: webServer）。
2. `cordis.patch.yml` 加入默认模型行（provider `deepseek-account` / model `deepseek-flash`），复用宿主既有登录，不复制凭据。

## 快速使用

1. 侧栏 **Studio** 打开；顶部选择项目（或地址栏 `?project=<id>`）。
2. Agent 用 `studio_project_create` / `studio_artifact_create` / `studio_render_job` 建项目、建对象、渲染候选。
3. `studio_adopt_work_basis` 选工作依据；`studio_integrate_artifact` 用确切子版本出整合片。
4. 「审阅」区播放、对比、提交**用户**局部认可或修改要求（Agent 只能写 `ai_check`）。
5. 恢复：只要 project_id + 数据根；`studio_source_export` 可导出确切源并逐字节重建。

## 文档

- `docs/CONTRACTS.md`：命令、主体/来源、scope、版本、任务、路由、错误码（冻结）
- `docs/USAGE-RECOVERY.md`：安装、使用、恢复、停用与回滚
- `docs/COMPATIBILITY.md`：实测兼容矩阵与未验证项

## 边界

- 渲染适配为本机 headless Chrome + FFmpeg（非 HyperFrames 官方渲染器）。
- 运行时不依赖第三方 npm；开发依赖只用于构建。
- v0.1 不支持 final／发布、自动审美评分、云同步、多供应商。