import {
  AnimationState,
  AnimationStateData,
  AssetManager,
  AtlasAttachmentLoader,
  ManagedWebGLRenderingContext,
  Physics,
  ResizeMode,
  SceneRenderer,
  Skeleton,
  SkeletonJson,
  type Bone,
  type TextureAtlas,
} from '@esotericsoftware/spine-webgl';
import {
  SPINE_BASE_ANIMATIONS,
  SPINE_CANVAS_PAD_BOTTOM,
  SPINE_CANVAS_PAD_TOP,
  SPINE_CANVAS_PAD_X,
  SPINE_PAT_MAX_REACH,
  SPINE_PAT_REACH,
  type SpineMascotAnimation,
  type SpineMascotReach,
  type SpineMascotRuntime,
  type SpineMascotRuntimeFactory,
  type SpineMascotSide,
} from './spineMascot';

const TRACK_BASE = 0;
const TRACK_GESTURE = 1;
const TRACK_BLINK = 2;
/** The whole-body layer (stand), added on top of the other tracks. */
const TRACK_POSTURE = 3;
const MIX_POSTURE = 0.4;

/** Seconds; the authored keys already ease in/out, these only blend between clips. */
const MIX_IN = 0.18;
const MIX_OUT = 0.32;
const MIX_BASE = 0.45;

/** Canvas units the eyes may travel, and how much of the gaze the head follows. */
const EYE_TRAVEL = 1;
const HEAD_TURN_PER_UNIT = 0.42;
const HEAD_SHIFT_PER_UNIT = 0.3;

/**
 * Spine WebGL adapter for the composer mascots.
 *
 * Owns its own frame loop instead of SpineCanvas: the loop stops whenever the
 * mascot is paused (motion off, reduced motion, window hidden), so an idle app
 * does not keep a WebGL canvas repainting at 60 Hz forever.
 */
export const createSpineWebglRuntime: SpineMascotRuntimeFactory = async (canvas, asset) => {
  const context = new ManagedWebGLRenderingContext(canvas, {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    preserveDrawingBuffer: false,
  });
  const renderer = new SceneRenderer(canvas, context, true);
  const assets = new AssetManager(context);
  let disposed = false;

  const teardown = () => {
    disposed = true;
    assets.dispose();
    renderer.dispose();
  };

  let skeleton: Skeleton;
  let state: AnimationState;
  try {
    const [atlas, json] = await Promise.all([
      assets.loadTextureAtlasAsync(asset.atlas) as Promise<TextureAtlas>,
      assets.loadJsonAsync(asset.skeleton),
    ]);
    if (disposed) throw new Error('Spine runtime disposed during load');
    const data = new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(json);
    skeleton = new Skeleton(data);
    skeleton.setupPose();
    const stateData = new AnimationStateData(data);
    stateData.defaultMix = MIX_IN;
    // Base clips as exported, sided ones (point-left / point-right) included.
    const bases = data.animations.map(a => a.name)
      .filter(n => SPINE_BASE_ANIMATIONS.some(b => n === b || n === `${b}-left` || n === `${b}-right`));
    for (const a of bases) {
      for (const b of bases) if (a !== b) stateData.setMix(a, b, MIX_BASE);
    }
    state = new AnimationState(stateData);
    state.setAnimation(TRACK_BASE, 'idle', true);
  } catch (error) {
    teardown();
    throw error;
  }

  const head = skeleton.findBone('head');
  const eyes = [skeleton.findBone('eye-left'), skeleton.findBone('eye-right')].filter(
    (bone): bone is Bone => Boolean(bone),
  );
  /** Exported name of the looping base clip (point-left, not point). */
  let base = 'idle';
  let standing = false;
  let targetX = 0;
  let targetY = 0;
  let lookX = 0;
  let lookY = 0;
  let paused = false;
  let frame = 0;
  let last = 0;

  const has = (name: string) => Boolean(skeleton.data.findAnimation(name));
  const resolve = (animation: SpineMascotAnimation, side?: SpineMascotSide) => {
    if (side && has(`${animation}-${side}`)) return `${animation}-${side}`;
    if (has(animation)) return animation;
    if (has(`${animation}-left`)) return `${animation}-left`;
    return null;
  };

  // The canvas reaches past the box by the pads (see mascot.css).
  const viewWidth = asset.width + 2 * SPINE_CANVAS_PAD_X;
  const viewHeight = asset.height + SPINE_CANVAS_PAD_BOTTOM + SPINE_CANVAS_PAD_TOP;
  const layout = () => {
    // Stretch: backing store follows CSS size x DPR, the camera keeps world units.
    // (FitClip would set the camera viewport in device pixels and zoom in.) The
    // canvas box has the viewport's aspect ratio, so nothing is distorted.
    renderer.resize(ResizeMode.Stretch);
    renderer.camera.setViewport(viewWidth, viewHeight);
    // Skeleton origin is the bottom centre of the source canvas.
    renderer.camera.position.x = 0;
    renderer.camera.position.y = viewHeight / 2 - SPINE_CANVAS_PAD_BOTTOM;
    renderer.camera.update();
  };

  // pat retargeting: the clip is authored to land at SPINE_PAT_REACH from the
  // resting wrist; `reachShift` moves that landing onto the real text. It is
  // applied in proportion to how far out the clip has the paw, so the lift, the
  // rubs and the return keep their authored shape.
  const pawTargets = {
    left: skeleton.findBone('paw-left-target'),
    right: skeleton.findBone('paw-right-target'),
  };
  skeleton.updateWorldTransform(Physics.reset);
  const restWrist = {
    left: pawTargets.left ? { x: pawTargets.left.appliedPose.worldX, y: pawTargets.left.appliedPose.worldY } : null,
    right: pawTargets.right ? { x: pawTargets.right.appliedPose.worldX, y: pawTargets.right.appliedPose.worldY } : null,
  };
  let reach: { bone: Bone; clip: string; ax: number; ay: number; dx: number; dy: number } | null = null;
  const aimReach = (clip: string, side: SpineMascotSide, at: SpineMascotReach) => {
    const bone = pawTargets[side];
    const rest = restWrist[side];
    const rect = canvas.getBoundingClientRect();
    if (!bone || !rest || !rect.width || !rect.height) return;
    const x = ((at.clientX - rect.left) / rect.width) * viewWidth - viewWidth / 2;
    const y = ((rect.bottom - at.clientY) / rect.height) * viewHeight - SPINE_CANVAS_PAD_BOTTOM;
    let wantX = x - rest.x;
    let wantY = y - rest.y;
    const length = Math.hypot(wantX, wantY);
    if (length > SPINE_PAT_MAX_REACH) {
      wantX *= SPINE_PAT_MAX_REACH / length;
      wantY *= SPINE_PAT_MAX_REACH / length;
    }
    const ax = side === 'left' ? SPINE_PAT_REACH.x : -SPINE_PAT_REACH.x;
    const ay = SPINE_PAT_REACH.y;
    reach = { bone, clip, ax, ay, dx: wantX - ax, dy: wantY - ay };
  };
  const applyReach = () => {
    if (!reach) return;
    if (state.tracks[TRACK_GESTURE]?.animation?.name !== reach.clip) {
      reach = null;
      return;
    }
    const { bone, ax, ay } = reach;
    const ox = bone.pose.x - bone.data.setupPose.x;
    const oy = bone.pose.y - bone.data.setupPose.y;
    const out = Math.max(0, Math.min(1.1, (ox * ax + oy * ay) / (ax * ax + ay * ay)));
    bone.pose.x += reach.dx * out;
    bone.pose.y += reach.dy * out;
  };

  /** null = 嘴交给动画; 0~1 = 按播放音量选嘴型 */
  let mouthLevel: number | null = null;
  const hasMouthSlot = Boolean(skeleton.findSlot('mouth'));

  const step = (delta: number) => {
    state.update(delta);
    // Procedural gaze is layered on top of whatever the clips keyed this frame.
    if (head) {
      head.pose.rotation = head.data.setupPose.rotation;
      head.pose.x = head.data.setupPose.x;
    }
    for (const eye of eyes) {
      eye.pose.x = eye.data.setupPose.x;
      eye.pose.y = eye.data.setupPose.y;
    }
    state.apply(skeleton);
    applyReach();
    if (mouthLevel !== null && hasMouthSlot) {
      const shape = mouthLevel < 0.08 ? 'mouth-cat' : mouthLevel < 0.32 ? 'mouth-o' : 'mouth-open';
      try { skeleton.setAttachment('mouth', shape); } catch { /* 这只的导出里没有这张嘴 */ }
    }
    const follow = 1 - Math.exp(-delta * 11);
    lookX += (targetX - lookX) * follow;
    lookY += (targetY - lookY) * follow;
    if (head) {
      head.pose.rotation -= lookX * HEAD_TURN_PER_UNIT;
      head.pose.x += lookX * HEAD_SHIFT_PER_UNIT;
    }
    for (const eye of eyes) {
      eye.pose.x += lookX * EYE_TRAVEL;
      eye.pose.y -= lookY * EYE_TRAVEL;
    }
    skeleton.update(delta);
    skeleton.updateWorldTransform(Physics.update);
  };

  let needsLayout = true;
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { needsLayout = true; }) : null;
  ro?.observe(canvas);
  const draw = () => {
    if (context.gl.isContextLost()) return;
    if (needsLayout || !ro) { layout(); needsLayout = false; }
    const gl = context.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.begin();
    renderer.drawSkeleton(skeleton);
    renderer.end();
  };

  /** 除了待机呼吸之外还有东西在动 (手势 / 眨眼 / 站坐切换 / 视线追随 / 口型) */
  const isBusy = (): boolean => {
    if (mouthLevel !== null) return true;
    if (Math.abs(targetX - lookX) > 0.005 || Math.abs(targetY - lookY) > 0.005) return true;
    for (const track of [TRACK_GESTURE, TRACK_BLINK, TRACK_POSTURE]) {
      const entry = state.getTrack(track);
      if (!entry) continue;
      if (entry.mixDuration > 0 && entry.mixTime < entry.mixDuration) return true;
      if (track !== TRACK_POSTURE && entry.animation && entry.animation.name !== '<empty>') return true;
    }
    return false;
  };

  const tick = (now: number) => {
    frame = 0;
    if (disposed || paused) return;
    const minGap = !document.hasFocus() ? 1000 / 8 : isBusy() ? 1000 / 30 : 1000 / 15;
    if (last && now - last < minGap - 2) {
      frame = requestAnimationFrame(tick);
      return;
    }
    // Clamp so a resumed tab does not fling the physics (上限跟着档位放宽, 否则低档会把动画拖慢).
    const delta = last ? Math.min(Math.max(0.05, (minGap * 1.5) / 1000), (now - last) / 1000) : 1 / 60;
    last = now;
    step(delta);
    draw();
    frame = requestAnimationFrame(tick);
  };

  const run = () => {
    if (disposed || paused || frame) return;
    last = 0;
    frame = requestAnimationFrame(tick);
  };

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else run();
  };
  document.addEventListener('visibilitychange', onVisibility);

  skeleton.updateWorldTransform(Physics.reset);
  step(0);
  draw();
  if (!document.hidden) run();

  const runtime: SpineMascotRuntime = {
    play(animation, side, at) {
      if (animation === 'stand' || animation === 'perch') {
        // perch has no clip: it is the posture layer mixing out.
        if ((animation === 'stand') === standing || (animation === 'stand' && !has('stand'))) return;
        standing = animation === 'stand';
        if (standing) {
          state.setEmptyAnimation(TRACK_POSTURE, 0);
          const entry = state.addAnimation(TRACK_POSTURE, 'stand', true, 0);
          entry.additive = true;
          entry.mixDuration = MIX_POSTURE;
        } else state.setEmptyAnimation(TRACK_POSTURE, MIX_POSTURE);
        run();
        return;
      }
      const name = resolve(animation, side);
      if (!name) return;
      if (SPINE_BASE_ANIMATIONS.includes(animation)) {
        if (name === base) return;
        base = name;
        state.setAnimation(TRACK_BASE, name, true);
      } else if (animation === 'blink') {
        state.setAnimation(TRACK_BLINK, name, false);
        state.addEmptyAnimation(TRACK_BLINK, 0.06, 0);
      } else {
        const entry = state.setAnimation(TRACK_GESTURE, name, false);
        entry.mixDuration = MIX_IN;
        state.addEmptyAnimation(TRACK_GESTURE, MIX_OUT, 0);
        reach = null;
        if (animation === 'pat' && at) aimReach(name, side ?? 'left', at);
      }
      run();
    },
    gestureDuration(animation, side) {
      const name = resolve(animation, side);
      return name ? skeleton.data.findAnimation(name)?.duration ?? 0 : 0;
    },
    setLookAt(x, y) {
      targetX = x;
      targetY = y;
    },
    setMouthLevel(level) {
      mouthLevel = level === null ? null : Math.max(0, Math.min(1, level));
      /* 交还给动画时要把 setup 的嘴放回去, 不然停在最后一个口型上 */
      if (level === null && hasMouthSlot) {
        const slot = skeleton.findSlot('mouth');
        const setup = slot?.data.attachmentName ?? null;
        try { skeleton.setAttachment('mouth', setup); } catch { /* ignore */ }
      }
      run();
    },
    setPaused(next) {
      if (paused === next) return;
      paused = next;
      if (paused) {
        cancelAnimationFrame(frame);
        frame = 0;
        // Settle on the calm authored pose rather than freezing mid-gesture.
        state.clearTracks();
        state.setAnimation(TRACK_BASE, 'idle', true);
        base = 'idle';
        standing = false;
        targetX = targetY = lookX = lookY = 0;
        skeleton.setupPose();
        skeleton.updateWorldTransform(Physics.reset);
        step(0);
        draw();
      } else run();
    },
    resize() {
      needsLayout = true;
      if (paused || document.hidden) draw();
    },
    dispose() {
      if (disposed) return;
      cancelAnimationFrame(frame);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      teardown();
    },
  };
  return runtime;
};
