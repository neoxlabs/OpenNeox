/**
 * work E-05 — 文件被占用 (Excel 开着) 时的失败与重试
 *
 * 验收标准: 检出锁定并给出「关掉 Excel 后点重试」; 重试成功率高。
 * 这些用例全部走真实文件系统 (锁定文件 / 只读位 / 真写), 不 mock fs。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OfficeFileLockedError,
  detectOfficeLock,
  isOfficeLockError,
  withOfficeWriteRetry,
} from '../officeFileLock.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-officelock-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeFile(name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'original');
  return p;
}

describe('detectOfficeLock', () => {
  it('Excel 开着时同目录有 ~$ 锁定文件 → 检出并认出 Excel', () => {
    const file = makeFile('report.xlsx');
    fs.writeFileSync(path.join(dir, '~$report.xlsx'), '');
    const info = detectOfficeLock(file);
    expect(info.locked).toBe(true);
    expect(info.app).toBe('Excel');
    expect(info.lockFile).toBe(path.join(dir, '~$report.xlsx'));
  });

  it('长文件名 (Office 吃掉前两个字符) 也能检出', () => {
    const file = makeFile('Quarterly Report.xlsx');
    fs.writeFileSync(path.join(dir, '~$arterly Report.xlsx'), '');
    expect(detectOfficeLock(file).locked).toBe(true);
  });

  it('LibreOffice 的 .~lock 文件也算占用', () => {
    const file = makeFile('budget.docx');
    fs.writeFileSync(path.join(dir, '.~lock.budget.docx#'), '');
    const info = detectOfficeLock(file);
    expect(info.locked).toBe(true);
    expect(info.app).toBe('LibreOffice');
  });

  it('没人开着 → 未锁定; 文件不存在 → 未锁定', () => {
    const file = makeFile('free.xlsx');
    expect(detectOfficeLock(file).locked).toBe(false);
    expect(detectOfficeLock(path.join(dir, 'new.xlsx')).locked).toBe(false);
  });

  it('只读文件不算占用 (那是 E-08 读只读目录的范围)', () => {
    const file = makeFile('readonly.xlsx');
    fs.chmodSync(file, 0o444);
    expect(detectOfficeLock(file).locked).toBe(false);
  });
});

describe('withOfficeWriteRetry', () => {
  it('锁定文件在时, 优先给出中文可执行指引', async () => {
    const file = makeFile('locked.xlsx');
    fs.writeFileSync(path.join(dir, '~$locked.xlsx'), '');

    const err = await withOfficeWriteRetry(file, () => { throw new Error('should not write'); }, {
      retries: 1, delaysMs: [0, 0],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(OfficeFileLockedError);
    expect(err.code).toBe('file_locked');
    expect(err.app).toBe('Excel');
    expect(err.message).toContain('文件被占用');
    expect(err.message).toContain('关掉');
    expect(err.message).toContain('重试');
    expect(err.message).toContain('异常退出');
  });

  it('瞬时 EBUSY 会重试, 下一轮成功 (重试成功率高)', async () => {
    const file = makeFile('transient.xlsx');
    let attempts = 0;
    const result = await withOfficeWriteRetry(file, () => {
      attempts++;
      if (attempts < 3) {
        const e: any = new Error('resource busy or locked');
        e.code = 'EBUSY';
        throw e;
      }
      fs.writeFileSync(file, 'written');
      return 'ok';
    }, { retries: 3, delaysMs: [0, 0, 0] });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(fs.readFileSync(file, 'utf8')).toBe('written');
  });

  it('一直 EBUSY → 抛 file_locked, 不把英文 errno 丢给用户', async () => {
    const file = makeFile('busy.xlsx');
    await expect(withOfficeWriteRetry(file, () => {
      const e: any = new Error('resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    }, { retries: 2, delaysMs: [0, 0, 0] })).rejects.toMatchObject({ code: 'file_locked', attempts: 3 });
  });

  it('非占用类错误原样上抛, 不包成"被占用"', async () => {
    const file = makeFile('other.xlsx');
    const boom = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    await expect(withOfficeWriteRetry(file, () => { throw boom; }, { delaysMs: [0] }))
      .rejects.toBe(boom);
  });

  it('锁文件在但用户随后关掉 Excel → 下一次工具调用直接写成功', async () => {
    const file = makeFile('closed-in-time.xlsx');
    const lockFile = path.join(dir, '~$closed-in-time.xlsx');
    fs.writeFileSync(lockFile, '');

    const first = await withOfficeWriteRetry(file, () => fs.writeFileSync(file, 'v2'), {
      retries: 1, delaysMs: [0, 0],
    }).catch((e) => e);
    expect(first).toBeInstanceOf(OfficeFileLockedError);

    fs.rmSync(lockFile);   // 用户关掉 Excel
    await withOfficeWriteRetry(file, () => fs.writeFileSync(file, 'v2'), { delaysMs: [0] });
    expect(fs.readFileSync(file, 'utf8')).toBe('v2');
  });
});

describe('isOfficeLockError', () => {
  it('只认占用类 errno', () => {
    expect(isOfficeLockError({ code: 'EBUSY' })).toBe(true);
    expect(isOfficeLockError({ code: 'EACCES' })).toBe(true);
    expect(isOfficeLockError({ code: 'ENOSPC' })).toBe(false);
    expect(isOfficeLockError(new Error('x'))).toBe(false);
  });
});
