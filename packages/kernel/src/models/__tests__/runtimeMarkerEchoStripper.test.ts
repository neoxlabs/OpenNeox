import { describe, expect, it } from 'vitest';
import {
  RuntimeMarkerEchoStripper,
  stripRuntimeMarkerEchoFromChunks,
  stripRuntimeMarkerEchoFromText,
} from '../runtimeMarkerEchoStripper';

const feed = (parts: string[]) => {
  const s = new RuntimeMarkerEchoStripper();
  return parts.map((p) => s.push(p)).join('') + s.flush();
};

describe('RuntimeMarkerEchoStripper', () => {
  it('剥掉回复末尾抄出的 current-time (2026-09-27 实录)', () => {
    const reply = '要具体用哪个直接说场景就行。\n\n<current-time>2026-09-27 周日 23:30</current-time>';
    expect(stripRuntimeMarkerEchoFromText(reply)).toBe('要具体用哪个直接说场景就行。');
  });

  it('标签被流式切碎也能剥', () => {
    const parts = ['就行。\n\n<cur', 'rent-ti', 'me>2026-09-27 周', '日 23:30</curr', 'ent-time>'];
    expect(feed(parts).trimEnd()).toBe('就行。');
  });

  it('reply-language 块同样剥掉', () => {
    const reply = 'ok\n<reply-language>本轮所有给用户看的话都用中文。</reply-language>';
    expect(stripRuntimeMarkerEchoFromText(reply)).toBe('ok');
  });

  it('正文里讨论这个标签 (内容对不上格式) 原样放行', () => {
    const code = '运行时会挂 `<current-time>` 标记, 见 `a.ts`; 例: <current-time>${nowStamp}</current-time>';
    expect(stripRuntimeMarkerEchoFromText(code)).toBe(code);
  });

  it('普通的 < 和 HTML 不受影响', () => {
    const t = 'a < b, <div>x</div>, <cur 不是标签, 1<2';
    expect(feed([...t])).toBe(t);
  });

  it('没闭合的开标签在流结束时原样吐出', () => {
    expect(feed(['看 <current-time>2026-09-27'])).toBe('看 <current-time>2026-09-27');
  });
});

describe('stripRuntimeMarkerEchoFromChunks', () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    object: 'chat.completion.chunk',
    id: 'x',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  it('只动 content; tool_calls / reasoning / finish_reason 原样透传, 尾部在 finish 前吐出', async () => {
    async function* src() {
      yield chunk({ reasoning_content: '想一下' });
      yield chunk({ content: '好的 <curr' });
      yield chunk({ content: 'ent-time>2026-09-27 周日 23:30</current-time>' });
      yield chunk({ content: ' 尾巴 <b' });
      yield chunk({}, 'stop');
    }
    const out: any[] = [];
    for await (const c of stripRuntimeMarkerEchoFromChunks(src())) out.push(c);
    const text = out.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('好的  尾巴 <b');
    expect(out[0].choices[0].delta.reasoning_content).toBe('想一下');
    expect(out.at(-1).choices[0].finish_reason).toBe('stop');
  });
});
