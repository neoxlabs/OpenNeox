/**
 * preload-pet.cjs — 桌宠 BrowserWindow 的极简 preload
 *
 * 跟主窗口 preload.cjs (1064 行, 暴露几百个 IPC) 完全独立. pet 窗口不该看见
 * 主窗口的任何能力 (workspace / git / 编辑器 / cloud / runtime...). 只暴露
 * 桌宠自己需要的几个通道:
 *
 *   getConfig() / onConfigChange()   — 跟主进程拿配置 (主窗口里 PetTab 改了会推过来)
 *   onAgentEvent()                   — 接收主进程转发的 agent 事件 (主窗口订阅 → 过滤 → 推)
 *   startDrag/drag/endDrag           — 拖动整个窗口 (main 用 setBounds, 不动 DOM)
 *   dismiss()                        — 用户右键 → 关掉窗口 (跟 cfg.enabled=false 等价)
 *   recenter()                       — debug 用
 *
 * IPC 最小化的好处: 攻击面小 (pet 窗口本质是用户 .glb 文件运行的环境, 未来可能跑用户代码),
 * 任何敏感能力 (FS / shell / cloud) 都不暴露. 即使 .glb 里有恶意 shader, 也只能
 * crash 当前 pet 窗口, 主进程毫发无损.
 */

const { contextBridge, ipcRenderer } = require('electron');

/* 事件 channel 用单一名 'pet:agent-event' / 'pet:config-changed', 多次 .on 会重复触发,
 * 必须 add/remove 配对. 这里给每个订阅函数挂个 wrap, return 一个 unsubscribe. */
function subscribe(channel, handler) {
  const wrapped = (_event, payload) => {
    try {
      handler(payload);
    } catch (e) {
      console.error('[petPreload] handler error on', channel, e);
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.off(channel, wrapped);
  };
}

const petBridge = {
  getConfig: () => ipcRenderer.invoke('pet:get-config'),

  onConfigChange: (handler) => subscribe('pet:config-changed', handler),
  onAgentEvent:   (handler) => subscribe('pet:agent-event', handler),

  /* 拖动: main 进程那侧维护 "drag session" — startDrag 记起点, drag 累计 delta,
   * endDrag 做吸附. renderer 不直接 setBounds (跨进程, 慢), 全走 main process. */
  startDrag: () => ipcRenderer.send('pet:start-drag'),
  drag: (dx, dy) => ipcRenderer.send('pet:drag', { dx, dy }),
  endDrag: () => ipcRenderer.send('pet:end-drag'),

  dismiss: () => ipcRenderer.send('pet:dismiss'),
  recenter: () => ipcRenderer.send('pet:recenter'),
};

contextBridge.exposeInMainWorld('petBridge', petBridge);
