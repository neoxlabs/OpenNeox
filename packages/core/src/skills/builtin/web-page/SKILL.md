---
name: "Web Page"
description: "做一个好看、能直接打开的网页 / 落地页 / 单页工具 (单文件 HTML)"
description_en: "Build a polished web page, landing page or single-page tool as one self-contained HTML file"
user-invocable: true
neox:
  category: creative
  aliases: [webpage, landing, html-page]
  dangerLevel: safe
---

## Overview

The deliverable is **one self-contained `.html` file** the user can double-click: inline CSS and JS, no build step,
no local assets. External code only from a CDN (cdnjs / jsdelivr / unpkg); fonts from Google Fonts.
It must look designed, not generated — the checks at the end are part of the job, not optional.

## Before writing

- Pin down in one line: who is it for, what is the one action or takeaway. That line decides the layout.
- Use the user's real content. No lorem ipsum, no "Feature 1 / Feature 2". If content is missing, write plausible
  copy for their actual topic and say so.

## Design rules

- **Tokens first**: define colors, radii, spacing and font sizes as CSS variables on `:root`; redefine colors under
  `@media (prefers-color-scheme: dark)`. Give `body` an explicit background.
- **Type**: at most two families; body 16–18px, line-height 1.5–1.7, measure 60–75 characters. A clear scale
  (e.g. 14 / 16 / 20 / 28 / 40). Headings tighter line-height (1.1–1.25).
- **Color**: one accent, used sparingly (primary action, key numbers). Neutral surfaces. Text contrast ≥ 4.5:1.
- **Spacing**: an 8px grid; generous section padding (64–120px desktop). Align to a max-width container (960–1200px).
- **Layout**: CSS grid / flex. Works at 360px wide with a 16px gutter and no horizontal scroll.
- **Detail**: real hover / focus states, `:focus-visible` rings, buttons ≥ 40px tall, images with `alt`.
- **Motion**: subtle (150–250ms, ease-out), only `transform` / `opacity`, and respect `prefers-reduced-motion`.
- No emoji as icons — inline SVG (Lucide / Heroicons style, one stroke width).

## Verify (required, but bounded)

1. Open the file in the browser (`browser_run` → `navigate` to `file://…`).
2. Screenshot at 1440×900 and at 390×844. Look at both: overflow, cramped spacing, unreadable text, broken dark mode.
3. Fix what you see and screenshot once more. At most two rounds — polish that needs a third is a note for the user.
   Report the file path and what the page contains in two lines.
