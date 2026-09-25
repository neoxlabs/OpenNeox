
import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishComputerPointer, type ComputerPointerEvent } from '@neoxlabs/platform/shared/computerPointerBus.js';
import {
  createChildProcessChannel,
  createWorkerChannel,
  resolveRuntimeIsolation,
  type RuntimeChannel,
  type RuntimeIsolation,
} from './runtimeChannel.js';
import type {
  RuntimeAdapter,
  RuntimeEventCallback,
  AdapterChatRequest,
  AdapterStatus,
} from './runtimeAdapter.js';
import type { RuntimeBridge } from '../server/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { withWatchdog } from '@neoxlabs/kernel/utils/stallGuard.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { createHostedWatcherHost, type HostedWatcherHost } from '@neoxlabs/platform';
import { loadParcelWatcher } from '../runtime/watch/WatchCoordinator.js';
import {
  getHostCapability,
  HOST_CAPABILITY_UNAVAILABLE,
  type HostCallMessage,
  type HostResultMessage,
} from './hostCapabilities.js';

export class WorkerRuntimeAdapter implements RuntimeAdapter {
  /** 只在 worker 模式下有值 —— 生命周期一律走 channel, 这个字段只为兼容旧引用。 */
  private worker: Worker | null = null;
  /** 传输层 (worker 或独立子进程) —— 见 runtimeChannel.ts。 */
  private channel: RuntimeChannel | null = null;
  private listeners = new Set<RuntimeEventCallback>();
  private running = new Set<string>();
  private currentMode = 'agentic';
  private reqSeq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private bridgeProxy: RuntimeBridge | null = null;
  /** worker 的文件监听由这里代订 (见 hostedWatcher.ts); worker 退出/回收时一并退订。 */
  private watchHost: HostedWatcherHost | null = null;

  constructor(
    private readonly workDir: string,
    private readonly identityDir: string = path.join(os.homedir(), NEOX_HOME_DIRNAME),
    private readonly deviceFp: string = '',
    private readonly workerFactory?: (workerData: Record<string, unknown>) => Worker | Promise<Worker>,
    /* 'process' = runtime 跑独立子进程 (崩溃隔离)。不传则读 NEOX_RUNTIME_ISOLATION, 默认 worker。 */
    private readonly isolation?: RuntimeIsolation,
    /* 进程隔离时 fork 哪个文件。宿主 (打包过的桌面端) 必须给, 因为它自己那份入口
     * 才是打包器真正产出的那个文件; 不给就回落到 core 自身 dist 里的入口。 */
    private readonly processEntryPath?: string,
  ) {}

  /** 懒启动 worker + 等 ready。幂等。 */
  async connect(_sessionId?: string): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.spawn();
    await this.readyPromise;
  }

  private async spawn(): Promise<void> {
    const workerData = { workDir: this.workDir, identityDir: this.identityDir, deviceFp: this.deviceFp };

    const isolation = resolveRuntimeIsolation(this.isolation);
    const entryPath = this.processEntryPath
      ?? fileURLToPath(new URL('./runtimeWorkerEntry.js', import.meta.url));
    let channel: RuntimeChannel;
    if (isolation === 'process') {
      channel = createChildProcessChannel({ entryPath, init: workerData });
    } else {
      const worker = await Promise.resolve(
        this.workerFactory
          ? this.workerFactory(workerData)
          : new Worker(new URL('./runtimeWorkerEntry.js', import.meta.url), { workerData }),
      );
      this.worker = worker;
      channel = createWorkerChannel(worker);
    }
    this.channel = channel;
    this.watchHost?.dispose();
    const watchHost = createHostedWatcherHost((m) => channel.post(m), loadParcelWatcher);
    this.watchHost = watchHost;

    return new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;

      channel.onMessage((msg: any) => {
        if (!msg) return;
        if (watchHost.handle(msg)) return;
        switch (msg.type) {
          case 'event': {
            const tracker = (msg.tracker
              ?? { contextUsed: 0, startTime: Date.now(), provider: '', model: '' });
            for (const cb of this.listeners) {
              try { cb(msg.event, tracker); } catch { /* 单监听者抛错不影响其他 */ }
            }
            break;
          }
          case 'result': {
            const p = this.pending.get(msg.reqId);
            if (p) {
              this.pending.delete(msg.reqId);
              if (msg.ok) p.resolve(msg.value);
              else p.reject(new Error(msg.error || 'worker bridge call failed'));
            }
            break;
          }
          case 'ready':
            cliLogger.info('WORKER_ADAPTER', 'runtime worker ready');
            this.readyResolve?.();
            this.readyResolve = null;
            break;
          case 'fatal':
            cliLogger.error('WORKER_ADAPTER', `runtime worker fatal: ${msg.error}`);
            rejectReady(new Error(msg.error || 'runtime worker fatal'));
            break;
          case 'host-call': {
            void this.handleHostCall(msg as HostCallMessage);
            break;
          }
          case 'os-pointer': {
            try {
              publishComputerPointer(msg.event as ComputerPointerEvent);
            } catch { /* 画不出来不该影响任何事 */ }
            break;
          }
        }
      });
      channel.onError((err) => {
        cliLogger.error('WORKER_ADAPTER', `runtime ${channel.kind} error: ${err?.message ?? err}`);
        rejectReady(err);
        // 所有挂起的 RPC 失败, 避免永久 pending
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
      });
      channel.onExit((code) => {
        if (code !== 0) cliLogger.warn('WORKER_ADAPTER', `runtime ${channel.kind} exited code=${code}`);
        for (const [, p] of this.pending) p.reject(new Error(`runtime ${channel.kind} exited (${code})`));
        this.pending.clear();
        watchHost.dispose();
        /* 进程隔离下这不是世界末日: 界面还活着, 下一次 connect() 会重建。
         * (worker 模式里同样的崩溃通常已经把整个进程带走了, 走不到这里。) */
        this.channel = null;
        this.worker = null;
        this.readyPromise = null;
      });
    });
  }

  /**
   * 处理 worker 发来的宿主能力调用。
   *
   *   没注册该能力 (比如 CLI 宿主没有渲染进程) → 如实回 unavailable, 工具那边照旧
   *   给出"用 run_lint 代替"的引导, 行为跟加这条通道之前一致。
   */
  private async handleHostCall(msg: HostCallMessage): Promise<void> {
    const reply = (r: Omit<HostResultMessage, 'type' | 'reqId'>) => {
      try {
        this.channel?.post({ type: 'host-result', reqId: msg.reqId, ...r } satisfies HostResultMessage);
      } catch (err) {
        /* runtime 已经退了 —— 它那边的 pending 会被 exit/error 分支收掉, 这里静默即可 */
        cliLogger.warn('WORKER_ADAPTER', `host-result 回不去 (runtime 已退?): ${String(err)}`);
      }
    };
    const fn = getHostCapability(msg.capability);
    if (typeof fn !== 'function') {
      reply({ ok: false, error: `${HOST_CAPABILITY_UNAVAILABLE}: ${msg.capability}` });
      return;
    }
    try {
      const value = await (fn as (...a: unknown[]) => Promise<unknown>)(
        ...(Array.isArray(msg.args) ? msg.args : []),
      );
      reply({ ok: true, value });
    } catch (err: any) {
      reply({ ok: false, error: String(err?.message ?? err) });
    }
  }

  /** 通用 RPC: 调 worker 里 bridge[method](...args), 等结果。 */
  private callBridge<T = any>(method: string, ...args: any[]): Promise<T> {
    if (!this.channel) {
      // 尚未 connect — 先确保启动再发
      return this.connect().then(() => this.callBridge<T>(method, ...args));
    }
    const reqId = ++this.reqSeq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      try {
        this.channel!.post({ type: 'call', reqId, method, args });
      } catch (err) {
        this.pending.delete(reqId);
        reject(err);
      }
    });
  }

  async chat(request: AdapterChatRequest): Promise<void> {
    await this.connect(request.sessionId);
    this.running.add(request.sessionId);
    try {
      await withWatchdog(
        this.callBridge('chat', request.sessionId, {
          prompt: request.prompt,
          mode: request.mode,
          attachments: request.attachments,
          providerId: request.providerId,
          modelName: request.modelName,
          isAutoRouted: request.isAutoRouted,
          routeConfig: request.routeConfig,
          effortLevel: request.effortLevel,
        }),
        {
          label: 'transport:worker-rpc:chat',
          warnAfterMs: 60_000,
          repeatEveryMs: 60_000,
          maxWarns: 0, // 真卡死时持续心跳, 别 5 条就闭嘴
          context: { sessionId: request.sessionId, modelName: request.modelName },
          tag: 'STALL',
        },
      );
    } finally {
      this.running.delete(request.sessionId);
    }
  }

  abort(sessionId: string): void {
    void this.callBridge('abort', sessionId).catch(() => { /* abort 尽力而为 */ });
    this.running.delete(sessionId);
  }

  /** 叠加层「停止」: 掐掉正在飞的 computer_run, 不必等整轮 agent abort 穿完。 */
  notifyOsControl(op: string): void {
    try { this.channel?.post({ type: 'os-control', op }); } catch { /* runtime 已退 */ }
  }

  async injectMessage(
    sessionId: string,
    message: string,
    images?: Array<{ mediaType: string; data: string; name?: string }>,
  ): Promise<number> {
    try {
      const r = await this.callBridge('injectMessage', sessionId, message, images);
      return typeof r === 'number' ? r : 0;
    } catch {
      return 0;
    }
  }

  onEvent(callback: RuntimeEventCallback): void {
    this.listeners.add(callback);
  }

  offEvent(callback: RuntimeEventCallback): void {
    this.listeners.delete(callback);
  }

  setRunMode(mode: string): void {
    this.currentMode = mode; // 本地缓存 (getRunMode 同步返回, 不 RPC)
    void this.callBridge('setRunMode', mode).catch(() => { /* ignore */ });
  }

  getRunMode(): string {
    return this.currentMode;
  }

  getStatus(): AdapterStatus {
    return {
      isRunning: this.running.size > 0,
      mode: this.currentMode,
      activeSessions: [...this.running],
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.running.clear();
    for (const [, p] of this.pending) p.reject(new Error('adapter disposed'));
    this.pending.clear();
    this.watchHost?.dispose();
    this.watchHost = null;
    try { void this.channel?.terminate(); } catch { /* ignore */ }
    this.channel = null;
    this.worker = null;
    this.readyPromise = null;
    this.bridgeProxy = null;
  }

  /** 返回 bridge 代理: 任意方法调用 → callBridge(method, ...args)。LocalNeoxClient 用它取代直调。 */
  getBridge(): RuntimeBridge | null {
    if (!this.bridgeProxy) {
      const self = this;
      this.bridgeProxy = new Proxy({}, {
        get(_t, prop: string) {
          if (typeof prop !== 'string') return undefined;
          return (...args: any[]) => self.callBridge(prop, ...args);
        },
      }) as unknown as RuntimeBridge;
    }
    return this.bridgeProxy;
  }
}
