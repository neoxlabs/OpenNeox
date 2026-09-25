
import { parentPort } from 'node:worker_threads';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '../server/eventBus.js';
import { initRuntimeBridge } from '../server/main.js';
import type { RuntimeBridge } from '../server/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import {
  HOST_CAPABILITY_UNAVAILABLE,
  type HostCapabilityName,
  type HostResultMessage,
} from './hostCapabilities.js';
import { resolveRuntimeEndpoint } from './runtimeEndpoint.js';

interface WorkerInit {
  workDir: string;
  identityDir: string;
  deviceFp?: string;
}

async function main(): Promise<void> {
  const endpoint = resolveRuntimeEndpoint();
  const port = { postMessage: endpoint.post, on: (_evt: 'message', cb: (m: any) => void) => endpoint.onMessage(cb) };
  const { workDir, identityDir, deviceFp } = endpoint.init as WorkerInit;
  cliLogger.info('WORKER_RT', `runtime endpoint = ${endpoint.kind}`);

  if (endpoint.kind === 'worker') {
    const { createHostedWatcherClient } = await import('@neoxlabs/platform');
    const { setWatchSubscribeOverride } = await import('../runtime/watch/WatchCoordinator.js');
    const watchClient = createHostedWatcherClient((m) => endpoint.post(m));
    endpoint.onMessage((m) => { watchClient.handle(m); });
    setWatchSubscribeOverride(watchClient.subscribe);
  }

  try {
    const proxyMod = await import('@neoxlabs/platform/platform/systemProxy.js');
    const r = proxyMod.applySystemProxySync();
    cliLogger.info('WORKER_RT', r.detected
      ? `systemProxy: source=${r.source} http=${r.httpProxy || '-'} https=${r.httpsProxy || '-'} socks=${r.socksProxy || '-'} pac=${r.pacUrl || '-'}`
      : 'systemProxy: 系统未配置代理 — 直连');
    proxyMod.startSystemProxyWatch(30000);
  } catch (err: any) {
    cliLogger.warn('WORKER_RT', `systemProxy 安装失败, worker 将直连: ${err?.message ?? err}`);
  }

  try {
    const { loadConfig } = await import('@neoxlabs/platform/utils/config.js');
    const lang = (loadConfig() as { language?: string })?.language === 'en' ? 'en' : 'zh';
    process.env.NEOX_LANGUAGE = lang;
    cliLogger.info('WORKER_RT', `ui language = ${lang} (错误文案按它由网关出)`);
  } catch { /* 读不到就按中文, 跟网关的兜底一致 */ }

  try {
    const { setNeoxDeviceFp } = await import('@neoxlabs/kernel/models/openai.js');
    setNeoxDeviceFp(deviceFp || '');
    cliLogger.info('WORKER_RT', `device fp ${deviceFp ? 'injected (' + deviceFp.slice(0, 8) + '...)' : 'EMPTY'}`);
  } catch (fpErr: any) {
    cliLogger.warn('WORKER_RT', `device fp inject failed: ${fpErr?.message ?? fpErr}`);
  }

  /* 1. 凭据真源 — 与 LocalRuntimeAdapter.doInit 一致 (按 identityDir 现取本端网关凭据)。 */
  try {
    const { installDbBasedRoutingResolver, setCredentialProvider } = await import('@neoxlabs/platform/platform/providerResolver.js');
    const routingFile = process.env.NEOX_ROUTING_FILE || path.join(os.homedir(), NEOX_HOME_DIRNAME, 'routing.json');
    await installDbBasedRoutingResolver(routingFile);
    const { readGatewayCredentialFromDir, readIdentityUserId } = await import('@neoxlabs/platform/platform/identityCredential.js');
    setCredentialProvider(() => readGatewayCredentialFromDir(identityDir));
    try {
      const uid = readIdentityUserId(identityDir);
      if (uid) {
        const { setCurrentUserId } = await import('@neoxlabs/platform/utils/config.js');
        setCurrentUserId(uid);
      }
    } catch { /* 非致命 */ }
    cliLogger.info('WORKER_RT', `credential provider installed (identity-dir=${identityDir})`);
  } catch (err: any) {
    cliLogger.warn('WORKER_RT', `credential setup failed: ${err?.message ?? err}`);
  }

  /* 2. worker 内组装完整 bridge (复用 server/Local 同一套 initRuntimeBridge)。 */
  const bus = new EventBus();
  const bridge: RuntimeBridge = await initRuntimeBridge(workDir, bus);

  /* 3. 订阅 bus → postMessage 回主线程 (替代 SSE / in-process 直接回调)。
   *    隔离关键: 事件在 worker 循环上产生, postMessage 跨线程 (= libuv macrotask 投递),
   *    主线程 Ink 的 16ms 渲染/心跳 timer 天然穿插, 不会被 runtime 灌爆。 */
  const sub = bus.subscribe();
  void (async () => {
    try {
      for await (const ev of sub) {
        try {
          const data = ev.data;
          const event = (data && typeof data === 'object' && !(data as { sessionId?: string }).sessionId)
            ? { ...(data as object), sessionId: ev.sessionId }
            : data;
          port.postMessage({ type: 'event', event, tracker: ev.tracker ?? null });
        } catch { /* 主线程已退/不可结构化克隆的事件丢弃, 不阻塞 */ }
      }
    } catch { /* sub 已 close */ }
  })();

  /* 4. RPC: 主线程的 bridge 方法调用 (chat/abort/inject/replyPermission/checkpoints/...)。
   *    chat 会 await 整个 turn 完成才回 result (与 LocalRuntimeAdapter.chat 行为一致)。 */
  let hostSeq = 0;
  const hostPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const callHost = (capability: HostCapabilityName, ...args: unknown[]): Promise<unknown> => {
    const reqId = ++hostSeq;
    return new Promise<unknown>((resolve, reject) => {
      hostPending.set(reqId, { resolve, reject });
      const timer = setTimeout(() => {
        if (hostPending.delete(reqId)) reject(new Error(`host call timeout: ${capability}`));
      }, 30_000);
      /* 结果回来时清掉定时器 —— 不清的话 worker 要多活 30 秒才肯退 */
      const entry = hostPending.get(reqId);
      if (entry) {
        const origResolve = entry.resolve; const origReject = entry.reject;
        entry.resolve = (v) => { clearTimeout(timer); origResolve(v); };
        entry.reject = (e) => { clearTimeout(timer); origReject(e); };
      }
      try {
        port.postMessage({ type: 'host-call', reqId, capability, args });
      } catch (err) {
        clearTimeout(timer);
        hostPending.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  /* 把宿主能力接到工具侧的执行器注册表上 —— 工具代码一行不用改, 它只知道
   * "有没有 executor"。宿主没实现时 callHost 会拿到 unavailable 错误, 工具那边
   * 照旧走它自己的兜底话术。 */
  try {
    const { setDiagnosticsExecutor, setTerminalExecutor, setPdfExporter } = await import('../tools/runtimeTools.js');
    setDiagnosticsExecutor(((options: unknown) => callHost('diagnostics', options)) as never);
    setTerminalExecutor(((options: unknown) => callHost('terminal', options)) as never);
    setPdfExporter(((options: unknown) => callHost('htmlToPdf', options)) as never);
  } catch (err) {
    cliLogger.warn('WORKER', `宿主能力桥接失败 (工具将回落到各自的兜底): ${String(err)}`);
  }

  try {
    const { onComputerPointer } = await import('@neoxlabs/platform/shared/computerPointerBus.js');
    onComputerPointer((event) => {
      try {
        port.postMessage({ type: 'os-pointer', event });
      } catch { /* 主线程已退, 丢弃 */ }
    });
  } catch { /* 没有叠加层动画也不影响操作 */ }

  port.on('message', async (msg: any) => {
    /* 宿主的应答先接住 —— 它跟下面的 'call' 是两个方向, 不能互相吞 */
    if (msg?.type === 'host-result') {
      const m = msg as HostResultMessage;
      const p = hostPending.get(m.reqId);
      if (!p) return;
      hostPending.delete(m.reqId);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error || HOST_CAPABILITY_UNAVAILABLE));
      return;
    }
    if (msg?.type === 'os-control') {
      if (msg.op === 'abort') {
        try {
          const { abortComputerSession } = await import('../runtime/computer/computerAbort.js');
          abortComputerSession();
        } catch { /* 没在跑 computer use */ }
      }
      return;
    }
    if (!msg || msg.type !== 'call') return;  /* fsw-* 由上面那个监听者接 */
    const { reqId, method, args } = msg;
    try {
      const fn = (bridge as any)[method];
      if (typeof fn !== 'function') {
        port.postMessage({ type: 'result', reqId, ok: true, value: undefined });
        return;
      }
      const value = await fn.apply(bridge, Array.isArray(args) ? args : []);
      port.postMessage({ type: 'result', reqId, ok: true, value });
    } catch (err: any) {
      port.postMessage({ type: 'result', reqId, ok: false, error: String(err?.message ?? err) });
    }
  });

  port.postMessage({ type: 'ready' });
}

main().catch((err: any) => {
  try { parentPort?.postMessage({ type: 'fatal', error: String(err?.message ?? err) }); } catch { /* ignore */ }
});
