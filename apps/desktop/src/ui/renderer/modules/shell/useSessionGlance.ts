/* 一批会话「现在什么样」—— 主进程 session:glance (electron/ipc/sessionGlance.ts) 的渲染侧钩子。
 * 工作台卡片和全景墙共用; ids 变了就补拉, 窗口回到前台 / 每 20 秒刷新一次 (等你的状态会变)。 */
import { useEffect, useState } from 'react';

export interface SessionGlance {
  waiting: { kind: 'ask' | 'approval' | 'question'; text: string } | null;
  activity: string;
  lastLine: string;
  lastTs: number;
  /** 最近做出来的成品 (最多 3 个, 新的在前); 老主进程没有这个字段 */
  outputs?: Array<{ path: string; ext: string }>;
}

export function useSessionGlance(ids: readonly string[], enabled = true, intervalMs = 20_000): Record<string, SessionGlance> {
  const [map, setMap] = useState<Record<string, SessionGlance>>({});
  const key = ids.join('|');
  useEffect(() => {
    if (!enabled || ids.length === 0) return;
    let alive = true;
    const load = async () => {
      const api = (window as unknown as { neox?: Record<string, any> }).neox;
      if (typeof api?.sessionGlance !== 'function') return;
      const r = await api.sessionGlance(ids).catch(() => null);
      if (alive && r) setMap((prev) => ({ ...prev, ...r }));
    };
    void load();
    const t = window.setInterval(() => { void load(); }, intervalMs);
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.clearInterval(t); window.removeEventListener('focus', onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, intervalMs]);
  return map;
}
