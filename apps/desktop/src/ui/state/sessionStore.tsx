import React, { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from 'react';
import type {
  Session,
  ChatMessage,
  Attachment,
  ModelInfo,
  InteractionMode,
} from '../shared/ipc';
import { DEFAULT_MODELS } from '../shared/ipc';
import { sameWorkspace } from '../renderer/utils/pathUtils';

interface SessionState {
  sessions: Session[];
  activeSession: Session | null;
  messages: ChatMessage[];
  input: string;
  status: string;
  streaming: boolean;
  availableModels: ModelInfo[];
  selectedModel: ModelInfo;
  totalTokens: number;
  contextUsed: number;
  mode: InteractionMode;
  attachments: Attachment[];
}

const initialState: SessionState = {
  sessions: [],
  activeSession: null,
  messages: [],
  input: '',
  status: 'Ready',
  streaming: false,
  availableModels: DEFAULT_MODELS,
  selectedModel: DEFAULT_MODELS[0],
  totalTokens: 0,
  contextUsed: 0,
  mode: 'agent',
  attachments: [],
};

export enum SessionActionType {
  SET_SESSIONS,
  SET_ACTIVE_SESSION,
  PATCH_ACTIVE_SESSION,
  SET_MESSAGES,
  SET_INPUT,
  SET_STATUS,
  SET_STREAMING,
  SET_MODELS,
  SET_SELECTED_MODEL,
  SET_TOTAL_TOKENS,
  SET_CONTEXT_USED,
  SET_MODE,
  SET_SESSION_AGENT_MODE,
  SET_ATTACHMENTS,
  /* RESET_ALL — 切账户 / logout 时把整个 store 拍回 initialState.
   * 国内共享电脑场景: 防 B 登录瞬间看到 A 残留的会话列表 / 消息 / streaming 状态. */
  RESET_ALL,
}

type SessionAction =
  | { type: SessionActionType.SET_SESSIONS; payload: Session[] | ((prev: Session[]) => Session[]) }
  | { type: SessionActionType.SET_ACTIVE_SESSION; payload: Session | null }
  | { type: SessionActionType.PATCH_ACTIVE_SESSION; payload: { id: string; patch: Partial<Session> } }
  | { type: SessionActionType.SET_MESSAGES; payload: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]) }
  | { type: SessionActionType.SET_INPUT; payload: string }
  | { type: SessionActionType.SET_STATUS; payload: string }
  | { type: SessionActionType.SET_STREAMING; payload: boolean }
  | { type: SessionActionType.SET_MODELS; payload: ModelInfo[] }
  | { type: SessionActionType.SET_SELECTED_MODEL; payload: ModelInfo | ((prev: ModelInfo) => ModelInfo) }
  | { type: SessionActionType.SET_TOTAL_TOKENS; payload: number | ((prev: number) => number) }
  | { type: SessionActionType.SET_CONTEXT_USED; payload: number }
  | { type: SessionActionType.SET_MODE; payload: InteractionMode }
  | { type: SessionActionType.SET_SESSION_AGENT_MODE; payload: { sessionId: string; agentMode: 'work' | 'code'; workspacePath?: string } }
  | { type: SessionActionType.SET_ATTACHMENTS; payload: Attachment[] | ((prev: Attachment[]) => Attachment[]) }
  | { type: SessionActionType.RESET_ALL };

export const sessionReducer = (state: SessionState, action: SessionAction): SessionState => {
  switch (action.type) {
    case SessionActionType.SET_SESSIONS: {
      const next = typeof action.payload === 'function' ? action.payload(state.sessions) : action.payload;
      if (next === state.sessions) return state;
      return { ...state, sessions: next };
    }
    case SessionActionType.SET_ACTIVE_SESSION:
      if (action.payload === state.activeSession) return state;
      return { ...state, activeSession: action.payload };
    case SessionActionType.PATCH_ACTIVE_SESSION: {
      const cur = state.activeSession;
      if (!cur || cur.id !== action.payload.id) return state;
      const patch = action.payload.patch as Record<string, unknown>;
      if (Object.keys(patch).every((k) => Object.is(patch[k], (cur as unknown as Record<string, unknown>)[k]))) return state;
      return { ...state, activeSession: { ...cur, ...action.payload.patch, id: cur.id } };
    }
    case SessionActionType.SET_MESSAGES: {
      const next = typeof action.payload === 'function' ? action.payload(state.messages) : action.payload;
      if (next === state.messages) return state;
      return { ...state, messages: next };
    }
    case SessionActionType.SET_INPUT:
      if (action.payload === state.input) return state;
      return { ...state, input: action.payload };
    case SessionActionType.SET_STATUS:
      if (action.payload === state.status) return state;
      return { ...state, status: action.payload };
    case SessionActionType.SET_STREAMING:
      if (action.payload === state.streaming) return state;
      return { ...state, streaming: action.payload };
    case SessionActionType.SET_MODELS:
      if (action.payload === state.availableModels) return state;
      return { ...state, availableModels: action.payload };
    case SessionActionType.SET_SELECTED_MODEL: {
      const next = typeof action.payload === 'function' ? action.payload(state.selectedModel) : action.payload;
      if (next === state.selectedModel) return state;
      return { ...state, selectedModel: next };
    }
    case SessionActionType.SET_TOTAL_TOKENS: {
      const next = typeof action.payload === 'function' ? action.payload(state.totalTokens) : action.payload;
      if (Object.is(next, state.totalTokens)) return state;
      return { ...state, totalTokens: next };
    }
    case SessionActionType.SET_CONTEXT_USED: {
      const nextContextUsed = action.payload;
      const activeId = state.activeSession?.id;
      const nextActiveSession =
        state.activeSession && state.activeSession.contextUsed !== nextContextUsed
          ? { ...state.activeSession, contextUsed: nextContextUsed }
          : state.activeSession;
      let sessionsChanged = false;
      const nextSessions = activeId
        ? state.sessions.map((session) => {
            if (session.id !== activeId || session.contextUsed === nextContextUsed) return session;
            sessionsChanged = true;
            return { ...session, contextUsed: nextContextUsed };
          })
        : state.sessions;
      if (
        state.contextUsed === nextContextUsed &&
        nextActiveSession === state.activeSession &&
        !sessionsChanged
      ) {
        return state;
      }
      return {
        ...state,
        contextUsed: nextContextUsed,
        activeSession: nextActiveSession,
        sessions: sessionsChanged ? nextSessions : state.sessions,
      };
    }
    case SessionActionType.SET_MODE:
      if (action.payload === state.mode) return state;
      return { ...state, mode: action.payload };
    case SessionActionType.SET_SESSION_AGENT_MODE: {
      /* workspacePath: 切到 Life/Work 时主进程已把会话改绑到 mode home, 这里跟着更新 ——
       * 必须和 agentMode 同一次 dispatch 落, 否则 sendPrompt / 侧栏分组会在中间那一帧
       * 拿到"新模式 + 旧工作区"的错配态, 产物就写回旧的 code 项目根了. */
      const { sessionId, agentMode, workspacePath } = action.payload;
      const patch = workspacePath ? { agentMode, workspacePath } : { agentMode };
      const isStale = (session: Session) =>
        session.agentMode !== agentMode || (!!workspacePath && !sameWorkspace(session.workspacePath, workspacePath));
      let sessionsChanged = false;
      const nextSessions = state.sessions.map((session) => {
        if (session.id !== sessionId || !isStale(session)) return session;
        sessionsChanged = true;
        return { ...session, ...patch };
      });
      const nextActiveSession =
        state.activeSession?.id === sessionId && isStale(state.activeSession)
          ? { ...state.activeSession, ...patch }
          : state.activeSession;
      if (!sessionsChanged && nextActiveSession === state.activeSession) return state;
      return {
        ...state,
        sessions: sessionsChanged ? nextSessions : state.sessions,
        activeSession: nextActiveSession,
      };
    }
    case SessionActionType.SET_ATTACHMENTS: {
      const next = typeof action.payload === 'function' ? action.payload(state.attachments) : action.payload;
      if (next === state.attachments) return state;
      return { ...state, attachments: next };
    }
    case SessionActionType.RESET_ALL:
      if (state === initialState) return state;
      return initialState;
    default:
      return state;
  }
};

type SessionStoreValue = {
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
};

const globalSessionStoreContext = globalThis as typeof globalThis & {
  __NEOX_SESSION_STORE_CONTEXT__?: React.Context<SessionStoreValue | null>;
  __NEOX_SESSION_DISPATCH_CONTEXT__?: React.Context<React.Dispatch<SessionAction> | null>;
  __NEOX_SESSION_ACTIVE_CONTEXT__?: React.Context<Session | null | undefined>;
};

const SessionStoreContext =
  globalSessionStoreContext.__NEOX_SESSION_STORE_CONTEXT__ ??
  (globalSessionStoreContext.__NEOX_SESSION_STORE_CONTEXT__ = createContext<SessionStoreValue | null>(null));

const SessionDispatchContext =
  globalSessionStoreContext.__NEOX_SESSION_DISPATCH_CONTEXT__ ??
  (globalSessionStoreContext.__NEOX_SESSION_DISPATCH_CONTEXT__ = createContext<React.Dispatch<SessionAction> | null>(null));

/** undefined = 不在 provider 内 (区别于"在 provider 内但没有活跃会话"的 null) */
const SessionActiveContext =
  globalSessionStoreContext.__NEOX_SESSION_ACTIVE_CONTEXT__ ??
  (globalSessionStoreContext.__NEOX_SESSION_ACTIVE_CONTEXT__ = createContext<Session | null | undefined>(undefined));

export const SessionStoreProvider = ({ children }: { children: ReactNode }) => {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);

  return (
    <SessionDispatchContext.Provider value={dispatch}>
      <SessionActiveContext.Provider value={state.activeSession}>
        <SessionStoreContext.Provider value={value}>{children}</SessionStoreContext.Provider>
      </SessionActiveContext.Provider>
    </SessionDispatchContext.Provider>
  );
};

export const useSessionStore = () => {
  const context = useContext(SessionStoreContext);
  if (!context) {
    throw new Error('useSessionStore must be used within a SessionStoreProvider');
  }
  return context;
};

/** 给 provider 之外也可能挂载的 hook 用: 无 provider 时读到 null 而不 throw. */
export const getSessionStoreContext = () => SessionStoreContext;

/** 只订阅活跃会话 (不随 messages / sessions 等变化重渲染)。无 provider 时读到 undefined。 */
export const getSessionActiveContext = () => SessionActiveContext;

export const useStoreActiveSession = (): Session | null => {
  const active = useContext(SessionActiveContext);
  if (active === undefined) {
    throw new Error('useStoreActiveSession must be used within a SessionStoreProvider');
  }
  return active;
};

export const useSessionActions = () => {
  /* 只读 dispatch context: 拿 action 的组件 (NeoxShellHost 整个外壳) 不再随 state 任何变化重渲染 */
  const dispatch = useContext(SessionDispatchContext);
  if (!dispatch) {
    throw new Error('useSessionActions must be used within a SessionStoreProvider');
  }

  const setSessions = useCallback((sessions: Session[] | ((prev: Session[]) => Session[])) => {
    dispatch({ type: SessionActionType.SET_SESSIONS, payload: sessions });
  }, [dispatch]);

  const setActiveSession = useCallback((session: Session | null) => {
    if ((session as { agentMode?: string } | null)?.agentMode === 'pilot') {
      try {
        (window as any).neox?.logInfo?.('MODE', `activate pilot ${session!.id.slice(0, 22)}: ${(new Error().stack ?? '').split('\n').slice(2, 8).map((l) => l.trim()).join(' | ')}`);
      } catch { /* 留痕不许影响切换 */ }
    }
    dispatch({ type: SessionActionType.SET_ACTIVE_SESSION, payload: session });
  }, [dispatch]);

  /** 只改当前会话的字段; 这期间已切到别的会话就不动 (见 PATCH_ACTIVE_SESSION)。 */
  const patchActiveSession = useCallback((id: string, patch: Partial<Session>) => {
    dispatch({ type: SessionActionType.PATCH_ACTIVE_SESSION, payload: { id, patch } });
  }, [dispatch]);

  const setMessages = useCallback((messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    dispatch({ type: SessionActionType.SET_MESSAGES, payload: messages });
  }, [dispatch]);

  const setInput = useCallback((input: string) => {
    dispatch({ type: SessionActionType.SET_INPUT, payload: input });
  }, [dispatch]);

  const setStatus = useCallback((status: string) => {
    dispatch({ type: SessionActionType.SET_STATUS, payload: status });
  }, [dispatch]);

  const setStreaming = useCallback((value: boolean) => {
    dispatch({ type: SessionActionType.SET_STREAMING, payload: value });
  }, [dispatch]);

  const setAvailableModels = useCallback((models: ModelInfo[]) => {
    dispatch({ type: SessionActionType.SET_MODELS, payload: models });
  }, [dispatch]);

  const setSelectedModel = useCallback((model: ModelInfo | ((prev: ModelInfo) => ModelInfo)) => {
    dispatch({ type: SessionActionType.SET_SELECTED_MODEL, payload: model });
  }, [dispatch]);

  const setTotalTokens = useCallback((tokens: number | ((prev: number) => number)) => {
    dispatch({ type: SessionActionType.SET_TOTAL_TOKENS, payload: tokens });
  }, [dispatch]);

  const setContextUsed = useCallback((value: number) => {
    dispatch({ type: SessionActionType.SET_CONTEXT_USED, payload: value });
  }, [dispatch]);

  const setMode = useCallback((mode: InteractionMode) => {
    dispatch({ type: SessionActionType.SET_MODE, payload: mode });
  }, [dispatch]);

  const setSessionAgentMode = useCallback((
    sessionId: string,
    agentMode: 'work' | 'code',
    workspacePath?: string,
  ) => {
    dispatch({ type: SessionActionType.SET_SESSION_AGENT_MODE, payload: { sessionId, agentMode, workspacePath } });
  }, [dispatch]);

  const setAttachments = useCallback((attachments: Attachment[] | ((prev: Attachment[]) => Attachment[])) => {
    dispatch({ type: SessionActionType.SET_ATTACHMENTS, payload: attachments });
  }, [dispatch]);

  /** 切账户 / logout 时调 — 把整个 session store 拍回 initialState. */
  const resetAll = useCallback(() => {
    dispatch({ type: SessionActionType.RESET_ALL });
  }, [dispatch]);

  return {
    setSessions,
    setActiveSession,
    patchActiveSession,
    setMessages,
    setInput,
    setStatus,
    setStreaming,
    setAvailableModels,
    setSelectedModel,
    setTotalTokens,
    setContextUsed,
    setMode,
    setSessionAgentMode,
    setAttachments,
    resetAll,
  };
};

export const useSessionState = () => {
  const { state } = useSessionStore();
  return state;
};
