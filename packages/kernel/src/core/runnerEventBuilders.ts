import type {
  LegacyStreamEvent,
  MessageOutputItem,
  PlanStreamEvent,
  RawResponseStreamEvent,
  StreamEvent,
  RunItemStreamEvent,
  ToolCallItem,
  ToolCallOutputItem,
} from '../types/index.js';

export function buildPlanAutoContinueEvent(
  planText: string,
  followupPrompt: string,
  count: number,
): RawResponseStreamEvent {
  return {
    type: 'raw_response_event',
    data: {
      type: 'plan.auto_continue',
      plan_text: planText,
      followup_prompt: followupPrompt,
      count,
    },
    event_type: 'plan.auto_continue',
  } as RawResponseStreamEvent;
}

export function buildEmptyFinalOutputRecoveryEvent(payload: {
  finishReason?: string;
  streak: number;
  totalToolCalls: number;
}): RawResponseStreamEvent {
  return {
    type: 'raw_response_event',
    data: {
      type: 'runner.empty_final_output_recovery',
      finish_reason: payload.finishReason,
      streak: payload.streak,
      total_tool_calls: payload.totalToolCalls,
    },
    event_type: 'runner.empty_final_output_recovery',
  } as RawResponseStreamEvent;
}

/**
 * Build the UI separator event emitted when a continuation gate blocks a
 * no-tool exit. The kind identifies target, verification, or team-spec gates.
 */
export function buildTargetContinuationEvent(payload: {
  iteration: number;
  consecutiveBlocks: number;
  kind?: 'target' | 'verify' | 'team_spec' | 'unfinished';
}): RawResponseStreamEvent {
  return {
    type: 'raw_response_event',
    data: {
      type: 'target.continuation',
      iteration: payload.iteration,
      consecutive_blocks: payload.consecutiveBlocks,
      kind: payload.kind ?? 'target',
    },
    event_type: 'target.continuation',
  } as RawResponseStreamEvent;
}

export function buildMessageOutputCreatedEvent(
  content: string,
): RunItemStreamEvent {
  const messageOutputItem: MessageOutputItem = {
    type: 'message_output_item',
    content,
    role: 'assistant',
    timestamp: Date.now(),
  };

  return {
    type: 'run_item_stream_event',
    name: 'message_output_created',
    item: messageOutputItem,
  } as RunItemStreamEvent;
}

export function buildParallelExecutionStatsEvent(
  stats: any,
): RawResponseStreamEvent {
  return {
    type: 'raw_response_event',
    data: {
      type: 'parallel_execution.stats',
      stats,
    },
    event_type: 'parallel_execution.stats',
  } as RawResponseStreamEvent;
}

export function buildLoopWasteSummaryEvent(
  summary: any,
): RawResponseStreamEvent {
  return {
    type: 'raw_response_event',
    data: {
      type: 'loop.waste_summary',
      summary,
    },
    event_type: 'loop.waste_summary',
  } as RawResponseStreamEvent;
}

export function buildToolOutputEvents(params: {
  id: string;
  name: string;
  output: string;
  success: boolean;
  /** 被守卫拦下 (loop/permission/risk/guardrail) —— 不是工具自己跑失败 */
  blockedBy?: string;
  /** 拦下时给用户看的一句人话 (output 里那份是给模型的指令) */
  userNotice?: string;
}): [RunItemStreamEvent, LegacyStreamEvent] {
  const toolOutputItem: ToolCallOutputItem = {
    type: 'tool_call_output_item',
    id: params.id,
    name: params.name,
    output: params.output,
    success: params.success,
    blockedBy: params.blockedBy,
    userNotice: params.userNotice,
    timestamp: Date.now(),
  };

  return [
    {
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: toolOutputItem,
    } as RunItemStreamEvent,
    {
      type: 'tool_output',
      id: params.id,
      name: params.name,
      output: params.output,
      success: params.success,
      blockedBy: params.blockedBy,
      userNotice: params.userNotice,
    } as LegacyStreamEvent,
  ];
}

export function buildPlanUpdateEvent(payload: {
  explanation?: string;
  plan: PlanStreamEvent['plan'];
}): PlanStreamEvent {
  return {
    type: 'plan_update',
    explanation: payload.explanation,
    plan: payload.plan,
    timestamp: Date.now(),
  };
}

export function buildToolCalledEvent(params: {
  id: string;
  name: string;
  arguments: string;
}): RunItemStreamEvent {
  const toolCallItem: ToolCallItem = {
    type: 'tool_call_item',
    id: params.id,
    name: params.name,
    arguments: params.arguments,
    timestamp: Date.now(),
  };

  return {
    type: 'run_item_stream_event',
    name: 'tool_called',
    item: toolCallItem,
  } as RunItemStreamEvent;
}

export function buildLegacyToolCallStartEvent(params: {
  id: string;
  name: string;
}): LegacyStreamEvent {
  return {
    type: 'tool_call_start',
    id: params.id,
    name: params.name,
  };
}

export function buildLegacyToolCallDoneEvent(params: {
  id: string;
  name: string;
  arguments: string;
  success: boolean;
}): LegacyStreamEvent {
  return {
    type: 'tool_call_done',
    id: params.id,
    name: params.name,
    arguments: params.arguments,
    success: params.success,
  };
}

export function buildFunctionCallArgumentsDoneEvent(params: {
  id: string;
  name: string;
  arguments: string;
}): RawResponseStreamEvent {
  return {
    type: 'raw_response_event',
    data: {
      type: 'response.function_call_arguments.done',
      call_id: params.id,
      name: params.name,
      arguments: params.arguments,
    },
    event_type: 'response.function_call_arguments.done',
  } as RawResponseStreamEvent;
}

export function buildToolCallLifecycleEvents(params: {
  id: string;
  name: string;
  arguments: string;
  success: boolean;
}): StreamEvent[] {
  return [
    buildToolCalledEvent({
      id: params.id,
      name: params.name,
      arguments: params.arguments,
    }),
    buildLegacyToolCallStartEvent({
      id: params.id,
      name: params.name,
    }),
    buildLegacyToolCallDoneEvent({
      id: params.id,
      name: params.name,
      arguments: params.arguments,
      success: params.success,
    }),
    buildFunctionCallArgumentsDoneEvent({
      id: params.id,
      name: params.name,
      arguments: params.arguments,
    }),
  ];
}
