/**
 * AgentStatusRow (Ink) — 底部一行,展示 context 预算徽章 + pending wakeup 倒计时。
 *
 * 数据源:直接读 runtime singleton(同进程,无 IPC)
 *   · AgentBudgetAccessor.getLatestSnapshot() — 跨 ALS 兜底读
 *   · ScheduledWakeupRegistry.listAllPending() — 公共 API
 *
 * 轮询 2s,倒计时 1s。数据为空时 return null,不占屏。
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';
import {
  getAgentBudgetAccessor,
  computeWorstPct,
  suggestFromSnapshot,
  type AgentBudgetSnapshot,
  type ContextSuggestion,
} from '@neoxlabs/core/runtime/agentBudgetAccessor.js';
import { getScheduledWakeupRegistry } from '@neoxlabs/core/runtime/shell/scheduledWakeupRegistry.js';

const POLL_MS = 2_000;

function formatK(n: number): string {
  if (!n) return '0';
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatCountdown(sec: number): string {
  if (sec <= 0) return 'fired';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s < 10 ? '0' : ''}${s}s`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function inkColorFor(sug: ContextSuggestion): string {
  if (sug === 'save_memory_and_restart') return 'red';
  if (sug === 'save_memory_soon') return 'yellow';
  return 'green';
}

function shortLabelFor(sug: ContextSuggestion): string {
  if (sug === 'save_memory_and_restart') return 'restart';
  if (sug === 'save_memory_soon') return 'save soon';
  return 'ok';
}

interface WakeupPending {
  id: string;
  sessionId: string;
  reason: string;
  prompt: string;
  dueAt: number;
  createdAt: number;
}

export const AgentStatusRow: React.FC = () => {
  const [snap, setSnap] = useState<AgentBudgetSnapshot | null>(null);
  const [wakeups, setWakeups] = useState<WakeupPending[]>([]);
  const [now, setNow] = useState(Date.now());

  // 定期同步状态(budget + wakeups)
  useEffect(() => {
    const tick = () => {
      try {
        setSnap(getAgentBudgetAccessor().getLatestSnapshot() ?? null);
      } catch { setSnap(null); }
      try {
        setWakeups(getScheduledWakeupRegistry().listAllPending() as WakeupPending[]);
      } catch { setWakeups([]); }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, []);

  // 倒计时 ticker(只在有 wakeup 时开启)
  useEffect(() => {
    if (wakeups.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [wakeups.length]);

  const hasBudget = snap !== null;
  const hasWakeup = wakeups.length > 0;
  if (!hasBudget && !hasWakeup) return null;

  // ─ Budget badge ─
  let budgetEl: React.ReactNode = null;
  if (hasBudget && snap) {
    const pct = computeWorstPct(snap);
    const sug = suggestFromSnapshot(snap);
    const color = inkColorFor(sug);
    const pctStr = `${Math.round(pct * 100)}%`;
    budgetEl = (
      <>
        <Text color={color as any} bold>{pctStr}</Text>
        <Text dimColor> · {shortLabelFor(sug)}</Text>
        <Text dimColor> · {formatK(snap.inputTokensEstimate)}/{formatK(snap.inputTokenBudget)}</Text>
      </>
    );
  }

  // ─ Wakeup chip ─
  let wakeupEl: React.ReactNode = null;
  if (hasWakeup) {
    const soonest = wakeups[0];
    const remaining = Math.max(0, Math.floor((soonest.dueAt - now) / 1000));
    const reason = truncate(soonest.reason, 34);
    wakeupEl = (
      <>
        <Text color="magenta">⏰ </Text>
        <Text color="magenta">{formatCountdown(remaining)}</Text>
        <Text dimColor> · {reason}</Text>
        {wakeups.length > 1 && <Text dimColor> (+{wakeups.length - 1})</Text>}
      </>
    );
  }

  return (
    <Box paddingX={1}>
      {budgetEl}
      {hasBudget && hasWakeup && <Text dimColor>  ·  </Text>}
      {wakeupEl}
    </Box>
  );
};
