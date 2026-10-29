/**
 * gitStatusCore —— 用真 git 在临时仓库里跑 (解析错了面板就会说假话, 这种东西不能只测假数据)。
 *
 *   · -z 流式解析: 中文 / 空格路径, rename 的"新\0旧"顺序, 同一文件既暂存又未暂存拆两条
 *   · 超限: 先折叠未跟踪目录 (-unormal) 再截断, 并且结果上带标记
 *   · 只读: 算一次状态不许改 .git/index (否则自己的 .git 监听会自激)
 *   · 增量: diffGitFiles 只给真变了的条目
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PorcelainZParser,
  computeGitStatus,
  diffGitFiles,
  parseBranchHeader,
  parseNumstatZ,
  type GitFileStatus,
} from '../gitStatusCore';

let repo = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-gitcore-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'd'));
  fs.writeFileSync(path.join(repo, 'd', 'old name.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'both.txt'), '1\n');
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'k\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('mv', 'd/old name.txt', 'd/新 name.txt');
  fs.writeFileSync(path.join(repo, 'both.txt'), '1\n2\n');
  git('add', 'both.txt');
  fs.writeFileSync(path.join(repo, 'both.txt'), '1\n2\n3\n');
  fs.mkdirSync(path.join(repo, 'gen'));
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(repo, 'gen', `f${i}.js`), 'x\ny\n');
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('解析', () => {
  it('PorcelainZParser: 切片任意断开也能拼回; rename 是 "新\\0旧"', () => {
    const raw = '## main...origin/main [ahead 2]\0R  d/新 name.txt\0d/old name.txt\0MM both.txt\0?? gen/f1.js\0';
    const p = new PorcelainZParser(100);
    for (let i = 0; i < raw.length; i += 3) p.feed(raw.slice(i, i + 3));
    expect(parseBranchHeader(p.header)).toEqual({ branch: 'main', ahead: 2, behind: 0 });
    expect(p.files).toEqual([
      { path: 'd/新 name.txt', indexStatus: 'R', worktreeStatus: ' ', area: 'staged', origPath: 'd/old name.txt' },
      { path: 'both.txt', indexStatus: 'M', worktreeStatus: ' ', area: 'staged', origPath: undefined },
      { path: 'both.txt', indexStatus: ' ', worktreeStatus: 'M', area: 'unstaged', origPath: undefined },
      { path: 'gen/f1.js', indexStatus: '?', worktreeStatus: '?', area: 'untracked' },
    ]);
  });

  it('PorcelainZParser: 超过上限返回 false', () => {
    const p = new PorcelainZParser(2);
    expect(p.feed('## main\0?? a\0?? b\0')).toBe(true);
    expect(p.feed('?? c\0')).toBe(false);
    expect(p.files.length).toBe(2);
  });

  it('parseBranchHeader: 空仓库', () => {
    expect(parseBranchHeader('## No commits yet on main').branch).toBe('main');
  });

  it('parseNumstatZ: 普通 + rename 落到新路径', () => {
    const m = parseNumstatZ('3\t1\tsrc/a.ts\0' + '0\t0\t\0d/old.txt\0d/new.txt\0' + '-\t-\tbin.png\0');
    expect(m.get('src/a.ts')).toEqual({ add: 3, del: 1 });
    expect(m.get('d/new.txt')).toEqual({ add: 0, del: 0 });
    expect(m.get('bin.png')).toEqual({ add: 0, del: 0 });
  });
});

describe('computeGitStatus (真 git)', () => {
  it('分支 / rename / 暂存+未暂存 / 未跟踪 / 行数', async () => {
    const { value, root, metaDirs } = await computeGitStatus(repo);
    expect(fs.realpathSync(root)).toBe(fs.realpathSync(repo));
    expect(metaDirs.length).toBeGreaterThan(0);
    expect(value.branch).toBe('main');
    expect(value.truncated).toBe(false);
    expect(value.untrackedMode).toBe('all');
    const find = (area: string, p: string) => value.files.find((f) => f.area === area && f.path === p);
    expect(find('staged', 'd/新 name.txt')?.origPath).toBe('d/old name.txt');
    expect(find('staged', 'both.txt')).toMatchObject({ add: 1, del: 0 });
    expect(find('unstaged', 'both.txt')).toMatchObject({ add: 1, del: 0 });
    expect(find('untracked', 'gen/f0.js')).toMatchObject({ add: 2, del: 0 });
    expect(value.files.filter((f) => f.area === 'untracked').length).toBe(30);
  });

  it('超限: 先折叠未跟踪目录, 并带 untrackedMode=normal 标记', async () => {
    const { value } = await computeGitStatus(repo, 10);
    expect(value.untrackedMode).toBe('normal');
    expect(value.truncated).toBe(false);
    expect(value.files.some((f) => f.area === 'untracked' && f.path === 'gen/')).toBe(true);
  });

  it('折叠后还超限: 截断并标 truncated', async () => {
    const { value } = await computeGitStatus(repo, 2);
    expect(value.truncated).toBe(true);
    expect(value.files.length).toBeLessThanOrEqual(4);
  });

  it('只读: 算状态不改 .git/index (否则 .git 监听自激)', async () => {
    /* 让 index 里的 stat 信息过期: 默认模式下 git status 会顺手重写 index */
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(repo, 'keep.txt'), later, later);
    const indexPath = path.join(repo, '.git', 'index');
    const before = fs.statSync(indexPath).mtimeMs;
    await computeGitStatus(repo);
    expect(fs.statSync(indexPath).mtimeMs).toBe(before);
  });

  it('不是仓库', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-norepo-'));
    try {
      const { value } = await computeGitStatus(dir);
      expect(value.unavailableReason).toBe('not-a-repo');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('diffGitFiles', () => {
  const f = (p: string, area: GitFileStatus['area'], add?: number): GitFileStatus =>
    ({ path: p, area, indexStatus: area === 'untracked' ? '?' : ' ', worktreeStatus: area === 'untracked' ? '?' : 'M', add });
  it('只给新增 / 变了的, 以及被删的 key', () => {
    const prev = [f('a', 'unstaged', 1), f('b', 'untracked'), f('c', 'unstaged', 2)];
    const next = [f('a', 'unstaged', 1), f('c', 'unstaged', 5), f('d', 'untracked')];
    const d = diffGitFiles(prev, next);
    expect(d.upserts.map((x) => x.path)).toEqual(['c', 'd']);
    expect(d.removes).toEqual(['untracked\0b']);
  });
});
