# 视觉规范

Neox PPT 的美学: **简洁编辑感杂志排版**. 一整幅电影分镜, 不是控制台 UI. 内容 90% 走模板, 装饰 10% 走 primitives, 手拼形状 = 违规.

---

## 心智一句话

**Deck 是一系列杂志跨页, 不是网页/APP/仪表盘.** 观众用眼睛扫, 不用点击. 视觉词汇不同:
- ✅ 大字 · 留白 · 一张主图 · 一条 accent 线
- ❌ 卡片墙 · 药丸标签 · 按钮框 · Tab · 徽章 · Dashboard

---

## 内容排布只走模板 · 手拼 shape 只允许结构装饰

这条最重要. 违反 = "Day 1-5 5 列小字挤成表"那种丑图.

### 允许
- 通过 primitives 调用: `heroGradientBackdrop` / `accentBar` / `divider` (模板内部会用, 你也可以在特殊场景补一根 accent bar)
- 单纯的背景色 / accent bar / 分割线 / 页脚 pageNumber

### 禁止
- `slide.shapes.addText(...)` 直接铺正文
- `slide.shapes.addRect / addEllipse / addLine` 拼成卡片 / 分栏 / 表格 / 图标
- 用 for 循环 addText 造 N 列 / N 行内容
- 手动造 KPI 卡 / timeline / bullet list

**遇到"模板装不下"就换模板, 别手拼**:
- 5 天并列展开 → `dataTable` (5 列, 每列一天)
- 6 步以上流程 → 拆两片 `timeline`
- 想要 4 个以上 KPI → 拆两片 `kpiCards` (每片 2-3 个)
- 想要复杂拼图 → 换 `imageGallery`

---

## 字号下限 · 靠模板默认 · 手写别缩

Neox 模板已经贴着可读下限设:

| 元素 | 我们默认 | 是硬底 |
|---|---|---|
| 封面 hero title | 60pt | 不允许 < 50pt |
| slide 页标题 (h1) | 36pt | 不允许 < 35pt |
| 中标题 / 卡片标题 (h2) | 26pt | 不允许 < 24pt |
| 正文 body | 18pt | 不允许 < 16pt |
| 副文 / label / kicker | 14pt | 不允许 < 14pt |
| footer / pageNumber / 极小注释 | 11pt | 允许 (被 inspect 豁免) |

**内容超模板的时候**: 删字, 别缩字号. 缩字号 = 观众读不清 = 失败.

模板自带 typographyBudget 是设计过的, 除非用户提出强需求, **不要 override**.

---

## 标题一行 · 不允许换行

标题 / 章节名 / hero title / KPI 数字这些**明确为一行设计**的元素, 绝对不能换行.

inspect 里 `title-wraps-multi-line` 报的 = 必修. 修法优先级:
1. **删字** (18 字标题剪成 12 字, 或换更短说法)
2. 拓宽 box (影响整片构图, 少用)
3. 缩字号 (最下策, 违反字号下限时坚决不用)

多行元素 (bullet 每条 / body 段落) 允许 wrap, 但每条也不该超 2 行.

---

## 图片 · Wikimedia generator=search 一条 URL 拿直链

**图源优先级 (2026-08-10 起)**:
1. **`generate_image`** —— 概念图 / 插画 / 氛围图 / 主视觉。可控、配色能对齐主题、
   有持久缓存。**默认只给封面和章节页用**, 详见 SKILL 的"配图"一节。
2. **Wikimedia** —— **写实**内容: 真实地点、历史照片、人物、具体实物。
   这类东西生成出来是"像那么回事但不是那个东西", 用真图才站得住。
3. 两者都不合适就**不放图**, 走 pageDecor 的矢量装饰 —— 空着比放张不相干的图好。


**唯一批准的图片检索方式** (跨模型通用 · 任何有 web_fetch / curl 的 agent 都能干):

```
https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=<query>&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1600&format=json
```

- `gsrnamespace=6` 只查 File namespace, 返 10 张
- **用 `imageinfo[0].thumburl`** (加了 `iiurlwidth=1600` 才有), 零手拼。
  **不要用 `imageinfo[0].url`** —— 那是原图。2026-08-10 实测: 同一张 Bali 梯田,
  原图 4032×2688 / **12.2MB**, `iiurlwidth=1600` 的缩略图 **1.2MB**, 差 10 倍;
  而版面只有 1280×720, 1600px 已经有 1.25 倍余量, 满幅出血也够。
  一份三图 deck 因此从 **23MB 降到 ~2MB** —— 23MB 的 pptx 是发不出去的。
- 中文关键词命中率低, 用英文: `Shanghai skyline` / `xiaolongbao dumpling` / `Great Wall China`

Neox 有 `heroGradientBackdrop` gradient 无图变体, **没图也好看**, 不要为了"塞张图"塞离谱的图.

### 图片来源优先级

1. **用户提供** (drop 进来 / 项目里已有) — 最稳
2. **Wikimedia `generator=search`** 唯一批准的图片 API (上面 URL 模板) — **首选**
3. **Bing images async** endpoint (Wikimedia 完全没命中时应急): `curl -A "Mozilla/5.0" "https://cn.bing.com/images/async?q=<query>&count=10&mmasync=1"` grep `murl` 字段
4. **AI 生成** (如果 `image_gen` 在): 明确 aspect + 主体位置
5. **不放图**: 走模板显式无图变体 (`heroImageQuote else` / `cover-hero` else · gradient + 立柱)

### 禁: 手拼 / 猜 URL · 100% 挂

任何模型都**不能**靠猜出真实图片 URL:

- ❌ 猜 `images.unsplash.com/photo-<id>` — 猜的 photo-id 基本 404
- ❌ 手拼 `upload.wikimedia.org/wikipedia/commons/a/b/File.jpg` 的 hash — md5 前两位不可推测
- ❌ 用 `titles=<page>&prop=images` — 只返 File 名不返直链 · 诱使 agent 去手拼 hash · 全 404
- ❌ `web_fetch` Wikipedia 条目页再从 HTML 拼图 URL — 两跳失败概率翻倍
- ❌ `source.unsplash.com/*` / `picsum.photos` / `loremflickr` / `via.placeholder.com` / 任何 random 端点 — 返随机图跟主题无关, create_slides 直接报错拒绝
- ❌ Google / Bing / Baidu **搜索结果页** URL — 那是网页不是图

Neox 的 create_slides / exporter 遇到失败 URL 直接报错 (不再兜底). 只走 Wikimedia `generator=search` 那一条模板稳.

### 拿图 → 塞 slot 是一步不是两步

一次搞定, 不要"下载到本地再引用":

- **首选** · 直接传 URL, 引擎自动下载嵌入: `image: { uri: "<https URL>" }`
- 本地已有文件 (用户 drop 进来的照片 · 之前 turn 生成的图): `image: { uri: "/absolute/path.jpg" }` — **本地绝对路径也认** (引擎自动读盘, 不用 readFileSync 转 base64)
- 已经拿到 bytes: `image: { blob: <ArrayBuffer>, contentType: 'image/jpeg' }`

**别做**: 先把图下载到本地、再想办法引用 → 中间一步漏了 pptx 就没图 (曾出错误: 下了 11 张图 pptx 只 35 KB 空版). URL 直接进槽位.

### 请求 AI 生成图时

明确写清 aspect + 主体位置:
- "横版 16:9 · 长城航拍 · 蜿蜒山脊 · 傍晚金光"
- "竖版 3:4 · 人物半身像 · 位于图片右侧 · 左侧留白给文字"

图找不到 / 生成失败 → **删掉 image 字段**, 走模板显式无图变体. 不要死等 · 不要瞎塞离谱 URL.

### 用图不重复

同一张图整份 deck 只用一次 (背景色除外). 每片 slide 用图必须不同.

---

## 一份 deck 一套风格 (StyleSpec)

不要 slide A 一套、slide B 另一套。全局统一 —— 逐页换风格正是"第 3 页和第 17 页
不像一套"的根因。

**风格不只是配色。** 一个 StyleSpec 冻结四样: 配色 + **形态语言 (motif)** +
字号尺度 + 中英字体配对。所以换风格换的是整套观感, 不是换个主题色。

4 套 (id 传给 deck_begin 的 styleId; 不传就按 brief 自动挑):

| id | 定位 | 形态 | 中文字面 |
|---|---|---|---|
| `corporate-chevron` | 商务推进 · 汇报/发布/提案 | 斜切箭羽 | 黑体 |
| `editorial-capsule` | 温和叙事 · 课件/品牌故事 | 圆角胶囊 | 圆体 |
| `minimal-line` | 克制专业 · 技术方案/数据复盘 | 细线 | 宋体 |
| `bold-ribbon` | 隆重仪式 · 表彰/里程碑/党政 | 绶带 | 楷体 |

风格在 `deck_begin` 定一次, 之后每页都自动套用 —— `deck_add_slide` 没有改配色 / 字号的入口, 这是刻意的。

⚠️ 在槽位里传 `theme` **无效** —— 模板根本不读 `slots.theme`, 传了会被静默忽略。

想要"高亮"不用切风格, 用 `sectionDivider` 天然反色 (深底白字) 就够用。

---

## 留白是内容的一部分

- 每片 slide 别塞满, 上下左右留视觉呼吸
- Neox 模板默认已经算好 PAGE.padH / padTop margin, **不要在 slots 里改**
- 两块内容之间空 `SPACE.xl` (~32px) 让层次读得出

看到成品觉得"这页透气", 就对了.

---

## overlap 必须清零

inspect 报 `text-overlap` = 两个文本框在同一位置重叠 → 必修.

- 位置算错了 → 修坐标
- 内容太长挤到别的 box → 缩短内容
- 模板本身冲突 → 换模板

装饰几何 (hero 的椭圆背景) 允许溢出边缘, 那是设计意图, inspect 已经豁免. 报出来的 overlap 都是真 bug.

---

## 常见反面样例 → 正例

| 反面 | 正例 |
|---|---|
| 4 图网格里出现无关笑脸白男 (Unsplash 搜索 URL 返随机) | `imageGallery` 传 4 张 Wikimedia 具体条目主图, 或不放图 (纯 caption + 单色底) |
| 5 列小字挤成"信息面板"感 (手拼 shape) | `dataTable` (5 列 × 4 行 headers/内容/时间) 或 拆两片 `timeline` |

## htmlDecor 装饰背景上的文字

**别用裸的 `theme.accent`。** 2026-08-10 实测六个 preset (editorial-capsule):

| 取色 | 亮色 preset | 深色 preset (abstractGeometry) |
|---|---|---|
| 裸 `theme.accent` | 4.04~4.27 ✗ | 3.22 ✗ |
| `readableAccent(theme.paper)` | 4.49~4.75 ✓ | **2.90 ✗** (喂错底色) |
| `theme.ink` | 13.0~13.8 ✓ | 1.00 ✗ |
| `theme.onInk` | 1.02~1.08 ✗ | 14.09 ✓ |

规则: **按 preset 的深浅选** —— 亮色用 `theme.ink`, 深色 (abstractGeometry) 用
`theme.onInk`; 要用 accent 就过 `readableAccent(那个底色)`, 而且**底色要喂对**。
