# 来源与验证记录（开发记录，不随包发布）

本文件记录本库专业知识的**出处、验证程度与已知缺口**，以及 v0.5.0 → v3 的知识迁移对照。

它不随 npm 包发布（不在 `package.json` 的 `files` 里）。用户侧的 `skills/` 与 `docs/` 不写本机私有路径——那些路径在这台机器上才有意义，随包发出去就是死链。

纪律：

- 「依据」写的是**真的读过**的文件，不是转述。
- 「未实测」必须具体到"哪一条、在什么条件下没验证过"。
- 「缺口」是写的时候就知道的空白，不用"待补充"糊过去。
- 来源受限的材料只提炼方法与判断，不搬原文、代码与词表，不随包分发。

## 一、文件迁移对照（v0.5.0 → v3）

| v0.5.0 | v3 位置 | 处理 |
|---|---|---|
| `skills/video-visual/SKILL.md` | `video-craft` §3 视觉 + `video-types` §5 三维 | 合并，去模板化，标注风格标准的条件 |
| `skills/video-motion/SKILL.md` | `video-craft` §4 运动与时间 | 合并；修 `1 拍 = 12 帧` 缺 BPM 条件；Carbon 时长表标为"借语义不搬数值" |
| `skills/video-sound/SKILL.md` | `video-craft` §5 声音 | 合并；"音乐不是铺底"标为一种主张 |
| `skills/video-edit/SKILL.md` | `video-craft` §6 剪辑与接缝、§7 屏上文字 | 合并；硬切默认与等间隔切点改为条件判断 |
| `skills/video-script/SKILL.md` | `video-craft` §2 内容与叙事 + `references/writing-*.md` + 新增 `visual-storytelling.md` | 合并；补无旁白的等价路径 |
| `skills/video-code-visual/SKILL.md` | `video-types` §3 + `references/code-*.md` | 合并；体例改为族内的"路线风险" |
| `skills/video-prompting/SKILL.md` | `video-types` §6 + `references/generative-*.md` | 合并；型号快照移出 skills/ |
| `skills/video-prompting/references/model-*.md` | `docs/model-notes/*.md` | 5 份带日期的历史快照，只作写法参考，不作能力声明 |
| `skills/video-visual/references/{design-system,layout,cover}.md` | `video-craft/references/visual-{design,layout,cover}.md` | 原样搬移 |
| `skills/video-motion/references/{motion-principles,motion-diagnosis,motion-measurement,effect-library}.md` | `video-craft/references/motion-*.md` | 原样搬移（`effect-library` → `motion-effect-library`） |
| `skills/video-sound/references/{voice-route,music-and-sfx,mix-and-verify}.md` | `video-craft/references/sound-*.md` | 原样搬移 |
| `skills/video-edit/references/{transitions,retiming,subtitles}.md` | `video-craft/references/editing-{transitions,retiming}.md`、`screen-text.md` | 原样搬移 |
| `skills/video-script/references/{narration-principles,article-to-voiceover,anti-ai-voice}.md` | `video-craft/references/writing-*.md` | 原样搬移 |
| `skills/video-code-visual/references/{canvas-and-three,render-pipeline,code-visual-review}.md` | `video-types/references/code-*.md` | 原样搬移 |
| `skills/video-visual/references/three-d.md` | `video-types/references/cg-3d.md` | 原样搬移 |
| `skills/video-prompting/references/{general-prompt,failure-attribution}.md` | `video-types/references/generative-*.md` | 原样搬移 |
| `skills/video-intent/*` | 原位置 | 保留为直接入口；去掉 8 字段强制表 |
| `skills/video-plan/*` | 原位置 | 保留为直接入口；补"每镜四件事" |
| `skills/video-review/*` | 原位置 | 保留为直接入口；**补审美判断通道** |
| `skills/video-release/*` | 原位置 | 保留为直接入口；去掉"不判断好不好看"；补时效标注 |
| `skills/video-library/*` | 原位置 | 保留；**与工具的七类场景目录对齐**（旧 references 按内容类型分目录，与工具不一致） |
| `skills/video-skill-authoring/*` | 原位置 | 保留；去掉固定模板与行数门禁，通用写法指向宿主的 `skill-creator` |
| — | `video-craft/references/visual-storytelling.md` | 新增：无旁白与纯视觉叙事 |
| — | `video-types/references/{code-driven,real-footage,mixed-media}.md` | 新增：代码路线的决策与两道门、实拍作业顺序、混合媒体桥接 |

## 二、各知识单元的来源与限制

### 创作意图（`video-intent`）

依据：`docs/编写规范.md` §1.2（当时的强制字段版）；`planning/产品框架-V1.md` §2、§3、§6、§13；`planning/首版能力骨架-主对话整合建议.md` §2.1、§5；`resources/research/已确认资产/02-创作剧本与分镜/10-video-shotcraft-共创与桥段/references/guided-free-creation.md`（"Agent 先填判断与依据、每轮 1—3 问"，其逐阶段确认流程未采用）；`resources/research/已确认资产/02-创作剧本与分镜/14-hypit-创作与时间支撑层/skills/hypit/references/creation/brief.md`（Apache 修改版，C 级，只作方法线索，未复制、未逐句翻译）；`resources/research/已确认资产/02-创作剧本与分镜/04-A组-分镜镜头与前期方法原文/A5-观众与时长/` 下 `thinkbox-earning-attention.md` 与 `thinkbox-a-matter-of-time.md`（只用于"声音可独立承载意义""长版才有叙事语境"两条方向）。

未实测：感觉词七条的读法与代价来自方法推演，没有用真实用户反馈校准；参考片四层拆解没有对照真实成片走过一遍；thinkbox 两份的结论未在本包做过任何验证。

缺口：没有真实用户案例库，七个感觉词之外的词没有积累；"不像 AI 做的"在具体模型与工具下如何分辨未实测。通用意图对齐方法可参考宿主自带的 `intent-alignment`。

### 完整方案（`video-plan`）

依据：`planning/产品框架-V1.md` §2、§3、§6、§13；`planning/首版能力骨架-主对话整合建议.md` §2.1、§5；`references/format-and-shape.md`（七种成立方式）、`structure.md`（结构）、`duration.md`（时长与重定时优先级）、`shot-format.md`（镜头行三问）、`sample.md`（小样选择）、`reference-rebuild.md`（参考重构）各自由前轮资产提炼，原始出处见各参考文件末尾的说明。

未实测：没有任何一支片子按这套顺序完整走完并把结论回填；片型与结构的七种分类来自方法与案例归纳，未在不同片型上逐一验证。

缺口：小样选择的"代表性"判据只有经验，没有对照实验数据；`plan-check` 判的是结构、时长与可核实性，不判创意可行性与审美。

### 内容叙事与口播写作（`video-craft` §2、`references/writing-*`、`references/visual-storytelling`）

依据：`resources/research/已确认资产/02-创作剧本与分镜/` 下逐个读过的文件，按"取到了什么"归成五条（许可等级写在行末）：

- ① `02-anything2explainer-讲解片解说词与分镜/reference/narration-guidance.md`——处境开场、主线、动机先于机制、接缝（C 级，只提炼原则，未沿用其句子、例子与编排）
- ② `12-garden-网页视频大纲与文风/references/` 的 `SCRIPT-STYLE.md`、`CHAPTER-CRAFT.md`、`OUTLINE-FORMAT.md`——只取方法与条件，其中的 60%、20 字、B 站默认已逐处标明来源与失效条件
- ③ `11-FullVideoProductionSkill-剧本与分镜/skills/` 的 `faceless-explainer/references/story-design.md`（按题材选结构）与 `hyperframes-creative/references/narration.md`（数字要写成能念出来的样子）
- ④ `01-lanshu-数字人讲解与12风格解说/explainer/stories/kv-cache/script.md`——只作"好口播长什么样"的参照，未抄用
- ⑤ `06-hypit-剧本语言与语义时间/skills/hypit/references/creation/script-and-time.md`（C 级，只提炼"文字与时间"的关系）与 `05-OpenMontage-剧本导演卡-11管线/skills/meta/voice-performance-director.md`（AGPL，只借"停顿当结构、给表演留位置"这一点，方法转述，未搬文本）

（以上均在 `resources/research/已确认资产/02-创作剧本与分镜/` 下。）

未实测：没有真的出声念过任何一稿，也没有把稿子送进 TTS 听过结果，所以"念着顺"全部是写作时的判断，不是听感证据。中文 4 字/秒是估读值，没有按实际语速测过；"2 分钟约 450—500 字"由它推出，误差未测。原资产里的"信息保留度 60%""每句 ≤20 字""B 站默认风格"都来自 garden 一份单作者材料，写进参考时已标明是文章转口播的起点而非硬门槛。

缺口：标题部分只覆盖"什么时候直白、什么时候给钩子"，没有覆盖各平台的标题长度、封面字与标题的配合。`visual-storytelling.md` 是 v3 新增，其判断来自"没有旁白时观众靠什么理解"的推演与看片常识，本包没有跑过无旁白成片的对照实验。

### 视觉、版式与可读性（`video-craft` §3、`references/visual-*`）

依据（逐份读过，不是转述）：`resources/research/已确认资产/03-美术图像与提示词/03-oil-ui-references/visual-language.md`；同组 `02-open-design版式模板与设计通则/craft/typography.md`；`05-FVPS视觉与方法-references/skills/faceless-explainer/references/composition.md`；`04-anatomy/references/3d.md`。

未实测：没有任何一支片子按这套顺序走完；"字号不小于屏高 4%""正文 45–60 汉字"是换算与经验值，未在成片上量过；中文断行三缺陷是静态判断，未在多种字体上各验一遍。

缺口：三份资产分别来自网页 UI、等轴测插图与讲解片，视频成片的"观看距离／屏占比"没有对应材料，只能现场核；封面的字形核验依赖出图后逐字读，替代不了那一步。

### 运动与时间（`video-craft` §4、`references/motion-*`）

依据：`resources/research/已确认资产/01-作品与案例/06-open-design-动效语汇/hyperframes/references/motion-principles.md`；`06-动效剪辑与Skill/01-动效原理与缓动/四条运动路线-归纳.md` 与同目录 `12原则-技术语言译写.md`、`A5-IBM-Carbon-Motion-摘取.md`；`06-动效剪辑与Skill/05-Skill文档/huashu-art-motion/references/镜头语言.md`。

未实测：没有渲染、没有生成、没有观看任何成片。六种病因的可观察现象来自资产里的成片复盘记录（如"每镜匀速推 7.5% 被判成放 PPT"）与规则作者的实测，不是在本项目片子上量到的；弹簧跨帧率不一致、采样折线复刻节奏，都是文档语义层面的结论，没有在本机跑过对比。

**部分实测支撑**：2026-11-19 在两支小样上跑了连通块与全局位移检测（"有大块主体动 6.9% / 碎动 72.5%"、"12.1% / 47.1%"），确认了"画面在变但主体不动"这种形态可被测出。但七类动源里 `转场`、`元素动效`、`整段特效` 三类的判定没有单独实测，`整段特效` 与 `碎动` 的机器边界尚未验证——那一栏只能人看。

缺口：Carbon 时长 token 快照只拿到 2/6，正文只借语义不借数值；W3C 快照缺 `cubic-bezier()` 与 `step()` 正文；Manim 只有函数名没有公式，无法据此复现曲线；"入场即停"与"有意停留"的边界最终仍要人看片判定。

### 声音（`video-craft` §5、`references/sound-*`）

依据：`resources/research/已确认资产/05-音乐与声音/07-采纳清单与反模式/`（`README.md`、`避免清单.md`、`未来音频层方向.md`——同步点语义、电平由构造保证、QC 闭环与两类工程病的来源）；`05-音乐与声音/02-音画同步与卡点方法/`（`a-video-shotcraft-卡点方法/music-beat-sync.md`）；`05-音乐与声音/03-混音响度与闪避/`（`01-标准/` 四份、`02-实现/mg-styles-mgaudio/README-音频工具包.md`、`03-学习要点/ffmpeg-响度与闪避-关键要点.md`）；`05-音乐与声音/`（`04-配音TTS-工程思路/`、`05-对齐算法-hypit-narrative-speech-alignment/README.md`、`06-音乐提示词方法/`、`01-mg-styles-15-声音/` 的 `README.md` 与 `15支声音-说明.md`）；`02-创作剧本与分镜/05-OpenMontage-剧本导演卡-11管线/skills/meta/voice-performance-director.md`。

未实测：没有任何一条跑过——没合成过语音、没渲染过片、没跑过节拍分析或响度测量；mg-styles 15 支一支都没听过，其响度是作者 ffmpeg `ebur128` 读数，不是听感结论。

缺口：TTS 工具的实际局部重配能力、"同一音色重配一句后接缝是否可接受"都无证据；节拍网格四项指标与渲后回测门槛来自单一作者的强鼓点宣传片，换片型未验证。v3 修正了原文"24 fps 下 1 拍 = 12 帧"缺 BPM 条件的问题。

许可：`04` 为 B 级（含 AGPL 部分）、`05/05` 为 C 级（修改版 Apache 附加条件）、`05/06` 为 D 级（厂商文档、许可不明），三处都只提炼方法与判断，不搬文本、代码与词表，不随包分发。

### 剪辑、转场与屏上文字（`video-craft` §6–§7、`references/editing-*`、`references/screen-text`）

依据：`resources/research/已确认资产/06-动效剪辑与Skill/02-转场与剪辑/`（`说明.md` 与同目录 studiobinder、remotion-transitions、remotion-audio-transitions、blender-vse-cross-strip、blender-vse-speed-control、otio-timeline-structure、ffmpeg-filters、pyscenedetect、auto-editor、editly 原文）；`06-动效剪辑与Skill/03-时间线与字幕/`（`说明.md` 与 bbc、netflix、webvtt-spec、w3c-webvtt-styling、aegisub-ass、videocaptioner、stable-ts、whisperx、faster-whisper 原文）；`01-作品与案例/06-open-design-动效语汇/hyperframes/references/transitions.md` 与 `01-作品与案例/03-simon-investigation/剪辑思路.md`；`02-创作剧本与分镜/02-anything2explainer-讲解片解说词与分镜/reference/narration-storyboard.md`。

未实测：没有渲染、没有剪过、没有看过任何一支成片。三种总时长语义（重叠缩短／切点上叠加／首末帧延展）来自文档描述，不是同一个工程量出的差；转场类型与用途来自行业科普页（StudioBinder 自述为博客，非规范），其"叠化 24—48 帧"是惯例描述；能量→时长映射来自一套 WebGL/GSAP 工程；BBC 与 Netflix 的数值没有在本机字幕上验过。

缺口：缺"转场时长与观众感知"的实测数据；中文断行的词类判据是从英文语法规则推的，没有中文语料验证；变速对瞬态位置的偏移量没有量化来源；卡点、多语言双字幕轨、HDR 下的字幕安全区都未覆盖。

### 代码与程序化（`video-types` §3、`references/code-*`）

依据：`resources/research/已确认资产/06-动效剪辑与Skill/06-代码实现/huashu-art-motion/` 的 `SKILL.md`，以及 `scripts/` 下 `storyboard_lint.py`、`film_gate.py`、`qa.py`、`font_subset.py` 的文件头与设计意图（未通读实现）；同目录 `lanshu/README.md` 与 `lanshu/explainer/core/core.js`；`08-补留动效方法原文/` 的 remotion-interpolate、remotion-spring、manim-rate-functions 三篇原文；`02-创作剧本与分镜/01-lanshu-数字人讲解与12风格解说/explainer/` 的 `GOTCHAS.md`、`KITS.md`、`STYLES.md`、`STARTER-BRIEF.md`、`stories/kv-cache/STORYBOARD.md` 与 `script.md`；`01-作品与案例/01-mg-styles-15/` 的 `说明.md`、`README.md`、`rubric.md`、`template.md` 与 `demos/`、`harness/`、`lib/`、`keyframes/` 的目录组织；`01-作品与案例/08-文本案例与方法/02-工程实现思路/` 的 `3b1b-交互式迭代-要点.md` 与 `Hydra-实时视觉-要点.md`；`03-美术图像与提示词/04-anatomy/references/` 的 `3d.md`（§1、§14—§16）、`verify.md`、`publish.md`。

许可：各组原许可分别保留；以上只提炼方法与判断，未搬用代码或文本。

未实测：本机没有安装或运行过其中任何引擎与脚本，没有渲染过一帧，没有看过 01/01 的 15 支成片（只读了说明与目录），所以"某画法能做到 X""某上限是多少"全部是文档说法，不是本机结果。性能数字来自资产作者在某台机器上的实测，不是通用阈值。

缺口：没有覆盖字幕、音画同步的细节；没有覆盖多机并行渲染与分布式出帧；"两次渲染逐像素一致"只在帧层面成立，编码后的 mp4 无法据此承诺。`code-driven.md` 是 v3 新增，把决策与两道门集中成一份作业顺序。

### 生成式素材（`video-types` §6、`references/generative-*`、`docs/model-notes/*`）

依据：`resources/research/已确认资产/04-视频模型与提示词/`（六份型号文档的说明与原文）；`06-动效剪辑与Skill/04-提示词写法/外部改造提示词的写法-归纳.md`；`01-作品与案例/08-文本案例与方法/01-提示词写法/`（三份要点）。未联网、未调用任何模型、未生成任何片段。

未实测：各型号的时长／比例锁定、参考素材上限、负向写法、音频标记全部来自文档声明，本机没有一条生成结果可对照。"身份错了先核映射"来自改造提示词的归纳与多主体映射说明，同样不是复现实验。

缺口：型号文档是**快照**，且已知其中至少一个端点已关停（`docs/model-notes/sora2-archived.md`）。这些文件只作写法参考，**不作能力声明**；现行能力必须以发布时查到的资料为准。`04` 组原文许可多为 unknown/©（D 级或未定），OpenMontage 适配层为 AGPL（C 级）；只提炼方法、未搬代码与原文段落，均不随包。

**工具侧事实**：当前授权接口只接受提示词文本，参数里出现 `image/video/inputs/source/path` 等键一律拒绝——参考图与首尾帧没有通道。这是代码决定的，不是文档遗漏。

### 审片、取证与专业判断（`video-review`）

依据：`docs/编写规范.md`（§1.3、§1.5）；`planning/产品框架-V1.md` §7.2—§7.3 与 `planning/首版能力骨架-主对话整合建议.md` §3、§5；`resources/research/已确认资产/08-许可标准与质量/05-质量评估与验收口径/口径.md`（A 级自写，只借结构不借分数）；`02-创作剧本与分镜/02-anything2explainer-讲解片解说词与分镜/reference/` 下 `lessons.md`（C 级，只提炼缺陷类型）与 `composition-and-light.md`（C 级，尺寸判据已条件化）；`06-动效剪辑与Skill/05-Skill文档/huashu-art-motion/references/镜头语言.md` §五。

未实测：没有在真实成片上跑过完整的 extract／measure／recall／sheet 流程（工具已实现，v3 之后才有联系表）；工具缺失时按能力降级，不假装取过证；去重与 `superseded` 流程未经脚本验证。

缺口：听感、混音、审美没有可靠的自动化路径，只能靠人听与专业判断。"`<2% 最大连通块 / ≥8 团`"这类阈值来自单支片一次实测，已写明来源，不能当通用门限。

**v3 修正**：原文把"这镜好不好？""有没有质感？"直接列为"无判据、答不了"，实际等于取消了"有理由的审美判断"这一档。现在改为：先拆成可观察的判断（§5），必须给出含因果与置信度的判断（§6），只把"要不要接受这个代价"留给用户（§8）。

### 发布判断（`video-release`）

依据：`planning/产品框架-V1.md` §6、§10、§13；`planning/当前共识与待决.md` D-02、D-14 与 `planning/首版能力骨架-主对话整合建议.md` §5；`resources/research/已确认资产/08-许可标准与质量/` 下 01—07 共 7 份（均自写提炼，A 级，只提炼结构不搬原文）；`05-音乐与声音/03-混音响度与闪避/01-标准/` 下 EBU R 128-2023、ATSC A/85-2026-07、ITU-R BS.1770-5 三份摘录。

未实测：没有在真实发布流程里跑过一次；没有实测任何 QC 脚本的退出码（"10 个里 5 个能判死"来自静态读码记录）；没有测过任何一支成片的响度，也没在任一平台后台核过标识功能是否可用。

缺口：GB 45438-2025 正文完全没有（标识样式与元数据字段给不出）；欧盟 deep fake／deployer 定义未摘、第 113 条时间表未摘；许可缺 Apache 第 2 条、CC BY 第 7 条、CC BY-NC 第 3 条、AGPL 全文；播客 −16／短视频 −14 无标准原文。以上都按"未核"写，不补齐、不推测。

**v3 修正**：原文描述里写着"不判断好不好看"，与"Agent 应给专业判断"冲突，已改为只在交付判断里不评价创作质量；同时新增 §8 时效标注：每条平台/法域结论都要能回答"依据哪一版、什么时候核的、什么条件下失效"。

### 跨作品经验与资产（`video-library`）

依据：`tools/experience-library.js`（七类场景、三状态、字段长度限制、读写都需要批准）；`references/library-rules.md` 与工具的实际目录模型。

未实测：v0.5.0 的 `library-rules.md`、`entry-quality.md`、`curation.md` 里有按内容类型分目录的旧模型（`preferences.md`、`methods/`、`prompts/`、`templates/`），与本工具按**使用场景**分类的目录不一致——照着旧参考写库会被工具拒绝。v3 已让正文与工具对齐；三份参考文件的内容按需再核。

缺口：检索是纯子串匹配（对 `index.md` 的行做包含判断），库变大后召回会变差；本包不引入索引服务，靠条目里写清"可检验特征"弥补。

### 技能创作（`video-skill-authoring`）

依据：`planning/DSH-Skill机制详解.md`（身份格式、rank、分层、目录消息、加载、watch、十个坑、排障）；`planning/产品框架-V1.md` §4 七层分工与 §9 装配隔离、§13 验证四层；`planning/首版能力骨架-主对话整合建议.md` §5 的口径与 §8 验证段。机制事实来自当前安装版 DSH 的子系统文档，不是本项目跑出来的。

未实测：DSH-Skill机制详解 §14 列的 5 项仍未实测——bundle 里 `!!js` 解析本地包路径、preset 层 provider 的实际隔离效果、Windows 上 watcher 的稳定性、`/名字` 手势的实际体验、描述截断的实际渲染效果。

缺口：验证四层的具体操作有协议但没有可执行脚本，结构校验仍靠人工核对；"一条库条目该不该升级成 Skill"只给了判据，没有跨作品样本。

**v3 修正**：去掉了"≤150 行 / 五节骨架 / 3 示例 1 反例 / references 头两行固定格式"这一组把本包模板当通用标准的硬要求；通用写法与 DSH 机制改为指向宿主自带的 `skill-creator` 与 `dsh-doc`。

## 三、v3 新增知识与它的验证状态

| 文件 | 内容 | 验证状态 |
|---|---|---|
| `video-craft/references/visual-storytelling.md` | 无旁白/纯视觉叙事的三条通道、四种推进结构、六种失败 | 未实测；无旁白成片的对照实验未做 |
| `video-types/references/code-driven.md` | 该不该用代码、两道门、画法、字体、验收 | 未实测；未在本机跑过完整出帧管线 |
| `video-types/references/real-footage.md` | 素材清点、时间码、三种"不够"、剪辑伦理、同步、权利前置 | 未实测；未跑过完整实拍项目 |
| `video-types/references/mixed-media.md` | 桥接表、统一顺序、一致性三支点、分层责任、露馅修法 | 未实测；未跑过多来源合成项目 |
| `video-craft` §8 跨域裁决、§9 审美判断六件套 | 判断与条件的写法 | 判据自写，未做对照实验 |
| `docs/编写规范.md` §4.2 | 已被否掉的口径清单 | 前轮产品讨论的结论，本轮只保留与强化 |

## 五、参考文件级的依据与限制

以下是各参考文件原来的"依据"段，原文照录（路径为开发机上的资产位置，用户侧不可解析）。
正文里已改为指向本文件，不再写这些路径。

- `skills/video-craft/references/editing-retiming.md`：`resources/research/已确认资产/06-动效剪辑与Skill/02-转场与剪辑/blender-vse-speed-control/原文.md`（倍速后帧用完即重复末帧、需手动改长度、慢放插值）、同目录 `ffmpeg-filters/原文.md`（`setpts` 的时间重映射、`minterpolate` 的补帧与场景切换检测）、`editly/原文.md`（按 cutFrom/cutTo 与目标时长自动变速）、`blender-vse-cross-strip/原文.md`；`resources/research/已确认资产/01-作品与案例/03-simon-investigation/剪辑思路.md`（只改视觉时复用同次音频与时间戳、不重新配音；以及"已确认旁白不因画面难做而改写"）；`resources/research/已确认资产/02-创作剧本与分镜/02-anything2explainer-讲解片解说词与分镜/reference/narration-storyboard.md`（一句一段＝每句都停＝整片显拖的反馈；段内与段末停顿的差别；字幕起点误差 ≈1 帧的校验）；`packages/control-your-video/skills/video-plan/references/duration.md` 与 `docs/编写规范.md`（预算归属与 ±10% 容差）。
- `skills/video-craft/references/editing-transitions.md`：`resources/research/已确认资产/06-动效剪辑与Skill/02-转场与剪辑/说明.md`（三层分法与三个工程坑的归纳），同目录 `studiobinder-editing-transitions/原文.md`（类型与用途，博客非规范）、`remotion-transitions/原文.md`（重叠/叠加、居中与偏移）、`remotion-audio-transitions/原文.md`（只在 entering 挂音频）、`blender-vse-cross-strip/原文.md`（gap 延展首末帧）、`otio-timeline-structure/原文.md`（转场不吃轨道长度）、`blender-vse-speed-control/原文.md`、`ffmpeg-filters/原文.md`、`pyscenedetect/原文.md`、`auto-editor/原文.md`、`editly/原文.md`；`resources/research/已确认资产/01-作品与案例/06-open-design-动效语汇/hyperframes/references/transitions.md`（四条硬规则与能量映射）。
- `skills/video-craft/references/screen-text.md`：`resources/research/已确认资产/06-动效剪辑与Skill/03-时间线与字幕/说明.md`（四旋钮与三条差异的归纳）；同目录 `bbc-subtitle-guidelines/原文.md`（§3.1 行宽双约束、§3.3 行数、§3.4 断点与五类不可拆搭配、§4.1 WPM、§25.4 安全区）、`netflix-timed-text-style-guide/原文.md`（§1 时长、§4 行处理与不可拆搭配、§5 定位）、`webvtt-spec/原文.md`、`w3c-webvtt-styling/原文.md`（cue settings 与 `::cue`/STYLE 块）、`aegisub-ass-docs/原文.md`（行样式、边距与自动断行、无两端对齐、`\N`/`\h`/`\an`/`\fad`）、`videocaptioner/原文.md`（按像素量宽与平衡折行、断句常量）、`stable-ts/原文.md`、`whisperx/原文.md`、`faster-whisper/原文.md`；`resources/research/已确认资产/02-创作剧本与分镜/02-anything2explainer-讲解片解说词与分镜/reference/narration-storyboard.md`（按画面单元分镜、块与停顿的具体做法，C 级只提炼）。
- `skills/video-library/references/curation.md`：`docs/编写规范.md` §1.4 硬规则、§8.2；`planning/产品框架-V1.md` §7.1"整理动作"与 §14"资产库变成知识管理工程"、§8 数据流（用户认可 → 记一条 → 值得就提升为技能）；`planning/当前共识与待决.md` D-09；`resources/research/已确认资产/07-产品与工作流/07-OpenMontage-工作流与状态机-要点/要点.md`（A 级自写，只取"契约与版式维护成本会漂"的反面教训，不取其人审门与检查点机制）。未实测：合并、删除、提升三个动作没有在真实库上执行过；"三支片"这个提升门槛是设计判断，不是实测得出的阈值。
- `skills/video-library/references/entry-quality.md`：`docs/编写规范.md` §1.4、§7（禁止清单 1/2/9/10 条）、§8.2；`resources/research/已确认资产/05-音乐与声音/07-采纳清单与反模式/避免清单.md`（A 级自写，只提炼"契约装饰化"判据）；`resources/research/已确认资产/08-许可标准与质量/06-QC与标识许可代码对应/代码对应.md`（A 级自写，只借"声明必须有消费者"与"名近实远"两条）。未实测：本份的六种写坏与三种反例来自写作时的推演，没有真实条目被用户判定过"这条没用"。
- `skills/video-library/references/library-rules.md`：`docs/编写规范.md` §1.4、§8.2；`planning/产品框架-V1.md` §7.1、§14；`planning/当前共识与待决.md` D-09；`resources/research/已确认资产/02-创作剧本与分镜/14-hypit-创作与时间支撑层/skills/hypit/references/creation/project-files.md`（C 级，只提炼"每个文档一份职责"与"参考真值/目标真值分开"）、同目录 `brief.md` 末节（C 级，只提炼"改哪个所有者"）；`resources/research/已确认资产/07-产品与工作流/08-hypit-语言层与本地工作室-要点/要点.md`（A 级自写总结）。未实测：本份的建立、读、写、修四套规则没有在真实的多作品序列上走过一遍；"用过"的三条口径是设计判断，没有使用数据校准。
- `skills/video-types/references/generative-failure.md`：`resources/research/已确认资产/06-动效剪辑与Skill/04-提示词写法/外部改造提示词的写法-归纳.md`（诊断→技术量、可测验收、反假修复、重试上限、单场景单派发）；`resources/research/已确认资产/04-视频模型与提示词/06-Seedance2.5-提示词指南/说明.md` 与原文的 FAQ（多任务混做、字幕、BGM 绕过、时长漂移等具体失效点）；`planning/首版能力骨架-主对话整合建议.md` §2.2（失败不写死“五层”“两次一律停”）。
- `skills/video-types/references/generative-prompting.md`：`resources/research/已确认资产/06-动效剪辑与Skill/04-提示词写法/外部改造提示词的写法-归纳.md`（诊断→技术量、不可变项＋真相源、成对写法、可测验收、反假修复、参数优先）；`resources/research/已确认资产/01-作品与案例/08-文本案例与方法/01-提示词写法/` 三份要点（任务类型与参数约束、结构化四段、公式与声音子公式）；`resources/research/已确认资产/04-视频模型与提示词/` 六份型号文档的写法共性。
- `docs/model-notes/luma.md`：`resources/research/已确认资产/04-视频模型与提示词/03-Luma-运镜概念/`（说明.md 与原文.md 全文，含 `/concepts/list` 返回的 34 个键）。
- `docs/model-notes/minimax.md`：`resources/research/已确认资产/04-视频模型与提示词/01-MiniMax-H3-视频生成指南/`（说明.md 与原文.md 全文）、`02-MiniMax-H3-提示示例集/`（说明.md 与原文.md 全文）。
- `docs/model-notes/seedance.md`：`resources/research/已确认资产/04-视频模型与提示词/06-Seedance2.5-提示词指南/`（说明.md 与原文.md 全文）；`resources/research/已确认资产/01-作品与案例/08-文本案例与方法/01-提示词写法/API参数与教程约束-要点.md`、`Seedance-结构化提示词-要点.md`（同厂另一版指南的要点）。
- `docs/model-notes/sora2-archived.md`：`resources/research/已确认资产/04-视频模型与提示词/04-OpenAI-Sora2-提示词指南/`（说明.md 与原文.md 全文，说明.md 明确记载 archived 与 2026-09-24 关停）。
- `docs/model-notes/veo.md`：`resources/research/已确认资产/04-视频模型与提示词/05-Google-Veo-提示词解剖/`（说明.md 与原文.md 全文）；结构判断另参 `references/general-prompt.md`。
## 四、维护

- 新增或改写的知识，在对应的"来源与限制"里补一条；不要只在 CHANGELOG 里写。
- 迁移文件时更新第一节的对照表。
- 本文件不随包发布；用户侧看到的是各 Skill 末尾更短的一段说明。
