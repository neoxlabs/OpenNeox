/**
 * useCommand / useCommandShortcut —— React 接入 IDE 平台层的命令系统。
 *
 * 设计目标
 * --------
 * - **从一份 commandId 出发**：键盘快捷键、菜单、命令面板、agent 调用都
 *   走同一个 commands.execute(id)，不再各自硬编码 handler。
 * - **跟现有 useShortcut 共存**：本步只是在它旁边加一条新路径，不删旧的。
 *   迁移可以一个 hook 一个 hook 慢慢做，每次都是局部、可回滚的小改动。
 * - **handler 始终是最新闭包**：用 ref 桥接，避免 useEffect 依赖捕获过时
 *   的 state。这是 React 注册外部回调的标准模式。
 * - **稳定的注册句柄**：register/unregister 跟着组件 mount/unmount，再加
 *   StrictMode 双调用安全（CommandRegistry.register 返回的 unregister 函
 *   数只会清掉自己注册的那一项，重注册不会被前一次 cleanup 误删）。
 *
 * 用法
 * ----
 *
 * 1) 仅注册命令（不绑快捷键，由菜单 / 命令面板触发）：
 *
 * ```tsx
 * useCommand('editor.formatDocument', () => {
 *   editor.format()
 * })
 * ```
 *
 * 2) 注册命令并绑定到 keymap 默认快捷键（90% 场景）：
 *
 * ```tsx
 * useCommandShortcut('find.inFiles', useCallback(() => {
 *   setShowFindDialog(true)
 * }, []))
 * ```
 */

import { useEffect, useRef } from 'react';
import {
  COMMAND_REGISTRY,
  FOCUS_SERVICE,
  type CommandRegistry,
  type FocusScope,
} from '../../../ide/index.js';
import { useService } from './useService.js';
import {
  matchesShortcut,
  type KeymapActionId,
} from '../utils/keymap.js';
import { useBinding } from '../hooks/useKeymap.js';

/** 拿当前作用域的 CommandRegistry 实例 */
export function useCommandRegistry(): CommandRegistry {
  return useService(COMMAND_REGISTRY);
}

/**
 * 注册一个命令到 CommandRegistry，组件卸载时自动反注册。
 *
 * - **id** 全局唯一，约定 'category.action' 形式（'editor.save' / 'find.inFiles'）
 * - **run** 是命令处理函数。它在每次渲染都会变（闭包捕获最新 state），但
 *   ** 实际注册的是一个稳定 wrapper**，wrapper 内部通过 ref 调最新版本。
 *   于是 register/unregister 只在 mount/unmount 跑一次，避免抖动。
 *
 * 失败模式：
 * - 如果同一 id 在多个组件同时被注册 → CommandRegistry.register 抛 "already
 *   registered"。这是程序员错（同一命令应该只有一个 owner），开发模式立刻
 *   暴露。如果业务上确实需要"主备 owner"，下一步可以加 force/replace 选项。
 */
export function useCommand(
  id: string,
  run: () => void | Promise<void>,
  options?: { enabled?: boolean },
): void {
  const registry = useCommandRegistry();
  const enabled = options?.enabled ?? true;

  // ref 桥接：每次渲染都把最新 closure 写到 ref，effect 注册的 wrapper
  // 调用时永远拿最新版本。
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    // enabled=false → 不注册。多 owner 场景 (如多根 FileExplorer 各渲一份)
    // 用它让只有 primary 实例注册, 避免 "already registered" 崩溃。
    if (!enabled) return;
    const unregister = registry.register({
      id,
      handler: async () => {
        await runRef.current();
      },
    });
    return unregister;
  }, [registry, id, enabled]);
}

export function useCommandShortcut(
  actionId: KeymapActionId,
  run: () => void | Promise<void>,
  options?: { enabled?: boolean; scope?: FocusScope },
): void {
  const enabled = options?.enabled ?? true;

  // 1. 注册命令（id 跟 actionId 同名）。enabled=false 时连注册都跳过 —— 让
  //    多 owner 场景 (多根 FileExplorer) 只有 primary 注册, 不撞 "already registered"。
  useCommand(actionId, run, { enabled });

  // 2. 绑定快捷键 —— 跟 useShortcut 同样的实现思路，但 dispatch 走 commands.execute
  const registry = useCommandRegistry();
  const focus = useService(FOCUS_SERVICE);
  const binding = useBinding(actionId);
  const scope = options?.scope;

  useEffect(() => {
    if (!enabled || !binding) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, binding)) return;
      // scoped 命令：检查焦点是否在指定 scope；不在就放过让其他 listener 处理
      if (scope && !focus.isActive(scope)) return;
      e.preventDefault();
      // fire-and-forget：异步命令的错误打日志，不冒泡到 keydown 链路
      registry.execute(actionId).catch((err: unknown) => {
        console.error(`[useCommandShortcut] command "${actionId}" failed:`, err);
      });
    };
    // scoped 用 capture: true → 在编辑器等 default-bubble 监听器之前抢到，
    // 解决 ⌘C/⌘V 在 file tree 和编辑器都绑同一组合的冲突
    const useCapture = Boolean(scope);
    window.addEventListener('keydown', onKeyDown, useCapture);
    return () => window.removeEventListener('keydown', onKeyDown, useCapture);
  }, [registry, focus, actionId, binding, enabled, scope]);
}

/**
 * 把当前组件声明成某个 focus scope 的拥有者。
 *
 * - mount 时：focus.setScope(scope)
 * - unmount 时：focus.clear() —— 等价于 setScope('global')
 * - 同一个 scope 在多个组件 mount 时只有最后一个生效（FocusService 是单值）
 *
 * 用法示例（FileExplorer）：
 * ```tsx
 * useFocusScope('fileTree', hasFocus)
 * ```
 *
 * 第二个参数 active 是可选的"开关"：
 * - 不传 / true → mount 期间一直持有该 scope
 * - false → 不持有（用于"鼠标 hover 时才算"等条件场景）
 *
 * 注意 scope 是单值的：如果两个组件都用 useFocusScope('fileTree')，第二个
 * mount 后第一个会被覆盖，第一个 unmount 时会 clear，把 scope 清成 global
 * 而不是恢复到之前的值。当前 IDE 同一时刻只有一个 file tree、一个编辑器，
 * 这个简化是 OK 的。未来真要做多 file tree 时再扩展为栈式 scope。
 */
export function useFocusScope(scope: FocusScope, active: boolean = true): void {
  const focus = useService(FOCUS_SERVICE);
  useEffect(() => {
    if (!active) return;
    focus.setScope(scope);
    return () => {
      // 只有当我们仍然是当前 scope 时才清，避免覆盖另一个组件的 push
      if (focus.isActive(scope)) {
        focus.clear();
      }
    };
  }, [focus, scope, active]);
}
