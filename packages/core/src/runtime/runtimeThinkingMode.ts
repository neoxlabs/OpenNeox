import type { ProviderControls } from './runtimeBuilder.js';
import type { LLMProvider } from '@neoxlabs/kernel/types/index.js';

export type ThinkingMode = 'enabled' | 'disabled' | 'auto';

export function applyThinkingMode(
  mode: ThinkingMode,
  controls?: ProviderControls | null,
  provider?: LLMProvider | null
): boolean {
  if (controls?.setThinkingMode) {
    controls.setThinkingMode(mode);
    return true;
  }

  const providerAny = provider as any;

  // Anthropic provider
  if (providerAny?.setThinking) {
    providerAny.setThinking({ type: mode === 'auto' ? 'enabled' : mode });
    return true;
  }

  // Doubao provider
  if (providerAny?.setDoubaoThinking) {
    providerAny.setDoubaoThinking({ type: mode });
    return true;
  }

  // Gemini provider - 使用相同的 setThinking 接口
  // GeminiProvider.setThinking 接受 { type: 'enabled' | 'disabled', budget?: number }
  // 注意: Gemini 的 setThinking 已经在上面的 providerAny?.setThinking 中处理
  // 这里不需要额外处理，因为 GeminiProvider 也实现了 setThinking 方法

  return false;
}
