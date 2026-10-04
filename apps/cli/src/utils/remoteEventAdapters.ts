import { t } from '../i18n/index.js';
import type { SelectionChoice } from '../cliTypes.js';
import {
  handleRemoteApprovalEventFlow,
  handleRemoteAskUserEventFlow,
  promptRemoteAskUserSelectionFlow,
  type RemoteApprovalEventPayload,
  type RemoteAskUserEventPayload,
} from './remoteInteractionFlows.js';
import type { NeoxClient } from '@neoxlabs/core/sdk/client.js';

export async function handleRemoteApprovalEventFromMain(params: {
  event: RemoteApprovalEventPayload;
  sdkClient: NeoxClient | null;
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string, hint?: string) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  isRequestCancelled?: (requestId: string) => boolean;
}): Promise<void> {
  await handleRemoteApprovalEventFlow({
    event: params.event,
    sdkClient: params.sdkClient || undefined,
    promptSelect: params.promptSelect,
    logInfo: params.logInfo,
    isRequestCancelled: params.isRequestCancelled,
  });
}

export async function handleRemoteAskUserEventFromMain(params: {
  event: RemoteAskUserEventPayload;
  sdkClient: NeoxClient | null;
  acquirePromptLock: () => Promise<void>;
  releasePromptLock: () => void;
  uiPromptSelect?: (params: any) => Promise<any>;
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string) => Promise<string>;
  addUserMessage: (message: string) => void;
  logInfo: (message: string, details?: string) => void;
}): Promise<void> {
  await handleRemoteAskUserEventFlow({
    event: params.event,
    sdkClient: params.sdkClient || undefined,
    promptSelection: (selectionParams) =>
      promptRemoteAskUserSelectionFlow({
        ...selectionParams,
        selectHint: t().common.selectHint,
        acquirePromptLock: params.acquirePromptLock,
        releasePromptLock: params.releasePromptLock,
        uiPromptSelect: params.uiPromptSelect,
        promptSelect: params.promptSelect,
      }),
    addUserMessage: params.addUserMessage,
    logInfo: params.logInfo,
  });
}
