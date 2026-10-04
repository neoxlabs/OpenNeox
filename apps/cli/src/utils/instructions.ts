import type { Instructions, RunContext } from '@neoxlabs/kernel/types/index.js';
import { buildInstructions as sharedBuildInstructions } from '@neoxlabs/core/runtime/systemPrompt.js';

interface BuildInstructionsOptions {
  workDir: string;
  model: string;
  protocol: string;
  baseUrl?: string;
  getSkillsPrompt: () => string;
}

export function createDynamicInstructions(
  options: BuildInstructionsOptions,
): Instructions {
  const useCodexStyle = options.protocol === 'openai-responses';
  return (_context: RunContext, _agent: { name: string; description: string }): string => {
    const basePrompt = sharedBuildInstructions({
      workDir: options.workDir,
      language: 'zh',
      useCodexStyle,
      protocol: options.protocol,
      model: options.model,
      baseUrl: options.baseUrl,
    });

    const skillsPrompt = options.getSkillsPrompt();
    if (skillsPrompt) {
      return `${basePrompt}\n\n${skillsPrompt}\n\nWhen users ask you to perform tasks, check if any skills can help. Use /skill-name to invoke a skill.`;
    }
    return basePrompt;
  };
}

export function buildStaticInstructionsText(
  options: Omit<BuildInstructionsOptions, 'getSkillsPrompt'>,
): string {
  const useCodexStyle = options.protocol === 'openai-responses';
  return sharedBuildInstructions({
    workDir: options.workDir,
    language: 'zh',
    useCodexStyle,
    protocol: options.protocol,
    model: options.model,
    baseUrl: options.baseUrl,
  });
}
