import React, { useEffect, useMemo, useState } from 'react';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import DockRail from './dock/DockRail';
import type { DockPill, DockTone } from './dock/dockTypes';
import { DockPopList, DockPopFoot, worstTone, TerminalGlyph, EyeGlyph, type DockPopRowData } from './dock/DockPopList';
import {
  useBackgroundTasks,
  barFadeRemainMs,
  killBackgroundTask,
  setBackgroundTaskPersistent,
  type BackgroundTask,
} from '../../state/backgroundTasksStore';
import { useMonitors, stopMonitor, type MonitorWire } from '../../state/monitorsStore';

/* ============ helpers ============ */

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const ss = s % 60;
  if (m < 60) return ss > 0 ? `${m}m${ss}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function clip(s: string, max = 60): string {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/**
 * 药丸上那几个字 —— 目标是"一眼认出是哪个任务", 不是复述整条命令。
 * 真实命令长这样: `cd /Users/x/Code/y/frontend && pnpm dev:antd`。前面那截 cd 是
 * 噪音 (每条都有、还特别长), 真正区分任务的是 && 之后那段。
 */
export function shortTaskLabel(task: BackgroundTask): string {
  /* 服务端按命令首词起的名字遇到循环就是「for」—— 关键字不算名字 */
  if (task.name && !/^(for|while|until|if|do|cd|bash|sh|zsh)$/.test(task.name.trim())) return clip(task.name, 22);
  let raw = (task.command || '').replace(/\s+/g, ' ').trim();
  const wrapped = /^(?:sh|bash|zsh)\s+-\w*c\s+(['"])(.*)\1$/.exec(raw);
  if (wrapped) raw = wrapped[2]!.trim();
  const segs = raw.split(/&&|;|\|\|/).map((s) => s.trim()).filter(Boolean);
  const loop = segs.find((s) => /^(for|while|until|if)\b/.test(s));
  const tail = loop
    || [...segs].reverse().find((s) => !/^(done|fi|esac|then|else|do|pwd|cd(\s|$))/.test(s))
    || raw;
  /* 再砍掉环境变量前缀 (FOO=1 BAR=2 cmd) */
  const noEnv = tail.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '');
  return clip(noEnv, 24) || (task.pid > 0 ? `pid ${task.pid}` : 'task');
}

function toneOf(status: BackgroundTask['status']): DockTone {
  switch (status) {
    case 'completed': return 'ok';
    case 'killed':    return 'muted';
    case 'failed':    return 'err';
    case 'paused':    return 'warn';
    default:          return 'running';
  }
}


/** 打开右栏服务面板; 传 pid 就顺便选中那一条 */
export function openServicesSurface(isZh: boolean, pid?: number): void {
  window.dispatchEvent(new CustomEvent('neox:open-surface', {
    detail: {
      kind: 'services',
      source: { type: 'inline', content: '' },
      title: isZh ? '服务' : 'Services',
      pinned: true,
      metadata: typeof pid === 'number' ? { selectedPid: pid } : undefined,
      /* 用户点了后台任务胶囊 —— 明确要看, 照展右栏 */
      byUser: true,
    },
  }));
}

/** 监控在盯什么 —— 药丸展开 / ⋯ 菜单里那一行 */
export function describeMonitor(m: MonitorWire, isZh: boolean): string {
  const t = m.trigger;
  if (t.type === 'output') return isZh ? `pid ${t.pid} 的输出出现 /${t.pattern}/` : `pid ${t.pid} output matches /${t.pattern}/`;
  if (t.type === 'poll') {
    const cond = t.until === 'success'
      ? (isZh ? '成功' : 'succeeds')
      : t.until === 'match' ? (isZh ? `输出出现 /${t.pattern ?? ''}/` : `output matches /${t.pattern ?? ''}/`)
      : (isZh ? '输出变了' : 'output changes');
    return isZh ? `每 ${t.intervalSeconds}s 跑 ${clip(t.command, 40)}, 直到${cond}` : `every ${t.intervalSeconds}s: ${clip(t.command, 40)} until it ${cond}`;
  }
  return isZh ? `${t.path} 下有文件变动` : `files change under ${t.path}`;
}


/* ============ pills hook ============ */

/**
 * 把当前会话的后台任务翻译成药丸。
 * 一秒一跳的计时会让本 hook 每秒返回新数组 —— DockRail 靠这个更新宽度测量, 是预期行为。
 */
export function useBackgroundTaskPills(): DockPill[] {
  const { activeSession } = useNeoxRuntime();
  const { isZh } = useI18n();
  const allTasks = useBackgroundTasks(activeSession?.id);
  const monitors = useMonitors(activeSession?.id);


  /* 1s tick 让计时数字跳 */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (allTasks.length === 0 && monitors.length === 0) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [allTasks.length, monitors.length]);

  return useMemo(() => {
    /* 已退出的任务在这条上露脸 5s/12s 就收起。free-shell 是用户自己的交互终端, 不是任务。 */
    const tasks = allTasks.filter(t => t.kind !== 'free-shell' && barFadeRemainMs(t, now) > 0);
    return groupedPills(tasks, monitors, now, isZh);
  }, [allTasks, monitors, now, isZh]);
}

function taskRow(t: BackgroundTask, now: number, isZh: boolean): DockPopRowData {
  const active = t.status === 'running' || t.status === 'paused';
  const actions: DockPopRowData['actions'] = [];
  if (active) {
    actions.push({
      id: 'pin',
      label: t.persistent ? (isZh ? '取消常驻' : 'Unpin') : (isZh ? '常驻' : 'Keep'),
      onClick: () => { void setBackgroundTaskPersistent(t.pid, !t.persistent); },
    });
    actions.push({ id: 'kill', label: isZh ? '停止' : 'Stop', danger: true, onClick: () => { void killBackgroundTask(t.pid, false); } });
  } else {
    actions.push({ id: 'log', label: isZh ? '日志' : 'Log', onClick: () => openServicesSurface(isZh, t.pid) });
  }
  const status = t.status === 'paused' ? (isZh ? '已暂停' : 'paused')
    : t.status === 'killed' ? (isZh ? '已停止' : 'stopped')
    : typeof t.exitCode === 'number' ? `exit ${t.exitCode}` : '';
  return {
    id: `bgtask:${t.pid}`,
    tone: toneOf(t.status),
    lead: <TerminalGlyph />,
    title: shortTaskLabel(t),
    note: [t.pid > 0 ? `pid ${t.pid}` : '', status, t.persistent ? (isZh ? '常驻' : 'kept') : ''].filter(Boolean).join(' · '),
    mono: clip(t.lastOutputLine || t.command, 90),
    meta: active ? formatElapsed(Math.max(0, now - t.startedAtMs)) : undefined,
    actions,
    onOpen: () => openServicesSurface(isZh, t.pid),
  };
}

function groupedPills(tasks: BackgroundTask[], monitors: MonitorWire[], now: number, isZh: boolean): DockPill[] {
  const out: DockPill[] = [];
  if (tasks.length > 0) {
    const rows = [...tasks]
      .sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed') || b.startedAtMs - a.startedAtMs)
      .map((t) => taskRow(t, now, isZh));
    const running = tasks.filter(t => t.status === 'running' || t.status === 'paused');
    const failed = tasks.filter(t => t.status === 'failed');
    const one = tasks.length === 1 ? tasks[0] : null;
    const earliest = running.length ? Math.min(...running.map(t => t.startedAtMs)) : 0;
    const summary = [
      running.length ? (isZh ? `${running.length} 个在跑` : `${running.length} running`) : '',
      failed.length ? (isZh ? `${failed.length} 个失败` : `${failed.length} failed`) : '',
    ].filter(Boolean).join(' · ') || (isZh ? '都结束了' : 'all done');
    out.push({
      id: 'bg:tasks',
      tone: worstTone(tasks.map(t => toneOf(t.status))),
      icon: <TerminalGlyph />,
      label: one ? shortTaskLabel(one) : (isZh ? '后台命令' : 'Background'),
      meta: one
        ? (running.length ? formatElapsed(Math.max(0, now - one.startedAtMs)) : (typeof one.exitCode === 'number' ? `exit ${one.exitCode}` : undefined))
        : String(tasks.length),
      weight: running.length ? 20 : 45,
      attention: failed.length > 0,
      expandDetail: false,
      updatedAt: earliest || Math.max(...tasks.map(t => t.endedAtMs ?? t.startedAtMs)),
      ariaLabel: isZh ? `后台命令 ${tasks.length} 个` : `${tasks.length} background commands`,
      popTitle: isZh ? '后台命令' : 'Background commands',
      popMeta: summary,
      panel: (
        <>
          <DockPopList rows={rows} />
          <DockPopFoot
            actions={[
              ...(running.length > 1 ? [{ id: 'killall', label: isZh ? '全部停止' : 'Stop all', danger: true, onClick: () => { running.forEach(t => { void killBackgroundTask(t.pid, false); }); } }] : []),
              { id: 'services', label: isZh ? '服务面板 ›' : 'Services ›', onClick: () => openServicesSurface(isZh) },
            ]}
          />
        </>
      ),
    });
  }
  if (monitors.length > 0) {
    const one = monitors.length === 1 ? monitors[0] : null;
    out.push({
      id: 'bg:monitors',
      tone: 'running',
      icon: <EyeGlyph />,
      label: one ? clip(one.label, 14) : (isZh ? '监控' : 'Monitors'),
      meta: one ? (one.fires > 0 ? `${one.fires}/${one.maxFires}` : formatElapsed(Math.max(0, one.expiresAt - now))) : String(monitors.length),
      weight: 25,
      updatedAt: Math.min(...monitors.map(m => m.createdAt)),
      ariaLabel: isZh ? `监控 ${monitors.length} 个` : `${monitors.length} monitors`,
      popTitle: isZh ? '在盯着' : 'Watching',
      popMeta: isZh ? `${monitors.length} 个` : `${monitors.length}`,
      panel: (
        <DockPopList rows={monitors.map((m) => ({
          id: `monitor:${m.id}`,
          tone: 'running' as DockTone,
          lead: <EyeGlyph />,
          title: clip(m.label, 24),
          note: m.fires > 0 ? (isZh ? `命中 ${m.fires}/${m.maxFires}` : `fired ${m.fires}/${m.maxFires}`) : undefined,
          desc: describeMonitor(m, isZh),
          meta: m.fires > 0 ? undefined : formatElapsed(Math.max(0, m.expiresAt - now)),
          actions: [{ id: 'stop', label: isZh ? '停止' : 'Stop', danger: true, onClick: () => { void stopMonitor(m.sessionId, m.id); } }],
        }))} />
      ),
    });
  }
  return out;
}

/* ============ 独立组件形态 (IDE 侧 AI 面板用) ============ */

export const BackgroundTasksBar: React.FC = () => {
  const pills = useBackgroundTaskPills();
  return <DockRail pills={pills} />;
};

export default BackgroundTasksBar;
