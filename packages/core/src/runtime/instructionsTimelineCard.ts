
import type { ProjectInstructions } from '@neoxlabs/kernel/core/projectInstructions.js';
import { createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';

/** 与 AgenticChatHandlers.onRuntimeEvent 的第二参 (tracker) 同形 —— 合成事件的最小 tracker. */
export interface SyntheticEventTracker {
  contextUsed: number;
  startTime: number;
  provider: string;
  model: string;
}

export type EmitRuntimeEvent = (event: unknown, tracker: SyntheticEventTracker) => void;

/** 卡片上的工具名 —— renderer 侧 mapTimeline / StepContentRenderer 按这个串路由. */
export const LOAD_INSTRUCTIONS_TOOL_NAME = 'load_instructions';

/** 供 timeline 富卡消费的结构化 metadata (不含 hash —— 那是内部细节, 用户不关心). */
export interface InstructionsCardMetadata {
  workspace: string;
  sources: Array<{ path: string; level: 'workspace' | 'parent' | 'user'; lines: number }>;
  failures: Array<{ path: string; code: string; message: string }>;
  /** 合并后指令总字符数 —— "多大" 的第二个口径 (行数在每条 source 上). */
  chars: number;
}

/** 一句话摘要, 折叠态就能看懂 (title 之外的副标题). */
export function summarizeInstructionsLoad(instructions: ProjectInstructions): string {
  const { sources, failures } = instructions;
  const okPart = sources.length > 0
    ? `${sources.length} 个指令文件 · ${sources.reduce((n, s) => n + s.lines, 0)} 行`
    : '';
  const failPart = failures.length > 0 ? `${failures.length} 个读取失败` : '';
  return [okPart, failPart].filter(Boolean).join(' · ');
}

export function shouldEmitInstructionsCard(instructions: ProjectInstructions): boolean {
  return instructions.sources.length > 0 || instructions.failures.length > 0;
}

/**
 * 发一对合成 tool_call_start / tool_call_end, 让 timeline 长出一张"加载项目指令"卡.
 *
 * 调用方只在 freshlyLoaded 时调 —— 本函数不自己判重, 保持职责单一 (便于测试).
 */
export function emitInstructionsTimelineCard(params: {
  emit: EmitRuntimeEvent | undefined;
  workspace: string;
  instructions: ProjectInstructions;
  providerId?: string;
  modelName?: string;
}): boolean {
  const { emit, workspace, instructions, providerId, modelName } = params;
  if (!emit) return false;
  if (!shouldEmitInstructionsCard(instructions)) return false;

  const now = Date.now();
  const tracker: SyntheticEventTracker = {
    contextUsed: 0,
    startTime: now,
    provider: providerId || 'unknown',
    model: modelName || 'unknown',
  };

  const metadata: InstructionsCardMetadata = {
    workspace,
    sources: instructions.sources,
    failures: instructions.failures,
    chars: instructions.content.length,
  };

  const success0 = instructions.failures.length === 0;
  const output = JSON.stringify(createContextualResult(
    LOAD_INSTRUCTIONS_TOOL_NAME,
    success0 ? 'success' : 'error',
    summarizeInstructionsLoad(instructions),
    /* content = 给 LLM/用户看的正文. 这里刻意**不**塞指令原文 —— 指令已经在 system prompt 里,
     * 重复一遍纯属浪费上下文, 卡片只需要交代"加载了什么". */
    '',
    { metadata: metadata as unknown as Record<string, unknown> },
  ));

  /* 显式 toolId —— renderer 靠它把 start/end 配成同一张卡 (runtimeEventForwarder 的
   * resolveToolId 缺省返 undefined, 那样只能靠工具名兜底匹配, 并发时会配错/卡在转圈).
   * 加 now 保证同一 workspace 二次加载 (refresh) 也不会撞上一张已完成的卡. */
  const toolId = `load-instructions:${workspace}:${now}`;

  emit({
    type: 'tool_call_start',
    name: LOAD_INSTRUCTIONS_TOOL_NAME,
    toolId,
    args: { workspace },
    description: '加载项目指令',
    timestamp: now,
  }, tracker);

  /* 有任何一个候选文件读不了就算失败 —— 哪怕另有文件读成功了.
   * "读到 2 个但第 3 个 EACCES" 依然必须是红卡: 用户少了一份他以为生效的指令. */
  const success = success0;

  emit({
    type: 'tool_call_end',
    name: LOAD_INSTRUCTIONS_TOOL_NAME,
    toolId,
    success,
    timestamp: Date.now(),
    duration: Date.now() - now,
    summary: summarizeInstructionsLoad(instructions),
    output,
    resultLength: output.length,
    toolStatus: success ? 'success' : 'error',
    toolKind: 'contextual',
    toolError: success
      ? undefined
      : instructions.failures.map(f => `${f.path}: ${f.code}`).join('; '),
    args: { workspace },
    metadata: metadata as unknown as Record<string, unknown>,
  }, tracker);

  return true;
}
