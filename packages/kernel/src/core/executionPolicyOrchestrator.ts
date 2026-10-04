import type {
  RawResponseStreamEvent,
  RunContext,
  RunItemStreamEvent,
  StreamEvent,
  Tool,
  ToolCallOutputItem,
} from '../types/index.js';
import type { ParsedToolArguments } from './toolArgsParser.js';
import type { ToolInputGuardrail, ToolOutputGuardrail, ToolContext } from '../types/guardrails.js';
import type { ToolCall as ParallelToolCall, ToolResult } from './parallelExecutor.js';
import { GuardrailsExecutor } from './guardrails.js';
import { ToolGuardrailTripwireTriggered } from './guardrail-exceptions.js';
import { recordToolCall } from './sessionState.js';
import { logger } from '../utils/logger.js';
import { cliLogger } from '../platform/cliLogger.js';
import { parseToolArguments } from './toolArgsParser.js';
import { PermissionManager } from './permissions/index.js';
import { ErrorCategory, type NeoxError } from '../types/errors.js';
import { formatDelay, getSmartRetryDelay } from '../utils/backoff.js';

function createAbortError(): Error & { code?: string; category?: string } {
  const error = new Error('Request aborted') as Error & { code?: string; category?: string };
  error.name = 'AbortError';
  error.code = 'ERR_CANCELED';
  error.category = 'canceled';
  return error;
}

async function withAbortCheck<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const result = await operation();
  if (signal?.aborted) {
    throw createAbortError();
  }
  return result;
}

interface PreExecutionInput {
  executableToolCalls: ExecutableToolCall[];
  parallelToolCalls: ParallelToolCall[];
  parsedArgsByToolId: Map<string, ParsedToolArguments>;
  shouldAutoApprove: boolean;
  signal?: AbortSignal;
  iteration: number;
}

interface PreExecutionResult {
  executableToolCalls: ExecutableToolCall[];
  parallelToolCalls: ParallelToolCall[];
  events: StreamEvent[];
  shouldBreak: boolean;
  shouldContinue: boolean;
  encounteredError: boolean;
}

interface ToolResultPolicyInput {
  result: ToolResult;
  toolCalls: ExecutableToolCall[];
  truncatedResult: string;
}

interface ExecutableToolCall {
  id: string;
  function: {
    name: string;
    arguments?: string;
  };
}

interface ToolResultPolicyResult {
  truncatedResult: string;
  toolInput: Record<string, any>;
  shouldBreak: boolean;
  encounteredError: boolean;
}

interface RetryDecisionInput {
  classifiedError: NeoxError;
  streamRetries: number;
  maxStreamRetries: number;
  providerManagedRetryObserved: boolean;
}

export interface RetryDecision {
  nextStreamRetries: number;
  delayMs: number;
  logMessage: string;
  event: RawResponseStreamEvent;
}

export interface ExecutionPolicyOrchestratorOptions {
  tools: Tool[];
  permissionManager: PermissionManager;
  memory: {
    addToolResult: (toolCallId: string, toolName: string, output: string) => void;
  };
  runContext: RunContext;
  agentName: string;
  toolInputGuardrails: ToolInputGuardrail[];
  toolOutputGuardrails: ToolOutputGuardrail[];
}

export class ExecutionPolicyOrchestrator {
  private tools: Tool[];
  private permissionManager: PermissionManager;
  private memory: ExecutionPolicyOrchestratorOptions['memory'];
  private runContext: RunContext;
  private agentName: string;
  private toolInputGuardrails: ToolInputGuardrail[];
  private toolOutputGuardrails: ToolOutputGuardrail[];

  constructor(options: ExecutionPolicyOrchestratorOptions) {
    this.tools = options.tools;
    this.permissionManager = options.permissionManager;
    this.memory = options.memory;
    this.runContext = options.runContext;
    this.agentName = options.agentName;
    this.toolInputGuardrails = options.toolInputGuardrails;
    this.toolOutputGuardrails = options.toolOutputGuardrails;
  }

  setRunContext(runContext: RunContext): void {
    this.runContext = runContext;
  }

  async evaluatePreExecution(input: PreExecutionInput): Promise<PreExecutionResult> {
    let { executableToolCalls, parallelToolCalls } = input;
    const events: StreamEvent[] = [];
    let encounteredError = false;
    let userDeniedTool = false;

    const pushToolOutputEvents = (
      toolCallId: string,
      toolName: string,
      output: string,
      errorReason?: 'denied_by_user' | 'denied_by_config' | 'denied_by_mode' | 'denied_by_hook' | 'denied_by_skill_scope' | 'tool_failure' | 'error',
    ) => {
      const toolOutputItem: ToolCallOutputItem = {
        type: 'tool_call_output_item',
        id: toolCallId,
        name: toolName,
        output,
        success: false,
        timestamp: Date.now(),
      };

      events.push({
        type: 'run_item_stream_event',
        name: 'tool_output',
        item: toolOutputItem,
      } as RunItemStreamEvent);

      events.push({
        type: 'tool_output',
        id: toolCallId,
        name: toolName,
        output,
        success: false,
        // 结构化错误原因 —— 让下游 runtimeEventForwarder 转 tool_error 时
        // 也能携带这个字段，最终 renderer 据此精确显示"已拒绝" / "已配置拒绝"
        // 而不需要解析 output 字符串
        errorReason,
      } as StreamEvent);
    };

    const forcePermissionCheck = this.permissionManager.shouldForcePermissionCheck({
      /* per-session approval mode: 优先 sessionId, 兜底 agentName (同 L196) */
      scopeKey: this.runContext.sessionId || this.agentName,
    });

    if (forcePermissionCheck || !input.shouldAutoApprove) {
      const permissionBlockedToolIds = new Set<string>();

      try {
        for (const toolCall of executableToolCalls) {
          try {
            const parsedArgs = input.parsedArgsByToolId.get(toolCall.id);
            if (!parsedArgs?.ok) {
              continue;
            }
            const args = parsedArgs.args;

            const tool = this.tools.find(t => t.name === toolCall.function.name);
            if (!tool) {
              cliLogger.warn('RUNNER', `Tool not found: ${toolCall.function.name}`);
              continue;
            }

            const decision = await withAbortCheck(input.signal, async () =>
              this.permissionManager.checkPermission(tool, args, {
                /* per-session approval mode: scopeKey 跟 L174 shouldForcePermissionCheck 对齐,
                 * 否则 force-check 用 sessionId / decision 用 agentName, 两边查不同 mode → 拿到的判定不一致 */
                scopeKey: this.runContext.sessionId || this.agentName,
              })
            );

            if (!decision.allowed) {
              permissionBlockedToolIds.add(toolCall.id);
              const denialOutput = decision.reason || `Tool "${toolCall.function.name}" was denied`;

              logger.toolError(toolCall.function.name, denialOutput);
              //  把 PermissionManager 给的 denyKind 透传到 tool_output 事件，
              // 让 renderer 不用字符串匹配也能识别"是不是用户拒绝"
              pushToolOutputEvents(toolCall.id, toolCall.function.name, denialOutput, decision.denyKind);

              const denialResult = JSON.stringify({
                type: 'ephemeral',
                status: 'error',
                tool: toolCall.function.name,
                summary: 'Tool execution denied by user',
                error: denialOutput,
                final: true,
              });
              this.memory.addToolResult(toolCall.id, toolCall.function.name, denialResult);

              cliLogger.info('PERMISSION', `Tool denied: ${toolCall.function.name} - ${denialOutput}`);
              userDeniedTool = true;
            }
          } catch (error: any) {
            if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {
              throw error;
            }
            logger.toolError(toolCall.function.name, error?.message || 'permission check failed');
          }
        }
      } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {
          cliLogger.info('RUNNER', 'Interrupt detected during permission check');
          return {
            executableToolCalls,
            parallelToolCalls,
            events,
            shouldBreak: true,
            shouldContinue: false,
            encounteredError: true,
          };
        }
        throw error;
      }

      executableToolCalls = executableToolCalls.filter(tc => !permissionBlockedToolIds.has(tc.id));
      parallelToolCalls = parallelToolCalls.filter(tc => !permissionBlockedToolIds.has(tc.id));

      if (userDeniedTool) {
        cliLogger.info('RUNNER', 'User denied tool - terminating current turn');
        return {
          executableToolCalls,
          parallelToolCalls,
          events,
          shouldBreak: true,
          shouldContinue: false,
          encounteredError: false,
        };
      }

      if (parallelToolCalls.length === 0) {
        return {
          executableToolCalls,
          parallelToolCalls,
          events,
          shouldBreak: false,
          shouldContinue: true,
          encounteredError: false,
        };
      }
    }

    if (this.toolInputGuardrails.length > 0) {
      const guardrailBlockedToolIds = new Set<string>();

      try {
        for (const toolCall of executableToolCalls) {
          try {
            const parsedArgs = input.parsedArgsByToolId.get(toolCall.id);
            if (!parsedArgs?.ok) {
              continue;
            }
            const args = parsedArgs.args;

            const toolContext: ToolContext = {
              tool_name: toolCall.function.name,
              tool_input: args,
              tool_call_id: toolCall.id,
            };

            const tool = this.tools.find(t => t.name === toolCall.function.name);
            if (!tool) {
              continue;
            }

            this.runContext.iteration = input.iteration;

            const guardrailResult = await withAbortCheck(input.signal, async () =>
              GuardrailsExecutor.runToolInputGuardrails(this.toolInputGuardrails, {
                context: this.runContext,
                tool_context: toolContext,
                agent_name: this.agentName,
                tool,
              })
            );

            if (!guardrailResult.should_execute) {
              guardrailBlockedToolIds.add(toolCall.id);
              const rejectionOutput = guardrailResult.rejection_message ||
                `Tool ${toolCall.function.name} was blocked by guardrail`;

              logger.toolError(toolCall.function.name, `Blocked by guardrail: ${rejectionOutput}`);
              pushToolOutputEvents(toolCall.id, toolCall.function.name, rejectionOutput);

              this.memory.addToolResult(toolCall.id, toolCall.function.name, rejectionOutput);
              recordToolCall(this.runContext, toolCall.function.name, args, false);
            }
          } catch (guardrailError: any) {
            if (guardrailError?.name === 'AbortError' || guardrailError?.code === 'ERR_CANCELED') {
              throw guardrailError;
            }

            if (guardrailError instanceof ToolGuardrailTripwireTriggered) {
              //  FIX: tripwire 不再硬终止 agent 运行
              // 改为与 permission denial 相同的处理：反馈给 LLM，让它换方式或向用户确认
              const tripwireMessage =
                `⚠️ 命令被安全策略阻止 (${toolCall.function.name})\n` +
                `原因: ${guardrailError.message}\n\n` +
                `该操作被判定为高风险，已被自动拦截。\n` +
                `你应该:\n` +
                `1. 向用户说明你想执行什么操作以及为什么\n` +
                `2. 使用更安全的替代命令\n` +
                `3. 如果用户明确要求执行，可以分步骤安全地完成`;
              logger.toolError(toolCall.function.name, `Guardrail tripwire: ${guardrailError.message}`);
              guardrailBlockedToolIds.add(toolCall.id);
              pushToolOutputEvents(toolCall.id, toolCall.function.name, tripwireMessage);
              this.memory.addToolResult(toolCall.id, toolCall.function.name, tripwireMessage);
              const tripwireArgs = input.parsedArgsByToolId.get(toolCall.id);
              recordToolCall(this.runContext, toolCall.function.name, tripwireArgs?.ok ? tripwireArgs.args : {}, false);
            }

            logger.toolError(toolCall.function.name, `Guardrail check failed: ${guardrailError?.message}`);
          }
        }
      } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {
          cliLogger.info('RUNNER', 'Interrupt detected during guardrails check');
          return {
            executableToolCalls,
            parallelToolCalls,
            events,
            shouldBreak: true,
            shouldContinue: false,
            encounteredError: true,
          };
        }
        throw error;
      }

      if (encounteredError) {
        return {
          executableToolCalls,
          parallelToolCalls,
          events,
          shouldBreak: true,
          shouldContinue: false,
          encounteredError: true,
        };
      }

      executableToolCalls = executableToolCalls.filter(tc => !guardrailBlockedToolIds.has(tc.id));
      parallelToolCalls = parallelToolCalls.filter(tc => !guardrailBlockedToolIds.has(tc.id));

      if (parallelToolCalls.length === 0) {
        return {
          executableToolCalls,
          parallelToolCalls,
          events,
          shouldBreak: false,
          shouldContinue: true,
          encounteredError: false,
        };
      }
    }

    return {
      executableToolCalls,
      parallelToolCalls,
      events,
      shouldBreak: false,
      shouldContinue: false,
      encounteredError: false,
    };
  }

  async applyToolResultPolicy(input: ToolResultPolicyInput): Promise<ToolResultPolicyResult> {
    let truncatedResult = input.truncatedResult;
    let toolInput: Record<string, any> = {};

    const originalCall = input.toolCalls.find(tc => tc.id === input.result.id);
    if (originalCall) {
      const parsedArgs = parseToolArguments(originalCall.function.arguments || '{}', originalCall.function.name);
      if (parsedArgs.ok) {
        toolInput = parsedArgs.args;
      }
    }

    if (this.toolOutputGuardrails.length > 0) {
      try {
        const tool = this.tools.find(t => t.name === input.result.name);
        if (tool) {
          const toolContext: ToolContext = {
            tool_name: input.result.name,
            tool_input: toolInput,
            tool_call_id: input.result.id,
          };

          const guardrailResult = await GuardrailsExecutor.runToolOutputGuardrails(
            this.toolOutputGuardrails,
            {
              context: this.runContext,
              tool_context: toolContext,
              agent_name: this.agentName,
              tool,
              output: input.result.output,
            }
          );

          if (!guardrailResult.should_use_output) {
            truncatedResult = guardrailResult.replacement_message ||
              '[Output blocked by guardrail]';
            logger.toolError(input.result.name, 'Output blocked by guardrail');
          }
        }
      } catch (guardrailError: any) {
        if (guardrailError instanceof ToolGuardrailTripwireTriggered) {
          logger.toolError(input.result.name, `Output guardrail tripwire triggered: ${guardrailError.message}`);
        }
      }
    }

    if (!input.result.success && typeof input.result.output === 'string') {
      const outputLower = input.result.output.toLowerCase();
      if (
        outputLower.includes('operation cancelled') ||
        outputLower.includes('command interrupted') ||
        outputLower.includes('request aborted')
      ) {
        cliLogger.info('RUNNER', '检测到工具中断信号，终止执行循环');
        return {
          truncatedResult,
          toolInput,
          shouldBreak: true,
          encounteredError: true,
        };
      }
    }

    return {
      truncatedResult,
      toolInput,
      shouldBreak: false,
      encounteredError: false,
    };
  }

  decideRetry(input: RetryDecisionInput): RetryDecision | null {
    const { classifiedError, streamRetries, maxStreamRetries, providerManagedRetryObserved } = input;
    if (!classifiedError.retryable || streamRetries >= maxStreamRetries || providerManagedRetryObserved) {
      return null;
    }

    const nextStreamRetries = streamRetries + 1;
    const delayMs = getSmartRetryDelay(
      classifiedError.category,
      nextStreamRetries,
      classifiedError.retryAfter
    );

    const isRateLimit = classifiedError.category === ErrorCategory.RETRYABLE_RATE_LIMIT;
    const isStreamTimeout = classifiedError.code === 'STREAM_TIMEOUT';
    const isNetworkError = classifiedError.category === ErrorCategory.RETRYABLE_NETWORK ||
      classifiedError.category === ErrorCategory.RETRYABLE_STREAM;

    return {
      nextStreamRetries,
      delayMs,
      logMessage: `Retrying after ${formatDelay(delayMs)} (attempt ${nextStreamRetries}/${maxStreamRetries}): ${classifiedError.message}`,
      event: {
        type: 'raw_response_event',
        data: {
          type: 'runner.stream_retry',
          error: classifiedError.message,
          errorCode: classifiedError.code,
          attempt: nextStreamRetries,
          maxRetries: maxStreamRetries,
          delayMs,
          isRateLimit,
          isStreamTimeout,
          isNetworkError,
        },
        event_type: 'runner.stream_retry',
      } as RawResponseStreamEvent,
    };
  }
}
