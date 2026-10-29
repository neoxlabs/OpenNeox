import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/* 六层不是五层 —— __tests__ → tabs → settings → pages → renderer → ui → src。
 * 这几轮我已经在相对路径上栽过两次 (少一层 → ENOENT → 整个文件"no tests", 看着像通过)。
 * 所以下面单独有一条路径自检: 路径错了要**报路径错**, 不能静悄悄地什么都不测。 */
const MAIN_PATH = join(__dirname, '..', '..', '..', '..', '..', '..', 'platform-electron', 'storageService.ts');
const MAIN = strip(readFileSync(MAIN_PATH, 'utf8'));
const TAB = strip(readFileSync(join(__dirname, '..', 'StorageTab.tsx'), 'utf8'));

describe('存储占用不重复计数', () => {
  it('两个源文件都真的读到了 —— 路径错会让整组闸静悄悄地什么都不测', () => {
    expect(MAIN.length).toBeGreaterThan(2000);
    expect(TAB.length).toBeGreaterThan(2000);
    expect(MAIN).toContain('storageService');
  });

  it('总数只是 files 之和, 不再额外加一次 checkpoint', () => {
    expect(MAIN).not.toMatch(/totalSize:\s*totalSize\s*\+\s*checkpointInfo\.totalSize/);
    expect(MAIN).toMatch(/totalSize,\s*\n\s*files,/);
  });

  it("checkpoints/ 仍然在 files 里 —— 它才是那份数据的正主", () => {
    /* 如果哪天改成"从 files 里拿掉 checkpoints/、靠 checkpointTotalSize 补",
     * 上面那条断言也会过, 但总数又会缺一块。两边一起钉住才闭合。 */
    expect(MAIN).toMatch(/name: 'checkpoints\/'/);
  });

  it('条形图不再 push 独立的「代码回退」段', () => {
    expect(TAB).not.toMatch(/raw\.push\(\{\s*key:\s*'checkpoint'/);
  });

  it('checkpointTotalSize 仍然返回 —— 清理区要靠它显示"能清多少"', () => {
    expect(MAIN).toMatch(/checkpointTotalSize:\s*checkpointInfo\.totalSize/);
    expect(TAB).toMatch(/checkpointTotalSize/);
  });
});

/* ── 废弃数据库副本必须被算进去并单独成栏 ── */

describe('废弃数据库副本', () => {
  it('有专门的统计函数, **而且真的被调用了**, 且只认明确的后缀', () => {
    expect(MAIN).toMatch(/private async getStaleDbBackupSize/);
    /* 只查"函数存在"是不够的 —— 变异验证时把调用点换成 Promise.resolve(0),
     * 函数还在、闸照样全绿。声明和调用要分开断言。 */
    expect(MAIN).toMatch(/this\.getStaleDbBackupSize\(\)/);
    expect(MAIN).toMatch(/staleDbSize/);
    /* 不做模糊匹配 —— 宁可漏一个没见过的新后缀, 也不能把活库或用户自己的文件
     * 算进"可以删"的那一栏。 */
    expect(MAIN).toMatch(/broken\|pre-migrate\|pre-v/);
    expect(MAIN).not.toMatch(/const STALE = \/\^neox\\\.db\\\.\.\*\//);
  });

  it('正则的分隔符点号和连字符都认 —— 真机上 pre-migrate 用的是连字符', () => {
    /* 第一版只写了点号, 拿真实文件名一验就漏掉 pre-migrate 那三个。
     * 这里把判据本身抠出来, 用真实文件名跑一遍 —— 正则光看着像对是不够的。 */
    const m = /const STALE = (\/[^\n]+\/);/.exec(MAIN);
    expect(m, '找不到 STALE 正则').not.toBeNull();
    // eslint-disable-next-line no-eval
    const re: RegExp = eval(m![1]);
    const REAL = [
      'neox.db.broken.1784784919927',
      'neox.db.encrypting.1783156959516',
      'neox.db.pre-v2.5.0-clean.1783070623',
      'neox.db.pre-v2.5.0-clean.1783070623-wal',
      'neox.db.pre-migrate-1782910093433',          // ← 连字符
      'neox.db.pre-migrate-1782910093433-shm',
    ];
    for (const n of REAL) expect(re.test(n), `应当认出 ${n}`).toBe(true);
    /* 活库和它的 wal/shm 绝不能被当成可删 */
    for (const n of ['neox.db', 'neox.db-wal', 'neox.db-shm']) {
      expect(re.test(n), `不该把 ${n} 当成废弃副本`).toBe(false);
    }
  });

  it('单独成栏, 不并进「数据库」—— 并进去用户会以为那是自己的数据', () => {
    expect(MAIN).toMatch(/name: 'neox\.db\.backups'/);
    expect(TAB).toMatch(/'neox\.db\.backups':/);
  });
});

/* ── 旧版 CLI 二进制 ── */

describe('旧版命令行工具', () => {
  it('单独统计并成栏, 且函数真的被调用', () => {
    expect(MAIN).toMatch(/private async getStaleCliBinarySize/);
    expect(MAIN).toMatch(/this\.getStaleCliBinarySize\(\)/);
    expect(MAIN).toMatch(/name: 'bin\/\.stale'/);
    expect(TAB).toMatch(/'bin\/\.stale':/);
  });

  it("bin/ 那一栏要扣掉旧版部分 —— 不扣两栏加起来会超过 bin/ 实际大小", () => {
    expect(MAIN).toMatch(/size: Math\.max\(0, binSize - staleCliSize\)/);
  });

  it('只认显式备份命名, 不猜 neox-<ver> 哪个是旧的', () => {
    const m = /const STALE = (\/\^neox[^\n]+\/);\s*\n\s*const hits = entries\.filter\(n => STALE\.test\(n\)\);\s*\n\s*const sizes = await Promise\.all\(hits\.map\(n => this\.getFileSize\(path\.join\(binDir/.exec(MAIN);
    expect(m, '找不到 bin 的 STALE 正则').not.toBeNull();
    // eslint-disable-next-line no-eval
    const re: RegExp = eval(m![1]);
    for (const n of ['neox.bin-backup-3.1.7', 'neox.orig-3.0.1']) {
      expect(re.test(n), `应当认出旧版 ${n}`).toBe(true);
    }
    for (const n of ['neox', 'neox-3.2.1', 'rg', 'watcher.node']) {
      expect(re.test(n), `不该把 ${n} 当成旧版 —— 误报等于叫用户删掉在用的二进制`).toBe(false);
    }
  });
});
