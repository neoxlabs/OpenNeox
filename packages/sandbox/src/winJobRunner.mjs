#!/usr/bin/env node
/**
 * Win Job Object runner — neox-sandbox restricted-token 后端 spawn 入口。
 * argv: node winJobRunner.mjs [--cwd=] [--max-processes=N] -- <program> <args...>
 *
 * 有 koffi 时挂真正 Job Object (KILL_ON_JOB_CLOSE + ActiveProcessLimit)。
 * 无 koffi 时仍包装子进程并转发 stdio（比裸 spawn 多一层可杀树入口）。
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

function parseArgs(argv) {
  let cwd = process.cwd();
  let maxProcesses = 64;
  const rest = [];
  let seenSep = false;
  for (const a of argv) {
    if (!seenSep) {
      if (a === '--') {
        seenSep = true;
        continue;
      }
      if (a.startsWith('--cwd=')) {
        cwd = a.slice('--cwd='.length);
        continue;
      }
      if (a.startsWith('--max-processes=')) {
        maxProcesses = Math.max(1, Number.parseInt(a.slice('--max-processes='.length), 10) || 64);
        continue;
      }
      continue;
    }
    rest.push(a);
  }
  if (!seenSep || rest.length === 0) {
    throw new Error('usage: winJobRunner.mjs [--cwd=] [--max-processes=N] -- <program> <args...>');
  }
  return { cwd, maxProcesses, program: rest[0], args: rest.slice(1) };
}

async function tryAttachJob(pid, maxProcesses) {
  let koffi;
  try {
    koffi = (await import('koffi')).default;
  } catch {
    return { attached: false, close: () => {} };
  }
  try {
    const kernel32 = koffi.load('kernel32.dll');
    const CreateJobObjectW = kernel32.func('CreateJobObjectW', 'void*', ['void*', 'str16']);
    const SetInformationJobObject = kernel32.func('SetInformationJobObject', 'bool', [
      'void*',
      'int',
      'uint8*',
      'uint32',
    ]);
    const AssignProcessToJobObject = kernel32.func('AssignProcessToJobObject', 'bool', ['void*', 'void*']);
    const OpenProcess = kernel32.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32']);
    const CloseHandle = kernel32.func('CloseHandle', 'bool', ['void*']);

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    const JobObjectExtendedLimitInformationClass = 9;
    const PROCESS_ALL = 0x1F0FFF;

    const job = CreateJobObjectW(null, null);
    if (!job) return { attached: false, close: () => {} };

    /* JOBOBJECT_BASIC_LIMIT_INFORMATION + padding for EXTENDED (x64) */
    const buf = Buffer.alloc(144);
    buf.writeBigInt64LE(0n, 0); // PerProcessUserTimeLimit
    buf.writeBigInt64LE(0n, 8); // PerJobUserTimeLimit
    buf.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS, 16);
    // skip MinimumWorkingSetSize/MaximumWorkingSetSize (pointer-sized each)
    const ptrSize = process.arch === 'x64' || process.arch === 'arm64' ? 8 : 4;
    const activeOff = 16 + 4 + 4 + ptrSize * 2; // LimitFlags + pad + 2×size_t
    buf.writeUInt32LE(maxProcesses, activeOff);

    SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, buf, buf.length);

    const hProcess = OpenProcess(PROCESS_ALL, false, pid);
    if (!hProcess) {
      CloseHandle(job);
      return { attached: false, close: () => {} };
    }
    const ok = AssignProcessToJobObject(job, hProcess);
    CloseHandle(hProcess);
    if (!ok) {
      CloseHandle(job);
      return { attached: false, close: () => {} };
    }
    return {
      attached: true,
      close: () => {
        try {
          CloseHandle(job);
        } catch {
          /* */
        }
      },
    };
  } catch {
    return { attached: false, close: () => {} };
  }
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* */
  }
}

async function main() {
  const { cwd, maxProcesses, program, args } = parseArgs(process.argv.slice(2));

  const child = spawn(program, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (!child.pid) {
    console.error('[winJobRunner] spawn failed');
    process.exit(93);
  }

  const job = await tryAttachJob(child.pid, maxProcesses);

  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  const onSignal = () => {
    killTree(child.pid);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const code = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });

  job.close();
  process.exit(typeof code === 'number' ? code : 1);
}

main().catch((err) => {
  console.error('[winJobRunner]', err);
  process.exit(1);
});
