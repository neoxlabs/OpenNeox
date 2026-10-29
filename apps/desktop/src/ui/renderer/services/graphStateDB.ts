/**
 * GraphState IndexedDB Service
 * 持久化 Orchestration Graph 的 Worker/Team 状态
 *
 * 设计要点：
 * 1. 按 sessionId 隔离，不同对话的 graph 互不干扰
 * 2. 每个 session 只保留一个最新快照（upsert 语义）
 * 3. 自动清理 >30 分钟的旧快照
 * 4. 数据量极小（~70KB/快照），读写微秒级
 */

import type { WorkerInfo, TeamInfo } from '../modules/conversation/types/assistantGraphTypes';

const DB_NAME = 'neox-graph-state';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

// 24 小时 TTL — worker/team 数据需要跨页面刷新和重启保留
const SNAPSHOT_TTL_MS = 24 * 60 * 60_000;

export interface GraphSnapshot {
  sessionId: string;       // 主键 — 每个 session 只存一个快照
  workers: WorkerInfo[];
  teams: TeamInfo[];
  savedAt: number;
}

// ============================================================================
// Database Instance
// ============================================================================

let dbInstance: IDBDatabase | null = null;
let dbInitPromise: Promise<IDBDatabase> | null = null;

function initDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[GraphStateDB] Failed to open:', request.error);
      dbInitPromise = null;
      reject(request.error);
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onclose = () => {
        dbInstance = null;
        dbInitPromise = null;
      };
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
        // 按保存时间索引，用于 TTL 清理
        store.createIndex('savedAt', 'savedAt', { unique: false });
      }
    };
  });

  return dbInitPromise;
}

async function getDB(): Promise<IDBDatabase> {
  return initDB();
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * 保存或更新 graph 快照（upsert）
 * 每个 sessionId 只保留一个快照
 */
export async function saveSnapshot(
  sessionId: string,
  workers: WorkerInfo[],
  teams: TeamInfo[],
): Promise<void> {
  // 空数据不保存
  if (workers.length === 0 && teams.length === 0) return;

  const db = await getDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const snapshot: GraphSnapshot = {
      sessionId,
      workers,
      teams,
      savedAt: Date.now(),
    };

    const request = store.put(snapshot); // put = upsert

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error('[GraphStateDB] Save failed:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 读取指定 session 的 graph 快照
 */
export async function loadSnapshot(
  sessionId: string,
): Promise<{ workers: WorkerInfo[]; teams: TeamInfo[] } | null> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    const request = store.get(sessionId);

    request.onsuccess = () => {
      const snapshot = request.result as GraphSnapshot | undefined;
      if (!snapshot) {
        resolve(null);
        return;
      }

      // TTL 检查：超过 30 分钟的快照视为过期
      if (Date.now() - snapshot.savedAt > SNAPSHOT_TTL_MS) {
        // 异步删除过期快照，不阻塞返回
        void deleteSnapshot(sessionId);
        resolve(null);
        return;
      }

      resolve({
        workers: snapshot.workers || [],
        teams: snapshot.teams || [],
      });
    };

    request.onerror = () => {
      console.error('[GraphStateDB] Load failed:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 删除指定 session 的快照
 */
export async function deleteSnapshot(sessionId: string): Promise<void> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const request = store.delete(sessionId);

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error('[GraphStateDB] Delete failed:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 清理过期快照（>30 分钟）
 * 建议在 app 启动时和定时调用
 */
export async function cleanupExpired(): Promise<number> {
  const db = await getDB();
  const cutoff = Date.now() - SNAPSHOT_TTL_MS;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('savedAt');

    let deleted = 0;
    const range = IDBKeyRange.upperBound(cutoff);
    const request = index.openCursor(range);

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        deleted++;
        cursor.continue();
      } else {
        if (deleted > 0) {
          console.log(`[GraphStateDB] Cleaned up ${deleted} expired snapshots`);
        }
        resolve(deleted);
      }
    };

    request.onerror = () => {
      console.error('[GraphStateDB] Cleanup failed:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 获取所有快照的统计信息（调试用）
 */
export async function getStats(): Promise<{ count: number; totalSize: number }> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    const countReq = store.count();

    countReq.onsuccess = () => {
      resolve({ count: countReq.result, totalSize: 0 });
    };

    countReq.onerror = () => reject(countReq.error);
  });
}

// 导出常量供调试
export const DATABASE_NAME = DB_NAME;
