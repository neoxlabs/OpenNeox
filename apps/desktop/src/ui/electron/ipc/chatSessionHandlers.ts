import { ipcMain } from './ipcMainBridged.js';
import { lazyElectron } from '../lazyElectron.js';

/* BrowserWindow / dialog 运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node
 * 后端里加载失败, 连累同包所有 handler (见 lazyElectron.ts, 方法必须 bind 回宿主)。
 * 这里只有"导出会话到文件"那一处用得到系统另存对话框; 极简版调到它会拿到
 * 一句明确的错, 而不是静默失败。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
const dialog = lazyElectron<typeof import('electron').dialog>('dialog');
import { writeFile } from 'fs/promises';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { storageService } from '../../../platform-electron/storageService.js';
import type { ChatMessage, ChatRequestPayload, Session } from '../../shared/ipc.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeBridgeResolver, makeWorkspaceResolver } from './scopeResolvers.js';
import { remoteSessions } from '../remoteSessions.js';
import { bridgeLog } from '../mobile-bridge/log.js';
import { isCloudPilotSession } from '../services/pilotCloudSlot.js';
import { sameWorkspace } from '../../shared/workspacePath.node.js';
import { hitFromMessage, dedupeHits, messageContentToText, MAX_HITS, type MatchHit } from '../../shared/sessionSearch';

interface SessionStoreLike {
  ensureMessagePair(sessionId: string, pair: ChatMessage[]): Promise<void>;
  saveSessionMetadata(session: Session): Promise<void>;
  listSessions(workspacePath?: string): Promise<Session[]>;
  listSessionsSlim(workspacePath?: string): Promise<Session[]>;
  /* #109: 侧栏刷新专用, 比 slim 再少三个 usage 字段 */
  listSessionsLite(workspacePath?: string): Promise<Session[]>;
  loadSession(sessionId: string, opts?: { full?: boolean }): Promise<Session | null>;
  createSession(input: { sessionId: string; workspacePath: string; modelId: string; kind?: 'chat' | 'image'; name?: string; agentMode?: 'work' | 'code' }): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  updateSessionMetadata(sessionId: string, patch: { name: string }): Promise<void>;
}

interface RegisterChatSessionIpcHandlersOptions {
  projectManager: ProjectManager;
  getSessionOrThrow: (sessionId: string) => Promise<Session>;
  sessionStore: SessionStoreLike;
  sessionsCache: Map<string, Session>;
}

const formatAttachmentSummary = (attachments?: { type: 'image' | 'url' | 'file'; data: string; name?: string; path?: string }[]): string => {
  if (!attachments || attachments.length === 0) {
    return '';
  }
  const lines = attachments.map((att, index) => {
    if (att.type === 'image') {
      return `Attachment ${index + 1}: [Image${att.name ? `: ${att.name}` : ''}]`;
    }
    if (att.type === 'file') {
      const label = att.name || att.path || att.data;
      return `Attachment ${index + 1}: [File: ${label}]`;
    }
    return `Attachment ${index + 1}: [URL: ${att.data}]`;
  });
  return `Attachments:\n${lines.join('\n')}`;
};

const formatMessageWithAttachments = (text: string, attachments?: { type: 'image' | 'url' | 'file'; data: string; name?: string; path?: string }[]): string => {
  const summary = formatAttachmentSummary(attachments);
  if (!summary) {
    return text;
  }
  return `${summary}\n\n${text}`.trim();
};

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * 上传 desktop 端的 attachment 到 cloud pod workspace.
 *   - file 类型: 读本机 fs → fs_write 上传到 pod 的 .neox/uploads/<id>-<name>, attachment.path 改写
 *   - image: data URL 留原样, agent runtime 解 base64 走 vision content block
 *   - url: 不动
 *  返回值跟 RuntimeOrchestrator metadata.attachments 同 shape, 直接灌进 session.input(user_message).
 */
async function uploadAttachmentsToPod(
  sessionId: string,
  attachments: any[] | undefined,
): Promise<any[] | undefined> {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const out: any[] = [];
  for (const att of attachments) {
    if (!att) continue;
    if (att.type === 'image' || att.type === 'url') {
      out.push(att);
      continue;
    }
    if (att.type !== 'file') {
      out.push(att);
      continue;
    }
    /* file 类型: 优先用 att.data (renderer 已读好 base64), 否则按 att.path 从本机读. */
    let payload: { encoding: 'utf8' | 'base64'; content: string };
    if (typeof att.data === 'string' && att.data.length > 0) {
      /* data 可能是 data URI 也可能是裸 base64 */
      const m = /^data:[^;]+;base64,(.+)$/.exec(att.data);
      payload = { encoding: 'base64', content: m ? m[1]! : att.data };
    } else if (typeof att.path === 'string' && att.path) {
      try {
        const buf = await fsp.readFile(att.path);
        payload = { encoding: 'base64', content: buf.toString('base64') };
      } catch (err: any) {
        bridgeLog('chat:send', `attachment readFile failed: ${att.path} ${err?.message}`);
        continue; /* 跳过这条, 不阻断其他 */
      }
    } else {
      continue;
    }
    const safeName = (att.name || path.basename(att.path || 'upload')).replace(/[^\w.\-]/g, '_');
    const podPath = `.neox/uploads/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safeName}`;
    try {
      const resp = await remoteSessions().sendRequest(sessionId, 'session.fs_write', {
        path: podPath,
        encoding: payload.encoding,
        content: payload.content,
      });
      if ((resp as any).error) {
        bridgeLog('chat:send', `fs_write fail: ${(resp as any).error.message}`);
        continue;
      }
      out.push({ ...att, path: podPath /* pod 相对路径, agent 读这里 */ });
    } catch (err: any) {
      bridgeLog('chat:send', `fs_write RPC threw: ${err?.message}`);
    }
  }
  return out;
}

export function registerChatSessionIpcHandlers(options: RegisterChatSessionIpcHandlersOptions): void {
  const {
    projectManager,
    getSessionOrThrow,
    sessionStore,
    sessionsCache,
  } = options;

  // chat 路径天然依赖 project scope —— 没 scope 直接抛错
  const bridgeOf = makeBridgeResolver(projectManager);
  const workspaceOf = makeWorkspaceResolver(projectManager);

  ipcMain.handle('chat:send', async (event, payload: ChatRequestPayload) => {
    const sendStartedAt = Date.now();
    /* 住在云端的 Pilot (services/pilotCloudSlot.ts): 它的会话一律走云端, renderer 不用知道 */
    const isCloud = (payload as any).transport === 'cloud' || isCloudPilotSession(payload.sessionId);
    bridgeLog('chat:send', `sessionId=${payload.sessionId?.slice(0, 24) ?? '(none)'} transport=${(payload as any).transport ?? 'local'} cloud=${isCloud}`);
    if (isCloud && payload.sessionId) {
      /* lazy: 没 relayKey 就 resume 拿. ensureCloudSessionKey 返具体 reason + code 让 renderer 路由处理. */
      const keyResult = await remoteSessions().ensureKey(payload.sessionId).catch((e) => {
        bridgeLog('chat:send', `ensureCloudSessionKey threw: ${e?.message ?? e}`);
        return { ok: false as const, reason: `异常: ${e?.message ?? e}`, code: 'UNKNOWN' as const };
      });
      if (!keyResult.ok) {
        bridgeLog('chat:send', `key fail reason=${keyResult.reason} code=${(keyResult as any).code ?? '?'}`);
        /* code 嵌进 message 前缀: "[CLOUD_FAIL:<CODE>] <reason>" — Electron IPC 不保留 Error
         * 自定义字段, 走 message 前缀让 renderer parse 出来路由 (TERMINATED → 自动新建+重发). */
        const code = (keyResult as any).code ?? 'UNKNOWN';
        throw new Error(`[CLOUD_FAIL:${code}] ${keyResult.reason}`);
      }
      /* attachments — desktop 端是本地 fs path / base64 dataURL.  cloud 模式 pod 看不到本地 fs,
       *  得先把 file 类型的 attachment 上传到 pod workspace, 再把 path 改写成 pod 相对路径.
       *  image / url 类型直接透传 (data URL / URL 字符串). */
      const isRecovery = payload.isContinue === true || payload.isRetry === true;
      const uploadedAttachments = isRecovery ? undefined : await uploadAttachmentsToPod(
        payload.sessionId,
        (payload as any).metadata?.attachments,
      );
      const sendOnce = async (): Promise<void> => {
        await remoteSessions().sendRequest(payload.sessionId!, 'session.input', {
          session_id: payload.sessionId,
          kind: payload.isContinue ? 'continue' : payload.isRetry ? 'retry' : 'user_message',
          payload: {
            text: isRecovery ? '' : payload.prompt,
            ...(uploadedAttachments && uploadedAttachments.length > 0
              ? { attachments: uploadedAttachments }
              : {}),
          },
        });
      };
      try {
        await sendOnce();
        bridgeLog('chat:send',
          `cloud send ok session=${payload.sessionId.slice(0, 24)} att=${uploadedAttachments?.length ?? 0}`);
      } catch (err: any) {
        /* 一次自愈尝试: send 失败大概率是 cached key 对应的 pod 已死 (suspended/transient
         *  cleanup). 把 cloudSessionStore 这条 invalidate, 重新 ensureCloudSessionKey 走 /resume
         *  (server 端 suspended → 自动拉新 pod), 再 send 一次.
         *  失败两次才真的报错给前端 — 这才是用户期望的"对 pod 死活无感"语义. */
        bridgeLog('chat:send', `cloud send failed once: ${err?.message ?? err}, try resume + retry`);
        try {
          remoteSessions().forget(payload.sessionId);
        } catch { /* ignore */ }
        const keyResult2 = await remoteSessions().ensureKey(payload.sessionId).catch((e) => ({
          ok: false as const, reason: `resume 异常: ${e?.message ?? e}`, code: 'UNKNOWN' as const,
        }));
        if (!keyResult2.ok) {
          const code = (keyResult2 as any).code ?? 'UNKNOWN';
          throw new Error(`[CLOUD_FAIL:${code}] ${keyResult2.reason}`);
        }
        try {
          await sendOnce();
          bridgeLog('chat:send', `cloud send ok after resume retry session=${payload.sessionId.slice(0, 24)}`);
        } catch (err2: any) {
          bridgeLog('chat:send', `cloud send failed after resume retry: ${err2?.message ?? err2}`);
          throw new Error(`cloud session.input failed: ${err2?.message ?? err2}`);
        }
      }
      return {
        sessionId: payload.sessionId,
        finalText: '',
        tokens: 0,
        contextUsed: 0,
        startedAt: sendStartedAt,
        finishedAt: sendStartedAt,
      };
    }

    const bridge = bridgeOf(event);
    /* M1 单源化 — server chat() 入口会 publish user_message event + appendMessage('user') 写 drift.
     * 这里给 payload 打 source='desktop' + 透传 userMessageId 让 server publish 时复用,
     * renderer self-push 跟 SSE 推回的 entry 用 messageId 去重不会双显. */
    /* 会话记录里的聊天标记是唯一真源 (chat:C1-01): 客户端没带 chatMode (手机 / 旧客户端)
     * 就用库里的 —— 桌面开的聊天会话, 换个客户端接着聊仍然是聊天。显式带了就以客户端为准
     * (用户可能刚在界面上切过, 那一刻的意图比库里旧值新)。 */
    let storedChatMode: boolean | null = null;
    if (payload.sessionId) {
      try { storedChatMode = getDatabase().getSessionChatMode(payload.sessionId); } catch { /* DB 不可用 → 当没设 */ }
    }
    const payloadWithSource: any = {
      ...payload,
      chatMode: payload.chatMode ?? storedChatMode ?? undefined,
      userMessageSource: (payload as any).userMessageSource ?? 'desktop',
      userMessageId: (payload as any).userMessageId,
    };
    const result = await bridge.sendMessage(payloadWithSource);

    if (payload.sessionId) {
      const session = await getSessionOrThrow(payload.sessionId);
      const userTimestamp = Math.min(sendStartedAt, result.startedAt ?? sendStartedAt);
      const assistantTimestamp = result.finishedAt ?? result.startedAt ?? Date.now();

      const userMessage: ChatMessage = {
        id: createId('msg'),
        role: 'user',
        text: formatMessageWithAttachments(payload.prompt, payload.metadata?.attachments),
        timestamp: userTimestamp,
      };
      const assistantMessage: ChatMessage = {
        id: createId('msg'),
        role: 'assistant',
        text: result.finalText,
        timestamp: assistantTimestamp,
        tokens: result.tokens,
      };

      if (!payload.isRetry && !payload.isContinue) session.messages.push(userMessage);
      if (result.finalText?.trim()) session.messages.push(assistantMessage);
      session.totalTokens += result.tokens;
      if (result.contextUsed && result.contextUsed > 0) {
        session.contextUsed = result.contextUsed;
      }
      session.updatedAt = assistantTimestamp;

      try {
        const dbSession = getDatabase().getSession(session.id);
        if (dbSession && dbSession.contextUsed > 0 && (!session.contextUsed || session.contextUsed <= 0)) {
          session.contextUsed = dbSession.contextUsed;
        }
        if (dbSession && dbSession.contextWindow && !session.contextWindow) {
          session.contextWindow = dbSession.contextWindow;
        }
        if (dbSession && typeof dbSession.name === 'string' && dbSession.name && dbSession.name !== session.name) {
          session.name = dbSession.name;
        }
      } catch { /* ignore read error */ }
      await sessionStore.saveSessionMetadata(session);
      if (session.workspacePath) {
        await storageService.updateWorkspaceLastSession(session.workspacePath, session.id);
      }
      bridge.updateSessionHistory(session.id, session.messages);

      if (payload.modelId) {
        await storageService.setLastModel(payload.modelId);
        // 同步更新 session 的 modelId（用户可能中途切换了模型）
        if (session.modelId !== payload.modelId) {
          session.modelId = payload.modelId;
          sessionsCache.set(session.id, session);
          try {
            getDatabase().updateSessionField(session.id, 'model_id', payload.modelId);
          } catch { /* ignore */ }
        }
      }
    }

    return result;
  });

  const resolveControlTarget = (payload: any): { sessionId: string | undefined; isCloud: boolean } => {
    const sessionId = typeof payload === 'string' ? payload : payload?.sessionId;
    if (!sessionId) return { sessionId: undefined, isCloud: false };
    /* 显式 transport='cloud' 或在 cloudSessionStore 命中都视为 cloud */
    const explicit = typeof payload === 'object' && payload?.transport === 'cloud';
    const inStore = remoteSessions().has(sessionId);
    return { sessionId, isCloud: explicit || inStore };
  };

  ipcMain.handle('chat:interrupt', async (event, payload: any) => {
    const { sessionId, isCloud } = resolveControlTarget(payload);
    if (!sessionId) return { ok: false, error: 'sessionId required' };
    if (isCloud) {
      const keyResult = await remoteSessions().ensureKey(sessionId);
      if (!keyResult.ok) throw new Error('Cloud session is not available; stop was not acknowledged');
      const response = await remoteSessions().sendRequest(sessionId, 'session.input', {
        session_id: sessionId,
        kind: 'control',
        payload: { action: 'cancel' },
      });
      if (response.error || (response.result as { ok?: boolean } | undefined)?.ok !== true) {
        throw new Error('Cloud stop was not acknowledged');
      }
      return { ok: true, sessionId, transport: 'cloud' };
    }
    return bridgeOf(event).interruptSession(sessionId);
  });

  ipcMain.handle('chat:getExecutionStates', async (event, probeSessionIds?: string[]) => {
    try {
      /* probeSessionIds = renderer 本地认为还在跑的会话。bridge 的状态 Map 是 per-scope
       * 内存态, 换 workspace 就换实例, 老会话不在 Map 里 —— 不点名就永远查不到它们。 */
      return { ok: true, states: await bridgeOf(event).getExecutionStates(probeSessionIds) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  /** 运行中插话必须由运行时确认排队，不能降级为普通发送。 */
  ipcMain.handle('chat:inject', async (event, payload: any) => {
    const { sessionId, isCloud } = resolveControlTarget(payload);
    const message: string = payload?.message ?? '';
    const images: Array<{ mediaType: string; data: string; name?: string }> | undefined =
      Array.isArray(payload?.images) && payload.images.length > 0 ? payload.images : undefined;
    if (!sessionId || !message.trim()) return { queued: false, position: 0, reason: 'empty' };
    if (isCloud) {
      const keyResult = await remoteSessions().ensureKey(sessionId).catch(() => ({ ok: false as const, reason: '' }));
      if (!keyResult.ok) return { queued: false, position: 0, reason: 'cloud_key_failed' };
      try {
        const response = await remoteSessions().sendRequest(sessionId, 'session.input', {
          session_id: sessionId,
          kind: 'inject_message',
          payload: {
            text: message,
            attachments: images?.map(img => ({
              kind: 'image', mime: img.mediaType, data_base64: img.data, name: img.name,
            })),
          },
        });
        const result = response.result as { queued?: boolean; position?: number } | undefined;
        if (response.error) return { queued: false, position: 0, reason: 'cloud_rejected' };
        if (typeof result?.queued !== 'boolean') {
          throw new Error('cloud injection acknowledgement missing');
        }
        return { queued: result.queued, position: result.position ?? 0 };
      } catch (err: any) {
        bridgeLog('chat:inject', `cloud session.input failed: ${err?.message ?? err}`);
        // A missing acknowledgement is not proof of rejection; do not restore and replay.
        throw err;
      }
    }
    const bridge = bridgeOf(event);
    const when = payload?.when === 'turn-end' ? 'turn-end' as const : undefined;
    const position = await bridge.injectMessage(sessionId, message, images, when);
    if (position > 0) return { queued: true, position };
    const detail = await bridge.describeInjectTarget(sessionId).catch(() => null);
    const reason = !detail ? 'no_detail'
      : !detail.hasHost ? 'no_host_for_session'
      : !detail.isRunning ? 'host_idle'
      : 'queue_refused';
    bridgeLog('chat:inject', `not queued: ${reason} sid=${sessionId} hosts=${detail?.hostSessionIds?.join(',') ?? '?'}`);
    return { queued: false, position: 0, reason, detail };
  });

  /** 第二次回车 = 立即转向: 插话已排进队列后, 打断在途模型输出让它下一步就生效。
   *  cloud 由 pod 自己排队, 这里不转向。 */
  ipcMain.handle('chat:steer', async (event, payload: any) => {
    const { sessionId, isCloud } = resolveControlTarget(payload);
    if (!sessionId || isCloud) return { steered: false };
    const steered = await bridgeOf(event).steerSession(sessionId).catch(() => false);
    bridgeLog('chat:steer', `sid=${sessionId} steered=${steered}`);
    return { steered };
  });

  ipcMain.handle('monitor:list', async (event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return [];
    return bridgeOf(event).listMonitors(sessionId);
  });
  ipcMain.handle('monitor:stop', async (event, payload: { sessionId?: string; id?: string }) => {
    if (!payload?.sessionId || !payload?.id) return false;
    return bridgeOf(event).stopMonitor(payload.sessionId, payload.id);
  });

  ipcMain.handle('chat:dequeue-last', async (event, payload: any) => {
    const { sessionId, isCloud } = resolveControlTarget(payload);
    if (!sessionId || isCloud) return null;
    const text = typeof payload?.text === 'string' ? payload.text : undefined;
    return bridgeOf(event).removeLastPendingMessage(sessionId, text);
  });

  ipcMain.handle('chat:pause', async (event, payload: any) => {
    const { sessionId, isCloud } = resolveControlTarget(payload);
    if (!sessionId) return { ok: false };
    if (isCloud) {
      const keyResult = await remoteSessions().ensureKey(sessionId).catch(() => ({ ok: false as const, reason: '' }));
      if (!keyResult.ok) return { ok: false };
      const resp = await remoteSessions().sendRequest(sessionId, 'session.input', {
        session_id: sessionId,
        kind: 'control',
        payload: { action: 'pause' },
      }).catch(() => null);
      return (resp as any)?.result ?? { ok: !!resp };
    }
    return bridgeOf(event).pauseSession(sessionId);
  });

  ipcMain.handle('chat:resume', async (event, payload: any) => {
    const { sessionId, isCloud } = resolveControlTarget(payload);
    if (!sessionId) return { ok: false };
    if (isCloud) {
      const keyResult = await remoteSessions().ensureKey(sessionId).catch(() => ({ ok: false as const, reason: '' }));
      if (!keyResult.ok) return { ok: false };
      const resp = await remoteSessions().sendRequest(sessionId, 'session.input', {
        session_id: sessionId,
        kind: 'control',
        payload: { action: 'resume' },
      }).catch(() => null);
      return (resp as any)?.result ?? { ok: !!resp };
    }
    return bridgeOf(event).resumeSession(sessionId);
  });

  ipcMain.handle('process:pause', async (event, pid: string) => {
    return bridgeOf(event).pauseProcess(pid);
  });

  ipcMain.handle('process:resume', async (event, pid: string) => {
    return bridgeOf(event).resumeProcess(pid);
  });

  ipcMain.handle('session:get-all', async (event, workspacePath?: string) => {
    // workspacePath 缺省 = 跨 workspace 全量(给 Sidebar 按 folder 分组用).
    // bridge 是 per-workspace 的, 只对 sender 当前 workspace 的 session 做 setCurrent / push history,
    // 避免把其他 workspace 的 session 灌进当前 bridge 造成 cross-workspace 串扰.
    let bridge: ReturnType<typeof bridgeOf> | null = null;
    try { bridge = bridgeOf(event); } catch { /* Welcome 场景无 scope, 允许. */ }
    const allSessions = await sessionStore.listSessionsSlim(workspacePath);
    if (bridge) {
      const senderWs = workspaceOf(event);
      const sessionsForBridge = workspacePath
        ? allSessions
        : (senderWs ? allSessions.filter(s => sameWorkspace(s.workspacePath, senderWs)) : []);
      if (!bridge.getCurrentSessionId() && sessionsForBridge.length > 0) {
        bridge.setCurrentSessionId(sessionsForBridge[0].id);
      }
    }
    return allSessions;
  });

  /* 侧栏刷新专用的更瘦一档 (#109) —— 在 slim 基础上再去掉三个 usage 字段。
   * 单开一个 channel 而不是改 session:get-all 的返回结构: 那个返回被好几个消费方读,
   * 发版前改契约风险太大。想省流量的调用方显式换过来就行。 */
  ipcMain.handle('session:get-all-lite', async (event, workspacePath?: string) => {
    try { bridgeOf(event); } catch { /* Welcome 场景无 scope, 允许 */ }
    return sessionStore.listSessionsLite(workspacePath);
  });

  /* 全量列表 (含 messages) — 只给显式按需场景用 (跨会话全文搜索 palette 打开时)。
   * 不进 sessionsCache、不灌 bridge — 纯读取, 调用方用完即弃。日常列表走 slim 的 get-all。 */
  ipcMain.handle('session:get-all-full', async (_event, workspacePath?: string) => {
    return sessionStore.listSessions(workspacePath);
  });

  ipcMain.handle('session:search', async (_event, payload?: { query?: string; workspacePath?: string }) => {
    const query = (payload?.query ?? '').trim();
    if (!query) return { ok: true, hits: [] };
    try {
      const db = getDatabase();
      const rows = db.searchMessages(query, { workspacePath: payload?.workspacePath, limit: 400 });
      const hits: MatchHit[] = [];
      for (const r of rows) {
        if (hits.length >= MAX_HITS) break;
        const data = (r.itemData ?? {}) as { role?: string; content?: unknown };
        const hit = hitFromMessage(
          { id: r.sessionId, name: r.sessionName, updatedAt: r.sessionUpdatedAt },
          {
            /* id 口径跟 sessionStore 的 timelineEntryToChatMessage 一致, 否则前端定位不到那条消息 */
            id: `msg_${r.sessionId}_${r.seq}`,
            role: String(data.role ?? ''),
            timestamp: r.timestamp,
            text: messageContentToText(data.content),
          },
          query,
        );
        if (hit) hits.push(hit);
      }
      /* 跟本地那条路 (searchSessions) 同一个口径 —— 去重必须两边都做, 否则用户会
       * 看到"有时重复有时不重复", 取决于走的是 IPC 还是 renderer 内的兜底搜索。 */
      return { ok: true, hits: dedupeHits(hits) };
    } catch (err) {
      /* 搜不动就让前端回落到本地全量搜索, 不要把面板打挂 */
      return { ok: false, hits: [], error: String((err as Error)?.message ?? err) };
    }
  });

  ipcMain.handle('team:get-plan', async (_event, sessionId: string) => {
    if (!sessionId) return null;
    try {
      const row = getDatabase().getLatestTeamSessionBySession(sessionId);
      if (!row?.missionGraph) return null;
      const g = JSON.parse(row.missionGraph) as Record<string, unknown>;
      return {
        ...g,
        teamId: row.teamId,
        sessionId: row.sessionId,
        goal: row.goal,
        stage: (g.stage as string) ?? row.status ?? 'requirements',
        requirements: g.requirements ?? [],
        roster: g.roster ?? [],
        reviews: g.reviews ?? [],
        meetings: g.meetings ?? [],
        claims: g.claims ?? [],
        updatedAt: (g.updatedAt as number) ?? row.updatedAt ?? Date.now(),
      };
    } catch (err: any) {
      bridgeLog('team:get-plan', `读取失败: ${err?.message ?? err}`);
      return null;
    }
  });

  ipcMain.handle('team:get-exec', async (_event, sessionId: string) => {
    if (!sessionId) return null;
    try {
      const row = getDatabase().getLatestTeamSessionBySession(sessionId);
      if (!row?.missionGraph) return null;
      const g = JSON.parse(row.missionGraph) as Record<string, unknown>;
      return (g as any).exec ?? null;
    } catch (err: any) {
      bridgeLog('team:get-exec', `读取失败: ${err?.message ?? err}`);
      return null;
    }
  });

  ipcMain.handle('team:dismiss', async (_event, payload: { sessionId?: string; force?: boolean }) => {
    const { sessionId, force } = payload ?? {};
    if (!sessionId) return { ok: false, reason: 'missing sessionId' };
    try {
      return (await bridgeOf(_event).teamDismiss?.(sessionId, force)) ?? { ok: false, reason: 'no bridge' };
    } catch (err: any) {
      bridgeLog('team:dismiss', `失败: ${err?.message ?? err}`);
      return { ok: false, reason: String(err?.message ?? err) };
    }
  });

  ipcMain.handle('team:exec-command', async (_event, payload: {
    sessionId?: string; cmd?: 'retry' | 'skip' | 'reassign'; taskId?: string; arg?: string;
  }) => {
    const { sessionId, cmd, taskId, arg } = payload ?? {};
    if (!sessionId || !cmd || !taskId) return null;
    try {
      return (await bridgeOf(_event).teamExecCommand?.(sessionId, cmd, taskId, arg)) ?? null;
    } catch (err: any) {
      bridgeLog('team:exec-command', `失败: ${err?.message ?? err}`);
      return null;
    }
  });

  /* 看板上用户点着把需求分给某个成员 —— 写回 core 的 teamPlanStore 并落库。
   * 这是**用户操作**不是模型调用, 所以不走工具, 走 IPC。 */
  ipcMain.handle('team:assign', async (_event, payload: { sessionId?: string; requirementId?: string; memberId?: string | null }) => {
    const { sessionId, requirementId } = payload ?? {};
    if (!sessionId || !requirementId) return null;
    try {
      const plan = await bridgeOf(_event).assignTeamRequirement?.(
        sessionId, requirementId, payload?.memberId ?? null,
      );
      return plan ?? null;
    } catch (err: any) {
      bridgeLog('team:assign', `失败: ${err?.message ?? err}`);
      return null;
    }
  });

  ipcMain.handle('session:peek', async (_event, sessionId: string) => {
    if (!sessionId) return null;
    return (await sessionStore.loadSession(sessionId)) ?? null;
  });

  ipcMain.handle('session:get', async (event, sessionId: string) => {
    const bridge = bridgeOf(event);
    const session = await sessionStore.loadSession(sessionId);
    if (!session) return null;
    bridge.setCurrentSessionId(session.id);
    sessionsCache.set(session.id, session);
    bridge.updateSessionHistory(session.id, session.messages);
    return session;
  });

  ipcMain.handle('session:create', async (event, workspacePath: string, modelId: string, opts?: { kind?: 'chat' | 'image'; name?: string; agentMode?: 'work' | 'code' }) => {
    const bridge = bridgeOf(event);
    const sessionId = createId('session');
    const resolvedWorkspace = workspacePath || bridge.getWorkspacePath() || '';
    const session = await sessionStore.createSession({ sessionId, workspacePath: resolvedWorkspace, modelId, kind: opts?.kind, name: opts?.name, agentMode: opts?.agentMode });
    bridge.setCurrentSessionId(sessionId);
    sessionsCache.set(sessionId, session);
    bridge.updateSessionHistory(sessionId, session.messages);
    if (resolvedWorkspace) await storageService.updateWorkspaceLastSession(resolvedWorkspace, sessionId);
    /* 通知 Desktop renderer 重拉 sessions — 避免 createSession 后列表未刷新,
     * selectSession 找不到 id 而误走云端 stub (标题「云端会话」). */
    try {
      const { notifyDesktopSessionsChanged } = await import('../mobile-bridge/index.js');
      notifyDesktopSessionsChanged();
    } catch { /* ignore */ }
    /* 广播给所有已连 Mobile — 不做手机端就只能等下次重连看到 desktop 新建的 session.
     *   dynamic import 防 IPC 文件被 unit test 加载时强引 mobile-bridge (含 mDNS 等 native dep). */
    void (async () => {
      try {
        const { broadcastSessionCreated } = await import('../mobile-bridge/wsServer.js');
        await broadcastSessionCreated({
          id: session.id,
          title: session.name ?? session.id,
          workspace_name: session.workspacePath
            ? session.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? ''
            : '',
          created_at: session.createdAt ?? 0,
          updated_at: session.updatedAt ?? 0,
          total_tokens: session.totalTokens ?? 0,
          /* image 会话标识 — phone 端显示"图片工作台"降级标注 */
          kind: (session as any).kind === 'image' ? 'image' : 'chat',
        });
      } catch { /* ignore — mobile bridge 可能未启动 */ }
    })();
    return session;
  });

  ipcMain.handle('session:delete', async (event, sessionId: string): Promise<{ ok: boolean; cloudOk: boolean; cloudError?: string }> => {
    const bridge = bridgeOf(event);
    try { bridge.clearSession(sessionId); } catch { /* ignore */ }
    void bridge.releaseSessionWatchers(sessionId);
    try {
      if (bridge.getCurrentSessionId() === sessionId) bridge.setCurrentSessionId(null);
    } catch { /* ignore */ }
    try { sessionsCache.delete(sessionId); } catch { /* ignore */ }
    try { await sessionStore.deleteSession(sessionId); } catch (err: any) {
      bridgeLog('session:delete', `local DB delete failed (cloud-only?): ${err?.message ?? err}`);
    }
    /* Pilot 的档案和通话记录跟会话一起删 —— 只删会话, 下次列表又会从档案里把它捞回来 */
    try {
      const { removePilotProfile } = await import('@neoxlabs/core');
      removePilotProfile(sessionId);
      const { removeCallLogFor } = await import('../services/pilotCallService.js');
      removeCallLogFor(sessionId);
    } catch { /* 不是 Pilot 会话 */ }
    /* 通知 phone 把 session_mirror 清掉 — fire-and-forget, 不阻塞返回. */
    void (async () => {
      try {
        const { broadcastSessionDeleted } = await import('../mobile-bridge/wsServer.js');
        await broadcastSessionDeleted(sessionId);
      } catch { /* ignore */ }
    })();
    /* cloud cleanup — await 等服务端 ack, 给 renderer 准确的 ok 状态.
     *  cloudOk=true 才能安全告诉用户"已彻底删除"; false 时 renderer 弹"本地已删, 云端清理失败" toast. */
    let cloudOk = true;
    let cloudError: string | undefined;
    try {
      const { ensureFreshDesktopAuthTokens } = await import('./authHandlers.js');
      const { resolveCloudEndpoints } = await import('../services/cloudEndpoints.js');
      const tokens = await ensureFreshDesktopAuthTokens();
      const ep = resolveCloudEndpoints();
      if (tokens?.accessToken) {
        const resp = await fetch(`${ep.api}/api/v1/cloud-agent/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        /* 200 + 404 都算成功 (本地已删, server 没找到也是预期 — 比如 cloud session 早过期被清). */
        if (!resp.ok && resp.status !== 404) {
          cloudOk = false;
          cloudError = `HTTP ${resp.status}`;
          bridgeLog('session:delete', `cloud DELETE failed: ${resp.status} ${sessionId.slice(0, 24)}`);
        } else {
          bridgeLog('session:delete', `cloud cleanup done (status=${resp.status}): ${sessionId.slice(0, 24)}`);
        }
      }
      /* 不管 server 成功失败, 本地 store 都清 — 用户已经按了删, store 留着是 stale. */
      remoteSessions().forget(sessionId);
    } catch (err: any) {
      cloudOk = false;
      cloudError = err?.message ?? String(err);
      bridgeLog('session:delete', `cloud cleanup exception: ${cloudError}`);
      /* 网络异常也清本地 cache, 否则下次发消息还用旧 key. */
      try { remoteSessions().forget(sessionId); } catch { /* ignore */ }
    }
    return { ok: true, cloudOk, cloudError };
  });

  ipcMain.handle('session:rename', async (event, sessionId: string, name: string) => {
    await sessionStore.updateSessionMetadata(sessionId, { name });
    const session = await sessionStore.loadSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    sessionsCache.set(sessionId, session);
    bridgeOf(event).updateSessionHistory(sessionId, session.messages);
    /* cloud session: 把新名字落到 server cloud_agent_sessions.title, 否则用户在其他设备登录看的还是旧名. */
    if (remoteSessions().has(sessionId)) {
      void (async () => {
        try {
          const { ensureFreshDesktopAuthTokens } = await import('./authHandlers.js');
          const { resolveCloudEndpoints } = await import('../services/cloudEndpoints.js');
          const tokens = await ensureFreshDesktopAuthTokens();
          const ep = resolveCloudEndpoints();
          if (tokens?.accessToken) {
            await fetch(`${ep.api}/api/v1/cloud-agent/sessions/${encodeURIComponent(sessionId)}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${tokens.accessToken}`,
              },
              body: JSON.stringify({ title: name }),
            });
            bridgeLog('cloud-session', `rename synced: ${sessionId.slice(0, 24)} → ${name}`);
          }
        } catch (err: any) {
          bridgeLog('cloud-session', `rename sync failed: ${err?.message ?? err}`);
        }
      })();
    }
    return session;
  });

  ipcMain.handle('session:export', async (event, sessionId: string, format: 'json' | 'md') => {
    /* 导出要全部历史 —— 缓存里的会话对象只带最近一页 (loadSession 默认有界), 这里单独全量读。 */
    const session: Session | null = await sessionStore.loadSession(sessionId, { full: true });
    if (!session) {
      throw new Error('Session not found');
    }

    let content: string;
    let extension: string;
    if (format === 'json') {
      content = JSON.stringify(session, null, 2);
      extension = 'json';
    } else {
      const lines = [
        `# ${session.name}`,
        '',
        `**Model:** ${session.modelId}`,
        `**Created:** ${new Date(session.createdAt).toLocaleString()}`,
        `**Tokens Used:** ${session.totalTokens}`,
        '',
        '---',
        '',
      ];
      for (const msg of session.messages) {
        const role = msg.role === 'user' ? '👤 You' : '🤖 Assistant';
        lines.push(`## ${role}`);
        lines.push('');
        lines.push(msg.text);
        lines.push('');
      }
      content = lines.join('\n');
      extension = 'md';
    }

    const senderWindow = BrowserWindow.fromWebContents(event?.sender);
    if (!senderWindow) {
      throw new Error('No sender window');
    }
    const result = await dialog.showSaveDialog(senderWindow, {
      title: 'Export Session',
      defaultPath: `${session.name.replace(/[^a-z0-9]/gi, '_')}.${extension}`,
      filters: [
        format === 'json'
          ? { name: 'JSON', extensions: ['json'] }
          : { name: 'Markdown', extensions: ['md'] },
      ],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    await writeFile(result.filePath, content, 'utf-8');
    return result.filePath;
  });
}
