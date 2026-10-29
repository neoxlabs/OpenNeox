/**
 * devServerKeeper.test.ts — dev server 看门人.
 *
 * 锁死三件事:
 *   1. 端口通 → 直接返回 true, 不去 spawn (不能跟 concurrently 起的 vite 打架)
 *   2. 端口不通 + 定位不到源码仓 (= 打包后的 app) → 返回 false, 不 spawn
 *   3. findViteRoot 的判据是「vite.config.ui.ts + node_modules/.bin/vite 同时在」
 */
import { createServer, type Server } from 'node:net';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetDevServerKeeper,
  ensureDevServer,
  findViteRoot,
  probePort,
} from '../devServerKeeper.js';

const servers: Server[] = [];
beforeEach(() => __resetDevServerKeeper());
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function fakeViteRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fakevite-'));
  writeFileSync(join(root, 'vite.config.ui.ts'), '');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  const script = `const a = process.argv;
const port = Number(a[a.indexOf('--port') + 1]);
const host = a[a.indexOf('--host') + 1];
require('net').createServer().listen(port, host);
setInterval(() => {}, 1000);
`;
  if (process.platform === 'win32') {
    writeFileSync(join(root, 'node_modules', '.bin', 'vite.js'), script);
    writeFileSync(join(root, 'node_modules', '.bin', 'vite.cmd'), '@echo off\r\nnode "%~dp0vite.js" %*\r\n');
  } else {
    writeFileSync(join(root, 'node_modules', '.bin', 'vite'), `#!/usr/bin/env node\n${script}`);
    chmodSync(join(root, 'node_modules', '.bin', 'vite'), 0o755);
  }
  return root;
}

function killByPort(port: number): void {
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' },
    );
  } else {
    execSync(`lsof -ti:${port} | xargs kill -9 || true`);
  }
}

/** 拿一个当下空着的端口号 (先监听再关掉). */
async function freePort(): Promise<number> {
  const port = await listen();
  servers.splice(0).forEach(s => s.close());
  await new Promise(r => setTimeout(r, 50));
  return port;
}

function listen(): Promise<number> {
  return new Promise(resolve => {
    const s = createServer();
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port));
  });
}

describe('probePort', () => {
  it('有人监听 → true', async () => {
    expect(await probePort('127.0.0.1', await listen())).toBe(true);
  });

  it('没人监听 → false', async () => {
    const port = await listen();
    servers.splice(0).forEach(s => s.close());
    await new Promise(r => setTimeout(r, 50));
    expect(await probePort('127.0.0.1', port)).toBe(false);
  });
});

describe('findViteRoot', () => {
  it('两个判据都满足 → 找到, 且能从深层子目录往上找', () => {
    const root = mkdtempSync(join(tmpdir(), 'viteroot-'));
    writeFileSync(join(root, 'vite.config.ui.ts'), '');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    /* win 上 findViteRoot 认 vite.cmd (见 devServerKeeper.viteBin) */
    const bin = process.platform === 'win32' ? 'vite.cmd' : 'vite';
    writeFileSync(join(root, 'node_modules', '.bin', bin), '');
    const deep = join(root, 'apps', 'cli', 'dist', 'ui-electron', 'electron');
    mkdirSync(deep, { recursive: true });
    expect(findViteRoot(deep)).toBe(root);
  });

  it('只有 config 没有 vite 可执行 → null (打包后的 app)', () => {
    const root = mkdtempSync(join(tmpdir(), 'viteroot-'));
    writeFileSync(join(root, 'vite.config.ui.ts'), '');
    expect(findViteRoot(root)).toBeNull();
  });

  it('什么都没有 → null, 不会一路走到文件系统根就死循环', () => {
    const root = mkdtempSync(join(tmpdir(), 'viteroot-'));
    expect(findViteRoot(root)).toBeNull();
  });
});

describe('ensureDevServer', () => {
  it('端口已通 → true, 不 spawn', async () => {
    const port = await listen();
    expect(await ensureDevServer(`http://127.0.0.1:${port}`, '/nonexistent')).toBe(true);
  });

  it('端口不通 + 无源码仓 → false (不 spawn, 也不干等满 waitMs)', async () => {
    const port = await listen();
    servers.splice(0).forEach(s => s.close());
    await new Promise(r => setTimeout(r, 50));
    const t0 = Date.now();
    expect(await ensureDevServer(`http://127.0.0.1:${port}`, tmpdir(), 5_000)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('URL 畸形 → 退回默认 127.0.0.1:5180 而不是抛异常', async () => {
    await expect(ensureDevServer('not a url', tmpdir(), 100)).resolves.toBeTypeOf('boolean');
  });

  it('端口不通 + 有源码仓 → 真把 vite 拉起来', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    expect(await ensureDevServer(url, fakeViteRoot(), 15_000)).toBe(true);
    expect(await probePort('127.0.0.1', port)).toBe(true);
    killByPort(port);
  });

  it('拉起来的 vite 又死了 → 会再拉一次 (不是一次性闸)', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const root = fakeViteRoot();
    expect(await ensureDevServer(url, root, 15_000)).toBe(true);

    killByPort(port);
    // 等子进程 exit 事件送达 + 端口真的空出来
    for (let i = 0; i < 40 && (await probePort('127.0.0.1', port)); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    expect(await probePort('127.0.0.1', port)).toBe(false);

    // 这一发才是回归点: 早先版本会跳过 spawn, 干等到超时返回 false.
    expect(await ensureDevServer(url, root, 15_000)).toBe(true);
    killByPort(port);
  });

  it('并发调用只拉一次 (loadDevUrl 重试和 did-fail-load 可能同时来)', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const root = fakeViteRoot();
    // 用了 --strictPort: 要是并发 spawn 了两个, 第二个会因端口占用而退出并打日志;
    // 这里断言两路都成功 —— 合并生效时它们本就是同一个 promise.
    const [a, b] = await Promise.all([
      ensureDevServer(url, root, 15_000),
      ensureDevServer(url, root, 15_000),
    ]);
    expect([a, b]).toEqual([true, true]);
    killByPort(port);
  });
});
