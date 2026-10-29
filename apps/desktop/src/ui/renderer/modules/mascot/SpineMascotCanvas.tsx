import React, { useEffect, useRef } from 'react';
import {
  hasSpineMascotAsset,
  SPINE_ANIMATION_EVENT,
  SPINE_BASE_ANIMATIONS,
  SPINE_LOOK_AT_EVENT,
  SPINE_MASCOT_ASSETS,
  type SpineAnimationEventDetail,
  type SpineMascotAsset,
  type SpineMascotRuntime,
  type SpineMascotRuntimeFactory,
  type SpineMascotSpecies,
} from './spineMascot';

const loadDefaultRuntime: SpineMascotRuntimeFactory = async (...args) => {
  const module = await import('./createSpineWebglRuntime');
  return module.createSpineWebglRuntime(...args);
};

interface SpineMascotCanvasProps {
  species: SpineMascotSpecies;
  onReady?: (runtime: SpineMascotRuntime) => void;
  onUnavailable?: () => void;
  createRuntime?: SpineMascotRuntimeFactory;
}

/**
 * One canvas + runtime per species, kept across mounts.
 *
 * Every new chat remounts the timeline, and with it the mascot. Building the
 * runtime again means a new WebGL context, a texture upload and a JSON parse;
 * CDP measured the Spine frame landing 150-730 ms after the empty state was
 * already visible ("the pet is a beat late"). A detached canvas keeps its GL
 * context, so an unmounting mascot parks its canvas here (paused on the idle
 * pose) and the next mount of the same species re-attaches it in the same frame.
 *
 * Only the default runtime is pooled; an injected `createRuntime` (tests) gets a
 * private runtime that is disposed on unmount as before. If two mascots of one
 * species are ever mounted at once, the second gets a private runtime too.
 */
interface PooledRig {
  canvas: HTMLCanvasElement;
  runtime: Promise<SpineMascotRuntime>;
  inUse: boolean;
}
const pool = new Map<SpineMascotSpecies, PooledRig>();

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'neox-mascot__spine-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  return canvas;
}

interface Lease {
  canvas: HTMLCanvasElement;
  runtime: Promise<SpineMascotRuntime>;
  release: (runtime: SpineMascotRuntime | null) => void;
}

function lease(species: SpineMascotSpecies, asset: SpineMascotAsset, factory?: SpineMascotRuntimeFactory): Lease {
  const pooled = factory ? undefined : pool.get(species);
  if (pooled && !pooled.inUse) {
    pooled.inUse = true;
    return {
      canvas: pooled.canvas,
      runtime: pooled.runtime,
      release: (runtime) => { park(pooled, runtime); },
    };
  }
  const canvas = createCanvas();
  const runtime = (factory ?? loadDefaultRuntime)(canvas, asset, species);
  if (!factory && !pooled) {
    const entry: PooledRig = { canvas, runtime, inUse: true };
    pool.set(species, entry);
    // A rig that failed to load must not be handed out again.
    runtime.catch(() => { if (pool.get(species) === entry) pool.delete(species); });
    return { canvas, runtime, release: (created) => { park(entry, created); } };
  }
  return {
    canvas,
    runtime,
    release: (created) => {
      if (created) created.dispose();
      else void runtime.then((late) => late.dispose(), () => {});
      /* 私有画布也要摘掉: 换物种时宿主节点还在, 不摘的话旧的那只停在新的这只下面露出一圈边 */
      canvas.remove();
    },
  };
}

function park(entry: PooledRig, runtime: SpineMascotRuntime | null): void {
  entry.inUse = false;
  // Paused = settled on idle and no frame loop, so a parked rig costs nothing.
  runtime?.setPaused(true);
  entry.canvas.remove();
}

/**
 * Renderer boundary for the authored Spine rig.
 *
 * Driven entirely by DOM events on the `.neox-mascot` root (see
 * useMascotMotion), so the motion code never imports WebGL. The frame loop
 * follows the root's `data-motion`: when motion is off (hidden, offscreen,
 * reduced motion) the runtime settles on idle and stops repainting.
 */
export default function SpineMascotCanvas({
  species,
  onReady,
  onUnavailable,
  createRuntime,
}: SpineMascotCanvasProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const callbacks = useRef({ onReady, onUnavailable });
  callbacks.current = { onReady, onUnavailable };

  useEffect(() => {
    const host = hostRef.current;
    const asset = SPINE_MASCOT_ASSETS[species];
    if (!host || !asset) {
      callbacks.current.onUnavailable?.();
      return undefined;
    }
    let alive = true;
    let runtime: SpineMascotRuntime | null = null;
    const held = lease(species, asset, createRuntime);
    const { canvas } = held;
    host.appendChild(canvas);
    const root = host.closest<HTMLElement>('.neox-mascot');
    /* The looping state the motion code last asked for. It is sent before the rig
       finishes loading, and a pause settles the rig on idle; both would otherwise
       leave a sad / thinking pet showing idle until the next state change. */
    let base: SpineAnimationEventDetail | null = null;
    let posture: 'stand' | 'perch' = 'perch';
    const syncMotion = () => {
      if (!runtime) return;
      const paused = root?.dataset.motion !== 'on';
      runtime.setPaused(paused);
      if (!paused && base) runtime.play(base.animation, base.side);
      if (!paused) runtime.play(posture);
    };
    const onAnimation = (event: Event) => {
      const detail = (event as CustomEvent<SpineAnimationEventDetail>).detail;
      if (!detail?.animation) return;
      if (SPINE_BASE_ANIMATIONS.includes(detail.animation)) base = { ...detail };
      if (detail.animation === 'stand' || detail.animation === 'perch') posture = detail.animation;
      runtime?.play(detail.animation, detail.side, detail.reach);
    };
    const onLookAt = (event: Event) => {
      const detail = (event as CustomEvent<{ x?: number; y?: number }>).detail;
      runtime?.setLookAt(detail?.x ?? 0, detail?.y ?? 0);
    };
    const resize = new ResizeObserver(() => runtime?.resize());
    const motion = new MutationObserver(syncMotion);
    root?.addEventListener(SPINE_ANIMATION_EVENT, onAnimation);
    root?.addEventListener(SPINE_LOOK_AT_EVENT, onLookAt);
    if (root) motion.observe(root, { attributes: true, attributeFilter: ['data-motion'] });
    resize.observe(canvas);

    const attach = (created: SpineMascotRuntime) => {
      if (!alive) return;
      runtime = created;
      created.resize();
      syncMotion();
      callbacks.current.onReady?.(created);
    };
    held.runtime.then(attach).catch((error) => {
      if (!alive) return;
      console.warn('[mascot] Spine rig unavailable, keeping the layered fallback:', error);
      callbacks.current.onUnavailable?.();
    });

    return () => {
      alive = false;
      resize.disconnect();
      motion.disconnect();
      root?.removeEventListener(SPINE_ANIMATION_EVENT, onAnimation);
      root?.removeEventListener(SPINE_LOOK_AT_EVENT, onLookAt);
      held.release(runtime);
      runtime = null;
    };
  }, [createRuntime, species]);

  if (!hasSpineMascotAsset(species)) return null;
  return <span ref={hostRef} className="neox-mascot__spine-host" aria-hidden="true" />;
}
