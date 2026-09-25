/**
 * BrowserSession — 浏览器生命周期的**唯一真相源**.
 *
 * 一个进程内单例. 三条事件流合并到这里:
 *
 *   1. 工具活动 (tool:start / tool:end) — 通过 withActivity() 一处装饰所有 browser_* tool.
 *      refcount 从 0 → 1 时视作"会话开启" (session:open).
 *
 *   2. Surface 物理打开 (surface:open) — open_surface({kind:'web'}) 时通知.
 *      也算会话开启信号.
 *
 *   3. Turn 边界 (endTurn) — StreamedRunner 一轮结束调一次. refcount==0 时视作
 *      "会话结束" (session:close), 接管层立即释放，浏览器是否关闭由启动器策略决定。
 *
 *   4. 启动器 (registerLauncher) — 把"Chrome 起动"函数注入这里,
 *      browserManager.connect() 缺 CDP 端口时调 ensureLaunched() 让 Chrome 起.
 *
 * 消费者:
 *   - externalChromeManager 订阅 session/surface 事件，管理 Chrome 窗口。
 *   - browserTakeoverController 同步工具活动、控制权和页面租约。
 *   - browserManager.connect() 调 ensureLaunched().
 *
 * 设计约束:
 *   - **不**用 wall-clock idle timer. Turn 边界是明确信号, 不猜.
 *   - **不**依赖 globalThis magic. 全部走导入 + 显式注册.
 *   - browser_* 工具作者不用改工具本体, 装饰在注册处一次装完.
 *   - 单例但纯 in-process, 不跨进程. CLI runtime 里也有一个独立实例.
 */

import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSessionScope } from '@neoxlabs/kernel';

export type BrowserSessionEvent =
  | { type: 'session:open' }
  | { type: 'session:close' }
  | { type: 'tool:start'; tool: string; detail?: string }
  | { type: 'tool:end'; tool: string; success: boolean }
  /** 所有工具结束，立即释放页面输入；会话可保持打开。 */
  | { type: 'tools:idle' }
  | { type: 'control:changed'; owner: 'agent' | 'user' }
  /** 停止 / 中断 / 换会话: 输入交还, 浏览器和标签页都留着。 */
  | { type: 'control:released' }
  | { type: 'surface:open'; surfaceId: string; url: string };

export type BrowserSessionListener = (ev: BrowserSessionEvent) => void;

class BrowserSession {
  private emitter = new EventEmitter();
  private refcount = 0;
  private isOpen = false;
  private launcher: (() => Promise<void>) | null = null;
  private owner: 'agent' | 'user' = 'agent';
  private generation = 0;
  private closePending = false;
  private detail = '';
  private agentSessionId: string | undefined;
  private activity = new AsyncLocalStorage<{ generation: number; signal?: AbortSignal }>();

  /** Late async continuations must not operate after stop or a new session. */
  assertCurrentActivity(): void {
    const current = this.activity.getStore();
    current?.signal?.throwIfAborted();
    if (current && current.generation !== this.generation) throw new Error('浏览器会话已停止');
    if (!current && this.owner === 'user') throw new Error('浏览器由用户控制，请先交还 Agent');
  }

  /** A handoff takes effect after the current atomic tool finishes. */
  setControlOwner(owner: 'agent' | 'user'): void {
    if (!this.isOpen || owner === this.owner) return;
    this.owner = owner;
    this.emit({ type: 'control:changed', owner });
  }

  async waitForAgentControl(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.owner === 'agent') return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        off();
        signal?.removeEventListener('abort', abort);
        clearTimeout(timer);
      };
      const abort = () => { cleanup(); reject(new Error('浏览器操作已停止')); };
      const off = this.on(event => {
        if (event.type === 'session:close') abort();
        else if (event.type === 'control:changed' && event.owner === 'agent') {
          cleanup();
          resolve();
        }
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('用户正在操作浏览器，请等待用户点击“交还 Agent”后再继续。'));
      }, 120_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  /** 订阅事件. 返 unsubscribe. */
  on(listener: BrowserSessionListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** 注册启动器. externalChromeManager 会注册, CLI 场景不注册就是 no-op. */
  registerLauncher(fn: () => Promise<void>): void {
    this.launcher = fn;
  }

  /** 卸载启动器 (mode 切换或关闭). */
  unregisterLauncher(): void {
    this.launcher = null;
  }

  /** browserManager.connect() 缺 CDP 端口时调此. 有启动器就跑, 没有就抛让 caller 报错. */
  async ensureLaunched(): Promise<void> {
    if (!this.launcher) return;
    await this.launcher();
  }

  hasLauncher(): boolean {
    return this.launcher !== null;
  }

  /**
   * 包装一个 tool 调用: 前后 emit 活动事件, 维护 refcount.
   *
   *   const r = await session.withActivity('browser_navigate', 'baidu.com', () => impl(args));
   *
   * 首次 refcount 0→1 emit session:open. Tool 内部错抛出会正确 emit tool:end + 递减.
   */
  async withActivity<R>(
    tool: string,
    detail: string | undefined,
    fn: () => Promise<R>,
    signal?: AbortSignal,
    sessionId = getSessionScope()?.sessionId,
  ): Promise<R> {
    await this.waitForAgentControl(signal);
    signal?.throwIfAborted();
    if (sessionId && this.agentSessionId && sessionId !== this.agentSessionId) {
      if (this.refcount > 0) throw new Error('另一个会话正在使用浏览器，请等待其操作完成');
      this.release();
    }
    if (sessionId) this.agentSessionId = sessionId;
    const generation = this.generation;
    this.beginActivity(tool, detail);
    const abort = () => { if (generation === this.generation) this.release(); };
    signal?.addEventListener('abort', abort, { once: true });
    let success = false;
    try {
      const r = await this.activity.run({ generation, signal }, fn);
      /* Tool 返 {ok:true/false} 结构, 但为了不假设结构, 只要没 throw 就算 success. */
      success = !(r != null && typeof r === 'object' && (r as any).ok === false);
      return r;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (generation === this.generation) this.endActivity(tool, success);
    }
  }

  private beginActivity(tool: string, detail: string | undefined): void {
    this.closePending = false;
    this.detail = detail ? `${tool.replace(/^browser_/, '')} · ${detail}` : tool.replace(/^browser_/, '');
    this.refcount += 1;
    if (!this.isOpen) {
      this.isOpen = true;
      this.emit({ type: 'session:open' });
    }
    this.emit({ type: 'tool:start', tool, detail });
  }

  private endActivity(tool: string, success: boolean): void {
    this.refcount = Math.max(0, this.refcount - 1);
    this.emit({ type: 'tool:end', tool, success });
    if (this.refcount === 0) {
      this.detail = '';
      /* 工具结束即释放输入，不把浏览器保活误当成持续接管。 */
      this.emit({ type: 'tools:idle' });
      if (this.closePending) this.close();
    }
    /* session:close 不在这发 — 等 endTurn 边界. tool 之间可能有短间隙, 关了又开浪费. */
  }

  /**
   * open_surface({kind:'web', url}) 时通知. 会:
   *  1. 若会话未开, emit session:open (触发 Chrome ensure)
   *  2. emit surface:open (externalChromeManager 据此建 tab + 打烙印)
   *
   * 不递增 refcount — surface 是长期存在的容器, 不是短暂 tool 调用.
   */
  notifyWebSurfaceOpen(surfaceId: string, url: string): void {
    if (!this.isOpen) {
      this.agentSessionId = getSessionScope()?.sessionId;
      this.isOpen = true;
      this.emit({ type: 'session:open' });
    }
    this.emit({ type: 'surface:open', surfaceId, url });
  }

  /**
   * StreamedRunner 一轮结束调此. 若无活跃 tool (refcount==0) 且会话已开,
   * emit session:close 释放接管层。
   *
   * 若还有活跃工具，记住关闭请求并在最后一个工具结束后处理。
   */
  endTurn(sessionId?: string): void {
    if (sessionId && this.agentSessionId && sessionId !== this.agentSessionId) return;
    this.closePending = true;
    if (this.isOpen && this.refcount === 0) this.close();
  }

  /** 状态查询 (调试用). */
  getState() {
    return {
      isOpen: this.isOpen, refcount: this.refcount, hasLauncher: this.launcher !== null,
      owner: this.owner, detail: this.detail, generation: this.generation,
      agentSessionId: this.agentSessionId,
    };
  }

  /** Called on runtime stop/dispose/finally, including between tool calls. */
  stopForSession(sessionId?: string): void {
    if (this.agentSessionId && sessionId !== this.agentSessionId) return;
    this.release();
  }

  /**
   * Hand the page back: late tool completions are invalidated and input is unlocked,
   * but the browser and its tabs stay. Stopping a run, an abort or another session
   * taking over is not a reason to close the browser.
   * (It used to emit session:close here too. The default launcher closes Chrome on that,
   * so a stop mid-turn took every tab with it and the next call found no surface.)
   */
  release(): void {
    this.generation += 1;
    this.refcount = 0;
    this.owner = 'agent';
    this.closePending = false;
    this.detail = '';
    if (this.isOpen) this.emit({ type: 'control:released' });
  }

  /** Turn end or reset: release, then let the launcher decide whether the browser closes. */
  private close(): void {
    const wasOpen = this.isOpen;
    this.release();
    this.isOpen = false;
    this.agentSessionId = undefined;
    if (wasOpen) this.emit({ type: 'session:close' });
  }

  /** 强制关闭并通知控制层释放页面。 */
  reset(): void {
    this.close();
  }

  private emit(ev: BrowserSessionEvent): void {
    /* 单个订阅者 throw 不能影响其他订阅者. EventEmitter 默认会同步抛,
     *   包一层 try 保险. */
    for (const listener of this.emitter.listeners('event')) {
      try { (listener as BrowserSessionListener)(ev); } catch { /* 静默 */ }
    }
  }
}

let instance: BrowserSession | null = null;
export function getBrowserSession(): BrowserSession {
  if (!instance) instance = new BrowserSession();
  return instance;
}
