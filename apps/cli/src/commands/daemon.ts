/**
 * Daemon Command — 守护进程管理
 *
 * neox daemon start   — 启动后台 Server
 * neox daemon stop    — 停止后台 Server
 * neox daemon status  — 查看状态
 * neox daemon restart — 重启
 * neox daemon logs    — 查看日志
 * neox daemon install — 安装系统服务 (launchd/systemd)
 */

import { startDaemon, stopDaemon, getDaemonStatus, getLogFile } from '@neoxlabs/core/server/processManager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const NEOX_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME);

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export async function handleDaemonCommand(args: string[]): Promise<number> {
  const action = args[0] || 'status';

  switch (action) {
    case 'start':
      await daemonStart(args);
      return 0;
    case 'stop':
      await daemonStop();
      return 0;
    case 'restart':
      await daemonStop();
      await daemonStart(args);
      return 0;
    case 'status':
      await daemonStatus();
      return 0;
    case 'logs':
      daemonLogs(args);
      return 0;
    case 'install':
      await daemonInstall();
      return 0;
    case 'help':
    case '--help':
    case '-h':
      console.log('Usage: neox daemon <start|stop|restart|status|logs|install>');
      console.log('');
      console.log('  start [--port <n>] [--workdir <path>]   Start background server');
      console.log('  stop                                     Stop background server');
      console.log('  restart                                  Restart background server');
      console.log('  status                                   Show daemon status (default)');
      console.log('  logs [-n <lines>]                        Tail daemon log (default 50)');
      console.log('  install                                  Install system service (launchd/systemd)');
      return 0;
    default:
      process.stderr.write(`Error: unknown daemon subcommand "${action}"\n`);
      console.log('Usage: neox daemon <start|stop|restart|status|logs|install>');
      return 1;
  }
}

async function daemonStart(args: string[]): Promise<void> {
  const workDir = getArgValue(args, '--workdir') || process.cwd();
  const portStr = getArgValue(args, '--port');
  const port = portStr ? parseInt(portStr, 10) : undefined;

  console.log('Starting Neox daemon...');
  try {
    const result = await startDaemon(workDir, port);
    console.log(`Daemon started (pid: ${result.pid}, port: ${result.port})`);
    console.log(`Log: ${getLogFile()}`);
  } catch (e: any) {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
  }
}

async function daemonStop(): Promise<void> {
  console.log('Stopping Neox daemon...');
  const stopped = await stopDaemon();
  if (stopped) {
    console.log('Daemon stopped.');
  } else {
    console.log('No daemon running.');
  }
}

async function daemonStatus(): Promise<void> {
  const status = await getDaemonStatus();
  if (status.running) {
    console.log(`Status:  running`);
    console.log(`PID:     ${status.pid}`);
    console.log(`Port:    ${status.port}`);
    console.log(`WorkDir: ${status.workDir}`);
    console.log(`Uptime:  ${formatUptime(status.uptime ?? 0)}`);
    console.log(`Log:     ${status.logFile}`);
  } else {
    console.log('Status:  stopped');
    console.log(`Log:     ${status.logFile}`);
  }
}

function daemonLogs(args: string[]): void {
  const logFile = getLogFile();
  if (!fs.existsSync(logFile)) {
    console.log('No log file found.');
    return;
  }

  const lines = getArgValue(args, '-n') || '50';
  const content = fs.readFileSync(logFile, 'utf-8');
  const allLines = content.split('\n');
  const tail = allLines.slice(-parseInt(lines, 10));
  console.log(tail.join('\n'));
}

// ============================================================================
// Service Install — launchd (macOS) / systemd (Linux)
// ============================================================================

async function daemonInstall(): Promise<void> {
  const platform = process.platform;
  if (platform === 'darwin') {
    await installLaunchd();
  } else if (platform === 'linux') {
    await installSystemd();
  } else {
    console.log(`Platform "${platform}" not supported. Use "neox daemon start" manually.`);
  }
}

async function installLaunchd(): Promise<void> {
  const plistName = 'com.neox.server';
  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(plistDir, `${plistName}.plist`);

  // 找到 neox 可执行文件路径
  const neoxBin = process.argv[1] || 'neox';
  const nodeBin = process.execPath;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${neoxBin}</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${getLogFile()}</string>
  <key>StandardErrorPath</key>
  <string>${getLogFile()}</string>
  <key>WorkingDirectory</key>
  <string>${os.homedir()}</string>
</dict>
</plist>`;

  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true });
  }

  fs.writeFileSync(plistPath, plist);
  console.log(`Installed: ${plistPath}`);
  console.log('');
  console.log('To enable:');
  console.log(`  launchctl load ${plistPath}`);
  console.log('');
  console.log('To disable:');
  console.log(`  launchctl unload ${plistPath}`);
}

async function installSystemd(): Promise<void> {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'neox.service');

  const neoxBin = process.argv[1] || 'neox';
  const nodeBin = process.execPath;

  const service = `[Unit]
Description=Neox AI Server
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${neoxBin} daemon start
Restart=on-failure
RestartSec=5
StandardOutput=append:${getLogFile()}
StandardError=append:${getLogFile()}
WorkingDirectory=${os.homedir()}

[Install]
WantedBy=default.target
`;

  if (!fs.existsSync(serviceDir)) {
    fs.mkdirSync(serviceDir, { recursive: true });
  }

  fs.writeFileSync(servicePath, service);
  console.log(`Installed: ${servicePath}`);
  console.log('');
  console.log('To enable:');
  console.log('  systemctl --user daemon-reload');
  console.log('  systemctl --user enable neox');
  console.log('  systemctl --user start neox');
  console.log('');
  console.log('To disable:');
  console.log('  systemctl --user stop neox');
  console.log('  systemctl --user disable neox');
}

// ============================================================================
// Helpers
// ============================================================================

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}
