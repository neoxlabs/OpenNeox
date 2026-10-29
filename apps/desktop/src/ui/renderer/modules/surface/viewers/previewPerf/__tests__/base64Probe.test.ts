import { describe, expect, it } from 'vitest';
import { base64Mentions, base64NeedleTokens } from '../base64Probe';

const NEEDLE = 'xl/charts/chart';

function b64(binary: string): string {
  return Buffer.from(binary, 'binary').toString('base64');
}

describe('base64Mentions', () => {
  it('能在 3 种字节对齐下都找到目标串', () => {
    for (let pad = 0; pad < 3; pad++) {
      const binary = 'Z'.repeat(pad) + 'PK' + NEEDLE + 'tail';
      expect(base64Mentions(b64(binary), NEEDLE)).toBe(true);
    }
  });

  it('目标串出现在文件中间也能找到', () => {
    const binary = 'A'.repeat(1000) + NEEDLE + 'B'.repeat(1000);
    expect(base64Mentions(b64(binary), NEEDLE)).toBe(true);
  });

  it('不存在时不误报', () => {
    expect(base64Mentions(b64('PK\x03\x04 nothing to see here xl/charts/'), NEEDLE)).toBe(false);
    expect(base64Mentions(b64('xl/charts/cha'), NEEDLE)).toBe(false);
  });

  it('空输入返回 false', () => {
    expect(base64Mentions('', NEEDLE)).toBe(false);
    expect(base64Mentions('AAAA', '')).toBe(false);
    expect(base64Mentions('AAAA', 'ab')).toBe(false);
  });

  it('token 都对齐到 4 字符组, 且覆盖目标串主体', () => {
    const tokens = base64NeedleTokens(NEEDLE);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token.length % 4).toBe(0);
      /* shift=0 的 token 应包含整段 needle 的编码 */
      expect(Buffer.from(token, 'base64').toString('binary').length).toBeGreaterThanOrEqual(12);
    }
  });
});
