import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { InterruptedRunStore } from '../InterruptedRunStore.js';

const SCHEMA = `
CREATE TABLE interrupted_runs (
  session_id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_id TEXT,
  prompt TEXT NOT NULL,
  metadata TEXT,
  started_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  server_pid INTEGER,
  server_token TEXT,
  iteration INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  completed_at INTEGER,
  error_message TEXT
);
`;

let raw: Database.Database;
let store: InterruptedRunStore;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(SCHEMA);
  store = new InterruptedRunStore({ getRawDb: () => raw } as any, '/ws');
});

afterEach(() => {
  raw.close();
});

function start(sessionId: string, prompt: string): void {
  store.recordStart({ sessionId, workspacePath: '/ws', mode: 'agentic', model: 'm', prompt });
}

describe('findOpenTurn', () => {
  it('running 的一轮算未完成', () => {
    start('s1', '整理季度报表');
    expect(store.findOpenTurn('s1')?.prompt).toBe('整理季度报表');
  });

  it('正常完成的不算', () => {
    start('s1', '发邮件');
    store.markCompleted('s1');
    expect(store.findOpenTurn('s1')).toBeNull();
  });

  it('主动取消的不算, 出错但没重试的算', () => {
    start('s1', 'A');
    store.markCancelled('s1');
    expect(store.findOpenTurn('s1')).toBeNull();

    start('s1', 'B');
    store.markErrored('s1', 'boom');
    expect(store.findOpenTurn('s1')?.prompt).toBe('B');
  });

  it('跨进程重启 (同一个库) 仍读得到 —— 就是 H-08 的验收场景', () => {
    start('s1', '把会议纪要发到群里');
    /* 模拟容器重启: 新建一个 store 指向同一份数据 */
    const afterRestart = new InterruptedRunStore({ getRawDb: () => raw } as any, '/ws');
    expect(afterRestart.findOpenTurn('s1')?.prompt).toBe('把会议纪要发到群里');
  });

  it('超过 24 小时的不再算待办', () => {
    start('s1', '很久以前的事');
    raw.prepare('UPDATE interrupted_runs SET started_at = ? WHERE session_id = ?').run(Date.now() - 25 * 60 * 60_000, 's1');
    expect(store.findOpenTurn('s1')).toBeNull();
  });

  it('没有记录 / 库异常时安静返回 null', () => {
    expect(store.findOpenTurn('nope')).toBeNull();
    raw.close();
    expect(store.findOpenTurn('s1')).toBeNull();
  });
});
