import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home };
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neox-modehome-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 产物根跟发行版走: 默认按商业版 (~/Neox) 测老位置迁移, 公开树里 DISTRIBUTION 是开源版身份, 不钉住就全红 */
async function loadAs(userRootDirname: string) {
  vi.resetModules();
  vi.doMock('@neoxlabs/kernel/platform/distribution.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@neoxlabs/kernel/platform/distribution.js')>();
    return { DISTRIBUTION: { ...actual.DISTRIBUTION, userRootDirname } };
  });
  return import('../modeHome.js');
}

const loadModule = () => loadAs('Neox');

afterEach(() => { vi.doUnmock('@neoxlabs/kernel/platform/distribution.js'); });

describe('modeHome v3', () => {
  it('新用户的产物根是 ~/Neox, 目录是英文 Work / Code / Pilot', async () => {
    const { ensureModeHome, getNeoxUserRoot } = await loadModule();
    expect(getNeoxUserRoot()).toBe(join(home, 'Neox'));
    const work = ensureModeHome('work');
    expect(work).toBe(join(home, 'Neox', 'Work'));
    expect(existsSync(work)).toBe(true);
    expect(ensureModeHome('code')).toBe(join(home, 'Neox', 'Code'));
    expect(ensureModeHome('pilot')).toBe(join(home, 'Neox', 'Pilot'));
  });

  it('movedLegacyModeHomes: 只列确实搬走了的老目录 (老的不在、新的在), 供会话路径换前缀', async () => {
    mkdirSync(join(home, 'Documents', 'Neox', '工作', 't1'), { recursive: true });
    mkdirSync(join(home, 'Documents', 'Neox', '领航'), { recursive: true });
    mkdirSync(join(home, 'Neox', 'Pilot'), { recursive: true }); /* 目标已存在 → 领航不搬, 不该列 */

    const { ensureModeHome, movedLegacyModeHomes } = await loadModule();
    ensureModeHome('work');
    ensureModeHome('pilot');
    const moves = movedLegacyModeHomes();

    expect(moves).toContainEqual({ from: join(home, 'Documents', 'Neox', '工作'), to: join(home, 'Neox', 'Work') });
    expect(moves.some(m => m.from.endsWith('领航'))).toBe(false);
  });

  it('老用户 ~/Documents/Neox/工作 迁到 ~/Neox/Work 且名字改成英文', async () => {
    const oldTask = join(home, 'Documents', 'Neox', '工作', '2026-10-19 做PPT');
    mkdirSync(oldTask, { recursive: true });
    writeFileSync(join(oldTask, 'a.pptx'), 'x');

    const { ensureModeHome } = await loadModule();
    const dir = ensureModeHome('work');

    /* 关键: 返回的路径必须就是文件现在所在的地方, 否则界面打开的是空目录 */
    expect(dir).toBe(join(home, 'Neox', 'Work'));
    expect(existsSync(join(dir, '2026-10-19 做PPT', 'a.pptx'))).toBe(true);
    /* 老根搬空 → 收掉 */
    expect(existsSync(join(home, 'Documents', 'Neox'))).toBe(false);
  });

  it('新位置已有内容时不覆盖老数据', async () => {
    mkdirSync(join(home, 'Documents', 'Neox', '工作'), { recursive: true });
    writeFileSync(join(home, 'Documents', 'Neox', '工作', 'old.txt'), 'old');
    mkdirSync(join(home, 'Neox', 'Work'), { recursive: true });
    writeFileSync(join(home, 'Neox', 'Work', 'new.txt'), 'new');

    const { ensureModeHome } = await loadModule();
    const dir = ensureModeHome('work');

    expect(dir).toBe(join(home, 'Neox', 'Work'));
    expect(existsSync(join(dir, 'new.txt'))).toBe(true);
    expect(existsSync(join(dir, 'old.txt'))).toBe(false);
  });

  it('目标目录已存在 (哪怕空的) 就不自动搬 —— 绝不删用户数据', async () => {
    const oldTask = join(home, 'Documents', 'Neox', '工作', '老任务');
    mkdirSync(oldTask, { recursive: true });
    writeFileSync(join(oldTask, 'b.docx'), 'y');
    mkdirSync(join(home, 'Neox', 'Work'), { recursive: true });

    const { ensureModeHome } = await loadModule();
    const dir = ensureModeHome('work');

    /* 目标还在, 且没被删 */
    expect(dir).toBe(join(home, 'Neox', 'Work'));
    expect(existsSync(join(home, 'Neox', 'Work'))).toBe(true);
    /* 老数据原封不动留在原地, 一条都不少 */
    expect(existsSync(join(home, 'Documents', 'Neox', '工作', '老任务', 'b.docx'))).toBe(true);
  });

  it('老根里还有用户自己的东西时保留, 不删', async () => {
    mkdirSync(join(home, 'Documents', 'Neox', '工作'), { recursive: true });
    writeFileSync(join(home, 'Documents', 'Neox', '用户自己放的.docx'), 'keep');

    const { ensureModeHome } = await loadModule();
    ensureModeHome('work');

    expect(existsSync(join(home, 'Documents', 'Neox', '用户自己放的.docx'))).toBe(true);
  });

  it('v1 的 ~/Neox/work 也归并到 Work', async () => {
    mkdirSync(join(home, 'Neox', 'work'), { recursive: true });
    writeFileSync(join(home, 'Neox', 'work', 'old.txt'), 'old');

    const { ensureModeHome } = await loadModule();
    const dir = ensureModeHome('work');

    expect(dir).toBe(join(home, 'Neox', 'Work'));
    expect(existsSync(join(dir, 'old.txt'))).toBe(true);
  });

  it('幂等: 连调多次不炸、路径不变、不重复搬', async () => {
    const { ensureModeHome } = await loadModule();
    const first = ensureModeHome('work');
    const second = ensureModeHome('work');
    expect(second).toBe(first);
    expect(readdirSync(join(home, 'Neox'))).toEqual(['Work']);
  });
});

describe('modeHome: 另一个发行版 (开源版)', () => {
  it('产物落在自己的根下, 不碰商业版的 ~/Neox 和 ~/Documents/Neox', async () => {
    mkdirSync(join(home, 'Neox', 'Work'), { recursive: true });
    writeFileSync(join(home, 'Neox', 'Work', 'report.pptx'), 'x');
    mkdirSync(join(home, 'Documents', 'Neox', '工作'), { recursive: true });
    const { ensureModeHome, movedLegacyModeHomes } = await loadAs('OpenNeox');
    expect(ensureModeHome('work')).toBe(join(home, 'OpenNeox', 'Work'));
    expect(readdirSync(join(home, 'OpenNeox', 'Work'))).toEqual([]);
    expect(existsSync(join(home, 'Documents', 'Neox', '工作'))).toBe(true);
    expect(movedLegacyModeHomes()).toEqual([]);
  });
});
