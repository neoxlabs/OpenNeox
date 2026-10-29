import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { skillRegistry, skillRouter } from '@neoxlabs/core/skills/index.js';

interface SkillCommandRoutingDeps {
  workDir: string;
  addSkillError?: (message: string) => void;
  executeSkillOutput: (output: string) => Promise<void>;
}

export async function handleSkillCommandRouting(
  trimmed: string,
  deps: SkillCommandRoutingDeps,
): Promise<boolean> {
  if (!trimmed.startsWith('/')) {
    return false;
  }

  const spaceIndex = trimmed.indexOf(' ');
  const skillName = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
  const skill = skillRegistry.find(skillName);
  if (!skill) {
    return false;
  }

  const skillArgs = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  cliLogger.info('CLI', `Executing skill: ${skill.id}`, { args: skillArgs });

  const result = await skillRouter.route(trimmed, {
    workDir: deps.workDir,
    args: skillArgs,
    rawInput: trimmed,
  });

  if (result && result.success && result.output) {
    if (result.model) {
      cliLogger.info('CLI', `Skill model override: ${result.model}`);
    }
    if (result.allowedTools && result.allowedTools.length > 0) {
      cliLogger.info('CLI', `Skill tool restriction: ${result.allowedTools.join(', ')}`);
    }
    await deps.executeSkillOutput(result.output);
    return true;
  }

  if (result && !result.success) {
    deps.addSkillError?.(`Skill error: ${result.error}`);
    return true;
  }

  return true;
}
