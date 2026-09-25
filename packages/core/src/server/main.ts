/**
 * Neox Server — 独立进程入口
 *
 * 用法: node dist/server/main.js --port 4399 --workdir /path/to/project
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { pauseSession, resumeSession } from '../runtime/pauseController.js';
import { readAvailableCloudImageModels } from '../platform/membershipCacheRead.js';
import { resolveSubAgentSessionOrigin } from '../platform/subAgentSessionOrigin.js';
import { isNeoxManagedApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { resolveProviderEntry } from '@neoxlabs/platform/platform/providerResolver.js';
import { randomBytes } from 'node:crypto';
import { resolve as pathResolve, dirname as pathDirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, createWriteStream, writeSync as fsWriteSync, appendFileSync as fsAppendFileSync } from 'node:fs';
import { createRequire as _createRequireForNative } from 'node:module';
import { createNeoxServer, type RuntimeBridge, type RunStateSnapshot } from './index.js';
import { EventBus } from './eventBus.js';
import { DeviceManager } from './middleware/device.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { createNodeServices } from '@neoxlabs/platform/platform/nodeServices.js';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { scheduleServiceInstanceReconcile } from './bootReaper.js';
import { buildSnapshot } from '../runtime/services/serviceSnapshot.js';
import { attachServiceEnrichment } from '../tools/shell/backgroundProcessEnrichment.js';
import { ModeFactory, type AgentRunMode } from '../runtime/modeFactory.js';
import { loadConfig, getDefaultServerPort } from '@neoxlabs/platform/utils/config.js';
import { buildMemory } from '../runtime/runtimeBuilder.js';
import {
  getTools,
  setSandboxEnabled,
} from '../tools/runtimeTools.js';
import { RuntimeCheckpointService } from '../runtime/checkpoint/runtimeCheckpointService.js';
import { PermissionManager, applyDefaultToolPermissions } from '@neoxlabs/kernel/core/permissions/index.js';
import { createFilePermissionStorage } from '../core/permissions/filePermissionStorage.js';
import { ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { buildInstructions } from '../runtime/systemPrompt.js';
import type { AgentRuntimeEvent } from '../runtime/runtimeTypes.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type { Message, Tool } from '@neoxlabs/kernel/types/index.js';
import { ActionLogService } from '../platform/actionLog/index.js';
import { TTSService } from '../services/ttsService.js';
import {
  resolveUserQuestion,
  formatAnswersForResume,
} from '../tools/askUserTool.js';
import { getPendingAskUserStore } from '../runtime/store/PendingAskUserStore.js';
import { SessionContext } from '@neoxlabs/platform/platform/sessionContext.js';
import { runWithChatSession } from '../runtime/shell/chatSessionContext.js';
import { setWakeupTriggerHandler } from '../runtime/shell/scheduledWakeupRegistry.js';
import { setCronFireCallback, startCronScheduler, setCronWorkspaceRoot } from '../tools/cronTools.js';
import { setBgTaskAutoResumeHandler, setBgTaskSessionActiveCheck, getBackgroundTaskNotifier } from '../runtime/shell/backgroundTaskNotifier.js';
import { setTurnStallHandlers } from '../runtime/resilience/turnStallGuard.js';
import { getInflightStalls } from '@neoxlabs/kernel/utils/stallGuard.js';
import {
  sendShellStdin as sendShellStdinViaHelper,
  resizeShell as resizeShellViaHelper,
  executeShellInWorker,
} from '../tools/shell/shellWorkerClient.js';
import { ensureCommandHelperRunning } from '../tools/commandHelperClient.js';
import { getShellOutputStreamCallback } from '../tools/shell/shellUiCallbacks.js';
import { deriveFriendlyName } from '@neoxlabs/platform/platform/processFriendlyName.js';
import { removePidFile } from './pidFile.js';
import { getActiveSseClients, getLastActivityTs } from './serverActivity.js';
export { readPidFile, type PidInfo } from './pidFile.js';
import { MCPClientManager } from '../mcp/index.js';
import { VERSION } from '@neoxlabs/kernel/version.js';
import { ApprovalModeResolver } from './services/approvalModeResolver.js';
import { ProviderResolver } from './services/providerResolver.js';
import { createMcpBridgeHandlers } from './services/mcpBridgeHandlers.js';
import { syncMcpTools, autoConnectMcpInBackground } from '../mcp/syncMcpTools.js';
import { createIndexBridgeHandlers } from './services/indexBridgeHandlers.js';
import { createSkillsBridgeHandlers } from './services/skillsBridgeHandlers.js';
import { dispatchChatByMode } from './services/chatModeDispatcher.js';
import { createChatEventPublisher } from './services/chatEventPublisher.js';
import { prepareChatRequest } from './services/chatRequestPreparation.js';
import { abortSession } from './services/sessionAborter.js';
import { toModelId } from './services/modelIdNormalize.js';
import { resolveSessionMemory } from './services/sessionMemoryResolver.js';
import { setApprovalMode as setApprovalModeHandler } from './services/approvalModeSetter.js';
import { compactSession as compactSessionHandler } from './services/sessionCompactor.js';
import { createToolWorkspaceBridgeHandlers } from './services/toolWorkspaceBridgeHandlers.js';
import { createCheckpointBridgeHandlers } from './services/checkpointBridgeHandlers.js';
import { createHostBridgeHandlers } from './services/hostBridgeHandlers.js';
import { createTTSBridgeHandlers } from './services/ttsBridgeHandlers.js';
import { createSTTBridgeHandlers } from './services/sttBridgeHandlers.js';
import { setupRuntimeBridgeCallbacks, type PendingPermissionEntry } from './services/runtimeBridgeSetup.js';
import { SessionWaitingRegistry, type WaitingKind } from './services/sessionWaitingRegistry.js';
import { createRuntimeInstances } from './services/runtimeInstanceFactory.js';
import { setupChannelAdapters } from './services/channelBootstrap.js';
import { buildServerConfig, resolveServerHostname } from './services/serverConfigFactory.js';
import { setupSkillsHotReload } from './services/skillsBootstrap.js';
import { initProjectInstructions, refreshProjectInstructions } from '@neoxlabs/kernel/core/projectInstructions.js';
import { startServerLifecycle } from './services/serverLifecycle.js';
import { runResumeScanner } from '../runtime/resume/resumeScanner.js';
import { InterruptedRunStore } from '../runtime/store/InterruptedRunStore.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { initTTSIfEnabled } from './services/ttsSetup.js';
import { setupImageGenResolvers } from './services/imageGenSetup.js';
import { SessionManager } from './sessionManager.js';
import { attachWSGateway } from './wsGateway.js';
import { sharedJevToolPreloader } from '../runtime/jev/sharedJevToolPreloader.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

// ============================================================================
// HMAC native 加载 — server 进程入口挂 globalThis.__NEOX_NATIVE__
//   loadAutoHmacSigner (neox-kernel/openai.ts) 优先读 globalThis.__NEOX_NATIVE__, 回落 bare require。
//   server 入口没挂 → daemon 靠 bundle 里的 bare require, 在某些打包/路径情形下飘 →
//   "HMAC signer unavailable" → 云端 chat 全挂。这里入口显式加载, 跟 CLI 入口对齐, 杜绝不确定性。
//   失败不崩 (BYOK / 缺平台 .node 时 signer 降级返 null)。
// ============================================================================
try {
  const _req = _createRequireForNative(import.meta.url);
  try {
    (globalThis as any).__NEOX_NATIVE__ = _req('@neoxlabs/native/neox-native.node');
  } catch {
    (globalThis as any).__NEOX_NATIVE__ = _req('@neoxlabs/native');
  }
} catch { /* optional — signer 缺失时 loadAutoHmacSigner 自身 catch 返 null */ }

// ============================================================================
// Daemon 模式 stdout/stderr 重定向
// 在 Electron 主进程中, Chromium 的 fd 清理逻辑会关闭 libuv 不认识的 fd,
// 导致 posix_spawn 时 EBADF (errno -9). 解法: 子进程自己在这里打开日志文件
// 并重定向 stdout/stderr, 父进程完全不碰 fd.
// ============================================================================

if (process.env.NEOX_DAEMON === '1' && process.env.NEOX_LOG_FILE) {
  const logFile = process.env.NEOX_LOG_FILE;
  try {
    mkdirSync(pathDirname(logFile), { recursive: true });
  } catch { /* ignore — dir already exists */ }
  const logStream = createWriteStream(logFile, { flags: 'a' });
  // Node.js 22+ 中 process.stdout/stderr 是 getter-only, 不能直接赋值.
  // 改为 override write 方法, 这样 console.log/cliLogger 等所有输出都会进日志文件.
  const makeWriter = (orig: NodeJS.WriteStream['write']) =>
    function (this: NodeJS.WriteStream, chunk: any, enc?: any, cb?: any) {
      logStream.write(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    } as typeof orig;
  process.stdout.write = makeWriter(process.stdout.write);
  process.stderr.write = makeWriter(process.stderr.write);
}

// ============================================================================
// 参数解析
// ============================================================================

function parseServerArgs(): { port: number; workDir: string; daemon: boolean; identityDir?: string } {
  const args = process.argv.slice(2);
  let port = getDefaultServerPort();
  let workDir = process.cwd();
  let daemon = false;
  let identityDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--workdir' && args[i + 1]) {
      workDir = args[i + 1];
      i++;
    } else if (args[i] === '--identity-dir' && args[i + 1]) {
      /* 本端身份目录 (auth.enc/gateway-key.enc 所在) — server 据此现取网关凭据 (阶段2)。 */
      identityDir = args[i + 1];
      i++;
    } else if (args[i] === '--daemon') {
      daemon = true;
    }
  }

  return { port, workDir, daemon, identityDir };
}

// ============================================================================
// ============================================================================
// 子 agent 运行中事件走内存镜像 (__subAgentMirror, sessionId=子会话, 进 '*')。
// 桌面 SSE / LocalRuntimeAdapter 订 '*' 收直播; CLI 按标记跳过, 避免和 Explorer 卡翻倍。
// 落盘只服务冷启动 (关 app 再点开已结束的子会话), 不替代直播:
//   · tool_call_end → tool_call 卡 (name/summary/output 预览)
//   · token/text 增量攒 buffer, text_complete/run_result 时落一条 assistant_message
//   · user_message_injected (send_message 注入) → user_message, 剥 XML 壳标"主 Agent"
// per-subSid promise 链串行化写入, 防 read-modify-write 竞态。

const subAgentPersistChains = new Map<string, Promise<void>>();
const subAgentTextBuffers = new Map<string, string>();
/** 当前这段文本从什么时候开始攒的 —— 攒太久要先落一段, 别让子会话干等 */
const subAgentTextSince = new Map<string, number>();
const subAgentTextSlots = new Map<string, Promise<{ id: string; sequence: number } | null>>();
/** 文本分段落盘间隔 */
const SUB_TEXT_FLUSH_MS = Math.max(1000, Number(process.env.NEOX_SUB_AGENT_TEXT_FLUSH_MS) || 3000);

/**
 * 落一条子会话 timeline。
 *
 * @param slotPromise 传了就是改写已有那条 (工具 start → end 用同一行), 否则新增。
 * @returns 这条最终占的 (id, sequence) —— 调用方拿它做后续改写。
 *
 * 写入仍然按 subSid 串行 (subAgentPersistChains), 所以 slot 的读写不会打架。
 */
function queueSubAgentTimelinePersist(
  subSid: string,
  entry: Record<string, any>,
  slotPromise?: Promise<{ id: string; sequence: number } | null>,
): Promise<{ id: string; sequence: number } | null> {
  const prev = subAgentPersistChains.get(subSid) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const storeMod: any = await import('../platform/sessionStore.js');
      const existing = slotPromise ? (await slotPromise.catch(() => null)) : null;
      const slot = await storeMod.sessionStore.appendSubAgentTimelineEntry(subSid, entry, existing ?? undefined);
      if (slot) notifySubAgentTimelineUpdated(subSid);
      return slot;
    })
    .catch((err: any) => {
      cliLogger.warn('SUB_AGENT', `persist timeline entry failed for ${subSid}: ${err?.message ?? err}`);
      return null;
    });
  subAgentPersistChains.set(subSid, next.then(() => undefined));
  return next;
}

/* ── 子会话 timeline 落盘通知 ─────────────────────────────────────────────
 * 直播走 __subAgentMirror (sessionId=子会话, 进 '*')。这条低频提示只给「子会话
 * 没在跑、直播已经停了」时补一次 DB 快照 —— 还在跑时 renderer 不许用它整表
 * 覆盖, 否则会把正在流式写入的卡片打成静照。 */
const SUB_TIMELINE_NOTIFY_MS = 1000;
const subAgentTimelineNotifyAt = new Map<string, number>();
let subAgentTimelineBus: { publish: (e: any) => void } | null = null;

function notifySubAgentTimelineUpdated(subSid: string): void {
  if (!subAgentTimelineBus) return;
  const now = Date.now();
  if (now - (subAgentTimelineNotifyAt.get(subSid) ?? 0) < SUB_TIMELINE_NOTIFY_MS) return;
  subAgentTimelineNotifyAt.set(subSid, now);
  try {
    subAgentTimelineBus.publish({
      sessionId: subSid,
      type: 'sub_agent_timeline_updated',
      data: { type: 'sub_agent_timeline_updated', childSessionId: subSid },
      timestamp: now,
    });
  } catch { /* 通知失败不影响落盘 */ }
}

/* 每个子会话里"已经开始、还没结束"的工具行 —— tool_call_end 回来时按工具名认领同一行改写。
 *
 *   tool_call_start 事件不带 toolId (只有 end 带), 所以按 **工具名 + 先进先出** 配对:
 *   顺序执行天然对得上; 并行同名工具最坏情况是两行内容互换, 仍然不会多印一行, 也不会丢。
 *   认领不到就退化成"直接插一条完成态", 跟改之前一样。 */
const subAgentOpenTools = new Map<string, Array<{
  name: string;
  slot: Promise<{ id: string; sequence: number } | null>;
}>>();

function claimOpenToolSlot(subSid: string, name: string) {
  const list = subAgentOpenTools.get(subSid);
  if (!list?.length) return undefined;
  const idx = list.findIndex(x => x.name === name);
  const picked = idx >= 0 ? list.splice(idx, 1)[0] : list.shift();
  if (!list.length) subAgentOpenTools.delete(subSid);
  return picked?.slot;
}

/** send_message 注入的 XML 包裹解析 — 展示层剥壳, 模型看到的原文不动 */
function parseSendMessageEnvelope(text: string): { from: string; body: string } | null {
  const m = /^\s*<send_message from="([^"]*)">\s*([\s\S]*?)\s*<\/send_message>\s*$/.exec(text || '');
  return m ? { from: m[1] || 'main_agent', body: m[2] || '' } : null;
}

const subAgentUsage = new Map<string, { total: number; latest: number; dirty: boolean }>();

function recordSubAgentUsage(subSid: string, event: any): void {
  const reqTotal = Number(event?.totalTokens ?? event?.usage?.total_tokens) || 0;
  if (reqTotal <= 0) return;
  const cur = subAgentUsage.get(subSid) ?? { total: 0, latest: 0, dirty: false };
  /* total = 逐次请求累加 (= UI 的"共消耗"口径); latest = 最后一次请求的总量 (= 当前上下文占用) */
  cur.total += reqTotal;
  cur.latest = reqTotal;
  cur.dirty = true;
  subAgentUsage.set(subSid, cur);
}

function flushSubAgentUsage(subSid: string): void {
  const cur = subAgentUsage.get(subSid);
  if (!cur || !cur.dirty) return;
  cur.dirty = false;
  const prev = subAgentPersistChains.get(subSid) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const storeMod: any = await import('../platform/sessionStore.js');
      await storeMod.sessionStore.updateSessionMetadata(subSid, {
        totalTokens: cur.total,
        contextUsed: cur.latest,
      });
    })
    .catch((err: any) => {
      cliLogger.warn('SUB_AGENT', `persist usage failed for ${subSid}: ${err?.message ?? err}`);
    });
  subAgentPersistChains.set(subSid, next);
}

function flushSubAgentTextBuffer(subSid: string, close = true): void {
  const buf = (subAgentTextBuffers.get(subSid) ?? '').trim();
  if (close) {
    subAgentTextBuffers.delete(subSid);
    subAgentTextSince.delete(subSid);
  }
  if (!buf) {
    if (close) subAgentTextSlots.delete(subSid);
    return;
  }
  const slot = queueSubAgentTimelinePersist(
    subSid,
    { type: 'assistant_message', title: 'Agent', detail: buf },
    subAgentTextSlots.get(subSid),
  );
  if (close) subAgentTextSlots.delete(subSid);
  else subAgentTextSlots.set(subSid, slot);
}

function persistSubAgentRuntimeEvent(subSid: string, event: any): void {
  try {
    const t = event?.type;
    if (t === 'token' || t === 'text') {
      const delta = typeof event.content === 'string' ? event.content
        : typeof event.delta === 'string' ? event.delta : '';
      if (delta) {
        const cur = subAgentTextBuffers.get(subSid) ?? '';
        /* 单段文本软上限 20k 字符 — UI 展示够用, 防长独白撑内存 (final 全文另有 appendSubAgentResult) */
        if (cur.length < 20_000) {
          subAgentTextBuffers.set(subSid, cur + delta);
        }
        if (!subAgentTextSince.has(subSid)) subAgentTextSince.set(subSid, Date.now());
        /* 攒够 SUB_TEXT_FLUSH_MS 就先落一段 —— 只在工具边界 flush 的话, 一个"先想很久
         * 再调工具"的子 agent 在那段时间里子会话仍然是空的。改写同一行, 越刷越长。 */
        if (Date.now() - (subAgentTextSince.get(subSid) ?? 0) >= SUB_TEXT_FLUSH_MS) {
          subAgentTextSince.set(subSid, Date.now());
          flushSubAgentTextBuffer(subSid, false);
        }
      }
    } else if (t === 'text_complete' || t === 'run_result') {
      /* 防御分支: 这两个类型目前被 agenticRuntime.onTaskAgentEvent 拦截不会冒泡上来
       * (session 生命周期事件跨会话无意义), 真正的 flush 边界在 tool_call_end 和
       * lifecycle done 的 flushSubAgentPersistState。保留以防将来放开拦截。 */
      flushSubAgentTextBuffer(subSid);
    } else if (t === 'token_usage') {
      recordSubAgentUsage(subSid, event);
    } else if (t === 'tool_call_start') {
      flushSubAgentTextBuffer(subSid);
      const slot = queueSubAgentTimelinePersist(subSid, {
        type: 'tool_call',
        title: event.name || 'tool',
        toolName: event.name,
        detail: typeof event.description === 'string' ? event.description : '',
        targetPath: event.targetPath,
        toolArgs: event.args,
        pending: true,
      });
      const list = subAgentOpenTools.get(subSid) ?? [];
      list.push({ name: event.name || 'tool', slot });
      subAgentOpenTools.set(subSid, list);
    } else if (t === 'tool_call_end') {
      /* 文本→工具交替是子 agent 的自然节奏: 工具结束时先把前面的说话落盘, 保持顺序 */
      flushSubAgentTextBuffer(subSid);
      flushSubAgentUsage(subSid);
      queueSubAgentTimelinePersist(subSid, {
        type: 'tool_call',
        title: event.name || 'tool',
        toolName: event.name,
        pending: false,
        detail: typeof event.summary === 'string' ? event.summary : '',
        output: typeof event.output === 'string' ? event.output.slice(0, 2000) : undefined,
        targetPath: event.targetPath,
        toolArgs: event.args,
        errorMessage: event.success === false
          ? (typeof event.toolError === 'string' ? event.toolError : 'failed')
          : undefined,
      }, claimOpenToolSlot(subSid, event.name || 'tool'));
    } else if (t === 'user_message_injected') {
      const text = typeof event.text === 'string' ? event.text : '';
      if (!text) return;
      const envelope = parseSendMessageEnvelope(text);
      queueSubAgentTimelinePersist(subSid, {
        type: 'user_message',
        title: envelope ? '主 Agent' : 'User',
        detail: envelope ? envelope.body : text,
        messageSource: envelope ? 'agent-to-agent' : 'desktop',
      });
    }
  } catch { /* 持久化失败不影响事件流 */ }
}

/** sub-agent 结束: 把残留文本 buffer 落盘 (run_result 不冒泡, 这是最终 flush 点) */
function flushSubAgentPersistState(subSid: string): void {
  flushSubAgentTextBuffer(subSid);
  flushSubAgentUsage(subSid);
  subAgentUsage.delete(subSid);
  /* 收尾时把还挂着 pending 的工具行收掉 —— 子 agent 被判死/报错时 tool_call_end
   * 可能永远不来, 不收的话那一行会**永远转圈**, 用户以为还在跑。 */
  const open = subAgentOpenTools.get(subSid);
  subAgentOpenTools.delete(subSid);
  for (const item of open ?? []) {
    queueSubAgentTimelinePersist(subSid, {
      type: 'tool_call',
      title: item.name,
      toolName: item.name,
      pending: false,
      errorMessage: '未完成 — 子 agent 在这一步结束前就停止了',
    }, item.slot);
  }
}

// ============================================================================
// Runtime 初始化
// ============================================================================

export async function initRuntimeBridge(
  workDir: string,
  bus: EventBus,
  /** 宿主特性开关。oneShot=true 表示宿主跑完一个 turn 就退 (`neox -p`), 见 allowBackgroundAgents。 */
  hostOptions?: { oneShot?: boolean },
): Promise<RuntimeBridge> {
  const config = loadConfig();
  const isElectron = !!(process.versions as any)?.electron;
  const platformServices = createNodeServices();
  if (isElectron) {
    (platformServices as any).capabilities = { ...platformServices.capabilities, gui: true, editor: true };
  }
  try {
    await platformServices.shellEnv.preloadShellEnv();
    cliLogger.info('SERVER', 'Shell environment preloaded for runtime tools');
  } catch (error: any) {
    cliLogger.warn('SERVER', `Shell environment preload failed: ${error?.message || String(error)}`);
  }
  const providerResolver = new ProviderResolver(config);
  let mcpManager: MCPClientManager | null = null;
  try {
    mcpManager = new MCPClientManager({ workDir });
    mcpManager.setEnabled(config.mcp?.enabled ?? false);
  } catch (err: any) { cliLogger.debug('SERVER', `MCP manager init failed: ${err?.message}`); }
  const approvalModeResolver = new ApprovalModeResolver(config);
  /* 把生效的审批模式打出来 —— "我明明配了 dangerous 怎么还在弹审批" 这类问题, 没有这行
   * 就得一路翻到 PermissionManager 才能确认到底解析成了什么。同时把两个来源字段一起打,
   * 一眼能看出是配置没读到, 还是被 env / per-session 覆盖了。 */
  cliLogger.info(
    'SERVER',
    `approval mode 生效值=${approvalModeResolver.getGlobalMode()} `
    + `(config.agentApprovalMode=${config.agentApprovalMode ?? '-'}, config.approvalMode=${config.approvalMode ?? '-'}, `
    + `env.NEOX_FORCE_APPROVAL_MODE=${process.env.NEOX_FORCE_APPROVAL_MODE ?? '-'})`,
  );
  try {
    const persisted = getDatabase().listSessionApprovalModes();
    let seeded = 0;
    for (const { sessionId, mode } of persisted) {
      if (mode === 'auto' || mode === 'manual' || mode === 'dangerous') {
        approvalModeResolver.setScopedMode(sessionId, mode);
        seeded++;
      }
    }
    if (seeded > 0) cliLogger.info('SERVER', `Seeded ${seeded} per-session approval mode(s) from DB`);
  } catch (err: any) {
    cliLogger.warn('SERVER', `seed approval modes from DB failed: ${err?.message || String(err)}`);
  }

  // Server process通过 SSE 向 CLI 派发审批请求
  const permissionManager = new PermissionManager({
    // 默认 ALLOW —— 白名单驱动. 只有 applyDefaultToolPermissions 里显式登记 ASK 的工具
    // (write_file / edit / execute_bash 等) 才弹审批; 其余 agent-pack 内部工具
    // (open_surface / update_plan / list_surfaces / browser_*) 透传放行.
    //
    // 会被 ASK 兜底劫持成弹窗轰炸, 体验崩盘. 反过来: 默认 ALLOW + 白名单 ASK 才是 CC/Codex
    // 在用的模型 (新增的危险工具必须显式登记到 defaultPermissions.ts 才能进 ASK).
    defaultPermission: ToolPermission.ALLOW,
    scopeModeResolver: (scopeKey) => approvalModeResolver.resolveByScope(scopeKey),
    storage: createFilePermissionStorage(),
  });
  applyDefaultToolPermissions(permissionManager);

  const resolveProvider = (providerId?: string, modelName?: string) =>
    providerResolver.resolve(providerId, modelName);

  // Memory
const memory: ShortTermMemory = buildMemory();

  // ActionLog（长期记忆）
  const actionLog = new ActionLogService({
    workspacePath: workDir,
    source: 'server',
    agentName: 'Neox Server',
  });

  const ttsService = new TTSService(config.tts ?? { enabled: false });

  // Tools
  const tools: Tool[] = await getTools(workDir, platformServices, actionLog);

  {
    const n = await syncMcpTools(tools, mcpManager);
    if (n > 0) cliLogger.info('MCP', `${n} MCP tool(s) merged into agent tool table`);
  }
  autoConnectMcpInBackground(tools, mcpManager); // 「启动时自动连接」: 后台连, 不挡启动

  /* 服务化 enrichment (RunConfig auto-bind / healthcheck / 端口探测) 挂到 ProcessManager 的
   * process:start 上 —— 挂一次, 覆盖所有 spawn 路径。
   *
   * 挂在这里而不是 electron main: 同 projectInstructions 的理由, initRuntimeBridge 才是
   * 桌面 / daemon / CLI 进程内 / CLI worker 四条入口的汇合处, 挂在 electron main 只能覆盖桌面。
   * (autoRestart 现在就挂错在 electron main, R1 一并处理。) */
  attachServiceEnrichment(processManager, cliLogger as any);

  const projectInstructions = await initProjectInstructions(workDir);
  if (projectInstructions.sources.length > 0) {
    cliLogger.info(
      'SERVER',
      `Project instructions active (${projectInstructions.sources.length} file(s), ` +
      `hash ${projectInstructions.contentHash.substring(0, 8)}): ` +
      projectInstructions.sources.map(s => `${s.path} (${s.lines} lines)`).join(', '),
    );
  } else {
    cliLogger.debug('SERVER', `No project instructions found under ${workDir} (this is normal)`);
  }

  // System prompt
  /* skipEnvironment: env (含 git status 等动态信息) 由 agenticRuntime 在每次组装 prompt 时
   * lazy 注入. 历史问题: 启动期跑 `git status --porcelain` 阻塞 server health-ready 最长 9s,
   * 不同 cwd 退化曲线不同 → 用户感受为"敲 neox 卡数秒". 详见 prompts/layers/index.ts 顶部注释. */
  const userLanguage: 'zh' | 'en' = (() => {
    try {
      const { loadConfig } = require('@neoxlabs/platform/utils/config.js');
      return loadConfig()?.language === 'en' ? 'en' : 'zh';
    } catch { return 'zh'; }
  })();
  const instructions = buildInstructions({ workDir, skipEnvironment: true, language: userLanguage });
  const systemPrompt = typeof instructions === 'string' ? instructions : '';

  /* 默认 provider —— **拿不到不能让 server 死掉**。
   *
   * getDefaultProvider 在"默认是云端但没有网关凭据"时会抛
   * (NeoxRoutingError: Neox Cloud 网关凭据缺失)。而"还没登录"本来就是完全正常的状态:
   * 极简版首次启动、用户登出之后都是。抛上去的后果是 [SERVER FATAL] 进程退出,
   * 客户端连界面都起不来 —— 而用户正是要进界面去登录或切 BYOK 才能修好它。
   * 起不来就更没法自救, 这是个死锁。
   *
   * 所以这里降级成"没有默认 provider": server 照常起, 界面照常进, 到真正要发请求时
   * 才在那条路径上报错 —— 那时报错才有意义, 因为用户看得见也改得动。 */
  let defaultProvider: ReturnType<typeof providerResolver.getDefaultProvider> | undefined;
  try {
    defaultProvider = providerResolver.getDefaultProvider();
  } catch (err: any) {
    cliLogger.warn('SERVER', `默认 provider 不可用 (${err?.message ?? err}) —— 先不带默认 provider 启动, 等用户登录或切 BYOK`);
    defaultProvider = undefined;
  }
  const providerId = defaultProvider?.id ?? '';
  /* toModelId: relay-a 这类导入的条目把显示名存进了 lastSelectedModel/defaultModel ("Grok 4.5"),
   * 这里换回模型 id, 否则显示名会被当模型名发出去 (见 modelIdNormalize.ts)。 */
  const modelName = toModelId(defaultProvider as any, (defaultProvider as any)?.lastSelectedModel
    ?? defaultProvider?.defaultModel
    ?? defaultProvider?.models?.[0]?.name
    ?? '') ?? '';
  await initTTSIfEnabled(ttsService, config.tts?.enabled === true, () => defaultProvider);

  /* Image gen — 挂 cloud + BYOK resolver + providers 列表.
   * 优先级 (imageGenService.currentProvider):
   *   1. preferBYOK 开时 → providers 列表 (capability system) → legacy BYOK
   *   2. 云端已登录 → NeoxCloud 网关
   *   3. 未登录 → providers 列表 (走 capability system 挑一个有 image 能力的) → legacy BYOK
   * 幂等, 无 opt-in gate, agent 拉起 generate_image 时按需 lazy 决定通道. */
  setupImageGenResolvers(
    () => {
      for (const p of providerResolver.getAllProviders()) {
        const id = String(p.id ?? '').replace(/-/g, '');
        if (id !== 'neoxcloud' && !isNeoxManagedApiKey(p.apiKey)) continue;
        return resolveProviderEntry(p);
      }
      return undefined;
    },
    () => (config as any)?.imageGen,
    () => providerResolver.getAllProviders(),
    /* 订阅侧可用出图模型 —— 读登录时已经落盘的 membership 缓存
     * (~/.neox/membership-cache.json, 桌面选择器里那批订阅模型就是它)。
     * 不再拉一次网络, 也不新开 IPC: agent server 虽是独立进程, 读的是同一个文件。 */
    () => readAvailableCloudImageModels(),
  );

  const baseConfig = {
    services: platformServices,
    permissionManager,
    tools,
    memory,
    workDir,
    /* 一次性宿主 (`neox -p`) 不允许后台 agent —— turn 结束进程就退, 后台 agent 会被连坐杀掉,
     * 产出全丢而退出码仍是 0。置 false 后 agent 工具把后台请求降级成前台同步等待。 */
    allowBackgroundAgents: hostOptions?.oneShot !== true,
    providerId,
    modelName,
    resolveProvider,
    systemPrompt,
    persistSessionTitle: async (
      sessionId: string,
      title: string,
      meta?: { aggregatedFromUserMessages?: number; expectedCurrentTitle?: string },
    ): Promise<void> => {
      try {
        const storeMod: any = await import('../platform/sessionStore.js');
        const titleStore = await import('../platform/sessionTitleStore.js');
        const s = await storeMod.sessionStore.loadSession(sessionId);
        if (!s) return;

        const { decideTitleWrite } = await import('../runtime/sessionTitlePolicy.js');
        const decision = decideTitleWrite({
          currentName: s.name,
          nextTitle: title,
          expectedCurrentTitle: meta?.expectedCurrentTitle,
        });
        if (decision === 'user_renamed') {
          await titleStore.writeSessionTitleMeta(sessionId, {
            title: s.name,
            aggregatedFromUserMessages: meta?.aggregatedFromUserMessages ?? 0,
            manual: true,
          });
          cliLogger.debug('SESSION_TITLE', `${sessionId} 用户已手动改名, 放弃自动重聚合`);
          return;
        }

        /* 账本要更新 —— 即便名字没变 (模型两次给出同一个标题), 也算这个里程碑已经跑过,
         * 否则下一轮又会再算一次。 */
        if (meta?.aggregatedFromUserMessages) {
          await titleStore.writeSessionTitleMeta(sessionId, {
            title,
            aggregatedFromUserMessages: meta.aggregatedFromUserMessages,
          });
        }
        if (decision === 'unchanged') return; /* idempotent */
        s.name = title;
        s.updatedAt = Date.now();
        await storeMod.sessionStore.saveSessionMetadata(s);
        /* 推 session_title_changed event — bus 订阅者 (desktop renderer + mobile-bridge
         *  agentStreamForwarder) 据此更新 UI title. */
        bus.publish({
          sessionId,
          type: 'session_title_changed',
          data: { type: 'session_title_changed', sessionId, title } as any,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        cliLogger.warn('SESSION_TITLE', `persist title failed for ${sessionId}: ${err?.message}`);
      }
    },
    /* 后台 sub-agent 生命周期 → SSE + sub-agent 独立 session 落盘.
     *  双重责任:
     *    a) bus.publish 'sub_agent' 事件 — UI SubAgentsBar 据此实时增删行
     *    b) started: 在 sessions 表新建 child session (parent_session_id=父),
     *       seed 第一条 user message=prompt, sidebar 展开父能看到这个子节点
     *    c) done/aborted: append 一条 assistant message = result/error,
     *       点开子 session 能看到 sub-agent 输出 */
    onBackgroundAgentLifecycle: (
      kind: 'started' | 'updated' | 'done' | 'aborted',
      info: {
        agentId: string;
        name?: string;
        sessionId?: string;
        description: string;
        status: string;
        elapsed: number;
        toolUseCount: number;
        outputTokens?: number;
        /** 子 agent 实际跑的模型 / provider / 是否继承主 agent */
        model?: string;
        providerId?: string;
        modelInherited?: boolean;
        prompt?: string;
        result?: string;
        error?: string;
      },
    ) => {
      const sid = info.sessionId;
      if (!sid) return; /* 没 session 关联的 task 不广播, UI 没地方挂 */
      bus.publish({
        sessionId: sid,
        type: 'sub_agent',
        data: {
          type: 'sub_agent',
          action: kind,
          agentId: info.agentId,
          name: info.name,
          description: info.description,
          status: info.status,
          elapsed: info.elapsed,
          toolUseCount: info.toolUseCount,
          outputTokens: info.outputTokens,
          model: info.model,
          providerId: info.providerId,
          modelInherited: info.modelInherited,
          timestamp: Date.now(),
        } as any,
        timestamp: Date.now(),
      });

      /* sub-agent 独立 session 落盘 — 异步, 失败不阻塞 SSE / agent 主流程 */
      void (async () => {
        try {
          const storeMod: any = await import('../platform/sessionStore.js');
          const store = storeMod.sessionStore;
          if (kind === 'started') {
            const parent = await store.loadSession(sid);
            const origin = resolveSubAgentSessionOrigin({
              info, parentSessionId: sid, parent, workDir,
            });
            if (origin.usedWorkDirFallback) {
              cliLogger.warn('SUB_AGENT',
                `parent session ${sid} 无 workspace (查不到或为空), 子 agent ${info.agentId} 用 workDir 兜底建行 (避免永久 Unlinked)`);
            }
            /* 先登记归属再建行 —— 外键占位行可能已经抢在前面写过, 也可能随后才写,
             * 有这条提示两种时序都不会留下无父无 workspace 的孤儿。 */
            store.rememberSubAgentParent?.(origin.sessionId, sid, origin.workspacePath);
            await store.createSession({
              sessionId: origin.sessionId,
              workspacePath: origin.workspacePath,
              modelId: origin.modelId,
              name: origin.name,
              parentSessionId: origin.parentSessionId,
              initialUserMessage: origin.initialUserMessage,
            });
            /* 广播 session_list_changed-ish event — 让 sidebar 立即刷新 (复用 session_title_changed
             *  这条 UI 端会重拉; 这里发个更通用的 sub_agent_session_created 事件) */
            bus.publish({
              sessionId: sid,
              type: 'sub_agent_session_created',
              data: {
                type: 'sub_agent_session_created',
                parentSessionId: sid,
                childSessionId: info.agentId,
              } as any,
              timestamp: Date.now(),
            });
          } else if (kind === 'done' || kind === 'aborted') {
            const payload = kind === 'aborted'
              ? `[${info.error || '已被用户终止'} · ${info.elapsed}s · ${info.toolUseCount} 工具]`
              : (info.result || info.error || `[完成 · ${info.elapsed}s · ${info.toolUseCount} 工具]`);
            /* 残留文本 buffer 先落盘, 且等中间步骤串行链排空再写 final —
             * appendSubAgentResult 与 queueSubAgentTimelinePersist 都是读-改-写同一
             * timeline, 不串行会互相吞条目。 */
            flushSubAgentPersistState(info.agentId);
            const chain = subAgentPersistChains.get(info.agentId);
            if (chain) await chain.catch(() => {});
            subAgentPersistChains.delete(info.agentId);
            await store.appendSubAgentResult(info.agentId, payload);
          }
        } catch (err: any) {
          cliLogger.warn('SUB_AGENT', `persist sub-agent session failed agent=${info.agentId} kind=${kind}: ${err?.message ?? err}`);
        }
      })();
    },
  };

  // Checkpoint 服务（需手动开启 experimental.enableCheckpoint）
  const checkpointService = new RuntimeCheckpointService();
  const checkpointEnabled = config.experimental?.enableCheckpoint === true;
  checkpointService.setEnabled(checkpointEnabled);
  checkpointService.setWorkspace(workDir);

  try {
    const persistedSandbox = config.agentSandboxEnabled === true;
    if (persistedSandbox) setSandboxEnabled(true);
  } catch { /* 配置读不到就保持 env 初值 */ }

  // 初始化 runtime（single + assistant）
  const createdRuntimes = createRuntimeInstances({
    config,
    baseConfig,
    actionLog,
    approvalModeResolver,
    tools,
    permissionManager,
    memory,
    checkpointService,
  });
  let singleRuntime = createdRuntimes.singleRuntime;
  /* assistant 模式已移除 —— 只剩 agentic single runtime。 */
  let currentMode: AgentRunMode = createdRuntimes.currentMode;

  try {
    const ctxCfg = loadConfig()?.context as
      | { compressionMode?: 'sync' | 'async'; thresholdPercent?: number }
      | undefined;
    if (ctxCfg) {
      const pct = ctxCfg.thresholdPercent;
      singleRuntime?.setContextCompression({
        mode: ctxCfg.compressionMode,
        ...(typeof pct === 'number'
          ? { autoEnabled: pct < 100, threshold: pct < 100 ? pct / 100 : undefined }
          : {}),
      });
    }
  } catch (err) {
    cliLogger.warn('SERVER', `apply persisted context compression failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 活跃 session 跟踪
  const activeSessions = new Set<string>();
  const activeSessionModes = new Map<string, AgentRunMode>();
  const abortControllers = new Map<string, AbortController>();
  const recentlyAbortedAt = new Map<string, number>();
  const ABORT_SUPPRESS_RESUME_MS = 4000;
  const approvalSessionStore = new AsyncLocalStorage<string>();

  const lastServiceSurvivorSig = new Map<string, string>();

  type RunStatus = 'idle' | 'running' | 'paused' | 'awaiting_approval' | 'awaiting_user';
  interface ServerRunState {
    status: RunStatus;
    turnId?: string;
    lastCommittedSeq?: number;
    pendingToolCalls: Array<{ toolCallId: string; toolName: string; args?: any; startedAt: number }>;
    initiatedBy?: string;
    pausedAt?: number;
    updatedAt: number;
  }
  const sessionRunStates = new Map<string, ServerRunState>();

  function publishRunStateChanged(
    sessionId: string,
    state: ServerRunState,
    options?: { persist?: boolean; heartbeat?: boolean },
  ): void {
    const emittedAt = Date.now();
    bus.publish({
      sessionId,
      type: 'run_state_changed',
      data: {
        type: 'run_state_changed',
        sessionId,
        status: state.status,
        executing: state.status === 'running',
        blockedBy: state.status === 'paused' ? 'pause'
          : state.status === 'awaiting_approval' ? 'approval'
            : state.status === 'awaiting_user' ? 'ask_user'
              : undefined,
        turnId: state.turnId,
        lastCommittedSeq: state.lastCommittedSeq,
        pendingToolCalls: state.pendingToolCalls,
        initiatedBy: state.initiatedBy,
        pausedAt: state.pausedAt,
        /* updatedAt 语义是"状态最后一次**变更**的时刻" — 心跳重播同一电平时保持不变,
         * 下游 mirror 才能按它做幂等/stale 判断. 心跳的新鲜度看 emittedAt. */
        updatedAt: state.updatedAt,
        emittedAt,
        heartbeat: options?.heartbeat === true,
        timestamp: emittedAt,
      } as any,
      timestamp: emittedAt,
    });
    /* 心跳只是同一电平的重播, 落盘内容一个字节都没变 — 持久化会把 SQLite 写成
     * 每 5s 一次的无效写放大, 所以显式跳过. */
    if (options?.persist === false) return;
    /* 异步持久化到 sessionStore — 不 await, 失败 log 但不阻塞主流 */
    void (async () => {
      try {
        const storeMod: any = await import('../platform/sessionStore.js');
        const session = await storeMod.sessionStore.loadSession(sessionId);
        if (session) {
          session.runState = {
            status: state.status,
            turnId: state.turnId,
            lastCommittedSeq: state.lastCommittedSeq,
            pendingToolCalls: state.pendingToolCalls,
            initiatedBy: state.initiatedBy,
            pausedAt: state.pausedAt,
            updatedAt: state.updatedAt,
          };
          await storeMod.sessionStore.saveSessionMetadata(session);
        }
      } catch (err: any) {
        cliLogger.warn('RUN_STATE', `persist failed for ${sessionId}: ${err?.message}`);
      }
    })();
  }

  function setRunStatus(sessionId: string, status: RunStatus, patch?: Partial<ServerRunState>): void {
    const prev = sessionRunStates.get(sessionId);
    const now = Date.now();
    const next: ServerRunState = {
      status,
      turnId: patch?.turnId ?? prev?.turnId,
      lastCommittedSeq: patch?.lastCommittedSeq ?? prev?.lastCommittedSeq,
      pendingToolCalls: patch?.pendingToolCalls ?? prev?.pendingToolCalls ?? [],
      initiatedBy: patch?.initiatedBy ?? prev?.initiatedBy,
      pausedAt: status === 'paused' ? (patch?.pausedAt ?? now) : undefined,
      updatedAt: now,
    };
    sessionRunStates.set(sessionId, next);
    cliLogger.debug('RUN_STATE', `${sessionId.slice(0, 16)} ${prev?.status ?? 'unknown'} → ${status}`);
    publishRunStateChanged(sessionId, next);
    syncRunStateHeartbeat();
  }

  const sessionWaiting = new SessionWaitingRegistry();

  function syncWaitingStatus(sessionId: string): void {
    const current = sessionRunStates.get(sessionId)?.status;
    /* 只在"跑着或已在等"的时候动状态。idle/paused 说明这一轮已经收尾或被挂起,
     * 这时候把状态推回 running 是错的 —— abort 会先 cancel 掉所有 pending 审批,
     * 若这里无条件切回 running, 就会跟紧随其后的 finally(idle) 打架。 */
    if (current !== 'running' && current !== 'awaiting_approval' && current !== 'awaiting_user') return;
    const { status, pendingToolCalls } = sessionWaiting.resolve(sessionId);
    /* pendingToolCalls 一并填上 —— 这个字段同样是"定义了从没填过", 而它正是端上显示
     * "在等你批准 delete_file"所需要的内容。回 running 时 resolve 给的是空数组, 显式
     * 写进去才能清掉上一轮残留 (setRunStatus 的 patch 语义是继承)。 */
    setRunStatus(sessionId, status ?? 'running', { pendingToolCalls });
  }

  function enterWaiting(
    sessionId: string,
    kind: WaitingKind,
    requestId: string,
    tool?: { toolName: string; args?: any },
  ): void {
    sessionWaiting.enter(sessionId, kind, requestId, tool);
    syncWaitingStatus(sessionId);
  }

  function exitWaiting(sessionId: string, kind: WaitingKind, requestId: string): void {
    sessionWaiting.exit(sessionId, kind, requestId);
    syncWaitingStatus(sessionId);
  }

  /** 按 requestId 反查所属 session 再退出 — replyAskUser 只拿得到全局 requestId。 */
  function exitWaitingByRequestId(kind: WaitingKind, requestId: string): void {
    const sessionId = sessionWaiting.findSession(kind, requestId);
    if (sessionId) exitWaiting(sessionId, kind, requestId);
  }

  function snapshotRunState(sessionId: string): RunStateSnapshot {
    const state = sessionRunStates.get(sessionId);
    const chatInFlight = activeSessions.has(sessionId);
    const status: RunStatus = state?.status
      ?? (chatInFlight ? 'running' : 'idle');
    /* 状态机说 idle 但 chat 还在 in-flight → 以 in-flight 为准并留痕, 这是不该发生的
     * 失配, 记 warn 便于事后定位是哪条异常路径漏了 setRunStatus. */
    const effective: RunStatus = status === 'idle' && chatInFlight ? 'running' : status;
    if (effective !== status) {
      cliLogger.warn('RUN_STATE', `${sessionId.slice(0, 16)} state=idle but chat in-flight → reporting running`);
    }
    const executing = effective === 'running';
    const blockedBy: RunStateSnapshot['blockedBy'] =
      effective === 'paused' ? 'pause'
        : effective === 'awaiting_approval' ? 'approval'
          : effective === 'awaiting_user' ? 'ask_user'
            : undefined;
    return {
      sessionId,
      status: effective,
      running: effective !== 'idle',
      executing,
      /* 有状态机条目 或 chat 还在 in-flight = 这里确实认识它。
       * 点名查一个从没见过的 sessionId 也会走到这儿并返回 idle —— known 就是用来
       * 让下游区分"它空闲"和"我不知道它"的, 后者不能拿去收敛别人的运行态。 */
      known: state !== undefined || chatInFlight,
      ...(blockedBy ? { blockedBy } : {}),
      turnId: state?.turnId,
      pendingToolCalls: state?.pendingToolCalls ?? [],
      initiatedBy: state?.initiatedBy,
      pausedAt: state?.pausedAt,
      updatedAt: state?.updatedAt ?? 0,
      observedAt: Date.now(),
    };
  }

  /** 全量非 idle 快照 + 调用方点名的 session — 下游一次 RPC 完成整表对账。
   *  只回非 idle 的, 是因为"没出现在结果里"本身就是 idle 的证据, 省得把成千条历史
   *  会话全序列化过去。调用方点名的 session 无论什么状态都回, 用于精确查询。 */
  function snapshotRunStates(sessionIds?: string[]): RunStateSnapshot[] {
    const out = new Map<string, RunStateSnapshot>();
    for (const sessionId of sessionRunStates.keys()) {
      const snap = snapshotRunState(sessionId);
      if (snap.running) out.set(sessionId, snap);
    }
    /* activeSessions 里有但状态机里没有的 — 同样是"在跑"的硬证据, 补进来。 */
    for (const sessionId of activeSessions) {
      if (!out.has(sessionId)) out.set(sessionId, snapshotRunState(sessionId));
    }
    for (const sessionId of sessionIds ?? []) {
      if (sessionId && !out.has(sessionId)) out.set(sessionId, snapshotRunState(sessionId));
    }
    return [...out.values()];
  }

  const RUN_STATE_HEARTBEAT_MS = 5000;
  let runStateHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function syncRunStateHeartbeat(): void {
    const hasActive = snapshotRunStates().length > 0;
    if (hasActive && !runStateHeartbeatTimer) {
      runStateHeartbeatTimer = setInterval(() => {
        const active = snapshotRunStates();
        if (active.length === 0) {
          syncRunStateHeartbeat();
          return;
        }
        for (const snap of active) {
          const state = sessionRunStates.get(snap.sessionId);
          if (state) publishRunStateChanged(snap.sessionId, state, { persist: false, heartbeat: true });
        }
      }, RUN_STATE_HEARTBEAT_MS);
      runStateHeartbeatTimer.unref?.();
    } else if (!hasActive && runStateHeartbeatTimer) {
      clearInterval(runStateHeartbeatTimer);
      runStateHeartbeatTimer = null;
    }
  }

  type SessionChatMetadata = {
    providerId?: string;
    modelName?: string;
    mode?: AgentRunMode;
  };
  const lastChatMetaBySession = new Map<string, SessionChatMetadata>();

  // 权限请求队列
  const pendingPermissions = new Map<string, PendingPermissionEntry>();

  const stopServiceSnapshotSubscription = setupRuntimeBridgeCallbacks({
    bus,
    workDir,
    activeSessions,
    approvalSessionStore,
    permissionManager,
    pendingPermissions,
    enterWaiting,
    exitWaiting,
  });

  /* timeout 仍保留在 StreamEvent union 里, 防协议老客户端解析失败; 服务端永远不主动发了.
   * 实际取消路径: 'resolved' (用户点击) / 'session_aborted' (用户 Stop) / 'manual_cancel' / 'stale'. */
  type ApprovalCancellationReason = 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale';

  function resolvePendingPermission(params: {
    requestId: string;
    result: { approved: boolean; remember: boolean };
    reason: ApprovalCancellationReason;
    approvedForEvent?: boolean;
  }): PendingPermissionEntry | null {
    const pending = pendingPermissions.get(params.requestId);
    if (!pending || pending.settled) {
      return null;
    }
    pendingPermissions.delete(params.requestId);
    pending.settled = true;
    pending.resolve(params.result);
    exitWaiting(pending.sessionId, 'approval', params.requestId);
    bus.publish({
      sessionId: pending.sessionId,
      type: 'approval_cancelled',
      data: {
        type: 'approval_cancelled',
        requestId: params.requestId,
        reason: params.reason,
        approved: params.approvedForEvent,
      },
      timestamp: Date.now(),
    });
    return pending;
  }

  function cancelPendingPermissionsForSession(sessionId: string, reason: ApprovalCancellationReason): number {
    const requestIds = Array.from(pendingPermissions.entries())
      .filter(([, pending]) => pending.sessionId === sessionId && !pending.settled)
      .map(([requestId]) => requestId);
    let cancelled = 0;
    for (const requestId of requestIds) {
      const resolved = resolvePendingPermission({
        requestId,
        result: { approved: false, remember: false },
        reason,
      });
      if (resolved) {
        cancelled++;
      }
    }
    return cancelled;
  }

  try {
    const { targetEvents } = await import('../tools/targetModeTools.js');
    targetEvents.on('snapshot', (snapshot: { sessionId?: string | null }) => {
      const sid = snapshot?.sessionId;
      if (!sid) return; /* 没有会话归属的快照没地方挂, 丢掉好过串到别的会话 */
      try {
        bus.publish({
          sessionId: sid,
          type: 'target_snapshot',
          data: { type: 'target_snapshot', ...snapshot } as any,
          timestamp: Date.now(),
        });
      } catch { /* 广播失败不能影响 target 状态机本身 */ }
    });
    cliLogger.info('TARGET', 'snapshot → bus bridge attached (runtime thread)');
  } catch (err: any) {
    cliLogger.warn('TARGET', `snapshot bridge attach failed: ${err?.message ?? err}`);
  }

  scheduleResumeScan({
    workDir,
    bus,
    getSingleRuntime: () => singleRuntime,
    authToken: '',
    source: 'in-process-bridge',
  });

  try {
    await setupSkillsHotReload(workDir);
  } catch (err: any) {
    cliLogger.warn('SERVER', `skills bootstrap failed (in-process): ${err?.message || err}`);
  }

  const bridge: RuntimeBridge = {
    getAgenticRuntime: () => singleRuntime,
    async chat(sessionId, request) {
      await approvalSessionStore.run(sessionId, () => runWithChatSession(sessionId, async () => {
        activeSessions.add(sessionId);
        const ac = new AbortController();
        abortControllers.set(sessionId, ac);
        /* M2 — 设置 running 状态, initiatedBy 从 request 拿 (desktop/mobile-{deviceId}) */
        const userMsgSource = typeof request?.userMessageSource === 'string'
          ? request.userMessageSource
          : undefined;
        setRunStatus(sessionId, 'running', {
          initiatedBy: userMsgSource,
          turnId: `chat-${Date.now()}`,
          pendingToolCalls: [],
        });

        const userPrompt = typeof request?.prompt === 'string' ? request.prompt : '';
        const isResumeRun = request?.isResume === true;
        const isContinueRun = (request as { isContinue?: boolean })?.isContinue === true;
        const isRetryRun = (request as { isRetry?: boolean })?.isRetry === true || isContinueRun;
        if (isRetryRun) {
          (request as any).metadata = {
            ...((request as any).metadata ?? {}),
            entryUserMessagePersisted: true,
          };
        }
        if (!isResumeRun && !isRetryRun && userPrompt.trim().length > 0) {
          const userTurnId = `chat-${Date.now()}`;
          const userTimestamp = Date.now();
          /* messageId 优先取 request 顶层 (desktop renderer 跟 mobile 已生成的 id), 没传就 server gen */
          const requestMessageId = typeof request?.userMessageId === 'string'
            ? request.userMessageId
            : `msg-srv-${userTimestamp}-${Math.random().toString(36).slice(2, 8)}`;
          /* messageSource 标记 desktop / mobile-{deviceId} / cli — 接力时 initiatedBy 用 */
          const requestSource = typeof request?.userMessageSource === 'string'
            ? request.userMessageSource
            : 'unknown';
          let userSeq = -1;
          try {
            const ctx = SessionContext.get(sessionId);
            userSeq = ctx.appendMessage('user', userPrompt, userTurnId, userTimestamp, {
              role: 'user', content: userPrompt, turnId: userTurnId, messageId: requestMessageId,
            });
            cliLogger.debug('CHAT_USER_MSG', `session=${sessionId.slice(0, 16)} seq=${userSeq} src=${requestSource} msgId=${requestMessageId.slice(0, 16)}`);
            if (userSeq >= 0) {
              (request as any).metadata = { ...((request as any).metadata ?? {}), entryUserMessagePersisted: true };
            }
          } catch (err: any) {
            cliLogger.warn('CHAT_USER_MSG', `appendMessage failed: ${err?.message}`);
          }
          /* publish user_message event 到 bus — desktop renderer / electron main proxy / phones 都从这接.
           * data 内带 seq + 完整字段, mobile-bridge 转发时可直接构造 drift session.event. */
          bus.publish({
            sessionId,
            type: 'user_message',
            data: {
              type: 'user_message',
              sessionId,
              seq: userSeq,
              text: userPrompt,
              messageId: requestMessageId,
              source: requestSource,
              turnId: userTurnId,
              timestamp: userTimestamp,
            } as any,
            timestamp: userTimestamp,
          });
        }

        /* 记下"这个 session 用的 provider/model" 给 schedule_wakeup 用 — 60 秒后
           wakeup 触发要代用户起新一轮,得用一致的模型,fallback 到默认会跑错。
           providerId/modelName 优先取 request 顶层,prepareChatRequest 后再覆盖一次。 */
        lastChatMetaBySession.set(sessionId, {
          providerId: request?.providerId ?? lastChatMetaBySession.get(sessionId)?.providerId,
          modelName: request?.modelName ?? lastChatMetaBySession.get(sessionId)?.modelName,
          mode: lastChatMetaBySession.get(sessionId)?.mode,
        });

        const { publishRawEvent, publishError, publishWorkerResult } = createChatEventPublisher({
          bus,
          sessionId,
          ttsService,
          /* 语音回合 — 工具启动时模型没先开口就由服务端垫一句 (语音快答公约兜底) */
          isVoiceTurn: userPrompt.includes('<voice-turn>'),
        });

        // AgenticAgent handlers (onRuntimeEvent 接收 2 个参数: event, tracker)
        // 注意: onRuntimeEvent 已经转发了真实的 run_result 事件，不再需要 onComplete
        const singleHandlers = {
          onRuntimeEvent: (event: any, tracker: any) => {
            publishRawEvent(event, tracker);
            /* sub-agent 镜像: event.taskAgentId 表示这条事件是 sub-agent runtime 冒泡上来的.
             *   父 session 的 explore 卡已经吃了 (publishRawEvent 上一行), 这里再以 sub-agent
             *   自己的 sessionId 推一份, 但**去掉 taskAgentId tag** — 否则 useStreamHandler 又
             *   把它当父 timeline 的 explore 路由去, 反而不写 sub-agent 自己的 timeline.
             *
             *   去 tag 后 renderer 看到的就是"sub-agent session 自己的普通事件流"
             *   (tool_call / tool_result / token / text), 走正常 appendTimelineEntry 链路,
             *   sub-agent session 的 timeline_entries 表自动累积. 用户点开 sub-agent 子会话
             *   能看到完整 shell 命令 / 工具调用 / 对话, 不再只有 prompt + final. */
            const subSid = event?.taskAgentId;
            if (subSid && typeof subSid === 'string') {
              /* 冷启动历史: 镜像进 '*' 之后直播不再靠 DB, 但仍落盘,
               * 关 app 再点开已结束的子会话才有完整记录。 */
              persistSubAgentRuntimeEvent(subSid, event);
              /* 派发/进度卡是父时间线的事 (agent_delegation)。镜像进子会话会在子线程
               * 顶上多一张 "Code Agent · 任务名" —— 人已经在这个线程里了, 再画一张母卡。 */
              if (event.type === 'worker_start'
                || event.type === 'worker_complete'
                || event.type === 'worker_event') {
                return;
              }
              const { taskAgentId: _t, sourceLabel: _s, ...cleanData } = event;
              bus.publish({
                sessionId: subSid,
                type: event.type,
                data: { ...cleanData, sessionId: subSid, __subAgentMirror: true },
                tracker,
                timestamp: Date.now(),
              });
            }
          },
          onError: publishError,
        };

        try {
          const { mode, metadata } = prepareChatRequest({
            request,
            currentMode,
            defaultProviderId: providerId,
            defaultModelName: modelName,
          });

          activeSessionModes.set(sessionId, mode);
          /* 把最终选定的 provider/model/mode 也缓存,wakeup 触发时复用 */
          lastChatMetaBySession.set(sessionId, {
            providerId: (metadata as any)?.providerId ?? lastChatMetaBySession.get(sessionId)?.providerId,
            modelName: (metadata as any)?.modelName ?? lastChatMetaBySession.get(sessionId)?.modelName,
            mode,
          });
          await dispatchChatByMode({
            currentMode: mode,
            sessionId,
            prompt: request.prompt,
            isRetry: request.isRetry,
            isContinue: request.isContinue,
            isResume: request.isResume,
            metadata,
            singleHandlers,
            singleRuntime,
            /* 多根工作区: 透传本工作区全部根 (desktop chat payload 带来) → agent env 段感知。 */
            workspaceRoots: (request as { workspaceRoots?: string[] }).workspaceRoots,
            workspacePath: (request as { workspacePath?: string }).workspacePath,
            agentMode: request.agentMode,
            chatMode: request.chatMode,
            abortSignal: ac.signal,
          });
        } catch (err: any) {
          const detail = err?.message ? String(err.message) : String(err);
          const aborted = ac.signal.aborted || /abort/i.test(detail);
          cliLogger.error('CHAT', `session ${sessionId.slice(0, 16)} chat() threw${aborted ? ' (aborted)' : ''}: ${detail}`);
          if (!aborted) {
            try {
              publishError(err instanceof Error ? err : new Error(detail));
            } catch (publishErr: any) {
              /* 连上报都失败了也不能让它盖掉原始异常 */
              cliLogger.error('CHAT', `publishError failed: ${publishErr?.message ?? publishErr}`);
            }
          }
          throw err;
        } finally {
          /* assistant 模式已移除 —— chat 跑完一律在 finally 清理 sessionId/状态。 */
          const isAssistantMode = false;
          if (!isAssistantMode) {
            activeSessions.delete(sessionId);
            activeSessionModes.delete(sessionId);
            abortControllers.delete(sessionId);
            sessionWaiting.clearSession(sessionId);
            /* M2 — 非 assistant 模式 chat 跑完直接 idle. assistant 模式由 run_result event handler 切 idle. */
            const currentState = sessionRunStates.get(sessionId);
            if (currentState && currentState.status !== 'paused') {
              const slowMs = Number(process.env.NEOX_DEBUG_SLOW_SETTLE_MS || 0);
              if (slowMs > 0) {
                cliLogger.warn('RUN_STATE', `[debug] 人为延迟 ${slowMs}ms 再转 idle (NEOX_DEBUG_SLOW_SETTLE_MS)`);
                setTimeout(() => {
                  const st = sessionRunStates.get(sessionId);
                  if (st && st.status !== 'paused') setRunStatus(sessionId, 'idle');
                }, slowMs).unref?.();
              } else {
                setRunStatus(sessionId, 'idle');
              }
            }
            try {
              const notifier = getBackgroundTaskNotifier();
              if (notifier.hasNotificationsFor(sessionId)) {
                if (ac.signal.aborted) {
                  const dropped = notifier.drainForSession(sessionId);
                  cliLogger.info('BG_NOTIFIER', `Turn aborted by user → dropped ${dropped.length} stranded notif(s) for ${sessionId}, NOT resuming`);
                } else {
                  const drained = notifier.drainForSession(sessionId);
                  const xml = drained.map(n => n.xml).filter(Boolean).join('\n');
                  const meta = lastChatMetaBySession.get(sessionId);
                  if (xml && meta) {
                    cliLogger.info('BG_NOTIFIER', `Post-turn drain: ${drained.length} stranded notif(s) for ${sessionId} → resuming`);
                    void bridge.chat(sessionId, {
                      prompt: xml,
                      providerId: meta.providerId,
                      modelName: meta.modelName,
                    } as any).catch((err: any) => {
                      cliLogger.error('BG_NOTIFIER', `post-turn drain chat failed for ${sessionId}: ${err?.message ?? err}`);
                    });
                  }
                }
              }
            } catch (e: any) {
              cliLogger.warn('BG_NOTIFIER', `post-turn drain check failed: ${e?.message ?? e}`);
            }
          } else {
            // assistant 模式只清理 abortController，sessionId 保留到 run_result
            abortControllers.delete(sessionId);
            activeSessionModes.delete(sessionId);
          }
        }
      }));
    },

    abort(sessionId) {
      recentlyAbortedAt.set(sessionId, Date.now());
      const cancelled = cancelPendingPermissionsForSession(sessionId, 'session_aborted');
      if (cancelled > 0) {
        cliLogger.info('SERVER_AUDIT', `cancelled ${cancelled} pending approval(s) due to abort: session=${sessionId}`);
      }
      const { survivingProcesses } = abortSession({
        sessionId,
        abortControllers,
        activeSessionModes,
        singleRuntime,
      });
      let services: Array<{ pid: number; command: string }> = [];
      try {
        services = (buildSnapshot(workDir).processes as Array<Record<string, any>>)
          .filter(p => p?.status === 'running' && typeof p.pid === 'number')
          .map(p => ({
            pid: p.pid as number,
            command: String(p.displayName ?? p.command ?? p.task ?? 'service'),
          }))
          /* abortSession 已经报过的不重复 */
          .filter(svc => !survivingProcesses.some(sp => sp.pid === svc.pid));
      } catch (err: any) {
        cliLogger.warn('SERVER', `abort: 收集运行中服务失败: ${err?.message ?? err}`);
      }
      /* 连按几次停止不该堆几条一模一样的通知 (队列上限 20, 会把真正有用的挤掉,
       * 下一轮还得让模型读 10 遍同样的 pid)。同一组 pid 只报一次, 变了才再报。 */
      const svcSig = services.map(p => p.pid).sort((a2, b2) => a2 - b2).join(',');
      if (services.length > 0 && lastServiceSurvivorSig.get(sessionId) !== svcSig) {
        lastServiceSurvivorSig.set(sessionId, svcSig);
        try {
          const notifier = getBackgroundTaskNotifier();
          notifier.enqueueMessageForSession(
            sessionId,
            `<services-still-running-after-interrupt>\n` +
            `用户中断了上一轮。以下服务仍在运行 (它们不随中断停止):\n` +
            services.map(p => `  - pid ${p.pid}: ${p.command}`).join('\n') + `\n` +
            `需要同一个端口/服务时请直接复用, 不要重新启动 —— 会 EADDRINUSE。\n` +
            `</services-still-running-after-interrupt>`,
            { terminatedBy: 'user', noAutoResume: true },
          );
        } catch (err: any) {
          cliLogger.warn('SERVER', `abort: 服务幸存通知投递失败: ${err?.message ?? err}`);
        }
      }
      const allSurvivors = [...survivingProcesses, ...services];

      /* 后台进程不随中断消失 (设计如此), 但用户按了停止就有权知道还剩什么在跑。
       * 只报一行, 点服务面板能看到全部。 */
      if (allSurvivors.length > 0) {
        const brief = allSurvivors
          .slice(0, 3)
          .map(p => p.command.split(/\s+/).slice(0, 3).join(' '))
          .join('、');
        bus.publish({
          sessionId,
          type: 'status',
          data: {
            type: 'status',
            sessionId,
            level: 'info',
            message: `已中断 — 仍有 ${allSurvivors.length} 个后台进程在运行（${brief}${allSurvivors.length > 3 ? ' 等' : ''}），可在服务面板停止`,
          },
        } as any);
      }
    },

    /** UI 服务管理面板 — 列出所有后台运行/最近完成的进程, 让用户点 icon 弹窗看 + 手动控制.
     *  P3+: 全字段输出 — 服务治理 UI 要 display_name / config_id / port / adoptable /
     *  uptime / health 等. processManager.snapshotForDisplay() 一把抓. */
    /** runtime 销毁时摘掉快照订阅 —— 见 setupRuntimeBridgeCallbacks 的返回值说明。 */
    disposeSnapshotTick() {
      try { stopServiceSnapshotSubscription(); } catch { /* ignore */ }
    },

    listBackgroundTasks() {
      try {
        return buildSnapshot(workDir).processes as unknown as Array<Record<string, unknown>>;
      } catch (err: any) {
        cliLogger.warn('SERVER', `listBackgroundTasks threw: ${err?.message ?? err}`);
        return [];
      }
    },

    async listServiceHistory(workspaceRoot) {
      try {
        const { listInstancesByWorkspace } = await import('@neoxlabs/platform/platform/serviceInstanceStore.js');
        return listInstancesByWorkspace(workspaceRoot) as unknown as Array<Record<string, unknown>>;
      } catch (err: any) {
        cliLogger.warn('SERVER', `listServiceHistory ws=${workspaceRoot} threw: ${err?.message ?? err}`);
        return [];
      }
    },

    /** 读盘上的历史日志尾部 —— 内存 buffer 早没了也能看到终端。 */
    readServiceLog(pid, startTimeMs) {
      try {
        return processManager.readLogFromDisk(pid, startTimeMs) ?? '';
      } catch (err: any) {
        cliLogger.warn('SERVER', `readServiceLog pid=${pid} threw: ${err?.message ?? err}`);
        return '';
      }
    },

    getBackgroundTaskOutput(pid) {
      /* server 端 processManager 持有真实 buffer; UI 跨进程走 HTTP 拉, electron-main
         那侧的 manager 是空 singleton. */
      try {
        return processManager.getOutput(pid) ?? '';
      } catch (err: any) {
        cliLogger.warn('SERVER', `getBackgroundTaskOutput pid=${pid} threw: ${err?.message ?? err}`);
        return '';
      }
    },

    untrackProcess(pid) {
      try {
        const removed = processManager.untrack(pid);
        cliLogger.info('SERVER', `untrackProcess: pid=${pid} removed=${removed}`);
        return { ok: true, removed };
      } catch (err: any) {
        cliLogger.warn('SERVER', `untrackProcess pid=${pid} threw: ${err?.message ?? err}`);
        return { ok: false, removed: false };
      }
    },

    killBackgroundTask(pid, force) {
      try {
        processManager.killProcessGroup(pid, force ? 'SIGKILL' : 'SIGTERM', 'user');
        cliLogger.info('SERVER', `killBackgroundTask: pid=${pid} signal=${force ? 'SIGKILL' : 'SIGTERM'} by=user`);
      } catch (err: any) {
        cliLogger.warn('SERVER', `killBackgroundTask pid=${pid} threw: ${err?.message ?? err}`);
      }
    },

    /* 清场: 停 tracked 进程 (可按工程过滤). 宿主退出 / 关项目走这里 —— runtime 在 worker
     * thread 时进程表在这一侧, 宿主直接调自己那个 processManager 会打在空气上。 */
    async killAllTrackedProcesses(opts) {
      try {
        const r = await processManager.killAllTracked({
          workspaceRoot: opts?.workspaceRoot,
          terminatedBy: opts?.terminatedBy ?? 'system',
        });
        cliLogger.info('SERVER',
          `killAllTrackedProcesses ws=${opts?.workspaceRoot ?? '(all)'}: ` +
          `killed=${r.killed} skipped=${r.skipped} hardKilled=${r.hardKilled}`);
        return r;
      } catch (err: any) {
        cliLogger.warn('SERVER', `killAllTrackedProcesses threw: ${err?.message ?? err}`);
        return { killed: 0, skipped: 0, hardKilled: 0 };
      }
    },

    /* per-session 列 sub-agent (UI bar 用) — 拿 BackgroundAgentManager.listActive(sessionId) */
    listSubAgents(sessionId) {
      try {
        const list = singleRuntime?.getBackgroundAgentManager().listActive(sessionId) ?? [];
        return list.map(info => ({
          agentId: info.agentId,
          name: info.name,
          sessionId: info.sessionId,
          description: info.description,
          status: info.status,
          elapsed: info.elapsed,
          toolUseCount: info.progress.toolUseCount,
        }));
      } catch (err: any) {
        cliLogger.warn('SERVER', `listSubAgents threw: ${err?.message ?? err}`);
        return [];
      }
    },

    /* 用户从 UI 停 sub-agent — abort 通过 AbortController, runtime loop 下一个 await
     *  点会捕获 AbortError 走清理. 触发 onLifecycle('aborted', task) → SSE 推 UI 清行. */
    abortSubAgent(agentId) {
      try {
        const ok = singleRuntime?.getBackgroundAgentManager().abort(agentId, '用户从界面停止了这个子 agent', false, 'user') === true;
        cliLogger.info('SERVER', `abortSubAgent: agentId=${agentId} ok=${ok}`);
        return { ok };
      } catch (err: any) {
        cliLogger.warn('SERVER', `abortSubAgent threw: ${err?.message ?? err}`);
        return { ok: false };
      }
    },

    async startServiceByConfig(workspaceRoot, configId, sessionId) {
      /* UI Start / 右键启动 / autoRestart 都走这条. 必须在 server 进程跑, 这样
       * runBackgroundShellCommand 起出来的子进程会注册进 server 这边的 processManager,
       * UI 的 process:list (走 SDK 拿 server 的列表) 立刻能看到.
       *
       * sessionId 必须透传到 launcher → runBackgroundShellCommand → shell_output_stream
       * 的 payload — 否则 server callback 解析 session 时 activeSessions 是空集 (chat 已结束),
       * 推流被丢, ShellConsole 看到 "// no output buffered". */
      try {
        const { startServiceByConfig: launcher } = await import('../runtime/services/serviceLauncher.js');
        const r = await launcher(workspaceRoot, configId, sessionId);
        cliLogger.info('SERVER', `startServiceByConfig: ws=${workspaceRoot} id=${configId} sid=${sessionId ?? 'none'} ok=${r.ok}`);
        return r;
      } catch (err: any) {
        cliLogger.warn('SERVER', `startServiceByConfig ws=${workspaceRoot} id=${configId} threw: ${err?.message ?? err}`);
        return { ok: false, error: err?.message || String(err) };
      }
    },

    bindRunConfig(pid, configId) {
      /* Adopt: 在 server 端的真 processManager 上 markRunConfig.
       * UI 拿 process:list 时 config_id 字段就有了, 行从 Adhoc 区跳到 Configured 区. */
      try {
        const proc = processManager.get(pid);
        if (!proc) return { ok: false, error: `pid=${pid} not tracked` };
        processManager.bindConfig(pid, configId);
        cliLogger.info('SERVER', `bindRunConfig: pid=${pid} configId=${configId}`);
        return { ok: true };
      } catch (err: any) {
        cliLogger.warn('SERVER', `bindRunConfig pid=${pid} configId=${configId} threw: ${err?.message ?? err}`);
        return { ok: false, error: err?.message || String(err) };
      }
    },

    async upsertServiceConfig(workspaceRoot, config) {
      try {
        const { getServiceConfigStore } = await import('../runtime/services/serviceConfigStoreCache.js');
        const store = getServiceConfigStore(workspaceRoot);
        /* createdBy 默认 'user' —— 跟 electron 本地兜底那条保持一致, 否则同一个动作
         * 走两条路会写出不同的 createdBy, 面板上"谁建的"就开始飘。 */
        const saved = store.upsert({ ...(config as any), createdBy: (config as any)?.createdBy || 'user' });
        cliLogger.info('SERVER', `upsertServiceConfig: ws=${workspaceRoot} id=${saved?.id}`);
        return { ok: true, config: saved as unknown as Record<string, unknown> };
      } catch (err: any) {
        cliLogger.warn('SERVER', `upsertServiceConfig ws=${workspaceRoot} threw: ${err?.message ?? err}`);
        return { ok: false, error: err?.message || String(err) };
      }
    },

    async removeServiceConfig(workspaceRoot, id) {
      try {
        const { getServiceConfigStore } = await import('../runtime/services/serviceConfigStoreCache.js');
        const store = getServiceConfigStore(workspaceRoot);
        const removed = store.remove(id);
        cliLogger.info('SERVER', `removeServiceConfig: ws=${workspaceRoot} id=${id} removed=${removed}`);
        return { ok: true, removed };
      } catch (err: any) {
        cliLogger.warn('SERVER', `removeServiceConfig ws=${workspaceRoot} id=${id} threw: ${err?.message ?? err}`);
        return { ok: false, removed: false, error: err?.message || String(err) };
      }
    },

    pauseBackgroundTask(pid) {
      /* SIGTSTP — 让进程"软暂停"挂起, 状态保留, 用 SIGCONT 恢复. */
      try {
        try { process.kill(-pid, 'SIGTSTP'); } catch { try { process.kill(pid, 'SIGTSTP'); } catch { /* dead */ } }
        cliLogger.info('SERVER', `pauseBackgroundTask: pid=${pid} SIGTSTP`);
      } catch (err: any) {
        cliLogger.warn('SERVER', `pauseBackgroundTask pid=${pid} threw: ${err?.message ?? err}`);
      }
    },

    /**
     * 把一个后台任务"转正"为工程级常驻 —— 跨会话可见.
     *
     *   后台任务默认是**会话级临时**的 (只在起它的会话里可见)。晋升只认用户显式确认,
     *   刻意不按端口 / config_id / 存活时长自动判定 —— 那是在猜意图, 而一个跑三分钟的
     *   构建照样占端口、照样活很久, 它并不是"服务"。
     *   [persistent] 传 false 即撤销转正。
     */
    setBackgroundTaskPersistent(pid, persistent) {
      const notifier = getBackgroundTaskNotifier();
      if (persistent) notifier.promotePid(pid);
      else notifier.demotePid(pid);
      cliLogger.info('SERVER',
        `setBackgroundTaskPersistent: pid=${pid} → ${persistent ? 'project-level' : 'session-only'}`);
    },

    resumeBackgroundTask(pid) {
      try {
        try { process.kill(-pid, 'SIGCONT'); } catch { try { process.kill(pid, 'SIGCONT'); } catch { /* dead */ } }
        cliLogger.info('SERVER', `resumeBackgroundTask: pid=${pid} SIGCONT`);
      } catch (err: any) {
        cliLogger.warn('SERVER', `resumeBackgroundTask pid=${pid} threw: ${err?.message ?? err}`);
      }
    },

    /* 起一个独立的可交互 PTY shell (Services panel 的 Shell 控制台用).
     *   跟 service 解耦, 用户拿到 pid 后通过 xterm.onData → shellStdin 双向交互.
     *
     *   关键: daemon 的 buildShellInvocation 会把传入的 command 包成 'zsh -lc <cmd>'.
     *   如果直接传 'bash -i', 会变成 zsh -lc 'bash -i' — zsh 以 -c 模式 fork bash,
     *   PTY 在 zsh 这一层 attach, bash 跟 zsh 抢 stdin, 现象就是 "启动失败" / 卡死.
     *   用 'exec' 让 shell 进程 image 直接被替换成真正的交互 shell, PTY 之后挂在 zsh -i 上,
     *   不存在子进程抢 stdin 问题. */
    async openInteractiveShell(args) {
      try {
        await ensureCommandHelperRunning();

        const userShell = (typeof process.env.SHELL === 'string' && process.env.SHELL) ? process.env.SHELL : '/bin/bash';
        const command = (args?.command && typeof args.command === 'string')
          ? args.command
          : `exec ${userShell} -i`;
        const cwd = (args?.cwd && typeof args.cwd === 'string') ? args.cwd : process.cwd();
        /* toolId 提前生成 — 既用作 daemon 端 shell_stream 的 routing id, 又作为返回值给
         * renderer (ShellConsole 用它订阅 terminalChunkBus, 拿到字节级实时推送). */
        const freeShellToolId = `free-shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await executeShellInWorker(
          {
            toolId: freeShellToolId,
            command,
            background: true,
            workspaceRoot: cwd,
            kind: 'free-shell',
          },
          {
            logger: cliLogger as any,
            processManager,
            /* 关键: 接通 stream callback. 之前注释说"通过 polling processGetOutput 拿全量",
             * 那条路径只能 1s 拿一次, 用户敲字符回显可见 1s 延迟, 体感"不像真终端".
             * 改成跟 LLM execute_shell 同一条推送路径: shellWorkerClient 拿到 daemon socket
             * 的 shell_stream → 调本 callback → bus.publish → SSE → renderer 端
             * terminalChunkBus.emit(toolId) → xterm.write. 零延迟字节直通.
             * outputBuffer 仍累积 (shellWorkerClient 那边), 给 page reload 后 polling 拉历史. */
            onShellOutputStream: getShellOutputStreamCallback() ?? undefined,
          },
        );
        if (!result?.pid) {
          cliLogger.warn('SERVER', `openInteractiveShell: daemon 没返回 pid (command="${command}")`);
          return { pid: null, error: 'daemon 没返回 pid (helper 是否在跑?)' };
        }
        return { pid: result.pid, toolId: freeShellToolId };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        cliLogger.warn('SERVER', `openInteractiveShell threw: ${msg}`);
        return { pid: null, error: msg };
      }
    },

    /* 把 xterm onData 的字节透传给 helper daemon → PTY stdin. 没找到对应 socket 返回 false,
       让上层 (HTTP route → SDK → IPC → renderer) 拿到准确的 delivery 状态,
       便于定位 "敲键没反应" 是哪一环吃了字节. */
    sendShellStdin(pid, data) {
      try {
        const ok = sendShellStdinViaHelper(pid, data);
        if (!ok) cliLogger.info('SERVER', `sendShellStdin: pid=${pid} no active socket`);
        return ok;
      } catch (err: any) {
        cliLogger.warn('SERVER', `sendShellStdin pid=${pid} threw: ${err?.message ?? err}`);
        return false;
      }
    },

    /* xterm 容器尺寸变化 → 同步 PTY cols/rows. less/vim/htop 这类 TUI 才不会渲染错位. */
    resizeShell(pid, cols, rows) {
      try {
        const ok = resizeShellViaHelper(pid, cols, rows);
        if (!ok) cliLogger.info('SERVER', `resizeShell: pid=${pid} no active socket`);
      } catch (err: any) {
        cliLogger.warn('SERVER', `resizeShell pid=${pid} threw: ${err?.message ?? err}`);
      }
    },

    getRunState(sessionId) {
      return snapshotRunState(sessionId);
    },

    getRunStates(sessionIds) {
      return snapshotRunStates(sessionIds);
    },

    pauseAll(sessionId) {
      const ok = pauseSession(sessionId);
      if (!ok) {
        /* 没有活着的控制器 = 这个会话没在跑。**不能假装暂停成功** —— UI 会显示
         * "已暂停"然后卡在那儿, 而根本没有东西在等着被恢复。 */
        cliLogger.info('SERVER', `pauseAll: session ${sessionId} 没在跑, 无从暂停`);
        return { mainPaused: false, workersPaused: 0 };
      }
      setRunStatus(sessionId, 'paused');
      cliLogger.info('SERVER', `pauseAll: ${sessionId} 将在本轮工具跑完后挂起`);
      return { mainPaused: true, workersPaused: 0 };
    },

    /** 恢复 —— 从下一轮接着跑 (不是让用户重发)。 */
    resumeAll(sessionId) {
      const ok = resumeSession(sessionId);
      if (!ok) {
        cliLogger.warn('SERVER', `resumeAll: session ${sessionId} 本来就没暂停`);
        return { mainResumed: false, workersResumed: 0 };
      }
      /* 回 running 而不是 idle —— 它确实还在跑, 只是刚才被挂住了。
       * 置 idle 会让侧栏那行 spinner 停掉, 而模型下一秒就接着吐字。 */
      setRunStatus(sessionId, 'running');
      return { mainResumed: true, workersResumed: 0 };
    },

    pauseProcess(_pid) {
      return false;
    },

    resumeProcess(_pid) {
      return false;
    },

    replyPermission(requestId, approved, _message, remember) {
      const pending = resolvePendingPermission({
        requestId,
        result: { approved, remember: remember === true },
        reason: 'resolved',
        approvedForEvent: approved,
      });
      if (!pending) {
        cliLogger.warn('SERVER_AUDIT', `permission reply ignored: requestId=${requestId} not found`);
        return;
      }
      const elapsedMs = Math.max(0, Date.now() - pending.createdAt);
      cliLogger.info(
        'SERVER_AUDIT',
        `permission request resolved: requestId=${requestId} tool=${pending.tool} risk=${pending.risk?.level ?? 'low'} approved=${approved} remember=${remember === true} session=${pending.sessionId} elapsedMs=${elapsedMs}`,
      );
    },

    cancelPermission(requestId, reason) {
      const resolved = resolvePendingPermission({
        requestId,
        result: { approved: false, remember: false },
        reason: reason ?? 'manual_cancel',
      });
      if (!resolved) {
        cliLogger.warn('SERVER_AUDIT', `permission cancel ignored: requestId=${requestId} not found`);
        return;
      }
      const elapsedMs = Math.max(0, Date.now() - resolved.createdAt);
      cliLogger.info(
        'SERVER_AUDIT',
        `permission request cancelled: requestId=${requestId} tool=${resolved.tool} risk=${resolved.risk?.level ?? 'low'} reason=${reason ?? 'manual_cancel'} session=${resolved.sessionId} elapsedMs=${elapsedMs}`,
      );
    },

    async replyAskUser(requestId, answers) {
      const safeAnswers = answers || {};

      /* fast path — 服务没死过, 内存 Map 有 entry, Promise.resolve 就完事了 */
      const status = resolveUserQuestion(requestId, safeAnswers);
      if (status === 'resolved') {
        exitWaitingByRequestId('user', requestId);
        return { status: 'resolved' as const };
      }

      /* 内存没命中 → 看磁盘是否有持久化记录. 有 = 服务重启过, 走 resume 路径:
       * 1. 把 formatted answer 当 tool_result message 追加到 SessionContext
       *    (跟 in-memory 路径里 Promise.resolve(formatted) 后 agentLoop 写入消息历史等价)
       * 2. consume disk row (DELETE 完成)
       * 3. agenticRuntime.chat({sessionId, prompt:'', isResume:true}) 让 LLM 续接.
       *    repairMessageHistory 会跳过本 toolCallId (它已经有真实 tool_result 不是孤儿了).
       *
       * 都没命中 → orphan: 服务在 ask_user 期间死过, 还没等到 schema 升级前的旧数据
       * 或表损坏. UI 应当提示用户改用普通消息重发. */
      const store = getPendingAskUserStore();
      const record = store?.consume(requestId);
      if (!record) {
        cliLogger.warn('SERVER', `replyAskUser orphan: requestId=${requestId}, no in-memory or disk pending`);
        return {
          status: 'orphan' as const,
          reason: 'pending entry not found in memory or on disk',
        };
      }

      try {
        const formatted = formatAnswersForResume(record.questions, safeAnswers);
        const ctx = SessionContext.get(record.sessionId);
        const now = Date.now();
        /* tool_call_id 用 toolCallId 本身; raw 同 repairMessageHistory 的格式 */
        ctx.appendMessage('tool', formatted, '', now, {
          role: 'tool',
          tool_call_id: record.toolCallId,
          content: formatted,
        });
        cliLogger.info('SERVER',
          `replyAskUser resumed: session=${record.sessionId} toolCallId=${record.toolCallId}`,
        );
      } catch (err: any) {
        cliLogger.error('SERVER',
          `replyAskUser failed to append tool_result for session=${record.sessionId}: ${err?.message}`);
        return { status: 'orphan' as const, reason: `failed to persist answer: ${err?.message}` };
      }

      /* 触发 isResume chat — 不 await, 让 SSE 流自然走. agenticRuntime 不就绪
       * (e.g. server 刚启动 singleRuntime 还没构造完) 时降级为 orphan. */
      if (!singleRuntime) {
        cliLogger.warn('SERVER',
          `replyAskUser: agentic runtime not ready for session=${record.sessionId}, will rely on next user message to drive resume`);
        return {
          status: 'resumed' as const,
          reason: 'answer persisted but runtime not yet ready; will continue on next interaction',
        };
      }

      void singleRuntime
        .chat({
          sessionId: record.sessionId,
          prompt: '',
          isResume: true,
        })
        .catch((err: any) => {
          cliLogger.error('SERVER',
            `replyAskUser resume chat threw for session=${record.sessionId}: ${err?.message}`);
        });

      return { status: 'resumed' as const };
    },

    getActiveSessions() {
      return [...activeSessions];
    },

    setRunMode(mode) {
      if (ModeFactory.isValidMode(mode as AgentRunMode)) {
        currentMode = mode as AgentRunMode;
        cliLogger.info('SERVER', `Run mode changed to: ${currentMode}`);
      }
    },

    getRunMode() {
      return currentMode;
    },

    setAgentMode(sessionId, mode) {
      return singleRuntime?.setSessionAgentMode(sessionId, mode) ?? 'code';
    },

    getAgentMode(sessionId) {
      return singleRuntime?.getSessionAgentMode(sessionId) ?? 'code';
    },

    jevPrefetch(text) {
      /* 不经 singleRuntime: 启动后第一条消息发出前它还没建 */
      sharedJevToolPreloader.prefetch(text);
    },

    injectMessage(sessionId, message, images) {
      return singleRuntime?.injectMessageToSession(sessionId, message, images) ?? 0;
    },

    /* 第二次回车 = 立即转向 (见 host.requestSteeringInterrupt): 模型输出中 → 打断, 工具执行中 → false */
    steerSession(sessionId) {
      return singleRuntime?.steerSession(sessionId) ?? false;
    },

    /* 没排上的真实原因 —— 区分"无 host"和"host 没在跑", 两者修法完全不同。 */
    describeInjectTarget(sessionId) {
      return singleRuntime?.describeInjectTarget(sessionId)
        ?? { hasHost: false, isRunning: false, hostSessionIds: [] };
    },

    /* 撤回最后一条排队消息 (↑ 拉回输入框编辑), 返回其文本 */
    removeLastPendingMessage(sessionId) {
      return singleRuntime?.removeLastPendingFromSession(sessionId) ?? null;
    },

    /* 三个都 async 并且**等 import 落定再返回** —— 调用方 (IPC) await 完才发消息,
     * 否则授权可能晚于 activate_target 到达, 又变成偶发拒绝。 */
    async grantTargetConsent(sessionId) {
      if (!sessionId) return;
      const { grantTargetConsent: grant } = await import('../tools/targetModeTools.js');
      grant(sessionId);
      cliLogger.info('TARGET', `consent granted on runtime thread for ${sessionId}`);
    },

    async rememberTargetUserText(sessionId, text) {
      if (!sessionId || !text) return;
      const { rememberUserText } = await import('../tools/targetModeTools.js');
      rememberUserText?.(sessionId, text);
    },

    async hasTargetConsent(sessionId) {
      if (!sessionId) return false;
      const { hasTargetConsent } = await import('../tools/targetModeTools.js');
      return hasTargetConsent(sessionId);
    },

    async assignTeamRequirement(sessionId: string, requirementId: string, memberId: string | null) {
      if (!sessionId || !requirementId) return null;
      const { assignRequirement } = await import('../runtime/team/teamPlanStore.js');
      const plan = assignRequirement(sessionId, requirementId, memberId);
      return plan ? JSON.parse(JSON.stringify(plan)) : null;
    },

    async teamDismiss(sessionId: string, force?: boolean) {
      if (!sessionId) return { ok: false, reason: 'missing sessionId' };
      const execMod = await import('../runtime/team/teamExecStore.js');
      const st = execMod.getTeamExec(sessionId);
      const running = st?.status === 'running' && st.tasks.some((t) => t.state === 'running');
      if (running && !force) {
        return { ok: false, reason: 'running', runningTasks: st!.tasks.filter((t) => t.state === 'running').map((t) => t.id) };
      }
      if (st) execMod.setTeamExecStatus(sessionId, 'aborted');
      execMod.clearTeamExec(sessionId);
      const planMod = await import('../runtime/team/teamPlanStore.js');
      /* purge 而不是 clear: 存档必须一起删, 否则下次启动团队自己回来 */
      planMod.purgeTeamPlan(sessionId);
      return { ok: true };
    },

    async teamExecCommand(sessionId: string, cmd: 'retry' | 'skip' | 'reassign', taskId: string, arg?: string) {
      if (!sessionId || !taskId) return null;
      const execMod = await import('../runtime/team/teamExecStore.js');
      const st = cmd === 'retry' ? execMod.retryTask(sessionId, taskId)
        : cmd === 'skip' ? execMod.skipTask(sessionId, taskId, arg || '用户在看板上跳过')
          : cmd === 'reassign' && arg ? execMod.reassignTask(sessionId, taskId, arg)
            : null;
      /* 改派要同步规划的 claims —— 否则看板两页显示两个主人 (那病今晚犯过) */
      if (st && cmd === 'reassign' && arg) {
        const { assignRequirement } = await import('../runtime/team/teamPlanStore.js');
        assignRequirement(sessionId, taskId, arg);
      }
      return st ? JSON.parse(JSON.stringify(st)) : null;
    },

    async targetCommand(sessionId, cmd, arg) {
      if (!sessionId) return { live: false, ok: false, error: 'missing sessionId' };
      const {
        hasLiveTargetSlot,
        pauseTargetMission,
        continueTargetMission,
        abandonTargetFromCommand,
        resetTargetMode,
        refineTargetMission,
        getTargetStatus,
      } = await import('../tools/targetModeTools.js');
      if (!hasLiveTargetSlot(sessionId)) return { live: false, ok: false };
      let ok = false;
      switch (cmd) {
        case 'pause': ok = pauseTargetMission(arg, sessionId); break;
        case 'continue': ok = continueTargetMission(sessionId); break;
        case 'stop': ok = abandonTargetFromCommand(arg, sessionId); break;
        case 'off': resetTargetMode(sessionId); ok = true; break;
        case 'refine': ok = arg ? refineTargetMission(arg, 'User refine (desktop)', sessionId) : false; break;
        default: return { live: true, ok: false, error: `unknown target command: ${cmd}` };
      }
      const status = getTargetStatus(sessionId);
      cliLogger.info('TARGET', `command '${cmd}' on runtime thread → ok=${ok} status=${status}`, { sessionId });
      return { live: true, ok, status };
    },

    /* leader/steward 团队 API 随 assistant 模式一并移除 (未来由 neox-colony 重建)。 */
    createLeaderTeam(_sessionId, _goal) {
      throw new Error('assistant/leader 模式已移除');
    },

    leaderRecruitMember(_sessionId, _teamId, _payload) {
      throw new Error('assistant/leader 模式已移除');
    },

    leaderRequestCapability(_sessionId, _teamId, _capability, _reason) {
      throw new Error('assistant/leader 模式已移除');
    },

    getStewardRuntimeSnapshot(_sessionId) {
      throw new Error('assistant/steward 模式已移除');
    },

    // ---- Session / Host 管理 ----
    setSandboxMode(_sessionId, enabled) {
      setSandboxEnabled(enabled);
    },

    setApprovalMode(_sessionId, mode, options) {
      setApprovalModeHandler({
        mode,
        scope: options?.scope,
        scopeKey: options?.scopeKey,
        inherit: options?.inherit,
        approvalModeResolver,
        singleRuntime,
        permissionManager,
      });
    },

    /* per-session approval mode 读 — 走 ApprovalModeResolver.resolveByScope, 这层已经
     *  覆盖了 'agent' scope 跟 fallback 到 global. 启动时 seedResolverFromDb 已把 DB 持久化的
     *  scoped mode 灌回, 这里 sync 读即可. UI 用它替代之前 electron 本地缓存 Map (撒谎). */
    getApprovalMode(sessionId) {
      return approvalModeResolver.resolveByScope(sessionId);
    },

    async compactSession(sessionId, modelOverride) {
      const { publishRawEvent } = createChatEventPublisher({
        bus,
        sessionId,
        ttsService,
      });
      await compactSessionHandler({
        sessionId,
        currentMode,
        singleRuntime,
        onEvent: (event) => publishRawEvent(event),
        modelOverride,
      });
    },

    forgetSession(sessionId) {
      resolveSessionMemory(singleRuntime, memory, sessionId).clear();
      SessionContext.reset(sessionId);
      cliLogger.info('SERVER', `Forgot session: ${sessionId} (memory + SessionContext, no archive)`);
    },

    clearSession(sessionId) {
      /* R2 wire (desktop): desktop 关 session 走 clearSession (而非 clearMemory).
       *   关 session 比 /clear 更明确"会话结束" — 更应该保存摘要. fire-and-forget
       *   触发 W4 saveSessionMemoryNow, 不阻塞 close. 失败静默. */
      try {
        singleRuntime?.saveSessionMemoryNow?.(sessionId).catch(() => { /* 静默 */ });
      } catch { /* 静默 */ }
      resolveSessionMemory(singleRuntime, memory, sessionId).clear();
      SessionContext.reset(sessionId);
      cliLogger.info('SERVER', `Cleared session: ${sessionId} (memory + SessionContext)`);
    },

    getContextHealth(sessionId) {
      const mem = resolveSessionMemory(singleRuntime, memory, sessionId);
      const health = mem.checkContextHealth?.() ?? null;
      if (!health) return null;
      const contextWindow = singleRuntime?.getSessionContextWindow(sessionId);
      return { ...health, contextWindow };
    },

    async getSessionInfo(sessionId) {
      const mem = resolveSessionMemory(singleRuntime, memory, sessionId);
      const messages = mem.getAll();
      const turnCount = messages.filter((m: { role?: string }) => m.role === 'user').length;
      return {
        sessionId,
        messageCount: mem.length,
        turnCount,
        messages,
      };
    },

    setCompressionMode(_sessionId, mode) {
      singleRuntime?.setContextCompression({ mode });
      cliLogger.info('SERVER', `Compression mode set to: ${mode}`);
    },

    /** 设置页的触发阈值 (0..1) 与自动压缩开关。传 undefined 表示该项不动。 */
    setContextCompression(_sessionId, next) {
      singleRuntime?.setContextCompression(next);
      cliLogger.info(
        'SERVER',
        `Context compression set: threshold=${next.threshold ?? 'default'} auto=${next.autoEnabled ?? 'unchanged'}`,
      );
    },

    // ---- Memory ----
    getMemoryStats(sessionId) {
      const mem = resolveSessionMemory(singleRuntime, memory, sessionId);
      return {
        length: mem.length,
        contextHealth: mem.checkContextHealth?.() ?? null,
      };
    },

    clearMemory(sessionId) {
      try {
        singleRuntime?.saveSessionMemoryNow?.(sessionId).catch(() => { /* 静默 */ });
      } catch { /* 静默 */ }
      resolveSessionMemory(singleRuntime, memory, sessionId).clear();
    },

    addMemoryMessage(sessionId, role, content) {
      const mem = resolveSessionMemory(singleRuntime, memory, sessionId);
      mem.add({ role: role as any, content });
    },

    setMemoryMessages(sessionId, messages: Message[]) {
      const mem = resolveSessionMemory(singleRuntime, memory, sessionId);
      const list = Array.isArray(messages) ? messages : [];
      mem.setMessages(list);
      if (list.length > 0) {
        void runWithChatSession(sessionId, () => import('../tools/smart-read/ledgerRebuild.js')
          .then(({ rebuildReadLedgerFromHistory }) => rebuildReadLedgerFromHistory(
            list as any[],
            (p) => (p.startsWith('/') ? p : pathResolve(workDir, p)),
            'desktop_set_memory_messages',
          ))
          .catch(() => { /* 非阻塞: 失败只退化成"多读一次" */ }));
      }
    },

    ...createToolWorkspaceBridgeHandlers({
      platformServices,
      actionLog,
      tools,
      checkpointService,
      mcpManager,
    }),

    ...createCheckpointBridgeHandlers({ checkpointService }),

    ...createHostBridgeHandlers({
      workDir,
      activeSessions,
      abortControllers,
      getCurrentMode: () => currentMode,
      memory,
      singleRuntime,
      chat: (sessionId, request) => bridge.chat(sessionId, request),
    }),

    ...createTTSBridgeHandlers({
      ttsService,
      defaultProvider,
      initialTTSConfig: config.tts,
    }),

    ...createSTTBridgeHandlers({
      defaultProvider,
      sttConfig: config.stt,
    }),

    // =========================================================================
    // =========================================================================

    getVersion() {
      return VERSION;
    },

    getKernelDiagnostics() {
      /* Agent OS kernel 随 assistant 模式一并移除。 */
      return null;
    },

    // runtime 仍使用旧 workDir（system prompt 中的工作目录不对）
    async setWorkspace(newWorkDir: string) {
      const resolved = pathResolve(newWorkDir);
      cliLogger.info('SERVER', `setWorkspace: ${workDir} → ${resolved}`);
      workDir = resolved;
      process.env.NEOX_WORKDIR = resolved;
      // 更新 baseConfig
      (baseConfig as any).workDir = resolved;
      // 更新 singleRuntime 的 workDir
      if (singleRuntime && typeof (singleRuntime as any).setWorkDir === 'function') {
        (singleRuntime as any).setWorkDir(resolved);
      }
      // 更新 checkpoint 服务
      checkpointService.setWorkspace(resolved);
      /* 项目指令重扫 — 切工作区是唯一需要主动读盘的时机 (新目录可能有自己的 NEOX.md,
       * 也可能用户刚编辑过). hash 没变时 refresh 不换对象引用, 不会误伤前缀缓存. */
      await refreshProjectInstructions(resolved);
      /* 角色也跟着换工作区 —— 新目录可能有自己的 .neox/agents/, 也可能一个都没有
       * (那时要把上一个工作区的清掉, initialize 内部负责)。 */
      try {
        const { agentTypeRegistry } = await import('../runtime/agent/agentTypeRegistry.js');
        await agentTypeRegistry.initialize(resolved);
      } catch { /* 加载失败退回内置类型, 不影响切工作区本身 */ }
    },

    ...createMcpBridgeHandlers({ workDir, mcpManager, tools }),

    ...createSkillsBridgeHandlers({ workDir }),

    ...createIndexBridgeHandlers({ workDir }),
  };

  /* schedule_wakeup 触发回调 — 60s 后 timer 到点时,代用户起一轮 chat,
     把 <scheduled-wakeup> XML 当 prompt 喂给同 sessionId, 用同样的 provider/model.
     bridge.chat 是 fire-and-forget,异常吞掉只 log,不要打断 timer 后续. */
  setWakeupTriggerHandler(({ sessionId, xml, reason }) => {
    if (!sessionId) {
      cliLogger.warn('WAKEUP', `trigger fired but sessionId empty — dropping`);
      return;
    }
    const meta = lastChatMetaBySession.get(sessionId);
    if (!meta) {
      cliLogger.warn('WAKEUP', `trigger fired for unknown session ${sessionId} (no chat meta) — dropping`);
      return;
    }
    cliLogger.info(
      'WAKEUP',
      `Auto-resuming session ${sessionId} for wakeup — provider=${meta.providerId} model=${meta.modelName} reason="${reason.slice(0, 60)}"`,
    );
    void bridge.chat(sessionId, {
      prompt: xml,
      providerId: meta.providerId,
      modelName: meta.modelName,
    } as any).catch((err: any) => {
      cliLogger.error('WAKEUP', `bridge.chat failed for wakeup session ${sessionId}: ${err?.message ?? err}`);
    });
  });

  setTurnStallHandlers({
    /* 没有事件 ≠ 停滞。工具执行期间本来就没有运行时事件 (一个 8 分钟的 build 中途
     * 一个事件都没有), 所以开火前必须确认底下真的没东西在跑, 否则会误杀长任务。
     * inflight = 正在执行中的工具; processes = 被追踪的子进程 (含转后台的)。 */
    hasLiveWork: () => {
      try {
        /* inflight = 正在执行中的工具 (stallGuard 在 execute stage 登记的) */
        if (getInflightStalls(0).length > 0) return true;
        /* 被追踪的子进程 — 含超时转后台的那些 */
        processManager.refreshStatus();
        if (processManager.getBackgroundRunning().length > 0) return true;
      } catch {
        /* 探针不可用时按"有活"处理: 宁可晚点开火, 也不能因为探针挂了误杀正常长任务 */
        return true;
      }
      return false;
    },

    onWarn: ({ sessionId, silentMs, lastSignal }) => {
      cliLogger.warn('TURN_STALL',
        `session ${sessionId} 静默 ${Math.round(silentMs / 1000)}s (最后: ${lastSignal}) — 底下确认无活在跑`);
    },

    onRecover: async ({ sessionId, silentMs, lastSignal }, message) => {
      const meta = lastChatMetaBySession.get(sessionId);
      if (!meta) {
        cliLogger.warn('TURN_STALL', `session ${sessionId} 无 chat meta, 无法唤醒`);
        return false;
      }
      cliLogger.warn('TURN_STALL',
        `session ${sessionId} 停滞 ${Math.round(silentMs / 1000)}s (最后: ${lastSignal}) → abort 当前 turn 并注入恢复信息`);
      try {
        /* 先掐断卡死的那一轮 —— 它正卡在一个永远不会 settle 的 await 上 */
        bridge.abort?.(sessionId);
      } catch (err) {
        cliLogger.warn('TURN_STALL', `abort 失败(继续尝试唤醒): ${(err as Error)?.message}`);
      }
      /* 给 abort 一点时间落地, 避免新一轮跟旧一轮的清理互相踩 */
      await new Promise((r) => setTimeout(r, 400));
      try {
        void bridge.chat(sessionId, {
          prompt: message,
          providerId: meta.providerId,
          modelName: meta.modelName,
        } as any).catch((err: any) => {
          cliLogger.error('TURN_STALL', `恢复轮 chat 失败 session=${sessionId}: ${err?.message ?? err}`);
        });
        return true;
      } catch (err) {
        cliLogger.error('TURN_STALL', `无法起恢复轮: ${(err as Error)?.message}`);
        return false;
      }
    },

    onAbort: async ({ sessionId, silentMs }, reason) => {
      cliLogger.error('TURN_STALL',
        `session ${sessionId} 停滞 ${Math.round(silentMs / 1000)}s 且自动恢复无效 → 终止本轮。${reason}`);
      /* abort 让这一轮真正结束 —— UI 侧的运行态随之收敛, 不再留一个假装在跑的 turn */
      try { bridge.abort?.(sessionId); } catch { /* 已经没在跑就算了 */ }
    },
  });

  /* 后台 shell 任务完成 / task-agent 完成 / wakeup 之外的所有 enqueueMessageForSession
     都会触发. agentLoop 退出后队列里的 XML 由这里代用户起新一轮 chat 把它喂进去 —
     用户不用手动发消息也能看到 agent 自动回话报告任务结果. */
  setBgTaskSessionActiveCheck((sessionId) => activeSessions.has(sessionId));
  setBgTaskAutoResumeHandler(async ({ sessionId, xml, command, status, terminatedBy }) => {
    if (terminatedBy === 'user') {
      const { appendDiagLog: diagU } = await import('../runtime/agent/diagLogFile.js');
      getBackgroundTaskNotifier().drainForSession(sessionId);
      cliLogger.info('BG_NOTIFIER',
        `task stopped by user (cmd="${command.slice(0, 60)}") → drop notif, skip auto-resume`);
      diagU('BG_AUTO_RESUME/skip', { reason: 'terminated_by_user', sessionId });
      return;
    }
    /* 关键诊断 — 把全过程写到 ~/neox-explore-debug.log, 用户可 grep BG_AUTO_RESUME 看分支 */
    const { appendDiagLog: diag } = await import('../runtime/agent/diagLogFile.js');
    const knownChatSessions = Array.from(lastChatMetaBySession.keys());
    diag('BG_AUTO_RESUME/handler', {
      sessionId,
      hasMetaForSession: lastChatMetaBySession.has(sessionId),
      sessionIsActive: activeSessions.has(sessionId),
      knownChatSessions,
      activeSessions: Array.from(activeSessions),
      command: command.slice(0, 60),
      status,
    });

    if (!sessionId) {
      cliLogger.warn('BG_NOTIFIER', `auto-resume fired but sessionId empty — dropping`);
      diag('BG_AUTO_RESUME/skip', { reason: 'empty_sessionId' });
      return;
    }
    /* 如果该 session 当前还有 active chat 在跑(agentLoop 没退出), 就不要重复起一轮 —
       loop 自己每轮开头的 drainForSession 会把这条 XML 注进去. activeSessions 是 server
       级的活跃 chat 集合, 不在里面就是 loop 退了. */
    if (activeSessions.has(sessionId)) {
      cliLogger.debug('BG_NOTIFIER',
        `session ${sessionId} still active, skip auto-resume (agentLoop will drain naturally) — pid=${command}`);
      diag('BG_AUTO_RESUME/skip', { reason: 'session_still_active', sessionId });
      return;
    }
    const abortedAt = recentlyAbortedAt.get(sessionId);
    if (abortedAt && Date.now() - abortedAt < ABORT_SUPPRESS_RESUME_MS) {
      getBackgroundTaskNotifier().drainForSession(sessionId);
      cliLogger.info('BG_NOTIFIER',
        `session ${sessionId} just aborted by user (${Date.now() - abortedAt}ms ago) → drop bg-task notif, skip auto-resume`);
      diag('BG_AUTO_RESUME/skip', { reason: 'recently_aborted', sessionId, agoMs: Date.now() - abortedAt });
      return;
    }
    const meta = lastChatMetaBySession.get(sessionId);
    if (!meta) {
      cliLogger.warn('BG_NOTIFIER',
        `auto-resume fired for unknown session ${sessionId} (no chat meta) — dropping. status=${status} cmd=${command.slice(0, 60)}`);
      diag('BG_AUTO_RESUME/skip', { reason: 'no_chat_meta', sessionId, knownChatSessions });
      return;
    }
    cliLogger.info(
      'BG_NOTIFIER',
      `Auto-resuming session ${sessionId} for bg-task-notification — provider=${meta.providerId} model=${meta.modelName} status=${status} cmd="${command.slice(0, 60)}"`,
    );
    diag('BG_AUTO_RESUME/dispatch', { sessionId, providerId: meta.providerId, modelName: meta.modelName });
    void bridge.chat(sessionId, {
      prompt: xml,
      providerId: meta.providerId,
      modelName: meta.modelName,
    } as any).catch((err: any) => {
      cliLogger.error('BG_NOTIFIER', `bridge.chat failed for bg-task session ${sessionId}: ${err?.message ?? err}`);
      diag('BG_AUTO_RESUME/chatFail', { sessionId, error: err?.message ?? String(err) });
    });
  });

  setCronWorkspaceRoot(workDir);

  setCronFireCallback((job, ctx) => {
    if (!job.sessionId) {
      cliLogger.error('CRON',
        `job ${job.id} (${job.cron}) fired but has no sessionId — cannot dispatch prompt, dropping this occurrence`);
      return;
    }
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts = [
      `<cron>${esc(job.cron)}</cron>`,
      `<prompt>${esc(job.prompt)}</prompt>`,
    ];
    /* 迟到超过 1 分钟 (机器休眠/关机) → 明确告诉 agent 本该几点跑, 别当准点汇报. */
    if (ctx.lateByMs > 60_000) {
      parts.push(`<scheduled-for>${new Date(ctx.dueAt).toLocaleString()}</scheduled-for>`);
      parts.push(`<late-by-minutes>${Math.round(ctx.lateByMs / 60_000)}</late-by-minutes>`);
    }
    const xml = `<scheduled-task-fired>${parts.join('')}</scheduled-task-fired>`;
    cliLogger.info('CRON',
      `job ${job.id} (${job.cron}) fired → enqueue for session ${job.sessionId}` +
      (ctx.lateByMs > 60_000 ? ` (late by ${Math.round(ctx.lateByMs / 60_000)}min)` : ''));
    getBackgroundTaskNotifier().enqueueMessageForSession(job.sessionId, xml, {
      command: `cron ${job.cron}: ${job.prompt.slice(0, 40)}`,
      pid: 0,
      status: 'completed',
    });
  });

  /* 重启恢复: durable job 存在 .neox/scheduled_tasks.json, 每 tick 从磁盘重读.
   * 在这里无条件起 scheduler (而不是只在 cron_create 里懒启动), 否则重启后没人
   * 再调 cron_create 的话, 盘上的 durable job 永远不会被扫到. */
  startCronScheduler();

  if (!hostOptions?.oneShot && process.env.NEOX_DISABLE_CHANNELS !== '1') {
    const { ChannelRegistry } = await import('../channels/registry.js');
    const channelRegistry = new ChannelRegistry();
    bridge.channels = channelRegistry;
    try {
      await setupChannelAdapters({ channelRegistry, channelConfig: config.channels ?? {}, bus, bridge });
    } catch (err: any) {
      cliLogger.warn('SERVER', `Channel 适配器启动失败: ${err?.message ?? err}`);
    }
  }

  return bridge;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { port, workDir, daemon, identityDir } = parseServerArgs();
  const config = loadConfig();
  const remoteConfig = config.remote ?? {};

  cliLogger.info('SERVER', `Starting Neox Server on port ${port}, workDir: ${workDir}`);

  try {
    const { migrateLiteHomeToStandard } = await import('@neoxlabs/platform/platform/database.js');
    const lite = migrateLiteHomeToStandard();
    if (!lite.skipped) cliLogger.info('SERVER', `lite-home merge: ${lite.files} file(s) → ~/.neox`);
  } catch (err: any) {
    cliLogger.warn('SERVER', `lite-home merge skipped: ${err?.message ?? err}`);
  }

  /* Neox routing 共享文件 — 让 desktop main 进程把 (gatewayKey, plan, gatewayBase) 透传到 server.
   *   优先 env (容器场景), 否则 ~/.neox/routing.json. 文件不存在就静默 no-op, 不报错.
   *   读取后透明改写 LLM 请求让 LLM 调用走 Neox 网关. */
  try {
    const { installDbBasedRoutingResolver } = await import('@neoxlabs/platform/platform/providerResolver.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const routingFile = process.env.NEOX_ROUTING_FILE
      || path.default.join(os.default.homedir(), NEOX_HOME_DIRNAME, 'routing.json');
    await installDbBasedRoutingResolver(routingFile);
    cliLogger.info('SERVER', `Neox routing resolver installed (file=${routingFile})`);
  } catch (err: any) {
    cliLogger.warn('SERVER', `Neox routing resolver install failed: ${err?.message ?? err}`);
  }

  try {
    const { setNeoxDeviceFp } = await import('@neoxlabs/kernel/models/openai.js');
    const { computeDeviceFpHash } = await import('@neoxlabs/platform/platform/deviceFingerprint.js');
    const fp = (process.env.NEOX_DEVICE_FP ?? '').trim() || computeDeviceFpHash() || '';
    setNeoxDeviceFp(fp);
    cliLogger.info('SERVER', fp ? `device fp installed (${fp.slice(0, 8)}...)` : 'device fp UNAVAILABLE — cloud 请求会被网关拒');
  } catch (err: any) {
    cliLogger.error('SERVER', `device fp install failed: ${err?.message ?? err}`);
  }

  if (identityDir) {
    try {
      const { setCredentialProvider } = await import('@neoxlabs/platform/platform/providerResolver.js');
      const { readGatewayCredentialFromDir, readIdentityUserId } = await import('@neoxlabs/platform/platform/identityCredential.js');
      const idDir = identityDir;
      setCredentialProvider(() => readGatewayCredentialFromDir(idDir));
      /* 同步 currentUserId: 让 loadConfig 读对 per-user 桶, 不被 routing.json 里被覆盖/陈旧的 userId 带偏。 */
      try {
        const uid = readIdentityUserId(idDir);
        if (uid) {
          const { setCurrentUserId } = await import('@neoxlabs/platform/utils/config.js');
          setCurrentUserId(uid);
        }
      } catch { /* 非致命 */ }
      cliLogger.info('SERVER', `Credential provider installed (identity-dir=${idDir})`);
    } catch (err: any) {
      cliLogger.warn('SERVER', `Credential provider install failed: ${err?.message ?? err}`);
    }
  }

  // Auth token 来源优先级: NEOX_TOKEN env > config.remote.token > 32 字节 random hex.
  // env 路径用于 Docker 部署 / processManager spawn; random 路径覆盖本地默认场景.
  const authToken: string =
    process.env.NEOX_TOKEN
    || (remoteConfig as any).token
    || randomBytes(32).toString('hex');

  const bus = new EventBus();
  /* 子会话 timeline 落盘通知接到 bus (见 notifySubAgentTimelineUpdated 注释) */
  subAgentTimelineBus = bus;
  const deviceManager = new DeviceManager();
  const bridge = await initRuntimeBridge(workDir, bus);

  if (process.env.NEOX_DEVTOOLS === '1') {
    const devtoolsPkg = '@neoxlabs/devtools';
    import(devtoolsPkg)
      .then((m: any) => m.attachMonitorToEventBus?.({
        bus,
        serve: { port: Number(process.env.NEOX_DEVTOOLS_PORT) || 7399 },
        onLog: (msg: string) => cliLogger.info('DEVTOOLS', msg),
      }))
      .catch((e: any) => cliLogger.debug('DEVTOOLS', `deep-mode attach skipped: ${e?.message ?? e}`));
  }

  const serverConfig = buildServerConfig({ workDir, port, remoteConfig, authToken });

  const sessionManager = new SessionManager({
    maxSessions: 100,
    sessionTTL: 24 * 60 * 60 * 1000, // 24h
  });

  const { app, channelRegistry } = createNeoxServer(serverConfig, bridge, bus, deviceManager, sessionManager);

  (bridge as unknown as { handleLocalRequest?: unknown }).handleLocalRequest =
    async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const hasBody = body !== undefined && method !== 'GET' && method !== 'DELETE';
      const res = await app.request(path, {
        method,
        ...(hasBody ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
      }
      /* 204 / 空 body 的路由 (很多 POST 只回 {status:'ok'}) 也要能安全解析 */
      const raw = await res.text();
      if (!raw) return undefined;
      try { return JSON.parse(raw); } catch { return raw; }
    };

  if (process.env.NEOX_DAEMON === '1' && process.env.NEOX_NO_IDLE_EXIT !== '1') {
    const idleMs = Math.max(60_000, Number(process.env.NEOX_DAEMON_IDLE_MS ?? '600000')); // 默认 10min, 下限 1min
    const idleTimer = setInterval(() => {
      try {
        if (getActiveSseClients() > 0) return;                    // 有客户端连着
        if ((bridge.getActiveSessions?.() ?? []).length > 0) return; // 有任务在跑
        if (Date.now() - getLastActivityTs() < idleMs) return;    // 还没闲够
        cliLogger.info('SERVER', `daemon 空闲 ${Math.round(idleMs / 1000)}s (无客户端/任务) — 自动退出, 解锁 binary; 下次用时自动重启`);
        try { removePidFile(workDir); } catch { /* ignore */ }
        process.exit(0);
      } catch { /* ignore */ }
    }, 60_000);
    idleTimer.unref();
  }

  /* channel 适配器已在 initRuntimeBridge 里起好 (bridge.channels), 这里不再重复 */

  const stopSkillsWatch = await setupSkillsHotReload(workDir);

  let stopAgentTypesWatch: (() => void) | null = null;
  try {
    const { agentTypeRegistry } = await import('../runtime/agent/agentTypeRegistry.js');
    await agentTypeRegistry.initialize(workDir);
    /* 热加载: 角色文件是要反复试出来的 (改一句提示、换个模型、收一收工具集),
     * 每改一次都重启应用的话第二次就没人改了。跟 skills 同一条生命周期。 */
    agentTypeRegistry.watch(workDir);
    stopAgentTypesWatch = () => agentTypeRegistry.stopWatch();
  } catch (err) {
    cliLogger.warn('SERVER', `自定义 agent 角色加载失败, 只用内置类型: ${err instanceof Error ? err.message : String(err)}`);
  }

  const hostname = resolveServerHostname(remoteConfig);

  startServerLifecycle({
    appFetch: app.fetch,
    port,
    hostname,
    workDir,
    daemon,
    identityDir,
    authToken,
    channelRegistry,
    deviceManager,
    bus,
    onBeforeShutdown: async () => {
      stopSkillsWatch?.();
      stopAgentTypesWatch?.();
      sessionManager.dispose();
      try {
        const r = await processManager.killAllTracked({ terminatedBy: 'system' });
        cliLogger.info('SERVER',
          `before-shutdown: killed=${r.killed} skipped(adopted)=${r.skipped} hardKilled=${r.hardKilled}`);
      } catch (err: any) {
        cliLogger.warn('SERVER', `before-shutdown killAllTracked failed: ${err?.message}`);
      }
    },
    onServerReady: (httpServer) => {
      attachWSGateway({
        server: httpServer,
        bridge,
        bus,
        authToken,
        sessionManager,
      }).then((gw) => {
        cliLogger.info('SERVER', `WebSocket gateway attached (ws://${hostname}:${port}/ws)`);
      }).catch((err) => {
        cliLogger.warn('SERVER', `WSGateway attach failed: ${(err as Error).message}`);
      });

      void scheduleResumeScan({
        source: 'http-server',
        workDir,
        bus,
        getSingleRuntime: () => (bridge.getAgenticRuntime?.() as any) ?? null,
        authToken,
      });

      void scheduleServiceInstanceReconcile();
    },
  });
}

/**
 * crash-resume — server bootstrap 后 800ms 跑 scanner.
 *
 * 延迟 800ms 是给 SSE 客户端连接窗口: 大多数 Electron app 跟 server 在同进程或本机,
 * 连接很快 (< 500ms). 即便慢一点错过, EventBus.replayFrom 会让重连客户端按 seq 回放.
 *
 * 失败 silently — 任何路径异常都不能炸 server bootstrap.
 */
let _resumeScanScheduled = false;

function scheduleResumeScan(opts: {
  workDir: string;
  bus: import('./eventBus.js').EventBus;
  getSingleRuntime: () => import('../runtime/agenticRuntime.js').AgenticRuntime | null;
  authToken: string;
  /** 哪条宿主路径触发的 — 进程内桌面 / HTTP server。只为日志, 不影响行为。 */
  source?: string;
}): void {
  /* 两条宿主路径都会调 (initRuntimeBridge 与 HTTP server 的 onListening), 只跑一次。 */
  if (_resumeScanScheduled) {
    cliLogger.debug('RESUME_SCAN', `already scheduled, skip duplicate from ${opts.source ?? 'unknown'}`);
    return;
  }
  _resumeScanScheduled = true;
  cliLogger.info('RESUME_SCAN', `scheduled by host=${opts.source ?? 'unknown'} workDir=${opts.workDir}`);
  setTimeout(() => {
    void runResumeScanAsync(opts).catch((err) => {
      cliLogger.warn('SERVER', `resume scan failed: ${err?.message || err}`);
    });
  }, 800);
}

async function runResumeScanAsync(opts: {
  workDir: string;
  bus: import('./eventBus.js').EventBus;
  getSingleRuntime: () => import('../runtime/agenticRuntime.js').AgenticRuntime | null;
  authToken: string;
}): Promise<void> {
  const runtime = opts.getSingleRuntime();
  if (!runtime) {
    cliLogger.debug('RESUME', 'no agentic runtime yet, skipping scan');
    return;
  }
  let db;
  try {
    db = getDatabase();
  } catch (err: any) {
    cliLogger.warn('RESUME', `getDatabase failed: ${err?.message} — skipping scan`);
    return;
  }
  const store = new InterruptedRunStore(db, opts.workDir);
  const currentToken = process.env.NEOX_SERVER_TOKEN || `pid:${process.pid}`;
  /* 这里把 NEOX_SERVER_TOKEN 也丢回 env, agenticRuntime.chat() 下次 recordStart 时
   * 用同一个 token. server 进程级 stable. */
  process.env.NEOX_SERVER_TOKEN = currentToken;

  await runResumeScanner({
    store,
    agenticRuntime: runtime,
    currentServerToken: currentToken,
    emitter: {
      emitResumed: (sessionId, repaired) => {
        opts.bus.publish({
          sessionId,
          type: 'session_resumed',
          data: {
            type: 'session_resumed',
            repairedToolCalls: repaired.repairedToolCalls,
            droppedPartialMessages: repaired.droppedPartialMessages,
            timestamp: Date.now(),
          } as any,
          timestamp: Date.now(),
        });
      },
      emitFailed: (sessionId, reason) => {
        opts.bus.publish({
          sessionId,
          type: 'session_resume_failed',
          data: {
            type: 'session_resume_failed',
            reason,
            timestamp: Date.now(),
          } as any,
          timestamp: Date.now(),
        });
      },
    },
  });
}

const __selfPath = fileURLToPath(import.meta.url);
const __entryPath = process.argv[1] ? pathResolve(process.argv[1]) : '';
const __isProcessEntry = __entryPath !== '' && __selfPath === __entryPath;
const __isDaemonEntry = __isProcessEntry
  && (process.env.NEOX_WORKER === 'server' || process.env.NEOX_DAEMON === '1');
if (__isDaemonEntry) main().catch(err => {
  cliLogger.error('SERVER', 'Failed to start server', { error: err });
  try {
    const msg = `[SERVER FATAL] Failed to start server: ${err?.stack || err?.message || String(err)}\n`;
    try { fsWriteSync(2, msg); } catch { /* ignore */ }
    const lf = process.env.NEOX_LOG_FILE;
    if (lf) { try { fsAppendFileSync(lf, msg); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  // 尝试获取 workDir 用于清理 PID 文件
  const { workDir } = parseServerArgs();
  removePidFile(workDir);
  process.exit(1);
});
