export interface RendererAPIOptionalFeatures {
  // ==================== Assistant 配置 ====================
  getAssistantConfig?: () => Promise<any>;
  setAssistantConfig?: (config: any) => Promise<void>;
  getStewardRuntimeSnapshot?: () => Promise<any>;

  // ==================== 记忆浏览 ====================
  memoryBrowse?: (options: { type?: string; query?: string; limit?: number }) => Promise<any[]>;
  memoryClear?: (type: string) => Promise<{ success: boolean; error?: string }>;
  /** 删一条记忆 (按 id, 长期 / 永久 / 会话摘要都行) */
  memoryDelete?: (id: string) => Promise<{ success: boolean; error?: string }>;

  // ==================== 进程管理 ====================
  processList?: () => Promise<any[]>;
  processKill?: (pid: number) => Promise<void>;

  // ==================== 服务治理 (RunConfig + Services panel) ====================
  serviceListConfigs?:  (workspaceRoot: string) => Promise<{ success: boolean; configs: any[]; error?: string }>;
  serviceUpsertConfig?: (workspaceRoot: string, config: any) => Promise<{ success: boolean; config?: any; error?: string }>;
  serviceRemoveConfig?: (workspaceRoot: string, id: string) => Promise<{ success: boolean; error?: string }>;
  serviceBind?:         (pid: number, configId: string) => Promise<{ success: boolean; error?: string }>;
  serviceScanImportable?: (workspaceRoot: string) => Promise<{
    packageJsonScripts: Array<{ name: string; command: string; suggestedId: string }>;
    procfile: Array<{ name: string; command: string; suggestedId: string }>;
  }>;
  serviceStartConfig?: (workspaceRoot: string, configId: string, sessionId?: string) => Promise<{ ok: boolean; pid?: number; reused?: boolean; output?: string; error?: string }>;
  /** 服务历史 (含已退出) — 面板"历史"tab。活跃列表只留 5min, 这里留 24h。 */
  serviceListHistory?: (workspaceRoot: string) => Promise<{
    success: boolean;
    instances: Array<{
      pid: number; startTime: number; command: string; cwd: string;
      status: string; exitCode?: number; endTime?: number; port?: number;
      displayName?: string; configId?: string; logFilePath?: string;
    }>;
    error?: string;
  }>;
  /** 读盘上的历史日志尾部 — 内存 buffer 早没了也能看终端。 */
  serviceReadLog?: (pid: number, startTimeMs?: number) => Promise<{ success: boolean; output: string; error?: string }>;

  // ==================== UI 状态持久化 (SQLite app_state) ====================
  uiStateGetLastSession?: (workspaceRoot: string) => Promise<{ success: boolean; id: string | null; error?: string }>;
  uiStateSetLastSession?: (workspaceRoot: string, id: string | null) => Promise<{ success: boolean; error?: string }>;
  uiStateGetSurfaces?: (sessionId: string) => Promise<{ success: boolean; state: { surfaces: any[]; activeId?: string } | null; error?: string }>;
  uiStateSetSurfaces?: (sessionId: string, state: { surfaces: any[]; activeId?: string } | null) => Promise<{ success: boolean; error?: string }>;
  uiStateGet?: (key: string) => Promise<{ success: boolean; value: string | null; error?: string }>;
  uiStateSet?: (key: string, value: string | null) => Promise<{ success: boolean; error?: string }>;
  /** autoOpenSurface 事件订阅 — 返 unsubscribe fn. */
  onServicesAutoOpen?:  (callback: (detail: { kind: string; source: any; title?: string; pinned?: boolean }) => void) => () => void;

  // ==================== 多窗口 ====================
  openWindowWithWorkspace?: (workspacePath: string) => Promise<{ success: boolean; error?: string }>;
  focusWorkspaceWindow?: (workspacePath: string) => Promise<boolean>;

  // ==================== 定价配置 ====================
  pricingGetAll?: () => Promise<any[]>;
  pricingUpsert?: (entry: any) => Promise<void>;
  pricingDelete?: (id: string) => Promise<void>;

  // ==================== TTS 语音管理 ====================
  ttsGetConfig?: () => Promise<{
    enabled: boolean;
    provider: 'edge' | 'neoxcloud' | 'openai' | 'custom';
    voice: string;
    speed: number;
    format: string;
    autoSummarize: boolean;
    maxSummaryChars: number;
    apiUrl: string;
    apiKey: string;
  }>;
  ttsSetConfig?: (updates: {
    enabled?: boolean;
    provider?: 'edge' | 'neoxcloud' | 'openai' | 'custom';
    voice?: string;
    model?: string;
    speed?: number;
    format?: 'mp3' | 'opus' | 'pcm';
    autoSummarize?: boolean;
    maxSummaryChars?: number;
    apiUrl?: string;
    apiKey?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  ttsSetEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

  // ==================== STT 语音识别 (输入框语音按钮) ====================
  /** base64 音频 (默认 wav) → 网关 ASR → 文本 (一次性). */
  sttTranscribe?: (audioBase64: string, format?: string) => Promise<{ success: boolean; text?: string; error?: string }>;
  /** 流式 STT (边说边出字): 开流, 返回 streamId. */
  sttStreamStart?: (model?: string) => Promise<{ ok: boolean; streamId?: string; error?: string }>;
  /** 流式 STT: 推一块 16k mono PCM (Int16). */
  sttStreamAudio?: (streamId: string, chunk: ArrayBuffer | Uint8Array) => void;
  /** 流式 STT: 结束本次识别. */
  sttStreamStop?: (streamId: string) => Promise<{ ok: boolean }>;
  /** 流式 STT: 订阅转写事件. 返回取消订阅函数. */
  onSttStreamEvent?: (
    callback: (data: { streamId: string; type: string; text?: string; isFinal?: boolean; message?: string }) => void,
  ) => () => void;

  // ==================== 实验性功能 ====================
  experimentalGetConfig?: () => Promise<{
    enableFGTS: boolean;
    enablePTC: boolean;
    enableCheckpoint: boolean;
    jevEnabled?: boolean;
    /** 已存 key 的末 4 位 (…abcd); 没 key 为空串。明文不回传。 */
    jevKeyHint?: string;
  }>;
  experimentalSetConfig?: (updates: {
    enableFGTS?: boolean;
    enablePTC?: boolean;
    enableCheckpoint?: boolean;
    jevEnabled?: boolean;
    /** 明文; 空串 = 清除 */
    jevApiKey?: string;
  }) => Promise<{ success: boolean; needsRestart?: boolean; error?: string }>;
  /** Jev 草稿预判 (输入框停顿时调); 没开 Jev 时主进程侧直接跳过 */
  jevPrefetch?: (text: string) => Promise<void>;
  /** 真发一道题测连通; 不传 key 用已存的 */
  experimentalJevTest?: (apiKey?: string) => Promise<
    | { success: true; ms: number; model: string; ok: boolean }
    | { success: false; error: string; status?: number }
  >;

  // ==================== Supervisor 配置 ====================
  supervisorGetConfig?: () => Promise<{
    enabled: boolean;
    collaborationMode: boolean;
    language: string;
    model: string;
    providerId: string;
  }>;
  supervisorSetConfig?: (updates: {
    enabled?: boolean;
    collaborationMode?: boolean;
    language?: 'zh' | 'en';
    model?: string;
    providerId?: string;
  }) => Promise<{ success: boolean; error?: string }>;

  // ==================== RunConfig (运行配置) ====================
  runconfigGet?: () => Promise<{
    runMode: string;
    modes: Record<string, any>;
  }>;
  runconfigSetModeConfig?: (mode: string, config: any) => Promise<{ success: boolean; error?: string }>;
  getOrganizationConfigStatus?: () => Promise<{
    exists: boolean;
    configPath: string;
    name?: string;
    departments: number;
    members: number;
  }>;
  createOrganizationDefaultConfig?: () => Promise<{
    success: boolean;
    created?: boolean;
    status?: {
      exists: boolean;
      configPath: string;
      name?: string;
      departments: number;
      members: number;
    };
    error?: string;
  }>;

  // ==================== 索引配置 ====================
  indexGetConfig?: () => Promise<{ excludePatterns?: string[] }>;
  indexSetConfig?: (config: { excludePatterns?: string[] }) => Promise<{ success: boolean; error?: string }>;

  // ==================== 通知音效 ====================
  listAvailableSounds?: () => Promise<Array<{ id: string; name: string; path: string; type: 'system' | 'custom' }>>;
  playSound?: (soundId: string) => Promise<void>;

  // ==================== Model Profile 查看 ====================
  modelProfileGetCurrent?: () => Promise<{
    profileId: string;
    model: string;
    providerId: string;
    protocol: string;
    sourceProfileIds: string[];
    prompt: any;
    completion: any;
    transport: any;
    behavior: any;
    toolset: any;
    reasoning: any;
    are: any;
  } | null>;
  modelProfileGetAll?: () => Promise<Array<{
    providerId: string;
    providerName: string;
    model: string;
    profileId: string;
    isDefault: boolean;
    sourceProfileIds: string[];
    disabledTools: string[];
    builtinDisabledTools?: string[];
    modelOverrideDisabledTools?: string[] | null;
    profileOverrideDisabledTools?: string[] | null;
    maxTokens?: number;
  }>>;
  modelProfileListTools?: () => Promise<Array<{ name: string; description: string }>>;
  modelProfileGetTaskAgentMap?: () => Promise<{
    success: boolean; map?: Record<string, { providerId: string; model: string }>; error?: string;
  }>;
  modelProfileSetTaskAgentForModel?: (params: { mainModel: string; providerId?: string; model?: string }) => Promise<{
    success: boolean; map?: Record<string, { providerId: string; model: string }>; error?: string;
  }>;
  modelProfileResolve?: (params: { model: string; providerId?: string }) => Promise<{
    success: boolean;
    profileId?: string;
    sourceProfileIds?: string[];
    effective?: Record<string, any>;
    builtin?: Record<string, any>;
    overrides?: Record<string, unknown>;
    error?: string;
  }>;
  modelProfileSetFieldOverride?: (params: { model: string; path: string; value: unknown }) =>
    Promise<{ success: boolean; overrides?: Record<string, unknown>; error?: string }>;
  modelProfileGetFieldOverrides?: (params: { model: string }) =>
    Promise<{ success: boolean; overrides?: Record<string, unknown>; error?: string }>;
  modelProfileGetToolsetOverride?: (params: {
    model: string;
    profileId?: string;
    builtinDisabledTools?: string[];
  }) => Promise<{
    success: boolean;
    modelKey?: string;
    source?: 'model' | 'profile' | 'builtin';
    modelDisabledTools?: string[] | null;
    profileDisabledTools?: string[] | null;
    effectiveDisabledTools?: string[];
    error?: string;
  }>;
  modelProfileSetToolsetOverride?: (params: {
    model: string;
    disabledTools: string[];
  }) => Promise<{
    success: boolean;
    modelKey?: string;
    disabledTools?: string[];
    error?: string;
  }>;

  // ==================== Editor AI ====================
  aiInlineComplete?: (request: {
    prefix: string;
    suffix: string;
    language: string;
    explicit?: boolean;
    maxCandidates?: number;
  }) => Promise<{ insertText: string; items: string[]; error?: string }>;
  aiRankCompletions?: (request: {
    language: string;
    prefix: string;
    beforeCursor: string;
    afterCursor: string;
    candidates: string[];
    explicit?: boolean;
  }) => Promise<{ orderedLabels: string[] }>;
  aiInlineEdit?: (request: {
    requestId: string;
    selectedCode: string;
    instruction: string;
    language: string;
    filePath?: string;
    prefix?: string;
    suffix?: string;
  }) => Promise<void>;
  onInlineEditChunk?: (callback: (payload: { requestId: string; text: string }) => void) => () => void;
  onInlineEditDone?: (callback: (payload: { requestId: string; text: string }) => void) => () => void;
  onInlineEditError?: (callback: (payload: { requestId: string; message: string }) => void) => () => void;
  onInlineEditAborted?: (callback: (payload: { requestId: string }) => void) => () => void;
  aiInlineEditAbort?: (requestId: string) => Promise<{ aborted: boolean }>;
  aiGetInlineCompleteConfig?: () => Promise<{
    enabled: boolean;
    providerId?: string;
    model?: string;
    effective?: { providerId: string; model: string; source: 'override' | 'auto'; isFast: boolean };
  }>;
  aiSetInlineCompleteConfig?: (updates: {
    enabled?: boolean;
    providerId?: string | null;
    model?: string | null;
  }) => Promise<{ enabled: boolean; providerId?: string; model?: string }>;
  modelProfileClearToolsetOverride?: (params: {
    model: string;
  }) => Promise<{
    success: boolean;
    modelKey?: string;
    error?: string;
  }>;

  // ==================== 版本更新 ====================
  updateCheck?: () => Promise<{
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    releaseNotes?: string;
    downloadUrl?: string;
    downloadUrlMirror?: string;
    publishedAt?: string;
    source?: string;
    error?: string;
  }>;
  updateDownload?: (url?: string) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
    /** 用户中途按了暂停 —— 不是失败, 半成品还在盘上等着续 */
    paused?: boolean;
    source?: 'electron-updater' | 'manual-download' | 'mac-self-update';
  }>;
  updateInstall?: (filePath?: string) => Promise<{
    success: boolean;
    message: string;
    error?: string;
  }>;
  /* 开页即知道"有没有下好等着装的包" —— preload 一直暴露着 (update:staged-status),
   * 只是这份类型没跟上, 于是 AboutTab 里那两处调用一直是 TS 报错 + 只能靠 `?.` 兜着。 */
  updateStagedStatus?: () => Promise<{ ready: boolean; version?: string }>;
  /** 暂停 / 继续 / 取消 / 查断点 —— 只有 mac 自研 updater 支持, 别处回 supported:false */
  updateDownloadControl?: (action: 'pause' | 'resume' | 'cancel' | 'state') => Promise<{
    supported: boolean;
    ok?: boolean;
    /** resume 一路下完了 */
    done?: boolean;
    /** resume 途中又被暂停了 */
    paused?: boolean;
    filePath?: string;
    error?: string;
    state?: { active: boolean; paused: boolean; version: string; transferred: number; total: number } | null;
  }>;
  updateOpenReleases?: () => Promise<{ success: boolean }>;
  onUpdateProgress?: (callback: (progress: {
    percent: number;
    transferred: number;
    total: number;
    speed: number;
    /** 这一拍是"停下了"而不是"卡住了" */
    paused?: boolean;
  }) => void) => () => void;
}
