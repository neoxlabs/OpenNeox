/**
 * Provider Prompts - 基础接口和抽象类
 *
 * 用于为每个 AI Provider 构建专属的 System Prompt / Instructions
 */

// ============================================================================
// 类型定义
// ============================================================================

/** Prompt 构建选项 */
export interface ProviderPromptOptions {
  /** 工作目录 */
  workDir: string;

  /** 语言 */
  language?: 'zh' | 'en';

  /** 模型名称（可选，用于模型特定的 prompt） */
  modelName?: string;

  /** 用户自定义的额外 instructions */
  customInstructions?: string;
}

/** Prompt 段落 */
export interface PromptSection {
  /** 段落标题 */
  title?: string;

  /** 段落内容 */
  content: string;

  /** 段落顺序（数字越小越靠前） */
  order?: number;
}

// ============================================================================
// 基础 Prompt Builder 抽象类
// ============================================================================

export abstract class BasePromptBuilder {
  /**
   * 构建完整的 System Prompt / Instructions
   * @param options 构建选项
   * @returns 完整的 prompt 字符串
   */
  abstract buildSystemPrompt(options: ProviderPromptOptions): string;

  /**
   * 获取 provider 特定的约束说明
   * @param language 语言
   * @param modelName 模型名称（可选）
   * @returns 约束说明文本
   */
  abstract getConstraintInstructions(language: 'zh' | 'en', modelName?: string): string;

  /**
   * 获取工具使用说明
   * @param language 语言
   * @returns 工具使用说明文本
   */
  abstract getToolUseInstructions(language: 'zh' | 'en'): string;

  /**
   * 获取核心身份和能力说明
   * @param language 语言
   * @param modelName 模型名称（可选）
   * @returns 核心说明文本
   */
  protected abstract getCoreInstructions(language: 'zh' | 'en', modelName?: string): string;

  /**
   * 组合多个 prompt 段落
   * @param sections 段落列表
   * @returns 组合后的 prompt
   */
  protected combinePromptSections(sections: PromptSection[]): string {
    // 按顺序排序
    const sorted = sections
      .filter((s) => s.content.trim().length > 0)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    return sorted
      .map((section) => {
        if (section.title) {
          return `# ${section.title}\n\n${section.content}`;
        }
        return section.content;
      })
      .join('\n\n');
  }

  /**
   * 获取工作目录说明
   * @param workDir 工作目录
   * @param language 语言
   */
  protected getWorkingDirectorySection(workDir: string, language: 'zh' | 'en'): PromptSection {
    if (language === 'zh') {
      return {
        title: '工作目录',
        content: `当前工作目录: ${workDir}`,
        order: 10,
      };
    }

    return {
      title: 'Working Directory',
      content: `Current working directory: ${workDir}`,
      order: 10,
    };
  }

  /**
   * 检查模型是否匹配某个模式
   * @param modelName 模型名称
   * @param pattern 模式（支持通配符 *）
   */
  protected modelMatches(modelName: string | undefined, pattern: string): boolean {
    if (!modelName) return false;

    if (!pattern.includes('*')) {
      return modelName === pattern;
    }

    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(modelName);
  }

  /**
   * 检查是否是某一类模型
   * @param modelName 模型名称
   * @param patterns 模式列表
   */
  protected isModelType(modelName: string | undefined, ...patterns: string[]): boolean {
    if (!modelName) return false;
    return patterns.some((pattern) => this.modelMatches(modelName, pattern));
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 移除多余的空行（连续的空行替换为单个空行）
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n') // 3个或更多换行 -> 2个换行
    .trim();
}

/**
 * 缩进文本
 * @param text 原文本
 * @param indent 缩进字符（默认 2 个空格）
 */
export function indentText(text: string, indent: string = '  '): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? indent + line : line))
    .join('\n');
}

/**
 * 将多行文本转为单行（用于日志）
 */
export function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
