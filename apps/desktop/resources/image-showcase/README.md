# Image studio discovery-wall showcase

Pre-generated category thumbnails for the Images empty state (`主图` / `美食` / …).

- Bundled via `electron-builder.json` → `extraResources/image-showcase`
- At runtime `image:showcase` seeds them into `<userData>/neox-artifacts/showcase/`
  (required because `neox-asset://` only serves the artifacts root)

Regenerate: produce one image per `CATEGORIES[].key` in
`ImageDiscoveryLanding.tsx`, save as `<key>.webp` (≤1280px) here.
