import { describe, expect, test } from 'vitest';
import { buildTimelineRows, stabilizeTimelineRows, type Row } from '../timelineRows';
import type { TimelineMessage } from '../types';

const RUN = process.env.NEOX_BENCH === '1';

function makeRows(streamingText: string, streaming: boolean, historyCount: number): Row[] {
  const items: TimelineMessage[] = [];
  for (let i = 0; i < historyCount; i++) {
    items.push({
      kind: 'message', id: `h${i}`, role: i % 2 ? 'assistant' : 'user',
      text: `历史消息 ${i} `.repeat(20), timestamp: '10:00', streaming: false,
    } as TimelineMessage);
  }
  items.push({
    kind: 'message', id: 'live', role: 'assistant',
    text: streamingText, timestamp: '10:01', streaming,
  } as TimelineMessage);
  return buildTimelineRows(items as never, false, new Set(), true);
}

describe.skipIf(!RUN)('流式行 stabilize 成本', () => {
  test('逐 token 生长 400 次的累计耗时', () => {
    const CHUNK = '这是一段流式输出的文本片段。';
    for (const history of [50, 200]) {
      let text = '';
      let prev = makeRows(text, true, history);
      const t0 = performance.now();
      for (let i = 0; i < 400; i++) {
        text += CHUNK;
        const next = makeRows(text, true, history);
        prev = stabilizeTimelineRows(prev, next) as Row[];
      }
      const dt = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`  历史 ${history} 条 · 流式 400 帧 · 末尾文本 ${text.length} 字 → ${dt.toFixed(0)}ms (${(dt / 400).toFixed(2)}ms/帧)`);
    }
  }, 600_000);
});

describe('流式行 stabilize 正确性', () => {
  test('流式行每帧返回新对象 (内容变了 UI 必须更新)', () => {
    const a = makeRows('abc', true, 3);
    const b = makeRows('abcdef', true, 3);
    const out = stabilizeTimelineRows(a, b) as Row[];
    const liveA = a[a.length - 1];
    const liveB = b[b.length - 1];
    const liveOut = out[out.length - 1];
    expect(liveOut).toBe(liveB);      // 用新的
    expect(liveOut).not.toBe(liveA);  // 不复用旧的
  });

  test('等长但内容不同的流式行也必须更新 (不能拿长度当签名)', () => {
    const a = makeRows('AAAA', true, 3);
    const b = makeRows('BBBB', true, 3);
    const out = stabilizeTimelineRows(a, b) as Row[];
    const liveOut = out[out.length - 1];
    expect(liveOut).toBe(b[b.length - 1]);
    expect((liveOut as { message: { text: string } }).message.text).toBe('BBBB');
  });

  test('非流式的历史行仍然被稳定复用 (引用不该无谓变化)', () => {
    const a = makeRows('done', false, 8);
    const b = makeRows('done', false, 8);
    const out = stabilizeTimelineRows(a, b) as Row[];
    let reused = 0;
    for (let i = 0; i < out.length; i++) if (out[i] === a[i]) reused++;
    expect(reused).toBeGreaterThan(out.length * 0.8);
  });
});
