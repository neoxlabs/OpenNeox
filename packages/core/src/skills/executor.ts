
import type { Skill, SkillResult, SkillExecutionContext } from '@neoxlabs/kernel/skills/types.js';
import { SkillRegistry } from './registry.js';
import { recordExecution } from './history.js';

/**
 * 参数解析结果
 */
interface ParsedArgs {
  /** 命名参数 */
  named: Record<string, string>;
  /** 位置参数 */
  positional: string[];
  /** 原始参数字符串 */
  raw: string;
}

/**
 * 解析命令行参数
 */
function parseArgs(argsString: string): ParsedArgs {
  const result: ParsedArgs = {
    named: {},
    positional: [],
    raw: argsString,
  };

  if (!argsString.trim()) {
    return result;
  }

  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  // 分割参数，处理引号
  for (const char of argsString) {
    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuote) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  // 解析参数
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part.startsWith('--')) {
      // 长参数: --key=value 或 --key value
      const eqIndex = part.indexOf('=');
      if (eqIndex > 0) {
        const key = part.slice(2, eqIndex);
        const value = part.slice(eqIndex + 1);
        result.named[key] = value;
      } else {
        const key = part.slice(2);
        const nextPart = parts[i + 1];
        if (nextPart && !nextPart.startsWith('-')) {
          result.named[key] = nextPart;
          i++;
        } else {
          result.named[key] = 'true';
        }
      }
    } else if (part.startsWith('-') && part.length === 2) {
      // 短参数: -k value
      const key = part.slice(1);
      const nextPart = parts[i + 1];
      if (nextPart && !nextPart.startsWith('-')) {
        result.named[key] = nextPart;
        i++;
      } else {
        result.named[key] = 'true';
      }
    } else {
      // 位置参数
      result.positional.push(part);
    }
  }

  return result;
}

/**
 * SkillExecutor 类 - 执行 skill
 */
export class SkillExecutor {
  constructor(private registry: SkillRegistry) {}

  async execute(
    skillId: string,
    args: string,
    context: SkillExecutionContext
  ): Promise<SkillResult> {
    const skill = this.registry.find(skillId);

    if (!skill) {
      return {
        success: false,
        error: `Skill not found: ${skillId}`,
      };
    }

    if (skill.metadata.isEnabled && !skill.metadata.isEnabled()) {
      return {
        success: false,
        error: `Skill '${skillId}' is currently disabled`,
      };
    }

    const startTime = Date.now();
    try {
      // 解析参数
      const parsedArgs = parseArgs(args);

      let content = skill.content;
      if (skill.lazyPrompt) {
        content = await skill.lazyPrompt();
      }

      // 构建执行 prompt
      const prompt = this.buildPrompt(skill, parsedArgs, context, content);

      const duration = Date.now() - startTime;
      recordExecution({ skillId: skill.id, timestamp: startTime, status: 'success', duration, args: args || undefined });

      return {
        success: true,
        output: prompt,
        model: skill.metadata.model,
        allowedTools: skill.metadata.neox?.allowedTools,
        /* K2: 把 trustLevel + skillId 透传给 caller (useSkillTool), 让它能 setSkillScope() */
        trustLevel: skill.trustLevel,
        skillId: skill.id,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : String(error);
      recordExecution({ skillId: skill.id, timestamp: startTime, status: 'error', duration, args: args || undefined, error: errMsg });

      return {
        success: false,
        error: errMsg,
      };
    }
  }

  buildPrompt(
    skill: Skill,
    parsedArgs: ParsedArgs,
    context: SkillExecutionContext,
    contentOverride?: string,
  ): string {
    const sections: string[] = [];

    // 添加 skill 名称和描述
    sections.push(`# Skill: ${skill.metadata.name}`);
    sections.push('');

    const allowedTools = skill.metadata.neox?.allowedTools;
    if (allowedTools && allowedTools.length > 0) {
      sections.push(`**IMPORTANT: This skill is restricted to the following tools only: ${allowedTools.join(', ')}. Do NOT use any other tools.**`);
      sections.push('');
    }

    if (skill.metadata.effort) {
      sections.push(`**Thinking effort: ${skill.metadata.effort}**`);
      sections.push('');
    }

    // 添加用户参数信息
    if (parsedArgs.raw) {
      sections.push(`## User Arguments`);
      sections.push(`Raw: ${parsedArgs.raw}`);

      if (Object.keys(parsedArgs.named).length > 0) {
        sections.push(`Named: ${JSON.stringify(parsedArgs.named)}`);
      }
      if (parsedArgs.positional.length > 0) {
        sections.push(`Positional: ${parsedArgs.positional.join(', ')}`);
      }
      sections.push('');
    }

    // 添加上下文信息
    sections.push(`## Context`);
    sections.push(`Working Directory: ${context.workDir}`);
    sections.push('');

    // 添加 skill 内容（主体指令）
    sections.push(contentOverride ?? skill.content);

    // 添加支持文件内容（如果有）
    if (skill.supportFiles && skill.supportFiles.size > 0) {
      sections.push('');
      sections.push('## Support Files');
      for (const [fileName, fileContent] of Array.from(skill.supportFiles.entries())) {
        sections.push(`### ${fileName}`);
        sections.push('```');
        sections.push(fileContent);
        sections.push('```');
      }
    }

    return sections.join('\n');
  }

  /**
   * 获取 skill 允许使用的工具列表
   */
  getAllowedTools(skill: Skill): string[] | undefined {
    return skill.metadata.neox?.allowedTools;
  }

  /**
   * 获取 skill 需要的工具列表
   */
  getRequiredTools(skill: Skill): string[] | undefined {
    return skill.metadata.neox?.requiredTools;
  }

  /**
   * 检查 skill 的危险等级
   */
  getDangerLevel(skill: Skill): 'safe' | 'moderate' | 'dangerous' {
    return skill.metadata.neox?.dangerLevel ?? 'safe';
  }
}
