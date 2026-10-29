import { afterEach, describe, expect, it } from 'vitest';
import { getNeoxUserAgent, resetNeoxUserAgentForTests } from '../neoxUserAgent.js';
import { VERSION } from '../../version.js';

const KEYS = ['NEOX_CLIENT', 'NEOX_CLIENT_VERSION', 'NEOX_HOST'] as const;
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));

function withEnv(env: Partial<Record<(typeof KEYS)[number], string>>): string {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  resetNeoxUserAgentForTests();
  return getNeoxUserAgent();
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  resetNeoxUserAgentForTests();
});

describe('getNeoxUserAgent', () => {
  it('没有宿主信息时退回老逻辑: 非 Electron 即 CLI, 版本是引擎版本, 不带 Engine 段', () => {
    const ua = withEnv({});
    expect(ua).toMatch(new RegExp(`^Neox-CLI/${VERSION.replace(/\./g, '\\.')} \\([^;]+; [^;]+; (Node|Bun)/`));
    expect(ua).not.toContain('Engine/');
  });

  it('VS Code 插件: 产品 / 插件版本 / 宿主编辑器, 末尾带引擎版本', () => {
    const ua = withEnv({ NEOX_CLIENT: 'vscode', NEOX_CLIENT_VERSION: '3.9.1', NEOX_HOST: 'VSCode/1.106.2' });
    expect(ua).toMatch(/^Neox-VSCode\/3\.9\.1 \(/);
    expect(ua).toContain('; VSCode/1.106.2; ');
    expect(ua).toMatch(new RegExp(`Engine/${VERSION.replace(/\./g, '\\.')}\\)$`));
  });

  it('桌面端: 用 app 版本而不是 CLI 版本线', () => {
    const ua = withEnv({ NEOX_CLIENT: 'desktop', NEOX_CLIENT_VERSION: '3.8.12' });
    expect(ua).toMatch(/^Neox-Desktop\/3\.8\.12 \(/);
  });

  it('JetBrains 只传了 NEOX_CLIENT 也能认出来', () => {
    expect(withEnv({ NEOX_CLIENT: 'jetbrains' })).toMatch(/^Neox-JetBrains\//);
  });

  it('环境变量里的括号 / 分号 / 换行不会破坏 UA 格式', () => {
    const ua = withEnv({ NEOX_CLIENT: 'vscode', NEOX_CLIENT_VERSION: '1.0 (x)', NEOX_HOST: 'Evil; Host)\nX' });
    expect(ua.match(/\(/g)).toHaveLength(1);
    expect(ua.match(/\)/g)).toHaveLength(1);
    expect(ua).not.toMatch(/\n/);
  });
});
