/**
 * Registration of the real-work domain view.
 *
 * Same shape as the creation, review and delivery domains: a shell-held registry entry, created
 * once and disposed by the effect that created it. It adds no panel, no navigation entry and no
 * tenth shell effect — the surface decision stays with C11/总控, per CT-00 §5.1.
 *
 * The view reads a generated snapshot (see `snapshot.js`), not the live project store: this round
 * produced a film and its measurements, not a project with editable states. Wrapping measured
 * evidence in a fake editable project would be worse than saying "this is a record".
 *
 * @module ui/client/domains/realwork/index
 */

/** The shell-held registry this domain registers into. */
const REALWORK_DOMAIN_REGISTRY = { component: null, mountedAt: null }

/**
 * Read the generated snapshot.
 *
 * `REALWORK_SNAPSHOT` is a build-time constant produced by
 * `产品实现/acceptance/real-work/scripts/embed-snapshot.mjs` from the evidence JSON. It is null when
 * the generator could not find the measurements, and the view then reports that instead of a
 * plausible table.
 *
 * @returns {{ snapshot: any, error: string|null }}
 */
function readRealworkSnapshot() {
  if (typeof REALWORK_SNAPSHOT === 'undefined' || REALWORK_SNAPSHOT === null) {
    return { snapshot: null, error: null }
  }
  if (REALWORK_SNAPSHOT.kind !== 'c15r-realwork-snapshot') {
    return { snapshot: null, error: `快照种类不符：${String(REALWORK_SNAPSHOT.kind)}` }
  }
  return { snapshot: REALWORK_SNAPSHOT, error: null }
}

/** The section the shell renders once it mounts this domain. */
function RealworkDomainSection() {
  const read = readRealworkSnapshot()
  return h(RealworkDomainView, {
    snapshot: read.snapshot,
    error: read.error,
    notice: '只读记录：数字来自 `实施交接/证据/C15R-证据/` 的实测文件，由生成脚本写入，不在此处编辑。',
  })
}

/**
 * Put the domain into the shell registry once, through a disposal path the shell owns.
 *
 * @param {any} ctx the Host plugin context
 * @returns {{ status: {mode: string, registered: boolean, reason: string|null}, dispose: () => void }}
 */
function registerRealworkDomain(ctx) {
  const status = { mode: 'shell-registry', registered: false, reason: null }
  if (ctx === null || typeof ctx !== 'object') {
    status.reason = '没有 Host 上下文'
    return { status, dispose: () => {} }
  }
  REALWORK_DOMAIN_REGISTRY.component = RealworkDomainSection
  REALWORK_DOMAIN_REGISTRY.mountedAt = new Date().toISOString()
  status.registered = true
  return {
    status,
    dispose: () => {
      // Disposing removes THIS registration and nothing else.
      if (REALWORK_DOMAIN_REGISTRY.component === RealworkDomainSection) {
        REALWORK_DOMAIN_REGISTRY.component = null
        REALWORK_DOMAIN_REGISTRY.mountedAt = null
      }
    },
  }
}
