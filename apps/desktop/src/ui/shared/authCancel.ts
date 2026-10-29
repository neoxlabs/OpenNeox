
/** 主进程 reject 时必须带上它; renderer 靠它认出"这是取消不是故障"。 */
export const AUTH_CANCELED_MARKER = 'NEOX_AUTH_CANCELED';

/** 主进程 cancel 用的完整 message。 */
export const AUTH_CANCELED_MESSAGE = `${AUTH_CANCELED_MARKER}: Login canceled by user`;

/** 这个异常是不是"用户自己取消的" —— 是的话调用方应当静默收场, 不弹错误。 */
export function isUserCanceledAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg.includes(AUTH_CANCELED_MARKER);
}

export function canDismissLogin(state: { loading: boolean; oauthRunning: boolean }): boolean {
  return !state.loading || state.oauthRunning;
}

/**
 * 剥掉 Electron 的 IPC 壳, 只留原始 message。
 *
 * 兜底给**所有**走 ipcRenderer.invoke 的错误用, 不只是登录取消 —— 只要有一条路把原始
 * 异常直接摆给用户, 用户看到的就是 `Error invoking remote method '...'` 这种内部串。
 */
export function stripIpcErrorPrefix(message: string): string {
  if (!message) return message;
  /* Electron 的格式: Error invoking remote method 'channel': Error: 真正的话
   * 可能套多层 (主进程内部又包了一次), 所以循环剥到不动为止。 */
  let out = message;
  for (let i = 0; i < 4; i++) {
    const m = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?([\s\S]+)$/.exec(out.trim());
    if (!m?.[1]) break;
    out = m[1];
  }
  return out.trim();
}
