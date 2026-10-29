import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expandReadTargets } from '../expandReadTargets.js';

let repo: string;
let plain: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-expand-'));
  const write = (rel: string, body: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  write('package.json', '{}');
  write('package-lock.json', '{}');
  write('src/a.js', 'a');
  write('src/b.ts', 'b');
  write('src/logo.png', Buffer.from([0x89, 0x50]));
  write('test/a.test.js', 't');
  write('ignored/x.js', 'x');
  write('.gitignore', 'ignored/\n');
  write('big.txt', 'x'.repeat(300_000));
  execFileSync('git', ['init', '-q'], { cwd: repo });

  plain = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-expand-plain-'));
  fs.mkdirSync(path.join(plain, 'src'), { recursive: true });
  fs.mkdirSync(path.join(plain, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'src/m.js'), 'm');
  fs.writeFileSync(path.join(plain, 'node_modules/x/i.js'), 'i');
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
});

describe('expandReadTargets', () => {
  it('"." 展开整个仓库: 守 .gitignore, 跳过锁文件 / 图片 / 超大文件', async () => {
    const { files, expanded } = await expandReadTargets(['.'], repo);
    expect(expanded).toBe(true);
    expect(files).toEqual(['.gitignore', 'package.json', 'src/a.js', 'src/b.ts', 'test/a.test.js']);
  });

  it('目录和通配符', async () => {
    expect((await expandReadTargets(['src'], repo)).files).toEqual(['src/a.js', 'src/b.ts']);
    expect((await expandReadTargets(['**/*.js'], repo)).files).toEqual(['src/a.js', 'test/a.test.js']);
  });

  it('普通文件原样保留, 不去重之外不改顺序', async () => {
    expect((await expandReadTargets(['test/a.test.js', 'src', 'src/a.js'], repo)).files)
      .toEqual(['test/a.test.js', 'src/a.js', 'src/b.ts']);
  });

  it('不是 git 仓库就遍历目录, 跳过 node_modules', async () => {
    expect((await expandReadTargets(['.'], plain)).files).toEqual(['src/m.js']);
  });
});
