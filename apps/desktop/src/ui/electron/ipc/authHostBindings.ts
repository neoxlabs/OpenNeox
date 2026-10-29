
export interface AuthHostBindings {
  broadcastAuthChanged(payload: Record<string, unknown>, excludeId?: number): void | Promise<void>;

  /**
   * 宿主的 userData 目录 —— **只用于旧路径兼容**。
   * 返回 null = 没有这个概念 (非 Electron 宿主), 跳过兼容检查即可。
   */
  legacyUserDataDir(): string | null;

  /** 应用版本 / 是否打包态 —— 拿不到就给保守值, 不影响主流程。 */
  appVersion(): string;
  isPackaged(): boolean;
}

/** 默认: 全是安全空实现。没注入宿主时 auth 逻辑照常工作, 只是不广播。 */
const NOOP_BINDINGS: AuthHostBindings = {
  broadcastAuthChanged: () => {},
  legacyUserDataDir: () => null,
  appVersion: () => '',
  isPackaged: () => true,
};

let current: AuthHostBindings = NOOP_BINDINGS;

/**
 * 宿主在启动时调一次。
 * Electron 在 main.ts 里注入 BrowserWindow 广播; Tauri 侧的后端注入事件总线推送。
 */
export function setAuthHostBindings(b: Partial<AuthHostBindings>): void {
  current = { ...NOOP_BINDINGS, ...b };
}

export function authHost(): AuthHostBindings {
  return current;
}
