/**
 * in-process 深度 attach —— 深度模式入口。
 *
 * 仅在测试场景由产品 bootstrap 在 env 门控下动态 import 调用(见 README 接线说明)。
 * 生产构建不引用本模块 / devtools 不在客户包里 → 永不进客户 bundle。
 *
 * 深度模式相比进程外纯订阅多拿到的:**控制平面信号**(stallGuard 当前挂起操作),
 * 这些不在 WS 事件流里, 只能进程内读 stallGuard 的被动 getter。
 *
 * 两种接法:
 *   · attachMonitor(hub)         — 挂 RuntimeEventHub.register(sink)
 *   · attachMonitorToEventBus(bus) — 消费 server EventBus.subscribe()(最省侵入, main.ts 现成有 bus)
 */

import { MonitorAggregator } from './aggregator.js';
import type { ControlPlaneSnapshot, MonitorState } from './types.js';

/** 产品侧 RuntimeEventHub 的最小结构 */
export interface RuntimeEventHubLike {
  register(sink: { name: string; handle: (sessionId: string, event: any, tracker: any) => void }): () => void;
}

/** 产品侧 EventBus 的最小结构(subscribe 返回 async-iterable of ServerEvent) */
export interface EventBusLike {
  subscribe(sessionId?: string, fromSeq?: number): AsyncIterable<{
    sessionId: string; type: string; data: any; tracker?: any; timestamp: number;
  }> & { close: () => void };
}

export interface AttachOptions {
  hub: RuntimeEventHubLike;
  aggregator?: MonitorAggregator;
  controlPlanePollMs?: number;
  serve?: { port?: number; intervalMs?: number };
  onLog?: (msg: string) => void;
}

export interface AttachBusOptions {
  bus: EventBusLike;
  aggregator?: MonitorAggregator;
  controlPlanePollMs?: number;
  serve?: { port?: number; intervalMs?: number };
  onLog?: (msg: string) => void;
}

export interface AttachedMonitor {
  aggregator: MonitorAggregator;
  snapshot: () => MonitorState;
  detach: () => void;
}

/** 控制平面采样 + 可选 in-process 仪表盘服务 —— 两种 attach 共用 */
function startControlPlaneAndServe(
  aggregator: MonitorAggregator,
  serveOpt: { port?: number; intervalMs?: number } | undefined,
  pollMs: number,
  onLog?: (m: string) => void,
): { snapshot: () => MonitorState; stop: () => void } {
  let lastControlPlane: ControlPlaneSnapshot = { inflightStalls: [], available: false };
  let getInflightStalls: ((minAgeMs?: number) => any[]) | null = null;

  const timer = setInterval(() => void sample(), pollMs);
  if (typeof timer?.unref === 'function') timer.unref();

  async function sample(): Promise<void> {
    try {
      if (!getInflightStalls) {
        const mod = await import('@neoxlabs/kernel/utils/stallGuard.js');
        getInflightStalls = mod.getInflightStalls;
      }
      const stalls = getInflightStalls?.(0) ?? [];
      lastControlPlane = { inflightStalls: stalls as any, available: true };
      for (const s of stalls) {
        if (s.ageMs >= (s.timeoutMs ?? 30_000) * 0.5) {
          aggregator.addAlert({
            level: s.ageMs >= (s.timeoutMs ?? Infinity) ? 'error' : 'warn',
            kind: 'stall', message: `${s.label} pending ${Math.round(s.ageMs / 1000)}s`,
            stallId: s.stallId, ts: Date.now(),
          });
        }
      }
    } catch (e: any) {
      onLog?.(`control-plane sample failed: ${e?.message ?? e}`);
      lastControlPlane = { inflightStalls: [], available: false };
    }
  }

  const snapshot = () => aggregator.snapshot(lastControlPlane);

  let dashboardServer: { close: () => void } | undefined;
  if (serveOpt) {
    void (async () => {
      try {
        const { startDashboardServer } = await import('./serve.js');
        dashboardServer = startDashboardServer({
          snapshot, port: serveOpt.port ?? 7399, intervalMs: serveOpt.intervalMs ?? 1000, onLog,
        });
      } catch (e: any) {
        onLog?.(`failed to start in-process dashboard: ${e?.message ?? e}`);
      }
    })();
  }

  return {
    snapshot,
    stop: () => { clearInterval(timer); try { (dashboardServer as any)?.close?.(); } catch { /* ignore */ } },
  };
}

/** 挂 RuntimeEventHub.register(sink) */
export function attachMonitor(opts: AttachOptions): AttachedMonitor {
  const aggregator = opts.aggregator ?? new MonitorAggregator();
  aggregator.setMode('attached');
  aggregator.setConnected(true);

  const unregister = opts.hub.register({
    name: 'neox-devtools-monitor',
    handle: (sessionId, event, tracker) => {
      aggregator.record({
        sessionId, eventType: event?.type ?? 'unknown',
        data: tracker ? { ...event, tracker } : event,
        timestamp: event?.timestamp ?? Date.now(),
      });
    },
  });

  const cp = startControlPlaneAndServe(aggregator, opts.serve, opts.controlPlanePollMs ?? 2000, opts.onLog);
  opts.onLog?.('neox-devtools monitor attached via RuntimeEventHub (deep mode)');

  return {
    aggregator, snapshot: cp.snapshot,
    detach: () => { cp.stop(); try { unregister(); } catch { /* ignore */ } opts.onLog?.('detached'); },
  };
}

/** 消费 server EventBus.subscribe()(最省侵入:main.ts 现成有 bus) */
export function attachMonitorToEventBus(opts: AttachBusOptions): AttachedMonitor {
  const aggregator = opts.aggregator ?? new MonitorAggregator();
  aggregator.setMode('attached');
  aggregator.setConnected(true);

  const sub = opts.bus.subscribe(); // 全量 '*' 通道
  let closed = false;
  (async () => {
    for await (const ev of sub) {
      if (closed) break;
      aggregator.record({
        sessionId: ev.sessionId,
        eventType: ev.type,
        data: ev.tracker ? { ...ev.data, tracker: ev.tracker } : ev.data,
        timestamp: ev.timestamp ?? Date.now(),
      });
    }
  })().catch((e) => opts.onLog?.(`event subscription ended: ${e?.message ?? e}`));

  const cp = startControlPlaneAndServe(aggregator, opts.serve, opts.controlPlanePollMs ?? 2000, opts.onLog);
  opts.onLog?.('neox-devtools monitor attached via EventBus (deep mode)');

  return {
    aggregator, snapshot: cp.snapshot,
    detach: () => { closed = true; try { sub.close(); } catch { /* ignore */ } cp.stop(); opts.onLog?.('detached'); },
  };
}
