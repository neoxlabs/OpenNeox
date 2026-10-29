/**
 * VERIFY-05: 单文件 TypeScript 检查 —— 临时 tsconfig 生成与真实单文件检查。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSingleFileTsCheckPlan, findNearestTsconfig } from '../incrementalTsCheck.js';

describe('findNearestTsconfig', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-tscheck-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('从改动文件往上找最近的 tsconfig (子包优先)', () => {
    fs.writeFileSync(path.join(workDir, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(workDir, 'packages', 'a', 'src'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'packages', 'a', 'tsconfig.json'), '{}');
    const file = path.join(workDir, 'packages', 'a', 'src', 'x.ts');
    expect(findNearestTsconfig(file, workDir)).toBe(path.join(workDir, 'packages', 'a', 'tsconfig.json'));
  });

  it('workspace 里没有 tsconfig → null', () => {
    const file = path.join(workDir, 'src', 'x.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(findNearestTsconfig(file, workDir)).toBeNull();
  });
});

describe('buildSingleFileTsCheckPlan', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-tscheck-plan-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('临时配置继承项目 tsconfig, 只收窄到改动文件, 用完删掉', () => {
    fs.writeFileSync(path.join(workDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    const file = path.join(workDir, 'src', 'a.ts');
    fs.writeFileSync(file, 'const x: number = 1;\n');

    const fakeTsc = path.join(workDir, 'fake-tsc');
    fs.writeFileSync(fakeTsc, '');
    const plan = buildSingleFileTsCheckPlan(file, workDir, { tscBinary: fakeTsc });
    expect(plan).not.toBeNull();
    expect(fs.existsSync(plan!.configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(plan!.configPath, 'utf-8'));
    expect(config.extends).toBe('./tsconfig.json');
    expect(config.include).toEqual([]);
    expect(config.files).toEqual(['./src/a.ts']);
    expect(config.compilerOptions.noEmit).toBe(true);

    plan!.cleanup();
    expect(fs.existsSync(plan!.configPath)).toBe(false);
  });

  it('没有 tsconfig / tsc 时返回 null (调用方跳过, 不报假错)', () => {
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    const file = path.join(workDir, 'src', 'a.ts');
    fs.writeFileSync(file, '');
    const fakeTsc = path.join(workDir, 'fake-tsc');
    fs.writeFileSync(fakeTsc, '');
    expect(buildSingleFileTsCheckPlan(file, workDir, { tscBinary: fakeTsc })).toBeNull();
    fs.writeFileSync(path.join(workDir, 'tsconfig.json'), '{}');
    /* tsc 路径不存在 → 也返回 null, 不让 ENOENT 变成"验证通过" */
    expect(buildSingleFileTsCheckPlan(file, workDir, { tscBinary: path.join(workDir, 'nope', 'tsc') })).toBeNull();
  });
});

describe('真实单文件检查', () => {
  const tsc = path.resolve(process.cwd(), 'node_modules', '.bin', 'tsc');
  const hasTsc = fs.existsSync(tsc);
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-tscheck-run-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it.skipIf(!hasTsc)('只报改动文件的错误, 不报无关文件 (VERIFY-05)', () => {
    fs.writeFileSync(path.join(workDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true },
      include: ['src'],
    }));
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'src', 'a.ts'), "export function f(a: number) { return a; }\nconst x: string = f(1);\n");
    fs.writeFileSync(path.join(workDir, 'src', 'b.ts'), 'const y: number = "bad";\n');

    const plan = buildSingleFileTsCheckPlan(path.join(workDir, 'src', 'a.ts'), workDir, { tscBinary: tsc })!;
    let output = '';
    try {
      output = execSync(plan.command, { encoding: 'utf-8', cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      output = (e.stdout || '') + (e.stderr || '');
    } finally {
      plan.cleanup();
    }

    expect(output).toContain('a.ts');
    expect(output).toContain('TS2322');
    expect(output).not.toContain('b.ts');
  });
});
