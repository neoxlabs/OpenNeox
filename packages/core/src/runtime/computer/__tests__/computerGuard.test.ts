import { describe, it, expect } from 'vitest';
import { guardComputerTarget } from '../computerGuard.js';

describe('Computer Use 目标边界', () => {
  it('终端类一律拒, 并把人指回 execute_shell', () => {
    for (const app of ['Terminal', 'terminal', 'iTerm', 'iTerm2', 'Warp', 'kitty',
                       'Alacritty', 'WezTerm', 'Hyper', '终端', 'com.apple.Terminal',
                       'com.googlecode.iterm2', 'Script Editor']) {
      const d = guardComputerTarget(app);
      expect(d, `${app} 应该被拒`).toBeTruthy();
      expect(d!.code).toBe('app_forbidden_terminal');
      /* 拒绝必须带"那你该用什么" —— 只说不行会让模型原地重试 */
      expect(d!.message).toMatch(/execute_shell/);
    }
  });

  it('Neox 自己一律拒 —— 代点审批卡就是自我授权', () => {
    for (const app of ['Neox', 'neox', 'com.mk.neox', 'com.mk.neox.dev', 'com.mk.neox.work']) {
      const d = guardComputerTarget(app);
      expect(d, `${app} 应该被拒`).toBeTruthy();
      expect(d!.code).toBe('app_forbidden_self');
    }
  });

  it('系统授权 / 密码窗一律拒', () => {
    for (const app of ['SecurityAgent', 'Keychain Access', '钥匙串访问',
                       'com.apple.security', 'loginwindow']) {
      const d = guardComputerTarget(app);
      expect(d, `${app} 应该被拒`).toBeTruthy();
      expect(d!.code).toBe('app_forbidden_security');
    }
  });

  /* 对照组 —— 边界不能是"全拦", 否则这条闸等于把功能关掉了 */
  it('正常应用照常放行', () => {
    for (const app of ['Calculator', 'QQ', '微信', 'Notes', 'Safari', 'Finder',
                       'com.tencent.xinWeChat', 'Visual Studio Code',
                       'neox-computer-use.docx - WPS 2019', '演示文稿1 - WPS 2019']) {
      expect(guardComputerTarget(app), `${app} 不该被拒`).toBeNull();
    }
  });

  it('不指定 app 交给桥去判真实前台 —— 这一层不猜', () => {
    expect(guardComputerTarget(undefined)).toBeNull();
    expect(guardComputerTarget('')).toBeNull();
    expect(guardComputerTarget('   ')).toBeNull();
  });
});

describe('系统设置', () => {
  it('整块拒, 并指一条真能走的路 (execute_shell + defaults)', () => {
    for (const app of ['System Settings', 'System Preferences', '系统设置',
                       'com.apple.systempreferences', 'com.apple.systemsettings']) {
      const d = guardComputerTarget(app);
      expect(d, `${app} 应该被拒`).toBeTruthy();
      expect(d!.code).toBe('app_forbidden_settings');
      expect(d!.message).toMatch(/defaults write/);
    }
  });
});
