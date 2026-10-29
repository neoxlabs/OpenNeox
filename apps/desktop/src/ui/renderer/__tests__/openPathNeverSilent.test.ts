import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const bridge = strip(readFileSync(resolve(HERE, '../app/NeoxRuntimeBridge.tsx'), 'utf8'));
const markdown = strip(readFileSync(resolve(HERE, '../components/Markdown.tsx'), 'utf8'));

/** 只取 neox:open-path 那个 handler 的正文 */
function openPathHandler(): string {
  const end = bridge.indexOf("window.addEventListener('neox:open-path'");
  expect(end, '找不到 neox:open-path 监听').toBeGreaterThan(-1);
  const start = bridge.lastIndexOf('const handler = (e: Event) =>', end);
  expect(start, '找不到 handler 起点').toBeGreaterThan(-1);
  return bridge.slice(start, end);
}

describe('点路径打不开时必须给反馈', () => {
  it('有一个统一的"打不开就说话"兜底函数', () => {
    expect(bridge).toMatch(/const openExternalOrTell = async \(target: string\)/);
    expect(bridge).toMatch(/dispatchHint\(\s*bi\(`打不开 \$\{shown\}/);
  });

  it('中英文都要有 —— 英文半边不许残留中文', () => {
    const m = /bi\(`打不开 \$\{shown\}[^`]*`, `([^`]*)`\)/.exec(bridge);
    expect(m, '找不到双语提示').toBeTruthy();
    expect(m![1]).not.toMatch(/[一-龥]/);
  });

  /* 三条路: 文件不存在 / Surface 不支持该扩展名 / 动态 import 失败 —— 一条都不许静默 */
  it('三条 fallback 全部走它, 不许再出现吞掉失败的空 catch', () => {
    const h = openPathHandler();
    const calls = h.match(/openExternalOrTell\(/g) ?? [];
    expect(calls.length, `只找到 ${calls.length} 处调用`).toBeGreaterThanOrEqual(3);
    expect(h).not.toMatch(/surfaceOpenExternal\([^)]*\)\.catch\(\(\) => \{\s*\}\)/);
  });

  it('判"打开成功"必须看 result.success, 不能只看 promise 有没有 resolve', () => {
    expect(bridge).toMatch(/surfaceOpenExternal\(target\)[\s\S]{0,120}r\?\.success === true/);
    expect(bridge).not.toMatch(/surfaceOpenExternal\([^)]*\)\s*\.then\(\(\) => true\)/);
  });

  it('路径太长要截断显示 —— 不能把一整行绝对路径糊进 toast', () => {
    expect(bridge).toMatch(/target\.length > 48/);
  });

  it('可点的判据仍是 isPreviewablePath, 且给了 pointer + 提示', () => {
    expect(markdown).toMatch(/isPreviewablePath\(rawText\)/);
    expect(markdown).toMatch(/md-inline-code--clickable/);
    expect(markdown).toMatch(/title=\{mdZh \? `点击打开: \$\{rawText\}` : `Open: \$\{rawText\}`\}/);
  });
});

describe('没有 sessionId 也不许静默', () => {
  const h = openPathHandler();

  it('不再有 `if (!sessionId) return;` 这种不出声的早退', () => {
    expect(h).not.toMatch(/if \(!sessionId\)\s*return;/);
  });

  it('没有会话时走系统默认打开, 打不开再出声', () => {
    expect(h).toMatch(/if \(!sessionId\) \{[\s\S]{0,200}openExternalOrTell/);
  });

  it('handler 里只剩一处"什么都不做就走人", 且是 !path', () => {
    const bail = (h.match(/\n\s*if \((![A-Za-z_$][\w.$]*)\)\s*return;/g) ?? [])
      .map((x) => x.trim());
    expect(bail.length, `还有 ${bail.length} 处静默早退: ${bail.join(' | ')}`).toBeLessThanOrEqual(1);
    if (bail.length) expect(bail[0]).toMatch(/!path/);
  });
});
