
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeRunMarker,
  clearRunMarker,
  readRunMarkers,
  detectAbnormalExits,
  isPidAlive,
} from '../runMarker.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neox-runmarker-'));
}

/* 一个几乎不可能存在的 pid (远大于 pid_max) */
const DEAD_PID = 4_000_000;

describe('runMarker', () => {
  it('写入后可读回', () => {
    const dir = tmpDir();
    const file = writeRunMarker(dir, {
      pid: DEAD_PID,
      startedAt: 1000,
      app: 'cli',
      version: '1.0.0',
      process: 'main',
    });
    expect(file).toBeTruthy();
    const markers = readRunMarkers(dir);
    expect(markers).toHaveLength(1);
    expect(markers[0].marker.pid).toBe(DEAD_PID);
  });

  it('正常退出清理后不再有标记', () => {
    const dir = tmpDir();
    const file = writeRunMarker(dir, { pid: DEAD_PID, startedAt: 1, app: 'cli', version: '1', process: 'main' });
    clearRunMarker(file);
    expect(readRunMarkers(dir)).toHaveLength(0);
  });

  it('死进程的标记 = 异常退出; 活进程的不算', () => {
    const dir = tmpDir();
    writeRunMarker(dir, { pid: DEAD_PID, startedAt: 1, app: 'cli', version: '1', process: 'main' });
    writeRunMarker(dir, { pid: process.pid, startedAt: 2, app: 'cli', version: '1', process: 'main' });
    const abnormal = detectAbnormalExits(dir);
    expect(abnormal).toHaveLength(1);
    expect(abnormal[0].marker.pid).toBe(DEAD_PID);
  });

  it('排除指定 pid (本进程)', () => {
    const dir = tmpDir();
    writeRunMarker(dir, { pid: DEAD_PID, startedAt: 1, app: 'cli', version: '1', process: 'main' });
    expect(detectAbnormalExits(dir, { currentPid: DEAD_PID })).toHaveLength(0);
  });

  it('isPidAlive: 当前进程活着, 巨号 pid 不在', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(DEAD_PID)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  it('坏标记文件被清掉', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'run-123-abcdef12.json'), '{bad json', 'utf-8');
    expect(readRunMarkers(dir)).toHaveLength(0);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});
