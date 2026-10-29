/**
 * documentParseClient — 调 NeoxCloud /api/v1/document/parse 的客户端封装.
 *
 * 用户在 Composer 拖拽 PDF/Word/Excel/CSV → 这里上传 → 拿 markdown →
 * 上层 (TimelineComposer.intake) 把 markdown 塞进 Attachment.data, 当 type='file'
 * 送给 agent, 由 agentRuntimeHost.extractDocumentTexts 拼到 user message.
 *
 * 为什么不本地解析?
 *   · 不让客户端装 pdfjs+mammoth+xlsx ~1.5MB
 *   · 让 LLM 跑 Python 脚本 → 大量用户没 Python 环境
 *   · 跟 Claude/OpenAI Files API 同范式: 云端集中解析
 *   · NeoxCloud 升级解析器 (今天 pdf-parse, 明天阿里 Docmind), 客户端无感
 */

/* 云端解析要登录凭据, 走发行版能力钩子 —— 没有账号体系的构建里恒为未登录, 只剩本地解析 */
import { getEditionHook } from '../modules/shell/editionHooks';
import { parseDocumentLocally, isLocallyParseable, type LocalParseResult } from './documentParsers/index';
import { getGlobalLanguage } from '../hooks/useI18n';


export type DocumentParseMode = 'local' | 'cloud';
/** 老位置 —— 只用于一次性迁移, 迁完就删。新值一律落 config.experimental.documentParseMode。 */
const LEGACY_MODE_STORAGE_KEY = 'neox.documentParseMode';
const DEFAULT_MODE: DocumentParseMode = 'local';

let cachedMode: DocumentParseMode | null = null;
let loadInflight: Promise<DocumentParseMode> | null = null;

async function fetchMode(): Promise<DocumentParseMode> {
  const api = (window as any)?.neox;
  const cfg = await api?.experimentalGetConfig?.();
  const fromConfig = cfg?.documentParseMode;
  if (fromConfig === 'cloud' || fromConfig === 'local') return fromConfig;
  return DEFAULT_MODE;
}

/** 老 localStorage 值搬进 config —— 用户之前切过云端的话不该被悄悄退回本地。
 *
 *  删老键必须**确认新位置真的收下了**再删: 主进程是独立构建, 旧版本的
 *  experimental:set-config 不认识 documentParseMode, 写进去会被丢掉。
 *  无条件删 = 值直接没了。没迁成就留着, 下次启动再试, 期间照样按老值工作。 */
async function migrateLegacyMode(): Promise<DocumentParseMode | null> {
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(LEGACY_MODE_STORAGE_KEY); } catch { return null; }
  if (legacy !== 'cloud' && legacy !== 'local') return null;
  try {
    await (window as any)?.neox?.experimentalSetConfig?.({ documentParseMode: legacy });
    if (await fetchMode() === legacy) localStorage.removeItem(LEGACY_MODE_STORAGE_KEY);
  } catch { /* 写失败: 保留老键, 下次再迁 */ }
  return legacy;
}

export async function ensureDocumentParseModeLoaded(): Promise<DocumentParseMode> {
  if (cachedMode) return cachedMode;
  if (loadInflight) return loadInflight;
  loadInflight = (async () => {
    const migrated = await migrateLegacyMode();
    cachedMode = migrated ?? await fetchMode();
    return cachedMode;
  })().finally(() => { loadInflight = null; });
  return loadInflight;
}

/** 同步读 —— 返回缓存; 没加载过时返回默认值并触发一次后台加载。 */
export function getDocumentParseMode(): DocumentParseMode {
  if (!cachedMode) { void ensureDocumentParseModeLoaded(); return DEFAULT_MODE; }
  return cachedMode;
}

export function setDocumentParseMode(mode: DocumentParseMode): void {
  cachedMode = mode;
  void (window as any)?.neox?.experimentalSetConfig?.({ documentParseMode: mode })
    ?.catch?.((err: unknown) => console.warn('[documentParseClient] setDocumentParseMode failed:', err));
}

export interface DocumentParseResult {
  /** v2: sha256 hex (64 chars) — 客户端用此 ID 写本地缓存, agent 工具 read_document(fileId) 读 */
  fileId: string;
  markdown: string;
  /** 前 200 字符摘要 — 给 attachment 卡 preview 用 */
  summary: string;
  metadata: {
    pages?: number;
    sheets?: number;
    chars: number;
    channel: string;       // 'pdf-parse' / 'mammoth' / 'xlsx' / 'plain'
    truncated: boolean;
    durationMs: number;
    cached?: boolean;
  };
}

export interface DocumentParseError extends Error {
  status?: number;
  code?: 'NOT_AUTHENTICATED' | 'UNSUPPORTED' | 'PARSE_FAILED' | 'TOO_LARGE' | 'RATE_LIMITED' | 'NETWORK' | 'UNKNOWN';
}

function makeError(message: string, code: DocumentParseError['code'], status?: number): DocumentParseError {
  const err = new Error(message) as DocumentParseError;
  err.code = code;
  err.status = status;
  return err;
}

/**
 * 上传文档到 NeoxCloud 解析. 失败抛 DocumentParseError, 调用方负责 toast.
 *
 * 进度回调: 暂未实现 (multipart upload 进度需要 XMLHttpRequest 而非 fetch, 后续 V2).
 */
export async function parseDocumentViaCloud(file: File): Promise<DocumentParseResult> {
  if (!getEditionHook('isAuthenticated')()) {
    throw makeError(
      getGlobalLanguage() === 'zh'
        ? '请先登录后再使用文档解析'
        : 'Please sign in to use document parsing',
      'NOT_AUTHENTICATED',
      401,
    );
  }

  const form = new FormData();
  form.append('file', file, file.name);

  let res: Response;
  try {
    res = await getEditionHook('fetchWithAuth')('/api/v1/document/parse', {
      method: 'POST',
      body: form,
      /* 注意不要手动设 Content-Type — fetch 会自动加 boundary, 设了反而坏掉 multipart 解析 */
    });
  } catch (err: any) {
    throw makeError(
      getGlobalLanguage() === 'zh'
        ? `网络错误: ${err?.message || String(err)}`
        : `Network error: ${err?.message || String(err)}`,
      'NETWORK',
    );
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = String(body.error);
    } catch {/* 非 JSON 响应忽略 */}

    const code: DocumentParseError['code'] =
      res.status === 401 ? 'NOT_AUTHENTICATED' :
      res.status === 413 ? 'TOO_LARGE' :
      res.status === 429 ? 'RATE_LIMITED' :
      detail.toLowerCase().includes('unsupported') ? 'UNSUPPORTED' :
      detail.toLowerCase().includes('parse failed') ? 'PARSE_FAILED' :
      'UNKNOWN';
    throw makeError(detail, code, res.status);
  }

  const result = await res.json();
  if (!result?.markdown || !result?.metadata || !result?.fileId) {
    throw makeError(
      getGlobalLanguage() === 'zh'
        ? 'NeoxCloud 返回格式异常 (缺 fileId/markdown/metadata)'
        : 'Unexpected NeoxCloud response (missing fileId/markdown/metadata)',
      'UNKNOWN',
      res.status,
    );
  }

  /* v2 (Files API 范式): 拿到 markdown 后写本地缓存, 后续 agent read_document(fileId)
   * 走本地 fs 不走云. 缓存写失败不致命 (用户依然能用本次结果). */
  try {
    const api: any = (window as any).neox;
    if (api?.documentCacheWrite) {
      const writeResult = await api.documentCacheWrite(result.fileId, result.markdown);
      if (!writeResult?.success) {
        console.warn('[documentParseClient] cache write failed:', writeResult?.error);
      }
    }
  } catch (err) {
    console.warn('[documentParseClient] cache write threw:', err);
  }

  return result as DocumentParseResult;
}

/** 判定文件是否为"需要走文档解析链路"的类型 (PDF/Word/Excel/CSV/PPT).
 * 其他 (image / 纯文本) 走客户端现有 intake 分支, 不需要走解析链路. */
export function isParseableDocument(file: File): boolean {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  return ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'tsv', 'pptx', 'ppt'].includes(ext);
}

/** 统一入口 — 按用户配置的 mode (local / cloud) 分发到对应 parser.
 *
 * 行为:
 *   · local + 本地能解析 → 客户端 parser (pdfjs/mammoth/xlsx)
 *   · local + 本地不能解析 (e.g., pptx) → 自动 fallback 云
 *   · cloud → NeoxCloud
 *
 * 失败时不静默 fallback — 抛错让上层 toast 提示, 用户决定切模式重试.
 *
 * 两条路径返回结构相同 ({fileId, markdown, summary, metadata}),
 * 且都会同步写本地缓存 ~/.neox/documents/<fileId>.md (供 agent read_document 用). */
export async function parseDocument(file: File): Promise<DocumentParseResult> {
  /* 这里必须 await 真值而不是读同步缓存: 用户可能开机就拖文件进来, 那时 preload 还没回来,
   * 读缓存会拿到默认 'local' —— 把设了云端的人静默切回本地。 */
  const mode = await ensureDocumentParseModeLoaded();

  if (mode === 'local' && isLocallyParseable(file)) {
    const result: LocalParseResult = await parseDocumentLocally(file);
    /* 本地解析也写本地缓存 — 保持 read_document 工具行为统一 (从 cache 读, 不分本地/云解析路径). */
    try {
      const api: any = (window as any).neox;
      if (api?.documentCacheWrite) {
        const writeResult = await api.documentCacheWrite(result.fileId, result.markdown);
        if (!writeResult?.success) {
          console.warn('[documentParseClient] local-mode cache write failed:', writeResult?.error);
        }
      }
    } catch (err) {
      console.warn('[documentParseClient] local-mode cache write threw:', err);
    }
    return result;
  }

  if (!getEditionHook('isAuthenticated')()) {
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const zh = getGlobalLanguage() === 'zh';
    /* 没有账号体系的构建不提"登录" —— 那里根本没有云端解析这条路 */
    const hasAccount = getEditionHook('hasAccount');
    throw makeError(
      !hasAccount
        ? (zh ? `暂不支持解析 .${ext} 格式；请将文件转存为 PDF 后重试` : `.${ext} files are not supported. Convert the file to PDF and retry`)
        : zh
        ? `.${ext} 格式需要登录后用云端解析；或将文件转存为 PDF 后重试`
        : `.${ext} files require signing in for cloud parsing. Alternatively, convert the file to PDF and retry`,
      'NOT_AUTHENTICATED',
      401,
    );
  }
  return parseDocumentViaCloud(file);
}
