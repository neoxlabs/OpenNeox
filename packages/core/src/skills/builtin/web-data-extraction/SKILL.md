---
name: "Web Data Extraction"
description: "从网页/管理后台高效提取与统计数据:按数据源分层 (XHR 接口 > DOM > 可访问树 > 截图),避免截图慢读和逐页翻页"
description_en: "Efficient data extraction from web apps: layered sources (captured XHR/API > DOM > aria tree > screenshot), avoid screenshot-reading and page-by-page crawling"
user-invocable: true
neox:
  category: browser
  aliases: [web-scrape, data-extract, grab-data]
  allowedTools:
    - browser_run
    - browser_navigate
    - browser_wait_for_network_idle
    - browser_wait_for
    - browser_get_network
    - browser_get_response_body
    - browser_eval
    - browser_get_text
    - browser_query
    - browser_get_aria_tree
    - browser_get_state
    - browser_click
    - browser_type
    - browser_fill_form
    - browser_press_key
    - browser_get_cookies
    - browser_export_storage_state
    - browser_import_storage_state
    - browser_screenshot
    - browser_scroll
    - open_surface
    - readfile
    - write_file
  dangerLevel: safe
---

## Overview

从网页提取数据时,**页面只是接口的壳**。绝大多数管理后台/列表页的数据来自 XHR/fetch 接口,
接口返回的 JSON 比页面渲染出来的 DOM 更完整、更结构化、拿得更快。截图是给人眼看的,
不是给统计用的。

**不适用**: 做题、填表、下单、玩网页这类"像人一样用页面"的任务。那种任务照着屏幕上显示的内容
读、然后点/填, 不要去扒站点接口或隐藏数据 (比如带答案的响应) 抄近路。

**核心原则:按数据源分层,从最结构化的源开始,逐层降级。**

## 数据源优先级

| 层 | 工具 | 适用 | 不适用 |
|---|---|---|---|
| 1. XHR/API 抓包 | `browser_get_network` + `browser_get_response_body` | 全量数据、统计、跨页汇总、导出、Top-N | 纯静态页 |
| 2. DOM 结构化读取 | `browser_eval` 一次取整表 | 当前页可见数据、按钮/筛选项/状态 | 虚拟滚动、需要跨页 |
| 3. 可访问树/文本 | `browser_get_aria_tree` / `browser_get_text` | 快速判断页面结构、标题、表单 | 复杂表格、折叠组件 |
| 4. 截图 | `browser_screenshot` | 布局、图表、样式等纯视觉问题 | 一切统计/字段提取 |
| 5. 前端状态 | `browser_eval` 读 store/localStorage | SPA 数据已在前端变量里时 | 结构不稳定,当探索手段 |

## Standard workflow

**全部走 `browser_run`, 一条脚本做完, 别一个工具一次往返。** 上面表里的工具名去掉 `browser_`
前缀就是脚本里的 action (navigate / get_network / eval / get_text …)。

```
第 1 次调用 —— 看一眼:
  browser_run({steps:[{action:"navigate", args:{url}}]})
  · 结果自带 page.structure (表格/分页/筛选器) 和 page.actionable (可用 ref 直接点)
  · 需要登录就在同一条脚本里先 fill_form + click (凭据问用户, 不要猜)

第 2 次调用 —— 拿数据 + 算完:
  browser_run({steps:[
    {action:"get_network", args:{resourceType:"fetch"}},          // 列出数据接口 (list/query/page/search)
    {action:"eval", args:{expression:"fetch('/api/xxx?pageSize=1000').then(r=>r.json()).then(d=>JSON.stringify({total:d.length, ...统计}))"}}
  ]})
  · 页面里的 fetch 自动带 cookie, 通常无需破解 token; 有分页就改 pageSize 或在 eval 里循环翻页
  · 接口 401/加签/难复刻 → 同一条脚本里降级 DOM:
    eval "JSON.stringify([...document.querySelectorAll('tbody tr')].map(tr=>[...tr.cells].map(c=>c.innerText)))"
  · 统计/汇总在 eval 里用代码做完再回来, 不要把整表拉回来肉眼数

第 3 次 —— 回答。按用户指定格式; 大结果写文件 (write_file) 别刷屏。
```

## 反模式 (禁止)

- ❌ 一上来 `browser_screenshot` 再"看图读数据" — 慢、漏字段、不可统计
- ❌ 先 `browser_get_text` 读整页文本再想办法 — 全量文本又贵又乱, 先看接口
- ❌ 为了"全部 N 条"逐页点分页 + 每页截图 — 改 pageSize 或循环接口参数
- ❌ 统计类需求只读当前页 DOM 就报数 — DOM 只有当前渲染的一页, 必须声明口径

## When to invoke

用户请求含以下语义时用这个 skill:
- "统计/汇总全部数据"、"导出所有记录"、"算 Top10"、"按 X 分组"
- "把这个后台/列表/表格的数据拿出来"
- "抓取这个页面的数据"、"跨页汇总"

只看当前页面上有什么("这页显示了什么"/"读一下这个表格")不用开 skill,
直接 `browser_eval` 读 DOM 即可 — 但同样禁止用截图读数据。
