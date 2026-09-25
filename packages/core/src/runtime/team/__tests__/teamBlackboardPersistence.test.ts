/**
 * 黑板落盘 roundtrip 单测 — TeamBlackboard → team_sessions.blackboard → 读回 (§3.3)
 *
 * 用真实 NeoxDatabase (临时文件, NEOX_DB_ENCRYPT=0 走明文 + node-ABI native 备份),
 * 验证 upsertTeamSession / getTeamSession 与黑板序列化的完整闭环。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TeamBlackboard, parseBlackboardJson } from '../teamBlackboard.js';

let tmpDir: string;
let db: import('@neoxlabs/platform/platform/database.js').NeoxDatabase;

beforeAll(async () => {
  process.env.NEOX_DB_ENCRYPT = '0'; // 明文模式 — 测试环境无 keychain, 且 plain native 备份 ABI 已就位
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-team-db-'));
  const { NeoxDatabase } = await import('@neoxlabs/platform/platform/database.js');
  db = new NeoxDatabase(path.join(tmpDir, 'test.db'));
});

afterAll(() => {
  try { db?.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('TeamBlackboard 内存行为', () => {
  it('post 归一化: summary 超 500 字截断, ts 自动补', () => {
    const bb = new TeamBlackboard();
    const long = 'x'.repeat(800);
    const entry = bb.post('t1', { key: 'k1', kind: 'note', summary: long, author: 'conductor' });
    expect(entry.summary.length).toBeLessThanOrEqual(500);
    expect(entry.ts).toBeGreaterThan(0);
    expect(bb.list('t1')).toHaveLength(1);
  });

  it('dispose 释放内存', () => {
    const bb = new TeamBlackboard();
    bb.post('t1', { key: 'k1', kind: 'result', summary: 's', author: 'a' });
    bb.dispose('t1');
    expect(bb.list('t1')).toHaveLength(0);
  });
});

describe('黑板落盘 roundtrip (team_sessions)', () => {
  it('post → serialize → upsertTeamSession → getTeamSession → parse 条目一致', () => {
    const bb = new TeamBlackboard();
    const teamId = 'team_rt_1';
    const e1 = bb.post(teamId, {
      key: 'L1.result', kind: 'result', ref: 'neox-worktree/agent-x', summary: '模块 A 完成', author: 'L1',
    });
    const e2 = bb.post(teamId, {
      key: 'L2.blocker', kind: 'blocker', summary: '缺依赖', author: 'L2',
    });

    db.upsertTeamSession({
      teamId,
      workspacePath: '/tmp/ws',
      sessionId: 'sess-1',
      goal: '重构 X',
      mode: 'swimlane',
      status: 'success',
      leaderId: 'sess-1',
      memberIds: ['L1', 'L2'],
      blackboard: bb.serialize(teamId),
      missionGraph: JSON.stringify({ lanes: [] }),
    });

    const row = db.getTeamSession(teamId);
    expect(row).not.toBeNull();
    expect(row!.goal).toBe('重构 X');
    expect(row!.status).toBe('success');
    expect(row!.memberIds).toEqual(['L1', 'L2']);

    const entries = parseBlackboardJson(row!.blackboard);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(e1);
    expect(entries[1]).toEqual(e2);
    expect(entries[0].ref).toBe('neox-worktree/agent-x');
    expect(entries[1].kind).toBe('blocker');
  });

  it('upsert 幂等更新: 同 teamId 二次写覆盖 status/blackboard, created_at 不回退', () => {
    const teamId = 'team_rt_2';
    const createdAt = Date.now() - 60_000;
    db.upsertTeamSession({
      teamId, workspacePath: '/tmp/ws', sessionId: 's', goal: 'g',
      status: 'running', memberIds: ['L1'], blackboard: '[]', createdAt,
    });
    const bb = new TeamBlackboard();
    bb.post(teamId, { key: 'k', kind: 'result', summary: 'done', author: 'L1' });
    db.upsertTeamSession({
      teamId, workspacePath: '/tmp/ws', sessionId: 's', goal: 'g',
      status: 'partial', memberIds: ['L1'], blackboard: bb.serialize(teamId), createdAt,
    });

    const row = db.getTeamSession(teamId);
    expect(row!.status).toBe('partial');
    expect(parseBlackboardJson(row!.blackboard)).toHaveLength(1);
    expect(row!.createdAt).toBe(createdAt);
  });

  it('损坏的 blackboard JSON 解析为 [] 不抛', () => {
    expect(parseBlackboardJson('{oops')).toEqual([]);
    expect(parseBlackboardJson(null)).toEqual([]);
    expect(parseBlackboardJson('"not-array"')).toEqual([]);
  });

  it('getTeamSession 未知 teamId 返回 null', () => {
    expect(db.getTeamSession('nope')).toBeNull();
  });
});
