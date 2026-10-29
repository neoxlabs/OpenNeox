/**
 * 「是不是 Chat」判据 (chat:C1-02)
 *
 * 用例表在 fixtures/chatSessionMode.cases.json —— 手机端
 * (apps/mobile/test/chat_session_mode_test.dart) 读的是同一个文件。两端结果不一样, 两边都会红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_AGENT_MODE, isChatSession } from '../chatSessionMode.js';

interface Case {
  name: string;
  agentMode: string | null;
  chatMode: boolean | null;
  expected: boolean;
}

const table = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'chatSessionMode.cases.json'), 'utf8'),
) as { cases: Case[] };

describe('isChatSession', () => {
  it('用例表覆盖三种 agentMode × 开关两种取法', () => {
    const modes = new Set(table.cases.map((c) => c.agentMode));
    expect(modes.has('work')).toBe(true);
    expect(modes.has('code')).toBe(true);
    expect(modes.has(CHAT_AGENT_MODE)).toBe(true);
  });

  for (const c of table.cases) {
    it(`${c.name} → ${c.expected}`, () => {
      expect(isChatSession({ agentMode: c.agentMode, chatMode: c.chatMode })).toBe(c.expected);
    });
  }

  it('字段全缺省 = 不是 Chat (不猜)', () => {
    expect(isChatSession({})).toBe(false);
  });
});
