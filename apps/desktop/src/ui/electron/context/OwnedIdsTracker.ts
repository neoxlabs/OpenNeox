/**
 * OwnedIdsTracker —— 记录本 ProjectScope 拥有的资源 id
 *
 * 用途: **事件路由**.
 *
 * 场景
 * ----
 * 比如 run-launch IPC: 启动一个进程返回 processId. 进程输出事件 (`run-launch:event`)
 * 在 main 进程里通过 BrowserWindow.webContents.send 发回 renderer. 问题是 main 进程
 * 里只知道 processId, 不知道这个 process 是哪个 window 发起的.
 *
 * 解法: process 启动时, 在发起 scope 的 OwnedIdsTracker 里 `claim('runProcess', id)`.
 * 输出事件到来时, 遍历 ProjectManager 的所有 scope, 找到持有这个 id 的 scope,
 * 就是要 send 事件的目标窗口.
 *
 * IDE 源里 IDEA 的做法是 service 持有 scope 引用, 直接知道要发给谁. JS 里我们
 * 用一个轻量级 tracker 做 id → scope 反查.
 */

export type OwnedIdKind =
  | 'terminal'       // terminal session id
  | 'runProcess'     // run-launch PTY process id
  | 'debugSession'   // debug session id
  | 'chatSession';   // neox agent chat session id

export class OwnedIdsTracker {
  private readonly sets = new Map<OwnedIdKind, Set<string>>();

  claim(kind: OwnedIdKind, id: string): void {
    let set = this.sets.get(kind);
    if (!set) {
      set = new Set();
      this.sets.set(kind, set);
    }
    set.add(id);
  }

  release(kind: OwnedIdKind, id: string): void {
    this.sets.get(kind)?.delete(id);
  }

  has(kind: OwnedIdKind, id: string): boolean {
    return this.sets.get(kind)?.has(id) ?? false;
  }

  list(kind: OwnedIdKind): readonly string[] {
    const set = this.sets.get(kind);
    return set ? [...set] : [];
  }

  clear(kind?: OwnedIdKind): void {
    if (kind) {
      this.sets.get(kind)?.clear();
    } else {
      for (const set of this.sets.values()) set.clear();
    }
  }
}
