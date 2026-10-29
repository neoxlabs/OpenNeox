
const MARKERS: Array<{ open: string; close: string; body: RegExp; max: number }> = [
  { open: '<current-time>', close: '</current-time>', body: /^\d{4}-\d{2}-\d{2}[^<>\n]{0,24}$/, max: 80 },
  { open: '<reply-language>', close: '</reply-language>', body: /^[^<>]{1,400}$/, max: 460 },
];

export class RuntimeMarkerEchoStripper {
  private buf = '';

  push(delta: string): string {
    if (!delta) return '';
    this.buf += delta;
    let out = '';
    for (;;) {
      const lt = this.buf.indexOf('<');
      if (lt < 0) { out += this.buf; this.buf = ''; return out; }
      out += this.buf.slice(0, lt);
      this.buf = this.buf.slice(lt);
      const verdict = this.judge();
      if (verdict === 'wait') return out;
      if (verdict === 'strip') continue;
      /* 不是标记: 放行这个 `<`, 从下一个字符接着找 */
      out += '<';
      this.buf = this.buf.slice(1);
    }
  }

  /** 流结束: 缓冲里剩的全部原样放行 (没闭合的不算标记) */
  flush(): string {
    const rest = this.buf;
    this.buf = '';
    return rest;
  }

  /** buf 以 `<` 开头。'strip' 时已把整块从 buf 里切掉。 */
  private judge(): 'wait' | 'strip' | 'text' {
    const b = this.buf;
    for (const m of MARKERS) {
      if (b.length < m.open.length) {
        if (m.open.startsWith(b)) return 'wait';
        continue;
      }
      if (!b.startsWith(m.open)) continue;
      const end = b.indexOf(m.close, m.open.length);
      if (end < 0) return b.length - m.open.length > m.max ? 'text' : 'wait';
      const body = b.slice(m.open.length, end);
      if (!m.body.test(body.trim())) return 'text';
      this.buf = b.slice(end + m.close.length);
      return 'strip';
    }
    return 'text';
  }
}

/** 整段文本版 (非流式 / 测试) —— 剥完收掉因此留下的尾部空白 */
export function stripRuntimeMarkerEchoFromText(text: string): string {
  const s = new RuntimeMarkerEchoStripper();
  const out = s.push(text) + s.flush();
  return out === text ? text : out.trimEnd();
}

/**
 * chat-completions 流式 chunk 变换器: 只动 delta.content, 其余字段原样透传;
 * finish_reason 帧之前先 flush, 尾巴不会落在完成信号之后。
 */
export async function* stripRuntimeMarkerEchoFromChunks(source: AsyncIterable<any>): AsyncGenerator<any> {
  const stripper = new RuntimeMarkerEchoStripper();
  let template: any = null;
  const contentChunk = (content: string) => ({
    ...(template ?? { object: 'chat.completion.chunk' }),
    choices: [{ index: 0, delta: { content } }],
  });

  for await (const chunk of source) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;
    if (!template && chunk?.object === 'chat.completion.chunk') {
      const { choices: _omit, ...rest } = chunk;
      template = rest;
    }

    if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
      const passed = stripper.push(delta.content);
      const { content: _drop, ...deltaRest } = delta;
      const restKeys = Object.keys(deltaRest).filter((k) => deltaRest[k] !== undefined && deltaRest[k] !== null);
      if (passed || restKeys.length > 0 || choice.finish_reason) {
        const tail = choice.finish_reason ? stripper.flush() : '';
        const content = passed + tail;
        yield { ...chunk, choices: [{ ...choice, delta: { ...deltaRest, ...(content ? { content } : {}) } }] };
      }
      continue;
    }

    if (choice?.finish_reason) {
      const rest = stripper.flush();
      if (rest) yield contentChunk(rest);
    }
    yield chunk;
  }

  const rest = stripper.flush();
  if (rest) yield contentChunk(rest);
}
