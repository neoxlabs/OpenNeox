import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { skillRegistry } from '../../skills/registry.js';

type Deps = { getWorkspaceRoot: () => string };

function slugify(raw: string): string {
  const ascii = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(ascii) ? ascii.slice(0, 48) : `skill-${ascii || Date.now().toString(36)}`.slice(0, 48);
}

export function createSaveSkillTool({ getWorkspaceRoot }: Deps): Tool {
  return {
    name: 'save_skill',
    description: `Save a reusable workflow as a skill (user says "存成技能" / "save as a skill" / "以后我说…就这么做"). Never write SKILL.md files by hand — use this. Instructions = numbered steps runnable without this chat (inputs, output format, where to save). Usable right away via use_skill.`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'English slug, e.g. weekly-report' },
        name: { type: 'string', description: "Display name in the user's language" },
        description: { type: 'string', description: 'One sentence: what it does' },
        when_to_use: { type: 'string', description: 'Trigger phrases / situations (drives auto-pick)' },
        instructions: { type: 'string', description: 'Markdown numbered steps' },
        scope: { type: 'string', enum: ['user', 'project'], description: 'user = all projects (default)' },
        overwrite: { type: 'boolean', description: 'Replace an existing skill with the same id' },
      },
      required: ['name', 'description', 'instructions'],
    },
    permission: { category: ToolCategory.WRITE, allowInAskMode: false },
    resultType: 'contextual',
    async function(args: {
      id?: string; name: string; description: string; when_to_use?: string;
      instructions: string; scope?: 'user' | 'project'; overwrite?: boolean;
    }) {
      const workDir = getWorkspaceRoot();
      await skillRegistry.initialize(workDir);
      const id = args.id && /^[a-z][a-z0-9-]*$/.test(args.id) ? args.id : slugify(args.id || args.name);
      const target = args.scope === 'project' ? 'workspace' : 'user';
      const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/"/g, '“').trim();

      if (skillRegistry.has(id)) {
        if (!args.overwrite) {
          return JSON.stringify(createContextualResult('save_skill', 'error',
            `Skill "${id}" already exists`,
            `Skill "${id}" already exists. Call again with overwrite: true to replace it, or pick another id.`,
            { error: 'exists', metadata: { skillId: id } }));
        }
        await skillRegistry.deleteSkill(id);
      }

      const r = await skillRegistry.createSkill({
        id,
        name: oneLine(args.name),
        description: oneLine(args.description),
        target,
        workDir,
        instructions: args.instructions.trim(),
        whenToUse: args.when_to_use ? oneLine(args.when_to_use) : undefined,
      });
      if (!r.success) {
        return JSON.stringify(createContextualResult('save_skill', 'error',
          `Save skill failed: ${r.error}`, `❌ Save skill failed: ${r.error}`, { error: r.error ?? 'unknown' }));
      }
      return JSON.stringify(createContextualResult('save_skill', 'success',
        `Saved skill /${id}`,
        `✅ Saved skill "${args.name}" as /${id} (${target === 'user' ? 'all projects' : 'this project'}).\nPath: ${r.path}\nIt is registered now — use_skill("${id}") works in this session; the user can also type /${id}.`,
        {
          file_path: r.path,
          metadata: {
            skillId: id,
            skillName: args.name,
            description: args.description,
            whenToUse: args.when_to_use,
            scope: target,
            path: r.path,
            steps: (args.instructions.match(/^\s*(\d+\.|[-*])\s+/gm) ?? []).length,
          },
        }));
    },
  };
}
