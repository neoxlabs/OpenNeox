import { describe, expect, test } from 'vitest';
import { normalizeMath } from '../normalizeMath';

describe('normalizeMath', () => {
  test('像公式的单 $ 转成行内 $$, 公式里的 % 补转义', () => {
    expect(normalizeMath('总盐 $90\\times40%+60\\times20%=48$ 千克'))
      .toBe('总盐 $$90\\times40\\%+60\\times20\\%=48$$ 千克');
    expect(normalizeMath('分母 $(60+X)$ 漏了')).toBe('分母 $$(60+X)$$ 漏了');
    expect(normalizeMath('转移 $|c_1-c_2|$。')).toBe('转移 $$|c_1-c_2|$$。');
    expect(normalizeMath('所以 $X$ 是')).toBe('所以 $$X$$ 是');
    expect(normalizeMath('最小值 $-4$（x=3）')).toBe('最小值 $$-4$$（x=3）');
    expect(normalizeMath('最小值 $-8$（$x=5$）')).toBe('最小值 $$-8$$（$$x=5$$）');
  });

  test('金额原样保留', () => {
    const cases = [
      'FLAT50 = 固定 $50, FREESHIP = 固定 $12',
      'costs $5 to $10',
      'range $5-$10 total',
      'pay $1,200, then $300',
      '价格 $ 50 和 $ 60',
    ];
    for (const c of cases) expect(normalizeMath(c)).toBe(c);
  });

  test('中文不进公式', () => {
    expect(normalizeMath('先付 $3 再付 5$ 结束')).toBe('先付 $3 再付 5$ 结束');
  });

  test('单独一行的 $$…$$ 变成块级, 不再挤在段落里', () => {
    const src = '正确的列法:\n$$\\frac{36-0.2X}{90}=\\frac{12+0.2X}{60}$$\n交叉相乘:';
    expect(normalizeMath(src)).toBe(
      '正确的列法:\n\n$$\n\\frac{36-0.2X}{90}=\\frac{12+0.2X}{60}\n$$\n\n交叉相乘:',
    );
  });

  test('\\[…\\] 与 \\(…\\)', () => {
    expect(normalizeMath('\\[a^2+b^2\\]')).toBe('$$\na^2+b^2\n$$\n');
    expect(normalizeMath('令 \\(x=1\\) 则')).toBe('令 $$x=1$$ 则');
  });

  test('多行块: 内容保留, % 补转义', () => {
    expect(normalizeMath('$$\n40% \\times 2\n$$')).toBe('$$\n40\\% \\times 2\n$$\n');
  });

  test('流式中途未闭合的块原样放回', () => {
    expect(normalizeMath('前文\n$$\n\\frac{1}{2')).toBe('前文\n$$\n\\frac{1}{2');
  });

  test('代码不动', () => {
    const fenced = '```sh\necho $HOME$PATH $(x+1)$\n```';
    expect(normalizeMath(fenced)).toBe(fenced);
    expect(normalizeMath('用 `$(a+b)$` 写')).toBe('用 `$(a+b)$` 写');
  });

  test('列表项里的块级公式保留缩进', () => {
    expect(normalizeMath('- 步骤\n  $$x=1$$')).toBe('- 步骤\n\n  $$\n  x=1\n  $$\n');
  });

  test('转义的 \\$ 不当公式边界', () => {
    expect(normalizeMath('\\$5 和 \\$(x)$')).toBe('\\$5 和 \\$(x)$');
  });
});
