/**
 * Target 指示 —— 底栏「◎ 目标 3/9 · 42m」的数据源。
 *
 * runtime 每次改 target 状态都会经 bus 发一条完整快照 (type='target_snapshot', 见 core
 * server/main.ts 的 snapshot → bus bridge)。桌面端早就接了; CLI 一直没接, 于是模型自己
 * activate_target 开了长跑, 输入框附近却什么都不显示, 用户不知道自己在目标模式里。
 *
 * 快照是全量的, 丢事件也能靠下一条恢复, 所以这里只存最后一条。
 */
import { useSyncExternalStore } from 'react';

export interface CliTargetSnapshot {
  sessionId: string | null;
  status: 'off' | 'active' | 'paused' | 'completed' | 'abandoned' | 'expired' | string;
  target: string | null;
  subMissionCount: number;
  completedSubMissions: number;
  createdAt: number | null;
  phase?: string;
}

let current: CliTargetSnapshot | null = null;
const listeners = new Set<() => void>();

export function setTargetSnapshot(snap: CliTargetSnapshot | null): void {
  current = snap;
  for (const l of listeners) l();
}

export function getTargetSnapshot(): CliTargetSnapshot | null {
  return current;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useTargetSnapshot(): CliTargetSnapshot | null {
  return useSyncExternalStore(subscribe, getTargetSnapshot, getTargetSnapshot);
}

/** 只有 active / paused 值得在底栏露面; 结束态由时间线里的回执交代。 */
export function isTargetShown(s: CliTargetSnapshot | null): s is CliTargetSnapshot {
  return !!s && (s.status === 'active' || s.status === 'paused');
}

function fmtElapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** 底栏文字: 「◎ 目标 3/9 · 42m」/「◎ 目标已暂停 3/9」 */
export function formatTargetIndicator(s: CliTargetSnapshot, zh: boolean, now = Date.now()): string {
  const paused = s.status === 'paused';
  const head = paused ? (zh ? '目标已暂停' : 'target paused') : (zh ? '目标' : 'target');
  const prog = s.subMissionCount > 0 ? ` ${s.completedSubMissions}/${s.subMissionCount}` : '';
  const elapsed = !paused && s.createdAt ? ` · ${fmtElapsed(Math.max(0, now - s.createdAt))}` : '';
  return `◎ ${head}${prog}${elapsed}`;
}
