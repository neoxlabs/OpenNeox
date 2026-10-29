
import type { ToolInputGuardrail, ToolInputGuardrailData } from '@neoxlabs/kernel/types/guardrails.js';
import { allowToolGuardrail, rejectToolGuardrail } from '@neoxlabs/kernel/types/guardrails.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getTeamPlan } from './teamPlanStore.js';
import { checkTerritory, lookupExecAgent } from './teamExecStore.js';

/** 会落地写入的工具 —— 只拦这些, 读类工具一律放行 (看别人的代码是应该的) */
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'edit', 'multi_edit', 'append_file', 'delete_file', 'move_file', 'rename_file',
]);

/** 从工具入参里取目标路径 —— 各工具字段名不统一 */
function targetPath(input: Record<string, any>): string | null {
  const p = input?.file_path ?? input?.path ?? input?.filePath ?? input?.target ?? input?.to;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
}

/**
 * 谁在跑这条工具调用 —— agentId 形如 `M2#TEN-3` (teamExecutor 派兵时定的),
 * 取前半段就是 roster id。拿不到成员身份就放行 (主 agent 自己不受领地限制)。
 */
function ownerOf(data: ToolInputGuardrailData): { sessionId: string; memberId: string } | null {
  /* agent_name 就是派兵时给的 agentId (`M2#TEN-3`) —— teamExecutor 登记过它属于哪个团队会话。
   * 登记表查不到 = 不是团队执行期的 agent, 一律放行 (主 agent 自己不受领地限制)。 */
  const direct = lookupExecAgent(String(data.agent_name ?? ''));
  if (direct) return direct;
  const sid = (data.context as any)?.sessionId;
  return sid ? lookupExecAgent(String(sid)) : null;
}

export const teamTerritoryGuardrail: ToolInputGuardrail = {
  name: 'team_territory',
  guardrail_function: async (data: ToolInputGuardrailData) => {
    const { tool_name, tool_input } = data.tool_context;
    if (!WRITE_TOOLS.has(tool_name)) return allowToolGuardrail();

    const owner = ownerOf(data);
    if (!owner) return allowToolGuardrail();
    const { memberId } = owner;
    const plan = getTeamPlan(owner.sessionId);
    if (!plan || plan.claims.length === 0) return allowToolGuardrail();

    const path = targetPath(tool_input as Record<string, any>);
    if (!path) return allowToolGuardrail();

    const verdict = checkTerritory(plan, memberId, path);
    if (verdict.allowed) return allowToolGuardrail();

    cliLogger.warn('TEAM_EXEC', `${memberId} 越界写 ${path} (领地: ${verdict.scopes.join(', ') || '未声明'})`);
    return rejectToolGuardrail(
      `🚧 越界: \`${path}\` 不在你的领地里。\n`
      + `你的领地: ${verdict.scopes.length ? verdict.scopes.join('、') : '(未声明)'}\n`
      + (verdict.owner
        ? `这块地是 **${verdict.owner}** 的 —— 用 send_message 找他: 说清你需要什么接口/字段、为什么需要, 让他改。\n`
        : '这块地没人认领 —— 如果确实该有人做, 在收尾时报给主脑, 别自己扩张。\n')
      + '不要绕道改别人的文件: 两个人同时改一处, 后写的会覆盖前一个, 而且没人知道。',
    );
  },
};
