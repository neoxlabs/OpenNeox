/**
 * instructionsBridge — kernel provider 拿"Neox 系统提示构建器"的注入桥 (kernel-clean)
 *
 * OpenAIProvider(走 openai-responses 协议时)会用 runtime/systemPrompt.ts 的 buildInstructions
 * 自建系统提示, 而 buildInstructions 拖 tools/runtimeToolServices(→sqlite)+ prompts/layers
 * (→skills)= Neox 业务。纯 kernel provider 不该建 Neox 提示。
 *
 * 机制(同 kernelConfigBridge): core 的 systemPrompt.ts 加载时自注册 setInstructionsBuilder(buildInstructions)。
 *   - 整车: 行为不变, provider 仍自建 Neox responses 指令。
 *   - 纯 kernel(第三方): 不注入 → buildKernelInstructions 返 undefined → provider 不注入指令
 *     (第三方自己通过 messages 传 system, 正确)。
 *
 * (kernel 抽离 models 批次 — 详见 docs/NEOX_KERNEL_EXTRACTION_DESIGN.md)
 */

import type { ResolvedModelProfile } from '../profiles/index.js';

export interface KernelInstructionsOpts {
  workDir: string;
  language?: 'zh' | 'en';
  protocol?: string;
  model?: string;
  baseUrl?: string;
  modelProfile?: ResolvedModelProfile;
}

let _builder: ((o: KernelInstructionsOpts) => string) | null = null;

/** core 侧 systemPrompt 自注册真实 buildInstructions。 */
export function setInstructionsBuilder(fn: ((o: KernelInstructionsOpts) => string) | null): void {
  _builder = fn;
}

/** kernel provider 调用; 无注入(纯 kernel)→ undefined → 不注入指令。 */
export function buildKernelInstructions(o: KernelInstructionsOpts): string | undefined {
  return _builder ? _builder(o) : undefined;
}
