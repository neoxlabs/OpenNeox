
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/** 停滞分级 */
export type StallLevel = 'warn' | 'recover' | 'abort';

export interface TurnStallEvent {
  sessionId: string;
  level: StallLevel;
  /** 本轮静默了多久 */
  silentMs: number;
  /** 最后一个进展信号是什么 (用于文案和诊断) */
  lastSignal: string;
  /** 这一轮已经触发过几次 recover */
  recoverAttempt: number;
}

/** 宿主注入的动作实现 — core 不直接持有"给 agent 喂消息"的能力 */
export interface TurnStallHandlers {
  hasLiveWork?: (sessionId: string) => boolean | Promise<boolean>;
  /** T1: 告诉 UI "这一轮停住了", 不打断执行 */
  onWarn?: (e: TurnStallEvent) => void;
  /**
   * T2: 把恢复信息喂给 agent 并确保它继续跑。
   * 返回 true 表示确实叫醒了 (计时重新开始), false 表示没能叫醒 (直接升级到 abort)。
   */
  onRecover?: (e: TurnStallEvent, message: string) => Promise<boolean> | boolean;
  /** T3: 终止这一轮, 并把原因交代给用户 */
  onAbort?: (e: TurnStallEvent, reason: string) => Promise<void> | void;
}

let handlers: TurnStallHandlers = {};

/** 宿主 (server/main.ts) 启动时注入真正的动作实现 */
export function setTurnStallHandlers(h: TurnStallHandlers): void {
  handlers = h ?? {};
}

function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/* 阈值全部可调; 设 0 关闭对应级别 (NEOX_TURN_STALL_WARN_MS=0 就不再发 UI 提示)。 */
const WARN_MS = () => envMs('NEOX_TURN_STALL_WARN_MS', 90_000);
const RECOVER_MS = () => envMs('NEOX_TURN_STALL_RECOVER_MS', 240_000);
const ABORT_MS = () => envMs('NEOX_TURN_STALL_ABORT_MS', 600_000);
/** 最多自救几次 — 超过就直接放弃, 避免"叫醒→又停→再叫醒"无限循环烧 token */
const MAX_RECOVER = () => Math.max(0, envMs('NEOX_TURN_STALL_MAX_RECOVER', 2));
/** 检查频率 — 不需要精确, 15s 一次足够, 也不会给空闲进程添负担 */
const TICK_MS = 15_000;

interface Watch {
  sessionId: string;
  armedAt: number;
  lastProgressAt: number;
  lastSignal: string;
  firedWarn: boolean;
  recoverAttempt: number;
  /** recover 正在进行中 — 避免 tick 重入 */
  recovering: boolean;
  timer: ReturnType<typeof setInterval>;
}

const watches = new Map<string, Watch>();

/**
 * 这一轮开始 — 挂上看门狗。
 * 重复 arm 同一个 session 视为"新一轮", 重置全部计数。
 */
export function armTurnStallGuard(sessionId: string): void {
  if (!sessionId) return;
  disarmTurnStallGuard(sessionId);

  const now = Date.now();
  const timer = setInterval(() => { void tick(sessionId); }, TICK_MS);
  /* unref: 看门狗绝不能成为进程退不出去的理由 */
  (timer as { unref?: () => void }).unref?.();

  watches.set(sessionId, {
    sessionId,
    armedAt: now,
    lastProgressAt: now,
    lastSignal: 'turn started',
    firedWarn: false,
    recoverAttempt: 0,
    recovering: false,
    timer,
  });
}

/** 这一轮结束 (正常收尾 / abort / 出错) — 一定要拆, 幂等 */
export function disarmTurnStallGuard(sessionId: string): void {
  const w = watches.get(sessionId);
  if (!w) return;
  clearInterval(w.timer);
  watches.delete(sessionId);
}

/**
 * 记一次进展 —— 任何来自这一轮的活动都算, 包括:
 * 文本 token / thinking / 工具开始 / 工具返回 / 状态事件 / 后台任务通知送达。
 * 只要还在动, 看门狗就永远不该开火。
 */
export function noteTurnProgress(sessionId: string, signal: string): void {
  const w = watches.get(sessionId);
  if (!w) return;
  w.lastProgressAt = Date.now();
  w.lastSignal = signal;
  /* 动起来了就把 warn 重新武装 — 下次再停住还要再提示一次 */
  w.firedWarn = false;
}

/** 当前是否有 turn 被监视 (诊断/测试用) */
export function isTurnGuarded(sessionId: string): boolean {
  return watches.has(sessionId);
}

/** 诊断快照 — 排查时能一眼看到每个 session 静默了多久 */
export function getTurnStallSnapshot(): Array<{
  sessionId: string; silentMs: number; lastSignal: string; recoverAttempt: number;
}> {
  const now = Date.now();
  return [...watches.values()].map((w) => ({
    sessionId: w.sessionId,
    silentMs: now - w.lastProgressAt,
    lastSignal: w.lastSignal,
    recoverAttempt: w.recoverAttempt,
  }));
}

/** 喂给 agent 的恢复信息 — 要让它能自己判断下一步, 而不是单纯"再试一次" */
export function buildStallRecoveryMessage(e: TurnStallEvent): string {
  const mins = Math.round(e.silentMs / 60_000);
  return [
    '<system-stall-recovery>',
    `距离上一次进展 (${e.lastSignal}) 已经过去约 ${mins} 分钟, 期间没有任何输出、没有工具返回。`,
    '这通常意味着你在等的东西不会来了 —— 工具结果丢失、后台任务的结束通知没送达,',
    '或者某个远程调用无声挂起。',
    '',
    '请不要继续等待。现在做一次状态复核:',
    '· 如果你在等某条命令或后台任务, 用 bash_output({pid}) 主动查它的输出, 不要 sleep 轮询;',
    '· 如果那个 pid 已经不存在, 就当它失败处理, 换一个更快、更可验证的方式重做这一步;',
    '· 如果访问的是远程服务 (数据库 / API), 显式加上连接超时, 避免再次无限等待;',
    '· 如果这一步不是必需的, 直接说明情况并推进后面的工作。',
    '',
    '把你的判断和下一步动作说清楚再执行。',
    '</system-stall-recovery>',
  ].join('\n');
}

async function tick(sessionId: string): Promise<void> {
  const w = watches.get(sessionId);
  if (!w || w.recovering) return;

  const silentMs = Date.now() - w.lastProgressAt;
  const warnMs = WARN_MS();
  const recoverMs = RECOVER_MS();
  const abortMs = ABORT_MS();

  /* 没有事件 ≠ 停滞 —— 先确认底下确实没有东西在跑。
   * 工具执行期间是没有运行时事件的, 漏了这一步就会把正常的长任务 (build/clone/慢 SQL)
   * 当成死锁打断。探针说"有活" → 视同一次进展。 */
  if (silentMs >= Math.min(warnMs || Infinity, recoverMs || Infinity)) {
    try {
      if (await handlers.hasLiveWork?.(sessionId)) {
        w.lastProgressAt = Date.now();
        w.lastSignal = 'work in flight';
        w.firedWarn = false;
        return;
      }
    } catch (err) {
      /* 探针本身出错时按"有活"处理 —— 宁可晚一点开火, 也不能因为探针挂了误杀正常任务 */
      cliLogger.warn('TURN_STALL', `hasLiveWork probe threw, 本轮跳过判定: ${(err as Error)?.message}`);
      return;
    }
  }

  const base = {
    sessionId,
    silentMs,
    lastSignal: w.lastSignal,
    recoverAttempt: w.recoverAttempt,
  };

  /* ── T3: 放弃 ── */
  if (abortMs > 0 && silentMs >= abortMs) {
    const e: TurnStallEvent = { ...base, level: 'abort' };
    const reason =
      `这一轮已经 ${Math.round(silentMs / 60_000)} 分钟没有任何进展 ` +
      `(最后一次是: ${w.lastSignal})，且自动恢复 ${w.recoverAttempt} 次仍未能继续。` +
      `已经停止本轮，你可以重新发送消息继续 —— 上下文都还在。`;
    cliLogger.error('TURN_STALL', `[abort] session=${sessionId} silent=${silentMs}ms last="${w.lastSignal}"`);
    disarmTurnStallGuard(sessionId);
    try { await handlers.onAbort?.(e, reason); } catch (err) {
      cliLogger.warn('TURN_STALL', `onAbort handler threw: ${(err as Error)?.message}`);
    }
    return;
  }

  /* ── T2: 自救 ── */
  if (recoverMs > 0 && silentMs >= recoverMs && w.recoverAttempt < MAX_RECOVER()) {
    const e: TurnStallEvent = { ...base, level: 'recover' };
    w.recovering = true;
    w.recoverAttempt += 1;
    cliLogger.warn('TURN_STALL',
      `[recover #${w.recoverAttempt}] session=${sessionId} silent=${silentMs}ms last="${w.lastSignal}" — 注入恢复信息唤醒 agent`);
    try {
      const woke = await handlers.onRecover?.(e, buildStallRecoveryMessage(e));
      if (woke) {
        /* 叫醒了 → 重新计时, 让它有完整的一段时间去干活 */
        w.lastProgressAt = Date.now();
        w.lastSignal = 'stall recovery injected';
        w.firedWarn = false;
      } else {
        /* 没能叫醒 (没有注册 handler / 会话已经不存在) → 不必再等满 T3, 直接放弃 */
        cliLogger.warn('TURN_STALL', `[recover] session=${sessionId} 未能唤醒, 升级到 abort`);
        w.recoverAttempt = MAX_RECOVER();
        w.lastProgressAt = Date.now() - Math.max(abortMs, recoverMs);
      }
    } catch (err) {
      cliLogger.warn('TURN_STALL', `onRecover handler threw: ${(err as Error)?.message}`);
    } finally {
      w.recovering = false;
    }
    return;
  }

  /* ── T1: 提示 ── */
  if (warnMs > 0 && silentMs >= warnMs && !w.firedWarn) {
    w.firedWarn = true;
    const e: TurnStallEvent = { ...base, level: 'warn' };
    cliLogger.info('TURN_STALL',
      `[warn] session=${sessionId} silent=${silentMs}ms last="${w.lastSignal}"`);
    try { handlers.onWarn?.(e); } catch { /* 提示失败不影响后续分级 */ }
  }
}

/** 测试用 — 清掉所有看门狗和 handler */
export function __resetTurnStallGuardForTest(): void {
  for (const w of watches.values()) clearInterval(w.timer);
  watches.clear();
  handlers = {};
}
