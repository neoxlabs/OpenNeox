
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sourceIdentity,
  hasMeaningfulSource,
  aliasSurfaceId,
  resolveSurfaceId,
  dropAliasesTo,
  surfaceKindForPath,
  isPersistentSurfaceKind,
  surfaceHasInternalTabs,
} from '../surfaceStore';
import type { Surface } from '../surfaceStore';

const fileSurface = (path: string): Surface => ({
  source: { type: 'file', path },
} as unknown as Surface);

describe('sourceIdentity · 插件面板按地址认身份', () => {
  const pluginSurface = (url: string): Surface => ({ kind: 'plugin', source: { type: 'url', url } } as unknown as Surface);

  it('同一个面板地址 → 同一身份 (再点一次回到原 tab, 不多开)', () => {
    expect(sourceIdentity(pluginSurface('neox-plugin://agent-hub/view/index.html')))
      .toBe(sourceIdentity(pluginSurface('neox-plugin://agent-hub/view/index.html')));
  });

  it('不同插件 / 不同面板 → 不同身份', () => {
    expect(sourceIdentity(pluginSurface('neox-plugin://agent-hub/view/index.html')))
      .not.toBe(sourceIdentity(pluginSurface('neox-plugin://other/view/index.html')));
  });

  it('普通 url surface 仍然没有身份 (网页每次都是新的一份)', () => {
    expect(sourceIdentity({ kind: 'html', source: { type: 'url', url: 'https://x.test' } } as unknown as Surface)).toBeNull();
  });
});

describe('sourceIdentity · 同一文件必须判成同一身份', () => {
  it('相同路径 → 相同身份', () => {
    expect(sourceIdentity(fileSurface('/w/a.md'))).toBe(sourceIdentity(fileSurface('/w/a.md')));
  });

  it('斜杠方向不同 → 仍是同一身份 (Windows 的主要来源)', () => {
    expect(sourceIdentity(fileSurface('C:\\w\\a.md')))
      .toBe(sourceIdentity(fileSurface('C:/w/a.md')));
  });

  it('`..` 归一后 → 同一身份', () => {
    expect(sourceIdentity(fileSurface('/w/docs/../docs/a.md')))
      .toBe(sourceIdentity(fileSurface('/w/docs/a.md')));
  });

  it('重复斜杠 → 同一身份', () => {
    expect(sourceIdentity(fileSurface('/w//docs///a.md')))
      .toBe(sourceIdentity(fileSurface('/w/docs/a.md')));
  });

  it('不同文件 → 不同身份', () => {
    expect(sourceIdentity(fileSurface('/w/a.md'))).not.toBe(sourceIdentity(fileSurface('/w/b.md')));
  });

  it('非文件源没有稳定身份 (inline / url 每次都是新的一份)', () => {
    expect(sourceIdentity({ source: { type: 'inline', content: 'x' } } as any)).toBeNull();
    expect(sourceIdentity({ source: { type: 'url', url: 'https://a' } } as any)).toBeNull();
    expect(sourceIdentity({} as any)).toBeNull();
  });

  it('空路径不产生身份 —— 否则所有空 surface 会互相合并', () => {
    expect(sourceIdentity(fileSurface(''))).toBeNull();
  });
});

describe('hasMeaningfulSource · 挡住空占位覆盖已有内容', () => {
  it('文件源一律算有内容', () => {
    expect(hasMeaningfulSource(fileSurface('/a.md'))).toBe(true);
  });

  it('inline 有非空正文才算', () => {
    expect(hasMeaningfulSource({ source: { type: 'inline', content: 'hi' } } as any)).toBe(true);
    expect(hasMeaningfulSource({ source: { type: 'inline', content: '   ' } } as any)).toBe(false);
    expect(hasMeaningfulSource({ source: { type: 'inline', content: '' } } as any)).toBe(false);
  });

  it('没有 source 不算', () => {
    expect(hasMeaningfulSource({} as any)).toBe(false);
  });
});

describe('surface id 别名表 · 合并后旧 id 仍要能落地', () => {
  const S = 'sess-1';
  beforeEach(() => {
    /* 每个用例自己清干净, 别互相串 */
    for (const id of ['a', 'b', 'c', 'd']) dropAliasesTo(S, id);
  });

  it('未登记的 id 原样返回', () => {
    expect(resolveSurfaceId(S, 'unknown')).toBe('unknown');
  });

  it('登记后旧 id 解析到新 id', () => {
    aliasSurfaceId(S, 'a', 'b');
    expect(resolveSurfaceId(S, 'a')).toBe('b');
  });

  it('别名链被压平 —— 查表永远只走一跳', () => {
    aliasSurfaceId(S, 'a', 'b');
    aliasSurfaceId(S, 'b', 'c');
    /* a 原本指向 b, b 又并进 c ⇒ a 必须直接指 c, 不能还停在 b */
    expect(resolveSurfaceId(S, 'a')).toBe('c');
    expect(resolveSurfaceId(S, 'b')).toBe('c');
  });

  it('三级合并后所有旧 id 都指向最终承载者', () => {
    aliasSurfaceId(S, 'a', 'b');
    aliasSurfaceId(S, 'b', 'c');
    aliasSurfaceId(S, 'c', 'd');
    for (const old of ['a', 'b', 'c']) expect(resolveSurfaceId(S, old)).toBe('d');
  });

  it('自指 / 空值不入表', () => {
    aliasSurfaceId(S, 'a', 'a');
    aliasSurfaceId(S, '', 'b');
    aliasSurfaceId(S, 'a', '');
    expect(resolveSurfaceId(S, 'a')).toBe('a');
  });

  it('会话之间互不串味', () => {
    aliasSurfaceId('s1', 'a', 'b');
    expect(resolveSurfaceId('s2', 'a')).toBe('a');
    dropAliasesTo('s1', 'b');
  });

  it('surface 真被关掉时指向它的别名一起清 —— 否则表只涨不落', () => {
    aliasSurfaceId(S, 'a', 'b');
    aliasSurfaceId(S, 'c', 'b');
    dropAliasesTo(S, 'b');
    expect(resolveSurfaceId(S, 'a')).toBe('a');
    expect(resolveSurfaceId(S, 'c')).toBe('c');
  });
});

describe('surfaceKindForPath · 扩展名 → surface 类型', () => {
  it('常见文档类型', () => {
    expect(surfaceKindForPath('/a/b.pdf')).toBe('pdf');
    expect(surfaceKindForPath('/a/b.docx')).toBe('docx');
    expect(surfaceKindForPath('/a/b.xlsx')).toBe('sheet');
    expect(surfaceKindForPath('/a/b.csv')).toBe('sheet');
    expect(surfaceKindForPath('/a/b.png')).toBe('image');
  });

  it('PowerPoint 全家族都落 pptx', () => {
    for (const ext of ['pptx', 'ppt', 'pptm', 'pps', 'ppsx', 'ppsm', 'potx', 'potm', 'odp']) {
      expect(surfaceKindForPath(`/a/deck.${ext}`), ext).toBe('pptx');
    }
  });

  it('大小写不敏感', () => {
    expect(surfaceKindForPath('/a/B.PDF')).toBe('pdf');
    expect(surfaceKindForPath('/a/B.PNG')).toBe('image');
  });

  it('未知扩展名 / 无扩展名一律当代码', () => {
    expect(surfaceKindForPath('/a/b.rs')).toBe('code');
    expect(surfaceKindForPath('/a/Makefile')).toBe('code');
    expect(surfaceKindForPath('')).toBe('code');
  });
});

describe('合并策略表派生的两个谓词 · 唯一真相是那张表', () => {
  it('持久化 kind 从表的 persistent 字段派生', () => {
    expect(isPersistentSurfaceKind('git')).toBe(true);
    expect(isPersistentSurfaceKind('plan')).toBe(false);
    expect(isPersistentSurfaceKind('不存在的kind')).toBe(false);
  });

  it('自带内部 tab 条 = mode 为 host-tabs', () => {
    /* SurfacePanel 靠它决定渲不渲染 chrome bar —— 新增 host-tabs kind 时
     * 不该再去 SurfacePanel 补第二份名单 */
    expect(surfaceHasInternalTabs('git')).toBe(false);
    expect(surfaceHasInternalTabs('不存在的kind')).toBe(false);
  });
});
