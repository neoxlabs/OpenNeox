import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, '..', 'agenticRuntime.ts'), 'utf-8');

describe('子 agent 事件登记 turn 进展', () => {
  it('onTaskAgentEvent 里调了 noteTurnProgress', () => {
    expect(SRC).toContain('noteTurnProgress(sessionId, `sub-agent:');
  });

  it('⭐️ 登记在生命周期过滤**之前** —— 被过滤掉的事件同样证明这一轮活着', () => {
    /* run_result / text_complete 这些子 agent 生命周期事件不往上转 (会被误读成整轮结束),
     * 但它们照样是"还在跑"的证据。埋点挪到 return 之后, 一个只发这类事件的子 agent
     * 又会把看门狗饿死。 */
    const at = SRC.indexOf('noteTurnProgress(sessionId, `sub-agent:');
    const filterAt = SRC.indexOf("type === 'run_result'");
    expect(at).toBeGreaterThan(-1);
    expect(filterAt).toBeGreaterThan(-1);
    expect(at).toBeLessThan(filterAt);
  });

  it('主 agent 那条路也还在 (别把包装器里的那句删了)', () => {
    expect(SRC).toContain("noteTurnProgress(sessionId, String((event as { type?: unknown })?.type ?? 'event'))");
  });
});
