import { spawn as nodeSpawn } from 'child_process';

/** Windows 上延时 N 秒后强杀 `pid` 的 cmd 命令行 (ping 不读 stdin, stdio:'ignore' 下也能等) */
export function windowsDelayedKillCommand(pid: number, delaySeconds: number): string {
  /* ping -n N = 发 N 个包, 间隔 1 秒 → 大约 N-1 秒。至少 2 个包才是真延时。 */
  const pings = Math.max(2, Math.floor(delaySeconds) + 1);
  return `ping -n ${pings} 127.0.0.1 >nul 2>&1 & taskkill /f /pid ${pid} >nul 2>&1`;
}

/**
 * 起一个退出看门狗: `delaySeconds` 秒后 `kill -9` 当前进程。
 * 失败静默 —— 看门狗起不来时, 调用方的正常退出仍然照走。
 */
export function spawnExitWatchdog(pid: number = process.pid, delaySeconds = 1): void {
  try {
    const child = process.platform === 'win32'
      ? nodeSpawn(
          'cmd.exe',
          ['/c', windowsDelayedKillCommand(pid, delaySeconds)],
          /* 不要 detached: 那会让 Windows 新开一个控制台窗口 (即使 windowsHide:true)。 */
          { stdio: 'ignore', windowsHide: true },
        )
      : nodeSpawn(
          '/bin/sh',
          ['-c', `sleep ${Math.max(0.3, delaySeconds / 3).toFixed(1)}; kill -9 ${pid} 2>/dev/null`],
          { detached: true, stdio: 'ignore' },
        );
    child.unref();
  } catch {
    /* ignore — 即使看门狗起不来, process.exit 仍尝试退 */
  }
}
