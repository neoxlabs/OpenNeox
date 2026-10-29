import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { getModeHomeDir } from '@neoxlabs/core/runtime/modeHome.js';
import { sameWorkspace } from '../../shared/workspacePath.node.js';

/** 文件夹名里的任务名: 首条消息第一行, 去掉文件名不认的字符, 最多 20 个字。 */
export function taskFolderTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const clean = firstLine
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  /* 第一个分句够长就只要它 (「写一个 hello.md，内容是…」→「写一个 hello.md」), 文件夹名短而好认 */
  const clause = clean.split(/[，,。；;！!？?]/)[0]!.trim();
  const chars = Array.from(Array.from(clause).length >= 4 ? clause : clean);
  const cut = chars.slice(0, 20).join('').replace(/[\s，,。.、；;：！!？~～—-]+$/, '');
  return cut || '任务';
}

function localDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 同名已存在就加 (2) (3)…, 不和别的任务混在一个文件夹里。 */
export function pickFreeDir(parent: string, base: string, exists: (p: string) => boolean = existsSync): string {
  let dir = path.join(parent, base);
  for (let i = 2; exists(dir); i++) dir = path.join(parent, `${base} (${i})`);
  return dir;
}

export function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 这条消息该用的工作目录。不是 Work 本机会话 → null (调用方照旧用 payload.workspacePath)。
 * 建文件夹失败也返回 null: 落回工作根目录, 不挡发送。
 */
export function ensureWorkTaskDir(sessionId: string, prompt: string): string | null {
  try {
    const db = getDatabase();
    const s = db.getSession(sessionId) as { agentMode?: string | null; workspacePath?: string; parentSessionId?: string | null; taskDir?: string | null } | null;
    if (!s || s.agentMode !== 'work' || s.parentSessionId) return null;
    const home = getModeHomeDir('work');
    if (!sameWorkspace(s.workspacePath ?? '', home)) return null;

    const saved = s.taskDir ?? '';
    /* 已建好: 文件夹被用户删了就原地重建 (成品照旧落这里, 历史里的路径不失效) */
    if (saved && !/[\\/]$/.test(saved)) {
      if (!existsSync(saved)) mkdirSync(saved, { recursive: true });
      return saved;
    }
    /* 以分隔符结尾 = 在项目里新建的, 还没建任务文件夹; 项目必须在工作目录下 */
    const projectDir = saved ? saved.replace(/[\\/]+$/, '') : '';
    const parent = projectDir && isInsideDir(projectDir, home) ? projectDir : home;
    const dir = pickFreeDir(parent, `${localDate(new Date())} ${taskFolderTitle(prompt)}`);
    mkdirSync(dir, { recursive: true });
    db.setSessionTaskDir(sessionId, dir);
    void import('../mobile-bridge/index.js')
      .then((m) => m.notifyDesktopSessionsChanged())
      .catch(() => { /* 只是让侧栏 / 文件夹胶囊早点拿到, 下次刷新也会到 */ });
    return dir;
  } catch (err) {
    console.warn('[workTaskDir] 建任务文件夹失败, 本轮落工作根目录:', err);
    return null;
  }
}
