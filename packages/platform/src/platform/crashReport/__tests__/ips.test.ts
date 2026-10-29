
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIps, findNativeCrashReports } from '../ips.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'node-abort-sample.ips');

describe('parseIps', () => {
  it('解析出进程名 / signal / 触发线程的栈 (模块!符号)', () => {
    const content = fs.readFileSync(FIXTURE, 'utf-8');
    const info = parseIps(content, FIXTURE);
    expect(info).not.toBeNull();
    expect(info!.procName).toBe('node');
    expect(info!.signal).toBe('SIGABRT');
    expect(info!.exceptionType).toBe('EXC_CRASH');
    expect(info!.frames.length).toBeGreaterThan(0);
    expect(info!.frames.length).toBeLessThanOrEqual(20);
    /* 关键帧必须能定位到 better-sqlite3 */
    expect(info!.frames.some((f) => f.includes('better_sqlite3'))).toBe(true);
    /* 第一帧是触发线程的 __pthread_kill */
    expect(info!.frames[0]).toContain('libsystem_pthread.dylib!__pthread_kill');
  });

  it('栈里绝不带整条绝对路径 (只留模块名)', () => {
    const info = parseIps(fs.readFileSync(FIXTURE, 'utf-8'), FIXTURE);
    for (const frame of info!.frames) {
      expect(frame).not.toContain('/Users/');
    }
  });

  it('空内容 / 坏 JSON 返回 null', () => {
    expect(parseIps('')).toBeNull();
    expect(parseIps('not json\nnot json either')).toBeNull();
  });

  it('没有 faultingThread 时退到 triggered 线程', () => {
    const header = '{"app_name":"node"}';
    const body = JSON.stringify({
      procName: 'node',
      threads: [{ triggered: true, frames: [{ imageIndex: 0, symbol: 'boom' }] }],
      usedImages: [{ name: 'mymod' }],
    });
    const info = parseIps(`${header}\n${body}`);
    expect(info!.frames).toEqual(['mymod!boom']);
  });
});

describe('findNativeCrashReports', () => {
  it('按进程名白名单与时间过滤, 排序返回', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-ips-'));
    fs.copyFileSync(FIXTURE, path.join(dir, 'node-2026-10-18-032240.ips'));
    /* 不在白名单的进程不捡 */
    fs.copyFileSync(FIXTURE, path.join(dir, 'Safari-2026-10-18-032240.ips'));
    /* since 在未来 → 全部过滤掉 */
    const list = findNativeCrashReports({ dir, procNames: ['node'] });
    expect(list).toHaveLength(1);
    expect(list[0].procName).toBe('node');

    const none = findNativeCrashReports({ dir, procNames: ['node'], since: Date.now() + 3_600_000 });
    expect(none).toHaveLength(0);
  });

  it('目录不存在时返回空数组', () => {
    expect(findNativeCrashReports({ dir: '/nonexistent/xyz' })).toEqual([]);
  });
});
