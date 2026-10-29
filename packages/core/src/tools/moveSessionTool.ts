import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';

export const SESSION_MOVE_MARKER = '__neox_session_move__';

/** 往上找 .git; 找不到就用给的目录本身 */
export function projectRootOf(dir: string): string {
  let cur = dir;
  for (let i = 0; i < 40; i++) {
    if (existsSync(resolve(cur, '.git'))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return dir;
}

export const moveSessionTool: Tool = {
  name: 'move_session_to_project',
  description: 'Move this conversation to the project it actually belongs to. Call it on your own (do not ask) when the work '
    + 'clearly lives in a different project folder than the current one — the user is talking about another repo, or '
    + 'everything you are reading and changing is under another directory. Not for a one-off look at another folder. '
    + 'The chat moves in the sidebar and later messages run in that folder; files are not moved.',
  capabilities: ['gui'],
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A folder in the target project (the project root is found by walking up to .git).' },
      reason: { type: 'string', description: 'One short line shown to the user, e.g. "this is about the billing-service repo".' },
    },
    required: ['path'],
  },
  function: async (args: any) => {
    const raw = String(args?.path ?? '').trim().replace(/^~(?=$|\/)/, homedir());
    const current = getWorkspaceRootFromContext();
    const abs = isAbsolute(raw) ? raw : resolve(current ?? process.cwd(), raw);
    if (!raw || !existsSync(abs) || !statSync(abs).isDirectory()) {
      return JSON.stringify({ ok: false, error: `not a folder: ${abs}` });
    }
    const root = projectRootOf(abs);
    /* 家目录 / 根目录不是项目 —— 挪过去等于把会话扔进一个装着一切的抽屉 */
    if (root === homedir() || root === '/' || /^[A-Za-z]:\\?$/.test(root)) {
      return JSON.stringify({ ok: false, error: `${root} is not a project folder — pass a folder inside the project` });
    }
    if (current && resolve(current) === resolve(root)) {
      return JSON.stringify({ ok: true, unchanged: true, path: root, note: 'Already in this project.' });
    }
    return JSON.stringify({
      [SESSION_MOVE_MARKER]: true,
      ok: true,
      path: root,
      from: current,
      reason: typeof args?.reason === 'string' ? args.reason.slice(0, 200) : undefined,
      note: `The conversation is moving to ${root}. From the next message the working directory is ${root}; `
        + 'for the rest of this turn use absolute paths under it.',
    });
  },
};
