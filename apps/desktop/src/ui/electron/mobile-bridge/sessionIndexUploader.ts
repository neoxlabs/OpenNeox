import * as crypto from 'node:crypto';

import { bridgeLog } from './log.js';
import { listPairedMobiles, getDeviceId } from './deviceStore.js';

/** 合并窗口 —— agent 跑起来时 updatedAt 频繁变, 不合并会变成上传风暴 */
const DEBOUNCE_MS = 8_000;
/** 一个请求最多带多少条 —— 跟服务端 MAX_ENTRIES_PER_PUT 对齐, 超了要自己分批 */
const MAX_ENTRIES_PER_REQUEST = 200;
/** 一轮最多处理多少个会话 (再乘配对手机数才是条目数) */
const MAX_SESSIONS_PER_ROUND = 200;
/** 只镜像最近这么多个顶层会话 —— 手机上翻不到那么远, 传全量纯属浪费 */
const MIRROR_LIMIT = 100;

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  workspaceName: string;
  kind: string;
  parentSessionId: string | null;
}

let timer: NodeJS.Timeout | null = null;
let disposed = false;
const lastUploaded = new Map<string, string>();

export function scheduleSessionIndexUpload(reason: string): void {
  if (disposed) return;
  if (timer) return;                      // 窗口内已经排过了
  timer = setTimeout(() => {
    timer = null;
    void uploadNow(reason).catch((e) => {
      bridgeLog('session-index', `上传失败: ${e?.message ?? e}`);
      // eslint-disable-next-line no-console
      console.warn(`[session-index] 上传失败: ${e?.message ?? e}`);
    });
  }, DEBOUNCE_MS);
  timer.unref?.();
}

export function disposeSessionIndexUploader(): void {
  disposed = true;
  if (timer) { clearTimeout(timer); timer = null; }
  lastUploaded.clear();
}

export function isOrphanSubAgentPlaceholder(s: { name?: string | null; parentSessionId?: string | null; modelId?: string | null }): boolean {
  return !s.parentSessionId && !s.modelId && String(s.name ?? '').startsWith('子 Agent ');
}

/** 会话列表 → 只取镜像需要的那几个字段 (跟 wsServer.listSessions 同一份数据源) */
async function collectSessions(): Promise<SessionSummary[]> {
  const mod = await import('@neoxlabs/platform/platform/database.js');
  const all: any[] = mod.getDatabase().listSessions();
  /* mirror_policy=never 的会话用户明确说过不要同步, 一条都不能传 */
  const usable = all.filter((s: any) => (s.mirrorPolicy ?? 'always') !== 'never' && !isOrphanSubAgentPlaceholder(s));
  const roots = usable.filter((s: any) => !s.parentSessionId).slice(0, MIRROR_LIMIT);
  const rootIds = new Set(roots.map((s: any) => s.id));
  const children = usable.filter((s: any) => s.parentSessionId && rootIds.has(s.parentSessionId));
  return [...roots, ...children].slice(0, MAX_SESSIONS_PER_ROUND).map((s: any) => ({
    id: String(s.id),
    title: String(s.name ?? s.id),
    updatedAt: Number(s.updatedAt ?? 0),
    workspaceName: s.workspacePath
      ? String(s.workspacePath).split(/[/\\]/).filter(Boolean).pop() ?? ''
      : '',
    kind: s.kind === 'image' ? 'image' : 'chat',
    parentSessionId: s.parentSessionId ?? null,
  }));
}

function encryptForMobile(key: Buffer, payload: unknown): { nonce: string; blob: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(payload), 'utf-8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  /* tag 拼在密文尾部 —— 手机端按同样约定切开 (跟 relay envelope 一致) */
  return {
    nonce: iv.toString('base64'),
    blob: Buffer.concat([ct, tag]).toString('base64'),
  };
}

let lastSkipReason = '';
function noteSkip(why: string): void {
  if (lastSkipReason === why) return;
  lastSkipReason = why;
  // eslint-disable-next-line no-console
  console.log(`[session-index] 跳过上传: ${why}`);
}

async function uploadNow(reason: string): Promise<void> {
  if (disposed) return;

  const { readDesktopAuthTokens } = await import('../ipc/authHandlers.js');
  const tok = await readDesktopAuthTokens();
  const userId = tok?.user?.id ?? null;
  if (!tok?.accessToken || !userId) { noteSkip('未登录'); return; }

  /* 只发给**当前登录用户**配对的手机 —— 别的账号配过的手机不该拿到这个账号的会话 */
  const owned = listPairedMobiles({ currentUserId: userId });
  const mobiles = owned.filter((m) => !!m.relay_session_key_b64);
  if (mobiles.length === 0) {
    noteSkip(`没有可用的配对手机 (本账号配对 ${owned.length} 台, 其中带 relay key 0 台)`);
    return;
  }

  const sessions = await collectSessions();
  if (sessions.length === 0) { noteSkip('没有可镜像的会话'); return; }
  lastSkipReason = '';

  const entries: Array<Record<string, unknown>> = [];
  for (const s of sessions) {
    /* 指纹里放所有会进密文的字段: 变了才重传。不放 nonce —— 每次加密 nonce 都不同,
     * 拿它算指纹等于每次都"变了", 节流直接失效。 */
    const fingerprint = `${s.title}|${s.updatedAt}|${s.workspaceName}|${s.kind}|${s.parentSessionId ?? ''}`;
    if (lastUploaded.get(s.id) === fingerprint) continue;

    for (const m of mobiles) {
      const key = Buffer.from(m.relay_session_key_b64!, 'base64');
      if (key.length !== 32) continue;
      const { nonce, blob } = encryptForMobile(key, {
        title: s.title,
        workspace_name: s.workspaceName,
        kind: s.kind,
        parent_session_id: s.parentSessionId,
        updated_at: s.updatedAt,
      });
      entries.push({
        mobile_device_id: m.device_id,
        session_id: s.id,
        nonce,
        blob,
        updated_at: s.updatedAt,
      });
    }
    lastUploaded.set(s.id, fingerprint);
  }
  if (entries.length === 0) return;

  const { resolveCloudEndpoints } = await import('../services/cloudEndpoints.js');
  const base = resolveCloudEndpoints().api.replace(/\/+$/, '');

  for (let i = 0; i < entries.length; i += MAX_ENTRIES_PER_REQUEST) {
    const chunk = entries.slice(i, i + MAX_ENTRIES_PER_REQUEST);
    const resp = await fetch(`${base}/api/v1/session-index`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok.accessToken}`,
      },
      body: JSON.stringify({ device_id: getDeviceId(), entries: chunk }),
    });
    if (!resp.ok) {
      /* 失败就把指纹全撤回, 否则这批改动"看起来没变", 永远不会再传 */
      for (const s of sessions) lastUploaded.delete(s.id);
      throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    }
  }
  bridgeLog('session-index', `已上传 ${entries.length} 条 (${reason})`);
  // eslint-disable-next-line no-console
  console.log(`[session-index] 已上传 ${entries.length} 条 (${reason})`);
}
