/**
 * 认识哪些工具是「外部 Agent 委派」
 *
 *   渲染层需要在看到一条 tool_call 时判断: 这是普通工具, 还是 Codex / Claude Code
 *   在干活。前者是通用工具卡, 后者要出 Agent 卡。
 *
 *   为什么不靠名字后缀猜
 *   ------------------
 *   `*_delegate` 看着够用, 但那是**约定**不是**事实** —— 第三方插件完全可以有个
 *   叫 `email_delegate` 的普通工具, 那时候用户会看到一张说「Agent 正在运行」的卡,
 *   而实际上什么 agent 都没有。所以以主进程注册表为准, 名字后缀只在注册表还没到位
 *   时兜底 (启动早期第一条消息就用到的极窄窗口)。
 */

const knownToolNames = new Set<string>();
const metaByTool = new Map<string, { agentId: string; displayName: string }>();
let loaded = false;

/** 从主进程拉一次外部 agent 清单。失败不抛 —— 拿不到就退回后缀兜底。 */
export async function loadExternalAgentTools(): Promise<void> {
  const api = (window as any)?.neox;
  if (!api?.pluginExternalAgentList) { loaded = true; return; }
  try {
    const list = await api.pluginExternalAgentList();
    knownToolNames.clear();
    metaByTool.clear();
    for (const a of list ?? []) {
      const tool = `${a.id}_delegate`;
      knownToolNames.add(tool);
      metaByTool.set(tool, { agentId: a.id, displayName: a.displayName || a.id });
    }
  } catch { /* 拿不到就用兜底 */ }
  loaded = true;
}

export function isExternalAgentTool(toolName?: string): boolean {
  if (!toolName) return false;
  if (knownToolNames.has(toolName)) return true;
  /* 兜底: 注册表还没到位时按约定认, 见文件头 */
  return !loaded && /^[a-z][a-z0-9_]*_delegate$/.test(toolName);
}

export function externalAgentMeta(toolName: string): { agentId: string; displayName: string } {
  const hit = metaByTool.get(toolName);
  if (hit) return hit;
  const agentId = toolName.replace(/_delegate$/, '');
  return { agentId, displayName: agentId };
}

/** 测试用 */
export function __setExternalAgentTools(list: Array<{ id: string; displayName?: string }>): void {
  knownToolNames.clear();
  metaByTool.clear();
  for (const a of list) {
    const tool = `${a.id}_delegate`;
    knownToolNames.add(tool);
    metaByTool.set(tool, { agentId: a.id, displayName: a.displayName || a.id });
  }
  loaded = true;
}
