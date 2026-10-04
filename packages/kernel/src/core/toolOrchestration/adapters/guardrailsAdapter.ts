/**
 * InputGuardrailRunner adapter — 把一组 ToolInputGuardrail 包装成
 * orchestrate 的 InputGuardrailRunner 接口。
 *
 * 顺序遍历所有 guardrail, 任一返回 reject_content / raise_exception 就短路:
 *   - reject_content → allow=false, reason=message
 *   - raise_exception → allow=false, reason=message(同样当作拒绝, 不再让异常
 *     冒泡 —— orchestrate gate 的 fail-closed 原则)
 *   - allow → 继续下一个
 */

import type {
  ToolInputGuardrail,
  ToolInputGuardrailData,
  ToolContext,
} from '../../../types/guardrails.js';
import type { Tool, RunContext } from '../../../types/index.js';
import type { InputGuardrailRunner } from '../types.js';

export interface CreateGuardrailsAdapterOptions {
  guardrails: readonly ToolInputGuardrail[];
  /** 取当前 tool 定义, guardrail data 里要带 */
  getTool: (toolName: string) => Tool | undefined;
  /** agent 名, 用于 guardrail data */
  agentName?: string;
  /** run 上下文工厂(guardrail data 里的 context 字段, 某些 guardrail 会用) */
  buildRunContext?: () => RunContext;
  /** 可选的 tool_call_id 注入(运行期 orchestrate 还不知道, 暂不传) */
}

export function createGuardrailsAdapter(
  opts: CreateGuardrailsAdapterOptions,
): InputGuardrailRunner {
  const { guardrails, getTool, agentName = 'main', buildRunContext } = opts;

  return {
    async run(toolName, args) {
      if (!guardrails.length) return { allow: true };

      const tool = getTool(toolName);
      // 如果 tool 解析不出来, 让 validate 阶段先拦(这里放行)
      if (!tool) return { allow: true };

      const toolContext: ToolContext = {
        tool_name: toolName,
        tool_input: args,
      };
      const runContext: RunContext = (buildRunContext?.() ?? {
        agent_name: agentName,
        turn_count: 0,
        total_tokens: 0,
      }) as RunContext;

      const data: ToolInputGuardrailData = {
        context: runContext,
        tool_context: toolContext,
        agent_name: agentName,
        tool,
      };

      for (const g of guardrails) {
        try {
          const result = await g.guardrail_function(data);
          const behavior = result.behavior;
          if (behavior.type === 'allow') continue;
          if (behavior.type === 'reject_content') {
            return {
              allow: false,
              reason: behavior.message,
              guardrailName: g.name,
            };
          }
          if (behavior.type === 'raise_exception') {
            // 不让异常冒泡到 LLM 层外部, 按拒绝处理(orchestrate 的 terminateLoop
            // 由 gate 层的 risk critical 控制 —— guardrail 不单独终止 loop)。
            const msg =
              typeof (result.output_info as any)?.description === 'string'
                ? (result.output_info as any).description
                : `guardrail "${g.name}" raised exception`;
            return { allow: false, reason: msg, guardrailName: g.name };
          }
        } catch (err: any) {
          // Fail-closed: guardrail 自身异常视为拒绝
          return {
            allow: false,
            reason: `guardrail "${g.name}" threw: ${err?.message ?? String(err)}`,
            guardrailName: g.name,
          };
        }
      }

      return { allow: true };
    },
  };
}
