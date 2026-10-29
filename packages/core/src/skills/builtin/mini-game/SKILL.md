---
name: "Mini Game"
description: "做一个能直接玩的小游戏 (单文件 HTML): 贪吃蛇、打砖块、跑酷、消除、问答…"
description_en: "Make a playable browser mini game in one HTML file: snake, breakout, runner, match-3, quiz…"
user-invocable: true
neox:
  category: creative
  aliases: [game, minigame]
  dangerLevel: safe
---

## Overview

Deliverable: one self-contained `.html` file, playable on desktop (keyboard/mouse) and phone (touch).
No image or sound files — draw with canvas / CSS, make sounds with the Web Audio API (short, optional, muted by default).

## Structure (keep it)

- **States**: `menu → playing → paused → over`, one `state` variable; each state has its own update + draw.
- **Loop**: `requestAnimationFrame` with delta time; clamp dt (e.g. ≤ 1/30s) so a background tab does not teleport
  things. Fixed-step physics if collisions matter.
- **Input**: keyboard + pointer/touch mapped to the same actions. On-screen buttons on touch devices.
  Prevent page scroll on game keys and touches inside the canvas.
- **Canvas**: size to the container, scale by `devicePixelRatio`, redraw on resize.
- **Feel**: instant feedback on every input (flash, shake, particle, sound), a readable score, difficulty that ramps.
- **Persistence**: best score in `localStorage` (wrapped in try/catch).
- Start screen says the controls in one line; game-over screen shows score, best, and restart (Space / tap).

## Verify (required, but bounded)

One pass, at most two `browser_run` calls: open it, start, press the controls for a few seconds (`press_key`
steps), screenshot, and read the console for errors. Fix real breakage (blank canvas, errors, controls dead).
Do not build test harnesses, stub `Math.random`, or chase exact scores — that is where time disappears.
Then give the file path and the controls.
