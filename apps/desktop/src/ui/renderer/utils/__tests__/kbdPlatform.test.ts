import { describe, expect, it, vi, afterEach } from 'vitest';

/** 用指定平台重新加载 keymap 模块 (isMac 在模块顶层求值, 必须 resetModules)。 */
async function loadOn(platform: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { platform, userAgent: platform });
  return import('../keymap');
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('mod 令牌按平台落到不同的修饰键', () => {
  it('mac 上是 ⌘ 系符号', async () => {
    const { kbd, isMac, MOD_LABEL } = await loadOn('MacIntel');
    expect(isMac).toBe(true);
    expect(kbd('mod+n')).toBe('⌘N');
    expect(kbd('mod+shift+m')).toBe('⇧⌘M');
    expect(kbd('mod+shift+z')).toBe('⇧⌘Z');
    expect(MOD_LABEL).toBe('⌘');
  });

  it('Windows 上是 Ctrl+, 且**绝不出现 ⌘**', async () => {
    const { kbd, isMac, MOD_LABEL } = await loadOn('Win32');
    expect(isMac).toBe(false);
    expect(kbd('mod+n')).toBe('Ctrl+N');
    expect(kbd('mod+shift+m')).toBe('Ctrl+Shift+M');
    expect(MOD_LABEL).toBe('Ctrl+');
    /* 这条是整件事的重点: Windows 一路上不该看见 ⌘。 */
    for (const s of ['mod+n', 'mod+p', 'mod+z', 'mod+shift+z', 'mod+enter', 'mod+[', 'mod+0']) {
      expect(kbd(s), `${s} 在 Windows 上仍含 ⌘`).not.toContain('⌘');
    }
  });

  it('Windows 上不能把 mod 认成 Win 键 —— Win+N 是系统快捷键, 写出来就是错的', async () => {
    const { kbd } = await loadOn('Win32');
    expect(kbd('mod+n')).not.toContain('Win');
  });

  it('显式写 cmd / ctrl 的仍照旧 —— 用户存的自定义绑定不能被 mod 改了语义', async () => {
    const win = await loadOn('Win32');
    expect(win.kbd('ctrl+shift+f')).toBe('Ctrl+Shift+F');
    const mac = await loadOn('MacIntel');
    expect(mac.kbd('cmd+shift+f')).toBe('⇧⌘F');
    /* mac 上显式 ctrl 就是 ⌃ (Control), 不该被当成 ⌘。 */
    expect(mac.kbd('ctrl+shift+f')).toBe('⌃⇧F');
  });

  it('特殊键名两边都有像样的标签, 不会漏成空串', async () => {
    const mac = await loadOn('MacIntel');
    expect(mac.kbd('mod+enter')).toBe('⌘↩');
    const win = await loadOn('Win32');
    expect(win.kbd('mod+enter')).toMatch(/^Ctrl\+\S+/);
  });

  it('matchesShortcut 也认 mod —— 文案和实际绑定用同一套写法才不会再次跑偏', async () => {
    const { matchesShortcut } = await loadOn('Win32');
    const ev = { key: 'n', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(matchesShortcut(ev as unknown as KeyboardEvent, 'mod+n')).toBe(true);
    const macMod = await loadOn('MacIntel');
    const macEv = { key: 'n', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false };
    expect(macMod.matchesShortcut(macEv as unknown as KeyboardEvent, 'mod+n')).toBe(true);
  });
});
