# Browser Brand Icons — Source & License

Fetched by `apps/desktop/scripts/fetch-browser-icons.sh` from the
**simple-icons** project, published under **CC0 1.0 Universal** (public domain).

- Project: https://github.com/simple-icons/simple-icons
- License: https://creativecommons.org/publicdomain/zero/1.0/

Each mark is the trademark of its respective owner. We use them only to identify
which browser Neox launched on the user's machine (nominative use) — descriptive,
and implying no affiliation, endorsement, or sponsorship.

## Chromium 没有独立 mark
simple-icons 已下架 `chromium` slug (2026-08 实测 404)。Chromium 与 Google Chrome
外形本就是同一套, 区别只在配色, 所以渲染层对 chromium 复用 `googlechrome.svg`,
配 Chromium 蓝 (#4587F3) 而不是 Chrome 的 #4285F4。见
`modules/surface/viewers/BrowserBrandIcon.tsx` 的 BROWSER_BRANDS。

## 为什么是单色
simple-icons 的 mark 一律是单 path 无 fill 的单色图形。渲染时由
`BrowserBrandIcon` 注入官方 brand hex —— 跟 FileTypeIcon 完全同一套做法
(见 assets/icons/file-types/LICENSE-NOTICE.md)。

To re-sync:

    bash apps/desktop/scripts/fetch-browser-icons.sh
