import type { SelectionChoice } from '../cliTypes.js';
import { getLanguage, L } from '../i18n/index.js';
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

const activeAskUserFlows = new Map<string, () => void>();

/**
 * 手机先答了: 收起终端里这一题的选择框, 后面的问题也不再弹。
 * 返 true = 终端确实正在等这一题 (回执才需要打)。
 */
export function cancelRemoteAskUserFlow(requestId: string): boolean {
  const cancel = activeAskUserFlows.get(requestId);
  if (!cancel) return false;
  cancel();
  return true;
}

/** 手机上的答案在终端留一行回执: 「已在手机上回答: <答案>」 (多题时带上问题) */
export function formatRemoteAnswerReceipt(answers: Record<string, string>): string {
  const entries = Object.entries(answers ?? {})
    .map(([question, answer]) => [String(question).trim(), String(answer ?? '').trim()] as const)
    .filter(([question, answer]) => question.length > 0 && answer.length > 0);
  const body = entries.length <= 1
    ? (entries[0]?.[1] ?? '')
    : entries.map(([question, answer]) => `${question}: ${answer}`).join('；');
  const label = L('已在手机上回答', 'Answered on phone');
  return body ? `${label}: ${body}` : label;
}

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
    logInfo(L('审批请求已失效，跳过回复', 'Approval request expired, skipping reply'), event.requestId);
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
      logInfo(L('审批提示失败', 'Approval prompt failed'), error?.message || String(error));
    }
    approved = false;
    remember = false;
  }

  if (isRequestCancelled?.(event.requestId)) {
    logInfo(L('审批请求在交互期间被取消，忽略本地结果', 'Approval request cancelled during interaction, ignoring local result'), event.requestId);
    return;
  }

  try {
    await sdkClient.replyPermission(event.requestId, approved, undefined, remember);
  } catch (error: any) {
    logInfo(L('审批回复失败', 'Approval reply failed'), error?.message || String(error));
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
  /** 收起终端里正在等回答的选择框 (手机先答时由 cancelRemoteAskUserFlow 调) */
  cancelActivePrompt?: () => void;
  /** 终端这边答完了: 告诉手机把那张卡翻成已答 (同一条回复路径, 只是多一个回执) */
  onAnswered?: (requestId: string, answers: Record<string, string>) => void;
  /** 答晚了: 问题已超时作废 (服务端回 orphan), 本轮早已结束 —— 把问答当一条新消息发出去,
   *  让 Agent 接着干。实现方负责回显这条消息 (这里不再单独 addUserMessage)。 */
  submitLateAnswer?: (text: string) => void;
}): Promise<void> {
  const { event, sdkClient, promptSelection, addUserMessage, logInfo, cancelActivePrompt, onAnswered, submitLateAnswer } = params;
  if (!sdkClient || !event.requestId) {
    return;
  }

  const questions = Array.isArray(event.questions)
    ? event.questions.filter((q) => typeof q?.question === 'string' && q.question.trim().length > 0)
    : [];
  const answers: Record<string, string> = {};
  /* 问答回显等回复结果出来再打: 答晚了要走 submitLateAnswer (它自己回显), 先打会出两遍 */
  const answerLines: string[] = [];

  /* 手机可能在任何一道题时先答 —— 一旦撤销: 收框 + 不再弹下一题 + 别在这里回一个空答案 */
  let cancelled = false;
  const cancelToken = () => {
    cancelled = true;
    cancelActivePrompt?.();
  };
  activeAskUserFlows.set(event.requestId, cancelToken);

  try {
    for (let i = 0; i < questions.length; i++) {
      if (cancelled) break;
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

      /* 框被撤销时 promptSelection 返回 null; 但 null 也可能是用户按了 ESC —— 只有
       * cancelled 才算"手机答了", 这时不能把 (跳过) 当成答案送回去 */
      if (cancelled) break;

      if (selected !== null && selected !== undefined && selected.length > 0) {
        answers[questionText] = selected;
        answerLines.push(`Q: ${questionText}\nA: ${selected}`);
      }
    }
  } catch (error: any) {
    logInfo(L('ask_user 交互失败', 'ask_user interaction failed'), error?.message || String(error));
  } finally {
    if (activeAskUserFlows.get(event.requestId) === cancelToken) {
      activeAskUserFlows.delete(event.requestId);
    }
  }

  if (cancelled) {
    /* 答案在手机上已经提交了 (手机自己走 replyAskUser), 这里再回一次会把答案覆盖成空 */
    return;
  }

  try {
    const result = await sdkClient.replyAskUser(event.requestId, answers);
    if (result && result.status === 'orphan' && answerLines.length > 0 && submitLateAnswer) {
      submitLateAnswer(answerLines.join('\n\n'));
      return;
    }
    for (const line of answerLines) addUserMessage?.(line);
    onAnswered?.(event.requestId, answers);
  } catch (error: any) {
    for (const line of answerLines) addUserMessage?.(line);
    logInfo(L('ask_user 回复失败', 'ask_user reply failed'), error?.message || String(error));
  }
}
