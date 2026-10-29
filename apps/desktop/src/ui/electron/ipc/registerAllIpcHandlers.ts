import type { Session } from '../../shared/ipc.js';
import { ipcMain } from 'electron';
import { registerUIIpcHandlers } from './uiHandlers.js';
import { registerUIReadHandlers } from './uiReadHandlers.js';
import { registerHealthIpcHandlers } from './healthHandlers.js';
import { registerRoutingIpcHandlers } from './routingHandlers.js';
import { registerWorkspaceIpcHandlers } from './workspaceHandlers.js';
import { registerChatSessionIpcHandlers } from './chatSessionHandlers.js';
import { registerServerStatusIpcHandlers } from './serverStatusHandlers.js';
import { registerSessionCheckpointTimelineIpcHandlers } from './sessionCheckpointTimelineHandlers.js';
import { registerRuntimeIpcHandlers } from './runtimeHandlers.js';
import { registerConfigGeneralIpcHandlers } from './configGeneralHandlers.js';
import { registerRunModePricingIpcHandlers } from './runModePricingHandlers.js';
import { registerAssistantConfigIpcHandlers } from './assistantConfigHandlers.js';
import { registerAssistantTeamIpcHandlers } from './assistantTeamHandlers.js';
import { registerSoundJavaIpcHandlers } from './soundJavaHandlers.js';
import { registerProviderModelIpcHandlers } from './providerModelHandlers.js';
import { registerModelStorageUsageIpcHandlers } from './modelStorageUsageHandlers.js';
import { registerShareCardHandlers } from './shareCardHandlers.js';
import { registerBackupIpcHandlers } from './backupHandlers.js';
import { registerTimelineIpcHandlers } from './timelineHandlers.js';
import { registerFileEditIpcHandlers } from './fileEditHandlers.js';
import { registerFileOpsIpcHandlers } from './fileOpsHandlers.js';
import { registerExplorerSettingsIpcHandlers } from './explorerSettingsHandlers.js';
import { registerKeymapSettingsIpcHandlers } from './keymapSettingsHandlers.js';
import { registerUiStateIpcHandlers } from './uiStateHandlers.js';
import { registerCheckpointIpcHandlers } from './checkpointHandlers.js';
import { registerProviderIpcHandlers } from './providerHandlers.js';
import { registerImageDirectIpcHandlers } from './imageDirectHandlers.js';
import { wireImageGenForDesktop } from '../services/imageGenWiring.js';
import { registerTerminalIpcHandlers } from './terminalHandlers.js';
import { configureTerminalRequestBridge, registerTerminalRequestIpcHandlers } from './terminalRequestBridge.js';
import { configureDiagnosticsRequestBridge, registerDiagnosticsRequestIpcHandlers } from './diagnosticsRequestBridge.js';
import { registerDebugIpcHandlers } from './debugHandlers.js';
import { registerDebugSessionIpcHandlers } from './debugSessionHandlers.js';
import { registerProcessIpcHandlers } from './processHandlers.js';
import { registerAgentStatusIpcHandlers } from './agentStatusHandlers.js';
import { registerFileSystemIpcHandlers } from './fileSystemHandlers.js';
import { registerWorkspaceWatcherIpcHandlers } from './workspaceWatcherHandlers.js';
import { registerLargeFileIpcHandlers } from './largeFileHandlers.js';
import { registerMcpIpcHandlers } from './mcpHandlers.js';
import { registerSkillsIpcHandlers } from './skillsHandlers.js';
import { registerMigrateIpcHandlers } from './migrateHandlers.js';
import { registerIndexIpcHandlers } from './indexHandlers.js';
import { registerMemoryIpcHandlers } from './memoryHandlers.js';
import { registerKnowledgeIpcHandlers } from './knowledgeHandlers.js';
import { registerEmbeddedBrowserIpcHandlers } from './embeddedBrowserHandlers.js';
import { registerLinkPreviewIpcHandlers } from './linkPreviewHandlers.js';
import { registerFeatureConfigIpcHandlers } from './featureConfigHandlers.js';
import { registerWorkProjectIpcHandlers } from './workProjectHandlers.js';
import { registerLifeEventsIpcHandlers } from './lifeEventsHandlers.js';
import { bootReminderJobRunner, debugFlushDueReminders } from '../services/reminderJobRunner.js';
import { registerSttStreamIpc } from '../services/sttStreamManager.js';
import { registerWakeWordIpc } from '../services/wakeWordService.js';
import { registerContextIpcHandlers } from './contextHandlers.js';
import { registerOutputStyleIpcHandlers } from './outputStyleHandlers.js';
import { registerDiagnosticsIpcHandlers } from './diagnosticsHandlers.js';
import { registerShareIpcHandlers } from './shareHandlers.js';
/* registerRemoteIpcHandlers 删除 — 老 v1 remote 占位的 IPC, 替换为 mobile-bridge
 * (registerMobileBridgeIpcHandlers, 末尾注册). */
import { registerModelProfileIpcHandlers } from './modelProfileHandlers.js';
import { registerUpdateIpcHandlers } from './updateHandlers.js';
import { registerGraphIpcHandlers } from './graphHandlers.js';
import { registerTaskBoardIpcHandlers } from './taskboardHandlers.js';
import { registerRateLimitIpcHandlers } from './rateLimitHandlers.js';
import { registerPluginIpcHandlers, bootstrapDesktopPlugins } from './pluginHandlers.js';
import { registerPluginHostIpcHandlers } from './pluginHostHandlers.js';
import { registerSemanticIpcHandlers } from './semanticHandlers.js';
import { registerGitIpcHandlers } from './gitHandlers.js';
import { registerAiIpcHandlers } from './aiHandlers.js';
import { registerEmbeddingIpcHandlers } from './embeddingHandlers.js';
import { registerProjectStartupIpcHandlers } from './projectStartupHandlers.js';
import { registerRunConfigIpcHandlers } from './runConfigIpcHandlers.js';
import { registerWriteIntentIpcHandlers } from './writeIntentHandlers.js';
import { registerAuthIpcHandlers } from './authHandlers.js';
import { registerNeoxRoutingIpcHandlers } from './neoxRoutingHandlers.js';
import { registerGatewayKeyIpcHandlers } from './gatewayKeyHandlers.js';
import { registerDocumentCacheIpcHandlers } from './documentCacheHandlers.js';
import { registerMobileBridgeIpcHandlers } from '../mobile-bridge/ipcHandlers.js';
import { registerMainEdition, registerMainEditionIpc } from '../mainEdition.js';
import { installNeoxRouting } from '../services/neoxRoutingService.js';
import type { ProjectManager } from '../context/ProjectManager.js';

interface RegisterAllIpcHandlersOptions {
  isDev: boolean;
  appVersion: string;
  /** Per-project 服务查找. 从 IPC event?.sender 反查 ProjectScope. */
  projectManager: ProjectManager;
  consumeCachedUIState: () => Promise<Awaited<ReturnType<typeof import('../../../platform-electron/storageService.js').storageService.loadUIState>>>;
  getSessionOrThrow: (sessionId: string) => Promise<Session>;
  getSqliteSession: (sessionId: string) => any;
  refreshSession: (sessionId: string) => Promise<Session>;
  persistSession: (session: Session) => Promise<Session>;
  sessionStore: any;
  sessionsCache: Map<string, Session>;
}

export function registerAllIpcHandlers(options: RegisterAllIpcHandlersOptions): void {
  const {
    isDev,
    appVersion,
    projectManager,
    consumeCachedUIState,
    getSessionOrThrow,
    getSqliteSession,
    refreshSession,
    persistSession,
    sessionStore,
    sessionsCache,
  } = options;

  /* 发行版实现先接上共享代码的口子 (远端会话 / 插件市场来源), 见 ../mainEdition.ts */
  registerMainEdition();

  registerUIIpcHandlers({
    isDev,
    appVersion,
    projectManager,
    consumeCachedUIState,
  });
  /* UI 只读那两条走通用 IPC 桥 —— renderer 启动第一步就要调, 极简版也必须有。 */
  registerUIReadHandlers({ consumeCachedUIState });

  registerHealthIpcHandlers();
  registerRoutingIpcHandlers();
  registerWorkspaceIpcHandlers({ projectManager });

  registerChatSessionIpcHandlers({
    projectManager,
    getSessionOrThrow,
    sessionStore,
    sessionsCache,
  });

  registerServerStatusIpcHandlers({ projectManager });

  registerSessionCheckpointTimelineIpcHandlers({
    projectManager,
    getSessionOrThrow,
    getSqliteSession,
    refreshSession,
    persistSession,
    sessionStore,
    sessionsCache,
  });

  registerRuntimeIpcHandlers({ projectManager });
  registerConfigGeneralIpcHandlers({ projectManager });
  registerRunModePricingIpcHandlers({ projectManager });
  registerAssistantConfigIpcHandlers();
  registerAssistantTeamIpcHandlers({ projectManager });
  registerSoundJavaIpcHandlers();
  registerProviderModelIpcHandlers();
  registerModelStorageUsageIpcHandlers({ projectManager });
  registerShareCardHandlers();
  // 一键备份 (~/.neox + 会话 SQLite → zip), 见 backupHandlers 头注释
  registerBackupIpcHandlers();
  // SQLite 单真源 timeline 行级 IPC (upsert/page/delete/count/迁移水位), 见 timelineHandlers 头注释
  registerTimelineIpcHandlers();
  registerFileEditIpcHandlers({ projectManager });
  registerDocumentCacheIpcHandlers();
  registerFileOpsIpcHandlers({ projectManager });
  registerExplorerSettingsIpcHandlers();
  registerKeymapSettingsIpcHandlers();
  registerUiStateIpcHandlers();
  registerCheckpointIpcHandlers({ projectManager });
  registerProviderIpcHandlers();
  wireImageGenForDesktop();
  registerImageDirectIpcHandlers();
  registerAuthIpcHandlers();
  registerNeoxRoutingIpcHandlers();
  registerGatewayKeyIpcHandlers();
  registerSttStreamIpc();
  registerWakeWordIpc();
  /* 把 Neox routing resolver 注册进 neox-core 的 providerResolver 钩子 —
   *   做完之后, neox-cloud / neox-managed provider 透明走 Neox 网关,
   *   其他 provider 保持 BYOK 直连. */
  installNeoxRouting();

  registerTerminalIpcHandlers({ projectManager });
  configureTerminalRequestBridge({ projectManager });
  registerTerminalRequestIpcHandlers();
  configureDiagnosticsRequestBridge({
    getWindow: () => projectManager.getFocused()?.window ?? null,
  });
  registerDiagnosticsRequestIpcHandlers();
  registerDebugIpcHandlers({ projectManager });
  // 新: 真实的 DebugSession 生命周期 (DebuggerManager + JvmDapBackend)
  registerDebugSessionIpcHandlers({ projectManager });

  registerProcessIpcHandlers({ projectManager });
  registerAgentStatusIpcHandlers();
  registerFileSystemIpcHandlers({ projectManager });
  registerWorkspaceWatcherIpcHandlers();
  registerLargeFileIpcHandlers();
  registerMcpIpcHandlers({ projectManager });
  registerSkillsIpcHandlers({ projectManager });
  registerMigrateIpcHandlers({ projectManager });
  registerIndexIpcHandlers({ projectManager });
  registerMemoryIpcHandlers({ projectManager });
  registerKnowledgeIpcHandlers({ projectManager });
  registerEmbeddedBrowserIpcHandlers({ projectManager });
  registerLinkPreviewIpcHandlers();
  registerFeatureConfigIpcHandlers({ projectManager });
  registerWorkProjectIpcHandlers();
  registerLifeEventsIpcHandlers();
  /* Life · ReminderJobRunner 单例 — 30s tick + Notification + recurrence 循环.
   * 幂等, 重复 boot 无副作用. */
  try { bootReminderJobRunner(); }
  catch (err: any) { console.warn('[registerAll] bootReminderJobRunner failed:', err?.message); }
  /* 调试用 IPC: renderer 可 window.neox.lifeEvents.debugFlushDueReminders() 立刻扫一次 due */
  try {
    ipcMain.handle('life-reminder:debug-flush', () => {
      try { return debugFlushDueReminders(); }
      catch (e: any) { return { error: e?.message || String(e) }; }
    });
  } catch { /* ignore */ }
  registerContextIpcHandlers({ projectManager, sessionsCache });
  registerOutputStyleIpcHandlers({ projectManager });
  registerDiagnosticsIpcHandlers();
  registerShareIpcHandlers();
  /* registerRemoteIpcHandlers() 删除 — 见上方 import 注释, 替换为 registerMobileBridgeIpcHandlers (末尾) */
  registerModelProfileIpcHandlers();
  // Update progress: 默认弹到 focused project window; 如果发起 IPC 的是特定
  // 窗口就优先发到那个窗口 (updateHandlers 内部会从 event?.sender 拿).
  registerUpdateIpcHandlers(() => projectManager.getFocused()?.window ?? null);
  registerGraphIpcHandlers();
  registerTaskBoardIpcHandlers();
  registerRateLimitIpcHandlers();
  registerPluginIpcHandlers();
  registerPluginHostIpcHandlers();
  /* 异步加载已启用插件 (auth / views / tools…) — 不阻塞 IPC 注册 */
  void bootstrapDesktopPlugins();
  // IDEA-like 语义层 IPC (Command Palette / Outline / Goto Symbol / ...)
  // Per-project: SemanticBridge/TsServerBridge 从 sender 的 ProjectScope 拿
  registerSemanticIpcHandlers({ projectManager });

  registerGitIpcHandlers();
  registerAiIpcHandlers();
  registerEmbeddingIpcHandlers({ projectManager });
  registerProjectStartupIpcHandlers({ projectManager });
  // P4: WriteIntent —— 全局读写协调 (一进程一把锁, 跨 workspace 共享)
  registerWriteIntentIpcHandlers();
  // 运行/调试配置 (IDEA-style: RunManager + ConfigurationType extension point)
  // Per-project RunProcessManager
  registerRunConfigIpcHandlers({ projectManager });

  // Mobile Bridge (LAN P2P) — Settings UI / Composer cloud icon 用
  // 协议: 内部设计文档 (Mode A)
  registerMobileBridgeIpcHandlers();

  /* 发行版自己的 IPC (官方插件市场 / 云端会话 / 云端迁移), 见 ../mainEdition.ts */
  registerMainEditionIpc();
}
