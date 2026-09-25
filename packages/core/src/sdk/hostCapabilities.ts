/**
 * hostCapabilities — worker → 宿主 的反向调用契约
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── 修的是什么 ──────────────────────────────────────────────────────────────
 * agent runtime 跑在 worker 线程上, 而有些工具需要的数据**只有宿主那一侧拿得到**:
 *
 *   read_lints      → Monaco 的 getModelMarkers(), 数据在**渲染进程**里
 *   terminal_execute → 用户看得见的那个终端面板, 也在渲染进程
 *
 * 桌面端在主进程的 AgentBridge 里 setDiagnosticsExecutor / setTerminalExecutor 注册了
 * 执行器, 但那是**主进程的模块实例**; worker 是另一个线程、另一份模块, 它那边的注册表
 * 永远是空的。于是 read_lints 恒返回 "IDE diagnostics bridge unavailable
 * (desktop UI not connected)" —— 桌面端明明连着, 误导性极强。
 *
 * ── 为什么不是"每个 worker 自己注册一个" ────────────────────────────────────
 * 因为数据源不在 worker 也不在主进程, 在**渲染进程**。主进程自己也只是中转
 * (webContents.send → renderer 读 Monaco → ipc 回来)。让 worker "自己有一份" 就得把
 * 全部 marker 实时同步过去 —— 同步一份不停变化的数据, 比"用的时候问一次"贵得多,
 * 而且必然滞后。按需问一次才是对的形状。
 *
 * ── 为什么不新建通道 ────────────────────────────────────────────────────────
 * worker 主线程之间**早就有**一条完整的请求/响应通道 (reqId + pending map):
 *     主线程 → worker   { type: 'call',   reqId, method, args }
 *     worker → 主线程   { type: 'result', reqId, ok, value }
 * 缺的只是**反方向**。所以这里加的是同一条通道上的反向车道, 不是第二条通道:
 *     worker → 主线程   { type: 'host-call',   reqId, capability, args }
 *     主线程 → worker   { type: 'host-result', reqId, ok, value }
 *
 * reqId 两个方向各自独立编号 (各有各的 pending map), 不会撞。
 *
 * ── 加一个新能力要动哪几处 ──────────────────────────────────────────────────
 *   1. 这里的 HostCapabilityMap 加一行 (签名即契约)
 *   2. 宿主侧 setHostCapabilities({ ... }) 里实现它
 *   3. worker 侧把它接到对应的 setXxxExecutor 上
 * 三处都在本文件注释里指得出来, 不需要另找地方。
 */

/** worker 能反向调用的宿主能力 —— 签名就是契约, 两侧共用这一份类型。 */
export interface HostCapabilityMap {
  /** IDE 实时诊断 (Monaco getModelMarkers) —— read_lints 用。 */
  diagnostics: (options: { paths?: string[]; limit?: number }) => Promise<unknown>;
  /** 在宿主的终端面板里执行 —— terminal_execute 那一类用。 */
  terminal: (options: unknown) => Promise<unknown>;
  /**
   * HTML → PDF (Chromium printToPDF) —— word → PDF / 调研报告导出用。
   * neox-core 对 electron 零依赖, 而 printToPDF 只有主进程有, 所以必须走这条反向 RPC。
   */
  htmlToPdf: (options: unknown) => Promise<unknown>;
}

export type HostCapabilityName = keyof HostCapabilityMap;

/** worker → 主线程 的请求。 */
export interface HostCallMessage {
  type: 'host-call';
  reqId: number;
  capability: HostCapabilityName;
  args: unknown[];
}

/** 主线程 → worker 的应答。 */
export interface HostResultMessage {
  type: 'host-result';
  reqId: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** 宿主没实现某个能力时 worker 侧收到的错误前缀 —— 调用方据此区分"没接线"和"跑失败了"。 */
export const HOST_CAPABILITY_UNAVAILABLE = 'host capability unavailable';

/**
 * 宿主侧注册表。
 *
 *   桌面端在 AgentBridge 构造时调一次, 把它已经有的 requestEditorDiagnostics /
 *   requestTerminalExecution 挂进来。CLI 宿主没有渲染进程, 不注册 —— worker 那边
 *   照旧拿不到能力, 工具如实说"不可用", 行为跟今天一致 (不会因为这条通道而变坏)。
 */
let hostCapabilities: Partial<HostCapabilityMap> = {};

export function setHostCapabilities(caps: Partial<HostCapabilityMap>): void {
  hostCapabilities = { ...hostCapabilities, ...caps };
}

export function getHostCapability<K extends HostCapabilityName>(
  name: K,
): HostCapabilityMap[K] | undefined {
  return hostCapabilities[name] as HostCapabilityMap[K] | undefined;
}

/** 测试用 —— 清空注册表, 免得用例之间互相污染。 */
export function resetHostCapabilities(): void {
  hostCapabilities = {};
}
