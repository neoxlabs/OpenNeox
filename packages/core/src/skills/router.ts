/**
 * SkillRouter - 路由用户输入到对应的 skill
 */

import type { Skill, SkillResult, SkillExecutionContext } from '@neoxlabs/kernel/skills/types.js';
import { SkillRegistry, skillRegistry } from './registry.js';
import { SkillExecutor } from './executor.js';

/**
 * 路由结果
 */
export interface RouteResult {
  /** 是否匹配到 skill */
  matched: boolean;
  /** 匹配到的 skill */
  skill?: Skill;
  /** 解析出的参数 */
  args?: string;
  /** 错误信息 */
  error?: string;
}

/**
 * SkillRouter 类 - 解析用户输入并路由到对应 skill
 */
export class SkillRouter {
  private executor: SkillExecutor;

  constructor(private registry: SkillRegistry = skillRegistry) {
    this.executor = new SkillExecutor(registry);
  }

  /**
   * 解析用户输入
   * @param input 用户输入，如 "/commit -m 'fix bug'"
   */
  parse(input: string): RouteResult {
    const trimmed = input.trim();

    // 检查是否以 / 开头
    if (!trimmed.startsWith('/')) {
      return { matched: false };
    }

    // 解析命令和参数
    const content = trimmed.slice(1); // 移除开头的 /
    const spaceIndex = content.indexOf(' ');

    let command: string;
    let args: string;

    if (spaceIndex === -1) {
      command = content;
      args = '';
    } else {
      command = content.slice(0, spaceIndex);
      args = content.slice(spaceIndex + 1).trim();
    }

    // 查找 skill
    const skill = this.registry.find(command);

    if (!skill) {
      return {
        matched: false,
        error: `Unknown skill: ${command}`,
      };
    }

    return {
      matched: true,
      skill,
      args,
    };
  }

  /**
   * 路由并执行
   */
  async route(
    input: string,
    context: SkillExecutionContext
  ): Promise<SkillResult | null> {
    const result = this.parse(input);

    if (!result.matched) {
      if (result.error) {
        return {
          success: false,
          error: result.error,
        };
      }
      return null; // 不是 skill 命令
    }

    return this.executor.execute(result.skill!.id, result.args || '', context);
  }

  /**
   * 检查输入是否是 skill 命令
   */
  isSkillCommand(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return false;
    }

    const command = trimmed.slice(1).split(' ')[0];
    return this.registry.has(command);
  }

  /**
   * 获取命令补全建议
   */
  getSuggestions(partial: string): Skill[] {
    if (!partial.startsWith('/')) {
      return [];
    }

    const command = partial.slice(1).toLowerCase();
    const allSkills = this.registry.list({ userInvocable: true });

    if (!command) {
      return allSkills;
    }

    return allSkills.filter(
      (skill) =>
        skill.id.toLowerCase().startsWith(command) ||
        skill.metadata.name.toLowerCase().startsWith(command) ||
        skill.metadata.neox?.aliases?.some((alias) =>
          alias.toLowerCase().startsWith(command)
        )
    );
  }

  /**
   * 获取 executor 实例
   */
  getExecutor(): SkillExecutor {
    return this.executor;
  }
}

// 默认路由器实例
export const skillRouter = new SkillRouter();

export function buildSlashResearchDirective(prompt: string | undefined | null): string | null {
  if (!prompt) return null;
  const m = /^\s*\/research(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!m) return null;
  const topic = (m[1] ?? '').trim();
  return [
    '<system-reminder>',
    '[authoritative directive · must follow even if it overrides normal behavior]',
    topic
      ? `用户用 /research 显式要求做深度调研, 题目: 「${topic}」。`
        + '你的第一个动作必须是调用 deep_research 工具: 自己把题目拆成几个互不重叠的角度放进 questions,'
        + ' 按题目大小选 scale。工具不在当前工具列表里就先用 tool_search 找到它。'
        + '禁止改用 web_search 自己查一查就作答 —— 用户要的是带出处的调研报告。'
      : '用户输入了 /research 但没给题目。先问一句要调研什么, 拿到题目再调 deep_research。',
    '</system-reminder>',
  ].join('\n');
}

export function buildSkillRefDirective(prompt: string | undefined | null): string | null {
  if (!prompt || !prompt.includes('@skill:')) return null;
  const matches = prompt.match(/@skill:([\w./-]+)/g);
  if (!matches || matches.length === 0) return null;
  const ids = Array.from(new Set(matches.map((m) => m.slice('@skill:'.length))));
  const calls = ids.map((id) => `use_skill(skill="${id}")`).join(' 和 ');
  return [
    '<system-reminder>',
    '[authoritative directive · must follow even if it overrides normal behavior]',
    `用户已显式选择技能: ${ids.map((id) => `/${id}`).join(', ')}。`
      + `你的第一个动作必须是调用 ${calls} 获取技能指令, 然后严格按指令执行。`
      + '禁止跳过技能凭默认知识直接动手。',
    '</system-reminder>',
  ].join('\n');
}
