/**
 * Mounting and registration of the creation domain view.
 *
 * The view reads ONE thing: the newest `creation.projection` in the project's own event stream,
 * through the route the workbench already exposes. No new host route, no second fact source.
 *
 * Registration is deliberately inert until 总控 rules on the surface: the shell asks for the slot
 * `workbench.creation-domain`, records whether the Host accepted it, and never falls back to
 * drawing somewhere else. A refused slot is reported as `registered: false` instead of being
 * hidden, because a view that silently does not exist is worse than one that says so.
 *
 * @module ui/client/domains/creation/index
 */

/**
 * The shell-held registry this domain registers into.
 *
 * Deliberately NOT a new slot and NOT a navigation entry: the surface decision belongs to 总控, and
 * pushing a slot into `apply` would change the shell's declared slot set behind that decision's
 * back. The registry gives the view a real, disposable registration without choosing a surface.
 */
export const CREATION_DOMAIN_REGISTRY = { component: null, mountedAt: null }

/** The client-side matcher for the projection event kind C13 publishes. */
export const CREATION_PROJECTION_KIND = 'creation.projection'

/**
 * Find the newest projection in a list of project events.
 * @param {any[]} events
 * @returns {any|null}
 */
export function newestProjection(events) {
  if (!Array.isArray(events)) return null
  let latest = null
  let latestSequence = -1
  for (const event of events) {
    if (event?.kind !== CREATION_PROJECTION_KIND) continue
    if (event.detail === null || typeof event.detail !== 'object') continue
    // `/projects/events` answers newest-first; the sequence, not the array position, decides.
    const sequence = Number.isInteger(event.sequence) ? event.sequence : Number.MAX_SAFE_INTEGER
    if (sequence >= latestSequence) {
      latestSequence = sequence
      latest = event.detail
    }
  }
  return latest
}

/** The section the shell would render when the slot is granted. */
export function CreationDomainSection() {
  const state = useStoreState()
  const projectId = state.projectId ?? state.project?.project?.projectId ?? null
  const [read, setRead] = React.useState({ loading: projectId !== null, projection: null, error: null })

  React.useEffect(() => {
    if (projectId === null) {
      setRead({ loading: false, projection: null, error: null })
      return undefined
    }
    let cancelled = false
    setRead((current) => ({ ...current, loading: true }))
    Api.events(projectId, 200)
      .then((payload) => {
        if (cancelled) return
        const events = Array.isArray(payload) ? payload : (payload?.events ?? [])
        setRead({ loading: false, projection: newestProjection(events), error: null })
      })
      .catch((error) => {
        if (cancelled) return
        setRead({ loading: false, projection: null, error: `读取项目事件失败：${error?.message ?? error}` })
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return h(CreationDomainView, {
    loading: read.loading,
    projection: read.projection,
    error: read.error,
    notice: '本视图面位待总控裁定；当前不占用导航入口。',
  })
}

/**
 * Ask the shell for the domain slot, once, through an effect the shell can dispose.
 *
 * @param {any} ctx the Host plugin context
 * @returns {{ status: {slot: string, registered: boolean, reason: string|null}, dispose: () => void }}
 */
export function registerCreationDomain(ctx) {
  const status = { mode: 'shell-registry', registered: false, reason: null }
  if (ctx === null || typeof ctx !== 'object') {
    status.reason = '没有 Host 上下文'
    return { status, dispose: () => {} }
  }
  CREATION_DOMAIN_REGISTRY.component = CreationDomainSection
  CREATION_DOMAIN_REGISTRY.mountedAt = new Date().toISOString()
  status.registered = true
  return {
    status,
    dispose: () => {
      // Disposing removes THIS registration and nothing else; a later registration is untouched.
      if (CREATION_DOMAIN_REGISTRY.component === CreationDomainSection) {
        CREATION_DOMAIN_REGISTRY.component = null
        CREATION_DOMAIN_REGISTRY.mountedAt = null
      }
    },
  }
}
