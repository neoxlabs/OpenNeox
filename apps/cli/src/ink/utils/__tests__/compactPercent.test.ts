import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../i18n/index.js', () => ({ getLanguage: () => 'zh' }));

import { buildCompactCardText, buildCompactStatusLine, parseCompactPercent } from '../compactProgress.js';

describe('一次请求摘要的百分比进度', () => {
  it('卡片: 进度条按百分比填格, 带已写 token, 不出 n/m', () => {
    const text = buildCompactCardText('⚡ 生成摘要 40%', '↓ 1.2K tokens');
    expect(text).toMatch(/^\[(▰|#){4}(▱|\.){6}\] 40% ↓1\.2K tokens 生成摘要$/);
  });

  it('状态行同一份进度', () => {
    expect(buildCompactStatusLine('⚡ 生成摘要 75%', '↓ 2.0K tokens')).toMatch(/^压缩 \[.{10}\] 75% ↓2\.0K tokens 生成摘要…$/);
  });

  it('分组摘要照旧数组', () => {
    expect(parseCompactPercent('⚡ 生成摘要 2/5 组', 'model x')).toBeNull();
    expect(buildCompactCardText('⚡ 生成摘要 2/5 组', 'model x')).toMatch(/40% 2\/5 生成摘要/);
  });
});
