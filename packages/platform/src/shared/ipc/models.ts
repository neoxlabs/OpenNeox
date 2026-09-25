import type { ProviderProtocol } from '@neoxlabs/kernel/types/configTypes.js';
import type { ModelRouteConfig } from './modelRouting.js';

export type DoubaoThinkingMode = 'enabled' | 'disabled' | 'auto';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  providerId: string;
  maxTokens: number;
  contextWindow: number;
  protocol?: ProviderProtocol;
  baseUrl?: string;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  thinkingModes?: DoubaoThinkingMode[];
  isAutoRouted?: boolean;
  routeConfig?: ModelRouteConfig;
  resolvedProviderId?: string;
}

export const DOUBAO_THINKING_MODELS: Record<string, DoubaoThinkingMode[]> = {
  'doubao-seed-code-preview-251028': ['enabled', 'disabled'],
  'doubao-seed-1-6-vision-250815': ['enabled', 'disabled'],
  'doubao-seed-1-6-lite-251015': ['enabled', 'disabled'],
  'doubao-seed-1-6-250615': ['enabled', 'disabled', 'auto'],
  'doubao-seed-1-6-251015': ['enabled', 'disabled'],
  'doubao-seed-1-6-flash-250828': ['enabled', 'disabled'],
  'doubao-seed-1-6-flash-250715': ['enabled', 'disabled'],
  'doubao-seed-1-6-flash-250615': ['enabled', 'disabled'],
  'deepseek-v3-1-terminus': ['enabled', 'disabled'],
  'deepseek-v3-1-250821': ['enabled', 'disabled'],
};

export const CLAUDE_THINKING_MODELS: string[] = [
  'opus-4-6',
  'opus-4.6',
  'opus-4-5',
  'opus-4.5',
  'sonnet-4-5',
  'sonnet-4.5',
  '-thinking',
];

export const GEMINI_THINKING_MODELS: string[] = [
  'gemini-2.0-flash-thinking',
  'gemini-2.5-flash-preview',
  'gemini-2.5-pro-preview',
];

export function isThinkingSupported(
  modelName: string,
  protocol?: ProviderProtocol,
  baseUrl?: string
): boolean {
  void baseUrl;
  const isClaudeThinkingModel = CLAUDE_THINKING_MODELS.some(pattern => modelName.includes(pattern));
  if (isClaudeThinkingModel && protocol === 'anthropic') {
    return true;
  }

  const isGeminiThinkingModel = GEMINI_THINKING_MODELS.some(pattern => modelName.includes(pattern));
  if (isGeminiThinkingModel && protocol === 'gemini') {
    return true;
  }

  const isDoubaoThinkingModel = Object.keys(DOUBAO_THINKING_MODELS).some(pattern => modelName.includes(pattern));
  if (!isDoubaoThinkingModel) {
    return false;
  }

  if (protocol === 'doubao') {
    return true;
  }

  if (protocol === 'openai') {
    return true;
  }

  return false;
}

export function getThinkingModes(
  modelName: string,
  protocol?: ProviderProtocol
): DoubaoThinkingMode[] | undefined {
  const isClaudeThinkingModel = CLAUDE_THINKING_MODELS.some(pattern => modelName.includes(pattern));
  if (isClaudeThinkingModel && protocol === 'anthropic') {
    return ['enabled', 'disabled'];
  }

  const isGeminiThinkingModel = GEMINI_THINKING_MODELS.some(pattern => modelName.includes(pattern));
  if (isGeminiThinkingModel && protocol === 'gemini') {
    return ['enabled', 'disabled'];
  }

  for (const [pattern, modes] of Object.entries(DOUBAO_THINKING_MODELS)) {
    if (modelName.includes(pattern)) {
      return modes;
    }
  }
  return undefined;
}

/* 真实模型加载前的占位 (sessionStore 初始化塞)。匿名/未登录默认走 Neox Cloud 'auto' 自动路由,
 * 不该显示 GPT-4o (匿名根本用不了境外模型, 显示出来误导)。id 仍以 default: 开头让既有"清占位"逻辑认得。 */
export const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'default:auto',
    name: 'auto',
    provider: 'Neox',
    providerId: 'default',
    maxTokens: 4096,
    contextWindow: 128000,
  },
];
