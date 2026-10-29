import type { StepContent } from './types';

export interface BashOutputResult { status?: string; exit_code?: number | null; content?: string; wait_outcome?: string; total_lines?: number }

/** 工具结果 JSON → 结构; 不是 JSON (还在等 / 报错文本) = undefined */
export function parseBashOutputJson(raw: unknown): BashOutputResult | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? (j as BashOutputResult) : undefined;
  } catch {
    return undefined;
  }
}

export function bashOutputTitle(args: Record<string, unknown> | undefined, r: BashOutputResult | undefined, zh: boolean): string | undefined {
  const pattern = typeof args?.wait_for_pattern === 'string' ? args.wait_for_pattern.trim() : '';
  const timeoutMs = typeof args?.timeout === 'number' ? args.timeout : undefined;
  const pid = args?.pid;
  const clip = (s: string) => (s.length > 48 ? `${s.slice(0, 47)}…` : s);
  const secs = timeoutMs ? Math.round(timeoutMs / 1000) : undefined;
  if (!r) {
    /* 还在等 */
    if (pattern) {
      const head = zh ? '等待输出' : 'Waiting for output';
      const lim = secs ? (zh ? ` · 最长 ${secs}s` : ` · up to ${secs}s`) : '';
      return `${head} · ${zh ? '直到出现' : 'until'}「${clip(pattern)}」${lim}`;
    }
    return pid != null ? `${zh ? '查看输出' : 'Read output'} · pid ${pid}` : undefined;
  }
  switch (r.wait_outcome) {
    case 'pattern_matched': {
      /* 是哪一个分支命中的 —— 「启动成功|APPLICATION FAILED」两种结局意思完全相反 */
      const alts = pattern.split('|').map((s) => s.trim()).filter(Boolean);
      const hit = alts.find((a) => { try { return new RegExp(a).test(r.content ?? ''); } catch { return (r.content ?? '').includes(a); } });
      return `${zh ? '等到了' : 'Matched'} · 「${clip(hit ?? pattern)}」`;
    }
    case 'timeout':
      return zh ? `等了 ${secs ?? '?'}s 没等到 · 「${clip(pattern)}」` : `No match after ${secs ?? '?'}s · "${clip(pattern)}"`;
    case 'exited':
      return zh ? `进程已退出${r.exit_code != null ? ` (code ${r.exit_code})` : ''}` : `Process exited${r.exit_code != null ? ` (code ${r.exit_code})` : ''}`;
    default: {
      const lines = typeof r.total_lines === 'number' ? (zh ? ` · ${r.total_lines} 行` : ` · ${r.total_lines} lines`) : '';
      const st = r.status === 'running' ? (zh ? ' · 还在跑' : ' · running') : '';
      return `${zh ? '查看输出' : 'Read output'}${pid != null ? ` · pid ${pid}` : ''}${lines}${st}`;
    }
  }
}

/** 点开的内容: 终端卡只摆进程输出 (没有命令可显示); 还在等时不挂空 xterm (TerminalView 无输出不画) */
export function bashOutputContent(opts: {
  r: BashOutputResult | undefined;
  args: Record<string, unknown> | undefined;
  rawOutput: unknown;
  toolCallId?: string;
  pending?: boolean;
}): StepContent {
  const { r, args } = opts;
  const pid = typeof args?.pid === 'number' ? args.pid : undefined;
  const waiting = opts.pending || !r;
  return {
    type: 'terminal',
    output: r?.content ?? (typeof opts.rawOutput === 'string' && !r ? opts.rawOutput : ''),
    toolId: opts.toolCallId,
    pid,
    exitCode: waiting ? undefined : (r?.status === 'running' ? undefined : (r?.exit_code ?? 0)),
    streaming: waiting,
  };
}
