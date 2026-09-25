/**
 * 通用 IPC 桥 —— 让 Electron 的 handler 在非 Electron 宿主里也能被调到。
 *
 * ── 设计 ─────────────────────────────────────────────────────────
 * renderer 那 19 万行认的是 `window.neox` 那套 preload API, 底下全是
 * `ipcMain.handle(channel, fn)`。极简版 (Tauri 壳 + Node 后端) 没有 ipcMain,
 * 因此非 Electron 宿主需要一个与 preload API 共享的路由表，避免为每个方法维护独立垫片。
 *
 * 所以不逐个手写, 而是把注册动作**同时记进一张普通的路由表**:
 *   Electron 宿主  → ipcMain.handle 照旧, 行为一字不变
 *   非 Electron 宿主 → 后端从这张表按 channel 名找函数直接调
 *
 * 注册动作同时保留 Electron 的 ipcMain.handle 行为，并让非 Electron 宿主按 channel
 * 查表调用；依赖窗口、更新和系统对话框的 handler 仍由各自宿主提供。
 *
 *  桥**不做能力放宽**: 它只是换了个调用入口, 不改变任何一个 handler 的行为和权限。
 * 后端那侧照旧走强制鉴权 —— 别把这里当成绕过鉴权的后门。
 */

/**
 * handler 的统一形状 —— 跟 ipcMain.handle 的回调对齐。
 *
 * event 用 `any` 而不是 `unknown`: 现有 handler 大量把它当 IpcMainInvokeEvent 用
 * (取 sender 解析 workspace scope 等), 收成 unknown 会让 65 个文件全报类型错,
 * 而那不是真问题 —— 桥只是换了调用入口, 没改变 handler 看到的东西。
 * 非 Electron 宿主传 undefined 进去, 那些依赖 event 的分支自己会走兜底
 * (它们本来就要处理"拿不到 sender"的情况, 见 scopeResolvers 的注释)。
 */
export type BridgeHandler = (event: any, ...args: any[]) => any;

/**
 * 路由表挂在 globalThis 上, **不能**是模块级的裸 Map。
 *
 * 极简版的后端由两个独立 bundle 组成: server/main.js 和 server/liteHandlers.js。
 * tsup 会把这个模块**各内联一份**进去 —— 于是 handler 注册进 liteHandlers 那份表,
 * 转发端点查的却是 main 那份, 两份各写各的。
 *
 * 打包器可能把该模块分别内联到多个 bundle；如果每份 bundle 持有自己的 Map，
 * 注册方与调用方就会看到不同的路由。globalThis 保证同一进程内的模块副本共享表。
 */
const GLOBAL_KEY = '__neoxIpcBridgeRoutes__';
const g = globalThis as unknown as Record<string, Map<string, BridgeHandler> | undefined>;
const routes: Map<string, BridgeHandler> = g[GLOBAL_KEY] ?? (g[GLOBAL_KEY] = new Map());

/**
 * 记一条路由。由 registerIpc (下面那个包装) 自动调用, 业务代码不用直接碰。
 *
 * 重复注册直接覆盖并告警 —— 两个地方抢同一个 channel 是真 bug,
 * 静默覆盖的话表现为"某个功能偶尔走错分支", 极难查。
 */
export function registerBridgeRoute(channel: string, fn: BridgeHandler): void {
  if (routes.has(channel)) {
    console.warn(`[ipcBridge] channel 重复注册, 后者覆盖前者: ${channel}`);
  }
  routes.set(channel, fn);
}

/**
 * 取出某条路由的 handler 本身。
 *
 * 给需要**自己传 event** 的调用方用 —— 主要是测试: 有些 handler 靠 event.sender
 * 反查窗口 scope, 而 invokeBridge 按非 Electron 宿主的语义固定传 undefined。
 * 业务代码一律走 invokeBridge, 别用这个绕过去。
 */
export function getBridgeRoute(channel: string): BridgeHandler | undefined {
  return routes.get(channel);
}

export function hasBridgeRoute(channel: string): boolean {
  return routes.has(channel);
}

/** 给后端做诊断/自检用 —— 知道桥上到底有哪些 channel。 */
export function bridgeChannels(): string[] {
  return [...routes.keys()].sort();
}

/**
 * 调一条路由。找不到时抛一个**说清楚是什么情况**的错 ——
 * 这类错最容易被当成"功能坏了", 其实是"这个宿主没注册那个 handler"。
 */
export async function invokeBridge(channel: string, args: unknown[]): Promise<unknown> {
  const fn = routes.get(channel);
  if (!fn) {
    throw new Error(
      `[ipcBridge] 没有注册 channel: ${channel} —— `
      + `要么这个 handler 依赖 Electron 没在当前宿主注册, 要么 preload 和 handler 对不上名。`,
    );
  }
  return fn(undefined, ...args);
}
