---
name: "PPT Deck Writer"
description: "逐页生成 pptx · deck_begin 规划 → deck_add_slide 每页一次 → deck_export 导出并自检 → open_surface 交付. 全程在 Neox 里跑."
description_en: "Build a .pptx page by page with Neox's native slides engine: deck_begin → deck_add_slide → deck_export (self-checked) → open_surface."
user-invocable: true
neox:
  category: content
  aliases: [make-pptx, slides, pptx, deck, make-slides]
  allowedTools:
    - deck_begin
    - deck_add_slide
    - deck_export
    # 模板元数据/slot 签名的唯一真源
    - list_slide_templates
    # 5 页以内的快捷口 (注意: 它走 renderer 的老模板, 观感和逐页工具不是一套)
    - create_slides
    - open_surface
    - generate_image
    - web_fetch
    # 工具真名是 readfile (无下划线)
    - readfile
---

# PPT Deck Writer

给用户生成一份**可编辑的** .pptx (不是截图 PDF), 用户能在 PowerPoint / Keynote / WPS 打开继续改。

心智: 你在**逐页**调用 Neox 自研的声明式排版引擎。每页一次工具调用, 右侧画布实时长出这份 PPT。
引擎做真实字体测量 + 自动换行 + 元素自动下推, **重叠在架构上不可能发生**; 你只管内容和页型。

美学定位: **简洁编辑感杂志排版**。一整幅电影分镜, 不是控制台 UI。

全程在 Neox 里跑, **用户什么都不用装**。不要写脚本, 不要跑 node, 也不要安装任何第三方 pptx 库。

---

## 【必读】开工前先读三份规范

- **`references/content-rules.md`** — 叙事 / 密度 / 章节结构 / 事实核验
- **`references/visual-rules.md`** — 排布只走模板 / 字号下限 / 标题一行 / **图片来源**
- **`references/qa-checklist.md`** — 交付流程细节 / 常见 fail 修法

## 流程

### 1. 明确目的 + 视觉大纲

一句话对齐: 观众 · 用途 · 大约几页。有缺就自己合理设默认。

**先输出一段"视觉大纲"再动手** —— 每页一行, 标出页型 + 焦点类型:

```
1. cover-hero       · 大字 hero + subtitle (视觉重)
2. hero-image-quote · 一句话引言 (呼吸页)     ← 视觉停顿
3. title-body       · 背景
4. bullet-list      · 本季做成的事 (4 条)
5. section-divider  · 01 · 经营数据          ← 章节切换
6. data-focus       · 单个大数字             ← 视觉重
7. data-table       · 分区域营收 (原生表)
8. quote-page       · 结束引言               ← 呼吸收尾
```

**大纲硬约束** (不满足就重排):
- **同页型不能连续 3 次**。
- **每 4 页至少 1 张呼吸页** (`hero-image-quote` / `quote-page` / `section-divider` / `cover-hero`)。
- **重视觉页和文字页交替**, 别全挤在开头或中间。
- **章节 3-5 个**, 每章开头一个 `section-divider`。
- 8 页以上至少一次 `hero-image-quote` 或 `data-focus`。

### 2. 抓素材 (可选)

- 关键事实 → `web_fetch` 多个来源交叉核验 (见 `content-rules.md`)。
- 需要照片 → `web_fetch` Wikimedia 搜索接口拿直链:
  `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=<英文关键词>&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1600&format=json`
  用 `imageinfo[0].thumburl` (1600px), **不要用 `url` 原图** —— 原图动辄 12 MB, 版面只有 1280×720。
  直接把 URL 塞进槽位 `{ uri: <URL> }`, 引擎自己下载嵌入。详见 `visual-rules.md` §图片。

### 3. `deck_begin` —— 规划并冻结风格

```
deck_begin({
  title: '第三季度经营汇报',
  brief: '<用户原话>',              // 不给 styleId 时按它自动挑风格
  styleId: 'corporate-chevron',     // 可选: corporate-chevron(商务) / editorial-capsule(温和) / minimal-line(克制) / bold-ribbon(隆重) / finance-navy(稳健金融: 银行·金融·年报, 藏青+古铜金+钞票细线纹)
  outline: [ { title: '封面', template: 'cover-hero' }, … 整份大纲 … ],
})
```

- 整份 deck **一套风格**, 逐页换风格就是拼凑感 —— 所以风格只在这里定一次。
- 大纲一次规划完整: 右侧会先显示全部骨架, 用户看到的就是你的计划。
- 输出位置默认 `<工作区>/<日期>-<标题>/<标题>.pptx`, 不要往工作区根目录扔。

### 4. `deck_add_slide` —— 每页一次

```
deck_add_slide({ index: 0, slots: { title: '第三季度经营汇报', subtitle: '营收、客户与下季度重点' },
                 decor: { intensity: 'bold', corner: 'br' } })
deck_add_slide({ index: 1, slots: { … } })
…
```

- `index` 是大纲里的位置 (0 起)。可以乱序画, 导出按大纲顺序。
- **同一个 index 再调一次 = 原地替换这一页** (重做失败时旧页保留)。修页就用这个。
- 每次只传一页的内容 —— 这正是逐页的意义: 单次参数小, 不会被截断。
- 某页失败了不影响其余页, 换个页型或精简内容重试同一个 index, 或先跳过。
- 颜色 / 字体 / 字号 / 圆角全部来自冻结的风格, **没有逐页改的入口**, 这是刻意的。

### 5. `deck_export` —— 导出 + 自检

```
deck_export({})
```

- 导出时自动跑排版自检 (真实字体测量: 越界 / 溢出 / 重叠 / 字号下限 / 标题折行)。
- `selfCheck.passed: false` → deck 保持打开, `selfCheck.mustFix` 点名到大纲 index。
  对这些页 `deck_add_slide` (同 index) 重做 —— **删字, 不要缩字号** —— 再 `deck_export`。
- `selfCheck.deckNotes` 是整份的节奏提示 (连续文字页 / 没有章节页 / 全无图), 不拦, 但值得照着改。

### 6. `open_surface` 交付

```
open_surface({ kind: 'pptx', source: { type: 'file', path: '<deck_export 返回的 path>' } })
```

- `open_surface` 用**同一把尺子**再查一遍: Neox 生成的 deck 有必修问题, surface 直接被拒。绕不过去。
- 自检跑不了时 (极少见, 比如文件读不开) 结果里会有 `selfCheck.available: false` ——
  那种情况**严禁说"排版已验证"**, 如实告诉用户没校验成功。
- 生成完不 `open_surface` = 右侧画布空 = 用户以为你没做完。

交付话术一到两句: 做了什么 · 几页 · 保存在哪。**不要**倒自检报告、列模板名、讲过程。

---

## 装饰层 decor

`deck_add_slide` 的 `decor` 在页面底下画一层矢量装饰 (流体色块或几何构成), 用的是这份 deck 自己的配色,
全部出血到版面外。**不需要生图、不花时间、不花钱**, 生不了图时它就是体面的替代。

- `intensity`: `subtle` (只让底不平) / `normal` / `bold` (封面、章节页)
- `corner`: `tr` (默认) `br` `bl` `tl` —— 装饰从哪个角出血
- 形状逐页不同 (按页序), 同一份 deck 每次导出完全一致。

**别每页都加。** 装饰是节奏, 不是底纹 —— 每页都有等于每页都没有。
正文页挑三五页用 `subtle`, 一两张呼吸页用 `normal`, 其余留白。
带色带骨架的页型 (feature-grid / 四个图示页型) 选 `br` / `bl`: 色带会把上方的装饰盖掉。
**不用传 decor 的页型** (工具会忽略并告诉你):
- `cover-hero` / `section-divider` —— 自带整页背景构成, 已经按风格画好了 (稳健金融风格下是钞票细线纹 + 纹章)。
- `data-table` / `chart-focus` —— 版心被占满, 装饰只会横穿内容。

## 配图: generate_image

**先说什么时候该生图。** 矢量图示能表达**关系** (先后 / 对立 / 层级 / 围绕), 照片和插画不能。所以:

| 页型 | 配图 |
|---|---|
| `cover-hero` 封面 | ✅ 默认配一张主视觉 (`backgroundImage`) |
| `section-divider` 章节页 | 可选, 用 `decor: {intensity:'bold'}` 往往就够 |
| 正文页 / 图示页 / 图表页 / 表格页 | ❌ **默认不配** —— 信息在图形和数字里, 塞张 AI 图只会稀释 |
| 用户明确要求"多配点图" | 按用户说的来 |

`generate_image` 返回**真实文件路径**, 直接喂给图片槽位: `backgroundImage: { uri: '<paths[0]>' }`。

硬约束:
1. **一张图要一两分钟**, 所以只给封面这类真需要的页生图, 并发最多 2~3 张。
2. **同一句 prompt 命中持久缓存** (0 秒、不计费), 别为了"换个说法"微调 prompt。
3. **prompt 用英文**, 写全: 主体 + 风格 + 构图 + 配色 + **`no text`** (生成的中文字几乎必然是乱码)。
4. **配色写进 prompt**, 用当前风格的 accent 十六进制值, 否则图和 deck 不是一套。
5. 模型默认 `gpt-image-2`。订阅通道只有 `gpt-image-2` / `nano-banana-2`; BYOK 按用户挂的来。
6. **生图失败不要重试第二遍** —— 基本是配置或额度问题, 把错误原样告诉用户, 改用 `decor`。

## 数值的形状

`kpi-cards` 的每张卡可以带一个形状, 给数字一个**参照系** —— 光一个 "68%" 回答不了"是好是坏、往哪走":

```
cards: [
  { value: '68%',  label: '优先相位覆盖', subLabel: '逐季走势', spark: [41, 48, 52, 60, 64, 68] },
  { value: '42条', label: '专用道线路',   subLabel: '目标 60',  progress: { value: 42, target: 60, max: 70 } },
  { value: '214米', label: '平均换乘距离', subLabel: '目标 200', progress: { value: 214, target: 200, max: 260, lowerIsBetter: true } },
]
```

- 指标**越小越好**时必须传 `lowerIsBetter` (成本 / 时长 / 损失率 / 投诉量), 否则会画成达标色。
- `spark` 缺数据传 `null` **不要传 0** —— 0 是"这期是零", null 是"这期没数据"。
- `spark` 和 `progress` 别同时给, 同时给只画 spark。

## 页码和页脚

**页码不用你写**, 按大纲序号自动编; 封面和章节页不编号 (印刷惯例)。
`footerText` 所有页型都生效, 整份传同一个值即可 (如 "经营分析部 · 2026 Q3")。

---

## 页型选择速查

| 内容形态 | 页型 |
|---|---|
| 封面 | `cover-hero` |
| 目录 / 议程 (2-6 项, 大号编号 + 通到页边的细线) | `agenda` |
| 视觉呼吸页 · 一句话引言 | `hero-image-quote` |
| 单个震撼数字 + 故事 | `data-focus` |
| 章节分隔 | `section-divider` |
| 一段散文 100-180 字 | `title-body` |
| 3-5 个要点 | `bullet-list` |
| 左右两个并列主题 | `two-column` |
| 3 栏并列 (服务概览 / 三段论) | `three-column` |
| 前后 / 问题 vs 方案 (戏剧对比) | `contrast` |
| 2-6 张图 | `image-gallery` |
| 3-4 图错落拼贴 | `photo-spread` |
| 左图右文单主题深度 | `editorial-split` |
| 3-6 步时间轴 | `timeline` |
| 2-4 个数字比较 | `kpi-cards` |
| 3-4 个数字宣言 | `numbers-hero` |
| 表格 (原生可编辑) | `data-table` |
| 一个图表 | `chart-focus` |
| 一段引语 | `quote-page` |
| 一句话宣言 极大字 | `manifesto` |
| icon + 短说明 3-6 格 | `feature-grid` |
| **有先后**的 3-5 步 | `process-flow` |
| **两个方案对立** | `versus-page` |
| **2-4 层高低之分** | `hierarchy-page` |
| **3-4 级逐级收窄** | `funnel-page` |
| **3-6 个要素围绕一个核心** (无顺序) | `orbit-page` |

**图示页型的选型是语义判断, 不是审美判断。** 它们画的是内容里的**关系**: 先后 / 对立 / 高低 / 流失 / 围绕。
关系不成立就不要用 —— 拿 `funnel-page` 去画三个**并列**的要点, 观众会去找那个不存在的流失关系。
**图示画错比不画更糟** (纯并列请用 `feature-grid` / `three-column`)。

- `hierarchy-page` 的 levels **从高到低**, `funnel-page` **从多到少** —— 顺序就是含义, 传反了没有任何断言会拦你。
- `process-flow` 超过 5 步每格就放不下, 拆两页或换 `timeline`。
- 每个图示页都给一句 `note`: 图讲"怎么走", note 讲"所以呢"。

**槽位签名以 `deck_add_slide` 的工具说明 / `list_slide_templates` 为准** —— 那份是从引擎直接读的, 别猜字段名。
常见踩坑: 底部小字是 `footerText` (不是 `footer`) · KPI 卡片是 `cards` (不是 `kpis`) ·
timeline 步骤是 `{label, detail}` · section-divider 是 `sectionNumber` + `title`。

补充语义:
- `chart-focus` 的 `variant: 'editorial'` 是杂志式画法: 不画刻度网格, 柱子两色交替并排贴在地面带上,
  柱顶直接写数值 + 类目 (+ data 里的 `note` 小注), 左栏标题下写一句 `note` 结论。只对**单系列、非负的柱状图**生效,
  稳健金融风格默认就是它。要比较精确量级或有负值、多系列时用标准画法。
- `chart-focus` 的 `chartType` 是**语义选择**: `line` 同一个量随时间 · `column` 类目比高低 · `bar` 横向排名 · `stacked` 构成 + 合计。
  缺数据给 `null` 不要给 0。多系列给 `categories` + `series`, 不要自己指定颜色。
- `feature-grid` 的 `icon` 是**语义**槽位: 只在图标和这一项有真实对应时传 (病虫预警 → warning · 机收减损 → truck);
  想不出配哪个就别传, 硬凑一个比不配更糟。
- `process-flow` 的 `variant`: separated (默认) / interlocked / ribbon / stair (**最后一项是目标**) / chain。
- 图片槽位: `{ uri: 'https://...' }` 或本地绝对路径 `{ uri: '/Users/.../foo.jpg' }`, 引擎自己下载 / 读盘嵌入。

---

## 反模式 (违反 = 失败)

- ❌ 写脚本 / 跑 node / 安装任何第三方 pptx 库 (`pptxgenjs` / `python-pptx` / officegen)。Neox 引擎是唯一出口。
- ❌ `create_slides` 做 6 页以上 (单次 JSON 会被截断, 用逐页工具)。
- ❌ 自检没过就 `open_surface` (会被拒, 白走一轮)。
- ❌ 生成完不 `open_surface` (用户看不到)。
- ❌ 缩字号救急 · 让标题两行 —— 删字。
- ❌ 每页都加装饰 / 每页都生图。
- ❌ 用 kpi-cards + 标签造仪表盘感 (见 `visual-rules.md`)。
- ❌ 泄漏 planning 语言 / 时间脚手架到成品 (见 `content-rules.md`)。
- ❌ 猜 Wikimedia hash 路径 / 猜 Unsplash photo-id / 用 random 端点 (见 `visual-rules.md` §图片)。

## 两条路的分工

- **逐页工具 = 主路.** 任意页数 (20 页 / 30 页都行) · 24 个页型 · 精准测量 · 实时预览 · 导出自检。
  用户问"能做 30 页 PPT 吗" → **能, 走这条**。
- **`create_slides` = 快捷口, 硬上限 5 页且文本极简.** 上限来自单次工具调用的 JSON 长度 (再长会中途损坏, 不可恢复),
  而且它走的是 renderer 的老模板, 观感和逐页工具不是一套。3 页以内结构规整、又不需要预览时才用。
