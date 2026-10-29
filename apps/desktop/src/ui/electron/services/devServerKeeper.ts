/**
 * devServerKeeper.ts — dev 模式下 Vite dev server 的看门人.
 *
 * ## 为什么需要它
 *
 * `npm run ui:dev` 靠 concurrently 把 vite 和 electron 并排拉起来。可 vite 是个
 * 会死的进程 —— OOM、端口被别的分支抢、`lsof -ti:5180 | xargs kill` 顺手带走、
 * 改了 vite.config 自杀重启失败。它一死, electron 这边 `loadURL` 立刻 ERR_FAILED,
 * 而老逻辑会退回去 `loadFile(dist/ui-electron/renderer/index.html)` —— 那是**生产**
 * 产物, dev 流程从来不生成它, 于是错误变成一句彻底误导人的 `ERR_FILE_NOT_FOUND`,
 * 让人以为是打包坏了, 实际是 dev server 没了。
 *
 * 光把等待时间加长也没用: 没人会去把 vite 拉回来, 等到天亮还是白屏。所以这里
 * 直接**自己把它拉起来** —— 探测端口, 没人监听就 spawn 本地 `node_modules/.bin/vite`,
 * 等端口通了再让 electron 去 load。
 *
 * ## 边界
 *
 * - 只在能定位到源码仓 (存在 `vite.config.ui.ts` 且有本地 vite 可执行) 时才 spawn。
 *   打包后的 app 里这两个条件都不成立, 函数直接返回, 不会有任何副作用。
 * - 同一进程内只 spawn 一次 (`spawned`); 端口已通也不 spawn —— 不会跟 concurrently
 *   起的那个 vite 打架。
 * - 子进程 detached + unref: electron 退出不会把它留成僵尸, 也不阻塞退出。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname as pathDirname, join } from 'node:path';

/** 探测 host:port 有没有人监听. */
export function probePort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * 本地 vite 可执行 —— win 上 npm 的 .bin 是 vite.cmd / vite.ps1 / vite (sh shim),
 * 无扩展的 sh shim 在 win 上 spawn 不了 (ENOENT)。win 优先 .cmd。
 */
export function viteBin(root: string): string | null {
  const candidates = process.platform === 'win32'
    ? ['vite.cmd', 'vite.exe', 'vite']
    : ['vite'];
  for (const c of candidates) {
    const p = join(root, 'node_modules', '.bin', c);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 从 `from` 往上找源码仓根 —— 判据是同时有 `vite.config.ui.ts` 和本地 vite 可执行.
 * 找不到返回 null (打包后的 app 就是这种情况).
 */
export function findViteRoot(from: string): string | null {
  let cur = from;
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(cur, 'vite.config.ui.ts')) &&
      viteBin(cur) !== null
    ) {
      return cur;
    }
    const up = pathDirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/**
 * 我们自己拉起来的那个 vite。留着它是为了区分「已经在拉了, 别重复 spawn」和
 * 「上一个也死了, 该再拉一次」—— 早先这里是个一次性的 `spawned = true` 布尔闸,
 * 结果第二次 vite 挂掉时它直接拒绝重拉, 只剩干等超时, 等于没修。
 */
let viteChild: { exited: boolean; kill(): void } | null = null;
let inFlight: Promise<boolean> | null = null;

/** 仅测试用 — 清掉进程内状态. */
export function __resetDevServerKeeper(): void {
  viteChild = null;
  inFlight = null;
}

/**
 * 确保 dev server 在跑。端口已通 → 立刻返回 true; 没通且能定位源码仓 → spawn vite
 * 并等它监听 (最多 waitMs)。返回最终端口是否可用。
 *
 * 可重复调用: 我们拉起的 vite 又死了会再拉一次。
 */
export function ensureDevServer(
  url: string,
  electronDirname: string,
  waitMs = 30_000,
): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = ensureDevServerOnce(url, electronDirname, waitMs).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function ensureDevServerOnce(
  url: string,
  electronDirname: string,
  waitMs: number,
): Promise<boolean> {
  let host = '127.0.0.1';
  let port = 5180;
  try {
    const u = new URL(url);
    host = u.hostname || host;
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    /* 用默认值 */
  }

  if (await probePort(host, port)) return true;

  // 只有「没有活着的自家 vite」时才 spawn —— 有的话说明已经在拉, 直接往下等端口。
  if (!viteChild || viteChild.exited) {
    const root = findViteRoot(electronDirname);
    if (!root) {
      console.warn(
        `[devServer] ${host}:${port} 没人监听, 且从 ${electronDirname} 往上找不到源码仓 —— 无法自动拉起 vite.`,
      );
      return false;
    }
    console.warn(`[devServer] ${host}:${port} 没人监听 —— 自动拉起 vite (cwd=${root})`);
    const bin = viteBin(root)!;
    const args = ['--config', 'vite.config.ui.ts', '--host', host, '--port', String(port), '--strictPort'];
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/c', 'call', bin, ...args], {
          cwd: root,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, NODE_ENV: 'development', VITE_DEV_SERVER_URL: url },
        })
      : spawn(bin, args, {
          cwd: root,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, NODE_ENV: 'development', VITE_DEV_SERVER_URL: url },
        });
    const tracked = { exited: false, kill: () => child.kill() };
    child.on('error', err => {
      tracked.exited = true;
      console.error('[devServer] spawn vite 失败:', err?.message || err);
    });
    child.on('exit', code => {
      tracked.exited = true;
      console.warn(`[devServer] 自家 vite 退出 (code=${code}) —— 下次需要时会再拉`);
    });
    child.unref();
    viteChild = tracked;
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (await probePort(host, port)) {
      console.warn(`[devServer] vite 已就绪 (${host}:${port})`);
      return true;
    }
  }
  console.error(`[devServer] 等了 ${waitMs}ms, vite 仍未监听 ${host}:${port}`);
  return false;
}
