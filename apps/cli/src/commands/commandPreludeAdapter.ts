import {
  handleThinkingCommand,
  type ThinkingCommandContext,
} from './index.js';
import { handleSkillCommandRouting } from './skillCommandRouting.js';

export async function handleCommandPreludeFromMain(params: {
  trimmed: string;
  workDir: string;
  addSkillError: (message: string) => void;
  executeSkillOutput: (output: string) => Promise<void>;
  getThinkingCommandContext: () => ThinkingCommandContext;
}): Promise<boolean> {
  if (await handleSkillCommandRouting(params.trimmed, {
    workDir: params.workDir,
    addSkillError: params.addSkillError,
    executeSkillOutput: params.executeSkillOutput,
  })) {
    return true;
  }

  const normalized = params.trimmed.toLowerCase();
  if (normalized.startsWith('/thinking')) {
    await handleThinkingCommand(params.getThinkingCommandContext(), params.trimmed);
    return true;
  }

  return false;
}
