type ToolCallLike = {
  id: string;
  function: {
    name: string;
    arguments?: string;
  };
};

export type BlockedToolCall<T extends ToolCallLike = ToolCallLike> = {
  toolCall: T;
  denialOutput: string;
};

export function filterToolCallsByMode<T extends ToolCallLike>(options: {
  toolCalls: T[];
  allowedToolNames: Set<string>;
  currentMode: string;
}): {
  executableToolCalls: T[];
  blockedToolCalls: BlockedToolCall<T>[];
} {
  const executableToolCalls: T[] = [];
  const blockedToolCalls: BlockedToolCall<T>[] = [];

  for (const toolCall of options.toolCalls) {
    // 稀疏洞 / 缺 function 的脏槽跳过 — densify 后正常不会到这, 防御兜底
    if (!toolCall?.function?.name) continue;
    const rawName = toolCall.function.name;
    const cleanName = normalizeToolName(rawName);
    if (options.allowedToolNames.has(cleanName) || options.allowedToolNames.has(rawName)) {
      executableToolCalls.push(toolCall);
      continue;
    }

    /* 实录: 旧文案 "not allowed in auto mode" 把审批模式名 (auto/ask)
     * 当拦截原因, 误导排障 (真实原因=工具不在本模式白名单/未 fetch)。
     * 这段话会作为 tool result 喂回模型 — 教它怎么恢复, 别让它反复撞墙。
     *
     *  用户实录: 模型调了 `execute_sql` —— 这个工具**全仓从来没注册过**,
     * 是模型按常理捏出来的名字。旧文案只会说"不在工具集里, 去 tool_search",
     * 于是白烧一整轮往返, 而正确答案 (execute_shell 里跑 sqlite3/psql) 就在手边。
     * 现在直接把最接近的真实工具报给它, 当轮就能纠正。 */
    const suggestions = suggestClosestTools(cleanName, options.allowedToolNames);
    const hint = suggestions.length > 0
      ? ` Closest tools you already have: ${suggestions.join(', ')}.`
      : '';
    blockedToolCalls.push({
      toolCall,
      denialOutput:
        `Tool "${rawName}" is not available (it may not exist at all, or is deferred/mode-restricted).${hint}`
        + ` Do NOT retry "${rawName}". Either use one of the tools above, or call tool_search once to unlock the right one,`
        + ` or just answer without tools.`,
    });
  }

  return { executableToolCalls, blockedToolCalls };
}

/**
 * 给"叫不出名字"的工具调用找最接近的真实工具。
 *
 * 只用于**提示**, 绝不自动改派 —— 参数形态完全不同 (一句 SQL 不是一条 shell 命令),
 * 猜着执行比报错更危险。
 *
 * 打分 (无依赖, 够用就行):
 *   · 下划线分词的交集 —— execute_sql / execute_shell 共享 "execute"
 *   · 公共前缀长度 —— "execute_s" 9 个字符, 强信号
 *   · 互相包含 —— git_commit ⊂ git_commits
 */
export function suggestClosestTools(
  name: string,
  allowed: Set<string>,
  limit = 3,
): string[] {
  const lower = name.toLowerCase();
  if (!lower) return [];
  const tokens = new Set(lower.split(/[_\-\s]+/).filter(Boolean));

  const commonPrefixLen = (a: string, b: string): number => {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  };

  const scored: Array<{ name: string; score: number }> = [];
  for (const candidate of allowed) {
    const c = candidate.toLowerCase();
    if (c === lower) continue;
    let score = 0;
    const cTokens = c.split(/[_\-\s]+/).filter(Boolean);
    for (const t of cTokens) if (tokens.has(t)) score += 4;
    const prefix = commonPrefixLen(lower, c);
    if (prefix >= 3) score += prefix;
    if (c.includes(lower) || lower.includes(c)) score += 3;
    if (score > 0) scored.push({ name: candidate, score });
  }
  /* 阈值 4 = 至少共享一个完整词或有像样的公共前缀; 低于它的"建议"只会添乱 */
  return scored
    .filter((s) => s.score >= 4)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, limit)
    .map((s) => s.name);
}

function normalizeToolName(name: string): string {
  // Handle malformed names from interrupted streams, e.g. `ExecStatus" />`
  const trimmed = name.replace(/["\s/>]+$/g, '').trim();

  // Handle call-like leakage in tool name, e.g.:
  // - update_plan({"plan":[...]})
  // - call_tool({"name":"readfile",...})
  const callLikeMatch = trimmed.match(/^([a-zA-Z_][\w-]*)\s*(?:\(|\{)/);
  if (callLikeMatch?.[1]) {
    return callLikeMatch[1];
  }

  return trimmed;
}
