import { registerRoutingIpcHandlers } from './routingHandlers.js';
import { registerExplorerSettingsIpcHandlers } from './explorerSettingsHandlers.js';
import { registerGitIpcHandlers } from './gitHandlers.js';
import { registerProviderIpcHandlers } from './providerHandlers.js';
import { registerProviderModelIpcHandlers } from './providerModelHandlers.js';
import { registerModelProfileIpcHandlers } from './modelProfileHandlers.js';
import { registerKeymapSettingsIpcHandlers } from './keymapSettingsHandlers.js';
import { registerUiStateIpcHandlers } from './uiStateHandlers.js';
import { registerHealthIpcHandlers } from './healthHandlers.js';
import { registerAuthIpcHandlers } from './authHandlers.js';
import { registerChatSessionIpcHandlers } from './chatSessionHandlers.js';
import { registerMcpIpcHandlers } from './mcpHandlers.js';
import { registerMemoryIpcHandlers } from './memoryHandlers.js';
import { registerMigrateIpcHandlers } from './migrateHandlers.js';
import { registerFileSystemIpcHandlers } from './fileSystemHandlers.js';
import { registerRuntimeIpcHandlers } from './runtimeHandlers.js';
import { registerSessionCheckpointTimelineIpcHandlers } from './sessionCheckpointTimelineHandlers.js';
import { registerProcessIpcHandlers } from './processHandlers.js';
import { registerTerminalIpcHandlers } from './terminalHandlers.js';
import { registerSemanticIpcHandlers } from './semanticHandlers.js';
import { registerWorkspaceIpcHandlers } from './workspaceHandlers.js';
import { registerWorkspaceWatcherIpcHandlers } from './workspaceWatcherHandlers.js';
import { registerEmbeddedBrowserIpcHandlers } from './embeddedBrowserHandlers.js';
import { registerTimelineIpcHandlers } from './timelineHandlers.js';
import { registerLiteEdition } from './liteEdition.js';
import { registerMobileBridgeIpcHandlers } from '../mobile-bridge/ipcHandlers.js';
import { registerSkillsIpcHandlers } from './skillsHandlers.js';
import { createSessionStateServices } from '../services/sessionState.js';
import { AgentBridge } from '../services/agentBridge.js';
import { AGENT_BRIDGE, TERMINAL_SERVICE } from '../context/tokens.js';
import { TerminalService } from '../../../platform-electron/terminalService.js';
import { sendToRenderer } from '../services/rendererBroadcast.js';
import { sessionStore } from '@neoxlabs/core/platform/sessionStore.js';
import { registerGatewayKeyIpcHandlers } from './gatewayKeyHandlers.js';
import { registerAgentStatusIpcHandlers } from './agentStatusHandlers.js';
import { registerAssistantConfigIpcHandlers } from './assistantConfigHandlers.js';
import { registerDocumentCacheIpcHandlers } from './documentCacheHandlers.js';
import { registerAiIpcHandlers } from './aiHandlers.js';
import { registerLargeFileIpcHandlers } from './largeFileHandlers.js';
import { registerGraphIpcHandlers } from './graphHandlers.js';
import { registerRateLimitIpcHandlers } from './rateLimitHandlers.js';
import { registerTaskBoardIpcHandlers } from './taskboardHandlers.js';
import { registerWriteIntentIpcHandlers } from './writeIntentHandlers.js';
import { registerFeatureConfigIpcHandlers } from './featureConfigHandlers.js';
import { registerConfigGeneralIpcHandlers } from './configGeneralHandlers.js';
import { registerModelStorageUsageIpcHandlers } from './modelStorageUsageHandlers.js';
import { registerRunModePricingIpcHandlers } from './runModePricingHandlers.js';
import { registerRunConfigIpcHandlers } from './runConfigIpcHandlers.js';
import { registerSoundJavaIpcHandlers } from './soundJavaHandlers.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { registerUIReadHandlers } from './uiReadHandlers.js';
import { storageService } from '../../../platform-electron/storageService.js';

/** 已经装过了 —— createServer 在某些路径上会跑不止一次。 */
let registered = false;

export function registerLiteBridgedHandlers(): void {
  /* 幂等。不加这道的话第二次装载会把 277 个 channel 全部"重复注册"一遍,
   * 路由表里换成第二批闭包 —— 那些闭包指向另一套 sessionState / AgentBridge,
   * 于是"新建的会话在另一个缓存里"这类错乱会随机出现, 而日志只有一堆告警。 */
  if (registered) return;
  registered = true;

  registerRoutingIpcHandlers();
  registerExplorerSettingsIpcHandlers();
  registerGitIpcHandlers();
  registerProviderIpcHandlers();
  registerProviderModelIpcHandlers();
  registerModelProfileIpcHandlers();
  registerKeymapSettingsIpcHandlers();
  registerUiStateIpcHandlers();
  registerAgentStatusIpcHandlers();
  registerAssistantConfigIpcHandlers();
  registerDocumentCacheIpcHandlers();
  registerAiIpcHandlers();
  registerLargeFileIpcHandlers();
  registerGraphIpcHandlers();
  registerRateLimitIpcHandlers();
  registerTaskBoardIpcHandlers();
  registerWriteIntentIpcHandlers();
  /* 主界面第一屏就要读的一批 (语言 / PII 过滤 / agent 设置 / 运行配置 / 提示音)。 */
  registerSoundJavaIpcHandlers();
  /* agent-mode:get-default 在这里 —— AppShell 进主工作区时第一件事就是问它,
   * 缺了会 autoEnterMainWorkspace failed, 卡在登录页后面进不去。
   *
   * 它只用 projectManager 做 "按 sender 反查 workspace scope", 而极简版没有多窗口、
   * 也没有 sender —— 反查恒为 undefined 正是这里的正确语义 (handler 本来就有拿不到
   * scope 的兜底分支)。所以给一个明确返回 undefined 的桩, 而不是假装有 scope。 */
  const workDir = process.cwd();
  let agentBridge: AgentBridge | undefined;
  const getAgentBridge = (): AgentBridge => {
    if (!agentBridge) {
      agentBridge = new AgentBridge();
      agentBridge.setWorkspace(workDir);
      agentBridge.on('stream', (event: unknown) => {
        sendToRenderer('chat:stream', event, (event as any)?.sessionId);
      });
    }
    return agentBridge;
  };
  let terminalService: TerminalService | undefined;
  const getTerminalService = (): TerminalService => {
    if (!terminalService) {
      terminalService = new TerminalService();
      terminalService.on('data', (e: unknown) => sendToRenderer('terminal:data', e, (e as any)?.sessionId));
      terminalService.on('exit', (e: unknown) => sendToRenderer('terminal:exit', e, (e as any)?.sessionId));
    }
    return terminalService;
  };

  const liteScope = {
    workspacePath: workDir,
    tryGetService: (token: unknown) => (
      token === AGENT_BRIDGE ? getAgentBridge()
        : token === TERMINAL_SERVICE ? getTerminalService()
          : undefined),
    getService: (token: unknown) => (
      token === AGENT_BRIDGE ? getAgentBridge()
        : token === TERMINAL_SERVICE ? getTerminalService()
          : undefined),
  };
  /* 极简版只有一个 scope, 所以按 sender 查、按 owned id 查, 答案都是同一个。
   *
   * getByOwnedId 是 terminalHandlers 用来"这个终端 id 属于哪个窗口"的 ——
   * 多窗口才需要区分。少了它 terminal:write 直接抛 `getByOwnedId is not a function`
   * (终端建得出来但一写就废)。 */
  const noScope = {
    getBySender: () => liteScope,
    getByOwnedId: () => liteScope,
    getByWorkspacePath: () => liteScope,
    all: () => [liteScope],
  } as unknown as ProjectManager;
  registerFeatureConfigIpcHandlers({ projectManager: noScope });
  /* 主界面第一屏就要读的一批 (语言 / PII 过滤 / agent 设置 / 运行配置)。
   * 同样只用 projectManager 做 sender→scope 反查, 极简版恒为 undefined。 */
  registerConfigGeneralIpcHandlers({ projectManager: noScope });
  registerRunConfigIpcHandlers({ projectManager: noScope });
  registerModelStorageUsageIpcHandlers({ projectManager: noScope });
  /* pricing:get-all —— 算花费用, 缺了会一直报 "Failed to calculate cost"。 */
  registerRunModePricingIpcHandlers({ projectManager: noScope });

  /* 会话主干 (session:create / get / rename / delete, chat:send …) ——
   * 没有它连"新建对话"都会失败, 界面弹 "Create session failed"。
   *
   * 这一族要真实的会话栈 (sessionStore + 缓存 + SQLite), 而那套东西**不依赖 Electron**
   * (services/sessionState.ts 顶层只有 storageService / sessionStore / database),
   * 所以极简版可以原样建起来 —— 用的是跟标准版同一份实现, 不是另写一个。
   *
   * getBridgeForSession 返回 undefined: 极简版没有多窗口 project scope,
   * 那条 lookup 本来就允许"没找到"并走 noop。 */
  /* Skills / MCP —— 侧栏里就有入口, 缺了点进去是空白加一条红字。 */
  /* timeline —— 聊天记录的落盘/翻页。缺了会话能建但内容存不住,
   * 而且它是 catch 住只 console 一句, 界面上看不出来。 */
  registerTimelineIpcHandlers();
  /* 发行版能力 (商业版: 云端会话传输口 + cloud-session:* IPC), 见 ./liteEdition.ts */
  registerLiteEdition();
  registerMobileBridgeIpcHandlers();
  registerMcpIpcHandlers({ projectManager: noScope });
  registerSkillsIpcHandlers({ projectManager: noScope });
  /* 设置 →「Memory」页。 */
  registerMemoryIpcHandlers({ projectManager: noScope });
  /* 从 Claude Code / Codex / CC Switch 导入已有的 provider。
   * 缺了它界面显示的是"没有可导入的"而不是报错 (调用方 catch 住了) ——
   * 用户会以为自己机器上真没有配过, 而实际上 ~/.claude 和 ~/.codex 都在。 */
  registerMigrateIpcHandlers({ projectManager: noScope });
  /* 文件浏览/读写 —— Files 面板、@ 引用文件、agent 的读写都走这一族。 */
  registerFileSystemIpcHandlers({ projectManager: noScope });
  registerRuntimeIpcHandlers({ projectManager: noScope });          /* 审批 / 后台任务 / shell */
  registerProcessIpcHandlers({ projectManager: noScope } as any);                                     /* 进程面板 + service:* */
  registerTerminalIpcHandlers({ projectManager: noScope });          /* 内置终端 */
  /* projectStartupHandlers **不能装**: 它直接 import ../main.js (Electron 主进程),
   * 一装就把整个主进程拉进 bundle —— 那里面 `import { app, crashReporter, protocol,
   * BrowserWindow, … } from 'electron'` 一整排, 纯 Node 里直接加载失败, 整包报废。
   * 要装它得先把那条对 main 的依赖倒过来 (改成注入), 那是另一件事。 */
  registerSemanticIpcHandlers({ projectManager: noScope });          /* 代码索引 / tsserver */
  registerWorkspaceIpcHandlers({ projectManager: noScope });
  registerWorkspaceWatcherIpcHandlers();   /* 文件变更监听 */         /* 工作区增删改 */
  /* 浏览器 —— 极简版**不自带浏览器**, 走的是"驱动用户自己机器上的 Chrome"那一路
   * (external-chrome:* + browser-tool:*, Playwright connectOverCDP)。
   * 这正是极简版该有的形态: 不为了一个浏览器把包体积翻上去。 */
  registerEmbeddedBrowserIpcHandlers({ projectManager: noScope });

  const sessionState = createSessionStateServices(() => undefined);
  registerSessionCheckpointTimelineIpcHandlers({
    projectManager: noScope,
    getSessionOrThrow: sessionState.getSessionOrThrow,
    getSqliteSession: sessionState.getSqliteSession,
    refreshSession: sessionState.refreshSession,
    persistSession: sessionState.persistSession,
    sessionStore,
    sessionsCache: sessionState.sessionsCache,
  });
  registerChatSessionIpcHandlers({
    projectManager: noScope,
    getSessionOrThrow: sessionState.getSessionOrThrow,
    sessionStore,
    sessionsCache: sessionState.sessionsCache,
  });
  /* 云端可达性探活 —— 登录页顶部那条红条就靠它。renderer 自己 fetch 会撞 CORS,
   * 必须由宿主进程发 (它没有 origin, 也就没有跨域)。 */
  registerHealthIpcHandlers();
  /* 登录 / BYOK —— auth.* 那一整族 (launchOAuth / fetch / logout / 设备指纹…)。
   * 浏览器登录靠 auth:launch-oauth 打开授权页, 而打开动作在非 Electron 宿主下
   * 走系统的 open/xdg-open (见 safeExternalOpen)。 */
  registerAuthIpcHandlers();
  registerGatewayKeyIpcHandlers();
  /* 标准版这里传的是主进程启动时预热好的缓存, 极简版没有那一步, 直接读盘。
   * (这条是 renderer 启动第一个调用, 必须有。) */
  registerUIReadHandlers({ consumeCachedUIState: () => storageService.loadUIState() });

  void seedLiteDefaults();
}

async function seedLiteDefaults(): Promise<void> {
  try {
    const { invokeBridge } = await import('@neoxlabs/platform/shared/ipc.js');
    const cur: any = await invokeBridge('ui-state:get', ['sidebarCollapsed']);
    if (cur?.value == null) {
      await invokeBridge('ui-state:set', ['sidebarCollapsed', '1']);
    }
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[lite] 播种默认值失败 (不致命, 只是侧栏默认展开):', e?.message ?? e);
  }
}
