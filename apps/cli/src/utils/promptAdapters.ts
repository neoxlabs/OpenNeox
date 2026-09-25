import { t, isZh } from '../i18n/index.js';
import type { SelectionChoice, TextPromptOptions } from '../cliTypes.js';
import { promptSelectFlow, promptTextFlow } from './legacyPrompts.js';

export async function promptTextFromMain(params: {
  question: string;
  options?: TextPromptOptions;
  acquirePromptLock: () => Promise<void>;
  releasePromptLock: () => void;
  uiPromptText?: (params: any) => Promise<any>;
}): Promise<string> {
  return await promptTextFlow({
    question: params.question,
    options: params.options || {},
    acquirePromptLock: params.acquirePromptLock,
    releasePromptLock: params.releasePromptLock,
    uiPromptText: params.uiPromptText,
  });
}

export async function promptSelectFromMain(params: {
  question: string;
  choices: SelectionChoice[];
  defaultValue?: string;
  hint?: string;
  acquirePromptLock: () => Promise<void>;
  releasePromptLock: () => void;
  uiPromptSelect?: (params: any) => Promise<any>;
}): Promise<string> {
  return await promptSelectFlow({
    question: params.question,
    choices: params.choices,
    defaultValue: params.defaultValue,
    hint: params.hint,
    effectiveHint: t().common.selectHint,
    acquirePromptLock: params.acquirePromptLock,
    releasePromptLock: params.releasePromptLock,
    uiPromptSelect: params.uiPromptSelect,
  });
}

export async function promptYesNoFromMain(params: {
  question: string;
  initialYes?: boolean;
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string) => Promise<string>;
}): Promise<boolean> {
  const answer = await params.promptSelect(
    params.question,
    [
      { label: isZh() ? '是' : 'Yes', value: 'yes' },
      { label: isZh() ? '否' : 'No', value: 'no' },
    ],
    params.initialYes ? 'yes' : 'no',
  );
  return answer === 'yes';
}

export async function promptConfirmKeywordFromMain(params: {
  message: string;
  keyword: string;
  promptText: (question: string, options?: TextPromptOptions) => Promise<string>;
}): Promise<boolean> {
  const value = await params.promptText(params.message, { allowEmpty: false });
  return value.trim().toLowerCase() === params.keyword.toLowerCase();
}
