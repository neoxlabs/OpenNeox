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

/* `<open-loops>` 待办账本 (见文件尾 enterWaitingLedger 的说明) */
import {
  clearPendingConfirmations,
  registerPendingConfirmation,
  resolvePendingConfirmation,
} from '../../runtime/pendingConfirmations.js';

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

/* ─── `<open-loops>` 接线 (pilot:H-08) ──────────────────────────────────────────
 * 等待态要同时写两处才一致:
 *   · 这里 (SessionWaitingRegistry)   决定这一轮该不该报 awaiting_approval / awaiting_user;
 *   · pendingConfirmations            决定下一轮提示词里要不要说「还有件事在等你确认」。
 * 分两处手写 enter/exit 总有漏掉一处的时候 (状态回到 running 了提示词还说在等你点),
 * 所以把"两件事一起做"收成下面这三个函数, 宿主只调它们。
 * 放在本文件导出而不是另开一个模块: 宿主本来就只 import 这里, 少一行 import
 * (server/main.ts 在文件大小闸里)。 */

/** 登记一个等待项 (审批 / ask_user)。 */
export function enterWaitingLedger(
  registry: SessionWaitingRegistry,
  sessionId: string,
  kind: WaitingKind,
  requestId: string,
  tool?: { toolName?: string; args?: unknown },
): void {
  registry.enter(sessionId, kind, requestId, tool);
  registerPendingConfirmation(sessionId, { id: requestId, kind, toolName: tool?.toolName });
}

/** 用户回了 / 取消 / 超时 — 两边一起注销。 */
export function exitWaitingLedger(
  registry: SessionWaitingRegistry,
  sessionId: string,
  kind: WaitingKind,
  requestId: string,
): void {
  registry.exit(sessionId, kind, requestId);
  resolvePendingConfirmation(sessionId, requestId);
}

/** 整条会话收尾 — 等待态和待办一起清。 */
export function clearWaitingLedger(registry: SessionWaitingRegistry, sessionId: string): void {
  registry.clearSession(sessionId);
  clearPendingConfirmations(sessionId);
}
