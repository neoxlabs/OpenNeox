import { describe, expect, it, vi, beforeEach } from 'vitest';

const NEOX_PROMPT = '你是 Neox，一个在用户本机工作的 senior engineering agent。';
const SUMMARY = '[Compressed Work Record] 用户让我重构了 timelineStore …';

/** 这一轮 SessionContext.get() 要返回的历史 */
let ctxItems: Array<{ role: string; content: string }> = [];

vi.mock('@neoxlabs/platform/platform/sessionContext.js', () => ({
  SessionContext: {
    get: () => ({
      getAll: () => ctxItems,
      appendMessage: () => {},
      get size() { return ctxItems.length; },
    }),
  },
}));

const { SessionSyncManager } = await import('../session-sync');
const { ShortTermMemory } = await import('@neoxlabs/kernel/memory/shortterm.js');

const fakeSession = () => ({ sessionId: 'sess-test' }) as never;

/** 复刻 runner.ts:996 —— 它决定要不要注入 instructions。 */
const runnerSeesPrompt = (mem: { getMessagesForLLM: () => Array<{ role: string }> }): boolean =>
  mem.getMessagesForLLM().some((m) => m.role === 'system');

/** 复刻 agentRuntimeHost.ts:1228 —— 同一件事, 但排除压缩摘要。 */
const hostSeesPrompt = (mem: { getMessagesForLLM: () => Array<{ role: string; content: unknown }> }): boolean =>
  mem.getMessagesForLLM().some(
    (m) => m.role === 'system' &&
      !(typeof m.content === 'string' && m.content.startsWith('[Compressed Work Record')),
  );

const hasNeox = (mem: { getMessagesForLLM: () => Array<{ role: string; content: unknown }> }): boolean =>
  mem.getMessagesForLLM()
    .filter((m) => m.role === 'system')
    .some((m) => String(m.content).includes('Neox'));

beforeEach(() => { ctxItems = []; });

describe('恢复一个压缩过的会话 (线上 false 的都是这种)', () => {
  const compactedHistory = [
    { role: 'system', content: SUMMARY },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '好的' },
  ];

  it('systemPrompt 有值 → 提示词回来了, has_neox 会是 true', async () => {
    ctxItems = compactedHistory;
    const mem = new ShortTermMemory();
    await new SessionSyncManager({ session: fakeSession(), memory: mem, systemPrompt: NEOX_PROMPT })
      .loadHistory();
    expect(hasNeox(mem)).toBe(true);
  });

  it('⚠️ systemPrompt 是空串 → 提示词没了, 而压缩摘要顶替了它的位置', async () => {
    /* '' 正是 hostFactory.ts:186 的兜底:
     *     systemPrompt ?? (typeof instructions === 'string' ? instructions : '')
     * layered 模式下 instructions 不是字符串 → 落到 ''。
     * 而 loadHistory 是 `if (this.systemPrompt)` —— '' 是 falsy, 整步跳过。 */
    ctxItems = compactedHistory;
    const mem = new ShortTermMemory();
    await new SessionSyncManager({ session: fakeSession(), memory: mem, systemPrompt: '' })
      .loadHistory();

    expect(hasNeox(mem), '这就是线上的 has_neox=false').toBe(false);

    /* 摘要**也是 role=system** —— 朴素判断会被它骗过去 (这是修之前 runner 的行为) */
    expect(runnerSeesPrompt(mem), '朴素判断被摘要骗了').toBe(true);
    expect(hostSeesPrompt(mem), '排除摘要后能正确看出"没有身份提示词"').toBe(false);
  });

  it('没压缩过的短会话不中招 —— 解释了为什么线上只有 12.8%', async () => {
    ctxItems = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好' },
    ];
    const mem = new ShortTermMemory();
    await new SessionSyncManager({ session: fakeSession(), memory: mem, systemPrompt: '' })
      .loadHistory();
    /* 一条 system 都没有 → runner 的判断也是 false → 它会正常注入, 自愈 */
    expect(runnerSeesPrompt(mem)).toBe(false);
  });
});

describe('runner 和 host 的判断必须同口径', () => {
  it('两处都排除压缩摘要', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const here = dirname(fileURLToPath(import.meta.url));

    const runnerSrc = readFileSync(
      resolve(here, '../../../../../packages/kernel/src/core/runner.ts'), 'utf8');
    const hostSrc = readFileSync(
      resolve(here, '../../runtime/agentRuntimeHost.ts'), 'utf8');

    /* runner: hasSystemPrompt 必须带摘要排除 */
    const i = runnerSrc.indexOf('const hasSystemPrompt =');
    expect(i, '找不到 hasSystemPrompt').toBeGreaterThan(0);
    const block = runnerSrc.slice(i, i + 200);
    expect(block, 'runner 退回了朴素判断 —— 压缩摘要会被当成身份提示词')
      .toContain('!isCompactionSummaryMessage(m)');

    /* host: 一直是对的, 一并钉住 */
    expect(hostSrc).toMatch(/role === 'system' && !isCompactionSummaryMessage\(m\)/);
  });

  it('hostFactory 不许再用空串兜底 —— 空串会让"补回提示词"这步静默跳过', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../runtime/hostFactory.ts'), 'utf8');
    expect(src).not.toMatch(/typeof instructions === 'string' \? instructions : ''/);
    expect(src, '拿不到 systemPrompt 是异常, 要看得见').toMatch(/cliLogger\.warn\('HOST_FACTORY'/);
  });
});
