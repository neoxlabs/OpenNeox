/**
 * 项目指令 (NEOX.md / .neox/INSTRUCTIONS.md) → system prompt 端到端注入测试.
 *
 * 背景: 这套分层扫描实现完整, 但 initProjectInstructions / refreshProjectInstructions
 * 全仓库零调用, `_cachedInstructions` 恒为 null → 用户写的 NEOX.md 被**静默忽略**.
 * 这里既覆盖加载器本身, 也断言内容**真的出现在 buildInstructions 产出的 system prompt 里**,
 * 防止"接上了但下游拿不到"的回归.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  initProjectInstructions,
  ensureProjectInstructionsFor,
  refreshProjectInstructions,
  ensureProjectInstructionsForDetailed,
  getCachedInstructions,
  getActiveInstructionsWorkDir,
  __resetProjectInstructionsCacheForTest,
} from '@neoxlabs/kernel/core/projectInstructions.js';
import { buildInstructions } from '../systemPrompt.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const MAGIC = 'ZZQQ-MAGIC-SENTINEL-9182';

const tempDirs: string[] = [];
function makeDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

/** 隔离 ~/.neox/INSTRUCTIONS.md — 否则开发机上的用户级指令会污染断言. */
let fakeHome: string;
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;

beforeEach(() => {
  fakeHome = makeDir('neox-home-');
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  __resetProjectInstructionsCacheForTest();
});

afterAll(() => {
  process.env.HOME = realHome;
  process.env.USERPROFILE = realUserProfile;
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const build = (workDir: string) =>
  buildInstructions({ workDir, skipEnvironment: true, language: 'en' });

// ============================================================================
// 1. 核心诉求: NEOX.md 真的进 system prompt
// ============================================================================

describe('project instructions → system prompt', () => {
  it('NEOX.md content lands in the final system prompt', async () => {
    const wd = makeDir('neox-ws-');
    writeFileSync(path.join(wd, 'NEOX.md'), `# Project rules\nAlways say ${MAGIC}.\n`);

    const loaded = await initProjectInstructions(wd);
    expect(loaded.sources).toHaveLength(1);
    expect(loaded.sources[0].level).toBe('workspace');

    const prompt = build(wd);
    expect(prompt).toContain(MAGIC);
    expect(prompt).toContain('## Project Instructions');
  });

  it('.neox/INSTRUCTIONS.md takes precedence over NEOX.md', async () => {
    const wd = makeDir('neox-ws-');
    mkdirSync(path.join(wd, '.neox'), { recursive: true });
    writeFileSync(path.join(wd, '.neox', 'INSTRUCTIONS.md'), 'PREFERRED-DOTNEOX');
    writeFileSync(path.join(wd, 'NEOX.md'), 'SHADOWED-ROOT');

    await initProjectInstructions(wd);
    const prompt = build(wd);
    expect(prompt).toContain('PREFERRED-DOTNEOX');
    expect(prompt).not.toContain('SHADOWED-ROOT');
  });

  it('loads AGENTS.md when Neox-native instruction files are absent', async () => {
    const wd = makeDir('neox-ws-');
    writeFileSync(path.join(wd, 'AGENTS.md'), `Always say ${MAGIC}-AGENTS.\n`);

    const loaded = await initProjectInstructions(wd);
    expect(loaded.sources).toHaveLength(1);
    expect(loaded.sources[0].path).toContain('AGENTS.md');
    expect(build(wd)).toContain(`${MAGIC}-AGENTS`);
  });

  it('loads .cursorrules when higher-priority instruction files are absent', async () => {
    const wd = makeDir('neox-ws-');
    writeFileSync(path.join(wd, '.cursorrules'), `RULE-${MAGIC}-CURSOR\n`);

    const loaded = await initProjectInstructions(wd);
    expect(loaded.sources[0].path).toContain('.cursorrules');
    expect(build(wd)).toContain(`RULE-${MAGIC}-CURSOR`);
  });

  it('NEOX.md takes precedence over AGENTS.md', async () => {
    const wd = makeDir('neox-ws-');
    writeFileSync(path.join(wd, 'NEOX.md'), 'PREFERRED-NEOX');
    writeFileSync(path.join(wd, 'AGENTS.md'), 'SHADOWED-AGENTS');

    await initProjectInstructions(wd);
    const prompt = build(wd);
    expect(prompt).toContain('PREFERRED-NEOX');
    expect(prompt).not.toContain('SHADOWED-AGENTS');
  });

  it('user-level ~/.neox/INSTRUCTIONS.md is merged in', async () => {
    const wd = makeDir('neox-ws-');
    mkdirSync(path.join(fakeHome, NEOX_HOME_DIRNAME), { recursive: true });
    writeFileSync(path.join(fakeHome, NEOX_HOME_DIRNAME, 'INSTRUCTIONS.md'), 'USER-GLOBAL-RULE');

    const loaded = await initProjectInstructions(wd);
    expect(loaded.sources.map(s => s.level)).toContain('user');
    expect(build(wd)).toContain('USER-GLOBAL-RULE');
  });
});

// ============================================================================
// 2. "没有指令文件" 是正常情况 — 不报错, 不产生空 section
// ============================================================================

describe('absent instructions are a normal, silent case', () => {
  it('produces empty content and no sources without throwing', async () => {
    const wd = makeDir('neox-empty-');
    const loaded = await initProjectInstructions(wd);
    expect(loaded.sources).toHaveLength(0);
    expect(loaded.content).toBe('');
  });

  it('emits NO empty "Project Instructions" section', async () => {
    const wd = makeDir('neox-empty-');
    await initProjectInstructions(wd);
    const prompt = build(wd);
    expect(prompt).not.toContain('Project Instructions');
    expect(prompt.length).toBeGreaterThan(200); // prompt 本身照常构建
  });

  it('treats a whitespace-only instruction file as absent', async () => {
    const wd = makeDir('neox-blank-');
    writeFileSync(path.join(wd, 'NEOX.md'), '   \n\n\t\n');
    const loaded = await initProjectInstructions(wd);
    expect(loaded.sources).toHaveLength(0);
    expect(build(wd)).not.toContain('Project Instructions');
  });
});

// ============================================================================
// 3. 前缀缓存保护 — hash 不变时不得触发刷新 / 不得换对象引用
// ============================================================================

describe('prefix-cache protection', () => {
  it('refresh with unchanged file returns false and preserves object identity', async () => {
    const wd = makeDir('neox-ws-');
    writeFileSync(path.join(wd, 'NEOX.md'), `rule: ${MAGIC}`);

    await initProjectInstructions(wd);
    const ref1 = getCachedInstructions();

    expect(await refreshProjectInstructions(wd)).toBe(false);
    const ref2 = getCachedInstructions();

    /* 对象引用不变是关键: projectInstructionsHash 不变 → sectionRegistry 的
     * project-instructions section 命中 memo → prompt 前缀逐字节稳定. */
    expect(ref2).toBe(ref1);
    expect(ref2!.contentHash).toBe(ref1!.contentHash);
  });

  it('repeated refreshes never flip the hash', async () => {
    const wd = makeDir('neox-ws-');
    writeFileSync(path.join(wd, 'NEOX.md'), 'stable rule');
    await initProjectInstructions(wd);
    const hash0 = getCachedInstructions()!.contentHash;

    for (let i = 0; i < 5; i++) {
      expect(await refreshProjectInstructions(wd)).toBe(false);
      expect(getCachedInstructions()!.contentHash).toBe(hash0);
    }
  });

  it('system prompt is byte-identical across rebuilds', async () => {
    const wd = makeDir('neox-ws-');
    writeFileSync(path.join(wd, 'NEOX.md'), `rule: ${MAGIC}`);
    await initProjectInstructions(wd);
    expect(build(wd)).toBe(build(wd));
  });

  it('hot path does NOT re-read disk within a session', async () => {
    const wd = makeDir('neox-ws-');
    writeFileSync(path.join(wd, 'NEOX.md'), 'ORIGINAL-RULE');

    const first = await ensureProjectInstructionsFor(wd);
    // 偷偷改盘: 命中缓存就不该看到新内容
    writeFileSync(path.join(wd, 'NEOX.md'), 'SNEAKY-DISK-EDIT');
    const second = await ensureProjectInstructionsFor(wd);

    expect(second).toBe(first);                       // 同一对象 = 没读盘
    expect(build(wd)).toContain('ORIGINAL-RULE');
    expect(build(wd)).not.toContain('SNEAKY-DISK-EDIT');
  });

  it('interleaved workspaces keep their own stable hashes (no thrash)', async () => {
    const wdA = makeDir('neox-wsA-');
    const wdC = makeDir('neox-wsC-');
    writeFileSync(path.join(wdA, 'NEOX.md'), 'PROJECT-A-RULES');
    writeFileSync(path.join(wdC, 'NEOX.md'), 'PROJECT-C-RULES');

    await ensureProjectInstructionsFor(wdA);
    const hashA1 = getCachedInstructions()!.contentHash;
    await ensureProjectInstructionsFor(wdC);
    const hashC = getCachedInstructions()!.contentHash;
    await ensureProjectInstructionsFor(wdA); // 切回 A
    const hashA2 = getCachedInstructions()!.contentHash;

    expect(hashA1).not.toBe(hashC);
    expect(hashA2).toBe(hashA1);              // A 的 hash 没被 C 踩坏
    expect(getActiveInstructionsWorkDir()).toBe(wdA);
    expect(build(wdA)).toContain('PROJECT-A-RULES');
    expect(build(wdA)).not.toContain('PROJECT-C-RULES');
  });
});

// ============================================================================
// 4. 真的改了要能生效 (workspace 切换 / 显式 refresh)
// ============================================================================

describe('freshlyLoaded gating (timeline 卡只出一次)', () => {
  it('第一次 = true, 之后同 workDir 恒 false', async () => {
    const wd = makeDir('neox-fresh-');
    writeFileSync(path.join(wd, 'NEOX.md'), `rule ${MAGIC}`);

    const first = await ensureProjectInstructionsForDetailed(wd);
    expect(first.freshlyLoaded).toBe(true);
    expect(first.instructions.sources).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      const again = await ensureProjectInstructionsForDetailed(wd);
      expect(again.freshlyLoaded).toBe(false);
      /* 同一个对象引用 —— hash 不翻转, 前缀缓存不断 */
      expect(again.instructions).toBe(first.instructions);
    }
  });

  it('多工作区交替: 各自只在自己第一次出现时 fresh 一次', async () => {
    const wdA = makeDir('neox-fresh-a-');
    const wdB = makeDir('neox-fresh-b-');
    writeFileSync(path.join(wdA, 'NEOX.md'), 'A rules');
    writeFileSync(path.join(wdB, 'NEOX.md'), 'B rules');

    expect((await ensureProjectInstructionsForDetailed(wdA)).freshlyLoaded).toBe(true);
    expect((await ensureProjectInstructionsForDetailed(wdB)).freshlyLoaded).toBe(true);
    /* 交替回切不该重新"加载" —— 否则 A/B 会话互切时 timeline 会被加载卡刷屏 */
    expect((await ensureProjectInstructionsForDetailed(wdA)).freshlyLoaded).toBe(false);
    expect((await ensureProjectInstructionsForDetailed(wdB)).freshlyLoaded).toBe(false);
    expect((await ensureProjectInstructionsForDetailed(wdA)).freshlyLoaded).toBe(false);
  });

  it('没有指令文件的工作区也只 fresh 一次 (但上层据此不出卡)', async () => {
    const wd = makeDir('neox-fresh-empty-');
    const first = await ensureProjectInstructionsForDetailed(wd);
    expect(first.freshlyLoaded).toBe(true);
    expect(first.instructions.sources).toEqual([]);
    expect((await ensureProjectInstructionsForDetailed(wd)).freshlyLoaded).toBe(false);
  });
});

describe('explicit refresh picks up real edits', () => {
  it('returns true and updates the prompt when content changed', async () => {
    const wd = makeDir('neox-ws-');
    writeFileSync(path.join(wd, 'NEOX.md'), `rule: ${MAGIC}`);
    await initProjectInstructions(wd);

    writeFileSync(path.join(wd, 'NEOX.md'), `rule: ${MAGIC}-V2`);
    expect(await refreshProjectInstructions(wd)).toBe(true);
    expect(build(wd)).toContain(`${MAGIC}-V2`);
  });

  it('switching workspace swaps the active instructions', async () => {
    const wdA = makeDir('neox-wsA-');
    const wdB = makeDir('neox-wsB-');
    writeFileSync(path.join(wdA, 'NEOX.md'), 'RULES-FROM-A');
    writeFileSync(path.join(wdB, 'NEOX.md'), 'RULES-FROM-B');

    await initProjectInstructions(wdA);
    expect(build(wdA)).toContain('RULES-FROM-A');

    expect(await refreshProjectInstructions(wdB)).toBe(true);
    expect(getActiveInstructionsWorkDir()).toBe(wdB);
    expect(build(wdB)).toContain('RULES-FROM-B');
    expect(build(wdB)).not.toContain('RULES-FROM-A');
  });
});

// ============================================================================
// 5. fail-loud: 读不了的文件必须出声, 不存在的文件必须闭嘴
// ============================================================================

describe('fail-loud boundary', () => {
  it('an unreadable instruction file warns instead of being swallowed', async () => {
    const wd = makeDir('neox-perm-');
    const file = path.join(wd, 'NEOX.md');
    writeFileSync(file, 'SECRET-RULES');
    chmodSync(file, 0o000);

    const warnings: string[] = [];
    const { cliLogger } = await import('@neoxlabs/kernel/platform/cliLogger.js');
    const originalWarn = cliLogger.warn.bind(cliLogger);
    (cliLogger as any).warn = (scope: string, msg: string) => {
      if (scope === 'INSTRUCTIONS') warnings.push(msg);
      return originalWarn(scope, msg);
    };

    try {
      const loaded = await initProjectInstructions(wd);
      // root 跑测试时 chmod 000 依然可读 — 那种环境下跳过断言
      if (loaded.sources.length === 0) {
        expect(warnings.some(w => w.includes('NEOX.md'))).toBe(true);
      }
    } finally {
      (cliLogger as any).warn = originalWarn;
      chmodSync(file, 0o644);
    }
  });

  /* cliLogger.warn 只在 CLI_DEBUG=1 落盘 —— 正常用户看不到。所以读失败必须**同时**
   * 进结构化的 failures 数组, 才有东西能渲成 timeline 上的错误卡。 */
  it('an unreadable instruction file is recorded in failures[] (not just logged)', async () => {
    const wd = makeDir('neox-perm2-');
    const file = path.join(wd, 'NEOX.md');
    writeFileSync(file, 'SECRET-RULES');
    chmodSync(file, 0o000);

    try {
      const loaded = await initProjectInstructions(wd);
      // root 跑测试时 chmod 000 依然可读 — 那种环境下这条不适用
      if (loaded.sources.length === 0) {
        expect(loaded.failures).toHaveLength(1);
        expect(loaded.failures[0].path).toBe(file);
        expect(loaded.failures[0].code).toBe('EACCES');
      }
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it('ENOENT never lands in failures[] — 没有指令文件是正常态', async () => {
    const wd = makeDir('neox-nofail-');
    const loaded = await initProjectInstructions(wd);
    expect(loaded.sources).toEqual([]);
    expect(loaded.failures).toEqual([]);
  });

  it('a missing instruction file produces no warning at all', async () => {
    const wd = makeDir('neox-empty-');
    const warnings: string[] = [];
    const { cliLogger } = await import('@neoxlabs/kernel/platform/cliLogger.js');
    const originalWarn = cliLogger.warn.bind(cliLogger);
    (cliLogger as any).warn = (scope: string, msg: string) => {
      if (scope === 'INSTRUCTIONS') warnings.push(msg);
      return originalWarn(scope, msg);
    };

    try {
      await initProjectInstructions(wd);
      expect(warnings).toEqual([]);
    } finally {
      (cliLogger as any).warn = originalWarn;
    }
  });
});
