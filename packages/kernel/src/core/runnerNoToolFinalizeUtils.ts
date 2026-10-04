import type { StreamEvent } from '../types/index.js';
import { runOutputGuardrailsWithEvents } from './runnerGuardrailUtils.js';
import { logNoToolLoopExit } from './runnerLoggingUtils.js';
import { processStructuredOutput } from './runnerStructuredOutputUtils.js';
import { buildMessageOutputCreatedEvent } from './runnerEventBuilders.js';

/* 前缀缓存补漏: 结构化输出 retry 提示原以 role:'system' 注入,
 * 会被 anthropic adapter 合并进顶层 system 块打穿整条 KV cache (retryPrompt 带
 * 校验错误详情, 每次内容都不同)。改 appendReminder 顺序尾部追加, 缓存无损。 */
type MemoryLike = {
  appendReminder: (text: string) => void;
};

export async function finalizeNoToolResponse(options: {
  fullContent: string;
  finishReason?: string;
  toolCallCount: number;
  totalToolCalls: number;
  iteration: number;
  textOnlyStreakCount: number;
  structuredValidator?: any;
  structuredOutputName?: string;
  outputGuardrails: any[];
  context: any;
  agentName: string;
  memory: MemoryLike;
}): Promise<{
  shouldContinue: boolean;
  finalOutput: string;
  events: StreamEvent[];
}> {
  const events: StreamEvent[] = [];

  if (options.fullContent) {
    events.push(buildMessageOutputCreatedEvent(options.fullContent));
  }

  logNoToolLoopExit({
    finishReason: options.finishReason,
    fullContent: options.fullContent,
    toolCallCount: options.toolCallCount,
    iteration: options.iteration,
    textOnlyStreakCount: options.textOnlyStreakCount,
  });

  const structuredResult = processStructuredOutput({
    fullContent: options.fullContent,
    validator: options.structuredValidator,
    schemaName: options.structuredOutputName,
  });

  if (structuredResult.kind === 'retry') {
    events.push(structuredResult.event);
    options.memory.appendReminder(structuredResult.retryPrompt);
    return {
      shouldContinue: true,
      finalOutput: '',
      events,
    };
  }

  if (structuredResult.event) {
    events.push(structuredResult.event);
  }

  for await (const guardrailEvent of runOutputGuardrailsWithEvents({
    outputGuardrails: options.outputGuardrails,
    context: options.context,
    agentName: options.agentName,
    finalOutput: structuredResult.finalOutput,
  })) {
    events.push(guardrailEvent);
  }

  /* · BYOK 无差异错误反馈: 任何"空 finalOutput"分支都必须 emit 到 UI 能收到的
   * 事件类型 (type:'error'), 否则 run_result output="" → useStreamHandler 静默返回 →
   * timeline 完全空白, 用户无反馈.
   *
   *   3 种空返回场景 (按严重度):
   *   ────────────────────────────────
   *   S1  totalToolCalls === 0, fullContent === ""
   *       从没调 tool 也没吐字 — 一定是异常 (max_tokens 太小 / provider 挂 / 上游过滤).
   *       BYOK 用户点击"发送"没任何反馈, 是最灾难场景, 强 error 卡片.
   *
   *   S2  totalToolCalls > 0, fullContent === "", finishReason 合法 (stop/end_turn/tool_calls)
   *       模型判断"完成了, 无追加" — Claude Code 视作合法响应 (ref claude.ts:2346-2349).
   *       静默通过, 用户看到的是工具结果卡片 + 无 assistant 消息.
   *
   *   S3  totalToolCalls > 0, fullContent === "", finishReason 异常 (length/content_filter/safety/...)
   *       调完 tool 后被 max_tokens 截断没吐字 → 用户看到的会是"工具跑完但没有回复", 一样得
   *       给红色 error 卡片, 告知 finish_reason. */
  const fr = (options.finishReason || '').toLowerCase();
  const isLegitimateStop = fr === '' || fr === 'stop' || fr === 'end_turn' || fr === 'tool_calls';
  const trimmedOutput = structuredResult.finalOutput.trim();
  if (!trimmedOutput) {
    if (options.totalToolCalls === 0) {
      /* S1: 强 error 卡片 — BYOK 空回复最灾难场景. */
      events.push({
        type: 'error',
        error: `模型未产出任何内容 (finish_reason=${fr || 'unknown'}, 未调用任何工具). 常见原因: max_tokens 太小 / 上游 provider 异常 / BYOK apiKey 无权限. 建议去 服务商设置 检查配置或增大 max_tokens.`,
      } as unknown as StreamEvent);
    } else if (isLegitimateStop) {
      /* S2: 合法静默 — 保持 Claude Code 一致行为, 不 emit. */
    } else {
      /* S3: 异常终止 + 工具跑过 → 红色 error 卡片, 告知 finish_reason. */
      events.push({
        type: 'error',
        error: `已完成 ${options.totalToolCalls} 次工具调用, 但模型在 finish_reason=${fr} 状态下未输出文字回复. 可能被 max_tokens 截断 / content_filter / 上游异常. 建议增大 max_tokens 或换模型.`,
      } as unknown as StreamEvent);
    }
  }

  return {
    shouldContinue: false,
    finalOutput: structuredResult.finalOutput,
    events,
  };
}
