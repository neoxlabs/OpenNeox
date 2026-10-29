import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

let TMP_HOME: string;
let CONFIG_FILE: string;
let cfg: typeof import('@neoxlabs/platform/utils/config.js');

const ORIGINAL_HOME = process.env.HOME;

beforeAll(async () => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-cfg-test-'));
  process.env.HOME = TMP_HOME;
  fs.mkdirSync(path.join(TMP_HOME, NEOX_HOME_DIRNAME), { recursive: true });
  CONFIG_FILE = path.join(TMP_HOME, NEOX_HOME_DIRNAME, 'config.json');

  cfg = await import('@neoxlabs/platform/utils/config.js');

  // 自检: 模块确实解析到了沙箱路径, 否则立刻失败, 绝不允许误伤真实配置
  const active = cfg.getActiveConfigFile();
  if (!active.startsWith(TMP_HOME)) {
    throw new Error(`配置路径未被重定向到沙箱 (实际: ${active}) — 中止, 防止写坏真实 config.json`);
  }
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 造一份"磁盘上已有的真实配置" —— 带 provider 和 apiKey, 就是最怕丢的东西 */
function seedDisk(): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    providers: {
      openai: { apiKey: 'sk-REAL-OPENAI', baseUrl: 'https://api.openai.com' },
      grok: { apiKey: 'sk-REAL-GROK' },
    },
    defaultModel: 'grok-4.5',
    theme: 'anye',
  }, null, 2), 'utf-8');
}

function readDisk(): any {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

describe('config 合并 — 不可信基线不得删键', () => {
  it('baseline 不可信时, 存一个只带单键的 config 不会清空磁盘上的 providers', () => {
    seedDisk();

    /* 模拟事故现场: 调用方拿到的是 loadConfig 失败后的空配置, 改了个字段就存。
     * 这里不调 loadConfig, 正是为了让 _configBaseline 保持 null (= 基线不可信)。 */
    cfg.saveConfig({ theme: 'moye' } as any);

    const after = readDisk();
    expect(after.theme).toBe('moye');                       // 本次的改动要落盘
    expect(after.providers?.openai?.apiKey).toBe('sk-REAL-OPENAI'); // 但 provider 一个都不能少
    expect(after.providers?.grok?.apiKey).toBe('sk-REAL-GROK');
    expect(after.defaultModel).toBe('grok-4.5');
  });

  it('基线可信时(先 load 再 save), 用户真的删掉某个 key 仍然生效', () => {
    seedDisk();

    const loaded = cfg.loadConfig();                  // 这一步让 _configBaseline 变可信
    expect(loaded.providers).toBeDefined();

    const next = { ...loaded } as any;
    delete next.providers;                            // 用户意图: 真的删掉 providers
    cfg.saveConfig(next);

    const after = readDisk();
    expect(after.providers).toBeUndefined();          // 可信基线下, 删除必须照做
    expect(after.theme).toBe('anye');                 // 没动的键保留
  });

  it('checkpoint 缺省即开 —— 用户从没设过时 loadConfig 补 true', () => {
    seedDisk(); // seed 里没有 experimental 段
    expect(cfg.loadConfig().experimental?.enableCheckpoint).toBe(true);
  });

  it('用户显式关掉 checkpoint 必须被尊重, 不能被默认值盖回去', () => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      experimental: { enableCheckpoint: false },
    }, null, 2), 'utf-8');
    expect(cfg.loadConfig().experimental?.enableCheckpoint).toBe(false);
  });

  it('补默认值不主动写盘 —— 用户不动它, config.json 里不该凭空多出一行', () => {
    seedDisk();
    const before = fs.readFileSync(CONFIG_FILE, 'utf-8');
    cfg.loadConfig();
    expect(fs.readFileSync(CONFIG_FILE, 'utf-8')).toBe(before);
  });

  it('配置损坏时 loadConfig 返回空配置, 但磁盘原文件保持原样并留下 .corrupt 备份', () => {
    fs.writeFileSync(CONFIG_FILE, '{ 这不是合法 JSON', 'utf-8');

    const loaded = cfg.loadConfig();
    expect(loaded).toEqual({});                       // 降级启动

    // 原文件不能被动过 —— 用户还指望它能救回来
    expect(fs.readFileSync(CONFIG_FILE, 'utf-8')).toContain('这不是合法 JSON');

    const baks = fs.readdirSync(path.dirname(CONFIG_FILE)).filter((f) => f.includes('.corrupt.'));
    expect(baks.length).toBeGreaterThan(0);
  });
});
