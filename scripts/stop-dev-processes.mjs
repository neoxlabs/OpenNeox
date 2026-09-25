import { spawnSync } from 'node:child_process';

const ports = [5180, 4399];
const commandLinePatterns = [
  'apps/cli/dist/server/main.js',
  'commandExecWorkerEntry',
];

function killProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

function killPortListenersOnWindows(port) {
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  if (result.error) throw result.error;

  const pids = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue;
    if (fields[3].toUpperCase() !== 'LISTENING') continue;

    const localAddress = fields[1];
    if (localAddress.endsWith(`:${port}`)) {
      const pid = Number.parseInt(fields[4], 10);
      if (Number.isInteger(pid)) pids.add(pid);
    }
  }

  for (const pid of pids) killProcess(pid);
}

function killPortListenersOnUnix(port) {
  const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
  if (result.error) return;

  for (const value of result.stdout.split(/\s+/)) {
    const pid = Number.parseInt(value, 10);
    if (Number.isInteger(pid)) killProcess(pid);
  }
}

function killNamedProcessesOnWindows() {
  const command = [
    '$patterns = @($env:NEOX_CLEANUP_PATTERN_1, $env:NEOX_CLEANUP_PATTERN_2)',
    'Get-CimInstance Win32_Process |',
    'Where-Object {',
    '  $commandLine = $_.CommandLine',
    "  $commandLine -and ($patterns | Where-Object { $commandLine -like ('*' + $_ + '*') } | Select-Object -First 1)",
    '} |',
    'ForEach-Object { $_.ProcessId }',
  ].join(' ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEOX_CLEANUP_PATTERN_1: commandLinePatterns[0],
        NEOX_CLEANUP_PATTERN_2: commandLinePatterns[1],
      },
    },
  );

  if (result.error) throw result.error;
  for (const value of result.stdout.split(/\s+/)) {
    const pid = Number.parseInt(value, 10);
    if (Number.isInteger(pid)) killProcess(pid);
  }
}

function killNamedProcessesOnUnix() {
  for (const pattern of commandLinePatterns) {
    // pkill exits with 1 when no process matches, which is not an error here.
    spawnSync('pkill', ['-f', pattern], { stdio: 'ignore' });
  }
}

for (const port of ports) {
  if (process.platform === 'win32') killPortListenersOnWindows(port);
  else killPortListenersOnUnix(port);
}

if (process.platform === 'win32') killNamedProcessesOnWindows();
else killNamedProcessesOnUnix();
