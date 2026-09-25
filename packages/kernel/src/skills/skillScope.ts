/**
 * skillScope — 当前活跃 skill 的 ALS context (K2 权限边界基石).
 *
 *   设计模式: shared box + AsyncLocalStorage.
 *
 *   背景: agent 在 turn N 调 use_skill 设 scope; turn N+1 调其它工具时, PermissionManager
 *   要看到这个 scope. 这意味着 scope 必须跨多个独立的 invokeTool / checkPermission 调用持续存在.
 *
 *   方案: Runner 持有一个 `SkillScopeBox`, 它和 Orchestrator 共享同一个 box 引用.
 *   - Runner.invokeTool 把 tool.function 跑在 `runWithSkillScopeBox(box, ...)` 里
 *   - Orchestrator.evaluatePreExecution 把权限检查跑在 `runWithSkillScopeBox(box, ...)` 里
 *   - useSkillTool 在它的 tool.function 调用里 setSkillScope() — 写入的是 box.current
 *   - 下一轮 (新 invokeTool / checkPermission) 进入 `runWithSkillScopeBox(box, ...)`,
 *     getSkillScope() 读 box.current → 拿到 useSkillTool 设的值
 *
 *   并发安全: 每个 Runner/Orchestrator 持自己的 box, 不同 agent (主 / 子 / side) 完全隔离.
 *   ALS 本身只是把 box 引用透到 tool.function 内部, 真值靠 box 对象的可变性传播.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SkillTrustLevel } from './types.js';

export interface ActiveSkillScope {
  skillId: string;
  /** 允许调的 tool 名字列表 (skill metadata.neox.allowedTools). limited 时强制, trusted 时仅 audit. */
  allowedTools: string[];
  trustLevel: SkillTrustLevel;
  /** ms timestamp — 调试用 */
  setAt: number;
}

export interface SkillScopeBox {
  current: ActiveSkillScope | null;
}

const skillScopeStore = new AsyncLocalStorage<SkillScopeBox>();

/** 给 Runner / 测试用 — 创建一个空的 box. 一个 Runner 通常一个 box. */
export function createSkillScopeBox(): SkillScopeBox {
  return { current: null };
}

/** 把 task 跑在以 box 为绑定的 ALS context 里. tool.function 内部调 set/get/clear 都打到这个 box. */
export async function runWithSkillScopeBox<T>(
  box: SkillScopeBox,
  task: () => T | Promise<T>,
): Promise<T> {
  return skillScopeStore.run(box, async () => await task());
}

/** 在当前 ALS context 读 scope. 不在 context 里返 null. */
export function getSkillScope(): ActiveSkillScope | null {
  return skillScopeStore.getStore()?.current ?? null;
}

/** 在当前 ALS context 设 scope. 不在 context 里静默 noop (caller 没准备 box 就别报错). */
export function setSkillScope(scope: Omit<ActiveSkillScope, 'setAt'>): void {
  const box = skillScopeStore.getStore();
  if (!box) return;
  box.current = { ...scope, setAt: Date.now() };
}

/** 在当前 ALS context 清 scope. 不在 context 里静默 noop. */
export function clearSkillScope(): void {
  const box = skillScopeStore.getStore();
  if (box) box.current = null;
}

/** 直接通过 box 引用清 scope (跨 ALS context 调用, 例如 Runner 在 run() 开始时重置). */
export function resetSkillScopeBox(box: SkillScopeBox): void {
  box.current = null;
}
