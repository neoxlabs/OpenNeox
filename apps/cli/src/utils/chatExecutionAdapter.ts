import { prepareUserChatExecutionFlow, runUserChatExecutionFlow, type ChatPayloadLike } from './userInputLifecycle.js';
import type { HostAttachment } from '@neoxlabs/core/runtime/runtimeTypes.js';
import type { InteractionMode } from '../cliTypes.js';
import type { AgentRunMode } from '@neoxlabs/core/runtime/modeFactory.js';

type InputImage = { path?: string; name?: string; mediaType?: string; data?: string };

export function prepareUserChatExecutionFromMain(params: {
  userInput: string;
  images: InputImage[] | undefined;
  source: 'local' | 'remote' | 'supervisor';
  pendingAttachments: HostAttachment[];
  interactionMode: InteractionMode;
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
  addUserMessage: (message: string, imagesToDisplay?: Array<{ data: string; mediaType: string; path?: string; name?: string }>, inputSource?: 'local' | 'remote' | 'supervisor') => void;
  startSessionTimer: () => void;
  setTaskRunning: (running: boolean) => void;
}): ChatPayloadLike {
  return prepareUserChatExecutionFlow({
    userInput: params.userInput,
    images: params.images,
    source: params.source,
    pendingAttachments: params.pendingAttachments,
    interactionMode: params.interactionMode,
    imageMimeByExt: params.imageMimeByExt,
    currentRunMode: params.currentRunMode,
    providerId: params.providerId,
    modelName: params.modelName,
    getSdkSessionId: params.getSdkSessionId,
    incrementSessionRequests: params.incrementSessionRequests,
    resetStreamingState: params.resetStreamingState,
    resetRuntimeTokens: params.resetRuntimeTokens,
    startTaskTimer: params.startTaskTimer,
    addInfo: params.addInfo,
    setPendingAttachments: params.setPendingAttachments,
    addUserMessage: params.addUserMessage,
    startSessionTimer: params.startSessionTimer,
    setTaskRunning: params.setTaskRunning,
  });
}

export async function runPreparedUserChatExecutionFromMain(params: {
  userInput: string;
  chatPayload: ChatPayloadLike;
  uiController: any;
  runChat: () => Promise<void>;
  tryRecoverServerConnection: (reason: string) => Promise<boolean>;
  hasChatTransport: () => boolean;
  retryChat: () => Promise<void>;
  setTaskRunning: (running: boolean) => void;
  stopTaskTimer: () => void;
  handleUserInput: (text: string) => void;
}): Promise<void> {
  await runUserChatExecutionFlow({
    userInput: params.userInput,
    chatPayload: params.chatPayload,
    uiController: params.uiController,
    runChat: params.runChat,
    tryRecoverServerConnection: params.tryRecoverServerConnection,
    hasChatTransport: params.hasChatTransport,
    retryChat: params.retryChat,
    setTaskRunning: params.setTaskRunning,
    stopTaskTimer: params.stopTaskTimer,
    handleUserInput: params.handleUserInput,
  });
}
