/**
 * 卡片展开/折叠状态持久化 Hook
 * 使用 sessionStorage 在会话期间保持卡片的展开/折叠状态
 */

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'neox-card-collapse-states';

// 内存缓存，避免频繁读取 sessionStorage
let stateCache: Record<string, boolean> | null = null;
const listeners = new Set<() => void>();

// 从 sessionStorage 加载状态
function loadStates(): Record<string, boolean> {
  if (stateCache !== null) {
    return stateCache;
  }
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    stateCache = stored ? JSON.parse(stored) : {};
  } catch {
    stateCache = {};
  }
  return stateCache!;
}

// 保存状态到 sessionStorage
function saveStates(states: Record<string, boolean>) {
  stateCache = states;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(states));
  } catch {
    // sessionStorage 可能已满或不可用
  }
  // 通知所有监听者
  listeners.forEach(listener => listener());
}

// 设置单个卡片的状态
function setCardState(cardId: string, collapsed: boolean) {
  const states = loadStates();
  states[cardId] = collapsed;
  saveStates(states);
}

// 获取单个卡片的状态
function getCardState(cardId: string, defaultValue: boolean): boolean {
  const states = loadStates();
  return states[cardId] !== undefined ? states[cardId] : defaultValue;
}

/**
 * 使用卡片折叠状态的 Hook
 * @param cardId 卡片的唯一标识符（通常是 entry.id 或组合键）
 * @param defaultCollapsed 默认是否折叠
 * @returns [collapsed, setCollapsed] 类似 useState 的返回值
 */
export function useCardCollapseState(
  cardId: string,
  defaultCollapsed: boolean
): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(() =>
    getCardState(cardId, defaultCollapsed)
  );

  // 监听其他组件的状态变化（用于多处渲染同一卡片的情况）
  useEffect(() => {
    const handleChange = () => {
      const newState = getCardState(cardId, defaultCollapsed);
      setCollapsedState(newState);
    };

    listeners.add(handleChange);
    return () => {
      listeners.delete(handleChange);
    };
  }, [cardId, defaultCollapsed]);

  const setCollapsed = useCallback((newCollapsed: boolean) => {
    setCollapsedState(newCollapsed);
    setCardState(cardId, newCollapsed);
  }, [cardId]);

  return [collapsed, setCollapsed];
}

/**
 * 清除所有保存的卡片状态（用于新会话或重置）
 */
export function clearCardCollapseStates() {
  stateCache = {};
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * 批量设置卡片状态（用于全部展开/折叠功能）
 */
export function setAllCardsCollapsed(cardIds: string[], collapsed: boolean) {
  const states = loadStates();
  cardIds.forEach(id => {
    states[id] = collapsed;
  });
  saveStates(states);
}
