<p align="center">
  <img src="https://raw.githubusercontent.com/HaoyanZhang123/dsh-plugin-control-your-video/v0.3.0/assets/cover.png" alt="control-your-video 封面，由上一代构建交付的成片静帧合成" width="100%">
</p>

<p align="center"><sub>封面由上一代构建交付的成片静帧合成，仅作示例，不是本版的界面截图。</sub></p>

<h1 align="center">Control Your Video</h1>
<p align="center">把想法、脚本或你自己的素材做成完整视频的 DeepSeek Harness 插件——三个节点由你拍板。</p>
<p align="center"><a href="README.md">English</a></p>

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22.3%2B-339933?logo=node.js&logoColor=white" alt="Node.js 22.3 或更高版本"></a>
  <a href="https://ffmpeg.org"><img src="https://img.shields.io/badge/FFmpeg-H.264%20%2B%20AAC-007808?logo=ffmpeg&logoColor=white" alt="需要带 H.264 与 AAC 编码器的 FFmpeg"></a>
  <a href="https://github.com/deepseek-ai"><img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-3d8bff" alt="DeepSeek Harness 插件"></a>
  <a href="https://opensource.org/license/mit"><img src="https://img.shields.io/badge/license-MIT-3d8bff" alt="MIT 许可证"></a>
  <a href="https://github.com/HaoyanZhang123/dsh-plugin-control-your-video/releases/tag/v0.4.0"><img src="https://img.shields.io/badge/release-v0.4.0-7fd4ff" alt="v0.4.0 发布"></a>
</p>

## 简介

`control-your-video` 给 DeepSeek Harness 加上一个 **视频创作** 预设，以及一个把作品从最初想法带到交付文件的 `cyv` 工具。你决定创意方向、批准一份完整的逐镜方案、观看代表性小样并在认可后才进入全片制作。每次修订都另存完整新版，旧版原样保留。

这是一个插件包，不是时间线编辑器。它不附带素材、字体、音乐、模型或渲染集群。本机制作路线用你机器上已有的 `ffmpeg` 与 `ffprobe`；十三个方法 Skill 负责告诉助手怎么规划、写稿、定画面、剪、混音、审片和交付。

## 核心特性

- **三个由宿主记录的确认点。** 创意方向、完整方案版本、代表性小样各自通过 DSH 的用户问答服务确认，答复存在宿主里并与内容绑定：方案认可带 `plan.md` 内容摘要、制作清单与小样镜头选择；小样认可带样片的 SHA-256。改动方案或批准另一版本，旧认可随之失效。
- **先有完整方案，再进制作。** `plan-check` 读 `plan.md`，报出缺镜、单镜与合计时长不一致、以及无法核实的素材。它认镜头表或逐镜小节两种写法，并区分「还没做但路线已写明」与「真缺」。
- **本机 FFmpeg 制作路线。** 画面可来自程序画面（四种生成图案）、项目内已有照片或既有视频；字幕用本机字体；音频可选无声、程序音调、自带音轨或沿用镜头原声。能出代表性小样、完整成片与完整修订版，渲染前先校验清单，并对同一项目加锁。
- **项目文件夹与素材副本。** 项目就是你工作区里的普通文件夹。导入的素材复制进 `assets/` 并留哈希，原件不动；同名时后到的一份自动改名，两份都保留。不安全路径与符号链接会被拒。
- **可选的经验库。** 位于 `<工作区>/control-your-video/`，你不主动要用就不创建，条目按使用场景归类，读与写都要你同意。
- **十三个方法 Skill 与 49 份按需参考。** 规划、文稿、视觉、动效、提示词、代码画面、剪辑、声音、审片、交付、资产库、技能创作各有一份，正文短，任务需要时才读对应参考。
- **独立的公开资料核对。** 另一个预设专门做公开资料查证，挂的是网页检索与读取、文件查看、待办与提问，创意和制作仍归主会话。

## 安装

前提：

- **DeepSeek Harness** 宿主程序。这是插件包，不能单独运行。
- **Node.js 22.3 或更高版本**。预设通过 `process.getBuiltinModule` 定位 Skill 目录；DSH Desktop 自带兼容运行时。
- **可在宿主环境找到的 `ffmpeg` 与 `ffprobe`**，且带 H.264 与 AAC 编码器，本机制作路线需要它们。
- **一个字幕字体**，用系统已装字体。

安装：

1. 在 DSH 的插件管理器里选 **从本地目录安装**，指向本包根目录；或安装 [v0.4.0 发布](https://github.com/HaoyanZhang123/dsh-plugin-control-your-video/releases/tag/v0.4.0) 里的 `dsh-plugin-control-your-video-0.4.0.tgz` 打包文件。
2. 按提示 **重启 DSH**。Bundle 与预设的改动只在重启后生效。
3. **新开一个会话**，选 **视频创作**。预设改动不会应用到已经打开的会话。
4. 可选自检：让助手用 `cyv` 的 `local_capabilities`，它会报出实际看到的 `ffmpeg`、`ffprobe` 版本与编码器可用情况。

改 Skill 正文即时生效，因为 Skill 是运行时从包目录读取的。只有 `cordis.patch.yml` 变了才需要重装并重启。

## 使用方式

用自然语言说你想做什么。一句想法、一份脚本、一包素材，或「第 40 秒那段拖了」，都是有效开场。

1. 助手提出少量真正有区别的方向，并说明它推荐哪个。
2. 你确认创意方向。随后拿到完整的 `plan.md`，每镜的画面、动源、时长、声音与具体制作路径都在里面。
3. 你批准这个方案版本。助手渲染代表性小样——是真实文件，不是描述——然后停下。
4. 你观看小样，或指定镜头要求修改，或认可它。
5. 认可后渲染并交付完整视频；不认可则退回小样继续改。

一句修订（「末镜字幕再短一点」）会在旧版旁边另存一版完整新片。只给现有片段做字幕的局部任务有独立入口，不必走三个确认点。

验收步骤写在[用户验收指南](docs/验证指南.md)。

## 项目文件与经验库

```
<工作区>/my-film/               ← 项目：你自己命名的普通文件夹
  plan.md                       ← 你批准过的完整方案
  assets/                       ← 你提供的素材副本
  output/                       ← 小样、完整成片、修订版
  work/                         ← 项目元数据与证据
```

插件不会把你的文件搬到别处，也不锁定格式。经验库是工作区里另一个 `control-your-video/` 文件夹，只在交付后、且你说要收录时才写。

## 审批边界

三个确认点是**流程约束，不是不可绕过的运行时门禁**。预设挂的是 DSH 标准工具清单（Shell、文件读写、后台任务、计划模式、子代理与工作流），所以本机渲染理论上可以不经 `cyv` 直接驱动。这套确认保证的是「在 `cyv` 内置路线上，只有你批准过的内容版本才继续」；`tools/preset-policy.js` 是空实现，不设插件级全局门禁。其他 DSH 会话、DSH 之外的命令行、以及另装的宿主插件各有自己的权限范围。

生成模型是可选项。宿主插件可以提供模型服务；此时单次素材任务要分别确认选型与费用上限，一次授权只对一次调用有效。本仓库里的提供方接口尚未连接真实服务。

## 验证与已知限制

- `npm test` 覆盖方案检查、项目创建与素材导入、审批绑定、本机制作与经验库。`tests/host-smoke.cjs` 用已安装的 DSH 与真实 FFmpeg 跑通完整流程：代表性小样、完整成片、与旧版并列的完整修订、导入片段的独立字幕任务（原件字节不变），以及先批准再收录与检索的经验库条目。
- 已验证环境为 Windows 11、DSH Desktop `0.2.2-rc.5`、Node 24.22.1、FFmpeg/FFprobe 9.0.1。macOS、Linux 与其他宿主版本未测。
- 用户在 `0.4.0-rc.3` 上完成了真实最小正片，并反馈核心 Skill 达到预期。这属于用户陈述，不是留存下来的测量记录；片名、技术路线与时长不在本仓库里。
- 没有与普通提示词的 A/B 对照，没有多题材或多人使用验证，也没有跨第二支片的库复用验证。
- `plan-check` 只判完整度、时长与素材可核实性，不判方案好坏。检查全绿仍然需要你自己看和听。

## 升级说明

本版 `cordis.patch.yml` 有改动，必须按宿主提示重启并**新开会话**才生效。如果你是从 0.3.0 的链接装的（`npm link`、本地目录链接，或指向旧路径的 `file:` 依赖），先把依赖指向 0.4.0 的安装包或本包目录再重启，否则重启后加载的仍是旧版。旧版本目录、你的项目文件夹与经验库都不占什么、也不需要清理，留着才有回退的路。

## 文档

- [变更记录](CHANGELOG.md)
- [插件说明](docs/DETAIL.md)
- [用户验收指南](docs/验证指南.md)
- [工程验收记录](docs/工程验收.md)
- [编写规范](docs/编写规范.md)

## 许可证

插件源码采用 [MIT](LICENSE)。外部工具与服务遵循各自的许可证和条款。
