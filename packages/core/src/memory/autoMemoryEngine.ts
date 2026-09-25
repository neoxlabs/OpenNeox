/**
 * AutoMemoryEngine — 自动记忆提取引擎
 *
 * 对话结束时用轻量模型自动提取有价值信息，写入长期记忆。
 * 支持去重（基于文本相似度）和配置化开关。
 */

import type { Message, LLMProvider } from '@neoxlabs/kernel/types/index.js';
import type { ActionLogService } from '../platform/actionLog/actionLogService.js';
import type { MemoryCategory } from '@neoxlabs/platform/platform/memory/types.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// 类型
// ============================================================================

export interface AutoMemoryConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 用于提取的 LLM provider */
  provider: LLMProvider;
  /** 模型名称 */
  model: string;
  /** 最低置信度（低于此值不写入） */
  minConfidence: number;
  /** 每次对话最多提取条数 */
  maxItemsPerSession: number;
  /** 去重相似度阈值（0-1，越高越严格） */
  dedupThreshold: number;
}

interface ExtractedMemoryItem {
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string[];
  files?: string[];
}

interface ExtractionResult {
  items: ExtractedMemoryItem[];
  projectUpdate?: {
    section: string;
    content: string;
  };
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: Omit<AutoMemoryConfig, 'provider' | 'model'> = {
  enabled: true,
  minConfidence: 0.7,
  maxItemsPerSession: 5,
  dedupThreshold: 0.75,
};

// ============================================================================
// 提取 Prompt
// ============================================================================

const EXTRACTION_SYSTEM_PROMPT = `你是记忆提取助手。分析对话，提取值得长期记住的信息。

输出严格 JSON 格式：
{
  "items": [
    {
      "category": "pinned|standard|lesson|progress",
      "content": "简洁的一句话描述",
      "confidence": 0.0-1.0,
      "tags": ["tag1", "tag2"],
      "files": ["path/to/file"]
    }
  ],
  "projectUpdate": null
}

分类规则：
- pinned: 架构决策、重要约定（如"项目用 Hono 不用 Express"）
- standard: 编码规范、命名约定（如"工具名用 snake_case"）
- lesson: 踩过的坑、解决方案（如"Kimi K2.5 需要保留 reasoning_content"）
- progress: 任务完成状态（如"已完成 MCP 客户端集成"）

不要提取：
- 临时调试信息
- 单次使用的代码片段
- 闲聊内容
- 已经很明显的信息（如"用户让我修改文件"）

confidence 评分：
- 0.9+: 明确的架构决策或反复确认的规范
- 0.8: 有价值的教训或重要发现
- 0.7: 可能有用但不确定
- <0.7: 不要输出

如果没有值得提取的信息，返回 {"items": [], "projectUpdate": null}`;

// ============================================================================
// 引擎
// ============================================================================

export class AutoMemoryEngine {
  private config: AutoMemoryConfig;

  constructor(config: Partial<AutoMemoryConfig> & Pick<AutoMemoryConfig, 'provider' | 'model'>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 对话结束后提取记忆
   */
  async extract(
    messages: Message[],
    actionLog: ActionLogService,
  ): Promise<{ saved: number; skipped: number }> {
    if (!this.config.enabled) return { saved: 0, skipped: 0 };

    // 只取最近的对话（避免 token 过多）
    const recentMessages = this.trimMessages(messages, 30);
    if (recentMessages.length < 4) return { saved: 0, skipped: 0 };

    try {
      // 1. LLM 提取
      const extraction = await this.callLLM(recentMessages);
      if (!extraction || extraction.items.length === 0) {
        return { saved: 0, skipped: 0 };
      }

      // 2. 过滤低置信度
      const qualified = extraction.items
        .filter(item => item.confidence >= this.config.minConfidence)
        .slice(0, this.config.maxItemsPerSession);

      // 3. 去重
      let saved = 0;
      let skipped = 0;

      for (const item of qualified) {
        const isDuplicate = await this.checkDuplicate(item, actionLog);
        if (isDuplicate) {
          skipped++;
          continue;
        }

        actionLog.addMemoryItem({
          category: item.category,
          summary: item.content,
          tags: item.tags,
          files: item.files,
          confidence: item.confidence,
        });
        saved++;
      }

      if (saved > 0) {
        cliLogger.info('AUTO_MEMORY', `Extracted ${saved} items (${skipped} duplicates skipped)`);
      }

      return { saved, skipped };
    } catch (error: any) {
      cliLogger.warn('AUTO_MEMORY', 'Extraction failed', { error: error.message });
      return { saved: 0, skipped: 0 };
    }
  }

  // --------------------------------------------------------------------------
  // LLM 调用
  // --------------------------------------------------------------------------

  private async callLLM(messages: Message[]): Promise<ExtractionResult | null> {
    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const content = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c: any) => c.text || '').join('')
            : '';
        // 截断过长的单条消息
        const trimmed = content.length > 1500 ? content.slice(0, 1500) + '...' : content;
        return `[${m.role}]: ${trimmed}`;
      })
      .join('\n\n');

    const response = await this.config.provider.chat(
      [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: `分析以下对话，提取值得长期记住的信息：\n\n${conversationText}` },
      ],
      { model: this.config.model, temperature: 0.2 },
    );

    const text = response.choices?.[0]?.message?.content;
    if (!text) return null;

    return this.parseResponse(text);
  }

  private parseResponse(text: string): ExtractionResult | null {
    try {
      // 提取 JSON（可能被 markdown 包裹）
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.items || !Array.isArray(parsed.items)) return null;

      // 验证每个 item
      const validCategories = new Set(['pinned', 'standard', 'lesson', 'progress']);
      const items: ExtractedMemoryItem[] = parsed.items
        .filter((item: any) =>
          item.category && validCategories.has(item.category) &&
          item.content && typeof item.content === 'string' &&
          typeof item.confidence === 'number',
        )
        .map((item: any) => ({
          category: item.category as MemoryCategory,
          content: item.content.slice(0, 300),
          confidence: Math.min(1, Math.max(0, item.confidence)),
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 5) : [],
          files: Array.isArray(item.files) ? item.files.slice(0, 5) : undefined,
        }));

      return {
        items,
        projectUpdate: parsed.projectUpdate || null,
      };
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // 去重
  // --------------------------------------------------------------------------

  private async checkDuplicate(
    item: ExtractedMemoryItem,
    actionLog: ActionLogService,
  ): Promise<boolean> {
    try {
      const existing = await actionLog.getRecentMemoryItems(item.category, 30);
      for (const mem of existing) {
        const similarity = textSimilarity(item.content, mem.summary);
        if (similarity >= this.config.dedupThreshold) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // 工具
  // --------------------------------------------------------------------------

  private trimMessages(messages: Message[], maxCount: number): Message[] {
    if (messages.length <= maxCount) return messages;
    // 保留第一条（system）和最后 maxCount-1 条
    const first = messages[0]?.role === 'system' ? [messages[0]] : [];
    const rest = messages.slice(-(maxCount - first.length));
    return [...first, ...rest];
  }
}

// ============================================================================
// 文本相似度（Jaccard 系数，基于 bigram）
// ============================================================================

function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);

  if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function getBigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const bigrams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    bigrams.add(normalized.slice(i, i + 2));
  }
  return bigrams;
}
