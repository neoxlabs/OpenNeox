import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotBeforeShell, filesWrittenSince, filesWrittenLine, parseFilesWritten } from '../shellFileChanges.js';

let repo: string;
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-shell-changes-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  write('src/a.js', 'a\n');
  write('src/b.js', 'b\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
  write('src/dirty-untouched.js', 'x\n');   /* 命令前就脏 */
  write('src/dirty-touched.js', 'y\n');
});

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('shellFileChanges', () => {
  it('报新写的、改过的、原本脏又被改的; 不报原本脏没动的', async () => {
    const snap = await snapshotBeforeShell(repo);
    expect(snap).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    write('test/new.test.js', 'new\n');
    write('src/a.js', 'a2\n');
    write('src/dirty-touched.js', 'y2\n');
    const files = await filesWrittenSince(snap!);
    expect(files.sort()).toEqual(['src/a.js', 'src/dirty-touched.js', 'test/new.test.js']);
  });

  it('结果行可以原样解析回来; 没写文件就不加这一行', () => {
    const out = 'ok 1 - tests\n' + filesWrittenLine(['src/a.js', 'test/x.js']);
    expect(parseFilesWritten(out)).toEqual(['src/a.js', 'test/x.js']);
    expect(filesWrittenLine([])).toBe('');
    expect(parseFilesWritten('plain output')).toEqual([]);
  });

  it('不是 git 仓库 → 不快照, 什么都不报', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-shell-plain-'));
    expect(await snapshotBeforeShell(plain)).toBeNull();
    fs.rmSync(plain, { recursive: true, force: true });
  });
});
