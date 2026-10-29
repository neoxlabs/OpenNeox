
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';

/* 仓库的 vitest environment 是 'node', 且没装 jsdom/happy-dom。
 * 被测函数只读 document.documentElement 的一个属性 —— 手搓最小 stub 即可,
 * 不为一个属性引一整个 DOM 实现 (那会扩大构建面)。 */
const attrs = new Map<string, string>();
const stubDoc = {
  documentElement: {
    getAttribute: (k: string) => (attrs.has(k) ? attrs.get(k)! : null),
    setAttribute: (k: string, v: string) => { attrs.set(k, v); },
    removeAttribute: (k: string) => { attrs.delete(k); },
  },
};
/* defineNeoxEditorTheme 在 typeof window === 'undefined' 时会短路成 'vs'/'vs-dark',
 * 那条分支绕开了 defineTheme —— 要测真实路径必须同时有 window。 */
const hadDoc = 'document' in globalThis;
const hadWin = 'window' in globalThis;
beforeAll(() => {
  if (!hadDoc) (globalThis as any).document = stubDoc;
  if (!hadWin) (globalThis as any).window = { document: stubDoc };
});
afterAll(() => {
  if (!hadDoc) delete (globalThis as any).document;
  if (!hadWin) delete (globalThis as any).window;
});

const { resolveThemeOption } = await import('../factory');
const { resolveDocumentIsDark } = await import('../theme');

/** 假引擎: defineNeoxEditorTheme 会调 editor.defineTheme, 这里只记录并回名字 */
function fakeEngine() {
  const defined: Array<{ name: string }> = [];
  return {
    defined,
    editor: {
      defineTheme: (name: string) => { defined.push({ name }); },
      setTheme: () => {},
    },
  };
}

const setDocTheme = (v: string | null) => {
  const d: any = (globalThis as any).document;
  if (v === null) d.documentElement.removeAttribute('data-theme');
  else d.documentElement.setAttribute('data-theme', v);
};

afterEach(() => setDocTheme(null));

describe('resolveThemeOption · 无头场景绝不碰全局主题', () => {
  it('applyTheme:false → 返回空对象, 不含 theme 字段', () => {
    const out = resolveThemeOption(fakeEngine(), { applyTheme: false });
    expect(out).toEqual({});
    expect('theme' in out).toBe(false);
  });

  it('applyTheme:false 时即使显式传了 isDark 也不返回 theme', () => {
    expect(resolveThemeOption(fakeEngine(), { applyTheme: false, isDark: true })).toEqual({});
    expect(resolveThemeOption(fakeEngine(), { applyTheme: false, isDark: false })).toEqual({});
  });

  it('applyTheme:false 不触发 defineTheme —— 连注册都不该发生', () => {
    const eng = fakeEngine();
    resolveThemeOption(eng, { applyTheme: false });
    expect(eng.defined).toHaveLength(0);
  });
});

describe('resolveThemeOption · 有头场景跟随壳层', () => {
  it('不传 isDark 且 document 是暗色 → 用暗色主题, 不能是 light', () => {
    setDocTheme('dark');
    const out = resolveThemeOption(fakeEngine(), {});
    expect(out.theme).toBeTruthy();
    expect(out.theme).not.toMatch(/light/i);
  });

  it('不传 isDark 且 document 没有 data-theme (系统默认) → 仍按暗色, 不能猜 light', () => {
    setDocTheme(null);
    const out = resolveThemeOption(fakeEngine(), {});
    expect(out.theme).not.toMatch(/light/i);
  });

  it('document 明确是 light → 用亮色主题', () => {
    setDocTheme('light');
    const out = resolveThemeOption(fakeEngine(), {});
    expect(out.theme).toMatch(/light/i);
  });

  it('显式传 isDark 时压过 document', () => {
    setDocTheme('light');
    expect(resolveThemeOption(fakeEngine(), { isDark: true }).theme).not.toMatch(/light/i);
    setDocTheme('dark');
    expect(resolveThemeOption(fakeEngine(), { isDark: false }).theme).toMatch(/light/i);
  });

  it('applyTheme 未传 (undefined) 等同于 true —— 默认行为不变', () => {
    setDocTheme('dark');
    const a = resolveThemeOption(fakeEngine(), {});
    const b = resolveThemeOption(fakeEngine(), { applyTheme: true });
    expect(a).toEqual(b);
  });
});

describe('resolveDocumentIsDark · 缺省必须安全', () => {
  it('只有明确 data-theme="light" 才算亮色', () => {
    setDocTheme('light');
    expect(resolveDocumentIsDark()).toBe(false);
  });

  it('dark / 未设置 / 未知值 一律按暗色 —— 猜错方向会让文字消失', () => {
    setDocTheme('dark');
    expect(resolveDocumentIsDark()).toBe(true);
    setDocTheme(null);
    expect(resolveDocumentIsDark()).toBe(true);
    setDocTheme('midnight-custom');
    expect(resolveDocumentIsDark()).toBe(true);
  });
});
