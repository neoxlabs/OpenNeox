
import * as path from 'path';
import type { CommandContext } from './types.js';
import { cliPrintln } from '../utils/output.js';
import { getLanguage } from '../i18n/index.js';

const L = (zh: string, en: string): string => (getLanguage() === 'zh' ? zh : en);

interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  additions: number;
  deletions: number;
}

interface TurnChanges {
  commit: string;
  timestamp: number;
  label: string;
  files: ChangedFile[];
}

interface SessionChanges {
  turns: TurnChanges[];
  files: ChangedFile[];
  /** core 的统一结构 (EDIT-02); 老服务端没有时退回 files */
  changeSet?: { files: ChangedFile[] };
  /** 快照与 checkpoint 对账结果 (EDIT-06): 每个文件的磁盘哈希 / 能否撤销 */
  reconciliation?: {
    turnCommit?: string;
    files: Array<{ path: string; unchanged: boolean | null }>;
  };
}

/** 单个文件的护栏结果: 磁盘现在的内容与「那一轮改完后」是否一致 */
interface FileGuard {
  unchanged: boolean;
  reason?: 'user-modified' | 'unknown';
  error?: string;
}

export interface UndoOptions {
  /** 跳过护栏强制恢复 (用户明确要覆盖自己两轮之间的手改) */
  force?: boolean;
}

function outputToUI(ctx: { outputLines?: (lines: string[]) => void }, lines: string[]): void {
  if (ctx.outputLines) {
    ctx.outputLines(lines);
  } else {
    lines.forEach(line => cliPrintln(line));
  }
}

const STATUS_TEXT: Record<ChangedFile['status'], { zh: string; en: string }> = {
  A: { zh: '新建', en: 'new' },
  M: { zh: '修改', en: 'edit' },
  D: { zh: '删除', en: 'del' },
  R: { zh: '重命名', en: 'mv' },
};

function statusText(status: ChangedFile['status']): string {
  const entry = STATUS_TEXT[status] ?? STATUS_TEXT.M;
  return L(entry.zh, entry.en);
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function fileLine(
  colors: CommandContext['colors'],
  file: ChangedFile,
  width: number,
  suffix?: string,
): string {
  const counts = `+${file.additions} −${file.deletions}`;
  const base = `  ${colors.dim(statusText(file.status))}  ${padRight(file.path, width)}  ${colors.info(counts)}`;
  return suffix ? `${base}  ${colors.warning(suffix)}` : base;
}

/** 用户可能给相对路径 / 绝对路径 / 带引号 —— 统一成工作区相对路径再和清单比对 */
function normalizeTarget(workspacePath: string | undefined, target: string): string {
  const cleaned = target.trim().replace(/^['"]|['"]$/g, '');
  const base = workspacePath || process.cwd();
  const relative = path.relative(base, path.resolve(base, cleaned));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return cleaned.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 撤销前的护栏: 逐个文件问 core「磁盘现在的内容和那一轮改完后一致吗」。
 *
 * 不一致 = 用户之后自己改过这个文件, 整文件覆盖会把他的改动一起抹掉 → 跳过。
 * 查不到 (老服务端 / git 出错) 一律按「跳过」处理: 宁可少撤一个, 也不覆盖用户的改动。
 */
async function collectGuards(
  ctx: CommandContext,
  files: ChangedFile[],
  turnOf: (filePath: string) => TurnChanges | undefined,
  known?: Map<string, FileGuard> | null,
): Promise<Map<string, FileGuard>> {
  const guards = new Map<string, FileGuard>();
  for (const file of files) {
    const cached = known?.get(file.path);
    if (cached) {
      guards.set(file.path, cached);
      continue;
    }
    const turn = turnOf(file.path);
    const check = ctx.sdkClient?.isFileUnchangedSinceCommit;
    if (!turn || typeof check !== 'function') {
      /* 拿不到那一轮的提交 = 没法比 —— 跟没加护栏之前的行为一致, 照常撤销 */
      guards.set(file.path, { unchanged: true });
      continue;
    }
    try {
      guards.set(file.path, await check.call(ctx.sdkClient, turn.commit, file.path));
    } catch (error: any) {
      guards.set(file.path, { unchanged: false, reason: 'unknown', error: String(error?.message ?? error) });
    }
  }
  return guards;
}

function guardSuffix(guard: FileGuard | undefined): string | undefined {
  if (!guard || guard.unchanged) return undefined;
  return guard.reason === 'unknown'
    ? L('无法确认是否改过, 跳过', 'couldn’t verify — skipped')
    : L('你之后改过, 跳过', 'edited by you since — skipped');
}

/**
 * 对账结果直接当护栏用 (EDIT-06)。
 *
 * core 在 /checkpoint/session-changes?reconcile=1 里已经逐个文件比过哈希, 这里不再
 * 一个文件发一次请求。对账只覆盖**最近一轮**, 清单里有更早轮次的文件时才回退到逐个查。
 */
function guardsFromReconciliation(changes: SessionChanges): Map<string, FileGuard> | null {
  const files = changes.reconciliation?.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const guards = new Map<string, FileGuard>();
  for (const file of files) {
    if (!file?.path) continue;
    guards.set(file.path, file.unchanged === true
      ? { unchanged: true }
      : { unchanged: false, reason: file.unchanged === false ? 'user-modified' : 'unknown' });
  }
  return guards;
}

async function isCheckpointOn(ctx: CommandContext): Promise<boolean> {
  if (!ctx.sdkClient) return false;
  try {
    return await ctx.sdkClient.isCheckpointEnabled();
  } catch {
    /* 查不到就当开着 —— 跟桌面回滚按钮同一口径, 别把人往一个无关的开关上指 */
    return true;
  }
}

async function fetchSessionChanges(ctx: CommandContext): Promise<SessionChanges | null> {
  const sessionId = ctx.currentSession?.sessionId;
  if (!ctx.sdkClient || !sessionId) {
    ctx.logInfo(L('没有活动会话', 'No active session'), L('先进入一个会话再试', 'Start a session first'));
    return null;
  }
  try {
    /* reconcile=1: 顺带拿回每个文件的哈希对账结果, 省掉后面逐个文件查一次 (EDIT-06) */
    const raw = await ctx.sdkClient.getSessionChanges(sessionId, { reconcile: true });
    return {
      turns: Array.isArray(raw?.turns) ? raw.turns : [],
      /* ChangeSet 是唯一结构 (EDIT-02); 老服务端没有时退回 files */
      files: Array.isArray(raw?.changeSet?.files)
        ? raw.changeSet.files
        : (Array.isArray(raw?.files) ? raw.files : []),
      changeSet: raw?.changeSet,
      reconciliation: raw?.reconciliation,
    };
  } catch (error: any) {
    ctx.logInfo(
      L('查询本会话改动失败', 'Failed to list this session’s changes'),
      error?.message ? String(error.message) : String(error),
    );
    return null;
  }
}

/**
 * /changes —— 列出本会话 agent 改过的文件 (路径 · 新建/修改/删除 · 行数)
 */
export async function handleChangesCommand(ctx: CommandContext): Promise<void> {
  const changes = await fetchSessionChanges(ctx);
  if (!changes) return;

  if (changes.files.length === 0) {
    const on = await isCheckpointOn(ctx);
    ctx.logInfo(
      L('本会话还没有文件改动', 'No file changes in this session'),
      on
        ? L('agent 还没改过文件; 改过之后再敲 /changes', 'The agent hasn’t edited any file yet')
        : L('文件快照没开: /checkpoint 打开后重启 CLI 才有撤销能力', 'File snapshots are off — turn them on with /checkpoint and restart'),
    );
    return;
  }

  const width = Math.min(60, Math.max(...changes.files.map(f => f.path.length)));
  const lines: string[] = [
    '',
    `  ${ctx.colors.highlight(L(
      `本会话改动 ${changes.files.length} 个文件`,
      `${changes.files.length} file(s) changed in this session`,
    ))}`,
  ];
  for (const file of changes.files) lines.push(fileLine(ctx.colors, file, width));

  const lastTurn = changes.turns[0];
  if (lastTurn) {
    lines.push(
      '',
      `  ${ctx.colors.dim(L(
        `最近一次文件改动: ${formatWhen(lastTurn.timestamp)} (${lastTurn.files.length} 个文件) · /undo 撤销`,
        `Last file change: ${formatWhen(lastTurn.timestamp)} (${lastTurn.files.length} file(s)) · /undo to revert`,
      ))}`,
    );
  }
  lines.push('');
  outputToUI(ctx, lines);
}

/**
 * /undo [文件] [--force] —— 撤销上一轮 (或指定文件) 的 agent 文件改动
 *
 * 撤前先逐个文件比一次内容: 磁盘现在的内容和「那一轮改完后」不一致 = 用户在两轮之间
 * 手改过 → 这个文件跳过, 不覆盖用户的手改; 用户确实要覆盖时用 --force。
 * 先列出要恢复的文件, 用户确认后才动磁盘; 撤销完在会话记忆里插一条说明。
 */
export async function handleUndoCommand(
  ctx: CommandContext,
  target?: string,
  options: UndoOptions = {},
): Promise<void> {
  const { logInfo, promptSelect } = ctx;

  if (ctx.isRunning) {
    logInfo(
      L('正在跑一轮, 先停止再撤销', 'A turn is running — stop it before undoing'),
      L('回合还在写文件, 现在撤销会和它的改动打架', 'It’s still writing files; undoing now would fight with it'),
    );
    return;
  }

  const changes = await fetchSessionChanges(ctx);
  if (!changes) return;

  if (changes.turns.length === 0) {
    const on = await isCheckpointOn(ctx);
    logInfo(
      L('没有可撤销的改动', 'Nothing to undo'),
      on
        ? L('本会话 agent 还没改过文件', 'The agent hasn’t edited any file in this session')
        : L('文件快照没开: /checkpoint 打开后重启 CLI 才有撤销能力', 'File snapshots are off — turn them on with /checkpoint and restart'),
    );
    return;
  }

  /* 没改文件的回合不留提交, 所以 turns[0] 是「最近一次真的改过文件的那一轮」——
   * 把它的时间写进标题, 用户能看出自己撤的是哪一轮 (纯聊天的回合不在清单里)。 */
  const lastTurn = changes.turns[0]!;
  /* 每个文件归「最近一次改过它的那一轮」—— 护栏就用那一轮的提交做基准 */
  const turnOf = (filePath: string) => changes.turns.find(t => t.files.some(f => f.path === filePath));
  let files: ChangedFile[];
  if (target) {
    const wanted = normalizeTarget(ctx.workspacePath, target);
    const hit = changes.files.find(f => f.path === wanted);
    if (!hit) {
      logInfo(
        L(`本会话没改过 ${target}`, `${target} wasn’t changed in this session`),
        L('先 /changes 看清单', 'Run /changes to see the list'),
      );
      return;
    }
    files = [hit];
  } else {
    files = lastTurn.files;
  }

  /* --force = 用户明确要覆盖自己的手改, 不查; 否则逐个比对 (见 collectGuards)。
   * 对账结果能直接当护栏用的文件不再单独发请求 (EDIT-06)。 */
  const force = options.force === true;
  const known = force ? null : guardsFromReconciliation(changes);
  const guards = force ? new Map<string, FileGuard>() : await collectGuards(ctx, files, turnOf, known);
  const restorable = files.filter(file => force || guards.get(file.path)?.unchanged === true);
  const skipped = files.filter(file => !restorable.includes(file));

  const turn = turnOf(files[0]!.path) ?? lastTurn;
  const width = Math.min(60, Math.max(...files.map(f => f.path.length)));
  const lines: string[] = [
    '',
    `  ${ctx.colors.highlight(
      target
        ? L(
          `撤销 ${files[0]!.path} 的改动 (来自 ${formatWhen(turn.timestamp)} 那一轮, 该轮共改 ${turn.files.length} 个文件)`,
          `Undo changes to ${files[0]!.path} (from the ${formatWhen(turn.timestamp)} turn, ${turn.files.length} file(s) that turn)`,
        )
        : L(
          `撤销 ${formatWhen(lastTurn.timestamp)} 那一轮的文件改动 (该轮共改 ${lastTurn.files.length} 个文件)`,
          `Undo the file changes from ${formatWhen(lastTurn.timestamp)} (${lastTurn.files.length} file(s) that turn)`,
        ),
    )}`,
  ];
  for (const file of files) {
    lines.push(fileLine(ctx.colors, file, width, guardSuffix(guards.get(file.path))));
  }
  if (skipped.length > 0) {
    lines.push(`  ${ctx.colors.dim(L(
      `跳过 ${skipped.length} 个你之后手改过的文件; 要强制恢复: /undo <文件> --force`,
      `Skipping ${skipped.length} file(s) you edited since; force with: /undo <file> --force`,
    ))}`);
  }
  lines.push('');
  outputToUI(ctx, lines);

  if (restorable.length === 0) {
    logInfo(
      L('这些文件你之后都改过, 没有撤销', 'You edited these files after that turn — nothing was undone'),
      target
        ? L(`要覆盖你的改动: /undo ${files[0]!.path} --force`, `To overwrite your edits: /undo ${files[0]!.path} --force`)
        : L('要覆盖你的改动: /undo <文件> --force', 'To overwrite your edits: /undo <file> --force'),
    );
    return;
  }

  const skipPart = skipped.length > 0
    ? L(`；跳过 ${skipped.length} 个你之后改过的`, `; skipping ${skipped.length} you edited since`)
    : '';
  let answer: string;
  try {
    answer = await promptSelect(
      L(
        `把 ${restorable.length} 个文件恢复到改动之前?${skipPart}`,
        `Restore ${restorable.length} file(s) to before that turn?${skipPart}`,
      ),
      [
        { label: L('取消', 'Cancel'), value: 'n' },
        { label: L('撤销', 'Undo'), value: 'y' },
      ],
      'n',
    );
  } catch {
    /* Esc / 取消 —— 什么都不做 */
    return;
  }
  if (answer !== 'y') {
    logInfo(L('已取消', 'Cancelled'));
    return;
  }

  const restored: string[] = [];
  /** 列清单之后、真正撤销之前又被改了 —— core 那边会再核一次护栏, 这里是让用户知道为什么没撤 */
  const skippedNow: string[] = [];
  const failed: Array<{ path: string; error?: string }> = [];
  try {
    const result = await ctx.sdkClient!.revertTurn(turn.commit, {
      files: restorable.map(file => file.path),
      guardCommit: turn.commit,
      force,
    });
    for (const path of Array.isArray(result?.restored) ? result.restored : []) restored.push(path);
    for (const item of Array.isArray(result?.skipped) ? result.skipped : []) {
      if (item?.path) skippedNow.push(item.path);
    }
    for (const item of Array.isArray(result?.failed) ? result.failed : []) {
      if (item?.path && item.path !== '*') failed.push({ path: item.path, error: item.error });
      else if (item?.error) failed.push({ path: '?', error: item.error });
    }
  } catch (error: any) {
    for (const file of restorable) {
      failed.push({ path: file.path, error: String(error?.message ?? error) });
    }
  }

  const skippedAll = skipped.map(f => f.path);
  /* 让模型知道磁盘被还原了 —— 否则它下一轮还会按「文件里是我改过的内容」推理 */
  const sessionId = ctx.currentSession?.sessionId;
  if (sessionId && restored.length > 0) {
    const failedPart = failed.length > 0
      ? L(`；${failed.map(f => f.path).join('、')} 撤销失败`, `; failed for ${failed.map(f => f.path).join(', ')}`)
      : '';
    const skippedPart = skippedAll.length + skippedNow.length > 0
      ? L(
        `；${[...skippedAll, ...skippedNow].join('、')} 因为用户之后手改过而跳过, 保持磁盘上的现有内容`,
        `; ${[...skippedAll, ...skippedNow].join(', ')} were skipped because the user edited them afterwards — their current content stands`,
      )
      : '';
    const note = L(
      `[撤销说明] 用户刚才用 /undo 把 ${restored.length} 个文件恢复到了那一轮改动之前（${restored.join('、')}）${skippedPart}${failedPart}。`
        + '请以磁盘上的当前内容为准，不要假设这些文件还是你改过的样子，也不要重复应用这些改动。',
      `[Undo note] The user just ran /undo and restored ${restored.length} file(s) to their state before that turn (${restored.join(', ')})${skippedPart}${failedPart}. `
        + 'Treat the files on disk as the current truth — do not assume your previous edits are still there, and do not re-apply them.',
    );
    try {
      await ctx.sdkClient!.addMemoryMessage(sessionId, 'user', note);
    } catch {
      /* 说明没插进去不影响撤销结果本身 */
    }
  }

  const notRestored = skippedAll.length + skippedNow.length;
  if (failed.length === 0 && notRestored === 0) {
    logInfo(
      L(`已撤销 ${restored.length} 个文件`, `Undid ${restored.length} file(s)`),
      L('已恢复到那一轮改动之前', 'Restored to before that turn'),
    );
    return;
  }
  const details: string[] = [];
  if (notRestored > 0) {
    const forcedHint = target
      ? L(`要强制恢复: /undo ${files[0]!.path} --force`, `To force: /undo ${files[0]!.path} --force`)
      : L('要强制恢复: /undo <文件> --force', 'To force: /undo <file> --force');
    details.push(L(
      `跳过: ${[...skippedAll, ...skippedNow].join('、')}（你之后改过，保持你的版本；${forcedHint}）`,
      `skipped: ${[...skippedAll, ...skippedNow].join(', ')} (you edited them since — your version kept; ${forcedHint})`,
    ));
  }
  if (failed.length > 0) details.push(failed.map(f => `${f.path}: ${f.error ?? 'unknown'}`).join('; '));
  logInfo(
    L(
      `撤销完成: ${restored.length} 个成功, ${notRestored} 个跳过, ${failed.length} 个失败`,
      `Undo finished: ${restored.length} ok, ${notRestored} skipped, ${failed.length} failed`,
    ),
    details.join(' | '),
  );
}
