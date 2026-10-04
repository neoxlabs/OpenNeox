---
name: "Data Chart"
description: "把数据做成清楚好看的图表 (网页交互图 / PNG), 选对图型、标清单位"
description_en: "Turn data into clear, good-looking charts (interactive HTML or PNG): the right chart type, labeled units"
user-invocable: true
neox:
  category: creative
  aliases: [chart, graph, viz]
  dangerLevel: safe
---

## Overview

Start from the question the chart must answer, then pick the type — not the other way round.
Default deliverable: one `.html` file with the chart (ECharts or Chart.js from a CDN, or plain SVG for simple ones).
If the user wants an image or it goes into a document, also export a PNG (ECharts `getDataURL` / a browser screenshot).
In a Python project, matplotlib/plotly is fine — same rules apply.

## Pick the type

| Question | Chart |
|---|---|
| Change over time | line (bars if few periods) |
| Compare categories | horizontal bar, sorted |
| Part of a whole (≤ 5 parts) | stacked bar; pie/donut only if parts are few and very different |
| Distribution | histogram / box plot |
| Relationship between two numbers | scatter |
| Many series over time | small multiples, not 10 lines on one chart |

## Rules

- Title states the finding ("Sales doubled after March"), subtitle states the data and period.
- Axis labels with **units**; y-axis starts at 0 for bars; readable number format (1.2M, 34%).
- One highlight color for what matters, grey for context; colorblind-safe palette; no 3D, no gradients on data.
- Label directly where possible instead of a legend. Show the source.
- Do the math in code (sums, growth, grouping) — never eyeball numbers from the data.

## Verify (required, but bounded)

Open it in the browser once, screenshot, and check: labels readable, nothing overlapping, numbers match the data
you computed. Fix and re-check at most once. State the one-sentence takeaway with the file path.
