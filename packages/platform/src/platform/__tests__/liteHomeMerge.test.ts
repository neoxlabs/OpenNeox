/**
 * ~/.neox-lite → ~/.neox 一次性合并。
 *
 *   3.5.3 ~ 3.6.7 的标准版误用了极简版目录一周: 登录态 / BYOK 配置 / 记忆等 home 文件落在 .neox-lite,
 *   更早几个月的在 .neox。两边都得留住: 普通文件新的赢, 旧的留 .pre-lite-merge。
 *   sqlite 库不碰: 库一直在 Application Support 下没受影响, .neox-lite 里的库是真极简版的数据。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLiteHomeToStandard } from '../database.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-lite-merge-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writeAt(file: string, content: string, mtimeSec: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtimeSec, mtimeSec);
}

describe('migrateLiteHomeToStandard', () => {
  it('普通文件: 目标没有的搬过来, 两边都有的新的赢且旧的留备份; 缓存目录和 sqlite 库不搬', () => {
    const lite = path.join(root, '.neox-lite');
    const std = path.join(root, '.neox');
    writeAt(path.join(lite, 'auth.enc'), 'lite-auth', 2000);          // lite 更新
    writeAt(path.join(std, 'auth.enc'), 'std-auth', 1000);
    writeAt(path.join(lite, 'config.json'), '{"lite":1}', 1000);       // std 更新
    writeAt(path.join(std, 'config.json'), '{"std":1}', 2000);
    writeAt(path.join(lite, 'memory', 'a.md'), 'A', 1500);            // 目标没有
    writeAt(path.join(std, 'knowledge', 'k.md'), 'K', 1500);          // lite 没有, 原样
    writeAt(path.join(lite, 'logs', 'stall.log'), 'x', 1500);         // 缓存, 不搬
    writeAt(path.join(lite, 'checkpoints', 'c.bin'), 'x', 1500);      // 缓存, 不搬
    writeAt(path.join(lite, 'neox-cli.db'), 'lite-db', 3000);         // 极简版自己的库, 不搬
    writeAt(path.join(lite, 'neox-cli.db-wal'), 'wal', 3000);

    const r = migrateLiteHomeToStandard({ liteDir: lite, stdDir: std });
    expect(r.skipped).toBe(false);
    expect(fs.readFileSync(path.join(std, 'auth.enc'), 'utf8')).toBe('lite-auth');
    expect(fs.readFileSync(path.join(std, 'auth.enc.pre-lite-merge'), 'utf8')).toBe('std-auth');
    expect(fs.readFileSync(path.join(std, 'config.json'), 'utf8')).toBe('{"std":1}');
    expect(fs.existsSync(path.join(std, 'config.json.pre-lite-merge'))).toBe(false);
    expect(fs.readFileSync(path.join(std, 'memory', 'a.md'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(std, 'knowledge', 'k.md'), 'utf8')).toBe('K');
    expect(fs.existsSync(path.join(std, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(std, 'checkpoints'))).toBe(false);
    expect(fs.existsSync(path.join(std, 'neox-cli.db'))).toBe(false);
    expect(fs.existsSync(path.join(std, 'neox-cli.db-wal'))).toBe(false);
    /* 源目录原样保留 */
    expect(fs.readFileSync(path.join(lite, 'auth.enc'), 'utf8')).toBe('lite-auth');
    /* marker 落了, 第二次是 no-op */
    expect(fs.existsSync(path.join(std, '.merged_from_lite_v1'))).toBe(true);
    expect(migrateLiteHomeToStandard({ liteDir: lite, stdDir: std }).skipped).toBe(true);
  });

  it('没有极简版目录 → 直接打 marker', () => {
    const std = path.join(root, '.neox');
    const r = migrateLiteHomeToStandard({ liteDir: path.join(root, 'nope'), stdDir: std });
    expect(r.skipped).toBe(true);
    expect(fs.existsSync(path.join(std, '.merged_from_lite_v1'))).toBe(true);
  });
});
