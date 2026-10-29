import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEnterTransition } from '../../hooks/useEnterTransition';
import { confirmAsync } from '../../components/confirmEvents';
import { dispatchOpFailed } from '../../components/notifyEvents';
import { useI18n } from '../../hooks/useI18n';
import type { TrackedProcessKind } from '@neoxlabs/platform/platform/processManager.js';

/* ============================================================
 * ServiceManagerBadge · 类 IntelliJ Services 工具窗
 *
 *  · header 右侧 / composer 上方都能挂. 内部组件不关心宿主, 只显示一个 badge.
 *  · badge 显示 running 服务数; 0 个时不渲染 (避免占位空跳).
 *  · 点开 popover 列出所有 background task (running / completed / killed 等),
 *    每条带 pid · 已运行时长 · 命令(截断) · 暂停/恢复/停止控制.
 *  · 每 3s 轮询一次后端 listBackgroundTasks; popover 打开时 1s 高频拉新.
 *
 *  · 后端入口: window.neox.listBackgroundTasks() — 返
 *      Array<{pid, command, cwd, startTime, status, exitCode, background, logFilePath}>
 *  · 暂停/恢复/停止 走已经接好的 window.neox.{pause,resume,kill}BackgroundTask.
 * ============================================================ */

type TaskStatus = 'running' | 'completed' | 'failed' | 'killed';
interface BackgroundTask {
  pid: number;
  command: string;
  cwd: string;
  startTime: string;        // ISO
  status: TaskStatus;
  exitCode?: number;
  endTime?: string;
  background: boolean;
  logFilePath?: string;
  /* free-shell = 用户 Services 面板里开的交互式 zsh, 不算"服务", 不进 badge 计数和列表 */
  kind?: TrackedProcessKind;
}

const POLL_INTERVAL_IDLE_MS = 3000;
const POLL_INTERVAL_OPEN_MS = 1000;

function formatElapsed(startTime: string, endTime?: string): string {
  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

function shortenCmd(cmd: string, max = 60): string {
  const clean = cmd.replace(/^cd\s+\S+\s+&&\s+/, '');   /* 砍掉前缀 "cd /xxx && " */
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

function statusLabel(t: BackgroundTask, zh: boolean): { text: string; cls: string } {
  if (t.status === 'running') return { text: zh ? '运行中' : 'Running', cls: 'is-running' };
  if (t.status === 'killed') return { text: zh ? '已停止' : 'Stopped', cls: 'is-killed' };
  if (t.status === 'failed') return { text: zh ? '失败' : 'Failed', cls: 'is-failed' };
  return { text: t.exitCode === 0 ? (zh ? '已完成' : 'Done') : `exit ${t.exitCode ?? '?'}`, cls: 'is-done' };
}

export const ServiceManagerBadge: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  /* macOS 入场动画 —— 菜单用 pop (只缩放不位移, 位移会跟触发器脱节) */
  const entered = useEnterTransition();
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    const api = (window as any).neox?.listBackgroundTasks;
    if (typeof api !== 'function') return;
    try {
      const raw: BackgroundTask[] = await api();
      /* 过滤 free-shell — 用户的 zsh 交互窗口不算"服务", 既不计入 badge count
       * 也不应出现在管理 popover 里 (会误导用户以为有多个 dev server). */
      const list = raw.filter(t => t.kind !== 'free-shell');
      /* 排序: running 在前, 再按 startTime desc */
      list.sort((a, b) => {
        if (a.status !== b.status) {
          if (a.status === 'running') return -1;
          if (b.status === 'running') return 1;
        }
        return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
      });
      setTasks(list);
    } catch (err) {
      console.warn('[ServiceManager] listBackgroundTasks failed', err);
    }
  }, []);

  /* 轮询 — 打开时高频, 关闭时低频; tab 隐藏时停轮询省功耗 */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'visible') await refresh();
      if (cancelled) return;
      timer = setTimeout(tick, open ? POLL_INTERVAL_OPEN_MS : POLL_INTERVAL_IDLE_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, refresh]);

  /* 点空白关闭 */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  /* ESC 关 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const runningCount = useMemo(() => tasks.filter((t) => t.status === 'running').length, [tasks]);

  /* 没有任何运行中服务时, badge 不渲染 — 避免顶部条永远挂一个零 */
  if (runningCount === 0 && !open) return null;

  const failed = (op: string, err: unknown) => {
    dispatchOpFailed({ op, message: err instanceof Error ? err.message : String(err) });
  };
  const handlePause = async (pid: number) => {
    try {
      await (window as any).neox?.pauseBackgroundTask?.(pid);
    } catch (e) { failed(zh ? '暂停进程' : 'Pause process', e); }
    setTimeout(refresh, 200);
  };
  const handleResume = async (pid: number) => {
    try {
      await (window as any).neox?.resumeBackgroundTask?.(pid);
    } catch (e) { failed(zh ? '继续进程' : 'Resume process', e); }
    setTimeout(refresh, 200);
  };
  const handleKill = async (pid: number, force = false) => {
    /* SIGKILL 强制杀进程不可恢复, 误触即丢任务 → 先确认; SIGTERM(优雅停)豁免。 */
    if (force) {
      const ok = await confirmAsync({
        title: zh ? '强制停止进程?' : 'Force kill process?',
        message: zh ? `将对 PID ${pid} 发送 SIGKILL 强制结束。` : `Sends SIGKILL to PID ${pid}.`,
        description: zh ? '强制停止不会让进程清理收尾, 未保存的工作可能丢失且不可恢复。优先用「停止 (SIGTERM)」。' : 'A force kill skips cleanup — unsaved work may be lost for good. Prefer "Stop (SIGTERM)".',
        variant: 'danger',
        confirmLabel: zh ? '强制停止' : 'Force kill',
      });
      if (!ok) return;
    }
    try {
      await (window as any).neox?.killBackgroundTask?.(pid, force);
    } catch (e) { failed(force ? (zh ? '强制停止进程' : 'Force kill') : (zh ? '停止进程' : 'Stop process'), e); }
    setTimeout(refresh, 500);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`atl-svc__badge${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={zh ? `${runningCount} 个服务运行中 — 点击管理` : `${runningCount} service(s) running — click to manage`}
        aria-label={zh ? `服务管理 (${runningCount} 个运行中)` : `Service manager (${runningCount} running)`}
      >
        <span className="atl-svc__icon" aria-hidden>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="6" rx="1.5" />
            <rect x="3" y="14" width="18" height="6" rx="1.5" />
            <circle cx="7" cy="7" r="0.5" fill="currentColor" />
            <circle cx="7" cy="17" r="0.5" fill="currentColor" />
          </svg>
        </span>
        <span className="atl-svc__count">{runningCount}</span>
      </button>

      {open && (
        <div ref={popRef} className={`atl-svc__pop nx-in nx-in--pop ${entered ? 'is-in' : ''}`} role="dialog" aria-label={zh ? '服务管理' : 'Service manager'}>
          <div className="atl-svc__head">
            <span className="atl-svc__title">{zh ? '服务管理' : 'Services'}</span>
            <span className="atl-svc__hint">{runningCount} 个运行中 · 共 {tasks.length}</span>
            <button type="button" className="atl-svc__refresh" onClick={refresh} title={zh ? '刷新' : 'Refresh'}>↻</button>
          </div>
          <div className="atl-svc__list">
            {tasks.length === 0 && <div className="atl-svc__empty">{zh ? '没有后台任务' : 'No background tasks'}</div>}
            {tasks.map((t) => {
              const lbl = statusLabel(t, zh);
              return (
                <div key={t.pid} className={`atl-svc__row ${lbl.cls}`}>
                  <div className="atl-svc__rowmain">
                    <div className="atl-svc__rowtop">
                      <span className={`atl-svc__chip ${lbl.cls}`}>{lbl.text}</span>
                      <span className="atl-svc__pid">pid {t.pid}</span>
                      <span className="atl-svc__elapsed">{formatElapsed(t.startTime, t.endTime)}</span>
                    </div>
                    <div className="atl-svc__cmd" title={t.command}>{shortenCmd(t.command)}</div>
                    {t.cwd && <div className="atl-svc__cwd" title={t.cwd}>📁 {t.cwd}</div>}
                  </div>
                  {t.status === 'running' && (
                    <div className="atl-svc__ctrl">
                      <button type="button" title="暂停 (SIGTSTP)" onClick={() => void handlePause(t.pid)}>⏸</button>
                      <button type="button" title="恢复 (SIGCONT)" onClick={() => void handleResume(t.pid)}>▶</button>
                      <button type="button" className="atl-svc__danger" title="停止 (SIGTERM)" onClick={() => void handleKill(t.pid, false)}>■</button>
                      <button type="button" className="atl-svc__danger" title="强制停止 (SIGKILL)" onClick={() => void handleKill(t.pid, true)}>⚡</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};

export default ServiceManagerBadge;
