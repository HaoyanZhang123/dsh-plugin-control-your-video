/**
 * The unit renderer: one CompositionPlan in, one video out.
 *
 * Ownership boundary (CT-05): the renderer only draws. Which object exists, where it is editable and
 * what an edit may touch is decided by the plugin's object layer; this file reads the plan's objects
 * and draws exactly those, keyed by the same object ids so a later inspection can name them.
 *
 * Movie-level objects (CT-04 v1.1 §2.1) are rendered OUTSIDE the TransitionSeries: a subtitle that
 * crosses a cut must not fade with the picture, and the continuous audio must never duck because a
 * cross-dissolve happens.
 */
import React, { useEffect, useRef } from 'react'
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from 'remotion'
import { Audio, Video } from '@remotion/media'
import { TransitionSeries, linearTiming } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { wipe } from '@remotion/transitions/wipe'

const fpsOf = (plan) => plan.outputSpec.fpsNumerator / plan.outputSpec.fpsDenominator
const secondsOf = (plan, frames) => frames / fpsOf(plan)

/** Opacity from a fade-in / fade-out motion spec, evaluated at a scene-local frame. */
function motionOpacity(motion, relFrame) {
  if (!motion) return 1
  const enter = motion.enter?.durationFrames ?? 0
  const hold = motion.hold?.durationFrames ?? 0
  const exit = motion.exit?.durationFrames ?? 0
  if (motion.term === 'fade-in' && enter > 0 && relFrame < enter) return relFrame / enter
  if (motion.term === 'fade-out' && exit > 0 && relFrame >= enter + hold) {
    return Math.max(0, 1 - (relFrame - enter - hold) / exit)
  }
  if (motion.term === 'fade-in' && exit > 0 && relFrame >= enter + hold) {
    return Math.max(0, 1 - (relFrame - enter - hold) / exit)
  }
  return 1
}

/** Deterministic program pattern: a seeded particle field, no Math.random anywhere. */
function ProgramPattern({ object, width, height, fps }) {
  const frame = useCurrentFrame()
  const canvasRef = useRef(null)
  const params = object.params ?? {}
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const context = canvas.getContext('2d')
    if (context === null) return
    context.clearRect(0, 0, width, height)
    let seed = (params.seed ?? 1) >>> 0
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    const count = params.count ?? 90
    for (let index = 0; index < count; index += 1) {
      const baseX = next() * width
      const baseY = next() * height
      const phase = next() * Math.PI * 2
      const speed = 0.4 + next() * 0.8
      const t = frame / fps
      const x = (baseX + Math.cos(phase + t * speed) * 6 + width) % width
      const y = (baseY + Math.sin(phase + t * speed) * 4 + height) % height
      context.fillStyle = params.hue ? `hsl(${params.hue} 90% 65% / 0.9)` : '#38bdf8'
      context.fillRect(Math.round(x), Math.round(y), 3, 3)
    }
  }, [frame, width, height, params.seed, params.count, params.hue, fps])
  return <canvas ref={canvasRef} width={width} height={height} style={{ display: 'block' }} />
}

/** Draw one scene-scoped object at its own window inside the scene. */
function SceneObject({ object, scene, plan }) {
  const frame = useCurrentFrame()
  const localStart = object.timeline.startFrame - scene.timeline.startFrame
  const localDuration = object.timeline.durationFrames
  if (frame < localStart || frame >= localStart + localDuration) return null
  const rel = frame - localStart
  const opacity = motionOpacity(object.motion, rel)
  const params = object.params ?? {}

  if (object.kind === 'video-source-with-offset' || object.kind === 'image') {
    const src = staticFile(params.staticPath)
    const style = {
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      objectFit: params.fit ?? 'cover',
      opacity: (params.opacity ?? 1) * opacity,
    }
    if (object.kind === 'image') return <img src={src} alt="" style={style} />
    return (
      <Video
        src={src}
        trimBefore={object.authored?.sourceOffsetFrames ?? 0}
        muted
        style={style}
        data-object-id={object.id}
      />
    )
  }
  if (object.kind === 'program-pattern') {
    const box = object.box ?? { x: 0, y: 0, width: 400, height: 240 }
    return (
      <div
        data-object-id={object.id}
        style={{
          position: 'absolute',
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          opacity,
        }}
      >
        <ProgramPattern object={object} width={box.width} height={box.height} fps={fpsOf(plan)} />
      </div>
    )
  }
  if (object.kind === 'program-counter') {
    return (
      <div
        data-object-id={object.id}
        style={{
          position: 'absolute',
          left: params.x ?? 0,
          top: params.y ?? 0,
          fontFamily: params.fontFamily ?? 'Microsoft YaHei',
          fontSize: params.fontSize ?? 32,
          color: params.color ?? '#fff',
          opacity,
        }}
      >
        {String(scene.timeline.startFrame + frame).padStart(3, '0')}
      </div>
    )
  }
  if (object.kind === 'text-native') {
    const anchor = params.anchor ?? 'top-left'
    const style = {
      position: 'absolute',
      fontFamily: params.fontFamily ?? 'Microsoft YaHei',
      fontSize: params.fontSize ?? 32,
      fontWeight: params.fontWeight ?? 400,
      color: params.color ?? '#fff',
      opacity,
      whiteSpace: 'pre',
      lineHeight: 1.35,
    }
    if (anchor === 'center') {
      style.left = '50%'
      style.top = params.y ?? 0
      style.transform = 'translate(-50%, -50%)'
    } else if (anchor === 'bottom-center') {
      style.left = '50%'
      style.bottom = params.safeArea?.bottomPx ?? 72
      style.transform = 'translateX(-50%)'
    } else {
      style.left = params.x ?? 0
      style.top = params.y ?? 0
    }
    return (
      <div data-object-id={object.id} style={style}>
        {params.text ?? ''}
      </div>
    )
  }
  return null
}

function Scene({ scene, plan }) {
  const background = plan.objects.find(
    (object) => object.sceneId === scene.id && object.kind === 'solid' && object.scope === 'scene',
  )
  const sceneObjects = plan.objects
    .filter((object) => object.scope === 'scene' && object.sceneId === scene.id)
    .filter((object) => object.kind !== 'solid')
    .sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0))
  return (
    <AbsoluteFill style={{ backgroundColor: background?.params?.color ?? '#000000' }}>
      {sceneObjects.map((object) => (
        <SceneObject key={object.id} object={object} scene={scene} plan={plan} />
      ))}
    </AbsoluteFill>
  )
}

function MovieLayer({ plan }) {
  const frame = useCurrentFrame()
  const movieObjects = plan.objects.filter((object) => object.scope === 'movie')
  return (
    <AbsoluteFill>
      {movieObjects
        .filter((object) => object.kind === 'subtitle' || object.kind === 'text-native')
        .map((object) => {
          const start = object.timeline.startFrame
          const end = start + object.timeline.durationFrames
          if (frame < start || frame >= end) return null
          const params = object.params ?? {}
          const style = {
            position: 'absolute',
            left: '50%',
            bottom: params.safeArea?.bottomPx ?? 72,
            transform: 'translateX(-50%)',
            fontFamily: params.fontFamily ?? 'Microsoft YaHei',
            fontSize: params.fontSize ?? 30,
            color: params.color ?? '#fff',
            background: params.backgroundColor ?? 'rgba(0,0,0,0.62)',
            borderRadius: params.borderRadius ?? 8,
            padding: '10px 18px',
            maxWidth: params.safeArea?.maxWidthPx ?? 1080,
            textAlign: 'center',
            lineHeight: 1.4,
            whiteSpace: 'pre',
          }
          return (
            <div key={object.id} data-object-id={object.id} style={style}>
              {params.text ?? ''}
            </div>
          )
        })}
    </AbsoluteFill>
  )
}

function AudioLayer({ plan }) {
  return (
    <>
      {plan.objects
        .filter((object) => object.kind === 'audio-continuous')
        .map((object) => (
          <Audio
            key={object.id}
            src={staticFile(object.params.staticPath)}
            trimBefore={object.authored?.sourceOffsetFrames ?? 0}
            volume={object.params?.volume ?? 1}
          />
        ))}
    </>
  )
}

export function Unit({ plan }) {
  const scenes = plan.scenes
  const transitions = plan.transitions ?? []
  const children = []
  scenes.forEach((scene, index) => {
    const before = transitions.find(
      (transition) => transition.toScene === scene.id && transition.fromScene === scenes[index - 1]?.id,
    )
    if (before !== undefined && before.kind !== 'cut') {
      const presentation = before.kind === 'wipe' ? wipe() : fade()
      children.push(
        <TransitionSeries.Transition
          key={`transition-${before.id}`}
          presentation={presentation}
          timing={linearTiming({ durationInFrames: before.overlapFrames })}
        />,
      )
    }
    children.push(
      <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.timeline.durationFrames}>
        <Scene scene={scene} plan={plan} />
      </TransitionSeries.Sequence>,
    )
  })
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <TransitionSeries>{children}</TransitionSeries>
      <MovieLayer plan={plan} />
      <AudioLayer plan={plan} />
    </AbsoluteFill>
  )
}
