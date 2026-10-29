/**
 * Timeline IndexedDB Service
 * 使用 IndexedDB 持久化 Timeline 数据，保证顺序稳定性和高性能
 *
 * 设计要点：
 * 1. 使用自增主键 `seqId` 作为排序依据，彻底解决顺序问题
 * 2. 按 sessionId 建立索引，支持快速查询
 * 3. 支持分页加载，适合大数据集
 * 4. 自动迁移旧的 session.timeline 数据
 */

import type { TimelineEntry } from '../utils/workspaceUtils';

const DB_NAME = 'neox-timeline';
const DB_VERSION = 1;
const STORE_NAME = 'entries';

/** 诊断日志只在 dev 输出 — 生产路径不刷 console (warn/error 不走这里, 保持常开). */
function devLog(...args: unknown[]): void {
  if (import.meta.env.DEV) console.log(...args);
}

// IndexedDB 中存储的条目格式
export interface DBTimelineEntry extends TimelineEntry {
  seqId?: number;        // 自增主键（IndexedDB 自动管理）
  sessionId: string;     // 会话 ID（索引字段）
}

// 数据库实例缓存
let dbInstance: IDBDatabase | null = null;
let dbInitPromise: Promise<IDBDatabase> | null = null;

function toDbEntry(sessionId: string, entry: TimelineEntry): DBTimelineEntry {
  const { sequence, ...rest } = entry;
  void sequence;
  return {
    ...rest,
    sessionId,
  };
}

function toTimelineEntry(dbEntry: DBTimelineEntry): TimelineEntry {
  const { sessionId: _sessionId, seqId, ...rest } = dbEntry;
  void _sessionId;
  return {
    ...rest,
    sequence: seqId,
  };
}

/**
 * 初始化数据库
 */
function initDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  if (dbInitPromise) {
    return dbInitPromise;
  }

  dbInitPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[TimelineDB] Failed to open database:', request.error);
      dbInitPromise = null;
      reject(request.error);
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      devLog('[TimelineDB] Database opened successfully');

      // 监听数据库关闭
      dbInstance.onclose = () => {
        devLog('[TimelineDB] Database closed');
        dbInstance = null;
        dbInitPromise = null;
      };

      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      devLog('[TimelineDB] Upgrading database...');

      // 创建对象存储
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'seqId',
          autoIncrement: true,
        });

        // 创建 sessionId 索引，用于按会话查询
        store.createIndex('sessionId', 'sessionId', { unique: false });

        // 创建复合索引：sessionId + id，用于快速查找特定条目
        store.createIndex('sessionId_id', ['sessionId', 'id'], { unique: true });

        devLog('[TimelineDB] Object store and indexes created');
      }
    };
  });

  return dbInitPromise;
}

/**
 * 获取数据库连接
 */
async function getDB(): Promise<IDBDatabase> {
  return initDB();
}

/**
 * 添加单个 Timeline 条目
 * 返回分配的 seqId
 */
export async function addEntry(sessionId: string, entry: TimelineEntry): Promise<number> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId_id');

    const dbEntry = toDbEntry(sessionId, entry);

    const existingRequest = index.get([sessionId, entry.id]);

    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as DBTimelineEntry | undefined;
      if (existing) {
        const updated: DBTimelineEntry = {
          ...existing,
          ...dbEntry,
          seqId: existing.seqId,
          sessionId,
          id: entry.id,
        };
        const putRequest = store.put(updated);
        putRequest.onsuccess = () => resolve(existing.seqId ?? (putRequest.result as number));
        putRequest.onerror = () => {
          console.error('[TimelineDB] Failed to upsert existing entry:', putRequest.error);
          reject(putRequest.error);
        };
        return;
      }

      const addRequest = store.add(dbEntry);
      addRequest.onsuccess = () => {
        const seqId = addRequest.result as number;
        resolve(seqId);
      };
      addRequest.onerror = (event) => {
        const error = addRequest.error;
        if (error?.name === 'ConstraintError') {
          event.preventDefault();
          const retryGetRequest = index.get([sessionId, entry.id]);
          retryGetRequest.onsuccess = () => {
            const racedExisting = retryGetRequest.result as DBTimelineEntry | undefined;
            if (!racedExisting) {
              console.error('[TimelineDB] Add raced but existing entry was not found:', error);
              reject(error);
              return;
            }
            const racedUpdated: DBTimelineEntry = {
              ...racedExisting,
              ...dbEntry,
              seqId: racedExisting.seqId,
              sessionId,
              id: entry.id,
            };
            const racedPutRequest = store.put(racedUpdated);
            racedPutRequest.onsuccess = () => resolve(racedExisting.seqId ?? (racedPutRequest.result as number));
            racedPutRequest.onerror = () => {
              console.error('[TimelineDB] Failed to upsert raced entry:', racedPutRequest.error);
              reject(racedPutRequest.error);
            };
          };
          retryGetRequest.onerror = () => {
            console.error('[TimelineDB] Failed to load raced entry:', retryGetRequest.error);
            reject(retryGetRequest.error);
          };
          return;
        }
        console.error('[TimelineDB] Failed to add entry:', error);
        reject(error);
      };
    };

    existingRequest.onerror = () => {
      console.error('[TimelineDB] Failed to check existing entry before add:', existingRequest.error);
      reject(existingRequest.error);
    };
  });
}

/**
 * 批量添加 Timeline 条目（用于迁移旧数据）
 * 保持原有顺序
 */
export async function addEntries(sessionId: string, entries: TimelineEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    let completed = 0;
    let hasError = false;

    transaction.oncomplete = () => {
      devLog(`[TimelineDB] Batch added ${entries.length} entries for session ${sessionId}`);
      resolve();
    };

    transaction.onerror = () => {
      if (!hasError) {
        hasError = true;
        console.error('[TimelineDB] Batch add failed:', transaction.error);
        reject(transaction.error);
      }
    };

    // 按顺序添加，IndexedDB 会自动分配递增的 seqId
    for (const entry of entries) {
      const dbEntry = toDbEntry(sessionId, entry);

      const request = store.add(dbEntry);
      request.onsuccess = () => {
        completed++;
      };
    }
  });
}

/**
 * 更新 Timeline 条目
 * 通过 sessionId + id 查找并更新
 */
export async function updateEntry(
  sessionId: string,
  entryId: string,
  updates: Partial<TimelineEntry>
): Promise<boolean> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId_id');

    // 先查找条目
    const getRequest = index.get([sessionId, entryId]);

    getRequest.onsuccess = () => {
      const existing = getRequest.result as DBTimelineEntry | undefined;
      if (!existing) {
        resolve(false);
        return;
      }

      // 合并更新
      const updated: DBTimelineEntry = {
        ...existing,
        ...updates,
        sessionId, // 确保 sessionId 不变
        id: entryId, // 确保 id 不变
      };

      const putRequest = store.put(updated);
      putRequest.onsuccess = () => resolve(true);
      putRequest.onerror = () => {
        console.error('[TimelineDB] Failed to update entry:', putRequest.error);
        reject(putRequest.error);
      };
    };

    getRequest.onerror = () => {
      console.error('[TimelineDB] Failed to find entry for update:', getRequest.error);
      reject(getRequest.error);
    };
  });
}

/**
 * 获取指定会话的所有 Timeline 条目
 * 按 seqId 升序返回，保证顺序正确
 */
export async function getEntriesBySession(sessionId: string): Promise<TimelineEntry[]> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId');

    const entries: TimelineEntry[] = [];
    const request = index.openCursor(IDBKeyRange.only(sessionId));

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const dbEntry = cursor.value as DBTimelineEntry;
        // 转换回 TimelineEntry，添加 sequence 字段用于兼容
        entries.push(toTimelineEntry(dbEntry));
        cursor.continue();
      } else {
        // 遍历完成，entries 已按 seqId 自然排序
        resolve(entries);
      }
    };

    request.onerror = () => {
      console.error('[TimelineDB] Failed to get entries:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 分页获取 Timeline 条目
 * @param sessionId 会话 ID
 * @param limit 每页数量
 * @param offset 偏移量（从最新的开始）
 * @returns 条目列表（按时间正序）和总数
 */
export async function getEntriesPaginated(
  sessionId: string,
  limit: number,
  offset: number = 0
): Promise<{ entries: TimelineEntry[]; total: number }> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId');

    // 先获取总数
    const countRequest = index.count(IDBKeyRange.only(sessionId));

    countRequest.onsuccess = () => {
      const total = countRequest.result;

      if (total === 0 || offset >= total) {
        resolve({ entries: [], total });
        return;
      }

      // 计算实际需要跳过和获取的数量
      const skipCount = Math.max(0, total - offset - limit);
      const entries: TimelineEntry[] = [];
      let skipped = 0;

      const cursorRequest = index.openCursor(IDBKeyRange.only(sessionId));

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          if (skipped < skipCount) {
            skipped++;
            cursor.continue();
            return;
          }

          if (entries.length < limit) {
            const dbEntry = cursor.value as DBTimelineEntry;
            entries.push(toTimelineEntry(dbEntry));
            cursor.continue();
          } else {
            resolve({ entries, total });
          }
        } else {
          resolve({ entries, total });
        }
      };

      cursorRequest.onerror = () => {
        console.error('[TimelineDB] Pagination cursor failed:', cursorRequest.error);
        reject(cursorRequest.error);
      };
    };

    countRequest.onerror = () => {
      console.error('[TimelineDB] Count failed:', countRequest.error);
      reject(countRequest.error);
    };
  });
}

/**
 * 获取某个 seqId 之前的一批条目。
 * 返回值仍按时间正序排列，用于滚到顶部时 prepend 旧历史。
 */
export async function getEntriesBeforeSequence(
  sessionId: string,
  beforeSequence: number,
  limit: number
): Promise<TimelineEntry[]> {
  if (!Number.isFinite(beforeSequence) || beforeSequence <= 0 || limit <= 0) {
    return [];
  }

  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const range = IDBKeyRange.upperBound(beforeSequence - 1);
    const entries: TimelineEntry[] = [];
    const request = store.openCursor(range, 'prev');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || entries.length >= limit) {
        resolve(entries.reverse());
        return;
      }

      const dbEntry = cursor.value as DBTimelineEntry;
      if (dbEntry.sessionId === sessionId) {
        entries.push(toTimelineEntry(dbEntry));
      }
      cursor.continue();
    };

    request.onerror = () => {
      console.error('[TimelineDB] getEntriesBeforeSequence failed:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 获取会话的条目总数
 */
export async function getEntryCount(sessionId: string): Promise<number> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId');

    const request = index.count(IDBKeyRange.only(sessionId));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.error('[TimelineDB] Count failed:', request.error);
      reject(request.error);
    };
  });
}

export async function findEntriesContainingText(
  query: string,
  limit: number = 50
): Promise<Array<{ sessionId: string; entry: TimelineEntry }>> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const db = await getDB();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit || 50)));

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const hits: Array<{ sessionId: string; entry: TimelineEntry }> = [];
    const request = store.openCursor(null, 'prev');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || hits.length >= safeLimit) {
        resolve(hits);
        return;
      }

      const dbEntry = cursor.value as DBTimelineEntry;
      const searchable = [
        dbEntry.title,
        dbEntry.detail,
        (dbEntry as any).content,
        (dbEntry as any).errorMessage,
        (dbEntry as any).toolName,
        (dbEntry as any).targetPath,
        (dbEntry as any).filePath,
        (dbEntry as any).editFilePath,
        (dbEntry as any).commandCode,
        (dbEntry as any).commandResult,
        (dbEntry as any).output,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0);

      if (searchable.some((value) => value.toLowerCase().includes(q))) {
        hits.push({ sessionId: dbEntry.sessionId, entry: toTimelineEntry(dbEntry) });
      }
      cursor.continue();
    };

    request.onerror = () => {
      console.error('[TimelineDB] findEntriesContainingText failed:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 删除指定会话的所有 Timeline 条目
 */
export async function deleteSessionEntries(sessionId: string): Promise<number> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId');

    let deletedCount = 0;
    const request = index.openCursor(IDBKeyRange.only(sessionId));

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        deletedCount++;
        cursor.continue();
      } else {
        devLog(`[TimelineDB] Deleted ${deletedCount} entries for session ${sessionId}`);
        resolve(deletedCount);
      }
    };

    request.onerror = () => {
      console.error('[TimelineDB] Delete failed:', request.error);
      reject(request.error);
    };
  });
}

export async function deleteEntriesFrom(sessionId: string, anchorEntryId: string): Promise<number> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const keyReq = store.index('sessionId_id').getKey([sessionId, anchorEntryId]);
    keyReq.onerror = () => reject(keyReq.error);
    keyReq.onsuccess = () => {
      const anchorKey = keyReq.result;
      if (anchorKey === undefined) { resolve(-1); return; }

      let deleted = 0;
      /* 只能按 sessionId 索引扫 —— 主键区间会跨会话, 裁到别人头上去。 */
      const cur = store.index('sessionId').openCursor(IDBKeyRange.only(sessionId));
      cur.onerror = () => reject(cur.error);
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) {
          devLog(`[TimelineDB] Truncated ${deleted} entries from ${anchorEntryId}`);
          resolve(deleted);
          return;
        }
        if ((c.primaryKey as number) >= (anchorKey as number)) { c.delete(); deleted++; }
        c.continue();
      };
    };
  });
}

/**
 * 通过 entryId 查找并删除单个条目
 */
export async function deleteEntry(sessionId: string, entryId: string): Promise<boolean> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId_id');

    const getRequest = index.getKey([sessionId, entryId]);

    getRequest.onsuccess = () => {
      const key = getRequest.result;
      if (key === undefined) {
        resolve(false);
        return;
      }

      const deleteRequest = store.delete(key);
      deleteRequest.onsuccess = () => resolve(true);
      deleteRequest.onerror = () => {
        console.error('[TimelineDB] Delete entry failed:', deleteRequest.error);
        reject(deleteRequest.error);
      };
    };

    getRequest.onerror = () => {
      console.error('[TimelineDB] Find entry for delete failed:', getRequest.error);
      reject(getRequest.error);
    };
  });
}

/**
 * 检查指定条目是否存在
 */
export async function hasEntry(sessionId: string, entryId: string): Promise<boolean> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId_id');

    const request = index.getKey([sessionId, entryId]);

    request.onsuccess = () => resolve(request.result !== undefined);
    request.onerror = () => {
      console.error('[TimelineDB] Check entry failed:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 获取单个条目
 */
export async function getEntry(sessionId: string, entryId: string): Promise<TimelineEntry | null> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId_id');

    const request = index.get([sessionId, entryId]);

    request.onsuccess = () => {
      const dbEntry = request.result as DBTimelineEntry | undefined;
      if (!dbEntry) {
        resolve(null);
        return;
      }

      resolve(toTimelineEntry(dbEntry));
    };

    request.onerror = () => {
      console.error('[TimelineDB] Get entry failed:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 清空所有数据（用于测试或重置）
 */
export async function clearAll(): Promise<void> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.clear();

    request.onsuccess = () => {
      devLog('[TimelineDB] All data cleared');
      resolve();
    };

    request.onerror = () => {
      console.error('[TimelineDB] Clear failed:', request.error);
      reject(request.error);
    };
  });
}

/**
 * 从旧的 session.timeline 数据迁移
 * 检查是否需要迁移，如果需要则执行迁移
 */
export async function migrateFromSessionTimeline(
  sessionId: string,
  oldTimeline: TimelineEntry[] | undefined
): Promise<boolean> {
  if (!oldTimeline || oldTimeline.length === 0) {
    return false;
  }

  // 检查是否已经迁移过（IndexedDB 中已有数据）
  const existingCount = await getEntryCount(sessionId);
  if (existingCount > 0) {
    const subEntries = oldTimeline.filter(e => String(e.id || '').startsWith('sub-'));
    if (subEntries.length > 0) {
      const existing = await getEntriesBySession(sessionId);
      const known = new Set(existing.map(e => e.id));
      const fresh = subEntries.filter(e => e.id && !known.has(e.id));
      if (fresh.length > 0) {
        devLog(`[TimelineDB] Merging ${fresh.length} fresh sub-agent entries for session ${sessionId}`);
        await addEntries(sessionId, fresh);
        return true;
      }
    }
    devLog(`[TimelineDB] Session ${sessionId} already has ${existingCount} entries, skipping migration`);
    return false;
  }

  devLog(`[TimelineDB] Migrating ${oldTimeline.length} entries for session ${sessionId}`);

  // 与 runtime normalizeTimeline 同序, 避免迁移时把缺 sequence 的新错误卡顶到 user 前面
  const { compareTimelineEntries } = await import('../utils/workspaceUtils');
  const sortedTimeline = [...oldTimeline].sort(compareTimelineEntries);

  await addEntries(sessionId, sortedTimeline);
  return true;
}

/**
 * 获取数据库统计信息
 */
export async function getStats(): Promise<{
  totalEntries: number;
  sessionCount: number;
  dbSizeEstimate: number;
}> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const countRequest = store.count();

    countRequest.onsuccess = async () => {
      const totalEntries = countRequest.result;

      // 估算数据库大小（需要 StorageManager API）
      let dbSizeEstimate = 0;
      if (navigator.storage && navigator.storage.estimate) {
        try {
          const estimate = await navigator.storage.estimate();
          dbSizeEstimate = estimate.usage || 0;
        } catch {
          // 忽略估算错误
        }
      }

      // 获取唯一 sessionId 数量（简化实现：遍历索引）
      const sessionIds = new Set<string>();
      const index = store.index('sessionId');
      const cursorRequest = index.openKeyCursor();

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          sessionIds.add(cursor.key as string);
          cursor.continue();
        } else {
          resolve({
            totalEntries,
            sessionCount: sessionIds.size,
            dbSizeEstimate,
          });
        }
      };

      cursorRequest.onerror = () => {
        // 即使获取 session 数量失败，也返回基本统计
        resolve({
          totalEntries,
          sessionCount: 0,
          dbSizeEstimate,
        });
      };
    };

    countRequest.onerror = () => {
      console.error('[TimelineDB] Stats count failed:', countRequest.error);
      reject(countRequest.error);
    };
  });
}

// 导出数据库名称供调试使用
export const DATABASE_NAME = DB_NAME;
export const STORE_NAME_EXPORT = STORE_NAME;
