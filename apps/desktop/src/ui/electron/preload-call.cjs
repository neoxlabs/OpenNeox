
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const wrapped = (_event, payload) => {
    try {
      handler(payload);
    } catch (e) {
      console.error('[callPreload] handler error on', channel, e);
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const ACTIONS = new Set(['accept', 'decline', 'snooze', 'hangup', 'mute', 'unmute']);

contextBridge.exposeInMainWorld('callBridge', {
  onState: (handler) => subscribe('pilot-call:state', handler),
  onLive: (handler) => subscribe('pilot-call:live', handler),
  hello: () => ipcRenderer.send('pilot-call:hello'),
  action: (name) => {
    if (ACTIONS.has(name)) ipcRenderer.send('pilot-call:action', name);
  },
});
