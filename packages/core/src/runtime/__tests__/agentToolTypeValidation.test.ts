import { describe, expect, it } from 'vitest';
import { getAvailableAgentTypes, getAgentType, DEFAULT_AGENT_TYPE_ID } from '../agent/agentTypes.js';

/* 验证 agent 工具类型使用稳定的小写 id，并接受归一化后的模型输入。 */

describe('agent type registry contract (E3)', () => {
  it('registry id must be lowercase', () => {
    /* buildAgentTypesPrompt 明确告诉 LLM 用 .id (lowercase), 所以 registry 键 id 必须是 lowercase */
    for (const t of getAvailableAgentTypes()) {
      expect(t.id).toBe(t.id.toLowerCase());
    }
  });

  it('DEFAULT_AGENT_TYPE_ID exists in registry', () => {
    expect(getAgentType(DEFAULT_AGENT_TYPE_ID)).toBeTruthy();
    expect(getAgentType(DEFAULT_AGENT_TYPE_ID).id).toBe(DEFAULT_AGENT_TYPE_ID);
  });

  it('getAgentType accepts lowercase id and returns matching def', () => {
    expect(getAgentType('code').id).toBe('code');
    expect(getAgentType('plan').id).toBe('plan');
    expect(getAgentType('verify').id).toBe('verify');
    expect(getAgentType('shell').id).toBe('shell');
  });

  it('all documented types are registered (regression: verify was missing from tool enum)', () => {
    const ids = new Set(getAvailableAgentTypes().map(t => t.id));
    expect(ids.has('code')).toBe(true);
    expect(ids.has('shell')).toBe(true);
    expect(ids.has('plan')).toBe(true);
    expect(ids.has('verify')).toBe(true);
  });
});
