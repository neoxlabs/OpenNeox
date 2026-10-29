/**
 * watchSingleFile — 真 fs 行为测试 (不 mock).
 *
 * 盯两件事:
 *   1. 语义: 文件在 / 不在 / 被删后重建 / 被 rename 原子替换, 都要报事件.
 *   2. 代价: 同一目录里**不相关**文件的变动, 一条都不该冒出来 ——
 *      这就是不再挂目录事件流 (macOS 上 = FSEvents) 的理由.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { watchSingleFile, type SingleFileWatcher } from '../watchSingleFile.js';

let root: string;
let target: string;
let watcher: SingleFileWatcher | null = null;
let hits = 0;

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function prime(bump: () => void): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const before = hits;
    bump();
    if (await waitFor(() => hits > before, 250)) return;
  }
  throw new Error('watcher 未能在 ~3s 内挂上');
}

/** prime 完再静一拍, 把队列里可能的重复事件排空, 之后才能拿 hits 当基线. */
async function primeAndSettle(bump: () => void): Promise<void> {
  await prime(bump);
  await settle(150);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'neox-watch-single-'));
  target = path.join(root, 'auth.enc');
  hits = 0;
});

afterEach(() => {
  watcher?.close();
  watcher = null;
  rmSync(root, { recursive: true, force: true });
});

describe('watchSingleFile', () => {
  test('文件已存在 → 文件模式, 内容变更被上报', async () => {
    writeFileSync(target, 'a');
    watcher = watchSingleFile(target, () => { hits++; });
    expect(watcher.mode()).toBe('file');

    await prime(() => writeFileSync(target, `v${hits}`));
    expect(hits).toBeGreaterThan(0);
  });

  test('同目录其它文件变动 → 一条都不上报', async () => {
    writeFileSync(target, 'a');
    watcher = watchSingleFile(target, () => { hits++; });
    await primeAndSettle(() => writeFileSync(target, `v${hits}`));

    const before = hits;
    for (let i = 0; i < 5; i++) writeFileSync(path.join(root, `noise-${i}.log`), 'x');
    await settle(700);
    expect(hits).toBe(before);

    /* 反向确认 —— 不是 watcher 死了, 而是确实只在看这一个文件. */
    writeFileSync(target, 'changed');
    expect(await waitFor(() => hits > before)).toBe(true);
  });

  test('文件被删 → 上报 + 降级看目录; 重建 → 再上报 + 切回文件模式', async () => {
    writeFileSync(target, 'a');
    watcher = watchSingleFile(target, () => { hits++; });
    await primeAndSettle(() => writeFileSync(target, `v${hits}`));

    const beforeDelete = hits;
    rmSync(target);
    expect(await waitFor(() => hits > beforeDelete)).toBe(true);
    expect(await waitFor(() => watcher?.mode() === 'dir')).toBe(true);

    const beforeCreate = hits;
    writeFileSync(target, 'b');
    expect(await waitFor(() => hits > beforeCreate)).toBe(true);
    expect(await waitFor(() => watcher?.mode() === 'file')).toBe(true);
  });

  test('安装时文件不存在 → 先看目录, 出现即上报', async () => {
    watcher = watchSingleFile(target, () => { hits++; });
    expect(watcher.mode()).toBe('dir');

    /* 目录模式下, 不相关文件不该触发. */
    writeFileSync(path.join(root, 'other.json'), 'x');
    await settle(300);
    expect(hits).toBe(0);

    await prime(() => {
      rmSync(target, { force: true });
      writeFileSync(target, `v${hits}`);
    });
    expect(watcher.mode()).toBe('file');
  });

  test('rename 原子替换 (写临时文件再 rename 覆盖) → 上报且保持文件模式', async () => {
    writeFileSync(target, 'a');
    watcher = watchSingleFile(target, () => { hits++; });
    await primeAndSettle(() => writeFileSync(target, `v${hits}`));

    const before = hits;
    const tmp = path.join(root, '.auth.enc.tmp');
    writeFileSync(tmp, 'b');
    renameSync(tmp, target);

    expect(await waitFor(() => hits > before)).toBe(true);
    expect(await waitFor(() => watcher?.mode() === 'file')).toBe(true);
  });

  test('close() 之后不再有任何回调, 模式为 closed', async () => {
    writeFileSync(target, 'a');
    watcher = watchSingleFile(target, () => { hits++; });
    await primeAndSettle(() => writeFileSync(target, `v${hits}`));

    watcher.close();
    expect(watcher.mode()).toBe('closed');

    const frozen = hits;
    writeFileSync(target, 'c');
    rmSync(target);
    await settle(700);
    expect(hits).toBe(frozen);
  });
});
