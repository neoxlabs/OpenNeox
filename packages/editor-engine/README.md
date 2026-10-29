# NeoX Editor Engine

This package is the NeoX-owned editor runtime. It is intentionally not treated as a third-party vendor patch layer.

Product code should not import the low-level runtime directly. Use the renderer engine wrapper under:

`apps/desktop/src/ui/renderer/modules/editor/engine`

The Vite `monaco-editor` alias points here so existing Monaco-compatible imports resolve to the NeoX editor engine runtime.
