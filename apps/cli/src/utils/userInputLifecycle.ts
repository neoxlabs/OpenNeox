import { cliHealthMonitor, cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { colors } from '../constants.js';
import { cliPrintln } from './output.js';
import { tryRecoverableChatRetry } from './chatRecovery.js';
import { buildInputMetadata } from './inputMetadata.js';
import { buildImagesToDisplay } from './inputPreprocess.js';
import { handleRunningTaskInput } from './runningTaskInput.js';
import type { HostAttachment } from '@neoxlabs/core/runtime/runtimeTypes.js';
import type { AgentRunMode } from '@neoxlabs/core/runtime/modeFactory.js';
import type { InkUIAdapter } from '../ink/InkUIAdapter.js';

type InputImage = { path?: string; name?: string; mediaType?: string; data?: string };

export interface ChatPayloadLike {
  sessionId: string;
  prompt: string;
  mode: AgentRunMode;
  attachments?: HostAttachment[];
  providerId: string;
  modelName: string;
}

interface HandleUserInputExecutionErrorFlowOptions {
  error: any;
  userInput: string;
  chatPayload: ChatPayloadLike;
  uiController: InkUIAdapter | null;
  tryRecoverServerConnection: (reason: string) => Promise<boolean>;
  hasChatTransport: () => boolean;
  retryChat: () => Promise<void>;
}

export async function handleUserInputExecutionErrorFlow(
  options: HandleUserInputExecutionErrorFlowOptions,
): Promise<boolean> {
  if (options.error?.code === 'missing_provider') {
    const message = 'No provider configured. Use /provider add to configure one.';
    if (options.uiController) {
      options.uiController.updateStatus(message, 'error');
      options.uiController.addInfo(message);
    } else {
      cliPrintln(colors.warning(`  ⚠ ${message}`));
    }
    return true;
  }

  const errorMsg = options.error?.message || String(options.error) || 'Unknown error';
  cliLogger.error('Agent', 'Task execution failed', {
    error: errorMsg,
    stack: options.error?.stack,
    userInput: options.userInput.substring(0, 200),
  });

  const retryResult = await tryRecoverableChatRetry({
    errorMessage: errorMsg,
    showProgress: (message) => options.uiController?.updateStatus(message, 'info'),
    tryRecoverServerConnection: (reason) => options.tryRecoverServerConnection(reason),
    hasChatTransport: () => options.hasChatTransport(),
    retryChat: async () => {
      await options.retryChat();
    },
  });

  if (retryResult.retryError) {
    const retryError: any = retryResult.retryError;
    const retryMsg = retryError?.message || String(retryError) || 'Unknown error';
    cliLogger.error('Agent', 'Retry after recovery failed', {
      error: retryMsg,
      stack: retryError?.stack,
    });
    if (process.env.CLI_DEBUG === '1') {
      cliHealthMonitor.logStdinState('handleUserInput.afterRetry.error');
    }
    /* 抛出的错误(恢复后重试仍失败: 超时/传输层)不走 SSE 'error' 事件 → runtimeEvents 不会
     * 渲 timeline 红 ✗。只更底部状态条会被下一次按键覆盖, 用户可能没察觉本轮已失败。
     * 这里补一条 addError 持久化到 timeline (SSE 错误是另一条路径, 不会重复)。 */
    options.uiController?.addError(`Error: ${retryMsg}`);
    options.uiController?.updateStatus(`Error: ${retryMsg}`, 'error');
    return true;
  }

  if (retryResult.handled) {
    return true;
  }

  if (process.env.CLI_DEBUG === '1') {
    cliHealthMonitor.logStdinState('handleUserInput.afterRunTask.error');
  }
  /* 同上 — 抛出的错误(chat 启动 HTTP 失败 / 总超时 / 不可恢复)不经 SSE, 上游不会渲 timeline,
   * 这里补 addError 持久化, 否则用户只看到一闪而过的底部状态条。 */
  options.uiController?.addError(`Error: ${errorMsg}`);
  options.uiController?.updateStatus(`Error: ${errorMsg}`, 'error');
  return true;
}

interface FinalizeUserInputHandlingFlowOptions {
  setTaskRunning: (running: boolean) => void;
  stopTaskTimer: () => void;
  handleUserInput: (text: string) => void;
}

export function finalizeUserInputHandlingFlow(options: FinalizeUserInputHandlingFlowOptions): void {
  options.setTaskRunning(false);

  if (process.env.CLI_DEBUG === '1') {
    cliLogger.debug('INPUT', '=== handleUserInput finally block ===');
    cliLogger.debug('INPUT', `  stdin.isPaused: ${process.stdin.isPaused?.()}`);
    cliLogger.debug('INPUT', `  stdin.destroyed: ${process.stdin.destroyed}`);
    cliHealthMonitor.logStdinState('handleUserInput.finally');
  }

  options.stopTaskTimer();

  if (process.env.CLI_DEBUG === '1') {
    cliLogger.debug('INPUT', '=== handleUserInput END - input should be available now ===');
  }

  const queuedMessages: any[] = [];
  if (queuedMessages.length > 0) {
    const combinedText = queuedMessages.map((m) => m.text).join('\n\n');
    if (process.env.CLI_DEBUG) {
      cliLogger.debug('INPUT', `Processing ${queuedMessages.length} queued messages: "${combinedText.substring(0, 50)}..."`);
    }
    setImmediate(() => {
      options.handleUserInput(combinedText);
    });
  }
}

interface PrepareUserChatExecutionFlowOptions {
  userInput: string;
  images: InputImage[] | undefined;
  source: 'local' | 'remote' | 'supervisor';
  pendingAttachments: HostAttachment[];
  interactionMode: 'agent' | 'ask';
  imageMimeByExt: Record<string, string>;
  currentRunMode: AgentRunMode;
  providerId: string;
  modelName: string;
  getSdkSessionId: () => string;
  incrementSessionRequests: () => void;
  resetStreamingState: () => void;
  resetRuntimeTokens: () => void;
  startTaskTimer: () => void;
  addInfo: (message: string, details?: string) => void;
  setPendingAttachments: (attachments: HostAttachment[]) => void;
  addUserMessage: (
    message: string,
    imagesToDisplay: Array<{ data: string; mediaType: string; path?: string; name?: string }> | undefined,
    source: 'local' | 'remote' | 'supervisor',
  ) => void;
  startSessionTimer: () => void;
  setTaskRunning: (running: boolean) => void;
}

export function prepareUserChatExecutionFlow(
  options: PrepareUserChatExecutionFlowOptions,
): ChatPayloadLike {
  options.incrementSessionRequests();
  options.resetStreamingState();
  options.resetRuntimeTokens();
  options.startTaskTimer();

  const { consumedPendingAttachments, metadata } = buildInputMetadata({
    pendingAttachments: options.pendingAttachments,
    images: options.images,
    interactionMode: options.interactionMode,
    imageMimeByExt: options.imageMimeByExt,
    addInfo: options.addInfo,
  });
  if (consumedPendingAttachments) {
    options.setPendingAttachments([]);
  }

  if (process.env.CLI_DEBUG === '1') {
    cliLogger.debug('INPUT', '=== handleUserInput calling runTask ===');
    cliHealthMonitor.logStdinState('handleUserInput.beforeRunTask');
  }

  const imagesToDisplay = buildImagesToDisplay(options.images);
  if (process.env.CLI_DEBUG === '1') {
    cliLogger.debug('MAIN', 'Calling addUserMessage', {
      userInput: options.userInput,
      source: options.source,
    });
  }

  options.addUserMessage(options.userInput, imagesToDisplay, options.source);
  cliLogger.debug(
    'MAIN',
    `🔥 addUserMessage called for source=${options.source}, text="${options.userInput?.substring(0, 50)}"`,
  );

  options.startSessionTimer();
  options.setTaskRunning(true);

  return {
    sessionId: options.getSdkSessionId(),
    prompt: options.userInput,
    mode: options.currentRunMode,
    attachments: metadata?.attachments,
    providerId: options.providerId,
    modelName: options.modelName,
  };
}

export function logUserInputEntryDebugState(
  rawInput: string,
  uiControllerExists: boolean,
  isTaskRunning: boolean,
): void {
  if (process.env.CLI_DEBUG !== '1') {
    return;
  }
  cliLogger.debug('INPUT', '========================================');
  cliLogger.debug('INPUT', '=== handleUserInput ENTRY ===');
  cliLogger.debug('INPUT', `  rawInput: "${rawInput?.substring(0, 50)}..."`);
  cliLogger.debug('INPUT', `  uiController exists: ${uiControllerExists}`);
  cliLogger.debug('INPUT', `  isTaskRunning: ${isTaskRunning}`);
  cliLogger.debug('INPUT', `  stdin.isPaused: ${process.stdin.isPaused?.()}`);
  cliLogger.debug('INPUT', `  stdin.destroyed: ${process.stdin.destroyed}`);
  cliLogger.debug('INPUT', `  stdin.readable: ${process.stdin.readable}`);
  cliHealthMonitor.logStdinState('handleUserInput.entry');
}

interface HandleRunningTaskInputGateOptions {
  rawInput: string;
  source: 'local' | 'remote' | 'supervisor';
  isTaskRunning: boolean;
  enqueueRemoteInput: (text: string) => void;
  injectMessage: (message: string) => void;
  addUserMessage: (message: string, inputSource: 'local' | 'remote' | 'supervisor') => void;
  interruptRunningTask?: () => void;
}

export function handleRunningTaskInputGate(
  options: HandleRunningTaskInputGateOptions,
): boolean {
  return handleRunningTaskInput({
    isTaskRunning: options.isTaskRunning,
    source: options.source,
    rawInput: options.rawInput,
    debugEnabled: !!process.env.CLI_DEBUG,
    enqueueRemoteInput: (text) => {
      options.enqueueRemoteInput(text);
    },
    logDebug: (message, details) => {
      if (details) {
        cliLogger.debug('INPUT', message, details);
        return;
      }
      cliLogger.debug('INPUT', message);
    },
    injectMessage: (message) => {
      options.injectMessage(message);
    },
    addUserMessage: (message, inputSource) => {
      options.addUserMessage(message, inputSource);
    },
    interruptRunningTask: options.interruptRunningTask,
  });
}

interface RunUserChatExecutionFlowOptions {
  userInput: string;
  chatPayload: ChatPayloadLike;
  uiController: InkUIAdapter | null;
  runChat: (chatPayload: ChatPayloadLike) => Promise<void>;
  tryRecoverServerConnection: (reason: string) => Promise<boolean>;
  hasChatTransport: () => boolean;
  retryChat: () => Promise<void>;
  setTaskRunning: (running: boolean) => void;
  stopTaskTimer: () => void;
  handleUserInput: (text: string) => void;
}

export async function runUserChatExecutionFlow(
  options: RunUserChatExecutionFlowOptions,
): Promise<void> {
  try {
    await options.runChat(options.chatPayload);
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('INPUT', '=== handleUserInput runTask completed successfully ===');
      cliHealthMonitor.logStdinState('handleUserInput.afterRunTask.success');
    }
  } catch (error: any) {
    if (await handleUserInputExecutionErrorFlow({
      error,
      userInput: options.userInput,
      chatPayload: options.chatPayload,
      uiController: options.uiController,
      tryRecoverServerConnection: (reason) => options.tryRecoverServerConnection(reason),
      hasChatTransport: () => options.hasChatTransport(),
      retryChat: async () => {
        await options.retryChat();
      },
    })) {
      return;
    }
  } finally {
    finalizeUserInputHandlingFlow({
      setTaskRunning: options.setTaskRunning,
      stopTaskTimer: options.stopTaskTimer,
      handleUserInput: options.handleUserInput,
    });
  }
}
