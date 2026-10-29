import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { tierToPolicy, secretGuards, tierNeedsSandbox, normalizeRoots } from '../policy.js';
import { buildSeatbeltProfile, paramsToArgs } from '../seatbelt.js';
import { buildBwrapArgs } from '../linux.js';
import { buildSandboxInvocation } from '../index.js';

const ctx = {
  workspaceRoot: '/Users/x/proj',
  home: '/Users/x',
  tmpDir: '/tmp/neox',
};

describe('tierToPolicy', () => {
  it('read-only: 无写、断网', () => {
    const p = tierToPolicy('read-only', ctx);
    expect(p.fs.writeRoots).toEqual([]);
    expect(p.fs.read).toBe('all');
    expect(p.net).toBe('none');
  });

  it('workspace-write: 工作区可写 + 断网 + 密钥护栏', () => {
    const p = tierToPolicy('workspace-write', ctx);
    expect(p.fs.writeRoots).toContain('/Users/x/proj');
    expect(p.fs.writeRoots).toContain('/tmp/neox');
    expect(p.net).toBe('none');
    // 护栏: .git 与 ~/.ssh ~/.neox 恒在只读洞
    expect(p.fs.readOnlyWithin).toContain('/Users/x/proj/.git');
    expect(p.fs.readOnlyWithin).toContain('/Users/x/.ssh');
    /* 办公版用户目录是 .neox-lite (见 kernel/platform/neoxHome.ts)。
     * neox-sandbox 不依赖 kernel, 这里只能写字面量 —— 两处必须同时改。 */
    expect(p.fs.readOnlyWithin).toContain('/Users/x/.neox-lite');
  });

  it('workspace-net: 同上但放网', () => {
    const p = tierToPolicy('workspace-net', ctx);
    expect(p.net).toBe('all');
    expect(p.fs.writeRoots).toContain('/Users/x/proj');
  });

  it('trusted: 不需要沙盒', () => {
    expect(tierNeedsSandbox('trusted')).toBe(false);
    expect(tierNeedsSandbox('workspace-write')).toBe(true);
  });

  it('disableSecretGuards 关掉护栏', () => {
    const p = tierToPolicy('workspace-write', { ...ctx, disableSecretGuards: true });
    expect(p.fs.readOnlyWithin).toEqual([]);
  });

  it('extraWriteRoots 追加', () => {
    const p = tierToPolicy('workspace-write', { ...ctx, extraWriteRoots: ['/data/shared'] });
    expect(p.fs.writeRoots).toContain('/data/shared');
  });
});

describe('secretGuards', () => {
  it('含 BYOK 密钥 + git 凭据 + git 历史 + registry token', () => {
    const g = secretGuards('/w', '/h');
    expect(g).toContain('/w/.git'); // git 历史 + hooks 逃逸防护
    expect(g).toContain('/h/.ssh');
    expect(g).toContain('/h/.aws');
    expect(g).toContain('/h/.neox-lite'); // Neox 凭据目录 (极简版)
    expect(g).toContain('/h/.config/neox');
    // 扩展凭据 (常被忽略但含明文 token)
    expect(g).toContain('/h/.npmrc');
    expect(g).toContain('/h/.git-credentials');
    expect(g).toContain('/h/.netrc');
    expect(g).toContain('/h/.pypirc');
    expect(g).toContain('/h/.config/gcloud');
  });
});

describe('buildSeatbeltProfile — 注入安全 + 语义', () => {
  it('路径只经 param 出现, 绝不内联进 profile 文本 (注入安全)', () => {
    const evil = '/Users/x/proj"; (allow default) ;"';
    const p = tierToPolicy('workspace-write', { ...ctx, workspaceRoot: evil });
    const { profile, params } = buildSeatbeltProfile(p);
    // 恶意路径出现在 params 值里 (作为 -D 传入, sandbox-exec 不会当 SBPL 解析)
    //  win 适配: 实现按 posix 保留原样, 不再 path.resolve —— 断言直接用 evil,
    // 否则 win 上 resolve 给 unix 路径加盘符前缀 (e:\Users\x...) 反而对不上。
    expect(Object.values(params)).toContain(evil);
    // profile 文本里不含 "(allow default)" 注入片段
    expect(profile).not.toContain('(allow default)');
    // profile 只引用 param, 不含原始恶意路径字符串
    expect(profile).not.toContain('(allow default) ;');
  });

  it('read-only: 有 file-read* 全放, 无 file-write*', () => {
    const p = tierToPolicy('read-only', ctx);
    const { profile } = buildSeatbeltProfile(p);
    expect(profile).toContain('(allow file-read*)');
    expect(profile).not.toContain('(allow file-write*');
    // 断网: 不含 network allow
    expect(profile).not.toContain('(allow network');
  });

  it('workspace-write: 写档带 require-not 只读洞', () => {
    const p = tierToPolicy('workspace-write', ctx);
    const { profile, params } = buildSeatbeltProfile(p);
    expect(profile).toContain('(allow file-write*');
    expect(profile).toContain('(require-not (subpath (param "RO0")))');
    expect(profile).toContain('(require-any');
    // 工作区在 WR 参数里, .git 在 RO 参数里
    expect(Object.values(params)).toContain('/Users/x/proj');
    expect(Object.values(params)).toContain('/Users/x/proj/.git');
  });

  it('workspace-net: 含 (allow network*)', () => {
    const p = tierToPolicy('workspace-net', ctx);
    const { profile } = buildSeatbeltProfile(p);
    expect(profile).toContain('(allow network*)');
  });

  it('基座含完整 sysctl/mach 白名单 (不误伤正常命令)', () => {
    const { profile } = buildSeatbeltProfile(tierToPolicy('read-only', ctx));
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('com.apple.trustd'); // 证书验证
    expect(profile).toContain('hw.ncpu'); // sysctl
    expect(profile).toContain('(allow process-exec)');
  });

  it('paramsToArgs 展开成 -D KEY=VALUE', () => {
    const args = paramsToArgs({ WR0: '/a', RO0: '/a/.git' });
    expect(args).toEqual(['-D', 'WR0=/a', '-D', 'RO0=/a/.git']);
  });
});

describe('buildBwrapArgs — Linux 真 fs 隔离', () => {
  it('整盘只读 + 工作区可写 bind + .git 只读洞覆盖', () => {
    const p = tierToPolicy('workspace-write', ctx);
    const args = buildBwrapArgs(p, { command: 'echo hi', cwd: '/Users/x/proj' });
    const s = args.join(' ');
    expect(s).toContain('--ro-bind / /'); // 整盘只读
    expect(s).toContain('--bind /Users/x/proj /Users/x/proj'); // 工作区可写
    expect(s).toContain('--ro-bind-try /Users/x/proj/.git'); // .git 覆盖回只读
    expect(s).toContain('--unshare-net'); // 断网
  });

  it('workspace-net: 不 unshare-net', () => {
    const p = tierToPolicy('workspace-net', ctx);
    const args = buildBwrapArgs(p, { command: 'x', cwd: '/w' });
    expect(args).not.toContain('--unshare-net');
  });
});

describe('normalizeRoots', () => {
  it('去重 + 去掉被父路径覆盖的子路径', () => {
    const r = normalizeRoots(['/a', '/a/b', '/c', '/a']);
    expect(r.sort()).toEqual(['/a', '/c']);
  });
});

describe('buildSandboxInvocation — 后端选择', () => {
  it('forceBackend none → 直跑 + degraded', () => {
    const p = tierToPolicy('workspace-write', ctx);
    const inv = buildSandboxInvocation(p, { command: 'echo hi', cwd: '/w' }, { forceBackend: 'none' });
    expect(inv.backend).toBe('none');
    expect(inv.args.join(' ')).toContain('echo hi');
  });

  it('win32 降级直跑: 有 SHELL=bash 也必须用 ComSpec/cmd, 绝不用 /c+bash', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevShell = process.env.SHELL;
    const prevComSpec = process.env.ComSpec;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    process.env.SHELL = 'C:\\Git\\bin\\bash.exe';
    process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe';
    try {
      const p = tierToPolicy('workspace-write', {
        workspaceRoot: 'C:\\proj',
        home: 'C:\\Users\\x',
        tmpDir: 'C:\\tmp\\neox',
      });
      const inv = buildSandboxInvocation(
        p,
        { command: 'echo hello', cwd: 'C:\\proj' },
        { forceBackend: 'none' },
      );
      expect(inv.backend).toBe('none');
      expect(inv.program.toLowerCase()).toContain('cmd.exe');
      expect(inv.program.toLowerCase()).not.toContain('bash');
      expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(inv.args[3]).toBe('echo hello');
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (prevShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = prevShell;
      if (prevComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = prevComSpec;
    }
  });

  it('win32 降级直跑: run.shell=bash/powershell 也不得配 /c, 强制 ComSpec', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevComSpec = process.env.ComSpec;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe';
    try {
      const p = tierToPolicy('workspace-write', {
        workspaceRoot: 'C:\\proj',
        home: 'C:\\Users\\x',
        tmpDir: 'C:\\tmp\\neox',
      });
      for (const shell of ['C:\\Git\\bin\\bash.exe', 'powershell.exe', 'pwsh']) {
        const inv = buildSandboxInvocation(
          p,
          { command: 'echo hi', cwd: 'C:\\proj', shell },
          { forceBackend: 'none' },
        );
        expect(inv.program, shell).toBe('C:\\Windows\\system32\\cmd.exe');
        expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      }
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (prevComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = prevComSpec;
    }
  });

  it('win32 probe → appcontainer 优先', async () => {
    if (process.platform !== 'win32') return;
    const { resetProbeCache, probeBackend } = await import('../probe.js');
    const { resetRestrictedTokenProbe } = await import('../windows.js');
    resetRestrictedTokenProbe();
    resetProbeCache();
    const p = probeBackend();
    expect(p.backend).toBe('appcontainer');
    expect(p.available).toBe(true);
  });

  it('forceBackend appcontainer → runner 包装 cmd', () => {
    if (process.platform !== 'win32') return;
    const p = tierToPolicy('workspace-write', {
      workspaceRoot: 'C:\\proj',
      home: 'C:\\Users\\x',
      tmpDir: 'C:\\tmp\\neox',
    });
    const inv = buildSandboxInvocation(
      p,
      { command: 'echo ac-ok', cwd: 'C:\\proj' },
      { forceBackend: 'appcontainer' },
    );
    expect(inv.backend).toBe('appcontainer');
    expect(inv.program).toBe(process.execPath);
    expect(inv.args.some((a) => a.includes('winAppContainerRunner'))).toBe(true);
    expect(inv.args.some((a) => a.startsWith('--profile='))).toBe(true);
    expect(inv.args.some((a) => a.startsWith('--write-root='))).toBe(true);
    expect(inv.args).toContain('--');
    expect(inv.args.join(' ')).toContain('echo ac-ok');
  });

  it('forceBackend restricted-token → runner 包装 cmd', () => {
    if (process.platform !== 'win32') return;
    const p = tierToPolicy('workspace-write', {
      workspaceRoot: 'C:\\proj',
      home: 'C:\\Users\\x',
      tmpDir: 'C:\\tmp\\neox',
    });
    const inv = buildSandboxInvocation(
      p,
      { command: 'echo rt-ok', cwd: 'C:\\proj' },
      { forceBackend: 'restricted-token' },
    );
    expect(inv.backend).toBe('restricted-token');
    expect(inv.program).toBe(process.execPath);
    expect(inv.args.some((a) => a.includes('winJobRunner'))).toBe(true);
    expect(inv.args).toContain('--');
    expect(inv.args.join(' ')).toContain('echo rt-ok');
  });
});
