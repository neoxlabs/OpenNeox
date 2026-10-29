
export interface ExternalAgentResult {
  elapsedMs?: number;
  reason?: string;
  /** 失败原因里括号那段「怎么改」 —— 分开放, 原因一行说清 */
  hint?: string;
  tools: Array<{ name: string; count: number }>;
  branch?: string;
  files: string[];
  noChanges: boolean;
  output: string;
}

export function parseExternalAgentResult(text?: string): ExternalAgentResult {
  const out: ExternalAgentResult = { tools: [], files: [], noChanges: false, output: '' };
  if (!text) return out;

  const marker = /^--- .+ 的输出 ---$/m.exec(text);
  const head = marker ? text.slice(0, marker.index) : text;
  if (marker) out.output = text.slice(marker.index + marker[0].length).trim();

  const mins = /（(\d+(?:\.\d+)?) 分钟）/.exec(head);
  if (mins) out.elapsedMs = Math.round(Number(mins[1]) * 60_000);

  const reason = /^原因：(.+)$/m.exec(head)?.[1]?.trim();
  if (reason) {
    const m = /^(.*?)（(用的模型.+)）$/.exec(reason);
    out.reason = m ? m[1].trim() : reason;
    if (m) out.hint = m[2];
  }

  const tools = /^它执行了：(.+)$/m.exec(head)?.[1];
  if (tools) {
    for (const part of tools.split('、')) {
      const t = /^(.+)×(\d+)$/.exec(part.trim());
      if (t) out.tools.push({ name: t[1], count: Number(t[2]) });
    }
  }

  out.branch = /独立分支 `([^`]+)`/.exec(head)?.[1];
  const files = /^涉及 \d+ 个文件：(.+)$/m.exec(head)?.[1];
  if (files) out.files = files.split(', ').map((f) => f.trim()).filter(Boolean);
  out.noChanges = /（没有产生文件改动）/.test(head);

  /* 老格式 / 别的宿主给的纯文本: 一行结构都认不出, 整段就是输出 */
  if (!marker && !mins && !reason && !tools && !out.branch) out.output = text.trim();
  return out;
}

export function fmtAgentElapsed(ms?: number): string {
  if (!ms || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
