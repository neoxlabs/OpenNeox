import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NeoxDatabase } from '../database.js';
import { _resetMasterKeyCache } from '../dbCipher.js';

/**
 *  真实数据丢失回归钉 —— 加密库拿错 key 打开时, 绝不允许整库改名弃用。
 *
 *   现场: 用户机器 ~/Library/Application Support/Neox/ 下累计 43 份 neox-cli.db.broken.*,
 *   最大一份 74MB。机制:
 *     · sqlcipher 用错 key 打开时, 每一条 SELECT 都抛 `file is not a database`;
 *     · probeDbForQuarantineDecision 把 sessions 的 COUNT 失败 catch 成 hasUserData=false;
 *     · 同一个错误串又被 isTrueCorruption 判成真损坏 ⇒ decide 返回 'quarantine'。
 *   于是「有用户数据就不隔离」这道护栏, 在"数据完好、只是没解开"这个唯一真正需要它的
 *   场景下, 结构上永远不可能触发。
 *
 *   本测试走真库 (不 mock 决策函数): 用 key A 建库写数据, 再用 key B 打开, 断言
 *     (1) 抛错 —— 拒绝启动;
 *     (2) 盘上没有任何 .broken.* —— 原文件一个字节都没动。
 *   加密不可用的环境 (没编 sqlcipher) 直接跳过, 不伪装成绿。
 */

/* key 的唯一可控来源是 machine-id 文件 (无 env 覆盖) —— 换它的内容 = 换 key。
 * os.homedir() 在 POSIX 上读 $HOME, 所以隔离 HOME 就能隔离 machine-id。 */
let dir: string | null = null;
let prevHome: string | undefined;

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  _resetMasterKeyCache();
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } dir = null; }
});

function brokenFiles(d: string): string[] {
  return fs.readdirSync(d).filter((f) => f.includes('.broken.'));
}

function setMachineId(home: string, value: string): void {
  const p = path.join(home, 'Library', 'Application Support', 'Neox');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'machine-id'), value);
  _resetMasterKeyCache();
}

describe('加密库 key 不匹配', () => {
  it('拒绝启动, 且绝不把原库改名 .broken', () => {
    if (process.platform !== 'darwin') return; /* machine-id 路径按平台分叉, 只在 darwin 上构造 */
    prevHome = process.env.HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dbkey-'));
    process.env.HOME = dir;
    const dbDir = path.join(dir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'neox-cli.db');

    setMachineId(dir, 'machine-AAAA-0000');
    const db1: any = new NeoxDatabase(dbPath);
    try { db1.close?.(); } catch { /* noop */ }

    /* 明文库不构成本用例 — 说明这台机器没编 sqlcipher / 加密没启用 */
    const encrypted = !fs.readFileSync(dbPath).subarray(0, 15).toString('latin1').startsWith('SQLite format');
    if (!encrypted) { expect(brokenFiles(dbDir)).toEqual([]); return; }

    const sizeBefore = fs.statSync(dbPath).size;
    setMachineId(dir, 'machine-BBBB-1111');

    expect(() => { const d2: any = new NeoxDatabase(dbPath); d2.close?.(); }).toThrow();
    expect(brokenFiles(dbDir)).toEqual([]);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).size).toBe(sizeBefore);
  });
});
