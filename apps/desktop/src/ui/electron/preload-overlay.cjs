/**
 * preload-overlay.cjs — "computer use 被操控" 叠加层窗口的极简 preload
 *
 * 跟主窗口 preload.cjs (几百个 IPC) 和桌宠 preload-pet.cjs 完全独立. 叠加层只是
 * 一块"画布", 它需要的只有三件事:
 *
 *   onState(cb)          — 订阅 'overlay:state'
 *   onPointer(cb)        — 订阅 'overlay:pointer'
 *   hello()              — 就绪握手
 *   setIgnoreMouse(bool) — 仅 mac: 停在「退出」按钮上时窗口收点击
 *   stop()               — 用户点「退出」
 *
 * 任何敏感能力 (FS / shell / cloud / 主窗口 IPC) 都不暴露 —— 叠加层覆盖全屏且永远置顶,
 * 攻击面必须压到最小.
 */

const { contextBridge, ipcRenderer } = require('electron');

/* 事件 channel 多次 .on 会重复触发, 必须 add/remove 配对. 每个订阅包一层,
 * 返回 unsubscribe 给渲染层调用方. */
function subscribe(channel, handler) {
  const wrapped = (_event, payload) => {
    try {
      handler(payload);
    } catch (e) {
      console.error('[overlayPreload] handler error on', channel, e);
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.off(channel, wrapped);
  };
}

const overlayBridge = {
  onState: (handler) => subscribe('overlay:state', handler),
  onPointer: (handler) => subscribe('overlay:pointer', handler),
  hello: () => ipcRenderer.send('overlay:hello'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('overlay:set-ignore-mouse', !!ignore),
  stop: () => ipcRenderer.send('overlay:stop'),
};

contextBridge.exposeInMainWorld('overlayBridge', overlayBridge);
