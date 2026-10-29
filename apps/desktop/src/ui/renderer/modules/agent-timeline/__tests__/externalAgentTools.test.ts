/**
 * 外部 Agent 工具识别
 *
 *   守的是一条: 名字后缀是**约定**不是**事实**。第三方插件完全可以有个叫
 *   `email_delegate` 的普通工具 —— 那时候不该给用户一张「Agent 正在运行」的卡。
 */
import { describe, it, expect } from 'vitest';
import {
  isExternalAgentTool,
  externalAgentMeta,
  __setExternalAgentTools,
} from '../externalAgentTools';

describe('externalAgentTools', () => {
  it('注册表里的才算外部 Agent', () => {
    __setExternalAgentTools([{ id: 'codex', displayName: 'Codex' }]);
    expect(isExternalAgentTool('codex_delegate')).toBe(true);
    /* 后缀像但没注册 —— 不能凭名字给它一张 Agent 卡 */
    expect(isExternalAgentTool('email_delegate')).toBe(false);
    expect(isExternalAgentTool('readfile')).toBe(false);
    expect(isExternalAgentTool(undefined)).toBe(false);
  });

  it('meta 优先用注册表里的显示名, 没有就从工具名推', () => {
    __setExternalAgentTools([{ id: 'claude_code', displayName: 'Claude Code' }]);
    expect(externalAgentMeta('claude_code_delegate')).toEqual({
      agentId: 'claude_code', displayName: 'Claude Code',
    });
    expect(externalAgentMeta('unknown_delegate').agentId).toBe('unknown');
  });
});
