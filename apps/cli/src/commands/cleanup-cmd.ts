import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { CommandContext } from './types.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { L } from '../i18n/index.js';

type RiskLevel = 'low' | 'medium' | 'high';
const riskText = (r: RiskLevel) => (r === 'low' ? L('低', 'low') : r === 'medium' ? L('中', 'medium') : L('高', 'high'));

interface CleanupCategory {
  id: string;
  label: string;
  riskLevel: RiskLevel;
  riskHint: string;
  recommended: boolean;
  size: number;
  clear: () => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function getPathSize(targetPath: string): Promise<number> {
  let stat;
  try {
    stat = await fs.lstat(targetPath);
  } catch {
    return 0;
  }

  if (stat.isFile()) {
    return stat.size;
  }

  if (!stat.isDirectory()) {
    return 0;
  }

  let totalSize = 0;
  let entries;
  try {
    entries = await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    totalSize += await getPathSize(path.join(targetPath, entry.name));
  }

  return totalSize;
}

async function sumPathsSize(paths: string[]): Promise<number> {
  let total = 0;
  for (const item of paths) {
    total += await getPathSize(item);
  }
  return total;
}

async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function ensureDir(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

async function listFilesByRegex(baseDir: string, regex: RegExp): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && regex.test(entry.name))
    .map((entry) => path.join(baseDir, entry.name));
}

async function buildCleanupCategories(workspacePath: string): Promise<CleanupCategory[]> {
  const neoxHome = path.join(os.homedir(), NEOX_HOME_DIRNAME);
  const logsDir = path.join(neoxHome, 'logs');
  const browserProfileDir = path.join(neoxHome, 'browser-profile');
  const checkpointsDir = path.join(neoxHome, 'checkpoints');
  const sessionsDir = path.join(neoxHome, 'sessions');
  const workspacesDir = path.join(neoxHome, 'workspaces');
  const worktreesDir = path.join(neoxHome, 'worktrees');
  const workspaceIndexDir = path.join(workspacePath, '.neox', 'index');
  const workspaceLegacyDir = path.join(workspacePath, '.cdundo');
  const workspaceProjectMemoryFiles = [
    path.join(workspacePath, '.neox', 'project.md'),
    path.join(workspacePath, '.neox', 'modules'),
    path.join(workspacePath, '.neox', 'rules'),
  ];

  const daemonLogFiles = await listFilesByRegex(neoxHome, /^server\.log(?:\.\d+)?$/);
  const configBackups = await listFilesByRegex(neoxHome, /^config\.json\.backup-/);

  const [
    logsSize,
    daemonLogsSize,
    browserProfileSize,
    checkpointsSize,
    sessionsSize,
    workspacesSize,
    worktreesSize,
    workspaceIndexSize,
    workspaceLegacySize,
    workspaceMemorySize,
    configBackupSize,
  ] = await Promise.all([
    getPathSize(logsDir),
    sumPathsSize(daemonLogFiles),
    getPathSize(browserProfileDir),
    getPathSize(checkpointsDir),
    getPathSize(sessionsDir),
    getPathSize(workspacesDir),
    getPathSize(worktreesDir),
    getPathSize(workspaceIndexDir),
    getPathSize(workspaceLegacyDir),
    sumPathsSize(workspaceProjectMemoryFiles),
    sumPathsSize(configBackups),
  ]);

  return [
    {
      id: 'cli-logs',
      label: L('CLI 调试日志 (~/.neox/logs)', 'CLI debug logs (~/.neox/logs)'),
      riskLevel: 'low',
      riskHint: L('仅影响历史排错日志，运行中可重新生成。', 'Only old troubleshooting logs; regenerated as needed.'),
      recommended: true,
      size: logsSize,
      clear: async () => {
        await removePath(logsDir);
        await ensureDir(logsDir);
      },
    },
    {
      id: 'daemon-logs',
      label: L('Daemon 日志 (~/.neox/server.log*)', 'Daemon logs (~/.neox/server.log*)'),
      riskLevel: 'low',
      riskHint: L('仅清空后台服务日志，服务功能不受影响。', 'Only background-service logs; the service keeps working.'),
      recommended: true,
      size: daemonLogsSize,
      clear: async () => {
        for (const logFile of daemonLogFiles) {
          await removePath(logFile);
        }
      },
    },
    {
      id: 'browser-profile',
      label: L('浏览器配置缓存 (~/.neox/browser-profile)', 'Browser profile cache (~/.neox/browser-profile)'),
      riskLevel: 'medium',
      riskHint: L('会清掉登录态/缓存，下次浏览器工具需重新初始化。', 'Clears logins and cache; the browser tool re-initialises next time.'),
      recommended: true,
      size: browserProfileSize,
      clear: async () => {
        await removePath(browserProfileDir);
        await ensureDir(browserProfileDir);
      },
    },
    {
      id: 'workspace-index',
      label: L('当前工作区索引 (.neox/index)', 'Workspace index (.neox/index)'),
      riskLevel: 'low',
      riskHint: L('仅删除可再生索引，后续可自动重建。', 'Only the rebuildable index; rebuilt automatically.'),
      recommended: true,
      size: workspaceIndexSize,
      clear: async () => {
        await removePath(workspaceIndexDir);
      },
    },
    {
      id: 'legacy-shadow',
      label: L('Legacy 回滚目录 (.cdundo)', 'Legacy rollback dir (.cdundo)'),
      riskLevel: 'low',
      riskHint: L('仅删除旧版残留目录，不影响当前私有 checkpoint。', 'Only leftovers from old versions; current checkpoints are untouched.'),
      recommended: true,
      size: workspaceLegacySize,
      clear: async () => {
        await removePath(workspaceLegacyDir);
      },
    },
    {
      id: 'config-backups',
      label: L('配置备份 (~/.neox/config.json.backup-*)', 'Config backups (~/.neox/config.json.backup-*)'),
      riskLevel: 'low',
      riskHint: L('仅删除历史备份，当前配置不会受影响。', 'Only old backups; the current config is untouched.'),
      recommended: true,
      size: configBackupSize,
      clear: async () => {
        for (const backup of configBackups) {
          await removePath(backup);
        }
      },
    },
    {
      id: 'worktrees',
      label: L('子代理隔离目录 (~/.neox/worktrees)', 'Sub-agent worktrees (~/.neox/worktrees)'),
      riskLevel: 'medium',
      riskHint: L('仅删除隔离工作副本，不影响主仓库代码。', 'Only isolated working copies; your repo is untouched.'),
      recommended: true,
      size: worktreesSize,
      clear: async () => {
        await removePath(worktreesDir);
        await ensureDir(worktreesDir);
      },
    },
    {
      id: 'checkpoints',
      label: L('Checkpoint 仓库 (~/.neox/checkpoints)', 'Checkpoint store (~/.neox/checkpoints)'),
      riskLevel: 'high',
      riskHint: L('会丢失所有 checkpoint 回滚能力。', 'You lose every checkpoint to roll back to.'),
      recommended: false,
      size: checkpointsSize,
      clear: async () => {
        await removePath(checkpointsDir);
        await ensureDir(checkpointsDir);
      },
    },
    {
      id: 'sessions',
      label: L('会话历史 (~/.neox/sessions)', 'Session history (~/.neox/sessions)'),
      riskLevel: 'high',
      riskHint: L('会删除历史会话记录，不可恢复。', 'Deletes past sessions for good.'),
      recommended: false,
      size: sessionsSize,
      clear: async () => {
        await removePath(sessionsDir);
        await ensureDir(sessionsDir);
      },
    },
    {
      id: 'workspaces',
      label: L('工作区记忆/事件 (~/.neox/workspaces)', 'Workspace memory/events (~/.neox/workspaces)'),
      riskLevel: 'high',
      riskHint: L('会清空记忆召回与历史事件日志。', 'Clears memory recall and event history.'),
      recommended: false,
      size: workspacesSize,
      clear: async () => {
        await removePath(workspacesDir);
        await ensureDir(workspacesDir);
      },
    },
    {
      id: 'workspace-memory',
      label: L('当前工作区项目记忆 (.neox/project.md|modules|rules)', 'Project memory (.neox/project.md|modules|rules)'),
      riskLevel: 'high',
      riskHint: L('会删除当前项目积累的记忆文件。', 'Deletes the memory files built up for this project.'),
      recommended: false,
      size: workspaceMemorySize,
      clear: async () => {
        for (const item of workspaceProjectMemoryFiles) {
          await removePath(item);
        }
      },
    },
  ];
}

async function cleanOneCategory(ctx: CommandContext, category: CleanupCategory): Promise<void> {
  if (category.size <= 0) {
    ctx.logInfo(L('无需清理', 'Nothing to clean'), L(`${category.label} 当前为 0 B`, `${category.label} is 0 B`));
    return;
  }

  const confirm = await ctx.promptSelect(
    L(`确认清理：${category.label} (${formatBytes(category.size)})`, `Clean ${category.label} (${formatBytes(category.size)})?`),
    [
      { label: `${L('确认', 'Confirm')} — ${L('风险', 'risk')} ${riskText(category.riskLevel)}`, value: 'yes', description: category.riskHint },
      { label: L('← 取消', '← Cancel'), value: 'no' },
    ],
    'no'
  );

  if (confirm !== 'yes') {
    ctx.logInfo(L('已取消', 'Cancelled'), L(`未清理：${category.label}`, `${category.label} left as is`));
    return;
  }

  await category.clear();
  ctx.logInfo(L('清理完成', 'Cleaned'), L(`${category.label}（释放约 ${formatBytes(category.size)}）`, `${category.label} (~${formatBytes(category.size)} freed)`));
}

async function cleanRecommended(ctx: CommandContext, categories: CleanupCategory[]): Promise<void> {
  const targets = categories.filter((item) => item.recommended && item.size > 0);
  if (targets.length === 0) {
    ctx.logInfo(L('无需清理', 'Nothing to clean'), L('推荐项当前没有可释放空间', 'The recommended items are already empty'));
    return;
  }

  const total = targets.reduce((sum, item) => sum + item.size, 0);
  const confirm = await ctx.promptSelect(
    L(`确认清理推荐项 (${targets.length} 项, ${formatBytes(total)})`, `Clean recommended items (${targets.length}, ${formatBytes(total)})?`),
    [
      { label: L(`确认 — ${targets.length} 项, ${formatBytes(total)}`, `Confirm — ${targets.length} items, ${formatBytes(total)}`), value: 'yes' },
      { label: L('← 取消', '← Cancel'), value: 'no' },
    ],
    'no'
  );

  if (confirm !== 'yes') {
    ctx.logInfo(L('已取消', 'Cancelled'), L('推荐项未清理', 'Nothing was cleaned'));
    return;
  }

  for (const target of targets) {
    await target.clear();
  }

  ctx.logInfo(L('清理完成', 'Cleaned'), L(`已清理推荐项 ${targets.length} 个，释放约 ${formatBytes(total)}`, `${targets.length} recommended items cleaned, ~${formatBytes(total)} freed`));
}

function renderStatusLines(workspacePath: string, categories: CleanupCategory[]): string[] {
  const total = categories.reduce((sum, item) => sum + item.size, 0);

  const lines = [
    `${L('工作区', 'Workspace')}: ${workspacePath}`,
    `${L('总占用', 'Total')}: ${formatBytes(total)}`,
    '',
  ];

  for (const item of categories) {
    lines.push(`- ${item.label}: ${formatBytes(item.size)} | ${L('风险', 'risk')} ${riskText(item.riskLevel)}`);
  }

  return lines;
}

export async function handleCleanupCommand(ctx: CommandContext, actionArg?: string): Promise<void> {
  const workspacePath = path.resolve(ctx.workspacePath || process.cwd());
  const action = (actionArg || '').trim().toLowerCase();

  if (action === 'status' || action === 'list') {
    const categories = await buildCleanupCategories(workspacePath);
    ctx.logInfo(L('磁盘占用总览', 'Disk usage'), renderStatusLines(workspacePath, categories).join('\n'));
    return;
  }

  while (true) {
    let categories: CleanupCategory[] = [];
    try {
      categories = await buildCleanupCategories(workspacePath);
    } catch (error: any) {
      ctx.logInfo(L('扫描失败', 'Scan failed'), error?.message || String(error));
      return;
    }

    const total = categories.reduce((sum, item) => sum + item.size, 0);
    const recommendedTotal = categories
      .filter((item) => item.recommended)
      .reduce((sum, item) => sum + item.size, 0);

    const choices = [
      { label: `${L('清理推荐项', 'Clean recommended')} (${formatBytes(recommendedTotal)})`, value: '__recommended__' },
      { label: L('重新统计', 'Refresh sizes'), value: '__refresh__' },
      ...categories.map((item) => ({
        label: `${item.recommended ? '[ok]' : '[!!]'} ${item.label} — ${formatBytes(item.size)}`,
        value: item.id,
      })),
      { label: L('← 返回', '← Back'), value: '__back__' },
    ];

    let selected: string;
    try {
      selected = await ctx.promptSelect(
        L(`清理 · 占用 ${formatBytes(total)} (${path.basename(workspacePath)})`, `Cleanup · ${formatBytes(total)} (${path.basename(workspacePath)})`),
        choices,
        '__refresh__'
      );
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo(L('清理菜单出错', 'Cleanup menu failed'), error?.message || String(error));
      }
      return;
    }

    if (selected === '__back__') {
      return;
    }

    if (selected === '__refresh__') {
      continue;
    }

    try {
      if (selected === '__recommended__') {
        await cleanRecommended(ctx, categories);
        continue;
      }

      const category = categories.find((item) => item.id === selected);
      if (!category) {
        ctx.logInfo(L('未知清理项', 'Unknown item'), `id=${selected}`);
        continue;
      }

      await cleanOneCategory(ctx, category);
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo(L('清理失败', 'Cleanup failed'), error?.message || String(error));
      }
    }
  }
}
