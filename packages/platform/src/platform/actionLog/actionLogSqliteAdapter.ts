/**
 * ActionLogSqliteAdapter — SQLite backend for ActionLog
 *
 * Replaces all JSONL file I/O in ActionLogService with SQLite queries.
 * Uses the following tables from Schema V3:
 * - actionlog_events
 * - actionlog_memories
 * - actionlog_graph_nodes / actionlog_graph_edges
 * - actionlog_session_summaries
 */

import type { NeoxDatabase } from '../../platform/database.js';
import type { ActionLogEvent, SessionSummaryItem } from './types.js';
import type { MemoryCategory, MemoryItem, MemoryGraphNode, MemoryGraphEdge } from '../memory/index.js';

export class ActionLogSqliteAdapter {
  private db: NeoxDatabase;
  private workspacePath: string;

  constructor(db: NeoxDatabase, workspacePath: string) {
    this.db = db;
    this.workspacePath = workspacePath;
  }

  private raw() {
    return this.db.getRawDb();
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  insertEvents(events: ActionLogEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.raw().prepare(`
      INSERT OR IGNORE INTO actionlog_events
        (id, workspace_path, seq, ts, event_type, session_id, run_id, actor, summary, reason, files, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.raw().transaction(() => {
      for (const e of events) {
        stmt.run(
          e.id, this.workspacePath, e.seq, e.ts, e.type,
          e.sessionId || null, e.runId || null, e.actor || null,
          e.summary || null, e.reason || null,
          e.files ? JSON.stringify(e.files) : null,
          e.data ? JSON.stringify(e.data) : null
        );
      }
    });
    tx();
  }

  // ==========================================================================
  // Session Summaries
  // ==========================================================================

  insertSessionSummaries(items: SessionSummaryItem[]): void {
    if (items.length === 0) return;
    const stmt = this.raw().prepare(`
      INSERT OR IGNORE INTO actionlog_session_summaries
        (id, workspace_path, session_id, summary, ts, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = this.raw().transaction(() => {
      for (const item of items) {
        stmt.run(
          item.id, this.workspacePath,
          (item as any).sessionId || null,
          item.summary, item.ts,
          null
        );
      }
    });
    tx();
  }

  getRecentSessionSummaries(maxItems: number): SessionSummaryItem[] {
    const rows = this.raw().prepare(`
      SELECT * FROM actionlog_session_summaries
      WHERE workspace_path = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(this.workspacePath, maxItems) as any[];

    return rows.reverse().map(r => ({
      schemaVersion: 1 as const,
      id: r.id,
      ts: r.ts,
      summary: r.summary,
      sessionId: r.session_id || undefined,
    }));
  }

  getSessionSummaryCount(): number {
    const row = this.raw().prepare(
      'SELECT COUNT(*) as cnt FROM actionlog_session_summaries WHERE workspace_path = ?'
    ).get(this.workspacePath) as { cnt: number };
    return row.cnt;
  }

  // ==========================================================================
  // Memory Items
  // ==========================================================================

  insertMemoryItems(items: MemoryItem[]): void {
    if (items.length === 0) return;
    const stmt = this.raw().prepare(`
      INSERT OR IGNORE INTO actionlog_memories
        (id, workspace_path, category, summary, source, confidence, tags, ts, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.raw().transaction(() => {
      for (const item of items) {
        stmt.run(
          item.id, this.workspacePath, item.category,
          item.summary, (item as any).source || null,
          item.confidence ?? 1.0,
          (item as any).tags ? JSON.stringify((item as any).tags) : null,
          item.ts, null
        );
      }
    });
    tx();
  }

  getRecentMemoryItems(category: MemoryCategory, maxItems: number): MemoryItem[] {
    const rows = this.raw().prepare(`
      SELECT * FROM actionlog_memories
      WHERE workspace_path = ? AND category = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(this.workspacePath, category, maxItems) as any[];

    return rows.reverse().map(r => ({
      schemaVersion: 1 as const,
      id: r.id,
      ts: r.ts,
      category: r.category as MemoryCategory,
      summary: r.summary,
      confidence: r.confidence,
    }));
  }

  getMemoryItemCount(category: MemoryCategory): number {
    const row = this.raw().prepare(
      'SELECT COUNT(*) as cnt FROM actionlog_memories WHERE workspace_path = ? AND category = ?'
    ).get(this.workspacePath, category) as { cnt: number };
    return row.cnt;
  }

  // ==========================================================================
  // Graph
  // ==========================================================================

  insertGraphNodes(nodes: MemoryGraphNode[]): void {
    if (nodes.length === 0) return;
    const stmt = this.raw().prepare(`
      INSERT OR IGNORE INTO actionlog_graph_nodes
        (id, workspace_path, label, node_type, run_id, ts, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.raw().transaction(() => {
      for (const n of nodes) {
        stmt.run(
          n.id, this.workspacePath, n.label,
          n.type || null, (n as any).runId || null,
          n.ts || Date.now(), null
        );
      }
    });
    tx();
  }

  insertGraphEdges(edges: MemoryGraphEdge[]): void {
    if (edges.length === 0) return;
    const stmt = this.raw().prepare(`
      INSERT INTO actionlog_graph_edges
        (workspace_path, source_id, target_id, relation, run_id, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = this.raw().transaction(() => {
      for (const e of edges) {
        stmt.run(
          this.workspacePath, e.from, e.to,
          e.type || null, (e as any).runId || null,
          e.ts || Date.now()
        );
      }
    });
    tx();
  }

  getGraphRunMatches(labels: string[]): Set<string> {
    if (labels.length === 0) return new Set();
    const placeholders = labels.map(() => '?').join(', ');
    const rows = this.raw().prepare(`
      SELECT DISTINCT run_id FROM actionlog_graph_nodes
      WHERE workspace_path = ? AND label IN (${placeholders})
      AND run_id IS NOT NULL
    `).all(this.workspacePath, ...labels) as { run_id: string }[];
    return new Set(rows.map(r => r.run_id));
  }
}
