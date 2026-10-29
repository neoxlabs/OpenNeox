
import { watch, existsSync, type FSWatcher } from 'node:fs';
import * as path from 'node:path';

export interface SingleFileWatcher {
  /** 当前模式 (日志 / 测试用). dir = 目标文件不在, 正在看父目录等它出现. */
  mode(): 'file' | 'dir' | 'closed';
  /** 幂等. 关掉之后不再有任何回调. */
  close(): void;
}

/* file ⇄ dir 互相回落的深度上限 —— 正常只会走一层 (文件不在就停在 dir). 真出现
 * "文件在但 watch 一直失败" (EMFILE / EACCES) 时到此收手, 不让两者递归打爆栈。 */
const MAX_FALLBACK_DEPTH = 2;

export function watchSingleFile(filePath: string, onChange: () => void): SingleFileWatcher {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);

  /* 世代号 —— 只有 close() 递增. 模式切换 (file ⇄ dir) 不递增: 那是同一段生命周期里换句柄。 */
  let gen = 0;
  let watcher: FSWatcher | null = null;
  let currentMode: 'file' | 'dir' | 'closed' = 'closed';

  const swap = (next: FSWatcher | null, mode: 'file' | 'dir' | 'closed'): void => {
    const prev = watcher;
    watcher = next;
    currentMode = mode;
    if (prev && prev !== next) {
      try { prev.close(); } catch { /* 已关 / 正在关 —— 忽略 */ }
    }
  };

  /* 文件模式下文件没了 / 句柄出错 → 回目录模式等它回来. */
  function armDir(myGen: number, depth: number): void {
    if (myGen !== gen) return;
    try {
      const w = watch(dir, (_eventType, filename) => {
        if (myGen !== gen) return;
        /* filename 平台间可能为 null —— 宁可多判一次也不漏事件. */
        if (filename && filename.toString() !== base) return;
        if (armFile(myGen, depth)) onChange();
      });
      w.on('error', () => { /* 父目录不可读: 保持当前状态, 不递归重挂 */ });
      if (typeof w.unref === 'function') w.unref();
      swap(w, 'dir');

      /* fs.watch 的底层 open + kevent 是排在 libuv 线程池上**异步**做的 —— 挂上之前的
       * 窗口里发生的 "文件已重建" 会丢。补一次存在性判定把这个盲窗关掉, 否则
       * 「删掉又立刻重建」会让本函数永远停在目录模式, 等一个已经发生过的 create。 */
      if (existsSync(filePath) && armFile(myGen, depth)) onChange();
    } catch {
      /* 父目录也不在 —— 调用方 (重) 安装时自然会重试. */
      swap(null, 'closed');
    }
  }

  /** @returns 文件模式是否装上. false = 文件不存在, 已回落目录模式. */
  function armFile(myGen: number, depth: number): boolean {
    if (myGen !== gen) return false;
    try {
      const w = watch(filePath, (eventType) => {
        if (myGen !== gen) return;
        if (eventType !== 'rename') {
          onChange();
          return;
        }
        /* 'rename' = 删除 / 改名 / 被 rename 原子替换. 先报 (调用方自己 stat 判存在性),
         * 再重新判定: 文件还在就继续文件模式, 真没了 armFile 内部自动回落目录模式. */
        onChange();
        armFile(myGen, depth);
      });
      w.on('error', () => { if (myGen === gen) armDir(myGen, depth + 1); });
      if (typeof w.unref === 'function') w.unref();
      swap(w, 'file');
      return true;
    } catch {
      if (depth >= MAX_FALLBACK_DEPTH) {
        swap(null, 'closed');
        return false;
      }
      armDir(myGen, depth + 1);
      return false;
    }
  }

  armFile(gen, 0);

  return {
    mode: () => currentMode,
    close(): void {
      gen++;
      swap(null, 'closed');
    },
  };
}
