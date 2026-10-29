/**
 * 从「倒数第 k 条用户消息」起截断 —— 「编辑并重发」的存档那一层.
 *
 *   用真实 NeoxDatabase (临时文件, NEOX_DB_ENCRYPT=0), 因为这条的全部风险都在 SQL 上:
 *   `seq >= ?` 还是 `seq > ?`、OFFSET 数错一位、json_extract 取不到 role —— 每一个
 *   都会让"编辑并重发"变成"改了一半": 存档裁到了错的位置, 而界面按自己的 k 裁另一处,
 *   两边从此对不上。这类错在 mock 上看不出来。
 *
 *   删除必须连存档一起删 (feedback_clear_memory_is_not_delete_purge_archive):
 *   每条断言都**读回来数**, 不看返回值自称删了几条。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;
let db: import('../database.js').NeoxDatabase;
const SID = 'sess-edit';

/** messages 有 FK → sessions, 得先有会话行 */
function ensureSession(id: string): void {
  const now = Date.now();
  db.upsertSession({
    id, name: id, modelId: 'test', workspacePath: '/tmp',
    createdAt: now, updatedAt: now, totalTokens: 0, contextUsed: 0,
  });
}

let seq = 0;
function put(sid: string, itemType: string, itemData: any): void {
  db.insertMessage(sid, seq++, itemType, itemData, Date.now());
}

/** 造一轮: 用户问 → 助手答 → 一次工具调用 */
function seedTurn(nth: number): void {
  put(SID, 'message', { role: 'user', content: `问题${nth}` });
  put(SID, 'message', { role: 'assistant', content: `回答${nth}` });
  put(SID, 'tool_call', { name: 'read_file', args: {} });
}

function roles(): string[] {
  return db.getLastMessages(SID, 999)
    .filter(r => r.itemType === 'message')
    .map(r => `${r.itemData.role}:${r.itemData.content}`);
}

beforeAll(async () => {
  process.env.NEOX_DB_ENCRYPT = '0';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-trunc-db-'));
  const { NeoxDatabase } = await import('../database.js');
  db = new NeoxDatabase(path.join(tmpDir, 'test.db'));
  ensureSession(SID);
  ensureSession('other-sess');
  ensureSession('empty-sess');
});

afterAll(() => {
  try { db?.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  db.clearMessages(SID);
  db.clearMessages('other-sess');
  seq = 0;
  seedTurn(1); seedTurn(2); seedTurn(3);
});

describe('deleteFromNthLastUserMessage', () => {
  it('k=1: 最后一条用户消息**自己也删掉**, 连同它之后的回答和工具调用', () => {
    expect(roles()).toEqual(['user:问题1','assistant:回答1','user:问题2','assistant:回答2','user:问题3','assistant:回答3']);
    const removed = db.deleteFromNthLastUserMessage(SID, 1);
    /* 问题3 + 回答3 + tool_call3 = 3 条 */
    expect(removed).toBe(3);
    expect(roles()).toEqual(['user:问题1','assistant:回答1','user:问题2','assistant:回答2']);
  });

  it('k=2: 回到倒数第二条用户消息之前 (它和之后的两轮全没了)', () => {
    const removed = db.deleteFromNthLastUserMessage(SID, 2);
    expect(removed).toBe(6);
    expect(roles()).toEqual(['user:问题1','assistant:回答1']);
  });

  it('k=3: 裁到空 —— 第一条用户消息也是可编辑的', () => {
    db.deleteFromNthLastUserMessage(SID, 3);
    expect(roles()).toEqual([]);
  });

  it('k 超出用户消息条数 → 返回 -1 且**一条都不删** (调用方据此中止, 不能半裁)', () => {
    expect(db.deleteFromNthLastUserMessage(SID, 4)).toBe(-1);
    expect(roles()).toHaveLength(6);
  });

  it('k 不合法 (0 / 负数 / 小数) → -1 且不删', () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(db.deleteFromNthLastUserMessage(SID, bad)).toBe(-1);
    }
    expect(roles()).toHaveLength(6);
  });

  it('只认 user —— 助手消息不参与数 k (否则 k=1 会停在最后一条回答上)', () => {
    /* 末尾再补一条助手消息, k=1 仍应锚到"问题3" */
      put(SID, 'message', { role: 'assistant', content: '补充' });
    db.deleteFromNthLastUserMessage(SID, 1);
    expect(roles()).toEqual(['user:问题1','assistant:回答1','user:问题2','assistant:回答2']);
  });

  it('不碰别的会话 —— DELETE 必须带 session_id', () => {
    put('other-sess', 'message', { role: 'user', content: '别人的' });
    db.deleteFromNthLastUserMessage(SID, 3);
    expect(db.getLastMessages('other-sess', 99)).toHaveLength(1);
  });

  it('没有任何消息的会话 → -1, 不抛', () => {
    expect(db.deleteFromNthLastUserMessage('empty-sess', 1)).toBe(-1);
  });
});
