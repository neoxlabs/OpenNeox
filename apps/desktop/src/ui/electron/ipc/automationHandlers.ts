import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const FILE = join('.neox', 'scheduled_tasks.json');

export interface AutomationJob {
  root: string;
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt?: number;
  lastFiredAt?: number;
}

async function candidateRoots(extra: unknown): Promise<string[]> {
  const { getNeoxUserRoot } = await import('@neoxlabs/core/runtime/modeHome.js');
  const base = getNeoxUserRoot();
  const roots = new Set<string>([join(base, 'Work'), join(base, 'Code')]);
  try {
    for (const d of await fs.readdir(join(base, 'Code'), { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) roots.add(join(base, 'Code', d.name));
    }
  } catch { /* 没有 Code 目录 */ }
  if (Array.isArray(extra)) for (const r of extra) if (typeof r === 'string' && r.trim()) roots.add(resolve(r));
  return [...roots];
}

async function readJobs(root: string): Promise<Record<string, unknown>[] | null> {
  try {
    const raw = JSON.parse(await fs.readFile(join(root, FILE), 'utf8'));
    return Array.isArray(raw) ? raw : null;
  } catch { return null; }
}

export function registerAutomationIpcHandlers(): void {
  ipcMain.handle('automations:list', async (_e, extraRoots?: unknown) => {
    const out: AutomationJob[] = [];
    for (const root of await candidateRoots(extraRoots)) {
      for (const j of (await readJobs(root)) ?? []) {
        if (typeof j.id !== 'string' || typeof j.cron !== 'string') continue;
        out.push({
          root, id: j.id, cron: j.cron, prompt: String(j.prompt ?? ''), recurring: j.recurring !== false,
          createdAt: typeof j.createdAt === 'number' ? j.createdAt : undefined,
          lastFiredAt: typeof j.lastFiredAt === 'number' ? j.lastFiredAt : undefined,
        });
      }
    }
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  });

  ipcMain.handle('automations:delete', async (_e, root: unknown, id: unknown) => {
    if (typeof root !== 'string' || typeof id !== 'string') return { ok: false, error: 'bad args' };
    /* 只改扫得到的目录或家目录下的工作区里那一个 scheduled_tasks.json, 不接受任意路径 */
    const target = resolve(root);
    const known = (await candidateRoots([])).includes(target) || target.startsWith(homedir() + '/');
    if (!known) return { ok: false, error: 'unknown root' };
    const jobs = await readJobs(target);
    if (!jobs) return { ok: false, error: 'not found' };
    const kept = jobs.filter((j) => j.id !== id);
    if (kept.length === jobs.length) return { ok: false, error: 'not found' };
    await fs.writeFile(join(target, FILE), JSON.stringify(kept, null, 2));
    return { ok: true };
  });
}
