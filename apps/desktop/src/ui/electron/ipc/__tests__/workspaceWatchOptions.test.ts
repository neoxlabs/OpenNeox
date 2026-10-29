import { describe, expect, it } from 'vitest';
import {
  createNativeWatchCoalescer,
  NATIVE_WATCH_COALESCE_MS,
  NATIVE_WATCH_MAX_PATHS_PER_FLUSH,
  preferNativeRecursiveFsWatch,
  translateNativeFsWatchEvent,
  translateParcelWatchEvent,
  watchPathLooksIgnored,
  workspaceWatchBackendOrder,
  workspaceWatchParcelIgnoreGlobs,
} from '../workspaceWatchOptions.js';
import { WATCH_IGNORE_DIRS, isWatchIgnoredDirSegment } from '@neoxlabs/kernel/platform/watchIgnoreSpec.js';

describe('workspace watch backend', () => {
  it('后端优先级末尾一定是 none —— 降级是显式的, 不存在"悄悄换成全树轮询"', () => {
    const win = workspaceWatchBackendOrder('win32');
    const mac = workspaceWatchBackendOrder('darwin');
    expect(win).toEqual(['fs-watch-recursive', 'parcel', 'none']);
    expect(mac).toEqual(['parcel', 'none']);
    for (const order of [win, mac, workspaceWatchBackendOrder('linux')]) {
      expect(order[order.length - 1]).toBe('none');
      expect(order.some((b) => /poll/i.test(b))).toBe(false);
    }
  });

  it('Windows 优先 recursive fs.watch, 其它平台不走它', () => {
    expect(preferNativeRecursiveFsWatch('win32')).toBe(true);
    expect(preferNativeRecursiveFsWatch('darwin')).toBe(false);
    expect(preferNativeRecursiveFsWatch('linux')).toBe(false);
  });

  it('parcel ignore 盖住缓存 / 构建产物 / 打包 node 运行时', () => {
    const globs = workspaceWatchParcelIgnoreGlobs().join('\n');
    expect(globs).toContain('**/.cache/**');
    expect(globs).toContain('**/node_modules/**');
    expect(globs).toContain('**/.parcel-cache/**');
    expect(globs).toContain('**/Caches/**');
    expect(globs).toContain('**/.npm/**');
    expect(globs).toContain('**/.vite/**');
    expect(globs).toContain('**/resources/node-runtime/**');
    expect(globs).toContain('**/*.asar');
  });

  it('native 回调也丢掉缓存路径', () => {
    expect(watchPathLooksIgnored('E:/ws/.cache/x')).toBe(true);
    expect(watchPathLooksIgnored('E:/ws/node_modules/x')).toBe(true);
    expect(watchPathLooksIgnored('E:/ws/src/index.ts')).toBe(false);
    expect(watchPathLooksIgnored('E:/code/ltoa/app/linux/flutter/ephemeral/.plugin_symlinks/x')).toBe(true);
    expect(watchPathLooksIgnored('E:/code/ltoa/.dart_tool/package_config.json')).toBe(true);
  });

  it('ignore 目录清单来自 kernel 单一真相源 (与 agent 侧 WatchCoordinator 同一份)', () => {
    /* desktop 侧不再维护第二份清单 —— 两侧漂移会导致"界面看不见、agent 能改"。 */
    for (const dir of ['node_modules', '.git', '.neox', 'ephemeral', '.pnpm', '.dart_tool']) {
      expect(WATCH_IGNORE_DIRS).toContain(dir);
      expect(isWatchIgnoredDirSegment(dir)).toBe(true);
    }
    /* macOS bundle 后缀: 严格 endsWith 且不能把裸后缀本身当命中 */
    expect(isWatchIgnoredDirSegment('Foo.app')).toBe(true);
    expect(isWatchIgnoredDirSegment('.app')).toBe(false);
    expect(isWatchIgnoredDirSegment('src')).toBe(false);
  });

  it('parcel 事件映射不把 delete 猜成 unlinkDir', () => {
    expect(translateParcelWatchEvent('create', false)).toBe('add');
    expect(translateParcelWatchEvent('create', true)).toBe('addDir');
    expect(translateParcelWatchEvent('update', false)).toBe('change');
    expect(translateParcelWatchEvent('delete', true)).toBe('unlink');
  });

  it('Windows recursive fs.watch rename/change 映射', () => {
    expect(translateNativeFsWatchEvent('change', true, false)).toBe('change');
    expect(translateNativeFsWatchEvent('rename', true, false)).toBe('add');
    expect(translateNativeFsWatchEvent('rename', true, true)).toBe('addDir');
    expect(translateNativeFsWatchEvent('rename', false, false)).toBe('unlink');
  });
});

describe('native 事件合批', () => {
  const flushAfter = (pushCount: number, maxPaths = NATIVE_WATCH_MAX_PATHS_PER_FLUSH) => {
    const batches: Array<{ paths: string[]; collapsed: boolean; droppedPaths: number }> = [];
    const c = createNativeWatchCoalescer((b) => batches.push(b), 5, maxPaths);
    for (let i = 0; i < pushCount; i++) c.push(`E:/ws/dir${i % 5}/file${i}.txt`);
    return new Promise<typeof batches>((resolve) => {
      setTimeout(() => { c.dispose(); resolve(batches); }, 30);
    });
  };

  it('小批量: 原样上报, 同一路径 50ms 内只算一次', async () => {
    const batches: Array<{ paths: string[]; collapsed: boolean }> = [];
    const c = createNativeWatchCoalescer((b) => batches.push(b), 5, 200);
    c.push('E:/ws/a.txt');
    c.push('E:/ws/a.txt');
    c.push('E:/ws/b.txt');
    await new Promise((r) => setTimeout(r, 30));
    c.dispose();
    expect(batches).toHaveLength(1);
    expect(batches[0].collapsed).toBe(false);
    expect([...batches[0].paths].sort()).toEqual(['E:/ws/a.txt', 'E:/ws/b.txt']);
  });

  it('超上限: 折叠到父目录, 不再逐路径 stat (防 npm install 式风暴钉死主线程)', async () => {
    const batches = await flushAfter(NATIVE_WATCH_MAX_PATHS_PER_FLUSH * 3);
    expect(batches).toHaveLength(1);
    expect(batches[0].collapsed).toBe(true);
    expect(batches[0].paths.length).toBeLessThanOrEqual(NATIVE_WATCH_MAX_PATHS_PER_FLUSH);
    expect(batches[0].paths.every((p) => !/file\d+\.txt$/.test(p))).toBe(true);
    expect(batches[0].droppedPaths).toBe(NATIVE_WATCH_MAX_PATHS_PER_FLUSH * 3);
  });

  it('合批窗口是 50ms (Flutter 热重载/多写盘源抖动合成一次)', () => {
    expect(NATIVE_WATCH_COALESCE_MS).toBe(50);
  });
});
