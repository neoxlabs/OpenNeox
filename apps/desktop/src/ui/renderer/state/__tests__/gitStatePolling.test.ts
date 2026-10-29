import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, '../..', rel), 'utf8');
/* 注释里会引用老写法当记录, 判代码前先剥掉 */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('渲染层: 事件驱动, 没有轮询', () => {
  it('gitStateStore 里没有定时器', () => {
    const src = code('state/gitStateStore.ts');
    expect(src).not.toMatch(/setInterval\(/);
    expect(src).not.toMatch(/setTimeout\(/);
    expect(src).toMatch(/onGitStatusChanged\(/);
    expect(src).toMatch(/gitStatusSubscribe\(/);
  });

  for (const rel of [
    'modules/vcs/components/CommitPanel.tsx',
    'modules/ide-workspace/GitCard.tsx',
    'modules/explorer/components/FileExplorer.tsx',
  ]) {
    it(`${rel} 不自己拉 git status、不起定时器刷状态`, () => {
      const src = code(rel);
      expect(src).not.toMatch(/\.gitStatus\(/);
      expect(src).not.toMatch(/setInterval\(refresh/);
      expect(src).toMatch(/gitStateStore/);
    });
  }

  it('文件树不持有整份角标 map, 每行按路径订阅', () => {
    const src = code('modules/explorer/components/FileExplorer.tsx');
    expect(src).not.toMatch(/gitStatusMap/);
    expect(src).toMatch(/useGitFileBadge\(/);
  });
});

describe('主进程: git:status 不在主线程算', () => {
  it('gitHandlers 走 gitStatusHost, 自己不跑 status', () => {
    const src = code('../electron/ipc/gitHandlers.ts');
    expect(src).toMatch(/gitStatusHost\.get\(/);
    expect(src).not.toMatch(/'status', '--porcelain/);
  });

  it('gitStatusHost 起 worker', () => {
    expect(code('../electron/services/gitStatusHost.ts')).toMatch(/new Worker\(new URL\('\.\.\/workers\/gitStatusWorker\.js'/);
  });

  it('worker 在 tsup 入口表里 (否则打包版解析不到)', () => {
    const tsup = readFileSync(resolve(HERE, '../../../../../../../tsup.config.ts'), 'utf8');
    expect(tsup).toMatch(/'ui-electron\/workers\/gitStatusWorker'/);
  });

  it('文件树 watcher 不再用 chokidar 轮询', () => {
    const src = code('../electron/ipc/workspaceWatcherHandlers.ts');
    expect(src).not.toMatch(/chokidar/);
    expect(src).not.toMatch(/usePolling/);
  });
});
