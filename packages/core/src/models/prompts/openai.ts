/**
 * OpenAI (GPT) Prompt Builder
 *
 * 走分层 prompt (runtime/systemPrompt.ts buildInstructions),
 * 不再维护一套独立的 chat-completions / responses-API prompt,
 * 子类只补 OpenAI 协议下的工具/约束格式 (供 base 抽象方法实现).
 */

import { BasePromptBuilder, type ProviderPromptOptions, normalizeWhitespace } from './base.js';
import { buildKernelInstructions } from '@neoxlabs/kernel/core/instructionsBridge.js';

export class OpenAIPromptBuilder extends BasePromptBuilder {
  buildSystemPrompt(options: ProviderPromptOptions): string {
    const { workDir, language = 'zh', modelName, customInstructions } = options;

    const protocol = this.isResponsesAPIModel(modelName)
      ? 'openai-responses'
      : 'openai';

    let prompt = buildKernelInstructions({
      workDir,
      language,
      protocol,
      model: modelName,
    }) ?? '';

    if (customInstructions && customInstructions.trim()) {
      prompt += '\n\n# Custom Instructions\n\n' + customInstructions.trim();
    }

    return normalizeWhitespace(prompt);
  }

  /**
   * 获取核心身份说明
   */
  protected getCoreInstructions(language: 'zh' | 'en', modelName?: string): string {
    const displayName = this.getModelDisplayName(modelName);

    if (language === 'zh') {
      return `你是一个专业的 AI 编程助手，基于 ${displayName} 提供支持。

你的主要职责是帮助用户完成软件工程任务，包括：
- 代码生成和修改
- 问题调试和解决
- 技术咨询和建议
- 文件操作和项目管理`;
    }

    return `You are a professional AI coding assistant powered by ${displayName}.

Your primary responsibilities include:
- Code generation and modification
- Debugging and problem-solving
- Technical consulting and advice
- File operations and project management`;
  }

  /**
   * 获取约束说明
   */
  getConstraintInstructions(language: 'zh' | 'en', modelName?: string): string {
    const isReasoningModel = this.isResponsesAPIModel(modelName);

    if (language === 'zh') {
      let constraints = `- **max_tokens**: 最大输出长度（根据模型不同）
- **temperature**: 0.0 - 2.0，控制随机性
- **top_p**: 0.0 - 1.0，核采样参数`;

      if (isReasoningModel) {
        constraints += '\n- **reasoning_effort**: low/medium/high，推理强度';
      }

      return constraints;
    }

    let constraints = `- **max_tokens**: Maximum output length (varies by model)
- **temperature**: 0.0 - 2.0, controls randomness
- **top_p**: 0.0 - 1.0, nucleus sampling parameter`;

    if (isReasoningModel) {
      constraints += '\n- **reasoning_effort**: low/medium/high, reasoning intensity';
    }

    return constraints;
  }

  /**
   * 获取工具使用说明
   */
  getToolUseInstructions(language: 'zh' | 'en'): string {
    if (language === 'zh') {
      return `使用 OpenAI Function Calling 格式调用工具：

\`\`\`json
{
  "tool_calls": [{
    "id": "call_xxx",
    "type": "function",
    "function": {
      "name": "read_file",
      "arguments": "{\\"path\\": \\"/path/to/file\\"}"
    }
  }]
}
\`\`\`

工具结果通过 tool 角色的消息返回。`;
    }

    return `Use OpenAI Function Calling format to invoke tools:

\`\`\`json
{
  "tool_calls": [{
    "id": "call_xxx",
    "type": "function",
    "function": {
      "name": "read_file",
      "arguments": "{\\"path\\": \\"/path/to/file\\"}"
    }
  }]
}
\`\`\`

Tool results are returned via messages with role "tool".`;
  }

  /**
   * 获取模型显示名称
   */
  private getModelDisplayName(modelName?: string): string {
    if (!modelName) return 'GPT-4';

    if (modelName.includes('o3')) return 'OpenAI o3';
    if (modelName.includes('o1')) return 'OpenAI o1';
    if (modelName.includes('gpt-4o')) return 'GPT-4o';
    if (modelName.includes('gpt-4')) return 'GPT-4';
    if (modelName.includes('gpt-3.5')) return 'GPT-3.5';

    return modelName;
  }

  /**
   * 检查是否是 Responses API 模型
   */
  private isResponsesAPIModel(modelName?: string): boolean {
    return this.isModelType(modelName, 'o1*', 'o3*', 'o4*');
  }
}

/**
 * 导出单例实例
 */
export const openaiPromptBuilder = new OpenAIPromptBuilder();
