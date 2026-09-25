/**
 * Lifecycle Hooks 执行器
 * Lifecycle Hooks Executor
 */

import type {
  AgentHooks,
  RunContext,
  AgentResult,
  Message,
  ChatCompletionResponse,
  ToolCallDecision,
  ToolValidationResult,
  IterationDecision,
  ErrorRecovery,
} from '@neoxlabs/kernel/types/index.js';
// Note: Using console for hook logs since logger doesn't have debug/info/warn methods
const DEBUG = process.env.CLI_DEBUG_CONSOLE === '1';

/**
 * Hook 执行器 - 统一处理所有 Hook 调用
 * Provides safe execution of lifecycle hooks with error handling
 */
export class HooksExecutor {
  constructor(private hooks: AgentHooks) {}

  // ========= 运行生命周期 =========

  /**
   * 执行 beforeRun hook
   */
  async executeBeforeRun(context: RunContext): Promise<void> {
    if (!this.hooks.beforeRun) return;

    try {
      await this.hooks.beforeRun(context);
      if (DEBUG) console.log('[Hooks] beforeRun executed successfully');
    } catch (error: any) {
      console.error('[Hooks] beforeRun failed:', error.message);
      throw new Error(`beforeRun hook failed: ${error.message}`);
    }
  }

  /**
   * 执行 afterRun hook
   */
  async executeAfterRun(context: RunContext, result: AgentResult): Promise<void> {
    if (!this.hooks.afterRun) return;

    try {
      await this.hooks.afterRun(context, result);
      if (DEBUG) console.log('[Hooks] afterRun executed successfully');
    } catch (error: any) {
      console.error('[Hooks] afterRun failed:', error.message);
      // afterRun 失败不应该影响主流程，只记录日志
    }
  }

  /**
   * 执行 onError hook
   */
  async executeOnError(error: Error, context: RunContext): Promise<ErrorRecovery | undefined> {
    if (!this.hooks.onError) return undefined;

    try {
      const recovery = await this.hooks.onError(error, context);
      if (recovery) {
        if (DEBUG) console.log('[Hooks] onError returned recovery strategy:', recovery.strategy);
      }
      return recovery || undefined;
    } catch (hookError: any) {
      console.error('[Hooks] onError hook failed:', hookError.message);
      // onError hook 失败不应该掩盖原始错误
      return undefined;
    }
  }

  // ========= LLM 调用 =========

  /**
   * 执行 beforeLLMCall hook
   */
  async executeBeforeLLMCall(messages: Message[]): Promise<Message[]> {
    if (!this.hooks.beforeLLMCall) return messages;

    try {
      const modifiedMessages = await this.hooks.beforeLLMCall(messages);
      if (DEBUG) console.log(
        `[Hooks] beforeLLMCall executed, messages: ${messages.length} -> ${modifiedMessages.length}`
      );
      return modifiedMessages;
    } catch (error: any) {
      console.error('[Hooks] beforeLLMCall failed:', error.message);
      // 失败时返回原始消息
      return messages;
    }
  }

  /**
   * 执行 afterLLMCall hook
   */
  async executeAfterLLMCall(response: ChatCompletionResponse): Promise<ChatCompletionResponse> {
    if (!this.hooks.afterLLMCall) return response;

    try {
      const modifiedResponse = await this.hooks.afterLLMCall(response);
      if (DEBUG) console.log('[Hooks] afterLLMCall executed successfully');
      return modifiedResponse;
    } catch (error: any) {
      console.error('[Hooks] afterLLMCall failed:', error.message);
      // 失败时返回原始响应
      return response;
    }
  }

  // ========= 工具调用 =========

  /**
   * 执行 beforeToolCall hook
   * @returns ToolCallDecision，如果 hook 不存在则返回默认的允许决策
   */
  async executeBeforeToolCall(toolName: string, args: any): Promise<ToolCallDecision> {
    if (!this.hooks.beforeToolCall) {
      return { allow: true };
    }

    try {
      const decision = await this.hooks.beforeToolCall(toolName, args);
      if (DEBUG) console.log(
        `[Hooks] beforeToolCall(${toolName}) decision: ${decision.allow ? 'allow' : 'deny'}`
      );
      return decision;
    } catch (error: any) {
      console.error(`[Hooks] beforeToolCall(${toolName}) failed:`, error.message);
      // 失败时默认允许执行
      return { allow: true };
    }
  }

  /**
   * 执行 afterToolCall hook（核心验证点）— 成功路径
   * @returns ToolValidationResult，如果 hook 不存在则返回默认的通过验证
   */
  async executeAfterToolCall(
    toolName: string,
    result: string,
    success: boolean
  ): Promise<ToolValidationResult> {
    if (!this.hooks.afterToolCall) {
      return { valid: true };
    }

    try {
      const validation = await this.hooks.afterToolCall(toolName, result, success);
      if (DEBUG) console.log(
        `[Hooks] afterToolCall(${toolName}) validation: ${validation.valid ? 'passed' : 'failed'}`
      );

      if (!validation.valid) {
        console.warn(
          `[Hooks] Tool validation failed for ${toolName}: ${validation.reason || 'Unknown reason'}`
        );
      }

      return validation;
    } catch (error: any) {
      console.error(`[Hooks] afterToolCall(${toolName}) failed:`, error.message);
      // Hook 执行失败时默认认为验证通过
      return { valid: true };
    }
  }

  async executeAfterToolCallFailure(
    toolName: string,
    error: string,
    isInterrupt: boolean = false,
  ): Promise<ToolValidationResult> {
    // 优先使用专用 failure hook，回退到通用 afterToolCall
    const hook = this.hooks.afterToolCallFailure ?? this.hooks.afterToolCall;
    if (!hook) {
      return { valid: true };
    }

    try {
      const validation = await hook(toolName, error, false);
      if (DEBUG) console.log(
        `[Hooks] afterToolCallFailure(${toolName}) validation: ${validation.valid ? 'passed' : 'failed'}, isInterrupt=${isInterrupt}`
      );
      return validation;
    } catch (hookError: any) {
      console.error(`[Hooks] afterToolCallFailure(${toolName}) failed:`, hookError.message);
      // 失败 hook 本身的异常不应掩盖原始工具错误
      return { valid: true };
    }
  }

  // ========= 迭代控制 =========

  /**
   * 执行 beforeIteration hook
   */
  async executeBeforeIteration(iteration: number): Promise<void> {
    if (!this.hooks.beforeIteration) return;

    try {
      await this.hooks.beforeIteration(iteration);
      if (DEBUG) console.log(`[Hooks] beforeIteration(${iteration}) executed successfully`);
    } catch (error: any) {
      console.error(`[Hooks] beforeIteration(${iteration}) failed:`, error.message);
      // 失败不应该影响迭代
    }
  }

  /**
   * 执行 afterIteration hook
   * @returns IterationDecision 或 undefined
   */
  async executeAfterIteration(
    iteration: number,
    hasToolCalls: boolean
  ): Promise<IterationDecision | undefined> {
    if (!this.hooks.afterIteration) return undefined;

    try {
      const decision = await this.hooks.afterIteration(iteration, hasToolCalls);
      if (decision) {
        if (DEBUG) console.log(
          `[Hooks] afterIteration(${iteration}) decision: ${decision.shouldContinue ? 'continue' : 'stop'}`
        );
      }
      return decision || undefined;
    } catch (error: any) {
      console.error(`[Hooks] afterIteration(${iteration}) failed:`, error.message);
      return undefined;
    }
  }

  // ========= 辅助方法 =========

  /**
   * 检查是否有任何 hook 被定义
   */
  hasAnyHooks(): boolean {
    return !!(
      this.hooks.beforeRun ||
      this.hooks.afterRun ||
      this.hooks.onError ||
      this.hooks.beforeLLMCall ||
      this.hooks.afterLLMCall ||
      this.hooks.beforeToolCall ||
      this.hooks.afterToolCall ||
      this.hooks.afterToolCallFailure ||
      this.hooks.beforeIteration ||
      this.hooks.afterIteration
    );
  }

  /**
   * 获取已定义的 hook 列表
   */
  getDefinedHooks(): string[] {
    const defined: string[] = [];
    if (this.hooks.beforeRun) defined.push('beforeRun');
    if (this.hooks.afterRun) defined.push('afterRun');
    if (this.hooks.onError) defined.push('onError');
    if (this.hooks.beforeLLMCall) defined.push('beforeLLMCall');
    if (this.hooks.afterLLMCall) defined.push('afterLLMCall');
    if (this.hooks.beforeToolCall) defined.push('beforeToolCall');
    if (this.hooks.afterToolCall) defined.push('afterToolCall');
    if (this.hooks.afterToolCallFailure) defined.push('afterToolCallFailure');
    if (this.hooks.beforeIteration) defined.push('beforeIteration');
    if (this.hooks.afterIteration) defined.push('afterIteration');
    return defined;
  }
}

/**
 * 创建空的 Hooks 执行器（当没有 hooks 时使用）
 */
export function createEmptyHooksExecutor(): HooksExecutor {
  return new HooksExecutor({});
}
