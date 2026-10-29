import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { hasPipedPrompt, parsePrintArgs, runPrintMode } from '../bootstrap/printMode.js';

class FakeStdin extends EventEmitter {
  constructor(public isTTY: boolean) {
    super();
  }
}

describe('print 模式 · 管道 stdin', () => {
  it('stdin 非 TTY 且已有内容 → 接管成一次性 prompt', async () => {
    const stdin = new FakeStdin(false);
    const ok = await hasPipedPrompt({ stdin: stdin as never, peek: () => Buffer.from('hello\n'), timeoutMs: 20 });
    expect(ok).toBe(true);
  });

  it('stdin 非 TTY 但一直没有内容 → 不接管, 不把启动拖住', async () => {
    const stdin = new FakeStdin(false);
    const started = Date.now();
    const ok = await hasPipedPrompt({ stdin: stdin as never, peek: () => null, timeoutMs: 30 });
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('内容晚到也能接住 (echo 的字节比模块加载慢)', async () => {
    const stdin = new FakeStdin(false);
    let captured: Buffer | null = null;
    setTimeout(() => {
      captured = Buffer.from('late prompt');
      stdin.emit('data', captured);
    }, 10);
    const ok = await hasPipedPrompt({ stdin: stdin as never, peek: () => captured, timeoutMs: 500 });
    expect(ok).toBe(true);
  });

  it('stdin 是 TTY → 一律不接管 (交互模式照旧)', async () => {
    const stdin = new FakeStdin(true);
    const ok = await hasPipedPrompt({ stdin: stdin as never, peek: () => Buffer.from('typed'), timeoutMs: 20 });
    expect(ok).toBe(false);
  });

  it('分几个 chunk 到的长提示不会被第一个 chunk 截断', async () => {
    const stdin = new FakeStdin(false);
    const chunks: string[] = [];
    let captured: Buffer | null = null;
    setTimeout(() => {
      chunks.push('part-one\n');
      captured = Buffer.from(chunks.join(''));
      stdin.emit('data', captured);
    }, 5);
    setTimeout(() => {
      chunks.push('part-two');
      captured = Buffer.from(chunks.join(''));
      stdin.emit('data', captured);
    }, 20);
    const ok = await hasPipedPrompt({ stdin: stdin as never, peek: () => captured, timeoutMs: 500 });
    expect(ok).toBe(true);
    expect(captured?.toString()).toBe('part-one\npart-two');
  });
});

describe('print 模式 · --resume', () => {
  it('长得像会话 id 的值才当 id 吃掉', () => {
    const opts = parsePrintArgs(['--resume', 'session_20261018_005100_ab12', 'hello']);
    expect(opts.resumeId).toBe('session_20261018_005100_ab12');
    expect(opts.prompt).toBe('hello');
  });

  it('不像会话 id 的值不当 id (提示不被吞)', () => {
    const opts = parsePrintArgs(['-p', '--resume', 'hello']);
    expect(opts.resumeId).toBeUndefined();
    expect(opts.prompt).toBe('hello');
  });

  it('报错说清楚正确写法', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
      chunks.push(String(chunk));
      return true;
    }) as never);
    try {
      const code = await runPrintMode(parsePrintArgs(['-p', '--resume', 'hello']));
      expect(code).toBe(2);
      expect(chunks.join('')).toContain('-p --resume <会话id> <提示>');
    } finally {
      spy.mockRestore();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
