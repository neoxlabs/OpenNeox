import type { AgentRuntimeHost } from './agentRuntimeHost.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export class HostController {
  private hosts = new Map<string, AgentRuntimeHost>();
  private hostConfigs = new Map<string, string>();
  /** 同时留几个会话的 host. 超出按最久未使用淘汰 (淘汰前先 interrupt, 别留着在跑的). */
  private static MAX_HOSTS = 6;
  private workspacePath: string | null = null;
  /**
   * host 被 LRU 淘汰时的回调。
   * agenticRuntime 用它把**同一个会话的其它 per-session 状态**一起摘掉
   * (sessionMemoryMap / sessionAgentModes / ...) —— 只淘汰 host 而把那些留着,
   * 等于只放掉了一半, 内存照样爬。
   */
  private onEvict: ((sessionId: string) => void) | null = null;

  setEvictListener(fn: (sessionId: string) => void): void {
    this.onEvict = fn;
  }

  setWorkspace(path: string): void {
    this.workspacePath = path;
    for (const host of this.hosts.values()) {
      try {
        host.setWorkDir(path);
      } catch {
        // Ignore per-host failures; caller can log if needed.
      }
    }
  }

  getWorkspace(): string | null {
    return this.workspacePath;
  }

  getHost(sessionId: string): AgentRuntimeHost | undefined {
    return this.hosts.get(sessionId);
  }

  hasHost(sessionId: string): boolean {
    return this.hosts.has(sessionId);
  }

  getHostConfig(sessionId: string): string | undefined {
    return this.hostConfigs.get(sessionId);
  }

  clearHost(sessionId: string): void {
    this.hosts.delete(sessionId);
    this.hostConfigs.delete(sessionId);
  }

  clearAll(): void {
    for (const host of this.hosts.values()) {
      try {
        host.interrupt();
      } catch {
        // Ignore per-host failures
      }
    }
    this.hosts.clear();
    this.hostConfigs.clear();
  }

  forEachHost(callback: (host: AgentRuntimeHost, sessionId: string) => void): void {
    for (const [sessionId, host] of this.hosts.entries()) {
      callback(host, sessionId);
    }
  }

  async getOrCreateHost(options: {
    sessionId: string;
    configKey: string;
    createHost: () => Promise<AgentRuntimeHost>;
  }): Promise<AgentRuntimeHost> {
    const { sessionId, configKey, createHost } = options;
    const existing = this.hosts.get(sessionId);
    if (existing) {
      const previousKey = this.hostConfigs.get(sessionId);
      if (previousKey === configKey) {
        cliLogger.info('HOST_CONTROLLER', `🔄 Reusing existing host for session=${sessionId}, configKey=${configKey}`);
        /* 命中也要挪到队尾 —— Map 按插入序迭代, delete+set 就是"标记为最近使用"。
         * 不挪的话最先创建的先被淘汰, 哪怕它正是用户一直在用的那个会话。 */
        this.hosts.delete(sessionId);
        this.hosts.set(sessionId, existing);
        return existing;
      }
      cliLogger.info('HOST_CONTROLLER', `🗑️ Clearing old host: session=${sessionId}, oldKey=${previousKey}, newKey=${configKey}`);
      this.clearHost(sessionId);
    }

    cliLogger.info('HOST_CONTROLLER', `✨ Creating NEW host: session=${sessionId}, configKey=${configKey}`);
    const host = await createHost();
    this.hosts.set(sessionId, host);
    this.hostConfigs.set(sessionId, configKey);
    if (this.workspacePath) {
      host.setWorkDir(this.workspacePath);
    }
    this.evictOldest();
    return host;
  }

  /**
   * 超出上限就淘汰最久没用的。**先插入再淘汰**, 保证刚建好的这个一定留得住
   * (哪怕上限被调成 1)。淘汰前 interrupt 一次 —— 那个会话早就没人看了, 让它
   * 继续跑只是在烧 token 和 CPU。
   */
  private evictOldest(): void {
    const idle = [...this.hosts.entries()]
      .filter(([, h]) => !(typeof h.isTaskRunning === 'function' && h.isTaskRunning()))
      .map(([sid]) => sid);
    while (this.hosts.size > HostController.MAX_HOSTS && idle.length > 0) {
      const oldest = idle.shift()!;
      const victim = this.hosts.get(oldest);
      try { victim?.interrupt(); } catch { /* 淘汰路径上的失败不该影响新会话 */ }
      this.hosts.delete(oldest);
      this.hostConfigs.delete(oldest);
      try { this.onEvict?.(oldest); } catch { /* 同上 */ }
      cliLogger.info('HOST_CONTROLLER', `♻️ Evicted idle host (LRU): session=${oldest}`);
    }
    if (this.hosts.size > HostController.MAX_HOSTS) {
      cliLogger.info('HOST_CONTROLLER', `host 数 ${this.hosts.size} 超上限 ${HostController.MAX_HOSTS}, 但余下的都在跑 —— 不淘汰`);
    }
  }

  /** 当前留着几个 host —— 给测试和内存排查用。 */
  hostCount(): number {
    return this.hosts.size;
  }
}
