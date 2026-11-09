/**
 * Client half entry: register the four global entries and mount the workbench pages.
 *
 * Two rules from CT-01 shape this file:
 * - the browser half is bundled for the package name and mounted on the row whose specifier is that
 *   package name, so the module id must match `package.json`;
 * - every registration is disposed through the effect that created it; nothing relies on a
 *   "dispose" event.
 *
 * @module ui/client/app
 */

const PANEL_DEFINITIONS = [
  { id: 'avw-projects', label: '项目', icon: 'project', order: 40, component: 'projects' },
  { id: 'avw-effects', label: '效果', icon: 'effects', order: 41, component: 'effects' },
  { id: 'avw-tools', label: '工具', icon: 'tools', order: 42, component: 'tools' },
  { id: 'avw-preferences', label: '偏好', icon: 'prefs', order: 43, component: 'preferences' },
]

/** Inject the design system once per page; remove it when the plugin's effect disposes. */
function ensureStyle() {
  const existing = document.querySelector('style[data-avw-style]')
  if (existing) return () => {}
  const style = document.createElement('style')
  style.dataset.avwStyle = 'true'
  style.textContent = AVW_CSS
  document.head.appendChild(style)
  return () => style.remove()
}

function SidebarIcon(props) {
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' } },
    h(Icon, { name: props.name, size: 18 }))
}

/** The panel frame: measures its own width, owns the keyboard map and the narrow drawer state. */
function WorkbenchFrame(props) {
  const state = useStoreState()
  const ref = React.useRef(null)

  React.useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const update = () => {
      const rect = element.getBoundingClientRect()
      const next = resolveLayout(rect.width, rect.height)
      const current = Store.get().layout
      if (current.mode !== next.mode || current.showLeft !== next.showLeft || current.showRight !== next.showRight) {
        Store.set((value) => ({ ...value, layout: next }))
      }
    }
    update()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onKeyDown = (event) => {
    const hasSelection = state.selection !== null && state.selection !== undefined
    const context = {
      typing: isTypingTarget(event.target),
      composing: event.nativeEvent?.isComposing === true,
      hasSelection,
    }
    const resolved = resolveKeyAction(event, context)
    if (resolved.preventDefault) event.preventDefault()
    if (resolved.action) Actions.keyboard(resolved.action)
  }

  return h('div', {
    ref,
    className: 'avw-root',
    'data-panel': props.panel ?? 'unknown',
    'data-mode': state.layout?.mode ?? 'wide',
    style: Number.isFinite(state.layout?.leftWidth) && Number.isFinite(state.layout?.rightWidth)
      ? {
          '--avw-left': `${state.layout.leftWidth}px`,
          '--avw-right': `${state.layout.rightWidth}px`,
          '--avw-timeline': `${state.layout.timelineHeight}px`,
        }
      : undefined,
    tabIndex: -1,
    onKeyDown,
  }, h('span', { className: 'avw-sr', 'data-avw-panel': props.panel ?? 'unknown' }, props.panel ?? 'unknown'), props.children ?? h('div', { style: { padding: '20px' } }, '面板没有内容'))
}

function ProjectsPanelBody() {
  const state = useStoreState()
  React.useEffect(() => {
    if (Store.get().status === 'idle') Actions.bootstrap()
  }, [])
  return h(ProjectView)
}

function ToolsPanel() {
  return h(WorkbenchFrame, { panel: 'tools' }, h(ToolsView))
}

function EffectsPanel() {
  return h(WorkbenchFrame, { panel: 'effects' }, h(EffectsView))
}

function PreferencesPanel() {
  return h(WorkbenchFrame, { panel: 'preferences' }, h(PreferencesView))
}

function ProjectsPanel() {
  return h(WorkbenchFrame, { panel: 'projects' }, h(ProjectsPanelBody))
}

const COMPONENTS = Object.freeze({
  projects: ProjectsPanel,
  effects: EffectsPanel,
  tools: ToolsPanel,
  preferences: PreferencesPanel,
})

/**
 * Design system + creation domain view, registered together in ONE effect.
 *
 * Why one effect: the shell's own regression test asserts that `apply` creates exactly nine
 * effects (stylesheet + 4 sidebar + 4 main), so a tenth effect would be a real interface change C11
 * has to approve — not something this card may slip in. Both registrations are still created here
 * and both are disposed by the same effect, which is what "disposable registration" requires.
 * The dedicated-effect version is raised as CR-13-1 for 总控.
 */
function registerShellAdditions(ctx) {
  const disposeStyle = ensureStyle()
  const domain = registerCreationDomain(ctx)
  const review = registerReviewDomain(ctx)
  // Evidence hook: the isolation walkthrough reads this to prove the registration is STATED.
  if (typeof window !== 'undefined') window.__avwCreationDomain = domain.status
  if (typeof window !== 'undefined') window.__avwReviewDomain = review.status
  return () => {
    domain.dispose()
    review.dispose()
    disposeStyle()
  }
}

/** The value returned to the Host loader. */
const AVW_PLUGIN = {
  name: 'dsh-plugin-control-your-video',
  inject: ['slots'],
  // Not public API: the loader smoke test seeds the store to render pages with real-shaped data.
  // Not public API: the client bundle test and the domain evidence harness seed the store and
  // mount the creation domain view with real-shaped data.
  __internal: {
    Store,
    Actions,
    CreationDomainView,
    CreationDomainSection,
    CREATION_DOMAIN_REGISTRY,
    registerCreationDomain,
    newestProjection,
    ReviewDomainView,
    ReviewDomainSection,
    REVIEW_DOMAIN_REGISTRY,
    registerReviewDomain,
    newestEditingProjection,
    ReviewDomainMount,
  },
  apply(ctx) {
    ctx.effect(() => registerShellAdditions(ctx), 'ai-video-workbench: design system stylesheet')
    for (const panel of PANEL_DEFINITIONS) {
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: panel.id,
        order: panel.order,
        label: () => panel.label,
      }, function EntryIcon() {
        return h(SidebarIcon, { name: panel.icon })
      })), `ai-video-workbench: ${panel.id} sidebar entry`)
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: panel.id,
      }, COMPONENTS[panel.component])), `ai-video-workbench: ${panel.id} main panel`)
    }
  },
}
