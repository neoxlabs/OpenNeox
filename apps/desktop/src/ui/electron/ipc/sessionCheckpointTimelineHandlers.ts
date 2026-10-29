import { ipcMain } from './ipcMainBridged.js';

/* electron 运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 后端里加载失败,
 * 连累同包所有 handler (见 lazyElectron.ts)。ipcMain 走桥的替身。 */
import type { SavedTimelineEntry, Session, SessionCheckpointMeta } from '../../shared/ipc.js';
import type { SQLiteSession } from '@neoxlabs/core/memory/sqlite-session.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeBridgeResolver } from './scopeResolvers.js';
import { remoteSessions } from '../remoteSessions.js';

interface SessionStoreLike {
  setTimeline(sessionId: string, timeline: SavedTimelineEntry[]): Promise<void>;
}

interface RegisterSessionCheckpointTimelineIpcHandlersOptions {
  projectManager: ProjectManager;
  getSessionOrThrow: (sessionId: string) => Promise<Session>;
  getSqliteSession: (sessionId: string) => SQLiteSession;
  refreshSession: (sessionId: string) => Promise<Session>;
  persistSession: (session: Session) => Promise<Session>;
  sessionStore: SessionStoreLike;
  sessionsCache: Map<string, Session>;
}

/** 从会话时间轴里翻出某个检查点当时记的 Shadow Git HEAD。老的检查点没有这个字段, 返 undefined。 */
async function findFileCheckpointId(
  sqliteSession: SQLiteSession,
  checkpointId: string,
): Promise<string | undefined> {
  try {
    const data = sqliteSession.getCheckpointData(checkpointId) as { fileCheckpointId?: string } | null;
    return data?.fileCheckpointId || undefined;
  } catch { /* 读不到就当没有 */ }
  return undefined;
}

export function registerSessionCheckpointTimelineIpcHandlers(
  options: RegisterSessionCheckpointTimelineIpcHandlersOptions,
): void {
  const {
    projectManager,
    getSessionOrThrow,
    getSqliteSession,
    refreshSession,
    persistSession,
    sessionStore,
    sessionsCache,
  } = options;

  const bridgeOf = makeBridgeResolver(projectManager);

  /* cloud session 用 pod 上的 RPC 走同语义操作. 路由判断都用 remoteSessions().has(). */
  const isCloud = async (sessionId: string): Promise<boolean> => {
    return remoteSessions().has(sessionId);
  };
  const cloudRpc = async (sessionId: string, method: string, params: Record<string, unknown> = {}) => {
    const resp = await remoteSessions().sendRequest(sessionId, method, params);
    if ((resp as any).error) throw new Error(String((resp as any).error.message ?? `${method} failed`));
    return (resp as any).result;
  };

  ipcMain.handle('session:undo', async (_event, sessionId: string, count: number = 1) => {
    if (await isCloud(sessionId)) {
      await cloudRpc(sessionId, 'session.undo', { count });
      return await refreshSession(sessionId);
    }
    await getSessionOrThrow(sessionId);
    const sqliteSession = getSqliteSession(sessionId);
    const turns = Math.max(1, count);

    for (let i = 0; i < turns; i++) {
      const assistant = await sqliteSession.popItem();
      if (!assistant) break;
      const user = await sqliteSession.popItem();
      if (!user) {
        await sqliteSession.addItems([assistant]);
        break;
      }
    }

    return await refreshSession(sessionId);
  });

  /* 会话检查点 = 对话 + 文件的同一个时刻。建点时把 Shadow Git 当前 HEAD 一起记下来,
   * 回滚才能把两边带回同一个位置 (见 CheckpointItem.fileCheckpointId 的注释)。
   * 拿不到就存空, 回滚退化成只裁对话 —— 不因为 checkpoint 关着就让建点失败。 */
  const currentFileCheckpointId = async (event: Electron.IpcMainInvokeEvent): Promise<string | undefined> => {
    try {
      const list = await bridgeOf(event).getCheckpoints(1);
      const head = Array.isArray(list) ? list[0] : undefined;
      return head?.id || undefined;
    } catch {
      return undefined;
    }
  };

  ipcMain.handle('session:checkpoint', async (event, sessionId: string, name?: string) => {
    if (await isCloud(sessionId)) {
      await cloudRpc(sessionId, 'session.checkpoint_create', { name: name?.trim() || undefined });
      return await refreshSession(sessionId);
    }
    await getSessionOrThrow(sessionId);
    const sqliteSession = getSqliteSession(sessionId);
    await sqliteSession.createCheckpoint(
      name?.trim() || undefined,
      undefined,
      await currentFileCheckpointId(event),
    );
    return await refreshSession(sessionId);
  });

  ipcMain.handle('session:get-checkpoints', async (_event, sessionId: string) => {
    if (await isCloud(sessionId)) {
      try {
        const r = await cloudRpc(sessionId, 'session.checkpoint_list');
        const arr = Array.isArray(r?.checkpoints) ? r.checkpoints : [];
        return arr.map((c: any) => ({
          id: c.id,
          name: c.name,
          timestamp: c.ts ?? Date.now(),
          messageCount: c.messageCount ?? 0,
          summary: undefined,
        })) as SessionCheckpointMeta[];
      } catch { return []; }
    }
    await getSessionOrThrow(sessionId);
    const sqliteSession = getSqliteSession(sessionId);
    /* 计数在 SQL 里做, 不把整段时间线读进主进程 */
    return sqliteSession.getCheckpointsWithMessageCount().map((c) => ({
      id: c.id,
      name: c.name,
      timestamp: c.timestamp,
      messageCount: c.messageCount,
      summary: c.description,
    })) as SessionCheckpointMeta[];
  });

  ipcMain.handle('session:rollback', async (event, sessionId: string, checkpointId: string) => {
    if (await isCloud(sessionId)) {
      await cloudRpc(sessionId, 'session.rollback', { checkpoint_id: checkpointId });
      return await refreshSession(sessionId);
    }
    await getSessionOrThrow(sessionId);
    const sqliteSession = getSqliteSession(sessionId);
    /* 先取文件基线再裁对话 —— 裁完 checkpoint 条目本身就没了, 取不到 fileCheckpointId。 */
    const fileCheckpointId = await findFileCheckpointId(sqliteSession, checkpointId);
    await sqliteSession.rollbackToCheckpoint(checkpointId);
    if (fileCheckpointId) {
      try {
        const r = await bridgeOf(event).rollbackToCheckpoint(fileCheckpointId);
        console.log(`[session:rollback] files restored=${r?.restored?.length ?? 0} errors=${r?.errors?.length ?? 0}`);
      } catch (err: any) {
        /* 文件回滚失败不该把对话回滚也一起回退 —— 对话已经裁了, 抛错只会让 UI 看起来没动。
         * 记日志, 让用户从「文件检查点」卡片手动补一刀。 */
        console.error('[session:rollback] file rollback failed:', err?.message ?? err);
      }
    }
    return await refreshSession(sessionId);
  });

  ipcMain.handle('session:truncate-from-user-message', async (event, sessionId: string, k: number) => {
    if (await isCloud(sessionId)) {
      /* 云会话的历史在服务端, 本地裁不到 —— 明确报不支持, 别假装裁了。 */
      return { ok: false, removed: -1, reason: 'cloud-session' };
    }
    await getSessionOrThrow(sessionId);
    const removed = await getSqliteSession(sessionId).truncateFromNthLastUserMessage(k);
    if (removed < 0) return { ok: false, removed, reason: 'anchor-not-found' };
    try { bridgeOf(event).forgetSession(sessionId); }
    catch (err: any) { console.warn('[session:truncate] runtime forget failed:', err?.message ?? err); }
    return { ok: true, removed };
  });

  ipcMain.handle('session:clear', async (event, sessionId: string) => {
    if (await isCloud(sessionId)) {
      await cloudRpc(sessionId, 'session.clear');
      return await refreshSession(sessionId);
    }
    await getSessionOrThrow(sessionId);
    const sqliteSession = getSqliteSession(sessionId);
    await sqliteSession.clearSession();
    try { bridgeOf(event).clearSession?.(sessionId); }
    catch (err: any) { console.warn('[session:clear] runtime clear failed:', err?.message ?? err); }
    return await refreshSession(sessionId);
  });

  /* 会话预算 get / set / clear —— 账本在跑 agent 的那条线程里 (同 target 的教训: 主进程那份模块状态是空的) */
  ipcMain.handle('session:budget', async (event, sessionId: string, cmd: 'get' | 'set' | 'clear', config?: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    if (cmd !== 'get' && cmd !== 'set' && cmd !== 'clear') return null;
    return bridgeOf(event).budgetCommand?.(sessionId, cmd, config) ?? null;
  });

  /* Target Mission P1.3/P1.5 命令 — /target status|off|pause|continue|refine 桌面端直接调
   *   core 状态机, 不走 LLM. /target <goal> 激活仍由 LLM 走 activate_target 工具 (更符合 model 自主). */
  ipcMain.handle('session:target:cmd', async (event, sessionId: string, subCmd: string, arg?: string) => {
    const mod = await import('@neoxlabs/core/tools/targetModeTools.js');
    const runOnRuntime = async (
      cmd: 'pause' | 'continue' | 'stop' | 'off' | 'refine',
    ): Promise<{ live: boolean; ok: boolean; status?: string } | null> => {
      try {
        const r = await bridgeOf(event).targetCommand?.(sessionId, cmd, arg);
        return r?.live ? r : null;
      } catch (err: any) {
        console.warn(`[target:${cmd}] bridge 命令失败:`, err?.message ?? err);
        return null;
      }
    };
    switch (subCmd) {
      case 'consent': {
        mod.grantTargetConsent(sessionId);
        let onRuntime = false;
        try {
          await bridgeOf(event).grantTargetConsent?.(sessionId);
          onRuntime = (await bridgeOf(event).hasTargetConsent?.(sessionId)) ?? false;
        } catch (err: any) {
          console.warn('[target:consent] bridge 授权失败:', err?.message ?? err);
        }
        return { ok: true, consented: true, onRuntime };
      }
      case 'remember': {
        const text = String(arg ?? '');
        mod.rememberUserText?.(sessionId, text);
        try {
          await bridgeOf(event).rememberTargetUserText?.(sessionId, text);
        } catch (err: any) {
          console.warn('[target:remember] bridge 留档失败:', err?.message ?? err);
        }
        return { ok: true };
      }
      case 'pause': {
        const live = await runOnRuntime('pause');
        return live ?? { ok: mod.setTargetStatusForSessionInDb(sessionId, 'paused'), status: 'paused' };
      }
      case 'continue':
      case 'resume': {
        const live = await runOnRuntime('continue');
        return live ?? { ok: mod.setTargetStatusForSessionInDb(sessionId, 'active'), status: 'active' };
      }
      case 'stop':
      case 'abandon': {
        const live = await runOnRuntime('stop');
        /* 终止还得**真的把在跑的那一轮掐掉** —— 只改状态的话, agent 要跑到下一个迭代
         * 边界才会看到 abandoned, 用户按的是"终止"不是"跑完这轮再说"。走的是停止按钮
         * 同一条路 (host.interrupt + abort), 顺带把 sessionInterrupted 置上, 自动续跑
         * 也不会再爬起来。暂停不掐 —— 按钮 title 写的就是"这轮收尾后不再续跑"。 */
        try { bridgeOf(event).interruptSession?.(sessionId); }
        catch (err: any) { console.warn('[target:stop] interrupt 失败:', err?.message ?? err); }
        return live ?? { ok: mod.setTargetStatusForSessionInDb(sessionId, 'abandoned', arg), status: 'abandoned' };
      }
      case 'refine': {
        const live = await runOnRuntime('refine');
        /* refine 只改内存里的 plan.target, DB 那行没有独立的"改文本"通道 —— 状态机不在
         * 就只能如实说改不了, 而不是像以前那样在桌面端恒定失败。 */
        return live ?? { ok: false, error: 'target 状态机未加载, 无法改写目标文本 (先发一条消息唤起会话)' };
      }
      case 'off': {
        const live = await runOnRuntime('off');
        return live ?? { ok: mod.setTargetStatusForSessionInDb(sessionId, 'off'), status: 'off' };
      }
      case 'status': {
        const peek = mod.peekTargetForSession(sessionId);
        return peek
          ? { ok: true, ...peek }
          : { ok: true, status: 'off', plan: null, lastDoneCheck: null, abandonReason: null };
      }
      default: return { ok: false, error: `Unknown target subcommand: ${subCmd}` };
    }
  });

  ipcMain.handle('session:compact', async (event, sessionId: string) => {
    /* cloud session: pod 跑 short-term memory compaction, 通过 session.compact RPC. */
    if (remoteSessions().has(sessionId)) {
      const resp = await remoteSessions().sendRequest(sessionId, 'session.compact', {});
      if ((resp as any).error) {
        throw new Error(String((resp as any).error.message ?? 'cloud compact failed'));
      }
      return await refreshSession(sessionId);
    }
    const session = await getSessionOrThrow(sessionId);
    await bridgeOf(event).compactSession(sessionId, session.modelId);
    return await refreshSession(sessionId);
  });

  ipcMain.handle('session:set-agent-mode', async (event, sessionId: string, mode: string) => {
    const applied = await bridgeOf(event).setAgentMode(sessionId, String(mode ?? ''));
    /* 持久化 + 更新缓存 — 重启后 sidebar/顶栏立即显示正确模式, 不用等首条消息。 */
    try {
      const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
      getDatabase().setSessionAgentMode(sessionId, applied);
    } catch { /* DB 不可用不阻塞切换 — runtime 内存态已生效, chat 携带兜底 */ }

    let workspacePath: string | undefined;
    if (applied === 'work') {
      const { ensureModeHome } = await import('@neoxlabs/core/runtime/modeHome.js');
      const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
      workspacePath = ensureModeHome(applied);
      getDatabase().setSessionWorkspacePath(sessionId, workspacePath);
    }

    const cached = sessionsCache.get(sessionId);
    if (cached) {
      sessionsCache.set(sessionId, {
        ...cached,
        agentMode: applied as Session['agentMode'],
        ...(workspacePath ? { workspacePath } : {}),
      });
    }
    return { ok: true, agentMode: applied, workspacePath };
  });

  ipcMain.handle('session:get-agent-mode', async (event, sessionId: string) => {
    const agentMode = await bridgeOf(event).getAgentMode(sessionId);
    return { ok: true, agentMode };
  });

  ipcMain.handle('session:set-chat-mode', async (_event, sessionId: string, on: boolean | null) => {
    const sid = String(sessionId ?? '').trim();
    if (!sid) return { ok: false, error: 'sessionId required' };
    const chatMode = on == null ? null : on === true;
    try {
      const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
      getDatabase().setSessionChatMode(sid, chatMode);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const cached = sessionsCache.get(sid);
    if (cached) sessionsCache.set(sid, { ...cached, chatMode });
    return { ok: true, chatMode };
  });

  ipcMain.handle('session:get-chat-mode', async (_event, sessionId: string) => {
    const sid = String(sessionId ?? '').trim();
    if (!sid) return { ok: false, error: 'sessionId required' };
    try {
      const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
      return { ok: true, chatMode: getDatabase().getSessionChatMode(sid) };
    } catch {
      return { ok: true, chatMode: null };
    }
  });

  /* 按会话持久化模型 — picker 切换立刻落库, 切回老会话还原该会话模型 (不等 send). */
  ipcMain.handle('session:set-model', async (_event, sessionId: string, modelId: string) => {
    const sid = String(sessionId ?? '').trim();
    const mid = String(modelId ?? '').trim();
    if (!sid || !mid) return { ok: false, error: 'sessionId and modelId required' };
    if (mid.startsWith('default:')) return { ok: false, error: 'placeholder model is not a selection' };
    await getSessionOrThrow(sid);
    const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
    getDatabase().updateSessionField(sid, 'model_id', mid);
    const cached = sessionsCache.get(sid);
    if (cached) sessionsCache.set(sid, { ...cached, modelId: mid });
    return { ok: true, modelId: mid };
  });

  ipcMain.handle('session:set-workspace-path', async (event, sessionId: string, workspacePath: string) => {
    const target = String(workspacePath ?? '').trim();
    if (!target) return { ok: false, error: 'workspacePath required' };
    await getSessionOrThrow(sessionId);
    const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
    getDatabase().setSessionWorkspacePath(sessionId, target);
    const cached = sessionsCache.get(sessionId);
    if (cached) sessionsCache.set(sessionId, { ...cached, workspacePath: target });

    try {
      const { notifyDesktopSessionsChanged } = await import('../mobile-bridge/index.js');
      notifyDesktopSessionsChanged();
    } catch (err: any) {
      console.warn('[session:set-workspace-path] broadcast failed:', err?.message ?? err);
    }

    /* 正在跑的那一轮不会换 cwd —— 工具已经在旧目录里跑着了, 中途换是不安全的。
     * 但**必须说出来**, 不能让调用方从一个光秃秃的 ok 里以为立刻生效。 */
    let switchedImmediately = true;
    try {
      const states = await bridgeOf(event).getExecutionStates();
      switchedImmediately = !states.some(s2 => s2.sessionId === sessionId && s2.running);
    } catch { /* 拿不到状态就不下断言, 保持乐观默认 */ }

    return {
      ok: true,
      workspacePath: target,
      /* false = 当前这一轮仍在旧目录里跑完, 下一轮才生效 */
      appliesToCurrentRun: switchedImmediately,
      ...(switchedImmediately ? {} : {
        note: '会话仍在执行，本轮工具仍在原目录下运行；新路径从下一轮开始生效。',
      }),
    };
  });

  ipcMain.handle('session:backfill-agent-modes', async (event) => {
    void event;
    try {
      const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
      const db = getDatabase();
      const all = db.listSessions();
      let updated = 0;
      let unchanged = 0;
      let matched = 0;
      const details: Array<{ id: string; name: string; from: string | null; to: string }> = [];
      for (const s of all) {
        const name = (s.name ?? '').trim();
        let target: 'work' | null = null;
        if (/^(早上|中午|下午|晚上)和\s?Neox\s?聊聊$/.test(name) || /^Chat\s·\s\w/.test(name)
          || /^工作·\d+月\d+日$/.test(name) || /^Work\s·\s\w/.test(name)) {
          target = 'work';
        }
        if (!target) continue;
        matched++;
        const current = (s as { agentMode?: string | null }).agentMode ?? null;
        if (current === target) { unchanged++; continue; }
        try {
          db.setSessionAgentMode(s.id, target);
          const cached = sessionsCache.get(s.id);
          if (cached) sessionsCache.set(s.id, { ...cached, agentMode: target as Session['agentMode'] });
          updated++;
          if (details.length < 20) details.push({ id: s.id, name, from: current, to: target });
        } catch (e: any) {
          console.warn('[backfill-agent-modes] failed for', s.id, e?.message);
        }
      }
      return { ok: true, total: all.length, matched, updated, unchanged, sampleDetails: details };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('session:set-timeline', async (event, sessionId: string, timeline: SavedTimelineEntry[]) => {
    const session = await getSessionOrThrow(sessionId);
    if (!Array.isArray(timeline)) {
      throw new Error('Invalid timeline format: expected array');
    }
    session.timeline = timeline;
    await sessionStore.setTimeline(sessionId, timeline);
    sessionsCache.set(sessionId, session);
    bridgeOf(event).updateSessionHistory(session.id, session.messages);
  });

  ipcMain.handle('session:clear-timeline', async (_event, sessionId: string) => {
    const session = await getSessionOrThrow(sessionId);
    if (session.timeline && session.timeline.length > 0) {
      session.timeline = undefined;
      sessionsCache.set(sessionId, session);
    }
  });

  ipcMain.handle('session:set-file-checkpoints', async (_event, sessionId: string, rollbackId: string | null, reapplyId: string | null, fileRevertedMap?: Record<string, boolean>, fileConfirmedMap?: Record<string, boolean>) => {
    const session = await getSessionOrThrow(sessionId);
    session.fileRollbackCheckpointId = rollbackId;
    session.fileReapplyCheckpointId = reapplyId;
    if (fileRevertedMap !== undefined) {
      session.fileRevertedMap = fileRevertedMap;
    }
    if (fileConfirmedMap !== undefined) {
      session.fileConfirmedMap = fileConfirmedMap;
    }
    await persistSession(session);
    // File checkpoint IDs persisted for session
  });
}
