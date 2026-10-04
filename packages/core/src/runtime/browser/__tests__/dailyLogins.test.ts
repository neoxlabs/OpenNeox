/** Cover opt-in cookie synchronization, same-brand paths, change detection,
 * and cleanup of stale journal files. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncDailyLogins, defaultDailyUserDataDir } from '../dailyLogins.js';

function fixture(): { userData: string; agent: string } {
  const root = mkdtempSync(join(tmpdir(), 'neox-daily-'));
  const userData = join(root, 'daily'); const agent = join(root, 'agent');
  mkdirSync(join(userData, 'Default'), { recursive: true });
  writeFileSync(join(userData, 'Default', 'Cookies'), 'COOKIES-V1');
  mkdirSync(join(agent, 'Default'), { recursive: true });
  writeFileSync(join(agent, 'Default', 'Cookies-journal'), 'stale');
  return { userData, agent };
}
const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

describe('syncDailyLogins', () => {
  it('开关关着 → 什么都不做, 也不报错', () => {
    const { userData, agent } = fixture();
    const r = syncDailyLogins({ executablePath: exe, agentProfileDir: agent, config: { reuseDailyLogins: false, dailyProfileDir: userData } });
    expect(r).toMatchObject({ ok: true, copied: false, reason: 'off' });
    expect(existsSync(join(agent, 'Default', 'Cookies'))).toBe(false);
  });

  it('开着 → 拷 Cookies, 清掉旧 journal, 写标记', () => {
    const { userData, agent } = fixture();
    const r = syncDailyLogins({ executablePath: exe, agentProfileDir: agent, config: { reuseDailyLogins: true, dailyProfileDir: userData } });
    expect(r.ok && r.copied).toBe(true);
    expect(readFileSync(join(agent, 'Default', 'Cookies'), 'utf8')).toBe('COOKIES-V1');
    expect(existsSync(join(agent, 'Default', 'Cookies-journal'))).toBe(false);
    expect(existsSync(join(agent, 'Default', '.neox-daily-logins.json'))).toBe(true);
  });

  it('源没变 → 第二次跳过; 源变了 → 再拷', () => {
    const { userData, agent } = fixture();
    const cfg = { reuseDailyLogins: true, dailyProfileDir: userData };
    syncDailyLogins({ executablePath: exe, agentProfileDir: agent, config: cfg });
    expect(syncDailyLogins({ executablePath: exe, agentProfileDir: agent, config: cfg })).toMatchObject({ copied: false, reason: 'unchanged' });
    writeFileSync(join(userData, 'Default', 'Cookies'), 'COOKIES-V2');
    utimesSync(join(userData, 'Default', 'Cookies'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(syncDailyLogins({ executablePath: exe, agentProfileDir: agent, config: cfg }).copied).toBe(true);
    expect(readFileSync(join(agent, 'Default', 'Cookies'), 'utf8')).toBe('COOKIES-V2');
  });

  it('日常 profile 没有 Cookies → ok:false 说清路径', () => {
    const { agent } = fixture();
    const r = syncDailyLogins({ executablePath: exe, agentProfileDir: agent, config: { reuseDailyLogins: true, dailyProfileDir: '/nonexistent' } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Cookies/);
  });

  it('各平台各品牌的默认目录', () => {
    expect(defaultDailyUserDataDir('chrome', 'darwin')).toMatch(/Library\/Application Support\/Google\/Chrome$/);
    expect(defaultDailyUserDataDir('edge', 'linux')).toMatch(/\.config\/microsoft-edge$/);
    expect(defaultDailyUserDataDir('brave', 'darwin')).toMatch(/BraveSoftware\/Brave-Browser$/);
  });
});
