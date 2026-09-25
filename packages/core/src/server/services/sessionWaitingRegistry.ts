/**
 * sessionWaitingRegistry.ts — 会话等待态账本
 *
 * 记录每条 session 当前挂起了哪些"在等人"的事项 (工具审批 / ask_user), 并据此推导
 * 它应处的 RunStatus。纯数据结构 + 纯推导, 不碰 bus / runtime / 时间, 因此可单测 ——
 * main.ts 那个 1700 行闭包里塞不下也测不了这种逻辑。
 *
 * ─── 为什么需要它 ───────────────────────────────────────────────────────────
 * RunStatus 里 `awaiting_approval` / `awaiting_user` 两个枚举定义了大半年却从来没人
 * set 过, 于是"agent 正在干活"和"agent 卡在等你点确认"在状态上完全不可区分。桌面端
 * 还能看见审批卡片, 手机端只有一个"运行中", 用户不知道该等还是该去点。
 *
 * ─── 语义 ───────────────────────────────────────────────────────────────────
 * 等待态是**叠加在 running 之上**的细化, 不是平级的第三种状态:
 * `running = status !== 'idle'` 对它们仍然成立, 所以运行态的所有兜底 (心跳 / 对账 /
 * watchdog 取证) 逻辑一个字都不用改, 只是多了一层可选精度。
 *
 * ─── 为什么按 requestId 去重而不是计数器 ────────────────────────────────────
 * 并行工具调用会同时挂多个审批, ask_user 也可能与审批并存。Set/Map 天然幂等:
 * 重复 exit (取消与回复竞态、超时与回答同时到) 不会把计数减穿 —— 减穿会让一个仍然
 * 挂着的审批被误判成"等完了", 状态提前回到 running, 用户看不出还有东西等着他。
 */

export type WaitingKind = 'approval' | 'user';

/** 与 ServerRunState.pendingToolCalls 同形 — 直接进 run_state_changed 事件给端上渲染。 */
export interface PendingApprovalEntry {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  startedAt: number;
}

export interface WaitingResolution {
  /** null = 该 session 没有任何等待项, 调用方应把状态落回 'running'。 */
  status: 'awaiting_approval' | 'awaiting_user' | null;
  /** 当前挂起的审批 (按进入顺序)。没有审批时是空数组, 调用方应显式写空以清掉上一轮残留。 */
  pendingToolCalls: PendingApprovalEntry[];
}

interface SessionWaiting {
  approval: Map<string, PendingApprovalEntry>;
  user: Set<string>;
}

export class SessionWaitingRegistry {
  private readonly bySession = new Map<string, SessionWaiting>();

  private ensure(sessionId: string): SessionWaiting {
    let w = this.bySession.get(sessionId);
    if (!w) {
      w = { approval: new Map(), user: new Set() };
      this.bySession.set(sessionId, w);
    }
    return w;
  }

  /** 登记一个等待项。同 requestId 重复 enter 覆盖同一条, 不会重复计数。 */
  enter(
    sessionId: string,
    kind: WaitingKind,
    requestId: string,
    tool?: { toolName?: string; args?: unknown },
    now: number = Date.now(),
  ): void {
    if (!sessionId || !requestId) return;
    const w = this.ensure(sessionId);
    if (kind === 'approval') {
      w.approval.set(requestId, {
        toolCallId: requestId,
        toolName: tool?.toolName ?? 'unknown',
        args: tool?.args,
        startedAt: now,
      });
    } else {
      w.user.add(requestId);
    }
  }

  /** 注销一个等待项。不存在时安静返回 —— 重复 exit 必须无害。 */
  exit(sessionId: string, kind: WaitingKind, requestId: string): void {
    if (!sessionId || !requestId) return;
    const w = this.bySession.get(sessionId);
    if (!w) return;
    if (kind === 'approval') w.approval.delete(requestId);
    else w.user.delete(requestId);
    if (w.approval.size === 0 && w.user.size === 0) this.bySession.delete(sessionId);
  }

  /** 按 requestId 反查所属 session — replyAskUser 之类只拿得到全局 requestId。 */
  findSession(kind: WaitingKind, requestId: string): string | null {
    if (!requestId) return null;
    for (const [sessionId, w] of this.bySession) {
      const hit = kind === 'approval' ? w.approval.has(requestId) : w.user.has(requestId);
      if (hit) return sessionId;
    }
    return null;
  }

  /** 整条 session 清账 — 一轮结束时调。异常/abort 可能在还挂着等待项时收尾,
   *  不清就会残留, 下一轮被上一轮的幽灵审批钉在 awaiting_approval。 */
  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** 推导该 session 应处的等待态。
   *  优先级 approval > user: 两者并存时审批更"硬"(它挡着工具执行), 先让用户看到它。 */
  resolve(sessionId: string): WaitingResolution {
    const w = this.bySession.get(sessionId);
    const pendingToolCalls = [...(w?.approval.values() ?? [])];
    if (pendingToolCalls.length > 0) {
      return { status: 'awaiting_approval', pendingToolCalls };
    }
    if (w && w.user.size > 0) {
      return { status: 'awaiting_user', pendingToolCalls: [] };
    }
    return { status: null, pendingToolCalls: [] };
  }
}
