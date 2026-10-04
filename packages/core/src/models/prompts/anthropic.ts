/**
 * Anthropic (Claude) Prompt Builder
 *
 * 使用现有的分层 Prompt 系统（不修改）
 * 路径: src/runtime/prompts/layers/
 */

import { BasePromptBuilder, type ProviderPromptOptions, normalizeWhitespace } from './base.js';
import { buildLayeredPrompt } from '../../runtime/prompts/layers/index.js';

/**
 * Anthropic Prompt Builder
 *
 * 直接使用现有的分层 prompt 系统:
 * - Layer 1: 环境信息
 * - Layer 2: 通用 Agent
 * - Layer 3: 固定约束
 */
export class AnthropicPromptBuilder extends BasePromptBuilder {
  /**
   * 构建 System Prompt
   *
   * 直接调用现有的 buildLayeredPrompt，保持不变
   */
  buildSystemPrompt(options: ProviderPromptOptions): string {
    const { workDir, language = 'zh', customInstructions } = options;

    // 使用现有的分层 prompt 系统
    let prompt = buildLayeredPrompt({
      workDir,
      language,
    });

    // 如果有自定义 instructions，追加到最后
    if (customInstructions && customInstructions.trim()) {
      prompt += '\n\n# Custom Instructions\n\n' + customInstructions.trim();
    }

    return normalizeWhitespace(prompt);
  }

  /**
   * 获取核心 instructions
   * （从分层系统中提取，仅供参考）
   */
  protected getCoreInstructions(language: 'zh' | 'en', modelName?: string): string {
    // Anthropic 使用分层 prompt，这里返回简化版本
    if (language === 'zh') {
      return '你是一个专业的 AI 编程助手，帮助用户完成软件工程任务。';
    }
    return 'You are a professional AI coding assistant helping users with software engineering tasks.';
  }

  /**
   * 获取约束说明
   */
  getConstraintInstructions(language: 'zh' | 'en', modelName?: string): string {
    const isThinkingModel = this.supportsExtendedThinking(modelName);

    if (language === 'zh') {
      let constraints = `# Claude 特性

- **Extended Thinking**: ${isThinkingModel ? '支持深度思考模式（thinking.type: enabled）' : '不支持'}
- **Prompt Caching**: 自动缓存重复的上下文，节省成本
- **max_tokens**: 最大 8192 (Sonnet) 或 4096 (Opus)
- **温度范围**: 0.0 - 1.0（比 OpenAI 范围更窄）`;

      return constraints;
    }

    let constraints = `# Claude Features

- **Extended Thinking**: ${isThinkingModel ? 'Supports deep thinking mode (thinking.type: enabled)' : 'Not supported'}
- **Prompt Caching**: Automatic caching of repeated context for cost savings
- **max_tokens**: Maximum 8192 (Sonnet) or 4096 (Opus)
- **Temperature range**: 0.0 - 1.0 (narrower than OpenAI)`;

    return constraints;
  }

  /**
   * 获取工具使用说明
   */
  getToolUseInstructions(language: 'zh' | 'en'): string {
    if (language === 'zh') {
      return `# 工具调用格式

Claude 使用标准的工具调用格式：

\`\`\`json
{
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_xxx",
      "name": "read_file",
      "input": {
        "path": "/path/to/file"
      }
    }
  ]
}
\`\`\`

工具结果通过 tool_result 消息返回。`;
    }

    return `# Tool Use Format

Claude uses standard tool calling format:

\`\`\`json
{
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_xxx",
      "name": "read_file",
      "input": {
        "path": "/path/to/file"
      }
    }
  ]
}
\`\`\`

Tool results are returned via tool_result messages.`;
  }

  /**
   * 检查模型是否支持 Extended Thinking
   */
  private supportsExtendedThinking(modelName?: string): boolean {
    if (!modelName) return false;
    return (
      modelName.includes('claude-3-5-sonnet') ||
      modelName.includes('claude-3-opus')
    );
  }

  /**
   * 检查模型是否支持 Prompt Caching
   */
  supportsPromptCaching(modelName?: string): boolean {
    if (!modelName) return false;
    return (
      modelName.includes('claude-3-5') ||
      modelName.includes('claude-3-opus') ||
      modelName.includes('claude-3-sonnet')
    );
  }

  /**
   * 获取 Prompt Caching 配置建议
   */
  getCachingRecommendation(promptLength: number): {
    shouldUseCache: boolean;
    cacheTTL: '5m' | '1h';
    reason: string;
  } {
    // 短 prompt (<2K tokens) 不建议缓存
    if (promptLength < 2000) {
      return {
        shouldUseCache: false,
        cacheTTL: '5m',
        reason: 'Prompt too short, caching overhead not worth it',
      };
    }

    // 中等长度 (2K-10K) 使用 5 分钟缓存
    if (promptLength < 10000) {
      return {
        shouldUseCache: true,
        cacheTTL: '5m',
        reason: 'Medium prompt, 5-minute cache recommended',
      };
    }

    // 长 prompt (>10K) 使用 1 小时缓存
    return {
      shouldUseCache: true,
      cacheTTL: '1h',
      reason: 'Long prompt, 1-hour cache recommended for cost savings',
    };
  }
}

/**
 * 导出单例实例
 */
export const anthropicPromptBuilder = new AnthropicPromptBuilder();
