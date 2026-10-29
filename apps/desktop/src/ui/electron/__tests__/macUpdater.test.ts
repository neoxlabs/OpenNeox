import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* macUpdater 顶层 import electron — node 环境下没有, mock 掉 (只测纯解析逻辑) */
vi.mock('electron', () => ({
  app: { getVersion: () => '3.1.1', getPath: () => '/tmp', getAppPath: () => '/tmp', quit: () => {} },
}));

const { parseLatestMacYml, buildApplyScript } = await import('../macUpdater.js');

/* 线上 https://dl.neox-dev.com/desktop/latest-mac.yml 的真实结构 (3.1.0 那一版, sha512 截短) */
const REAL_FEED = `version: 3.1.0
files:
  - url: Neox-3.1.0-x64.zip
    sha512: gqqss/SEGM0+FRPY04Lsq3+ecsxHkj9q8Qh0TSNhYVYoOXeV0ZSTgeENxFOdgr49C6FwvGdd7PcR2V6Zde4iPA==
    size: 617344580
  - url: Neox-3.1.0-arm64.zip
    sha512: s7+zGfokbd+2OQCP0xqlsZnMR/PUebk/bncitiK0tatb6wy2AgUc18bnqwq33KAGjNk2v7ndtYSCaMNkTeNZ8A==
    size: 609512160
  - url: Neox-3.1.0-x64.dmg
    sha512: GTVenH6EHflD4iIdafXzTYPCwPJ3GWusn6SHRjrj5Y23iCJnGw+a3Y1zXm7dqV6HSAPFYAw6Ei/pT30OFA9rRw==
    size: 619074212
  - url: Neox-3.1.0-arm64.dmg
    sha512: h8x8H3Ox5DUW/ndxhLfLWu4SRSyOQtb6w8falfRlhONASF4ye7KxyoNLhYPogQjTlcmynbDDi26u3rEzD5dk3Q==
    size: 611262537
path: Neox-3.1.0-x64.zip
sha512: gqqss/SEGM0+FRPY04Lsq3+ecsxHkj9q8Qh0TSNhYVYoOXeV0ZSTgeENxFOdgr49C6FwvGdd7PcR2V6Zde4iPA==
releaseDate: '2026-07-27T16:57:56.017Z'
`;

describe('parseLatestMacYml', () => {
  it('parses version and every file entry from the real feed shape', () => {
    const r = parseLatestMacYml(REAL_FEED);
    expect(r.version).toBe('3.1.0');
    expect(r.files).toHaveLength(4);
    expect(r.files.map((f) => f.url)).toEqual([
      'Neox-3.1.0-x64.zip',
      'Neox-3.1.0-arm64.zip',
      'Neox-3.1.0-x64.dmg',
      'Neox-3.1.0-arm64.dmg',
    ]);
    expect(r.files.every((f) => f.sha512.length > 40)).toBe(true);
    expect(r.files[1].size).toBe(609512160);
  });

  it('stops at the top-level keys after files (path/sha512/releaseDate 不能被当成第 5 个文件)', () => {
    const r = parseLatestMacYml(REAL_FEED);
    /* 顶格的 path:/sha512: 跟 files 里的缩进 sha512: 同名 — 解析器必须靠缩进区分,
     * 否则最后一条 dmg 的 sha512 会被顶格那个覆盖成 x64.zip 的哈希 → 校验必失败 */
    expect(r.files[3].sha512.startsWith('h8x8H3Ox5DUW')).toBe(true);
  });

  it('picks the arch-matching zip, never the dmg', () => {
    const r = parseLatestMacYml(REAL_FEED);
    const pick = (arch: string) => r.files.find((f) => f.url.endsWith('.zip') && f.url.includes(`-${arch}.`));
    expect(pick('arm64')?.url).toBe('Neox-3.1.0-arm64.zip');
    expect(pick('x64')?.url).toBe('Neox-3.1.0-x64.zip');
  });

  it('returns empty version for garbage input (调用方据此报错, 不静默当成有更新)', () => {
    expect(parseLatestMacYml('').version).toBe('');
    expect(parseLatestMacYml('<html>404</html>').version).toBe('');
    expect(parseLatestMacYml('<html>404</html>').files).toHaveLength(0);
  });
});

describe('下载中途断网', () => {
  it('reader 报错时不留 uncaughtException, 且把错误如实抛给调用方', async () => {
    const { downloadAndStageMacUpdate } = await import('../macUpdater.js');
    const statePath = '/tmp/neox-mac-update/download-state.json';
    const partPath = '/tmp/neox-mac-update/Neox-9.9.9-test.zip.part';
    rmSync('/tmp/neox-mac-update', { recursive: true, force: true });

    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);

    const chunk = new Uint8Array(4096);
    let reads = 0;
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '16384' : null) },
      body: {
        getReader: () => ({
          read: async () => {
            if (reads++ === 0) {
              /* 先让 createWriteStream 把 fd 打开 —— 否则这个 chunk 只是躺在
               * 写流的缓冲区里, 压根没有"在飞的 fs.write", 复现不到崩溃那条路径 */
              await new Promise((r) => setTimeout(r, 20));
              return { done: false, value: chunk };
            }
            throw new Error('ECONNRESET (测试: 下载中途断网)');
          },
        }),
      },
    }));

    try {
      const err = await downloadAndStageMacUpdate({
        version: '9.9.9-test',
        zipUrl: 'https://dl.neox-dev.com/desktop/Neox-9.9.9-test-arm64.zip',
        sha512: 'ignored',
        size: 16384,
      }).then(() => null, (e: unknown) => e);

      /* 让在飞的 fs 写回调跑完 —— 崩溃恰恰发生在这个窗口里 */
      await new Promise((r) => setTimeout(r, 300));

      expect(String((err as Error)?.message)).toContain('ECONNRESET');
      expect(uncaught).toEqual([]);
      /* 半成品留着 (续传的本钱), 但写流必须已经收摊: 文件句柄不许漏 */
      expect(existsSync(statePath)).toBe(true);
      expect(existsSync(partPath)).toBe(true);
    } finally {
      process.off('uncaughtException', onUncaught);
      vi.unstubAllGlobals();
      rmSync('/tmp/neox-mac-update', { recursive: true, force: true });
    }
  });
});

/**
 * 写不进去 (EACCES / ENOSPC / EISDIR) 时的另一半: 常驻监听者把错误存下来了,
 * 那么循环必须**看得见它并如实报错** —— 不补这一步就变成静默挂住 (比崩溃更糟:
 * 下载永远停在 0%, 用户什么提示都没有)。
 */
describe('落盘本身失败', () => {
  it('part 文件打不开时快速报错, 不挂住也不留 uncaughtException', async () => {
    const { downloadAndStageMacUpdate } = await import('../macUpdater.js');
    rmSync('/tmp/neox-mac-update', { recursive: true, force: true });
    mkdirSync('/tmp/neox-mac-update', { recursive: true });
    /* 只读文件 → createWriteStream 的 open 直接 EACCES (size 0, 不会走 Range 分支) */
    writeFileSync('/tmp/neox-mac-update/Neox-9.9.9-denied.zip.part', '', { mode: 0o400 });

    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '16384' },
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(4096) }),
        }),
      },
    }));

    try {
      const outcome = await Promise.race([
        downloadAndStageMacUpdate({
          version: '9.9.9-denied',
          zipUrl: 'https://dl.neox-dev.com/desktop/Neox-9.9.9-denied-arm64.zip',
          sha512: 'ignored',
          size: 16384,
        }).then(() => null, (e: unknown) => e),
        new Promise((r) => setTimeout(() => r('TIMEOUT' as const), 3000)),
      ]);

      expect(outcome).not.toBe('TIMEOUT');
      expect((outcome as Error)?.message).toMatch(/EACCES|EPERM|EROFS/);
      await new Promise((r) => setTimeout(r, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      vi.unstubAllGlobals();
      rmSync('/tmp/neox-mac-update', { recursive: true, force: true });
    }
  });
});

const describeRestart = process.platform === 'darwin' ? describe : describe.skip;

const STAGING = '/tmp/neox-mac-update';

/** 造一份真的可解压、可验签的 zip: Neox.app (含真 Info.plist) → ad-hoc 签名 → zip */
function buildZipFixture(rootDir: string, version: string): { zipPath: string; sha512: string; size: number } {
  const srcRoot = join(rootDir, 'src');
  const appPath = join(srcRoot, 'Neox.app');
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(appPath, 'Contents', 'MacOS', 'Neox'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(appPath, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.mk.neox.test</string>
  <key>CFBundleName</key><string>Neox</string>
  <key>CFBundleExecutable</key><string>Neox</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
</dict></plist>
`, 'utf-8');
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '-s', '-', appPath], { stdio: 'pipe' });

  const zipPath = join(rootDir, `Neox-${version}.zip`);
  execFileSync('/usr/bin/zip', ['-qry', zipPath, 'Neox.app'], { cwd: srcRoot });
  const bytes = readFileSync(zipPath);
  return { zipPath, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length };
}

/** 把 fixture 的字节当作 HTTP 响应喂给 updater */
function serveZipOnce(zipPath: string) {
  let sent = false;
  return async () => {
    const bytes = readFileSync(zipPath);
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
        }),
      },
    };
  };
}

describeRestart('暂存包跨重启复用', () => {
  let sandbox = '';
  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = '';
    rmSync(STAGING, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('下完写盘; "重启"后直接复用, 不再走一次网络', async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'neox-stage-'));
    const fixture = buildZipFixture(sandbox, '3.9.9');
    const manifest = {
      version: '3.9.9',
      zipUrl: 'https://dl.neox-dev.com/desktop/Neox-3.9.9-arm64.zip',
      sha512: fixture.sha512,
      size: fixture.size,
    };

    const mac = await import('../macUpdater.js');
    vi.stubGlobal('fetch', serveZipOnce(fixture.zipPath));
    const staged = await mac.downloadAndStageMacUpdate(manifest);

    expect(staged.version).toBe('3.9.9');
    expect(existsSync(staged.stagedAppPath)).toBe(true);
    expect(existsSync(join(STAGING, 'staged.json'))).toBe(true);

    /* ── "重启" ── 清模块缓存 = 新进程 (内存里的 lastStaged 没了), 且让 fetch 一调就炸:
     *    还能认出这份包, 就证明它完全来自盘上的标记, 没有再下一遍。 */
    vi.resetModules();
    vi.stubGlobal('fetch', async () => { throw new Error('重启后不该再发起下载'); });
    const mac2 = await import('../macUpdater.js');
    const again = await mac2.resolveStagedMacUpdate();

    expect(again?.version).toBe('3.9.9');
    expect(again?.stagedAppPath).toBe(staged.stagedAppPath);
    /* 同一个版本再下也走复用 (不再下一遍 200MB) */
    const again2 = await mac2.downloadAndStageMacUpdate(manifest);
    expect(again2.stagedAppPath).toBe(staged.stagedAppPath);
  });

  it('标记里的版本不新于当前版本 → 当它不存在 (否则每次退出都会"重装"同一个版本)', async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'neox-stage-old-'));
    const stagedApp = join(sandbox, 'extracted', 'Neox.app');
    mkdirSync(join(stagedApp, 'Contents'), { recursive: true });

    mkdirSync(STAGING, { recursive: true });
    writeFileSync(join(STAGING, 'staged.json'), JSON.stringify({
      version: '3.0.0',                 /* app.getVersion() 在测试里是 3.1.1 */
      stagedAppPath: stagedApp,
      verifiedAt: new Date().toISOString(),
    }));

    const mac = await import('../macUpdater.js');
    expect(await mac.resolveStagedMacUpdate()).toBeNull();
  });
});

/**
 * apply helper 是整条链里唯一会动用户已安装 app 的一步 — 出错的代价是用户没有 Neox 可用。
 * 这组测试跑【真的 shell 脚本】, 对着假 .app 目录, 覆盖成功替换与两条回滚路径。
 * 只在 macOS 跑 (依赖 ditto/open 的行为)。
 */
const describeMac = process.platform === 'darwin' ? describe : describe.skip;

let sandboxes: string[] = [];
afterEach(() => {
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true });
  sandboxes = [];
});

/** 造一个最小可辨认的假 .app: Contents/MacOS/<name> 可执行 + 一个版本标记文件 */
function makeFakeApp(root: string, name: string, version: string, opts: { withExecutable?: boolean } = {}): string {
  const appPath = join(root, `${name}.app`);
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(appPath, 'Contents', 'VERSION.txt'), version, 'utf-8');
  if (opts.withExecutable !== false) {
    const exe = join(appPath, 'Contents', 'MacOS', name);
    writeFileSync(exe, '#!/bin/bash\nexit 0\n', 'utf-8');
    chmodSync(exe, 0o755);
  }
  return appPath;
}

function runApply(spec: Parameters<typeof buildApplyScript>[0], sandbox: string): string {
  const scriptPath = join(sandbox, 'apply.sh');
  /* open(1) 在测试里会真去启动 app — 用一个同名 stub 顶掉, 顺便证明脚本确实调了它 */
  const stubBin = join(sandbox, 'stubbin');
  mkdirSync(stubBin, { recursive: true });
  const openStub = join(stubBin, 'open');
  writeFileSync(openStub, `#!/bin/bash\necho "OPEN $*" >> "${join(sandbox, 'open.log')}"\n`, 'utf-8');
  chmodSync(openStub, 0o755);

  writeFileSync(scriptPath, buildApplyScript(spec), 'utf-8');
  chmodSync(scriptPath, 0o755);
  try {
    /* 传一个必然不存在的 pid, 等待循环立刻跳出 */
    execFileSync('/bin/bash', [scriptPath, '999999'], {
      env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
    });
  } catch { /* 回滚路径故意 exit 1 — 由断言判定, 不靠退出码 */ }
  return existsSync(spec.logPath) ? readFileSync(spec.logPath, 'utf-8') : '';
}

describeMac('buildApplyScript — 真跑替换与回滚', () => {
  it('替换成功: 新版本就位, 备份被清掉, 新 app 被拉起', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'neox-apply-ok-'));
    sandboxes.push(sandbox);
    const installRoot = join(sandbox, 'Applications');
    const stageRoot = join(sandbox, 'stage');
    mkdirSync(installRoot, { recursive: true });
    mkdirSync(stageRoot, { recursive: true });

    const targetApp = makeFakeApp(installRoot, 'Neox', '3.1.0');
    const stagedApp = makeFakeApp(stageRoot, 'Neox', '3.1.2');

    const log = runApply({
      targetApp,
      rollback: `${targetApp}.neox-rollback`,
      stagedAppPath: stagedApp,
      version: '3.1.2',
      logPath: join(sandbox, 'apply.log'),
      extractedDir: stageRoot,
    }, sandbox);

    expect(readFileSync(join(targetApp, 'Contents', 'VERSION.txt'), 'utf-8')).toBe('3.1.2');
    expect(existsSync(`${targetApp}.neox-rollback`)).toBe(false);
    expect(log).toContain('apply ok → 3.1.2');
    expect(readFileSync(join(sandbox, 'open.log'), 'utf-8')).toContain(targetApp);
  });

  it('新包损坏 (缺可执行文件): 自动回滚, 用户手里仍是能跑的旧版本', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'neox-apply-rollback-'));
    sandboxes.push(sandbox);
    const installRoot = join(sandbox, 'Applications');
    const stageRoot = join(sandbox, 'stage');
    mkdirSync(installRoot, { recursive: true });
    mkdirSync(stageRoot, { recursive: true });

    const targetApp = makeFakeApp(installRoot, 'Neox', '3.1.0');
    /* 新包没有 Contents/MacOS/Neox → 第 4 步自检必须拦下并回滚 */
    const stagedApp = makeFakeApp(stageRoot, 'Neox', '3.1.2', { withExecutable: false });

    const log = runApply({
      targetApp,
      rollback: `${targetApp}.neox-rollback`,
      stagedAppPath: stagedApp,
      version: '3.1.2',
      logPath: join(sandbox, 'apply.log'),
      extractedDir: stageRoot,
    }, sandbox);

    expect(existsSync(targetApp)).toBe(true);
    expect(readFileSync(join(targetApp, 'Contents', 'VERSION.txt'), 'utf-8')).toBe('3.1.0');
    expect(existsSync(join(targetApp, 'Contents', 'MacOS', 'Neox'))).toBe(true);
    expect(existsSync(`${targetApp}.neox-rollback`)).toBe(false);
    expect(log).toContain('missing executable');
    expect(readFileSync(join(sandbox, 'open.log'), 'utf-8')).toContain(targetApp);
  });

  it('暂存包整个不存在: 旧 app 原样恢复, 不留半残状态', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'neox-apply-nostage-'));
    sandboxes.push(sandbox);
    const installRoot = join(sandbox, 'Applications');
    mkdirSync(installRoot, { recursive: true });

    const targetApp = makeFakeApp(installRoot, 'Neox', '3.1.0');

    const log = runApply({
      targetApp,
      rollback: `${targetApp}.neox-rollback`,
      stagedAppPath: join(sandbox, 'does-not-exist', 'Neox.app'),
      version: '3.1.2',
      logPath: join(sandbox, 'apply.log'),
      extractedDir: join(sandbox, 'stage'),
    }, sandbox);

    expect(existsSync(targetApp)).toBe(true);
    expect(readFileSync(join(targetApp, 'Contents', 'VERSION.txt'), 'utf-8')).toBe('3.1.0');
    expect(existsSync(`${targetApp}.neox-rollback`)).toBe(false);
    expect(log).toContain('ditto new app failed');
  });

  it('relaunch:false 替换成功: 新版本就位, 但不把 app 拉起来', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'neox-apply-quiet-ok-'));
    sandboxes.push(sandbox);
    const installRoot = join(sandbox, 'Applications');
    const stageRoot = join(sandbox, 'stage');
    mkdirSync(installRoot, { recursive: true });
    mkdirSync(stageRoot, { recursive: true });

    const targetApp = makeFakeApp(installRoot, 'Neox', '3.1.0');
    const stagedApp = makeFakeApp(stageRoot, 'Neox', '3.1.2');

    const log = runApply({
      targetApp,
      rollback: `${targetApp}.neox-rollback`,
      stagedAppPath: stagedApp,
      version: '3.1.2',
      logPath: join(sandbox, 'apply.log'),
      extractedDir: stageRoot,
      relaunch: false,
    }, sandbox);

    expect(readFileSync(join(targetApp, 'Contents', 'VERSION.txt'), 'utf-8')).toBe('3.1.2');
    expect(log).toContain('apply ok → 3.1.2');
    expect(existsSync(join(sandbox, 'open.log'))).toBe(false);
  });

  it('relaunch:false 回滚: 旧版本原样留着, 同样不拉起来', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'neox-apply-quiet-rollback-'));
    sandboxes.push(sandbox);
    const installRoot = join(sandbox, 'Applications');
    const stageRoot = join(sandbox, 'stage');
    mkdirSync(installRoot, { recursive: true });
    mkdirSync(stageRoot, { recursive: true });

    const targetApp = makeFakeApp(installRoot, 'Neox', '3.1.0');
    const stagedApp = makeFakeApp(stageRoot, 'Neox', '3.1.2', { withExecutable: false });

    const log = runApply({
      targetApp,
      rollback: `${targetApp}.neox-rollback`,
      stagedAppPath: stagedApp,
      version: '3.1.2',
      logPath: join(sandbox, 'apply.log'),
      extractedDir: stageRoot,
      relaunch: false,
    }, sandbox);

    expect(readFileSync(join(targetApp, 'Contents', 'VERSION.txt'), 'utf-8')).toBe('3.1.0');
    expect(existsSync(`${targetApp}.neox-rollback`)).toBe(false);
    expect(log).toContain('missing executable');
    expect(existsSync(join(sandbox, 'open.log'))).toBe(false);
  });
});
