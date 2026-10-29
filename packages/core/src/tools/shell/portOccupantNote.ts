import { execFileSync } from 'node:child_process';

const IN_USE_RE = /address already in use|EADDRINUSE|port\s+\d+\s+is\s+(?:already\s+)?in use/i;

function portsMentioned(output: string, command: string): number[] {
  const ports = new Set<number>();
  for (const m of `${output}\n${command}`.matchAll(/(?:port|:)\s*(\d{2,5})\b|\b(\d{4,5})\b/gi)) {
    const n = Number(m[1] ?? m[2]);
    if (n >= 80 && n <= 65535) ports.add(n);
  }
  return [...ports].slice(0, 4);
}

export function portOccupantNote(output: string, command: string, zh = true): string {
  if (process.platform === 'win32' || !IN_USE_RE.test(output)) return '';
  const lines: string[] = [];
  for (const port of portsMentioned(output, command)) {
    let pids: string[] = [];
    try {
      pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 2000 })
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { continue; }
    for (const pid of pids.slice(0, 3)) {
      let cmd = '';
      try { cmd = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8', timeout: 2000 }).trim(); } catch { /* 进程刚退 */ }
      lines.push(`  - ${zh ? '端口' : 'port'} ${port}: pid ${pid}${cmd ? ` (${cmd.slice(0, 120)})` : ''}`);
    }
  }
  if (!lines.length) return '';
  return zh
    ? `\n⚠️ 你这次启动的进程没起来: 端口已被下面的进程占着。它们**不是你这次启动的** —— 不要停它, 也不要把它当成你的服务去验证/停止。告诉用户是谁占着, 由用户决定 (或换个端口起你自己的)。\n${lines.join('\n')}`
    : `\n⚠️ The process you started did not come up: the port is held by the process(es) below. They were **not started by you** — do not stop them, and do not treat them as your service. Tell the user who holds the port and let them decide (or use another port for your own).\n${lines.join('\n')}`;
}
