#!/usr/bin/env node


// ─── 零 import 快路径（不加载任何模块） ───
/* Build-time 版本注入. Bun --define / tsc --define-version flag 都可以注入.
 * Bun --compile 后 require('../../package.json') 路径不可达, 所以走 const 注入更稳.
 * Bun 没 --define 时这个值是 undefined, fallback 到运行时读 (本地 tsx dev / npm pack 路径). */
declare const __NEOX_VERSION__: string | undefined;
const _NEOX_BAKED_VERSION = (typeof __NEOX_VERSION__ !== 'undefined' && __NEOX_VERSION__) ? __NEOX_VERSION__ : null;

const _rawArgs = process.argv.slice(2);
if (_rawArgs.length === 1) {
  if (_rawArgs[0] === '--version' || _rawArgs[0] === '-v' || _rawArgs[0] === '-V') {
    if (_NEOX_BAKED_VERSION) {
      console.log(`Neox CLI v${_NEOX_BAKED_VERSION}`);
      process.exit(0);
    }
  }
}

//   全部仍然走代理。国内用户几乎人人开 Clash/V2Ray (HTTP_PROXY=http://127.0.0.1:7890) 且通常
//   不设 NO_PROXY → CLI 连【自己的本地 server (127.0.0.1)】也被塞进代理 → 代理回不到 localhost
//   (502 / 连接黑洞) → SSE 订阅永久卡住 → POST 永不发出 → 表现为永久卡死 + "Server not connected"。
//   唯一可靠解: 在进程【启动前】把 localhost 加进 NO_PROXY。client 由用户直接启动, 只能在最早期
//   把 localhost 注入 NO_PROXY 后 re-exec 自己一次 (server/worker 子进程不走这里 —— 它们由
//   processManager 在 spawn 的 env 里直接带 NO_PROXY)。只对真·发布二进制 (argv[1]=/$bunfs/...)
//   且确实设了代理、且 NO_PROXY 未覆盖 localhost 时才 re-exec, 普通无代理用户零开销。
if (!process.env.NEOX_WORKER && process.env.__NEOX_PROXY_REEXEC !== '1') {
  const _proxy = process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  const _os = process.platform;
  let _caPath: string | undefined;
  if (!process.env.NODE_EXTRA_CA_CERTS) {
    try {
      const fs = require('node:fs');
      const _candidates = _os === 'darwin'
        ? ['/etc/ssl/cert.pem']
        : _os === 'linux'
          ? ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/ca-bundle.pem']
          : [];
      for (const p of _candidates) {
        if (fs.existsSync(p)) { _caPath = p; break; }
      }
    } catch { /* ESM dev: require 不存在 → 跳过 CA 探测 */ }
  }
  const _np = `${process.env.NO_PROXY || ''},${process.env.no_proxy || ''}`;
  const _hasLocal = /(^|[,\s])(127\.0\.0\.1|localhost|::1|\*)([,\s]|$)/i.test(_np);
  const _isCompiledBin = !!process.argv[1] && /\$bunfs|~BUN/.test(process.argv[1]);
  /* 需要 re-exec 的两种情况:
   *   ① 有代理 + 未把 localhost 加进 NO_PROXY (老逻辑)
   *   ② 任何 BYOK / 第三方 endpoint 场景: bun --compile 没读 system CA, 注入 NODE_EXTRA_CA_CERTS. */
  const _needProxyFix = _proxy && !_hasLocal;
  const _needCaFix = !!_caPath;
  if (_isCompiledBin && (_needProxyFix || _needCaFix)) {
    const _merged = [process.env.NO_PROXY, '127.0.0.1', 'localhost', '::1']
      .filter(Boolean).join(',');
    try {
      const { spawnSync } = require('node:child_process');
      const _newEnv: NodeJS.ProcessEnv = { ...process.env, __NEOX_PROXY_REEXEC: '1' };
      if (_needProxyFix) {
        _newEnv.NO_PROXY = _merged;
        _newEnv.no_proxy = _merged;
      }
      if (_needCaFix) {
        _newEnv.NODE_EXTRA_CA_CERTS = _caPath;
      }
      const _r = spawnSync(process.execPath, process.argv.slice(2), {
        stdio: 'inherit',
        env: _newEnv,
      });
      process.exit(typeof _r.status === 'number' ? _r.status : 0);
    } catch {
      // re-exec 失败就继续走原路径 (退化, 不要把启动搞挂)
    }
  }
}

/* 入口的【内置 require】能解析 bun --compile 嵌入的模块; 被打包的 neox-kernel 依赖里拿到的
 * 却是绑定到 /$bunfs/root/neox 的【模块作用域 require】(走文件系统解析 → 找不到嵌入模块)。
 * 所以这里在入口加载 native, 挂到进程全局 globalThis (跨模块共享, 无单例问题),
 * loadAutoHmacSigner 优先读它。这一处 require literal 同时也强制 bun 把 .node 嵌进 binary。 */
try {
  (globalThis as any).__NEOX_NATIVE__ = require('@neoxlabs/native/neox-native.node');
} catch {
  try { (globalThis as any).__NEOX_NATIVE__ = require('@neoxlabs/native'); } catch { /* optional — 缺失时 signer 降级返 null */ }
}

/* v2 fp 注入 (NeoxCloud 请求需要 X-Device-FP 非空, 需在首次 signer 调用前挂载) + BYOK 老配置迁移 ——
 * 都是账号插槽的进程启动钩子 (商业版 auth/registerEdition.ts; 公开版没有账号 → 不做)。
 * 插槽由商业入口 auth/cliEntry.ts 在本模块求值之前装好, 见 edition/index.ts。 */
getCliEdition().account?.onProcessStart();

{
  const _origEmitWarning = process.emitWarning.bind(process);
  (process as any).emitWarning = (warning: unknown, ...args: unknown[]) => {
    const opts = args[0];
    const code = (opts && typeof opts === 'object') ? (opts as any).code : (typeof opts === 'string' ? args[1] : undefined);
    if (code === 'UNDICI-EHPA') return;
    return (_origEmitWarning as any)(warning, ...args);
  };
}

const _isPrintMode = _rawArgs.includes('-p') || _rawArgs.includes('--print');

if (!process.stdin.isTTY && !_isPrintMode) {
  // 后续会被 earlyInputCapture 模块接管
}

// ─── 正常启动路径（加载完整模块） ───

// 安装 CLI 崩溃日志处理器（必须最先执行）
import { cliLogger, installCrashHandler, cliHealthMonitor } from '@neoxlabs/kernel/platform/cliLogger.js';
import { applySystemProxySync, startSystemProxyWatch } from '@neoxlabs/platform/platform/systemProxy.js';
import { bootstrapMasterKey } from '@neoxlabs/platform/platform/dbCipher.js';
import { bootstrapDebugFlagsFromArgv, installDebugConsoleInterceptor, setInkConsolePatch } from './bootstrap/consolePatch.js';
import { registerCliFallbackHandlers } from './bootstrap/registerCliFallbackHandlers.js';
import { runExecuteShellWorkerIfNeeded } from './bootstrap/workerEntrypoint.js';
import { runMainWithFatalCatch } from './bootstrap/mainFatalHandler.js';
import { startPerfHooksCleanupInterval } from './bootstrap/perfCleanup.js';
import { stopEventLoopWatchdog } from './bootstrap/eventLoopWatchdog.js';
import { handleEarlyCliSubcommands, handleEarlyProcessArgs } from './bootstrap/earlyCommandRouter.js';
import { runCliMainEntryFlow, levenshtein } from './bootstrap/mainEntryFlow.js';
import { getSlashCommands } from './ink/components/SlashCommandMenu.js';
import { runInteractiveFlowFromMain } from './bootstrap/interactiveRunFlow.js';
import { logRunModernUiDebugStateFromMain, runModernUiFlowFromMain } from './bootstrap/modernUiFlow.js';
import { runCleanupWithTimeout } from './bootstrap/cleanupTimeout.js';
import { cleanupCliLifecycleFromMain } from './bootstrap/cleanupLifecycle.js';
import { scheduleStartupUpdateCheck } from './bootstrap/startupUpdateCheck.js';
// child_process removed — native module fix moved to build time (dist/native/) + database.ts
import { runParallelBootPhaseFromMain } from './bootstrap/parallelBootPhase.js';
import { runRuntimeBootstrapPhaseFromMain } from './bootstrap/runtimeBootstrapPhase.js';
import { tryRecoverServerConnectionFromMain } from './bootstrap/serverRecovery.js';
import { ServerHealthHeartbeat } from './bootstrap/serverHealthHeartbeat.js';
import {
  connectServerForCliAttemptFromMain,
  registerRuntimeEventForwardingFromMain,
} from './bootstrap/serverConnectionSetup.js';
import { profileCheckpoint, printProfileSummary } from '@neoxlabs/platform/utils/startup/profiler.js';
import { startCapturingEarlyInput } from './bootstrap/earlyInputCapture.js';
import { shouldUsePrintMode, parsePrintArgs, runPrintMode } from './bootstrap/printMode.js';
import { preconnectFromConfig } from '@neoxlabs/platform/utils/startup/apiPreconnect.js';

profileCheckpoint('cli_entry');

startCapturingEarlyInput();

profileCheckpoint('early_input_capture_started');

bootstrapDebugFlagsFromArgv();

installCrashHandler();
cliLogger.info('CLI', 'Starting Neox CLI');

profileCheckpoint('crash_handler_installed');

if (process.env.CLI_DEBUG === '1') {
  cliHealthMonitor.start(5000); // 每 5 秒检查一次
  cliLogger.info('CLI', 'Health monitor started for debugging');
}

let isInkUIActive = false;
let activeCliInstance: NeoxCLI | null = null;
let sessionSummaryShown = false;

installDebugConsoleInterceptor();

// Fix perf_hooks memory leak warning
const stopPerfHooksCleanupInterval = startPerfHooksCleanupInterval();

void import('./bootstrap/securityAudit.js')
  .then(({ auditSensitiveFiles }) => {
    try {
      const r = auditSensitiveFiles();
      /* 修了的文件 + warning 写日志, 不抢用户屏幕 (启动期是 banner 路径) */
      if (r.fixed.length > 0 || r.warnings.length > 0) {
        cliLogger.warn('CLI', '[securityAudit] sensitive file perms: fixed=' + r.fixed.length + ' warnings=' + r.warnings.length);
        for (const f of r.fixed) cliLogger.info('CLI', '[securityAudit] fixed: ' + f);
        for (const w of r.warnings) cliLogger.warn('CLI', '[securityAudit] ' + w);
      }
    } catch { /* 静默 */ }
  })
  .catch(() => { /* 静默 */ });

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import chalk from 'chalk';
import { AgentMode } from '@neoxlabs/kernel/core/runner.js';
import { setApprovalPrompt } from './approvalDialog.js';
import { getTools, preloadShellEnv, setBackgroundTaskCallback } from '@neoxlabs/core/tools/runtimeTools.js';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { cliPrintln } from './utils/output.js';
import { InkUIAdapter, type TokenStats } from './ink/InkUIAdapter.js';
import { initBgDetection, setTheme, setBgMode, getThemeName, getBgMode, THEME_NAMES } from './ink/theme.js';
import { setHeroRecentSessions } from './ink/brand/heroData.js';
import { formatTimeAgo } from './utils/format.js';
import { isCancelNotice } from './utils/cancelNotice.js';
import { needsProviderConfiguration } from './provider/providerSetupState.js';
import { ensureProviderConfigured } from './provider/ensureProviderConfigured.js';
/* 账号 / 订阅能力一律走发行版插槽 —— 本文件不许 import auth/ (公开树里没有它) */
import { getCliEdition, type CliAccountHost } from './edition/index.js';
/* child_process 同理必须 static import — 给 exit watchdog 用 */
import { spawn as nodeSpawn } from 'child_process';
import { runProviderSetupFlowIfNeeded } from './provider/providerSetupFlow.js';
import { ensureProviderReadyForModernUI } from './provider/ensureProviderReadyForModernUI.js';
import type { AgentConfig, StructuredOutputDefinition, Tool, LLMProvider } from '@neoxlabs/kernel/types/index.js';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import type { AgentContextStats, AgentStatus } from '@neoxlabs/kernel/types/agent.js';
import { MCPClientManager } from '@neoxlabs/core/mcp/clientManager.js';
import {
  MemoryPressureMonitor,
  type MemoryPressureSnapshot,
  type MemoryPressureState,
} from '@neoxlabs/kernel/compat/memoryPressure.js';
import { getDefaultServerBaseUrl } from '@neoxlabs/platform/utils/config.js';
import { loadConfig, saveConfig, type ApprovalMode, type NeoxConfig, type ProviderConfigEntry, type ProviderModelConfig, type ProviderProtocol, type RemoteAccessConfig } from '@neoxlabs/platform/utils/config.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import type { ProviderControls } from '@neoxlabs/core/runtime/runtimeBuilder.js';
import { ModeFactory, normalizeRunMode, type AgentRunMode } from '@neoxlabs/core/runtime/modeFactory.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import { DefaultSessionManager } from '@neoxlabs/core/memory/index.js';
import type { Session as PersistedSession } from '@neoxlabs/kernel/types/session.js';
import { parseArgs, type CLIArgs } from './args.js';
import * as path from 'path';
import type { HostAttachment } from '@neoxlabs/core/runtime/runtimeTypes.js';
import { createIntentClassifier, type IntentResult } from '@neoxlabs/core/intent/index.js';
import { createNodeServices } from '@neoxlabs/platform/platform/nodeServices.js';
import { ActionLogService } from '@neoxlabs/core/platform/actionLog/index.js';
import {
  generateRemoteToken,
  type RunRequest,
  type RunResponse,
} from '@neoxlabs/core/server/client-agent/index.js';
import { skillRegistry } from '@neoxlabs/core/skills/index.js';
import { knowledgeRegistry } from '@neoxlabs/core/knowledge/index.js';
import {
  t,
  getLanguage,
  loadLanguageFromConfig,
} from './i18n/index.js';
import { buildAttachmentCommandRoutingDepsFromMain } from './commands/attachmentRoutingAdapter.js';
import { buildBasicCommandRoutingDepsFromMain } from './commands/basicRoutingAdapter.js';
import { handleCommandFlowFromMain } from './commands/handleCommandFlow.js';
import {
  buildModeAndModelCommandRoutingDepsFromMain,
  buildModeFeatureCommandRoutingDepsFromMain,
} from './commands/modeRoutingAdapters.js';
import { buildSessionProcessRoutingDepsFromMain } from './commands/sessionProcessRoutingAdapter.js';
import { handleModelProfileCommandFlow } from './commands/modelProfileCommand.js';
import { buildMiscCommandRoutingDepsFromMain } from './commands/miscRoutingAdapter.js';
import { buildServiceCommandRoutingDepsFromMain } from './commands/serviceRoutingAdapter.js';
import { buildUiUtilityCommandRoutingDepsFromMain } from './commands/uiUtilityRoutingAdapter.js';
import type { ServerConnection } from '@neoxlabs/core/server/processManager.js';
import { RemoteRuntimeAdapter } from '@neoxlabs/core/sdk/remoteRuntimeAdapter.js';
import type { RuntimeAdapter } from '@neoxlabs/core/sdk/runtimeAdapter.js';
import { NeoxClient } from '@neoxlabs/core/sdk/client.js';

type QueuedRunRequest = RunRequest & {
  source: 'remote';
};

type MainLoopState = 'idle' | 'running';
type MainLoopTransitionReason =
  | 'prepareUserChatExecution'
  | 'runUserChatExecution.finalize'
  | 'interrupt:user'
  | 'interrupt:sigint-fallback';
type SessionSwitchReason = 'activateSession';
type PendingSessionSwitch = {
  session: PersistedSession;
  reason: SessionSwitchReason;
  requestedAt: number;
};

// Import constants and types from extracted modules
import {
  CLI_VERSION,
  getCliCommandHints,
  PROTOCOL_LABELS,
  IMAGE_MIME_BY_EXT,
  isDark,
  colors,
} from './constants.js';
import type { SelectionChoice, TextPromptOptions, InteractionMode } from './cliTypes.js';
import {
  formatProcessDuration,
  formatBadges,
  getCompletionSuggestions,
  createRuntimeEventHandler,
  loadStructuredOutputDefinition,
} from './utils/index.js';
import {
  getWorkspaceHistory as getWorkspaceHistoryUtil,
  saveWorkspaceHistoryIfChanged,
} from './utils/workspaceHistory.js';
import { handleWorkspaceCommandFromMain } from './utils/workspaceCommandAdapter.js';
import { applyResolvedWorkspaceSwitchFromMain } from './utils/workspaceSwitchAdapter.js';
import {
  getModelShortNameForCli,
  getProviderDisplayNameForCli,
  resolveProviderForCli,
  resolveProviderByIdentifierForCli,
  resolveInitialModel,
} from './utils/providerPresentation.js';
import {
  selectModelFromProviderForMain,
  selectProviderFromListForMain,
} from './utils/providerSelectionAdapter.js';
import {
  getActiveModelConfigForCli,
  getActiveReasoningEffortForCli,
  refreshProviderSettingsFromMainState,
} from './utils/providerModelState.js';
import { reloadProviderStateForModernUiFromCli } from './utils/providerStateReload.js';
import { readUtf8FileOrNull, listDirOrEmpty } from './utils/filesystemAccess.js';
import { computeCompatProfileFromMainState } from './utils/compatProfileAdapter.js';
import { pushTokenStatsFromMain } from './utils/tokenStatsAdapter.js';
import { generateSessionSummary } from './utils/sessionSummary.js';
import {
  buildDefaultContextExtrasFromMain,
  calculateContextBreakdownFromMain,
  updateContextWindowDisplayFromMain,
} from './utils/contextWindowAdapter.js';
import { drainRemoteQueueFromMain, enqueueExecutorRunFromMain } from './utils/remoteQueueAdapter.js';
import {
  regenerateRemoteTokenFromMain,
  startRemoteServerFromMain,
  stopRemoteServerFromMain,
} from './utils/remoteLifecycleAdapter.js';
import { buildRemoteStatusFromMain } from './utils/remoteStatusAdapter.js';
import {
  type ChatPayloadLike,
} from './utils/userInputLifecycle.js';
import { handleUserInputFromMain } from './utils/userInputEntryAdapter.js';
import {
  prepareUserChatExecutionFromMain,
  runPreparedUserChatExecutionFromMain,
} from './utils/chatExecutionAdapter.js';
import { rebuildAgentAndRunnerFlow } from './utils/runnerRebuildFlow.js';
import {
  type RemoteApprovalEventPayload,
  type RemoteApprovalCancelledEventPayload,
  type RemoteAskUserEventPayload,
} from './utils/remoteInteractionFlows.js';
import {
  promptConfirmKeywordFromMain,
  promptSelectFromMain,
  promptTextFromMain,
  promptYesNoFromMain,
} from './utils/promptAdapters.js';
import {
  handleRemoteApprovalEventFromMain,
  handleRemoteAskUserEventFromMain,
} from './utils/remoteEventAdapters.js';
import { buildRuntimeEventContextFromMainState } from './utils/runtimeEventContext.js';
import {
  getNormalizedRemoteConfigFromMainState,
  getRawRemoteConfigFromMainState,
  updateRemoteConfigFromMainState,
} from './utils/remoteConfigStateAdapter.js';
import {
  buildThinkingCommandContextFromMain,
} from './contexts/basicCommandContexts.js';
import {
  buildConfigCommandContextFromMainState,
  buildNotifyCommandContextFromMainState,
} from './contexts/configNotifyContextAdapters.js';
import {
  buildInitCommandContextFromMainState,
  buildRemoteCommandContextFromMainState,
  buildRunConfigCommandContextFromMainState,
  buildSetupCommandContextFromMainState,
  buildSupervisorCommandContextFromMainState,
} from './contexts/interactionRuntimeContextAdapters.js';
import {
  buildContextCommandContextFromMainState,
  buildIndexCommandContextFromMainState,
  buildMemoryCommandContextFromMainState,
} from './contexts/stateContextAdapters.js';
import {
  buildMcpCommandContextFromMain,
} from './contexts/interactionCommandContexts.js';
import {
  buildCommandContextFromMainState,
  buildProviderCommandContextGetterFromMainState,
} from './contexts/mainCommandContextAdapters.js';
import { createCommandOutputLinesCallbacks } from './utils/commandOutputLines.js';
import { showSessionSelectorFlow } from './ui/sessionMenus.js';
import { showResumeSelector } from './ui/showResumeSelector.js';
import { showProviderConfigurationGuidePanel } from './ui/headerDisplay.js';
import { initializeMainInkUi, startMainInkUIControllerWithGuards } from './ui/inkUiSetup.js';
import { activateSessionFromMain, initializeSessionFromMain, buildHistoryReplay } from './session/sessionInitializationAdapter.js';
import { handleToolCallStart as toolCallStartHandler, handleToolOutput as toolOutputHandler, initAskUserUI } from './tools/index.js';
import {
  normalizeCheckpoints,
  // Config commands
  type ConfigCommandContext,
  // Index commands
  type IndexCommandContext,
  // Context commands
  type ContextCommandContext,
  type MemoryCommandContext,
  type InitCommandContext,
  type SetupCommandContext,
  type RemoteCommandContext,
  type SupervisorCommandContext,
  type RunConfigCommandContext,
  type CommandContext,
  type ProviderCommandContext,
} from './commands/index.js';

// Global flag for interruption handling
let isRunning = false;
let shouldInterrupt = false;

class NeoxCLI {
  private memory: ShortTermMemory | null = null;
  private providerControls: ProviderControls | null = null;
  private workDir: string;
  private model: string;
  private provider: ProviderProtocol;
  private providerId: string;
  private providerSettings: ProviderConfigEntry;
  private providerStore: ProviderStore;
  private sessionRequests: number = 0;
  private uiController: InkUIAdapter | null = null;
  private userConfig: NeoxConfig = {};
  private platformServices = createNodeServices();
  private actionLog: ActionLogService;
  // hostService removed — server manages runtime host
  private promptLock: Promise<void> | null = null;
  private promptLockResolver: (() => void) | null = null;
  private approvalMode: ApprovalMode = 'auto';
  private structuredOutput?: StructuredOutputDefinition;
  private compatProfile: CompatProfile | null = null;
  private memoryPressure?: MemoryPressureMonitor;
  private lastMemoryPressureState: MemoryPressureState = 'unknown';
  private autoCompactionInProgress = false;
  private interactionMode: InteractionMode = 'agent';
  private pendingAttachments: HostAttachment[] = [];
  private tools: Tool[] = [];
  private baseTools: Tool[] = [];
  private mcpTools: Tool[] = [];
  private mcpManager: MCPClientManager | null = null;
  private lastToolCallArgs: Map<string, Record<string, any>> = new Map(); // Store tool args for output handling
  private toolIdToName: Map<string, string> = new Map(); // Map toolId -> toolName for aggregation
  private toolIdToArgs: Map<string, Record<string, any>> = new Map();

  // Session persistence
  // sessionSync removed — server manages session sync
  private sessionManager: DefaultSessionManager;
  private sessionEnabled: boolean = true;
  private cliArgs: CLIArgs;
  // runtimeHost removed — server manages runtime host
  private isTaskRunning: boolean = false;
  private mainLoopState: MainLoopState = 'idle';
  private pendingSessionSwitch: PendingSessionSwitch | null = null;
  private exiting: boolean = false;
  private runtimeInputTokens: number = 0;
  private runtimeOutputTokens: number = 0;
  private streamingTokenCount: number = 0;  // Estimated tokens during streaming
  private currentSession?: PersistedSession;
  private thinkingMode: 'enabled' | 'disabled' | undefined; // Extended Thinking 模式
  // permissionManager removed — server manages permissions
  private remoteEnabled: boolean = false;  // 远程模式是否已启用（通过 Main Server auth）
  private remoteInputQueue: QueuedRunRequest[] = [];
  private remoteQueueActive: boolean = false;
  private helpMenuLastSelection: string = 'model';
  private currentRunMode: AgentRunMode = 'agentic';

  private serverConnection: ServerConnection | null = null;
  /* 方案 C: 可能是 RemoteRuntimeAdapter (daemon) 或 LocalRuntimeAdapter (进程内), 都实现 RuntimeAdapter。 */
  private remoteAdapter: RuntimeAdapter | null = null;
  private sdkClient: NeoxClient | null = null;
  private cancelledApprovalRequestIds: Map<string, number> = new Map();
  private serverHeartbeat: ServerHealthHeartbeat | null = null;
  private lastSigintAt: number = 0;
  private readonly SIGINT_EXIT_WINDOW_MS = 1200;

  private initRunModeFromConfig(): void {
    const savedMode = this.userConfig.runMode as AgentRunMode | undefined;
    this.currentRunMode = savedMode && ModeFactory.isValidMode(savedMode)
      ? normalizeRunMode(savedMode)
      : 'agentic';
    cliLogger.info('MODE', `Run mode initialized: ${this.currentRunMode}`);
  }


  private getSingleTools(): Tool[] {
    if (this.mcpTools.length === 0) {
      return this.baseTools;
    }
    return [...this.baseTools, ...this.mcpTools];
  }

  private async loadMcpTools(options?: { refresh?: boolean }): Promise<void> {
    if (!this.mcpManager) {
      this.mcpManager = new MCPClientManager({ workDir: this.workDir });
    } else {
      this.mcpManager.setWorkDir(this.workDir);
    }
    try {
      this.mcpTools = await this.mcpManager.getTools({ refresh: options?.refresh });
    } catch (error: any) {
      cliLogger.warn('MCP', `Failed to load MCP tools: ${error?.message || error}`);
      this.mcpTools = [];
    }
    this.tools = this.getSingleTools();
  }

  private setRunMode(mode: AgentRunMode): void {
    mode = normalizeRunMode(mode);
    if (this.currentRunMode === mode) {
      return;
    }

    // 中止当前运行时
    this.abortCurrentRunMode();

    this.currentRunMode = mode;
    this.saveRunModeToConfig(mode);

    if (this.uiController) {
      this.uiController.setRunMode(mode);
    }

    cliLogger.info('MODE', `Switched to ${mode} mode`);
  }

  private abortCurrentRunMode(): void {
    if (this.remoteAdapter) {
      this.remoteAdapter.abort(this.getSdkSessionId());
    }
  }

  private transitionMainLoopState(
    next: MainLoopState,
    reason: MainLoopTransitionReason,
    options?: { allowNoop?: boolean },
  ): void {
    const prev = this.mainLoopState;
    const prevRunning = this.isTaskRunning;
    if (prev === next) {
      const message = `main-loop noop transition: ${prev} -> ${next} (${reason})`;
      if (options?.allowNoop) {
        cliLogger.debug('STATE', message, {
          sessionId: this.currentSession?.sessionId,
          queueLength: this.remoteInputQueue.length,
          runMode: this.currentRunMode,
        });
      } else {
        cliLogger.warn('STATE', message, {
          sessionId: this.currentSession?.sessionId,
          queueLength: this.remoteInputQueue.length,
          runMode: this.currentRunMode,
        });
      }
      this.isTaskRunning = next === 'running';
      if (next === 'idle') {
        this.flushPendingSessionSwitch('main-loop-idle');
      }
      return;
    }

    this.mainLoopState = next;
    this.isTaskRunning = next === 'running';
    cliLogger.debug('STATE', `main-loop ${prev} -> ${next} (${reason})`, {
      prevRunning,
      nextRunning: this.isTaskRunning,
      sessionId: this.currentSession?.sessionId,
      queueLength: this.remoteInputQueue.length,
      runMode: this.currentRunMode,
    });
    if (next === 'idle') {
      this.flushPendingSessionSwitch('main-loop-idle');
    }
  }

  private flushPendingSessionSwitch(trigger: 'main-loop-idle'): void {
    const pending = this.pendingSessionSwitch;
    if (!pending || this.mainLoopState !== 'idle') {
      return;
    }
    this.pendingSessionSwitch = null;

    const prevSessionId = this.currentSession?.sessionId;
    const nextSessionId = pending.session.sessionId;
    if (prevSessionId === nextSessionId) {
      cliLogger.debug('SESSION', `deferred session unchanged: ${nextSessionId} (${pending.reason})`, {
        trigger,
      });
      return;
    }

    this.currentSession = pending.session;
    cliLogger.info('SESSION', `deferred session switched: ${prevSessionId || 'none'} -> ${nextSessionId}`, {
      reason: pending.reason,
      trigger,
      deferredMs: Date.now() - pending.requestedAt,
    });
  }

  private setCurrentSessionWithAudit(nextSession: PersistedSession, reason: SessionSwitchReason): void {
    const prevSessionId = this.currentSession?.sessionId;
    const nextSessionId = nextSession.sessionId;
    if (prevSessionId === nextSessionId) {
      cliLogger.debug('SESSION', `session unchanged: ${nextSessionId} (${reason})`);
      return;
    }

    if (this.isTaskRunning) {
      this.pendingSessionSwitch = {
        session: nextSession,
        reason,
        requestedAt: Date.now(),
      };
      cliLogger.warn('SESSION', `session switch deferred while task running: ${prevSessionId || 'none'} -> ${nextSessionId}`, {
        reason,
        queueLength: this.remoteInputQueue.length,
      });
      return;
    }

    this.pendingSessionSwitch = null;
    this.currentSession = nextSession;
    cliLogger.info('SESSION', `session switched: ${prevSessionId || 'none'} -> ${nextSessionId} (${reason})`);
  }

  private _lastInterruptTime = 0;

  private interruptCurrentTask(reason: 'user' | 'sigint-fallback' = 'user'): void {
    const now = Date.now();
    if (now - this._lastInterruptTime < 500) return;
    this._lastInterruptTime = now;

    const transitionReason: MainLoopTransitionReason =
      reason === 'sigint-fallback' ? 'interrupt:sigint-fallback' : 'interrupt:user';
    this.transitionMainLoopState('idle', transitionReason, { allowNoop: true });
    this.abortCurrentRunMode();

    this.serverHeartbeat?.pauseFor(5000);

    if (this.uiController) {
      /* 先于 finalizeStreamingState (它会把 pending 全提交进滚动区) 取回还没得到回应的用户消息 */
      const unanswered = this.uiController.takeUnansweredPrompt();
      this.uiController.stopTaskTimer();
      this.uiController.finalizeStreamingState?.();
      this.uiController.resetStreamingState();
      this.uiController.abortRunningTaskAgents?.();
      this.uiController.clearSidebarAgents?.();
      this.uiController.clearAllAgentContexts?.();
      this.uiController.setRunning(false);
      this.uiController.updateStatus('Interrupted', 'complete');
      this.uiController.flushRenderScheduler();

      this.uiController.addInterrupted(unanswered);
    }

    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('INTERRUPT', `Task interrupted, source=${reason}`);
    }
    cliHealthMonitor.stop();
  }

  public handleSigintFallback(): void {
    const now = Date.now();
    const isSecondPress = now - this.lastSigintAt <= this.SIGINT_EXIT_WINDOW_MS;
    this.lastSigintAt = now;

    if (this.isTaskRunning) {
      if (isSecondPress) {
        void this.exitWithCleanup({ skipProcessCheck: true, exitCode: 0, reason: 'sigint-double-press' });
        return;
      }

      this.interruptCurrentTask('sigint-fallback');
      if (this.uiController) {
        this.uiController.addInfo(chalk.yellow('再次按 Ctrl+C 退出'));
      }
      return;
    }

    void this.exitWithCleanup({ skipProcessCheck: true, exitCode: 0, reason: 'sigint-idle-exit' });
  }

  /** 获取当前 session ID（用于退出时显示 resume 提示） */
  getSessionId(): string | undefined {
    return this.currentSession?.sessionId;
  }

  private getSdkSessionId(): string {
    const id = this.currentSession?.sessionId;
    if (!id) {
      cliLogger.warn('SDK', 'getSdkSessionId: currentSession not set yet, fallback to "cli" — boot race?');
      return 'cli';
    }
    return id;
  }

  private saveRunModeToConfig(mode: AgentRunMode): void {
    cliLogger.info('MODE', `Saving run mode to config: ${mode}`);
    this.userConfig = {
      ...this.userConfig,
      runMode: mode,
    };
    saveConfig(this.userConfig);
    cliLogger.info('MODE', `Run mode saved: ${mode}`);
  }

  public getCurrentRunMode(): AgentRunMode {
    return this.currentRunMode;
  }

  private getCompactionThreshold(): number {
    const contextConfig = this.userConfig.context || {};
    return contextConfig.thresholdPercent || 85;
  }

  private getCompressionMode(): 'sync' | 'async' {
    const contextConfig = this.userConfig.context || {};
    return contextConfig.compressionMode || 'sync';
  }

  private updateRemoteConfig(updates: Partial<RemoteAccessConfig>): void {
    const updatedConfig = updateRemoteConfigFromMainState({
      userConfig: this.userConfig,
      updates,
      createToken: generateRemoteToken,
    });
    this.userConfig = updatedConfig;
    saveConfig(updatedConfig);
  }

  private getRemoteStatus() {
    const config = getNormalizedRemoteConfigFromMainState({
      userConfig: this.userConfig,
      createToken: generateRemoteToken,
    });
    const serverPort = this.serverConnection?.port ?? config.port;
    return buildRemoteStatusFromMain({
      config,
      remoteEnabled: this.remoteEnabled,
      serverPort,
    });
  }

  private regenerateRemoteToken(): string {
    return regenerateRemoteTokenFromMain({
      createToken: generateRemoteToken,
      updateRemoteConfig: (updates) => this.updateRemoteConfig(updates),
      sdkClient: this.sdkClient,
    });
  }

  /** 切到后台(daemon)模式重启自己 — 远程共享需要常驻 server。会话已持久化, 重启后可继续。 */
  private async restartInDaemonMode(): Promise<void> {
    this.uiController?.addInfo('正在切换到后台模式…', 'Neox 会重启一下,然后再开一次 /remote 即可共享', 'info');
    try { await runCleanupWithTimeout(() => this.cleanup(true), 2000); } catch { /* ignore */ }
    try {
      if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
        (process.stdin as any).setRawMode(false);
      }
      process.stdin.pause();
    } catch { /* ignore */ }
    try {
      const { spawnSync } = await import('node:child_process');
      /* 编译版 argv=[bin, $bunfs脚本, ...args] → slice(2); node dev=[node, main.js, ...args] → slice(1)。 */
      const isCompiled = !!process.argv[1] && /\$bunfs|~BUN/.test(process.argv[1]);
      const reArgs = process.argv.slice(isCompiled ? 2 : 1);
      const r = spawnSync(process.execPath, [...process.execArgv, ...reArgs], {
        stdio: 'inherit',
        env: { ...process.env, NEOX_USE_DAEMON: '1' },
      });
      process.exit(typeof r.status === 'number' ? r.status : 0);
    } catch {
      process.exit(0);
    }
  }

  private async startRemoteServer(opts: { silent?: boolean } = {}): Promise<void> {
    /* 方案 C: 进程内无常驻 HTTP server —— 远程共享(让手机/另一台设备连这个会话)需要后台模式。
     *   · boot 自动调用时 (silent) → 静默跳过, 绝不打扰 (用户没主动开远程)。
     *   · 用户主动 /remote 时 → 友好确认 + 自动切后台并重启 (商业化 UX, 不甩环境变量)。 */
    if (!this.serverConnection) {
      if (opts.silent) return;
      const ok = await this.promptYesNo(
        '远程共享需要后台模式,才能让手机或其他设备连上这个会话。现在切换并重启 Neox?(当前会话会保留)',
        true,
      );
      if (!ok) {
        this.uiController?.addInfo('已取消远程共享', '随时可以再开', 'info');
        return;
      }
      await this.restartInDaemonMode();
      return;
    }
    await startRemoteServerFromMain({
      config: getNormalizedRemoteConfigFromMainState({
        userConfig: this.userConfig,
        generateToken: true,
        createToken: generateRemoteToken,
      }),
      existing: getRawRemoteConfigFromMainState(this.userConfig),
      updateRemoteConfig: (updates) => this.updateRemoteConfig(updates),
      sdkClient: this.sdkClient,
      setRemoteEnabled: (value) => {
        this.remoteEnabled = value;
      },
    });
  }

  private async stopRemoteServer(): Promise<void> {
    await stopRemoteServerFromMain({
      remoteEnabled: this.remoteEnabled,
      sdkClient: this.sdkClient,
      setRemoteEnabled: (value) => {
        this.remoteEnabled = value;
      },
    });
  }

  private enqueueExecutorRun(text: string, source: 'remote', voice?: boolean): RunResponse {
    return enqueueExecutorRunFromMain({
      text,
      source,
      voice,
      remoteInputQueue: this.remoteInputQueue,
      triggerDrain: () => {
        void this.drainRemoteQueue();
      },
    });
  }

  private async drainRemoteQueue(): Promise<void> {
    await drainRemoteQueueFromMain({
      isActive: () => this.remoteQueueActive,
      setActive: (value) => {
        this.remoteQueueActive = value;
      },
      getQueue: () => this.remoteInputQueue,
      isTaskRunning: () => this.isTaskRunning,
      processInput: async (request) => {
        await this.handleUserInput(request.text, undefined, request.source);
      },
    });
  }
  private currentMode: AgentMode = AgentMode.AGENT; // 默认 AGENT 模式

  constructor(model?: string, workDir?: string, providerId?: string, args?: CLIArgs) {
    // Parse CLI args
    this.cliArgs = args || parseArgs();

    this.userConfig = loadConfig();
    this.approvalMode = this.userConfig.approvalMode || 'auto';
    this.providerStore = new ProviderStore(this.userConfig);
    this.workDir = path.resolve(workDir || this.cliArgs.workDir || process.cwd());
    this.actionLog = new ActionLogService({
      workspacePath: this.workDir,
      source: 'cli',
      agentName: 'Neox CLI',
    });
    this.structuredOutput = loadStructuredOutputDefinition(this.cliArgs.outputSchema);

    // Initialize session manager
    this.sessionManager = new DefaultSessionManager();
    this.sessionEnabled = !this.cliArgs.noSession;

    const initialProvider = resolveProviderForCli(this.providerStore, providerId);
    this.providerSettings = initialProvider;
    this.providerId = initialProvider.id;
    this.provider = initialProvider.protocol;
    const resolvedModel = model || resolveInitialModel(initialProvider, this.providerStore);
    if (!resolvedModel && initialProvider.id !== 'neox-cloud') {
      throw new Error(`Provider "${initialProvider.name}" does not have any models configured. Use /model add to configure one.`);
    }
    this.model = resolvedModel || 'auto';
    /* sentinel 的 setLastSelectedModel 现在跳过 models[] 校验 (providerStore 改) */
    this.providerStore.setLastSelectedModel(initialProvider.id, this.model);

    /* E · sentinel 启动期 model 校验 — 如果 cache 已 warm 且当前选的订阅 model
     * 已不在 allowed 列表 (admin 改 plan / 模型下架), 给清晰 warn 提示 /model 重选.
     * 不阻塞启动 — banner 仍按用户当前选 render, chat 时上游会返 403 之类. */
    if (initialProvider.id === 'neox-cloud') {
      getCliEdition().account?.warnIfManagedModelNotAllowed(this.model);
    }
    this.refreshProviderSettings();

    // Change to work directory & expose for tool helpers
    process.chdir(this.workDir);
    process.env.NEOX_WORKDIR = this.workDir;

    // Track workspace history for quick switching
    this.saveWorkspaceHistory(
      getWorkspaceHistoryUtil(
        this.workDir,
        this.userConfig.recentWorkspaces,
        process.env.HOME || '',
      ),
    );

    this.initRunModeFromConfig();
  }

  private async bootStep<T>(scope: string, label: string, task: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    cliLogger.debug('BOOT', `${scope}: ▶ ${label}`);
    try {
      const result = await task();
      cliLogger.debug('BOOT', `${scope}: ✓ ${label} (${Date.now() - startedAt}ms)`);
      return result;
    } catch (error: any) {
      cliLogger.error('BOOT', `${scope}: ✗ ${label} (${Date.now() - startedAt}ms): ${error?.message || String(error)}`);
      throw error;
    }
  }

  private scheduleDeferredBootTask(label: string, timeoutMs: number, task: () => Promise<void>): void {
    const startedAt = Date.now();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      cliLogger.warn('BOOT', `init:deferred: timeout ${label} (${timeoutMs}ms), continue degraded`);
    }, timeoutMs);
    timeoutHandle.unref?.();

    void (async () => {
      try {
        await this.bootStep('init:deferred', label, task);
        if (timedOut) {
          cliLogger.info('BOOT', `init:deferred: recovered ${label} (+${Date.now() - startedAt}ms)`);
        }
      } catch (error: any) {
        const message = error?.message || String(error);
        if (timedOut) {
          cliLogger.warn('BOOT', `init:deferred: failed after timeout ${label}: ${message}`);
        } else {
          cliLogger.warn('BOOT', `init:deferred: degraded ${label}: ${message}`);
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    })();
  }

  /**
   * Async initialization - must be called after constructor
   */
  async init(): Promise<void> {
    const _t0 = Date.now();
    const _bt = (label: string) => cliLogger.debug('BOOT', `init: ${label} (+${Date.now() - _t0}ms)`);
    loadLanguageFromConfig();

    const account = getCliEdition().account;
    if (account) {
      await account.prepareRouting();
      account.startRoutingWatch();
    }

    await runParallelBootPhaseFromMain({
      trace: _bt,
      bootStep: (scope, label, task) => this.bootStep(scope, label, task),
      scheduleDeferredTask: (label, timeoutMs, task) => this.scheduleDeferredBootTask(label, timeoutMs, task),
      preloadShellEnv: async () => preloadShellEnv(this.platformServices),
      setActionLogWorkspace: async () => this.actionLog.setWorkspace(this.workDir),
      initServerConnection: async (trace) => this.initServerConnection(trace),
    });

    await runRuntimeBootstrapPhaseFromMain({
      approvalMode: this.approvalMode,
      setCurrentMode: (mode) => {
        this.currentMode = mode;
      },
      trace: _bt,
      bootStep: (scope, label, task) => this.bootStep(scope, label, task),
      scheduleDeferredTask: (label, timeoutMs, task) => this.scheduleDeferredBootTask(label, timeoutMs, task),
      loadBaseTools: async () => {
        this.baseTools = await getTools(this.workDir, this.platformServices);
      },
      initMcpTools: async () => {
        this.mcpManager = new MCPClientManager({ workDir: this.workDir });
        await this.loadMcpTools();
      },
      initializeSkills: async () => {
        await skillRegistry.initialize(this.workDir);
        /* 知识库跟 skills 同一生命周期 — 失败不阻塞 boot (空库 = L0 section 不注入) */
        try {
          await knowledgeRegistry.initialize(this.workDir);
        } catch (err: any) {
          cliLogger.debug('KNOWLEDGE', `initialize failed: ${err?.message}`);
        }
      },
      getSkillCount: () => skillRegistry.size,
      setCombinedTools: () => {
        this.tools = this.getSingleTools();
      },
      setupApprovalPrompt: () => {
        setApprovalPrompt((question, choices, defaultValue, hint) =>
          this.promptSelect(question, choices, defaultValue, hint)
        );
      },
    });

    cliLogger.info('BOOT', `init: critical path ready (+${Date.now() - _t0}ms)`);

  }

  private async initServerConnection(_bt: (label: string) => void): Promise<void> {
    const MAX_SERVER_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_SERVER_RETRIES; attempt++) {
      try {
        const connection = await connectServerForCliAttemptFromMain({
          userConfig: this.userConfig,
          workDir: this.workDir,
          attempt,
          maxRetries: MAX_SERVER_RETRIES,
          trace: _bt,
          bootStep: (scope, label, task) => this.bootStep(scope, label, task),
          logInfo: (message, details) => this.logInfo(message, details),
        });
        this.remoteAdapter = connection.remoteAdapter;
        this.sdkClient = connection.sdkClient;
        this.serverConnection = connection.serverConnection;

        // 注册事件回调 — 将 server 事件转发给 UI
        const runtimeHandler = createRuntimeEventHandler(buildRuntimeEventContextFromMainState({
          uiController: this.uiController,
          getUiController: () => this.uiController,
          lastToolCallArgs: this.lastToolCallArgs,
          toolIdToName: this.toolIdToName,
          toolIdToArgs: this.toolIdToArgs,
          pushTokenStats: (input, output, snapshot, cacheStats) => this.pushTokenStats(input, output, snapshot, cacheStats),
          getRuntimeTokens: () => ({ input: this.runtimeInputTokens, output: this.runtimeOutputTokens }),
          setRuntimeTokens: (input, output) => {
            this.runtimeInputTokens = input;
            this.runtimeOutputTokens = output;
          },
          getStreamingTokenCount: () => this.streamingTokenCount,
          setStreamingTokenCount: (count: number) => {
            this.streamingTokenCount = count;
          },
          provider: this.getProviderDisplayName(),
          model: this.model,
          sessionId: this.currentSession?.sessionId,
          tokenUsage: this.platformServices.tokenUsage,
        }));
        registerRuntimeEventForwardingFromMain({
          remoteAdapter: this.remoteAdapter,
          runtimeHandler,
          handleRemoteApprovalEvent: (incoming) => {
            void this.handleRemoteApprovalEvent(incoming);
          },
          handleRemoteApprovalCancelledEvent: (incoming) => {
            this.handleRemoteApprovalCancelledEvent(incoming);
          },
          handleRemoteAskUserEvent: (incoming) => {
            void this.handleRemoteAskUserEvent(incoming);
          },
        });
        //   (根本没 daemon) → ping 失败 → 误触发 recovery → dispose adapter → worker 的 chat RPC 被 reject
        //   → explore 中途"adapter disposed"失败。无 server 时根本不该有 server 心跳。
        const hbBase = this.serverConnection?.baseUrl
          || this.userConfig.remoteServer?.url?.replace(/\/+$/, '');
        if (hbBase) {
          const heartbeatUrl = `${hbBase}/health`;
          if (this.serverHeartbeat?.isRunning()) {
            this.serverHeartbeat.updateHealthUrl(heartbeatUrl);
          } else {
            this.startServerHeartbeat();
          }
        } else if (this.serverHeartbeat?.isRunning()) {
          this.serverHeartbeat.stop();
          this.serverHeartbeat = null;
        }
        _bt('server setup complete');
        break; // 成功，跳出重试循环
      } catch (err: any) {
        cliLogger.warn('BOOT', `server connect failed (attempt ${attempt}/${MAX_SERVER_RETRIES}): ${err.message}`);
        cliLogger.error('CLI', `Failed to start/connect server (attempt ${attempt})`, { error: err.message });
        this.remoteAdapter = null;
        this.sdkClient = null;
        this.serverConnection = null;
        if (attempt < MAX_SERVER_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          cliLogger.error('BOOT', `server connect failed after ${MAX_SERVER_RETRIES} attempts`);
        }
      }
    }
  }


  private async tryRecoverServerConnection(reason: string): Promise<boolean> {
    this.serverHeartbeat?.stop();
    this.serverHeartbeat = null;

    return tryRecoverServerConnectionFromMain({
      reason,
      disposeRemoteAdapter: () => {
        this.remoteAdapter?.dispose();
      },
      resetConnectionState: () => {
        this.remoteAdapter = null;
        this.sdkClient = null;
      },
      initServerConnection: async () => {
        await this.initServerConnection(() => { });
      },
      hasRemoteAdapter: () => !!this.remoteAdapter,
    });
  }

  private startServerHeartbeat(): void {
    // 远程模式或无 server 连接时不需要心跳
    if (!this.serverConnection && !this.sdkClient) return;

    const baseUrl = this.serverConnection?.baseUrl || getDefaultServerBaseUrl();
    const healthUrl = `${baseUrl}/health`;

    this.serverHeartbeat = new ServerHealthHeartbeat({
      healthUrl,
      intervalMs: 15_000,
      timeoutMs: 3_000,
      failThreshold: 2,
      onServerUnreachable: async (failures) => {
        /* 自愈是 CLI 内部维护, 成功就完全静默 — 用户没必要知道 daemon 短暂抖动.
         * 只有恢复失败 (用户下条 chat 真发不出去) 才提示, 减少 UI 噪音. */
        cliLogger.warn('HEARTBEAT', `Server unreachable (${failures} consecutive failures), auto-recovering...`);
        const recovered = await this.tryRecoverServerConnection(`heartbeat: ${failures} consecutive failures`);
        if (recovered) {
          cliLogger.info('HEARTBEAT', 'Server auto-recovery succeeded via heartbeat');
          /* 成功 — 不弹 banner, 不打扰用户. */
        } else {
          cliLogger.error('HEARTBEAT', 'Server auto-recovery failed via heartbeat');
          if (this.uiController) {
            this.uiController.addInfo('✗ 服务恢复失败，下次请求时会再次尝试');
          }
        }
      },
    });

    this.serverHeartbeat.start();
  }

  private reloadProviderStateForModernUI(): void {
    const state = reloadProviderStateForModernUiFromCli();
    this.userConfig = state.userConfig;
    this.providerStore = state.providerStore;
    this.providerSettings = state.providerSettings;
    this.providerId = state.providerId;
    this.provider = state.provider;
    this.model = state.model;
    this.refreshProviderSettings();
  }

  private getProviderByIdentifier(providerId?: string): ProviderConfigEntry | null {
    return resolveProviderByIdentifierForCli(providerId, this.providerStore, this.providerSettings);
  }

  private getProviderDisplayName(): string {
    return getProviderDisplayNameForCli(this.providerSettings, PROTOCOL_LABELS);
  }

  private getModelShortName(model: string): string {
    return getModelShortNameForCli(model);
  }

  private async promptText(question: string, options: TextPromptOptions = {}): Promise<string> {
    return await promptTextFromMain({
      question,
      options,
      acquirePromptLock: () => this.acquirePromptLock(),
      releasePromptLock: () => this.releasePromptLock(),
      uiPromptText: this.uiController
        ? (params: { message: string; initial?: string; defaultValue?: string; hint?: string; allowEmpty?: boolean; password?: boolean }) => this.uiController!.promptText(params)
        : undefined,
    });
  }

  private async promptSelect(
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ): Promise<string> {
    return await promptSelectFromMain({
      question,
      choices,
      defaultValue,
      hint,
      acquirePromptLock: () => this.acquirePromptLock(),
      releasePromptLock: () => this.releasePromptLock(),
      uiPromptSelect: this.uiController
        ? (params: { message: string; choices: Array<{ title: string; value: string; description?: string }>; initial?: number; initialValue?: string; hint?: string; header?: string; allowTextInput?: boolean }) => this.uiController!.promptSelect(params)
        : undefined,
    });
  }

  private async promptYesNo(question: string, initialYes = false): Promise<boolean> {
    return await promptYesNoFromMain({
      question,
      initialYes,
      promptSelect: (q, c, d) => this.promptSelect(q, c, d),
    });
  }

  private async promptConfirmKeyword(message: string, keyword: string): Promise<boolean> {
    return await promptConfirmKeywordFromMain({
      message,
      keyword,
      promptText: (q, o) => this.promptText(q, o),
    });
  }

  private async handleRemoteApprovalEvent(event: RemoteApprovalEventPayload): Promise<void> {
    if (event.requestId) {
      this.cancelledApprovalRequestIds.delete(event.requestId);
    }
    await handleRemoteApprovalEventFromMain({
      event,
      sdkClient: this.sdkClient,
      promptSelect: (question, choices, defaultValue, hint) =>
        this.promptSelect(question, choices, defaultValue, hint),
      logInfo: (message, details) => this.logInfo(message, details),
      isRequestCancelled: (requestId) => this.isApprovalRequestCancelled(requestId),
    });
  }

  private handleRemoteApprovalCancelledEvent(event: RemoteApprovalCancelledEventPayload): void {
    if (!event.requestId) {
      return;
    }
    this.markApprovalRequestCancelled(event.requestId);
    /* server 'approval_cancelled' 事件实质是 "审批已结算" 通知 (approve / deny / timeout 都发),
     * 不是真"取消". approved=true → 用户同意了, 这是清理通知, 别给用户显"已取消"误导
     * (截图里同 ID 显两遍"审批请求已取消"就是这一坑). 只 reason 是真取消语义 (resolved/manual_cancel
     * 也只是状态名, 不是用户视角的取消) 时写日志, 且文案区分 approved.
     *
     * 用户视角:
     *   - approved=true → 静默 (审批已通过, 工具开始跑, 不需要额外打扰)
     *   - approved=false + reason ∈ {timeout, session_aborted} → 显"审批超时/已中止"
     *   - 其它 (resolved/manual_cancel/stale 但已 approve) → 静默
     */
    if (event.approved === true) return;
    if (event.reason === 'timeout' || event.reason === 'session_aborted') {
      this.logInfo('审批已中止', event.reason === 'timeout' ? '等待超时' : '会话中止');
    }
    /* 其它情况 (manual_cancel / resolved / stale) 都不打扰用户. */
  }

  private markApprovalRequestCancelled(requestId: string): void {
    const now = Date.now();
    this.cancelledApprovalRequestIds.set(requestId, now + 120_000);
    for (const [id, expiresAt] of this.cancelledApprovalRequestIds.entries()) {
      if (expiresAt <= now) {
        this.cancelledApprovalRequestIds.delete(id);
      }
    }
  }

  private isApprovalRequestCancelled(requestId: string): boolean {
    const expiresAt = this.cancelledApprovalRequestIds.get(requestId);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      this.cancelledApprovalRequestIds.delete(requestId);
      return false;
    }
    return true;
  }

  private async handleRemoteAskUserEvent(event: RemoteAskUserEventPayload): Promise<void> {
    await handleRemoteAskUserEventFromMain({
      event,
      sdkClient: this.sdkClient,
      acquirePromptLock: () => this.acquirePromptLock(),
      releasePromptLock: () => this.releasePromptLock(),
      uiPromptSelect: this.uiController
        ? (selectParams) => this.uiController!.promptSelect(selectParams)
        : undefined,
      promptSelect: (question, choices, defaultValue) =>
        this.promptSelect(question, choices, defaultValue),
      addUserMessage: (message) => {
        this.uiController?.addUserMessage(message);
      },
      logInfo: (message, details) => this.logInfo(message, details),
    });
  }

  private refreshProviderSettings(): void {
    refreshProviderSettingsFromMainState({
      providerId: this.providerId,
      providerStore: this.providerStore,
      setProviderSettings: (provider) => {
        this.providerSettings = provider;
      },
      rebuildCompatProfile: () => this.rebuildCompatProfile(),
    });
  }

  private getActiveModelConfig(): ProviderModelConfig | undefined {
    return getActiveModelConfigForCli(this.providerSettings, this.model);
  }

  private getActiveReasoningEffort(modelName?: string): string | undefined {
    const targetModel = modelName || this.model;
    return getActiveReasoningEffortForCli(this.providerSettings, targetModel);
  }

  private async handleModelProfileCommand(args: string[]): Promise<void> {
    cliLogger.info('MODEL_PROFILE', 'Manual profile inspection command invoked', { args });
    await handleModelProfileCommandFlow({
      args,
      providerId: this.providerId,
      model: this.model,
      providerSettings: this.providerSettings,
      providers: this.providerStore.getProviders(),
      toolsLength: this.tools.length,
      toolNames: this.tools.map(t => t.name),
      promptSelect: (question, choices, defaultValue, hint) =>
        this.promptSelect(question, choices, defaultValue, hint),
      logInfo: (message, details) => this.logInfo(message, details),
    });
  }

  private rebuildCompatProfile(): void {
    const nextCompatProfile = computeCompatProfileFromMainState({
      model: this.model,
      providerSettings: this.providerSettings,
      getActiveModelConfig: () => this.getActiveModelConfig(),
      getCompactionThreshold: () => this.getCompactionThreshold(),
    });

    if (!nextCompatProfile) {
      this.compatProfile = null;
      this.memoryPressure = undefined;
      this.lastMemoryPressureState = 'unknown';
      this.updateContextWindowDisplay();
      return;
    }
    this.compatProfile = nextCompatProfile;

    this.resetMemoryPressureMonitor();
    this.updateContextWindowDisplay();
  }

  private resetMemoryPressureMonitor(): void {
    if (this.compatProfile) {
      this.memoryPressure = new MemoryPressureMonitor(this.compatProfile);
    } else {
      this.memoryPressure = undefined;
    }
    this.lastMemoryPressureState = 'unknown';
  }

  private buildDefaultContextExtras(
    overrides?: Partial<Omit<TokenStats, 'inputTokens' | 'outputTokens' | 'totalTokens'> & { warningLevel: MemoryPressureState }>
  ): Partial<Omit<TokenStats, 'inputTokens' | 'outputTokens' | 'totalTokens'>> | undefined {
    return buildDefaultContextExtrasFromMain({
      compatProfile: this.compatProfile,
      overrides,
    });
  }

  private updateContextWindowDisplay(): void {
    updateContextWindowDisplayFromMain({
      uiController: this.uiController,
      compatProfile: this.compatProfile,
      buildDefaultContextExtras: (contextOverrides) => this.buildDefaultContextExtras(contextOverrides),
    });
  }

  public updateCompactionThreshold(thresholdPercent: number): void {
    if (!this.compatProfile) {
      cliLogger.warn('CLI', 'Cannot update threshold: compatProfile not initialized');
      return;
    }

    // Update compatProfile threshold (convert percentage to decimal)
    this.compatProfile.warnThresholds.warn = thresholdPercent / 100;
    cliLogger.info('CLI', `Updated compaction threshold to ${thresholdPercent}% (warn=${this.compatProfile.warnThresholds.warn})`);

    // Update UI display
    if (this.uiController && 'setCompactionThreshold' in this.uiController) {
      this.uiController.setCompactionThreshold(thresholdPercent);
    }

    // Reset memory pressure monitor to apply new threshold
    this.resetMemoryPressureMonitor();
  }

  private pushTokenStats(
    inputTokens: number,
    outputTokens: number,
    snapshot?: MemoryPressureSnapshot,
    cacheStats?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      contextTokens?: number;
    }
  ): void {
    pushTokenStatsFromMain({
      uiController: this.uiController,
      inputTokens,
      outputTokens,
      snapshot,
      cacheStats,
      compatProfile: this.compatProfile,
      calculateContextBreakdown: (currentSnapshot) => this.calculateContextBreakdown(currentSnapshot),
      buildDefaultContextExtras: (overrides) => this.buildDefaultContextExtras(overrides),
    });
  }

  private calculateContextBreakdown(snapshot?: MemoryPressureSnapshot): {
    systemTokens?: number;
    userTokens?: number;
    assistantTokens?: number;
    toolCallTokens?: number;
    toolResultTokens?: number;
    toolTokens?: number;
    messageTokens?: number;
    totalTokens?: number;
  } {
    return calculateContextBreakdownFromMain({
      memory: this.memory,
      snapshot,
    });
  }

  private async acquirePromptLock(): Promise<void> {
    while (this.promptLock) {
      await this.promptLock;
    }
    this.promptLock = new Promise<void>((resolve) => {
      this.promptLockResolver = resolve;
    });
  }

  private releasePromptLock(): void {
    if (this.promptLockResolver) {
      this.promptLockResolver();
    }
    this.promptLock = null;
    this.promptLockResolver = null;
  }

  private async selectProviderFromList(message: string): Promise<ProviderConfigEntry | null> {
    return selectProviderFromListForMain({
      providerStore: this.providerStore,
      providerId: this.providerId,
      message,
      promptSelect: (question, choices, defaultValue, hint) =>
        this.promptSelect(question, choices, defaultValue, hint),
      logInfo: (infoMessage, details) => this.logInfo(infoMessage, details),
    });
  }

  private async selectModelFromProvider(provider: ProviderConfigEntry, message: string): Promise<string | null> {
    return selectModelFromProviderForMain({
      provider,
      providerId: this.providerId,
      model: this.model,
      message,
      promptSelect: (question, choices, defaultValue, hint) =>
        this.promptSelect(question, choices, defaultValue, hint),
      logInfo: (infoMessage, details) => this.logInfo(infoMessage, details),
    });
  }

  /** 欢迎面板右栏 "最近会话": 取 3 个真聊过的 (有标题、有消息、不是当前), 失败就不显示这一栏, 不挡启动 */
  private async prefetchHeroRecentSessions(): Promise<void> {
    if (!this.sessionEnabled) return;
    try {
      const current = (this as any).currentSession?.sessionId;
      const list = await Promise.race([
        this.sessionManager.listSessions(),
        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 400)),
      ]);
      const picked = (list as any[])
        .filter((s) => s.sessionId !== current && (s.itemCount ?? 0) > 1)
        .map((s) => ({ s, name: typeof s.agentName === 'string' ? s.agentName.trim() : '' }))
        .filter(({ s, name }) => name && name !== `Session ${s.sessionId}`)
        .slice(0, 4)  /* 宽屏 hero 右栏放 4 条, 窄一档的只用前 2 条 */
        .map(({ s, name }) => ({ title: name, ago: formatTimeAgo(s.updatedAt) }));
      setHeroRecentSessions(picked);
    } catch { /* 拿不到就不显示 */ }
  }

  /**
   * Initialize session persistence
   */
  private async initializeSession(): Promise<void> {
    await initializeSessionFromMain({
      sessionEnabled: this.sessionEnabled,
      cliArgs: this.cliArgs,
      sessionManager: this.sessionManager,
      model: this.model,
      showSessionSelector: () => this.showSessionSelector(),
      activateSession: (session, options) => this.activateSession(session, options),
      sdkClient: this.sdkClient,
      userConfig: this.userConfig,
      printLoadedHistory: (loaded) => {
        cliPrintln(colors.dim(`  ↳ Loaded ${loaded} messages from history`));
      },
      printHistoryRecap: () => {},
      printSessionInitFailed: (message) => {
        cliLogger.warn('SESSION', `Session init failed: ${message}`);

        if (message.includes('NODE_MODULE_VERSION')) {
          // 打印完整错误帮助定位是哪个模块
          cliPrintln(colors.error(`  ✗ Native module error: ${message}`));
        }
        return false;
      },
      disableSession: () => {
        this.sessionEnabled = false;
      },
    });
  }

  private async showSessionSelector(): Promise<PersistedSession | null> {
    try {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const selectedId = await showResumeSelector();
        if (selectedId === null) return null; // 用户选新建 / Esc
        return (await this.sessionManager.getSession(selectedId)) as PersistedSession | null;
      }
    } catch {
      /* 富选择器异常 → 回落 */
    }
    return await showSessionSelectorFlow(this.sessionManager);
  }

  private async activateSession(
    session: PersistedSession,
    options?: { loadHistory?: boolean }
  ): Promise<number> {
    const loaded = await activateSessionFromMain({
      session,
      options,
      setCurrentSession: (nextSession) => {
        this.setCurrentSessionWithAudit(nextSession, 'activateSession');
      },
      sdkClient: this.sdkClient,
    });
    if (options?.loadHistory && session?.sessionId) {
      this.pendingHistoryReplay = session.sessionId;
      /* /resume: 界面已经起来了, 马上回放; 启动时的 -c / -r: 等界面起来后 (flushHistoryReplay) */
      if (isInkUIActive) this.flushHistoryReplay();
    }
    return loaded;
  }

  /** 恢复会话后要回放到时间线的会话 id (界面起来前先记着) */
  private pendingHistoryReplay: string | null = null;

  private flushHistoryReplay(): void {
    const sessionId = this.pendingHistoryReplay;
    this.pendingHistoryReplay = null;
    if (!sessionId || !this.uiController) return;
    try {
      const turns = buildHistoryReplay(sessionId, 3);
      if (turns.length === 0) return;
      const zh = getLanguage() === 'zh';
      this.uiController.addInfo(
        zh ? `之前的对话 · 最近 ${turns.length} 轮` : `Earlier in this session · last ${turns.length} turns`,
        zh ? 'ctrl+o 看完整记录' : 'ctrl+o for the full transcript',
      );
      for (const t of turns) {
        this.uiController.addUserMessage(t.user);
        if (t.assistant) this.uiController.addAssistantMessage(t.assistant);
      }
    } catch (err: any) {
      cliLogger.warn('SESSION', `history replay failed: ${err?.message ?? err}`);
    }
  }

  private async cleanup(skipProcessCheck: boolean = false): Promise<void> {
    stopPerfHooksCleanupInterval();
    stopEventLoopWatchdog();
    this.serverHeartbeat?.stop();
    this.serverHeartbeat = null;
    await cleanupCliLifecycleFromMain({
      skipProcessCheck,
      uiController: this.uiController,
      setInkConsolePatch: (enabled) => setInkConsolePatch(enabled),
      setInkUIActive: (active) => {
        isInkUIActive = active;
      },
      stopRemoteServer: () => this.stopRemoteServer(),
      remoteAdapter: this.remoteAdapter,
      clearRemoteAdapter: () => {
        this.remoteAdapter = null;
      },
      serverConnection: this.serverConnection,
      clearServerConnection: () => {
        this.serverConnection = null;
      },
      shutdownActionLog: () => this.actionLog.shutdown(),
    });
  }

  private async exitWithCleanup(options: { skipProcessCheck: boolean; exitCode: number; reason: string }): Promise<void> {
    if (this.exiting) {
      return;
    }
    this.exiting = true;

    try {
      await runCleanupWithTimeout(() => this.cleanup(options.skipProcessCheck), 2000);
    } catch (err: any) {
      cliLogger.debug('DEBUG', `exitWithCleanup failed (${options.reason}): ${err?.message}`);
    } finally {
      // 放在 cleanup finally 里、process.exit 之前
      try {
        const summary = generateSessionSummary(this.currentSession?.sessionId);
        if (summary) {
          sessionSummaryShown = true;
          process.stdout.write('\n' + summary + '\n');
        }
      } catch (err: any) { cliLogger.debug('CLI', `Session summary failed: ${err?.message}`); }
      try {
        if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
          (process.stdin as any).setRawMode(false);
        }
        process.stdin.pause();
      } catch { /* ignore */ }
      try {
        const wd = process.platform === 'win32'
          ? nodeSpawn(
              'cmd.exe',
              ['/c', `timeout /t 1 /nobreak >nul & taskkill /f /pid ${process.pid} >nul 2>&1`],
              { detached: true, stdio: 'ignore', windowsHide: true },
            )
          : nodeSpawn(
              '/bin/sh',
              ['-c', `sleep 0.3; kill -9 ${process.pid} 2>/dev/null`],
              { detached: true, stdio: 'ignore' },
            );
        wd.unref();
      } catch { /* ignore — 即使 watchdog 起不来, process.exit 仍尝试退 */ }
      process.exit(options.exitCode);
    }
  }

  private initializeInkUi(workDirShort: string): void {
    cliLogger.info('CLI', 'Using Ink UI');
    const compressionMode = this.getCompressionMode();
    const thresholdPercent = this.getCompactionThreshold();

    let account = '—';
    let accountTone: 'cyan' | 'green' | 'gray' = 'gray';
    try {
      const hasDefaultProvider = !!(this.providerStore && this.providerStore.getDefaultProvider?.());
      const editionAccount = getCliEdition().account;
      if (editionAccount) {
        ({ text: account, tone: accountTone } = editionAccount.bannerAccount(hasDefaultProvider));
      } else if (hasDefaultProvider) {
        account = '本地 BYOK';
        accountTone = 'green';
      } else {
        account = '未配置 · /provider add';
        accountTone = 'gray';
      }
    } catch { /* 静默, banner 显 '—' */ }

    this.uiController = initializeMainInkUi({
      version: CLI_VERSION,
      provider: this.getProviderDisplayName(),
      model: this.model,
      reasoningEffort: this.getActiveReasoningEffort(),
      workDir: workDirShort,
      account,
      accountTone,
      commandHints: getCliCommandHints(),
      getCompletions: (value) => getCompletionSuggestions({
        providerStore: this.providerStore,
        providerSettings: this.providerSettings,
      }, value),
      compressionMode,
      thresholdPercent,
      initAskUserUI: (ui) => initAskUserUI(ui),
      setBackgroundTaskCallback: (callbacks) => setBackgroundTaskCallback({
        onAdd: callbacks.onAdd,
        onUpdate: callbacks.onUpdate,
        onUpdateByPid: callbacks.onUpdateByPid,
      }),
      currentRunMode: this.currentRunMode,
      syncCompressionMode: () => {
        this.fireAndForgetSdkSync(
          'setCompressionMode during UI init',
          this.sdkClient?.setCompressionMode(this.getSdkSessionId(), compressionMode),
          { compressionMode },
        );
      },
      updateContextWindowDisplay: () => this.updateContextWindowDisplay(),
      logContextSettings: (details) => {
        cliLogger.debug('CLI', 'Initialized context settings from userConfig', details);
      },
    });

    this.uiController?.setKillBackgroundTaskHandler((pid, force) => {
      this.fireAndForgetSdkSync(
        'killBackgroundTask from UI panel',
        this.sdkClient?.killBackgroundTask(pid, force),
        { pid, force },
      );
    });
  }

  private startInkUiControllerWithGuards(): void {
    if (!this.uiController) {
      throw new Error('Ink UI controller not initialized.');
    }
    startMainInkUIControllerWithGuards({
      uiController: this.uiController,
      setInkConsolePatch: (enabled) => setInkConsolePatch(enabled),
      setInkUIActive: (active) => {
        isInkUIActive = active;
      },
      onSubmit: async (input, images) => {
        await this.handleUserInput(input, images, 'local');
      },
      onExit: () => {
        cliLogger.debug('DEBUG', 'onExit callback invoked');
        this.exitWithCleanup({ skipProcessCheck: true, exitCode: 0, reason: 'ui-exit' });
      },
      onInterrupt: () => {
        this.interruptCurrentTask('user');
      },
      isTaskRunning: () => this.isTaskRunning,
      onToggleThinking: (enabled) => {
        this.thinkingMode = enabled ? 'enabled' : 'disabled';
        /* 跟 setThinkingMode 走同一条同步 —— 状态栏的 Thinking on/off 才不会说假话 */
        this.uiController?.setThinkingEnabled?.(enabled);
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('THINKING', `Toggled to: ${this.thinkingMode}`);
        }
      },
    });

    // ↑ 撤回排队消息: 调 server dequeue-last, 返回文本放回输入框 (QueuedMessagesBar 提示的功能)
    this.uiController.setPullbackQueued?.(async () => {
      const sid = this.getSdkSessionId();
      if (!sid) return null;
      try {
        return (await this.sdkClient?.removeLastPendingMessage(sid)) ?? null;
      } catch {
        return null;
      }
    });

    /* 启动时 -c / -r 恢复的会话: 界面刚起来, 把最近几轮放进时间线 (hero 下面) */
    this.flushHistoryReplay();
  }

  /**
   * Run with modern UI
   */
  private async runModernUI(): Promise<void> {
    /* audit P1-12: token refresh 失败 (401/403) 时同步刷 banner 让用户看见
     *   "登录已过期", 不要让用户首条 chat 才知道. 一次性 register, 弱耦合. */
    try {
      getCliEdition().account?.onRefreshFailed(() => {
        try { this.refreshAccountStatusForBanner(); } catch { /* refresh banner 失败不阻塞 */ }
      });
    } catch { /* 注册失败不阻塞 */ }

    return runModernUiFlowFromMain({
      workDir: this.workDir,
      logRunModernUiDebugState: (stage) => logRunModernUiDebugStateFromMain(stage),
      ensureProviderReadyForUi: async () => {
        await ensureProviderReadyForModernUI({
          needsProviderConfiguration: () => needsProviderConfiguration(),
          showProviderConfigurationGuide: () => showProviderConfigurationGuidePanel(),
          ensureProviderConfigured: () => ensureProviderConfigured(),
          reloadProviderState: () => this.reloadProviderStateForModernUI(),
        });
      },
      initializeModernUiSession: async (bt) => {
        bt('initializeSession...');
        await this.bootStep('runModernUI', 'initializeSession', async () => this.initializeSession());
        bt('initializeSession done');
        await this.prefetchHeroRecentSessions();
      },
      initializeInkUi: (workDirShort) => this.initializeInkUi(workDirShort),
      startInkUiControllerWithGuards: () => this.startInkUiControllerWithGuards(),
      startRemoteServerForModernUi: async (bt) => {
        bt('startRemoteServer...');
        /* boot 自动调用 → silent: 进程内模式下静默跳过, 不弹"需 daemon"。remote 真启用时 mode-selection
         * 已把 CLI 切到 daemon 模式 (serverConnection 非空), 这里就会正常起远程。 */
        await this.bootStep('runModernUI', 'startRemoteServer', async () => this.startRemoteServer({ silent: true }));
      },
      scheduleStartupUpdateCheck: () => {
        scheduleStartupUpdateCheck(() => this.getCommandContext(), 1200);
      },
    });
  }

  private prepareUserChatExecution(
    userInput: string,
    images: Array<{ path?: string; name?: string; mediaType?: string; data?: string }> | undefined,
    source: 'local' | 'remote' | 'supervisor',
  ): ChatPayloadLike {
    return prepareUserChatExecutionFromMain({
      userInput,
      images,
      source,
      pendingAttachments: this.pendingAttachments,
      interactionMode: this.interactionMode,
      imageMimeByExt: IMAGE_MIME_BY_EXT,
      currentRunMode: this.currentRunMode,
      providerId: this.providerId,
      modelName: this.model,
      getSdkSessionId: () => this.getSdkSessionId(),
      incrementSessionRequests: () => {
        this.sessionRequests++;
      },
      resetStreamingState: () => {
        this.uiController!.resetStreamingState();
      },
      resetRuntimeTokens: () => {
        this.runtimeInputTokens = 0;
        this.runtimeOutputTokens = 0;
        this.streamingTokenCount = 0;
      },
      startTaskTimer: () => {
        this.uiController!.startTaskTimer();
      },
      addInfo: (message, details) => {
        this.uiController?.addInfo(message, details);
      },
      setPendingAttachments: (attachments) => {
        this.pendingAttachments = attachments;
      },
      addUserMessage: (message, imagesToDisplay, inputSource) => {
        this.uiController!.addUserMessage(message, imagesToDisplay, inputSource);
      },
      startSessionTimer: () => {
        this.uiController!.startSessionTimer();
      },
      setTaskRunning: (running) => {
        this.transitionMainLoopState(running ? 'running' : 'idle', 'prepareUserChatExecution');
      },
    });
  }

  private async runPreparedUserChatExecution(
    userInput: string,
    chatPayload: ChatPayloadLike,
  ): Promise<void> {
    await runPreparedUserChatExecutionFromMain({
      userInput,
      chatPayload,
      uiController: this.uiController,
      runChat: async () => {
        /** 开始真正的运行任务了 **/
        if (!this.remoteAdapter) {
          throw new Error('Server not connected. Cannot process request.');
        }
        await this.remoteAdapter.chat(chatPayload);
      },
      tryRecoverServerConnection: (reason) => this.tryRecoverServerConnection(reason),
      hasChatTransport: () => !!this.remoteAdapter,
      retryChat: async () => {
        await this.remoteAdapter!.chat(chatPayload);
      },
      setTaskRunning: (running) => {
        this.transitionMainLoopState(running ? 'running' : 'idle', 'runUserChatExecution.finalize', {
          allowNoop: !running,
        });
      },
      stopTaskTimer: () => {
        this.uiController?.stopTaskTimer();
      },
      handleUserInput: (text) => {
        void this.handleUserInput(text);
      },
    });
  }

  /**
   * Handle user input in modern UI mode using the shared runtime host
   */
  private async handleUserInput(
    rawInput: string,
    images?: Array<{ path?: string; name?: string; mediaType?: string; data?: string }>,
    source: 'local' | 'remote' | 'supervisor' = 'local'
  ): Promise<void> {
    await handleUserInputFromMain({
      rawInput,
      images,
      source,
      uiController: this.uiController,
      isTaskRunning: this.isTaskRunning,
      enqueueRemoteInput: (text) => {
        this.enqueueExecutorRun(text, 'remote');
      },
      injectMessage: (message) => {
        this.fireAndForgetSdkSync(
          'injectMessage from user input',
          this.sdkClient?.injectMessage(this.getSdkSessionId(), message),
          { source },
        );
      },
      interruptRunningTask: () => {
        this.interruptCurrentTask('user');
      },
      handleCommand: async (command) => this.handleCommand(command),
      prepareUserChatExecution: (userInput, inputImages, inputSource) =>
        this.prepareUserChatExecution(userInput, inputImages, inputSource),
      runPreparedUserChatExecution: async (userInput, chatPayload) =>
        this.runPreparedUserChatExecution(userInput, chatPayload),
    });
  }

  async runInteractive(): Promise<void> {
    try { await initBgDetection(); } catch { /* 探测失败不阻塞 */ }
    return runInteractiveFlowFromMain({
      hasSeenOnboarding: !!this.userConfig.hasSeenOnboarding,
      hasUiController: !!this.uiController,
      promptSelect: (question, choices, defaultValue, hint) =>
        this.promptSelect(question, choices, defaultValue, hint),
      logInfo: (message, details) => this.logInfo(message, details),
      markOnboardingSeen: () => {
        this.userConfig.hasSeenOnboarding = true;
        saveConfig(this.userConfig);
      },
      runModernUI: async () => this.runModernUI(),
    });
  }

  /** /theme [name|light|dark] — 运行时切配色/背景, 即时刷新整个 UI。无参数 → 交互式选择器。 */
  private async handleThemeCommand(arg: string): Promise<void> {
    const a = arg.toLowerCase().trim();
    if (a === 'light' || a === 'dark') {
      setBgMode(a);
      this.uiController?.refreshTheme();
      this.uiController?.addInfo(`背景模式 → ${a}`, undefined, 'success');
      return;
    }
    if (!a) {
      /* 无参数 → 弹交互式选择器 (商业化 UX, 不只甩命令)。每个配色按当前标记, 选了即时刷新。 */
      const current = getThemeName();
      let choice: string;
      try {
        choice = await this.promptSelect(
          '选择配色主题',
          THEME_NAMES.map((n) => ({ label: n === current ? `${n}  (当前)` : n, value: n })),
          current,
          '↑↓ 选择 · Enter 确认 · ESC 取消 · 背景明暗用 /theme light|dark',
        );
      } catch { return; /* 取消 */ }
      if (choice && setTheme(choice)) {
        this.uiController?.refreshTheme();
        this.uiController?.addInfo(`配色 → ${choice}`, undefined, 'success');
      }
      return;
    }
    if (setTheme(a)) {
      this.uiController?.refreshTheme();
      this.uiController?.addInfo(`配色 → ${a}`, undefined, 'success');
    } else {
      this.uiController?.addInfo(`未知配色 "${a}"`, `可选: ${THEME_NAMES.join(' / ')}`, 'warning');
    }
  }

  private async handleCommand(command: string): Promise<void> {
    const tt = command.trim();
    if (tt === '/theme' || tt.startsWith('/theme ')) {
      try {
        await this.handleThemeCommand(tt.slice(6).trim());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        /* ESC 取消不是失败, 同 handleCommandFlow 里的说明 */
        if (message !== 'cancelled') {
          this.uiController?.addError(`Command failed: /theme — ${message}`);
        }
      }
      return;
    }
    await handleCommandFlowFromMain({
      command,
      workDir: this.workDir,
      addSkillError: (message) => {
        this.uiController?.addError(message);
      },
      executeSkillOutput: async (output) => this.handleUserInput(output, undefined, 'local'),
      getThinkingCommandContext: () => buildThinkingCommandContextFromMain({
        model: this.model,
        providerSettings: this.providerSettings,
        thinkingMode: this.thinkingMode,
        llmProvider: this.providerControls?.anthropic || null,
        setThinkingMode: (mode) => {
          this.thinkingMode = mode;
          this.uiController?.setThinkingEnabled?.(mode === 'enabled');
        },
        promptSelect: (q, c, d) => this.promptSelect(q, c, d),
        logInfo: (m, d) => this.logInfo(m, d),
      }),
      getBasicCommandRoutingDeps: () => this.getBasicCommandRoutingDeps(),
      getModeAndModelCommandRoutingDeps: () => this.getModeAndModelCommandRoutingDeps(),
      getAttachmentCommandRoutingDeps: () => this.getAttachmentCommandRoutingDeps(),
      getServiceCommandRoutingDeps: () => this.getServiceCommandRoutingDeps(),
      getUiUtilityCommandRoutingDeps: () => this.getUiUtilityCommandRoutingDeps(),
      getModeFeatureCommandRoutingDeps: () => this.getModeFeatureCommandRoutingDeps(),
      getMiscCommandRoutingDeps: () => this.getMiscCommandRoutingDeps(),
      getSessionProcessRoutingDeps: () => this.getSessionProcessRoutingDeps(),
      getAccountCommandRoutingDeps: () => ({
        refreshAccountStatus: () => this.refreshAccountStatusForBanner(),
        printOutput: (lines: string[]) => {
          if (this.uiController?.setCommandOutputLines) {
            this.uiController.setCommandOutputLines(lines);
          }
        },
      }),
      /* /target — Target Mission Phase 1 (单 agent 长跑).
       * 只做副作用 (激活 target mode + 打提示), 不发 chat. loop 闸门在 runtimeBuilder 里.
       * 参考 内部设计文档 */
      getTargetCommandRoutingDeps: () => ({
        logInfo: (m, d) => this.logInfo(m, d),
        logError: (m, d) => this.logInfo(m, d),
      }),
      logUnknownCommand: (cmdRaw) => {
        const suggestion = suggestSlashCommand(cmdRaw);
        this.logInfo(
          'Unknown command',
          `Command: ${cmdRaw}\n\n${suggestion ? `Did you mean ${suggestion} ?\n\n` : ''}Type /help for available commands`,
        );
      },
    });
  }

  private getBasicCommandRoutingDeps() {
    return buildBasicCommandRoutingDepsFromMain({
      workDir: this.workDir,
      uiController: this.uiController,
      getLastSelection: () => this.helpMenuLastSelection,
      setLastSelection: (value) => {
        this.helpMenuLastSelection = value;
      },
      executeCommand: (command) => this.handleCommand(command),
      logInfo: (message, details) => this.logInfo(message, details),
      exitWithCleanup: (options) => {
        this.exitWithCleanup(options);
      },
    });
  }

  private getModeAndModelCommandRoutingDeps() {
    return buildModeAndModelCommandRoutingDepsFromMain({
      getInteractionMode: () => this.interactionMode,
      setInteractionMode: (mode) => {
        this.interactionMode = mode;
      },
      getCurrentRunMode: () => this.getCurrentRunMode(),
      setRunMode: (mode) => this.setRunMode(mode),
      promptSelect: (question, choices, defaultValue) =>
        this.promptSelect(question, choices, defaultValue),
      logInfo: (message, details) => this.logInfo(message, details),
      getRunConfigCommandContext: () => this.getRunConfigCommandContext(),
      getProviderCommandContext: buildProviderCommandContextGetterFromMainState({
        providerId: this.providerId,
        provider: this.provider,
        model: this.model,
        providerSettings: this.providerSettings,
        providerStore: this.providerStore,
        promptText: (question, options) => this.promptText(question, options),
        promptSelect: (question, choices, defaultValue, hint) => this.promptSelect(question, choices, defaultValue, hint),
        promptYesNo: (question, initialYes) => this.promptYesNo(question, initialYes),
        promptConfirmKeyword: (message, keyword) => this.promptConfirmKeyword(message, keyword),
        selectProviderFromList: (message) => this.selectProviderFromList(message),
        selectModelFromProvider: (provider, message) => this.selectModelFromProvider(provider, message),
        getProviderByIdentifier: (providerId) => this.getProviderByIdentifier(providerId),
        setProviderState: (state) => {
          this.providerId = state.providerId;
          this.provider = state.provider;
          this.model = state.model;
          this.providerSettings = state.providerSettings;
        },
        refreshProviderSettings: () => this.refreshProviderSettings(),
        rebuildCompatProfile: () => this.rebuildCompatProfile(),
        rebuildAgentAndRunner: () => this.rebuildAgentAndRunner(),
        updateContextWindowDisplay: () => this.updateContextWindowDisplay(),
        getProviderDisplayName: () => this.getProviderDisplayName(),
        sdkClient: this.sdkClient,
        getSdkSessionId: () => this.getSdkSessionId(),
        logInfo: (message, details) => this.logInfo(message, details),
        uiController: this.uiController,
        getActiveReasoningEffort: (model) => this.getActiveReasoningEffort(model),
      }),
      handleModelProfileCommand: (args) => this.handleModelProfileCommand(args),
      /* /effort 命令需要拿当前 provider/model + 改完通知 main 刷新 */
      getActiveProvider: () => this.providerSettings,
      getActiveModel: () => this.model,
      onProviderChanged: () => {
        this.refreshProviderSettings();
        this.rebuildCompatProfile();
        this.rebuildAgentAndRunner();
      },
    });
  }

  private getAttachmentCommandRoutingDeps() {
    return buildAttachmentCommandRoutingDepsFromMain({
      getPendingAttachments: () => this.pendingAttachments,
      setPendingAttachments: (attachments) => {
        this.pendingAttachments = attachments;
      },
      logInfo: (message, details) => this.logInfo(message, details),
    });
  }

  private getServiceCommandRoutingDeps() {
    return buildServiceCommandRoutingDepsFromMain({
      getConfigCommandContext: () => this.getConfigCommandContext(),
      getNotifyCommandContext: () => buildNotifyCommandContextFromMainState({
        userConfig: this.userConfig,
        promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
        logInfo: (m, d) => this.logInfo(m, d),
        updateConfig: (config) => {
          this.userConfig = config;
        },
      }),
      getMcpCommandContext: () => buildMcpCommandContextFromMain({
        workDir: this.workDir,
        mcpManager: this.mcpManager,
        setMcpManager: (manager) => {
          this.mcpManager = manager;
        },
        promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
        promptText: (q, o) => this.promptText(q, o),
        logInfo: (m: string, d?: string) => this.logInfo(m, d),
        refreshMcpTools: async () => {
          await this.rebuildAgentAndRunner();
        },
        outputLines: (lines: string[]) => this.uiController?.setCommandOutputLines(lines),
      }),
      getRemoteCommandContext: () => this.getRemoteCommandContext(),
      getSupervisorCommandContext: () => this.getSupervisorCommandContext(),
      webSearch: {
        userConfig: this.userConfig,
        promptSelect: (question, choices, defaultValue, hint) =>
          this.promptSelect(question, choices, defaultValue, hint),
        promptText: (question, options) => this.promptText(question, options),
        logInfo: (message, details) => this.logInfo(message, details),
        updateUserConfig: (nextConfig) => {
          this.userConfig = nextConfig;
        },
        persistConfig: (nextConfig) => {
          saveConfig(nextConfig);
        },
        refreshTools: async () => {
          this.baseTools = await getTools(this.workDir, this.platformServices);
          this.tools = this.getSingleTools();
        },
      },
    });
  }

  private getUiUtilityCommandRoutingDeps() {
    return buildUiUtilityCommandRoutingDepsFromMain({
      hasUiController: !!this.uiController,
      workDir: this.workDir,
      promptSelect: (question, choices, defaultValue, hint) =>
        this.promptSelect(question, choices, defaultValue, hint),
      promptText: (label, options) => this.promptText(label, options),
      logInfo: (message, details) => this.logInfo(message, details),
      executeSkillById: async (skillId) => {
        await this.handleUserInput(`/${skillId}`, undefined, 'local');
      },
      getCommandContext: () => this.getCommandContext(),
    });
  }

  private getModeFeatureCommandRoutingDeps() {
    return buildModeFeatureCommandRoutingDepsFromMain({
      model: this.model,
      promptSelect: (question, choices, defaultValue) =>
        this.promptSelect(question, choices, defaultValue),
      logInfo: (message, details) => this.logInfo(message, details),
      syncSandboxMode: async (enabled: boolean) => {
        try {
          await this.sdkClient?.setSandboxMode(this.getSdkSessionId(), enabled);
        } catch (error) {
          this.logSdkSyncWarning('setSandboxMode from command', error, { enabled });
        }
      },
      syncTtsEnabled: (enabled: boolean) => {
        this.sdkClient?.setTTSEnabled?.(enabled);
      },
    });
  }

  private refreshAccountStatusForBanner(): void {
    const account = getCliEdition().account;
    if (!this.uiController || !account) return;
    account.refreshAccount(this.accountHost());
  }

  /** 账号插槽操作 CLI 运行态用的窄接口 (见 edition/index.ts CliAccountHost) */
  private accountHost(): CliAccountHost {
    return {
      reloadProviderState: () => {
        const fresh = reloadProviderStateForModernUiFromCli();
        this.userConfig = fresh.userConfig;
        this.providerStore = fresh.providerStore;
      },
      getProviderStore: () => this.providerStore,
      getProviderId: () => this.providerId,
      getProviderDisplayName: () => this.getProviderDisplayName(),
      switchProvider: (entry, model) => {
        this.providerSettings = entry;
        this.providerId = entry.id;
        this.provider = entry.protocol;
        this.model = model;
        this.refreshProviderSettings?.();
        this.uiController?.updateProvider?.(
          this.getProviderDisplayName(),
          model,
          this.getActiveReasoningEffort(model),
        );
      },
      clearModel: () => {
        this.model = '';
        this.uiController?.updateProvider?.(this.getProviderDisplayName(), '', undefined);
      },
      addInfo: (text, details, level) => this.uiController?.addInfo?.(text, details, level),
      setAccount: (text, tone) => this.uiController?.setAccount(text, tone),
      refreshHeader: () => this.uiController?.refreshTheme(),
      rebuildCompatProfile: () => this.rebuildCompatProfile(),
    };
  }

  private getMiscCommandRoutingDeps() {
    return buildMiscCommandRoutingDepsFromMain({
      sdkClient: this.sdkClient,
      getSdkSessionId: () => this.getSdkSessionId(),
      uiController: this.uiController,
      logInfo: (message, details) => this.logInfo(message, details),
      getConfigCommandContext: () => this.getConfigCommandContext(),
      getIndexCommandContext: () => this.getIndexCommandContext(),
      getContextCommandContext: () => this.getContextCommandContext(),
      getMemoryCommandContext: () => this.getMemoryCommandContext(),
      getInitCommandContext: () => this.getInitCommandContext(),
      getSetupCommandContext: () => this.getSetupCommandContext(),
      handleWorkspaceCommand: (workspaceArgs: string[]) => this.handleWorkspaceCommand(workspaceArgs),
      statistic: {
        promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
        userConfig: this.userConfig,
        uiController: this.uiController,
      },
      pricing: {
        userConfig: this.userConfig,
        promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
        acquirePromptLock: () => this.acquirePromptLock(),
        releasePromptLock: () => this.releasePromptLock(),
        uiController: this.uiController,
        updateConfig: (config) => {
          this.userConfig = config;
        },
      },
      stats: {
        workDir: this.workDir,
        providerDisplayName: this.getProviderDisplayName(),
        model: this.model,
        providerSettings: this.providerSettings,
        memoryLength: this.memory?.length ?? 0,
        toolsLength: this.tools.length,
        sessionRequests: this.sessionRequests,
        interactionMode: this.interactionMode,
        userConfig: this.userConfig,
        thinkingMode: this.thinkingMode,
        sdkClient: this.sdkClient,
        uiController: this.uiController,
      },
      getKernelDiagnostics: () => {
        // Direct access to runtime — only available in same-process mode
        // In client/server mode, this needs an SDK API endpoint
        return (this as any)._assistantRuntime?.getKernelDiagnostics?.() ?? null;
      },
    });
  }

  private getSessionProcessRoutingDeps() {
    return buildSessionProcessRoutingDepsFromMain({
      getCommandContext: () => this.getCommandContext(),
      getProcessCommandContext: () => createCommandOutputLinesCallbacks(this.uiController),
      model: this.model,
      isRunning,
      setAutoCompactionInProgress: (value) => {
        this.autoCompactionInProgress = value;
      },
    });
  }

  private async rebuildAgentAndRunner(): Promise<void> {
    await rebuildAgentAndRunnerFlow({
      hasProviderSettings: !!this.providerSettings,
      reloadBaseTools: async () => {
        this.baseTools = await getTools(this.workDir, this.platformServices);
      },
      refreshMcpTools: async () => {
        await this.loadMcpTools({ refresh: true });
      },
      resetMemoryPressureMonitor: () => {
        this.resetMemoryPressureMonitor();
      },
      sessionEnabled: this.sessionEnabled,
      hasCurrentSession: !!this.currentSession,
    });
  }

  private logInfo(message: string, details?: string): void {
    if (isCancelNotice(message)) return;
    if (this.uiController) {
      this.uiController.addInfo(message, details);
    } else {
      cliPrintln('');
      cliPrintln(colors.highlight(`  ${message}`));
      if (details) {
        cliPrintln(colors.dim(details));
      }
      cliPrintln('');
    }
  }

  private logSdkSyncWarning(action: string, error: unknown, details?: Record<string, any>): void {
    const message = error instanceof Error ? error.message : String(error);
    cliLogger.warn('CLI_SYNC', `${action} failed`, {
      ...details,
      message,
    });
  }

  private fireAndForgetSdkSync(action: string, promise?: Promise<unknown>, details?: Record<string, any>): void {
    promise?.catch((error) => {
      this.logSdkSyncWarning(action, error, details);
    });
  }

  private saveWorkspaceHistory(workspaces: string[]): void {
    saveWorkspaceHistoryIfChanged({
      workspaces,
      recentWorkspaces: this.userConfig.recentWorkspaces,
      persistRecentWorkspaces: (nextWorkspaces) => {
        this.userConfig = { ...this.userConfig, recentWorkspaces: nextWorkspaces };
        saveConfig(this.userConfig);
      },
    });
  }

  private async applyResolvedWorkspaceSwitch(resolvedPath: string): Promise<void> {
    await applyResolvedWorkspaceSwitchFromMain({
      resolvedPath,
      getWorkDir: () => this.workDir,
      homeDir: process.env.HOME || '',
      uiController: this.uiController,
      sessionEnabled: this.sessionEnabled,
      setWorkDir: (workDir) => {
        this.workDir = workDir;
      },
      applyProcessWorkDir: (workDir) => {
        process.chdir(workDir);
        process.env.NEOX_WORKDIR = workDir;
      },
      setActionLogWorkspace: async (workDir) => {
        await this.actionLog.setWorkspace(workDir);
      },
      setSdkWorkspace: (workDir) => {
        this.fireAndForgetSdkSync(
          'setWorkspace on workspace switch',
          this.sdkClient?.setWorkspace(workDir),
          { workDir },
        );
      },
      reloadBaseTools: async () => {
        this.baseTools = await getTools(this.workDir, this.platformServices);
      },
      ensureMcpTools: async () => {
        if (!this.mcpManager) {
          this.mcpManager = new MCPClientManager({ workDir: this.workDir });
        } else {
          this.mcpManager.setWorkDir(this.workDir);
        }
        await this.loadMcpTools({ refresh: true });
      },
      clearSdkMemory: () => {
        this.fireAndForgetSdkSync(
          'clearMemory on workspace switch',
          this.sdkClient?.clearMemory(this.getSdkSessionId()),
        );
      },
      resetSessionForWorkspace: async () => {
        const session = await this.sessionManager.createSession({ model: this.model });
        await this.activateSession(session, { loadHistory: false });
      },
    });
  }

  private async handleWorkspaceCommand(args: string[]): Promise<void> {
    await handleWorkspaceCommandFromMain({
      args,
      workDir: this.workDir,
      recentWorkspaces: this.userConfig.recentWorkspaces,
      homeDir: process.env.HOME || '',
      isTaskRunning: this.isTaskRunning,
      promptSelect: (question, choices, defaultValue) =>
        this.promptSelect(question, choices, defaultValue),
      promptText: (question, options) => this.promptText(question, options),
      logInfo: (message, details) => this.logInfo(message, details),
      saveWorkspaceHistory: (workspaces) => this.saveWorkspaceHistory(workspaces),
      applyResolvedWorkspace: (resolvedPath) =>
        this.applyResolvedWorkspaceSwitch(resolvedPath),
      setCommandOutputLines:
        this.uiController && typeof this.uiController.setCommandOutputLines === 'function'
          ? (lines: string[]) => {
            this.uiController!.setCommandOutputLines(lines);
          }
          : undefined,
    });
  }

  /**
   * Build command context for extracted command handlers
   */
  private getCommandContext(): CommandContext {
    return buildCommandContextFromMainState({
      sdkClient: this.sdkClient,
      uiController: this.uiController,
      colors,
      sessionEnabled: this.sessionEnabled,
      sessionManager: this.sessionManager,
      currentSession: this.currentSession,
      compatProfile: this.compatProfile,
      autoCompactionInProgress: this.autoCompactionInProgress,
      isTaskRunning: this.isTaskRunning,
      workDir: this.workDir,
      logInfo: (message: string, details?: string) => this.logInfo(message, details),
      activateSession: (session, options) => this.activateSession(session, options),
      normalizeCheckpoints,
      promptSelect: (question, choices, defaultValue) => this.promptSelect(question, choices, defaultValue),
      promptText: (question, options) => this.promptText(question, options),
    });
  }

  private getConfigCommandContext(): ConfigCommandContext {
    return buildConfigCommandContextFromMainState({
      approvalMode: this.approvalMode,
      userConfig: this.userConfig,
      promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
      logInfo: (m, d) => this.logInfo(m, d),
      cleanup: () => this.cleanup(),
      setApprovalMode: (mode) => {
        this.approvalMode = mode;
      },
      setCurrentMode: (mode) => {
        this.currentMode = mode;
      },
      syncSdkApprovalMode: async (mode, options) => {
        if (!this.sdkClient) {
          throw new Error('daemon SDK 还没连上, 审批模式只在 CLI 本地生效, 重启 neox 后 daemon 会从 config.json 读. 或者跑 /clear 重连.');
        }
        try {
          const sid = this.getSdkSessionId();
          await this.sdkClient.setApprovalMode(sid, mode, options);
          /* 同步成功后 (best-effort) 拉一次回来确认 daemon resolver 真到位.
           * 失败容忍 — 不阻塞 ack, 只是少一层信心. */
          try {
            const confirmed = await this.sdkClient.getApprovalMode?.(sid);
            // getApprovalMode 返回 { mode }, 不是裸字符串 — 原来 confirmed !== mode (对象 vs 字符串)
            // 恒为 true, 这条诊断警告每次全局 setApprovalMode 都误报。比对 confirmed.mode。
            if (confirmed && confirmed.mode !== mode && (!options || options.scope === 'global')) {
              cliLogger.warn('PERM_SET', `requested mode=${mode} but daemon returned ${confirmed.mode} — possible per-scope override masking global`);
            }
          } catch { /* getApprovalMode 可能 daemon 没实现, 不致命 */ }
        } catch (err: any) {
          this.logSdkSyncWarning('setApprovalMode from config command', err, { mode });
          throw new Error(`daemon RPC 失败: ${err?.message ?? err}. config.json 已写, 重启 neox 才能让 daemon 读到.`);
        }
      },
      updateConfig: (config) => {
        this.userConfig = config;
      },
    });
  }

  private getIndexCommandContext(): IndexCommandContext {
    return buildIndexCommandContextFromMainState({
      userConfig: this.userConfig,
      workDir: this.workDir,
      promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
      logInfo: (m, d) => this.logInfo(m, d),
      updateConfig: (config) => {
        this.userConfig = config;
      },
    });
  }

  private getContextCommandContext(): ContextCommandContext {
    return buildContextCommandContextFromMainState({
      userConfig: this.userConfig,
      promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
      logInfo: (m, d) => this.logInfo(m, d),
      updateConfig: (config) => {
        this.userConfig = config;
      },
      uiController: this.uiController,
      memoryPressure: this.memoryPressure,
      updateCompactionThreshold: (thresholdPercent) => this.updateCompactionThreshold(thresholdPercent),
      syncCompressionMode: (mode) => {
        this.fireAndForgetSdkSync(
          'setCompressionMode from context command',
          this.sdkClient?.setCompressionMode(this.getSdkSessionId(), mode),
          { mode },
        );
      },
    });
  }

  private getMemoryCommandContext(): MemoryCommandContext {
    return buildMemoryCommandContextFromMainState({
      actionLog: this.actionLog,
      userConfig: this.userConfig,
      promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
      promptText: (q, o) => this.promptText(q, o),
      logInfo: (m, d) => this.logInfo(m, d),
      updateConfig: (config) => {
        this.userConfig = config;
      },
      uiController: this.uiController,
    });
  }

  private getInitCommandContext(): InitCommandContext {
    return buildInitCommandContextFromMainState({
      workDir: this.workDir,
      actionLog: this.actionLog,
      promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
      logInfo: (m, d) => this.logInfo(m, d),
      setStatusText: (text: string) => {
        // Init progress must not own turn lifecycle (updateStatus is text-only; still use info).
        if (this.uiController) {
          this.uiController.updateStatus(text, 'info');
        }
      },
      providerSettings: this.providerSettings,
      model: this.model,
    });
  }

  private getSetupCommandContext(): SetupCommandContext {
    return buildSetupCommandContextFromMainState({
      logInfo: (m: string, d?: string) => this.logInfo(m, d),
      promptSelect: async <T extends string>(q: string, c: Array<{ label: string; value: T; description?: string }>, d?: string) =>
        this.promptSelect(q, c as SelectionChoice[], d) as Promise<T>,
      promptText: (label: string, opts?: TextPromptOptions) => this.promptText(label, opts),
      handleCommand: async (cmd: string) => {
        await this.handleCommand(cmd);
      },
      current: { provider: this.getProviderDisplayName(), model: this.model },
    });
  }

  private getRemoteCommandContext(): RemoteCommandContext {
    return buildRemoteCommandContextFromMainState({
      userConfig: this.userConfig,
      promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
      promptText: (q, o) => this.promptText(q, o),
      logInfo: (m, d) => this.logInfo(m, d),
      updateConfig: (config) => {
        this.userConfig = config;
      },
      startRemote: () => this.startRemoteServer(),
      stopRemote: () => this.stopRemoteServer(),
      regenerateToken: () => this.regenerateRemoteToken(),
      getStatus: () => this.getRemoteStatus(),
      uiController: this.uiController,
    });
  }

  private getSupervisorCommandContext(): SupervisorCommandContext {
    return buildSupervisorCommandContextFromMainState({
      userConfig: this.userConfig,
      logInfo: (m, d) => this.logInfo(m, d),
      updateConfig: (config) => {
        this.userConfig = config;
      },
    });
  }

  private getRunConfigCommandContext(): RunConfigCommandContext {
    return buildRunConfigCommandContextFromMainState({
      userConfig: this.userConfig,
      promptSelect: (q, c, d, h) => this.promptSelect(q, c, d, h),
      promptText: (q, o) => this.promptText(q, o),
      providerStore: this.providerStore,
      activeProviderId: this.providerId,
      model: this.model,
      remoteAdapter: this.remoteAdapter,
      logInfo: (m, d) => this.logInfo(m, d),
      updateConfig: (config) => {
        this.userConfig = config;
      },
      workDir: this.workDir,
      readFile: (path: string) => readUtf8FileOrNull(path),
      listDir: (path: string) => listDirOrEmpty(path),
    });
  }

}

/** 未知 slash 命令 → 就近建议: 前缀匹配优先 (取最短命中), 其次编辑距离 ≤2; 无候选返回 null. */
function suggestSlashCommand(input: string): string | null {
  const raw = input.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const name = raw.startsWith('/') ? raw.slice(1) : raw;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return null;
  const candidates = getSlashCommands().map((c) => c.name.slice(1));
  const prefixed = candidates.filter((c) => c.startsWith(name));
  if (prefixed.length > 0) {
    return '/' + prefixed.sort((a, b) => a.length - b.length)[0];
  }
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best && bestDist <= 2 ? '/' + best : null;
}

async function main() {
  profileCheckpoint('main_function_start');

  try {
    const r = applySystemProxySync();
    if (r.detected) {
      /* 走 cliLogger 不走 stdout —— 有代理的用户每次启动都会在 banner 前冒一行内部日志 */
      cliLogger.info('CLI', `systemProxy: source=${r.source} http=${r.httpProxy || '-'} https=${r.httpsProxy || '-'}`
        + ` socks=${r.socksProxy || '-'} pac=${r.pacUrl || '-'}`);
    }
    startSystemProxyWatch(30000);
  } catch (err) {
    cliLogger.error('CLI', `systemProxy 安装失败 — 将直连, 需要代理才能联网的用户会看到 fetch failed: ${(err as any)?.message ?? err}`);
  }

  /* DB master key —— 必须在任何人打开 SQLite 之前 await 完。
   * 当前启动路径只预热 machine-id 派生 key, 不访问系统 Keychain。
   * 失败不抛, 数据库初始化会按现有密钥不可用的保护路径处理。 */
  try {
    await bootstrapMasterKey();
  } catch (err) {
    cliLogger.error('CLI', `masterKey bootstrap 失败 — 将按回落 key 开库: ${(err as any)?.message ?? err}`);
  }

  if (shouldUsePrintMode(process.argv.slice(2))) {
    profileCheckpoint('print_mode_detected');
    const options = parsePrintArgs(process.argv.slice(2));
    const exitCode = await runPrintMode(options);
    printProfileSummary();
    await drainStdout();
    process.exit(exitCode);
  }

  void preconnectFromConfig();
  profileCheckpoint('api_preconnect_initiated');

  const entryResult = await runCliMainEntryFlow({
    cliVersion: CLI_VERSION,
    parseArgs: () => parseArgs(),
    handleEarlyCliSubcommands: async (rawArgs) => handleEarlyCliSubcommands(rawArgs),
    handleEarlyProcessArgs: async (args, cliVersion) => handleEarlyProcessArgs(args, cliVersion),
    runProviderSetupFlowIfNeeded: async () => runProviderSetupFlowIfNeeded(),
    ensureProviderConfigured: async () => ensureProviderConfigured(),
    createCli: (args) => new NeoxCLI(args.model, args.workDir, args.provider, args),
    setActiveCliInstance: (cli) => {
      activeCliInstance = cli;
    },
  });

  profileCheckpoint('main_entry_flow_done');

  if (typeof entryResult.exitCode === 'number') {
    printProfileSummary();
    process.exit(entryResult.exitCode);
  }

  printProfileSummary();
}

/**
 * 退出前把 stdout 排空。
 *
 *   process.stdout 指向管道时是**异步**写, 指向 TTY 时是同步写。process.exit() 不等
 *   pending 写完成 —— 管道场景下缓冲区里的内容直接随进程消失。
 *   写一个空片段并等它的回调, 即可确认此前所有数据都已交付内核。
 *   2s 上限: 万一下游不读 (管道满/对端卡住), 宁可少等也不能让 CLI 挂住不退。
 */
async function drainStdout(): Promise<void> {
  if ((process.stdout as any).writableLength === 0) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(done, 2000);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    try { process.stdout.write('', () => { clearTimeout(timer); done(); }); }
    catch { clearTimeout(timer); done(); }
  });
}

registerCliFallbackHandlers({
  isInkUIActive: () => isInkUIActive,
  getActiveCliInstance: () => activeCliInstance,
});

// 这是最后的保底，exitWithCleanup 已显示过则跳过
process.on('exit', () => {
  if (sessionSummaryShown) return;
  try {
    const sessionId = activeCliInstance?.getSessionId();
    const summary = generateSessionSummary(sessionId);
    if (summary) {
      process.stdout.write('\n' + summary + '\n');
    }
  } catch (err: any) { cliLogger.debug('CLI', `Exit session summary failed: ${err?.message}`); }
});

if (process.env.NEOX_WORKER === 'server') {
  try {
    await import('@neoxlabs/core/server/main.js');
  } catch (e: any) {
    try { require('node:fs').writeSync(2, `[SERVER MODULE LOAD FATAL] ${e?.stack || e?.message || String(e)}\n`); } catch { /* ignore */ }
    process.exit(1);
  }
} else {
  const workerExitCode = await runExecuteShellWorkerIfNeeded();
  if (typeof workerExitCode !== 'number') {
    runMainWithFatalCatch(main);
  }
}
