---
name: "Animation"
description: "做动画 / 动效: 加载动画、图标动效、讲解动画、SVG / Canvas 动画, 流畅不卡"
description_en: "Create animations and motion: loaders, icon motion, explainer sequences, SVG or Canvas animation that runs smoothly"
user-invocable: true
neox:
  category: creative
  aliases: [motion, anim]
  dangerLevel: safe
---

## Overview

Default deliverable: one self-contained `.html` file that plays the animation (and loops if it should).
Pick the lightest tool that does the job:

| Need | Use |
|---|---|
| UI motion, loaders, transitions | CSS `@keyframes` / transitions |
| Shapes, icons, line drawing, morphing | inline SVG + CSS or the Web Animations API |
| Many particles, physics, generative | `<canvas>` + `requestAnimationFrame` |
| Timeline with many coordinated parts | GSAP from a CDN |

## Rules that make it feel good

- **Timing**: UI feedback 150–300ms; entrances 300–600ms; explainer beats 0.6–1.2s with holds in between.
- **Easing**: never linear for movement. Entrances ease-out, exits ease-in, loops ease-in-out.
  Good defaults: `cubic-bezier(.2,.8,.2,1)` (out), `cubic-bezier(.65,0,.35,1)` (in-out).
- **Stagger** related items by 40–80ms instead of moving them all at once.
- **Performance**: animate only `transform` and `opacity` (plus SVG attributes on small SVGs). No layout properties
  (`top`, `width`, `margin`) in loops. Canvas: clear and redraw per frame, use delta time, not frame counts.
- **Loops** must be seamless: last frame equals first frame.
- Respect `prefers-reduced-motion`: show the end state or a gentle fade.

## Verify (required, but bounded)

One `browser_run`: open it and take 3–4 screenshots across the timeline (`eval` to seek, or waits between
screenshots). Check the key poses look right and nothing jumps; fix and re-check once. For a GIF/MP4, see the Video skill.
