import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'TimelineComposer.tsx');

const MODULE_SCOPE_SYMBOLS = [
  'BURN_LEVELS',
  'burnLevelOf',
  'burnLevelLabel',
  'burnPercent',
  'ModelBurnBar',
  'CapChip',
];

describe('消耗条 / 能力 chip 的定义必须在模块作用域', () => {
  const src = readFileSync(SRC, 'utf8');

  for (const name of MODULE_SCOPE_SYMBOLS) {
    it(`${name} 定义在模块顶层 (不缩进)`, () => {
      /* 行首无空白 + const/function <name> —— 缩进就说明它被嵌进了某个函数体 */
      const topLevel = new RegExp(`^(const|function)\\s+${name}\\b`, 'm');
      const anywhere = new RegExp(`(const|function)\\s+${name}\\b`);

      expect(anywhere.test(src), `${name} 根本不存在 — 断言写错了或符号被改名`).toBe(true);
      expect(
        topLevel.test(src),
        `${name} 的定义有缩进 = 被嵌进了某个组件体内。` +
          `这类错误 tsc 抓不到 (对所在组件仍然可见), 只有别的组件调用它时才运行时崩溃。`,
      ).toBe(true);
    });
  }
});
