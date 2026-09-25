---
name: "UI Testing"
description: "对 Web 页面/应用做真 UI 测试:视觉回归 / 响应式 / a11y / 性能 / 端到端交互 / 报告"
description_en: "Real UI testing for web pages: visual regression / responsive / a11y / perf / e2e interactions / structured report"
user-invocable: true
neox:
  category: browser
  aliases: [ui-test, uitest]
  allowedTools:
    - browser_list_surfaces
    - browser_navigate
    - browser_get_state
    - browser_screenshot
    - browser_set_viewport
    - browser_wait_for_network_idle
    - browser_wait_for
    - browser_wait_for_navigation
    - browser_highlight
    - browser_a11y_scan
    - browser_get_perf_metrics
    - browser_export_storage_state
    - browser_import_storage_state
    - browser_get_aria_tree
    - browser_query
    - browser_get_text
    - browser_get_bbox
    - browser_get_computed_style
    - browser_get_full_dom
    - browser_click
    - browser_type
    - browser_press_key
    - browser_scroll
    - browser_hover
    - browser_select_option
    - browser_fill_form
    - browser_get_console_logs
    - browser_get_network
    - browser_get_response_body
    - browser_expect
    - browser_eval
    - browser_record_start
    - browser_record_stop
    - browser_throttle
    - browser_pdf
    - browser_new_tab
    - browser_close_tab
    - open_surface
    - readfile
    - write_file
    - execute_shell
  dangerLevel: safe
---

## Overview

Neox agent 拥有 47 个 browser_* 工具,可以做**真 UI 测试**——不只是"打开页面看看",而是产品级的:视觉回归 baseline 对比、响应式多视口验证、可访问性 WCAG 扫描、Core Web Vitals 性能采集、端到端交互流验证、结构化报告输出。

**核心原则**:UI 测试是**收集证据的过程**,不是操作页面的过程。每一步都留下可查的 artifact(截图 / diff png / a11y 违规 / 性能数据 / 视频),最后汇总到用户能读的报告。

## When to invoke

用户请求含以下语义时**必须**用这个 skill:
- "帮我测试这个页面 / 网站 / 组件"
- "看看这里有没有 UI 问题 / 视觉 bug / 布局错"
- "跑一遍视觉回归 / regression / diff"
- "检查响应式 / mobile / iPhone / iPad"
- "扫可访问性 / a11y / WCAG"
- "拿性能指标 / LCP / CLS"
- "自动化点击流程 / e2e"

普通"打开网页看看"不需要开这个 skill,直接 `browser_navigate` + `browser_screenshot` 就够。

## Standard workflow

按下面顺序走,不能跳步:

### Phase 1: Setup

1. **确认有可用的 browser surface**:`browser_list_surfaces`
   - 若为空 → `open_surface({kind:"web", source:{type:"url", url:"..."}})`
2. **设视口**:`browser_set_viewport({ width, height, deviceScaleFactor })`
   - 桌面基线:`1440×900` 或 `1920×1080`,`deviceScaleFactor: 2`(Retina)
   - 响应式测试至少跑 3 个:桌面 + 平板(`1024×768`) + 手机(`390×844, isMobile: true`)
3. **导航到测试目标**:`browser_navigate({ url, waitUntil: "load" })`
4. **等到页面真正就绪**:`browser_wait_for_network_idle({ idleMs: 500, timeout: 15000 })`
   - **必须做**——`navigate` 的 waitUntil:load 只等 window.onload,不等 SPA 后续 XHR / 懒加载图片
   - 如果站点用 skeleton loader,再 `browser_wait_for({ kind:"selector", selector:"[data-loaded]", state:"visible" })` 兜底

### Phase 2: 视觉回归(视觉是第一优先级)

**首次跑**——建立 baseline:
```
browser_screenshot({
  fullPage: true,
  baseline: "landing-page-desktop",   // 命名:<页面>-<视口>
  baselineMode: "save",
})
```

**后续跑**——对比 baseline:
```
browser_screenshot({
  fullPage: true,
  baseline: "landing-page-desktop",
  baselineMode: "compare",
  diffThreshold: 0.02,   // 2% 像素差异内算通过
})
```

返回 `diff: { ratio, passed, diffBase64, diffPixels }`。**passed:false** 时,把 `diffBase64` 写文件供用户看:
```
write_file(".neox/ui-reports/diff-<name>-<timestamp>.png", <decode base64>)
```

**元素级视觉回归**:只关心某组件时用 `selector`:
```
browser_screenshot({ selector: ".hero-banner", baseline: "hero-banner-desktop", baselineMode: "compare" })
```

### Phase 3: 响应式(多视口重跑 Phase 2)

按下面这组视口每个跑一遍 Phase 2:
| 名称 | 视口 | 场景 |
|---|---|---|
| desktop | 1440×900, dpr 2 | 主要桌面 |
| laptop | 1366×768, dpr 1 | 常见笔记本 |
| tablet | 1024×768, dpr 2 | iPad |
| mobile | 390×844, dpr 3, isMobile: true | iPhone 14 |

baseline 名带视口后缀:`landing-page-mobile`。

### Phase 4: 可访问性(a11y)

```
browser_a11y_scan({ minSeverity: "moderate" })
```

返 `violations: [{ id, impact, description, helpUrl, nodes }]`。**critical / serious 必须 0**;moderate 记录到报告让开发决定;minor 忽略。

若测的是登录后页面,先 `browser_import_storage_state({ name: "logged-in-user" })` 恢复登录态(前提是之前跑过一次 `browser_export_storage_state`)。

### Phase 5: 性能

```
browser_get_perf_metrics()
```

返 `{ lcp, fcp, cls, ttfb, dcl, load, jsHeapUsed, jsHeapTotal }`。红线:
- LCP > 2500ms → warning;> 4000ms → fail
- CLS > 0.1 → warning;> 0.25 → fail
- FCP > 1800ms → warning
- TTFB > 800ms → warning(网络慢的话可能是服务端问题,不完全是前端)

### Phase 6: 端到端交互(有 flow 要跑时)

**每次交互前先高亮**——让用户 & agent 都看清:
```
browser_highlight({ selector: "#login-btn", durationMs: 800 })
browser_click({ selector: "#login-btn" })
browser_wait_for_navigation({ timeout: 10000 })
```

登录流:
```
browser_type({ selector: "#username", text: "..." })
browser_type({ selector: "#password", text: "..." })
browser_click({ selector: "[type=submit]" })
browser_wait_for({ kind: "url", urlPattern: "**/dashboard" })
browser_export_storage_state({ name: "logged-in-user" })   // 存下登录态复用
```

复杂表单用 `browser_fill_form({ fields: [...] })` 一次填完。

### Phase 7: 报告输出

汇总所有结果写 Markdown 报告到 `.neox/ui-reports/<timestamp>.md`:

```markdown
# UI Test Report · <URL> · <timestamp>

## Visual regression
| Viewport | Baseline | Diff ratio | Passed |
|---|---|---|---|
| desktop | landing-page-desktop | 0.008 | ✅ |
| mobile | landing-page-mobile | 0.043 | ❌ (diff png: ./diff-*.png) |

## Accessibility
| Impact | Count | Ids |
|---|---|---|
| critical | 0 | - |
| serious | 2 | color-contrast, label |
| moderate | 5 | ... |

## Performance
| Metric | Value | Status |
|---|---|---|
| LCP | 1820ms | 🟢 good |
| CLS | 0.15 | 🟡 warning |
| ...

## E2E flows
- ✅ 登录 → dashboard
- ❌ 结算 → 支付网关:step "点击 [提交订单]" 失败,元素找不到

## Artifacts
- Baselines: `~/.neox/browser-artifacts/<sid>/baseline/`
- Diffs: `.neox/ui-reports/diff-*.png`
- Storage state: `~/.neox/browser-artifacts/<sid>/storage-state/`
```

## 特殊场景

### 需要录视频演示 bug
```
browser_record_start({ maxFps: 10, quality: 75 })
// ... 各种交互
browser_record_stop({ filename: "bug-repro-<name>" })
```
返 `framesDir`,里面有 `meta.json` 带 ffmpeg 拼 mp4 的命令。让用户或 skill 手动跑 `execute_shell("cd <framesDir> && ffmpeg ...")` 生成 mp4。

### 需要测慢网络
```
browser_throttle({ preset: "slow-3g" })
// ... 跑同一批测试
browser_throttle({ preset: "no-throttle" })   // 记得复位
```

### 需要测离线
```
browser_throttle({ preset: "offline" })
browser_navigate({ url: "..." })   // 应该看到 offline 页面
browser_screenshot({ baseline: "offline-page", baselineMode: "compare" })
```

### 只想看某组件的 CSS 是不是正确
```
browser_get_computed_style({
  selector: ".primary-btn",
  properties: ["color", "background-color", "border-radius", "font-weight"],
})
```

### 深度 DOM 分析(拿完整 HTML)
```
browser_get_full_dom({ selector: ".form-container", maxBytes: 100000 })
```
只有必要时才用——多数场景 `browser_get_aria_tree` 已经够。

## 反模式(不要做)

- ❌ **不做 baseline 直接 compare** → 结果是 error "baseline 未找到"。第一次必须 save。
- ❌ **不 wait_for_network_idle 就截图** → 抓到骨架屏或懒加载缺图,diff 假阳性。
- ❌ **响应式测试不切 viewport 就截图** → 用默认视口(通常 1280)测所有断点,毫无意义。
- ❌ **不 highlight 就 click** → 用户看不到 agent 打算点哪儿,失败时无法回溯。
- ❌ **a11y 违规直接 fail 报错**——列出等用户看,不代表页面完全不能用。
- ❌ **视频录制忘记 stop** → 内存持续攒帧。写代码时 record_start / record_stop 必须成对且带 try-finally 语义。
- ❌ **跨会话不用 storage_state** → 每次都手动登录,慢且脆弱。

## 已知边界

- 视觉 diff 靠 pngjs + pixelmatch;截图尺寸不一致(视口变了 / 页面变高)会返 error 提示重跑 baseline
- axe-core 从 CDN 拉,离线环境会失败——可 fallback 让 agent `browser_eval` 直接注入 axe 源码
- browser_pdf 走 CDP Page.printToPDF,Chromium headful 也支持,不受 Playwright headless 限制
- 视频当前是 JPEG 帧序列,mp4 需要用户/agent 后置调 ffmpeg 拼
- 所有 artifact 落 `~/.neox/browser-artifacts/<surfaceId>/`,agent 生成的**报告** 落 workspace `.neox/ui-reports/`,两个位置分开

## 完成后

- 明确告诉用户:通过 / 部分通过 / 失败
- 关键 artifact 路径(diff png / 报告 md / 视频帧目录)贴出来
- 有 failed 的建议下一步(比如"CLS 高看下 hero 图 aspect-ratio")
