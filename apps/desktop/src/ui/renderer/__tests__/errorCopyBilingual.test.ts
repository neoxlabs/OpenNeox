import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* 注释里出现中文是正常的 —— 这个仓库的注释本来就是中文写的。
   不先剥掉注释, 这个闸会被自己的说明文字判红 (制造假红的经典方式)。 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const FILES: Array<[string, string]> = [
  ['useStreamHandler.ts', '../pages/workspace/hooks/useStreamHandler.ts'],
  ['NeoxRuntimeBridge.tsx', '../app/NeoxRuntimeBridge.tsx'],
];

const CJK = /[一-龥]/;
const FIELD = /\b(title|message|suggestion|errorMessage)\s*:\s*['"`]/;

function bareChineseCopy(src: string): string[] {
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    const m = FIELD.exec(line);
    if (!m) return;
    const after = line.slice(m.index);
    /* bi() = 本文件的双语出口; statusT/t. = 走 translations 表。都算已翻译。 */
    if (after.includes('bi(') || after.includes('statusT(') || after.includes('t.')) return;
    if (CJK.test(after)) out.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  return out;
}

describe('用户可见的错误文案必须双语', () => {
  for (const [name, rel] of FILES) {
    it(`${name} 里没有裸中文的 title / message / suggestion / errorMessage`, () => {
      const src = strip(readFileSync(resolve(HERE, rel), 'utf8'));
      const bare = bareChineseCopy(src);
      expect(bare, `这些文案只有中文, 英文界面下会原样露出来 —— 包进 bi(zh, en):\n  ${bare.join('\n  ')}`)
        .toEqual([]);
    });
  }

  /* 对照组: 闸本身能亮红。否则上面两条永远绿, 等于没有闸。 */
  it('闸能抓到裸中文 (自检)', () => {
    expect(bareChineseCopy(`  title: '连接已恢复',`)).toHaveLength(1);
    expect(bareChineseCopy(`  title: bi('连接已恢复', 'Reconnected'),`)).toHaveLength(0);
    expect(bareChineseCopy(`  title: 'Reconnected',`)).toHaveLength(0);
    /* 注释里的中文不算 */
    expect(bareChineseCopy(strip(`  /* title: '连接已恢复' */`))).toHaveLength(0);
  });
});
