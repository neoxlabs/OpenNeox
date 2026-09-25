import { skillRegistry } from '../../skills/registry.js';
import { knowledgeRegistry } from '../../knowledge/registry.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export async function setupSkillsHotReload(workDir: string): Promise<() => void> {
  await skillRegistry.initialize(workDir);
  skillRegistry.watch(workDir);
  cliLogger.info('SERVER', `Skills hot-reload active (${skillRegistry.size} skills loaded)`);
  /* 知识库跟 skills 同一生命周期 — 失败不阻塞 (空库 = L0 section 不注入) */
  try {
    await knowledgeRegistry.initialize(workDir);
    knowledgeRegistry.watch(workDir);
    if (knowledgeRegistry.size > 0) {
      cliLogger.info('SERVER', `Knowledge hot-reload active (${knowledgeRegistry.size} cards loaded)`);
    }
  } catch (err: any) {
    cliLogger.debug('KNOWLEDGE', `bootstrap failed: ${err?.message}`);
  }
  return () => {
    skillRegistry.stopWatch();
    knowledgeRegistry.stopWatch();
  };
}
