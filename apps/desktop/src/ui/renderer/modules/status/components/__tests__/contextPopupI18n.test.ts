
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ContextDetailPopup.tsx'),
  'utf8',
);

describe('上下文详情面板 i18n', () => {
  test('接了语言开关 (L 助手 + getGlobalLanguage)', () => {
    expect(SRC).toMatch(/getGlobalLanguage/);
    expect(SRC).toMatch(/const L = \(zh: string, en: string\)/);
  });

  test('JSX 文本节点里不许再有裸英文', () => {
    /* >Used< 这种。允许纯符号/数字, 以及 {L(...)} 包过的 */
    const bare = [...SRC.matchAll(/>\s*([A-Za-z][A-Za-z ()]{2,40})\s*</g)].map((m) => m[1].trim());
    expect(bare, `这些 JSX 文本还是英文: ${bare.join(' | ')}`).toEqual([]);
  });

  test('关键指标都给了中文', () => {
    for (const zh of ['剩余', '距自动压缩', '缓存读取', '缓存写入',
                      '系统提示词', '工具定义', '缓存命中', '输出速度', '首字延迟']) {
      /* L('…') 或 L(`…${n}`) 两种写法都算 */
      expect(SRC, `缺中文: ${zh}`).toMatch(new RegExp(`L\\(['\`]${zh}`));
    }
  });

  test('两个 tab 也翻了 —— 它们独立成行, 最容易被漏', () => {
    expect(SRC).toMatch(/L\('本次请求', 'Request'\)/);
    expect(SRC).toMatch(/L\('会话累计', 'Session'\)/);
  });

  test('英文原文保留在 L 的第二参 —— 英文用户不能被塞中文', () => {
    expect(SRC).toMatch(/L\('输出速度', 'Output speed'\)/);
    expect(SRC).toMatch(/L\('缓存读取', 'Cache read'\)/);
  });
});
