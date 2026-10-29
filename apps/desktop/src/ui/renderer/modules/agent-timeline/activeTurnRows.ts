
import type { Row, RowStep } from './timelineRows';
import type { StepIconKind, TimelineMessage } from './types';

/** 逐元素指针比较 —— 判断两个成员列表是不是同一批对象 */
function sameMembers(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 按"第一个成员对象"索引的槽位: 同一批成员 → 复用同一个行对象 */
interface Slot {
  members: readonly unknown[];
  row: Row;
}

function reuse(
  slots: WeakMap<object, Slot>,
  anchor: unknown,
  members: readonly unknown[],
  build: () => Row,
): Row {
  const key = anchor as object | null;
  if (key) {
    const hit = slots.get(key);
    if (hit && sameMembers(hit.members, members)) return hit.row;
  }
  const row = build();
  if (key) slots.set(key, { members, row });
  return row;
}

/* let 而非 const: WeakMap 不可枚举、不可清空, 测试钩子只能整体换新 */
let singleSlots = new WeakMap<object, Row>();
let messageSlots = new WeakMap<object, Row>();
let clusterSlots = new WeakMap<object, Slot>();
let groupSlots = new WeakMap<object, Slot>();
let activitySlots = new WeakMap<object, Slot>();
let labeledSlots = new WeakMap<object, { label: string; row: Row }>();
let activeFlagSlots = new WeakMap<object, { flag: boolean; row: Row }>();

/** 一条 step 的 single 行 —— 内容只由 step 决定 */
export function rowForSingle(step: RowStep): Row {
  const hit = singleSlots.get(step as unknown as object);
  if (hit) return hit;
  const row: Row = { kind: 'single', step };
  singleSlots.set(step as unknown as object, row);
  return row;
}

/** 一条消息的行 —— 内容只由 message 决定 */
export function rowForMessage(message: TimelineMessage): Row {
  const hit = messageSlots.get(message as unknown as object);
  if (hit) return hit;
  const row: Row = { kind: 'message', message };
  messageSlots.set(message as unknown as object, row);
  return row;
}

/* ── HistoryCellRow → TimelineMessage 的复用 ─────────────────────────────────
 * timelineRows 里这条映射是**纯函数**, 但它每帧给同一个 cell 造一个新对象。而 user /
 * assistant 消息常常落在段的开头, 新对象会立刻打断下游 stabilize 的公共前缀短路 ——
 * 后面所有行都跟着重新算签名。按 cell 对象身份缓存, 消息对象就稳定了。 */
let historyMessageSlots = new WeakMap<object, TimelineMessage>();

/** 取上一条为这个 cell 造出来的消息 (没有则 undefined) */
export function cachedHistoryMessage(cellRow: object): TimelineMessage | undefined {
  return historyMessageSlots.get(cellRow);
}

/** 记住这个 cell 造出来的消息 */
export function cacheHistoryMessage(cellRow: object, message: TimelineMessage): TimelineMessage {
  historyMessageSlots.set(cellRow, message);
  return message;
}

/** 聚类行 —— 成员 (items) 全部是同一批对象时复用 */
export function rowForCluster(
  id: string,
  key: string,
  iconKind: StepIconKind,
  head: string,
  items: RowStep[],
): Row {
  return reuse(clusterSlots, items[0], items, () => ({ kind: 'cluster', id, key, iconKind, head, items }));
}

/** 并行组行 —— 成员全部是同一批对象时复用 */
export function rowForGroup(id: string, label: string, items: RowStep[]): Row {
  return reuse(groupSlots, items[0], items, () => ({ kind: 'group', id, label, items }));
}

/** activity 行 —— 子行全部是同一批对象时复用 */
export function rowForActivity(
  id: string,
  rows: Row[],
  opCount: number,
  hasActive: boolean,
): Row {
  return reuse(activitySlots, rows[0], rows, () => ({ kind: 'activity', id, rows, opCount, hasActive }));
}

/**
 * 组行上补数量后的 label —— 键是**组行本身**。
 *
 * 组行现在按身份复用, 于是这个副本每帧都会重建一次; 不缓存的话, 活跃轮里每个并行组
 * 都会让公共前缀断在那儿。label 没变就还原来那个对象。
 */
export function rowWithGroupLabel(row: Row, label: string): Row {
  const hit = labeledSlots.get(row);
  if (hit && hit.label === label) return hit.row;
  const next: Row = { ...row, label } as Row;
  labeledSlots.set(row, { label, row: next });
  return next;
}

/**
 * 合并两个相邻 activity —— 产出**新对象**, 不改入参。
 *
 * 原实现原地 prev.rows.push(...) + prev.opCount +=: 与跨帧复用互斥 (见文件头),
 * 而且会把上一帧已经交给 React 的行改写掉。内容与原实现完全一致。
 */
export function mergeActivityRow(prev: Row, next: Row): Row {
  if (prev.kind !== 'activity' || next.kind !== 'activity') return prev;
  return {
    kind: 'activity',
    id: prev.id,
    rows: prev.rows.concat(next.rows),
    opCount: prev.opCount + next.opCount,
    hasActive: prev.hasActive || next.hasActive,
    ...(prev.inActiveTurn || next.inActiveTurn ? { inActiveTurn: true } : {}),
    ...(prev.summary ? { summary: prev.summary } : {}),
  };
}

/**
 * 补了 inActiveTurn 的 activity 行 —— 键是 (activity 行, 标志)。
 *
 * markActiveTurnActivities 每帧都要给"本轮尾巴那一段"打上点亮标志; 直接 {...r} 会让
 * 这一行每帧换新对象。内容是 (行, 标志) 的函数, 所以同样的组合复用同一个对象。
 */
export function rowWithActiveFlag(row: Row, inActiveTurn: boolean): Row {
  const hit = activeFlagSlots.get(row);
  if (hit && hit.flag === inActiveTurn) return hit.row;
  const next: Row = { ...row, inActiveTurn } as Row;
  activeFlagSlots.set(row, { flag: inActiveTurn, row: next });
  return next;
}

/** 测试用: 清空全部复用槽位 (等价于"冷启动") */
export function __resetActiveTurnRowCacheForTests(): void {
  singleSlots = new WeakMap();
  messageSlots = new WeakMap();
  clusterSlots = new WeakMap();
  groupSlots = new WeakMap();
  activitySlots = new WeakMap();
  labeledSlots = new WeakMap();
  activeFlagSlots = new WeakMap();
  historyMessageSlots = new WeakMap();
}
