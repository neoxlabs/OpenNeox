import { dispatchHint } from '../../components/notifyEvents';

export const SESSION_MIME = 'application/x-neox-session';

type NeoxApi = Record<string, any>;
const api = (): NeoxApi | undefined => (window as unknown as { neox?: NeoxApi }).neox;

/** 拖着的东西能不能放到这个工具上 (dragover 时只能看 types, 看不到内容) */
export function acceptsDrop(toolId: string, types: readonly string[]): boolean {
  const hasSession = types.includes(SESSION_MIME);
  const hasFiles = types.includes('Files');
  if (toolId === 'knowledge') return hasSession || hasFiles;
  if (toolId === 'image') return hasFiles;
  return false;
}

/** 悬停时名字换成这句, 告诉用户松手会发生什么 */
export function dropHint(toolId: string, types: readonly string[], zh: boolean): string {
  if (toolId === 'knowledge') return types.includes(SESSION_MIME) ? (zh ? '存成知识' : 'Remember') : (zh ? '收进来' : 'Add');
  if (toolId === 'image') return zh ? '拿去改图' : 'Edit';
  return '';
}

export interface DropContext {
  zh: boolean;
  selectSession?: (id: string) => void;
  openImageStudio?: () => void;
}

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handleDrop(toolId: string, dt: DataTransfer, ctx: DropContext): Promise<void> {
  const { zh } = ctx;
  const sessionId = dt.getData(SESSION_MIME);
  const files = Array.from(dt.files ?? []);

  if (toolId === 'knowledge' && sessionId) {
    if (!ctx.selectSession) return;
    ctx.selectSession(sessionId);
    /* 等会话切过去、输入框挂好再填 (composer 只响应露在外面的那个) */
    await later(450);
    const text = zh
      ? '把这次对话里值得长期记住的结论、做法和踩过的坑整理成知识卡片, 用 knowledge_add 存进知识库。'
      : 'Distill the conclusions, approaches and pitfalls from this conversation worth remembering into knowledge cards, and save them with knowledge_add.';
    window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, focus: true } }));
    dispatchHint(zh ? '已备好, 回车就整理进知识库' : 'Ready — press Enter to save it to knowledge', 'info');
    return;
  }

  if (toolId === 'knowledge' && files.length > 0) {
    const a = api();
    const docs = files
      .map((f) => { try { return a?.getPathForFile?.(f) as string | undefined; } catch { return undefined; } })
      .filter((p): p is string => !!p && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)))
      .map((p) => ({ path: p, collection: 'default' }));
    if (docs.length === 0) {
      dispatchHint(zh ? '拿不到文件路径 — 请从访达/资源管理器拖本地文件' : 'Could not resolve file paths — drag local files', 'warning');
      return;
    }
    const r = await a?.knowledgeAddDocs?.(docs).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (r?.ok) {
      dispatchHint(zh ? `已收进知识库 ${r.added} 个${r.skipped ? ` (${r.skipped} 个已在)` : ''}` : `Added ${r.added} to knowledge${r.skipped ? ` (${r.skipped} already there)` : ''}`, 'success');
    } else {
      dispatchHint((zh ? '没收进去: ' : 'Not added: ') + (r?.error ?? ''), 'warning');
    }
    return;
  }

  if (toolId === 'image' && files.length > 0) {
    const img = files.find((f) => f.type.startsWith('image/'));
    if (!img) { dispatchHint(zh ? '只认图片文件' : 'Images only', 'warning'); return; }
    ctx.openImageStudio?.();
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(img);
    });
    await later(600);
    window.dispatchEvent(new CustomEvent('neox:image-attach', { detail: { dataUrl, name: img.name } }));
  }
}

/* ── 状态 ── */

export interface DockBadge { count?: number; alert?: boolean; title?: string }

export interface McpRow { id: string; name: string; scope: string; enabled: boolean; ok: boolean | null; tools: number }
export interface SkillRow { id: string; name: string; description: string }

export async function loadMcp(): Promise<{ on: boolean; rows: McpRow[] }> {
  const a = api();
  if (typeof a?.mcpList !== 'function') return { on: false, rows: [] };
  const [list, on] = await Promise.all([
    a.mcpList().catch(() => []),
    a.mcpGetEnabled?.().catch(() => false) ?? false,
  ]);
  const rows: McpRow[] = await Promise.all((Array.isArray(list) ? list : []).map(async (s: any) => {
    const enabled = s.enabled !== false;
    let ok: boolean | null = null;
    let tools = 0;
    if (on && enabled) {
      try {
        const r = await a.mcpGetTools?.(s.id);
        const t = Array.isArray(r) ? r : (r?.tools ?? []);
        tools = Array.isArray(t) ? t.length : 0;
        ok = Array.isArray(r) ? true : !!r?.success;
      } catch { ok = false; }
    }
    return { id: s.id, name: s.name || s.id, scope: s.scope ?? 'user', enabled, ok, tools };
  }));
  return { on: !!on, rows };
}

export async function setMcpServerEnabled(row: McpRow, enabled: boolean): Promise<boolean> {
  const r = await api()?.mcpUpdate?.(row.scope, row.id, { enabled }).catch(() => null);
  return !!r?.success;
}

export async function setMcpAllEnabled(enabled: boolean): Promise<void> {
  await api()?.mcpSetEnabled?.(enabled).catch(() => undefined);
}

export async function loadSkills(): Promise<SkillRow[]> {
  const list = await api()?.skillsList?.({ userInvocable: true }).catch(() => []);
  return (Array.isArray(list) ? list : []).map((s: any) => ({
    id: s.id,
    name: s.metadata?.name || s.id,
    description: s.metadata?.description || '',
  }));
}

export interface KbCardRow { id: string; title: string; description: string; always: boolean; draft: boolean }

export async function loadKnowledge(): Promise<KbCardRow[]> {
  const r = await api()?.knowledgeListCards?.().catch(() => null);
  const cards: any[] = r?.ok && Array.isArray(r.cards) ? r.cards : [];
  return cards
    .sort((x, y) => String(y.updated ?? '').localeCompare(String(x.updated ?? '')))
    .map((c) => ({
      id: c.id,
      title: c.title || c.id,
      description: c.description || '',
      always: c.always === true,
      draft: c.trust != null && c.trust !== 'verified',
    }));
}

export function mcpBadge(on: boolean, rows: McpRow[], zh: boolean): DockBadge | undefined {
  if (!on) return undefined;
  const live = rows.filter((r) => r.enabled && r.ok).length;
  const broken = rows.filter((r) => r.enabled && r.ok === false);
  if (live === 0 && broken.length === 0) return undefined;
  return {
    count: live || undefined,
    alert: broken.length > 0,
    title: broken.length > 0
      ? (zh ? `${broken.map((b) => b.name).join('、')} 连不上` : `${broken.map((b) => b.name).join(', ')} not connected`)
      : (zh ? `已连上 ${live} 个` : `${live} connected`),
  };
}
