/**
 * Gemini Prompt Builder
 *
 * Build a lightweight system prompt for Gemini models.
 */

import {
  BasePromptBuilder,
  type ProviderPromptOptions,
  type PromptSection,
  normalizeWhitespace,
} from './base.js';
import { lookupRegistryModel } from '@neoxlabs/platform/platform/modelCapabilities.js';

export class GeminiPromptBuilder extends BasePromptBuilder {
  buildSystemPrompt(options: ProviderPromptOptions): string {
    const { workDir, language = 'zh', modelName, customInstructions } = options;

    const sections: PromptSection[] = [];

    sections.push({
      content: this.getCoreInstructions(language, modelName),
      order: 0,
    });

    sections.push(this.getWorkingDirectorySection(workDir, language));

    sections.push({
      content: this.getCapabilitiesSection(language, modelName),
      order: 20,
    });

    sections.push({
      title: language === 'zh' ? '参数约束' : 'Parameter Constraints',
      content: this.getConstraintInstructions(language),
      order: 30,
    });

    sections.push({
      title: language === 'zh' ? '工具调用' : 'Tool Usage',
      content: this.getToolUseInstructions(language),
      order: 40,
    });

    sections.push({
      content: this.getGeneralRules(language),
      order: 50,
    });

    if (customInstructions && customInstructions.trim()) {
      sections.push({
        title: language === 'zh' ? '自定义指令' : 'Custom Instructions',
        content: customInstructions.trim(),
        order: 60,
      });
    }

    return normalizeWhitespace(this.combinePromptSections(sections));
  }

  getConstraintInstructions(language: 'zh' | 'en'): string {
    if (language === 'zh') {
      return `- temperature: 0.0 - 2.0
- topP: 0.0 - 1.0
- topK: >= 1
- maxOutputTokens: 控制输出长度
- stopSequences: 可选，字符串数组`;
    }

    return `- temperature: 0.0 - 2.0
- topP: 0.0 - 1.0
- topK: >= 1
- maxOutputTokens: controls output length
- stopSequences: optional array of strings`;
  }

  getToolUseInstructions(language: 'zh' | 'en'): string {
    if (language === 'zh') {
      return `- 优先使用工具完成文件与命令操作
- 工具参数必须是有效 JSON
- 工具返回后再继续下一步`;
    }

    return `- Prefer tools for file/command operations
- Tool arguments must be valid JSON
- Continue only after tool results return`;
  }

  protected getCoreInstructions(language: 'zh' | 'en', modelName?: string): string {
    const displayName = this.getModelDisplayName(modelName);

    if (language === 'zh') {
      return `你是一个专业的 AI 编程助手，基于 ${displayName} 提供支持。

你的主要职责是：
- 代码生成和修改
- 问题调试和解决
- 技术咨询和建议
- 文件操作和项目管理`;
    }

    return `You are a professional AI coding assistant powered by ${displayName}.

Your primary responsibilities:
- Code generation and modification
- Debugging and problem-solving
- Technical consulting and advice
- File operations and project management`;
  }

  private getCapabilitiesSection(language: 'zh' | 'en', modelName?: string): string {
    const supportsVision = this.supportsVision(modelName);

    if (language === 'zh') {
      let text = `# 你的能力

- **代码理解**: 阅读和分析代码，提供优化建议
- **代码生成**: 根据需求生成高质量代码
- **工具调用**: 执行文件操作、运行命令等`;

      if (supportsVision) {
        text += '\n- **视觉理解**: 分析图片、截图、图表等视觉内容';
      }

      return text;
    }

    let text = `# Capabilities

- **Code understanding**: analyze code and propose improvements
- **Code generation**: produce high-quality code from requirements
- **Tool usage**: perform file operations and run commands`;

    if (supportsVision) {
      text += '\n- **Vision**: analyze images, screenshots, and diagrams';
    }

    return text;
  }

  private getGeneralRules(language: 'zh' | 'en'): string {
    if (language === 'zh') {
      return `# 通用规则

1. **准确优先**：确保代码和建议正确
2. **简洁直达**：避免冗余，直接回答
3. **安全第一**：避免危险或破坏性操作
4. **专业客观**：保持技术性、客观表达`;
    }

    return `# General Rules

1. **Accuracy first**: ensure correctness
2. **Be concise**: avoid redundancy
3. **Safety first**: avoid destructive actions
4. **Professional tone**: objective and technical`;
  }

  private getModelDisplayName(modelName?: string): string {
    if (!modelName) return 'Gemini';

    if (modelName.includes('gemini-3')) return 'Gemini 3';
    if (modelName.includes('gemini-2.5')) return 'Gemini 2.5';
    if (modelName.includes('gemini-2.0')) return 'Gemini 2.0';
    if (modelName.includes('gemini-1.5')) return 'Gemini 1.5';
    if (modelName.includes('gemini-1.0')) return 'Gemini 1.0';

    return modelName;
  }

  private supportsVision(modelName?: string): boolean {
    if (!modelName) return false;
    const meta = lookupRegistryModel(modelName);
    if (meta?.supportsVision !== undefined) return meta.supportsVision;
    if (modelName.includes('vision')) return true;
    return this.isModelType(modelName, 'gemini-1.5*', 'gemini-2*', 'gemini-3*');
  }
}

export const geminiPromptBuilder = new GeminiPromptBuilder();
