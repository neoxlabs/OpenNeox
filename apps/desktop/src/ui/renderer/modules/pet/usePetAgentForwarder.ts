/**
 * usePetAgentForwarder — 主窗口订阅 NeoxRuntime 事件, 简化后转发给 pet window
 *
 * 这个 hook 跟 usePetWindowSync 一样挂在 AppShell 顶层, 但分工不同:
 *   usePetWindowSync       — 生命周期 (spawn/destroy + config 同步)
 *   usePetAgentForwarder   — 数据流 (timeline → 简化 → IPC)
 *
 * 设计原则:
 *   1. **只读** runtime, 不改它. 桌宠是观察者, 不影响 agent 行为.
 *   2. **过滤+简化** 后再 IPC — pet window 拿到的不是完整 TimelineEntry, 而是
 *      简化的 PetAgentEvent (10-30 字段 → 3-4 字段). 减小 IPC payload + 解耦.
 *   3. **去重** — 同一 entry id 不重复转发 (timelineEvents 会因状态变化重新 emit
 *      整个数组, 不去重的话每次 setMessage 都会 spam 一次 'speech').
 *   4. **enabled gating** — cfg.enabled=false 时全 short-circuit, 0 开销.
 */

import { useEffect, useRef } from 'react';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { useTimelineFeed } from '../../state/timelineFeedStore';
import { usePetConfig } from './petConfig';
import type { TimelineEntry } from '../../utils/workspaceUtils';

interface PetForwarderApi {
  forwardAgentEvent: (evt: unknown) => Promise<{ ok: boolean }>;
}

function petApi(): PetForwarderApi | null {
  const neox = (window as unknown as { neox?: { pet?: PetForwarderApi } }).neox;
  return neox?.pet ?? null;
}

/** TimelineEntry → 简化的 PetAgentEvent. null 表示这条 entry 不触发桌宠反应. */
function deriveEvent(entry: TimelineEntry): unknown | null {
  switch (entry.type) {
    case 'assistant_message': {
      const text = ((entry as any).text ?? (entry as any).content ?? '').toString().trim();
      if (!text) return null;
      /* 截到 80 字, 太长气泡撑爆 */
      return { type: 'speech', text: text.slice(0, 80) };
    }
    case 'thinking':
    case 'assistant_prefix': {
      /* mood → thinking, 触发 standing 动作 */
      return { type: 'mood', mood: 'thinking' };
    }
    case 'plan': {
      /* plan 卡片 — entry 里通常带 plan steps. 提取已完成 / 总数. */
      const steps = ((entry as any).planSteps ?? (entry as any).plan?.steps ?? []) as Array<{ status?: string }>;
      if (!Array.isArray(steps) || steps.length === 0) return null;
      const done = steps.filter((s) => s?.status === 'completed').length;
      return { type: 'plan', planProgress: { done, total: steps.length } };
    }
    case 'tool_call': {
      const tool = (entry as any).toolName?.toLowerCase() ?? '';
      if (['edit_file', 'write_file', 'multi_edit'].includes(tool)) {
        return { type: 'mood', mood: 'coding' };
      }
      if (['readfile', 'search', 'search_files', 'show_tree'].includes(tool)) {
        return { type: 'mood', mood: 'reading' };
      }
      if (['execute_shell', 'execute_bash'].includes(tool)) {
        return { type: 'mood', mood: 'running' };
      }
      return null;
    }
    case 'tool_error':
    case 'runner_error': {
      const msg = ((entry as any).message ?? (entry as any).error ?? '工具出错').toString();
      return { type: 'error', text: msg.slice(0, 60) };
    }
    default:
      return null;
  }
}

export function usePetAgentForwarder(): void {
  const cfg = usePetConfig();
  const runtime = useNeoxRuntimeOptional();
  const timelineEvents = useTimelineFeed();
  const lastEntryIdRef = useRef<string | null>(null);
  const lastStreamingRef = useRef<boolean>(false);

  /* timelineEvents → forward */
  useEffect(() => {
    if (!cfg.enabled || !runtime) return;
    const events = timelineEvents;
    if (!events || events.length === 0) return;
    const latest = events[events.length - 1];
    if (!latest?.id) return;
    if (lastEntryIdRef.current === latest.id) return; /* 同条 entry, 跳过 */
    lastEntryIdRef.current = latest.id;
    const petEvt = deriveEvent(latest);
    if (!petEvt) return;
    const api = petApi();
    api?.forwardAgentEvent(petEvt).catch((err) => {
      console.warn('[petAgentForwarder] forward failed:', err);
    });
  }, [cfg.enabled, timelineEvents, runtime]);

  /* streaming false→true→false 边沿: 一轮跑完 → 发 'complete' 让宠物撒花 */
  useEffect(() => {
    if (!cfg.enabled || !runtime) return;
    const wasStreaming = lastStreamingRef.current;
    const isStreaming = runtime.streaming;
    if (wasStreaming && !isStreaming && cfg.reactOnTaskComplete) {
      const api = petApi();
      api?.forwardAgentEvent({ type: 'complete' }).catch(() => { /* ignore */ });
    }
    lastStreamingRef.current = isStreaming;
  }, [cfg.enabled, cfg.reactOnTaskComplete, runtime?.streaming, runtime]);

  /* lastError 出现 → forward 'error'. lastError 是 stateful object, 用 message 作 dedup key. */
  const lastErrorMsgRef = useRef<string | null>(null);
  useEffect(() => {
    if (!cfg.enabled || !runtime || !cfg.reactOnError) return;
    const err = runtime.lastError;
    const msg = err?.message ?? null;
    if (msg === lastErrorMsgRef.current) return;
    lastErrorMsgRef.current = msg;
    if (!msg) return;
    const api = petApi();
    api?.forwardAgentEvent({ type: 'error', text: msg.slice(0, 60) }).catch(() => { /* ignore */ });
  }, [cfg.enabled, cfg.reactOnError, runtime?.lastError, runtime]);

  /* 打字反应 (吸收"敲键盘"灵感, 纯前端无需系统权限): 监听用户在主窗口的按键,
   * 节流后给桌宠发 'activity' — 桌宠据此切到"陪你写代码"的反应 (SVG 触角发光 / sprite 跑动).
   * 只发节流脉冲 (200ms 内最多一次), 不记录任何按键内容 — 纯活动信号, 不碰隐私. */
  useEffect(() => {
    if (!cfg.enabled) return;
    let lastSent = 0;
    const onKey = (e: KeyboardEvent) => {
      /* 纯修饰键 (Shift/Ctrl/...) 不算"在写" */
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      const now = Date.now();
      if (now - lastSent < 200) return;
      lastSent = now;
      petApi()?.forwardAgentEvent({ type: 'activity' }).catch(() => { /* ignore */ });
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as any);
  }, [cfg.enabled]);
}
