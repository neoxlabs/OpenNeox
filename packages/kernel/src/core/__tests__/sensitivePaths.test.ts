/**
 * 敏感路径识别 (SEC1/SEC2 →  改为审批信号)。
 *
 * 命中的路径在 toolRiskEvaluator 里记成 critical `path:sensitive`, 走审批而不是工具层硬拒。
 * 可执行配置位置 (hook / git 钩子与 config) 防提权, 凭据存储防外泄。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { isSensitivePath } from '../sensitivePaths.js';

const W = '/Users/someone/work/repo';

describe('hook 配置 / git 钩子', () => {
  it('工作区 .neox/settings.json 命中 —— 它就是 hook 的注入点', () => {
    expect(isSensitivePath(path.join(W, '.neox/settings.json'))).toBe(true);
    expect(isSensitivePath(path.join(W, '.neox/settings.local.json'))).toBe(true);
  });

  it('工作区 .neox/mcp.json / config.json 命中', () => {
    expect(isSensitivePath(path.join(W, '.neox/mcp.json'))).toBe(true);
    expect(isSensitivePath(path.join(W, '.neox/config.json'))).toBe(true);
  });

  it('工作区 .neox/hooks/ 下任何文件都命中', () => {
    expect(isSensitivePath(path.join(W, '.neox/hooks/pre-tool-call.sh'))).toBe(true);
    expect(isSensitivePath(path.join(W, '.neox/hooks/nested/x.py'))).toBe(true);
  });

  it('.git/hooks/ 和 .git/config 命中 —— git 一动就执行 / core.hooksPath 能 RCE', () => {
    expect(isSensitivePath(path.join(W, '.git/hooks/post-commit'))).toBe(true);
    expect(isSensitivePath(path.join(W, '.git/config'))).toBe(true);
    expect(isSensitivePath(path.join(W, '.git/info/attributes'))).toBe(true);
  });

  it('子模块的 .git/modules/<name>/{config,hooks} 是同一件事', () => {
    expect(isSensitivePath(path.join(W, '.git/modules/vendor/config'))).toBe(true);
    expect(isSensitivePath(path.join(W, '.git/modules/vendor/hooks/pre-push'))).toBe(true);
  });

  it('大小写换个写法照样命中 (macOS/Windows 文件系统大小写不敏感)', () => {
    expect(isSensitivePath(path.join(W, '.GIT/hooks/post-commit'))).toBe(true);
    expect(isSensitivePath(path.join(W, '.Neox/Settings.json'))).toBe(true);
  });

  it('嵌套仓库 / 任意深度也命中 —— 不是只看工作区根那一层', () => {
    expect(isSensitivePath(path.join(W, 'vendor/other-repo/.git/hooks/pre-commit'))).toBe(true);
    expect(isSensitivePath(path.join(W, 'sub/proj/.neox/settings.json'))).toBe(true);
  });

  it('**只收这几个位置, 不收整个 .git / .neox 目录**', () => {
    expect(isSensitivePath(path.join(W, '.neox/knowledge/card.md'))).toBe(false);
    expect(isSensitivePath(path.join(W, '.neox/plans/p1.md'))).toBe(false);
    expect(isSensitivePath(path.join(W, '.neox/skills/foo/SKILL.md'))).toBe(false);
    expect(isSensitivePath(path.join(W, '.git/HEAD'))).toBe(false);
    expect(isSensitivePath(path.join(W, '.git/refs/heads/main'))).toBe(false);
  });

  it('名字长得像但不是的不能误伤', () => {
    expect(isSensitivePath(path.join(W, 'src/.gitignore'))).toBe(false);
    expect(isSensitivePath(path.join(W, 'docs/git/config.md'))).toBe(false);
    expect(isSensitivePath(path.join(W, 'src/neox/settings.json'))).toBe(false);
    /* .neox 下更深一层的 settings.json 不是 hook 配置 */
    expect(isSensitivePath(path.join(W, '.neox/foo/settings.json'))).toBe(false);
  });
});

describe('用户级 ~/.neox', () => {
  it('hook 配置 / 凭据文件仍然命中', () => {
    expect(isSensitivePath(path.join(os.homedir(), '.neox/settings.json'))).toBe(true);
    expect(isSensitivePath(path.join(os.homedir(), '.neox/config.json'))).toBe(true);
    expect(isSensitivePath(path.join(os.homedir(), '.neox/auth.enc'))).toBe(true);
  });

  it('整个目录不再算敏感 —— 创建技能要写 ~/.neox/skills/<id>/SKILL.md', () => {
    expect(isSensitivePath(path.join(os.homedir(), '.neox/skills/x/SKILL.md'))).toBe(false);
  });
});

describe('凭据存储', () => {
  it('~/.ssh / ~/.aws 命中', () => {
    expect(isSensitivePath(path.join(os.homedir(), '.ssh/config'))).toBe(true);
    expect(isSensitivePath(path.join(os.homedir(), '.aws/credentials'))).toBe(true);
  });
});
