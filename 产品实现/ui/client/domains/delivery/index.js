/**
 * Mounting and registration of the delivery domain view.
 *
 * The view reads ONE thing: the newest `delivery.projection` in the project's own event stream,
 * through the route the workbench already exposes (`/projects/events`). No new host route, no second
 * fact source, no write.
 *
 * Registration is deliberately a shell-held registry, exactly like the creation and review domains:
 * the surface decision belongs to C11/总控, so this card adds no panel, no navigation entry and no
 * tenth effect. A refused registration is reported instead of hidden.
 *
 * @module ui/client/domains/delivery/index
 */

/** The shell-held registry this domain registers into. */
export const DELIVERY_DOMAIN_REGISTRY = { component: null, mountedAt: null }

/** The client-side matcher for the event kind C15 publishes. */
export const DELIVERY_PROJECTION_KIND = 'delivery.projection'

/**
 * Find the newest delivery projection in a list of project events.
 * @param {any[]} events
 * @returns {any|null}
 */
export function newestDeliveryProjection(events) {
  if (!Array.isArray(events)) return null
  let latest = null
  let latestSequence = -1
  for (const event of events) {
    if (event?.kind !== DELIVERY_PROJECTION_KIND) continue
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

/** The section the shell renders once it has a mounting surface. */
export function DeliveryDomainSection() {
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
        setRead({ loading: false, projection: newestDeliveryProjection(events), error: null })
      })
      .catch((error) => {
        if (cancelled) return
        setRead({ loading: false, projection: null, error: `读取项目事件失败：${error?.message ?? error}` })
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return h(DeliveryDomainView, {
    loading: read.loading,
    projection: read.projection,
    error: read.error,
    notice: '只读投影：数据来自项目事件流；导出、确认与清理要接上真实交互后才出现。',
  })
}

/**
 * Set the delivery domain into the shell registry, once, through an effect the shell can dispose.
 *
 * @param {any} ctx the Host plugin context
 * @returns {{ status: {mode: string, registered: boolean, reason: string|null}, dispose: () => void }}
 */
export function registerDeliveryDomain(ctx) {
  const status = { mode: 'shell-registry', registered: false, reason: null }
  if (ctx === null || typeof ctx !== 'object') {
    status.reason = '没有 Host 上下文'
    return { status, dispose: () => {} }
  }
  DELIVERY_DOMAIN_REGISTRY.component = DeliveryDomainSection
  DELIVERY_DOMAIN_REGISTRY.mountedAt = new Date().toISOString()
  status.registered = true
  return {
    status,
    dispose: () => {
      // Disposing removes THIS registration and nothing else; a later registration is untouched.
      if (DELIVERY_DOMAIN_REGISTRY.component === DeliveryDomainSection) {
        DELIVERY_DOMAIN_REGISTRY.component = null
        DELIVERY_DOMAIN_REGISTRY.mountedAt = null
      }
    },
  }
}
