/**
 * diagLogGate — 诊断日志的唯一开关
 *
 * 默认不写诊断日志，因为诊断内容可能包含用户路径、工具参数和中间推理，同时持续写入会占用磁盘。
 *
 * 开关口径:
 *   · NEOX_DIAG_LOG=1 — 总开关, 打开全部诊断日志
 *   · NEOX_DIAG_LOG=<a,b,c> — 只开指定通道 (如 `mobile-bridge,explore`)
 *   · --debug / --debug-console — CLI 沿用既有习惯 (cliLogger 本来就这么判)
 *
 * **不归这个开关管**的东西 (它们不是"日志"):
 *   · ~/.neox/tasks/*.log — 后台进程的 stdout/stderr, bash_output 工具要读它,
 *                             关掉等于功能没了。
 *   · crash-*.json — 崩溃现场, 每次几 KB, 出事后唯一的线索。
 *   · llm-traces / llm-requests — 本来就是 opt-in (NEOX_DEBUG_REQUEST /
 *                             NEOX_DUMP_LLM_PAYLOAD), 不用再加一道。
 */

let cached: { raw: string; all: boolean; channels: Set<string> } | null = null;

function parse(): { raw: string; all: boolean; channels: Set<string> } {
  const raw = (process.env.NEOX_DIAG_LOG ?? '').trim();
  if (!cached || cached.raw !== raw) {
    const all = raw === '1' || raw.toLowerCase() === 'all' || raw.toLowerCase() === 'true';
    const channels = new Set(
      raw && !all ? raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : [],
    );
    cached = { raw, all, channels };
  }
  return cached;
}

/**
 * 这个通道的诊断日志该不该写。
 * @param channel 通道名 (如 'tool-trace' / 'explore' / 'mobile-bridge' / 'workspace-watcher')
 */
export function isDiagLogEnabled(channel: string): boolean {
  const { all, channels } = parse();
  if (all) return true;
  if (channels.size === 0) return false;
  return channels.has(channel.toLowerCase());
}

/** CLI 的 --debug 同样算打开 (沿用既有习惯, 不逼用户学新开关) */
export function isCliDebugFlagPresent(): boolean {
  try {
    return process.argv.includes('--debug') || process.argv.includes('--debug-console');
  } catch {
    return false;
  }
}
