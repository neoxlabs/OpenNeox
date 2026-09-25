/**
 * Hook 协议 —— 事件表 + 决策语义。
 *
 * 从 userHooks.ts 里拆出来 : 那边是"怎么把脚本跑起来", 这边是"约定是什么"。
 * 拆开的直接原因是事件从 2 个涨到 20+, 而**协议部分才是容易出错的地方** ——
 * 一条 deny 该不该压过 bypassPermissions, 是安全问题, 不该埋在执行代码中间。
 *
 * ─── 为什么要对齐 兼容格式 / 兼容格式 的事件名 ──────────────────────────────
 * 用户的 hook 脚本是资产: 他在别处写过的 `PreToolUse` / `UserPromptSubmit` 脚本,
 * 拷进来就该能跑。事件名、载荷字段、退出码语义都采用同一套, 不自己发明。
 */

/* ══════════════════════════════════════════════════════════════════════════
 * 事件
 * ══════════════════════════════════════════════════════════════════════════ */

export const HOOK_EVENTS = [
  /* 工具 */
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',   // 工具抛错/返回失败 —— 跟成功分开, 脚本常只想管失败那一半
  'PostToolBatch',        // 一批并行工具全部收敛之后
  /* 会话 */
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',     // 用户按下发送, 模型还没看到 —— 能改写/追加上下文
  'Stop',                 // 一轮正常收尾
  'StopFailure',          // 一轮以失败收尾
  'Notification',         // 需要用户注意 (等审批 / 长任务完成)
  /* 压缩 */
  'PreCompact',
  'PostCompact',
  /* 子 agent */
  'SubagentStart',
  'SubagentStop',
  /* 权限 */
  'PermissionRequest',    // 要弹审批卡之前 —— hook 可以代替用户决定
  'PermissionDenied',     // 用户/策略拒了之后
  /* worktree */
  'WorktreeCreate',
  'WorktreeRemove',
  /* 交互 */
  'Elicitation',          // 向用户提问之前
  'ElicitationResult',    // 用户答完
  /* 配置 */
  'ConfigChange',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(v: unknown): v is HookEvent {
  return typeof v === 'string' && (HOOK_EVENTS as readonly string[]).includes(v);
}

/** 这些事件的返回值能拦住后续动作; 其余是通知式的, 脚本说什么都不改变流程。 */
const BLOCKING_EVENTS = new Set<HookEvent>([
  'PreToolUse', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'PreCompact', 'SubagentStart',
]);

export function isBlockingEvent(e: HookEvent): boolean {
  return BLOCKING_EVENTS.has(e);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 决策
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * `permissionDecision` —— hook 对"要不要放行"的表态。
 *
 * · allow 放行, 并且**不再弹审批卡** (hook 代替用户点了同意)
 * · deny   拒绝
 * · ask    照常走审批 (等于没表态)
 * · defer 交给外部 UI 去决定 —— 企业环境里由自家审批系统代批。
 *          我们这边的表现是"当作 ask", 但会把 defer 传下去, 让接管方知道有人要接。
 */
export type PermissionDecision = 'allow' | 'deny' | 'ask' | 'defer';

export interface HookOutcome {
  /** 放不放行。通知式事件恒为 true。 */
  allow: boolean;
  /** 不放行时给模型/用户看的话 */
  reason?: string;
  decision?: PermissionDecision;
  /**
   * 改写工具入参 (PreToolUse) —— 比如把危险路径换成安全路径、给命令补上 --dry-run。
   * 只在**放行**时有意义: 拦下来了就没有"改完再跑"这回事。
   */
  updatedInput?: Record<string, unknown>;
  /** 改写工具输出 (PostToolUse) —— 比如把日志里的密钥抹掉再进上下文 */
  updatedToolOutput?: string;
  /** 追加给模型的上下文 (UserPromptSubmit / SessionStart 最常用) */
  additionalContext?: string;
  /** 这条决定是哪个 hook 给的 (审计/排查用) */
  source?: string;
}

export const ALLOW: HookOutcome = { allow: true };

/**
 * 把一个 hook 脚本的退出码 + stdout 解析成决策。
 *
 * 退出码语义 (跟 Claude Code 一致, 别自己发明):
 *   0 放行。stdout 若是 JSON 则按下面的字段解释
 *   2  **拦下**, stderr (没有就 stdout) 当理由
 *   其它 非零 = 脚本自己坏了, **不当成拦截** —— 一个写错的 hook 不该把用户的工具卡死。
 *      这一条是刻意的: fail-open。安全边界不靠 hook 撑 (那是审批档位和沙箱的事),
 *      hook 是用户的自动化, 它坏了应该吵一声然后放行。
 *
 * stdout JSON 认这些字段:
 *   { "decision": "block", "reason": "…" }                  ← 老写法, 继续认
 *   { "permissionDecision": "allow|deny|ask|defer", … }
 *   { "updatedInput": {...}, "updatedToolOutput": "...", "additionalContext": "..." }
 */
export function parseHookOutcome(
  exitCode: number,
  stdout: string,
  stderr: string,
  opts?: { source?: string },
): HookOutcome {
  const source = opts?.source;
  if (exitCode === 2) {
    return {
      allow: false,
      decision: 'deny',
      reason: stderr.trim() || stdout.trim() || 'blocked by user hook (exit 2)',
      source,
    };
  }

  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return { allow: true, source };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { allow: true, source };   /* 输出不是 JSON —— 当普通日志, 别猜 */
  }

  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;

  const out: HookOutcome = { allow: true, source };
  const pd = str(parsed.permissionDecision);
  if (pd === 'allow' || pd === 'deny' || pd === 'ask' || pd === 'defer') out.decision = pd;
  /* 老写法 decision:"block" 等价于 permissionDecision:"deny" */
  if (str(parsed.decision) === 'block') out.decision = 'deny';

  if (out.decision === 'deny') {
    out.allow = false;
    out.reason = str(parsed.reason) ?? str(parsed.permissionDecisionReason) ?? 'blocked by user hook';
  } else {
    out.reason = str(parsed.reason) ?? str(parsed.permissionDecisionReason);
  }

  if (parsed.updatedInput && typeof parsed.updatedInput === 'object' && !Array.isArray(parsed.updatedInput)) {
    out.updatedInput = parsed.updatedInput as Record<string, unknown>;
  }
  const uo = str(parsed.updatedToolOutput);
  if (uo !== undefined) out.updatedToolOutput = uo;
  const ac = str(parsed.additionalContext);
  if (ac !== undefined) out.additionalContext = ac;

  return out;
}

/**
 * 多个 hook 的结果合成一个。**这个函数就是"谁压过谁"的全部真相**, 别在别处再判一次。
 *
 * 规则 (按优先级):
 *   ① 任何一个 deny → 整体 deny。**deny 不可被后面的 allow 翻案** ——
 *      企业把某个工具钉死之后, 用户自己的 hook 不该能松开它。
 *   ② allow 之间取第一个 (它决定"跳过审批卡"这件事)
 *   ③ updatedInput / updatedToolOutput 后写的赢 (链式改写: 前一个改完后一个接着改)
 *   ④ additionalContext 全部拼起来, 谁都别丢
 */
export function mergeHookOutcomes(list: readonly HookOutcome[]): HookOutcome {
  const merged: HookOutcome = { allow: true };
  const contexts: string[] = [];

  for (const o of list) {
    if (o.additionalContext) contexts.push(o.additionalContext);
    if (o.updatedInput) merged.updatedInput = { ...(merged.updatedInput ?? {}), ...o.updatedInput };
    if (o.updatedToolOutput !== undefined) merged.updatedToolOutput = o.updatedToolOutput;

    if (!o.allow || o.decision === 'deny') {
      /* 首个 deny 保留其理由，确保合并结果稳定且原因对应最早的拒绝来源。 */
      if (merged.allow) {
        merged.allow = false;
        merged.decision = 'deny';
        merged.reason = o.reason;
        merged.source = o.source;
      }
      continue;
    }
    if (merged.allow && !merged.decision && o.decision) {
      merged.decision = o.decision;
      if (o.reason) merged.reason = o.reason;
      merged.source = o.source ?? merged.source;
    }
  }

  if (contexts.length) merged.additionalContext = contexts.join('\n');
  return merged;
}

/**
 * hook 的 allow 能不能跳过审批卡。
 *
 * 能, 但**永远压不过 deny**: 如果同一轮里有任何一个 hook 说了 deny, 这里返回 false。
 * mergeHookOutcomes 已经保证了这一点, 这个函数只是把语义写成一句能读懂的话。
 */
export function skipsApproval(outcome: HookOutcome): boolean {
  return outcome.allow && outcome.decision === 'allow';
}

/* ══════════════════════════════════════════════════════════════════════════
 * matcher
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * matcher 匹配工具名。
 *
 *  **带连字符的 MCP 工具名必须能精确匹配** —— 这是清单上单独点名的一条。
 * MCP 工具名长这样: `mcp__my-server__do-thing`。用户写 matcher 时最自然的写法就是
 * 把这个名字原样贴进去, 而它在正则里是合法的 (连字符在字符类外不特殊), 所以老实现
 * "当正则用"其实能匹配上。真正会出事的是名字里带 `.` `+` `(` 这类的:
 * `mcp__srv__get.file` 当正则时 `.` 匹配任意字符, 于是 `get_file` / `getXfile` 也被匹上,
 * 一条本该管一个工具的 hook 悄悄管了三个。
 *
 * 所以判定顺序改成: **先按字面量精确比一次**, 完全相等就命中 (最常见的用法, 零歧义);
 * 不相等再当正则。这样"贴全名"永远是精确的, 而写 `Edit|Write` 这种正则照旧能用。
 */
/** 真正的正则结构。`.` 和 `-` 刻意**不算** —— 它们在工具名里太常见 (见下) */
const REGEX_STRUCTURE = /[|^$*+?()[\]{}\\]/;

export function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || !matcher.trim()) return true;   /* 空 = 匹配所有 */
  const m = matcher.trim();
  if (m === toolName) return true;                /* 贴全名 —— 最常见的写法, 零歧义 */

  /* 没有任何正则结构 = 用户写的是一个**名字**, 就按名字比, 不当正则。
   * 这一条专治 `mcp__srv__get.file` 这种: 当正则时 `.` 是任意字符, 会把
   * get_file / getXfile 一起匹上, 一条本该管一个工具的 hook 悄悄管了三个。 */
  if (!REGEX_STRUCTURE.test(m)) return false;

  try {
    /* 有正则结构时按**搜索**语义 (不强行包 ^…$): `^git_` 要能匹 git_commit,
     * `Edit|Write` 要能匹 Edit。想要精确就自己写 `^Edit$` —— 跟别家一致。 */
    return new RegExp(m, 'i').test(toolName);
  } catch {
    return false;                                  /* 非法正则: 上面的字面量比已经试过了 */
  }
}
