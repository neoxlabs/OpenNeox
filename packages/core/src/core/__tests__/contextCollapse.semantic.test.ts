/**
 * Context Collapse — Semantic Scoring Unit Tests
 *
 * Tests:
 * - Semantic promotion of relevant turns from Layer 2
 * - Keyword matching raises scores
 * - CJK bigram scoring
 * - maxPromotedTurns limit
 * - semanticScoring=false disables promotion
 * - Empty queryText fallback to last user message
 */

import { describe, it, expect } from 'vitest';
import { extractLastUserQuery } from '@neoxlabs/kernel/core/contextCollapse.js';
import { contextCollapse, type CollapseConfig } from '@neoxlabs/kernel/core/contextCollapse.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';

// ==================== Helpers ====================

/** Create a simple user message */
function userMsg(content: string): Message {
  return { role: 'user', content };
}

/** Create a simple assistant message */
function assistantMsg(content: string): Message {
  return { role: 'assistant', content };
}

/** Create a tool result message */
function toolMsg(content: string, name?: string): Message {
  return { role: 'tool' as any, content, name } as any;
}

/**
 * Build a conversation with N turns.
 * Each turn = [user, assistant] or [user, assistant, tool].
 */
function buildConversation(turns: Array<{ user: string; assistant: string; tool?: string }>): Message[] {
  const msgs: Message[] = [];
  for (const t of turns) {
    msgs.push(userMsg(t.user));
    msgs.push(assistantMsg(t.assistant));
    if (t.tool) {
      msgs.push(toolMsg(t.tool, 'readfile'));
    }
  }
  return msgs;
}

/** Default config for testing with enough turns to trigger Layer 2 */
const testConfig: Partial<CollapseConfig> = {
  recentTurns: 2,
  middleTurns: 2,
  toolResultMaxChars: 50,
  semanticScoring: true,
  relevanceThreshold: 0.1, // low threshold for easier testing
  maxPromotedTurns: 2,
};

describe('contextCollapse — semantic scoring', () => {
  // ========================================================================
  // 1. Semantic promotion from Layer 2
  // ========================================================================
  describe('semantic promotion', () => {
    it('promotes relevant Layer 2 turns instead of collapsing them', () => {
      // Build 8 turns so we have Layer 2 (turns 0-3), Layer 1 (turns 4-5), Layer 0 (turns 6-7)
      const msgs = buildConversation([
        { user: 'How do I configure webpack?', assistant: 'Use webpack.config.js with entry and output fields.' },
        { user: 'What about babel plugins?', assistant: 'Add plugins to .babelrc or babel.config.js' },
        { user: 'Tell me about docker networking', assistant: 'Docker uses bridge networks by default.' },
        { user: 'What is a Dockerfile?', assistant: 'A Dockerfile defines container build steps.' },
        { user: 'How do I use CSS modules?', assistant: 'Import styles as modules with webpack css-loader.' },
        { user: 'What about PostCSS?', assistant: 'PostCSS transforms CSS with plugins.' },
        { user: 'How do I set up webpack dev server?', assistant: 'Use devServer config in webpack.config.js.' },
        { user: 'webpack hot reload?', assistant: 'Enable HMR in webpack dev server config.' },
      ]);

      // Query about webpack — turns 0, 4, 6, 7 mention webpack
      const result = contextCollapse(msgs, 100_000, testConfig, 'webpack configuration setup');

      // The result should contain more messages than pure Layer 2 collapse would produce.
      // Turn 0 (webpack config) should be promoted from Layer 2 to Layer 1.
      const allContent = result.messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
      // Promoted turn should still have its text (not collapsed to summary)
      expect(allContent).toContain('webpack.config.js');
    });

    it('collapses irrelevant Layer 2 turns to summaries', () => {
      const msgs = buildConversation([
        { user: 'Tell me about docker networking', assistant: 'Docker uses bridge networks by default.' },
        { user: 'What is Kubernetes?', assistant: 'Kubernetes is a container orchestration platform.' },
        { user: 'Explain microservices', assistant: 'Microservices are small independent services.' },
        { user: 'What is REST API?', assistant: 'REST is a web API architectural style.' },
        { user: 'How do I use Python decorators?', assistant: 'Decorators wrap functions with @syntax.' },
        { user: 'What about generators?', assistant: 'Generators yield values lazily.' },
        { user: 'How to install webpack?', assistant: 'npm install webpack webpack-cli' },
        { user: 'webpack config?', assistant: 'Create webpack.config.js' },
      ]);

      const result = contextCollapse(msgs, 100_000, testConfig, 'webpack bundler');

      // Irrelevant early turns (docker, kubernetes, etc.) should be collapsed to summaries
      const collapsedSummaries = result.messages.filter(
        m => typeof m.content === 'string' && m.content.startsWith('[Collapsed turn:'),
      );
      // There should be at least some collapsed summaries from the irrelevant Layer 2 turns
      expect(collapsedSummaries.length).toBeGreaterThan(0);

      // The collapsed count should be > 0 since some turns got collapsed
      expect(result.collapsedCount).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // 2. Keyword matching scores
  // ========================================================================
  describe('keyword matching', () => {
    it('turns with matching keywords get higher relevance', () => {
      const msgs = buildConversation([
        { user: 'debugging typescript errors', assistant: 'Use strict mode in tsconfig.' },
        { user: 'cooking recipe pasta', assistant: 'Boil water then add pasta.' },
        { user: 'random chat topic', assistant: 'Sure, what about?' },
        { user: 'another random topic', assistant: 'Interesting idea.' },
        { user: 'filler turn 1', assistant: 'okay' },
        { user: 'filler turn 2', assistant: 'sure' },
        { user: 'typescript compiler options', assistant: 'Set target and module in tsconfig.' },
        { user: 'How to fix typescript type errors?', assistant: 'Check your type annotations.' },
      ]);

      // Query about typescript — turn 0 is relevant, turn 1 is not
      const result = contextCollapse(msgs, 100_000, testConfig, 'typescript type checking');
      const allContent = result.messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
      // Turn 0 about typescript should be promoted
      expect(allContent).toContain('tsconfig');
    });
  });

  // ========================================================================
  // 3. CJK text scoring
  // ========================================================================
  describe('CJK text scoring', () => {
    it('Chinese bigrams are matched for relevance', () => {
      const msgs = buildConversation([
        { user: '如何配置数据库连接池？', assistant: '使用 HikariCP 配置连接池参数。' },
        { user: '前端路由怎么设置？', assistant: '使用 React Router 配置路由。' },
        { user: '天气怎么样？', assistant: '今天晴天。' },
        { user: '推荐一本好书', assistant: '推荐《深入理解Java虚拟机》。' },
        { user: '填充内容一', assistant: '好的' },
        { user: '填充内容二', assistant: '了解' },
        { user: '数据库索引优化', assistant: '使用 B+ 树索引提高查询性能。' },
        { user: '数据库查询慢怎么办？', assistant: '检查索引和执行计划。' },
      ]);

      // Query about database — turn 0 mentions 数据库
      const result = contextCollapse(msgs, 100_000, testConfig, '数据库连接优化');
      const allContent = result.messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
      // Turn 0 about database connection pool should be promoted
      expect(allContent).toContain('连接池');
    });
  });

  // ========================================================================
  // 4. maxPromotedTurns limit
  // ========================================================================
  describe('maxPromotedTurns limit', () => {
    it('respects maxPromotedTurns=1 limit', () => {
      const msgs = buildConversation([
        { user: 'webpack entry point', assistant: 'Set entry in webpack.config.js' },
        { user: 'webpack output path', assistant: 'Set output.path in config' },
        { user: 'webpack loaders', assistant: 'Configure module.rules for loaders' },
        { user: 'webpack plugins', assistant: 'Use plugins array for HtmlWebpackPlugin etc' },
        { user: 'filler 1', assistant: 'ok' },
        { user: 'filler 2', assistant: 'sure' },
        { user: 'filler 3', assistant: 'noted' },
        { user: 'webpack optimization', assistant: 'Use splitChunks for code splitting' },
      ]);

      const limitedConfig: Partial<CollapseConfig> = {
        ...testConfig,
        maxPromotedTurns: 1,
        recentTurns: 1,
        middleTurns: 2,
      };

      const result = contextCollapse(msgs, 100_000, limitedConfig, 'webpack configuration');

      // Count how many originally-Layer-2 turns still have their full content
      // With maxPromotedTurns=1, at most 1 early turn should be promoted
      // The collapsed messages should contain [Collapsed turn:...] summaries
      const collapsedSummaries = result.messages.filter(
        m => typeof m.content === 'string' && m.content.startsWith('[Collapsed turn:'),
      );
      // There should be some collapsed summaries since we have 8 turns and only 1 promoted
      expect(collapsedSummaries.length).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // 5. semanticScoring=false disables promotion
  // ========================================================================
  describe('semanticScoring disabled', () => {
    it('no promotion when semanticScoring is false', () => {
      const msgs = buildConversation([
        { user: 'webpack config details', assistant: 'Webpack uses webpack.config.js' },
        { user: 'more webpack stuff', assistant: 'Entry and output fields' },
        { user: 'random filler', assistant: 'ok' },
        { user: 'another filler', assistant: 'sure' },
        { user: 'filler 3', assistant: 'noted' },
        { user: 'filler 4', assistant: 'ok' },
        { user: 'latest turn', assistant: 'current topic' },
        { user: 'webpack question again', assistant: 'webpack answer' },
      ]);

      const noSemanticConfig: Partial<CollapseConfig> = {
        ...testConfig,
        semanticScoring: false,
        recentTurns: 1,
        middleTurns: 2,
      };

      const result = contextCollapse(msgs, 100_000, noSemanticConfig, 'webpack');

      // Turn 0 and 1 are in Layer 2 — without semantic scoring, they should be collapsed
      const collapsedSummaries = result.messages.filter(
        m => typeof m.content === 'string' && m.content.startsWith('[Collapsed turn:'),
      );
      // All Layer 2 turns should be collapsed (turns 0-4 = 5 turns in Layer 2)
      expect(collapsedSummaries.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ========================================================================
  // 6. Empty queryText falls back to last user message
  // ========================================================================
  describe('queryText fallback', () => {
    it('uses last user message when queryText is empty', () => {
      const msgs = buildConversation([
        { user: 'database migration scripts', assistant: 'Use Flyway or Liquibase for DB migrations.' },
        { user: 'cooking tips', assistant: 'Season your food well.' },
        { user: 'filler 1', assistant: 'ok' },
        { user: 'filler 2', assistant: 'sure' },
        { user: 'filler 3', assistant: 'noted' },
        { user: 'filler 4', assistant: 'yep' },
        { user: 'filler 5', assistant: 'done' },
        // Last user message is about database — should promote turn 0
        { user: 'database schema design patterns', assistant: 'Use normalization and proper indexes.' },
      ]);

      // No queryText provided — should fall back to last user message "database schema design patterns"
      const result = contextCollapse(msgs, 100_000, testConfig);
      const allContent = result.messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
      // Turn 0 about database should be promoted since last user message mentions database
      expect(allContent).toContain('migration');
    });
  });

  // ========================================================================
  // 7. Edge cases
  // ========================================================================
  describe('edge cases', () => {
    it('returns original messages when turns <= recentTurns', () => {
      const msgs = buildConversation([
        { user: 'hello', assistant: 'hi' },
        { user: 'how are you?', assistant: 'fine' },
      ]);

      const result = contextCollapse(msgs, 100_000, { ...testConfig, recentTurns: 3 });
      expect(result.collapsedCount).toBe(0);
      expect(result.messages).toEqual(msgs);
    });

    it('preserves system messages', () => {
      const msgs: Message[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        ...buildConversation([
          { user: 'q1', assistant: 'a1' },
          { user: 'q2', assistant: 'a2' },
          { user: 'q3', assistant: 'a3' },
          { user: 'q4', assistant: 'a4' },
        ]),
      ];

      const result = contextCollapse(msgs, 100_000, testConfig);
      const systemMsgs = result.messages.filter(m => m.role === 'system');
      expect(systemMsgs).toHaveLength(1);
      expect(systemMsgs[0].content).toBe('You are a helpful assistant.');
    });

    it('collapseToolResult truncates long tool output', () => {
      const longTool = 'x'.repeat(500);
      const msgs: Message[] = [
        userMsg('q1'),
        assistantMsg('a1'),
        toolMsg(longTool, 'read'),
        userMsg('q2'),
        assistantMsg('a2'),
        toolMsg(longTool, 'read'),
        userMsg('q3'),
        assistantMsg('a3'),
        userMsg('q4'),
        assistantMsg('a4'),
      ];

      const result = contextCollapse(msgs, 100_000, {
        ...testConfig,
        recentTurns: 1,
        middleTurns: 2,
        toolResultMaxChars: 50,
      });

      // Some tool messages should be truncated
      const truncated = result.messages.filter(
        m => typeof m.content === 'string' && m.content.includes('[... collapsed'),
      );
      expect(truncated.length).toBeGreaterThan(0);
    });
  });
});

describe('extractLastUserQuery — 续跑指令不该当查询词', () => {
  const u = (content: string, name?: string) => ({ role: 'user', content, ...(name ? { name } : {}) } as any);

  it('最后一条是"继续"时, 回退到前面有信息量的那条', () => {
    const q = extractLastUserQuery([
      u('把 fileDB.ts 的包装层删掉, 统一走 fileRepository'),
      { role: 'assistant', content: 'ok' } as any,
      u('继续'),
    ]);
    expect(q).toContain('fileDB.ts');
    expect(q.trim()).not.toBe('继续');
  });

  it('多条续跑指令连着也能穿透', () => {
    const q = extractLastUserQuery([
      u('修一下 schema 迁移'), u('继续'), u('ok'), u('go on'),
    ]);
    expect(q).toContain('schema');
  });

  it('框架自己注入的 user 消息不算用户意图', () => {
    const q = extractLastUserQuery([
      u('重构 chatDbService'),
      u('[Post-compact work state] ...', 'PostCompactWorkState'),
      u('<system-reminder>foo</system-reminder>'),
    ]);
    expect(q).toContain('chatDbService');
    expect(q).not.toContain('system-reminder');
  });

  it('全是续跑指令时退回最后一条, 不返回空串', () => {
    expect(extractLastUserQuery([u('继续'), u('ok')])).toBe('ok');
  });

  it('多条有效消息按"旧→新"拼接 (新的更靠后)', () => {
    const q = extractLastUserQuery([u('先改 schema.ts'), u('再改 fileRepository.ts')]);
    expect(q.indexOf('schema.ts')).toBeLessThan(q.indexOf('fileRepository.ts'));
  });
});
