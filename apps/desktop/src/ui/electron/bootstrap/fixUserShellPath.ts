
import { execSync, exec } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const PATH_FIX_TIMEOUT_MS = 3000;
/* 后台刷新不挡任何人, 给宽裕超时 (巨型 .zshrc / 冷盘) */
const PATH_REFRESH_TIMEOUT_MS = 10_000;

/**
 * 要从 user shell 抓回来的环境变量白名单.
 *
 *   PATH               — 解决 spawn ENOENT (python3 / curl / brew 等)
 *   HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/NO_PROXY — 解决中国网络环境下 web_fetch
 *                        访问外网受阻 (用户在 .zshrc 里设了 VPN proxy, 启 desktop
 *                        从 Finder 起就丢了)
 *   LANG / LC_ALL      — 解决中文用户在某些 spawn 进程下输出乱码
 *
 *  其它环境变量不抓 (XDG_*, EDITOR 等) — 太散, 增加 surface area, 没必要.
 */
const ENV_VARS_TO_INHERIT = [
  'PATH',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
  'LANG', 'LC_ALL',
];

interface ShellEnvCache {
  shell: string;
  values: Record<string, string>;
}

function cacheFilePath(): string {
  return path.join(app.getPath('userData'), 'shell-env-cache.json');
}

function readCache(shell: string): ShellEnvCache | null {
  try {
    const raw = fs.readFileSync(cacheFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as ShellEnvCache;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.shell !== shell) return null; /* 换了 shell → 缓存作废, 走同步抓取 */
    if (!parsed.values || typeof parsed.values !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(shell: string, values: Record<string, string>): void {
  try {
    fs.writeFileSync(cacheFilePath(), JSON.stringify({ shell, values }));
  } catch { /* 缓存写失败无所谓, 下次照旧同步抓 */ }
}

/* probe 命令 — 一次性抓多个变量, 用 \x1f (Unit Separator, 不会出现在正常 env 值里)
 * 当分隔符, 避免值里含 = / : 等被误解析.
 *
 * -i: interactive (执行 .zshrc / .bashrc)
 * -l: login (执行 .zprofile / .profile)
 * -c: 单命令模式. 先 -l 再 -i, 跟用户实际打开新 Terminal 时一致.
 *
 * 把命令外层用 `'...'` 包, 防 shell 把变量在外层解析成 launchctl 的值.
 * 内层 printf 必须在 user shell 里才会展开成 user 的环境. */
export function probeCommand(shell: string): string {
  const probeScript = `printf "%s\\x1f" ${ENV_VARS_TO_INHERIT.map((name) => `"$${name}"`).join(' ')}`;
  return `${shell} -ilc '${probeScript}'`;
}

/** probe 输出 → { name: value },格式异常返回 null */
export function parseProbeOutput(out: string): Record<string, string> | null {
  const values = out.split('\x1f');
  /* 最后一段是末尾的空字符串 (printf 每个值后都加 \x1f, 末尾会多出来一个空), 砍掉 */
  if (values.length > ENV_VARS_TO_INHERIT.length) values.pop();
  if (values.length !== ENV_VARS_TO_INHERIT.length) {
    console.warn(`[fixUserShellPath] unexpected probe output: ${values.length} values, expected ${ENV_VARS_TO_INHERIT.length}`);
    return null;
  }
  const map: Record<string, string> = {};
  ENV_VARS_TO_INHERIT.forEach((name, i) => { map[name] = values[i] ?? ''; });
  return map;
}

function applyValues(map: Record<string, string>): void {
  let changedCount = 0;
  for (const name of ENV_VARS_TO_INHERIT) {
    const value = map[name];
    if (!value) continue; /* user shell 里没设这个变量 */
    if (name === 'PATH' && !value.includes('/')) continue; /* sanity */
    if (process.env[name] !== value) {
      process.env[name] = value;
      changedCount++;
    }
  }
  if (changedCount > 0) {
    const pathLen = process.env.PATH?.length ?? 0;
    const proxyHints = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']
      .filter((k) => process.env[k])
      .join(',');
    console.log(`[fixUserShellPath] inherited ${changedCount} env vars from user shell (PATH=${pathLen} chars${proxyHints ? `, proxy=${proxyHints}` : ''})`);
  }
}

function refreshInBackground(shell: string): void {
  exec(probeCommand(shell), {
    timeout: PATH_REFRESH_TIMEOUT_MS,
    encoding: 'utf8',
  }, (err, stdout) => {
    if (err) {
      console.warn(`[fixUserShellPath] background refresh failed: ${err?.message || err}`);
      return;
    }
    const map = parseProbeOutput(stdout);
    if (!map) return;
    applyValues(map);
    writeCache(shell, map);
  });
}

/* ── Windows ────────────────────────────────────────────────────────── */

/** 展开 PATH 里的 %VAR% 引用。展不开的原样留着 —— 删掉等于凭空少一段路径。 */
export function expandWinVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    /* Windows 环境变量大小写不敏感, 而 process.env 的键是原样的 —— 必须忽略大小写查,
     * 否则 %NVM_SYMLINK% 对上 nvm_symlink 会查不到而被当成"展不开"。 */
    const hit = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
    const v = hit ? env[hit] : undefined;
    return v && v.length > 0 ? v : whole;
  });
}

/** 合并 + 去重 + 保序。抽出来是为了能直接测"只增不减"这条安全性质。 */
export function mergeWinPath(current: string, fromRegistry: string, env: NodeJS.ProcessEnv): string {
  const sep = ';';
  const candidate = [expandWinVars(current, env), expandWinVars(fromRegistry, env)]
    .filter(Boolean).join(sep);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of candidate.split(sep)) {
    const entry = raw.trim();
    if (!entry) continue;
    const k = entry.toLowerCase().replace(/\\+$/, '');
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(entry);
  }
  return merged.join(sep);
}

/** 从注册表读一处 PATH。读不到返回 '' —— 调用方按"这一处没有"处理, 不是失败。 */
function readRegistryPath(root: string, key: string): string {
  try {
    const out = execSync(`reg query "${root}\\${key}" /v Path`, {
      timeout: PATH_FIX_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    /*   Path    REG_EXPAND_SZ    C:\foo;%BAR%\bin   */
    const m = out.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/mi);
    return m?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

function fixWindowsPath(): void {
  const current = process.env.PATH ?? '';
  const sep = ';';

  const fromRegistry = [
    readRegistryPath('HKCU', 'Environment'),
    readRegistryPath('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
  ].filter(Boolean).join(sep);

  /* 当前 PATH 自身也可能带没展开的 %VAR% (继承自更早的进程), 一起展。
   * 只增不减: 结果一定是 current 的超集 —— 注册表读空或解析错时最坏就是"跟修之前一样"。 */
  const next = mergeWinPath(current, fromRegistry, process.env);
  if (!next) return;
  const merged = next.split(sep);
  if (next !== current) {
    process.env.PATH = next;
    const added = merged.filter(e => !current.toLowerCase().includes(e.toLowerCase())).length;
    console.log(`[fixUserShellPath] win PATH 合并完成: ${merged.length} 段 (新增 ${added})`);
  }
}

export function fixUserShellPath(): void {
  if (process.platform === 'win32') {
    try { fixWindowsPath(); }
    catch (err: any) { console.warn(`[fixUserShellPath] win PATH 修复失败, 保持原样: ${err?.message || err}`); }
    return;
  }
  if (process.platform !== 'darwin') return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';

    const cached = readCache(shell);
    if (cached) {
      applyValues(cached.values);
      refreshInBackground(shell);
      return;
    }

    /* 首次启动 (无缓存): 保持原同步语义 — 必须拿到正确 PATH 再继续 */
    const out = execSync(probeCommand(shell), {
      timeout: PATH_FIX_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const map = parseProbeOutput(out);
    if (!map) return;
    applyValues(map);
    writeCache(shell, map);
  } catch (err: any) {
    console.warn(`[fixUserShellPath] failed to fetch user shell env: ${err?.message || err}`);
  }
}
