# @openneox/pptx-renderer

Neox 自研 pptx 客户端渲染器 · 零后端进程 · 零下载 · 跨平台一致.

## 定位

对标 OpenAI 内部 `@oai/artifact-tool` 的 pptx 渲染路径, 开源社区目前只有 PPTXjs 一款可用方案 (jQuery 老货). 本包提供:

- **parser**: JSZip 解 pptx zip + 浏览器原生 DOMParser 拆 OOXML → 结构化 `Presentation` 数据树
- **render**: React 组件按 EMU→px 换算, 单张 `SlideView` 完全绝对定位, 缩略图 / 大图共用同组件

## 覆盖度

- **~90%**: AI 用 python-pptx / pptxgenjs 生成的规整模板 (标题 + 正文 + 图片 + 简单装饰形状)
- **~60%**: 手工排版复杂 pptx (SmartArt / 表格 / 图表暂不覆盖, 但不会崩)

## 用法

```ts
import { parsePptx, SlideView, type Presentation } from '@openneox/pptx-renderer';

const pres = await parsePptx(arrayBuffer);
<SlideView slide={pres.slides[0]} presentation={pres} containerWidth={800} />
```

## 关键实现

- **占位符继承**: python-pptx 生成的 shape 大部分 `<p:spPr/>` 空空, 坐标从 slideLayout / slideMaster 继承. 本 parser 沿 slide→layout→master 链收占位符表, 按 (type, idx) 三级 fallback 补 xfrm/style
- **单位换算**: EMU / pt / px 全链路精确 (12700 EMU/pt, 914400 EMU/inch, 96 CSS px/inch). 缩放时字号跟着 slide 尺寸线性变
- **主题解析**: `<a:schemeClr val="accent1"/>` → 从 theme colorScheme 查出实色, `<a:lumMod>` / `<a:tint>` / `<a:shade>` 修饰应用. `+mj-lt` / `+mn-lt` 字体引用解析

## 未覆盖 (故意)

- 演讲者备注 / 切换动画 / 播放模式
- 表格 `<graphicFrame>` (SmartArt 同理)
- 视频 / 音频 / OLE 嵌入
- 复杂 master 深度继承 (只走 slide→layout→master 一层)
- 精确字体 fallback (依赖用户机装了对应字体)

## 依赖

- `jszip` (runtime): 解 pptx zip
- `react` (peer): 渲染组件
- 浏览器原生 `DOMParser`: 解 OOXML (renderer 环境自带, 不装 fast-xml-parser 之类)
