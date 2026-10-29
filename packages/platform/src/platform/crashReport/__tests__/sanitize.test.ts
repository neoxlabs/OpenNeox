
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import {
  maskSecrets,
  scrubPaths,
  sanitizeText,
  truncateMessage,
  normalizeStack,
  firstMeaningfulFrame,
  computeDedupeKey,
} from '../sanitize.js';

describe('maskSecrets', () => {
  it('抹掉 OpenAI 风格的 key', () => {
    const out = maskSecrets('boom sk-abcdefghijklmnopqrstuvwxyz123456 boom');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(out).toContain('[REDACTED]');
  });

  it('抹掉 Bearer token', () => {
    const out = maskSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toMatch(/REDACTED/i);
  });

  it('抹掉 key=value 形态, 保留键名', () => {
    const out = maskSecrets('api_key=supersecretvalue123 token: anothersecret456');
    expect(out).not.toContain('supersecretvalue123');
    expect(out).not.toContain('anothersecret456');
    expect(out).toContain('api_key=');
  });

  it('普通文本不动', () => {
    expect(maskSecrets('Cannot read property x of undefined')).toBe('Cannot read property x of undefined');
  });
});

describe('scrubPaths', () => {
  it('本机 home → ~', () => {
    const home = os.homedir();
    const out = scrubPaths(`${home}/projects/app/index.ts:10:5`);
    expect(out).toContain('~/projects/app/index.ts');
    expect(out).not.toContain(home);
  });

  it('其它用户名下的绝对路径 → ~', () => {
    expect(scrubPaths('/Users/alice/code/x.ts')).toBe('~/code/x.ts');
    expect(scrubPaths('/home/bob/code/x.ts')).toBe('~/code/x.ts');
  });

  it('工作区路径只留最后一段', () => {
    const out = scrubPaths('/tmp/some/workdir/src/a.ts:1:1', { workspaceDir: '/tmp/some/workdir' });
    expect(out).toBe('workdir/src/a.ts:1:1');
  });
});

describe('sanitizeText', () => {
  it('路径与凭证一起抹', () => {
    const out = sanitizeText('/Users/alice/app crashed with sk-abcdefghijklmnopqrstuvwx');
    expect(out).not.toContain('alice');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });
});

describe('truncateMessage', () => {
  it('压成一行并截断到 500 字', () => {
    const long = 'x'.repeat(2000) + '\n\n   more';
    const out = truncateMessage(long);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).not.toContain('\n');
  });
});

describe('normalizeStack', () => {
  it('只取 at 帧并脱敏, 最多 40 帧', () => {
    const lines = ['Error: boom', '    at fnA (/Users/alice/a.ts:1:1)'];
    for (let i = 0; i < 100; i++) lines.push(`    at fn${i} (/Users/alice/f${i}.ts:${i}:1)`);
    const frames = normalizeStack(lines.join('\n'));
    expect(frames.length).toBe(40);
    expect(frames[0]).not.toContain('alice');
    expect(frames[0].startsWith('at ')).toBe(true);
  });

  it('没有栈返回空数组', () => {
    expect(normalizeStack(undefined)).toEqual([]);
  });
});

describe('dedupeKey', () => {
  it('跳过 node 内部帧, 取第一个有意义帧', () => {
    const frames = [
      'at node:internal/process/task_queues:95:5',
      'at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      'at ourCode (src/app.ts:10:3)',
    ];
    expect(firstMeaningfulFrame(frames)).toContain('ourCode');
  });

  it('同一处崩溃 → 同一个 key; 不同处 → 不同 key', () => {
    const a = computeDedupeKey('js', ['at ourCode (src/app.ts:10:3)']);
    const b = computeDedupeKey('js', ['at ourCode (src/app.ts:10:3)', 'at other (x.ts:1:1)']);
    const c = computeDedupeKey('js', ['at different (src/other.ts:1:1)']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });
});
