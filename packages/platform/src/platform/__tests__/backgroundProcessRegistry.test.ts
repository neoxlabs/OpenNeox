import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  backgroundRegistryDir,
  findBackgroundProcessEntry,
  listBackgroundProcessEntries,
  registerBackgroundProcess,
  removeBackgroundProcessEntry,
  type BackgroundProcessEntry,
} from '../backgroundProcessRegistry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-bg-registry-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entry(overrides: Partial<BackgroundProcessEntry> = {}): BackgroundProcessEntry {
  return {
    pid: 12345,
    startTime: 1_760_000_000_000,
    command: 'npm run dev',
    cwd: '/tmp/project',
    workspaceRoot: '/tmp/project',
    ownerPid: 999,
    ownerStartTime: 1_759_999_000_000,
    sessionId: 'session-abc',
    createdAt: 1_760_000_000_100,
    ...overrides,
  };
}

describe('backgroundProcessRegistry', () => {
  it('按 run 目录写 → 读 → 删', () => {
    expect(backgroundRegistryDir({ runDir: tmpDir })).toBe(path.join(tmpDir, 'bg-procs'));

    registerBackgroundProcess(entry(), { runDir: tmpDir });
    const all = listBackgroundProcessEntries({ runDir: tmpDir });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ pid: 12345, command: 'npm run dev', sessionId: 'session-abc' });

    removeBackgroundProcessEntry(12345, 1_760_000_000_000, { runDir: tmpDir });
    expect(listBackgroundProcessEntries({ runDir: tmpDir })).toHaveLength(0);
  });

  it('同一 pid+startTime 重复写是幂等的', () => {
    registerBackgroundProcess(entry(), { runDir: tmpDir });
    registerBackgroundProcess(entry({ command: 'npm run dev -- --port 4000' }), { runDir: tmpDir });
    const all = listBackgroundProcessEntries({ runDir: tmpDir });
    expect(all).toHaveLength(1);
    expect(all[0].command).toBe('npm run dev -- --port 4000');
  });

  it('不同 pid / 不同启动时间的记录互不覆盖', () => {
    registerBackgroundProcess(entry({ pid: 1 }), { runDir: tmpDir });
    registerBackgroundProcess(entry({ pid: 2 }), { runDir: tmpDir });
    registerBackgroundProcess(entry({ pid: 1, startTime: 1_760_000_001_000 }), { runDir: tmpDir });
    expect(listBackgroundProcessEntries({ runDir: tmpDir })).toHaveLength(3);
  });

  it('findBackgroundProcessEntry 按 pid + startTime 精确命中', () => {
    registerBackgroundProcess(entry(), { runDir: tmpDir });
    expect(findBackgroundProcessEntry(12345, 1_760_000_000_000, { runDir: tmpDir })?.pid).toBe(12345);
    expect(findBackgroundProcessEntry(12345, 1, { runDir: tmpDir })).toBeUndefined();
  });

  it('坏文件 / 非法记录直接跳过, 不连坐其它记录', () => {
    registerBackgroundProcess(entry({ pid: 42 }), { runDir: tmpDir });
    const dir = backgroundRegistryDir({ runDir: tmpDir });
    fs.writeFileSync(path.join(dir, '43-100.json'), '{not json', 'utf8');
    fs.writeFileSync(path.join(dir, '44-100.json'), JSON.stringify({ pid: 44 }), 'utf8');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me', 'utf8');

    const all = listBackgroundProcessEntries({ runDir: tmpDir });
    expect(all.map(e => e.pid)).toEqual([42]);
  });

  it('目录不存在时读为空、删不抛', () => {
    expect(listBackgroundProcessEntries({ runDir: path.join(tmpDir, 'nope') })).toEqual([]);
    expect(() => removeBackgroundProcessEntry(1, 2, { runDir: path.join(tmpDir, 'nope') })).not.toThrow();
  });

  it('非法条目拒绝写入', () => {
    expect(registerBackgroundProcess(entry({ pid: 0 }), { runDir: tmpDir })).toBe(false);
    expect(listBackgroundProcessEntries({ runDir: tmpDir })).toEqual([]);
  });
});
