/**
 * A content search with no matches may retry by file name.
 *
 * The retry trigger stays conservative so content queries are not redirected accidentally.
 *
 * A false positive is worse than an extra search attempt, so the predicate remains narrow.
 */
import { describe, test, expect } from 'vitest';
import { looksLikePathQuery, looksLikeProseQuery, worthFilenameRetry } from '../queryUtils.js';

describe('looksLikePathQuery', () => {
  test('★ 典型的"我在找这个文件"', () => {
    for (const q of [
      'runtimeSearchTool.ts',
      'src/tools/search',
      'packages/core/src/server/main.ts',
      'AgentTimelineView.tsx',
      '*Controller*',
      'useStreamHandler.ts',
      'config.yaml',
      'Makefile.py',
    ]) {
      expect(looksLikePathQuery(q), q).toBe(true);
    }
  });

  test('★ 内容查询绝不能被误判 (误判比漏判更坏)', () => {
    for (const q of [
      'ALWAYS_ACTIVE_TOOLS',
      'injectUserMessage',
      'const foo = 1',
      '会话归属',
      'compaction threshold',
      'TODO',
      'sessionId',
      '',
      '   ',
    ]) {
      expect(looksLikePathQuery(q), q).toBe(false);
    }
  });

  test('带空格的交给自然语言那条降级, 不抢', () => {
    expect(looksLikePathQuery('src/tools 搜索')).toBe(false);
    expect(looksLikePathQuery('main.ts 在哪')).toBe(false);
  });

  test('两条降级判据不重叠 —— 同一个 query 不会同时命中', () => {
    for (const q of ['runtimeSearchTool.ts', 'src/tools/search', '*Controller*']) {
      expect(looksLikePathQuery(q) && looksLikeProseQuery(q), q).toBe(false);
    }
    for (const q of ['compaction threshold', '日志目录清理']) {
      expect(looksLikePathQuery(q), q).toBe(false);
    }
  });
});

describe('worthFilenameRetry (内容零命中后要不要按文件名再试)', () => {
  test('★ 裸名字也要接住 —— 真机实测 agent 搜的往往是去掉扩展名的主干', () => {
    /* Bare file names without an extension or slash are also candidates after
     * content search returns no matches. */
    for (const q of ['zzProbe333812', 'pendingSweep', 'AgentTimelineView', 'runtimeSearchTool.ts', 'src/tools/search']) {
      expect(worthFilenameRetry(q), q).toBe(true);
    }
  });

  test('带空格交给自然语言降级, 显式正则尊重原意, 太短的不折腾', () => {
    for (const q of ['compaction threshold', '日志目录清理 的位置', 'foo|bar', '^main$', 'ab', '']) {
      expect(worthFilenameRetry(q), q).toBe(false);
    }
  });

  test('放宽是安全的 —— 触发前提是内容已经零命中, 再试一次没有东西可损失', () => {
    /* 这条不测行为, 只把设计意图钉在测试里: 判据宽窄的代价是不对称的。 */
    expect(worthFilenameRetry('ALWAYS_ACTIVE_TOOLS')).toBe(true);
  });
});
