
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';

/**
 * 读用户 UI 语言 (跟 runtimeBuilder.uiLanguage 走同一 config.language 字段).
 * 用于 getTargetSystemPromptSection 决定用中/英 prompt.
 * 保守 fallback: 读不出来当 'zh' (兼容老配置).
 */
function getPromptLanguage(): 'zh' | 'en' {
  try {
    return (loadConfig() as any).language === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

// ==================== Target Mission State ====================

/**
 * Target 生命周期:
 *   off       — 未激活.
 *   active    — 正在跑, loop 闸门开启, 每轮结束前 model 需调 check_target_done.
 *   paused    — P1.3: 用户/model 主动暂停; loop 允许退出, 状态保留可 continue_target 恢复.
 *   satisfied — check_target_done(done=true) 后终态, loop 允许退出.
 *   abandoned — abandon_target 后终态, loop 允许退出.
 *   expired   — P1.4: max_run_time 到期兜底终态, loop 允许退出.
 */
export type TargetStatus = 'off' | 'active' | 'paused' | 'satisfied' | 'abandoned' | 'expired';

/** 战略块状态 — 双层规划的战略层(update_plan 是战术层, 管当前块的细步). */
export type SubMissionStatus = 'pending' | 'in_progress' | 'completed';

/** Target 阶段 — 研究先行状态机:
 *   research — 调研对标(web_search 主流 + explore 盘点现状 + gap 分析 → 写 REQUIREMENTS.md), 拍战略块之前.
 *   execute  — 逐块攻(plan_target 拆完战略块 / 中小目标直接干).
 * 大目标 activate 时进 research; plan_target 拆出战略块即转 execute. 中小目标直接 execute. */
export type TargetPhase = 'research' | 'execute';

/** 一个战略块 — 大目标拆出的几十个大块之一; 每块内部再用 update_plan 拆细步逐个攻. */
export interface SubMission {
  id: string;
  description: string;
  success_criteria?: string;
  status: SubMissionStatus;
}

interface TargetPlan {
  target: string;
  rationale?: string;
  sub_missions: SubMission[];
  createdAt: number;
  /** P1.4 time ceiling — 超时自动 expired. undefined 表示无上限. */
  maxRunTimeMs?: number;
  /** 研究先行阶段. undefined 视为 execute (向后兼容 + 中小目标默认). */
  phase?: TargetPhase;
}


interface TargetSlot {
  status: TargetStatus;
  plan: TargetPlan | null;
  lastDoneCheck: { done: boolean; reason: string; ts: number } | null;
  abandonReason: string | null;
}
function emptySlot(): TargetSlot {
  return { status: 'off', plan: null, lastDoneCheck: null, abandonReason: null };
}
const sessions = new Map<string, TargetSlot>();

const _sessionAls = new AsyncLocalStorage<string>();
let _fallbackSessionId: string | null = null;

function currentSid(): string | null {
  return _sessionAls.getStore() ?? _fallbackSessionId;
}
function getSlot(sid: string | null | undefined): TargetSlot | null {
  if (!sid) return null;
  let slot = sessions.get(sid);
  if (!slot) { slot = emptySlot(); sessions.set(sid, slot); }
  return slot;
}
function currentSlot(): TargetSlot | null { return getSlot(currentSid()); }

const targetConsent = new Set<string>();

export function grantTargetConsent(sid: string): void {
  if (sid) targetConsent.add(sid);
}
export function hasTargetConsent(sid: string | null | undefined): boolean {
  return !!sid && targetConsent.has(sid);
}
export function revokeTargetConsent(sid: string | null | undefined): void {
  if (sid) targetConsent.delete(sid);
}

const recentUserText = new Map<string, string[]>();
const KEEP_TURNS = 6;
const KEEP_CHARS = 2000;

export function rememberUserText(sid: string | null | undefined, text: string): void {
  if (!sid || !text) return;
  const list = recentUserText.get(sid) ?? [];
  list.push(String(text).slice(0, KEEP_CHARS));
  while (list.length > KEEP_TURNS) list.shift();
  recentUserText.set(sid, list);
}

/** 归一化后比对 —— 模型引用时常改标点/空白/大小写, 那不该判它伪造。 */
function normalizeForQuote(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,。.、；;：:！!？?~～"'“”‘’()（）【】\[\]]/g, '');
}

/** 这句引用是不是用户真说过的。太短的不算 —— "做" "改" 这种谁都能凑出来。 */
export function userReallySaid(sid: string | null | undefined, quote: string): boolean {
  if (!sid || !quote) return false;
  const q = normalizeForQuote(quote);
  if (q.length < 4) return false;
  const list = recentUserText.get(sid) ?? [];
  return list.some((t) => normalizeForQuote(t).includes(q));
}

export function forgetUserText(sid: string | null | undefined): void {
  if (sid) recentUserText.delete(sid);
}

export const TARGET_INTENT_RE =
  /(^|\s)\/target(\s|$)|[设开启建]{1,2}[^。，,.\n]{0,6}target|target\s*模式|长期(目标|跑|运行)|长跑模式|持续.{0,4}跑(到|直到)|一直(干|做|跑)(到|下去)?|(围绕|按).{0,6}目标.{0,4}(一直|持续|反复)|[设定置]{1,2}[^。，,.\n]{0,4}目标/;


function renderTargetPlanMarkdown(plan: TargetPlan): string {
  const mark = (s: SubMissionStatus): string =>
    s === 'completed' ? 'x' : s === 'in_progress' ? '>' : ' ';
  const done = plan.sub_missions.filter((b) => b.status === 'completed').length;
  const total = plan.sub_missions.length;
  return [
    '# Target Plan',
    '',
    `> ${plan.target}`,
    '',
    `进度: ${done}/${total}`,
    `更新: ${new Date().toISOString()}`,
    '',
    '<!-- [x]=完成  [>]=进行中  [ ]=待办 · 这个文件由 plan_target / plan_block 维护 -->',
    '',
    ...plan.sub_missions.map((b) => {
      const criteria = b.success_criteria ? ` — 验收: ${b.success_criteria}` : '';
      return `- [${mark(b.status)}] \`${b.id}\` ${b.description}${criteria}`;
    }),
    '',
  ].join('\n');
}

/** 投影到磁盘。失败不阻塞主流程 —— 计划的真源在内存 + DB, 文件只是给人看的那一份。 */
async function persistTargetPlanFile(sid: string | null, plan: TargetPlan): Promise<string | undefined> {
  const root = getWorkspaceRootFromContext();
  if (!root || !sid) return undefined;
  try {
    const dir = nodePath.join(root, '.neox', 'plans');
    await fsp.mkdir(dir, { recursive: true });
    const file = nodePath.join(dir, `target-${sid}.md`);
    await fsp.writeFile(file, renderTargetPlanMarkdown(plan), 'utf-8');
    return file;
  } catch {
    return undefined;   /* 无写权限 / workspace 没了 —— 不影响长跑本身 */
  }
}

/** 给模型的进度摘要 —— 永远只回这个, 不回全量清单 */
function planSummary(plan: TargetPlan, planPath?: string): Record<string, unknown> {
  const blocks = plan.sub_missions;
  const done = blocks.filter((b) => b.status === 'completed').length;
  const current = blocks.find((b) => b.status === 'in_progress');
  const nextPending = blocks.filter((b) => b.status === 'pending').slice(0, 3)
    .map((b) => ({ id: b.id, description: b.description.slice(0, 80) }));
  return {
    progress: `${done}/${blocks.length}`,
    ...(current ? { current: { id: current.id, description: current.description.slice(0, 120) } } : {}),
    ...(nextPending.length ? { nextPending } : {}),
    ...(planPath ? { planFile: planPath } : {}),
    remaining: blocks.length - done,
  };
}

/** Runtime 在每次 tool 调用前用它包住, 保证 handler 里所有 target state 操作走对 sid. */
export function runWithTargetSession<T>(sid: string, fn: () => T): T {
  return _sessionAls.run(sid, fn);
}

// Runtime hooks (UI / persistence / event bus) — legacy, still module-scoped single subscriber.
let onTargetChange: ((status: TargetStatus, plan: TargetPlan | null) => void) | null = null;
let onDoneChecked: ((done: boolean, reason: string) => void) | null = null;

// ==================== Phase A · Event Bus (single source of truth) ====================
//
// 后端是唯一的 target 状态 owner. 每次 mutation 都 emit 一次完整 snapshot,
// 前端 (desktop/CLI) 通过 IPC 订阅这些事件, 不再从 timeline 派生状态.
//
// 契约: 每次 emit 都带完整 snapshot (不是 diff), 保证消费端丢事件也能恢复完整状态.

export interface TargetSnapshot {
  sessionId: string | null;
  status: TargetStatus;
  target: string | null;
  rationale: string | null;
  subMissions: SubMission[];
  createdAt: number | null;
  updatedAt: number;
  maxRunTimeMs: number | null;
  lastDoneCheck: { done: boolean; reason: string; ts: number } | null;
  abandonReason: string | null;
  /** 派生字段, 便于前端直接展示无需 client-side 计算 (纯值, 快照时刻) */
  elapsedMs: number;
  subMissionCount: number;
  /** status==='completed' 的战略块数 — 前端算宏观进度 (completed/total 块) 直接读 */
  completedSubMissions: number;
  phase: TargetPhase;
}

class TargetEventBus extends EventEmitter {}
export const targetEvents = new TargetEventBus();

/** 组装指定 session 的完整 snapshot. sid 缺省时走 ALS/fallback 当前上下文.
 *  说明: 每个 session 的 slot 独立, 不同 UI/命令请求可拿各自的 snapshot. */
export function getTargetSnapshot(sid?: string | null): TargetSnapshot {
  const sessionId = sid ?? currentSid();
  const slot = getSlot(sessionId);
  const now = Date.now();
  const plan = slot?.plan ?? null;
  const createdAt = plan?.createdAt ?? null;
  return {
    sessionId: sessionId,
    status: slot?.status ?? 'off',
    target: plan?.target ?? null,
    rationale: plan?.rationale ?? null,
    subMissions: plan?.sub_missions ?? [],
    createdAt,
    updatedAt: now,
    maxRunTimeMs: plan?.maxRunTimeMs ?? null,
    lastDoneCheck: slot?.lastDoneCheck ?? null,
    abandonReason: slot?.abandonReason ?? null,
    elapsedMs: createdAt ? Math.max(0, now - createdAt) : 0,
    subMissionCount: plan?.sub_missions?.length ?? 0,
    completedSubMissions: plan?.sub_missions?.filter((s) => s.status === 'completed').length ?? 0,
    phase: plan?.phase ?? 'execute',
  };
}

/** 内部: 每次 mutation 结束时调用, emit 一次完整 snapshot 给所有订阅者.
 *  显式带 sid — sessionId 永远等于被 mutation 的 slot 的所属, 不再从全局猜. */
function broadcastTargetSnapshot(sid: string | null): void {
  if (!sid) return;
  try {
    const snap = getTargetSnapshot(sid);
    targetEvents.emit('snapshot', snap);
  } catch (err: any) {
    // event 广播 fail 不能影响主流程 (target 状态本身仍是正确的)
    console.warn('[target-mission] broadcast failed:', err?.message);
  }
}

// ==================== Persistence (P1.2) ====================
//
// target_missions 表: 每 session 至多 1 条 target (session_id PK). session 崩溃 / 进程退出
// 重启后, Boot 时 rehydrateTargetFromDb(sid) 恢复模块级状态, 主 agent 继续长跑不丢.
//
// sessionId 由 runtime (runtimeBuilder) 每次启动 session 时通过 setActiveTargetSession 注入.
// 未注入时 (测试 / 无 sessionId 上下文) 所有 persist 变 no-op.

/** 相同 err.message 只 warn 一次的去重集, 防 loop 里持续报错刷屏; 换新错还是会 warn. */
const _persistWarnedMessages = new Set<string>();

/** 由 runtimeBuilder 在每次启动 session 时调用. 传 null 表示当前无 session.
 *  Fix C 后: 只更新"fallback 上下文"给不走 ALS 的 legacy 调用点 (CLI 等), 不再清任何 session 的
 *  内存状态 (每 session 独立 slot). 想清某 session 请调 deleteTargetForSession(sid). */
export function setActiveTargetSession(sid: string | null): void {
  _fallbackSessionId = sid;
}

/** 日志 helper — 每次失败都主动 log warn (相同 err.message 去重), 不再一次 warn 后永久静默. */
function warnPersistFailure(op: 'persist' | 'rehydrate' | 'clear', sid: string | null, err: any): void {
  const msg = err?.message || String(err);
  const key = `${op}:${msg}`;
  if (_persistWarnedMessages.has(key)) return;
  _persistWarnedMessages.add(key);
  console.warn(`[target-mission] ${op} failed sid=${sid ?? '(none)'} err=${msg}`);
}

/** 内部: 把指定 session 的 target slot 写回 target_missions 表 (INSERT OR REPLACE). */
function persistTargetToDb(sid: string | null): void {
  if (!sid) return;
  const slot = getSlot(sid);
  if (!slot) return;
  try {
    const db = getDatabase();
    // 'off' 状态直接删行, 避免残留.
    if (slot.status === 'off') {
      db.getRawDb().prepare('DELETE FROM target_missions WHERE session_id = ?').run(sid);
      broadcastTargetSnapshot(sid);
      return;
    }
    const plan = slot.plan;
    const planJson = plan
      ? JSON.stringify({
          rationale: plan.rationale,
          sub_missions: plan.sub_missions,
          maxRunTimeMs: plan.maxRunTimeMs,
          phase: plan.phase,
          /* 落盘也是白名单 —— 不写进去, 重启后 rehydrate 拿不到, 团队会话变回「目标」 */
        })
      : null;
    const now = Date.now();
    db.getRawDb()
      .prepare(
        `INSERT INTO target_missions (
           session_id, status, target_text, rationale, plan_json,
           last_done_check_json, abandon_reason, activated_at, updated_at, max_run_time_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           status=excluded.status,
           target_text=excluded.target_text,
           rationale=excluded.rationale,
           plan_json=excluded.plan_json,
           last_done_check_json=excluded.last_done_check_json,
           abandon_reason=excluded.abandon_reason,
           updated_at=excluded.updated_at,
           max_run_time_ms=excluded.max_run_time_ms`,
      )
      .run(
        sid,
        slot.status,
        plan?.target ?? '',
        plan?.rationale ?? null,
        planJson,
        slot.lastDoneCheck ? JSON.stringify(slot.lastDoneCheck) : null,
        slot.abandonReason,
        plan?.createdAt ?? Date.now(),
        now,
        plan?.maxRunTimeMs ?? null,
      );
    broadcastTargetSnapshot(sid);
  } catch (err: any) {
    // DB 不可用 / SQL 出错时不阻塞主流程, 但每种错都 log 一次 (去重按 err.message).
    warnPersistFailure('persist', sid, err);
    // 即使 DB 写失败, in-memory 状态已改, 也 broadcast 给前端 (UI 至少能看到状态变化).
    broadcastTargetSnapshot(sid);
  }
}

/**
 * 显式删除某 session 的 target 行. 由 sessionStore.deleteSession / cloud session delete 应用层调用,
 * 替代 V6 版本靠外键 CASCADE 的自动清理 (V7 去外键后需要应用层做). session 可以是任意 id, 不必是当前 active.
 */
export function deleteTargetForSession(sid: string): void {
  if (!sid) return;
  try {
    const db = getDatabase();
    db.getRawDb().prepare('DELETE FROM target_missions WHERE session_id = ?').run(sid);
    // 清对应 session 的内存 slot (每 session 独立, 别的 session 不受影响)
    const slot = getSlot(sid);
    if (slot) {
      slot.status = 'off';
      slot.plan = null;
      slot.lastDoneCheck = null;
      slot.abandonReason = null;
      if (onTargetChange) onTargetChange('off', null);
    }
    broadcastTargetSnapshot(sid);
  } catch (err: any) {
    warnPersistFailure('clear', sid, err);
  }
}

/**
 * 从 DB 读回指定 session 的 target 状态并恢复模块级变量.
 * runtime 启动 session 时调用. 找不到行就 reset 到 off.
 * 只恢复 active/paused 两种可继续状态 — 终态 (satisfied/abandoned/expired) 也读出来但不再 gate loop.
 */
export function rehydrateTargetFromDb(sid: string): void {
  const slot = getSlot(sid);
  if (!slot) return;
  try {
    const db = getDatabase();
    const row = db.getRawDb()
      .prepare('SELECT * FROM target_missions WHERE session_id = ?')
      .get(sid) as any;
    if (!row) {
      if ((slot.status === 'active' || slot.status === 'paused') && slot.plan) {
        persistTargetToDb(sid);     // 顺手补落盘; DB 若恢复可用就存上, 仍缺表则再次静默失败无害
        broadcastTargetSnapshot(sid);
        return;
      }
      // 无持久化状态且内存 slot 无活跃 target → 显式 off (幂等)
      slot.status = 'off';
      slot.plan = null;
      slot.lastDoneCheck = null;
      slot.abandonReason = null;
      if (onTargetChange) onTargetChange(slot.status, null);
      broadcastTargetSnapshot(sid);
      return;
    }
    slot.status = (row.status as TargetStatus) || 'off';
    let planExt: {
      rationale?: string;
      sub_missions?: Array<{ id: string; description: string; success_criteria?: string; status?: SubMissionStatus }>;
      maxRunTimeMs?: number;
      phase?: TargetPhase;
    } = {};
    if (row.plan_json) {
      try { planExt = JSON.parse(row.plan_json); } catch { /* corrupted JSON 忽略, 用空 */ }
    }
    slot.plan = {
      target: row.target_text || '',
      rationale: row.rationale || planExt.rationale,
      // 旧数据无 status → 默认 pending (向后兼容双层规划前的快照).
      sub_missions: (planExt.sub_missions || []).map((sm, i) => ({
        id: String(sm.id || `b${i + 1}`),
        description: String(sm.description || ''),
        success_criteria: sm.success_criteria ? String(sm.success_criteria) : undefined,
        status: sm.status === 'in_progress' || sm.status === 'completed' ? sm.status : 'pending',
      })),
      createdAt: Number(row.activated_at) || Date.now(),
      maxRunTimeMs: row.max_run_time_ms != null ? Number(row.max_run_time_ms) : planExt.maxRunTimeMs,
      phase: planExt.phase === 'research' ? 'research' : 'execute',
    };
    if (row.last_done_check_json) {
      try { slot.lastDoneCheck = JSON.parse(row.last_done_check_json); } catch { slot.lastDoneCheck = null; }
    } else {
      slot.lastDoneCheck = null;
    }
    slot.abandonReason = row.abandon_reason || null;
    if (onTargetChange) onTargetChange(slot.status, slot.plan);
    broadcastTargetSnapshot(sid);
  } catch (err: any) {
    warnPersistFailure('rehydrate', sid, err);
  }
}

/** 兼容旧调用: 返回 fallback 当前 sid. Fix C 后不再等价"活跃的 target session"
 *  (可能有多个 session 同时活跃), 保留 API 是为不炸 CLI/桌面调用点. */
export function getActiveTargetSessionId(): string | null {
  return _fallbackSessionId;
}

export function peekTargetForSession(sid: string): {
  status: TargetStatus;
  plan: {
    target: string;
    rationale?: string;
    sub_missions: SubMission[];
    createdAt: number;
    maxRunTimeMs?: number;
    phase?: TargetPhase;
  } | null;
  lastDoneCheck: { done: boolean; reason: string; ts: number } | null;
  abandonReason: string | null;
} | null {
  if (!sid) return null;
  try {
    const db = getDatabase();
    const row = db.getRawDb()
      .prepare('SELECT * FROM target_missions WHERE session_id = ?')
      .get(sid) as any;
    if (!row) return null;
    let planExt: any = {};
    if (row.plan_json) { try { planExt = JSON.parse(row.plan_json); } catch { /* corrupted 忽略 */ } }
    let ldc: { done: boolean; reason: string; ts: number } | null = null;
    if (row.last_done_check_json) { try { ldc = JSON.parse(row.last_done_check_json); } catch { /* ignore */ } }
    return {
      status: (row.status as TargetStatus) || 'off',
      plan: {
        target: row.target_text || '',
        rationale: row.rationale || planExt.rationale,
        sub_missions: (planExt.sub_missions || []).map((sm: any, i: number) => ({
          id: String(sm.id || `b${i + 1}`),
          description: String(sm.description || ''),
          success_criteria: sm.success_criteria ? String(sm.success_criteria) : undefined,
          status: sm.status === 'in_progress' || sm.status === 'completed' ? sm.status : 'pending',
        })),
        createdAt: Number(row.activated_at) || Date.now(),
        maxRunTimeMs: row.max_run_time_ms != null ? Number(row.max_run_time_ms) : planExt.maxRunTimeMs,
        phase: planExt.phase === 'research' ? 'research' : 'execute',
      },
      lastDoneCheck: ldc,
      abandonReason: row.abandon_reason || null,
    };
  } catch (err: any) {
    warnPersistFailure('rehydrate', sid, err);
    return null;
  }
}

/**
 * 对"非当前活跃 session"的 target 做状态改写 — 直接写 DB 行, 不动模块状态机.
 * 该 session 下次 rehydrate (发消息 / buildRunner) 时生效. off = 删行.
 */
export function setTargetStatusForSessionInDb(
  sid: string,
  next: 'paused' | 'active' | 'abandoned' | 'off',
  reason?: string,
): boolean {
  if (!sid) return false;
  try {
    const db = getDatabase();
    if (next === 'off') {
      db.getRawDb().prepare('DELETE FROM target_missions WHERE session_id = ?').run(sid);
      return true;
    }
    const res = db.getRawDb()
      .prepare('UPDATE target_missions SET status = ?, abandon_reason = COALESCE(?, abandon_reason), updated_at = ? WHERE session_id = ?')
      .run(next, next === 'abandoned' ? (reason ?? 'Stopped by user') : null, Date.now(), sid);
    return ((res as any)?.changes ?? 0) > 0;
  } catch (err: any) {
    warnPersistFailure('persist', sid, err);
    return false;
  }
}

export function hasLiveTargetSlot(sid: string | null | undefined): boolean {
  if (!sid) return false;
  const slot = sessions.get(sid);
  return !!slot && slot.status !== 'off';
}

/** 用户从 UI 终止 target (等价 abandon, 不经 LLM). sid 省略时走 ALS/fallback 当前上下文. */
export function abandonTargetFromCommand(reason?: string, sid?: string | null): boolean {
  const targetSid = sid ?? currentSid();
  const slot = getSlot(targetSid);
  if (!slot) return false;
  if (slot.status !== 'active' && slot.status !== 'paused') return false;
  slot.status = 'abandoned';
  slot.abandonReason = reason ?? 'Stopped by user from desktop UI';
  if (onTargetChange) onTargetChange(slot.status, slot.plan);
  persistTargetToDb(targetSid);
  return true;
}

export function setTargetModeCallbacks(callbacks: {
  onChange?: (status: TargetStatus, plan: TargetPlan | null) => void;
  onDoneChecked?: (done: boolean, reason: string) => void;
}): void {
  if (callbacks.onChange) onTargetChange = callbacks.onChange;
  if (callbacks.onDoneChecked) onDoneChecked = callbacks.onDoneChecked;
}

/** 全部 getter 支持可选 sid (省略走 ALS/fallback 当前上下文). */
export function getTargetStatus(sid?: string | null): TargetStatus {
  return getSlot(sid ?? currentSid())?.status ?? 'off';
}

export function getCurrentTargetPlan(sid?: string | null): TargetPlan | null {
  return getSlot(sid ?? currentSid())?.plan ?? null;
}

export function isTargetActive(sid?: string | null): boolean {
  return getTargetStatus(sid) === 'active';
}

export function isTargetSatisfied(sid?: string | null): boolean {
  return getTargetStatus(sid) === 'satisfied';
}

export function isTargetAbandoned(sid?: string | null): boolean {
  return getTargetStatus(sid) === 'abandoned';
}

/** CLI/桌面命令层调用: /target <文本> 直接激活 target mode (不经过 plan_target 工具).
 *  phase 默认 execute (研究先行由 agent 按规模自判); activate_target 工具会按 needs_research 传 research. */
export function activateTargetFromCommand(target: string, maxRunTimeMs?: number, phase: TargetPhase = 'execute'): void {
  const sid = currentSid();
  const slot = getSlot(sid);
  if (!slot) return;
  slot.status = 'active';
  slot.plan = {
    target,
    rationale: 'Activated via /target command; agent keeps a living plan via update_plan.',
    sub_missions: [],
    createdAt: Date.now(),
    maxRunTimeMs,
    phase,
  };
  slot.lastDoneCheck = null;
  slot.abandonReason = null;
  if (onTargetChange) onTargetChange(slot.status, slot.plan);
  persistTargetToDb(sid);
}

export function resetTargetMode(sid?: string | null): void {
  const targetSid = sid ?? currentSid();
  revokeTargetConsent(targetSid);
  const slot = getSlot(targetSid);
  if (!slot) return;
  slot.status = 'off';
  slot.plan = null;
  slot.lastDoneCheck = null;
  slot.abandonReason = null;
  if (onTargetChange) onTargetChange(slot.status, slot.plan);
  persistTargetToDb(targetSid);
}

/**
 * P1.3 Pause — 用户/model 主动暂停. loop 允许退出, 状态保留可 continue.
 */
export function pauseTargetMission(reason?: string, sid?: string | null): boolean {
  const targetSid = sid ?? currentSid();
  const slot = getSlot(targetSid);
  if (!slot || slot.status !== 'active') return false;
  slot.status = 'paused';
  if (slot.plan && reason) {
    slot.plan.rationale = `[paused] ${reason}` + (slot.plan.rationale ? `\n(prev) ${slot.plan.rationale}` : '');
  }
  if (onTargetChange) onTargetChange(slot.status, slot.plan);
  persistTargetToDb(targetSid);
  return true;
}

/**
 * P1.3 Continue — 从 paused 恢复到 active.
 */
export function continueTargetMission(sid?: string | null): boolean {
  const targetSid = sid ?? currentSid();
  const slot = getSlot(targetSid);
  if (!slot || slot.status !== 'paused') return false;
  slot.status = 'active';
  if (onTargetChange) onTargetChange(slot.status, slot.plan);
  persistTargetToDb(targetSid);
  return true;
}

/**
 * P1.5 Refine — 只改 target 文本, 保留 status / plan / elapsed / 历史.
 * 只由用户命令触发, 不给 model 自主入口 (防中途偏题).
 */
export function refineTargetMission(newTarget: string, reason?: string, sid?: string | null): boolean {
  const targetSid = sid ?? currentSid();
  const slot = getSlot(targetSid);
  if (!slot) return false;
  if (slot.status !== 'active' && slot.status !== 'paused') return false;
  if (!slot.plan) return false;
  const trimmed = newTarget.trim();
  if (!trimmed) return false;
  slot.plan.target = trimmed;
  if (reason) {
    slot.plan.rationale = `[refined] ${reason}` + (slot.plan.rationale ? `\n(prev) ${slot.plan.rationale}` : '');
  }
  if (onTargetChange) onTargetChange(slot.status, slot.plan);
  persistTargetToDb(targetSid);
  return true;
}

/**
 * 每轮 continuation prompt — 每 iteration>=2 时被 kernel perTurnInjector 以 user role 注入。
 *   不是规则手册, 是每轮一次"围绕目标的清醒思考": 先对齐(现状 vs 完整目标, 看真实证据),
 *   再挑下一个细任务推进, 用 update_plan 记账。工程大小 / 拆解粒度交给 LLM 自己判断。
 *   保留 objective + 已运行。取意自 Codex ext/goal 但更聚焦对齐与细拆, 不做"逼着别停"的堆压。
 *
 * 若 target 非 active 或无 plan → 返回 null (kernel no-op)。
 */
export function getTargetContinuationPrompt(iteration: number, sid?: string | null): string | null {
  const slot = getSlot(sid ?? currentSid());
  if (!slot || slot.status !== 'active' || !slot.plan) return null;
  const plan = slot.plan;
  void iteration; // 保留形参给 kernel; 目前不按 iteration 分级 (信任模型)
  const isEn = getPromptLanguage() === 'en';
  const targetText = plan.target || '(unspecified)';
  const elapsedMs = Date.now() - plan.createdAt;
  const elapsedH = Math.floor(elapsedMs / 3_600_000);
  const elapsedM = Math.floor((elapsedMs % 3_600_000) / 60_000);
  const elapsedStr = elapsedH > 0 ? `${elapsedH}h ${elapsedM}m` : `${elapsedM}m`;

  const blocks = plan.sub_missions ?? [];
  const total = blocks.length;
  const done = blocks.filter((b) => b.status === 'completed').length;
  const active = blocks.find((b) => b.status === 'in_progress');
  const hasStrategy = total > 0;

  /* 研究先行阶段 — 拍战略块之前先驱动调研对标, 别凭空 plan. plan_target 一拆块就转 execute. */
  if ((plan.phase ?? 'execute') === 'research') {
    return isEn
      ? [
          `[Target · RESEARCH · elapsed ${elapsedStr}]`,
          targetText,
          ``,
          `Still in the research phase — do the homework before carving strategy blocks, but DON'T pile the exploration into this context.`,
          `Delegate the research: call agent({ type: 'research', description: '<one-line>', task: 'Survey mainstream/reference systems + this repo (real stack/code/integration points) + gap analysis, then write a detailed REQUIREMENTS.md at ./REQUIREMENTS.md' }). The sub-agent explores in isolation and returns only a short summary + the file path — the heavy reading stays out of your window.`,
          `When it returns: readfile REQUIREMENTS.md, then call plan_target to carve strategy blocks from the doc and move to execution. If REQUIREMENTS.md already exists and is solid, skip straight to plan_target. Don't guess the plan — ground it in the doc.`,
        ].join('\n')
      : [
          `[目标 · 调研中 · 已运行 ${elapsedStr}]`,
          targetText,
          ``,
          `还在调研阶段 —— 拍战略块之前先把功课做足, 但**别把探索堆进当前上下文**。`,
          `把调研派出去: 调 agent({ type: 'research', description: '<one line>', task: '对标主流/参考系统 + 盘点本 repo(真实技术栈/代码/接入点)+ gap 分析, 写一份详实的 REQUIREMENTS.md 到 ./REQUIREMENTS.md' })。子 agent 在隔离上下文里探索, 只回一句摘要 + 文件路径 —— 海量阅读不进你的窗口。`,
          `它回来后: readfile REQUIREMENTS.md, 再调 plan_target 照文档拆战略块、进入执行。若 REQUIREMENTS.md 已存在且扎实, 直接 plan_target。别凭空拍 plan —— 让它落在文档上。`,
        ].join('\n');
  }

  if (isEn) {
    const header = hasStrategy
      ? `[Target · ${done}/${total} blocks · elapsed ${elapsedStr}]`
      : `[Target · elapsed ${elapsedStr}]`;
    const body = hasStrategy
      ? [
          `Keep going around this objective. Align first: which block you're on${active ? ` (now: ${active.description})` : ''} and what's still missing against the full objective — read code / output / tests, not memory.`,
          `Attack the current block with update_plan (fine steps you can finish this turn). When the whole block lands, mark it completed in plan_target and open the next.`,
          `How large the work is and how finely to split — you decide. Done only when every block holds up against real evidence.`,
        ]
      : [
          `Keep going around this objective. First read the scale: a large multi-subsystem goal → carve strategy blocks with plan_target, then attack them one at a time; a smaller goal → just break it into steps with update_plan.`,
          `Align on where it really stands (code / output / tests, not memory), then advance. How large the work is and how finely to split — you decide.`,
          `Done only when every part holds up against real evidence.`,
        ];
    return [header, targetText, ``, ...body].join('\n');
  }
  const header = hasStrategy
    ? `[目标 · ${done}/${total} 块 · 已运行 ${elapsedStr}]`
    : `[目标 · 已运行 ${elapsedStr}]`;
  const body = hasStrategy
    ? [
        `围绕这个目标继续。先对齐: 当前在攻哪一块${active ? `(正在: ${active.description})` : ''}、离完整目标还差哪些 —— 看代码 / 输出 / 测试, 别凭记忆。`,
        `当前这块用 update_plan 拆成这一轮能做完的细步做掉; 整块攻完就在 plan_target 标 completed、起下一块。`,
        `工程多大、拆多细, 你自己判断。每一块都经得起真实证据核验, 才算完。`,
      ]
    : [
        `围绕这个目标继续。先看清规模: 多子系统的大目标 → 用 plan_target 拆战略块再逐块攻; 中小目标 → 直接 update_plan 拆细步做。`,
        `先对齐现状(看代码 / 输出 / 测试, 别凭记忆)再推进。工程多大、拆多细, 你自己判断。`,
        `目标每一部分都经得起真实证据核验, 才算完。`,
      ];
  return [header, targetText, ``, ...body].join('\n');
}

/**
 * P1.4 Time ceiling check — 由 check_target_done 前调用.
 * 超过 maxRunTimeMs → status 转 expired, loop 允许退出.
 * 返回 true 表示本次调用触发了 expired, false 表示未超时或无 ceiling.
 */
export function checkAndMarkExpiredIfOverdue(): boolean {
  const sid = currentSid();
  const slot = getSlot(sid);
  if (!slot || slot.status !== 'active' || !slot.plan?.maxRunTimeMs) return false;
  const elapsed = Date.now() - slot.plan.createdAt;
  if (elapsed <= slot.plan.maxRunTimeMs) return false;
  slot.status = 'expired';
  if (onTargetChange) onTargetChange(slot.status, slot.plan);
  persistTargetToDb(sid);
  return true;
}

/**
 * 供 runner loop 判断: target mode 激活但主 agent 还没确认完成时,
 * 不允许"无 tool_use"退出 loop.
 * 返回 true 表示应该阻止本轮 break, 注入提醒继续.
 * paused/expired/satisfied/abandoned 均放行退出.
 */
export function shouldBlockNoToolExit(sid?: string | null): boolean {
  return getTargetStatus(sid) === 'active';
}

export function isTargetPaused(sid?: string | null): boolean { return getTargetStatus(sid) === 'paused'; }
export function isTargetExpired(sid?: string | null): boolean { return getTargetStatus(sid) === 'expired'; }

/**
 * 供 runner 拼装 system prompt 时调用: target mode 激活时追加的约束段.
 * 通过 memory.upsertSystemTagged('target_mission', ...) 挂在 system prompt 里.
 * 按 UI language (config.language) 分中/英两版, 让 model 输出跟 UI 语一致.
 */
export function getTargetSystemPromptSection(sid?: string | null): string {
  const slot = getSlot(sid ?? currentSid());
  if (!slot || !slot.plan) return '';
  if (slot.status === 'paused') {
    const done = slot.plan.sub_missions?.filter((s) => s.status === 'completed').length ?? 0;
    const total = slot.plan.sub_missions?.length ?? 0;
    return getPromptLanguage() === 'en'
      ? [
          '<target_mission>',
          `A Target Mission is PAUSED: ${slot.plan.target || '(unspecified)'} (${done}/${total} blocks done).`,
          'If the user explicitly asks to continue/resume in their message, call continue_target and proceed with the in_progress block immediately — do NOT tell them to type /target continue.',
          'Otherwise treat the conversation normally and do NOT resume on your own initiative.',
          '</target_mission>',
        ].join('\n')
      : [
          '<target_mission>',
          `有一个 Target Mission 处于暂停: ${slot.plan.target || '(未指定)'} (已完成 ${done}/${total} 块)。`,
          '用户在消息里明确要求继续/恢复时: 直接调 continue_target 并立即从 in_progress 块继续 — 不要让用户去敲 /target continue。',
          '其余情况按普通对话处理, 不要自作主张恢复。',
          '</target_mission>',
        ].join('\n');
  }
  if (slot.status !== 'active') return '';
  return getPromptLanguage() === 'en'
    ? buildTargetSystemPromptSectionEn(slot.plan)
    : buildTargetSystemPromptSectionZh(slot.plan);
}

function buildTargetSystemPromptSectionZh(plan: TargetPlan): string {
  const targetText = plan.target || '(未指定)';
  return [
    '<target_mission>',
    '你在 Target Mission — 围绕一个目标深度长跑. loop 只在 check_target_done(done=true) 或 abandon_target 时退出.',
    '',
    `目标: ${targetText}`,
    '',
    ...(plan.phase === 'research' ? [
      '【当前阶段 · 调研对标】拍战略块之前先做功课, 但**把调研派给子 agent**别堆进主上下文: 调 agent({type:\'research\', task:\'对标主流 + 盘点本 repo + gap 分析, 写详实 REQUIREMENTS.md 到 ./REQUIREMENTS.md\'})。它隔离探索, 只回摘要+路径。回来后 readfile REQUIREMENTS.md 再 plan_target 照文档拆块。别凭空拍 plan, 也别自己在这个上下文里读几十个文件。',
      '',
    ] : []),
    '两层规划, 按目标规模自适应:',
    '· 战略层 plan_target: 有 REQUIREMENTS.md/spec 时【对齐它的模块结构】—— 大致一个模块一块(大规格拆出几十块), 别揉成几个粗块(如"总账+应收应付+审计"塞一块); 每块标注覆盖哪些节(可追溯), 进度才细、模块才能独立建/验/以后并发. 每块一句话 + 成功判据 + status, 永远一块 in_progress, 攻完标 completed 起下一块.',
    '· 战术层 update_plan: 当前正在攻的那一块, 拆成能一轮做完的细步逐个做; 这块攻完就刷新成下一块的细步.',
    '· 规模自适应: 几百项需求 → plan_target 拆块 + 逐块 update_plan; 十几步的中小目标 → 直接 update_plan; trivial → 不用 plan. 目标附了 spec/doc 就照文档做.',
    '· 完成由目标本身是否达成决定 —— 逐块对着真实证据核, 跟 plan 打没打勾无关.',
    '</target_mission>',
  ].join('\n');
}

function buildTargetSystemPromptSectionEn(plan: TargetPlan): string {
  const targetText = plan.target || '(unspecified)';
  return [
    '<target_mission>',
    'You are in Target Mission — a deep long-run around one objective. The loop exits only on check_target_done(done=true) or abandon_target.',
    '',
    `Objective: ${targetText}`,
    '',
    ...(plan.phase === 'research' ? [
      '[Current phase · RESEARCH] Do the homework before carving strategy blocks, but DELEGATE the research to a sub-agent instead of piling it into this context: call agent({type:\'research\', task:\'survey mainstream + this repo + gap analysis, write a detailed REQUIREMENTS.md at ./REQUIREMENTS.md\'}). It explores in isolation and returns only a summary + path. Then readfile REQUIREMENTS.md and call plan_target to carve blocks from the doc. Don\'t guess the plan, and don\'t read dozens of files inline here.',
      '',
    ] : []),
    'Two-layer planning, adaptive to scale:',
    '· Strategy layer, plan_target: for a large (multi-subsystem) objective, carve it into dozens of strategy blocks — each a one-liner + success criterion + status. Keep exactly one in_progress; mark completed and open the next as you finish. If the user gave a checklist, turn it into blocks; if not, carve them yourself.',
    '· Tactics layer, update_plan: for the block you are attacking now, break it into steps you can finish this turn and do them one by one; refresh it to the next block once this one lands.',
    '· Scale-adaptive: hundreds of requirements → plan_target blocks + update_plan per block; a dozen-step goal → update_plan directly; trivial → no plan. If the objective points to a spec/doc, follow it.',
    '· Done is decided by whether the objective itself is met — checked block by block against real evidence, not by whether the plan is ticked.',
    '</target_mission>',
  ].join('\n');
}

// ==================== Tool Definitions ====================

export const activateTargetTool: Tool = {
  name: 'activate_target',
  description: [
    'Enter Target Mission mode — Neox\'s long-run mode. **USER-CONSENT GATED: only the user can',
    'open this door.** You may call this ONLY when the user\'s own words explicitly ask for a',
    'target / mission / long-run — task size alone NEVER qualifies, no matter how large.',
    '',
    '## What it costs',
    'Target Mission keeps the loop running iteration after iteration until you actively declare done',
    'via check_target_done. It significantly increases token spend (sustained context, mandatory',
    'per-turn check_target_done overhead, strategy/plan tools). The user pays for those tokens.',
    'Wrong activation on a normal task wastes real money and clogs the conversation with target',
    'ceremony that adds no value. Treat activation like a commitment, not a helpful default.',
    '',
    '## DO NOT CALL when (default assumption — most sessions fall here):',
    '  - The task can plausibly be finished in **< 20 tool calls** (bug fix, small feature, refactor',
    '    of one file, explaining code, running tests, small config change). Just do the work.',
    '  - The user\'s message is a single-shot request ("修一下 X", "加个 Y", "跑一下 test",',
    '    "解释这段代码", "为什么报错", "这块怎么改"). No matter how complex the underlying',
    '    codebase, a single request is normal chat until it visibly outgrows normal chat.',
    '  - The user did not use the words target / mission / 长跑 / 大工程 / 全面 / 系统性 / 从头 /',
    '    "帮我搞个大" / "一次性做完" or similar deep-commitment framing.',
    '  - You have plausible doubt. **Doubt = do not activate.** The user can start it themselves',
    '    with /target if they want it.',
    '  - You are already in Target Mission (cannot re-activate).',
    '',
    '## Only call when ALL of these are true:',
    '  1. The user EXPLICITLY asked for it in their own words — "开个 target", "start a mission",',
    '     "长跑做完", "跑一个 target", "/target ..." or equivalent. This is a hard gate:',
    '     scope/complexity/multi-hour framing WITHOUT these words = normal chat + update_plan.',
    '     Inferring consent from task size is exactly the failure mode this gate exists to stop.',
    '  2. Task scope genuinely warrants it — realistically 30+ tool calls or spans multiple',
    '     subsystems. If the user asked for target on a small task, suggest normal chat instead.',
    '  3. Success criteria are stated or obvious — you know how to declare done.',
    '',
    '## If you\'re on the fence:',
    'Use ask_user first. Wording: "This looks like it may run long — switch to Target Mission',
    '(higher token cost, loop persists to completion) or handle it in normal chat?" Never activate',
    'silently to be "helpful"; the mode change is user-visible and costly.',
    '',
    '## If cleared to activate:',
    '  1. Call activate_target with a precise target statement + rationale (why this warrants',
    '     Target vs normal chat — reference the scope signal).',
    '  2. Gauge scale: large / multi-subsystem → plan_target strategy blocks, then per-block',
    '     update_plan. Medium → update_plan only. Small → don\'t plan.',
    '  3. Call check_target_done at every turn end.',
    '',
    'The tool switches loop mode only; it does not commit changes. That safety does NOT make it',
    'cheap — the sustained loop it starts is what costs.',
  ].join(' '),
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Restate the target you are pursuing, in one clear sentence.',
      },
      rationale: {
        type: 'string',
        description: 'Why this task warrants Target Mission (not simple chat). Be brief but specific.',
      },
      needs_research: {
        type: 'boolean',
        description: 'true if the objective is large / references mainstream systems / benefits from researching prior art FIRST — web_search the mainstream, survey the current repo, gap analysis, write a REQUIREMENTS.md — BEFORE carving strategy blocks. false for a self-contained goal you can start immediately. When unsure and the goal is big, prefer true.',
      },
      user_authorization_quote: {
        type: 'string',
        description:
          'Quote the user\'s OWN WORDS that authorize a long autonomous run — verbatim, copied from their message, in their language. '
          + 'You judge whether the words mean "keep going on your own until this is done"; we only verify the user actually said them. '
          + 'Task size is never authorization. If they never said anything like it, do not call this tool.',
      },
    },
    required: ['target', 'rationale'],
  },

  async function(args: any): Promise<string> {
    const target: string = String(args?.target ?? '').trim();
    const rationale: string = String(args?.rationale ?? '').trim();
    const needsResearch = Boolean(args?.needs_research);

    if (!target) {
      return JSON.stringify({ error: 'target is required.' });
    }
    if (!rationale) {
      return JSON.stringify({ error: 'rationale is required — explain why this needs Target Mission.' });
    }

    const sid = currentSid();
    if (!hasTargetConsent(sid)) {
      const quote = String(args?.user_authorization_quote ?? '').trim();
      if (quote && userReallySaid(sid, quote)) {
        grantTargetConsent(sid!);
      } else {
        return JSON.stringify({
          error: 'Target Mission NOT activated.',
          why: quote
            ? 'The words you quoted are not found in the user\'s recent messages. Never paraphrase or invent authorization.'
            : 'Long-run mode burns tokens continuously; only the user opens this door. Task size alone never qualifies.',
          whatToDo: 'Do the work as a normal task. If the user genuinely asked to keep going on their own, call this tool again '
            + 'with user_authorization_quote set to their exact words. Otherwise tell them (in their language) they can say '
            + '"设定目标 …" / send /target <goal> to start a long run.',
        });
      }
    }

    {
      const preSlot = currentSlot();
      if (preSlot?.status === 'active') {
        return JSON.stringify({
          error: 'A target is already active. No re-activation needed. Continue working or call check_target_done.',
          currentTarget: preSlot.plan?.target,
        });
      }
    }

    activateTargetFromCommand(target, undefined, needsResearch ? 'research' : 'execute');
    // 保留 rationale 供 UI / logs 显示 (activateTargetFromCommand 只写 target)
    {
      const postSlot = currentSlot();
      if (postSlot?.plan) {
        postSlot.plan.rationale = rationale;
      }
    }

    const message = needsResearch
      ? [
          'Target Mission activated · RESEARCH phase.',
          'Do NOT carve strategy blocks (plan_target) yet — a plan guessed without homework is exactly what to avoid.',
          'DELEGATE the research to a sub-agent (keep the heavy exploration OUT of your context):',
          'call agent({ type: "research", task: "survey the mainstream/reference systems + this repo (real stack, code, integration points) + gap analysis, then write a detailed REQUIREMENTS.md at ./REQUIREMENTS.md" }).',
          'It explores in an isolated context and returns only a short summary + the REQUIREMENTS.md path — the doc is where a large plan lives, and it stays a file (you readfile it, never carry it inline).',
          'THEN: readfile REQUIREMENTS.md, call plan_target to carve strategy blocks from the doc (covering all its areas), and execute block by block with update_plan.',
          'Call check_target_done at every turn end. The loop will not exit until you confirm done=true or abandon_target.',
        ].join(' ')
      : [
          'Target Mission activated.',
          'Gauge scale: large / multi-subsystem → carve strategy blocks with plan_target then attack each with a fine update_plan; smaller → just update_plan.',
          'Call check_target_done at every turn end. The loop will not exit until you confirm done=true or abandon_target.',
        ].join(' ');
    return JSON.stringify({
      ok: true,
      status: 'active',
      phase: needsResearch ? 'research' : 'execute',
      target,
      message,
    });
  },
};

export const planTargetTool: Tool = {
  name: 'plan_target',
  description: [
    'Carve the Target Mission objective into strategy blocks — the STRATEGY layer of a two-layer plan.',
    'plan_target holds the blocks; update_plan holds the fine steps inside the block you are attacking now.',
    '',
    'GRANULARITY (important): when a REQUIREMENTS.md / spec exists, MIRROR its module structure —',
    'roughly one block per major module / section (so a big spec yields dozens of blocks), NOT a handful of coarse buckets.',
    'Do NOT merge unrelated modules into one block (e.g. don\'t collapse "general ledger" + "AR/AP" + "audit" into a single block).',
    'Fine-grained blocks make progress readable (N/M) and let modules be built / verified — and later run — independently.',
    'Each block\'s description should name which REQUIREMENTS section(s) it covers, so coverage is traceable end to end.',
    'Use it for large / multi-subsystem objectives; skip it for small goals (a dozen steps or fewer) — just use update_plan.',
    '',
    'Call this ONCE to lay out the initial block list. After that, **never re-send the whole list** —',
    'use plan_block(start/complete/add/drop) to move one block at a time. With hundreds of requirements,',
    'restating everything costs thousands of output tokens per call and risks silently dropping blocks.',
    'A later plan_target call is only for a genuine re-plan (the whole map changed), and it replaces everything.',
    'The full list is written to a markdown plan file (planFile in the reply) — readfile it when you need the whole picture.',
    'The block list is the map; the natural-language objective still decides overall done.',
  ].join(' '),
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'The overall target you are pursuing (restate it clearly, one paragraph).',
      },
      sub_missions: {
        type: 'array',
        description: 'Ordered list of strategy blocks (dozens for a large goal). Each block is a self-contained chunk of the objective, attacked one at a time.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short identifier, e.g. "b1".' },
            description: { type: 'string', description: 'What this block accomplishes.' },
            success_criteria: { type: 'string', description: 'How you will know this block is done (verifiable, not vibes).' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Block status. Keep exactly one in_progress; mark completed only with real evidence. Defaults to pending.' },
          },
          required: ['id', 'description'],
        },
      },
      rationale: {
        type: 'string',
        description: 'Why this decomposition into blocks.',
      },
    },
    required: ['target', 'sub_missions'],
  },

  async function(args: any): Promise<string> {
    const target: string = String(args?.target ?? '').trim();
    const rationale: string | undefined = args?.rationale ? String(args.rationale) : undefined;
    const rawBlocks = Array.isArray(args?.sub_missions) ? args.sub_missions : [];

    if (!target) {
      return JSON.stringify({ error: 'target is required' });
    }
    if (rawBlocks.length === 0) {
      return JSON.stringify({ error: 'sub_missions must have at least one strategy block' });
    }

    const sid = currentSid();
    const slot = getSlot(sid);
    // plan_target 只在 target active 时可调. off 时的错误必须够强, 否则模型会按上一轮
    if (!slot || slot.status !== 'active') {
      const st = slot?.status ?? 'off';
      if (st === 'paused') {
        return JSON.stringify({
          error: `TARGET MISSION PAUSED (not ended) — the plan is preserved. If the user's latest message explicitly asks to continue/resume, call continue_target FIRST, then retry this call. Do NOT tell the user to type /target continue. If the user did not ask to resume, leave the target paused and answer their actual request.`,
          terminal: false,
          currentStatus: st,
        });
      }
      const isTerminal = st === 'off' || st === 'abandoned'
        || st === 'satisfied' || st === 'expired';
      return JSON.stringify({
        error: `TARGET MISSION ENDED · current status = ${st}. Any prior sub-mission plan (b1/b2/...) is STALE — do NOT reissue plan_target or check_target_done. Stop attempting to continue the previous mission from memory. If the user still wants this work, they will explicitly ask you to reactivate via /target <goal>; only then may you plan again. For now, respond to the user's latest actual request directly instead of resuming an ended mission.`,
        terminal: isTerminal,
        currentStatus: st,
      });
    }

    // 保留原 createdAt (激活时间戳) 和 maxRunTimeMs (P1.4 ceiling), plan_target 只换战略块清单.
    const prevCreatedAt = slot.plan?.createdAt ?? Date.now();
    const prevMaxRunTime = slot.plan?.maxRunTimeMs;

    // 全量替换战略块; status 缺省 pending (agent 每次带全量 status, 跟 update_plan 同款语义).
    const blocks: SubMission[] = rawBlocks.map((sm: any, i: number) => ({
      id: String(sm.id || `b${i + 1}`),
      description: String(sm.description || ''),
      success_criteria: sm.success_criteria ? String(sm.success_criteria) : undefined,
      status: sm.status === 'in_progress' || sm.status === 'completed' ? sm.status : 'pending',
    }));

    const blank = blocks.filter((b) => !b.description.trim());
    if (blank.length > 0) {
      return JSON.stringify({
        error: `${blank.length} of ${blocks.length} block(s) have an empty description.`,
        blankIds: blank.map((b) => b.id).slice(0, 20),
        why: 'The description is what the user reads in the plan file, and what you read back when you need to re-orient. A bare id like "b7" carries no information.',
        whatToDo: 'Resend plan_target with a real one-line description for every block (what it delivers).',
      });
    }

    slot.plan = {
      target,
      rationale,
      sub_missions: blocks,
      createdAt: prevCreatedAt,
      maxRunTimeMs: prevMaxRunTime,
      // 拆出战略块 = 研究 + 规划完成 → 进入执行阶段 (研究先行状态机 research → execute).
      phase: 'execute',
    };

    if (onTargetChange) onTargetChange(slot.status, slot.plan);
    persistTargetToDb(sid);

    const done = blocks.filter((b) => b.status === 'completed').length;
    const active = blocks.find((b) => b.status === 'in_progress');
    const next = active
      ? `Now attacking "${active.description}" — break it into fine steps with update_plan and execute.`
      : 'Mark the block you start next as in_progress, then break it down with update_plan.';
    /* 投影一份 markdown 给人看 —— 几百个块时它才是"计划全貌"的载体, context 里不放全量 */
    const planPath = await persistTargetPlanFile(sid, slot.plan);
    return JSON.stringify({
      ok: true,
      plan_recorded: true,
      target,
      block_count: blocks.length,
      completed: done,
      ...planSummary(slot.plan, planPath),
      message: `Strategy blocks recorded (${done}/${blocks.length} done). ${next} `
        + 'From now on use plan_block(start/complete/add/drop) for progress — do NOT re-send the whole list. '
        + 'Call check_target_done at every turn end.',
    });
  },
};


export const planBlockTool: Tool = {
  name: 'plan_block',
  description: [
    'Update ONE strategy block incrementally. Use this for every progress update after the initial plan_target.',
    '**Never re-send the whole block list** — with hundreds of requirements that is thousands of wasted output',
    'tokens per call, and every restatement risks silently dropping or mangling blocks.',
    '',
    'ops:',
    '  · start(id)              — mark it in_progress (keep exactly one in_progress)',
    '  · complete(id, evidence) — mark it completed; evidence should be concrete (tests passing, file written, endpoint responding)',
    '  · add(blocks)            — append newly discovered work; the plan can grow to hundreds of blocks over time',
    '  · drop(id, why)          — remove a block that is genuinely no longer needed (leaves a trace in the reply)',
    '',
    'The full list lives in the plan file (planFile in the reply) — readfile it when you need the whole picture.',
    'This call returns only a summary (N/M + current + next few), never the full list.',
  ].join(' '),
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  parameters: {
    type: 'object' as const,
    properties: {
      op: { type: 'string', enum: ['start', 'complete', 'add', 'drop'], description: 'What to do.' },
      id: { type: 'string', description: 'Block id — required for start / complete / drop.' },
      evidence: { type: 'string', description: 'For complete: the concrete evidence this block is really done.' },
      why: { type: 'string', description: 'For drop: why this block is no longer needed.' },
      blocks: {
        type: 'array',
        description: 'For add: the new blocks to append.',
        items: {
          type: 'object' as const,
          properties: {
            description: { type: 'string', description: 'What this block delivers.' },
            success_criteria: { type: 'string', description: 'How we know it is done.' },
          },
          required: ['description'],
        },
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
  async function(args: any): Promise<string> {
    const op = String(args?.op ?? '');
    const sid = currentSid();
    const slot = getSlot(sid);
    if (!slot || slot.status !== 'active') {
      return JSON.stringify({
        error: `Target is not active (status = ${slot?.status ?? 'off'}). plan_block only works inside an active Target Mission.`,
        currentStatus: slot?.status ?? 'off',
      });
    }
    const plan = slot.plan;
    if (!plan || plan.sub_missions.length === 0) {
      return JSON.stringify({ error: 'No strategy blocks yet — call plan_target once to lay them out first.' });
    }

    const find = (id: string): SubMission | undefined => plan.sub_missions.find((b) => b.id === id);

    if (op === 'add') {
      const raw = Array.isArray(args?.blocks) ? args.blocks : [];
      if (raw.length === 0) return JSON.stringify({ error: 'add needs at least one block.' });
      /* id 顺着现有最大编号往后排, 不跟已有的撞 */
      let n = plan.sub_missions.length;
      const added: SubMission[] = raw.map((b: any) => {
        n += 1;
        return {
          id: `b${n}`,
          description: String(b?.description ?? '').trim(),
          success_criteria: b?.success_criteria ? String(b.success_criteria) : undefined,
          status: 'pending' as const,
        };
      });
      const blankAdds = added.filter((b: SubMission) => !b.description.trim());
      if (blankAdds.length > 0) {
        /* 静默过滤掉会让模型以为加成功了 —— 明确报错, 它才知道要补描述 */
        return JSON.stringify({
          error: `${blankAdds.length} of ${added.length} new block(s) have an empty description.`,
          whatToDo: 'Every block needs a one-line description of what it delivers — that is what shows up in the plan file.',
        });
      }
      plan.sub_missions.push(...added);
      const planPath = await persistTargetPlanFile(sid, plan);
      if (onTargetChange) onTargetChange(slot.status, plan);
      persistTargetToDb(sid);
      return JSON.stringify({ ok: true, added: added.map((b) => b.id), ...planSummary(plan, planPath) });
    }

    const id = String(args?.id ?? '').trim();
    if (!id) return JSON.stringify({ error: `${op} needs an id.` });
    const block = find(id);
    if (!block) {
      return JSON.stringify({
        error: `No block with id "${id}".`,
        hint: 'Ids look like b1, b2, … — readfile the plan file to see the current list.',
        ...planSummary(plan),
      });
    }

    if (op === 'start') {
      /* 同时只允许一个 in_progress —— 上一个还开着就先把它放回 pending,
       * 免得计划里出现两个"正在做"让进度失真。 */
      for (const b of plan.sub_missions) {
        if (b.status === 'in_progress' && b.id !== id) b.status = 'pending';
      }
      block.status = 'in_progress';
    } else if (op === 'complete') {
      const evidence = String(args?.evidence ?? '').trim();
      if (!evidence) {
        return JSON.stringify({
          error: 'complete needs concrete evidence — what actually proves this block is done?',
          hint: 'e.g. "12 tests green in test/orders.test.ts", "POST /api/orders returns 201", not "looks done".',
        });
      }
      block.status = 'completed';
      block.success_criteria = block.success_criteria
        ? `${block.success_criteria} · 证据: ${evidence.slice(0, 200)}`
        : `证据: ${evidence.slice(0, 200)}`;
    } else if (op === 'drop') {
      const why = String(args?.why ?? '').trim();
      if (!why) return JSON.stringify({ error: 'drop needs a why — dropping work silently is exactly what we are preventing.' });
      plan.sub_missions = plan.sub_missions.filter((b) => b.id !== id);
    } else {
      return JSON.stringify({ error: `unknown op "${op}" — use start / complete / add / drop.` });
    }

    const planPath = await persistTargetPlanFile(sid, plan);
    if (onTargetChange) onTargetChange(slot.status, plan);
    persistTargetToDb(sid);
    return JSON.stringify({ ok: true, op, id, ...planSummary(plan, planPath) });
  },
};

export const checkTargetDoneTool: Tool = {
  name: 'check_target_done',
  description: [
    'Declare whether the Target Mission objective is done.',
    'You MUST call this before ending a turn while Target Mission is active.',
    'Judge from the natural-language objective itself — not from any plan you may have kept.',
    'Only pass done=true if the objective is genuinely met and you have concrete evidence for it.',
    'Not sure / partial / close enough / plan ticked → done=false with a short reason; keep working.',
  ].join(' '),
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      done: {
        type: 'boolean',
        description: 'true if the target is fully achieved; false otherwise.',
      },
      reason: {
        type: 'string',
        description: 'Short justification: what was achieved (if done=true) or what still remains (if done=false).',
      },
    },
    required: ['done', 'reason'],
  },

  async function(args: any): Promise<string> {
    const done = Boolean(args?.done);
    const reason = String(args?.reason ?? '').trim() || (done ? 'Target achieved.' : 'Not yet.');

    const sid = currentSid();
    const slot = getSlot(sid);
    if (!slot || slot.status !== 'active') {
      const st = slot?.status ?? 'off';
      if (st === 'paused') {
        // paused ≠ ended — 见 plan_target 同款分支
        return JSON.stringify({
          error: `TARGET MISSION PAUSED (not ended). If the user's latest message explicitly asks to continue/resume, call continue_target FIRST — do NOT tell the user to type /target continue. Otherwise leave it paused.`,
          currentStatus: st,
        });
      }
      // 见 plan_target 同款注释: 强错误终止模型对旧 mission 的惯性刷取.
      return JSON.stringify({
        error: `TARGET MISSION ENDED · current status = ${st}. Do NOT keep calling check_target_done or plan_target. The earlier mission has already been closed (satisfied / abandoned / expired / never activated in this thread). Stop trying to continue it from memory — reply to the user's actual latest message instead.`,
        currentStatus: st,
      });
    }

    // P1.4 time ceiling — check_target_done 前判超时, 超了转 expired 直接返回.
    if (checkAndMarkExpiredIfOverdue()) {
      return JSON.stringify({
        ok: true,
        done: false,
        expired: true,
        reason: 'Target exceeded configured max_run_time. Auto-transitioned to expired.',
        status: 'expired',
        message: 'Target expired due to time ceiling. Loop will exit. Summarize progress for the user.',
      });
    }

    slot.lastDoneCheck = { done, reason, ts: Date.now() };

    if (done) {
      const unfinished = (slot.plan?.sub_missions ?? []).filter((m) => m.status !== 'completed');
      if (unfinished.length > 0) {
        slot.lastDoneCheck = { done: false, reason: `blocked: ${unfinished.length} block(s) still open`, ts: Date.now() };
        return JSON.stringify({
          ok: false,
          done: false,
          error: `Cannot declare done — the plan still has ${unfinished.length} block(s) not marked completed.`,
          openBlocks: unfinished.slice(0, 12).map((m) => ({ id: m.id, status: m.status, description: m.description.slice(0, 100) })),
          whatToDo: [
            'Keep working: pick the next open block, mark it in_progress via plan_target, finish it with real evidence, mark it completed.',
            'If a block is genuinely no longer needed, call plan_target with the full list and drop it (or mark it completed with the evidence that made it unnecessary) — say so explicitly, do not silently skip.',
            'Then call check_target_done again.',
          ].join(' '),
        });
      }
      slot.status = 'satisfied';
    }
    if (onTargetChange) onTargetChange(slot.status, slot.plan);
    persistTargetToDb(sid);

    if (onDoneChecked) onDoneChecked(done, reason);

    // P1.7: done=false 时返回长 audit — 强制 model 每轮 self-audit,
    //   防止只调 check_done(false) 空转 / 复述 / 迷航.
    let message: string;
    if (done) {
      message = 'Target marked as satisfied. You may now end the turn (no need to call more tools this turn unless you want to give a final summary).';
    } else {
      const elapsedMs = slot.plan ? Date.now() - slot.plan.createdAt : 0;
      const elapsedH = Math.floor(elapsedMs / 3_600_000);
      const elapsedM = Math.floor((elapsedMs % 3_600_000) / 60_000);
      const elapsedStr = elapsedH > 0 ? `${elapsedH}h ${elapsedM}m` : `${elapsedM}m`;
      const isEn = getPromptLanguage() === 'en';
      message = isEn
        ? `Target still active. Elapsed ${elapsedStr}. Keep working — advance the current strategy block with fine update_plan steps; mark it completed and open the next when it lands. Only call check_target_done(done=true) when every block holds up against real evidence.`
        : `Target 仍在推进. 已运行 ${elapsedStr}. 继续做 — 用 update_plan 拆细步推进当前战略块, 整块攻完就标 completed、起下一块. 每一块都经得起真实证据核验时, 才调 check_target_done(done=true).`;
    }

    return JSON.stringify({
      ok: true,
      done,
      reason,
      status: slot.status,
      message,
    });
  },
};

export const abandonTargetTool: Tool = {
  name: 'abandon_target',
  description: [
    'Abandon the current Target Mission and exit target mode.',
    'Only call this when the target is impossible, invalid, or clearly out of your capability.',
    'Do NOT call abandon just because progress is slow — keep working through check_target_done={done:false}.',
    'After abandon, the loop can exit normally.',
  ].join(' '),
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why abandoning. Be specific — the user will see this.',
      },
    },
    required: ['reason'],
  },

  async function(args: any): Promise<string> {
    const reason = String(args?.reason ?? '').trim() || 'No reason provided.';

    const sid = currentSid();
    const slot = getSlot(sid);
    if (!slot || slot.status === 'off') {
      return JSON.stringify({ error: 'No active target to abandon.' });
    }

    slot.status = 'abandoned';
    slot.abandonReason = reason;
    if (onTargetChange) onTargetChange(slot.status, slot.plan);
    persistTargetToDb(sid);

    return JSON.stringify({
      ok: true,
      status: 'abandoned',
      reason,
      message: 'Target abandoned. You may now end the turn with a brief explanation to the user.',
    });
  },
};

// ==================== P1.3 Pause / Continue Tools ====================

export const pauseTargetTool: Tool = {
  name: 'pause_target',
  description: [
    'Pause the current Target Mission. Use this when you need user clarification / input to proceed,',
    'or a hard external dependency is missing (waiting on a build, someone to test, etc).',
    'The target is preserved (plan / elapsed / history all kept); user resumes via /target continue,',
    'or when the user explicitly asks you to continue in chat, call continue_target yourself.',
    'Do NOT use pause as a soft abandon — if the target itself is wrong, call abandon_target instead.',
    'After calling pause_target, end the turn with a short summary of what you paused on.',
  ].join(' '),
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why pausing. Be specific — what are you waiting for or what does the user need to clarify?',
      },
    },
    required: ['reason'],
  },
  async function(args: any): Promise<string> {
    const reason = String(args?.reason ?? '').trim() || 'No reason provided.';
    const st = getTargetStatus();
    if (st !== 'active') {
      return JSON.stringify({ error: `pause_target called but status is ${st}, not active.` });
    }
    pauseTargetMission(reason);
    return JSON.stringify({
      ok: true,
      status: 'paused',
      reason,
      message: 'Target paused. Loop will exit after this turn. User can resume via /target continue; if the user later asks you to continue in chat, call continue_target.',
    });
  },
};

export const continueTargetTool: Tool = {
  name: 'continue_target',
  description: [
    'Resume a paused Target Mission. ONLY call this when the user has EXPLICITLY asked to continue/resume',
    'in their message ("继续", "continue", "resume", etc.) — their message IS the consent.',
    'NEVER call this on your own initiative: a paused target usually means the user chose to pause it,',
    'or you paused it waiting for something; resuming without an explicit user ask overrides their control.',
    'If the user asked you to continue and the target is paused, call this FIRST, then proceed with the',
    'next in_progress block — do NOT tell the user to type /target continue themselves.',
  ].join(' '),
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: {},
  },
  async function(): Promise<string> {
    const st = getTargetStatus();
    if (st !== 'paused') {
      return JSON.stringify({ error: `continue_target called but status is ${st}, not paused.` });
    }
    continueTargetMission();
    return JSON.stringify({
      ok: true,
      status: 'active',
      message: 'Target resumed. Proceed with the next in_progress block immediately — the loop will keep running after this turn.',
    });
  },
};

// ==================== Introspection (for logs / UI) ====================

export function getLastDoneCheck(sid?: string | null): { done: boolean; reason: string; ts: number } | null {
  return getSlot(sid ?? currentSid())?.lastDoneCheck ?? null;
}

export function getAbandonReason(sid?: string | null): string | null {
  return getSlot(sid ?? currentSid())?.abandonReason ?? null;
}
