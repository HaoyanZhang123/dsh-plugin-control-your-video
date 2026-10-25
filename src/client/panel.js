/*
 * AI Video Studio v0.1 — 浏览器端 Workbench（单文件客户端插件）
 *
 * 只读 GET /studio/projects/:id/state（5 秒轮询），写操作只走契约路由：
 *   POST /studio/projects/:id/ui/decision
 *   POST /studio/projects/:id/ui/intent
 * 前端不发送 principal，也不直接修改项目状态；主体由宿主按浏览器通道赋值。
 *
 * 契约依据：docs/CONTRACTS.md §4（版本）、§5（决定）、§7（路由）、§9（能力降级）。
 * 面板结构：sidebar.panellist（id "studio"）→ main keyed slot（key "studio"）。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-control-your-video",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
		const React = require("react")
		const h = React.createElement
		const PANEL_ID = "studio"
		const POLL_MS = 5000
		const STORAGE_KEY = "studio.project_id"
		const ASPECTS = ["typography", "motion", "sound", "material", "layout"]
		let ctxRef = null

		const CSS =
			".swb-root{display:flex;flex-direction:column;height:100%;box-sizing:border-box;background:var(--swb-bg);color:var(--swb-fg);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;overflow:hidden;--swb-bg:#ffffff;--swb-fg:#1f2328;--swb-muted:#57606a;--swb-border:#d0d7de;--swb-card:#ffffff;--swb-subtle:#f6f8fa;--swb-accent:#0969da;--swb-danger:#cf222e;--swb-ok:#1a7f37;--swb-warn:#9a6700;--swb-warnbg:#fff8c5}" +
			"body[data-ds-dark-theme] .swb-root,html[data-ds-dark-theme] .swb-root{--swb-bg:#0d1117;--swb-fg:#e6edf3;--swb-muted:#8b949e;--swb-border:#30363d;--swb-card:#161b22;--swb-subtle:#21262d;--swb-accent:#4493f8;--swb-danger:#f85149;--swb-ok:#3fb950;--swb-warn:#d29922;--swb-warnbg:#3b2e00}" +
			".swb-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--swb-border);background:var(--swb-subtle)}" +
			".swb-topmain{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0;flex:1 1 380px}" +
			".swb-topright{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
			".swb-title{font-weight:700;font-size:14px;letter-spacing:.02em}" +
			".swb-subtitle{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38ch}" +
			".swb-badge{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--swb-card);border:1px solid var(--swb-border);color:var(--swb-muted);font-size:11px;white-space:nowrap}" +
			".swb-badge[data-tone='warn']{border-color:var(--swb-warn);color:var(--swb-warn);background:var(--swb-warnbg)}" +
			".swb-tabs{display:flex;gap:2px;padding:6px 16px 0;border-bottom:1px solid var(--swb-border);background:var(--swb-bg);flex-wrap:wrap}" +
			".swb-tab{appearance:none;border:1px solid transparent;border-bottom:none;background:transparent;color:var(--swb-muted);padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;border-radius:6px 6px 0 0}" +
			".swb-tab:hover{background:var(--swb-subtle);color:var(--swb-fg)}" +
			".swb-tab[aria-selected='true']{background:var(--swb-card);border-color:var(--swb-border);color:var(--swb-fg);font-weight:600}" +
			".swb-body{flex:1 1 auto;overflow:auto;padding:14px 16px 28px;background:var(--swb-bg)}" +
			".swb-stack{display:flex;flex-direction:column;gap:12px;max-width:1180px}" +
			".swb-card{border:1px solid var(--swb-border);border-radius:8px;background:var(--swb-card);padding:12px 14px}" +
			".swb-h3{margin:0 0 8px;font-size:13px;font-weight:600}" +
			".swb-sub{margin:8px 0 2px;font-size:12px;font-weight:600;color:var(--swb-muted)}" +
			".swb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}" +
			".swb-field{display:inline-flex;gap:4px;align-items:center}" +
			".swb-label{color:var(--swb-muted);font-size:12px;white-space:nowrap}" +
			".swb-input,.swb-select,.swb-textarea{border:1px solid var(--swb-border);border-radius:6px;background:var(--swb-bg);color:var(--swb-fg);padding:4px 7px;font:inherit;font-size:12px}" +
			".swb-textarea{width:100%;box-sizing:border-box;margin:6px 0 2px;resize:vertical}" +
			".swb-num{width:82px}" +
			".swb-btn{appearance:none;border:1px solid var(--swb-border);background:var(--swb-subtle);color:var(--swb-fg);border-radius:6px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}" +
			".swb-btn[data-variant='primary']{background:var(--swb-accent);border-color:var(--swb-accent);color:#ffffff}" +
			".swb-btn[data-variant='danger']{color:var(--swb-danger);border-color:var(--swb-danger)}" +
			".swb-btn:disabled{opacity:.45;cursor:not-allowed}" +
			".swb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--swb-muted);word-break:break-all}" +
			".swb-hint{color:var(--swb-muted);font-size:12px}" +
			".swb-empty{color:var(--swb-muted);font-size:12px;font-style:italic}" +
			".swb-err{color:var(--swb-danger);font-size:12px;margin-top:6px}" +
			".swb-ok{color:var(--swb-ok);font-size:12px;margin-top:6px}" +
			".swb-warnbox{margin-top:8px;padding:6px 10px;border:1px solid var(--swb-warn);background:var(--swb-warnbg);color:var(--swb-warn);border-radius:6px;font-size:12px}" +
			".swb-banner{margin-bottom:10px;padding:6px 10px;border:1px solid var(--swb-danger);border-radius:6px;color:var(--swb-danger);font-size:12px}" +
			".swb-video{display:block;width:100%;max-height:46vh;background:#000000;border-radius:6px}" +
			".swb-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px}" +
			"@media (max-width:900px){.swb-grid2{grid-template-columns:1fr}}" +
			".swb-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 14px;font-size:12px;align-items:baseline}" +
			".swb-k{color:var(--swb-muted)}" +
			".swb-list{margin:0;padding-left:18px;font-size:12px}" +
			".swb-list li{margin:2px 0}" +
			".swb-table{border-collapse:collapse;width:100%;font-size:12px}" +
			".swb-th{text-align:left;border-bottom:1px solid var(--swb-border);padding:4px 6px;color:var(--swb-muted);font-weight:600}" +
			".swb-td{border-bottom:1px solid var(--swb-border);padding:4px 6px;vertical-align:top}" +
			".swb-link{color:var(--swb-accent);text-decoration:none}" +
			".swb-link:hover{text-decoration:underline}" +
			".swb-chiplist{display:flex;gap:6px;flex-wrap:wrap}" +
			".swb-chip{appearance:none;border:1px solid var(--swb-border);background:var(--swb-subtle);color:var(--swb-fg);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}" +
			".swb-chip[data-selected='true']{border-color:var(--swb-accent);color:var(--swb-accent);background:transparent;font-weight:600}" +
			".swb-root :focus-visible{outline:2px solid var(--swb-accent);outline-offset:1px}"

		// ---------------- 通用小工具 ----------------
		function pick(...values) {
			for (const value of values) {
				if (value !== undefined && value !== null) return value
			}
			return undefined
		}
		function str(value) {
			if (value === undefined || value === null) return null
			if (typeof value === "object") return null
			const text = String(value)
			return text.length ? text : null
		}
		function num(value) {
			if (value === undefined || value === null || value === "") return null
			const parsed = typeof value === "number" ? value : Number(String(value).trim())
			return isFinite(parsed) ? parsed : null
		}
		function toArray(value) {
			if (Array.isArray(value)) return value
			if (value === undefined || value === null) return []
			return [value]
		}
		function parseNum(text) {
			if (text === undefined || text === null) return null
			const trimmed = String(text).trim()
			if (!trimmed) return null
			const value = Number(trimmed)
			return isFinite(value) ? value : null
		}
		function formatNum(value) {
			const parsed = Number(value)
			if (!isFinite(parsed)) return String(value)
			return String(Math.round(parsed * 100) / 100)
		}
		function numberText(value) {
			const parsed = num(value)
			return parsed === null ? "?" : formatNum(parsed)
		}
		function shortHash(hash) {
			const text = str(hash)
			if (!text) return ""
			return text.length > 12 ? text.slice(0, 12) + "…" : text
		}
		function formatClock(ts) {
			const date = new Date(ts)
			const pad = (value) => (value < 10 ? "0" + value : String(value))
			return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds())
		}
		function errMessage(error) {
			if (!error) return "未知错误"
			if (error.message) return String(error.message)
			return String(error)
		}
		function errorText(res, data) {
			const err = data && data.error
			if (err && typeof err === "object") {
				const code = err.code ? String(err.code) : ""
				const message = err.message ? String(err.message) : ""
				if (code && message) return code + "：" + message
				if (code) return code
				if (message) return message
			}
			if (typeof err === "string" && err) return err
			return "HTTP " + res.status
		}
		function errorHint(data) {
			const code = data && data.error && data.error.code
			if (code === "STALE_BASE_REVISION") return "（项目已被更新：已自动刷新，请确认最新状态后重试）"
			if (code === "IDEMPOTENCY_CONFLICT") return "（同一 command_id 对应了不同请求，请联系宿主排查）"
			if (code === "DECISION_NOT_PERMITTED_FOR_PRINCIPAL") return "（该主体不允许此类决定）"
			if (code === "SCOPE_OUT_OF_BOUNDS") return "（范围超出该版本媒体边界）"
			if (code === "CAPABILITY_MISSING") return "（缺少媒体/渲染能力，见总览的能力缺失）"
			if (code === "MEDIA_UNAVAILABLE") return "（该版本媒体不可用：文件缺失或字节数不一致，认可需要已加载的真实媒体）"
			if (code === "PROJECT_STATE_MISSING") return "（项目状态缺失；不会初始化为空项目，请联系宿主）"
			if (code === "PROJECT_STATE_CORRUPT") return "（项目状态损坏；不会静默重置，请联系宿主）"
			return ""
		}
		function canonical(value) {
			if (value === null || typeof value !== "object") {
				return JSON.stringify(value === undefined ? null : value)
			}
			if (Array.isArray(value)) {
				return "[" + value.map(canonical).join(",") + "]"
			}
			const keys = Object.keys(value).sort()
			return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
		}
		function newCommandId() {
			const cryptoApi = typeof crypto !== "undefined" ? crypto : null
			try {
				if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID()
				if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
					const bytes = new Uint8Array(16)
					cryptoApi.getRandomValues(bytes)
					bytes[6] = (bytes[6] & 15) | 64
					bytes[8] = (bytes[8] & 63) | 128
					let hex = ""
					for (let i = 0; i < bytes.length; i += 1) hex += (bytes[i] + 256).toString(16).slice(1)
					return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32)
				}
			} catch (error) {
				void error
			}
			return "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12)
		}
		function stableCommandId(store, projectId, request) {
			const key = String(projectId) + "|" + canonical(request)
			const existing = store.get(key)
			if (existing) return existing
			const created = newCommandId()
			store.set(key, created)
			return created
		}
		function safeGet(key) {
			try { return window.localStorage.getItem(key) } catch (error) { void error; return null }
		}
		function safeSet(key, value) {
			try { window.localStorage.setItem(key, value) } catch (error) { void error }
		}
		function readSessionId(ctx) {
			if (!ctx) return null
			try {
				if (ctx.session && typeof ctx.session.id === "string" && ctx.session.id) return ctx.session.id
				if (typeof ctx.sessionId === "string" && ctx.sessionId) return ctx.sessionId
			} catch (error) {
				void error
			}
			return null
		}
		function postJson(url, body) {
			return fetch(url, {
				method: "POST",
				credentials: "same-origin",
				cache: "no-store",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).then((res) => res.json().then(
				(data) => ({ ok: res.ok, status: res.status, data: data }),
				() => ({ ok: res.ok, status: res.status, data: null })
			))
		}

		// ---------------- 状态归一化（按契约 §4/§5 字段，兼容少量别名） ----------------
		function missingList(capabilities) {
			if (!capabilities || typeof capabilities !== "object") return []
			const raw = pick(capabilities.missing, capabilities.missing_capabilities)
			if (Array.isArray(raw)) return raw.map(capabilityText)
			if (raw && typeof raw === "object") {
				return Object.keys(raw).filter((key) => raw[key] === true || raw[key] === "missing" || raw[key] === "unavailable")
			}
			if (typeof raw === "string" && raw) return [raw]
			const probes = ["node", "ffmpeg", "ffprobe", "chrome", "browser"]
			const derived = []
			probes.forEach((key) => {
				if (capabilities[key] === false || capabilities[key] === "missing") derived.push(key)
			})
			return derived
		}
		function capabilityText(item) {
			if (typeof item === "string") return item
			if (item && typeof item === "object") return str(pick(item.name, item.capability, item.id)) || "未知能力"
			return String(item)
		}
		function normalizeVersion(version) {
			if (!version || typeof version !== "object") return null
			const output = (version.output && typeof version.output === "object") ? version.output : {}
			const snapshot = (version.source_snapshot && typeof version.source_snapshot === "object") ? version.source_snapshot : {}
			const versionId = str(pick(version.version_id, version.versionId, version.id)) || ""
			return {
				versionId: versionId,
				artifactId: str(pick(version.artifact_id, version.artifactId)),
				label: str(pick(version.label, version.title)) || versionId,
				basedOn: str(pick(version.based_on, version.basedOn)),
				mediaUrl: str(pick(output.media_url, output.mediaUrl, version.media_url)),
				sha256: str(pick(output.sha256, version.sha256, version.media_sha256)),
				durationSeconds: num(pick(output.duration_seconds, output.durationSeconds, version.duration_seconds)),
				width: num(pick(output.width, version.width)),
				height: num(pick(output.height, version.height)),
				fps: num(pick(output.fps, version.fps)),
				hasAudio: pick(output.has_audio, version.has_audio),
				probeVerified: pick(output.probe_verified, version.probe_verified),
				sourceUrl: str(pick(version.source_url, snapshot.source_url, snapshot.url)),
				protectedItems: toArray(pick(version.protected, version.protected_items, version.protections)),
				changes: toArray(version.changes),
				createdAt: str(pick(version.created_at, version.createdAt)),
			}
		}
		function normalizeDecision(decision) {
			if (!decision || typeof decision !== "object") return null
			return {
				decisionId: str(pick(decision.decision_id, decision.decisionId, decision.id)) || "",
				kind: str(decision.kind) || "",
				artifactId: str(pick(decision.artifact_id, decision.artifactId)),
				versionId: str(pick(decision.version_id, decision.versionId)),
				scope: (decision.scope && typeof decision.scope === "object") ? decision.scope : {},
				principal: str(decision.principal),
				channel: str(decision.channel),
				note: str(decision.note),
				valid: decision.valid !== false,
				supersedes: toArray(decision.supersedes).map((item) => str(item)).filter(Boolean),
				createdAt: str(pick(decision.created_at, decision.createdAt)),
				projectRevision: num(pick(decision.project_revision, decision.projectRevision)),
			}
		}
		function normalizeArtifact(artifact) {
			if (!artifact || typeof artifact !== "object") return null
			const artifactId = str(pick(artifact.artifact_id, artifact.artifactId, artifact.id)) || ""
			return {
				artifactId: artifactId,
				title: str(pick(artifact.title, artifact.name, artifact.label)) || artifactId,
				kind: str(pick(artifact.kind, artifact.type)),
			}
		}
		function normalizeRef(reference) {
			if (typeof reference === "string") return { refId: null, label: reference, href: null, note: null }
			if (!reference || typeof reference !== "object") return { refId: null, label: String(reference), href: null, note: null }
			return {
				refId: str(pick(reference.ref_id, reference.reference_id, reference.id)),
				label: str(pick(reference.label, reference.title, reference.name, reference.summary)) || "",
				href: str(pick(reference.url, reference.href)),
				note: str(reference.note),
			}
		}
		function normalizeProtection(entry) {
			if (!entry || typeof entry !== "object") return null
			const versionId = str(pick(entry.version_id, entry.versionId))
			if (!versionId) return null
			return {
				versionId: versionId,
				approved: toArray(entry.approved).map((scope) => ((scope && typeof scope === "object") ? scope : { raw: scope })),
				changesRequested: toArray(entry.changes_requested).map((note) => String(note)),
			}
		}
		function normalizeCreativeBrief(item) {
			if (typeof item === "string") return { artifactId: null, note: item, createdAt: null, commandId: null }
			if (!item || typeof item !== "object") return null
			return {
				artifactId: str(pick(item.artifact_id, item.artifactId)),
				note: str(pick(item.note, item.summary, item.text, item.intent)) || "",
				createdAt: str(pick(item.created_at, item.createdAt)),
				commandId: str(pick(item.command_id, item.commandId)),
			}
		}
		function normalizeState(raw) {
			let root = raw
			if (root && typeof root === "object" && root.state && typeof root.state === "object" && !Array.isArray(root.state) && !Array.isArray(root.versions)) {
				root = root.state
			}
			const project = (root && typeof root.project === "object" && root.project) ? root.project : {}
			const versions = toArray(root && root.versions).map(normalizeVersion).filter((item) => item && item.versionId)
			const decisions = toArray(root && root.decisions).map(normalizeDecision).filter((item) => item && item.decisionId)
			const artifacts = toArray(root && root.artifacts).map(normalizeArtifact).filter((item) => item && item.artifactId)
			const capabilities = (project.capabilities && typeof project.capabilities === "object") ? project.capabilities : ((root && typeof root.capabilities === "object" && root.capabilities) ? root.capabilities : {})
			const references = toArray(pick(root && root.references, project.references)).map(normalizeRef)
			const protection = toArray(root && root.protection).map(normalizeProtection).filter(Boolean)
			const workBasis = normalizeVersion(root && root.work_basis)
			const currentVersionId = str(pick(
				project.current_version_id,
				project.work_basis_version_id,
				project.currentVersionId,
				root && root.current_version_id,
				root && root.work_basis_version_id,
				workBasis ? workBasis.versionId : null
			))
			const nextRaw = (root && typeof root.next === "object" && root.next) ? root.next : null
			const next = { present: false, openChangeRequests: null, unadopted: [], unadoptedCount: null, unadoptedListProvided: false }
			if (nextRaw) {
				next.present = true
				next.openChangeRequests = num(pick(nextRaw.open_change_requests, nextRaw.openChangeRequests))
				const rawList = pick(nextRaw.unadopted_versions, nextRaw.unadoptedVersions)
				if (Array.isArray(rawList)) {
					next.unadoptedListProvided = true
					next.unadopted = rawList.map((item) => {
						if (typeof item === "string") return findVersion(versions, item)
						if (item && typeof item === "object") {
							const id = str(pick(item.version_id, item.versionId, item.id))
							return findVersion(versions, id) || normalizeVersion(item)
						}
						return null
					}).filter(Boolean)
				} else if (typeof rawList === "number") {
					next.unadoptedCount = rawList
				}
			}
			return {
				projectId: str(pick(project.project_id, project.projectId, root && root.project_id)) || "",
				title: str(pick(project.title, project.name, root && root.title)),
				revision: num(pick(project.project_revision, project.revision, root && root.project_revision, root && root.revision)),
				currentVersionId: currentVersionId,
				versions: versions,
				decisions: decisions,
				artifacts: artifacts,
				references: references,
				protection: protection,
				workBasis: workBasis,
				next: next,
				creativeBrief: toArray(root && root.creative_brief).map(normalizeCreativeBrief).filter(Boolean),
				capabilities: { missing: missingList(capabilities), raw: capabilities },
			}
		}
		function normalizeProjects(data) {
			let list = null
			if (Array.isArray(data)) list = data
			else if (data && Array.isArray(data.projects)) list = data.projects
			else if (data && Array.isArray(data.items)) list = data.items
			if (!list) return []
			const seen = {}
			const result = []
			list.forEach((item) => {
				if (item === null || item === undefined) return
				if (typeof item === "string") {
					if (!seen[item]) { seen[item] = true; result.push({ projectId: item, title: item }) }
					return
				}
				if (typeof item !== "object") return
				const id = str(pick(item.project_id, item.projectId, item.id))
				if (!id || seen[id]) return
				seen[id] = true
				result.push({ projectId: id, title: str(pick(item.title, item.name)) || id })
			})
			return result
		}
		function pickInitialProjectId(list) {
			let query = ""
			try {
				const params = new URLSearchParams(window.location.search)
				query = params.get("project_id") || params.get("project") || ""
			} catch (error) {
				void error
				query = ""
			}
			if (query) return query
			const stored = safeGet(STORAGE_KEY)
			if (stored && (list.length === 0 || list.some((item) => item.projectId === stored))) return stored
			return list.length ? list[0].projectId : (stored || "")
		}
		function findVersion(versions, versionId) {
			if (!versionId) return null
			for (const version of versions) if (version.versionId === versionId) return version
			return null
		}
		function findProtection(protection, versionId) {
			if (!versionId) return null
			for (const entry of protection) if (entry.versionId === versionId) return entry
			return null
		}
		function findArtifact(artifacts, artifactId) {
			if (!artifactId) return null
			for (const artifact of artifacts) if (artifact.artifactId === artifactId) return artifact
			return null
		}
		function approvalsOf(decisions, versionId) {
			if (!versionId) return []
			return decisions.filter((item) => item.kind === "partial_approval" && item.valid && item.versionId === versionId)
		}
		function openChangeRequests(decisions) {
			const superseded = {}
			decisions.forEach((item) => {
				if (!item.valid) return
				item.supersedes.forEach((id) => { if (id) superseded[id] = true })
			})
			return decisions.filter((item) => item.kind === "change_request" && item.valid && !superseded[item.decisionId])
		}
		function pendingApprovalVersions(state) {
			const versions = state.versions
			if (!versions.length) return []
			const targets = []
			const current = findVersion(versions, state.currentVersionId)
			const latest = versions[versions.length - 1]
			if (current) targets.push(current)
			if (latest && latest !== current) targets.push(latest)
			return targets.filter((item) => approvalsOf(state.decisions, item.versionId).length === 0)
		}
		function pickLatestViewable(versions) {
			for (let i = versions.length - 1; i >= 0; i -= 1) {
				if (versions[i].mediaUrl) return versions[i]
			}
			return versions.length ? versions[versions.length - 1] : null
		}
		function versionLabelOf(state, versionId) {
			const version = findVersion(state.versions, versionId)
			return version ? version.label + " · " + version.versionId : (versionId || "（未知版本）")
		}
		function scopeText(scope) {
			const value = scope || {}
			if (value.kind === "full_version") return "整版"
			if (value.kind === "time_range") return "时间段 [" + numberText(value.start_seconds) + ", " + numberText(value.end_seconds) + ")s"
			if (value.kind === "region") return "画面区域 @" + numberText(value.frame_seconds) + "s (" + numberText(value.x) + "," + numberText(value.y) + " " + numberText(value.width) + "×" + numberText(value.height) + ")"
			if (value.kind === "aspect") return "方面 " + (value.aspect || "?") + (value.description ? "：" + value.description : "")
			return value.kind ? String(value.kind) : "未知范围"
		}
		const KIND_TEXT = { partial_approval: "用户认可", change_request: "修改要求", reject: "拒绝", withdraw: "撤回认可", ai_check: "AI 检查", final: "最终定稿（未支持）" }
		function kindText(kind) {
			return KIND_TEXT[kind] || String(kind || "未知决定")
		}
		const ASPECT_TEXT = { typography: "排版 / 字体", motion: "运动 / 节奏", sound: "声音", material: "材质", layout: "布局" }
		function aspectText(aspect) {
			return ASPECT_TEXT[aspect] ? ASPECT_TEXT[aspect] + "（" + aspect + "）" : String(aspect)
		}
		function decisionLine(decision) {
			const parts = [kindText(decision.kind), scopeText(decision.scope)]
			if (!decision.valid) parts.push("已失效")
			if (decision.principal) parts.push("主体 " + decision.principal)
			if (decision.note) parts.push(decision.note)
			if (decision.createdAt) parts.push(decision.createdAt)
			return parts.join(" · ")
		}
		function versionMetaText(version) {
			const parts = []
			if (version.durationSeconds !== null) parts.push("时长 " + formatNum(version.durationSeconds) + "s")
			if (version.width !== null && version.height !== null) parts.push("尺寸 " + formatNum(version.width) + "×" + formatNum(version.height))
			if (version.fps !== null) parts.push(formatNum(version.fps) + " fps")
			if (version.hasAudio === true) parts.push("有音轨")
			else if (version.hasAudio === false) parts.push("无音轨")
			if (version.probeVerified === false) parts.push("探测未验证（probe_verified: false）")
			return parts.length ? parts.join(" · ") : "（状态未提供该版本媒体元数据）"
		}
		function refText(reference) {
			const parts = []
			if (reference.label) parts.push(reference.label)
			if (reference.refId) parts.push(reference.refId)
			if (reference.note) parts.push(reference.note)
			return parts.length ? parts.join(" · ") : "（未命名引用）"
		}
		function nextStepText(state, openCount, pendingCount) {
			if (!state.versions.length) return "还没有版本：先让 Agent 登记第一个候选版本（version_register），然后在「审阅」中播放并给出范围认可。"
			if (openCount > 0) return "有 " + openCount + " 条未关闭的修改要求：等待 Agent 处理后登记新版本，再用「审阅」复核目标变化与保护项。"
			if (pendingCount > 0) return "有 " + pendingCount + " 个版本尚未采用或尚无用户认可：在「审阅」播放后提交认可或修改要求，并与 Agent 确认采用哪个版本作为工作依据。"
			return "当前工作依据已有用户认可。如需继续改进，在「审阅」用时间段 / 区域 / 方面提交新的修改要求；v0.1 未支持最终定稿与发布。"
		}
		function initialUi() {
			return {
				tab: "overview",
				artifactId: null,
				reviewVersionId: null,
				compareVersionId: null,
				scopeKind: "time_range",
				tStart: "0",
				tEnd: "",
				frameSeconds: "0",
				regionX: "0",
				regionY: "0",
				regionW: "",
				regionH: "",
				aspect: "motion",
				aspectDesc: "",
				note: "",
				createNote: "",
				briefNote: "",
				withdrawDecisionId: null,
			}
		}
		function emptyForms() {
			return {
				create: { busy: false, error: null, info: null },
				brief: { busy: false, error: null, info: null },
				review: { busy: false, error: null, info: null },
			}
		}

		// ---------------- Workbench ----------------
		function Workbench() {
			const [projects, setProjects] = React.useState([])
			const [projectId, setProjectId] = React.useState("")
			const [snapshot, setSnapshot] = React.useState(null)
			const [stateError, setStateError] = React.useState(null)
			const [updatedAt, setUpdatedAt] = React.useState(0)
			const [refreshing, setRefreshing] = React.useState(false)
			const [ui, setUi] = React.useState(initialUi)
			const [forms, setForms] = React.useState(emptyForms)
			const [media, setMedia] = React.useState({ versionId: null, readyState: 0, failed: false })
			const videoRef = React.useRef(null)
			const commandIdsRef = React.useRef(new Map())
			const prevProjectRef = React.useRef(null)

			const patchUi = React.useCallback((patch) => {
				setUi((prev) => Object.assign({}, prev, patch))
			}, [])
			const setForm = React.useCallback((name, patch) => {
				setForms((prev) => {
					const next = Object.assign({}, prev)
					next[name] = Object.assign({}, prev[name] || {}, patch)
					return next
				})
			}, [])
			const loadState = React.useCallback((id) => {
				if (!id) return Promise.resolve()
				setRefreshing(true)
				return fetch("/studio/projects/" + encodeURIComponent(id) + "/state", {
					credentials: "same-origin",
					cache: "no-store",
					headers: { accept: "application/json" },
				}).then(
					(res) => res.json().then(
						(data) => {
							if (!res.ok) {
								setStateError(errorText(res, data))
							} else {
								setSnapshot(normalizeState(data))
								setStateError(null)
								setUpdatedAt(Date.now())
							}
						},
						() => { setStateError("无法解析状态响应（HTTP " + res.status + "）") }
					),
					(error) => { setStateError("无法读取项目状态：" + errMessage(error)) }
				).then(() => setRefreshing(false))
			}, [])

			// 首次：读取项目索引，确定要展示的项目
			React.useEffect(() => {
				let alive = true
				fetch("/studio/projects", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } }).then(
					(res) => res.json().then(
						(data) => {
							if (!alive) return
							const list = res.ok ? normalizeProjects(data) : []
							setProjects(list)
							setProjectId(pickInitialProjectId(list))
							if (!res.ok) setStateError(errorText(res, data))
							else if (!list.length) setStateError("GET /studio/projects 没有返回项目；可用地址栏参数 ?project=<project_id> 指定。")
						},
						() => {
							if (!alive) return
							setProjectId(pickInitialProjectId([]))
							setStateError("无法解析项目索引响应。")
						}
					),
					(error) => {
						if (!alive) return
						setProjectId(pickInitialProjectId([]))
						setStateError("无法读取项目索引：" + errMessage(error))
					}
				)
				return () => { alive = false }
			}, [])

			React.useEffect(() => {
				if (projectId) safeSet(STORAGE_KEY, projectId)
			}, [projectId])

			// 项目切换：清空本地视图（避免把上一项目的表单/选择带到新项目）
			React.useEffect(() => {
				if (prevProjectRef.current === projectId) return
				prevProjectRef.current = projectId
				setSnapshot(null)
				setStateError(null)
				setUi(initialUi())
				setForms(emptyForms())
				setMedia({ versionId: null, readyState: 0, failed: false })
				if (videoRef.current && typeof videoRef.current.pause === "function") {
					try { videoRef.current.pause() } catch (error) { void error }
				}
			}, [projectId])

			// 5 秒轮询
			React.useEffect(() => {
				if (!projectId) return undefined
				loadState(projectId)
				const timer = setInterval(() => {
					if (typeof document !== "undefined" && document.hidden) return
					loadState(projectId)
				}, POLL_MS)
				return () => clearInterval(timer)
			}, [projectId, loadState])

			// 会话绑定：只有宿主 ctx 暴露 session id 时才尝试登记一次（失败静默，不影响四区功能）
			const sessionBoundRef = React.useRef("")
			const snapshotRevision = snapshot ? snapshot.revision : null
			React.useEffect(() => {
				if (!projectId || snapshotRevision === null) return
				const sessionId = readSessionId(ctxRef)
				if (!sessionId) return
				const key = projectId + "|" + sessionId
				if (sessionBoundRef.current === key) return
				sessionBoundRef.current = key
				const body = { session_id: sessionId, base_revision: snapshotRevision, command_id: newCommandId() }
				postJson("/studio/projects/" + encodeURIComponent(projectId) + "/ui/session", body).catch(() => {})
			}, [projectId, snapshotRevision])

			// 默认审阅版本：当前工作依据，否则最新
			const versionKey = snapshot ? snapshot.versions.map((item) => item.versionId).join("|") : ""
			const snapshotCurrentId = snapshot ? snapshot.currentVersionId : null
			React.useEffect(() => {
				if (!snapshot) return
				const ids = snapshot.versions.map((item) => item.versionId)
				setUi((prev) => {
					if (prev.reviewVersionId && ids.indexOf(prev.reviewVersionId) >= 0) return prev
					const target = snapshot.currentVersionId || (ids.length ? ids[ids.length - 1] : "")
					if (!target || target === prev.reviewVersionId) return prev
					return Object.assign({}, prev, { reviewVersionId: target })
				})
			}, [versionKey, snapshotCurrentId])

			const reviewVersion = snapshot ? findVersion(snapshot.versions, ui.reviewVersionId) : null
			const rvDuration = reviewVersion ? reviewVersion.durationSeconds : null
			const rvWidth = reviewVersion ? reviewVersion.width : null
			const rvHeight = reviewVersion ? reviewVersion.height : null

			// 版本切换：按该版本真实媒体元数据重新初始化范围表单
			React.useEffect(() => {
				setUi((prev) => Object.assign({}, prev, {
					tStart: "0",
					tEnd: rvDuration !== null ? formatNum(rvDuration) : "",
					frameSeconds: "0",
					regionX: "0",
					regionY: "0",
					regionW: rvWidth !== null ? formatNum(Math.round(rvWidth / 2)) : "",
					regionH: rvHeight !== null ? formatNum(Math.round(rvHeight / 2)) : "",
				}))
			}, [ui.reviewVersionId, rvDuration, rvWidth, rvHeight])

			React.useEffect(() => {
				setMedia({ versionId: ui.reviewVersionId, readyState: 0, failed: false })
			}, [ui.reviewVersionId])

			const setVideoEl = React.useCallback((element) => {
				videoRef.current = element
				if (element && typeof element.readyState === "number" && element.readyState >= 2) {
					setMedia({ versionId: ui.reviewVersionId, readyState: element.readyState, failed: false })
				}
			}, [ui.reviewVersionId])
			const syncMedia = React.useCallback(() => {
				const element = videoRef.current
				const readyState = element && typeof element.readyState === "number" ? element.readyState : 0
				setMedia({ versionId: ui.reviewVersionId, readyState: readyState, failed: false })
			}, [ui.reviewVersionId])
			const failMedia = React.useCallback(() => {
				const element = videoRef.current
				const readyState = element && typeof element.readyState === "number" ? element.readyState : 0
				setMedia({ versionId: ui.reviewVersionId, readyState: readyState, failed: true })
			}, [ui.reviewVersionId])

			const mediaReady = media.versionId === ui.reviewVersionId && !media.failed && media.readyState >= 2

			// ---------------- 行为 ----------------
			function goBack() {
				const ctx = ctxRef
				if (ctx && ctx.layout && typeof ctx.layout.selectPanel === "function") ctx.layout.selectPanel(null)
			}
			function projectTitleOf(id) {
				for (const item of projects) if (item.projectId === id) return item.title
				return id || ""
			}
			function mediaStatusText() {
				if (!reviewVersion) return "未选择版本。"
				if (!reviewVersion.mediaUrl) return "该版本没有媒体地址，无法产生“已播放”的认可。"
				if (media.failed) return "媒体加载失败：不能产生已播放的认可（仍可提交修改要求）。"
				if (media.versionId !== reviewVersion.versionId) return "媒体准备中…"
				if (media.readyState >= 2) return "媒体已就绪（readyState " + media.readyState + "），可以提交用户认可。"
				return "媒体尚未就绪（readyState " + media.readyState + "），等待加载后再提交认可。"
			}
			function formMessage(name) {
				const form = forms[name]
				if (!form || (!form.error && !form.info)) return null
				return h("div", null,
					form.error ? h("div", { className: "swb-err", role: "alert" }, form.error) : null,
					form.info ? h("div", { className: "swb-ok", role: "status" }, form.info) : null
				)
			}
			function numberField(label, value, onChange, ariaLabel) {
				return h("label", { className: "swb-field", key: ariaLabel },
					h("span", { className: "swb-label" }, label),
					h("input", { className: "swb-input swb-num", type: "number", step: "0.1", min: "0", value: value, "aria-label": ariaLabel, onChange: (event) => onChange(event.target.value) })
				)
			}
			function buildScope() {
				if (ui.scopeKind === "full_version") return { scope: { kind: "full_version" } }
				if (ui.scopeKind === "time_range") {
					const start = parseNum(ui.tStart)
					const end = parseNum(ui.tEnd)
					if (start === null || end === null) return { error: "请填写开始与结束时间（秒）。" }
					if (start < 0) return { error: "开始时间必须大于等于 0。" }
					if (!(end > start)) return { error: "结束时间必须大于开始时间（半开区间 [start, end)）。" }
					if (rvDuration !== null && end > rvDuration) return { error: "结束时间超出该版本时长 " + formatNum(rvDuration) + " 秒。" }
					return { scope: { kind: "time_range", start_seconds: start, end_seconds: end } }
				}
				if (ui.scopeKind === "region") {
					const frame = parseNum(ui.frameSeconds)
					const x = parseNum(ui.regionX)
					const y = parseNum(ui.regionY)
					const width = parseNum(ui.regionW)
					const height = parseNum(ui.regionH)
					if (frame === null || x === null || y === null || width === null || height === null) return { error: "画面区域需要 frame_seconds、x、y、宽度、高度五个数字。" }
					if (frame < 0) return { error: "frame_seconds 必须大于等于 0。" }
					if (rvDuration !== null && frame >= rvDuration) return { error: "frame_seconds 必须小于该版本时长 " + formatNum(rvDuration) + " 秒。" }
					if (x < 0 || y < 0) return { error: "x / y 必须大于等于 0。" }
					if (!(width > 0) || !(height > 0)) return { error: "宽度和高度必须大于 0。" }
					if (rvWidth !== null && x + width > rvWidth) return { error: "区域超出该版本宽度（x + 宽度 > " + formatNum(rvWidth) + "）。" }
					if (rvHeight !== null && y + height > rvHeight) return { error: "区域超出该版本高度（y + 高度 > " + formatNum(rvHeight) + "）。" }
					return { scope: { kind: "region", frame_seconds: frame, x: x, y: y, width: width, height: height, basis: "display" } }
				}
				const description = ui.aspectDesc.trim()
				if (!description) return { error: "方面范围需要填写说明（description）。" }
				return { scope: { kind: "aspect", aspect: ui.aspect, description: description } }
			}
			function withdrawTargets() {
				if (!snapshot || !reviewVersion) return []
				return approvalsOf(snapshot.decisions, reviewVersion.versionId)
			}
			function pickWithdrawTarget(targets) {
				if (!targets.length) return null
				for (const item of targets) if (item.decisionId === ui.withdrawDecisionId) return item
				return targets[targets.length - 1]
			}
			function submitDecision(kind) {
				if (!snapshot) { setForm("review", { error: "项目状态尚未加载，无法提交。", info: null }); return }
				if (!reviewVersion) { setForm("review", { error: "没有可提交的版本，请先选择版本。", info: null }); return }
				if (snapshot.revision === null) { setForm("review", { error: "状态未提供 project_revision，缺少并发基线，无法安全提交。", info: null }); return }
				if (kind === "partial_approval" && !mediaReady) {
					setForm("review", { error: "媒体未加载，不能产生已播放的认可。", info: null })
					return
				}
				let scope = null
				let target = null
				if (kind === "withdraw") {
					const picked = pickWithdrawTarget(withdrawTargets())
					if (!picked) { setForm("review", { error: "该版本没有可撤回的有效认可记录。", info: null }); return }
					target = { decision_id: picked.decisionId }
					scope = (picked.scope && picked.scope.kind) ? picked.scope : { kind: "full_version" }
				} else {
					const built = buildScope()
					if (built.error) { setForm("review", { error: built.error, info: null }); return }
					scope = built.scope
				}
				const note = ui.note.trim()
				const body = {
					base_revision: snapshot.revision,
					version_id: reviewVersion.versionId,
					decision_kind: kind,
					scope: scope,
					media_ready: kind === "partial_approval" ? true : mediaReady,
				}
				const artifactId = reviewVersion.artifactId || ui.artifactId || null
				if (artifactId) body.artifact_id = artifactId
				if (note) body.note = note
				if (target) body.target = target
				const commandId = stableCommandId(commandIdsRef.current, projectId, body)
				const payload = Object.assign({ command_id: commandId }, body)
				const url = "/studio/projects/" + encodeURIComponent(projectId) + "/ui/decision"
				setForm("review", { busy: true, error: null, info: null })
				postJson(url, payload).then((res) => {
					if (!res.ok) {
						setForm("review", { busy: false, error: errorText(res, res.data) + errorHint(res.data), info: null })
						loadState(projectId)
						return
					}
					const result = res.data || {}
					const decisionId = str(pick(result.decision_id, result.decision && result.decision.decision_id, result.decision && result.decision.decisionId))
					const replay = result.idempotent_replay === true || (result.result && result.result.idempotent_replay === true)
					setForm("review", {
						busy: false,
						error: null,
						info: "已提交：" + kindText(kind) + (decisionId ? " · decision_id " + decisionId : "") + (replay ? " · 幂等重放（复用首次结果，未重复记录）" : ""),
					})
					if (kind !== "withdraw") setUi((prev) => Object.assign({}, prev, { note: "" }))
					loadState(projectId)
				}, (error) => {
					setForm("review", { busy: false, error: "网络错误，可直接重试（会复用同一 command_id）：" + errMessage(error), info: null })
				})
			}
			function submitIntent(formName, note, artifactId, field) {
				const text = note.trim()
				if (!text) { setForm(formName, { error: "请先填写内容再保存。", info: null }); return }
				if (!projectId) { setForm(formName, { error: "尚未选择项目。", info: null }); return }
				if (!snapshot) { setForm(formName, { error: "项目状态尚未加载，无法提交。", info: null }); return }
				if (snapshot.revision === null) { setForm(formName, { error: "状态未提供 project_revision，缺少并发基线，无法安全提交。", info: null }); return }
				if (formName === "brief" && !artifactId) { setForm(formName, { error: "请先在「对象」中选择一个对象。", info: null }); return }
				const body = { base_revision: snapshot.revision, note: text, intent_kind: "creative_brief" }
				if (artifactId) body.artifact_id = artifactId
				const commandId = stableCommandId(commandIdsRef.current, projectId, body)
				const payload = Object.assign({ command_id: commandId }, body)
				const url = "/studio/projects/" + encodeURIComponent(projectId) + "/ui/intent"
				setForm(formName, { busy: true, error: null, info: null })
				postJson(url, payload).then((res) => {
					if (!res.ok) {
						setForm(formName, { busy: false, error: errorText(res, res.data) + errorHint(res.data), info: null })
						return
					}
					const result = res.data || {}
					const intentId = str(pick(result.intent_id, result.command_id, result.command && result.command.command_id))
					setForm(formName, { busy: false, error: null, info: "已登记创作意图" + (intentId ? " · " + intentId : "") + "（后续由 Agent 执行）" })
					setUi((prev) => {
						const patch = {}
						patch[field] = ""
						return Object.assign({}, prev, patch)
					})
				}, (error) => {
					setForm(formName, { busy: false, error: "网络错误：" + errMessage(error), info: null })
				})
			}

			// ---------------- 渲染：顶栏 ----------------
			function renderTop() {
				const missing = snapshot ? snapshot.capabilities.missing : []
				const optionIds = projects.map((item) => item.projectId)
				if (projectId && optionIds.indexOf(projectId) < 0) optionIds.unshift(projectId)
				const basis = snapshot ? (findVersion(snapshot.versions, snapshot.currentVersionId) || snapshot.workBasis) : null
				return h("div", { className: "swb-top" },
					h("div", { className: "swb-topmain" },
						h("span", { className: "swb-title" }, "Studio"),
						h("span", { className: "swb-subtitle" }, snapshot ? (snapshot.title || snapshot.projectId || projectId || "未命名项目") : "未加载项目状态"),
						snapshot ? h("span", { className: "swb-badge" }, "revision " + (snapshot.revision === null ? "-" : String(snapshot.revision))) : null,
						snapshot ? h("span", { className: "swb-badge" }, "工作依据 " + (basis ? basis.label + " · " + basis.versionId : "（未设置）")) : null,
						missing.length ? h("span", { className: "swb-badge", "data-tone": "warn", title: "缺失能力：" + missing.join("、") }, "能力缺失 " + missing.length + " 项") : null
					),
					h("div", { className: "swb-topright" },
						optionIds.length ? h("label", { className: "swb-field" },
							h("span", { className: "swb-label" }, "项目"),
							h("select", { className: "swb-select", value: projectId, "aria-label": "选择项目", onChange: (event) => setProjectId(event.target.value) },
								optionIds.map((id) => h("option", { key: id, value: id }, projectTitleOf(id)))
							)
						) : null,
						h("span", { className: "swb-hint" }, updatedAt ? "更新于 " + formatClock(updatedAt) + (refreshing ? " · 刷新中" : "") : (refreshing ? "读取中…" : "")),
						h("button", { type: "button", className: "swb-btn", disabled: !projectId || refreshing, onClick: () => loadState(projectId) }, "刷新"),
						h("button", { type: "button", className: "swb-btn", onClick: goBack }, "返回原会话")
					)
				)
			}

			function renderLoading() {
				if (!projectId) {
					return h("section", { className: "swb-card" },
						h("h3", { className: "swb-h3" }, "没有可显示的项目"),
						h("div", { className: "swb-empty" }, "GET /studio/projects 未返回项目。请先在宿主创建项目再刷新；也可用地址栏参数 ?project=<project_id> 指定项目。")
					)
				}
				if (stateError) {
					return h("section", { className: "swb-card" },
						h("div", { className: "swb-err", role: "alert" }, stateError),
						h("div", { className: "swb-row" }, h("button", { type: "button", className: "swb-btn", onClick: () => loadState(projectId) }, "重试"))
					)
				}
				return h("section", { className: "swb-card" }, h("div", { className: "swb-empty" }, "正在读取项目状态…"))
			}

			// ---------------- 渲染：总览 ----------------
			function renderOverview() {
				if (!snapshot) return renderLoading()
				const current = findVersion(snapshot.versions, snapshot.currentVersionId) || snapshot.workBasis
				const latest = pickLatestViewable(snapshot.versions)
				const protectionEntry = current ? findProtection(snapshot.protection, current.versionId) : null
				const approvals = current ? approvalsOf(snapshot.decisions, current.versionId) : []
				const approvedScopes = (protectionEntry && protectionEntry.approved.length) ? protectionEntry.approved : approvals.map((item) => item.scope)
				const changesRequested = protectionEntry ? protectionEntry.changesRequested : []
				const openItems = openChangeRequests(snapshot.decisions)
				const derivedPending = pendingApprovalVersions(snapshot)
				const openCount = snapshot.next.openChangeRequests !== null ? snapshot.next.openChangeRequests : openItems.length
				const pendingList = snapshot.next.unadoptedListProvided ? snapshot.next.unadopted : derivedPending
				const pendingCount = snapshot.next.unadoptedCount !== null ? snapshot.next.unadoptedCount : pendingList.length
				const missing = snapshot.capabilities.missing
				const protectionParts = []
				if (approvedScopes.length) {
					protectionParts.push(h("div", { key: "approved" },
						h("div", { className: "swb-sub" }, "已认可范围（保护依据）"),
						h("ul", { className: "swb-list" }, approvedScopes.map((scope, index) => h("li", { key: "prot-" + index }, scopeText(scope))))
					))
				}
				if (changesRequested.length) {
					protectionParts.push(h("div", { key: "changes" },
						h("div", { className: "swb-sub" }, "曾要求修改（保护依据）"),
						h("ul", { className: "swb-list" }, changesRequested.map((note, index) => h("li", { key: "chg-" + index }, note)))
					))
				}
				if (!protectionParts.length && approvals.length) {
					protectionParts.push(h("div", { key: "derived" },
						h("div", { className: "swb-sub" }, "当前工作依据上有效的认可记录（由决定推导）"),
						h("ul", { className: "swb-list" }, approvals.map((item) => h("li", { key: item.decisionId }, scopeText(item.scope) + (item.note ? "（" + item.note + "）" : "") + (item.createdAt ? " · " + item.createdAt : ""))))
					))
				}
				const protectionBlock = current
					? (protectionParts.length ? h("div", null, protectionParts) : h("div", { className: "swb-empty" }, "当前工作依据没有保护项记录。"))
					: h("div", { className: "swb-empty" }, "尚未设置当前工作依据，因此还没有保护项。")
				const pendingParts = []
				if (openCount > 0) {
					pendingParts.push(h("div", { key: "open" },
						h("div", { className: "swb-sub" }, "未关闭的修改要求（" + openCount + "）"),
						openItems.length
							? h("ul", { className: "swb-list" }, openItems.map((item) => h("li", { key: item.decisionId }, versionLabelOf(snapshot, item.versionId) + " · " + scopeText(item.scope) + (item.note ? "：" + item.note : ""))))
							: h("div", { className: "swb-hint" }, "服务端只给出计数（state.next.open_change_requests），明细见该版本的决定记录。")
					))
				}
				if (pendingCount > 0) {
					pendingParts.push(h("div", { key: "pending" },
						h("div", { className: "swb-sub" }, "待决定版本（未采用 / 尚无用户认可）（" + pendingCount + "）"),
						pendingList.length
							? h("ul", { className: "swb-list" }, pendingList.map((item) => h("li", { key: item.versionId }, item.label + " · " + item.versionId + (item.versionId === snapshot.currentVersionId ? "（当前工作依据）" : ""))))
							: h("div", { className: "swb-hint" }, "服务端只给出数量（state.next.unadopted_versions），明细见「资产」版本列表。")
					))
				}
				const pendingBlock = pendingParts.length
					? h("div", null, pendingParts, h("div", { className: "swb-hint" }, "来源：state.next（未关闭修改要求、未采用版本）；缺失时由决定记录推导。"))
					: h("div", { className: "swb-empty" }, "没有真正待决定的事项。")
				return h("div", { className: "swb-stack" },
					h("section", { className: "swb-card", "aria-label": "继续当前项目" },
						h("h3", { className: "swb-h3" }, "继续当前项目"),
						h("div", { className: "swb-kv" },
							h("span", { className: "swb-k" }, "项目"), h("span", null, snapshot.title || snapshot.projectId || "-"),
							h("span", { className: "swb-k" }, "项目 revision"), h("span", null, snapshot.revision === null ? "（状态未提供）" : String(snapshot.revision)),
							h("span", { className: "swb-k" }, "当前工作依据"), h("span", null, current ? current.label + " · " + current.versionId + (current.durationSeconds !== null ? " · " + formatNum(current.durationSeconds) + "s" : "") : "（尚未设置）")
						),
						h("div", { className: "swb-hint", style: { marginTop: "6px" } }, "缺渲染能力时浏览、审阅记录与保存恢复仍可用；渲染/转码返回 CAPABILITY_MISSING（契约 §9）。")
					),
					h("section", { className: "swb-card", "aria-label": "最近可看结果" },
						h("h3", { className: "swb-h3" }, "最近可看结果"),
						latest ? h("div", null,
							h("div", { className: "swb-mono" }, latest.label + " · " + latest.versionId + (latest.sha256 ? " · " + shortHash(latest.sha256) : "")),
							latest.mediaUrl
								? h("video", { key: "overview-" + latest.versionId, className: "swb-video", src: latest.mediaUrl, controls: true, preload: "metadata", playsInline: true })
								: h("div", { className: "swb-empty" }, "该版本未提供媒体地址（state.versions[i].media_url）。"),
							h("div", { className: "swb-hint", style: { marginTop: "4px" } }, versionMetaText(latest))
						) : h("div", { className: "swb-empty" }, "还没有登记任何版本。")
					),
					h("section", { className: "swb-card", "aria-label": "保护项" },
						h("h3", { className: "swb-h3" }, "保护项（新版继承保护依据，不继承“已认可”）"),
						protectionBlock
					),
					h("section", { className: "swb-card", "aria-label": "待决定事项" },
						h("h3", { className: "swb-h3" }, "待决定事项"),
						pendingBlock
					),
					h("section", { className: "swb-card", "aria-label": "下一步" },
						h("h3", { className: "swb-h3" }, "下一步"),
						h("div", null, nextStepText(snapshot, openCount, pendingCount))
					),
					h("section", { className: "swb-card", "aria-label": "制作任务" },
						h("h3", { className: "swb-h3" }, "制作任务"),
						(snapshot.jobs || []).length
							? h("ul", { className: "swb-list" }, (snapshot.jobs || []).slice(-6).reverse().map((job) => h("li", { key: job.job_id },
								h("span", { className: "swb-badge" }, job.status), " ", job.job_id,
								job.version_id ? " → " + job.version_id : "",
								job.error ? " · " + (job.error.code || job.error.message) : "",
								job.status === "unknown" ? "（结果未知，需对账）" : ""
							)))
							: h("div", { className: "swb-empty" }, "还没有制作任务。"),
						h("div", { className: "swb-hint", style: { marginTop: "4px" } }, "任务状态由 ProjectStore 串行写入，不推进创作 revision；未知结果先对账再决定是否重试。")
					),
					h("section", { className: "swb-card", "aria-label": "能力缺失" },
						h("h3", { className: "swb-h3" }, "能力缺失"),
						missing.length
							? h("div", null,
								h("ul", { className: "swb-list" }, missing.map((item, index) => h("li", { key: "cap-" + index }, String(item)))),
								h("div", { className: "swb-hint", style: { marginTop: "4px" } }, "缺少的渲染/探测工具会让对应动作返回 CAPABILITY_MISSING；不会静默降级。")
							)
							: h("div", { className: "swb-empty" }, "没有报告能力缺失（state.project.capabilities.missing 为空或未提供）。")
					)
				)
			}

			// ---------------- 渲染：创作 ----------------
			function renderCreate() {
				if (!snapshot) return renderLoading()
				const artifacts = snapshot.artifacts
				const selectedArtifact = findArtifact(artifacts, ui.artifactId)
				const relevant = snapshot.versions.filter((item) => !selectedArtifact || item.artifactId === selectedArtifact.artifactId)
				const recent = relevant.slice(-8).reverse()
				const recentBriefs = snapshot.creativeBrief
					.filter((item) => !selectedArtifact || !item.artifactId || item.artifactId === selectedArtifact.artifactId)
					.slice(-5)
					.reverse()
				return h("div", { className: "swb-stack" },
					h("section", { className: "swb-card", "aria-label": "对象列表" },
						h("h3", { className: "swb-h3" }, "对象"),
						artifacts.length
							? h("div", { className: "swb-chiplist", "aria-label": "选择对象" }, artifacts.map((item) => h("button", {
								key: item.artifactId,
								type: "button",
								"aria-pressed": ui.artifactId === item.artifactId ? "true" : "false",
								className: "swb-chip",
								"data-selected": ui.artifactId === item.artifactId ? "true" : "false",
								onClick: () => patchUi({ artifactId: item.artifactId }),
							}, item.title + (item.kind ? " · " + item.kind : ""))))
							: h("div", { className: "swb-empty" }, "状态未提供对象列表（state.artifacts），可先登记创建意图。")
					),
					h("section", { className: "swb-card", "aria-label": "新建对象" },
						h("h3", { className: "swb-h3" }, "新建对象"),
						h("div", { className: "swb-row" },
							h("input", { className: "swb-input", style: { flex: "1 1 280px" }, placeholder: "描述要新建的对象（例如：30 秒产品介绍小样）", value: ui.createNote, "aria-label": "新建对象说明", onChange: (event) => patchUi({ createNote: event.target.value }) }),
							h("button", { type: "button", className: "swb-btn", "data-variant": "primary", disabled: forms.create.busy || !projectId, onClick: () => submitIntent("create", ui.createNote, null, "createNote") }, forms.create.busy ? "提交中…" : "登记创建意图")
						),
						h("div", { className: "swb-hint" }, "v0.1 的 UI 没有直接的 artifact_create 路由（契约 §7）：这里登记 creative_brief 意图（不带 artifact_id）请求 Agent 创建对象。"),
						formMessage("create")
					),
					h("section", { className: "swb-card", "aria-label": "目标与自主范围" },
						h("h3", { className: "swb-h3" }, "当前对象的目标与自主范围"),
						selectedArtifact
							? h("div", { className: "swb-hint" }, "对象：" + selectedArtifact.title + "（" + selectedArtifact.artifactId + "）")
							: h("div", { className: "swb-empty" }, "尚未选择对象：先在上一节选择，或登记创建意图。"),
						h("textarea", { className: "swb-textarea", rows: 4, value: ui.briefNote, "aria-label": "对象目标与自主范围", placeholder: "目标、要保留什么、允许多大自主范围（自由文本，保存为 creative_brief 意图）", onChange: (event) => patchUi({ briefNote: event.target.value }) }),
						h("div", { className: "swb-row" },
							h("button", { type: "button", className: "swb-btn", "data-variant": "primary", disabled: forms.brief.busy || !projectId || !selectedArtifact, onClick: () => submitIntent("brief", ui.briefNote, selectedArtifact ? selectedArtifact.artifactId : null, "briefNote") }, forms.brief.busy ? "保存中…" : "保存到 ui/intent"),
							h("span", { className: "swb-hint" }, "POST /studio/projects/:id/ui/intent · {command_id, base_revision, artifact_id?, note, intent_kind}")
						),
						formMessage("brief"),
						recentBriefs.length
							? h("div", null,
								h("div", { className: "swb-sub" }, "已登记的创作意图（只读）"),
								h("ul", { className: "swb-list" }, recentBriefs.map((item, index) => h("li", { key: item.commandId || ("brief-" + index) },
									(item.artifactId ? item.artifactId + "：" : "（新对象）：") + item.note + (item.createdAt ? " · " + item.createdAt : "")
								)))
							)
							: null
					),
					h("section", { className: "swb-card", "aria-label": "最近版本登记" },
						h("h3", { className: "swb-h3" }, "最近版本登记（只读）"),
						recent.length
							? h("table", { className: "swb-table" },
								h("thead", null, h("tr", null, ["版本", "说明", "时长", "哈希前 12 位"].map((label) => h("th", { key: label, className: "swb-th" }, label)))),
								h("tbody", null, recent.map((item) => h("tr", { key: item.versionId },
									h("td", { className: "swb-td swb-mono" }, item.versionId),
									h("td", { className: "swb-td" }, item.label),
									h("td", { className: "swb-td" }, item.durationSeconds === null ? "（未探测）" : formatNum(item.durationSeconds) + "s"),
									h("td", { className: "swb-td swb-mono" }, item.sha256 ? shortHash(item.sha256) : "（无）")
								)))
							)
							: h("div", { className: "swb-empty" }, "暂无登记版本。")
					)
				)
			}

			// ---------------- 渲染：审阅 ----------------
			function renderScopeFields() {
				if (ui.scopeKind === "time_range") {
					return h("div", { className: "swb-row" },
						h("span", { className: "swb-label" }, "半开区间 [start, end)"),
						numberField("开始 (s)", ui.tStart, (value) => patchUi({ tStart: value }), "开始秒"),
						h("span", null, "–"),
						numberField("结束 (s)", ui.tEnd, (value) => patchUi({ tEnd: value }), "结束秒"),
						h("span", { className: "swb-hint" }, rvDuration !== null ? "该版本实际时长 " + formatNum(rvDuration) + "s，end 可等于时长" : "状态未提供该版本时长，无法校验上界")
					)
				}
				if (ui.scopeKind === "region") {
					return h("div", null,
						h("div", { className: "swb-row" },
							numberField("帧时间 (s)", ui.frameSeconds, (value) => patchUi({ frameSeconds: value }), "帧时间秒"),
							numberField("x", ui.regionX, (value) => patchUi({ regionX: value }), "区域 x"),
							numberField("y", ui.regionY, (value) => patchUi({ regionY: value }), "区域 y"),
							numberField("宽", ui.regionW, (value) => patchUi({ regionW: value }), "区域宽"),
							numberField("高", ui.regionH, (value) => patchUi({ regionH: value }), "区域高")
						),
						h("div", { className: "swb-hint" }, rvWidth !== null && rvHeight !== null
							? "该版本实际尺寸 " + formatNum(rvWidth) + " × " + formatNum(rvHeight) + "（坐标基于显示尺寸 basis: display，区域须完全落在尺寸内）"
							: "状态未提供该版本宽高，无法校验区域边界")
					)
				}
				if (ui.scopeKind === "aspect") {
					return h("div", { className: "swb-row" },
						h("select", { className: "swb-select", value: ui.aspect, "aria-label": "方面", onChange: (event) => patchUi({ aspect: event.target.value }) },
							ASPECTS.map((item) => h("option", { key: item, value: item }, aspectText(item)))
						),
						h("input", { className: "swb-input", style: { flex: "1 1 260px" }, placeholder: "方面说明（必填）：例如字幕节奏太快", value: ui.aspectDesc, "aria-label": "方面说明", onChange: (event) => patchUi({ aspectDesc: event.target.value }) })
					)
				}
				return h("div", { className: "swb-hint" }, "整版范围：对该版本全部内容给出认可或修改要求。")
			}
			function renderReview() {
				if (!snapshot) return renderLoading()
				if (!snapshot.versions.length) {
					return h("section", { className: "swb-card" },
						h("h3", { className: "swb-h3" }, "审阅"),
						h("div", { className: "swb-empty" }, "还没有可审阅的版本。先由 Agent 登记候选版本（version_register），再回到这里播放并给出范围认可。")
					)
				}
				const versions = snapshot.versions
				const version = reviewVersion
				const compareVersion = findVersion(versions, ui.compareVersionId)
				const recent = version ? snapshot.decisions.filter((item) => item.versionId === version.versionId).slice(-6).reverse() : []
				const approvalTargets = version ? approvalsOf(snapshot.decisions, version.versionId) : []
				const withdrawPick = pickWithdrawTarget(approvalTargets)
				const reviewForm = forms.review
				return h("div", { className: "swb-stack" },
					h("section", { className: "swb-card", "aria-label": "播放与对照" },
						h("div", { className: "swb-row" },
							h("label", { className: "swb-field" },
								h("span", { className: "swb-label" }, "审阅版本"),
								h("select", { className: "swb-select", value: ui.reviewVersionId || "", "aria-label": "选择审阅版本", onChange: (event) => patchUi({ reviewVersionId: event.target.value }) },
									versions.map((item) => h("option", { key: item.versionId, value: item.versionId }, item.label + " · " + item.versionId + (item.versionId === snapshot.currentVersionId ? "（工作依据）" : "")))
								)
							),
							h("label", { className: "swb-field" },
								h("span", { className: "swb-label" }, "对照"),
								h("select", { className: "swb-select", value: ui.compareVersionId || "", "aria-label": "选择对照版本", onChange: (event) => patchUi({ compareVersionId: event.target.value || null }) },
									[h("option", { key: "none", value: "" }, "不启用")].concat(versions.map((item) => h("option", { key: item.versionId, value: item.versionId }, item.label + " · " + item.versionId)))
								)
							),
							h("button", { type: "button", className: "swb-btn", disabled: !ui.reviewVersionId, onClick: () => patchUi({ compareVersionId: ui.reviewVersionId }) }, "用作对照"),
							h("button", { type: "button", className: "swb-btn", disabled: !ui.compareVersionId, onClick: () => patchUi({ compareVersionId: null }) }, "清除对照")
						),
						h("div", { className: "swb-mono" }, version ? version.label + " · " + version.versionId + (version.sha256 ? " · " + shortHash(version.sha256) : "") : "未选择版本"),
						h("div", { className: "swb-hint" }, version ? versionMetaText(version) : ""),
						h("div", { className: compareVersion ? "swb-grid2" : "" },
							h("div", null,
								version && version.mediaUrl
									? h("video", {
										key: "review-" + version.versionId,
										ref: setVideoEl,
										className: "swb-video",
										src: version.mediaUrl,
										controls: true,
										preload: "metadata",
										playsInline: true,
										onLoadedMetadata: syncMedia,
										onLoadedData: syncMedia,
										onCanPlay: syncMedia,
										onPlaying: syncMedia,
										onDurationChange: syncMedia,
										onError: failMedia,
									})
									: h("div", { className: "swb-empty" }, "该版本未提供媒体地址（state.versions[i].media_url），不能播放或产生已播放的认可。"),
								h("div", { className: "swb-hint", role: "status", style: { marginTop: "4px" } }, mediaStatusText())
							),
							compareVersion ? h("div", null,
								h("div", { className: "swb-mono" }, "对照：" + compareVersion.label + " · " + compareVersion.versionId),
								compareVersion.mediaUrl
									? h("video", { key: "compare-" + compareVersion.versionId, className: "swb-video", src: compareVersion.mediaUrl, controls: true, preload: "metadata", playsInline: true })
									: h("div", { className: "swb-empty" }, "对照版本没有媒体地址。")
							) : null
						)
					),
					h("section", { className: "swb-card", "aria-label": "审阅范围与提交" },
						h("h3", { className: "swb-h3" }, "审阅范围与提交"),
						h("div", { className: "swb-row" },
							h("label", { className: "swb-field" },
								h("span", { className: "swb-label" }, "范围"),
								h("select", { className: "swb-select", value: ui.scopeKind, "aria-label": "审阅范围类型", onChange: (event) => patchUi({ scopeKind: event.target.value }) },
									h("option", { value: "full_version" }, "整版"),
									h("option", { value: "time_range" }, "时间段"),
									h("option", { value: "region" }, "画面区域"),
									h("option", { value: "aspect" }, "方面")
								)
							),
							h("span", { className: "swb-hint" }, "范围按当前审阅版本的实际媒体元数据初始化；切换版本会重新绑定。")
						),
						renderScopeFields(),
						h("div", { className: "swb-row" },
							h("input", { className: "swb-input", style: { flex: "1 1 300px" }, placeholder: "说明（可选）：为什么、要保留什么", value: ui.note, "aria-label": "决定说明", onChange: (event) => patchUi({ note: event.target.value }) })
						),
						approvalTargets.length
							? h("div", { className: "swb-row" },
								h("label", { className: "swb-field" },
									h("span", { className: "swb-label" }, "撤回目标认可"),
									h("select", { className: "swb-select", value: withdrawPick ? withdrawPick.decisionId : "", "aria-label": "撤回目标认可", onChange: (event) => patchUi({ withdrawDecisionId: event.target.value || null }) },
										approvalTargets.map((item) => h("option", { key: item.decisionId, value: item.decisionId }, item.decisionId + " · " + scopeText(item.scope) + (item.createdAt ? " · " + item.createdAt : "")))
									)
								),
								h("span", { className: "swb-hint" }, "撤回会带上该记录的范围（target: {decision_id}）；只撤回所选的这一条。")
							)
							: h("div", { className: "swb-hint" }, "该版本没有可撤回的有效认可记录。"),
						h("div", { className: "swb-row", style: { marginTop: "8px" } },
							h("button", { type: "button", className: "swb-btn", "data-variant": "primary", disabled: reviewForm.busy || !version || !mediaReady, title: mediaReady ? "" : "媒体未加载，不能产生已播放的认可", onClick: () => submitDecision("partial_approval") }, reviewForm.busy ? "提交中…" : "提交用户认可（partial_approval）"),
							h("button", { type: "button", className: "swb-btn", disabled: reviewForm.busy || !version, onClick: () => submitDecision("change_request") }, "提交修改要求（change_request）"),
							h("button", { type: "button", className: "swb-btn", "data-variant": "danger", disabled: reviewForm.busy || !version || !withdrawPick, title: withdrawPick ? "" : "该版本没有可撤回的认可记录", onClick: () => submitDecision("withdraw") }, "撤回此版本认可（withdraw）")
						),
						!mediaReady ? h("div", { className: "swb-warnbox", role: "note" }, "媒体未加载，不能产生已播放的认可。请先播放/等待就绪（readyState ≥ 2）；修改要求不要求已播放。") : null,
						formMessage("review"),
						h("div", { className: "swb-hint", style: { marginTop: "6px" } }, "POST /studio/projects/:id/ui/decision · 扁平 body：command_id / base_revision / version_id / decision_kind / scope / note? / media_ready / artifact_id? / target? · 主体由宿主按浏览器通道赋值（前端不发送 principal）")
					),
					h("section", { className: "swb-card", "aria-label": "该版本的记录" },
						h("h3", { className: "swb-h3" }, "该版本的记录（只读）"),
						recent.length
							? h("ul", { className: "swb-list" }, recent.map((item) => h("li", { key: item.decisionId }, decisionLine(item))))
							: h("div", { className: "swb-empty" }, "该版本还没有决定记录。")
					)
				)
			}

			// ---------------- 渲染：资产 ----------------
			function renderAssets() {
				if (!snapshot) return renderLoading()
				const versions = snapshot.versions
				const references = snapshot.references
				const selectedArtifact = findArtifact(snapshot.artifacts, ui.artifactId)
				return h("div", { className: "swb-stack" },
					h("section", { className: "swb-card", "aria-label": "项目材料" },
						h("h3", { className: "swb-h3" }, "项目材料（源快照入口）"),
						versions.length
							? h("table", { className: "swb-table" },
								h("thead", null, h("tr", null, ["版本", "说明", "源快照"].map((label) => h("th", { key: label, className: "swb-th" }, label)))),
								h("tbody", null, versions.map((item) => h("tr", { key: item.versionId },
									h("td", { className: "swb-td swb-mono" }, item.versionId),
									h("td", { className: "swb-td" }, item.label),
									h("td", { className: "swb-td" }, item.sourceUrl
										? h("a", { className: "swb-link", href: item.sourceUrl, target: "_blank", rel: "noopener noreferrer" }, "打开源快照")
										: h("span", { className: "swb-empty" }, "（未提供 source_url）"))
								)))
							)
							: h("div", { className: "swb-empty" }, "还没有版本。")
					),
					h("section", { className: "swb-card", "aria-label": "用过的确切版本" },
						h("h3", { className: "swb-h3" }, "用过的确切版本"),
						versions.length
							? h("ul", { className: "swb-list" }, versions.map((item) => h("li", { key: item.versionId },
								h("span", { className: "swb-mono" }, item.versionId),
								" · ",
								item.label,
								" · ",
								item.sha256 ? h("span", { className: "swb-mono" }, "sha256 " + item.sha256) : h("span", { className: "swb-mono" }, "（无哈希）"),
								item.durationSeconds !== null ? " · " + formatNum(item.durationSeconds) + "s" : ""
							)))
							: h("div", { className: "swb-empty" }, "还没有版本。")
					),
					h("section", { className: "swb-card", "aria-label": "选中引用" },
						h("h3", { className: "swb-h3" }, "选中引用（只读）"),
						h("div", { className: "swb-kv" },
							h("span", { className: "swb-k" }, "选中对象"), h("span", null, selectedArtifact ? selectedArtifact.title + "（" + selectedArtifact.artifactId + "）" : "（未选择）"),
							h("span", { className: "swb-k" }, "审阅版本"), h("span", null, ui.reviewVersionId || "（未选择）")
						),
						references.length
							? h("ul", { className: "swb-list" }, references.map((item, index) => h("li", { key: item.refId || ("ref-" + index) },
								item.href ? h("a", { className: "swb-link", href: item.href, target: "_blank", rel: "noopener noreferrer" }, refText(item)) : refText(item)
							)))
							: h("div", { className: "swb-empty" }, "状态未提供库引用列表（state.references）；本区只展示，不改动引用。")
					)
				)
			}

			const tabs = [
				{ key: "overview", label: "总览" },
				{ key: "create", label: "创作" },
				{ key: "review", label: "审阅" },
				{ key: "assets", label: "资产" },
			]
			let content = renderOverview()
			if (ui.tab === "create") content = renderCreate()
			else if (ui.tab === "review") content = renderReview()
			else if (ui.tab === "assets") content = renderAssets()

			return h("div", { className: "swb-root" },
				h("style", { key: "swb-style" }, CSS),
				renderTop(),
				h("div", { className: "swb-tabs", role: "tablist", "aria-label": "Studio 标签页" },
					tabs.map((tab) => h("button", {
						key: tab.key,
						type: "button",
						role: "tab",
						id: "swb-tab-" + tab.key,
						className: "swb-tab",
						"aria-selected": ui.tab === tab.key ? "true" : "false",
						"aria-controls": "swb-panel-" + tab.key,
						onClick: () => patchUi({ tab: tab.key }),
					}, tab.label))
				),
				h("div", { className: "swb-body", role: "tabpanel", id: "swb-panel-" + ui.tab, "aria-labelledby": "swb-tab-" + ui.tab },
					stateError && snapshot ? h("div", { className: "swb-banner", role: "alert" }, "状态刷新失败（上方显示上次结果）：" + stateError) : null,
					content
				)
			)
		}

		function PanelIcon() {
			return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, stroke: "currentColor", strokeWidth: 1.2 }),
				h("path", { d: "M6.5 5.8l4 2.2-4 2.2z", fill: "currentColor" })
			)
		}
		function apply(ctx) {
			ctxRef = ctx
			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, Workbench))
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 3, label: "Studio" }, PanelIcon))
		}
		exports.PANEL_ID = PANEL_ID
		exports.apply = apply
		exports.inject = ["slots", "layout"]
		return module.exports
	}
})
