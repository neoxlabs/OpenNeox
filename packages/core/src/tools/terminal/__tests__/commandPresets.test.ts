import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { buildCommandForPreset, detectCommandPreset, normalizeCommandPreset } from '../commandPresets.js';
import { runStructuredCommandFromRuntimeTools } from '../structuredCommand.js';

const baseParams = {
  resolveWorkspacePath: (p?: string) => p || '/ws',  truncateText: (t: string, n: number) => ({ text: t.slice(0, n), truncated: t.length > n }),
  maxCommandOutputChars: 12000,
  maxErrorSnippetChars: 4000,
  runCommand: async (command: string, args: string[]) => ({
    stdout: [command, ...args].join(' '),
    stderr: '',
    exitCode: 0,
    durationMs: 1,
  }),
};

describe('detectCommandPreset — Java / Flutter', () => {
  it('picks maven from pom.xml even if package.json is leftover', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'neox-preset-'));
    try {
      await writeFile(path.join(dir, 'pom.xml'), '<project/>');
      await writeFile(path.join(dir, 'package.json'), '{}');
      expect(await detectCommandPreset(dir)).toBe('maven');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('picks flutter from pubspec.yaml', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'neox-preset-'));
    try {
      await writeFile(path.join(dir, 'pubspec.yaml'), 'name: demo\n');
      expect(await detectCommandPreset(dir)).toBe('flutter');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildCommandForPreset — maven / flutter', () => {
  it('maps test/lint/format', () => {
    expect(buildCommandForPreset('maven', 'test', [])).toEqual({ command: 'mvn', args: ['test'] });
    expect(buildCommandForPreset('maven', 'lint', [])).toEqual({ command: 'mvn', args: ['-DskipTests', 'compile'] });
    expect(buildCommandForPreset('flutter', 'lint', [])).toEqual({ command: 'flutter', args: ['analyze'] });
    expect(buildCommandForPreset('flutter', 'test', ['test/foo_test.dart'])).toEqual({
      command: 'flutter', args: ['test', 'test/foo_test.dart'],
    });
  });
});

describe('run_tests / run_lint command override', () => {
  it('allows mvn and flutter (the Win 能力报告里被白名单拦的那两个)', async () => {
    const mvn = await runStructuredCommandFromRuntimeTools({
      ...baseParams, toolName: 'run_tests', kind: 'test', args: { command: 'mvn test' },
    });
    const flutter = await runStructuredCommandFromRuntimeTools({
      ...baseParams, toolName: 'run_lint', kind: 'lint', args: { command: 'flutter analyze' },
    });
    expect(JSON.parse(mvn).status).toBe('success');
    expect(JSON.parse(flutter).status).toBe('success');
  });

  it('allows Windows wrapper names', async () => {
    const res = await runStructuredCommandFromRuntimeTools({
      ...baseParams, toolName: 'run_tests', kind: 'test', args: { command: 'mvn.cmd test' },
    });
    expect(JSON.parse(res).status).toBe('success');
  });

  it('still rejects unknown binaries', async () => {
    const res = await runStructuredCommandFromRuntimeTools({
      ...baseParams, toolName: 'run_tests', kind: 'test', args: { command: 'rm -rf /' },
    });
    const parsed = JSON.parse(res);
    expect(parsed.status).toBe('error');
    expect(JSON.stringify(parsed)).toMatch(/Command not allowed|Allowed commands/);
  });
});

/* 自测: run_format(preset="python") 跑出了 `npm run format`。
 * 'python' 不在联合类型里, buildCommandForPreset 的 default 静默兜到 npm —— "不认识"
 * 被翻译成了"另一种确定的东西"。 */
describe('preset 收敛 — python 别名 / 不认识的值', () => {
  it('python 别名 → pytest, 三件事三个工具', () => {
    expect(normalizeCommandPreset('python')).toBe('pytest');
    expect(normalizeCommandPreset('Python3')).toBe('pytest');
    expect(buildCommandForPreset('pytest', 'test', [])).toEqual({ command: 'pytest', args: [] });
    expect(buildCommandForPreset('pytest', 'lint', [])).toEqual({ command: 'ruff', args: ['check', '.'] });
    expect(buildCommandForPreset('pytest', 'format', [])).toEqual({ command: 'ruff', args: ['format', '.'] });
  });

  it('run_format(preset="python") 绝不再跑 npm', async () => {
    const calls: string[] = [];
    const res = await runStructuredCommandFromRuntimeTools({
      ...baseParams,
      runCommand: async (command: string, args: string[]) => {
        calls.push([command, ...args].join(' '));
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
      },
      toolName: 'run_format', kind: 'format', args: { preset: 'python' },
    });
    expect(calls).toEqual(['ruff format .']);
    expect(JSON.parse(res).status).toBe('success');
  });

  it('不认识的 preset → guidance 信封 (模型自己改), 不跑任何命令', async () => {
    const calls: string[] = [];
    const res = await runStructuredCommandFromRuntimeTools({
      ...baseParams,
      runCommand: async (command: string, args: string[]) => {
        calls.push([command, ...args].join(' '));
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
      },
      toolName: 'run_format', kind: 'format', args: { preset: 'cobol' },
    });
    const parsed = JSON.parse(res);
    expect(calls).toEqual([]);
    expect(parsed.status).toBe('error');
    expect(parsed.guidance).toBe(true);
    expect(parsed.summary).toMatch(/pytest/);
  });
});
