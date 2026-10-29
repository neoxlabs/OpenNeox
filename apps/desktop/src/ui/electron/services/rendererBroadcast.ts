
import { electronOrNull } from '../lazyElectron.js';

/** server 的 EventBus 挂在这个键上 —— 由 neox-core 的 server 在 lite 形态下放进来。 */
const BUS_KEY = '__neoxServerEventBus__';

/** 极简版的 SSE 载荷形状: 渲染层按 channel 分流, 跟 IPC 那侧一一对应。 */
export interface BridgedRendererEvent {
  __neoxChannel: string;
  payload: unknown;
}

/**
 * 推一条事件给渲染层。
 *
 * Electron: 广播到所有窗口, 行为跟以前**一字不差**。
 * 非 Electron: 发到 server EventBus → SSE。
 *
 * 拿不到任何出口时静默返回 —— 这条路上抛异常会把调用方 (通常是流式事件的
 * 热路径) 整条带断, 而丢一条 UI 事件的代价远小于中断一轮对话。
 */
export function sendToRenderer(channel: string, payload: unknown, sessionId?: string): void {
  const electron = electronOrNull();
  if (electron?.BrowserWindow) {
    for (const w of electron.BrowserWindow.getAllWindows()) {
      try {
        if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
        w.webContents.send(channel, payload);
      } catch { /* 窗口正在关闭, 不影响其他窗口 */ }
    }
    return;
  }

  const bus = (globalThis as any)[BUS_KEY];
  if (!bus?.publish) return;
  try {
    bus.publish({
      type: 'bridged',
      sessionId: sessionId ?? '*',
      data: { __neoxChannel: channel, payload } satisfies BridgedRendererEvent,
    });
  } catch { /* 总线满/关闭都不该影响调用方 */ }
}

/** 当前宿主有没有真窗口 —— 少数地方要按这个分支 (比如只在有窗口时才做的聚焦)。 */
export function hasRendererWindows(): boolean {
  const electron = electronOrNull();
  return !!electron?.BrowserWindow?.getAllWindows?.().length;
}
