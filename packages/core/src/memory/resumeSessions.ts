import { execFile } from 'child_process';
import path from 'path';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';

export interface ResumeSessionInfo {
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
  itemCount: number;
  workspacePath: string;
  /** workspace 目录名 (basename), 列表里显示用 */
  workspaceName: string;
  /** 当前 git 分支, 拿不到为空串 */
  branch: string;
  /** 首条用户消息摘要 (单行, 已截断) */
  summary: string;
}

/** 从 item_data JSON 里尽量抠出可读文本 */
function extractText(itemData: string): { role: string; text: string } | null {
  try {
    const parsed = JSON.parse(itemData);
    const role: string = parsed?.data?.role || parsed?.role || parsed?.type || 'unknown';
    const content = parsed?.data?.content ?? parsed?.content ?? parsed?.data?.text ?? parsed?.text;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // content blocks: [{type:'text', text:'...'}, ...]
      text = content
        .map((b: any) => (typeof b === 'string' ? b : b?.text ?? ''))
        .join(' ');
    }
    return { role, text: text.trim() };
  } catch {
    return null;
  }
}

/** 单行化 + 截断 (去换行/多空格, 最长 maxLen) */
function oneLine(s: string, maxLen = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > maxLen ? flat.slice(0, maxLen - 1) + '…' : flat;
}

/** 取某会话的首条用户消息作摘要 */
function firstUserSummary(sessionId: string): string {
  try {
    const raw = getDatabase().getRawDb();
    const rows = raw
      .prepare('SELECT item_data FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT 8')
      .all(sessionId) as Array<{ item_data: string }>;
    for (const r of rows) {
      const parsed = extractText(r.item_data);
      if (parsed && parsed.role === 'user' && parsed.text) {
        return oneLine(parsed.text);
      }
    }
    // 没找到明确 user 角色 → 退而取第一条有文本的
    for (const r of rows) {
      const parsed = extractText(r.item_data);
      if (parsed && parsed.text) return oneLine(parsed.text);
    }
  } catch { /* best-effort */ }
  return '';
}

/** 按 workspace 路径取 git 分支 (去重缓存, 失败给空串) */
function gitBranch(workspacePath: string): Promise<string> {
  return new Promise((resolve) => {
    if (!workspacePath) return resolve('');
    execFile(
      'git',
      ['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 2000, windowsHide: true },
      (err, stdout) => resolve(err ? '' : stdout.trim()),
    );
  });
}

/**
 * 拉取 resume 选择器要展示的富会话列表 (已按 updatedAt DESC)。
 * @param limit 最多返回多少个 (默认 50)
 */
export async function getResumeSessions(limit = 50): Promise<ResumeSessionInfo[]> {
  const db = getDatabase();
  const rows = (db.listSessions() as any[]).slice(0, limit);

  // 按唯一 workspace 去重跑 git 分支 (通常就几个路径)
  const uniqueWorkspaces = [...new Set(rows.map((r) => r.workspacePath).filter(Boolean))] as string[];
  const branchByWorkspace = new Map<string, string>();
  await Promise.all(
    uniqueWorkspaces.map(async (wp) => branchByWorkspace.set(wp, await gitBranch(wp))),
  );

  return rows.map((row) => {
    const workspacePath: string = row.workspacePath || '';
    return {
      sessionId: row.id,
      createdAt: new Date(row.createdAt ?? row.created_at),
      updatedAt: new Date(row.updatedAt ?? row.updated_at),
      itemCount: db.getMessageCount(row.id),
      workspacePath,
      workspaceName: workspacePath ? path.basename(workspacePath) : '',
      branch: branchByWorkspace.get(workspacePath) || '',
      summary: firstUserSummary(row.id),
    };
  });
}
