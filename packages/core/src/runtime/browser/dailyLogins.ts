import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { browserBrandOf, type BrowserBrand } from './chromeLauncher.js';

export interface DailyLoginsConfig {
  /** 开关, 默认 false */
  reuseDailyLogins?: boolean;
  /** 覆盖日常 profile 目录 (含 Default 那一级的**上一级**, 即 user-data-dir) */
  dailyProfileDir?: string;
  /** 用哪个 profile 子目录, 默认 "Default" */
  dailyProfileName?: string;
}

/** 读 ~/.neox/config.json 的 browserUse 段; 读不到就当没开 */
export function readDailyLoginsConfig(): DailyLoginsConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), NEOX_HOME_DIRNAME, 'config.json'), 'utf8'));
    const bu = (raw?.browserUse ?? {}) as Record<string, unknown>;
    return {
      reuseDailyLogins: bu.reuseDailyLogins === true,
      dailyProfileDir: typeof bu.dailyProfileDir === 'string' ? bu.dailyProfileDir : undefined,
      dailyProfileName: typeof bu.dailyProfileName === 'string' ? bu.dailyProfileName : undefined,
    };
  } catch {
    return {};
  }
}

/** 各平台日常 Chrome 系浏览器的 user-data-dir */
export function defaultDailyUserDataDir(brand: BrowserBrand, platform: NodeJS.Platform = process.platform): string | null {
  const home = os.homedir();
  const names: Record<BrowserBrand, { mac: string; win: string; linux: string }> = {
    chrome:   { mac: 'Google/Chrome',            win: 'Google\\Chrome\\User Data',      linux: 'google-chrome' },
    chromium: { mac: 'Chromium',                 win: 'Chromium\\User Data',            linux: 'chromium' },
    edge:     { mac: 'Microsoft Edge',           win: 'Microsoft\\Edge\\User Data',     linux: 'microsoft-edge' },
    brave:    { mac: 'BraveSoftware/Brave-Browser', win: 'BraveSoftware\\Brave-Browser\\User Data', linux: 'BraveSoftware/Brave-Browser' },
  };
  const n = names[brand];
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', n.mac);
  if (platform === 'win32') return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, n.win) : null;
  return path.join(home, '.config', n.linux);
}

export interface SyncResult {
  ok: boolean;
  /** 真拷了 (false + ok = 源没变, 跳过) */
  copied: boolean;
  bytes?: number;
  source?: string;
  reason?: string;
}

const MARKER = '.neox-daily-logins.json';

/** agent profile 里有没有同步过的标记 —— 有就说明这份 profile 里躺着真钥匙串加密的 cookie */
export function hasDailyLoginsMarker(agentProfileDir: string): boolean {
  return fs.existsSync(path.join(agentProfileDir, 'Default', MARKER));
}

/**
 * 把日常 profile 的 Cookies 拷进 agent profile。调用方须持有目录租约并已关闭对应 Chrome。
 */
export function syncDailyLogins(opts: {
  executablePath: string;
  agentProfileDir: string;
  config?: DailyLoginsConfig;
  platform?: NodeJS.Platform;
}): SyncResult {
  const cfg = opts.config ?? readDailyLoginsConfig();
  if (!cfg.reuseDailyLogins) return { ok: true, copied: false, reason: 'off' };
  const brand = browserBrandOf(opts.executablePath);
  const userData = cfg.dailyProfileDir ?? defaultDailyUserDataDir(brand, opts.platform);
  if (!userData) return { ok: false, copied: false, reason: '找不到日常浏览器的 profile 目录' };
  const srcDir = path.join(userData, cfg.dailyProfileName ?? 'Default');
  const src = path.join(srcDir, 'Cookies');
  if (!fs.existsSync(src)) {
    return { ok: false, copied: false, source: src, reason: `日常 profile 里没有 Cookies 文件: ${src}` };
  }
  const st = fs.statSync(src);
  const dstDir = path.join(opts.agentProfileDir, 'Default');
  const dst = path.join(dstDir, 'Cookies');
  const markerPath = path.join(dstDir, MARKER);
  try {
    const m = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { src?: string; mtimeMs?: number; size?: number };
    /* 源没变才跳过 —— 还得目标没被 Chrome 清空 (解不开时它会把表清光, 文件缩到几十 KB) */
    if (m.src === src && m.mtimeMs === st.mtimeMs && m.size === st.size && fs.existsSync(dst)
        && fs.statSync(dst).size >= st.size / 4) {
      return { ok: true, copied: false, source: src, reason: 'unchanged' };
    }
  } catch { /* 没有标记就是第一次 */ }
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, dst);
    /* Chrome 用 journal 模式; 拷完把旧 journal/wal 清掉, 别让 agent 那边拿一份不配套的日志去回滚 */
    for (const extra of ['Cookies-journal', 'Cookies-wal', 'Cookies-shm']) {
      try { fs.rmSync(path.join(dstDir, extra), { force: true }); } catch { /* 无所谓 */ }
    }
    fs.writeFileSync(markerPath, JSON.stringify({ src, mtimeMs: st.mtimeMs, size: st.size, at: new Date().toISOString() }), 'utf8');
    cliLogger.info('BROWSER_MGR', `日常登录态已同步: ${src} → ${dst} (${st.size} bytes)`);
    return { ok: true, copied: true, bytes: st.size, source: src };
  } catch (err: any) {
    return { ok: false, copied: false, source: src, reason: `拷贝失败: ${err?.message || err}` };
  }
}
