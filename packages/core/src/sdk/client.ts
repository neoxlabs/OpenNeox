/**
 * NeoxClient SDK
 * CLI / Electron / Web UI 用这个 SDK 跟 server 通信
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { AgentRuntimeEvent } from '../runtime/runtimeTypes.js';
import type { RuntimeEventTracker } from '../runtime/runtimeEventHub.js';
import type { ServerEvent } from '../server/eventBus.js';
import type { ChatRequest, PermissionReply, RunStateSnapshot } from '../server/index.js';
import { getDefaultServerBaseUrl } from '@neoxlabs/platform/utils/config.js';

// ============================================================================
// Types
// ============================================================================

export type ServerEventHandler = (event: ServerEvent) => void;

export interface NeoxClientOptions {
  baseUrl?: string;
  /** Bearer token（远程模式认证） */
  token?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// ============================================================================
// SSE 解析器（Node.js 环境没有原生 EventSource）
// ============================================================================

interface SSESubscription {
  close: () => void;
}

const SSE_HEARTBEAT_TIMEOUT_MS = 60_000;
const SSE_RECONNECT_BASE_MS = 1_000;
const SSE_RECONNECT_MAX_MS = 30_000;

function shouldLogSseReconnect(attempt: number): boolean {
  return attempt <= 3 || attempt === 5 || attempt === 10 || attempt % 30 === 0;
}

async function subscribeSSE(
  url: string,
  handler: ServerEventHandler,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
  onReconnect?: (attempt: number) => void,
  onActivity?: () => void,
): Promise<SSESubscription> {
  const ac = new AbortController();
  let reconnectCount = 0;
  let initialConnectSettled = false;
  let resolveInitialConnect!: () => void;
  let rejectInitialConnect!: (error: Error) => void;
  const initialConnect = new Promise<void>((resolve, reject) => {
    resolveInitialConnect = resolve;
    rejectInitialConnect = reject;
  });

  let lastSeqNum = 0;

  // 合并外部 signal
  if (signal) {
    signal.addEventListener('abort', () => ac.abort());
  }

  const connect = async () => {
    while (!ac.signal.aborted) {
      let heartbeatTriggered = false;

      try {
        let connectUrl = url;
        if (reconnectCount > 0) {
          const sep = url.includes('?') ? '&' : '?';
          connectUrl = lastSeqNum > 0
            ? `${url}${sep}reconnect=true&last_seq=${lastSeqNum}`
            : `${url}${sep}reconnect=true`;
        }

        if (reconnectCount > 0) {
          onReconnect?.(reconnectCount);
          if (shouldLogSseReconnect(reconnectCount)) {
            console.warn(`[SSE] Reconnecting (attempt ${reconnectCount})...`);
          }
        }

        const res = await fetch(connectUrl, {
          headers: { Accept: 'text/event-stream', ...extraHeaders },
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`);
        }

        if (!initialConnectSettled) {
          initialConnectSettled = true;
          resolveInitialConnect();
        }

        reconnectCount = 0;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
        const resetHeartbeat = () => {
          if (heartbeatTimer) clearTimeout(heartbeatTimer);
          heartbeatTimer = setTimeout(() => {
            heartbeatTriggered = true;
            reconnectCount++;
            if (shouldLogSseReconnect(reconnectCount)) {
              console.warn(`[SSE] Heartbeat timeout — no data received for 60s, reconnecting... (attempt ${reconnectCount})`);
            }
            onReconnect?.(reconnectCount);
            try { reader.cancel(); } catch (err: any) { cliLogger.debug('SDK', `SSE reader cancel failed: ${err?.message}`); }
          }, SSE_HEARTBEAT_TIMEOUT_MS);
        };
        resetHeartbeat();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            resetHeartbeat();
            onActivity?.();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            let currentEvent = '';
            let currentData = '';
            let currentId = '';

            for (const line of lines) {
              if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                currentData += line.slice(5).trim();
              } else if (line.startsWith('id:')) {
                currentId = line.slice(3).trim();
              } else if (line === '') {
                // 空行 = 事件结束
                if (currentEvent && currentData && currentEvent !== 'heartbeat' && currentEvent !== 'connected') {
                  try {
                    const parsed = JSON.parse(currentData) as ServerEvent;
                    handler(parsed);
                    if (currentId) {
                      const seq = parseInt(currentId, 10);
                      if (!isNaN(seq) && seq > lastSeqNum) {
                        lastSeqNum = seq;
                      }
                    } else if (parsed.seq && parsed.seq > lastSeqNum) {
                      lastSeqNum = parsed.seq;
                    }
                  } catch (err: any) {
                    cliLogger.debug('SDK', `SSE event parse failed: ${err?.message}`);
                  }
                }
                currentEvent = '';
                currentData = '';
                currentId = '';
              }
            }
          }
        } finally {
          if (heartbeatTimer) clearTimeout(heartbeatTimer);
        }
      } catch (err: any) {
        if (ac.signal.aborted) {
          if (!initialConnectSettled) {
            initialConnectSettled = true;
            rejectInitialConnect(new Error('SSE connection aborted'));
          }
          return;
        }
        if (!initialConnectSettled) {
          initialConnectSettled = true;
          rejectInitialConnect(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (!heartbeatTriggered) {
          reconnectCount++;
        }
        const delay = Math.min(SSE_RECONNECT_BASE_MS * Math.pow(2, reconnectCount - 1), SSE_RECONNECT_MAX_MS);
        if (shouldLogSseReconnect(reconnectCount)) {
          console.warn(`[SSE] Disconnected, retrying in ${delay}ms (attempt ${reconnectCount})...`);
        }
        await new Promise(r => setTimeout(r, delay));
      }
    }
  };

  // 后台运行
  void connect();

  await initialConnect;

  return { close: () => ac.abort() };
}


// ============================================================================
// Client
// ============================================================================

export class NeoxClient {
  private baseUrl: string;
  private token?: string;
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly NETWORK_RETRY_COUNT = 2;

  constructor(baseUrlOrOpts?: string | NeoxClientOptions) {
    if (typeof baseUrlOrOpts === 'string') {
      this.baseUrl = baseUrlOrOpts;
    } else {
      this.baseUrl = baseUrlOrOpts?.baseUrl ?? getDefaultServerBaseUrl();
      this.token = baseUrlOrOpts?.token;
    }
  }

  /** 获取认证头 */
  private get authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  // =========================================================================
  // SSE 事件订阅
  // =========================================================================

  /**
   * 订阅事件流
   * @returns close 函数
   */
  async subscribe(
    handler: ServerEventHandler,
    sessionId?: string,
    signal?: AbortSignal,
    onReconnect?: (attempt: number) => void,
    onActivity?: () => void,
  ): Promise<SSESubscription> {
    const url = sessionId
      ? `${this.baseUrl}/events?sessionId=${encodeURIComponent(sessionId)}`
      : `${this.baseUrl}/events`;

    return subscribeSSE(url, handler, signal, this.authHeaders, onReconnect, onActivity);
  }

  // =========================================================================
  // Chat
  // =========================================================================

  async chat(sessionId: string, prompt: string, opts?: Partial<ChatRequest>): Promise<void> {
    await this.post(`/session/${sessionId}/chat`, {
      prompt,
      ...opts,
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.post(`/session/${sessionId}/abort`);
  }

  async getRunState(sessionId: string): Promise<RunStateSnapshot> {
    return this.get(`/session/${sessionId}/run-state`);
  }

  /** 运行态整表对账 — 不传 sessionIds 只回非 idle 的会话。 */
  async getRunStates(sessionIds?: string[]): Promise<RunStateSnapshot[]> {
    const qs = sessionIds?.length ? `?sessionIds=${encodeURIComponent(sessionIds.join(','))}` : '';
    const res = await this.get<{ runStates: RunStateSnapshot[] }>(`/run-states${qs}`);
    return res?.runStates ?? [];
  }

  async pauseAll(sessionId: string): Promise<{ mainPaused: boolean; workersPaused: number }> {
    return this.post(`/session/${sessionId}/pause`);
  }

  async resumeAll(sessionId: string): Promise<{ mainResumed: boolean; workersResumed: number }> {
    return this.post(`/session/${sessionId}/resume`);
  }

  async pauseProcess(pid: string): Promise<{ paused: boolean }> {
    return this.post(`/process/${pid}/pause`);
  }

  async resumeProcess(pid: string): Promise<{ resumed: boolean }> {
    return this.post(`/process/${pid}/resume`);
  }

  // =========================================================================
  // Permission
  // =========================================================================

  async replyPermission(requestId: string, approved: boolean, message?: string, remember?: boolean): Promise<void> {
    await this.post(`/permission/${requestId}/reply`, { approved, message, remember });
  }

  async cancelPermission(
    requestId: string,
    reason?: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale',
  ): Promise<void> {
    await this.post(`/permission/${requestId}/cancel`, { reason });
  }

  /** 返回值: { status, reason? } — UI 据此决定 timeline 卡片显示 ✓ 已回答 还是 orphan 错误. */
  async replyAskUser(
    requestId: string,
    answers: Record<string, string>,
  ): Promise<{ status: 'resolved' | 'resumed' | 'orphan'; reason?: string }> {
    return this.post<{ status: 'resolved' | 'resumed' | 'orphan'; reason?: string }>(
      `/ask-user/${requestId}/reply`,
      { answers },
    );
  }

  async killBackgroundTask(pid: number, force?: boolean): Promise<void> {
    await this.post(`/background-task/${pid}/kill`, { force: !!force });
  }

  /** per-session sub-agent 列表 — UI bar 拉初始快照, 后续靠 sub_agent SSE 增量更新 */
  async listSubAgents(sessionId: string): Promise<{ agents: Array<{
    agentId: string;
    name?: string;
    sessionId?: string;
    description: string;
    status: string;
    elapsed: number;
    toolUseCount: number;
  }> }> {
    return this.get(`/session/${sessionId}/sub-agents`);
  }

  async abortSubAgent(agentId: string): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>(`/sub-agent/${agentId}/abort`, {});
  }

  /** 从 processManager 移除 pid 跟踪 — 不杀进程, 只擦掉记录, UI "从列表清除". */
  async untrackProcess(pid: number): Promise<{ ok: boolean; removed: boolean }> {
    return this.post<{ ok: boolean; removed: boolean }>(`/background-task/${pid}/untrack`, {});
  }

  /** UI Start 按钮: 从 RunConfig 把服务拉起到 server 进程里. 必须走这条;
   *  electron-main 直调 serviceLauncher 会让进程落在它自己的空 processManager 上,
   *  UI 的 process:list 永远看不到 (该 list 从 server 取). */
  async startServiceByConfig(
    workspaceRoot: string,
    configId: string,
    /** UI 必传 — server 端 shell_output_stream 路由用. agent 内部 (autoRestart 等) 可省. */
    sessionId?: string,
  ): Promise<{ ok: boolean; pid?: number; reused?: boolean; output?: string; error?: string }> {
    return this.post<{ ok: boolean; pid?: number; reused?: boolean; output?: string; error?: string }>(
      `/service/start-config`,
      { workspaceRoot, configId, sessionId },
    );
  }

  /** Adopt: 把 ad-hoc pid 绑到 RunConfig 名下. 必须走 server 这边的 processManager. */
  async bindRunConfig(pid: number, configId: string): Promise<{ ok: boolean; error?: string }> {
    return this.post<{ ok: boolean; error?: string }>(
      `/service/bind-run-config`,
      { pid, configId },
    );
  }

  /** 服务历史 (含已退出的) —— 面板"历史"tab 用。 */
  async listServiceHistory(workspaceRoot: string): Promise<{ instances: Array<Record<string, any>> }> {
    return this.get<{ instances: Array<Record<string, any>> }>(
      `/service/history?workspaceRoot=${encodeURIComponent(workspaceRoot)}`,
    );
  }

  /** 读历史日志 (盘上文件) —— 进程早退出、内存 buffer 没了也能看。 */
  async readServiceLog(pid: number, startTimeMs?: number): Promise<{ output: string }> {
    const q = startTimeMs !== undefined ? `?startTime=${startTimeMs}` : '';
    return this.get<{ output: string }>(`/service/log/${pid}${q}`);
  }

  /** 新建/编辑 RunConfig. 让 server 当 truth source: 立即更新 server 端 ServiceConfigStore cache,
   *  后续 LLM 触发 start / autoRestart 时不会读到过时的配置. */
  async upsertServiceConfig(
    workspaceRoot: string,
    config: Record<string, unknown>,
  ): Promise<{ ok: boolean; config?: Record<string, unknown>; error?: string }> {
    return this.post<{ ok: boolean; config?: Record<string, unknown>; error?: string }>(
      `/service/upsert-config`,
      { workspaceRoot, config },
    );
  }

  /** 删除 RunConfig. */
  async removeServiceConfig(
    workspaceRoot: string,
    id: string,
  ): Promise<{ ok: boolean; removed: boolean; error?: string }> {
    return this.post<{ ok: boolean; removed: boolean; error?: string }>(
      `/service/remove-config`,
      { workspaceRoot, id },
    );
  }

  /* ── Browser Surface (B Day 2+) ── */
  async browserNavigate(args: { surfaceId: string; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }) {
    return this.post<{ ok: boolean; url?: string; title?: string; error?: string }>(
      `/browser/navigate`, args,
    );
  }
  async browserScreenshot(args: { surfaceId: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number }; format?: 'png' | 'jpeg'; quality?: number }) {
    return this.post<{ ok: boolean; base64?: string; width?: number; height?: number; error?: string }>(
      `/browser/screenshot`, args,
    );
  }
  async browserGetState(args: { surfaceId: string }) {
    return this.post<{ ok: boolean; url?: string; title?: string; error?: string }>(
      `/browser/get-state`, args,
    );
  }
  /* B Day 3: DOM 感知 + 交互. 返回类型用 any 不强约束 — 不同 tool 字段差别大,
   * agent / UI 自己按 tool 名理解; type-safe wrapper 后续按需补. */
  async browserGetAriaTree(args: any) { return this.post<any>(`/browser/get-aria-tree`, args); }
  async browserQuery(args: any)        { return this.post<any>(`/browser/query`, args); }
  async browserGetText(args: any)      { return this.post<any>(`/browser/get-text`, args); }
  async browserClick(args: any)        { return this.post<any>(`/browser/click`, args); }
  async browserType(args: any)         { return this.post<any>(`/browser/type`, args); }
  async browserPressKey(args: any)     { return this.post<any>(`/browser/press-key`, args); }
  async browserScroll(args: any)       { return this.post<any>(`/browser/scroll`, args); }
  async browserHover(args: any)        { return this.post<any>(`/browser/hover`, args); }
  async browserSelectOption(args: any) { return this.post<any>(`/browser/select-option`, args); }
  async browserFillForm(args: any)     { return this.post<any>(`/browser/fill-form`, args); }
  /* B Day 4 */
  async browserWaitFor(args: any)           { return this.post<any>(`/browser/wait-for`, args); }
  async browserWaitForNavigation(args: any) { return this.post<any>(`/browser/wait-for-navigation`, args); }
  async browserGetConsoleLogs(args: any)    { return this.post<any>(`/browser/get-console-logs`, args); }
  async browserGetNetwork(args: any)        { return this.post<any>(`/browser/get-network`, args); }
  async browserGetResponseBody(args: any)   { return this.post<any>(`/browser/get-response-body`, args); }
  /* B Day 5 */
  async browserBack(args: any)    { return this.post<any>(`/browser/back`, args); }
  async browserForward(args: any) { return this.post<any>(`/browser/forward`, args); }
  async browserReload(args: any)  { return this.post<any>(`/browser/reload`, args); }
  async browserExpect(args: any)  { return this.post<any>(`/browser/expect`, args); }
  async browserEval(args: any)    { return this.post<any>(`/browser/eval`, args); }
  /* C Day 1 */
  async browserGetCookies(args: any)        { return this.post<any>(`/browser/get-cookies`, args); }
  async browserSetCookies(args: any)        { return this.post<any>(`/browser/set-cookies`, args); }
  async browserClearCookies(args: any)      { return this.post<any>(`/browser/clear-cookies`, args); }
  async browserGetLocalStorage(args: any)   { return this.post<any>(`/browser/get-local-storage`, args); }
  async browserSetLocalStorage(args: any)   { return this.post<any>(`/browser/set-local-storage`, args); }
  /* C Day 2 */
  async browserMockResponse(args: any)      { return this.post<any>(`/browser/mock-response`, args); }
  async browserClearMocks(args: any)        { return this.post<any>(`/browser/clear-mocks`, args); }
  async browserListMocks(args: any)         { return this.post<any>(`/browser/list-mocks`, args); }
  async browserSetInputFiles(args: any)     { return this.post<any>(`/browser/set-input-files`, args); }
  async browserSetViewport(args: any)       { return this.post<any>(`/browser/set-viewport`, args); }

  /** UI 拉所有 bg shell (running + 5min 内退出). Services panel 走这条. */
  async listBackgroundTasks(): Promise<Array<Record<string, any>>> {
    const r = await this.get<{ tasks?: Array<Record<string, any>> }>(`/background-tasks`);
    return r?.tasks ?? [];
  }

  /** Logs 面板 / 后台任务终端拉某个 pid 的累积输出. 跨进程必走这里 (electron-main 端的
   *  processManager 是空 singleton, 真实进程在 server 子进程 manager 里). */
  async getBackgroundTaskOutput(pid: number): Promise<string> {
    const r = await this.get<{ output?: string }>(`/background-task/${pid}/output`);
    return r?.output ?? '';
  }

  /** Services panel 的 Shell 控制台开一个独立可交互 PTY shell (bash -i / $SHELL -i).
   *  跟 service 解耦, 返回新 PTY 的 pid. UI 用 xterm 双向接 stdin/stdout. */
  async openInteractiveShell(args?: { cwd?: string; command?: string }): Promise<{ pid: number | null; toolId?: string; error?: string }> {
    return this.post<{ pid: number | null; toolId?: string; error?: string }>(`/shell/open-interactive`, args ?? {});
  }

  async pauseBackgroundTask(pid: number): Promise<void> {
    await this.post(`/background-task/${pid}/pause`, {});
  }

  async resumeBackgroundTask(pid: number): Promise<void> {
    await this.post(`/background-task/${pid}/resume`, {});
  }

  /** 转正 / 取消转正 —— 后台任务默认只在起它的会话里可见 */
  async setBackgroundTaskPersistent(pid: number, persistent: boolean): Promise<void> {
    await this.post(`/background-task/${pid}/persistent`, { persistent });
  }

  async sendShellStdin(pid: number, data: string): Promise<{ delivered: boolean }> {
    const r = await this.post<{ delivered?: boolean }>(`/shell/${pid}/stdin`, { data });
    return { delivered: r?.delivered === true };
  }

  async resizeShell(pid: number, cols: number, rows: number): Promise<void> {
    await this.post(`/shell/${pid}/resize`, { cols, rows });
  }

  // =========================================================================
  // Run Mode
  // =========================================================================

  async getRunMode(): Promise<string> {
    const res = await this.get<{ mode: string }>('/mode');
    return res.mode;
  }

  async setRunMode(mode: string): Promise<void> {
    await this.post('/mode', { mode });
  }

  // =========================================================================
  // Inject (Network mode)
  // =========================================================================

  /** @returns 队列位置; 0 = 没排上 (服务端没有在跑的 host)。调用方必须看返回值。 */
  async injectMessage(sessionId: string, message: string, images?: Array<{ mediaType: string; data: string; name?: string }>): Promise<number> {
    const res = await this.post(`/session/${sessionId}/inject`, images?.length ? { message, images } : { message }) as
      { queued?: boolean; position?: number } | undefined;
    return typeof res?.position === 'number' ? res.position : 0;
  }

  /** 撤回最后一条排队消息, 返回其文本 (空队列 null) — 用于 ↑ 拉回输入框编辑 */
  async removeLastPendingMessage(sessionId: string): Promise<string | null> {
    const res = await this.post(`/session/${sessionId}/dequeue-last`, {}) as { text?: string | null } | undefined;
    return res?.text ?? null;
  }

  async createLeaderTeam(sessionId: string, goal: string): Promise<any> {
    return this.post(`/session/${sessionId}/assistant/team`, { goal });
  }

  async leaderRecruitMember(sessionId: string, teamId: string, payload: { role: string; task: string; providerId?: string; model?: string }): Promise<any> {
    return this.post(`/session/${sessionId}/assistant/team/${teamId}/recruit`, payload);
  }

  async leaderRequestCapability(sessionId: string, teamId: string, capability: string, reason: string): Promise<any> {
    return this.post(`/session/${sessionId}/assistant/team/${teamId}/capability`, { capability, reason });
  }

  async getStewardRuntimeSnapshot(sessionId: string): Promise<any> {
    return this.get(`/session/${sessionId}/assistant/steward-snapshot`);
  }

  async cancelCommitment(sessionId: string, commitmentId: string): Promise<{ success: boolean }> {
    return this.post(`/session/${sessionId}/assistant/cancel-commitment`, { commitmentId });
  }

  async getKernelDiagnostics(): Promise<any> {
    return this.get('/kernel/diagnostics');
  }

  // =========================================================================
  // Status
  // =========================================================================

  async getStatus(): Promise<{
    status: string;
    uptime: number;
    pid: number;
    workDir: string;
    activeSessions: string[];
    mode: string;
  }> {
    return this.get('/status');
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch (err: any) {
      cliLogger.debug('SDK', `Health check failed: ${err?.message}`);
      return false;
    }
  }

  // =========================================================================
  // Session / Host 管理
  // =========================================================================

  async setSandboxMode(sessionId: string, enabled: boolean): Promise<void> {
    await this.post(`/session/${sessionId}/sandbox`, { enabled });
  }

  async setApprovalMode(
    sessionId: string,
    mode: 'auto' | 'manual' | 'dangerous',
    options?: {
      scope?: 'global' | 'agent';
      scopeKey?: string;
      inherit?: boolean;
      dangerousConfirmation?: {
        acknowledgeNoApproval: true;
        acknowledgeHighRiskExecution: true;
      };
    }
  ): Promise<void> {
    await this.post(`/session/${sessionId}/approval`, {
      mode,
      scope: options?.scope,
      scopeKey: options?.scopeKey,
      inherit: options?.inherit,
      dangerousConfirmation: options?.dangerousConfirmation,
    });
  }

  /** per-session 审批模式查询 — 服务端 ApprovalModeResolver.resolveByScope 真值,
   *  跟 DB 持久化 + scopedModes Map 一致, UI 替代旧的客户端 Map 缓存. */
  async getApprovalMode(sessionId: string): Promise<{ mode: 'auto' | 'manual' | 'dangerous' }> {
    return this.get(`/session/${sessionId}/approval`);
  }

  async compactSession(sessionId: string, model?: string): Promise<void> {
    await this.post(`/session/${sessionId}/compact`, model ? { model } : undefined);
  }

  /** Jev 草稿预判。HTTP 模式没有这条路由 (远端服务不收草稿), 只有本地 runtime 实现。 */
  async jevPrefetch(_text: string): Promise<void> {}

  async setAgentMode(sessionId: string, mode: string): Promise<string> {
    const res = await this.post<{ agentMode?: string }>(`/session/${sessionId}/agent-mode`, { mode });
    return res?.agentMode ?? 'code';
  }

  async getAgentMode(sessionId: string): Promise<string> {
    const res = await this.get<{ agentMode?: string }>(`/session/${sessionId}/agent-mode`);
    return res?.agentMode ?? 'code';
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.post(`/session/${sessionId}/clear`);
  }

  /** 只忘不存档 (对话回退) */
  async forgetSession(sessionId: string): Promise<void> {
    await this.post(`/session/${sessionId}/forget`);
  }

  async getContextHealth(sessionId: string): Promise<any> {
    return this.get(`/session/${sessionId}/context-health`);
  }

  async getSessionInfo(sessionId: string): Promise<any> {
    return this.get(`/session/${sessionId}/info`);
  }

  async setCompressionMode(sessionId: string, mode: 'sync' | 'async'): Promise<void> {
    await this.post(`/session/${sessionId}/compression`, { mode });
  }

  /** 设置页「上下文」的触发阈值 (0..1) 与自动压缩开关。undefined = 该项不动。 */
  async setContextCompression(
    sessionId: string,
    next: { mode?: 'sync' | 'async'; threshold?: number; autoEnabled?: boolean },
  ): Promise<void> {
    await this.post(`/session/${sessionId}/context-compression`, next);
  }

  // =========================================================================
  // Memory
  // =========================================================================

  async getMemoryStats(sessionId: string): Promise<{ length: number; contextHealth: any }> {
    return this.get(`/session/${sessionId}/memory`);
  }

  async clearMemory(sessionId: string): Promise<void> {
    await this.post(`/session/${sessionId}/memory/clear`);
  }

  async addMemoryMessage(sessionId: string, role: string, content: string): Promise<void> {
    await this.post(`/session/${sessionId}/memory/add`, { role, content });
  }

  async setMemoryMessages(sessionId: string, messages: any[]): Promise<void> {
    await this.post(`/session/${sessionId}/memory/set`, { messages });
  }

  // =========================================================================
  // Tools
  // =========================================================================

  async getToolList(): Promise<{ count: number; names: string[] }> {
    return this.get('/tools');
  }

  async reloadTools(workDir: string): Promise<void> {
    await this.post('/tools/reload', { workDir });
  }

  // =========================================================================
  // Workspace
  // =========================================================================

  async setWorkspace(workDir: string): Promise<void> {
    await this.post('/workspace', { workDir });
  }

  // =========================================================================
  // Checkpoint
  // =========================================================================

  async startCheckpointWatching(sessionId: string): Promise<string | null> {
    const res = await this.post<{ checkpointId: string | null }>('/checkpoint/start-watching', { sessionId });
    return res?.checkpointId ?? null;
  }

  async stopCheckpointWatching(): Promise<void> {
    await this.post('/checkpoint/stop-watching');
  }

  async createCheckpoint(sessionId: string, label?: string): Promise<any> {
    return this.post('/checkpoint/create', { sessionId, label });
  }

  async rollbackToCheckpoint(checkpointId: string): Promise<any> {
    return this.post('/checkpoint/rollback', { checkpointId });
  }

  async rollbackSingleFile(filePath: string): Promise<any> {
    return this.post('/checkpoint/rollback-file', { filePath });
  }

  async reapplySingleFile(filePath: string): Promise<any> {
    return this.post('/checkpoint/reapply-file', { filePath });
  }

  async getCheckpoints(limit?: number, sessionId?: string): Promise<any[]> {
    const params = new URLSearchParams();
    if (limit != null) params.set('limit', String(limit));
    if (sessionId) params.set('sessionId', sessionId);
    const qs = params.toString();
    return this.get(`/checkpoints${qs ? `?${qs}` : ''}`);
  }

  async getCheckpointStats(): Promise<any> {
    return this.get('/checkpoint/stats');
  }

  async getCheckpointChanges(): Promise<any[]> {
    return this.get('/checkpoint/changes');
  }

  async setCheckpointEnabled(enabled: boolean): Promise<void> {
    await this.post('/checkpoint/enabled', { enabled });
  }

  async isCheckpointEnabled(): Promise<boolean> {
    const res = await this.get<{ enabled: boolean }>('/checkpoint/enabled');
    return res.enabled;
  }

  async cleanupCheckpoints(): Promise<void> {
    await this.post('/checkpoint/cleanup');
  }

  // =========================================================================
  // TTS
  // =========================================================================

  async setTTSEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.post('/tts', { enabled });
  }

  /** 全量同步 TTS 配置到运行中 daemon —— provider/voice/speed 等改动即时生效 (切 provider 会 re-init). */
  async updateTTSConfig(config: any): Promise<{ enabled: boolean }> {
    return this.post('/tts/config', { config });
  }

  async getTTSStatus(): Promise<{ enabled: boolean; config: any }> {
    return this.get('/tts');
  }

  /** 一次性合成任意文本 (消息脚注"重新朗读") — 返回 base64 音频 */
  async ttsSpeak(text: string): Promise<{ audio?: string; format?: string; voiceSummary?: string; error?: string }> {
    return this.post('/tts/speak', { text });
  }

  /** STT —— base64 音频转文字 (输入框语音按钮). */
  async transcribeAudio(audioBase64: string, format?: string): Promise<{ text: string }> {
    return this.post('/audio/transcribe', { audio: audioBase64, format });
  }

  // =========================================================================
  // HTTP helpers
  // =========================================================================

  private static isRetriableNetworkError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    const causeCode = typeof error === 'object' && error !== null
      ? ((error as { cause?: { code?: string } }).cause?.code || '')
      : '';
    const text = `${message} ${causeCode}`;
    return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|ETIMEDOUT|socket hang up|aborted/i.test(text);
  }

  private static enrichNetworkError(error: unknown, url: string, method: string): Error {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const causeCode = typeof error === 'object' && error !== null
      ? (error as { cause?: { code?: string } }).cause?.code
      : undefined;
    const detail = causeCode ? `${rawMessage} (cause=${causeCode})` : rawMessage;
    return new Error(`${method} ${url} failed: ${detail}`);
  }

  private async fetchWithRetry(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;

    for (let attempt = 1; attempt <= NeoxClient.NETWORK_RETRY_COUNT + 1; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), NeoxClient.REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(timer);
        return response;
      } catch (error) {
        clearTimeout(timer);
        const retriable = NeoxClient.isRetriableNetworkError(error);
        if (!retriable || attempt > NeoxClient.NETWORK_RETRY_COUNT) {
          throw NeoxClient.enrichNetworkError(error, url, init?.method || 'GET');
        }
        const backoff = 200 * attempt;
        await new Promise(r => setTimeout(r, backoff));
      }
    }

    throw new Error(`Unexpected request retry state for ${url}`);
  }

  protected async get<T>(path: string): Promise<T> {
    const res = await this.fetchWithRetry(path, {
      headers: { ...this.authHeaders },
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.json() as Promise<T>;
  }

  protected async post<T = any>(path: string, body?: any): Promise<T> {
    const res = await this.fetchWithRetry(path, {
      method: 'POST',
      headers: {
        ...this.authHeaders,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  protected async del<T = any>(path: string): Promise<T> {
    const res = await this.fetchWithRetry(path, {
      method: 'DELETE',
      headers: { ...this.authHeaders },
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // =========================================================================
  // Device Management
  // =========================================================================

  async registerDevice(device: { type: string; name: string; model?: string; os?: string; version?: string }, capabilities: string[]): Promise<{ deviceId: string }> {
    return this.post('/device/register', { device, capabilities });
  }

  async getDevice(deviceId: string): Promise<any> {
    return this.get(`/device/${deviceId}`);
  }

  async getDevices(): Promise<{ count: number; devices: any[] }> {
    return this.get('/devices');
  }

  async removeDevice(deviceId: string): Promise<void> {
    await this.del(`/device/${deviceId}`);
  }

  // =========================================================================
  // Host Introspection
  // =========================================================================

  async getHostStatus(): Promise<any> {
    return this.get('/host/status');
  }

  async getHostAgents(): Promise<any[]> {
    return this.get('/host/agents');
  }

  async getHostActivity(limit?: number): Promise<any[]> {
    const qs = limit != null ? `?limit=${limit}` : '';
    return this.get(`/host/activity${qs}`);
  }

  async getHostSession(): Promise<any> {
    return this.get('/host/session');
  }

  async getHostSystem(): Promise<any> {
    return this.get('/host/system');
  }

  async hostInterrupt(reason?: string): Promise<{ interrupted: boolean }> {
    return this.post('/host/interrupt', { reason });
  }

  async hostSendCommand(text: string, priority?: string): Promise<any> {
    return this.post('/host/command', { text, priority });
  }

  // =========================================================================
  // Admin (仅本地调用)
  // =========================================================================

  async setAuth(config: { enabled?: boolean; token?: string }): Promise<{ enabled: boolean }> {
    return this.post('/admin/auth', config);
  }

  async getAuth(): Promise<{ enabled: boolean; hasToken: boolean }> {
    return this.get('/admin/auth');
  }

  // =========================================================================
  // =========================================================================

  async listMcpServers(): Promise<any[]> {
    return this.get('/mcp/servers');
  }

  async isMcpEnabled(): Promise<boolean> {
    const res = await this.get<{ enabled: boolean }>('/mcp/enabled');
    return res.enabled;
  }

  async setMcpEnabled(enabled: boolean): Promise<void> {
    await this.post('/mcp/enabled', { enabled });
  }

  async addMcpServer(scope: string, server: any): Promise<void> {
    await this.post('/mcp/servers', { scope, server });
  }

  async removeMcpServer(scope: string, id: string): Promise<boolean> {
    const res = await this.del<{ status: string }>(`/mcp/servers/${encodeURIComponent(id)}?scope=${scope}`);
    return res?.status === 'ok';
  }

  async updateMcpServer(scope: string, id: string, updates: any): Promise<boolean> {
    /* 服务端路由是 app.patch('/mcp/servers/:id') —— 原来这里发 POST, 永远 404。 */
    const res = await this.fetchWithRetry(`/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, updates }),
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined)?.status === 'ok';
  }

  async connectMcpServer(id: string): Promise<void> {
    await this.post(`/mcp/servers/${encodeURIComponent(id)}/connect`);
  }

  async disconnectMcpServer(id: string): Promise<void> {
    await this.post(`/mcp/servers/${encodeURIComponent(id)}/disconnect`);
  }

  async testMcpServer(id: string): Promise<any> {
    return this.post(`/mcp/servers/${encodeURIComponent(id)}/test`);
  }

  async getMcpServerTools(id: string): Promise<any[]> {
    const res = await this.get<{ tools: any[] }>(`/mcp/servers/${encodeURIComponent(id)}/tools`);
    return res.tools;
  }

  // =========================================================================
  // =========================================================================

  async listSkills(options?: { scope?: string; category?: string }): Promise<any[]> {
    const params = new URLSearchParams();
    if (options?.scope) params.set('scope', options.scope);
    if (options?.category) params.set('category', options.category);
    const qs = params.toString();
    return this.get(`/skills${qs ? `?${qs}` : ''}`);
  }

  async getSkill(id: string): Promise<any> {
    return this.get(`/skills/${encodeURIComponent(id)}`);
  }

  async refreshSkills(): Promise<void> {
    await this.post('/skills/refresh');
  }

  async createSkill(options: any): Promise<any> {
    return this.post('/skills', options);
  }

  async deleteSkill(id: string): Promise<any> {
    return this.del(`/skills/${encodeURIComponent(id)}`);
  }

  async importSkillFromUrl(url: string, target: string): Promise<any> {
    return this.post('/skills/import-url', { url, target });
  }

  async importSkillFromPath(sourcePath: string, target: string): Promise<any> {
    return this.post('/skills/import-path', { sourcePath, target });
  }

  async getSkillDirs(): Promise<{ user: string; workspace: string }> {
    return this.get('/skills/dirs');
  }

  // =========================================================================
  // =========================================================================

  async getIndexStats(): Promise<any> {
    return this.get('/index/stats');
  }

  async buildIndex(force?: boolean): Promise<any> {
    return this.post('/index/build', { force });
  }

  async clearIndex(): Promise<void> {
    await this.post('/index/clear');
  }

  async searchIndex(query: string, kind?: string, limit?: number): Promise<any[]> {
    return this.post('/index/search', { query, kind, limit });
  }
}
