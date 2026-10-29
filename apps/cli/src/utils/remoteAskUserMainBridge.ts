import type { NeoxClient } from '@neoxlabs/core/sdk/client.js';
import type { SelectionChoice } from '../cliTypes.js';
import { handleRemoteAskUserEventFromMain } from './remoteEventAdapters.js';
import {
  cancelRemoteAskUserFlow,
  formatRemoteAnswerReceipt,
  type RemoteAskUserEventPayload,
} from './remoteInteractionFlows.js';

/** main.ts 里 InkUIAdapter 需要的那几个口 (传 undefined = 没起 Ink UI) */
export interface RemoteAskUserUi {
  cancelActiveSelectPrompt(): boolean;
  promptSelect(params: {
    message: string;
    choices: Array<{ title: string; value: string; description?: string; isCurrent?: boolean }>;
    initial?: number;
    initialValue?: string;
    hint?: string;
    header?: string;
    allowTextInput?: boolean;
  }): Promise<string | null>;
  addUserMessage(message: string): void;
}

/** 终端先答后要通知的那一方 (远程没开时是空操作) */
export interface RemoteAskUserPhone {
  askUserAnsweredLocally(requestId: string, answers: Record<string, string>): void;
}

/** 终端侧的 ask_user 交互: 弹框 / 撤销 / 答完通知手机 */
export async function handleRemoteAskUserEventInMain(params: {
  event: RemoteAskUserEventPayload;
  sdkClient: NeoxClient | null;
  uiController: RemoteAskUserUi | null;
  phone: RemoteAskUserPhone;
  acquirePromptLock: () => Promise<void>;
  releasePromptLock: () => void;
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string) => Promise<string>;
  addUserMessage: (message: string) => void;
  logInfo: (message: string, details?: string) => void;
  submitLateAnswer?: (text: string) => void;
}): Promise<void> {
  await handleRemoteAskUserEventFromMain({
    event: params.event,
    sdkClient: params.sdkClient,
    submitLateAnswer: params.submitLateAnswer,
    /* 手机先答了要把键盘这边正在等的那一题收起来 */
    cancelActivePrompt: () => { params.uiController?.cancelActiveSelectPrompt(); },
    /* 键盘这边先答了: 手机上那张卡翻成已答, 不用等 tool_done */
    onAnswered: (requestId, answers) => params.phone.askUserAnsweredLocally(requestId, answers),
    acquirePromptLock: params.acquirePromptLock,
    releasePromptLock: params.releasePromptLock,
    uiPromptSelect: params.uiController
      ? (selectParams) => params.uiController!.promptSelect(selectParams)
      : undefined,
    promptSelect: params.promptSelect,
    addUserMessage: params.addUserMessage,
    logInfo: params.logInfo,
  });
}

/**
 * 手机先答了 ask_user: 收起终端里的选择框, 留一行回执, 再把手机答案交给 runtime。
 * 返 true = 终端确实正在等这一题 (PhoneRemoteSession 用它决定要不要再补一行提示)。
 */
export function replyRemoteAskUserInMain(params: {
  requestId: string;
  answers: Record<string, string>;
  uiController: { addUserMessage(message: string): void } | null;
  reply: (requestId: string, answers: Record<string, string>) => void;
}): boolean {
  const closedTerminalPrompt = cancelRemoteAskUserFlow(params.requestId);
  if (closedTerminalPrompt) {
    params.uiController?.addUserMessage(formatRemoteAnswerReceipt(params.answers));
  }
  params.reply(params.requestId, params.answers);
  return closedTerminalPrompt;
}
