#!/usr/bin/env node

import { execSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

const DESKTOP_SERVER_PORT = Number.parseInt(process.env.NEOX_SERVER_PORT || '4500', 10);

const PORTS = [
  { port: 5180, why: 'Vite dev server' },
  { port: DESKTOP_SERVER_PORT, why: '桌面 dev 的本地 Neox server' },
];

const PATTERNS = [
  {
    pattern: `dist/server/main.js.*--port ${DESKTOP_SERVER_PORT}`,
    why: `上一次桌面 dev 残留的 server (--port ${DESKTOP_SERVER_PORT})`,
  },
];

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

/** 监听指定 TCP 端口的 pid 列表。 */
const pidsOnPort = (port) => {
  if (!IS_WIN) return sh(`lsof -ti:${port}`).split('\n').filter(Boolean);
  /* netstat 行形如: TCP  127.0.0.1:5180  0.0.0.0:0  LISTENING  12345 */
  return sh(`netstat -ano -p tcp`)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
    .map((l) => l.split(/\s+/).pop())
    .filter((pid) => pid && /^\d+$/.test(pid) && pid !== '0');
};

const describe = (pid) => {
  if (!IS_WIN) return sh(`ps -p ${pid} -o command=`).slice(0, 120) || '(已退出)';
  const cmdline = sh(
    `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
  );
  if (cmdline) return cmdline.slice(0, 160);
  const name = sh(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).split(',')[0] || '';
  return name ? `${name.replace(/"/g, '')} (命令行不可读)` : '(已退出)';
};

const killPid = (pid, hard) => {
  if (!IS_WIN) return sh(hard ? `kill -9 ${pid}` : `kill ${pid}`);
  /* Windows 没有 SIGTERM 的直接等价物; taskkill 不带 /F 只是"请"进程退出,
   * 对挂死的 dev 进程经常无效 —— 这里是清理残留, 统一 /T /F 并打印是谁。 */
  return sh(`taskkill /PID ${pid} /T /F`);
};

let killed = 0;

for (const { port, why } of PORTS) {
  const pids = pidsOnPort(port);
  for (const pid of pids) {
    const cmd = describe(pid);
    const isCli = /neox-cli\/dist\/cli\/main\.js|\bneox\b|Neox\.exe/i.test(cmd) && !cmd.includes('ui-electron');
    console.log(
      `${isCli ? '⚠️ ' : '· '}端口 ${port} (${why}) 被 pid ${pid} 占用 → 终止\n    ${cmd}` +
        (isCli ? '\n    ↑ 这看起来是你正在用的 CLI/客户端。桌面 dev 需要这个端口, 已终止它。' : ''),
    );
    killPid(pid, true);
    killed++;
  }
}

if (IS_WIN) {
  /* pgrep 与 PPID==1 都是 Unix 进程模型的概念, Windows 上不存在:
   * 命令行模糊匹配段与孤儿 worker 回收段整体跳过, 并明确说出来。 */
  console.log('· 进程命令行匹配 / 孤儿 worker 回收: Windows 上跳过 (依赖 pgrep 与 PPID, 无对应机制)');
} else {
  for (const { pattern, why } of PATTERNS) {
    const pids = sh(`pgrep -f '${pattern}'`).split('\n').filter(Boolean);
    for (const pid of pids) {
      console.log(`· 残留进程 pid ${pid} (${why}) → 终止\n    ${describe(pid)}`);
      killPid(pid, false);
      killed++;
    }
  }

  {
    const pids = sh(`pgrep -f 'commandExecWorkerEntry'`).split('\n').filter(Boolean);
    for (const pid of pids) {
      const ppid = sh(`ps -p ${pid} -o ppid=`).trim();
      if (ppid !== '1') continue;               // 还有活父进程 → 是别人在用的, 别碰
      console.log(`· 孤儿 worker pid ${pid} (父进程已退出) → 终止\n    ${describe(pid)}`);
      killPid(pid, false);
      killed++;
    }
  }
}

if (killed === 0) {
  console.log('· 端口与残留进程检查: 干净, 无需终止');
}
