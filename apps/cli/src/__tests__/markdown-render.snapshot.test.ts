/**
 * Markdown 渲染 — golden-file 快照回归集 (让终端 markdown 渲染"成熟"的地基)。
 *
 * 每条用例是一段**真实模型乱输出 / 边界情况** (多来自实际截图反馈), 快照其渲染后的可视布局
 * (stripAnsi —— 关注对齐/降级/换行/间距这些不稳定点, 颜色另说)。
 * 改动渲染器后任何一条变样 → 测试立刻红, 必须有意识地 `-u` 更新并复核。
 *
 * 新 bug 的流程: 把触发它的原始 md 加成一条用例 → 它就成了永久回归护栏。
 *
 * 跑: npx vitest run apps/cli/src/__tests__/markdown-render.snapshot.test.ts
 * 更新快照: npx vitest run ... -u   (改完务必肉眼核对 diff!)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { renderMarkdown } from '../ink/components/markdownRenderer.js';

// 固定终端宽度 → 快照确定性 (renderMarkdown 读 process.stdout.columns 算表格降级阈值)
let savedCols: number | undefined;
function setWidth(cols: number) { (process.stdout as { columns?: number }).columns = cols; }
beforeEach(() => { savedCols = process.stdout.columns; });
afterEach(() => { (process.stdout as { columns?: number }).columns = savedCols; });

/** 渲染并取可视布局 (去色), 便于 review 对齐/间距 */
function render(md: string, opts: { streaming?: boolean; cols?: number } = {}): string {
  setWidth(opts.cols ?? 156);
  return stripAnsi(renderMarkdown(md, opts.streaming ?? false));
}

describe('markdown render · 表格', () => {
  it('干净员工表 → 画方框对齐', () => {
    const md = `| ID | 姓名 | 部门 | 状态 |
|----|------|------|------|
| 1001 | 张三 | 技术部 | 在职 |
| 1002 | 李四 | 产品部 | 在职 |
| 1003 | 王五 | 技术部 | 离职 |`;
    expect(render(md)).toMatchSnapshot();
  });

  it('emoji 状态列 (✅🚧⌛) → 边框仍对齐 (string-width)', () => {
    const md = `| 序号 | 名称 | 状态 | 优先级 |
|------|------|------|--------|
| 1 | 用户登录 | ✅已完成 | P0 |
| 2 | 消息推送 | 🚧进行中 | P0 |
| 3 | 数据看板 | ⌛待开始 | P1 |`;
    expect(render(md)).toMatchSnapshot();
  });

  it('宽表含长 URL 单值 + 够宽终端 → 画方框 (不误降级)', () => {
    const md = `|配置项 |值 |
|--------|-----|
| \`DATABASE_URL\` | \`postgresql://user:password@db.internal.example.com:5432/myapp_production?sslmode=require\` |
| \`KAFKA_BROKERS\` | \`broker1.example.com:9092,broker2.example.com:9092,broker3.example.com:9092\` |`;
    expect(render(md, { cols: 156 })).toMatchSnapshot();
  });

  it('同上宽表 + 窄终端 (80) → 收窄宽列, 格内折行', () => {
    const md = `|配置项 |值 |
|--------|-----|
| \`DATABASE_URL\` | \`postgresql://user:password@db.internal.example.com:5432/myapp_production?sslmode=require\` |`;
    expect(render(md, { cols: 80 })).toMatchSnapshot();
  });

  it('多维对比表 (模型爱塞多值) → 够宽就画框, 内容照实', () => {
    const md = `| 维度 | React | Vue | Svelte |
|------|-------|-----|--------|
| 渲染机制 | 虚拟 DOM + Diff | 虚拟 DOM + 响应式 | 编译时无虚拟 DOM |
| 状态管理 | Redux/Zustand | Pinia | 内置 store |`;
    expect(render(md)).toMatchSnapshot();
  });

  it('列数不齐的畸形表 (marked 会补空格)', () => {
    const md = `| A | B | C |
|---|---|---|
| 只有两列 | 缺一列 |
| 1 | 2 | 3 |`;
    expect(render(md)).toMatchSnapshot();
  });
});

// ── 机器自检: 不变量断言 (不靠人眼, 对就是对) ──────────────────────
// 凡是画了方框的表, 所有框线/数据行的可视宽度必须完全相等 → 否则边框对不齐。
describe('markdown render · 对齐不变量 (机器可判)', () => {
  function assertBoxAligned(md: string, cols = 156) {
    setWidth(cols);
    const out = stripAnsi(renderMarkdown(md, false));
    const boxLines = out.split('\n').filter(l => /[┌├└│]/.test(l));
    if (boxLines.length === 0) return; // 降级成原文了, 不适用
    const widths = boxLines.map(l => stringWidth(l));
    // 全部等宽才算对齐
    expect(new Set(widths).size, `框线行宽度不一致: ${widths.join(',')}\n${out}`).toBe(1);
  }

  it('纯 CJK 表对齐', () => {
    assertBoxAligned(`| 名称 | 部门 | 状态 |
|------|------|------|
| 张三 | 技术部 | 在职 |
| 李四 | 产品部门 | 离职 |`);
  });

  it('emoji 混排表对齐 (✅🚧⌛⭐❌)', () => {
    assertBoxAligned(`| 项 | 状态 |
|----|------|
| A | ✅完成 |
| B | 🚧进行 |
| C | ⌛等待 |
| D | ⭐重点 |
| E | ❌失败 |`);
  });

  it('中英数字混排表对齐', () => {
    assertBoxAligned(`| Key | 中文说明 | Value |
|-----|---------|-------|
| timeout | 超时毫秒 | 5000 |
| retry | 重试次数 number | 3 |`);
  });

  it('单列宽窄差异大也对齐', () => {
    assertBoxAligned(`| 短 | 比较长的一列标题文字 |
|----|---------------------|
| a | 内容内容内容内容内容 |
| bb | 短 |`);
  });
});

describe('markdown render · 流式半成品 (不能画破方框)', () => {
  it('表格写到一半 (无分隔行) → 按原文裸竖线, 不画框', () => {
    const md = `| 序号 | 名称 | 状态
| 1 | 用户登录`;
    expect(render(md, { streaming: true })).toMatchSnapshot();
  });

  it('表格完整但仍在流式 → 也按原文 (等写完再画框)', () => {
    const md = `| A | B |
|---|---|
| 1 | 2 |`;
    expect(render(md, { streaming: true })).toMatchSnapshot();
  });

  it('未闭合代码块 (流式) → 不崩, 原样渲染', () => {
    const md = '```ts\nconst x = 1;\nfunction foo() {';
    expect(render(md, { streaming: true })).toMatchSnapshot();
  });
});

describe('markdown render · 列表 & emoji 间距', () => {
  it('行首 emoji 后补空格 (✅长 → ✅ 长)', () => {
    const md = `- ✅长表格渲染正常
- ✅代码高亮正常
- 引用块缩进正常
- 普通项无emoji不动`;
    expect(render(md)).toMatchSnapshot();
  });

  it('嵌套无序列表 (•/◦/▪ 按深度)', () => {
    const md = `- 顶层项
  - 二层项
    - 三层项
- 顶层项二`;
    expect(render(md)).toMatchSnapshot();
  });

  it('有序列表 + 长内容换行对齐', () => {
    const md = `1. 有序长内容第一项, 主要用于检查在序号后面的缩进对齐是否正常, 当内容跨行时第二行的起始位置。
2. 有序长内容第二项, 再塞一点内容让它在终端里自然换行。`;
    expect(render(md)).toMatchSnapshot();
  });
});

describe('markdown render · 代码/引用/标题/内联', () => {
  it('typescript 代码块 (左竖条)', () => {
    const md = '```typescript\n// WebSocket 连接管理\nclass ConnectionManager {\n  private connections = new Map();\n}\n```';
    expect(render(md)).toMatchSnapshot();
  });

  it('引用块', () => {
    const md = '> 核心原则: 先行动, 后解释。代码胜千言。';
    expect(render(md)).toMatchSnapshot();
  });

  it('标题 h1-h3', () => {
    const md = `# 一级标题\n## 二级标题\n### 三级标题`;
    expect(render(md)).toMatchSnapshot();
  });

  it('内联: 粗体/斜体/行内码/链接', () => {
    const md = '这是 **粗体** 和 *斜体* 和 `行内码`, 还有 [链接](https://example.com)。';
    expect(render(md)).toMatchSnapshot();
  });

  it('中英文混排对齐', () => {
    const md = '实现 OAuth2.0 第三方登录, 支持 Google / GitHub / 微信扫码 WebSocket 长连接。';
    expect(render(md)).toMatchSnapshot();
  });
});
