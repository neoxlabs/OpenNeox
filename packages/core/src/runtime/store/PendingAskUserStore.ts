/**
 * PendingAskUserStore — 跨 server 重启持久化 ask_user 工具调用.
 *
 * 设计动机:
 *   ask_user 工具用 in-memory Map `pendingQuestions` 接住 Promise. server crash /
 *   hot-reload / 用户离开几小时回来发现服务死过一次, in-memory entry 没了, 用户
 *   submit 的答案就被静默吞掉. 持久化后, replyAskUser handler 可以走 resume 路径:
 *     1. 把 formatted answer 追加成 tool_result message
 *     2. 删掉 disk row
 *     3. agenticRuntime.chat({sessionId, isResume:true}) 重启 agentLoop
 *
 * 表结构详见 schema.ts `pending_ask_user`.
 *
 * 失败处理: 任何 db 抛错都 swallow + warn — fallback 是丢失 disk 持久化, 跟今天
 * 一样的"重启后吞掉答案"行为, 不能因为 db 问题让 ask_user 本身炸掉.
 */

import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface AskUserQuestionStored {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface PendingAskUserRecord {
  toolCallId: string;
  sessionId: string;
  questions: AskUserQuestionStored[];
  createdAt: number;
}

interface RawRow {
  tool_call_id: string;
  session_id: string;
  questions: string;
  created_at: number;
}

export class PendingAskUserStore {
  private db: NeoxDatabase;

  constructor(db: NeoxDatabase) {
    this.db = db;
  }

  /** 工具调用挂起时调. 同 toolCallId 已存在 → 覆盖 (理论上 toolCallId 唯一, 防御性 REPLACE). */
  record(opts: {
    toolCallId: string;
    sessionId: string;
    questions: AskUserQuestionStored[];
  }): void {
    try {
      this.raw().prepare(`
        INSERT OR REPLACE INTO pending_ask_user (
          tool_call_id, session_id, questions, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        opts.toolCallId,
        opts.sessionId,
        JSON.stringify(opts.questions),
        Date.now(),
      );
    } catch (err: any) {
      cliLogger.warn('PENDING_ASK_USER', `record failed for toolCallId=${opts.toolCallId}: ${err?.message}`);
    }
  }

  /** 查 + 删 atomic — 用 RETURNING (sqlite >=3.35), 失败则两步走. */
  consume(toolCallId: string): PendingAskUserRecord | null {
    try {
      const row = this.raw().prepare(`
        DELETE FROM pending_ask_user WHERE tool_call_id = ? RETURNING *
      `).get(toolCallId) as RawRow | undefined;
      return row ? this.toRecord(row) : null;
    } catch (err: any) {
      /* sqlite RETURNING 不可用 / 版本太老 → 退两步 */
      cliLogger.debug('PENDING_ASK_USER', `RETURNING failed (${err?.message}), falling back to read+delete`);
      try {
        const row = this.raw().prepare(`SELECT * FROM pending_ask_user WHERE tool_call_id = ?`)
          .get(toolCallId) as RawRow | undefined;
        if (!row) return null;
        this.raw().prepare(`DELETE FROM pending_ask_user WHERE tool_call_id = ?`).run(toolCallId);
        return this.toRecord(row);
      } catch (err2: any) {
        cliLogger.warn('PENDING_ASK_USER', `consume failed for toolCallId=${toolCallId}: ${err2?.message}`);
        return null;
      }
    }
  }

  /** 只读查询, 不删. resumeScanner 用它判断 session 是否有挂起的 ask_user. */
  findBySession(sessionId: string): PendingAskUserRecord[] {
    try {
      const rows = this.raw().prepare(`
        SELECT * FROM pending_ask_user WHERE session_id = ? ORDER BY created_at ASC
      `).all(sessionId) as RawRow[];
      return rows.map(r => this.toRecord(r));
    } catch (err: any) {
      cliLogger.warn('PENDING_ASK_USER', `findBySession failed for session=${sessionId}: ${err?.message}`);
      return [];
    }
  }

  /** repairMessageHistory 用 — 拿所有挂起 toolCallId 的 set, 跳过 INTERRUPTED 修补. */
  listToolCallIdsBySession(sessionId: string): Set<string> {
    try {
      const rows = this.raw().prepare(`
        SELECT tool_call_id FROM pending_ask_user WHERE session_id = ?
      `).all(sessionId) as Array<{ tool_call_id: string }>;
      return new Set(rows.map(r => r.tool_call_id));
    } catch (err: any) {
      cliLogger.warn('PENDING_ASK_USER', `listToolCallIdsBySession failed: ${err?.message}`);
      return new Set();
    }
  }

  /** 不带答案直接删 — 工具被 abort / cleanup 时调. */
  delete(toolCallId: string): void {
    try {
      this.raw().prepare(`DELETE FROM pending_ask_user WHERE tool_call_id = ?`).run(toolCallId);
    } catch (err: any) {
      cliLogger.warn('PENDING_ASK_USER', `delete failed for toolCallId=${toolCallId}: ${err?.message}`);
    }
  }

  cleanupExpired(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    try {
      const cutoff = Date.now() - maxAgeMs;
      const result = this.raw().prepare(
        `DELETE FROM pending_ask_user WHERE created_at < ?`,
      ).run(cutoff);
      return (result?.changes ?? 0) as number;
    } catch (err: any) {
      cliLogger.warn('PENDING_ASK_USER', `cleanupExpired failed: ${err?.message}`);
      return 0;
    }
  }

  private raw(): NeoxDatabase['db'] {
    return this.db.getRawDb();
  }

  private toRecord(row: RawRow): PendingAskUserRecord {
    let questions: AskUserQuestionStored[] = [];
    try {
      const parsed = JSON.parse(row.questions);
      if (Array.isArray(parsed)) questions = parsed;
    } catch { /* 损坏数据当空数组 */ }
    return {
      toolCallId: row.tool_call_id,
      sessionId: row.session_id,
      questions,
      createdAt: row.created_at,
    };
  }
}

/** lazy singleton — getDatabase() 未就绪时返 null, 让 caller noop. */
let _instance: PendingAskUserStore | null = null;
export function getPendingAskUserStore(): PendingAskUserStore | null {
  if (_instance) return _instance;
  try {
    const db = getDatabase();
    _instance = new PendingAskUserStore(db);
    /* 启动一次性清理 7 日前死单 — 不引定时器, server 经常重启已自然定期触发. */
    try {
      const cleared = _instance.cleanupExpired();
      if (cleared > 0) cliLogger.info('PENDING_ASK_USER', `cleaned up ${cleared} expired entries (>7d)`);
    } catch { /* swallow — cleanup 失败不阻塞 singleton 创建 */ }
    return _instance;
  } catch {
    return null;
  }
}

/** 测试用 — reset singleton 让单测可以注入 mock db. */
export function _resetPendingAskUserStoreForTest(): void {
  _instance = null;
}
