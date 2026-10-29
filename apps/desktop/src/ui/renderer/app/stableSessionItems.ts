import { useMemo, useRef } from 'react';
import type { SessionItem } from '../modules/shell/Sidebar';

type Rec = Record<string, unknown>;

/** 逐键浅比。SessionItem 没有嵌套对象字段, 所以 === 就是内容相等。 */
function sameSessionItem(a: SessionItem, b: SessionItem): boolean {
  if (a === b) return true;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a as unknown as Rec)[k] !== (b as unknown as Rec)[k]) return false;
  }
  return true;
}

/**
 * 内容没变的条目复用上一次的对象; 整列都没变时连**数组引用**一起复用。
 *
 * 数组引用这一条很关键: 下游注解那层的 useMemo 依赖的就是这个数组, 引用稳住之后
 * 它根本不会重算, 那一层的 `{...it}` 展开也就不会再造新对象。
 */
export function stabilizeSessionItems(
  prev: SessionItem[] | undefined,
  next: SessionItem[],
): SessionItem[] {
  if (!prev || prev.length === 0 || next.length === 0) return next;
  const prevById = new Map<string, SessionItem>();
  for (const it of prev) prevById.set(it.id, it);

  let reusedAll = true;
  const stabilized = next.map((it) => {
    const p = prevById.get(it.id);
    if (p && sameSessionItem(p, it)) return p;
    reusedAll = false;
    return it;
  });

  /* 每一条都复用了、条数和顺序也跟上一次逐位相同 → 整个数组原样交回 */
  if (reusedAll && prev.length === stabilized.length && prev.every((p, i) => p === stabilized[i])) {
    return prev;
  }
  return stabilized;
}

export function annotateSessionItems(
  items: SessionItem[],
  filterMode: 'work' | 'code' | 'pilot',
): SessionItem[] {
  const modeById = new Map(items.map((it) => [it.id, it.agentMode] as const));
  const effectiveMode = (it: SessionItem): 'work' | 'code' | 'pilot' => {
    if (it.agentMode) return it.agentMode;
    if (it.parentSessionId) {
      const parentMode = modeById.get(it.parentSessionId);
      if (parentMode) return parentMode;
    }
    return 'code';
  };
  const annotated = items.map((it) =>
    it.kind === 'image' ? it : { ...it, effectiveMode: effectiveMode(it) },
  );
  return annotated.filter((it) => it.kind === 'image' || it.effectiveMode === filterMode);
}

/** 把一列 SessionItem 的引用稳住 (内容没变就交回上一帧的对象/数组)。 */
export function useStableSessionItems(items: SessionItem[]): SessionItem[] {
  const prevRef = useRef<SessionItem[] | undefined>(undefined);
  const stable = useMemo(() => stabilizeSessionItems(prevRef.current, items), [items]);
  prevRef.current = stable;
  return stable;
}

/** 注解 + 过滤 + 稳定引用 —— 侧栏真正消费的那一列。 */
export function useSidebarSessionItems(
  items: SessionItem[],
  filterMode: 'work' | 'code' | 'pilot',
): SessionItem[] {
  const prevRef = useRef<SessionItem[] | undefined>(undefined);
  const stable = useMemo(
    () => stabilizeSessionItems(
      prevRef.current,
      annotateSessionItems(items, filterMode),
    ),
    [items, filterMode],
  );
  prevRef.current = stable;
  return stable;
}
