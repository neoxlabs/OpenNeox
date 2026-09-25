/**
 * 进程内模式下 SDK 的 HTTP 方法必须有人接 (回归)
 * ═══════════════════════════════════════════════════════════════════════════
 * 用户报: `LocalNeoxClient.post(/mcp/enabled): no handler in this runtime`。
 *
 * 查下来不是一个方法的事: LocalNeoxClient 的 get/post/del 一直在找
 * bridge.handleLocalRequest, 而**全库从来没有人实现过它**。于是 client.ts 里
 * 109 个走 HTTP 的方法中, 49 个没有显式 override 的在进程内模式(桌面默认)下全部必抛 ——
 * 整套 MCP、整套技能、索引、设备、服务配置、语音转写、getToolList 都在里面。
 *
 * 现在 main.ts 把它接到同一个 hono app 上 (app.request 进程内跑路由)。
 * 这个用例钉两件事:
 *   · 有 handler 时: 走得通, 且拿得到路由的真实返回
 *   · 没 handler 时: 必须**抛错**, 不许静默返 undefined
 *     (静默返 undefined 才是最坏的 —— 调用方以为成功了;  就是为这个改成 throw 的)
 */
import { describe, expect, it } from 'vitest';
import { LocalNeoxClient } from '../localNeoxClient.js';

/** 模拟 main.ts 里那段: 把请求分发到 hono app 的等价物 */
function bridgeWithDispatch(routes: Record<string, unknown>) {
  return {
    handleLocalRequest: async (method: string, path: string, body?: unknown) => {
      const key = `${method} ${path}`;
      if (!(key in routes)) throw new Error(`${key} → 404`);
      const v = routes[key];
      return typeof v === 'function' ? (v as (b?: unknown) => unknown)(body) : v;
    },
  };
}

describe('有 handleLocalRequest 时', () => {
  it('isMcpEnabled 拿得到路由的真实返回', async () => {
    const c = new LocalNeoxClient(() => bridgeWithDispatch({
      'GET /mcp/enabled': { enabled: true },
    }) as any);
    await expect(c.isMcpEnabled()).resolves.toBe(true);
  });

  /*这两条原来拿 setMcpEnabled 当"走 HTTP 的样本方法", 后来
   * setMcpEnabled 被**故意**改成直接打 bridge (config 存了但运行中的 runtime 收不到),
   * 于是用例挂在一个已经不走 HTTP 的方法上, 红了却跟它要钉的东西无关。
   * 改成直接量 post()/get() 本身 —— 那才是这组用例真正的被测对象, 而且以后再给哪个
   * 公开方法加 override 都不会把它带红。 */
  it('post() 把 body 送到了路由', async () => {
    let seen: unknown = null;
    const c = new LocalNeoxClient(() => bridgeWithDispatch({
      'POST /mcp/enabled': (b: unknown) => { seen = b; return { status: 'ok' }; },
    }) as any);
    await (c as any).post('/mcp/enabled', { enabled: false });
    expect(seen).toEqual({ enabled: false });
  });

  /* setMcpEnabled 自己的契约: 不走 HTTP, 直接打 bridge (哪怕 bridge 有 handleLocalRequest) */
  it('setMcpEnabled 直接打 bridge, 不回落 HTTP', async () => {
    const calls: unknown[] = [];
    const c = new LocalNeoxClient(() => ({
      setMcpEnabled: (v: boolean) => { calls.push(v); },
      handleLocalRequest: async () => { throw new Error('不该走到 HTTP'); },
    }) as any);
    await c.setMcpEnabled(false);
    expect(calls).toEqual([false]);
  });

  it('listMcpServers / listSkills 这类 GET 也走得通', async () => {
    const c = new LocalNeoxClient(() => bridgeWithDispatch({
      'GET /mcp/servers': [{ name: 'fs' }],
      'GET /skills': { skills: [{ id: 'a' }] },
    }) as any);
    await expect(c.listMcpServers()).resolves.toEqual([{ name: 'fs' }]);
  });
});

describe('没有 handleLocalRequest 时', () => {
  /* 这正是用户碰到的形状 —— 但必须是**响亮的错误**, 不能是静默的 undefined */
  it('抛错而不是静默返回 undefined', async () => {
    const c = new LocalNeoxClient(() => ({}) as any);
    await expect(c.isMcpEnabled()).rejects.toThrow(/no handler in this runtime/);
  });

  it('post 同理', async () => {
    const c = new LocalNeoxClient(() => ({}) as any);
    await expect((c as any).post('/mcp/enabled', { enabled: true }))
      .rejects.toThrow(/no handler in this runtime/);
  });
});

/* 后台任务操作直接调用 bridge，避免进程内请求回落到不存在的 HTTP handler。 */
describe('后台任务操作: 进程内必须直接打 bridge (不许回落 HTTP)', () => {
  function bridgeNoDispatch() {
    const calls: string[] = [];
    return {
      calls,
      /* 故意不提供 handleLocalRequest —— 复现桌面 bridge 的真实形状 */
      killBackgroundTask: (pid: number, force?: boolean) => { calls.push(`kill:${pid}:${!!force}`); },
      pauseBackgroundTask: (pid: number) => { calls.push(`pause:${pid}`); },
      resumeBackgroundTask: (pid: number) => { calls.push(`resume:${pid}`); },
    };
  }

  it('kill / pause / resume 都直达 bridge', async () => {
    const b = bridgeNoDispatch();
    const c = new LocalNeoxClient(() => b as never);
    await c.killBackgroundTask(4321, true);
    await c.pauseBackgroundTask(4321);
    await c.resumeBackgroundTask(4321);
    expect(b.calls).toEqual(['kill:4321:true', 'pause:4321', 'resume:4321']);
  });

  it('bridge 没实现这几个方法时也不抛 —— 上层已按 { ok } 判定, 抛了会变成裸 IPC 异常', async () => {
    const c = new LocalNeoxClient(() => ({}) as never);
    await expect(c.pauseBackgroundTask(1)).resolves.toBeUndefined();
    await expect(c.resumeBackgroundTask(1)).resolves.toBeUndefined();
    await expect(c.killBackgroundTask(1)).resolves.toBeUndefined();
  });
});
