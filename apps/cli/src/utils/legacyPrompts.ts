import prompts from 'prompts';

import type { SelectionChoice, TextPromptOptions } from '../cliTypes.js';

export async function promptTextLegacy(question: string, options: TextPromptOptions): Promise<string> {
  const response = await prompts({
    type: options.password ? 'password' : 'text',
    name: 'value',
    message: question,
    initial: options.defaultValue,
  }, {
    onCancel: () => {
      throw new Error('cancelled');
    },
  });

  let value: string = response.value ?? '';
  if (!value && !options.allowEmpty) {
    if (options.defaultValue) {
      value = options.defaultValue;
    } else {
      throw new Error('cancelled');
    }
  }
  return value;
}

export async function promptTextFlow(params: {
  question: string;
  options: TextPromptOptions;
  acquirePromptLock: () => Promise<void>;
  releasePromptLock: () => void;
  uiPromptText?: (params: {
    message: string;
    defaultValue?: string;
    allowEmpty?: boolean;
    hint?: string;
    password?: boolean;
  }) => Promise<string | null | undefined>;
}): Promise<string> {
  const { question, options, acquirePromptLock, releasePromptLock, uiPromptText } = params;
  await acquirePromptLock();
  try {
    if (uiPromptText) {
      const result = await uiPromptText({
        message: question,
        defaultValue: options.defaultValue,
        allowEmpty: options.allowEmpty,
        hint: options.hint,
        password: options.password,
      });
      if (result === null || result === undefined) {
        throw new Error('cancelled');
      }
      return result;
    }
    return await promptTextLegacy(question, options);
  } finally {
    releasePromptLock();
  }
}

export async function promptSelectLegacy(
  question: string,
  choices: SelectionChoice[],
  defaultValue?: string
): Promise<string> {
  const initial = defaultValue
    ? Math.max(0, choices.findIndex(choice => choice.value === defaultValue))
    : 0;

  const response = await prompts({
    type: 'select',
    name: 'value',
    message: question,
    choices: choices.map(choice => ({
      title: choice.label,
      description: choice.description,
      value: choice.value,
    })),
    initial,
  }, {
    onCancel: () => {
      throw new Error('cancelled');
    },
  });

  if (response.value === undefined) {
    throw new Error('cancelled');
  }
  return response.value as string;
}

export async function promptSelectFlow(params: {
  question: string;
  choices: SelectionChoice[];
  defaultValue?: string;
  hint?: string;
  effectiveHint: string;
  acquirePromptLock: () => Promise<void>;
  releasePromptLock: () => void;
  uiPromptSelect?: (params: {
    message: string;
    choices: Array<{ title: string; value: string; description?: string }>;
    initialValue?: string;
    hint: string;
  }) => Promise<string | null | undefined>;
}): Promise<string> {
  const {
    question,
    choices,
    defaultValue,
    hint,
    effectiveHint,
    acquirePromptLock,
    releasePromptLock,
    uiPromptSelect,
  } = params;
  await acquirePromptLock();
  if (choices.length === 0) {
    releasePromptLock();
    throw new Error('No available options');
  }

  const selectHint = hint ?? effectiveHint;
  if (uiPromptSelect) {
    const formatted = choices.map(choice => ({
      title: choice.label,
      value: choice.value,
      description: choice.description,
      isCurrent: choice.isCurrent,
    }));
    try {
      const value = await uiPromptSelect({
        message: question,
        choices: formatted,
        initialValue: defaultValue,
        hint: selectHint,
      });
      releasePromptLock();
      if (value === null || value === undefined) {
        throw new Error('cancelled');
      }
      return value;
    } catch (error: any) {
      releasePromptLock();
      throw error;
    }
  }
  try {
    return await promptSelectLegacy(question, choices, defaultValue);
  } finally {
    releasePromptLock();
  }
}

export async function promptInputFlow(params: {
  prompt: string;
  defaultValue?: string;
  acquirePromptLock: () => Promise<void>;
  releasePromptLock: () => void;
  uiPromptInput?: (params: { message: string; initialValue: string }) => Promise<string | null | undefined>;
}): Promise<string> {
  const { prompt, defaultValue, acquirePromptLock, releasePromptLock, uiPromptInput } = params;

  await acquirePromptLock();
  try {
    if (uiPromptInput) {
      const value = await uiPromptInput({
        message: prompt,
        initialValue: defaultValue || '',
      });
      releasePromptLock();
      if (value === null || value === undefined) {
        throw new Error('cancelled');
      }
      return value;
    }

    const response = await prompts({
      type: 'text',
      name: 'value',
      message: prompt,
      initial: defaultValue || '',
    }, {
      onCancel: () => {
        throw new Error('cancelled');
      },
    });

    releasePromptLock();
    if (response.value === undefined) {
      throw new Error('cancelled');
    }
    return response.value as string;
  } catch (error) {
    releasePromptLock();
    throw error;
  }
}
