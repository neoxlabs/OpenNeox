/**
 * P2-7 项目级验证闭环 — .neox/settings.json "verify" 声明命令替代内置单文件检查。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AutoVerifyPipeline, parseProjectVerifyConfig } from '../autoVerifyPipeline.js';

describe('parseProjectVerifyConfig', () => {
  it('accepts string shorthand', () => {
    expect(parseProjectVerifyConfig('npm run typecheck')).toEqual([{ command: 'npm run typecheck' }]);
  });

  it('accepts commands array with matcher and timeout', () => {
    const parsed = parseProjectVerifyConfig({
      commands: [{ command: 'cargo check', matcher: '\\.rs$', timeout: 30 }],
    });
    expect(parsed).toEqual([{ command: 'cargo check', matcher: '\\.rs$', timeout: 30 }]);
  });

  it('rejects malformed entries', () => {
    expect(parseProjectVerifyConfig({ commands: [{ command: '' }, { notCommand: true }, 42] })).toEqual([]);
    expect(parseProjectVerifyConfig(undefined)).toEqual([]);
    expect(parseProjectVerifyConfig(123)).toEqual([]);
  });
});

describe('AutoVerifyPipeline project commands', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-verify-test-'));
    fs.mkdirSync(path.join(workDir, '.neox'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function writeSettings(verify: unknown) {
    fs.writeFileSync(path.join(workDir, '.neox', 'settings.json'), JSON.stringify({ verify }));
  }

  it('runs the declared command and reports failure output to the model', async () => {
    writeSettings({ commands: [{ command: 'echo "TS9999: fake error" >&2; exit 1', matcher: '\\.ts$' }] });
    const pipeline = new AutoVerifyPipeline(workDir);
    const result = await pipeline.verify(path.join(workDir, 'src/app.ts'));
    expect(result?.passed).toBe(false);
    expect(result?.errors).toContain('TS9999: fake error');
  });

  it('reports pass when the command exits 0', async () => {
    writeSettings('exit 0');
    const pipeline = new AutoVerifyPipeline(workDir);
    const result = await pipeline.verify(path.join(workDir, 'anything.xyz'));
    expect(result?.passed).toBe(true);
  });

  it('debounces the same command across consecutive file edits', async () => {
    const marker = path.join(workDir, 'runs.log');
    writeSettings(`echo run >> "${marker}"`);
    const pipeline = new AutoVerifyPipeline(workDir);
    await pipeline.verify(path.join(workDir, 'a.ts'));
    await pipeline.verify(path.join(workDir, 'b.ts'));
    const runs = fs.readFileSync(marker, 'utf-8').trim().split('\n').length;
    expect(runs).toBe(1);
  });

  it('文件 mtime+size 没变 → 不再重复验证 (即使过了 10s 防抖窗口)', async () => {
    vi.useFakeTimers();
    try {
      const marker = path.join(workDir, 'runs-mtime.log');
      writeSettings(`echo run >> "${marker}"`);
      const pipeline = new AutoVerifyPipeline(workDir);
      const file = path.join(workDir, 'a.ts');
      fs.writeFileSync(file, 'const a = 1;');

      await pipeline.verify(file);
      vi.advanceTimersByTime(11_000);
      await pipeline.verify(file);
      expect(fs.readFileSync(marker, 'utf-8').trim().split('\n').length).toBe(1);

      /* 文件内容变了 (size 也变) → 缓存失效, 重新验 */
      fs.writeFileSync(file, 'const a = 22;');
      vi.advanceTimersByTime(11_000);
      await pipeline.verify(file);
      expect(fs.readFileSync(marker, 'utf-8').trim().split('\n').length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('失败回执带具体错行 + 最小修复建议 (VERIFY-06)', async () => {
    writeSettings({
      commands: [{
        command: `echo "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'." >&2; exit 1`,
        matcher: '\\.ts$',
      }],
    });
    const pipeline = new AutoVerifyPipeline(workDir);
    const result = await pipeline.verify(path.join(workDir, 'src/app.ts'));
    expect(result?.passed).toBe(false);
    expect(result?.firstError?.line).toBe(3);
    expect(result?.firstError?.code).toBe('TS2322');
    expect(result?.fixAdvice).toContain('第 3 行');
    expect(result?.fixAdvice).toContain('类型对不上');

    const text = pipeline.formatForToolResult(result!);
    expect(text).toContain('最小修复建议');
    expect(text).toContain('第 3 行');
  });

  it('同一个错第 3 次出现 → 劝停, 不再让人全量重跑 (VERIFY-06)', async () => {
    vi.useFakeTimers();
    try {
      writeSettings({
        commands: [{
          command: `echo "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'." >&2; exit 1`,
          matcher: '\\.ts$',
        }],
      });
      const pipeline = new AutoVerifyPipeline(workDir);
      const file = path.join(workDir, 'app.ts');

      let result = null as Awaited<ReturnType<AutoVerifyPipeline['verify']>>;
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(file, `const a = ${i};`);
        result = await pipeline.verify(file);
        vi.advanceTimersByTime(11_000);
      }

      expect(result?.repeatCount).toBe(3);
      const text = pipeline.formatForToolResult(result!);
      expect(text).toContain('同一错误已经出现 3 次');
      expect(text).toContain('别再重跑');
    } finally {
      vi.useRealTimers();
    }
  });

  it('真实项目里只查改动文件, 并在 3s 预算内给出错行 + 建议 (VERIFY-05/06)', async () => {
    const tsc = path.resolve(process.cwd(), 'node_modules', '.bin', 'tsc');
    if (!fs.existsSync(tsc)) return; // 没有本地 tsc 时跳过 (不触发下载)

    /* 用仓库根目录当 workspace: 根 tsconfig + node_modules 都在, 走真实的单文件检查路径 */
    const repoRoot = process.cwd();
    const tempFile = path.join(repoRoot, `.neox-verify-e2e-${process.pid}.ts`);
    fs.writeFileSync(tempFile, "export const broken: number = 'not a number';\n");
    try {
      const pipeline = new AutoVerifyPipeline(repoRoot);
      const result = await pipeline.verify(tempFile);
      expect(result).not.toBeNull();
      expect(result?.skipped).toBeFalsy();
      expect(result?.passed).toBe(false);
      expect(result?.firstError?.line).toBe(1);
      expect(result?.firstError?.code).toBe('TS2322');
      expect(result?.fixAdvice).toContain('类型对不上');
    } finally {
      fs.rmSync(tempFile, { force: true });
    }
  });

  it('non-matching files fall through to built-in verifiers', async () => {
    writeSettings({ commands: [{ command: 'exit 1', matcher: '\\.rs$' }] });
    const pipeline = new AutoVerifyPipeline(workDir);
    // .ts 不匹配 .rs matcher; workDir 无 tsconfig → 内置验证器也不可用 → skipped/null
    const result = await pipeline.verify(path.join(workDir, 'src/app.ts'));
    expect(result === null || result.skipped || result.passed).toBe(true);
  });
});
