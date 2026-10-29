import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('启动不许永久停在启动页', () => {
  it('骨架的强制拆除必须在挂载之外注册, 不能在 then/finally 里', () => {
    const src = stripComments(read('../main.tsx'));
    const removeAt = src.indexOf('app-skeleton');
    const mountAt = src.indexOf('Promise.all([waitForStartupGate()');
    expect(removeAt, 'main.tsx 里应当有骨架兜底拆除 (闸没空跑)').toBeGreaterThan(0);
    expect(mountAt, 'main.tsx 里应当有挂载闸门 (闸没空跑)').toBeGreaterThan(0);
    expect(
      removeAt,
      '兜底拆除排在 Promise.all 之后 = 它也要等主路径落地; 而卡死的场景就是主路径不落地',
    ).toBeLessThan(mountAt);
  });

  it('种 defaultAgentMode 的 IPC 必须带超时 —— invoke 卡住时不会 reject', () => {
    const src = stripComments(read('../main.tsx'));
    const at = src.indexOf('async function seedDefaultAgentMode');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, at + 900);
    expect(
      /Promise\.race/.test(body),
      'agentModeGetDefault 裸 await = 主进程一卡就永久停在启动页 (它只影响初始档位, 不值得挡挂载)',
    ).toBe(true);
  });

  it('签名自检有超时, 且不排在启动关键路径上', () => {
    const verify = stripComments(
      read('../../../../../../packages/platform/src/platform/codeSignVerify.ts'),
    );
    /* spawnSync 同步阻塞主进程, 没有 timeout 就是"可以卡到世界末日" */
    const winAt = verify.indexOf('function verifyWindows');
    expect(winAt).toBeGreaterThan(0);
    expect(
      /timeout:/.test(verify.slice(winAt, winAt + 1200)),
      'verifyWindows 的 spawnSync 必须带 timeout',
    ).toBe(true);

    const main = stripComments(read('../../electron/main.ts'));
    const callAt = main.indexOf('verifyCodeSign(binPath)');
    expect(callAt).toBeGreaterThan(0);
    /* 它的结果只写审计日志, 必须延后到窗口起来之后再跑 */
    const before = main.slice(Math.max(0, callAt - 700), callAt);
    expect(
      /setTimeout\(/.test(before),
      '签名自检要挪出启动关键路径 (光加超时也还是能冻住主线程整整 8 秒)',
    ).toBe(true);
  });

  it('启动阶段必须无条件落盘 —— console.log 在打包版 Windows 上进不了任何文件', () => {
    const lifecycle = stripComments(read('../../electron/bootstrap/appLifecycle.ts'));
    expect(lifecycle).toMatch(/beginStartupBreadcrumb\(/);
    /* runStartupPhase 是所有阶段的唯一入口, 面包屑必须在它里面 */
    const at = lifecycle.indexOf('const runStartupPhase');
    expect(at).toBeGreaterThan(0);
    expect(
      /breadcrumb\(/.test(lifecycle.slice(at, at + 1200)),
      'runStartupPhase 里没有 breadcrumb = 卡住之后依然查不到卡在哪',
    ).toBe(true);
    /* 面包屑本身不许依赖任何调试开关 */
    const crumb = stripComments(read('../../electron/bootstrap/startupBreadcrumb.ts'));
    expect(
      /CLI_DEBUG|NEOX_DIAG_LOG|enabled/.test(crumb),
      '面包屑一旦挂在调试开关上就等于没有 —— 出问题的用户默认是关的',
    ).toBe(false);
  });

  it('SQLite 打开这一步要有自己的阶段名 (它是最重且会同步忙等的一步)', () => {
    const lifecycle = stripComments(read('../../electron/bootstrap/appLifecycle.ts'));
    expect(
      lifecycle,
      'getDatabase() 裸调 = 日志上表现为 master_key_bootstrap done 之后一片安静',
    ).toMatch(/runStartupPhase\('sqlite_open'/);
  });
});
