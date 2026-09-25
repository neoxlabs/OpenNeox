
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '../server/eventBus.js';
import { initRuntimeBridge } from '../server/main.js';
import type { RuntimeBridge } from '../server/index.js';
import type {
  RuntimeAdapter,
  RuntimeEventCallback,
  AdapterChatRequest,
  AdapterStatus,
} from './runtimeAdapter.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { installDbBasedRoutingResolver, setCredentialProvider } from '@neoxlabs/platform/platform/providerResolver.js';
import { readGatewayCredentialFromDir, readIdentityUserId } from '@neoxlabs/platform/platform/identityCredential.js';
import { setCurrentUserId } from '@neoxlabs/platform/utils/config.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export class LocalRuntimeAdapter implements RuntimeAdapter {
  private bus = new EventBus();
  private bridge: RuntimeBridge | null = null;
  private listeners = new Set<RuntimeEventCallback>();
  private running = new Set<string>();
  private currentMode = 'agentic';
  private initPromise: Promise<void> | null = null;
  private busSub: { close: () => void } | null = null;
  /* 转发循环的完成 promise —— dispose 前要等它排空, 否则最后一批事件送不到监听器。 */
  private busLoop: Promise<void> | null = null;

  constructor(
    private readonly workDir: string,
    private readonly identityDir: string = path.join(os.homedir(), NEOX_HOME_DIRNAME),
    private readonly deviceFp: string = '',
    /* 宿主特性: oneShot=true → 跑完一个 turn 进程就退 (`neox -p`)。
     * 传下去让 agent 工具禁用后台子 agent (否则子 agent 被连坐杀掉、产出丢失且退出码 0)。 */
    private readonly hostOptions: { oneShot?: boolean } = {},
  ) {}

  /** 懒初始化: 注册凭据 + 组装 bridge + 订阅 bus。幂等。 */
  async connect(_sessionId?: string): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    // 1. 凭据真源 — 全部静态导入，确保 bundler 内联（动态 import 在打包后解析失败）
    try {
      const routingFile = process.env.NEOX_ROUTING_FILE
        || path.join(os.homedir(), NEOX_HOME_DIRNAME, 'routing.json');
      await installDbBasedRoutingResolver(routingFile);
      const idDir = this.identityDir;
      setCredentialProvider(() => readGatewayCredentialFromDir(idDir));
      try {
        const uid = readIdentityUserId(idDir);
        if (uid) setCurrentUserId(uid);
      } catch { /* 非致命 */ }
      if (this.deviceFp) {
        try {
          const { setNeoxDeviceFp } = await import('@neoxlabs/kernel/models/openai.js');
          setNeoxDeviceFp(this.deviceFp);
          cliLogger.info('LOCAL_ADAPTER', `device fp injected (${this.deviceFp.slice(0, 8)}...)`);
        } catch (fpErr: any) {
          cliLogger.warn('LOCAL_ADAPTER', `device fp inject failed: ${fpErr?.message ?? fpErr}`);
        }
      }
      cliLogger.info('LOCAL_ADAPTER', `credential provider installed (identity-dir=${idDir})`);
    } catch (err: any) {
      cliLogger.warn('LOCAL_ADAPTER', `credential setup failed: ${err?.message ?? err}`);
    }

    // 2. helper daemon — shell 命令通过 daemon 执行（PTY 交互、实时 stream、进程领养）。
    //    跟 server 模式一样启动，确保任何模式下 shell 命令都能正常工作。
    try {
      const { ensureCommandHelperRunning } = await import('../tools/commandHelperClient.js');
      await ensureCommandHelperRunning();
      cliLogger.info('LOCAL_ADAPTER', 'command helper daemon started');
    } catch (err: any) {
      cliLogger.warn('LOCAL_ADAPTER', `command helper daemon failed to start: ${err?.message ?? err}`);
    }

    // 3. 进程内组装完整 bridge (复用 server 同一套 initRuntimeBridge)
    this.bridge = await initRuntimeBridge(this.workDir, this.bus, this.hostOptions);

    // 2b. shell 实时输出流 — server 模式在 runtimeBridgeSetup 设,
    //     in-process 模式必须这里补, 否则 executeShellWorker 的 stream callback 是 null,
    //     shell 卡片只在命令完成后才显示输出, 用户不知道在不在跑。
    try {
      const { setShellOutputStreamCallback } = await import('../tools/runtimeTools.js');
      cliLogger.info('LOCAL_ADAPTER', 'shell output stream callback REGISTERED');
      setShellOutputStreamCallback((payload) => {
        cliLogger.info('LOCAL_ADAPTER', `shell_stream: toolId=${payload.toolId} elapsed=${payload.elapsed} complete=${payload.isComplete} delta_len=${payload.outputDelta?.length ?? 0}`);
        this.bus.publish({
          sessionId: payload.sessionId || '__local__',
          type: 'shell_output_stream',
          timestamp: Date.now(),
          data: {
            type: 'shell_output_stream',
            toolId: payload.toolId,
            command: payload.command,
            output: payload.output,
            outputDelta: payload.outputDelta,
            elapsed: payload.elapsed,
            isComplete: payload.isComplete,
            exitCode: payload.exitCode,
            pid: payload.pid,
          } as any,
        });
      });
    } catch (err: any) {
      cliLogger.warn('LOCAL_ADAPTER', `shell output stream callback setup failed: ${err?.message ?? err}`);
    }

    // 3. 直接订阅 bus → 转发 onEvent (替代 daemon 的 SSE)
    this.busSub = this.subscribeBus();
  }

  private subscribeBus(): { close: () => void } {
    const sub = this.bus.subscribe(); // 通配: 所有 session
    this.busLoop = (async () => {
      try {
        for await (const ev of sub) {
          const tracker = (ev.tracker
            ?? { contextUsed: 0, startTime: Date.now(), provider: '', model: '' }) as any;
          let payload = ev.data;
          if (payload && typeof payload === 'object' && !(payload as { sessionId?: string }).sessionId) {
            /* 展开会把 51 个成员的联合类型打宽 → 断言回原类型; 只补一个字段, 形状不变。 */
            payload = { ...(payload as object), sessionId: ev.sessionId } as typeof ev.data;
          }
          for (const cb of this.listeners) {
            try { cb(payload, tracker); } catch { /* 单个监听者抛错不影响其他 */ }
          }
        }
      } catch { /* 已 close */ }
    })();
    return sub;
  }

  /**
   * 等事件转发排空 —— close 后队列里剩下的事件全部送达监听器才 resolve。
   *
   *   转发是 `for await` 循环, 跟 chat() 的 resolve 是**两个独立任务**。不等它,
   *   调用方在 chat 返回后立刻读自己的状态 (如 print 模式的 streamedAny), 会读到
   *   最后一批事件还没送达的中间态 —— 表现为 `neox -p` 静默丢结果。
   *   1s 上限: 转发卡住时宁可少等, 也不能让 dispose 挂住。
   */
  async flushEvents(): Promise<void> {
    this.busSub?.close();
    this.busSub = null;
    const loop = this.busLoop;
    if (!loop) return;
    await Promise.race([loop, new Promise<void>((r) => {
      const t = setTimeout(r, 1000);
      if (typeof (t as any).unref === 'function') (t as any).unref();
    })]);
  }

  async chat(request: AdapterChatRequest): Promise<void> {
    await this.connect(request.sessionId);
    this.running.add(request.sessionId);
    try {
      /* bridge.chat 是 await 完整 turn 的 (server HTTP 才 fire-and-forget); 事件在期间经 bus 流出。 */
      await this.bridge!.chat(request.sessionId, {
        prompt: request.prompt,
        mode: request.mode,
        attachments: request.attachments as any,
        providerId: request.providerId,
        modelName: request.modelName,
        isAutoRouted: request.isAutoRouted,
        routeConfig: request.routeConfig,
        effortLevel: request.effortLevel,
      });
    } finally {
      this.running.delete(request.sessionId);
    }
  }

  abort(sessionId: string): void {
    this.bridge?.abort(sessionId);
    this.running.delete(sessionId);
  }

  notifyOsControl(op: string): void {
    if (op !== 'abort') return;
    void import('../runtime/computer/computerAbort.js').then((m) => m.abortComputerSession()).catch(() => {});
  }

  injectMessage(sessionId: string, message: string, images?: Array<{ mediaType: string; data: string; name?: string }>): number {
    const r = this.bridge?.injectMessage?.(sessionId, message, images);
    return typeof r === 'number' ? r : 0;
  }

  onEvent(callback: RuntimeEventCallback): void {
    this.listeners.add(callback);
  }

  offEvent(callback: RuntimeEventCallback): void {
    this.listeners.delete(callback);
  }

  setRunMode(mode: string): void {
    this.currentMode = mode;
    this.bridge?.setRunMode?.(mode);
  }

  getRunMode(): string {
    return this.bridge?.getRunMode?.() ?? this.currentMode;
  }

  getStatus(): AdapterStatus {
    return {
      isRunning: this.running.size > 0,
      mode: this.getRunMode(),
      activeSessions: this.bridge?.getActiveSessions() ?? [...this.running],
    };
  }

  dispose(): void {
    try { this.bridge?.disposeSnapshotTick?.(); } catch { /* ignore */ }
    this.busSub?.close();
    this.busSub = null;
    this.busLoop = null;
    this.listeners.clear();
    this.running.clear();
    try { this.bus.dispose(); } catch { /* ignore */ }
    this.bridge = null;
  }

  /** 进程内访问 bridge — LocalNeoxClient 据此直接调 replyPermission/replyAskUser/injectMessage 等 (替代 HTTP)。 */
  getBridge(): RuntimeBridge | null {
    return this.bridge;
  }
}
