# MH2 — MotionHarness 的 npm 包与 `mh` CLI 真实结构

> 方式：`npm view` → `npm pack` → `tar -xzf` → 只读字符串扫描。全程未安装、未 `import`、未执行 `mh`、未反编译。解包产物在 `C:\Users\18149\AppData\Local\Temp\mh-pkgs\`。

证据分级：**【实测】**=实际下载解包读到；**【推断】**=多组独立字符串交叉印证但未运行；**【未验证】**=不运行产品无法确认。

三个前提事实：npm registry 完全可用，GitHub 不需要；CLI 的真实逻辑**不在** `@motionharness/cli`（25 KB 启动器）而在 163 MB 的 Rust 二进制里，所以"读 CLI 源码"不存在；`@motionharness/sdk` 是唯一源码级富矿。

---

## §1 包清单

**【实测】**

| 包名 | 版本 | 解包大小 | license | 依赖 | bin |
| --- | --- | --- | --- | --- | --- |
| `@motionharness/cli` | 0.1.4 | 25,551 B / 6 文件 | `UNLICENSED` | 无；4 个 optional 平台包 | `mh`→`bin/mh` |
| `@motionharness/sdk` | 0.1.4 | 293,367 B / 79 文件 | `UNLICENSED` | `its-fine@2.1.1`、`@webgpu/types@0.1.72` | 无 |
| `cli-win32-x64` | 0.1.4 | 163,122,122 B / 4 文件 | `UNLICENSED` | 无 | 无（只装 `MotionHarness.exe`） |
| `cli-darwin-arm64` | 0.1.4 | 148,134,455 B / 4 | `UNLICENSED` | 无 | 无 |
| `cli-darwin-x64` | 0.1.4 | 151,950,767 B / 4 | `UNLICENSED` | 无 | 无 |
| `cli-linux-x64` | 0.1.4 | 64,210,044 B / 4 | `UNLICENSED` | 无（glibc） | 无 |
| `@motionharness/bridge-davinci` | 0.1.4 | 2,073,592 B / 27 | `UNLICENSED` | 无 | 无（`exports: ./dist/runner.mjs`） |
| `@base_bit/vmg-cli` | 0.0.14 | 58,965,077 B / 13 | **`Apache-2.0`** | 内嵌 `@motionharness/cli@0.0.11` | `mh`+`vmg` |
| `@base_bit/vmg-cli-darwin-arm64` | 0.0.14 | **628 B** / 2 | **`Apache-2.0`** | 无 | 无（空壳） |

**元数据要点**：`cli` 的 `engines.node >= 22.15`，`files` 白名单只 5 项，仓库 `VibeMG/vibe-motion-graphics`，GitHub Actions 用 OIDC 发布。`sdk` 有 **13 个导出子路径**（`.`、`host`、`host/render`、`standard`、`three`、`motion`、`easing`、`effects`、`geometry`、`sequence`、`fonts`、`loop`、`values`、`basic-properties`），peer 要求 `react >=19 <20`、`three@0.180.0`，且 three/R3F 全部 `optional: true`，另有私有字段 `mhOptionalEntries`。

**版本谱系（重要）**：2026-09-28 发生改名。`@base_bit/vmg-cli@0.0.14` 的 description 自述 *"VMG has been renamed to MotionHarness (mh)"*，同一天 `@motionharness/cli@0.0.11` 首发。vmg 包是**迁移壳**，`bundleDependencies` 把新包整个塞进去。`cli-linux-x64` 与 `cli-darwin-x64` 的首个正式版就是 0.1.4（2026-11-11），此前只有 `0.0.0-stage` 占位——这解释了 README"某些版本只为一个平台发布"那句。0.1.0→0.1.4 全在两天内，产品仍在快速迭代。

---

## §2 解包文件树（≤3 层）

**`@motionharness/cli`**
```
package/
├── LICENSE 1,021 · README.md 10,936 · package.json 905
└── bin/{mh 3,365 · npm-resolve.mjs 2,405 · windows-update.mjs 6,919}
```

**`@motionharness/sdk`** — 每个 `.ts` 模块都配 `.d.ts`
```
package/
├── LICENSE 682 · NOTICE 489 · README.md 43,454 · THIRD_PARTY_NOTICES.md 1,398
└── dist/                        67 文件
    ├── index.{js,d.ts}          authoring.{js,d.ts}
    ├── authoring-types.d.ts     19,213 ← 全量文档模型
    ├── authoring-runtime.{js,d.ts}      ← Layer/Canvas/Image/Video/useTime
    ├── effects.{js,d.ts}        11,473 ← 16 种特效参数
    ├── basic-{container,graphic,media,properties} · camera · color
    ├── control-panel · counter · easing · effect-stack · follow · fonts
    ├── geometry · host · loop · mask · motion · path · path-follow
    ├── repeat · render · sequence · standard · text · three
    ├── time-markers.d.ts        4,953 ← AI 标记协议
    └── time-remap · video-time
```
关键：`render`、`standard`、`time-markers` 的 `.js` 都只有 **11 字节**（`export {}` 空壳），只有 `.d.ts` 有内容——契约对外，实现在闭源宿主里。

**平台包（四个同构）**
```
package/
├── LICENSE 1,040 · README.md 11,114 · package.json 592
└── bin/MotionHarness.exe     163,109,376
```

**`@motionharness/bridge-davinci`**
```
package/
├── bridge-manifest.json 4,172 ← 25 文件 sha256 清单
├── README.md 23,315 · LICENSE · NOTICE · OPENFX_LICENSE · THIRD_PARTY_NOTICES.md
├── dist/{runner.mjs 1,039,070 · resolve_rpc.py 98,079 · legacy_conversion.py 45,002
│        · instance_runtime.py 33,368 · intrinsic_runtime.py 6,611
│        · inspector_runtime.py 5,901 · runtime_io.py 1,013}
└── resources/
    ├── HotionHarness.ofx.bundle/Contents/{Info.plist, MacOS/HotionHarness.ofx}
    ├── MotionHarnessBridge.app/Contents/{Info.plist, MacOS/, Resources/{en,zh-Hans}.lproj}
    ├── MotionHarnessInstall 67,752 · menu-entry.py · legacy-*.lua
    └── sidebar-help/{index.html, en.html, guide.css}
```
`HotionHarness` 的拼写错误是历史包袱，README 明说要保留以兼容旧工程。`bridge-manifest.json`（`schemaVersion:1`、`protocol:1`、`cliVersion:"0.1.4"`）就是 CLI 安装组件时核对完整性的依据。

**`@base_bit/vmg-cli`** — 迁移壳教科书：`bin/{mh,vmg,launcher.cjs}` 三个 2,928 B 的转发器 + `node_modules/@motionharness/cli` 与 `cli-darwin-arm64`（内含 58,918,704 B 二进制）。`vmg-cli-darwin-arm64` 只有 `package.json`+说明，是退役占位，防旧 lockfile 解析失败。

---

## §3 `mh` CLI 的完整命令面

### 3.1 启动链路（理解一切的前提）

**【实测】** `bin/mh` 仅 55 行：校验 Node ≥22.15 → `npm-resolve.mjs` 按包名+版本精确定位平台包 → 注入 `MH_NPM_PACKAGE_JSON`/`MH_NODE_EXEC_PATH` → **非 Windows 用 `process.execve()` 把整个进程换成 Rust 二进制**（无中间层）；**Windows `spawn` 子进程**，因为 libuv 的 Job Object 会在父进程退出时杀掉子进程；若参数含 `update` 且非 `--check`/`--help`，额外把 `windows-update.mjs` 拷到临时目录，靠 IPC 让它在原 exe 退出后再跑 npm 安装。**`mh` 本身零业务逻辑。**

### 3.2 顶层命令表

**【实测】** 来源：二进制 help 描述串 + README + 范例串。`mh describe <command>` 可自省精确参数。

| 命令 | 作用 / 关键参数 |
| --- | --- |
| `new <dir>` | 建工程。`--type standard\|pro`、`--sdk`、`--skip-install` |
| `open [dir]` | 启动/复用会话返回 Studio URL。`--browser`、`--output-format json` |
| `doctor` | 检查工具与缓存。`--check`、`--timeout-seconds` |
| `capabilities` | **不启动会话**列出支持的操作 |
| `describe <cmd>` | 输出命令的输入契约。`--type <action>` |
| `inspect` | `--view full\|summary\|instances\|parameters`、`--instance`、`--parameter`、`--query` |
| `batch` | 数组批量编辑，全成或全不成 |
| `param set` / `param reset` | 设值 / 恢复源码默认 |
| `keyframe list\|set\|edit\|remove\|loop\|apply\|bake\|sequence` | 关键帧全生命周期；`--time --value --easing --limit` |
| `instance timing\|geometry\|stagger\|rename\|visibility\|delete` | `--start --duration --edge --timeSpace` |
| `list add\|remove\|duplicate\|move` | `--preset` |
| `table import` | CSV/TSV 或行数组导入 |
| `effects` | 特效栈增删移与参数键 |
| `component action` / `component control` | 调组件声明的 action / 控件 |
| `history undo` / `history redo` | 撤销/重做用户编辑 |
| `checkpoint list\|create\|restore\|recover-work\|collect\|gc` | 可运行版本保存与恢复 |
| `project settings\|rename\|reload\|migrate` | 含 `migrate file`、`migrate rename` |
| `pack <out.vmg>` / `unpack <in.vmg> <dir>` | 打包（不含历史）/ 解包 |
| `render <out>` / `render plan\|status\|cancel` | `--json '{"format","fps","quality","start","duration","codec","alpha","motionBlur"}'` |
| `preview` | `--time --times --output --output-dir --contact-sheet --columns --file --check-playback` |
| `capture-probe` | `--json` / `--file` / `--stdin` |
| `studio sessions` / `studio control` | 列/控 Studio 页；`--client`、`--file` |
| `daemon start\|status\|logs\|stop` | 后台宿主 |
| `status` / `close` | 看/释放会话 |
| `update` | `--check`、`--output-format json\|text`、`--timeout-seconds 120` |
| `auth login\|status\|logout` | 设备码；`--server --name --browser --no-wait` |
| `hook install\|status\|context\|acknowledge\|enable\|disable` | AI 标记注入；`--agent`、`--token` |
| `skill` | **读随包发布的 Agent 指南**：`--list`、`--reference`、`--section`、`--symbol` |
| `marker list\|edit\|complete\|remove` | AI 标记读写与确认；`--kind`、`--instance` |
| `audio config\|context\|edit` | Standard 音频 / Pro 声音实例 |
| `assets` | `import`、`replace`、`library-replace`、`info`、`catalog`、`device favorite\|update\|remove\|use` |
| `time remap\|retime\|stretch` | 时间重映射 / 变速段 / 整段拉伸 |
| `camera set` · `import` | 输出相机 · 导入 `.vmg` |
| `bridge davinci …` | 见 3.4 |

### 3.3 全局约定

1. 工程默认当前工作目录，`--project <dir>` 换；**两者不能同时给**。
2. 入参四种：关键参数 / `--json` / `--file` / `--stdin`，CLI 自己注入 version 字段。
3. **输出路径一律相对终端 cwd，即使给了 `--project`**；格式由扩展名定（`.png .mp4 .mov .gif .webp .apng .zip .wav`）；**已存在的输出不覆盖**。

### 3.4 `bridge davinci`

```
install [--package <dir>] [--workspace <dir>]   uninstall   doctor   status
describe / action prepare / inspect / timeline / selection
send / update / insert / edit                   bind / adopt / apply / sync / duplicate
render / task / cancel / recover                restore / relink / migrate
legacy preview|convert|entry|retire              sidebar-guide / runtime-identity
```
任务阶段固定：`queued → preparing → rendering → validating → applying → completed|failed|cancelled|outcome-unknown`；变更类必须带 `idempotencyKey`。

### 3.5 环境变量

| 变量 | 作用 |
| --- | --- |
| `MH_NO_BROWSER=1` | 不自动开 Studio（批处理/服务器） |
| `MH_CACHE_DIR` | 运行时资源缓存（须绝对私有可写） |
| `MH_NO_UPDATE_NOTIFIER=1` | 关更新提示 |
| `MH_SOFTWARE_UPDATE_DIR` | 更新设置与已备发布 |
| `MH_FFMPEG` / `MH_FFPROBE` | 替代 FFmpeg（ProRes 需 7+） |
| `MH_BROWSER_PATH` | 指定 Chrome/Chromium（会校验非伪造） |
| `MH_API_BASE_URL` | 默认 `https://api.motionharness.top`；须 HTTPS 或 localhost HTTP |
| `MH_UI_LOCALE` / `MH_BRIDGE_DIR` / `MH_DAVINCI_OFX_DIR` | 语言 / 桥接目录 / OFX 位置 |
| `MH_NPM_PACKAGE_JSON` · `MH_NODE_EXEC_PATH` | 启动器注入，供自更新定位 |
| `CODEX_HOME` · `CLAUDE_CONFIG_DIR` · `KIMI_CODE_HOME` | hook 安装时定位 Agent 配置 |

### 3.6 内部 HTTP 路由（极高价值）

**【实测】** CLI 与宿主之间是 **localhost HTTP**，不是 stdio：

```
/api/project/{launch,pack,download}   /api/exports/{plan,prepare,start,capabilities}
/api/preview/{prepare,capture,ack}    /api/studio/{sessions,control,attach,audio-layout,preferences,report}
/api/markers  /api/marker-context  /api/agent-sync  /api/capabilities  /api/describe  /api/batch
/api/checkpoints/  /api/assets/  /api/assets/catalog  /api/assets/device/{favorite,update,remove,use,info}
/api/migrate  /api/browser-assets/discover  /api/bridge/davinci/  /api/generate/{candidates,probe,state,execute}
/api/software-update  /api/telemetry  /api/clients/{retain,release}  /auth/device/{code,token,cancel}  /auth/cli/{session,logout}
```
自定义头：`x-mh-operation`、`x-mh-runner`、`x-mh-source`。这说明产品架构是**本地 HTTP 服务 + 浏览器前端（Studio）**，CLI 只是客户端之一。

---

## §4 `@motionharness/sdk` 的导出面

**【实测】** 以下全部来自 `dist/*.d.ts`。**接口签名免费，实现不免费。**

### 4.1 根入口 `.`

| 符号 | 签名要点 |
| --- | --- |
| `field` | 12 个方法：`geometry effects table text color number boolean select transform asset component componentList`（对应 14 种 `ParameterKind`） |
| `defineParameters` | `<S>(parameters: S) => S` 保字面量 |
| `defineComponent` | `({id, parameters, component, audio?, video?, fonts?, computed?, actions?, controls?}) => ComponentDefinition<S>` |
| `defineComposition` | `(composition: Composition<S>) => Composition<S>` |
| `discoverComposition` | `(composition) => CompositionSchema`（**编译成宿主可序列化契约**；注释明确"模块求值后调用，不做 AST 元数据求值"） |
| `Layer` | `({value, binding?, bindings?, offset?, editable?, ...divProps})` 唯一入口，无兼容别名 |
| `Instance` | `({value: InstanceReference}) => ReactNode`，**无自定义 time prop** |
| `useInstance` | `<S>(ref) => InstanceSnapshot<S>` = `{values, time, visible}` |
| `useTime` / `useCompositionSettings` | 内容秒 / `{width,height,fps,duration}` |
| `useAsset` / `useFont` | `=> string`（URL / font-family） |
| `useFrame` | `(effect: (frame: FrameContext)=>void\|Promise, deps?, owner?)` 帧准备屏障 |
| `useNumberSampler` | `(parameter) => (localTime) => number` |
| `useSequenceProgress` | `{mode:'inherit'} \| {mode:'scale'\|'override', value}` |
| `Image` | `{asset, startFrom?, playbackRate?, holdAt?, loop?}` GIF 按原件帧时长求帧 |
| `Video` | 同上；强制静音，原声须显式启用 |
| `Canvas` | 重载：`mode?:'2d'`→`CanvasRenderingContext2D`；`mode:'webgl2'`→`WebGL2RenderingContext` |
| `GpuCanvas` | `{width, height, inputs, graph: GpuGraph, textureOptions?}`，≤32 pass / 64 输入 |
| `Sequence` | `{progress, timing, children}`，直接子元素即项，不加 DOM 包裹 |
| `EffectStack` / `Mask` | 接受 `"100%"` 宽高；`MaskMode='alpha'\|'luminance'\|'clip'` |
| `ControlPanel` / `ControlGroup` | Studio 自绘外观，作者只给标签与 children |
| `Graphic` / `basicGraphicPresets` / `defineTextComponent` / `defineMediaComponent` / `defineContainerComponent` / `defineAudioComponent` | 基础图形与媒体定义 |

### 4.2 `./motion` — 无状态动效，全按 MH 秒求值

```ts
springState(t, opts?): MotionState    // {value, velocity}
spring / inertia / inertiaState / oscillate / noise(t, opts?): number
sampleVelocity(t, source:(t)=>number, opts?): number
dampedFollow(t, source, opts?): number          // y' = damping*(source - y)
springFollowState(t, source, opts?): MotionState
springFollow(t, source, opts?): number
```
`SpringOptions={from?,to?,velocity?,stiffness?,damping?,mass?}`；`MotionSamplingOptions={start?,step?}`，注释写明"`step` 默认 1/60 秒，**与作品 FPS 无关**；每次按当前输入重建整条轨迹，不积累隐藏模拟状态"——这是可 seek 设计的明确承诺。

### 4.3 其余纯函数入口

```ts
// easing
NAMED_EASINGS  // linear ease quad-in quad-out ease-in ease-out ease-in-out smooth
               // sine-in-out power2-in-out power4-out power4-in-out expo-in-out step-start step-end
cubicBezier(x1,y1,x2,y2) · evaluateEasing(easing, progress) · isParameterEasing(v)

// sequence
SequenceTiming = {duration, spacing?:'fixed'|'fit', stagger?, easing?}
sequenceItemProgress(progress, index, count, timing) · validateSequenceTiming(t)

// text / counter / repeat / video-time
segmentText(text, unit?) · revealText(text, progress, unit?)   // character|whitespace-token|newline
textReveal(time, {text, progress, unit?, cursor?}): TextRevealState
counterValue(time, opts) · formatCounter(value, opts?) · repeatTransform(index, opts?)
resolveVideoTime(time, {startFrom?, playbackRate?, holdAt?})

// geometry
GEOMETRY_AXES = [x,y,width,height,anchorX,anchorY,scaleX,scaleY,rotation]
geometryValue · convertGeometryUnit · geometryStyle · changeGeometryAnchor
resizeGeometry(value,{width?,height?,lockAspect?,fixedFraction?},ref) · geometryPointAtFraction

// basic-properties
BASIC_AXES = [x,y,scaleX,scaleY,rotation,skew,anchorX,anchorY,opacity]
basicTransformParameters({defaults?,animations?}) · basicSizeParameters(w,h)
basicTransformValue(values,bindings?) · basicTransformStyle(v) · applyTransformOffset(v,offset?)
basicTransformMatrix(v) · changeBasicAnchor(v,anchor)

// path / path-follow / loop / fonts / color
pointAtFraction · bindPathEndpoints · pathData · trimPath · TrimPath
createPathSampler(d) → {length, sample(progress)} · usePath(d)
followPath(path, progress, {orientToPath?, rotation?, rotationOffset?, offset?})
mapAnimationTime(time, loop?) · isAnimationLoop(v)
defineFont({family, faces:[{asset,weight?,style?}], cssVariable?:`--mh-font-${string}`})
normalizeFontDefinitions · fontDefinitionKey
normalizeColor · colorChannels(v)→[r,g,b,a] · interpolateColor
```

### 4.4 `./effects` — 16 种特效完整参数

| type | 参数 |
| --- | --- |
| `blur` / `backdrop-blur` | `radius` |
| `color-adjust` | `brightness contrast saturation hue grayscale sepia` |
| `shadow` / `inner-shadow` | `x y blur spread color alpha` |
| `glow` | `x y blur spread color alpha` |
| `blend-mode` | `mode`（16 选项）— **唯一没有 `intensity` 的特效** |
| `effect-mask` | `mask size position` |
| `gradient-overlay` | `gradient` |
| `vignette` | `size spread color` |
| `light` | `x y radius color` |
| `grain` | `amount frequency seed` |
| `texture-overlay` | `asset size blendMode` |
| `svg-distortion` | `frequency octaves scale seed` |
| `frame` | `asset width color slice` |

```ts
EffectSpec     = {type, params?, enabled?, intensity?}
EffectInstance = {id, type, enabled, params, tracks?: {…, intensity?: EffectTrack<number>}}
EffectTrack    = {keyframes: [{id, time, value, easing}], loop?}
```

### 4.5 `./host` 与 `./host/render` — 真正的集成面

```ts
interface AuthoringRuntime {
  time; renderer?: 'dom'|'three'; frameToken?; instanceId?; definitionId?
  sampleNumber?(parameter, localTime): number; parameterKinds?
  resources?: {url(ref), fontFamily(ref), isAnimatedImage?, imageFrame?, releaseImage?}
  frames?: FrameScopePort; settings?; pixelRatio?; readInstance?(ref); renderInstance(ref, time, env?)
}
RuntimeProvider · DefinitionBoundary · useAuthoringRuntime
interface FrameScopePort { signal; track(); bindRoot?(); cleanup(); canvas(); gpu(); video(); releaseVideo() }
AUDIO_COMPONENT_ID="mh.audio" · TEXT_COMPONENT_ID="mh.text"

// ./host/render —— 纯类型，无 React/DOM 依赖，Node 渲染器可用
Renderer<TScene> = {capabilities(): RendererCapabilities; createJob(scene, req): RenderJob}
RenderRequest = {format, width, height, fps, start, duration,
  quality:'balanced'|'high'|'master',
  codec?:'h264'|'hevc'|'prores-422'|'prores-422-hq'|'prores-4444'|'prores-4444-xq',
  alpha?:'none'|'straight', motionBlur?:{shutterAngle, samples}}
RenderJob = {read(), subscribe(), start(), performAction(id), cancel(), done: Promise<RenderOutcome>}
```

### 4.6 `./standard` 与 `./three`

```ts
StandardScene = {prepareFrame(time): void|Promise; dispose()}
StandardSceneContext = {root, width, height, pixelRatio, media}
StandardSceneFactory = (ctx) => StandardScene | Promise<StandardScene>
StandardAudioTrack = {referenceId?, src, start?, duration?, offset?, stream?,
                      volume?, pan?, fadeIn?, fadeOut?, loop?, muted?}
StandardMedia = {video(src): Promise<{element, prepareFrame(time)}>}

ThreeCanvas({camera?, orthographic?, shadows?, linear?, flat?, width?, height?, children?})
materialColor(v) → {color, opacity, transparent}   // Three.Color 无 alpha 通道
```

---

## §5 数据模型线索

### 5.1 已暴露的序列化契约 `CompositionSchema`

**【实测】** 即 `discoverComposition()` 的输出，宿主拿到的就是这个：

```ts
{version: 1, id, rootComponentId, cameraComponentId?, fonts?,
 settings: {width, height, fps, duration},
 components: Record<id, {
   parameters: Record<string, ParameterSchema>,
   outputs?: Record<string, {parameter, dependencies?}>,
   actions?: Record<string, {label, description?}>,
   controls?: Record<string, {label, description?, placement:'inspector'|'toolbar'|'overlay'|'standard', parameters[]}>,
   video?: VideoBinding, audio?: AudioBinding}>}
```

`ParameterSchema` 的键就是**参数在磁盘上的样子**：`kind label labelTranslations description default min max step animatable basicProperty visibleWhen columns identity accept options presentation defaultAnimation{keyframes,loop} componentId initialProps timing editableTiming presets initialItems minItems maxItems optional multiline`。

### 5.2 `document.json` 顶层键

**【推断，高置信】** 只出现在文档校验错误串里的键名：`compositionId`、`rootInstanceId`、`layerOrder`、`instances`、`settings`、`cameraComponentId`、`version`；`mh.json` 侧还有 `projectType`(`standard|pro`)、`audio[]`、`version`。印证串：`Invalid document settings`、`Invalid layer order`、`Missing camera instance`、`Document contains unowned instances`、`Instance has multiple owners or a cycle`、`The composition root and camera cannot be reordered`。

**文档版本（实测）**：v1 基础；**v2** 音频实例与时间重映射（`Audio instances require document version 2 or later`）；**v3** `curveSlice`；**v4** Canvas 元素（`Canvas elements require document version 4`）。README 有一条反直觉规则：**删掉这些功能后版本号故意不降**，否则旧读取器会误读仍可能存在的新版数据。

### 5.3 时间模型

**【实测】** `u = groupTime - start + offset`；内容时间 = `timeRemap(u)`（无曲线即 `u`）；可见性按 `(groupTime - start) ∈ [0, duration)`。`start/duration/offset` 都在**所属组的内容秒**里。左裁剪同时增 `start` 与 `offset` 并缩短 `duration`，右裁剪只改 `duration`，窗口外的键**保留不动**。输出相机用独立工程时钟且**不可被重映射**；根组重映射会改变作品总时长。

```ts
TimeRemap = {keyframes: [{id, time, value, easing, curveSlice?}]}
// time = 重映射前的输入秒；value = 内容秒
TimeRemapCurveSlice = {easing, from, to, scale}   // 存相对端点弦的偏差
evaluateTimeRemap(time, remap?)   // 曲线外保持最近端点
```

### 5.4 `src/` 的 React 约定

| 约定 | 内容 |
| --- | --- |
| 工程类型 | `projectType` 二选一，**Standard 与 Pro 不互通** |
| Standard | 默认工厂返回 `{prepareFrame, dispose}`，**不需要 React、不装 SDK**；音频写在 `mh.json` 的 `audio[]`；场景源码手写 |
| Pro | `defineComponent`/`defineComposition`，必须能 resolve 到 `@motionharness/sdk` |
| 依赖 | `work/package.json` + `work/pnpm-lock.yaml`，用 `pnpm install --ignore-workspace --lockfile-only --ignore-scripts` |
| SDK 来源 | npm 版，或 `vendor/mh-sdk.tgz`（`file:./vendor/mh-sdk.tgz`） |
| 动画 | **完全依赖 MH 时间**，禁 `requestAnimationFrame`/`setInterval`/墙钟；异步绘制必须走 `useFrame` 屏障 |
| 所有权 | 持久实例由宿主初始化；**已有值不随源码默认值改变**；`Computed output is read-only; bake it before editing` |
| 保留 ID | `mh.audio`、`mh.text`、`mh.camera` 由宿主注册，创作组件**不得使用** |

### 5.5 AI 标记协议 `TimeMarker`

```ts
TimeMarker = {id, number?, label, notes?, attachments?, screenshot?, color?, kind?,
  origin?, lineageId?, target?, anchor?, requestVersion?, context?, intent?, onResolve?, completion?}
  & ({timeSpace:'project', start, end?}
   | {timeSpace:'source', start, end?, source:{instanceId, asset, stream, duration}}
   | {timeSpace:'object', target})          // 无时间关联的对象备注

MarkerTarget = {kind:'instance', instanceId} | {kind:'component', componentId}
             | {kind:'timing', instanceId, channel:'timing'|'time-remap'}
             | {kind:'parameter', instanceId, parameter, effectId?, name?, rowId?, column?}
ProEditIntent = {kind:'pro-edit', controls?: ('content'|'transform'|'appearance'|'animation')[]}
```
设计要点：`requestVersion` 由**内核持有**，独立于文档 revision，确认时必须原样回传，过期直接拒；`intent.kind='delete-instance'` 带 `restoreVisible`，删掉标记即撤销删除；`screenshot`（宿主截）与 `attachments`（用户加）语义严格分离；`onResolve:'keep'|'delete'`。

---

## §6 `.vmg` 是什么格式

**结论：【推断，高置信】`.vmg` 是 ZIP 归档。**

```
<name>.vmg  (ZIP)
├── manifest.json     归档索引：projectType、文件表、sha256、lockfile 标记
└── work/
    ├── mh.json       工程清单：version、projectType、settings{width,height,fps,duration}、audio[]
    ├── vmg.json      打包元数据
    ├── document.json 编辑内核文档（instances/layerOrder/rootInstanceId/cameraComponentId/settings/version）
    ├── package.json  Pro 依赖
    └── pnpm-lock.yaml
```

**证据链**

1. 二进制里整段只可能来自 ZIP 读写器自身的校验错误：`ZIP64 or multi-volume entry is unsupported`、`ZIP local and central names/extra differ`、`Invalid ZIP data descriptor`、`Stored ZIP sizes disagree`、`ZIP inflated size differs`、`Non-ASCII ZIP names require the UTF-8 flag`、`ZIP links/directories/special files are not allowed`、`Duplicate archive path`、`Truncated ZIP name`。
2. 解包器固定路径与报错：`manifest.json work/mh.json work/vmg.json`、`Project package is missing work/mh.json`、`manifest projectType and mh.json projectType differ`。
3. 打包器自我约束：`Only current work and original assets belong in a project package`、`node_modules is not included`、`manifestSha256`、`createdWithMh`、`lockfile`。

**这不是普通 `zip` 能产出的东西**：单卷非 ZIP64、条目数须被 `manifest.json` 精确覆盖（`ZIP entry count differs` 会报错）、拒符号链接/目录/设备条目、非 ASCII 名必须置 UTF-8 标志、本地头与中央目录的名字与 extra 必须逐项一致、拒数据描述符（否则 sha256 无法独立校验）。**我们能读它，但手搓合法 `.vmg` 需要复刻 manifest 规则，而 manifest 除 `projectType`/`manifestSha256`/`createdWithMh`/`lockfile` 外的字段细节我没有样本可对照。**

**必须交代的缺口【未验证】**：**9 个包里没有任何 `.vmg` 模板或示例**，也没有 `templates/`、`examples/`、`docs/`。README 提到的 `skills/mh-author/SKILL.md`、`skills/mh-author/references/{authoring,editing,materials,audio,rendering,davinci,time-remapping}.md`、`pro/conversion.md`、`pro/assets/narrated-scene.tsx`、`examples/product-intro`、`examples/green-lantern` **全部不在 npm 包里**。它们在 GitHub 仓库（不通）和**二进制内嵌资源**里——证据是 `Cannot locate the installed authoring guide`、`skills/mh-author`、`SKILL.md` 等串，配合 README 说的"二进制内嵌固定运行时资源，首用展开到 `%LOCALAPPDATA%\mh\cache-v2\runtime\<payload-sha256>\`"。我还在字符串里捞到一个 **1,780,804 字节的内嵌资源索引 JSON**（`{"files":[{"path":"LICENSE","size":1040,"mode":384,"sha256":"6fe20dc6…"}, …]}`），说明 payload 里至少还有完整三方依赖清单与 FFmpeg 重建材料。**那份对 Agent 最有价值的 `SKILL.md` 全家桶，在"不运行产品"的前提下拿不到。**

---

## §7 我们能合法拿到什么

三个包的 `LICENSE` 措辞一致：

> **No open-source license is granted for MotionHarness-authored material by this repository or distribution. Use is subject to a separate authorization from the applicable rights holders.**
> …**Rights already granted for previously distributed versions, including under the Apache License, Version 2.0, are unaffected.**

SDK 的 `NOTICE` 自述：本 tarball 只含 **public document, component and extension type contracts**，**不含** CLI/编辑器/引擎实现。

| 行为 | 判断 | 依据 |
| --- | --- | --- |
| `npm view` 读元数据 | ✅ 安全 | 事实性元数据 |
| 全文读 3 份 README（10.9/43.5/23.3 KB） | ✅ 安全，本次最大收获 | 文档是给你读的；行为描述不受版权保护 |
| 读 `.d.ts`、记下函数签名与字段名 | ✅ 基本安全 | 接口/事实不受版权保护。**但不要整段抄注释**——注释是有独创性的表达 |
| 依据签名自己写同构数据模型 | ✅ 安全（clean-room） | 独立实现，不复用代码 |
| 读二进制字符串还原命令名 | ⚠️ 灰区低风险 | 只读、未规避技术措施、目的为互操作 |
| 把 `.d.ts` 或 `dist/*.js` 复制进仓库 | ❌ 侵权 | LICENSE 明确 no open-source license is granted |
| 把 `EFFECT_DEFINITIONS` 那张表原样搬走 | ❌ 高风险 | 那是它写的字面量，不是纯事实 |
| 反编译 163 MB 的 exe | ❌ 不做 | 任务禁止，且无授权 |
| 装 `mh` 并用它产出作品 | ⚠️ 需授权 | "Use is subject to a separate authorization"；且会采集匿名遥测（命令与结果、Studio 点击、版本、系统信息、可识别的编码 Agent；明确**不**上传源码/工程/素材/路径/参数/输入文本） |
| 直连 §3.6 的本地 HTTP 路由 | ⚠️ 不建议 | 未公开协议，绕过其客户端边界 |
| 复用 `@base_bit/vmg-cli` 的代码 | ✅ 可以但无用 | 唯一有明确开源授权的包（`Apache-2.0`），内容只是迁移壳，零业务逻辑 |

**一句话原则**：读它公开的文档和类型 = 学习接口，合法；把它的任何代码或常量表搬进我们仓库 = 侵权；要在产品里用它 = 必须先拿书面授权。本次严格落在第一行——读的是 README、`.d.ts` 和只读字符串，没有一行它的代码进入工作区。

---

## §8 对我们的可执行结论

**"能不能通过 SDK 集成"——不能，但不是许可证问题，是架构问题。** SDK README 自己说："SDK 不包含 Builder、Studio、数据引擎或导出 Renderer。"它导出的一切（`useTime()`、`Layer`、`Instance`、`useFrame()`、`resources.url()`）都要求存在一个 `RuntimeProvider`，而 Runtime 是闭源宿主提供的。我们只能写"能在 MotionHarness 里跑的组件"，**不能拿它当渲染引擎**；`Renderer<TScene>` 看着像集成点，同样需要宿主实现的 `SceneSession`、帧屏障与 GPU 设备。**SDK 是插件通道，不是集成通道。**

**真正可用的集成面只有一个，而且是黑盒**：`mh` CLI 子进程 + `--json` 进出 + `--output-format json`。技术上可行，`capabilities`/`describe` 两个命令就是为机器可读设计的（"Discover supported operations without starting a session"）。但要装 163 MB 二进制、可能要设备码授权（`api.motionharness.top`）、采集遥测，且 LICENSE 下**使用本身需授权**——这是要跟对方谈的路。

**可以自己建的**（方法论层面 clean-room 复刻，非其代码）：组件定义→可序列化契约的分离（`CompositionSchema`）；14 种参数 kind + 扁平 `ParameterSchema` 一套 schema 同时喂校验器/UI/CLI/序列化；`ComponentCommand` 语义化命令枚举天然支持 undo/redo、批处理、Agent 调用；**无状态动效**（`spring(t,opts)` 而非累积模拟）让"任意 seek 同一结果"成为类型级承诺；三段时间模型 `u = groupTime - start + offset` 比绝对时间轴清晰；`useFrame` 帧准备屏障保证预览与导出一致；`TimeMarker`+`requestVersion` 让过期确认必然失败，避免 Agent 拿旧理解改新数据；`.vmg` 的 manifest+严格 ZIP 比 tar.gz 更适合做可验证交付格式。

**下一步（按价值）**：① `skills/mh-author/` 全家桶（比 README 详细一个量级）——需 GitHub 或 `mh skill --reference pro`，**当前 GitHub 不通，卡住**；② 一个真实 `.vmg` 样本，可把 §5 的【推断】升级为【实测】；③ `mh capabilities --output-format json` 输出，可一次性替掉我靠字符串拼出的命令面；④ `examples/` 里的真实示例工程。

前三项都要么需要 GitHub、要么需要授权安装。**这就是本次最诚实的结论：在"不装、不跑、不碰 GitHub"的约束下，公开面已榨到极限，剩下的每个字节都在那两道门后面。**

---

*全部解包产物在 `C:\Users\18149\AppData\Local\Temp\mh-pkgs\`，未安装、未 import、未执行 `mh`；工作区仅新增本文件。*
