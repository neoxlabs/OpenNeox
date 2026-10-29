/* code:TIMELINE-08 —— Markdown 头部块增量指纹。
 *
 * 守三件事:
 *   1. 语义等价: 任何一块内容变了 / 切分变了 / 块数变了, 指纹必须变, 否则 memo 会用旧元素
 *      渲染新正文 (静默错字)。反过来, 流式追加只动最后一块时, 前缀指纹必须不变, 否则
 *      就退回到"每帧全量重建元素"。
 *   2. 不再拼接: update() 里不许出现 join / 整段字符串拼接 —— 这正是本条要解决的问题。
 *   3. 成本: 20K 字正文流式追加时, 每帧指纹 ≤1ms (验收标准)。
 */
import { describe, it, expect } from 'vitest';
import { createHeadKeyTracker } from '../markdownHeadKey';
import { splitMarkdownBlocks } from '../markdownBlocks';

describe('code:TIMELINE-08 · markdownHeadKey', () => {
  it('同样的块 → 同样的指纹 (流式没新块时 memo 命中)', () => {
    const t = createHeadKeyTracker();
    const blocks = ['第一段\n\n', '第二段\n\n'];
    const first = t.update(blocks);
    expect(t.update(['第一段\n\n', '第二段\n\n'])).toBe(first);
  });

  it('追加一块 → 指纹变化', () => {
    const t = createHeadKeyTracker();
    const a = t.update(['一\n\n']);
    const b = t.update(['一\n\n', '二\n\n']);
    expect(b).not.toBe(a);
  });

  it('内容改写但长度、块数都不变 → 指纹仍要变', () => {
    const a = createHeadKeyTracker().update(['abc\n\n']);
    const b = createHeadKeyTracker().update(['abd\n\n']);
    expect(b).not.toBe(a);
  });

  it('块边界不同 (拼起来一样) → 指纹不同', () => {
    const a = createHeadKeyTracker().update(['ab', 'c']);
    const b = createHeadKeyTracker().update(['a', 'bc']);
    expect(b).not.toBe(a);
  });

  it('块数变少 (截断) → 指纹变化', () => {
    const t = createHeadKeyTracker();
    const longer = t.update(['一\n\n', '二\n\n', '三\n\n']);
    const shorter = t.update(['一\n\n', '二\n\n']);
    expect(shorter).not.toBe(longer);
  });

  it('中途某块被改写 (共享前缀之后) → 指纹变化, 且与全新实例算出的结果一致', () => {
    const t = createHeadKeyTracker();
    const before = t.update(['一\n\n', '二\n\n', '三\n\n']);
    const changed = t.update(['一\n\n', '二改\n\n', '三\n\n']);
    expect(changed).not.toBe(before);
    expect(changed).toBe(createHeadKeyTracker().update(['一\n\n', '二改\n\n', '三\n\n']));
  });

  it('不拼接整段正文 (update 期间调用 join 即失败)', () => {
    const t = createHeadKeyTracker();
    const blocks = ['一\n\n', '二\n\n', '三\n\n'];
    t.update(blocks);
    const original = Array.prototype.join;
    /* eslint-disable no-extend-native */
    Array.prototype.join = function banned() {
      throw new Error('headKey 不许 join 全文 (code:TIMELINE-08)');
    } as typeof Array.prototype.join;
    try {
      expect(t.update(['一\n\n', '二\n\n', '三\n\n', '四\n\n'])).toBeTruthy();
    } finally {
      Array.prototype.join = original;
    }
  });

  it('20K 字流式追加: 每帧指纹 ≤1ms', () => {
    const t = createHeadKeyTracker();
    const target = 20_000;
    const chunks: string[] = [];
    let size = 0;
    let i = 0;
    while (size < target) {
      const para = `第 ${i} 段: 这是一段用于测量指纹成本的正文, 每段约一百字左右, 保持块边界清晰。\n\n`;
      chunks.push(para);
      size += para.length;
      i++;
    }

    let content = '';
    let frames = 0;
    let total = 0;
    for (const chunk of chunks) {
      content += chunk;
      const blocks = splitMarkdownBlocks(content);
      const head = blocks.length > 1 ? blocks.slice(0, -1) : [];
      const t0 = performance.now();
      t.update(head);
      total += performance.now() - t0;
      frames++;
    }

    const avg = total / frames;
    expect(content.length).toBeGreaterThanOrEqual(20_000);
    expect(avg, `20K 字每帧指纹平均 ${avg.toFixed(3)}ms`).toBeLessThan(1);
  });
});
