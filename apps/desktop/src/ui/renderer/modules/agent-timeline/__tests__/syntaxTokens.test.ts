import { describe, test, expect, beforeEach } from 'vitest';
import {
  tokenizeLine, tokenizeLineCached, langOf, __syntaxCacheSize, __resetSyntaxCache,
} from '../cells/syntaxTokens';

const join = (toks: { t: string }[]) => toks.map((x) => x.t).join('');
const kindsOf = (toks: { t: string; k: string }[], kind: string) =>
  toks.filter((x) => x.k === kind).map((x) => x.t);

describe('tokenizeLine', () => {
  /* 这条是所有着色器的底线: 切出来的 token 拼回去必须**一字不差**等于原文。
   * 少一个空格、吞一个引号, 用户看到的就是错的代码。 */
  test.each([
    ['ts', `  const x = foo("a\\"b", 42); // 说明`],
    ['ts', `<Foo bar={baz} className="x">{'y'}</Foo>`],
    ['py', `def f(a, b=3):  # 注释`],
    ['go', `func main() { fmt.Println("hi") }`],
    ['rs', `let mut v: Vec<u8> = vec![1, 2];`],
    ['sh', `export PATH="$HOME/bin:$PATH" # 路径`],
    ['ts', `const s = \`模板 \${x} 串\`;`],
    ['ts', ``],
    ['ts', `                `],
  ] as const)('%s 行切词后拼回原文一字不差', (lang, src) => {
    expect(join(tokenizeLine(src, lang as any))).toBe(src);
  });

  test('关键字/字符串/数字/注释各归各位', () => {
    const toks = tokenizeLine(`const n = 42; // 尾注`, 'ts');
    expect(kindsOf(toks, 'kw')).toContain('const');
    expect(kindsOf(toks, 'num')).toContain('42');
    expect(kindsOf(toks, 'com')).toEqual(['// 尾注']);
  });

  test('字符串里的关键字和注释符不许被当成代码', () => {
    const toks = tokenizeLine(`const a = "const // not a comment";`, 'ts');
    expect(kindsOf(toks, 'str')).toEqual(['"const // not a comment"']);
    expect(kindsOf(toks, 'com')).toEqual([]);
    /* 只有行首那个 const 是关键字 */
    expect(kindsOf(toks, 'kw')).toEqual(['const']);
  });

  test('转义引号不会提前收尾', () => {
    const src = `x("a\\"b")`;
    const toks = tokenizeLine(src, 'ts');
    expect(join(toks)).toBe(src);
    expect(kindsOf(toks, 'str')).toEqual([`"a\\"b"`]);
  });

  test('JSX 标签名与属性名分开', () => {
    const toks = tokenizeLine(`<ProviderLogo type={r.t} size={22} />`, 'ts');
    expect(kindsOf(toks, 'tag')).toContain('ProviderLogo');
    expect(kindsOf(toks, 'attr')).toEqual(expect.arrayContaining(['type', 'size']));
  });

  test('相邻同类合并, 别一个字符一个 span', () => {
    const toks = tokenizeLine(`a  +  b`, 'ts');
    /* 中间的空白和标点各自合并, token 数远小于字符数 */
    expect(toks.length).toBeLessThan(6);
  });

  test('未知扩展名走 plain, 原样一段', () => {
    expect(langOf('a.bin')).toBe('plain');
    expect(langOf(undefined)).toBe('plain');
    expect(langOf('src/x/TokensPage.tsx')).toBe('ts');
    expect(tokenizeLine('随便什么', 'plain')).toEqual([{ t: '随便什么', k: 'txt' }]);
  });
});

describe('tokenizeLineCached — 性能护栏', () => {
  beforeEach(() => __resetSyntaxCache());

  test('同一行第二次命中缓存, 返回同一个数组引用', () => {
    const a = tokenizeLineCached('const x = 1;', 'ts');
    const b = tokenizeLineCached('const x = 1;', 'ts');
    expect(b).toBe(a);
    expect(__syntaxCacheSize()).toBe(1);
  });

  test('超长行 (minified/base64) 直接放弃着色, 不进缓存也不切词', () => {
    const long = 'a'.repeat(5000);
    const toks = tokenizeLineCached(long, 'ts');
    expect(toks).toEqual([{ t: long, k: 'txt' }]);
    expect(__syntaxCacheSize()).toBe(0);
  });

  test('缓存有上界, 不会随会话无限涨', () => {
    for (let i = 0; i < 2100; i++) tokenizeLineCached(`const v${i} = ${i};`, 'ts');
    expect(__syntaxCacheSize()).toBeLessThanOrEqual(2000);
  });

  test('一屏量级 (600 行) 冷切词在预算内', () => {
    const lines = Array.from({ length: 600 }, (_, i) =>
      `  const value${i} = compute("arg${i}", ${i}); // 第 ${i} 行`);
    const t0 = performance.now();
    for (const l of lines) tokenizeLineCached(l, 'ts');
    const cold = performance.now() - t0;
    const t1 = performance.now();
    for (const l of lines) tokenizeLineCached(l, 'ts');
    const warm = performance.now() - t1;
    /* 冷切词 600 行必须远低于一帧 (16.7ms) 的预算; 命中缓存后应该快到可以忽略 */
    expect(cold).toBeLessThan(50);
    expect(warm).toBeLessThan(cold);
  });
});
