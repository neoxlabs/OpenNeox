/**
 * BYOK 检测测试使用临时 home，覆盖来源识别、密钥脱敏和显式导入边界，避免
 * 依赖运行测试的机器上的 provider 配置。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { discoverExternalProviders, maskKey } from '../discoverProviders.js';

let home = '';

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-byok-'));

  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://relay.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-relay-0123456789abcdef',
    },
  }));

  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
    '[model_providers.withkey]',
    'name = "Has Key"',
    'base_url = "https://api.haskey.example/v1"',
    'env_key = "HASKEY_API_KEY"',
    'wire_api = "responses"',
    '',
    '[model_providers.nokey]',
    'name = "No Key"',
    'base_url = "https://api.nokey.example/v1"',
    'env_key = "NOKEY_API_KEY"',
    'wire_api = "chat"',
    '',
  ].join('\n'));

  /* shell 启动文件里的 export —— 桌面进程 process.env 里没有的那一类 */
  fs.writeFileSync(path.join(home, '.zshrc'), [
    '# 注释行不算',
    'export HASKEY_API_KEY="sk-haskey-abcdefghijklmnop"',
    'export DYNAMIC_API_KEY=$(cat /somewhere/secret)',   // 非字面量, 必须丢
    'export DEEPSEEK_API_KEY=sk-deepseek-abcdefghijkl',
  ].join('\n'));
});

afterAll(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('discoverExternalProviders', () => {
  it('默认不带明文 —— 扫描给界面看的那一趟, apiKey 字段必须不存在', () => {
    const list = discoverExternalProviders({ homeOverride: home, envOverride: {} });
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) {
      expect(p).not.toHaveProperty('apiKey');
      /* 掩码里不许出现完整 Key 的中段 */
      if (p.keyPreview) expect(p.keyPreview).toMatch(/…/);
    }
  });

  it('includeSecrets 时才带明文 —— 那一趟只在主进程落盘时跑', () => {
    const list = discoverExternalProviders({ homeOverride: home, envOverride: {}, includeSecrets: true });
    const withKey = list.find((p) => p.id === 'withkey');
    expect(withKey?.apiKey).toBe('sk-haskey-abcdefghijklmnop');
  });

  it('Codex 的 env_key 要去 shell 启动文件里兑 —— 桌面进程没有 login shell', () => {
    const list = discoverExternalProviders({ homeOverride: home, envOverride: {} });
    const withKey = list.find((p) => p.id === 'withkey');
    expect(withKey?.hasKey).toBe(true);
    expect(withKey?.keyOrigin).toBe('shell-profile');
    expect(withKey?.protocol).toBe('openai-responses');
  });

  it('读不到 Key 的照样列出来 —— 端点是对的, 用户只需补一个 Key', () => {
    const list = discoverExternalProviders({ homeOverride: home, envOverride: {} });
    const noKey = list.find((p) => p.id === 'nokey');
    expect(noKey).toBeTruthy();
    expect(noKey?.hasKey).toBe(false);
    expect(noKey?.keyEnvName).toBe('NOKEY_API_KEY');
    expect(noKey?.baseUrl).toBe('https://api.nokey.example/v1');
    /* wire_api=chat → 走 openai 兼容, 不是 responses */
    expect(noKey?.protocol).toBe('openai');
  });

  it('不是字面量的 export 一律丢 —— 取那种值要跑用户的 shell', () => {
    const list = discoverExternalProviders({ homeOverride: home, envOverride: {}, includeSecrets: true });
    expect(JSON.stringify(list)).not.toContain('/somewhere/secret');
  });

  it('Claude Code 的自定义端点连 Key 一起认', () => {
    const list = discoverExternalProviders({ homeOverride: home, envOverride: {} });
    const claude = list.find((p) => p.source === 'Claude Code');
    expect(claude?.protocol).toBe('anthropic');
    expect(claude?.baseUrl).toBe('https://relay.example.com');
    expect(claude?.hasKey).toBe(true);
    expect(claude?.keyOrigin).toBe('config');
  });

  it('已有同端点的标 alreadyImported —— 不能让用户以为要覆盖他的配置', () => {
    const list = discoverExternalProviders({
      homeOverride: home,
      envOverride: {},
      existing: [{ id: 'whatever', baseUrl: 'https://api.nokey.example/v1' }],
    });
    expect(list.find((p) => p.id === 'nokey')?.alreadyImported).toBe(true);
  });

  it('掩码保留头尾各 4 位, 中间不还原', () => {
    expect(maskKey('sk-1234567890abcd')).toBe('sk-1…abcd');
    expect(maskKey('short')).toBe('•••••');
  });
});

/**
 * CC Switch —— 它管的是 Claude Code 的服务商切换。
 *
 *    SQLite 那条路 (`~/.cc-switch/cc-switch.db`) **这里测不了**:
 *   vitest 跑在 node ABI 下, 而本仓的 better-sqlite3 是按 Electron ABI 编的
 *   (NODE_MODULE_VERSION 143 vs 127), require 直接抛。所以只测 config.json 这一支,
 *   SQLite 那支靠"读不动就跳过"的兜底保证不炸 —— 别把这条当成 SQLite 也验过了。
 */
describe('discoverExternalProviders · CC Switch', () => {
  let ccHome = '';
  beforeAll(() => {
    ccHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-ccsw-'));
    fs.mkdirSync(path.join(ccHome, '.cc-switch'), { recursive: true });
    fs.writeFileSync(path.join(ccHome, '.cc-switch', 'config.json'), JSON.stringify({
      providers: {
        p1: {
          name: '中转 A',
          settingsConfig: {
            env: {
              ANTHROPIC_BASE_URL: 'https://relay-a.example.com',
              ANTHROPIC_AUTH_TOKEN: 'sk-relay-a-0123456789',
            },
          },
        },
        p2: {
          name: '中转 B',
          /* 有的版本把整段设置当字符串存 —— 解析要能再剥一层 */
          settingsConfig: JSON.stringify({
            env: { ANTHROPIC_BASE_URL: 'https://relay-b.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-relay-b-9876543210' },
          }),
        },
      },
    }));
  });
  afterAll(() => {
    try { fs.rmSync(ccHome, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('嵌套和字符串两种存法都要认出来', () => {
    const list = discoverExternalProviders({ homeOverride: ccHome, envOverride: {} });
    const cc = list.filter((p) => p.source === 'CC Switch');
    expect(cc.map((p) => p.baseUrl).sort()).toEqual([
      'https://relay-a.example.com',
      'https://relay-b.example.com',
    ]);
    expect(cc.every((p) => p.hasKey && p.protocol === 'anthropic')).toBe(true);
  });

  it('掩码照样只出掩码 —— 明文不许默认带出来', () => {
    const list = discoverExternalProviders({ homeOverride: ccHome, envOverride: {} });
    for (const p of list) expect(p).not.toHaveProperty('apiKey');
    expect(JSON.stringify(list)).not.toContain('sk-relay-a-0123456789');
  });

  it('没装 CC Switch 时安安静静, 不报错也不产生候选', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-noccsw-'));
    try {
      const list = discoverExternalProviders({ homeOverride: empty, envOverride: {} });
      expect(list.filter((p) => p.source === 'CC Switch')).toHaveLength(0);
    } finally {
      try { fs.rmSync(empty, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});

/**
 * dotenv —— Codex 的 Key **实际上就存在这里**。
 *
 *   第一版只查 process.env + shell profile, 于是本机 7 家全扫成"需补 Key",
 *   而 6 把 Key 明明躺在 ~/.codex/.env 里。这条闸钉住"去它真正在的地方找"。
 */
describe('discoverExternalProviders · dotenv', () => {
  let dotHome = '';
  beforeAll(() => {
    dotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dotenv-'));
    fs.mkdirSync(path.join(dotHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dotHome, '.codex', 'config.toml'), [
      '[model_providers.viadotenv]',
      'name = "Via dotenv"',
      'base_url = "https://api.viadotenv.example/v1"',
      'env_key = "VIADOTENV_API_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dotHome, '.codex', '.env'), [
      '# 注释',
      'VIADOTENV_API_KEY=sk-viadotenv-0123456789',
      'RUNTIME_ONLY=$(cat /nope)',        /* 非字面量, 必须丢 */
      'export QUOTED_API_KEY="sk-quoted-0123456789"',
    ].join('\n'));
    /* 启动器 per-profile 的 .env */
    const prof = path.join(dotHome, '.codex-config-ui', 'codex-oauth-profiles', 'prof_x');
    fs.mkdirSync(prof, { recursive: true });
    fs.writeFileSync(path.join(prof, '.env'), 'DEEPSEEK_API_KEY=sk-fromprofile-0123456789\n');
  });
  afterAll(() => {
    try { fs.rmSync(dotHome, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('~/.codex/.env 里的 Key 要能兑上 config.toml 的 env_key', () => {
    const list = discoverExternalProviders({ homeOverride: dotHome, envOverride: {} });
    const p = list.find((x) => x.id === 'viadotenv');
    expect(p?.hasKey).toBe(true);
    expect(p?.keyOrigin).toBe('dotenv');
  });

  it('启动器 per-profile 的 .env 也读', () => {
    const list = discoverExternalProviders({ homeOverride: dotHome, envOverride: {} });
    const ds = list.find((x) => x.id === 'deepseek');
    expect(ds?.hasKey).toBe(true);
    expect(ds?.keyOrigin).toBe('dotenv');
  });

  it('.env 里的非字面量一律丢 —— 跟 shell profile 同一条规矩', () => {
    const list = discoverExternalProviders({ homeOverride: dotHome, envOverride: {}, includeSecrets: true });
    expect(JSON.stringify(list)).not.toContain('/nope');
  });

  it('同一个端点只出现一次 —— 不管被几个源认出来', () => {
    const list = discoverExternalProviders({ homeOverride: dotHome, envOverride: {} });
    const urls = list.map((p) => (p.baseUrl ?? '').replace(/\/+$/, '').toLowerCase());
    expect(urls.length).toBe(new Set(urls).size);
  });
});
