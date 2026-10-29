import { isGitCoAuthorEnabled } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';

export const NEOX_COMMIT_EMAIL = 'github@neox-dev.com';
export const NEOX_COMMIT_NAME = 'Neox';
export const NEOX_COMMIT_AUTHOR = `${NEOX_COMMIT_NAME} <${NEOX_COMMIT_EMAIL}>`;

/* 旧名字保留 —— 已有调用方/测试按这两个引用 */
export const NEOX_CO_AUTHOR_EMAIL = NEOX_COMMIT_EMAIL;
export const NEOX_CO_AUTHOR_TRAILER = `Co-Authored-By: ${NEOX_COMMIT_AUTHOR}`;

/** `git commit` 的 --author 参数 —— 进 Contributors 靠的是这一层; 开关关着返回空 */
export function neoxAuthorArgs(): string[] {
  if (!isGitCoAuthorEnabled()) return [];
  return [`--author=${NEOX_COMMIT_AUTHOR}`];
}

/** 提交信息末尾补上署名; 开关关着 / 已经带了就原样返回 */
export function withNeoxCoAuthor(message: string): string {
  if (!isGitCoAuthorEnabled()) return message;
  if (message.toLowerCase().includes(`<${NEOX_CO_AUTHOR_EMAIL}>`)) return message;
  /* trailer 必须跟正文隔一个空行, 且在最后一段 —— 否则 git / GitHub 不认它是 trailer。
   * 最后一段本来就是 trailer 块 (比如已有别的 Co-Authored-By) 时接在它后面, 不另起一段。 */
  const body = message.replace(/\s+$/, '');
  const lastPara = body.split(/\n\s*\n/).pop() ?? '';
  const lastIsTrailers = lastPara.split('\n').every((l) => /^[A-Za-z-]+: .+/.test(l.trim()));
  return lastIsTrailers && body.includes('\n\n')
    ? `${body}\n${NEOX_CO_AUTHOR_TRAILER}`
    : `${body}\n\n${NEOX_CO_AUTHOR_TRAILER}`;
}

/** system prompt 段: 模型直接在 shell 里提交时也带上。开关关着返回 '' */
export function getGitCoAuthorPromptSection(): string {
  if (!isGitCoAuthorEnabled()) return '';
  return [
    '<git_commit_attribution>',
    'When you create a git commit yourself (e.g. `git commit` in the shell), commit with this author so the commit is attributed to Neox:',
    `git commit --author="${NEOX_COMMIT_AUTHOR}" -m "..."`,
    'and end the commit message with this trailer, separated from the body by a blank line:',
    NEOX_CO_AUTHOR_TRAILER,
    'The git_commit tool does both automatically. Do not do it when the user writes the commit message themselves or asks you not to.',
    '</git_commit_attribution>',
  ].join('\n');
}
