/**
 * useKeymap — React integration for the keymap system
 *
 * - useKeymapBindings(): subscribes to live binding changes
 * - useShortcut(actionId, handler): register a global keyboard shortcut
 */

import { useEffect, useState, useCallback } from 'react';
import {
  getKeymapBindings,
  subscribeKeymap,
  matchesShortcut,
  type KeymapActionId,
  type KeymapBindings,
} from '../utils/keymap';

/** Get current bindings, re-renders on change */
export function useKeymapBindings(): KeymapBindings {
  const [bindings, setBindings] = useState<KeymapBindings>(() => getKeymapBindings());
  useEffect(() => {
    return subscribeKeymap(() => setBindings({ ...getKeymapBindings() }));
  }, []);
  return bindings;
}

/** Get a single binding string */
export function useBinding(id: KeymapActionId): string {
  const bindings = useKeymapBindings();
  return bindings[id] || '';
}

/**
 * Register a global keyboard shortcut handler.
 * The handler is called when the user's bound shortcut for `actionId` is pressed.
 * Automatically updates if the user remaps the action.
 *
 * @example
 * useShortcut('find.inFiles', useCallback((e) => {
 *   e.preventDefault();
 *   setShowFindDialog(true);
 * }, []));
 */
export function useShortcut(
  actionId: KeymapActionId,
  handler: (e: KeyboardEvent) => void,
  options?: { enabled?: boolean }
): void {
  const binding = useBinding(actionId);
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled || !binding) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, binding)) handler(e);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [binding, handler, enabled]);
}

/**
 * Helper for components that need to imperatively check a shortcut
 * (e.g. inside an existing keydown handler).
 */
export function useShortcutMatcher(): (e: KeyboardEvent | React.KeyboardEvent, id: KeymapActionId) => boolean {
  const bindings = useKeymapBindings();
  return useCallback(
    (e, id) => matchesShortcut(e, bindings[id] || ''),
    [bindings]
  );
}

/**
 * 注册一个有上下文限制的 keyboard shortcut(IDEA when="..." 模式)
 *
 * 跟 useShortcut 区别: 通过 isActive() 谓词决定该快捷键是否生效。
 * 用于解决 Cmd+C/⌘V 在编辑器和文件树都用的冲突 — 文件树版本只在 isActive() 返回 true 时响应。
 *
 * @example
 * const isFileTreeFocused = useFileTreeFocus();
 * useScopedShortcut('file.copy', () => isFileTreeFocused, (e) => {
 *   e.preventDefault();
 *   handleCopy();
 * });
 */
export function useScopedShortcut(
  actionId: KeymapActionId,
  isActive: () => boolean,
  handler: (e: KeyboardEvent) => void,
  options?: { enabled?: boolean }
): void {
  const binding = useBinding(actionId);
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled || !binding) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, binding)) return;
      if (!isActive()) return;
      handler(e);
    };
    // capture: true → 在 editor 拿到事件之前先判断是不是属于 file tree
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [binding, handler, enabled, isActive]);
}
