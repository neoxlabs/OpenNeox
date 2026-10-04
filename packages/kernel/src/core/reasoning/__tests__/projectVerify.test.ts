/**
 * P2-7 项目级验证闭环 — .neox/settings.json "verify" 声明命令替代内置单文件检查。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('non-matching files fall through to built-in verifiers', async () => {
    writeSettings({ commands: [{ command: 'exit 1', matcher: '\\.rs$' }] });
    const pipeline = new AutoVerifyPipeline(workDir);
    // .ts 不匹配 .rs matcher; workDir 无 tsconfig → 内置验证器也不可用 → skipped/null
    const result = await pipeline.verify(path.join(workDir, 'src/app.ts'));
    expect(result === null || result.skipped || result.passed).toBe(true);
  });
});
