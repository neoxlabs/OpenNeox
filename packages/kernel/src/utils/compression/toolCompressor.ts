/**
 * Tool 压缩器 - 针对不同 Tool 类型的智能压缩策略
 * Tool Compressor - Smart compression strategies for different tool types
 */

import type { LLMProvider } from '../../types/index.js';
import { getTextFromContent } from '../messageUtils.js';
import { cliLogger } from '../../platform/cliLogger.js';
import {
  ToolType,
  CompressionLevel,
  type CompressionContext,
  type ToolCompressionResult,
  type IToolCompressor,
} from './types.js';

// ============================================================================
// 常量和 Prompt
// ============================================================================

/** 默认截断长度 */
const DEFAULT_TRUNCATE_LENGTH = 2000;

/** Tool 名称到类型的映射 */
const TOOL_TYPE_MAP: Record<string, ToolType> = {
  // 文件操作
  'Read': ToolType.FILE_READ,
  'Write': ToolType.FILE_WRITE,
  'Edit': ToolType.FILE_EDIT,
  'Glob': ToolType.FILE_SEARCH,
  'Grep': ToolType.FILE_SEARCH,

  // 命令执行
  'Bash': ToolType.BASH,
  'BashOutput': ToolType.BASH,

  // 网络操作
  'WebFetch': ToolType.WEB_FETCH,
  'WebSearch': ToolType.WEB_SEARCH,

  // 子代理
  'Task': ToolType.TASK,
};

/** LLM 压缩 Prompt（仅部分 ToolType 支持 LLM 压缩） */
const COMPRESSION_PROMPTS: Partial<Record<ToolType, {
  system: string;
  user: (content: string, path?: string) => string;
}>> = {
  [ToolType.FILE_READ]: {
    system: `你是一个代码分析助手。请将文件内容压缩为简洁摘要，保留：
1. 文件类型和主要功能
2. 关键的函数/类/接口定义（只保留签名）
3. 重要的配置项或常量
4. 与当前任务相关的代码段

格式要求：
- 使用 markdown 格式
- 保留文件路径信息
- 代码片段用 \`\`\` 包裹
- 总长度控制在 500 字以内`,
    user: (content: string, path?: string) =>
      `文件路径: ${path || '未知'}\n\n文件内容:\n${content}\n\n请压缩这个文件的内容。`,
  },

  [ToolType.FILE_EDIT]: {
    system: `你是一个代码变更分析助手。请将编辑操作压缩为简洁摘要，保留：
1. 修改的文件路径
2. 修改的类型（添加/删除/修改）
3. 修改的关键内容摘要
4. 影响的函数/类/行号

格式：[文件路径] 修改类型: 摘要`,
    user: (content: string) =>
      `编辑操作:\n${content}\n\n请压缩这个编辑操作。`,
  },

  [ToolType.BASH]: {
    system: `你是一个命令行输出分析助手。请将命令输出压缩为简洁摘要，保留：
1. 命令执行状态（成功/失败）
2. 关键输出信息（版本号、路径、错误信息等）
3. 如果是构建命令，保留构建结果
4. 如果有错误，保留完整错误信息

格式：[命令] 状态: 关键输出`,
    user: (content: string) =>
      `命令输出:\n${content}\n\n请压缩这个命令输出。`,
  },

  [ToolType.WEB_FETCH]: {
    system: `你是一个网页内容分析助手。请将网页内容压缩为简洁摘要，保留：
1. 页面标题和 URL
2. 主要内容摘要
3. 与用户问题相关的关键信息
4. 重要的代码示例或配置

格式要求：
- 不保留导航、广告等无关内容
- 代码片段用 \`\`\` 包裹
- 保留重要链接
- 总长度控制在 800 字以内`,
    user: (content: string) =>
      `网页内容:\n${content}\n\n请提取并压缩这个网页的核心内容。`,
  },

  [ToolType.WEB_SEARCH]: {
    system: `你是一个搜索结果分析助手。请将搜索结果压缩为简洁摘要，保留：
1. 最相关的 3-5 条结果
2. 每条结果的标题和简介
3. 重要的 URL 链接

格式：
1. [标题](URL) - 简介
2. ...`,
    user: (content: string) =>
      `搜索结果:\n${content}\n\n请压缩这个搜索结果。`,
  },

  [ToolType.TASK]: {
    system: `你是一个任务结果分析助手。请将子任务的执行结果压缩为简洁摘要，保留：
1. 任务的主要发现或结论
2. 找到的关键文件或代码位置
3. 执行的主要操作
4. 未完成的部分（如有）

格式：[任务类型] 结论: 摘要`,
    user: (content: string) =>
      `任务结果:\n${content}\n\n请压缩这个任务结果。`,
  },
};

// ============================================================================
// ToolCompressor 类
// ============================================================================

export class ToolCompressor implements IToolCompressor {
  readonly supportedTools = Object.keys(TOOL_TYPE_MAP);

  private debug: boolean;
  private llmProvider?: LLMProvider;
  private model?: string;

  constructor(options?: {
    debug?: boolean;
    llmProvider?: LLMProvider;
    model?: string;
  }) {
    this.debug = options?.debug ?? (process.env.CLI_DEBUG === '1');
    this.llmProvider = options?.llmProvider;
    this.model = options?.model;
  }

  /**
   * 获取 tool 类型
   */
  getToolType(toolName: string): ToolType {
    // 处理 MCP 工具（格式：mcp__server__tool）
    if (toolName.startsWith('mcp__')) {
      return ToolType.MCP;
    }
    return TOOL_TYPE_MAP[toolName] || ToolType.OTHER;
  }

  /**
   * 判断是否需要 LLM 压缩
   *  支持根据模型上下文窗口动态调整阈值
   */
  needsLLMCompression(toolName: string, toolResult: string, contextWindow?: number): boolean {
    const toolType = this.getToolType(toolName);

    // 以下类型总是使用 LLM 压缩（内容复杂，需要智能提取）
    const alwaysUseLLM = [
      ToolType.WEB_FETCH,
      ToolType.WEB_SEARCH,
      ToolType.TASK,
    ];

    if (alwaysUseLLM.includes(toolType)) {
      return true;
    }

    //  根据上下文窗口动态计算阈值
    // 基准：200K 上下文使用以下阈值，其他按比例缩放
    // 默认：128K（当找不到模型配置时）
    const DEFAULT_CONTEXT_WINDOW = 128_000;
    const baseContextWindow = 200_000;
    const effectiveContextWindow = contextWindow || DEFAULT_CONTEXT_WINDOW;
    const scaleFactor = Math.max(0.3, Math.min(2.0, effectiveContextWindow / baseContextWindow));  // 限制在 0.3x ~ 2x

    // 基准阈值（字符数，基于 200K 上下文）
    const baseThresholds: Record<ToolType, number> = {
      [ToolType.FILE_READ]: 20000,    // ~7K tokens
      [ToolType.FILE_WRITE]: 8000,    // ~3K tokens
      [ToolType.FILE_EDIT]: 5000,     // ~2K tokens
      [ToolType.FILE_SEARCH]: 10000,  // ~3K tokens
      [ToolType.BASH]: 15000,         // ~5K tokens
      [ToolType.WEB_FETCH]: 0,        // 总是压缩
      [ToolType.WEB_SEARCH]: 0,       // 总是压缩
      [ToolType.IMAGE_ANALYSIS]: 3000, // ~1K tokens
      [ToolType.MCP]: 10000,          // ~3K tokens
      [ToolType.TASK]: 0,             // 总是压缩
      [ToolType.OTHER]: 15000,        // ~5K tokens
    };

    const baseThreshold = baseThresholds[toolType] ?? 15000;
    const threshold = Math.floor(baseThreshold * scaleFactor);

    if (this.debug) {
      cliLogger.debug('ToolCompressor',
        `[${toolName}] contextWindow=${effectiveContextWindow}${contextWindow ? '' : '(default)'}, scaleFactor=${scaleFactor.toFixed(2)}, threshold=${threshold}`
      );
    }

    return toolResult.length > threshold;
  }

  /**
   * 压缩 tool 结果
   */
  async compress(
    toolName: string,
    toolResult: string,
    context: CompressionContext
  ): Promise<ToolCompressionResult> {
    const toolType = this.getToolType(toolName);
    const originalLength = toolResult.length;

    // 提取元数据
    const metadata = this.extractMetadata(toolType, toolResult, toolName);

    // 判断压缩策略（传入 contextWindow 用于动态阈值）
    const needsLLM = this.needsLLMCompression(toolName, toolResult, context.contextWindow);
    const llmProvider = context.llmProvider || this.llmProvider;

    let compressedContent: string;
    let usedLLM = false;

    if (needsLLM && llmProvider && context.enableLLMCompression !== false) {
      // 使用 LLM 智能压缩
      const llmResult = await this.compressWithLLM(
        toolType,
        toolResult,
        llmProvider,
        context.model || this.model,
        metadata
      );

      if (llmResult) {
        compressedContent = llmResult;
        usedLLM = true;
      } else {
        // LLM 失败，回退到规则压缩
        compressedContent = this.compressWithRules(toolType, toolResult, metadata);
      }
    } else {
      // 使用规则压缩
      compressedContent = this.compressWithRules(toolType, toolResult, metadata);
    }

    if (this.debug) {
      const ratio = ((1 - compressedContent.length / originalLength) * 100).toFixed(1);
      cliLogger.debug('ToolCompressor',
        `[${toolName}] ${originalLength} → ${compressedContent.length} chars (${ratio}% saved, LLM: ${usedLLM})`
      );
    }

    return {
      content: compressedContent,
      originalLength,
      compressedLength: compressedContent.length,
      strategy: toolType,
      usedLLM,
      metadata,
    };
  }

  /**
   * 提取元数据
   */
  private extractMetadata(
    toolType: ToolType,
    content: string,
    toolName: string
  ): ToolCompressionResult['metadata'] {
    const metadata: ToolCompressionResult['metadata'] = {};

    switch (toolType) {
      case ToolType.FILE_READ:
      case ToolType.FILE_WRITE:
      case ToolType.FILE_EDIT:
        // 尝试从内容中提取文件路径
        const pathMatch = content.match(/(?:file|path)[:\s]+([^\n]+)/i);
        if (pathMatch) {
          metadata.filePath = pathMatch[1].trim();
        }
        break;

      case ToolType.BASH:
        // 提取命令和退出码
        const cmdMatch = content.match(/(?:command|cmd)[:\s]+([^\n]+)/i);
        if (cmdMatch) {
          metadata.command = cmdMatch[1].trim();
        }
        // 检测错误
        if (/error|failed|exit code [1-9]/i.test(content)) {
          metadata.exitCode = 1;
        }
        break;

      case ToolType.WEB_FETCH:
      case ToolType.WEB_SEARCH:
        // 提取 URL
        const urlMatches = content.match(/https?:\/\/[^\s\)]+/g);
        if (urlMatches) {
          metadata.urls = [...new Set(urlMatches)].slice(0, 10);
        }
        break;
    }

    return metadata;
  }

  /**
   * 使用 LLM 压缩
   */
  private async compressWithLLM(
    toolType: ToolType,
    content: string,
    llmProvider: LLMProvider,
    model?: string,
    metadata?: ToolCompressionResult['metadata']
  ): Promise<string | null> {
    const prompt = COMPRESSION_PROMPTS[toolType];
    if (!prompt) {
      return null;
    }

    try {
      // 如果内容太长，先截断
      const maxInputLength = 8000;
      const truncatedContent = content.length > maxInputLength
        ? content.slice(0, maxInputLength) + '\n\n...[内容过长，已截断]...'
        : content;

      const response = await llmProvider.chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user(truncatedContent, metadata?.filePath) },
        ],
        {
          model,
          temperature: 0.2,
          // 限制输出长度
        }
      );

      const summary = getTextFromContent(response.choices[0]?.message?.content);
      return summary?.trim() || null;
    } catch (error: any) {
      cliLogger.warn('ToolCompressor', `LLM compression failed: ${error.message}`);
      return null;
    }
  }

  /**
   * 使用规则压缩（回退策略）
   */
  private compressWithRules(
    toolType: ToolType,
    content: string,
    metadata?: ToolCompressionResult['metadata']
  ): string {
    const maxLength = DEFAULT_TRUNCATE_LENGTH;

    switch (toolType) {
      case ToolType.FILE_READ:
        return this.compressFileRead(content, metadata?.filePath, maxLength);

      case ToolType.FILE_EDIT:
        return this.compressFileEdit(content, maxLength);

      case ToolType.BASH:
        return this.compressBash(content, metadata?.command, maxLength);

      case ToolType.WEB_FETCH:
      case ToolType.WEB_SEARCH:
        return this.compressWebContent(content, metadata?.urls, maxLength);

      case ToolType.FILE_SEARCH:
        return this.compressSearchResult(content, maxLength);

      default:
        return this.truncateWithContext(content, maxLength);
    }
  }

  /**
   * 压缩文件读取结果
   */
  private compressFileRead(content: string, filePath?: string, maxLength: number = 2000): string {
    const lines = content.split('\n');
    const header = filePath ? `📄 ${filePath}\n` : '';

    if (content.length <= maxLength) {
      return header + content;
    }

    // 保留头部和尾部
    const headLines = Math.floor(maxLength * 0.6 / 80); // 假设每行约80字符
    const tailLines = Math.floor(maxLength * 0.3 / 80);

    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(-tailLines).join('\n');
    const omitted = lines.length - headLines - tailLines;

    return `${header}${head}\n\n... [省略 ${omitted} 行] ...\n\n${tail}`;
  }

  /**
   * 压缩文件编辑结果
   */
  private compressFileEdit(content: string, maxLength: number = 1500): string {
    // 提取关键信息
    const fileMatch = content.match(/file[:\s]+([^\n]+)/i);
    const oldMatch = content.match(/old_string[:\s]+([\s\S]*?)(?=new_string|$)/i);
    const newMatch = content.match(/new_string[:\s]+([\s\S]*?)$/i);

    if (fileMatch) {
      const file = fileMatch[1].trim();
      const oldStr = oldMatch ? this.truncate(oldMatch[1].trim(), 200) : '';
      const newStr = newMatch ? this.truncate(newMatch[1].trim(), 200) : '';

      return `📝 编辑: ${file}\n旧内容: ${oldStr}\n新内容: ${newStr}`;
    }

    return this.truncateWithContext(content, maxLength);
  }

  /**
   * 压缩 Bash 输出
   */
  private compressBash(content: string, command?: string, maxLength: number = 2000): string {
    const lines = content.split('\n');
    const header = command ? `$ ${command}\n` : '';

    // 检测是否有错误
    const hasError = /error|failed|exception/i.test(content);

    if (hasError) {
      // 错误情况下保留更多内容
      return header + this.truncateWithContext(content, maxLength * 1.5);
    }

    if (content.length <= maxLength) {
      return header + content;
    }

    // 保留头部和尾部
    const headLines = 10;
    const tailLines = 20;

    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(-tailLines).join('\n');
    const omitted = lines.length - headLines - tailLines;

    return `${header}${head}\n\n... [省略 ${omitted} 行] ...\n\n${tail}`;
  }

  /**
   * 压缩网页内容
   */
  private compressWebContent(content: string, urls?: string[], maxLength: number = 2000): string {
    // 移除 HTML 标签（如果有）
    let cleaned = content.replace(/<[^>]+>/g, ' ');
    // 移除多余空白
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    const urlSection = urls?.length ? `\n\n相关链接:\n${urls.slice(0, 5).map(u => `- ${u}`).join('\n')}` : '';

    return this.truncate(cleaned, maxLength - urlSection.length) + urlSection;
  }

  /**
   * 压缩搜索结果
   */
  private compressSearchResult(content: string, maxLength: number = 2000): string {
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length <= 30) {
      return content;
    }

    // 只保留前30个结果
    return lines.slice(0, 30).join('\n') + `\n\n... [还有 ${lines.length - 30} 个结果] ...`;
  }

  /**
   * 带上下文的截断
   */
  private truncateWithContext(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }

    const headLength = Math.floor(maxLength * 0.7);
    const tailLength = Math.floor(maxLength * 0.25);

    const head = content.slice(0, headLength);
    const tail = content.slice(-tailLength);
    const omitted = content.length - headLength - tailLength;

    return `${head}\n\n... [省略 ${omitted} 字符] ...\n\n${tail}`;
  }

  /**
   * 简单截断
   */
  private truncate(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }
    return content.slice(0, maxLength - 3) + '...';
  }
}

// 默认实例
export const toolCompressor = new ToolCompressor();
