---
name: /ppt-outline
description: Generate a PPT-style slide outline for a topic
category: Plugin
usage: "/ppt-outline <topic>"
---

Generate a slide outline for the following topic in **8–10 slides**.

Topic: $ARGUMENTS

For each slide, return:
  - A title (one line, no prefix)
  - 2–4 concise bullet points

Format your answer as JSON (array of slides) so downstream tools can parse it:

```json
[
  {"title": "...", "bullets": ["...", "..."]},
  ...
]
```

No extra commentary.
