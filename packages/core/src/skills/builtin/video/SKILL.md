---
name: "Video"
description: "做短视频 / 讲解动画 / 幻灯片视频 / GIF: 写一页按时间定格的网页动画, 用 render_video 导出 MP4"
description_en: "Make short videos, explainer animations, slideshow videos or GIFs: write a time-seekable HTML animation and export it with render_video"
user-invocable: true
neox:
  category: creative
  aliases: [mp4, gif, clip]
  dangerLevel: safe
---

## Overview

Neox has a built-in browser and video encoder. Do not look for Playwright, Puppeteer or ffmpeg on the machine, do not
write capture scripts, and do not screenshot frames yourself — `render_video` does all of that (in parallel, frames
never touch the disk). Unlock it with `tool_search` (pack `video`).

**A. Explainer / motion graphics** (the default):
1. Write ONE self-contained HTML page under `.neox-tmp/` in the workspace, stage sized exactly 1920×1080
   (or 1080×1920 for vertical). Define `window.seek(t)` (seconds) that draws the exact state at time t — every
   animation, subtitle and transition must be a pure function of t. No CSS animations, no setTimeout, no rAF timing.
2. `render_video({ html, preview_times: [...] })` with 4–6 key moments → look at the PNGs → fix layout, overlaps,
   subtitle timing. Do this BEFORE the final render; previews are cheap, a re-render is not.
3. `render_video({ html, duration, output })` once, output into the user's folder
   (e.g. `<date>-<topic>/<topic>.mp4`). A 1-minute 1080p video renders in well under a minute.

**B. Slideshow / cut-together** (images, clips, text cards, audio): the bundled `ffmpeg` is on PATH in the shell —
stills with duration via `-loop 1 -t 3`, `concat` / `xfade` for transitions, `-shortest` with music, `-ss/-to` to trim.
Render text cards as HTML through `render_video` preview stills rather than fighting `drawtext` fonts.

## Rules

- Decide length, aspect ratio and fps up front (default 1920×1080, 30fps; social vertical 1080×1920, ≤ 60s).
- Keep each subtitle on screen ≥ 2s; 5% safe margins on every edge; subtitles never overlap the main visual.
- GIF: output a `.gif` path — render_video caps it at 15fps / 800px wide with a proper palette.
- Only the final video (and subtitles if asked) goes in the user's folder; everything else stays in `.neox-tmp/`.
- Talk to the user about the video, not the toolchain: never mention ffmpeg, browsers, frames or scripts in
  progress updates.

## Deliver

`open_surface({ kind: 'image', source: { type: 'file', path: '<the .mp4>' } })` — Neox shows it in its video player
on the right. Do not open videos as a web page and do not drive playback with browser tools.

## Verify (required)

Check the result render_video returns (duration, resolution, size). If something looks off, preview the suspect
moments again rather than re-rendering blind. Report the file name, length and size.
