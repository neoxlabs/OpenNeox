import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const svc = readFileSync(resolve(HERE, '../actionLogService.ts'), 'utf8');
const runtime = readFileSync(resolve(HERE, '../../../runtime/agenticRuntime.ts'), 'utf8');

describe('ActionLog 不自动往长期记忆里塞流水', () => {
  it('没有从事件提取记忆的调用', () => {
    expect(svc).not.toMatch(/extractMemoryEntries/);
    expect(svc).not.toMatch(/Tool failed: \$\{/);
    expect(svc).not.toMatch(/category: 'progress',\s*\n\s*summary: truncateText\(event\.summary/);
  });

  it('没有每轮后台摘要器', () => {
    expect(svc).not.toMatch(/enqueueSummarizer|runSummarizer|resolveSummarizerProvider/);
    expect(svc).not.toMatch(/提取长期可复用的记忆/);
  });

  it('会话摘要去掉运行时挂的 <current-time> 和 <reply-language>', () => {
    expect(svc).toContain(String.raw`.replace(/<(current-time|reply-language)>[\s\S]*?<\/\1>/g, '')`);
  });
});

describe('runAutoMemory', () => {
  const body = runtime.slice(runtime.indexOf('private async runAutoMemory'), runtime.indexOf('const TOOL_TREE_INSTRUCTIONS'));

  it('读本会话的消息, 不读全局 memory', () => {
    expect(body).toMatch(/this\.sessionMemoryMap\.get\(sessionId\)/);
    expect(body).not.toMatch(/this\.config\.memory\.getAll\(\)/);
  });

  it('没开 Jev 就不跑; Jev 判不出来也不记', () => {
    expect(body).toMatch(/if \(!jev\) return;/);
    expect(body).toMatch(/if \(!verdict \|\| !worthRemembering\(verdict\)\) return;/);
  });

  it('用这一轮实际跑的模型', () => {
    expect(runtime).toMatch(/this\.runAutoMemory\(sessionId, runProviderId, runModelName\)/);
  });
});
