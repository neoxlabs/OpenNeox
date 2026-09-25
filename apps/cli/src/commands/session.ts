/**
 * Session Command Handlers
 * Handles all session-related CLI commands
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandContext, RuntimeHostLike } from './types.js';
import { formatTimeAgo } from '../utils/index.js';
import { cliPrintln } from '../utils/output.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { t, formatMessage, getLanguage } from '../i18n/index.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

function outputToUI(ctx: { outputLines?: (lines: string[]) => void }, lines: string[]): void {
  if (ctx.outputLines) {
    ctx.outputLines(lines);
  } else {
    lines.forEach(line => cliPrintln(line));
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function requireRuntimeHost(ctx: CommandContext): RuntimeHostLike {
  if (!ctx.runtimeHost) {
    throw new Error('Runtime host is not available');
  }
  return ctx.runtimeHost;
}

async function createCheckpointCompat(ctx: CommandContext, label?: string): Promise<any> {
  if (ctx.sdkClient) {
    const sessionId = ctx.currentSession?.sessionId ?? 'cli';
    return ctx.sdkClient.createCheckpoint(sessionId, label);
  }
  return requireRuntimeHost(ctx).createCheckpoint(label);
}

async function cleanupCheckpointsCompat(ctx: CommandContext): Promise<void> {
  if (ctx.sdkClient) {
    await ctx.sdkClient.cleanupCheckpoints();
    return;
  }
  await requireRuntimeHost(ctx).cleanupCheckpoints?.();
}

async function getCheckpointStatsCompat(ctx: CommandContext): Promise<any | null> {
  if (ctx.sdkClient) {
    return ctx.sdkClient.getCheckpointStats();
  }
  if (ctx.runtimeHost?.getCheckpointStats) {
    return requireRuntimeHost(ctx).getCheckpointStats!();
  }
  return null;
}

async function listCheckpointsCompat(ctx: CommandContext): Promise<any[]> {
  if (ctx.sdkClient) {
    const sessionId = ctx.currentSession?.sessionId;
    return ctx.sdkClient.getCheckpoints(undefined, sessionId);
  }
  return requireRuntimeHost(ctx).listCheckpoints();
}

async function rollbackCheckpointCompat(ctx: CommandContext, checkpointId: string): Promise<any> {
  if (ctx.sdkClient) {
    return ctx.sdkClient.rollbackToCheckpoint(checkpointId);
  }
  return requireRuntimeHost(ctx).rollbackTo(checkpointId);
}

/** 跟随 /language 的双语文案 (本文件的提示原来一半英文一半中文写死) */
const L = (zh: string, en: string): string => (getLanguage() === 'zh' ? zh : en);

function formatRollbackSummary(result: any): string {
  if (typeof result?.removedCount === 'number') {
    return L(`移除 ${result.removedCount} 项`, `removed ${result.removedCount} items`);
  }
  if (Array.isArray(result?.restored)) {
    const restoredCount = result.restored.length;
    const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
    return L(
      `恢复 ${restoredCount} 个文件${errorCount > 0 ? `, ${errorCount} 个失败` : ''}`,
      `restored ${restoredCount} files${errorCount > 0 ? `, ${errorCount} errors` : ''}`,
    );
  }
  return L('完成', 'completed');
}

/**
 * Handle /sessions command - interactive session selection
 */
export async function handleSessionsCommand(ctx: CommandContext): Promise<void> {
  const { colors, promptSelect, sessionEnabled, activateSession, logInfo } = ctx;

  if (!sessionEnabled) {
    logInfo(L('会话未启用', 'Session disabled'), L('没有开启会话持久化', 'Session persistence is not enabled.'));
    return;
  }

  const sessions = await ctx.sessionManager.listSessions();

  if (sessions.length === 0) {
    logInfo(L('还没有会话', 'No sessions'), L('发一条消息就会创建', 'Start chatting to create one.'));
    return;
  }

  const currentSessionId = ctx.currentSession?.sessionId ?? null;
  const zhUi = (() => { try { return getLanguage() === 'zh'; } catch { return false; } })();

  try {
    // SelectMenu 自带按终端高度 window + 滚动, 不写死截断; 留 50 上限防超长列表卡。
    /* 没说过话的空会话不列 (占位名 + 至多 1 条) —— 每次打开 CLI 敲个斜杠命令就退出也会留一条,
     * 列表里一屏全是 session_20260924_… 的空壳, 真正聊过的被挤到下面。当前会话总是列出。 */
    const isEmptyShell = (s: any) => {
      const nm = typeof s.agentName === 'string' ? s.agentName.trim() : (typeof s.name === 'string' ? s.name.trim() : '');
      const n = s.itemCount ?? 0;
      /* 0 条 = 子 agent 自己的会话 ("子 Agent Explorer") 或刚建就退出的, 都不是用户能接着聊的对话 */
      return n === 0 || ((!nm || nm === `Session ${s.sessionId}`) && n <= 1);
    };
    /* 当前会话还没聊过也不列 —— 刚打开就 /resume 时它排第一且默认选中, 回车等于"接着一段空白" */
    const listed = sessions.filter((s: any) => !isEmptyShell(s));
    const sessionChoices = listed.slice(0, 50).map((s: any) => {
      const isCurrent = !!currentSessionId && s.sessionId === currentSessionId;
      const time = formatTimeAgo(s.updatedAt);

      /* 注意字段叫 agentName —— session-manager.listSessions 把 sessions.name
       * 映射成了 agentName (不是 name), 查 s.name 会一直是 undefined。 */
      const rawName = typeof s.agentName === 'string' ? s.agentName.trim()
        : (typeof s.name === 'string' ? s.name.trim() : '');
      const isPlaceholderName = !rawName || rawName === `Session ${s.sessionId}`;
      const shown = isPlaceholderName
        ? (zhUi ? '未命名会话' : 'Untitled session')
        : (rawName.length > 44 ? `${rawName.slice(0, 43)}…` : rawName).replace(/[()]/g, ' ');

      const n = s.itemCount ?? 0;
      const count = zhUi ? `${n} 条消息` : `${n} ${n === 1 ? 'message' : 'messages'}`;

      /* 末尾括号 = SelectMenu 的灰色第二栏; 当前会话走菜单自带的 ● 标记 */
      return {
        label: `${shown} (${count} · ${time})`,
        value: s.sessionId,
        isCurrent,
      };
    });

    const choices = [
      { label: zhUi ? '← 返回' : '← Back', value: '__back__' },
      ...sessionChoices,
    ];

    const selectedId = await promptSelect(zhUi ? '选择会话 · 回车接着聊' : 'Resume a session', choices,
      /* 光标落在当前会话 (在列表里的话), 否则第一条会话 —— 不落在"← 返回"上, 打开就能回车 */
      sessionChoices.find(c => c.isCurrent)?.value ?? sessionChoices[0]?.value);

    if (selectedId === '__back__') {
      return;
    }



    if (selectedId === currentSessionId) {
      logInfo(zhUi ? '已经在这个会话里' : 'Already on this session');
      return;
    }

    // Switch to selected session
    const session = await ctx.sessionManager.getSession(selectedId);
    const loaded = await activateSession(session, { loadHistory: true });
    const picked = listed.find((s: any) => s.sessionId === selectedId);
    const pickedName = picked && typeof picked.agentName === 'string' && picked.agentName.trim() && picked.agentName !== `Session ${selectedId}`
      ? picked.agentName.trim() : selectedId;

    logInfo(
      zhUi ? `已切换到「${pickedName}」` : `Resumed "${pickedName}"`,
      loaded > 0 ? (zhUi ? `载入 ${loaded} 条消息 · ctrl+o 查看完整记录` : `${loaded} messages loaded · ctrl+o for full transcript`) : undefined,
    );
  } catch (error: any) {
    if (error.message !== 'cancelled') {
      logInfo(L('切换会话失败', 'Session switch failed'), error.message);
    }
  }
}

/**
 * Handle /session <id> command - switch to a session
 */
export async function handleSessionSwitchCommand(
  ctx: CommandContext,
  sessionId: string
): Promise<void> {
  const { sessionEnabled, activateSession, colors } = ctx;

  if (!sessionEnabled) {
    outputToUI(ctx, [colors.error('  [x] Session persistence is disabled')]);
    return;
  }

  try {
    const session = await ctx.sessionManager.getSession(sessionId);
    const loaded = await activateSession(session, { loadHistory: true });

    const lines = ['', colors.success(`  ✓ Switched to session: ${sessionId}`)];
    if (loaded > 0) {
      lines.push(colors.dim(`    Loaded ${loaded} messages`));
    }
    lines.push('');
    outputToUI(ctx, lines);
  } catch (error: any) {
    outputToUI(ctx, [colors.error(`  [x] ${error.message}`)]);
  }
}

/**
 * Handle /session-new command - create new session
 */
export async function handleSessionNewCommand(
  ctx: CommandContext,
  model: string
): Promise<void> {
  const { sessionEnabled, activateSession, colors } = ctx;

  if (!sessionEnabled) {
    outputToUI(ctx, [colors.error('  [x] Session persistence is disabled')]);
    return;
  }

  try {
    const session = await ctx.sessionManager.createSession({ model });
    await activateSession(session, { loadHistory: false });
    /* checkpoint 走 sdkClient (有则用, 无则跳过) —— 新建会话不该因为拿不到 checkpoint 能力就整条失败 */
    try { await createCheckpointCompat(ctx, 'session_start'); } catch { /* 非致命 */ }

    const lines = ['', colors.success(`  ✓ Created new session: ${session.sessionId}`), ''];
    outputToUI(ctx, lines);
  } catch (error: any) {
    outputToUI(ctx, [colors.error(`  [x] Failed to create session: ${error.message}`)])
  }
}

/**
 * Handle /session-info command - show session info
 */
export async function handleSessionInfoCommand(ctx: CommandContext): Promise<void> {
  const { colors } = ctx;

  if (ctx.clearOutputLines) {
    ctx.clearOutputLines();
  }

  try {
    /* 同上: 不走 runtimeHost。会话统计从 sessionManager (直连 DB) 取, checkpoint 数走 sdkClient。 */
    const sessionId = ctx.currentSession?.sessionId;
    if (!sessionId) throw new Error('当前没有活动会话');
    const all = await ctx.sessionManager.listSessions();
    const row = all.find((x) => x.sessionId === sessionId);
    let checkpointCount = 0;
    try {
      const cps = await listCheckpointsCompat(ctx);
      checkpointCount = Array.isArray(cps) ? cps.length : 0;
    } catch { /* checkpoint 拿不到不影响其它信息 */ }
    const info = {
      sessionId,
      turnCount: (ctx.currentSession as any)?.turnCount ?? 0,
      messageCount: row?.itemCount ?? 0,
      checkpointCount,
      meta: ((ctx.currentSession as any)?.meta ?? null) as Record<string, unknown> | null,
    };

    const lines: string[] = [];
    lines.push('');
    lines.push(colors.highlight('  Session Info:'));
    lines.push('');
    lines.push(colors.dim('    Session ID:  ') + colors.info(info.sessionId));
    lines.push(colors.dim('    Turns:       ') + colors.info(info.turnCount.toString()));
    lines.push(colors.dim('    Messages:    ') + colors.info(info.messageCount.toString()));
    lines.push(colors.dim('    Checkpoints: ') + colors.info(info.checkpointCount.toString()));
    if (info.meta) {
      const model = typeof info.meta.model === 'string' ? info.meta.model : 'N/A';
      lines.push(colors.dim('    Model:       ') + colors.info(model));
      const createdAt = info.meta.createdAt;
      if (typeof createdAt === 'string' || typeof createdAt === 'number' || createdAt instanceof Date) {
        lines.push(colors.dim('    Created:     ') + colors.info(new Date(createdAt).toLocaleString()));
      }
    }
    lines.push('');
    outputToUI(ctx, lines);
  } catch {
    outputToUI(ctx, [colors.dim('  No active session')]);
  }
}

/**
 * Handle /undo command - undo last n turns
 */
export async function handleUndoCommand(
  ctx: CommandContext,
  countStr?: string
): Promise<void> {
  const { colors } = ctx;

  try {
    if (!ctx.runtimeHost) {
      ctx.logInfo('/undo 暂不可用', '想撤回改动: /rollback 回到某个检查点 (每轮开始前会自动存档)');
      return;
    }
    const runtimeHost = requireRuntimeHost(ctx);
    const count = parseInt(countStr || '1') || 1;
    const result = await runtimeHost.undoTurns(count);

    if (result.success) {
      const lines: string[] = ['', colors.success(`  ✓ Undone ${result.undoneCount} turn(s)`)];
      if (result.messages.length > 0) {
        lines.push(colors.dim('    Removed messages:'));
        for (const msg of result.messages.slice(0, 4)) {
          const preview = (msg.content || '').slice(0, 50);
          lines.push(colors.dim(`      [${msg.role}] ${preview}${preview.length >= 50 ? '...' : ''}`));
        }
        if (result.messages.length > 4) {
          lines.push(colors.dim(`      ... and ${result.messages.length - 4} more`));
        }
      }
      lines.push('');
      outputToUI(ctx, lines);
    } else {
      outputToUI(ctx, [colors.warning('  ⚠ Nothing to undo')]);
    }
  } catch (error: any) {
    outputToUI(ctx, [colors.error(`  [x] Undo failed: ${error.message}`)]);
  }
}

/**
 * Handle /checkpoint command - create checkpoint
 */
export async function handleCheckpointCommand(
  ctx: CommandContext,
  name?: string
): Promise<void> {
  const { logInfo, promptSelect } = ctx;
  const config = loadConfig();
  const isEnabled = config.experimental?.enableCheckpoint === true;

  // 快捷子命令: /checkpoint enable | disable | create <name>
  const sub = (name || '').trim().toLowerCase();
  if (sub === 'enable') {
    const updated = { ...config, experimental: { ...config.experimental, enableCheckpoint: true } };
    saveConfig(updated);
    logInfo(L('自动检查点已开', 'Checkpoints enabled'), L('重启后生效', 'Takes effect after restart'));
    return;
  }
  if (sub === 'disable') {
    const updated = { ...config, experimental: { ...config.experimental, enableCheckpoint: false } };
    saveConfig(updated);
    logInfo(L('自动检查点已关', 'Checkpoints disabled'), L('重启后生效', 'Takes effect after restart'));
    return;
  }
  if (sub.startsWith('create')) {
    const label = sub.replace(/^create\s*/, '').trim() || undefined;
    if (!isEnabled) {
      logInfo(L('检查点没开', 'Checkpoints are off'), L('先 /checkpoint enable 再重启', 'Run /checkpoint enable and restart'));
      return;
    }
    try {
      const checkpoint = await createCheckpointCompat(ctx, label);
      const checkpointId = checkpoint?.id || checkpoint || 'unknown';
      logInfo(L('已创建检查点', 'Checkpoint created'), `${checkpointId}${label ? ` (${label})` : ''}`);
    } catch (error: any) {
      logInfo(L('创建检查点失败', 'Checkpoint failed'), error.message);
    }
    return;
  }

  // 交互式菜单
  try {
    const stats = await getCheckpointStatsCompat(ctx).catch(() => null);
    const repositorySize = Number(stats?.repositorySize ?? 0);
    const legacyShadowSize = Number(stats?.shadowDirSize ?? 0);
    const storageTotal = Number(
      stats?.storageTotalSize ?? (repositorySize + legacyShadowSize)
    );
    const checkpointCount = Number(stats?.checkpointCount ?? 0);

    const menuTitle = stats
      ? L(`检查点 · 占用 ${formatBytes(storageTotal)} · ${checkpointCount} 个`, `Checkpoints · ${formatBytes(storageTotal)} · ${checkpointCount}`)
      : L('检查点', 'Checkpoints');
    void repositorySize; void legacyShadowSize;

    const onOff = isEnabled ? L('已开', 'on') : L('已关', 'off');
    const choices = [
      { label: `${L('自动检查点', 'Auto checkpoints')} — ${onOff}`, value: 'toggle', description: L('每轮开始前自动存档, 回车切换', 'Saved before each turn · enter to toggle') },
      { label: L('现在创建一个', 'Create one now'), value: 'create' },
      { label: L('查看 / 回滚', 'Browse / roll back'), value: 'list' },
      { label: L('清理', 'Clean up'), value: 'cleanup', description: L('删除旧检查点释放空间', 'Delete old checkpoints to free space') },
    ];

    const selected = await promptSelect(menuTitle, choices, '');

    if (selected === 'toggle') {
      const newVal = !isEnabled;
      const updated = { ...config, experimental: { ...config.experimental, enableCheckpoint: newVal } };
      saveConfig(updated);
      logInfo(
        newVal ? L('自动检查点已开', 'Checkpoints enabled') : L('自动检查点已关', 'Checkpoints disabled'),
        L('重启后生效', 'Takes effect after restart'),
      );
    } else if (selected === 'create') {
      if (!isEnabled) {
        logInfo(L('检查点没开', 'Checkpoints are off'), L('先打开自动检查点再重启', 'Turn on auto checkpoints and restart'));
        return;
      }
      try {
        const checkpoint = await createCheckpointCompat(ctx);
        const checkpointId = checkpoint?.id || checkpoint || 'unknown';
        logInfo(L('已创建检查点', 'Checkpoint created'), checkpointId);
      } catch (error: any) {
        logInfo(L('创建检查点失败', 'Checkpoint failed'), error.message);
      }
    } else if (selected === 'list') {
      await handleCheckpointsCommand(ctx);
    } else if (selected === 'cleanup') {
      try {
        await cleanupCheckpointsCompat(ctx);
        logInfo(L('已清理', 'Cleaned up'), L('旧检查点和遗留快照已删除', 'Old checkpoints and legacy snapshots removed'));
      } catch (error: any) {
        logInfo(L('清理失败', 'Cleanup failed'), error.message);
      }
    }
  } catch (error: any) {
    if (error.message !== 'cancelled') {
      logInfo(L('检查点菜单出错', 'Checkpoint menu failed'), error.message);
    }
  }
}

/**
 * Handle /checkpoints command - list checkpoints (interactive)
 * 直接调用 /rollback 的交互式菜单
 */
export async function handleCheckpointsCommand(ctx: CommandContext): Promise<void> {
  // 直接复用 /rollback 的交互式选择逻辑
  return handleRollbackCommand(ctx);
}

/**
 * Handle /rollback command - rollback to checkpoint (interactive)
 */
export async function handleRollbackCommand(
  ctx: CommandContext,
  checkpointId?: string
): Promise<void> {
  const { normalizeCheckpoints, promptSelect, logInfo } = ctx;
  const logRolledBack = (id: string, result: any) =>
    logInfo(L(`已回滚到 ${id}`, `Rolled back to ${id}`), formatRollbackSummary(result));

  try {
    // 如果提供了 checkpointId，直接回滚
    if (checkpointId) {
      const result = await rollbackCheckpointCompat(ctx, checkpointId);
      logRolledBack(checkpointId, result);
      return;
    }

    // 交互式选择 checkpoint
    const checkpoints = normalizeCheckpoints(await listCheckpointsCompat(ctx));
    if (checkpoints.length === 0) {
      logInfo(
        L('还没有检查点', 'No checkpoints yet'),
        L('/checkpoint 打开自动检查点并重启, 之后每轮开始前会自动存档', 'Turn them on in /checkpoint and restart — one is saved before each turn'),
      );
      return;
    }

    // 分类 checkpoints
    const sessionStart = checkpoints.find(cp => cp.name === 'session_start');
    const turnCheckpoints = checkpoints.filter(cp => cp.name?.startsWith('turn_'));
    const manualCheckpoints = checkpoints.filter(
      cp => cp.name !== 'session_start' && !cp.name?.startsWith('turn_')
    );

    // 构建选择列表
    const choices: Array<{ label: string; value: string; description?: string }> = [];

    // Back 选项
    choices.push({ label: L('← 返回', '← Back'), value: '__back__' });
    choices.push({ label: L('手动输入检查点 ID', 'Enter a checkpoint ID'), value: '__manual__' });

    // Session Start
    if (sessionStart) {
      const date = new Date(sessionStart.timestamp).toLocaleString();
      choices.push({ label: `${sessionStart.id} — ${L('会话开始', 'Session start')}, ${date}`, value: sessionStart.id });
    }

    // Turn Checkpoints (最新的在前)
    turnCheckpoints
      .slice()
      .reverse()
      .forEach((cp) => {
        const date = new Date(cp.timestamp).toLocaleString();
        const turnMatch = cp.name?.match(/turn_(\d+)/);
        const turnLabel = turnMatch ? L(`第 ${turnMatch[1]} 轮`, `Turn ${turnMatch[1]}`) : cp.name;
        choices.push({ label: `${cp.id} — ${turnLabel}, ${date}`, value: cp.id });
      });

    // Manual Checkpoints
    manualCheckpoints.forEach((cp) => {
      const date = new Date(cp.timestamp).toLocaleString();
      choices.push({ label: `${cp.id} — ${cp.name || L('未命名', 'unnamed')}, ${date}`, value: cp.id });
    });

    // 显示交互式菜单
    const selectedId = await promptSelect(L('回滚到哪个检查点', 'Roll back to which checkpoint'), choices);

    // 处理特殊值
    if (selectedId === '__back__') {
      return;
    }



    if (selectedId === '__manual__') {
      // 手动输入 checkpoint ID
      const { promptText } = ctx;
      if (!promptText) {
        logInfo(L('这里不支持手动输入', 'Manual input not supported'), L('用 /rollback <id>', 'Use /rollback <id>'));
        return;
      }
      const manualId = await promptText(L('检查点 ID', 'Checkpoint ID'), { allowEmpty: false });
      if (!manualId) {
        return;
      }
      logRolledBack(manualId, await rollbackCheckpointCompat(ctx, manualId));
      return;
    }

    // 执行回滚
    logRolledBack(selectedId, await rollbackCheckpointCompat(ctx, selectedId));
  } catch (error: any) {
    if (error.message !== 'cancelled') {
      logInfo(L('回滚失败', 'Rollback failed'), error.message);
    }
  }
}

/**
 * Handle /session-clear command - clear session
 */
export async function handleSessionClearCommand(ctx: CommandContext): Promise<void> {
  const { colors, promptSelect } = ctx;

  // 破坏性操作: 清空当前会话内容不可恢复 → 先确认 (Ink 安全的 promptSelect)
  try {
    const choice = await promptSelect(
      '清空当前会话内容? 此操作不可恢复',
      [
        { label: '取消', value: 'cancel' },
        { label: '确认清空', value: 'confirm' },
      ],
      'cancel',
    );
    if (choice !== 'confirm') {
      outputToUI(ctx, [colors.dim('  已取消')]);
      return;
    }
  } catch {
    // 取消/中断 → 不清
    outputToUI(ctx, [colors.dim('  已取消')]);
    return;
  }

  try {
    const sessionId = ctx.currentSession?.sessionId;
    if (ctx.sdkClient && sessionId) {
      await ctx.sdkClient.clearSession(sessionId);
    } else if (sessionId) {
      /* 没有 sdkClient (in-process 场景) → 直接清本地会话消息 */
      await ctx.sessionManager.deleteSession(sessionId);
    } else {
      throw new Error('当前没有活动会话');
    }
    outputToUI(ctx, ['', colors.success('  ✓ Session cleared'), '']);
  } catch (error: any) {
    outputToUI(ctx, [colors.error(`  [x] Failed to clear session: ${error.message}`)]);
  }
}

/**
 * Handle /session-export command - export session
 */
export async function handleSessionExportCommand(
  ctx: CommandContext,
  filePath?: string
): Promise<void> {
  const { currentSession, sessionManager, colors } = ctx;

  if (!currentSession) {
    outputToUI(ctx, [colors.error('  [x] No active session')]);
    return;
  }

  try {
    const sessionId = currentSession.sessionId;
    const exported = await sessionManager.exportSession(sessionId);

    // 无路径时默认落盘到 ~/.neox/exports/ (避免把整段 JSON 喷进聊天流刷屏)
    let target = filePath;
    if (!target) {
      const dir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'exports');
      await fs.promises.mkdir(dir, { recursive: true });
      target = path.join(dir, `session-${sessionId}.json`);
    }
    await fs.promises.writeFile(target, exported, 'utf-8');
    outputToUI(ctx, ['', colors.success(`  ✓ Session exported to: ${target}`), '']);
  } catch (error: any) {
    outputToUI(ctx, [colors.error(`  [x] Export failed: ${error.message}`)]);
  }
}

/**
 * Handle /compact command - manually compact conversation
 */
export async function handleCompactCommand(
  ctx: CommandContext,
  isRunning: boolean
): Promise<boolean> {
  const { sessionEnabled, compatProfile, uiController, sdkClient, currentSession, logInfo, colors } = ctx;
  let { autoCompactionInProgress } = ctx;

  if (!sessionEnabled) {
    logInfo('会话已禁用', '压缩仅适用于启用了持久化的会话。');
    return autoCompactionInProgress;
  }
  if (!compatProfile) {
    logInfo('缺少模型上下文画像', '请检查 Provider/Model 配置。');
    return autoCompactionInProgress;
  }
  if (isRunning) {
    logInfo('正在执行任务', '请等待当前任务完成或按 ESC 两次中断后再压缩。');
    return autoCompactionInProgress;
  }
  if (autoCompactionInProgress) {
    logInfo('压缩进行中', '请稍候片刻。');
    return autoCompactionInProgress;
  }
  if (!sdkClient || !currentSession) {
    logInfo('压缩不可用', '未连接到服务端或无活跃会话。');
    return autoCompactionInProgress;
  }

  // 检查对话是否有足够内容需要压缩
  try {
    const stats = await sdkClient.getMemoryStats(currentSession.sessionId);
    if (!stats || stats.length <= 0) {
      logInfo('无内容需要压缩', '当前对话为空，没有可压缩的内容。');
      return autoCompactionInProgress;
    }
  } catch {
    // 获取统计失败时不阻塞，继续尝试压缩
  }

  autoCompactionInProgress = true;

  try {
    if (uiController) {
      if (typeof uiController.beginCompaction === 'function') {
        uiController.beginCompaction();
      }
      uiController.updateStatus('Compact starting…', 'compacting');
    }

    const runWithEvents = ctx.withRuntimeEvents ?? (async (action) => action());
    await runWithEvents(() => sdkClient.compactSession(currentSession.sessionId));

    // 终态文案由 compacting 事件写入 (无需压缩 / 压缩完成); 这里只兜底释放 compact busy
    if (uiController) {
      if (typeof uiController.endCompaction === 'function') {
        uiController.endCompaction();
      } else {
        uiController.setRunning?.(false);
      }
    }
  } catch (error: any) {
    logInfo('手动压缩失败', error?.message || String(error));
    if (uiController) {
      uiController.updateStatus('Compaction failed', 'error');
      uiController.addInfo('✗ 压缩失败', error?.message || String(error));
      if (typeof uiController.endCompaction === 'function') {
        uiController.endCompaction();
      } else {
        uiController.setRunning?.(false);
      }
    }
  } finally {
    autoCompactionInProgress = false;
  }

  return autoCompactionInProgress;
}
