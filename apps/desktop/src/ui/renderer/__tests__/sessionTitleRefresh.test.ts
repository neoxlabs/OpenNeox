import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(HERE, p), 'utf8');

const streamHandler = read('../pages/workspace/hooks/useStreamHandler.ts');
const bridge = read('../app/NeoxRuntimeBridge.tsx');

describe('会话标题刷新链路', () => {
  it('收到 session_title_changed 会派 DOM 事件', () => {
    expect(streamHandler).toMatch(/event\.type === 'session_title_changed'/);
    expect(streamHandler).toMatch(/new CustomEvent\('neox:session-title-changed'/);
  });

  it('派出去的事件有人接 —— 断在这一跳就是"库里改了界面不动"', () => {
    expect(bridge).toMatch(/addEventListener\('neox:session-title-changed'/);
    expect(bridge).toMatch(/removeEventListener\('neox:session-title-changed'/);
  });

  it('接到之后两处都改: 侧栏列表 + 顶部的 activeSession', () => {
    const i = bridge.indexOf("addEventListener('neox:session-title-changed'");
    const block = bridge.slice(Math.max(0, i - 1800), i);
    expect(block).toMatch(/setSessions\(/);
    /* 顶部走 patchActiveSession —— 整个 setActiveSession 旧对象会把期间切过去的会话顶回来 */
    expect(block).toMatch(/patchActiveSession\(/);
  });
});
