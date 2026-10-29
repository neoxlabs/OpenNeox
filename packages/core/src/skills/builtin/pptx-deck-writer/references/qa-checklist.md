# 交付前检查单

**每张 slide 都要看一遍**. 不看 = 交付前不知道自己做出什么, 用户拿到手一定挨骂.

---

## 交付流程 · 缺一步就是没做完

### 第一步: `deck_export` — 生成物存在 + 自检过关

`deck_export` 返回里的 `selfCheck`:

```json
{
  "passed": true,        /* 必须 true */
  "warnings": 2,
  "deckNotes": ["…"]     /* 整份的节奏提示 */
}
```

**规则**:
- `passed: false` → deck 还开着, `mustFix` 点名了大纲 index。**对这些页 `deck_add_slide` (同一个 index) 重做**, 再 `deck_export`。
- `passed: true` 但有 `deckNotes` → 逐条判断: 照着改, 或能说清为什么可以留。
- `available: false` (极少见) → 交付时如实说"排版没有经过自动校验", 不许声称已验证。

**mustFix 类型 (每个都必修)**:
- `out-of-bounds` / `edge-overflow` — 内容越出版面
- `zero-size` — 尺寸为 0
- `text-overlap` — 两个文本框重叠
- `text-overflow-estimated` — 文字撑爆容器
- `title-font-too-small` — 标题字号未达下限
- `body-font-too-small` — 正文字号未达下限
- `title-wraps-multi-line` — 标题会折行 (删字, 别缩字号)

修法查 `content-rules.md` §少而精 和 `visual-rules.md` §字号下限.

### 第二步: `open_surface` 打开 · 逐页扫

```
open_surface({kind: 'pptx', source: {type: 'file', path: <deck_export 返回的 path>}, title: <title>})
```

`open_surface` 会用同一把尺子再查一遍, 有必修问题直接拒绝上屏。打开后**你自己一页一页扫**:

- 标题是不是一行? (visual-rules §标题一行)
- 有没有"UI 面板墙"的感觉? (visual-rules §心智一句话)
- 一片一焦点还是抢戏? 视觉锚点清楚吗?
- 留白够不够? 太挤还是太空?
- 字号看着能读吗?
- 图配得上文字吗? 有没有牛头不对马嘴的图?
- 封面极简吗? 有没有多塞元素?
- 章节切换有节奏吗? 装饰是不是每页都有 (那等于没有)?

**有任何一片不满意就用 `deck_add_slide` 重做那一页**, 不要"用户会将就"心态.

### 第三步: deck-level 一致性 (整体过一遍)

- 全 deck 只用**一套风格** (deck_begin 定的那套, 本来也改不了)
- footer 内容一致或统一没有
- 章节 divider 用得均衡 (3-5 个), 不集中在头尾
- 总页数适中: **8-15 页最佳**, 5 页以下太单薄, 20+ 页太长

### 第四步: 内容一致性 · 主线自洽

- 封面许诺的东西**每页都在兑现**? (封面说"3 天怎么走", 中间就是 3 天, 不是 5 天)
- 数字前后一致? (第 3 页说 800, 第 12 页说 1200 → 修)
- 时间线上没矛盾?
- 结尾有回收吗? 有可执行的下一步吗?

---

## 常见 fail 模式

### Fail 1: 封面塞满
症状: cover-hero 塞了 tag + title + subtitle + footer + 大图
修: 删到只剩 title (必) + subtitle (强推) + footerText (可) 三样

### Fail 2: 中间页 UI 化
症状: 大量 kpi-cards / 标签 / dashboard 感
修: 换成 title-body / two-column / bullet-list

### Fail 3: 标题被字数逼两行
症状: 自检报 `title-wraps-multi-line`
修: **删字**, 不要缩字号

### Fail 4: 图挂了
症状: 报 `image URL prefetch failed` / `图片处理失败`, 附失败 URL 清单
修: **无兜底**. 换稳定源 (Wikimedia `generator=search` 拿真直链, 见 visual-rules §图片), 或删掉 image 字段走无图变体, 或加 `decor`.

### Fail 5: 图跟内容对不上 · 或猜 URL 全 404
修: 只用 Wikimedia `generator=search` 端点拿真直链. 别猜 hash · 别用随机端点

### Fail 6: 5 列信息硬塞
症状: 一堆并列小字挤成一页
修: 换 `data-table` (5 列 × 4 行) 或拆两页 `timeline`

### Fail 7: kpi-cards 用了 4+ 个
修: 拆两页, 或换 `data-table`

### Fail 8: 每页都 section-divider / 每页都加装饰
修: 章节页一份 deck 只用 3-5 次; 装饰只给封面、章节页和少数正文页

---

## 交付话术

交付 = `open_surface` 打开 + **一到两句话说明**.

**不要**: 倒自检报告 · 列模板/字段/内部实现 · "我用了 8 个模板..."之类的过程语言

**要**: 说 deck 是什么 + 页数 + 保存位置; 有主动决策就一句话解释.

例子:
> PPT 做好了 · 8 页 · 第三季度经营汇报 · 保存在 `~/Documents/Neox/工作/2026-09-10-第三季度经营汇报/第三季度经营汇报.pptx`

---

## 迭代循环

```
deck_begin (大纲 + 风格)
  → deck_add_slide × N (右侧实时看)
  → deck_export (自检)
      passed:false → deck_add_slide 重做点名的页 → 回 deck_export
  → open_surface (给用户看) → 自己逐页扫
      不满意 → deck_add_slide 重做 → deck_export → open_surface
  → 交付
```

**第一版就通过的 deck 很少** (通常有 3-5 处细节要调). 别第一次导出完就交.
