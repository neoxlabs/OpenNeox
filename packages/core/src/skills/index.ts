/**
 * Neox Skills 系统
 *
 * 模块化的知识单元系统，兼容 Claude Code SKILL.md 格式
 *
 * @example
 * ```typescript
 * import { skillRegistry, skillRouter } from './skills/index.js';
 *
 * // 初始化
 * await skillRegistry.initialize(process.cwd());
 *
 * // 检查是否是 skill 命令
 * if (skillRouter.isSkillCommand('/commit -m "fix"')) {
 *   const result = await skillRouter.route('/commit -m "fix"', {
 *     workDir: process.cwd(),
 *     args: '-m "fix"',
 *     rawInput: '/commit -m "fix"',
 *   });
 * }
 *
 * // 列出所有可用 skills
 * const skills = skillRegistry.list({ userInvocable: true });
 * ```
 */

// 类型导出
export type {
  Skill,
  SkillMetadata,
  SkillSource,
  SkillCategory,
  SkillHooks,
  SkillResult,
  SkillListOptions,
  SkillExecutionContext,
  NeoxSkillExtension,
  DangerLevel,
  EffortLevel,
} from '@neoxlabs/kernel/skills/types.js';

// 类导出
export { SkillLoader, skillLoader } from './loader.js';
export { SkillRegistry, skillRegistry, onSkillsLoaded } from './registry.js';
export { SkillExecutor } from './executor.js';
export { SkillRouter, skillRouter } from './router.js';
export type { RouteResult } from './router.js';
export { readHistory, clearHistory, recordExecution } from './history.js';
export type { SkillHistoryEntry } from './history.js';
