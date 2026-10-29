
export type LogoutContext = {
  /** 登出前的 userId, null 表示之前是匿名态 */
  previousUserId: string | null;
};

export type LogoutHandler = (ctx: LogoutContext) => Promise<void> | void;

const handlers: LogoutHandler[] = [];

/** 注册登出清理回调 — main 模块 init 时调一次, 模块自释放. */
export function onLogout(handler: LogoutHandler): void {
  handlers.push(handler);
}

/** 顺序触发所有登出回调. 单个 handler 抛错被吞, 不影响其他. */
export async function runLogout(ctx: LogoutContext): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler(ctx);
    } catch (err: any) {
      console.error('[logoutBus] handler failed:', err?.message ?? err);
    }
  }
}

/** 测试用 — 清空注册的 handler 列表. 生产代码不该调. */
export function __resetForTests(): void {
  handlers.length = 0;
}
