import { beforeEach, describe, expect, it, vi } from 'vitest';

const configState = vi.hoisted(() => ({
  config: {} as any,
}));

vi.mock('@neoxlabs/platform/utils/config.js', () => ({
  loadConfig: () => configState.config,
  saveConfig: vi.fn(),
  CONFIG_FILE: '/tmp/neox/config.json',
  onUserIdChange: () => {},
}));

import { getModelOrchestrationPromptSection } from '../modelOrchestrationPrompt.js';
import { getModelOrchestrationMode, refreshAgentRuntimeConfig } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';

describe('智能模型编排知识注入 (Team P1 能力1)', () => {
  beforeEach(() => {
    configState.config = { language: 'zh' };
    delete process.env.NEOX_MODEL_ORCHESTRATION;
    refreshAgentRuntimeConfig();
  });

  it('默认 off: 不注入任何内容 (发布稳定优先)', () => {
    expect(getModelOrchestrationMode()).toBe('off');
    expect(getModelOrchestrationPromptSection()).toBe('');
  });

  it('开关 on: 注入中文编排知识段', () => {
    configState.config = { language: 'zh', agentRuntime: { modelOrchestration: 'on' } };
    refreshAgentRuntimeConfig();
    const section = getModelOrchestrationPromptSection();
    expect(section).toContain('<model_orchestration>');
    expect(section).toContain('neox_config');
    expect(section).toContain('不同 provider');       // 交叉审查原则
    expect(section).toContain('理由');                // 选型可解释
    expect(section).toContain('偏好');                // 用户偏好经 routing 域
  });

  it('英文 UI: 注入英文版 (跟 getPromptLanguage 同款判断)', () => {
    configState.config = { language: 'en', agentRuntime: { modelOrchestration: 'on' } };
    refreshAgentRuntimeConfig();
    const section = getModelOrchestrationPromptSection();
    expect(section).toContain('<model_orchestration>');
    expect(section).toContain('different provider');
    expect(section).not.toContain('智能模型编排');
  });

  it('env NEOX_MODEL_ORCHESTRATION 可临时覆盖 config', () => {
    process.env.NEOX_MODEL_ORCHESTRATION = 'on';
    expect(getModelOrchestrationMode()).toBe('on');
    expect(getModelOrchestrationPromptSection()).not.toBe('');

    process.env.NEOX_MODEL_ORCHESTRATION = 'off';
    configState.config = { agentRuntime: { modelOrchestration: 'on' } };
    refreshAgentRuntimeConfig();
    expect(getModelOrchestrationMode()).toBe('off');
  });

  it('token 预算护栏: 单语版 ≤600 tokens (按 CJK≈1 token/字 + latin≈4 字符/token 估)', () => {
    const estimateTokens = (text: string): number => {
      const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
      const rest = text.length - cjk;
      return cjk + Math.ceil(rest / 4);
    };

    configState.config = { language: 'zh', agentRuntime: { modelOrchestration: 'on' } };
    refreshAgentRuntimeConfig();
    expect(estimateTokens(getModelOrchestrationPromptSection())).toBeLessThanOrEqual(600);

    configState.config = { language: 'en', agentRuntime: { modelOrchestration: 'on' } };
    refreshAgentRuntimeConfig();
    expect(estimateTokens(getModelOrchestrationPromptSection())).toBeLessThanOrEqual(600);
  });
});
