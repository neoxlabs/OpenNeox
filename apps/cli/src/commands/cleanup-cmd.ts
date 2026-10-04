import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { CommandContext } from './types.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

interface CleanupCategory {
  id: string;
  label: string;
  riskLevel: '低' | '中' | '高';
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
      label: 'CLI 调试日志 (~/.neox/logs)',
      riskLevel: '低',
      riskHint: '仅影响历史排错日志，运行中可重新生成。',
      recommended: true,
      size: logsSize,
      clear: async () => {
        await removePath(logsDir);
        await ensureDir(logsDir);
      },
    },
    {
      id: 'daemon-logs',
      label: 'Daemon 日志 (~/.neox/server.log*)',
      riskLevel: '低',
      riskHint: '仅清空后台服务日志，服务功能不受影响。',
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
      label: '浏览器配置缓存 (~/.neox/browser-profile)',
      riskLevel: '中',
      riskHint: '会清掉登录态/缓存，下次浏览器工具需重新初始化。',
      recommended: true,
      size: browserProfileSize,
      clear: async () => {
        await removePath(browserProfileDir);
        await ensureDir(browserProfileDir);
      },
    },
    {
      id: 'workspace-index',
      label: '当前工作区索引 (.neox/index)',
      riskLevel: '低',
      riskHint: '仅删除可再生索引，后续可自动重建。',
      recommended: true,
      size: workspaceIndexSize,
      clear: async () => {
        await removePath(workspaceIndexDir);
      },
    },
    {
      id: 'legacy-shadow',
      label: 'Legacy 回滚目录 (.cdundo)',
      riskLevel: '低',
      riskHint: '仅删除旧版残留目录，不影响当前私有 checkpoint。',
      recommended: true,
      size: workspaceLegacySize,
      clear: async () => {
        await removePath(workspaceLegacyDir);
      },
    },
    {
      id: 'config-backups',
      label: '配置备份 (~/.neox/config.json.backup-*)',
      riskLevel: '低',
      riskHint: '仅删除历史备份，当前配置不会受影响。',
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
      label: '子代理隔离目录 (~/.neox/worktrees)',
      riskLevel: '中',
      riskHint: '仅删除隔离工作副本，不影响主仓库代码。',
      recommended: true,
      size: worktreesSize,
      clear: async () => {
        await removePath(worktreesDir);
        await ensureDir(worktreesDir);
      },
    },
    {
      id: 'checkpoints',
      label: 'Checkpoint 仓库 (~/.neox/checkpoints)',
      riskLevel: '高',
      riskHint: '会丢失所有 checkpoint 回滚能力。',
      recommended: false,
      size: checkpointsSize,
      clear: async () => {
        await removePath(checkpointsDir);
        await ensureDir(checkpointsDir);
      },
    },
    {
      id: 'sessions',
      label: '会话历史 (~/.neox/sessions)',
      riskLevel: '高',
      riskHint: '会删除历史会话记录，不可恢复。',
      recommended: false,
      size: sessionsSize,
      clear: async () => {
        await removePath(sessionsDir);
        await ensureDir(sessionsDir);
      },
    },
    {
      id: 'workspaces',
      label: '工作区记忆/事件 (~/.neox/workspaces)',
      riskLevel: '高',
      riskHint: '会清空记忆召回与历史事件日志。',
      recommended: false,
      size: workspacesSize,
      clear: async () => {
        await removePath(workspacesDir);
        await ensureDir(workspacesDir);
      },
    },
    {
      id: 'workspace-memory',
      label: '当前工作区项目记忆 (.neox/project.md|modules|rules)',
      riskLevel: '高',
      riskHint: '会删除当前项目积累的记忆文件。',
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
    ctx.logInfo('无需清理', `${category.label} 当前为 0 B`);
    return;
  }

  const confirm = await ctx.promptSelect(
    `确认清理：${category.label} (${formatBytes(category.size)})`,
    [
      { label: `Confirm — risk:${category.riskLevel}`, value: 'yes' },
      { label: '← Cancel', value: 'no' },
    ],
    'no'
  );

  if (confirm !== 'yes') {
    ctx.logInfo('已取消', `未清理：${category.label}`);
    return;
  }

  await category.clear();
  ctx.logInfo('清理完成', `${category.label}（释放约 ${formatBytes(category.size)}）`);
}

async function cleanRecommended(ctx: CommandContext, categories: CleanupCategory[]): Promise<void> {
  const targets = categories.filter((item) => item.recommended && item.size > 0);
  if (targets.length === 0) {
    ctx.logInfo('无需清理', '推荐项当前没有可释放空间');
    return;
  }

  const total = targets.reduce((sum, item) => sum + item.size, 0);
  const confirm = await ctx.promptSelect(
    `确认清理推荐项 (${targets.length} 项, ${formatBytes(total)})`,
    [
      { label: `Confirm — ${targets.length} items, ${formatBytes(total)}`, value: 'yes' },
      { label: '← Cancel', value: 'no' },
    ],
    'no'
  );

  if (confirm !== 'yes') {
    ctx.logInfo('已取消', '推荐项未清理');
    return;
  }

  for (const target of targets) {
    await target.clear();
  }

  ctx.logInfo('清理完成', `已清理推荐项 ${targets.length} 个，释放约 ${formatBytes(total)}`);
}

function renderStatusLines(workspacePath: string, categories: CleanupCategory[]): string[] {
  const total = categories.reduce((sum, item) => sum + item.size, 0);

  const lines = [
    `Workspace: ${workspacePath}`,
    `总占用: ${formatBytes(total)}`,
    '',
  ];

  for (const item of categories) {
    lines.push(`- ${item.label}: ${formatBytes(item.size)} | 风险${item.riskLevel}`);
  }

  return lines;
}

export async function handleCleanupCommand(ctx: CommandContext, actionArg?: string): Promise<void> {
  const workspacePath = path.resolve(ctx.workspacePath || process.cwd());
  const action = (actionArg || '').trim().toLowerCase();

  if (action === 'status' || action === 'list') {
    const categories = await buildCleanupCategories(workspacePath);
    ctx.logInfo('Cleanup 占用总览', renderStatusLines(workspacePath, categories).join('\n'));
    return;
  }

  while (true) {
    let categories: CleanupCategory[] = [];
    try {
      categories = await buildCleanupCategories(workspacePath);
    } catch (error: any) {
      ctx.logInfo('Cleanup 扫描失败', error?.message || String(error));
      return;
    }

    const total = categories.reduce((sum, item) => sum + item.size, 0);
    const recommendedTotal = categories
      .filter((item) => item.recommended)
      .reduce((sum, item) => sum + item.size, 0);

    const choices = [
      { label: `Clean recommended (${formatBytes(recommendedTotal)})`, value: '__recommended__' },
      { label: 'Refresh sizes', value: '__refresh__' },
      ...categories.map((item) => ({
        label: `${item.recommended ? '[ok]' : '[!!]'} ${item.label} — ${formatBytes(item.size)}`,
        value: item.id,
      })),
      { label: '← Back', value: '__back__' },
    ];

    let selected: string;
    try {
      selected = await ctx.promptSelect(
        `Cleanup · 占用 ${formatBytes(total)} (${path.basename(workspacePath)})`,
        choices,
        '__refresh__'
      );
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo('Cleanup 菜单失败', error?.message || String(error));
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
        ctx.logInfo('未知清理项', `id=${selected}`);
        continue;
      }

      await cleanOneCategory(ctx, category);
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo('清理失败', error?.message || String(error));
      }
    }
  }
}
