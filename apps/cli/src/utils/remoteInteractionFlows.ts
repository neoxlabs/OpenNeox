import type { SelectionChoice } from '../cliTypes.js';
import { getLanguage } from '../i18n/index.js';
import {
  buildApprovalPreview,
  buildRemoteApprovalArgsPreview,
  buildRemoteApprovalChoices,
  buildRemoteApprovalHints,
  buildRemoteApprovalQuestion,
  normalizeRemoteAskOptions,
} from './remoteInteractionPrompts.js';

export type RemoteApprovalEventPayload = {
  requestId?: string;
  toolName?: string;
  args?: Record<string, any>;
  reason?: string;
  allowRemember?: boolean;
  scopeKey?: string;
  risk?: {
    level?: string;
    summary?: string;
  };
};

export type RemoteApprovalCancelledEventPayload = {
  requestId?: string;
  reason?: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale';
  approved?: boolean;
};

export type RemoteAskUserEventPayload = {
  requestId?: string;
  questions?: Array<{
    question?: string;
    options?: Array<{ label?: string; description?: string }>;
    header?: string;
  }>;
};

type PermissionReplyClient = {
  replyPermission: (
    requestId: string,
    approved: boolean,
    reason?: string,
    remember?: boolean
  ) => Promise<void>;
};

type AskUserReplyClient = {
  replyAskUser: (
    requestId: string,
    answers: Record<string, string>,
  ) => Promise<void | { status: 'resolved' | 'resumed' | 'orphan'; reason?: string }>;
};

type PromptSelect = (
  question: string,
  choices: SelectionChoice[],
  defaultValue?: string,
  hint?: string
) => Promise<string>;

export async function promptRemoteAskUserSelectionFlow(params: {
  questionText: string;
  progress: string;
  options: Array<{ label: string; description?: string }>;
  header?: string;
  selectHint: string;
  acquirePromptLock: () => Promise<void>;
  releasePromptLock: () => void;
  uiPromptSelect?: (params: {
    message: string;
    choices: Array<{ title: string; value: string; description?: string }>;
    header: string;
    allowTextInput: boolean;
    hint: string;
  }) => Promise<string | null>;
  promptSelect: PromptSelect;
}): Promise<string | null> {
  const {
    questionText,
    progress,
    options,
    header,
    selectHint,
    acquirePromptLock,
    releasePromptLock,
    uiPromptSelect,
    promptSelect,
  } = params;

  if (uiPromptSelect) {
    await acquirePromptLock();
    try {
      return await uiPromptSelect({
        message: `${questionText}${progress}`,
        choices: options.map((opt) => ({
          title: opt.label,
          value: opt.label,
          description: opt.description,
        })),
        /* 表头默认值 'Ask User' 是英文, 而卡里的问题和选项都是中文 (模型按界面语言生成) */
        header: header || (getLanguage() === 'zh' ? '需要你决定' : 'Ask User'),
        allowTextInput: true,
        hint: selectHint,
      });
    } finally {
      releasePromptLock();
    }
  }

  return await promptSelect(
    `${questionText}${progress}`,
    options.map((opt) => ({
      label: opt.label,
      value: opt.label,
      description: opt.description,
    })),
    options[0]?.label,
  );
}

export async function handleRemoteApprovalEventFlow(params: {
  event: RemoteApprovalEventPayload;
  sdkClient?: PermissionReplyClient;
  promptSelect: PromptSelect;
  logInfo: (message: string, details?: string) => void;
  isRequestCancelled?: (requestId: string) => boolean;
}): Promise<void> {
  const { event, sdkClient, promptSelect, logInfo, isRequestCancelled } = params;
  if (!sdkClient || !event.requestId) {
    return;
  }
  if (isRequestCancelled?.(event.requestId)) {
    logInfo('审批请求已失效，跳过回复', event.requestId);
    return;
  }

  const toolName = event.toolName || 'unknown_tool';
  const argsPreview = buildRemoteApprovalArgsPreview(event.args);
  const choices = buildRemoteApprovalChoices(toolName, event.allowRemember);
  const hints = buildRemoteApprovalHints(event.reason, event.scopeKey, event.risk);
  /* 改动预览 —— 用户点"允许"之前得先看得见改什么 (见 buildApprovalPreview 的说明) */
  const preview = buildApprovalPreview(event.args);

  let approved = false;
  let remember = false;

  try {
    const decision = await promptSelect(
      /* 用动作+对象说话, 不是内部工具名 —— `Allow tool edit src/index.js?` 里的
       * "tool edit" 对用户是噪声, 他要判断的是"改哪个文件"。 */
      buildRemoteApprovalQuestion(toolName, argsPreview),
      choices,
      'allow_once',
      /* diff 预览排在风险说明**之前** —— 用户要判断的是改动本身,
       * "风险 LOW / 会修改文件" 那行信息量低, 不该压在改动前面。 */
      [...preview, ...(hints.length > 0 ? [hints.join(' · ')] : [])].join('\n') || undefined,
    );
    approved = decision === 'allow_once' || decision === 'always_allow';
    remember = decision === 'always_allow';
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      logInfo('审批提示失败', error?.message || String(error));
    }
    approved = false;
    remember = false;
  }

  if (isRequestCancelled?.(event.requestId)) {
    logInfo('审批请求在交互期间被取消，忽略本地结果', event.requestId);
    return;
  }

  try {
    await sdkClient.replyPermission(event.requestId, approved, undefined, remember);
  } catch (error: any) {
    logInfo('审批回复失败', error?.message || String(error));
  }
}

export async function handleRemoteAskUserEventFlow(params: {
  event: RemoteAskUserEventPayload;
  sdkClient?: AskUserReplyClient;
  promptSelection: (params: {
    questionText: string;
    progress: string;
    options: Array<{ label: string; description?: string }>;
    header?: string;
  }) => Promise<string | null>;
  addUserMessage?: (message: string) => void;
  logInfo: (message: string, details?: string) => void;
}): Promise<void> {
  const { event, sdkClient, promptSelection, addUserMessage, logInfo } = params;
  if (!sdkClient || !event.requestId) {
    return;
  }

  const questions = Array.isArray(event.questions)
    ? event.questions.filter((q) => typeof q?.question === 'string' && q.question.trim().length > 0)
    : [];
  const answers: Record<string, string> = {};

  try {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const questionText = (q.question || '').trim();
      const options = normalizeRemoteAskOptions(q.options);
      if (!questionText || options.length === 0) {
        continue;
      }

      const progress = questions.length > 1 ? ` (${i + 1}/${questions.length})` : '';
      const selected = await promptSelection({
        questionText,
        progress,
        options,
        header: q.header,
      });

      if (selected !== null && selected !== undefined && selected.length > 0) {
        answers[questionText] = selected;
        addUserMessage?.(`Q: ${questionText}\nA: ${selected}`);
      }
    }
  } catch (error: any) {
    logInfo('ask_user 交互失败', error?.message || String(error));
  }

  try {
    await sdkClient.replyAskUser(event.requestId, answers);
  } catch (error: any) {
    logInfo('ask_user 回复失败', error?.message || String(error));
  }
}
