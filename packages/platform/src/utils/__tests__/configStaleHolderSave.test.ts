/**
 * 长期持有 config 对象的调用方整份 saveConfig, 不能把别处刚改的开关改回去。
 *
 *   需求：「token 脱敏我关掉还是在脱敏」。盘上 piiFilterEnabled 仍是 true: 设置页写了 false,
 *   之后 ProviderStore 拿着构造时 loadConfig 的旧对象 (piiFilterEnabled: true) 整份保存,
 *   三方合并的 baseline 是进程级一份、早被刷成 false → 旧对象的 true 被当成"本进程改了"写回。
 *
 *  这个文件绝不碰真实 ~/.neox/config.json: HOME 指到临时目录后再动态 import,
 *    并先断言配置路径确实落在临时目录里, 否则直接失败。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let tmpHome: string;
let prevHome: string | undefined;
let mod: typeof import('../config.js');

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-config-stale-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  vi.resetModules();
  mod = await import('../config.js');
  if (!mod.CONFIG_FILE.startsWith(tmpHome)) {
    throw new Error(`refusing to run: CONFIG_FILE ${mod.CONFIG_FILE} is not under temp HOME ${tmpHome}`);
  }
  fs.mkdirSync(path.dirname(mod.CONFIG_FILE), { recursive: true });
  fs.writeFileSync(mod.CONFIG_FILE, JSON.stringify({ piiFilterEnabled: true, providers: {} }, null, 2));
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const readDisk = () => JSON.parse(fs.readFileSync(mod.CONFIG_FILE, 'utf-8'));

describe('saveConfig 按对象记 baseline', () => {
  it('旧对象整份保存只写出它自己改过的字段 —— 设置页刚关的开关不被改回', () => {
    /* ProviderStore 那种: 构造时读一份, 一直拿着 */
    const staleHolder = mod.loadConfig() as any;
    expect(staleHolder.piiFilterEnabled).toBe(true);

    /* 设置页: 现读现改现存 (configService.setPiiFilterPreference 的写法) */
    const fresh = mod.loadConfig() as any;
    fresh.piiFilterEnabled = false;
    mod.saveConfig(fresh);
    expect(readDisk().piiFilterEnabled).toBe(false);

    /* 过一阵 provider 有变动, 旧对象整份保存 */
    staleHolder.providers = { ...(staleHolder.providers ?? {}), demo: { name: 'demo', baseUrl: 'https://example.invalid/v1' } };
    mod.saveConfig(staleHolder);

    const disk = readDisk();
    expect(disk.piiFilterEnabled).toBe(false);
    expect(disk.providers?.demo?.name).toBe('demo');
  });

  it('同一个旧对象再存一次: 只算上次保存之后又改的 (上次写过的不重复顶掉别人)', () => {
    const holder = mod.loadConfig() as any;
    const other = mod.loadConfig() as any;
    other.piiFilterEnabled = true;
    mod.saveConfig(other);
    /* holder 手里还是 false, 但它从没改过这个字段 */
    holder.someFlag = 1;
    mod.saveConfig(holder);
    expect(readDisk().piiFilterEnabled).toBe(true);
    expect(readDisk().someFlag).toBe(1);
  });
});
