
import { ipcMain } from './ipcMainBridged.js';
import { spawnSync, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { getRgPath } from '../util/rgBinary.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { RUN_PROCESS_MANAGER } from '../context/tokens.js';
import type { RunProcessSpec } from '../services/runProcessManager.js';

// ────────────────────────────── Types ──────────────────────────────

export interface PersistedConfigurationEntry {
  id: string;
  typeId: string;
  factoryId: string;
  name: string;
  folderName: string | null;
  allowRunningInParallel: boolean;
  data: Record<string, unknown>;
}

export interface PersistedRunConfigFile {
  $schema: 1;
  selectedId: string | null;
  configurations: PersistedConfigurationEntry[];
}

/**
 * renderer 发到 main 的 spawn 描述 —— 跟 RunProcessSpec 完全一致 (复用 type).
 */
type RunLaunchSpec = RunProcessSpec;

// ────────────────────────────── Paths ──────────────────────────────
//
// (runningProcesses Map 已移到 per-project RunProcessManager; 见 services/runProcessManager.ts)

function getRunConfigFilePath(workspacePath: string): string {
  const dir = path.join(workspacePath, '.neox');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'runConfigurations.json');
}

function getLegacyLaunchFilePath(workspacePath: string): string {
  return path.join(workspacePath, '.neox', 'launch.json');
}

// ────────────────────────────── Legacy migration ──────────────────────────────

/**
 * 旧格式 (.neox/launch.json):
 * ```json
 * [
 *   { "id": "...", "name": "Run dev", "type": "node", "program": "index.js",
 *     "args": "...", "runtimeArgs": "...", "cwd": "...", "env": {...}, ... }
 * ]
 * ```
 *
 * 新格式里不再用扁平的 type 字符串 —— 迁移策略:
 *   - type='node'    → typeId='node.script',   factoryId='node.script'
 *   - type='python'  → typeId='python.script', factoryId='python.script'
 *   - type='java'    → typeId='java.main',     factoryId='java.main'
 *   - type='go'      → typeId='go.run',        factoryId='go.run'
 *   - type='custom'  → typeId='shell',         factoryId='shell'
 *
 * **重要**: 这些 typeId 在 v1 里我们只实现了 npm, 其他类型还没有对应的
 * ConfigurationType 注册. RunManager load 到它们时会 warn + skip, 不会
 * 崩溃. 所以迁移数据会先保存到新文件, 但这些条目暂时不可见, 等后续
 * Node/Python/Go/Java/Shell 类型陆续实现后会自动显示.
 *
 * v1 限制可以接受, 用户可以在 Edit Configurations 里重新建 npm 配置.
 */
function migrateLegacyLaunchFile(
  workspacePath: string,
): PersistedRunConfigFile | null {
  const legacyPath = getLegacyLaunchFilePath(workspacePath);
  if (!fs.existsSync(legacyPath)) return null;

  let legacy: unknown;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
  } catch (err) {
    console.warn('[runConfig] legacy launch.json parse failed:', err);
    return null;
  }
  if (!Array.isArray(legacy)) return null;

  const typeMap: Record<string, { typeId: string; factoryId: string }> = {
    node: { typeId: 'node.script', factoryId: 'node.script' },
    python: { typeId: 'python.script', factoryId: 'python.script' },
    java: { typeId: 'java.main', factoryId: 'java.main' },
    go: { typeId: 'go.run', factoryId: 'go.run' },
    custom: { typeId: 'shell', factoryId: 'shell' },
  };

  const configurations: PersistedConfigurationEntry[] = [];
  for (const item of legacy as Array<Record<string, unknown>>) {
    const legacyType = (item.type as string) || 'custom';
    const mapped = typeMap[legacyType] ?? typeMap.custom;
    configurations.push({
      id: (item.id as string) || randomUUID(),
      typeId: mapped.typeId,
      factoryId: mapped.factoryId,
      name: (item.name as string) || 'Unnamed',
      folderName: null,
      allowRunningInParallel: false,
      // 透传老字段 —— 未来 type 实现出来后自己从 data 里挑需要的字段
      data: { ...item },
    });
  }

  const file: PersistedRunConfigFile = {
    $schema: 1,
    selectedId: null,
    configurations,
  };

  // 保存新文件
  try {
    fs.writeFileSync(
      getRunConfigFilePath(workspacePath),
      JSON.stringify(file, null, 2),
      'utf-8',
    );
  } catch (err) {
    console.warn('[runConfig] failed to write migrated file:', err);
    return null;
  }

  // 重命名老文件
  try {
    const backup = legacyPath + '.migrated.bak';
    // 如果备份已存在 (重复迁移), 追加 timestamp
    const finalBackup = fs.existsSync(backup)
      ? `${backup}.${Date.now()}`
      : backup;
    fs.renameSync(legacyPath, finalBackup);
    console.info(`[runConfig] migrated launch.json → runConfigurations.json (backup: ${finalBackup})`);
  } catch (err) {
    console.warn('[runConfig] rename legacy launch.json failed:', err);
  }

  return file;
}

// ────────────────────────────── Load / Save ──────────────────────────────

function loadRunConfigFile(workspacePath: string): PersistedRunConfigFile {
  const filePath = getRunConfigFilePath(workspacePath);

  if (!fs.existsSync(filePath)) {
    // 尝试迁移老格式
    const migrated = migrateLegacyLaunchFile(workspacePath);
    if (migrated) return migrated;
    return { $schema: 1, selectedId: null, configurations: [] };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // 轻量 schema 校验 —— 缺字段补默认
    const configurations = Array.isArray(raw.configurations)
      ? (raw.configurations as PersistedConfigurationEntry[])
      : [];
    return {
      $schema: 1,
      selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : null,
      configurations,
    };
  } catch (err) {
    console.error('[runConfig] load parse failed:', err);
    return { $schema: 1, selectedId: null, configurations: [] };
  }
}

function saveRunConfigFile(
  workspacePath: string,
  file: PersistedRunConfigFile,
): void {
  const filePath = getRunConfigFilePath(workspacePath);
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
}

// ────────────────────────────── Spawn ──────────────────────────────
//
// startLaunch / stopLaunch / writeStdin / resizePty / runningProcesses Map
// 全部移到 per-project 的 RunProcessManager (见 services/runProcessManager.ts).
// 下面的 IPC handler 通过 projectManager.getBySender(event) 拿到对应 scope 的
// RunProcessManager 实例, 事件自动路由到正确的 BrowserWindow.
//

// ────────────────────────────── Scanning ──────────────────────────────

/**
 * 扫描 workspace 里所有 package.json (异步, 尊重 .gitignore).
 *
 * 主路径: ripgrep `rg --files -g 'package.json'`
 *   - rg 默认尊重 .gitignore / .git/info/exclude / 全局 gitignore, 所以
 *     node_modules / release / reverse / dist / build 等被 ignore 的目录自动跳过
 *   - rg 是 Rust 实现, 速度比 Node fs.readdirSync 快 10x+
 *   - 异步 execFile, 不阻塞主进程事件循环
 *   - 10 秒超时兜底
 *
 * Fallback: 如果 rg 不可用 (极少数情况), 退回旧的 fs.readdirSync 版本
 * 并手动读根 .gitignore 作为粗粒度排除源.
 */
async function scanPackageJsonFiles(workspacePath: string): Promise<string[]> {
  try {
    return await scanPackageJsonFilesWithRg(workspacePath);
  } catch (err) {
    console.warn('[runConfig] rg scan failed, fallback to fs walk:', (err as Error)?.message);
    return scanPackageJsonFilesFallback(workspacePath);
  }
}

function scanPackageJsonFilesWithRg(workspacePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    getRgPath().then((rg) => {
      const args = [
        '--files',
        '--color',
        'never',
        '-g',
        'package.json',
        // 双保险: 即使用户 gitignore 没排 node_modules, 这里也手动排
        '-g',
        '!node_modules/',
        '.',
      ];
      execFile(
        rg,
        args,
        {
          cwd: workspacePath,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 10_000,
          env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` },
        },
        (error, stdout) => {
          if (error && !stdout) {
            reject(error);
            return;
          }
          const abs = (stdout || '')
            .split('\n')
            .map((l) => l.trim().replace(/^\.\//, ''))
            .filter((l) => l.length > 0 && l.endsWith('package.json'))
            .map((rel) => path.join(workspacePath, rel));
          // 排序: 浅路径优先, 同深度字母序
          abs.sort((a, b) => {
            const da = a.split(path.sep).length;
            const db = b.split(path.sep).length;
            if (da !== db) return da - db;
            return a.localeCompare(b);
          });
          resolve(abs);
        },
      );
    }).catch(reject);
  });
}

/**
 * Fallback 同步扫描 (rg 不可用时).
 * 读根 .gitignore 的顶级目录条目, 加到 hard-exclude 里, 避免走 node_modules /
 * release / reverse 等大坑.
 */
function scanPackageJsonFilesFallback(workspacePath: string): string[] {
  const hardExclude = new Set(['node_modules', '.git', '.neox']);
  // 解析根 .gitignore 里的顶层目录条目
  try {
    const gi = fs.readFileSync(path.join(workspacePath, '.gitignore'), 'utf-8');
    for (const rawLine of gi.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      // 剥离前导 / 和尾部 /
      let p = line.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!p || p.includes('*') || p.includes('/')) continue;
      hardExclude.add(p);
    }
  } catch {
    /* 没 .gitignore, 用默认 */
  }
  const MAX_DEPTH = 10;
  const MAX_RESULTS = 200;
  const results: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (results.length >= MAX_RESULTS || depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'package.json') {
        results.push(path.join(dir, 'package.json'));
        if (results.length >= MAX_RESULTS) return;
        break;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (hardExclude.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
      if (results.length >= MAX_RESULTS) return;
    }
  };
  walk(workspacePath, 0);
  results.sort((a, b) => {
    const da = a.split(path.sep).length;
    const db = b.split(path.sep).length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
  return results;
}

/**
 * 扫描到的 binary —— { 分类, 绝对路径, 版本号 }.
 */
export interface ScannedBinary {
  kind: string;
  path: string;
  version: string;
}

let cachedUserPath: string | null = null;
function getUserPath(): string {
  if (cachedUserPath !== null) return cachedUserPath;
  try {
    const shell = process.env.SHELL || '/bin/bash';
    // -l 登录 shell, -c 跑一条命令. 超时 3 秒 (足够加载 rc 文件).
    // 用 printf 避免 echo 被 alias 劫持.
    const out = spawnSync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (out.status === 0 && out.stdout) {
      cachedUserPath = out.stdout.trim();
      return cachedUserPath;
    }
  } catch {
    /* ignore */
  }
  // 兜底: process.env.PATH + 硬编码常见位置
  const fallback: string[] = [
    process.env.PATH || '',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(os.homedir(), '.bun/bin'),
    path.join(os.homedir(), '.volta/bin'),
  ];
  cachedUserPath = fallback.filter(Boolean).join(':');
  return cachedUserPath;
}

/** 给定一个 name, 在 PATH + nvm/volta/fnm 等位置遍历找所有匹配 binary */
function scanBinary(name: string, kind: string): ScannedBinary[] {
  const seen = new Set<string>();
  const results: ScannedBinary[] = [];

  const push = (binPath: string) => {
    if (seen.has(binPath)) return;
    if (!fs.existsSync(binPath)) return;
    try {
      const stat = fs.statSync(binPath);
      if (!stat.isFile() && !stat.isSymbolicLink()) return;
    } catch {
      return;
    }
    seen.add(binPath);
    results.push({ kind, path: binPath, version: queryVersion(binPath) });
  };

  // 1. 用户 PATH 里每一个目录尝试
  const userPath = getUserPath();
  for (const dir of userPath.split(path.delimiter)) {
    if (!dir) continue;
    push(path.join(dir, name));
  }

  // 2. 版本管理器常见位置 (glob 风格, 手动 readdir)
  const versionManagerDirs: string[] = [];
  const home = os.homedir();
  // nvm: ~/.nvm/versions/node/<version>/bin
  const nvmRoot = path.join(home, '.nvm/versions/node');
  try {
    if (fs.existsSync(nvmRoot)) {
      for (const v of fs.readdirSync(nvmRoot)) {
        versionManagerDirs.push(path.join(nvmRoot, v, 'bin'));
      }
    }
  } catch {
    /* ignore */
  }
  // fnm: ~/.local/share/fnm/node-versions/<version>/installation/bin
  const fnmRoot = path.join(home, '.local/share/fnm/node-versions');
  try {
    if (fs.existsSync(fnmRoot)) {
      for (const v of fs.readdirSync(fnmRoot)) {
        versionManagerDirs.push(path.join(fnmRoot, v, 'installation/bin'));
      }
    }
  } catch {
    /* ignore */
  }
  // volta: ~/.volta/tools/image/node/<version>/bin
  const voltaRoot = path.join(home, '.volta/tools/image/node');
  try {
    if (fs.existsSync(voltaRoot)) {
      for (const v of fs.readdirSync(voltaRoot)) {
        versionManagerDirs.push(path.join(voltaRoot, v, 'bin'));
      }
    }
  } catch {
    /* ignore */
  }
  for (const dir of versionManagerDirs) {
    push(path.join(dir, name));
  }

  // 3. macOS homebrew 的 keg-only 版本 binary 路径 (例: node@18)
  if (process.platform === 'darwin') {
    for (const kegDir of ['/opt/homebrew/opt', '/usr/local/opt']) {
      try {
        if (!fs.existsSync(kegDir)) continue;
        for (const keg of fs.readdirSync(kegDir)) {
          // 只看 node / pnpm / yarn / bun 前缀
          if (
            !keg.startsWith('node') &&
            !keg.startsWith('npm') &&
            !keg.startsWith('pnpm') &&
            !keg.startsWith('yarn') &&
            !keg.startsWith('bun')
          )
            continue;
          push(path.join(kegDir, keg, 'bin', name));
        }
      } catch {
        /* ignore */
      }
    }
  }

  return results;
}

function queryVersion(binaryPath: string): string {
  try {
    const out = spawnSync(binaryPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (out.status === 0 && out.stdout) {
      return out.stdout.trim().replace(/^v/, '');
    }
  } catch {
    /* ignore */
  }
  return '?';
}

function scanAllPackageManagers(): ScannedBinary[] {
  const all: ScannedBinary[] = [];
  for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
    all.push(...scanBinary(name, name));
  }
  // dedupe by path (同一个 binary 可能通过 PATH + keg 两条路径同时命中)
  const seen = new Set<string>();
  const unique: ScannedBinary[] = [];
  for (const b of all) {
    if (seen.has(b.path)) continue;
    seen.add(b.path);
    unique.push(b);
  }
  return unique;
}

function scanAllNodeBinaries(): ScannedBinary[] {
  const all = scanBinary('node', 'node');
  const seen = new Set<string>();
  const unique: ScannedBinary[] = [];
  for (const b of all) {
    if (seen.has(b.path)) continue;
    seen.add(b.path);
    unique.push(b);
  }
  return unique;
}

// ────────────────────────────── Register ──────────────────────────────

export interface RunConfigHandlerOptions {
  /**
   * ProjectManager 用于从 IPC event?.sender 反查 ProjectScope, 然后从 scope
   * 拿到 per-project 的 RunProcessManager. 这样 run-launch 事件会路由到
   * 正确的窗口, 多个 project 窗口可以完全独立地跑进程.
   */
  projectManager: ProjectManager;
}

export function registerRunConfigIpcHandlers(
  options: RunConfigHandlerOptions,
): void {
  const { projectManager } = options;

  // ── 持久化 ─────────────────────────────────────────
  // run-config:load / save 不需要 scope, 因为 renderer 显式传入 workspacePath
  ipcMain.handle(
    'run-config:load',
    async (_e, workspacePath: string): Promise<PersistedRunConfigFile> => {
      return loadRunConfigFile(workspacePath);
    },
  );

  ipcMain.handle(
    'run-config:save',
    async (
      _e,
      workspacePath: string,
      file: PersistedRunConfigFile,
    ): Promise<void> => {
      saveRunConfigFile(workspacePath, file);
    },
  );

  // ── 执行 ─────────────────────────────────────────
  // 所有 run-launch IPC 都通过 projectManager.getBySender(event) 拿到发起
  // 窗口对应的 ProjectScope, 然后 scope.getService(RUN_PROCESS_MANAGER).
  // 每个 scope 有独立的 RunProcessManager, 事件自动发回 scope.window.
  ipcMain.handle(
    'run-launch:start',
    async (event, spec: RunLaunchSpec): Promise<{ processId: string }> => {
      const scope = projectManager.getBySender(event?.sender as any);
      if (!scope) {
        throw new Error('run-launch:start: no project scope for sender window');
      }
      const manager = scope.getService(RUN_PROCESS_MANAGER);
      const processId = manager.start(spec);
      return { processId };
    },
  );

  ipcMain.handle(
    'run-launch:stop',
    async (event, processId: string): Promise<void> => {
      const scope = projectManager.getBySender(event?.sender as any);
      scope?.getService(RUN_PROCESS_MANAGER).stop(processId);
    },
  );

  ipcMain.handle(
    'run-launch:stdin',
    async (event, processId: string, data: string): Promise<void> => {
      const scope = projectManager.getBySender(event?.sender as any);
      scope?.getService(RUN_PROCESS_MANAGER).writeStdin(processId, data);
    },
  );

  ipcMain.handle(
    'run-launch:resize',
    async (event, processId: string, cols: number, rows: number): Promise<void> => {
      const scope = projectManager.getBySender(event?.sender as any);
      scope?.getService(RUN_PROCESS_MANAGER).resize(processId, cols, rows);
    },
  );

  ipcMain.handle(
    'run-launch:get-running',
    async (event) => {
      const scope = projectManager.getBySender(event?.sender as any);
      if (!scope) return [];
      return scope.getService(RUN_PROCESS_MANAGER).getRunning();
    },
  );

  // ── 扫描 ─────────────────────────────────────────
  ipcMain.handle(
    'run-npm:scan-package-jsons',
    async (_e, workspacePath: string): Promise<string[]> => {
      return await scanPackageJsonFiles(workspacePath);
    },
  );

  ipcMain.handle(
    'run-npm:scan-package-managers',
    async (): Promise<ScannedBinary[]> => {
      return scanAllPackageManagers();
    },
  );

  ipcMain.handle(
    'run-npm:scan-node',
    async (): Promise<ScannedBinary[]> => {
      return scanAllNodeBinaries();
    },
  );
}
