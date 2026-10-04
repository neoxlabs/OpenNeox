/**
 * sheetWorkbookStore — agent 跨轮共享 workbook 句柄 (S1 Phase 1).
 *
 *   场景: agent 第 1 轮调 `sheet_new_workbook` → 拿 workbook_id;
 *         第 2 轮调 `sheet_write_range(workbook_id, ...)` 还能用同一个 id;
 *         第 N 轮调 `sheet_export_file(workbook_id, save_path)` 写盘.
 *
 *   决策: 内存 store + TTL 1h. 不持久化盘 —
 *     - agent 用完一般立刻 export, 不需要跨 process 持久化
 *     - 跨 process 持久化由本地存储负责, 当前版本保持单机范围
 *     - TTL 1h 防 leak (agent 跑挂或忘 export 会留垃圾)
 *
 *   workbook data 用 SheetJS 内存 workbook (XLSX.utils.book_new() 返的 obj).
 *   export 时 XLSX.writeFile() 写到磁盘.
 */

type SheetJSWorkbook = any; /* SheetJS 的 WorkBook type, 懒 import 时拿到 */

interface StoredWorkbook {
  id: string;
  wb: SheetJSWorkbook;
  name: string;
  createdAt: number;
  lastTouchedAt: number;
}

const TTL_MS = 60 * 60 * 1000; /* 1 小时 */
const MAX_WORKBOOKS = 50;       /* 防过度堆积 */
const store = new Map<string, StoredWorkbook>();

/** TTL 清理 — 每次 set/get 顺手扫一遍, 不开独立 timer (避免 process 退出阻塞) */
function gcExpired(): void {
  const now = Date.now();
  for (const [id, w] of store) {
    if (now - w.lastTouchedAt > TTL_MS) store.delete(id);
  }
}

export function createWorkbook(name: string, wb: SheetJSWorkbook): string {
  gcExpired();
  if (store.size >= MAX_WORKBOOKS) {
    /* LRU 淘汰 oldest */
    let oldest: StoredWorkbook | null = null;
    for (const w of store.values()) {
      if (!oldest || w.lastTouchedAt < oldest.lastTouchedAt) oldest = w;
    }
    if (oldest) store.delete(oldest.id);
  }
  const id = `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  store.set(id, { id, wb, name, createdAt: now, lastTouchedAt: now });
  return id;
}

export function getWorkbook(id: string): StoredWorkbook | null {
  gcExpired();
  const w = store.get(id);
  if (!w) return null;
  w.lastTouchedAt = Date.now();
  return w;
}

export function deleteWorkbook(id: string): boolean {
  return store.delete(id);
}

export function listWorkbooks(): Array<{ id: string; name: string; createdAt: number }> {
  gcExpired();
  return Array.from(store.values()).map(w => ({ id: w.id, name: w.name, createdAt: w.createdAt }));
}

/** 仅测试用 — 清空全部 */
export function _resetWorkbookStore(): void {
  store.clear();
}
