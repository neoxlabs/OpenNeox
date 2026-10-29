# The Composer Mascot

A small animal perched on the top edge of the chat composer: white cat by
default, corgi as the alternative. It is a first-party UI ornament, not a game
character and not part of the pet module.

This document records the design constraints, the asset pipeline, and the work
that is still open, so the component can be picked up without re-deriving any of
it.

## Why it is not built on the pet module

`modules/pet` renders a sprite atlas of 8 columns x 9 rows = 72 frames covering
15 states, and separately a set of `PET_CANDIDATES` that are three hue-rotated
copies of one third-party `robot.glb` (Tomas Laulhe, CC-BY 4.0, attributed on
the About page). `SPRITE_CANDIDATES` is an empty array: nobody has ever produced
a 72-frame atlas for it, which is exactly why the module shipped with no
first-party character.

That budget is the problem. Generative image models hold character identity only
over short edits — changing the eyes of a render reproduces the rest of the
frame almost pixel for pixel, but changing the pose drifts, in measurement up to
8% on head width alone. A 72-frame atlas of a consistent character is therefore
not reachable by that route, and hand-animating one is a different project.

The mascot takes the opposite budget: very few keyframes, and continuous CSS
transforms for everything between them. That is what makes a first-party
character possible at all here.

## Structure

The base image has **no eyes**. The eyes are vector, drawn on top by
`MascotEyes`. Every expression is then a continuous transform — a blink is the
lid scaling down and springing back, a glance is a translate, surprise is a
scale — instead of a cut between two bitmaps. Swapping whole images produces a
slideshow: each frame arrives instantly with nothing in between, and for a blink
the two hundred milliseconds in between is the entire effect.

### The four nested `<g>` elements

Each eye is wrapped in four groups because **a CSS `transform` replaces an
element's SVG `transform` attribute entirely — it does not compose with it**.
Positioning, gaze, widening and blinking all need to write `transform`; put two
of them on one element and the later one erases the placement, which sends the
eyes to the viewBox origin, i.e. off the top-left of the canvas.

So each layer owns exactly one transform source:

1. outermost — placement, written as an SVG attribute. **No CSS rule may ever
   select this layer.**
2. `.neox-mascot__eye-shift` — gaze (translate)
3. `.neox-mascot__eye-scale` — widen/narrow (scale)
4. `.neox-mascot__eye-lid` — lid open/close (scaleY)

Layers 2-4 also need `transform-box: fill-box`. Inside SVG, the default
transform origin for a CSS transform is the viewBox's top-left corner, so
without it "widen" scales about the corner of the whole canvas and the eyes slide
off the face as they grow.

## Assets

`assets/mascots/{cat,corgi}-base-v2.webp` are the two files actually used. Canvas is
**480 x 397**; the solid paw tip sits at row **389**, 8px above the canvas
bottom. Both editions use identical lossless WebP files and eye geometry.

The paw anchor is what makes positioning size-independent: aligning the canvas
bottom edge to the composer's top edge is the same thing as resting the paws on
that edge, at any display size, with no per-size offset table.

Eye geometry in `EYE_GEOMETRY` is calibrated to the V2 eyeless artwork, in canvas
coordinates: cat centres `(184, 221)` and `(295, 221)`, radius `11.52`; corgi
centres `(193, 203)` and `(287, 203)`, radius `11.232`. Specular highlights stay
above and to the right of each centre. Replacing the artwork requires checking
this registration and the paw anchor together, on light and dark backgrounds.

The original `{cat,corgi}-base.webp` files are retained for rollback but are no
longer imported by the mascot.

`{cat,corgi}-{idle,blink,tilt,cheer,sleep}.webp` are also in the directory and
are **currently unreferenced** — they are the original pose keyframes from
before the vector-eye rewrite. They are kept as the source for the paw/ear
layering work described below; if that work is dropped, delete them.

## Mounting and stacking

The mascot is mounted twice, because the composer itself has two separate DOM
trees: `.atl-empty-composer` on the first screen (150px) and `.atl-bottom-float`
once a conversation starts (124px). Preferences are therefore broadcast over a
custom event rather than held in a context — see `useMascotPrefs`.

Two positioning constraints that are easy to undo by accident:

- `z-index: 11`, because `.atl-composer` is `z-index: 10`. The ten-odd pixels of
  paw pressed into the box are only painted if the mascot is above it; below it
  the position is still correct but invisible, and the animal reads as floating
  rather than resting on the edge.
- The negative `right` offset parks it on the outer corner of the box. At a
  1390px window the gap between the greeting's right edge and the box's right
  edge is about 133px while the cat is 181px wide, so anything else overlaps the
  greeting text.

Depth of overlap cannot grow much past 10px either: the model picker and send
button sit 6px below the top of the box, directly under the mascot's left half.

## Idle behaviour

Blink intervals are re-rolled after every blink (2.6-6.4s) and come in single and
double variants; a fixed period reads as an indicator light rather than an
animal. Occasional glances to the side, but only when the user is not typing —
while they type, it looks at them.

There is deliberately **no doze/squint-after-idle state**. Idle is the mascot's
normal condition, so keying an expression off idle duration makes that expression
its default face — and squinting hides the blinking and gaze, which are the only
signs of life it has.

The attention signal is *composer has content*, not *composer has focus*: the
first-screen textarea autofocuses, so focus is always true and carries no
information. The composer reports actual draft presence, including programmatic
clearing and restoration. Attention changes the eyes, not the entire body, so
the paws stay registered against the composer edge.

`useMascotActivity` pauses idle scheduling while the mascot is offscreen, the
document is hidden, the preference is hidden, or reduced motion is requested.
Species/activity changes clear pending blink and gaze timers. Double blinks
animate the highlights with the eyes; reduced motion also covers the menu.

## Controls

Right-click the mascot for cat / corgi / hide. Keyboard users can open the menu
with Enter, Space, the context-menu key, or Shift+F10; arrows and Home/End move
between choices, and Escape returns focus. The menu is clamped to the viewport
and closes on scroll, resize, or window blur. The same three choices live in Settings →
Appearance ("Desk buddy"), which is the only way back after hiding: the control
and the thing it controls are the same object, so a hide button that lives on the
mascot is a one-way door without a second copy somewhere else.

Preferences are in `localStorage` (`neox.mascot.hidden`, `neox.mascot.species`)
rather than backend settings — this is a taste-level preference that does not
warrant an IPC channel and a table. Reads and writes are guarded. When storage
is blocked, an in-memory fallback preserves choices for the current renderer
lifetime. Custom events synchronize mounted copies; storage events synchronize
other windows when persistence is available.

## Files

- `modules/mascot/Mascot.tsx` — base image, idle scheduling, context menu
- `modules/mascot/MascotEyes.tsx` — vector eyes, `EYE_GEOMETRY`, canvas constants
- `modules/mascot/useMascotPrefs.ts` — localStorage + cross-mount broadcast
- `modules/mascot/useMascotActivity.ts` — visibility and reduced-motion gating
- `modules/mascot/mascot.css` — all motion, shadows, both mount positions
- `pages/settings/tabs/ThemeTab.tsx` — the "Desk buddy" card (`#setting-mascot`)
- `pages/settings/SettingsPage.tsx` — settings-search entry for that card

## Open work

**Paw and ear layering.** Only the eyes can currently tween. The ears and paws
are baked into the base image, so there is no "hands" animation — no paw
tapping the edge, no ear flick. Doing it properly means cutting those regions
into separately driven layers, which is a fresh round of asset generation: each
part exported on its own transparent canvas, registered against the same 480x397
frame and the same paw anchor so the reassembled animal lands pixel-identical to
today's single image. This is the largest remaining piece and has not been
started.

**Blink feel.** Current timing is close-fast / open-slow (closing takes about a
third of the cycle) with a 6% overshoot on the way back open. The user has asked
for a comparison pass against Nomi's blink style; not done.

**Replacing the borrowed pet.** The cat and corgi should become the pet module's
built-in characters, with the CC-BY `robot.glb` demoted to a user-extension
option rather than the default. Note this means producing 3D or atlas assets to
that module's spec, which is the constraint that produced this component in the
first place — read the first section before starting.

**Theming.** One mascot for all theme packs today. Per-theme variants were
discussed and not designed.

## Verification

The V2 update received static source checks and a light/dark bitmap contact-sheet
inspection only. No app launch, tests, build, or typecheck was run for this
update. DS owns runtime and layout acceptance, including narrow windows, both
composer mounts, reduced motion, keyboard menus, session switching, and blocked
storage.

For subsequent manual verification, the existing dev-client CDP workflow is:

```bash
NEOX_CDP_PORT=41778 npm run ui:dev
```

Then drive `ws://127.0.0.1:41778/devtools/page/<id>` with `Runtime.evaluate` and
`Page.captureScreenshot`. Two things to know: the WebSocket handshake needs the
Origin header suppressed, and **never call
`Emulation.setDeviceMetricsOverride`** — it locks the Electron viewport and
`clearDeviceMetricsOverride` does not release it, so only restarting the app
recovers. Use `captureScreenshot` with `clip` instead.
