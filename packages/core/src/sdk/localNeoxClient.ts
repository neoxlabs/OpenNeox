
import { NeoxClient } from './client.js';
import type { RuntimeBridge, RunStateSnapshot } from '../server/index.js';

export class LocalNeoxClient extends NeoxClient {
  private readonly activeChats = new Map<string, Promise<void>>();
  private readonly pendingAborts = new Map<string, Promise<void>>();
  constructor(private readonly getBridge: () => RuntimeBridge | null) {
    // baseUrl 不会被用到 (CLI 用到的方法全覆盖); 仅满足父类构造。
    super('http://local.inprocess');
  }

  private get b(): RuntimeBridge | null {
    return this.getBridge();
  }

  // ── 回复 (关键路径) ──
  override async abort(sessionId: string): Promise<void> {
    const pending = this.pendingAborts.get(sessionId);
    if (pending) return pending;
    const bridge = this.b;
    if (!bridge) throw new Error('Runtime not ready');
    const chat = this.activeChats.get(sessionId);
    const operation = (async () => {
      // Worker bridges return a promise even though the in-process bridge is synchronous.
      await bridge.abort(sessionId);
      await chat?.catch(() => undefined);
      if (this.activeChats.get(sessionId) === chat) this.activeChats.delete(sessionId);
    })();
    this.pendingAborts.set(sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.pendingAborts.get(sessionId) === operation) this.pendingAborts.delete(sessionId);
    }
  }

  override async getRunState(sessionId: string): Promise<RunStateSnapshot> {
    return this.b?.getRunState?.(sessionId) ?? {
      sessionId,
      status: 'idle',
      running: false,
      /* bridge 不存在 = 没有任何东西在执行, executing 必须同为 false。
       * 这个兜底对象的语义是"查不到就是空闲", 与 running 保持一致。 */
      executing: false,
      /* 连 bridge 都没有 = 这里没有任何关于它的信息, 不是"它空闲"。
       * 下游拿 known=false 的快照去收敛别人的运行态是不成立的。 */
      known: false,
      pendingToolCalls: [],
      updatedAt: 0,
      observedAt: Date.now(),
    };
  }

  override async getRunStates(sessionIds?: string[]): Promise<RunStateSnapshot[]> {
    return this.b?.getRunStates?.(sessionIds) ?? [];
  }

  override async replyPermission(requestId: string, approved: boolean, message?: string, remember?: boolean): Promise<void> {
    this.b?.replyPermission(requestId, approved, message, remember);
  }

  override async replyAskUser(
    requestId: string,
    answers: Record<string, string>,
  ): Promise<{ status: 'resolved' | 'resumed' | 'orphan'; reason?: string }> {
    const r = await this.b?.replyAskUser?.(requestId, answers);
    return r ?? { status: 'orphan' };
  }

  override async injectMessage(sessionId: string, message: string, images?: Array<{ mediaType: string; data: string; name?: string }>): Promise<number> {
    const r = await this.b?.injectMessage?.(sessionId, message, images);
    return typeof r === 'number' ? r : 0;
  }

  override async removeLastPendingMessage(sessionId: string): Promise<string | null> {
    return (await this.b?.removeLastPendingMessage?.(sessionId)) ?? null;
  }

  override async setRunMode(mode: string): Promise<void> {
    await this.b?.setRunMode?.(mode);
  }

  override async killBackgroundTask(pid: number, force?: boolean): Promise<void> {
    await this.b?.killBackgroundTask?.(pid, force);
  }

  override async pauseBackgroundTask(pid: number): Promise<void> {
    await this.b?.pauseBackgroundTask?.(pid);
  }

  override async resumeBackgroundTask(pid: number): Promise<void> {
    await this.b?.resumeBackgroundTask?.(pid);
  }

  override async setBackgroundTaskPersistent(pid: number, persistent: boolean): Promise<void> {
    await (this.b as any)?.setBackgroundTaskPersistent?.(pid, persistent);
  }

  // ── 审批模式 ──
  override async setApprovalMode(
    sessionId: string,
    mode: 'auto' | 'manual' | 'dangerous',
    options?: {
      scope?: 'global' | 'agent';
      scopeKey?: string;
      inherit?: boolean;
      dangerousConfirmation?: { acknowledgeNoApproval: true; acknowledgeHighRiskExecution: true };
    },
  ): Promise<void> {
    await this.b?.setApprovalMode?.(sessionId, mode, options as any);
  }

  override async getApprovalMode(sessionId: string): Promise<{ mode: 'auto' | 'manual' | 'dangerous' }> {
    const mode = await this.b?.getApprovalMode?.(sessionId);
    return { mode: (mode as any) ?? 'auto' };
  }

  // ── 内存 / 上下文 ──
  override async compactSession(sessionId: string): Promise<void> {
    await this.b?.compactSession?.(sessionId);
  }

  override async setAgentMode(sessionId: string, mode: string): Promise<string> {
    return this.b?.setAgentMode?.(sessionId, mode) ?? 'code';
  }

  override async jevPrefetch(text: string): Promise<void> {
    await this.b?.jevPrefetch?.(text);
  }

  override async getAgentMode(sessionId: string): Promise<string> {
    return this.b?.getAgentMode?.(sessionId) ?? 'code';
  }

  override async getSessionInfo(sessionId: string): Promise<any> {
    return this.b?.getSessionInfo?.(sessionId);
  }

  override async setCompressionMode(sessionId: string, mode: 'sync' | 'async'): Promise<void> {
    await (this.b as any)?.setCompressionMode?.(sessionId, mode);
  }

  override async setContextCompression(
    sessionId: string,
    next: { mode?: 'sync' | 'async'; threshold?: number; autoEnabled?: boolean },
  ): Promise<void> {
    await (this.b as any)?.setContextCompression?.(sessionId, next);
  }

  override async getMemoryStats(sessionId: string): Promise<{ length: number; contextHealth: any }> {
    return (await this.b?.getMemoryStats?.(sessionId)) ?? { length: 0, contextHealth: null };
  }

  override async clearMemory(sessionId: string): Promise<void> {
    await this.b?.clearMemory?.(sessionId);
  }

  override async setSandboxMode(sessionId: string, enabled: boolean): Promise<void> {
    await (this.b as any)?.setSandboxMode?.(sessionId, enabled);
  }

  override async setWorkspace(workDir: string): Promise<void> {
    await this.b?.setWorkspace?.(workDir);
  }

  override async setTTSEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    const r = (this.b as any)?.setTTSEnabled?.(enabled);
    return (r && typeof r === 'object') ? r : { enabled };
  }

  override async updateTTSConfig(config: any): Promise<{ enabled: boolean }> {
    /* 漏 override 曾致设置页改 TTS 永远推不进进程内 daemon (基类 post /tts/config
     * 在 local runtime 直接 throw), BYOK 配置只落盘不生效, 每次都要重启 */
    await (this.b as any)?.updateTTSConfig?.(config);
    return { enabled: !!config?.enabled };
  }

  override async ttsSpeak(text: string): Promise<{ audio?: string; format?: string; voiceSummary?: string; error?: string }> {
    /* 同 updateTTSConfig 的教训: 必须 override, 基类 HTTP 路由在进程内 runtime 会 throw */
    const r = await (this.b as any)?.speakTTS?.(text);
    return (r && typeof r === 'object') ? r : { error: '合成失败 — 检查设置里的语音合成配置' };
  }


  /** 语音输入落到这儿的是 dashscope / 官方等"非 local 非 custom"档 ——
   *  没有这个 override, 那些档位的语音输入在桌面端**必然失败**。 */
  override async transcribeAudio(audioBase64: string, format?: string): Promise<{ text: string }> {
    const r = await (this.b as any)?.transcribeAudio?.(audioBase64, format);
    return (r && typeof r === 'object') ? r : { text: '' };
  }

  /** MCP 开关: 没有它, config 存了但**运行中的 runtime 收不到**, 要重启才生效 */
  override async setMcpEnabled(enabled: boolean): Promise<void> {
    await (this.b as any)?.setMcpEnabled?.(enabled);
  }

  /** /status 的进程内等价物 —— 缺它时 handler 只能吞掉异常回 { activeSessions: [] },
   *  于是"活跃会话"永远是空的。 */
  override async getStatus(): Promise<any> {
    const b = this.b as any;
    return {
      status: b ? 'ok' : 'unavailable',
      uptime: typeof process !== 'undefined' ? process.uptime() : 0,
      pid: typeof process !== 'undefined' ? process.pid : 0,
      workDir: '',
      activeSessions: b?.getActiveSessions?.() ?? [],
      mode: b?.getRunMode?.() ?? 'agentic',
      version: b?.getVersion?.() ?? '',
    };
  }

  override async getIndexStats(): Promise<any> {
    return (await (this.b as any)?.getIndexStats?.())
      ?? { hasIndex: false, fileCount: 0, symbolCount: 0, lastUpdated: null, size: 0 };
  }

  override async buildIndex(force?: boolean): Promise<any> {
    return (await (this.b as any)?.buildIndex?.(force))
      ?? { success: false, filesIndexed: 0, symbolsFound: 0, timeMs: 0, errors: [] };
  }

  override async clearIndex(): Promise<void> {
    await (this.b as any)?.clearIndex?.();
  }

  override async searchIndex(query: string, kind?: string, limit?: number): Promise<any[]> {
    return (await (this.b as any)?.searchIndex?.(query, kind, limit)) ?? [];
  }

  override async setAuth(config: { enabled?: boolean; token?: string }): Promise<{ enabled: boolean }> {
    // 进程内无远程 LAN server 概念 — auth 仅对 remote 模式有意义, 这里 no-op 回 echo。
    return { enabled: config.enabled ?? false };
  }

  // ── Chat (核心路径 — 进程内直调 bridge, fire-and-forget) ──
  override async chat(sessionId: string, prompt: string, opts?: any): Promise<void> {
    const stopping = this.pendingAborts.get(sessionId);
    if (stopping) await stopping;
    const bridge = this.b;
    if (!bridge) throw new Error('Runtime not ready');
    if (typeof prompt !== 'string') {
      throw new Error('chat prompt must be a string (got ' + typeof prompt + ')');
    }
    const promptPreview = prompt.slice(0, 40);
    console.log('[LocalNeoxClient] chat() → bridge.chat fire-and-forget', { sessionId: sessionId.slice(0, 20), prompt: promptPreview });
    if (this.activeChats.has(sessionId)) throw new Error('Session is still running');
    const completion = bridge.chat(sessionId, {
      ...(opts ?? {}),
      prompt,
    });
    this.activeChats.set(sessionId, completion);
    const release = () => {
      if (this.activeChats.get(sessionId) === completion) this.activeChats.delete(sessionId);
    };
    void completion.then(() => {
      release();
      console.log('[LocalNeoxClient] bridge.chat() completed for', sessionId.slice(0, 20));
    }, (err: any) => {
      release();
      console.error('[LocalNeoxClient] bridge.chat() FAILED:', err?.stack ?? err?.message ?? err);
    });
  }

  // ── 暂停/恢复 ──
  override async pauseAll(sessionId: string): Promise<any> {
    return (this.b as any)?.pauseAll?.(sessionId) ?? { mainPaused: false, workersPaused: 0 };
  }

  override async resumeAll(sessionId: string): Promise<any> {
    return (this.b as any)?.resumeAll?.(sessionId) ?? { mainResumed: false, workersResumed: 0 };
  }

  override async pauseProcess(pid: string): Promise<any> {
    return (this.b as any)?.pauseProcess?.(pid) ?? { paused: false };
  }

  override async resumeProcess(pid: string): Promise<any> {
    return (this.b as any)?.resumeProcess?.(pid) ?? { resumed: false };
  }

  // ── 健康/诊断 ──
  override async isHealthy(): Promise<boolean> {
    return this.b != null;
  }

  override async getContextHealth(sessionId: string): Promise<any> {
    return (this.b as any)?.getContextHealth?.(sessionId) ?? null;
  }

  override async clearSession(sessionId: string): Promise<void> {
    await (this.b as any)?.clearSession?.(sessionId);
  }

  override async forgetSession(sessionId: string): Promise<void> {
    await (this.b as any)?.forgetSession?.(sessionId);
  }

  override async getKernelDiagnostics(): Promise<any> {
    return (this.b as any)?.getKernelDiagnostics?.() ?? {};
  }

  // ── Checkpoints (shadow git) ──
  override async createCheckpoint(sessionId: string, label?: string): Promise<any> {
    return this.b?.createCheckpoint?.(sessionId, label);
  }

  override async rollbackToCheckpoint(checkpointId: string): Promise<any> {
    return (this.b as any)?.rollbackToCheckpoint?.(checkpointId);
  }

  override async rollbackSingleFile(filePath: string): Promise<any> {
    return (this.b as any)?.rollbackSingleFile?.(filePath);
  }

  override async reapplySingleFile(filePath: string): Promise<any> {
    return (this.b as any)?.reapplySingleFile?.(filePath);
  }

  override async getCheckpoints(limit?: number, sessionId?: string): Promise<any[]> {
    return (await (this.b as any)?.getCheckpoints?.(limit, sessionId)) ?? [];
  }

  override async getCheckpointStats(): Promise<any> {
    return (this.b as any)?.getCheckpointStats?.();
  }

  override async getCheckpointChanges(): Promise<any[]> {
    return (await (this.b as any)?.getCheckpointChanges?.()) ?? [];
  }

  override async setCheckpointEnabled(enabled: boolean): Promise<void> {
    await (this.b as any)?.setCheckpointEnabled?.(enabled);
  }

  override async isCheckpointEnabled(): Promise<boolean> {
    return (this.b as any)?.isCheckpointEnabled?.() ?? false;
  }

  override async cleanupCheckpoints(): Promise<void> {
    await (this.b as any)?.cleanupCheckpoints?.();
  }

  override async startCheckpointWatching(sessionId: string): Promise<string | null> {
    return (this.b as any)?.startCheckpointWatching?.(sessionId) ?? null;
  }

  override async stopCheckpointWatching(): Promise<void> {
    await (this.b as any)?.stopCheckpointWatching?.();
  }

  // ── 权限 ──
  override async cancelPermission(requestId: string, reason?: string): Promise<void> {
    await (this.b as any)?.cancelPermission?.(requestId, reason);
  }

  // ── 后台任务 / 子 Agent ──
  override async listBackgroundTasks(): Promise<Array<Record<string, any>>> {
    return (await (this.b as any)?.listBackgroundTasks?.()) ?? [];
  }

  override async startServiceByConfig(
    workspaceRoot: string,
    configId: string,
    sessionId?: string,
  ): Promise<{ ok: boolean; pid?: number; reused?: boolean; output?: string; error?: string }> {
    return (await (this.b as any)?.startServiceByConfig?.(workspaceRoot, configId, sessionId))
      ?? { ok: false, error: 'runtime bridge 未实现 startServiceByConfig' };
  }

  override async bindRunConfig(pid: number, configId: string): Promise<{ ok: boolean; error?: string }> {
    return (await (this.b as any)?.bindRunConfig?.(pid, configId))
      ?? { ok: false, error: 'runtime bridge 未实现 bindRunConfig' };
  }

  override async upsertServiceConfig(
    workspaceRoot: string,
    config: Record<string, unknown>,
  ): Promise<{ ok: boolean; config?: Record<string, unknown>; error?: string }> {
    return (await (this.b as any)?.upsertServiceConfig?.(workspaceRoot, config))
      ?? { ok: false, error: 'runtime bridge 未实现 upsertServiceConfig' };
  }

  override async removeServiceConfig(
    workspaceRoot: string,
    id: string,
  ): Promise<{ ok: boolean; removed: boolean; error?: string }> {
    return (await (this.b as any)?.removeServiceConfig?.(workspaceRoot, id))
      ?? { ok: false, removed: false, error: 'runtime bridge 未实现 removeServiceConfig' };
  }

  override async listServiceHistory(workspaceRoot: string): Promise<{ instances: Array<Record<string, any>> }> {
    /* bridge 侧返回的是裸数组 (server/index.ts:261), HTTP 那条返回 {instances}. 归一到后者。 */
    const r = await (this.b as any)?.listServiceHistory?.(workspaceRoot);
    return { instances: Array.isArray(r) ? r : (r?.instances ?? []) };
  }

  override async readServiceLog(pid: number, startTimeMs?: number): Promise<{ output: string }> {
    const output = await (this.b as any)?.readServiceLog?.(pid, startTimeMs);
    return { output: typeof output === 'string' ? output : (output?.output ?? '') };
  }

  override async getBackgroundTaskOutput(pid: number): Promise<string> {
    const out = await (this.b as any)?.getBackgroundTaskOutput?.(pid);
    return typeof out === 'string' ? out : '';
  }

  override async getRunMode(): Promise<string> {
    return (await (this.b as any)?.getRunMode?.()) ?? 'agentic';
  }

  override async openInteractiveShell(args?: { cwd?: string; command?: string }): Promise<{ pid: number | null; toolId?: string; error?: string }> {
    return (await (this.b as any)?.openInteractiveShell?.(args ?? {})) ?? { pid: null, error: 'runtime bridge 未实现 openInteractiveShell' };
  }

  override async sendShellStdin(pid: number, data: string): Promise<{ delivered: boolean }> {
    const r = await (this.b as any)?.sendShellStdin?.(pid, data);
    return { delivered: r === true || r?.delivered === true };
  }

  override async resizeShell(pid: number, cols: number, rows: number): Promise<void> {
    await (this.b as any)?.resizeShell?.(pid, cols | 0, rows | 0);
  }

  override async createSkill(options: any): Promise<any> {
    return (await (this.b as any)?.createSkill?.(options)) ?? null;
  }

  override async deleteSkill(id: string): Promise<any> {
    return (await (this.b as any)?.deleteSkill?.(id)) ?? { success: false };
  }

  override async listSubAgents(sessionId: string): Promise<any> {
    return (this.b as any)?.listSubAgents?.(sessionId) ?? { agents: [] };
  }

  override async abortSubAgent(agentId: string): Promise<{ ok: boolean }> {
    await (this.b as any)?.abortSubAgent?.(agentId);
    return { ok: true };
  }

  override async untrackProcess(pid: number): Promise<{ ok: boolean; removed: boolean }> {
    const r = (this.b as any)?.untrackProcess?.(pid);
    return r ?? { ok: true, removed: true };
  }

  private async callBrowserBridge(method: keyof RuntimeBridge, args: any): Promise<any> {
    const bridge = this.b as any;
    const fn = bridge?.[method];
    if (typeof fn !== 'function') {
      return { ok: false, error: `Runtime bridge method ${String(method)} not available` };
    }
    return fn.call(bridge, args);
  }

  // ── Browser Surface: 进程内直接走 bridge，不走 http://local.inprocess fallback ──
  override async browserNavigate(args: any): Promise<any> { return this.callBrowserBridge('browserNavigate', args); }
  override async browserScreenshot(args: any): Promise<any> { return this.callBrowserBridge('browserScreenshot', args); }
  override async browserGetState(args: any): Promise<any> { return this.callBrowserBridge('browserGetState', args); }
  override async browserGetAriaTree(args: any): Promise<any> { return this.callBrowserBridge('browserGetAriaTree', args); }
  override async browserQuery(args: any): Promise<any> { return this.callBrowserBridge('browserQuery', args); }
  override async browserGetText(args: any): Promise<any> { return this.callBrowserBridge('browserGetText', args); }
  override async browserClick(args: any): Promise<any> { return this.callBrowserBridge('browserClick', args); }
  override async browserType(args: any): Promise<any> { return this.callBrowserBridge('browserType', args); }
  override async browserPressKey(args: any): Promise<any> { return this.callBrowserBridge('browserPressKey', args); }
  override async browserScroll(args: any): Promise<any> { return this.callBrowserBridge('browserScroll', args); }
  override async browserHover(args: any): Promise<any> { return this.callBrowserBridge('browserHover', args); }
  override async browserSelectOption(args: any): Promise<any> { return this.callBrowserBridge('browserSelectOption', args); }
  override async browserFillForm(args: any): Promise<any> { return this.callBrowserBridge('browserFillForm', args); }
  override async browserWaitFor(args: any): Promise<any> { return this.callBrowserBridge('browserWaitFor', args); }
  override async browserWaitForNavigation(args: any): Promise<any> { return this.callBrowserBridge('browserWaitForNavigation', args); }
  override async browserGetConsoleLogs(args: any): Promise<any> { return this.callBrowserBridge('browserGetConsoleLogs', args); }
  override async browserGetNetwork(args: any): Promise<any> { return this.callBrowserBridge('browserGetNetwork', args); }
  override async browserGetResponseBody(args: any): Promise<any> { return this.callBrowserBridge('browserGetResponseBody', args); }
  override async browserBack(args: any): Promise<any> { return this.callBrowserBridge('browserBack', args); }
  override async browserForward(args: any): Promise<any> { return this.callBrowserBridge('browserForward', args); }
  override async browserReload(args: any): Promise<any> { return this.callBrowserBridge('browserReload', args); }
  override async browserExpect(args: any): Promise<any> { return this.callBrowserBridge('browserExpect', args); }
  override async browserEval(args: any): Promise<any> { return this.callBrowserBridge('browserEval', args); }
  override async browserGetCookies(args: any): Promise<any> { return this.callBrowserBridge('browserGetCookies', args); }
  override async browserSetCookies(args: any): Promise<any> { return this.callBrowserBridge('browserSetCookies', args); }
  override async browserClearCookies(args: any): Promise<any> { return this.callBrowserBridge('browserClearCookies', args); }
  override async browserGetLocalStorage(args: any): Promise<any> { return this.callBrowserBridge('browserGetLocalStorage', args); }
  override async browserSetLocalStorage(args: any): Promise<any> { return this.callBrowserBridge('browserSetLocalStorage', args); }
  override async browserMockResponse(args: any): Promise<any> { return this.callBrowserBridge('browserMockResponse', args); }
  override async browserClearMocks(args: any): Promise<any> { return this.callBrowserBridge('browserClearMocks', args); }
  override async browserListMocks(args: any): Promise<any> { return this.callBrowserBridge('browserListMocks', args); }
  override async browserSetInputFiles(args: any): Promise<any> { return this.callBrowserBridge('browserSetInputFiles', args); }
  override async browserSetViewport(args: any): Promise<any> { return this.callBrowserBridge('browserSetViewport', args); }

  // ── Leader Team / Steward ──
  override async createLeaderTeam(sessionId: string, goal: string): Promise<any> {
    return (this.b as any)?.createLeaderTeam?.(sessionId, goal);
  }

  override async leaderRecruitMember(sessionId: string, teamId: string, payload: any): Promise<any> {
    return (this.b as any)?.leaderRecruitMember?.(sessionId, teamId, payload);
  }

  override async leaderRequestCapability(sessionId: string, teamId: string, capability: string, reason: string): Promise<any> {
    return (this.b as any)?.leaderRequestCapability?.(sessionId, teamId, capability, reason);
  }

  override async getStewardRuntimeSnapshot(sessionId: string): Promise<any> {
    return (this.b as any)?.getStewardRuntimeSnapshot?.(sessionId) ?? null;
  }

  override async cancelCommitment(sessionId: string, commitmentId: string): Promise<{ success: boolean }> {
    return (this.b as any)?.cancelCommitment?.(sessionId, commitmentId) ?? { success: false };
  }

  // ── Subscribe (进程内不需要 SSE，返回空操作) ──
  override async subscribe(): Promise<{ close: () => void }> {
    return { close: () => {} };
  }

  //    那条路径无实现时 silent 返 undefined → "已连接但 0 工具" 假象. 直接调 bridge.) ──
  override async connectMcpServer(id: string): Promise<void> {
    const bridge = this.b;
    if (!bridge?.connectMcpServer) {
      throw new Error('MCP not available in this runtime (bridge.connectMcpServer missing)');
    }
    await bridge.connectMcpServer(id);
  }

  override async disconnectMcpServer(id: string): Promise<void> {
    const bridge = this.b;
    if (!bridge?.disconnectMcpServer) {
      throw new Error('MCP not available in this runtime (bridge.disconnectMcpServer missing)');
    }
    await bridge.disconnectMcpServer(id);
  }

  /** 改 server 配置 (启用/停用/allow·denylist): 必须进 bridge, 那边改完会重算工具表。
   *  没有这个 override 就掉进基类的 HTTP 分支, 进程内 runtime 根本收不到。 */
  override async updateMcpServer(scope: string, id: string, updates: any): Promise<boolean> {
    const bridge = this.b;
    if (!bridge?.updateMcpServer) {
      throw new Error('MCP not available in this runtime (bridge.updateMcpServer missing)');
    }
    return bridge.updateMcpServer(scope, id, updates);
  }

  override async testMcpServer(id: string): Promise<any> {
    const bridge = this.b;
    if (!bridge?.testMcpServer) {
      throw new Error('MCP not available in this runtime (bridge.testMcpServer missing)');
    }
    return bridge.testMcpServer(id);
  }

  override async getMcpServerTools(id: string): Promise<any[]> {
    const bridge = this.b;
    if (!bridge?.getMcpServerTools) {
      throw new Error('MCP not available in this runtime (bridge.getMcpServerTools missing)');
    }
    return (await bridge.getMcpServerTools(id)) ?? [];
  }

  // ── HTTP 底层拦截: 所有未显式 override 的方法最终走 get/post/del,
  //    在进程内模式下通过 bridge.handleLocalRequest 分发 (如果 bridge 支持),
  //    否则返回安全默认值，避免 fetch ENOTFOUND 错误。──
  protected override async get<T>(path: string): Promise<T> {
    const handler = (this.b as any)?.handleLocalRequest;
    if (typeof handler === 'function') {
      return handler('GET', path) as T;
    }
    throw new Error(`LocalNeoxClient.get(${path}): no handler in this runtime — method must be overridden`);
  }

  protected override async post<T = any>(path: string, body?: any): Promise<T> {
    const handler = (this.b as any)?.handleLocalRequest;
    if (typeof handler === 'function') {
      return handler('POST', path, body) as T;
    }
    throw new Error(`LocalNeoxClient.post(${path}): no handler in this runtime — method must be overridden`);
  }

  protected override async del<T = any>(path: string): Promise<T> {
    const handler = (this.b as any)?.handleLocalRequest;
    if (typeof handler === 'function') {
      return handler('DELETE', path) as T;
    }
    throw new Error(`LocalNeoxClient.del(${path}): no handler in this runtime — method must be overridden`);
  }
}
