/** 主线程 ↔ gitStatusWorker 的消息 (只放类型, 两边都 import 它而不互相 import) */
import type { GitStatusChangedPayload, GitStatusResult } from './gitStatusCore.js';

export type GitWorkerRequest =
  | { id: number; op: 'get'; cwd: string; fresh: boolean }
  /** 同 get, 但不回传结果 (变化走 changed 推送) —— 省掉一次整份状态的跨线程拷贝 */
  | { id: number; op: 'revalidate'; cwd: string; fresh: boolean }
  | { id: number; op: 'retain'; cwd: string }
  | { id: number; op: 'release'; cwd: string }
  | { id: number; op: 'invalidate'; cwd: string };

export type GitWorkerMessage =
  | { type: 'reply'; id: number; ok: true; result: GitStatusResult | null }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'changed'; payload: GitStatusChangedPayload }
  /** worker 自己的非致命故障 (watcher 起不来等) —— 主线程负责大声记下来 */
  | { type: 'problem'; message: string };
