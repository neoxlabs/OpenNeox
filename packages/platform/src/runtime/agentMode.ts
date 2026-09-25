
export type AgentMode = 'work' | 'code';

export const AGENT_MODES: readonly AgentMode[] = ['work', 'code'] as const;

/** 默认 code — 保持存量用户行为不变 (Neox 现有用户全是编码场景)。 */
export const DEFAULT_AGENT_MODE: AgentMode = 'code';

export function isValidAgentMode(v: unknown): v is AgentMode {
  return v === 'work' || v === 'code';
}

/** 非法/缺省值一律归一到 code (fail-open 到全功能, 不静默降级到受限模式); 旧的 assistant 归到 work。 */
export function normalizeAgentMode(v?: string | null): AgentMode {
  if (v === 'assistant') return 'work';
  return isValidAgentMode(v) ? v : DEFAULT_AGENT_MODE;
}

export function getAgentModeLabel(mode: AgentMode, language: 'zh' | 'en' = 'zh'): string {
  const labels: Record<AgentMode, { zh: string; en: string }> = {
    work: { zh: '工作', en: 'Work' },
    code: { zh: '编码', en: 'Code' },
  };
  return labels[mode][language];
}
