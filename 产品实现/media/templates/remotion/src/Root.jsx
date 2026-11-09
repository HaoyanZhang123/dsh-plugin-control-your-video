/**
 * Composition registration. The plan is bundled as JSON so the composition's duration, size and
 * rate come from the same document the plugin validated — the renderer never re-derives timing.
 */
import { Composition } from 'remotion'
import plan from './plan.json'
import { Unit } from './Unit.jsx'

export function Root() {
  const rate = plan.outputSpec.fpsNumerator / plan.outputSpec.fpsDenominator
  return (
    <Composition
      id="C12Unit"
      component={Unit}
      durationInFrames={plan.timebase.totalFrames}
      fps={rate}
      width={plan.outputSpec.width}
      height={plan.outputSpec.height}
      defaultProps={{ plan }}
    />
  )
}
