import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stripRuntimeInjectedMarkers } from '../runtimeInjectedMarkers';

const HERE = dirname(fileURLToPath(import.meta.url));
/* HERE = src/ui/shared/__tests__ → 上两级是 src/ui */
const SRC_ROOT = resolve(HERE, '../..');

describe('运行时注入标记', () => {
  it('剥掉标记, 并收掉它留下的行尾空白', () => {
    expect(stripRuntimeInjectedMarkers('如何益生菌 <current-time>2026-09-04 周五 09:00</current-time>'))
      .toBe('如何益生菌');
    expect(stripRuntimeInjectedMarkers('a\nb <current-time>x</current-time>\nc')).toBe('a\nb\nc');
  });

  it('跨行的标记也剥得掉', () => {
    expect(stripRuntimeInjectedMarkers('q<current-time>\n2026\n</current-time>')).toBe('q');
  });

  it('没有标记时原样返回, 不动用户自己写的尖括号', () => {
    expect(stripRuntimeInjectedMarkers('a<b>c</b>')).toBe('a<b>c</b>');
    expect(stripRuntimeInjectedMarkers('讲讲 <current-time 这个标记')).toBe('讲讲 <current-time 这个标记');
  });

  it('非字符串原样返回 —— 调用点常常直接喂 item.content, 它可能是 undefined', () => {
    expect(stripRuntimeInjectedMarkers(undefined)).toBe(undefined);
    expect(stripRuntimeInjectedMarkers(null)).toBe(null);
    const o = { a: 1 };
    expect(stripRuntimeInjectedMarkers(o)).toBe(o);
  });

  it('全仓只许这一个文件手写 <current-time> 的剥离正则', () => {
    /* 换个地方再手抄一遍, 下次加标记时那处必漏 —— 这正是这个 bug 出现三次的方式。 */
    const files = [
      'renderer/pages/settings/tabs/MemoryTab.tsx',
      'shared/sessionSearch.ts',
      'electron/mobile-bridge/wsServer.ts',
    ];
    for (const f of files) {
      const src = readFileSync(resolve(SRC_ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')       /* 注释里会**引用**这个正则说明来历 */
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      expect(src, `${f} 里又手写了一遍剥离正则, 应该 import stripRuntimeInjectedMarkers`)
        .not.toMatch(/<current-time>\[\\s\\S\]/);
      expect(src, `${f} 没在用公共剥离函数`).toMatch(/stripRuntimeInjectedMarkers/);
    }
  });
});
