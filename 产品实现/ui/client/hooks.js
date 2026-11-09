/**
 * Store binding for React components.
 *
 * One hook, one subscription: every panel re-renders when the store changes. The store is tiny
 * enough that selectors would be ceremony; the views read the fields they need.
 *
 * @module ui/client/hooks
 */

export function useStoreState() {
  const [state, setState] = React.useState(Store.get())
  React.useEffect(() => Store.subscribe(setState), [])
  return state
}

/** A stable callback identity for event handlers that only read the latest store. */
export function useLatest(value) {
  const ref = React.useRef(value)
  ref.current = value
  return ref
}
