/**
 * One tiny observable store for the whole workbench panel.
 *
 * Why not a framework: the Host hands every panel its own React root; a single store with
 * `subscribe` is enough for four pages, keeps state changes explicit, and lets the same reducer
 * logic be tested in Node. State is deliberately flat — nested per-project copies would drift from
 * the Host's answer.
 *
 * @module ui/client/store
 */

export const INITIAL_STATE = Object.freeze({
  status: 'idle',
  error: null,
  bootstrap: null,
  panel: 'projects',
  view: 'home',
  projectId: null,
  project: null,
  surface: 'creation',
  selection: null,
  rightTab: 'properties',
  assistantOpen: false,
  assistantDraft: '',
  assistantRefs: [],
  saveState: 'idle',
  lastSavedAt: null,
  toast: null,
  modal: null,
  search: '',
  searchOpen: false,
  helpOpen: false,
  layout: resolveLayout(1400, 900),
  createDraft: { title: '', idea: '' },
  busy: null,
  upload: null,
  events: null,
  tools: null,
  toolDetail: null,
  preferences: null,
  effects: null,
  playhead: 0,
  playing: false,
  composition: { available: false, reason: 'C12 尚未接入' },
})

/**
 * @param {object} [initial]
 */
export function createStore(initial = INITIAL_STATE) {
  let state = { ...initial }
  const listeners = new Set()

  function get() {
    return state
  }

  function set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch
    if (next === null || typeof next !== 'object') return state
    state = { ...state, ...next }
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // One broken subscriber must not stop the others from seeing the new state.
      }
    }
    return state
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { get, set, subscribe }
}

/** The single store this panel tree uses. Created once per module load. */
export const Store = createStore()

/** Selector helpers kept next to the store so tests can use them without a DOM. */
export function currentProject(state) {
  return state?.project ?? null
}

export function selectionLabel(state) {
  const selection = state?.selection
  if (selection === null || selection === undefined) return ''
  return selection.label ?? selection.objectId ?? ''
}

/** Queue a toast; the view clears it after a timeout. */
export function toast(state, message, tone = 'info') {
  return { ...state, toast: { message, tone, at: Date.now() } }
}
