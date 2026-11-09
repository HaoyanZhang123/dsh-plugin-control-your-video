# dsh-plugin-control-your-video

DeepSeek Harness 内的 AI 视频创作工作台插件：项目与版本、工具管理、媒体渲染、创作编排与专业工作面。

> 状态：**开发中，尚不可安装使用。**当前仓库只有插件本体的源码与测试，没有可用于真实作品验收的完整产品。

## 仓库内容

| 路径 | 内容 |
|---|---|
| `产品实现/base/` | 错误模型、脱敏、路径守卫、原子写、确定性、锁与日志 |
| `产品实现/core/project/` | 项目生命周期、材料用途、确认与授权、三类版本、恢复 |
| `产品实现/tools/` | 工具检测、授权采纳、验证与追加式 pin 历史（不下载、不安装） |
| `产品实现/media/` | 合成计划、对象映射、渲染适配器（FFmpeg／Remotion／HyperFrames） |
| `产品实现/orchestration/` | 简报、方向、早期单元、工作包与连续制作 |
| `产品实现/ui/` | 宿主半、客户端外壳、四个入口与两个工作面 |
| `产品实现/tests/` | 单元、契约、集成与验收骨架 |
| `产品实现/scripts/` | 构建、静态规则、格式、分层测试与干净环境复现 |
| `产品实现/docs/` | 工程边界、依赖台账与模块说明 |

## 本地检查

```bash
cd 产品实现
node scripts/verify.mjs        # 构建、静态规则、格式、依赖、分层测试
node scripts/verify-clean.mjs  # 工作区外隔离目录复现
```

零第三方依赖，测试与构建只用 Node 内置模块，可离线运行。Node 需 `>=24.21.0 <25`。

## 明确边界

- 不下载、不安装、不更新外部工具；工具由用户自行安装后由插件检测与采纳。
- 外部运行时（FFmpeg／浏览器等）不随本包分发。
- 验收层按设计失败：还没有可运行产品，不允许用工程骨架冒充产品完成。
- 尚未验证：真实宿主内的长期使用、长项目、多进程竞争、非 Windows 平台与发布包许可闭环。

## 许可

代码与文档以 MIT 发布；外部工具遵循各自的许可，不因本包而改变。

## English

A DeepSeek Harness plugin for an AI video creation workbench: projects and versions, tool management, media rendering, creation orchestration, and a professional work surface.

Status: **work in progress, not installable yet.** The repository contains the plugin source and tests only; there is no complete product that could be accepted for real work.

The plugin never downloads, installs, or updates external tools — the user installs them and the plugin detects and adopts them. External runtimes are not bundled. The acceptance layer fails by design until a real product exists. Code and documents are MIT; external tools keep their own licenses.
