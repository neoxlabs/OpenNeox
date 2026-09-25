export type RunningTaskInputSource = 'local' | 'remote' | 'supervisor';

interface HandleRunningTaskInputOptions {
  isTaskRunning: boolean;
  source: RunningTaskInputSource;
  rawInput: string;
  debugEnabled: boolean;
  enqueueRemoteInput: (text: string) => void;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
  injectMessage: (message: string) => void;
  addUserMessage: (message: string, source: RunningTaskInputSource) => void;
  /** Enter 运行中发消息: 先中断再走下一轮 (匹配 "Enter to interrupt and send") */
  interruptRunningTask?: () => void;
}

/**
 * @returns true = 已处理完, 调用方不要再跑正常 chat;
 *          false = 未处理 / 已中断并交给调用方用本条消息开新 turn
 */
export function handleRunningTaskInput(options: HandleRunningTaskInputOptions): boolean {
  if (!options.isTaskRunning) {
    return false;
  }

  if (options.source === 'remote') {
    options.logDebug(
      `🔥 Remote message while task running, enqueueing: "${options.rawInput?.substring(0, 50)}"`,
    );
    options.enqueueRemoteInput(options.rawInput);
    return true;
  }

  const userInput = options.rawInput ? options.rawInput.trim() : '';
  if (!userInput) {
    return false;
  }

  // 本地 Enter: 中断当前 turn (含 Explore) + 本条作为下一轮用户消息.
  // 旧行为只 injectMessage 排队 → Explore 不停, 占位符 "interrupt and send" 是假的.
  if (options.interruptRunningTask) {
    if (options.debugEnabled) {
      options.logDebug('Task running: interrupt + continue as new turn', {
        message: userInput.substring(0, 50),
      });
    }
    options.interruptRunningTask();
    return false;
  }

  if (options.debugEnabled) {
    options.logDebug('Task running: injecting user message', {
      message: userInput.substring(0, 50),
    });
  }

  options.injectMessage(userInput);
  return true;
}
