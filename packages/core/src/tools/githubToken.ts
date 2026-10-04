/**
 * 本机 GitHub token —— web_fetch 打 api.github.com 和 GitHub channel 回评论/推分支共用一处。
 * 来源顺序: GITHUB_TOKEN / GH_TOKEN 环境变量 → `gh auth token`。不落盘、不进配置。
 */
import { execFileSync } from 'node:child_process';

let cachedGithubToken: string | null | undefined;

export function resolveGithubToken(): string | null {
  if (cachedGithubToken !== undefined) return cachedGithubToken;
  const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (fromEnv) { cachedGithubToken = fromEnv; return fromEnv; }
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    cachedGithubToken = out || null;
  } catch {
    cachedGithubToken = null;
  }
  return cachedGithubToken;
}

/** 测试 / 用户在 gh 里换号之后用: 下次再问就重新解析 */
export function resetGithubTokenCache(): void {
  cachedGithubToken = undefined;
}
