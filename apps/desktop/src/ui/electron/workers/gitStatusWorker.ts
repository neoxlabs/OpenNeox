
import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitStatusCache, type GitRepoWatch } from '../git/gitStatusCache.js';
import {
  computeGitStatus,
  diffGitFiles,
  gitStatusSignature,
  summaryOf,
  type GitStatusResult,
} from '../git/gitStatusCore.js';
import type { GitWorkerMessage, GitWorkerRequest } from '../git/gitStatusProtocol.js';
import { createHostedWatcherClient } from '@neoxlabs/platform';

function post(msg: GitWorkerMessage): void {
  parentPort?.postMessage(msg);
}

function problem(message: string): void {
  post({ type: 'problem', message });
}

/* 工作区订阅由主线程代办 —— watcher.node 全进程共享, 本线程重建后会撞上自己留下的悬空回调
 * 把整个 Electron 带走 (见 hostedWatcher.ts)。 */
const watchClient = createHostedWatcherClient((m) => parentPort?.postMessage(m));

/* .git 元数据: 本层 (index, HEAD, FETCH_HEAD, MERGE_HEAD, packed-refs, rebase-merge/ …) + refs 递归。
 * 不递归整个 .git: objects/ 在 commit / gc 时成千上万次写, 那不是状态变化。 */
function watchMeta(dirs: string[], onEvent: () => void): fs.FSWatcher[] {
  const out: fs.FSWatcher[] = [];
  const add = (dir: string, recursive: boolean) => {
    try {
      const w = fs.watch(dir, { persistent: false, recursive }, (_ev, name) => {
        const n = typeof name === 'string' ? name : '';
        /* index.lock 之类是写到一半; 真正落地会再来一次 rename 事件 */
        if (n.endsWith('.lock')) return;
        if (!recursive && (n === 'objects' || n === 'logs')) return;
        onEvent();
      });
      /* 仓库被删 / Windows 上目录被占用 → error; 不挂 handler 会变成未捕获异常打崩 worker */
      w.on('error', (err) => {
        problem(`.git watcher error on ${dir}: ${(err as Error).message}`);
        try { w.close(); } catch { /* ignore */ }
      });
      out.push(w);
    } catch (err) {
      /* refs 目录在某些仓库 (全 packed) 里可以不存在 —— 那只是没什么可监听, 不是故障 */
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        problem(`.git watcher failed on ${dir}: ${(err as Error).message}`);
      }
    }
  };
  for (const d of dirs) add(d, false);
  const common = dirs[dirs.length - 1];
  if (common) add(path.join(common, 'refs'), true);
  return out;
}

function watchRepo(cwd: string, onEvent: (source: 'tree' | 'meta') => void): GitRepoWatch {
  let metaWatchers: fs.FSWatcher[] = [];
  let metaKey = '';
  let disposed = false;
  let subscription: { unsubscribe(): Promise<void> } | null = null;
  void watchClient.subscribe(cwd, (err, events) => {
    if (err) { problem(`workspace watcher error on ${cwd}: ${err.message}`); return; }
    if (events.length > 0) onEvent('tree');
  }, { ignore: ['.git', '**/.git', '**/.git/**'] })
    .then((sub) => {
      if (disposed) void sub.unsubscribe();
      else subscription = sub;
    })
    .catch((err: Error) => problem(`workspace watcher failed on ${cwd}: ${err.message}`));
  const closeMeta = () => {
    for (const w of metaWatchers) { try { w.close(); } catch { /* ignore */ } }
    metaWatchers = [];
  };
  return {
    setMetaDirs(dirs) {
      const key = dirs.join('\0');
      if (disposed || key === metaKey) return;
      metaKey = key;
      closeMeta();
      if (dirs.length) metaWatchers = watchMeta(dirs, () => onEvent('meta'));
    },
    dispose() {
      disposed = true;
      closeMeta();
      if (subscription) void subscription.unsubscribe().catch(() => { /* 目录已删 */ });
      subscription = null;
    },
  };
}

let versionSeq = 0;

const cache = new GitStatusCache<GitStatusResult>({
  compute: (cwd) => computeGitStatus(cwd),
  signature: gitStatusSignature,
  /* 版本号全局单调 —— 同一 cwd 的 entry 被回收后重建, 版本也不会倒退撞上渲染层手里的旧号 */
  stamp: (value) => ({ ...value, version: ++versionSeq }),
  onChanged: (cwds, root, value, prev) => {
    post({
      type: 'changed',
      payload: {
        cwds,
        root,
        version: value.version ?? 0,
        prevVersion: prev.version ?? 0,
        summary: summaryOf(value),
        delta: diffGitFiles(prev.files, value.files),
      },
    });
  },
  watch: watchRepo,
});

parentPort?.on('message', (msg: GitWorkerRequest) => {
  if (watchClient.handle(msg)) return;
  const reply = (p: Promise<GitStatusResult | null>) => {
    p.then(
      (result) => post({ type: 'reply', id: msg.id, ok: true, result }),
      (err: Error) => post({ type: 'reply', id: msg.id, ok: false, error: err?.message ?? String(err) }),
    );
  };
  switch (msg.op) {
    case 'get': reply(cache.get(msg.cwd, { fresh: msg.fresh })); break;
    case 'revalidate': reply(cache.get(msg.cwd, { fresh: msg.fresh }).then(() => null)); break;
    case 'retain': cache.retain(msg.cwd); reply(Promise.resolve(null)); break;
    case 'release': cache.release(msg.cwd); reply(Promise.resolve(null)); break;
    case 'invalidate': cache.invalidate(msg.cwd, 'hard'); reply(Promise.resolve(null)); break;
  }
});
