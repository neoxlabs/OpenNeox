import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStreamParser } from '../externalAgent/streamParsers.js';

const dir = fileURLToPath(new URL('./fixtures/external-agents/', import.meta.url));

/** 跟 runner 同一套累积规则 */
function replay(format: string, file: string) {
  const parser = createStreamParser(format);
  let text = '';
  let done = false;
  let error: string | undefined;
  let fatal = false;
  const tools: Record<string, number> = {};
  const lines: string[] = [];
  for (const raw of readFileSync(dir + file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    for (const ev of parser.feed(raw)) {
      if (ev.toolName) tools[ev.toolName] = (tools[ev.toolName] ?? 0) + 1;
      if (ev.text) text = ev.replacesText ? ev.text : text + ev.text;
      if (ev.done) done = true;
      if (ev.error) error = ev.error;
      if (ev.fatal) fatal = true;
      if (ev.line) lines.push(ev.line);
    }
  }
  return { text, done, error, fatal, tools, lines };
}

describe('droid-stream-json (droid exec -o stream-json)', () => {
  it('read-only run: final text from completion, Read counted, done', () => {
    const r = replay('droid-stream-json', 'droid-read.ndjson');
    expect(r.text).toBe('`math.js` exports a single named function, `add(a, b)`, which returns the sum of its two arguments.');
    expect(r.tools).toEqual({ Read: 1 });
    expect(r.done).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('write run: sees the edit tool and finishes', () => {
    const r = replay('droid-stream-json', 'droid-write.ndjson');
    expect(Object.keys(r.tools).some((t) => /edit|create|patch/i.test(t))).toBe(true);
    expect(r.done).toBe(true);
    expect(r.text).toMatch(/sub/);
  });
});

describe('opencode-json (opencode run --format json)', () => {
  it('read-only run: text parts, bash + read tools, done only on reason=stop', () => {
    const r = replay('opencode-json', 'opencode-read.ndjson');
    expect(r.text.trim()).toBe('`math.js` exports a single named function `add(a, b)` that returns the sum of its two arguments.');
    expect(r.tools).toEqual({ bash: 1, read: 1 });
    expect(r.done).toBe(true);
    expect(r.lines.filter((l) => l === '✓ 完成')).toHaveLength(1);
  });

  it('write run finishes', () => {
    const r = replay('opencode-json', 'opencode-write.ndjson');
    expect(r.done).toBe(true);
    expect(Object.keys(r.tools).some((t) => /edit|write|patch/i.test(t))).toBe(true);
  });

  it('error event carries the server message', () => {
    const r = replay('opencode-json', 'opencode-error.ndjson');
    expect(r.error).toBe('Unexpected server error. Check server logs for details.');
    expect(r.done).toBe(true);
  });
});

describe('kimi-stream-json (kimi -p --output-format stream-json)', () => {
  it('read-only run: assistant content and tool_calls, meta lines dropped', () => {
    const r = replay('kimi-stream-json', 'kimi-read.ndjson');
    expect(r.text.trim()).toBe('`math.js` exports a single named function, `add(a, b)`, which returns the sum of its two arguments.');
    expect(r.tools).toEqual({ Read: 1 });
    expect(r.lines.some((l) => l.includes('resume'))).toBe(false);
  });

  it('write run: Read then Edit', () => {
    const r = replay('kimi-stream-json', 'kimi-write.ndjson');
    expect(r.tools).toEqual({ Read: 1, Edit: 1 });
    expect(r.text).toMatch(/sub/);
  });

  it('plain `error:` line becomes the failure reason', () => {
    const r = replay('kimi-stream-json', 'kimi-error.txt');
    expect(r.error).toBe('failed to run prompt: Model "no-such-model" is not configured in config.toml.');
  });
});

describe('cline-json (cline --json)', () => {
  it('read-only run: whole text from content_end (not every delta), final text from done', () => {
    const r = replay('cline-json', 'cline-read.ndjson');
    expect(r.text).toMatch(/^\*\*`math.js` exports a single named function `add\(a, b\)`/);
    expect(r.tools).toEqual({ run_commands: 1, read_files: 1 });
    expect(r.done).toBe(true);
    expect(r.error).toBeUndefined();
    /* 21 条逐字增量不能变成 21 行进度 */
    expect(r.lines.length).toBeLessThan(10);
  });

  it('write run finishes without error', () => {
    const r = replay('cline-json', 'cline-write.ndjson');
    expect(r.done).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('done(reason=error) is the failure; the unrelated top-level hook error is not', () => {
    const r = replay('cline-json', 'cline-error.ndjson');
    expect(r.error).toBe('Upstream request failed: Model is unavailable.');
    expect(r.lines.some((l) => l.includes('hook dispatch'))).toBe(false);
  });
});
