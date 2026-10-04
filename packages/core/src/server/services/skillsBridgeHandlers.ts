import type { RuntimeBridge } from '../index.js';
import { skillRegistry } from '../../skills/registry.js';
import type { SkillListOptions } from '@neoxlabs/kernel/skills/types.js';

type SkillsBridgeMethods = Pick<
  RuntimeBridge,
  | 'listSkills'
  | 'getSkill'
  | 'refreshSkills'
  | 'createSkill'
  | 'deleteSkill'
  | 'importSkillFromUrl'
  | 'importSkillFromPath'
  | 'getSkillDirs'
  | 'activateSkillsForPaths'
  | 'getSkillStats'
>;

interface CreateSkillsBridgeHandlersOptions {
  workDir: string;
}

export function createSkillsBridgeHandlers(options: CreateSkillsBridgeHandlersOptions): SkillsBridgeMethods {
  const { workDir } = options;

  return {
    async listSkills(options?: SkillListOptions) {
      return skillRegistry.list(options);
    },

    async getSkill(id: string) {
      return skillRegistry.find(id) ?? null;
    },

    async refreshSkills() {
      await skillRegistry.refresh(workDir);
    },

    async createSkill(options: { id: string; name: string; description: string; category?: string; target: 'user' | 'workspace' }) {
      return skillRegistry.createSkill({ ...options, workDir });
    },

    async deleteSkill(id: string) {
      return skillRegistry.deleteSkill(id);
    },

    async importSkillFromUrl(url: string, target: string) {
      return skillRegistry.importFromUrl(url, target as 'user' | 'workspace', workDir);
    },

    async importSkillFromPath(sourcePath: string, target: string) {
      return skillRegistry.importFromPath(sourcePath, target as 'user' | 'workspace', workDir);
    },

    getSkillDirs() {
      return {
        user: skillRegistry.getUserSkillsDir(),
        workspace: skillRegistry.getWorkspaceSkillsDir(workDir),
      };
    },

    activateSkillsForPaths(filePaths: string[]) {
      return skillRegistry.activateForPaths(filePaths, workDir);
    },

    getSkillStats() {
      return {
        total: skillRegistry.size,
        conditional: skillRegistry.conditionalCount,
        dynamic: skillRegistry.dynamicCount,
        commands: skillRegistry.getUnifiedCommands().length,
      };
    },
  };
}
