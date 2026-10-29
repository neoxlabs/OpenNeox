
import { useSyncExternalStore } from 'react';

/** 用户能做的一次修改 (UI 层入参, 不含原文 —— 原文由 notePlanEdit 补上) */
export type PlanUserEdit =
  | { kind: 'skip'; index: number }
  | { kind: 'focus'; index: number }
  | { kind: 'rename'; index: number; title: string };

/** 记下来的一条修改; `text` = 记录当时那一步的原文 */
export interface PlanEditRecord {
  kind: PlanUserEdit['kind'];
  index: number;
  text: string;
  title?: string;
}

export interface PlanStepLike {
  id?: string;
  content?: string;
  status?: string;
}

const EMPTY: readonly PlanEditRecord[] = Object.freeze([]);
const editsBySession = new Map<string, PlanEditRecord[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 当前会话累积的修改 (没有就是同一份空数组, 保持引用稳定给 useSyncExternalStore) */
export function getPlanEdits(sessionId?: string | null): readonly PlanEditRecord[] {
  if (!sessionId) return EMPTY;
  return editsBySession.get(sessionId) ?? EMPTY;
}

/**
 * 记一条修改并通知订阅者 —— 同 kind 同下标只留最新的一条
 * (连着点两次「跳过」不该叠两条)。
 */
export function notePlanEdit(sessionId: string, edit: PlanUserEdit, stepText: string): PlanEditRecord {
  const cur = editsBySession.get(sessionId) ?? [];
  const record: PlanEditRecord = {
    kind: edit.kind,
    index: edit.index,
    text: stepText,
    ...(edit.kind === 'rename' ? { title: edit.title } : {}),
  };
  const next = cur.filter((r) => !(r.kind === edit.kind && r.index === edit.index));
  next.push(record);
  editsBySession.set(sessionId, next);
  emit();
  return record;
}

/** 计划整体换掉 (新任务 / 用户手动清) 时把修改一起清掉 */
export function clearPlanEdits(sessionId: string): void {
  if (!editsBySession.delete(sessionId)) return;
  emit();
}

/** 测试用 —— 模块级 Map 得在用例之间清干净 */
export function __resetPlanEditsForTesting(): void {
  editsBySession.clear();
  emit();
}

export function usePlanEdits(sessionId?: string | null): readonly PlanEditRecord[] {
  return useSyncExternalStore(
    subscribe,
    () => getPlanEdits(sessionId),
    () => getPlanEdits(sessionId),
  );
}

const COMPLETED = new Set(['completed', 'done']);
const SKIPPED = new Set(['skipped']);

/**
 * 把用户修改合并进一份计划步骤 (纯函数)。
 *
 * 匹配规则: 下标一致 **且** 该下标的原文跟记录时一致。
 *   —— 这是唯一能防「模型重排步骤后, 跳过打到了别的步上」的办法。
 * 顺序: 先改名 (不改状态) → 再 focus → 最后 skip (skip 优先级最高)。
 */
export function mergePlanSteps<T extends PlanStepLike>(
  steps: readonly T[],
  edits: readonly PlanEditRecord[],
): T[] {
  if (!edits.length || !steps.length) return steps as T[];
  const known = new Map<number, Set<string>>();
  for (const r of edits) {
    if (r.index < 0 || r.index >= steps.length) continue;
    const set = known.get(r.index) ?? new Set<string>();
    if (r.text) set.add(r.text);
    if (r.kind === 'rename' && r.title) set.add(r.title);
    known.set(r.index, set);
  }
  const matched = edits.map((r) =>
    known.get(r.index)?.has(steps[r.index]?.content ?? '') === true);

  const out = steps.map((s) => ({ ...s }));

  edits.forEach((r, i) => {
    if (!matched[i] || r.kind !== 'rename' || !r.title) return;
    out[r.index].content = r.title;
  });

  const focusAt = edits.reduce((acc, r, i) => (matched[i] && r.kind === 'focus' ? i : acc), -1);
  if (focusAt >= 0) {
    const target = out[edits[focusAt].index];
    const st = target.status ?? '';
    if (!COMPLETED.has(st) && !SKIPPED.has(st)) {
      for (const s of out) {
        if ((s.status ?? '') === 'in_progress') s.status = 'pending';
      }
      target.status = 'in_progress';
    }
  }

  edits.forEach((r, i) => {
    if (!matched[i] || r.kind !== 'skip') return;
    const target = out[r.index];
    /* 已经做完了就别改成 skipped —— 那会让「做过的活」看起来像「没做」 */
    if (!COMPLETED.has(target.status ?? '')) target.status = 'skipped';
  });

  return out;
}

/**
 * 送给 agent 的那句话 —— 走用户消息 / 插话, 不硬改引擎里的计划。
 * 明确点名「第 N 步」和原文, 模型才接得住。
 */
export function buildPlanEditDirective(edit: PlanEditRecord, isZh: boolean): string {
  const n = edit.index + 1;
  const text = edit.text || '';
  if (edit.kind === 'skip') {
    return isZh
      ? `[计划调整] 我跳过第 ${n} 步「${text}」。请不要再执行这一步, 下一次 update_plan 保持它为 skipped, 已完成的部分照常保留。`
      : `[Plan change] I'm skipping step ${n} "${text}". Don't run that step; keep it marked skipped in the next update_plan and keep the finished work as is.`;
  }
  if (edit.kind === 'focus') {
    return isZh
      ? `[计划调整] 我先做第 ${n} 步「${text}」。请把它标为 in_progress 并从这里开始, 其余步骤按原计划排在后面。`
      : `[Plan change] Do step ${n} "${text}" first. Mark it in_progress and start there; keep the other steps in the original order.`;
  }
  const title = edit.title || '';
  return isZh
    ? `[计划调整] 我要求把第 ${n} 步「${text}」改名为「${title}」。请用新标题更新 update_plan, 内容不变。`
    : `[Plan change] Rename step ${n} from "${text}" to "${title}". Use the new title in the next update_plan; the work itself is unchanged.`;
}
