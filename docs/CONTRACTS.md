# AI Video Studio v0.1 — 公共契约（冻结草案）

> 状态：v0.1 实施期冻结；内部函数、组件拆分、局部数据结构不在此列。
> 依据：`AI-Video-Studio-v0.1-完整实施计划.md` §5–§6；PoC-002 契约（命令/幂等/基线/原子提交）与 PoC-003（版本/快照/决定）已验证语义的正式化。

## 0. 版本

| 项 | 值 |
|---|---|
| 插件包 | `ai-video-studio@0.1.11` |
| 状态 schema | `schema_version: 1`（JSON，每项目一份权威状态） |
| 已验证 DSH | 0.2.1-rc.3 / win32 x64 |
| 适配器 | `html-scene@1`（headless Chrome seek + FFmpeg，PoC-003 同源实现，非 HyperFrames 官方渲染器） |

## 1. 存储布局

```text
<dataRoot>/
  index.json                     # 项目索引（定位/可重建），不是状态真相
  projects/<project_id>/
    state.json                   # 唯一权威状态（原子写）
    state.rev-<n>.json           # 已发布修订快照（只读）
    .lock                        # 单写者锁
    objects/<sha256>.<ext>       # 内容寻址：媒体、源文件、快照清单
    jobs/<job_id>/               # 任务目录（worker 只写这里）
    logs/
```

- 首次创建与“已存在项目状态缺失”必须区分：后者返回 `PROJECT_STATE_MISSING`，不得初始化为空项目。
- 损坏状态返回 `PROJECT_STATE_CORRUPT`，不静默重置。

## 2. 主体与通道

| 通道 | principal | 生成方式 |
|---|---|---|
| `ui`（生产） | `user` | 仅由宿主可信的浏览器用户动作（Workbench 内 POST）产生；`ctx.connection.admit(req)` 且 `peer === browserPeer` |
| `test`（测试） | `synthetic_test` | 仅在 dev 配置 `allowTestChannel: true` 时注册 `/studio/test/*`；**永不产生 user** |
| `agent` | `agent` | 插件工具调用与 `/studio/projects/:id/agent/*` 诊断入口 |

- 客户端自报身份一律忽略；principal 由宿主按通道赋值。
- 负例必须被拒：测试通道产生 user、agent 借测试通道产生 user、agent 产生用户认可。

## 3. 命令

```ts
type Command = { project_id, command_id, base_revision, kind, target?, payload }
```

顺序固定：**身份与操作权限 → 项目作用域幂等 → 基线/内容校验 → 唯一提交点发布**。

- 指纹 = sha256(canonicalJson({project_id, kind, target, payload, base_revision}))，不含通道/时间。
- 同键同请求（含过期 base）→ 返回首次结果，`idempotent_replay: true`。
- 同键异请求 → `409 IDEMPOTENCY_CONFLICT`。
- 新命令 base 不等于当前 revision → `409 STALE_BASE_REVISION`。
- 权限失败不得借既有 key 回放成功。
- 一次提交只写一次 `state.json`（临时文件 + rename），版本/决定/任务/事件/幂等结果同批可见。

kind：`artifact_create` `version_register` `adopt_work_basis` `integrate_artifact` `decision` `intent_record` `job_create` `job_cancel` `job_reconcile` `session_bind`。

## 4. 版本与整合

```ts
Version = {
  version_id, artifact_id, based_on, label,
  output: { media_rel, sha256, bytes, duration_seconds, width, height, fps, has_audio, probe_verified },
  source_snapshot: { manifest_sha256, entry, files: [{rel, sha256, bytes}], external_deps: [{kind, name, required, note}], closure_verified },
  recipe: { adapter, adapter_version, params },
  job_id, changes: string[], checks: [{kind, by, at, note}],
  created_at, created_by_command_id
}
```

- `version_register` 只登记**不可变候选**，不改变工作依据。
- `adopt_work_basis` 只把已有版本设为当前工作依据，不产生新媒体。
- `integrate_artifact` 用**确切子版本**生成新的整合版本：manifest 固定 `{version_id, role, order, in_seconds, out_seconds}`；旧整合版本不随子版本更新而变化；重新整合必须产生新版本。
- 媒体时长/尺寸/帧率以 ffprobe 探测为准；探测不可用时 `probe_verified: false` 且不得声称已验证。
- 源快照必须内含**依赖闭包**（入口 + 相对文件映射 + 每个对象哈希）；无法证明时 `closure_verified: false`。

## 5. 决定（ReviewDecision）

```ts
Decision = {
  decision_id, kind, artifact_id, version_id,
  scope: FullVersion | TimeRange | Region | Aspect,
  principal: 'user' | 'synthetic_test' | 'agent',
  channel: 'ui' | 'test' | 'agent',
  origin: { kind: 'ui_action' | 'test_action' | 'tool_call' | 'host_event', ref?: string, at: string },
  valid: boolean, supersedes?: string[], note?: string,
  created_at, project_revision
}
```

| kind | 允许主体 |
|---|---|
| `partial_approval` `change_request` `reject` `withdraw` | `user`；`synthetic_test`（仅测试） |
| `ai_check` | `agent` |
| `final` | **未支持** → `DECISION_UNSUPPORTED` |

- 主体×类型矩阵之外一律拒绝（`DECISION_NOT_PERMITTED_FOR_PRINCIPAL` / `DECISION_NOT_PERMITTED_FOR_AGENT`）。
- scope：
  - `full_version`
  - `time_range`：半开区间 `[start_seconds, end_seconds)`，`0 ≤ start < end ≤ duration`（end 可等于时长）；越界 `SCOPE_OUT_OF_BOUNDS`；旧记录中的 `end_inclusive` 原样保留、不做猜测转换。
  - `region`：`{frame_seconds, x, y, width, height, basis:'display'}`，必须在该版本实际尺寸内；不支持的空间 → `SCOPE_COORDINATE_SPACE_UNSUPPORTED`。
  - `aspect`：`{aspect: 'typography'|'motion'|'sound'|'material'|'layout', description}`。
- 表单依据**正在审阅版本的实际媒体元数据**初始化；版本变更必须重新绑定（服务端校验 version_id 与 scope）。
- 媒体未加载/失败时可保存 `change_request`，但不得产生 `partial_approval`（服务端要求 `media_ready: true`）。
- 重复点击：同一 `command_id` 复用；不同 id 但同版本+同 scope 的重复认可记 `duplicate_of`，投影只取最新有效记录。
- `withdraw` 之后旧认可 `valid: false`，历史保留；新版不继承“已认可”。

## 6. 任务（Job）

```ts
Job = { job_id, kind: 'render', adapter, request_fingerprint, base_revision, version_id?, source: {dir, entry},
        budget: {attempts: 1, max_seconds}, attempt, status: 'queued'|'preparing'|'running'|'succeeded'|'failed'|'cancelled'|'unknown',
        output?: {...}, error?: {code, message}, pid?, started_at?, ended_at?, reconcile_note? }
```

- worker 只写 `jobs/<job_id>/`；成功后登记候选（`version_register`），**不产生用户认可**。
- 崩溃/重启后 `job_reconcile`：完整输出登记一次；输出不完整且未确认 → `unknown`，不自动重跑。
- 取消只终止有归属证据的进程树，返回是否已停、是否存在未知结果。
- 任务进度不推进 `project_revision`；状态由 ProjectStore 串行写入（每次状态变更仍是一次原子写）。

## 7. 路由

| 方法 | 路径 | 通道 |
|---|---|---|
| GET | `/studio/health` | 任意（只读） |
| GET | `/studio/projects` | 任意（只读索引） |
| POST | `/studio/projects` | ui / agent |
| GET | `/studio/projects/:id/state` | 任意（只读） |
| GET | `/studio/projects/:id/media/:versionId` | 任意；`HEAD`/`Range` 必须正确，非法 Range → 416 |
| GET | `/studio/projects/:id/source/:versionId?file=<rel>` | 任意；HTML 按文本返回 |
| POST | `/studio/projects/:id/ui/decision` | **仅 UI（browser peer）** |
| POST | `/studio/projects/:id/ui/intent` | **仅 UI** |
| POST | `/studio/projects/:id/ui/render` | **仅 UI** |
| POST | `/studio/projects/:id/agent/command` | agent（诊断） |
| POST | `/studio/test/decision` | 仅 dev（`allowTestChannel`） |

错误统一：`{ error: { code, message, details? } }`，HTTP 400/403/404/409/416/500。

## 8. 工具（模型）

| 工具 | 说明 |
|---|---|
| `studio_project_state` | 总览：当前工作依据、最近版本、待决事项、任务、能力与缺失项（分页/按需） |
| `studio_project_create` | 创建项目（标题、工作区路径），返回 project_id 与根目录 |
| `studio_version_register` | 从本地媒体 + 源目录登记不可变候选（内容寻址 + 依赖闭包 + ffprobe 探测） |
| `studio_adopt_work_basis` | 把已有版本设为当前工作依据 |
| `studio_integrate_artifact` | 用确切子版本生成整合版本 |
| `studio_decision_submit` | agent 只能提交 `ai_check` |
| `studio_render_job` | 提交本地渲染任务并等待/查询 |
| `studio_job_status` | 查询任务与对账结果 |

工具参数中的 `project_id` 必填；`base_revision` 必填（并发保护）。工具由宿主注入 principal=agent。

## 9. 能力与降级

- 能力检测：`node`、`ffmpeg`、`ffprobe`、Chrome/Edge 可执行路径。
- 缺渲染工具：项目创建、浏览、审阅记录、保存恢复仍可用；渲染/转码返回 `CAPABILITY_MISSING` 并列出缺项。
- 缺字体/素材：源快照 `external_deps` 记录；恢复时报告 `unverified`，不静默替换。
- 不硬编码开发机路径：路径来自配置（dataRoot）与项目状态。
