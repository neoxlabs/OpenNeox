import { describe, it, expect } from 'vitest';
import { stabilizeTimelineRows, stringSignature, type Row } from '../timelineRows';

/** 造一个"正在写大文件"的流式行 —— 照着真实 file_stream 条目的形状, 不是简化版:
 *  正文 + 原始内容 + diff 统计 + presentation + meta, 每一样都会进签名。 */
function streamingWriteRow(id: string, content: string): Row {
  const lines = content.split('\n');
  return {
    kind: 'single',
    step: {
      id,
      status: 'running',
      title: `写入文件 ${id}.ts`,
      startedAtMs: 1_700_000_000_000,
      content,
      rawContent: content,
      codeLines: lines,
      codeContent: content,
      preview: lines.slice(0, 40).join('\n'),
      diffStat: { added: lines.length, removed: 0, files: 1 },
      presentation: {
        kind: 'patch',
        path: `/tmp/${id}.ts`,
        body: content,
        hunks: lines.slice(0, 80).map((l, i) => ({ line: i, text: l })),
      },
      meta: { tool: 'write_file', path: `/tmp/${id}.ts`, bytes: content.length },
    } as any,
  };
}

/** 已封口的历史行 —— 每帧引用不变, 应该走公共前缀短路 */
function settledRow(id: string): Row {
  return {
    kind: 'single',
    step: { id, status: 'done', title: `读取 ${id}`, content: 'ok' } as any,
  };
}

const measure = (fn: () => void, runs: number) => {
  fn(); /* 预热, 别把首次 JIT 算进去 */
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  return (performance.now() - t0) / runs;
};

const measureNet = (build: () => Row[], stabilize: (rows: Row[]) => void, rounds = 3, runs = 20): number => {
  let minBuild = Infinity;
  let minTotal = Infinity;
  for (let i = 0; i < rounds; i++) {
    const mb = () => { minBuild = Math.min(minBuild, measure(() => { build(); }, runs)); };
    const mt = () => { minTotal = Math.min(minTotal, measure(() => { stabilize(build()); }, runs)); };
    if (i % 2 === 0) { mb(); mt(); } else { mt(); mb(); }
  }
  /* 下限保护: 净耗时理论上 >0, 但两次测量各带噪声时差值可能落到 0 附近甚至为负 */
  return Math.max(minTotal - minBuild, 0.0001);
};

describe('流式期 stabilize 的成本', () => {
  /* 已封口的历史部分每帧引用不变 —— 真实情况就是这样 (segmentCache 整段复用) */
  const history = Array.from({ length: 120 }, (_, i) => settledRow(`h${i}`));

  const build = (chunkSize: number, streamingCount: number): Row[] => {
    const body = 'export const x = 1;\n'.repeat(chunkSize);
    return [
      ...history,
      ...Array.from({ length: streamingCount }, (_, i) => streamingWriteRow(`w${i}`, body + i)),
    ];
  };

  describe('签名必须是采样的, 不能回退成全文哈希', () => {
    const LONG = 200_000;   /* 远超 FULL_HASH_MAX_LEN(4096), 走采样分支 */
    const WINDOW = 1024;    /* SAMPLE_WINDOW */

    /** 造一个长串, 在指定位置埋一个标记字符 */
    const withMarkAt = (len: number, pos: number, mark = 'X') =>
      'a'.repeat(pos) + mark + 'a'.repeat(len - pos - 1);

    it('只在采样窗口之外不同的等长串 → 签名相同 (证明没读全文)', () => {
      /* 1/4 处: 既不在头窗口(0~1024), 不在中窗口(中点±512), 也不在尾窗口 */
      const posA = Math.floor(LONG * 0.25);
      const posB = Math.floor(LONG * 0.30);
      const a = withMarkAt(LONG, posA);
      const b = withMarkAt(LONG, posB);
      expect(a.length).toBe(b.length);
      expect(a).not.toBe(b);
      expect(stringSignature(a)).toBe(stringSignature(b));
    });

    it('长度不同 → 签名一定不同 (长度是签名的第一段)', () => {
      expect(stringSignature('a'.repeat(LONG)))
        .not.toBe(stringSignature('a'.repeat(LONG + 1)));
    });

    it('头 / 中 / 尾三个窗口内的改动都要被检测到', () => {
      const base = 'a'.repeat(LONG);
      const head = withMarkAt(LONG, 10);
      const mid = withMarkAt(LONG, LONG >> 1);
      const tail = withMarkAt(LONG, LONG - 10);
      for (const [name, v] of [['head', head], ['mid', mid], ['tail', tail]] as const) {
        expect(stringSignature(v), name).not.toBe(stringSignature(base));
      }
    });

    it('短串走全文哈希, 任意位置的改动都能检测', () => {
      const short = 'a'.repeat(2000);   /* < FULL_HASH_MAX_LEN */
      expect(stringSignature(withMarkAt(2000, 1000)))
        .not.toBe(stringSignature(short));
    });

    it('相同输入签名稳定 (纯函数, 不带状态)', () => {
      const v = withMarkAt(LONG, 777);
      expect(stringSignature(v)).toBe(stringSignature(v));
    });

    it('签名长度不随输入长度增长 —— 否则签名本身就成了新的内存/比较成本', () => {
      const s1 = stringSignature('a'.repeat(10_000));
      const s2 = stringSignature('a'.repeat(2_000_000));
      expect(Math.abs(s1.length - s2.length)).toBeLessThan(20);
    });
  });

  it('单帧 stabilize 在流式大文本下要留在 16ms 预算内', () => {
    const rows = build(3000, 13);
    const ms = measure(() => { stabilizeTimelineRows(build(3000, 13), rows); }, 20);
    /* 60fps 一帧 16.7ms, stabilize 只是其中一环, 给它 8ms 已经很宽松 */
    expect(ms).toBeLessThan(8);
  });
});
