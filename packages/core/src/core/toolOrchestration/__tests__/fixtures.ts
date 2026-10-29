/**
 * 共享测试 fixtures —— 构造最小可用的 ToolUseContext / ToolCall / Tool。
 * 各 stage 测试 import 这里, 避免每个文件重复造轮子。
 */

import type { Tool, ToolCall } from '@neoxlabs/kernel/types/index.js';
import type {
  PermissionChecker,
  RiskEvaluator,
  InputGuardrailRunner,
  LoopDetectorGate,
  PreToolHook,
  PostToolSuccessHook,
  PostToolFailureHook,
  TelemetrySink,
  ToolUseContext,
} from '@neoxlabs/kernel/core/toolOrchestration/types.js';

// ─── Tool / ToolCall 构造 ──────────────────────────────────────────────
export function makeTool(
  name: string,
  overrides: Partial<Tool> = {},
): Tool {
  return {
    name,
    description: `mock tool ${name}`,
    function: async () => `${name}:ok`,
    ...overrides,
  } as Tool;
}

export function makeToolCall(
  name: string,
  args: unknown = {},
  id = `call-${name}`,
): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  } as ToolCall;
}

// ─── invokeTool 默认实现 ────────────────────────────────────────────────
export async function defaultInvoke(
  tool: Tool,
  args: Record<string, unknown>,
): Promise<{ output: string; success: boolean }> {
  const fn = (tool as any).function;
  if (typeof fn !== 'function') {
    return { output: `${tool.name}: no function`, success: false };
  }
  const out = await fn(args);
  return { output: typeof out === 'string' ? out : JSON.stringify(out), success: true };
}

// ─── 最小 ToolUseContext ───────────────────────────────────────────────
export interface MakeCtxOptions {
  tools?: Tool[];
  aliases?: Record<string, string>;
  signal?: AbortSignal;
  iteration?: number;
  shouldAutoApprove?: boolean;

  permission?: PermissionChecker;
  risk?: RiskEvaluator;
  inputGuardrails?: InputGuardrailRunner;
  loopDetector?: LoopDetectorGate;

  preHooks?: PreToolHook[];
  postSuccessHooks?: PostToolSuccessHook[];
  postFailureHooks?: PostToolFailureHook[];

  telemetry?: TelemetrySink;

  invokeTool?: ToolUseContext['invokeTool'];
}

export function makeCtx(opts: MakeCtxOptions = {}): ToolUseContext {
  const tools = opts.tools ?? [makeTool('readfile'), makeTool('execute_shell')];
  const aliases = opts.aliases ?? {};
  return {
    tools,
    resolveAlias: (name: string) => aliases[name] ?? null,
    signal: opts.signal ?? new AbortController().signal,
    iteration: opts.iteration ?? 1,
    workspacePath: '/workspace',
    shouldAutoApprove: opts.shouldAutoApprove ?? false,

    permission: opts.permission,
    risk: opts.risk,
    inputGuardrails: opts.inputGuardrails,
    loopDetector: opts.loopDetector,

    preHooks: opts.preHooks ?? [],
    postSuccessHooks: opts.postSuccessHooks ?? [],
    postFailureHooks: opts.postFailureHooks ?? [],

    invokeTool: opts.invokeTool ?? defaultInvoke,

    telemetry: opts.telemetry,
  };
}

// ─── Hook / 决策器工厂 ─────────────────────────────────────────────────
export function allowHook(name = 'allow-hook'): PreToolHook {
  return {
    name,
    async run() {
      return { allow: true };
    },
  };
}
export function denyHook(name = 'deny-hook', reason = 'denied by policy'): PreToolHook {
  return {
    name,
    async run() {
      return { allow: false, reason };
    },
  };
}
export function throwingHook(name = 'bad-hook'): PreToolHook {
  return {
    name,
    async run() {
      throw new Error('hook crashed');
    },
  };
}

export function allowPermission(): PermissionChecker {
  return { async check() { return { allowed: true }; } };
}
export function denyPermission(reason = 'user declined'): PermissionChecker {
  return { async check() { return { allowed: false, reason }; } };
}

export function riskLow(): RiskEvaluator {
  return { evaluate: () => ({ level: 'low' }) };
}
export function riskCritical(summary = 'sudo rm -rf /'): RiskEvaluator {
  return { evaluate: () => ({ level: 'critical', summary }) };
}
export function riskHigh(summary = 'dangerous command'): RiskEvaluator {
  return { evaluate: () => ({ level: 'high', summary }) };
}

export function allowGuardrails(): InputGuardrailRunner {
  return { async run() { return { allow: true }; } };
}
export function denyGuardrails(
  reason = 'matches dangerous pattern',
  guardrailName = 'dangerous_command',
): InputGuardrailRunner {
  return { async run() { return { allow: false, reason, guardrailName }; } };
}

export function loopNone(): LoopDetectorGate {
  return {
    check: () => ({ level: 'none' }),
    record: () => {},
  };
}
export function loopHard(message = 'loop hard block'): LoopDetectorGate {
  return {
    check: () => ({ level: 'hard', message }),
    record: () => {},
  };
}

// ─── Recording telemetry sink ─────────────────────────────────────────
export function recordingSink(): TelemetrySink & { events: Array<[string, any]> } {
  const events: Array<[string, any]> = [];
  return {
    events,
    onStageEnter(stage, toolName, toolCallId) {
      events.push([`enter:${stage}`, { toolName, toolCallId }]);
    },
    onStageExit(stage, toolName, toolCallId, ms, blockedBy) {
      events.push([`exit:${stage}`, { toolName, toolCallId, blockedBy }]);
    },
    onToolComplete(outcome) {
      events.push([`complete`, outcome]);
    },
  };
}
