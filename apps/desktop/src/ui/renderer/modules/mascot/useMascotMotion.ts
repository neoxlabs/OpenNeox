import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { getMascotCaretTarget } from './mascotCaret';
import { freeOffset, measureRoamRange, offsetForCaret } from './mascotRoam';
import {
  SPINE_ANIMATION_EVENT,
  SPINE_LOOK_AT_EVENT,
  type SpineAnimationEventDetail,
  type SpineMascotAnimation,
  type SpineMascotSide,
} from './spineMascot';

/** Nobody typed, clicked or hovered for this long: the mascot dozes off. */
const SLEEP_AFTER_MS = 3 * 60_000;

/** One authored scoot clip (two hops), seconds → ms. */
const SCOOT_MS = 840;
/** Don't bother walking for less than this; small caret moves are followed by the eyes. */
const ROAM_MIN_STEP = 32;
/** Stopped typing this long (still focused): pad back to the corner and watch from there. */
const HOME_AFTER_TYPING_MS = 5000;
/** Ordinary chat replies end in a few seconds; only a real piece of work earns a celebration. */
const CELEBRATE_AFTER_MS = 6000;
const CALL_AGAIN_MS = 7000;
/** Typing pause before it may reach down and pat the words, the odds, and how rarely. */
const PAT_AFTER_PAUSE_MS = 1000;
const PAT_CHANCE = 0.85;
const PAT_COOLDOWN_MS = 8000;
/** Staying put: pat the words only when they are about this close under a paw (CSS px). */
const PAT_NEAR_PX = 60;
/** Authored clip lengths (build_spine_rig.py), ms, plus a beat to settle. */
const FLINCH_MS = 1700;
const GESTURE_MS = {
  cover: 3400, yawn: 3150, phone: 4050, sip: 3350, jump: 1650, stretch: 3050, smile: 2650, fume: 3650, ears: 1850,
} as const;

/** What the agent is up to, as far as the pet's pose is concerned. */
export type MascotMood = 'idle' | 'thinking' | 'working' | 'writing' | 'waiting' | 'error';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * Sending from the empty state swaps the composer (and its mascot) for the one
 * docked under the conversation. The new mascot starts where the old one stood
 * and walks home, so it reads as one pet going to settle, not a teleport.
 */
let handoff: { offset: number; at: number } | null = null;

/**
 * Where the user put the pet by dragging it, kept across remounts (the empty-state
 * composer handing over to the docked one): a spot along the composer edge (an
 * offset from the docked corner), or a free spot anywhere on the page (viewport px
 * of the box's top-left) where it sits up on its whole body.
 */
const placement: { homeX: number; free: { left: number; top: number } | null } = { homeX: 0, free: null };
/**
 * Picking the pet up off the composer and putting it down anywhere (it stands up on
 * its whole body there). Off for now: dragging only slides it along the composer
 * edge, and it perches where it is let go.
 */
const FREE_ROAM = false;
/** Pointer travel before a press on the pet becomes a drag instead of a click (px). */
const DRAG_START_PX = 5;
/** Dropped with its paws this close to the composer's top edge (px): it perches there. */
const SNAP_PX = 70;

/** Browser-native interpolation; no per-frame React state or frame-swapped character images. */
export function mountMascotMotion(
  root: HTMLElement, composer: HTMLElement | null, species: 'cat' | 'corgi', initiallyBusy = false,
  initiallyStayPut = false,
) {
  let alive = true;
  let frame = 0;
  let idleTimer = 0;
  let blinkTimer = 0;
  let settleTimer = 0;
  let gestureTimer = 0;
  let lastStroke = -Infinity;
  let lastPet = -Infinity;
  let lastBigGesture = -Infinity;
  let lastInteraction = -Infinity;
  let petting = false;
  let alternate = false;
  const animations = new Map<Element, Animation>();
  const timers = new Set<number>();
  const emit = (type: string, detail: Record<string, unknown>) => {
    root.dispatchEvent(new CustomEvent(type, { detail }));
  };
  const emitAnimation = (animation: SpineMascotAnimation, side?: SpineMascotSide) => {
    const detail: SpineAnimationEventDetail = { animation, side };
    emit(SPINE_ANIMATION_EVENT, { ...detail });
  };
  // With the Spine rig on screen the DOM layers are hidden; don't animate them.
  const spineDrawing = () =>
    root.querySelector('.neox-mascot__art')?.getAttribute('data-renderer') === 'spine';
  let sleepTimer = 0;
  let sleeping = false;
  const wake = () => {
    window.clearTimeout(sleepTimer);
    if (sleeping) {
      sleeping = false;
      root.dataset.mood = 'idle';
      emitAnimation('idle');
      // Woken up: a big stretch first.
      later(() => playGesture('stretch'), 250);
    }
    sleepTimer = window.setTimeout(() => {
      if (!alive || petting || input() === document.activeElement) return;
      sleeping = true;
      root.dataset.mood = 'sleeping';
      emitAnimation('sleep');
    }, SLEEP_AFTER_MS);
  };
  const later = (fn: () => void, delay: number) => {
    const id = window.setTimeout(() => { timers.delete(id); if (alive) fn(); }, delay);
    timers.add(id);
    return id;
  };
  const clear = (id: number) => { window.clearTimeout(id); timers.delete(id); };
  const animate = (selector: string, frames: Keyframe[], duration: number) => {
    if (spineDrawing()) return;
    root.querySelectorAll(selector).forEach(element => {
      if (typeof element.animate !== 'function') return;
      animations.get(element)?.cancel();
      const animation = element.animate(frames, { duration, easing: 'linear' });
      animations.set(element, animation);
      animation.onfinish = () => {
        if (animations.get(element) === animation) animations.delete(element);
        animation.cancel();
      };
    });
  };
  const animateLimb = (
    side: 'left' | 'right',
    armFrames: Keyframe[],
    handFrames: Keyframe[],
    duration: number,
  ) => {
    animate(`.neox-mascot__arm--${side}`, armFrames, duration);
    animate(`.neox-mascot__hand--${side}`, handFrames, duration);
  };
  const gaze = (x: number, y: number, turn = 0) => {
    root.style.setProperty('--mascot-look-x', `${x.toFixed(2)}px`);
    root.style.setProperty('--mascot-look-y', `${y.toFixed(2)}px`);
    root.style.setProperty('--mascot-head-turn', `${turn.toFixed(2)}deg`);
    emit(SPINE_LOOK_AT_EVENT, { x, y });
  };
  const blink = (soft = false) => animate('.neox-mascot__rig .neox-mascot__eye-lid', [
    { transform: 'scaleY(1)', offset: 0 },
    { transform: `scaleY(${soft ? .22 : .06})`, offset: soft ? .2 : .28, easing: 'ease-out' },
    { transform: `scaleY(${soft ? .22 : .06})`, offset: soft ? .64 : .36, easing: 'ease-out' },
    { transform: 'scaleY(1.035)', offset: .85, easing: 'ease-out' },
    { transform: 'scaleY(1)', offset: 1 },
  ], soft ? 820 : 210);
  const scheduleBlink = () => {
    blinkTimer = later(() => {
      if (!petting && !sleeping) {
        emitAnimation('blink');
        blink();
        if (Math.random() < .23) later(() => {
          if (petting || sleeping) return;
          emitAnimation('blink');
          blink();
        }, 360);
      }
      scheduleBlink();
    }, 2700 + Math.random() * 3900);
  };
  const stroke = (affection = false) => {
    const now = performance.now();
    if (now - lastStroke < (affection ? 1800 : 4400)) return;
    lastStroke = now;
    const side = alternate ? 'right' : 'left';
    alternate = !alternate;
    // Petting plays its own clip; a stroke while typing is a pat on the composer.
    if (!affection) emitAnimation('tap', side);
    const direction = side === 'left' ? -1 : 1;
    // The other paw stays planted. Raise from the shoulder, then articulate the wrist.
    animateLimb(side, [
      { transform: 'rotate(0deg)', offset: 0, easing: 'ease-in-out' },
      { transform: `rotate(${direction * 8}deg)`, offset: .2, easing: 'ease-out' },
      { transform: `rotate(${direction * 13}deg)`, offset: .38, easing: 'ease-in-out' },
      { transform: `rotate(${direction * 11}deg)`, offset: .7, easing: 'ease-out' },
      { transform: `rotate(${direction * 4}deg)`, offset: .88, easing: 'ease-out' },
      { transform: 'rotate(0deg)', offset: 1 },
    ], [
      { transform: 'rotate(0deg)', offset: 0, easing: 'ease-in-out' },
      { transform: `rotate(${direction * 4}deg)`, offset: .2, easing: 'ease-out' },
      { transform: `rotate(${direction * -8}deg)`, offset: .38, easing: 'ease-in-out' },
      { transform: `rotate(${direction * 9}deg)`, offset: .55, easing: 'ease-in-out' },
      { transform: `rotate(${direction * -5}deg)`, offset: .73, easing: 'ease-out' },
      { transform: `rotate(${direction * 3}deg)`, offset: .88, easing: 'ease-out' },
      { transform: 'rotate(0deg)', offset: 1 },
    ], species === 'cat' ? 1650 : 1430);
  };
  const finishGesture = (delay = 1500) => {
    later(() => {
      root.dataset.gesture = 'none';
      if (input() === document.activeElement) queueWatch();
      else relax();
    }, delay);
  };
  const canBigGesture = (force = false) => {
    const now = performance.now();
    if ((!force && petting) || (!force && now - lastBigGesture < 10_000)) return false;
    lastBigGesture = now;
    return true;
  };
  const wave = (force = false) => {
    if (!canBigGesture(force)) return;
    const side = alternate ? 'right' : 'left';
    alternate = !alternate;
    const direction = side === 'left' ? -1 : 1;
    const height = Math.max(120, root.getBoundingClientRect().height);
    const lift = height * .105;
    const lean = height * .018;
    const armPose = (rotation: number, amount: number, outward = 0) =>
      `translate3d(${(direction * outward).toFixed(2)}px, ${(-amount).toFixed(2)}px, 0) rotate(${(direction * rotation).toFixed(2)}deg)`;
    root.dataset.gesture = 'wave';
    emitAnimation('wave', side);
    gaze(direction * 2.6, -1.2, direction * 2.1);
    animateLimb(side, [
      { transform: armPose(0, 0), offset: 0, easing: 'ease-in' },
      { transform: armPose(16, lift * .48, lean * .35), offset: .13, easing: 'ease-out' },
      { transform: armPose(38, lift * .9, lean), offset: .29, easing: 'ease-in-out' },
      { transform: armPose(46, lift, lean * 1.2), offset: .43, easing: 'ease-out' },
      { transform: armPose(42, lift * .98, lean), offset: .63, easing: 'ease-in-out' },
      { transform: armPose(46, lift, lean * 1.2), offset: .78, easing: 'ease-in-out' },
      { transform: armPose(25, lift * .7, lean * .55), offset: .9, easing: 'ease-out' },
      { transform: armPose(0, 0), offset: 1, easing: 'ease-in' },
    ], [
      { transform: 'rotate(0deg)', offset: 0, easing: 'ease-out' },
      { transform: `rotate(${direction * 10}deg)`, offset: .13, easing: 'ease-out' },
      { transform: `rotate(${direction * -22}deg)`, offset: .29, easing: 'ease-in-out' },
      { transform: `rotate(${direction * 28}deg)`, offset: .43, easing: 'ease-in-out' },
      { transform: `rotate(${direction * -24}deg)`, offset: .57, easing: 'ease-in-out' },
      { transform: `rotate(${direction * 29}deg)`, offset: .71, easing: 'ease-in-out' },
      { transform: `rotate(${direction * -18}deg)`, offset: .82, easing: 'ease-out' },
      { transform: `rotate(${direction * 11}deg)`, offset: .91, easing: 'ease-out' },
      { transform: 'rotate(0deg)', offset: 1, easing: 'ease-in' },
    ], species === 'cat' ? 2350 : 2150);
    animate('.neox-mascot__head-act', [
      { transform: 'translateY(0) rotate(0deg) scale(1)', offset: 0 },
      { transform: `translateY(${-height * .008}px) rotate(${direction * 1.6}deg) scale(1.01,.995)`, offset: .3, easing: 'ease-out' },
      { transform: `translateY(${-height * .012}px) rotate(${direction * 2.3}deg) scale(1.012,.994)`, offset: .52, easing: 'ease-in-out' },
      { transform: 'translateY(0) rotate(0deg) scale(1)', offset: 1, easing: 'ease-out' },
    ], species === 'cat' ? 2350 : 2150);
    blink(true);
    finishGesture(species === 'cat' ? 2420 : 2220);
  };
  const turnHead = (force = false) => {
    if (!canBigGesture(force)) return;
    const direction = Math.random() < .5 ? -1 : 1;
    root.dataset.gesture = 'turn';
    emitAnimation('turn', direction < 0 ? 'left' : 'right');
    gaze(direction * 4.8, -1.4, direction * 5.8);
    animate('.neox-mascot__head-look', [
      { transform: 'rotate(0deg)', offset: 0, easing: 'ease-out' },
      { transform: `rotate(${direction * 5.8}deg)`, offset: .27, easing: 'ease-in-out' },
      { transform: `rotate(${direction * 5.8}deg)`, offset: .52, easing: 'linear' },
      { transform: `rotate(${direction * 1.2}deg)`, offset: .78, easing: 'ease-out' },
      { transform: 'rotate(0deg)', offset: 1 },
    ], species === 'cat' ? 1900 : 1720);
    later(() => blink(), 390);
    // The Spine turn slides the face round the head and holds it (2.35s authored).
    finishGesture(spineDrawing() ? 2400 : species === 'cat' ? 1950 : 1770);
  };
  const input = () => composer?.querySelector<HTMLTextAreaElement>('textarea.atl-composer__input') ?? null;
  const touch = root.querySelector<HTMLElement>('.neox-mascot__touch');

  // --- roaming along the composer's top edge --------------------------------
  let roamX = 0;
  /** The spot along the composer edge it goes back to (placement.homeX). */
  let homeX = placement.homeX;
  /** Off the composer: dragged somewhere else on the page, sitting up there. */
  let free = false;
  let freeX = 0;
  let freeY = 0;
  let dragging = false;
  let roaming = false;
  let roamTimer = 0;
  let homeTimer = 0;
  let wanderTimer = 0;
  let busy = initiallyBusy;
  let busySince = initiallyBusy ? performance.now() : 0;
  /** Failures since the last run that finished well. */
  let errorStreak = 0;
  let mood: MascotMood = 'idle';
  let lastPat = 0;
  let patTimer = 0;
  let workTimer = 0;
  /** User setting: never walk, stay in the corner. */
  let stayPut = initiallyStayPut;
  /** Went back to the corner after a typing pause; don't follow the caret until the next keystroke. */
  let restingHome = false;
  const roamTo = (wanted: number, onArrive?: () => void) => {
    if (!composer) return;
    if (free || (stayPut && wanted !== homeX)) {
      onArrive?.();
      return;
    }
    const range = measureRoamRange(root, composer);
    const target = range ? freeOffset(range, wanted) : 0;
    const distance = target - roamX;
    if (Math.abs(distance) < 6) {
      onArrive?.();
      return;
    }
    wake();
    const ms = Math.round(clamp(Math.abs(distance) * 2.4 + 280, 420, 1500));
    const side: SpineMascotSide = distance < 0 ? 'left' : 'right';
    const direction = distance < 0 ? -1 : 1;
    roamX = target;
    roaming = true;
    root.dataset.roaming = 'yes';
    root.style.setProperty('--mascot-roam-ms', `${ms}ms`);
    root.style.setProperty('--mascot-roam-x', `${target.toFixed(1)}px`);
    gaze(direction * 3.4, -.8, direction * 2.4);
    // One clip is two hops; keep hopping for as long as the slide lasts.
    for (let t = 0; t < ms - SCOOT_MS * .4; t += SCOOT_MS) {
      later(() => { if (roaming) emitAnimation('scoot', side); }, t);
    }
    clear(roamTimer);
    roamTimer = later(() => {
      roaming = false;
      root.dataset.roaming = 'no';
      if (onArrive) onArrive();
      else if (input() === document.activeElement) queueWatch();
      else relax();
    }, ms);
  };
  const goHome = (onArrive?: () => void) => {
    clear(homeTimer);
    clear(wanderTimer);
    roamTo(homeX, onArrive);
  };
  /** Follow the caret: the pet scoots over to see what is being typed. */
  const followCaret = (caretX: number) => {
    // Typing while a reply streams in counts too: the draft is what the user is looking at.
    if (roaming || petting || stayPut || restingHome || free || dragging || !composer) return;
    const range = measureRoamRange(root, composer);
    if (!range) return;
    const target = freeOffset(range, offsetForCaret(range, caretX));
    if (Math.abs(target - roamX) >= ROAM_MIN_STEP) roamTo(target);
  };

  const watch = () => {
    const editor = input();
    if (!editor || editor !== document.activeElement || petting || dragging) return;
    // Sent and nothing new typed yet: watch the reply, not the empty box.
    if (busy && !editor.value.trim()) {
      relax();
      return;
    }
    const caret = getMascotCaretTarget(editor);
    if (editor.value.trim()) followCaret(caret.x);
    if (roaming) return;
    const face = root.getBoundingClientRect();
    const box = editor.getBoundingClientRect();
    const x = clamp((caret.x - (face.left + face.width / 2)) / Math.max(220, box.width) * 7, -7, 4);
    const y = clamp((caret.y - (face.top + face.height * .55)) / Math.max(100, face.height) * 5, 1.5, 5.5);
    wake();
    gaze(x, y, x * .33);
    root.dataset.mood = 'watching';
    emitAnimation('watch');
  };
  const queueWatch = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; if (alive) watch(); });
  };
  const relax = () => {
    if (petting || sleeping || roaming || dragging) return;
    // What the agent is doing decides the resting pose; typing (watch) overrides it.
    if (mood === 'waiting') {
      // Standing beside the approval strip (useMascotAnchor): point at its buttons.
      if (root.dataset.beside === 'approval') {
        root.dataset.mood = 'pointing';
        emitAnimation('point', 'left');
        gaze(-3.5, 2.5, -2);
        return;
      }
      root.dataset.mood = 'alert';
      emitAnimation('alert');
      gaze(0, 1.5, 0);
      return;
    }
    if (mood === 'error') {
      root.dataset.mood = 'sad';
      emitAnimation('sad');
      gaze(0, 2, 0);
      return;
    }
    if (busy) {
      if (mood === 'thinking') {
        root.dataset.mood = 'thinking';
        emitAnimation('think');
        return;
      }
      // Tools running: tapping away on a little laptop. Writing the reply: scribbling
      // in a notebook. (The DOM rig has neither; it watches the reply come in.)
      root.dataset.mood = mood === 'working' ? 'working' : 'waiting';
      if (spineDrawing()) {
        emitAnimation(mood === 'working' ? 'type' : 'write');
        gaze(0, 3, 0);
        return;
      }
      emitAnimation('watch');
      gaze(0, -2.4, 0);
      return;
    }
    root.dataset.mood = 'idle';
    emitAnimation('idle');
    gaze(0, 0, 0);
  };
  /** Tools running: drum the ledge now and then, between the other gestures. */
  const scheduleWork = () => {
    clear(workTimer);
    workTimer = later(() => {
      workTimer = 0;
      if (!busy || mood !== 'working') return;
      // The Spine rig types on its laptop the whole time; drumming the ledge is for the DOM rig.
      if (!spineDrawing() && !petting && !roaming && !sleeping && input() !== document.activeElement
        && (!root.dataset.gesture || root.dataset.gesture === 'none')) {
        emitAnimation('work');
      }
      scheduleWork();
    }, 2600 + Math.random() * 2200);
  };
  const setMood = (next: MascotMood) => {
    if (next === mood) return;
    const prev = mood;
    mood = next;
    if (next === 'working') scheduleWork();
    else { clear(workTimer); workTimer = 0; }
    if (next !== 'idle' || prev === 'error' || prev === 'waiting') wake();
    if (next === 'waiting') {
      // Off the draft and back to the corner, from where it steps over to the strip.
      goHome(relax);
      return;
    }
    if (next === 'error') {
      // Ears shoot up; then it hides its face for a moment, or, once failures pile up
      // (or now and then), goes red in the face and fumes.
      errorStreak++;
      flinch();
      const fume = errorStreak > 1 || Math.random() < .25;
      if (fume || Math.random() < .5) later(() => playGesture(fume ? 'fume' : 'cover'), FLINCH_MS + 100);
    }
    if (input() === document.activeElement && input()?.value.trim()) return;
    relax();
  };
  /** Reach down onto the text the user just typed and rub it: the draft got noticed. */
  const patText = (retries = 3) => {
    const editor = input();
    if (!editor || editor !== document.activeElement || !editor.value.trim()) return;
    if (petting || sleeping || free || dragging) return;
    // Still walking over to the caret: pat once it has arrived.
    if (roaming || (root.dataset.gesture && root.dataset.gesture !== 'none')) {
      if (retries > 0) later(() => patText(retries - 1), 450);
      return;
    }
    const now = performance.now();
    if (now - lastPat < PAT_COOLDOWN_MS) return;
    // The pet stands with a paw right above the caret; the words are just below the
    // composer edge, so the paw only has to reach a little way down onto them (the
    // runtime caps the reach at a natural arm length).
    const caret = getMascotCaretTarget(editor);
    const face = root.getBoundingClientRect();
    const side: SpineMascotSide = caret.x <= face.left + face.width / 2 ? 'left' : 'right';
    const pawX = face.left + face.width * (side === 'left' ? .3 : .7);
    if (Math.abs(caret.x - pawX) > PAT_NEAR_PX) {
      // Too far to reach without walking (it stays put): a tap on the edge instead.
      stroke();
      return;
    }
    lastPat = now;
    wake();
    root.dataset.gesture = 'pat';
    const reach = { clientX: caret.x - 10, clientY: caret.y };
    gaze(side === 'left' ? -1.5 : 1.5, 5, side === 'left' ? -.8 : .8);
    const detail: SpineAnimationEventDetail = { animation: 'pat', side, reach };
    emit(SPINE_ANIMATION_EVENT, { ...detail });
    finishGesture(1900);
  };
  /** A tool just failed: ears up, eyes wide, then back to whatever it was doing. */
  const flinch = () => {
    if (sleeping || petting) return;
    if (root.dataset.gesture && root.dataset.gesture !== 'none') return;
    wake();
    root.dataset.gesture = 'flinch';
    emitAnimation('flinch');
    finishGesture(FLINCH_MS);
  };
  /** A longer Spine-only one-shot (cover, yawn, phone, sip) that holds off other gestures while it plays. */
  const playGesture = (name: keyof typeof GESTURE_MS) => {
    if (!spineDrawing() || sleeping || petting || roaming) return;
    if (root.dataset.gesture && root.dataset.gesture !== 'none') return;
    root.dataset.gesture = name;
    emitAnimation(name);
    finishGesture(GESTURE_MS[name]);
  };
  const onInput = (event: Event) => {
    if (event.target !== input()) return;
    clear(homeTimer);
    restingHome = false;
    // Draft cleared: nothing left to watch, wander back to the corner. Otherwise go
    // back once the typing stops for a while, so it is not hovering over the draft.
    if (!input()?.value.trim()) homeTimer = later(() => goHome(), 700);
    else homeTimer = later(() => { restingHome = true; goHome(); }, HOME_AFTER_TYPING_MS);
    queueWatch();
    clear(settleTimer);
    settleTimer = later(relax, 1800);
    if (!gestureTimer) gestureTimer = later(() => {
      gestureTimer = 0;
      if (petting || input() !== document.activeElement) return;
      // Small things to do while the user types: mostly a tap, now and then a head
      // tilt or a nod. Each has its own cooldown, so a long burst stays calm.
      const roll = Math.random();
      if (roll < .2) turnHead();
      else if (roll < .35 && (!root.dataset.gesture || root.dataset.gesture === 'none')) emitAnimation('nod');
      else stroke();
    }, 680);
    // A pause after a burst of typing: sometimes reach down and pat the words.
    clear(patTimer);
    patTimer = later(() => { if (Math.random() < PAT_CHANCE) patText(); }, PAT_AFTER_PAUSE_MS);
  };
  const onSelection = (event: Event) => {
    if (event.target === input()) queueWatch();
  };
  const onBlur = (event: FocusEvent) => {
    if (event.target !== input()) return;
    clear(gestureTimer);
    gestureTimer = 0;
    clear(settleTimer);
    relax();
    clear(homeTimer);
    homeTimer = later(() => { if (input() !== document.activeElement) goHome(); }, 1600);
  };
  const pet = (force = false) => {
    if (!force && performance.now() - lastPet < 1600) return;
    if (root.dataset.gesture && root.dataset.gesture !== 'none') return;
    wake();
    lastPet = performance.now();
    petting = true;
    root.dataset.gesture = 'pet';
    root.dataset.mood = 'petting';
    emitAnimation('pet');
    gaze(0, 0, 0);
    blink(true);
    stroke(true);
    animate('.neox-mascot__head-act', [
      { transform: 'translateY(0) rotate(0deg) scale(1)', offset: 0, easing: 'ease-out' },
      { transform: 'translateY(.6%) rotate(-1.8deg) scale(1.008,.99)', offset: .3, easing: 'ease-in-out' },
      { transform: 'translateY(-.25%) rotate(.8deg) scale(.998,1.004)', offset: .65, easing: 'ease-out' },
      { transform: 'translateY(0) rotate(0deg) scale(1)', offset: 1 },
    ], 1050);
    later(() => {
      petting = false;
      root.dataset.gesture = 'none';
      relax();
      if (input() === document.activeElement) queueWatch();
    }, 1100);
  };
  const interact = () => {
    const now = performance.now();
    if (now - lastInteraction < 280 || (root.dataset.gesture && root.dataset.gesture !== 'none')) return;
    lastInteraction = now;
    if (sleeping) {
      // Poking a sleeping mascot just wakes it; the gesture comes on the next click.
      wake();
      return;
    }
    wake();
    const action = Math.random();
    if (action < .4) wave(true);
    else if (action < .62) turnHead(true);
    else if (action < .74 && spineDrawing()) playGesture('jump');
    else if (action < .84 && spineDrawing()) playGesture(Math.random() < .5 ? 'smile' : 'ears');
    else pet(true);
  };
  const onPointer = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || petting || input() === document.activeElement) return;
    wake();
    const box = root.getBoundingClientRect();
    const x = clamp((event.clientX - box.left - box.width / 2) / box.width * 12, -5, 5);
    gaze(x, -1, x * .3);
  };
  const onPointerLeave = () => {
    if (input() === document.activeElement) queueWatch();
    else relax();
  };
  const idle = () => {
    idleTimer = later(() => {
      if (!petting && !roaming && !sleeping && input() !== document.activeElement) {
        const roll = Math.random();
        if (roll < .12 && !busy && !stayPut && !free && roamX === homeX) {
          // Now and then it pads off along the edge for a look around, then comes back.
          roamTo(homeX - (70 + Math.random() * 140), () => {
            relax();
            clear(wanderTimer);
            wanderTimer = later(() => goHome(), 3200 + Math.random() * 2400);
          });
        } else if (roll < .14) wave();
        else if (roll < .31) turnHead();
        else if (roll < .5 && !busy && spineDrawing()) {
          // Passing the time: a yawn, a stretch, a look at its phone, a sip from its mug,
          // an ear twitch, a little smile to itself.
          const pick = Math.random();
          playGesture(pick < .18 ? 'yawn' : pick < .32 ? 'stretch' : pick < .54 ? 'phone' : pick < .7 ? 'sip' : pick < .86 ? 'ears' : 'smile');
        } else {
          const x = Math.random() < .5 ? 3.2 : -3.2;
          gaze(x, -1.2, x * .35);
          if (Math.random() < .3) stroke();
          later(() => {
            if (input() === document.activeElement) queueWatch();
            else relax();
          }, 1200);
        }
      }
      idle();
    }, 6300 + Math.random() * 4000);
  };
  const celebrate = () => {
    wake();
    if (!spineDrawing()) {
      pet(true);
      return;
    }
    errorStreak = 0;
    if (petting || roaming || (root.dataset.gesture && root.dataset.gesture !== 'none')) return;
    gaze(0, -1.5, 0);
    // Often it hops right off the ledge, sometimes it just beams and blushes.
    const pick = Math.random();
    if (pick < .6) {
      playGesture(pick < .4 ? 'jump' : 'smile');
      return;
    }
    root.dataset.gesture = 'celebrate';
    emitAnimation('celebrate');
    finishGesture(1750);
  };
  /** The agent started (message sent) or finished a run. */
  const setBusy = (next: boolean) => {
    if (next === busy) return;
    busy = next;
    if (busy) {
      busySince = performance.now();
      // "Got it": a nod once it is back home, then it settles in to watch.
      goHome(() => {
        relax();
        if (!petting && !sleeping && (!root.dataset.gesture || root.dataset.gesture === 'none')) {
          emitAnimation('nod');
        }
      });
      if (mood === 'working') scheduleWork();
      return;
    }
    const ran = performance.now() - busySince;
    relax();
    if (ran >= CELEBRATE_AFTER_MS) later(celebrate, 280);
  };
  root.dataset.motion = 'on';
  root.dataset.gesture = 'none';
  root.dataset.roaming = 'no';
  wake();
  relax();
  if (handoff && performance.now() - handoff.at < 1500 && handoff.offset) {
    // Arrive from where the previous composer's mascot stood, then settle.
    const from = handoff.offset;
    root.style.setProperty('--mascot-roam-ms', '0ms');
    root.style.setProperty('--mascot-roam-x', `${from.toFixed(1)}px`);
    roamX = from;
    later(() => goHome(relax), 180);
  }
  handoff = null;

  // --- dragging it around ------------------------------------------------------
  const setFree = (x: number, y: number) => {
    freeX = x;
    freeY = y;
    root.style.setProperty('--mascot-free-x', `${x.toFixed(1)}px`);
    root.style.setProperty('--mascot-free-y', `${y.toFixed(1)}px`);
  };
  const setRoam = (x: number) => {
    roamX = x;
    root.style.setProperty('--mascot-roam-x', `${x.toFixed(1)}px`);
  };
  /** Back onto the composer edge at `offset`, sliding there over `ms`. */
  const perch = (offset: number, ms: number) => {
    free = false;
    delete root.dataset.free;
    placement.free = null;
    homeX = placement.homeX = offset;
    root.style.setProperty('--mascot-roam-ms', `${ms}ms`);
    setFree(0, 0);
    setRoam(offset);
    emitAnimation('perch');
    later(() => { if (input() === document.activeElement) queueWatch(); else relax(); }, ms);
  };
  /** Stays where it was dropped, sitting up on its whole body; kept inside the window. */
  const settleFree = () => {
    const rect = root.getBoundingClientRect();
    // Sitting up, the head rises about .45 of the box height above it.
    const dx = clamp(rect.left, 4, window.innerWidth - rect.width - 4) - rect.left;
    const dy = clamp(rect.top, rect.height * .45 + 4, window.innerHeight - rect.height - 4) - rect.top;
    root.style.setProperty('--mascot-roam-ms', '220ms');
    setFree(freeX + dx, freeY + dy);
    free = true;
    root.dataset.free = 'yes';
    placement.free = { left: rect.left + dx, top: rect.top + dy };
    emitAnimation('stand');
    relax();
  };
  const drop = () => {
    const box = composer?.querySelector('.atl-composer__box')?.getBoundingClientRect();
    const range = composer ? measureRoamRange(root, composer) : null;
    const rect = root.getBoundingClientRect();
    const middle = rect.left + rect.width / 2;
    if (!FREE_ROAM) {
      perch(range ? freeOffset(range, rect.left - range.homeLeft) : homeX, 260);
      return;
    }
    // Docked, the box's bottom sits a few px below the composer's top edge.
    const near = box && range && Math.abs(rect.bottom - (box.top + rect.height * .06)) < SNAP_PX
      && middle > box.left - rect.width * .2 && middle < box.right + rect.width * .5;
    if (near) perch(freeOffset(range, rect.left - range.homeLeft), 260);
    else settleFree();
  };
  let press: { id: number; x: number; y: number; fx: number; fy: number } | null = null;
  let swallowClick = false;
  const onPressDown = (event: PointerEvent) => {
    if (event.button !== 0 || press) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, fx: freeX, fy: freeY };
  };
  const onPressMove = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!dragging) {
      if (Math.hypot(dx, dy) < DRAG_START_PX) return;
      // Picked up: whatever it was doing stops, it dangles from the pointer.
      dragging = true;
      touch?.setPointerCapture(event.pointerId);
      clear(roamTimer);
      clear(homeTimer);
      clear(wanderTimer);
      roaming = false;
      root.dataset.roaming = 'no';
      wake();
      // The walk offset folds into the free offset so the pet stays under the pointer.
      press.fx = freeX + roamX;
      press.fy = freeY;
      setRoam(0);
      root.dataset.dragging = 'yes';
      root.dataset.gesture = 'drag';
      if (FREE_ROAM) {
        emitAnimation('stand');
        emitAnimation('dangle');
      }
      gaze(0, 2, 0);
    }
    setFree(press.fx + dx, FREE_ROAM ? press.fy + dy : 0);
  };
  const onPressUp = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return;
    press = null;
    if (!dragging) return;
    dragging = false;
    swallowClick = true;
    delete root.dataset.dragging;
    root.dataset.gesture = 'none';
    drop();
  };
  // The click that ends a drag is not a pat.
  const onPressClick = (event: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  };
  const onDock = () => { if (free) perch(homeX, 520); };
  if (placement.free && FREE_ROAM) {
    // Put back where it was left, once the anchor has placed the docked box.
    const spot = placement.free;
    later(() => {
      const rect = root.getBoundingClientRect();
      root.style.setProperty('--mascot-roam-ms', '0ms');
      setRoam(0);
      setFree(spot.left - (rect.left - roamX - freeX), spot.top - (rect.top - freeY));
      free = true;
      root.dataset.free = 'yes';
      emitAnimation('stand');
      relax();
    }, 60);
  } else if (homeX && !handoff) setRoam(homeX);
  scheduleBlink();
  idle();
  queueWatch();
  touch?.addEventListener('pointerdown', onPressDown);
  touch?.addEventListener('pointermove', onPressMove);
  touch?.addEventListener('pointerup', onPressUp);
  touch?.addEventListener('pointercancel', onPressUp);
  touch?.addEventListener('click', onPressClick, true);
  root.addEventListener('neox-mascot:dock', onDock);
  touch?.addEventListener('pointermove', onPointer);
  touch?.addEventListener('pointerleave', onPointerLeave);
  composer?.addEventListener('input', onInput);
  composer?.addEventListener('focusin', onSelection);
  composer?.addEventListener('focusout', onBlur);
  composer?.addEventListener('select', onSelection, true);
  composer?.addEventListener('keyup', onSelection);
  composer?.addEventListener('pointerup', onSelection);
  composer?.addEventListener('scroll', onSelection, true);
  // The anchor moves the pet beside the approval strip, out of a pill's way, and back: hop along, then settle.
  const beside = new MutationObserver(records => {
    // Only a real move: rewriting the same value still produces a record.
    if (!records.some(r => r.oldValue && r.oldValue !== root.dataset.beside) || free || dragging) return;
    const side: SpineMascotSide = root.dataset.stepDir === 'left' ? 'left' : 'right';
    emitAnimation('scoot', side);
    later(() => { if (!roaming) relax(); }, 820);
  });
  beside.observe(root, { attributes: true, attributeFilter: ['data-beside'], attributeOldValue: true });
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queueWatch);
  if (composer) resize?.observe(composer);
  return {
    pet,
    celebrate,
    interact,
    setBusy,
    setMood,
    flinch,
    setStayPut(next: boolean) {
      stayPut = next;
      if (next) goHome();
    },
    /** 招呼一声 —— 睡着也叫醒, 挥一次爪, 不受大动作冷却限制。已经站在审批条旁边指着它时不再挥。 */
    call() {
      wake();
      if (root.dataset.beside === 'approval') return;
      wave(true);
    },
    dispose() {
      handoff = { offset: roamX, at: performance.now() };
      alive = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(sleepTimer);
      clear(idleTimer);
      clear(blinkTimer);
      timers.forEach(id => window.clearTimeout(id));
      animations.forEach(animation => animation.cancel());
      animations.clear();
      resize?.disconnect();
      beside.disconnect();
      touch?.removeEventListener('pointerdown', onPressDown);
      touch?.removeEventListener('pointermove', onPressMove);
      touch?.removeEventListener('pointerup', onPressUp);
      touch?.removeEventListener('pointercancel', onPressUp);
      touch?.removeEventListener('click', onPressClick, true);
      root.removeEventListener('neox-mascot:dock', onDock);
      touch?.removeEventListener('pointermove', onPointer);
      touch?.removeEventListener('pointerleave', onPointerLeave);
      composer?.removeEventListener('input', onInput);
      composer?.removeEventListener('focusin', onSelection);
      composer?.removeEventListener('focusout', onBlur);
      composer?.removeEventListener('select', onSelection, true);
      composer?.removeEventListener('keyup', onSelection);
      composer?.removeEventListener('pointerup', onSelection);
      composer?.removeEventListener('scroll', onSelection, true);
      root.dataset.motion = 'off';
      root.dataset.mood = 'idle';
      root.dataset.gesture = 'none';
      delete root.dataset.roaming;
      root.style.removeProperty('--mascot-roam-x');
      root.style.removeProperty('--mascot-roam-ms');
      root.style.removeProperty('--mascot-free-x');
      root.style.removeProperty('--mascot-free-y');
      delete root.dataset.free;
      delete root.dataset.dragging;
      gaze(0, 0, 0);
    },
  };
}

export function useMascotMotion(
  rootRef: RefObject<HTMLElement | null>, composerRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean, species: 'cat' | 'corgi', busy: boolean,
  /** 有事等用户 (批准 / 回答): 立刻挥爪, 之后每隔一阵再挥一次, 直到事情处理掉。 */
  calling = false,
  mood: MascotMood = 'idle',
  /** Changes each time a tool fails in the live turn; the pet startles once per change. */
  flinchKey: string | null = null,
  /** User setting: stay in the corner instead of following the caret. */
  stayPut = false,
) {
  const controller = useRef<ReturnType<typeof mountMascotMotion> | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const stayPutRef = useRef(stayPut);
  stayPutRef.current = stayPut;
  useEffect(() => {
    if (!enabled || !rootRef.current) return;
    const motion = mountMascotMotion(rootRef.current, composerRef?.current ?? null, species, busyRef.current, stayPutRef.current);
    controller.current = motion;
    return () => { motion.dispose(); controller.current = null; };
  }, [enabled, rootRef, composerRef, species]);
  useEffect(() => { controller.current?.setBusy(busy); }, [enabled, busy]);
  useEffect(() => { controller.current?.setStayPut(stayPut); }, [enabled, stayPut]);
  useEffect(() => { controller.current?.setMood(mood); }, [enabled, species, mood]);
  const lastFlinch = useRef(flinchKey);
  useEffect(() => {
    if (!flinchKey || flinchKey === lastFlinch.current) return;
    lastFlinch.current = flinchKey;
    controller.current?.flinch();
  }, [flinchKey]);
  useEffect(() => {
    if (!enabled || !calling) return;
    controller.current?.call();
    const timer = window.setInterval(() => controller.current?.call(), CALL_AGAIN_MS);
    return () => window.clearInterval(timer);
  }, [enabled, calling]);
  return useCallback(() => controller.current?.interact(), []);
}
