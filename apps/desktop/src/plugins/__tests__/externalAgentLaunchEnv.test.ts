import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildAgentEnv, readDefaultModel, resolveLaunch, setExternalAgentLaunchHooks, versionAtLeast,
} from '../externalAgent/launchEnv.js';
import { createStreamParser } from '../externalAgent/streamParsers.js';
import { validateExternalAgents } from '../externalAgent/validate.js';

const base = {
  id: 'dsh_test', displayName: { en: 'x' }, description: { en: 'x' }, command: 'fakedsh',
  detect: { args: ['--version'], installHint: { en: 'x' } }, argsTemplate: ['{{prompt}}'], streamFormat: 'text' as const,
};

/* HOME 指到临时目录: node 候选 / CLI 配置都从 HOME 下找, 不碰真实家目录 */
let tmp = '';
const realHome = process.env.HOME;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extagent-env-'));
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});
afterAll(() => {
  process.env.HOME = realHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeBin(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

describe('版本比较', () => {
  it('22.16 < 22.19 ≤ 24.x', () => {
    expect(versionAtLeast('v22.16.0', '22.19')).toBe(false);
    expect(versionAtLeast('v22.19.0', '22.19')).toBe(true);
    expect(versionAtLeast('v24.1.0', '22.19')).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('node 运行时: 默认 node 太旧时挑一个够新的', () => {
  it('PATH 上 node 是 22.16 → 用 nvm 里够新的那个跑同一个脚本', () => {
    const oldBin = path.join(tmp, 'old');
    fakeBin(oldBin, 'node', '#!/bin/sh\necho v22.16.0\n');
    const script = fakeBin(oldBin, 'fakedsh', '#!/usr/bin/env node\nconsole.log(1)\n');
    /* 新 node 不在 PATH 上 —— 模拟 nvm 装在别处。版本给 99, 本机真装的 node 一定比它旧 */
    const nvmNode = fakeBin(path.join(os.homedir(), '.nvm', 'versions', 'node', 'v99.0.0', 'bin'), 'node', '#!/bin/sh\necho v99.0.0\n');
    const launch = resolveLaunch({ ...base, runtime: { node: '22.19' } }, { PATH: oldBin });
    expect(launch.ok).toBe(true);
    if (launch.ok) {
      expect(fs.realpathSync(launch.file)).toBe(fs.realpathSync(nvmNode));
      expect(launch.prefixArgs).toEqual([fs.realpathSync(script)]);
    }
  });

  it('没声明 runtime → 原样按命令名起', () => {
    expect(resolveLaunch(base, { PATH: '' })).toEqual({ ok: true, file: 'fakedsh', prefixArgs: [] });
  });
});

describe('凭据: 用户环境优先, 缺了才从 Neox 服务商取', () => {
  it('没设 DEEPSEEK_API_KEY → 注入 Neox 里 api.deepseek.com 那家的 key 和地址', () => {
    setExternalAgentLaunchHooks({
      getEnv: () => ({ PATH: '/usr/bin' }),
      resolveCredential: (hosts) => (hosts.includes('api.deepseek.com') ? { apiKey: 'sk-neox', baseUrl: 'https://api.deepseek.com' } : null),
    });
    const env = buildAgentEnv({ ...base, credentials: ['deepseek'] }, '/w');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-neox');
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com');
    expect(env.PWD).toBe('/w');
  });

  it('用户 shell 里设了 → 不覆盖; 没声明 credentials → 不注入; NEOX_* 剥掉', () => {
    setExternalAgentLaunchHooks({ getEnv: () => ({ DEEPSEEK_API_KEY: 'sk-user', NEOX_SERVER_TOKEN: 's' }) });
    expect(buildAgentEnv({ ...base, credentials: ['deepseek'] }).DEEPSEEK_API_KEY).toBe('sk-user');
    setExternalAgentLaunchHooks({ getEnv: () => ({}) });
    const env = buildAgentEnv(base);
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(Object.keys(env).some((k) => k.startsWith('NEOX_'))).toBe(false);
  });
});

describe('默认模型: 从 CLI 自己的配置里取', () => {
  it('droid: sessionDefault 不是自定义模型 → 取 customModels[0]', () => {
    fs.mkdirSync(path.join(os.homedir(), '.factory'), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), '.factory', 'settings.json'), JSON.stringify({
      sessionDefaultSettings: { model: 'claude-sonnet-4-5' },
      customModels: [{ id: 'custom:Zen-0' }, { id: 'custom:Other-1' }],
    }));
    const agent = { ...base, defaultModelFrom: { file: '~/.factory/settings.json', paths: ['sessionDefaultSettings.model', 'customModels.0.id'], match: '^custom:' } };
    expect(readDefaultModel(agent)).toBe('custom:Zen-0');
  });

  it('文件不存在 → undefined (交给 CLI 自己的默认)', () => {
    expect(readDefaultModel({ ...base, defaultModelFrom: { file: '~/.nope-extagent.json', paths: ['a'] } })).toBeUndefined();
  });
});

describe('droid 流: 真原因不被 "Exec failed" 盖掉', () => {
  it('405 在前, Exec failed 只标结束', () => {
    const p = createStreamParser('droid-stream-json');
    const a = p.feed(JSON.stringify({ type: 'error', message: '405 Method Not Allowed' }));
    const b = p.feed(JSON.stringify({ type: 'error', message: 'Exec failed' }));
    expect(a[0]?.error).toBe('405 Method Not Allowed');
    expect(b[0]?.error).toBeUndefined();
    expect(b[0]?.done).toBe(true);
  });

  it('没登录: 给出下一步', () => {
    const p = createStreamParser('droid-stream-json');
    const [ev] = p.feed(JSON.stringify({ type: 'error', message: 'Error: Authentication failed. Please log in using /login' }));
    expect(ev?.error).toMatch(/customModels/);
    expect(ev?.fatal).toBe(true);
  });
});

describe('没配好时快速失败 (不等 CLI 自己重试一两分钟)', () => {
  it('cline: 从配置读当前服务商的接口地址; 端口没人听 → 立刻给出原因', async () => {
    fs.mkdirSync(path.join(os.homedir(), '.cline'), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), '.cline', 'p.json'), JSON.stringify({
      lastUsedProvider: 'oc', providers: { oc: { settings: { baseUrl: 'http://127.0.0.1:9/v1' } } },
    }));
    const agent = { ...base, endpointFrom: { file: '~/.cline/p.json', path: 'providers.{lastUsedProvider}.settings.baseUrl' } };
    const { readEndpoint, probeEndpoint } = await import('../externalAgent/launchEnv.js');
    expect(readEndpoint(agent)).toBe('http://127.0.0.1:9/v1');
    const t0 = Date.now();
    expect(await probeEndpoint('http://127.0.0.1:9/v1', {})).toMatch(/连接被拒/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('kimi: 还没产出就连续两次连接失败 → 致命停下; 产出之后的偶发断网不拦', () => {
    const retry = (n: number) => JSON.stringify({ role: 'meta', type: 'turn.step.retrying', failed_attempt: n, error_name: 'APIConnectionError', error_message: 'Connection error.' });
    const p = createStreamParser('kimi-stream-json');
    expect(p.feed(retry(1))).toEqual([]);
    const [ev] = p.feed(retry(2));
    expect(ev?.fatal).toBe(true);
    expect(ev?.error).toMatch(/config\.toml/);

    const q = createStreamParser('kimi-stream-json');
    q.feed(JSON.stringify({ role: 'assistant', content: 'working' }));
    expect(q.feed(retry(3))).toEqual([]);
  });
});

describe('清单校验', () => {
  it('凭据只能引用内置表, 配置文件只能在 ~/ 下', () => {
    expect(validateExternalAgents([{ ...base, credentials: ['openai'] }]).errors.join()).toMatch(/credentials/);
    expect(validateExternalAgents([{ ...base, defaultModelFrom: { file: '~/../etc/passwd', paths: ['a'] } }]).errors.join()).toMatch(/defaultModelFrom/);
    expect(validateExternalAgents([{ ...base, runtime: { node: '22.19' }, credentials: ['deepseek'] }]).errors).toEqual([]);
  });
});
