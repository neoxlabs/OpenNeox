/**
 * Neox Wire Text 方案 + 截断 sink 回归.
 *
 * 方案三条 (见 wireText.ts):
 *   R1 截断只走 wireText / toolOutputTruncation
 *   R2 出口 prepareMessagesForWire
 *   R3 验收 assertStrictJsonSafe (≠ JS JSON.parse)
 */
import { describe, it, expect } from 'vitest';
import {
  assertStrictJsonSafe,
  hasLoneSurrogate,
  isStrictJsonSafe,
  prepareMessagesForWire,
  sanitizeUnicodeDeep,
  takeUtf16SafeTail,
  toWellFormedString,
  truncateMiddleUtf16Safe,
  truncateUtf16Safe,
  sliceUtf16Safe,
} from '../wireText.js';
import { truncateToolOutput } from '../toolOutputTruncation.js';
import { snipOversizedToolResults } from '../../core/runnerCompressionUtils.js';
import { truncateToolOutput as runnerTruncate } from '../../core/runnerUtils.js';

const EMOJI = '🔥';
const denseEmoji = (n: number) => EMOJI.repeat(n);

describe('wireText primitives', () => {
  it('toWellFormedString 替换孤立 surrogate', () => {
    expect(toWellFormedString('hello\uD83Dworld')).toBe('hello\uFFFDworld');
    expect(toWellFormedString('hello🔥world')).toBe('hello🔥world');
  });

  it('sliceUtf16Safe / truncate / tail 不切断代理对', () => {
    const s = 'ab🔥cd';
    expect(hasLoneSurrogate(s.slice(0, 3))).toBe(true);
    expect(hasLoneSurrogate(sliceUtf16Safe(s, 0, 3))).toBe(false);
    expect(truncateUtf16Safe(s, 3)).toBe('ab');
    expect(takeUtf16SafeTail(s, 3)).toBe('cd');
  });

  it('truncateMiddleUtf16Safe emoji odd budget', () => {
    const out = truncateMiddleUtf16Safe(denseEmoji(20_000), { maxUnits: 15_001 });
    expect(hasLoneSurrogate(out)).toBe(false);
    assertStrictJsonSafe({ content: out });
  });
});

describe('strict JSON ≠ JS JSON.parse', () => {
  it('poisoned body: JS 绿、严格红；prepareMessagesForWire 后绿', () => {
    const poisoned = { messages: [{ role: 'tool', content: 'x\uD83Dy' }] };
    expect(() => JSON.parse(JSON.stringify(poisoned))).not.toThrow();
    expect(isStrictJsonSafe(poisoned)).toBe(false);
    const cleaned = prepareMessagesForWire(poisoned);
    assertStrictJsonSafe(cleaned);
    expect(sanitizeUnicodeDeep(poisoned).messages[0]!.content).toBe('x\uFFFDy');
  });
});

describe('唯一 truncateToolOutput 实现 (providers + platform + runner)', () => {
  const impls: Array<{ name: string; fn: (s: string, n?: number) => string }> = [
    { name: 'canonical toolOutputTruncation', fn: truncateToolOutput },
    { name: 'runnerUtils wrapper', fn: runnerTruncate },
  ];

  for (const impl of impls) {
    it(`${impl.name}: emoji dense → strict-JSON safe`, () => {
      const out = impl.fn(denseEmoji(20_000), 15_000);
      expect(hasLoneSurrogate(out)).toBe(false);
      assertStrictJsonSafe({ messages: [{ role: 'tool', content: out }] }, impl.name);
    });
  }
});

describe('LLM-bound truncation sinks matrix', () => {
  const cases: Array<{ name: string; run: () => string }> = [
    { name: 'truncateUtf16Safe odd', run: () => truncateUtf16Safe(denseEmoji(5000), 8001) },
    { name: 'takeUtf16SafeTail odd', run: () => takeUtf16SafeTail(denseEmoji(5000), 8001) },
    {
      name: 'snipOversizedToolResults',
      run: () => {
        const r = snipOversizedToolResults([{ role: 'tool', content: denseEmoji(40_000) }], 50_000, () => {});
        return r.messages[0].content as string;
      },
    },
    { name: 'truncateToolOutput', run: () => truncateToolOutput(denseEmoji(20_000), 15_000) },
    {
      name: 'web_fetch-style',
      run: () => truncateUtf16Safe(denseEmoji(6000), 8001) + '\n\n... (内容已截断)',
    },
  ];

  for (const c of cases) {
    it(`${c.name}`, () => {
      const out = c.run();
      expect(hasLoneSurrogate(out)).toBe(false);
      assertStrictJsonSafe({
        messages: Array.from({ length: 69 }, (_, i) =>
          i === 68 ? { role: 'tool', content: out } : { role: 'user', content: 'ok' },
        ),
      }, c.name);
    });
  }
});
