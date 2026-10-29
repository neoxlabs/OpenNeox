import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnvironmentInfo, __resetGitInfoCache, __expireGitInfoCache } from '../layers/index';

/**
 * Verify byte stability of the cached system prompt across environment changes.
 *
 * The fixtures use a dedicated git repository and a separate non-git directory.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-sysprompt-'));
const REPO = path.join(ROOT, 'repo');       /* 真 git 仓库 */
const NOGIT = path.join(ROOT, 'plain');     /* 从来不是 git 仓库 —— 不需要改名就能模拟"查不到" */
let gitAvailable = true;

beforeAll(() => {
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(NOGIT, { recursive: true });
  fs.writeFileSync(path.join(NOGIT, 'a.txt'), 'x');
  try {
    const g = (c: string) => execSync(`git ${c}`, { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
    g('init -q');
    fs.writeFileSync(path.join(REPO, 'tracked.txt'), 'hello');
    g('add tracked.txt');
    g('-c user.email=t@t -c user.name=t commit -q -m base');
  } catch { gitAvailable = false; }   /* 机器上没 git 就跳过依赖 git 的那两条 */
});
afterAll(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('system 段字节稳定性 (前缀缓存的生命线)', () => {
  test('工作区从 clean 变 dirty, 环境段必须一字不变', () => {
    if (!gitAvailable) return;
    __resetGitInfoCache();
    const clean = buildEnvironmentInfo(REPO, 'zh');
    expect(clean).toMatch(/Git 分支/);

    /* 只改工作区内容, 不 commit —— 提交历史变了本来就该变提示词, 那不是本条要守的东西。
     * 用 __expireGitInfoCache 而不是 reset: 前者才是生产里真实发生的事 (TTL 到点重查,
     * 查失败靠 sticky 兜住)。reset 会把兜底依据一起删掉, 高负载下 git log 一超时就假失败
     * —— 这条用例自己就是这么挂过一次的 (load 19.87)。 */
    fs.writeFileSync(path.join(REPO, 'tracked.txt'), 'changed');
    __expireGitInfoCache();
    expect(buildEnvironmentInfo(REPO, 'zh')).toBe(clean);
  });

  test('TTL 到点重查失败 → 提示词保持上一次的样子 (sticky)', () => {
    if (!gitAvailable) return;
    __resetGitInfoCache();
    const primed = buildEnvironmentInfo(REPO, 'zh');
    expect(primed).toMatch(/Git 分支/);
    /* Expired refreshes retain the previous value when git is slow or fails. */
    __expireGitInfoCache();
    expect(buildEnvironmentInfo(REPO, 'zh')).toBe(primed);
    __expireGitInfoCache();
    expect(buildEnvironmentInfo(REPO, 'zh')).toBe(primed);
  });

  test('非 git 目录不报错, 且不产生易变字样', () => {
    __resetGitInfoCache();
    const env = buildEnvironmentInfo(NOGIT, 'zh');
    expect(typeof env).toBe('string');
    expect(env).not.toMatch(/\((?:dirty|clean|unknown)\)/);
  });

  test('环境段不得包含 dirty / clean / unknown 这类干净度字样', () => {
    for (const lang of ['zh', 'en'] as const) {
      __resetGitInfoCache();
      expect(buildEnvironmentInfo(gitAvailable ? REPO : NOGIT, lang)).not.toMatch(/\((?:dirty|clean|unknown)\)/);
    }
  });

  test('环境段不得包含分钟级时刻 / 进程 id 这类每轮都变的东西', () => {
    __resetGitInfoCache();
    const env = buildEnvironmentInfo(gitAvailable ? REPO : NOGIT, 'zh');
    expect(env).not.toMatch(/\d{1,2}:\d{2}(:\d{2})?/);          /* 时:分 */
    expect(env).not.toMatch(new RegExp(`\\b${process.pid}\\b`));
    expect(env).toMatch(/\d{4}-\d{2}-\d{2}/);                   /* 天级日期允许 */
  });
});
