import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { preprocessUserInput } from './inputPreprocess.js';
import { handleRunningTaskInputGate, logUserInputEntryDebugState } from './userInputLifecycle.js';

export async function handleUserInputFromMain(params: {
  rawInput: string;
  images?: Array<{ path?: string; name?: string; mediaType?: string; data?: string }>;
  source: 'local' | 'remote' | 'supervisor';
  uiController: any;
  isTaskRunning: boolean;
  enqueueRemoteInput: (text: string) => void;
  injectMessage: (message: string) => void;
  interruptRunningTask?: () => void;
  handleCommand: (command: string) => Promise<void>;
  prepareUserChatExecution: (
    userInput: string,
    images: Array<{ path?: string; name?: string; mediaType?: string; data?: string }> | undefined,
    source: 'local' | 'remote' | 'supervisor',
  ) => any;
  runPreparedUserChatExecution: (userInput: string, chatPayload: any) => Promise<void>;
}): Promise<void> {
  logUserInputEntryDebugState(params.rawInput, !!params.uiController, params.isTaskRunning);

  const handledRunningTaskInput = handleRunningTaskInputGate({
    rawInput: params.rawInput,
    source: params.source,
    isTaskRunning: params.isTaskRunning,
    enqueueRemoteInput: (text) => {
      params.enqueueRemoteInput(text);
    },
    injectMessage: (message) => {
      params.injectMessage(message);
    },
    addUserMessage: (message, inputSource) => {
      params.uiController?.addUserMessage(message, undefined, inputSource);
    },
    interruptRunningTask: params.interruptRunningTask,
  });
  if (handledRunningTaskInput) {
    return;
  }

  const preparedInput = preprocessUserInput(params.rawInput, params.images);
  const userInput = preparedInput.userInput;

  if (preparedInput.ignore) {
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('INPUT', 'Empty input received, ignoring');
    }
    return;
  }

  /** 对于菜单进行特殊处理 拦截 **/
  if (userInput.startsWith('/')) {
    await params.handleCommand(userInput);
    return;
  }

  if (!params.uiController) {
    return;
  }

  const chatPayload = params.prepareUserChatExecution(userInput, params.images, params.source);
  await params.runPreparedUserChatExecution(userInput, chatPayload);
}
