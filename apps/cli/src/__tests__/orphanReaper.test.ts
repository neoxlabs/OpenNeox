import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  registerBackgroundProcess,
  listBackgroundProcessEntries,
  type BackgroundProcessEntry,
} from '@neoxlabs/platform/platform/backgroundProcessRegistry.js';
import { getProcessStartTimeMs, isPidAlive } from '@neoxlabs/platform/platform/processTree.js';
import { reapOrphanBackgroundProcesses } from '@neoxlabs/platform/platform/orphanReaper.js';
import { sweepOrphanBackgroundProcesses } from '../bootstrap/orphanBootSweep.js';

/**
 * TERM-08: 启动清扫孤儿后台进程。
 *
 * 用真实子进程 (sleep 的跨平台版: node setInterval) 造场景 —— 收尸的判据全部落在
 * "OS 上的 pid / 启动时间 / 命令行"上, mock 掉就没有意义了。
 */

const LONG_SCRIPT = 'setInterval(()=>{},1000)';
const children: ChildProcess[] = [];
let tmpDir: string;

function spawnLongLived(): { pid: number; command: string; child: ChildProcess } {
  const child = spawn(process.execPath, ['-e', LONG_SCRIPT], { detached: true, stdio: 'ignore' });
  child.unref();
  children.push(child);
  if (!child.pid) throw new Error('failed to spawn child');
  return { pid: child.pid, command: `${process.execPath} -e ${LONG_SCRIPT}`, child };
}

async function startTimeOf(pid: number): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const t = getProcessStartTimeMs(pid);
    if (t !== undefined) return t;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`pid ${pid} start time unavailable`);
}

/** 造一个真实存在过、且已经退出的 owner 进程。 */
async function deadOwner(): Promise<{ pid: number; startTime: number }> {
  const owner = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20)'], { stdio: 'ignore' });
  const pid = owner.pid!;
  const startTime = await startTimeOf(pid);
  await once(owner, 'exit');
  return { pid, startTime };
}

function makeEntry(overrides: Partial<BackgroundProcessEntry>): BackgroundProcessEntry {
  return {
    pid: 0,
    startTime: 0,
    command: '',
    cwd: os.tmpdir(),
    workspaceRoot: os.tmpdir(),
    ownerPid: 1,
    ownerStartTime: 1,
    createdAt: Date.now(),
    ...overrides,
  };
}

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 50));
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try { process.kill(child.pid!, 'SIGKILL'); } catch { /* already dead */ }
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('reapOrphanBackgroundProcesses', () => {
  it('父进程已退出 → 杀掉真实子进程并删掉登记', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-orphan-reap-'));
    const { pid, command } = spawnLongLived();
    const startTime = await startTimeOf(pid);
    const owner = await deadOwner();

    registerBackgroundProcess(makeEntry({
      pid, startTime, command,
      ownerPid: owner.pid, ownerStartTime: owner.startTime,
      sessionId: 'session-orphan',
    }), { runDir: tmpDir });

    const result = await reapOrphanBackgroundProcesses({ runDir: tmpDir, graceMs: 200 });

    expect(result.orphans.map(o => o.pid)).toEqual([pid]);
    expect(result.orphans[0].sessionId).toBe('session-orphan');
    expect(result.reaped).toBe(1);
    await waitUntil(() => !isPidAlive(pid));
    expect(isPidAlive(pid)).toBe(false);
    expect(listBackgroundProcessEntries({ runDir: tmpDir })).toEqual([]);
  });

  it('owner 还活着 → 不是孤儿, 不杀也不删', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-orphan-alive-'));
    const { pid, command } = spawnLongLived();
    const startTime = await startTimeOf(pid);

    registerBackgroundProcess(makeEntry({
      pid, startTime, command,
      /* 本测试进程 = 还活着的 owner */
      ownerPid: process.pid,
      ownerStartTime: Math.round(Date.now() - process.uptime() * 1000),
    }), { runDir: tmpDir });

    const result = await reapOrphanBackgroundProcesses({ runDir: tmpDir, graceMs: 200 });

    expect(result.orphans).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(isPidAlive(pid)).toBe(true);
    expect(listBackgroundProcessEntries({ runDir: tmpDir })).toHaveLength(1);
  });

  it('pid 对但启动时间对不上 (pid 被复用) → 不杀, 只删死登记', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-orphan-reused-'));
    const { pid, command } = spawnLongLived();
    const startTime = await startTimeOf(pid);
    const owner = await deadOwner();

    registerBackgroundProcess(makeEntry({
      pid,
      startTime: startTime - 60_000,
      command,
      ownerPid: owner.pid, ownerStartTime: owner.startTime,
    }), { runDir: tmpDir });

    const result = await reapOrphanBackgroundProcesses({ runDir: tmpDir, graceMs: 200 });

    expect(result.reaped).toBe(0);
    expect(result.removed).toBe(1);
    expect(isPidAlive(pid)).toBe(true);
    expect(listBackgroundProcessEntries({ runDir: tmpDir })).toEqual([]);
  });

  it('命令对不上 → 不杀 (启动命令是第三道防线)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-orphan-cmd-'));
    const { pid } = spawnLongLived();
    const startTime = await startTimeOf(pid);
    const owner = await deadOwner();

    registerBackgroundProcess(makeEntry({
      pid, startTime,
      command: 'totally-different-command --port 9999',
      ownerPid: owner.pid, ownerStartTime: owner.startTime,
    }), { runDir: tmpDir });

    const result = await reapOrphanBackgroundProcesses({ runDir: tmpDir, graceMs: 200 });

    expect(result.reaped).toBe(0);
    expect(result.removed).toBe(1);
    expect(isPidAlive(pid)).toBe(true);
  });

  it('keep=true (--keep-orphans) → 列出来但不杀、不删', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-orphan-keep-'));
    const { pid, command } = spawnLongLived();
    const startTime = await startTimeOf(pid);
    const owner = await deadOwner();

    registerBackgroundProcess(makeEntry({
      pid, startTime, command,
      ownerPid: owner.pid, ownerStartTime: owner.startTime,
    }), { runDir: tmpDir });

    const result = await reapOrphanBackgroundProcesses({ runDir: tmpDir, graceMs: 200, keep: true });

    expect(result.orphans.map(o => o.pid)).toEqual([pid]);
    expect(result.reaped).toBe(0);
    expect(isPidAlive(pid)).toBe(true);
    expect(listBackgroundProcessEntries({ runDir: tmpDir })).toHaveLength(1);
  });

  it('CLI 启动清扫: 打印一行「清理了 N 个…」并真的结束孤儿', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-orphan-sweep-'));
    const { pid, command } = spawnLongLived();
    const startTime = await startTimeOf(pid);
    const owner = await deadOwner();

    registerBackgroundProcess(makeEntry({
      pid, startTime, command,
      ownerPid: owner.pid, ownerStartTime: owner.startTime,
    }), { runDir: tmpDir });

    const output: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => { output.push(String(chunk)); return true; };
    try {
      await sweepOrphanBackgroundProcesses({ keep: false, runDir: tmpDir });
    } finally {
      (process.stdout as any).write = originalWrite;
    }

    const line = output.join('');
    /* 文案跟 locale 走 (L() 双语), 只钉住"清了几条 + 是哪条" */
    expect(line).toMatch(/清理了 1 个|Cleaned up 1 background process/);
    expect(line).toContain(`pid ${pid}`);
    await waitUntil(() => !isPidAlive(pid));
    expect(isPidAlive(pid)).toBe(false);
  });

  it('进程已经死了 → 只删登记, 不去 kill', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-orphan-dead-'));
    const owner = await deadOwner();

    registerBackgroundProcess(makeEntry({
      pid: 999_999_999,
      startTime: Date.now() - 10_000,
      command: 'npm run dev',
      ownerPid: owner.pid, ownerStartTime: owner.startTime,
    }), { runDir: tmpDir });

    const result = await reapOrphanBackgroundProcesses({ runDir: tmpDir, graceMs: 100 });

    expect(result.reaped).toBe(0);
    expect(result.removed).toBe(1);
    expect(listBackgroundProcessEntries({ runDir: tmpDir })).toEqual([]);
  });
});
