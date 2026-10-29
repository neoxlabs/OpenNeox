import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { skillRegistry } from '../../skills/registry.js';
import { SkillExecutor } from '../../skills/executor.js';
import { setSkillScope } from '@neoxlabs/kernel/skills/skillScope.js';
import { createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';

type CreateUseSkillToolDeps = {
  getWorkspaceRoot: () => string;
};

export function createUseSkillTool({ getWorkspaceRoot }: CreateUseSkillToolDeps): Tool {
  return {
    name: 'use_skill',
    description: `Execute a registered skill to get specialized instructions for a task.

Skills are pre-defined instruction sets for specialized tasks (the available ones are listed in the system prompt), e.g.:
- review: Code review and PR creation
- pptx-deck-writer: Build a slide deck page by page

When you recognize a user's intent matches a skill, call this tool to get the detailed instructions, then follow them to complete the task.

Example: User says "帮我审查一下这次改动" → call use_skill(skill="review")`,
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name or alias (e.g., "review")',
        },
        args: {
          type: 'string',
          description: 'Optional arguments to pass to the skill (e.g., "--staged")',
        },
      },
      required: ['skill'],
    },
    permission: {
      category: ToolCategory.READ,
      allowInAskMode: true,
    },
    /* resultType: 'contextual' — 结构化元数据走 metadata, 让 timeline SkillCardView 渲富卡;
     * LLM 侧还是消费 content 字符串 (跟老版一致, 行为不变). */
    resultType: 'contextual',
    async function(args: { skill: string; args?: string }) {
      const { skill: skillName, args: skillArgs = '' } = args;
      const workDir = getWorkspaceRoot();

      await skillRegistry.initialize(workDir);

      const skill = skillRegistry.find(skillName);
      if (!skill) {
        const availableSkills = skillRegistry.list({ userInvocable: true });
        const skillList = availableSkills.map(s => s.id).join(', ');
        return JSON.stringify(createContextualResult(
          'use_skill',
          'error',
          `Skill not found: "${skillName}"`,
          `❌ Skill not found: "${skillName}"\n\nAvailable skills: ${skillList || '(none)'}\n\nTo list all skills, use the /skills command.`,
          { error: `unknown skill: ${skillName}` },
        ));
      }

      const executor = new SkillExecutor(skillRegistry);
      const result = await executor.execute(skillName, skillArgs, {
        workDir,
        args: skillArgs,
        rawInput: `/${skillName} ${skillArgs}`.trim(),
      });

      if (!result.success) {
        return JSON.stringify(createContextualResult(
          'use_skill',
          'error',
          `Skill execution failed: ${result.error}`,
          `❌ Skill execution failed: ${result.error}`,
          { error: result.error ?? 'unknown error' },
        ));
      }

      /* K2: 激活 skillScope, 强制后续 tool call 走 allowedTools 边界 (仅 limited 生效).
       *   - trusted: scope 仍 set 但 PermissionManager 不强制, 仅作 audit / 后续 hook
       *   - limited + allowedTools 空 = skill 啥都不能调 (合理: marketplace skill 不声明就别给权)
       *   - limited + allowedTools 非空 → 仅该列表能过
       *   skillScope 由 orchestrator 的 runWithSkillScopeContext 边界自动回收, 这里只设不清. */
      if (result.skillId && result.trustLevel) {
        setSkillScope({
          skillId: result.skillId,
          allowedTools: result.allowedTools ?? [],
          trustLevel: result.trustLevel,
        });
      }

      const modelNotice = result.model
        ? `\n🔧 **Model override: Use model "${result.model}" for this skill's tasks.**\n`
        : '';

      const toolNotice = result.allowedTools && result.allowedTools.length > 0
        ? `\n🔒 **TOOL RESTRICTION: You MUST only use these tools: ${result.allowedTools.join(', ')}. ${
            result.trustLevel === 'limited'
              ? 'This is ENFORCED by the runtime — any other tool call will be denied.'
              : 'Using any other tool is FORBIDDEN for this skill.'
          }**\n`
        : '';

      const body = `✅ Skill "${skill.metadata.name}" loaded successfully.
${modelNotice}${toolNotice}
📋 **Follow these instructions carefully:**

${result.output}

---
⚠️ IMPORTANT: Now execute the above instructions step by step. Do not ask for confirmation unless the instructions explicitly require it.`;

      return JSON.stringify(createContextualResult(
        'use_skill',
        'success',
        `Skill "${skill.metadata.name}" loaded`,
        body,
        {
          metadata: {
            /* 供 timeline SkillCardView 用: skillId / name / trustLevel / allowedTools / model. */
            skillId: result.skillId ?? skill.id,
            skillName: skill.metadata.name,
            trustLevel: result.trustLevel,
            allowedTools: result.allowedTools ?? [],
            model: result.model,
          },
        },
      ));
    },
  };
}
