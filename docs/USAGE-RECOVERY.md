# 使用与恢复说明（v0.1 内测）

## 1. 安装到专用 profile（不要直接装日常 profile）

```bash
export DSH_HOME="<专用 profile home>"
<DSH_CLI> plugin --profile ai-video-studio-dev add <ai-video-studio-0.1.11.tgz 的绝对路径>
```

`<DSH_CLI>` 由你的 DSH 安装方式提供；本文不假定固定安装路径。

**首次创建 profile 时必须补一行**：`dsh plugin ... add` 初始化出的 profile 只含 `@deepseek-ai/dsh-base`，需在
`<home>/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 中加入 `@deepseek-ai/dsh-web-app`，否则插件会停在
`waiting for service: webServer`。之后重启实例即可。

## 2. 打开与创建项目

- 侧栏 **Studio** 打开 Workbench；顶部可切换项目，也可用 `?project=<project_id>` 直达。
- 创建项目：让 Agent 调 `studio_project_create`（标题 + 工作区路径），或在面板「创作」区提交创作意图。
- 每个项目是独立目录：`<dataRoot>/projects/<project_id>/{state.json,objects/,jobs/}`。

## 3. 正常创作流程

1. `studio_artifact_create` 建对象（场景／整合片）。
2. `studio_render_job` 渲染本地 HTML 场景 → 成功自动登记**候选**版本（不改变工作依据）。
3. `studio_adopt_work_basis` 选定当前工作依据；`studio_integrate_artifact` 用**确切子版本**生成整合片。
4. 在「审阅」区播放、比较；用户提交**局部认可**（需媒体已加载）或**修改要求**。
5. Agent 依修改要求改源 → 渲染 → 新候选 → 用户复核。

## 4. 恢复（关实例／换会话之后）

- 只需 `project_id` + 数据根：`studio_project_state` 会读回当前工作依据、版本、决定、任务与能力。
- 源快照含**入口 + 全部文件哈希 + 依赖闭包校验**（缺失的引用会标 `closure_verified:false` 并列入 `external_deps`）。
- 重建：`studio_source_export` 把确切源导出到目录 → 再次渲染。实测与原始版本**逐字节相同**。
- 迁移：整目录复制到另一个授权位置 → `studio_project_attach` → 导出/重建同样成功。
- 中断：实例被杀后重启，未完成任务用 `studio_job_status{reconcile:true}` 对账为 `unknown`，不会自动重跑、不重复登记版本。

## 5. 停用与回滚

```bash
# 停用（从 profile 移除 bundle）
dsh plugin --profile ai-video-studio-dev remove ai-video-studio
# 回滚到旧版本
dsh plugin --profile ai-video-studio-dev add <older>.tgz
```

项目数据不受停用影响；重新安装后仍可读。

## 6. 工具缺失怎么办

`/studio/health` 与项目状态里的 `capabilities.missing` 会列出缺项。缺 ffmpeg/ffprobe/浏览器时：
项目管理、浏览、审阅记录、保存与恢复仍可用；渲染、抽帧、整合返回 `CAPABILITY_MISSING`。

## 7. 边界

- 不复制账号状态、不打包浏览器 profile、不含会话库。
- 渲染适配是本机 headless Chrome + FFmpeg（非 HyperFrames 官方渲染器）。
- v0.1 不支持 final/发布、自动审美评分、云同步、多供应商。
