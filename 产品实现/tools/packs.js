/**
 * The declared support catalog for the first product version.
 *
 * Everything in this file is a DECLARATION taken from the accepted evidence in the handoff package,
 * never a verification. Version strings, license classes and evidence references trace back to CT-00 §1,
 * CT-10 §2 and the C01/C02 records; C06 does not re-invent them and does not upgrade them to "verified".
 *
 * **Scope decision (user, 2026-11-08): manual guidance only.** The plugin does not download, unpack,
 * install or update external tools. Every tool below therefore declares `source.kind: manual-only`
 * with user-facing guidance, and no artifact hash or URL appears anywhere — the plugin never fetches
 * tool bytes, so it has no integrity to assert.
 *
 * Every tool's status is derived from evidence, and at the time of writing **two of the three official
 * tools are `not-installed`** while FFmpeg is adopted and verified from the user's own WinGet install
 * (see `实施交接/证据/C06-FFmpeg真实探针.md`). Nothing here claims a tool works; that claim lives only in
 * a verification record produced by running the real thing.
 *
 * @module tools/packs
 */

import { buildCatalog } from './catalog.js'

/**
 * FFmpeg / FFprobe: basic media operations (probe, cut, concat, transcode, simple transitions).
 *
 * Version and license facts come from CT-00 §1 and CT-10 §2: `9.0.1-full_build-www.gyan.dev`, a GPL
 * build of the tool. It is an external tool, so its own license regime applies and the plugin does not
 * redistribute it.
 *
 * The `bin/` relative paths describe the layout of a standard Windows FFmpeg distribution, so a user
 * who unpacked one into the tools root can be detected and verified there. The WinGet install used on
 * this machine lives outside that root; it is adopted explicitly by the user's answer via
 * `adopt()` with an explicit location, which is why detection also accepts extra candidate roots.
 */
const FFMPEG_PACK = {
  packId: 'media-basics',
  version: '1.0.0',
  displayName: '基础媒体能力',
  description: '读取真实媒体时长、精确剪切与拼接、编码与封装；是第一版所有真实音画的基础。',
  pluginCode: {
    license: 'MIT',
    components: [
      'FFprobe 输出解析与真实时长换算（自写）',
      '精确剪切与拼接的参数编排（自写）',
      '错误解释与失败分类（自写）',
    ],
    evidenceRef: '实施交接/技术契约/CT-06-RenderAdapter与媒体.md §FFmpeg 接入边界',
  },
  tools: [
    {
      toolId: 'ffmpeg',
      displayName: 'FFmpeg / FFprobe',
      supportClass: 'external',
      catalogClass: 'official',
      channel: 'cli',
      origin: 'manual',
      supportedVersions: '>=9.0.0 <10.0.0',
      permissions: ['filesystem', 'process', 'media'],
      detection: {
        mode: 'files-only',
        executables: ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'bin/ffmpeg', 'bin/ffprobe'],
        manifestFiles: ['LICENSE', 'README.txt'],
        versionProbe: { command: 'ffmpeg', args: ['-version'] },
      },
      verificationChecks: [
        {
          id: 'ffmpeg-binary',
          kind: 'file-exists',
          relativePath: 'bin/ffmpeg.exe',
          description: 'ffmpeg 可执行文件存在（相对安装根目录）',
        },
        {
          id: 'ffprobe-binary',
          kind: 'file-exists',
          relativePath: 'bin/ffprobe.exe',
          description: 'ffprobe 可执行文件存在（相对安装根目录）',
        },
        {
          id: 'ffmpeg-license-present',
          kind: 'file-exists',
          relativePath: 'LICENSE',
          description: '该构建自带许可文件存在（外部工具保留原许可）',
        },
        {
          id: 'ffmpeg-version',
          kind: 'version-match',
          expectedBuild: '9.0.1-full_build-www.gyan.dev',
          command: 'ffmpeg',
          args: ['-version'],
          description: '真实版本与本机 C02 实测构建一致（需要授权的执行器运行一次 ffmpeg -version）',
        },
        {
          id: 'ffprobe-version',
          kind: 'version-match',
          expectedBuild: '9.0.1-full_build-www.gyan.dev',
          command: 'ffprobe',
          args: ['-version'],
          description: 'ffprobe 真实版本一致（需要授权的执行器运行一次 ffprobe -version）',
        },
      ],
      license: {
        spdx: 'GPL-3.0-or-later',
        class: 'external',
        copyright: 'FFmpeg project contributors',
        conditions: [
          '本体为 GPL 构建，不随插件包再分发，也不标为 MIT',
          '用户自行安装并遵守其 GPL 条件',
          '输入输出内容的使用条件由用户与其素材来源决定',
        ],
        evidenceRef: '实施交接/技术契约/CT-10-权利依赖与发布.md §2 外部工具当前记录',
      },
      effects: {
        effects: [],
        network: false,
        dataSubmission: false,
        registration: false,
        dataDestination: null,
        fee: null,
        environmentImpact: '只读取本机该工具的文件并运行其版本命令；不修改系统环境变量',
        notes: '构建配置含 --enable-gpl --enable-version3；发布用户作品前需自行确认 GPL 义务是否适用',
      },
      source: {
        kind: 'manual-only',
        publisher: 'gyan.dev',
        obtainFrom: 'https://www.gyan.dev/ffmpeg/builds/ （本机既有安装来自 WinGet）',
      },
      manualGuidance: {
        steps: [
          '在你自己的位置安装 FFmpeg 9.0.x（本机 C02 记录的是 gyan.dev 的 full_build）',
          '确认 ffmpeg 与 ffprobe 在同一个 bin 目录下',
          '回到「工具」页点检测；如果安装在工具目录之外，请在检测时给出真实目录',
          '检测只读取文件与版本，不会运行任何命令；核对真实版本需要你单独授权一次',
        ],
        verifyHint: '检测会读取 bin/ffmpeg.exe 与 bin/ffprobe.exe；核对真实版本需要单独授权运行一次 ffmpeg -version',
      },
      rollback: {
        strategy: 'previous-build',
        retainedVersions: 1,
        instructions: '手动安装的工具由你自己决定卸载或替换；插件只切换记录，不删除你安装的程序',
      },
      evidenceRefs: [
        '实施交接/技术契约/CT-00-契约总入口目录与写入映射.md §1',
        '实施交接/证据/C02-渲染同单元对照.md',
        '实施交接/证据/C06-FFmpeg真实探针.md',
      ],
      notes: '基础能力不代表复杂作品可以降级兜底；复杂效果必须走已验证的能力包。',
    },
  ],
  capabilities: [
    {
      capabilityId: 'media-probe',
      displayName: '读取真实媒体时长与规格',
      userOutcome: '看到素材的真实时长、帧率、分辨率与音轨信息，而不是按字数估算',
      inputs: ['已有视频或音频文件'],
      outputs: ['真实时长与媒体规格', '供时间表使用的探测结果'],
      requires: [{ toolId: 'ffmpeg' }],
      surface: '作品面·时间结构',
    },
    {
      capabilityId: 'media-cut',
      displayName: '精确剪切与拼接',
      userOutcome: '按真实帧位置裁切与拼接已有素材，不漂移到关键帧',
      inputs: ['已有视频或音频文件', '入出点'],
      outputs: ['裁剪后的媒体文件'],
      requires: [{ toolId: 'ffmpeg' }],
      surface: '作品面·时间结构',
    },
  ],
}

/**
 * Remotion: the default render runtime candidate.
 *
 * CT-00 §1 records `4.0.541`; CT-10 §2 records its custom Remotion License, which is NOT MIT and
 * carries company-use conditions the tool documentation must state. It is external: the plugin ships
 * adapters and templates, never the runtime itself.
 */
const REMOTION_PACK = {
  packId: 'render-remotion',
  version: '1.0.0',
  displayName: '程序画面渲染（Remotion）',
  description: '用代码／React 场景产生确定性画面并渲染成片。',
  pluginCode: {
    license: 'MIT',
    components: ['RenderAdapter 场景映射（自写）', '参数转换与结果回收（自写）', '错误解释（自写）'],
    evidenceRef: '实施交接/技术契约/CT-06-RenderAdapter与媒体.md §双运行时',
  },
  tools: [
    {
      toolId: 'remotion',
      displayName: 'Remotion',
      supportClass: 'external',
      catalogClass: 'official',
      channel: 'cli',
      origin: 'manual',
      supportedVersions: '=4.0.541',
      permissions: ['filesystem', 'process', 'media', 'environment'],
      detection: {
        mode: 'files-only',
        manifestFiles: ['package.json'],
        versionProbe: { command: 'npx', args: ['remotion', '--version'] },
      },
      verificationChecks: [
        {
          id: 'remotion-manifest',
          kind: 'file-exists',
          relativePath: 'package.json',
          description: 'Remotion 包清单存在',
        },
        {
          id: 'remotion-declared',
          kind: 'file-contains',
          relativePath: 'package.json',
          contains: 'remotion',
          description: '包清单确实是 Remotion 包，而不是同名目录',
        },
        {
          id: 'remotion-version',
          kind: 'version-match',
          expectedBuild: '4.0.541',
          command: 'npx',
          args: ['remotion', '--version'],
          description: '真实版本与本机 C02 实测版本一致（需要授权运行外部进程）',
        },
      ],
      license: {
        spdx: 'Remotion-License',
        class: 'external',
        copyright: 'Remotion AG',
        conditions: [
          '自定义 Remotion License，不是 MIT，不能写成严格 MIT',
          '公司使用条件须在工具文档中告知用户',
          '本体不随插件包分发；插件只交付适配与模板（MIT）',
        ],
        evidenceRef: '实施交接/技术契约/CT-10-权利依赖与发布.md §2',
      },
      effects: {
        effects: [],
        network: false,
        dataSubmission: false,
        registration: false,
        dataDestination: null,
        fee: null,
        environmentImpact: '运行时会启动 Node 进程与浏览器；不修改系统环境变量',
      },
      source: {
        kind: 'manual-only',
        publisher: 'npm',
        obtainFrom: '在你自己的工程里安装 remotion@4.0.541',
      },
      manualGuidance: {
        steps: [
          '在一个独立工程目录里安装与你项目一致的 Remotion 版本（当前实测 4.0.541）',
          '确认版本没有被 npm 自动升级到其他小版本',
          '回到「工具」页点检测并给出该工程的目录，插件只读取 package.json，不安装也不运行',
        ],
        verifyHint: '检测读取 package.json 的 version 字段；核对真实版本需要单独授权运行 remotion --version',
      },
      rollback: {
        strategy: 'manual-guidance',
        retainedVersions: 0,
        instructions: '版本由你的工程 lock 文件控制；插件不修改你的依赖',
      },
      evidenceRefs: ['实施交接/技术契约/CT-00-契约总入口目录与写入映射.md §1'],
    },
  ],
  capabilities: [
    {
      capabilityId: 'render-program-visual',
      displayName: '程序画面渲染',
      userOutcome: '把程序画面、图形、字幕与转场渲染成可播放成片',
      inputs: ['CompositionPlan', '项目素材'],
      outputs: ['真实可播放媒体文件'],
      requires: [{ toolId: 'remotion' }],
      surface: '作品面·时间结构',
    },
  ],
}

/**
 * HyperFrames: the quality-check / strong alternative runtime.
 *
 * CT-00 §1 records `0.9.19`; CT-10 §2 records Apache-2.0, which is NOT MIT. Version is locked and an
 * upgrade requires re-verification (a C02 product decision).
 */
const HYPERFRAMES_PACK = {
  packId: 'render-hyperframes',
  version: '1.0.0',
  displayName: '质检渲染（HyperFrames）',
  description: '按帧渲染并导出 MP4，用于质检与对照。',
  pluginCode: {
    license: 'MIT',
    components: ['质检调用编排（自写）', '输出检查（自写）'],
    evidenceRef: '实施交接/技术契约/CT-06-RenderAdapter与媒体.md §双运行时',
  },
  tools: [
    {
      toolId: 'hyperframes',
      displayName: 'HyperFrames',
      supportClass: 'external',
      catalogClass: 'official',
      channel: 'cli',
      origin: 'manual',
      supportedVersions: '=0.9.19',
      permissions: ['filesystem', 'process', 'media'],
      detection: {
        mode: 'files-only',
        manifestFiles: ['package.json'],
        versionProbe: { command: 'hyperframes', args: ['--version'] },
      },
      verificationChecks: [
        {
          id: 'hyperframes-manifest',
          kind: 'file-exists',
          relativePath: 'package.json',
          description: 'HyperFrames 包清单存在',
        },
        {
          id: 'hyperframes-declared',
          kind: 'file-contains',
          relativePath: 'package.json',
          contains: 'hyperframes',
          description: '包清单确实是 HyperFrames，而不是同名目录',
        },
        {
          id: 'hyperframes-version',
          kind: 'version-match',
          expectedBuild: '0.9.19',
          command: 'hyperframes',
          args: ['--version'],
          description: '真实版本与 C02 实测版本一致（需要授权运行外部进程）',
        },
      ],
      license: {
        spdx: 'Apache-2.0',
        class: 'external',
        copyright: 'HyperFrames contributors',
        conditions: [
          'Apache-2.0 不是 MIT，不能写成严格 MIT',
          '本体不随插件包分发',
          '版本锁定，升级后必须重新验证',
        ],
        evidenceRef: '实施交接/技术契约/CT-10-权利依赖与发布.md §2',
      },
      effects: {
        effects: [],
        network: false,
        dataSubmission: false,
        registration: false,
        dataDestination: null,
        fee: null,
        environmentImpact: '运行时会启动外部进程；不修改系统环境变量',
      },
      source: {
        kind: 'manual-only',
        publisher: 'npm',
        obtainFrom: '在你自己的工程里安装 hyperframes@0.9.19',
      },
      manualGuidance: {
        steps: [
          '在你自己的工程目录安装 HyperFrames 0.9.19（当前实测版本）',
          '不要自动升级到其他版本：升级后需要重新验证',
          '回到「工具」页点检测并给出该工程目录，插件只读取文件，不安装也不运行',
        ],
        verifyHint: '检测读取 package.json；核对真实版本需要单独授权运行 hyperframes --version',
      },
      rollback: {
        strategy: 'manual-guidance',
        retainedVersions: 0,
        instructions: '由你的工程依赖控制版本；插件不修改你的依赖',
      },
      evidenceRefs: ['实施交接/证据/C02-渲染同单元对照.md'],
    },
  ],
  capabilities: [
    {
      capabilityId: 'render-quality-check',
      displayName: '成片质检渲染',
      userOutcome: '按帧渲染出用于质检的成片，与主渲染做真实对照',
      inputs: ['CompositionPlan', '项目素材'],
      outputs: ['质检用媒体文件'],
      requires: [{ toolId: 'hyperframes' }],
      surface: '作品面·对照',
    },
  ],
}

/**
 * Research candidates: recorded with evidence, permanently unusable for production.
 *
 * `editly` appears in the mapping document as a lightweight declarative alternative whose README
 * declares MIT but which was never run. It is listed here so the record exists, and the catalog rules
 * forbid it from ever reading as available.
 */
const RESEARCH_PACK = {
  packId: 'research-candidates',
  version: '1.0.0',
  displayName: '调研候选（不可用于制作）',
  description: '记录已阅读但未采用、未验证的候选，供后续决定使用；不进入可用清单。',
  catalogClass: 'research-candidate',
  pluginCode: {
    license: 'MIT',
    components: ['调研记录与候选卡片（自写）'],
    evidenceRef: '实施交接/技术契约/CT-10-权利依赖与发布.md §3',
  },
  tools: [
    {
      toolId: 'editly',
      displayName: 'Editly（调研候选）',
      supportClass: 'external',
      catalogClass: 'research-candidate',
      channel: 'cli',
      origin: 'manual',
      supportedVersions: '>=0.0.0',
      permissions: ['filesystem', 'process', 'media'],
      detection: {
        mode: 'files-only',
        manifestFiles: ['package.json'],
      },
      verificationChecks: [
        {
          id: 'editly-manifest',
          kind: 'file-exists',
          relativePath: 'package.json',
          description: '仅作存在性记录',
        },
      ],
      license: {
        spdx: 'MIT',
        class: 'external',
        copyright: 'Editly contributors',
        conditions: ['README 声明 MIT，但未核实际文件与传递依赖', '未运行，因此不能标为可用'],
        evidenceRef: '创作方法-工具-资产映射.md §2.3.9【轻量声明式备选】',
      },
      effects: {
        effects: [],
        network: false,
        dataSubmission: false,
        registration: false,
        dataDestination: null,
        fee: null,
        environmentImpact: null,
      },
      source: { kind: 'manual-only', publisher: 'npm' },
      manualGuidance: { steps: [], verifyHint: null },
      rollback: { strategy: 'none', retainedVersions: 0, instructions: '调研候选不提供安装或回退' },
      notes: '仅调研记录：未采用、未验证、未运行。',
    },
  ],
  capabilities: [
    {
      capabilityId: 'research-lightweight-render',
      displayName: '轻量声明式渲染（调研中）',
      userOutcome: '尚未提供：该能力只是调研候选',
      requires: [{ toolId: 'editly' }],
      surface: null,
      notes: '调研候选不能进入制作',
    },
  ],
}

/** The four capability packs this version ships. */
export const PACKS = Object.freeze([FFMPEG_PACK, REMOTION_PACK, HYPERFRAMES_PACK, RESEARCH_PACK])

/**
 * Build the catalog. Throws on any structural inconsistency, so a malformed declaration fails at
 * import time rather than producing a tool that can never be verified.
 * @returns {Readonly<object>}
 */
export function createDefaultCatalog() {
  return buildCatalog({
    packs: PACKS,
    catalogVersion: '2.0.0',
    note:
      '声明来自 CT-00／CT-10 与 C01／C02 证据；只提供手动指引，插件不下载、不安装、不更新；' +
      '未验证前不标可用。',
  })
}
