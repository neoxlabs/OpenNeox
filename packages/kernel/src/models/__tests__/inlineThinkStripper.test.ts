import { describe, expect, it } from 'vitest';
import {
  InlineThinkStripper,
  stripInlineThinkFromChunks,
  stripInlineThinkFromText,
} from '../inlineThinkStripper.js';

function drain(stripper: InlineThinkStripper, deltas: string[]) {
  let content = '';
  let reasoning = '';
  for (const d of deltas) {
    const r = stripper.push(d);
    content += r.content;
    reasoning += r.reasoning;
  }
  const tail = stripper.flush();
  return { content: content + tail.content, reasoning: reasoning + tail.reasoning };
}

describe('InlineThinkStripper', () => {
  it('splits a leading think block into reasoning', () => {
    const r = drain(new InlineThinkStripper(), ['<think>let me see</think>Hello world']);
    expect(r.reasoning).toBe('let me see');
    expect(r.content).toBe('Hello world');
  });

  it('handles tags split across chunks', () => {
    const r = drain(new InlineThinkStripper(), ['<thi', 'nk>a', 'b</th', 'ink>ok']);
    expect(r.reasoning).toBe('ab');
    expect(r.content).toBe('ok');
  });

  it('tolerates leading whitespace before the tag', () => {
    const r = drain(new InlineThinkStripper(), ['\n  <think>x</think>y']);
    expect(r.reasoning).toBe('x');
    expect(r.content).toBe('y');
  });

  it('supports <thinking> variant', () => {
    const r = drain(new InlineThinkStripper(), ['<thinking>deep</thinking>out']);
    expect(r.reasoning).toBe('deep');
    expect(r.content).toBe('out');
  });

  it('leaves mid-text think tags untouched', () => {
    const text = 'The <think> tag is used by R1.';
    const r = drain(new InlineThinkStripper(), [text]);
    expect(r.content).toBe(text);
    expect(r.reasoning).toBe('');
  });

  it('treats unclosed think as pure reasoning', () => {
    const r = drain(new InlineThinkStripper(), ['<think>never closed...']);
    expect(r.reasoning).toBe('never closed...');
    expect(r.content).toBe('');
  });

  it('passes through normal content without buffering delays after probe resolves', () => {
    const s = new InlineThinkStripper();
    expect(s.push('Hello ').content).toBe('Hello ');
    expect(s.push('world').content).toBe('world');
  });

  it('eats a single newline right after the close tag', () => {
    const r = drain(new InlineThinkStripper(), ['<think>a</think>\nText']);
    expect(r.content).toBe('Text');
  });

  it('handles a partial close-tag lookalike inside reasoning', () => {
    const r = drain(new InlineThinkStripper(), ['<think>a </thin b</think>c']);
    expect(r.reasoning).toBe('a </thin b');
    expect(r.content).toBe('c');
  });
});

describe('stripInlineThinkFromText', () => {
  it('strips whole-string responses', () => {
    const r = stripInlineThinkFromText('<think>plan</think>answer');
    expect(r).toEqual({ content: 'answer', reasoning: 'plan' });
  });

  it('returns original text when no think block present', () => {
    const r = stripInlineThinkFromText('plain answer');
    expect(r).toEqual({ content: 'plain answer', reasoning: '' });
  });
});

async function* chunksOf(deltas: Array<Record<string, unknown>>, finish = true) {
  for (const delta of deltas) {
    yield { object: 'chat.completion.chunk', id: 'c1', model: 'r1-proxy', choices: [{ index: 0, delta }] };
  }
  if (finish) {
    yield { object: 'chat.completion.chunk', id: 'c1', model: 'r1-proxy', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  }
}

async function collect(source: AsyncIterable<any>) {
  const out: any[] = [];
  for await (const c of source) out.push(c);
  return out;
}

describe('stripInlineThinkFromChunks', () => {
  it('rewrites inline think deltas into reasoning_content chunks', async () => {
    const out = await collect(stripInlineThinkFromChunks(chunksOf([
      { role: 'assistant', content: '<think>th' },
      { content: 'inking</think>Hi' },
      { content: ' there' },
    ])));
    const reasoning = out.map(c => c.choices[0].delta?.reasoning_content ?? '').join('');
    const content = out.map(c => c.choices[0].delta?.content ?? '').join('');
    expect(reasoning).toBe('thinking');
    expect(content).toBe('Hi there');
  });

  it('preserves tool_calls on frames whose content got buffered', async () => {
    const out = await collect(stripInlineThinkFromChunks(chunksOf([
      { content: '<thi', tool_calls: [{ index: 0, function: { name: 'readfile', arguments: '' } }] },
      { content: 'nk>x</think>done' },
    ])));
    const toolFrames = out.filter(c => c.choices[0].delta?.tool_calls);
    expect(toolFrames).toHaveLength(1);
    const content = out.map(c => c.choices[0].delta?.content ?? '').join('');
    expect(content).toBe('done');
  });

  it('flushes unclosed reasoning before the finish_reason frame', async () => {
    const out = await collect(stripInlineThinkFromChunks(chunksOf([
      { content: '<think>never closed' },
    ])));
    const finishIdx = out.findIndex(c => c.choices[0].finish_reason);
    const reasoningIdx = out.findIndex(c => c.choices[0].delta?.reasoning_content?.includes('never closed'));
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(finishIdx);
  });

  it('leaves native reasoning_content streams untouched', async () => {
    const out = await collect(stripInlineThinkFromChunks(chunksOf([
      { reasoning_content: 'native thoughts' },
      { content: 'answer' },
    ])));
    const reasoning = out.map(c => c.choices[0].delta?.reasoning_content ?? '').join('');
    const content = out.map(c => c.choices[0].delta?.content ?? '').join('');
    expect(reasoning).toBe('native thoughts');
    expect(content).toBe('answer');
  });

  it('passes through usage / non-delta frames verbatim', async () => {
    async function* src() {
      yield { object: 'chat.completion.chunk', choices: [], usage: { total_tokens: 42 } };
    }
    const out = await collect(stripInlineThinkFromChunks(src()));
    expect(out[0].usage.total_tokens).toBe(42);
  });
});
