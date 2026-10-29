/**
 * Spine mascot asset contract.
 *
 * The runtime is loaded behind this boundary. A missing or broken export falls
 * back to the layered WebP rig without blanking the composer.
 *
 * Assets are generated from the approved V2 artwork by
 * `docs/internal/design/mascot-v2/build_spine_rig.py`.
 */

export type SpineMascotSpecies = 'cat' | 'corgi';

/**
 * Looping states (track 0). dangle: held up by the mouse while it is dragged.
 * Following the agent: think (paw under the chin), type
 * (tools running, on a little laptop), write (writing a reply in a notebook), point
 * (needs the user: standing beside the approval strip, pointing at it), alert, sad.
 */
export type SpineMascotBaseAnimation =
  | 'idle' | 'watch' | 'sleep' | 'dangle' | 'think' | 'type' | 'write' | 'point' | 'alert' | 'sad';

/**
 * One-shots layered over the base state. pat reaches down onto the composer text,
 * flinch is the ears-up startle at a failure, cover hides the face after one,
 * work drums the ledge while tools run, nod acknowledges a send; yawn, phone,
 * sip and stretch fill the idle time; jump hops right off the ledge for joy; smile
 * blushes at something nice, fume goes red in the face when failures pile up, ears
 * is a curious ear twitch.
 */
export type SpineMascotGesture =
  | 'pet' | 'wave' | 'turn' | 'tap' | 'celebrate' | 'scoot' | 'pat' | 'flinch' | 'work' | 'nod'
  | 'cover' | 'yawn' | 'phone' | 'sip' | 'jump' | 'stretch' | 'smile' | 'fume' | 'ears';

/**
 * stand / perch switch the whole-body layer: off the composer it sits up on its hips
 * and hind legs (an additive track over whatever the base clip does); perched on
 * the composer it is a bust again.
 */
export type SpineMascotPosture = 'stand' | 'perch';

export type SpineMascotAnimation = SpineMascotBaseAnimation | SpineMascotGesture | SpineMascotPosture | 'blink';

/** Which paw waves / taps, or which way the head turns (viewer's left/right). */
export type SpineMascotSide = 'left' | 'right';

export const SPINE_BASE_ANIMATIONS: readonly SpineMascotAnimation[] = [
  'idle', 'watch', 'sleep', 'dangle', 'think', 'type', 'write', 'point', 'alert', 'sad',
];

/**
 * Room around the box, in skeleton units: the canvas extends this far below the
 * mascot box and to either side, so an arm reaching out onto the composer text
 * (pat) is not clipped, and above it, where the head goes when it sits up on its
 * whole body. Keep in sync with --mascot-spine-pad-* in mascot.css.
 */
export const SPINE_CANVAS_PAD_BOTTOM = 130;
export const SPINE_CANVAS_PAD_X = 200;
export const SPINE_CANVAS_PAD_TOP = 180;

/**
 * Where the authored pat clip lands, relative to the resting wrist (skeleton
 * units, y up, left paw; PAT_REACH in build_spine_rig.py). The runtime moves the
 * landing onto the real text, never further than SPINE_PAT_MAX_REACH from the wrist.
 */
export const SPINE_PAT_REACH = { x: -18, y: -52 } as const;
/** About a third longer than the resting forearm: the paw touches the words, the arm does not stretch. */
export const SPINE_PAT_MAX_REACH = 62;

export interface SpineMascotAsset {
  /** Runtime-compatible Spine export version. */
  spineVersion: string;
  /** URL of the .json export, relative to the renderer document. */
  skeleton: string;
  /** URL of the .atlas export; its page images sit next to it. */
  atlas: string;
  /** Source canvas in skeleton units; the DOM rig uses the same 480x397 box. */
  width: number;
  height: number;
}

/** A point on screen (client pixels) for a reaching clip to land on. */
export interface SpineMascotReach {
  clientX: number;
  clientY: number;
}

export interface SpineMascotRuntime {
  play(animation: SpineMascotAnimation, side?: SpineMascotSide, reach?: SpineMascotReach): void;
  /** Authored length of a clip in seconds, 0 when the export lacks it. */
  gestureDuration(animation: SpineMascotAnimation, side?: SpineMascotSide): number;
  /** Gaze offset in source-canvas units (same scale the SVG eyes use). */
  setLookAt(x: number, y: number): void;
  /** 说话口型: 0~1 播放音量选嘴型 (闭 / 小 o / 张开); null = 嘴交还给动画 */
  setMouthLevel(level: number | null): void;
  /** Stops the frame loop and settles on the idle pose. */
  setPaused(paused: boolean): void;
  resize(): void;
  dispose(): void;
}

export interface SpineMascotRuntimeFactory {
  (canvas: HTMLCanvasElement, asset: SpineMascotAsset, species: SpineMascotSpecies): Promise<SpineMascotRuntime>;
}

export const SPINE_ANIMATION_EVENT = 'neox-mascot:spine-animation';
export const SPINE_LOOK_AT_EVENT = 'neox-mascot:spine-look-at';

export interface SpineAnimationEventDetail {
  animation: SpineMascotAnimation;
  side?: SpineMascotSide;
  /** pat: the text to land on. Without it the clip lands where it was authored. */
  reach?: SpineMascotReach;
}

/**
 * `mascots/` is the renderer's publicDir root (vite.config.ui.ts), so these
 * resolve next to index.html in dev and in the packaged build alike.
 */
export const SPINE_MASCOT_ASSETS: Partial<Record<SpineMascotSpecies, SpineMascotAsset>> = {
  cat: {
    spineVersion: '4.3.13',
    skeleton: 'mascots/spine/cat/cat.json',
    atlas: 'mascots/spine/cat/cat.atlas',
    width: 480,
    height: 397,
  },
  corgi: {
    spineVersion: '4.3.13',
    skeleton: 'mascots/spine/corgi/corgi.json',
    atlas: 'mascots/spine/corgi/corgi.atlas',
    width: 480,
    height: 397,
  },
};

export function hasSpineMascotAsset(species: SpineMascotSpecies): boolean {
  return Boolean(SPINE_MASCOT_ASSETS[species]);
}
