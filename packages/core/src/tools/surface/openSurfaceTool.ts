/**
 * open_surface — 在用户右栏画布打开一个产出物 viewer
 *
 * agent 调用场景:
 *   - 写完 .md 文档 → open_surface({kind:'doc', source:{type:'file', path:'...'}})
 *   - 输出 mermaid 图 → open_surface({kind:'diagram', source:{type:'inline', content:'graph TD...'}})
 *   - 生成图片 → open_surface({kind:'image', source:{type:'file', path:'...'}})
 *   - 起 dev server ready 后 → open_surface({kind:'web', source:{type:'url', url:'http://localhost:3000'}})
 *   - 写好 HTML 设计稿 → open_surface({kind:'html', source:{type:'file', path:'...'}})
 *   - 生成 Word/PDF/表格 → open_surface({kind:'docx'|'pdf'|'sheet', source:{type:'file', path:'...'}})
 *
 * 实现: 返回带 SURFACE_MARKER 的 JSON, renderer 在 tool_result event 里识别后 ingest 到 surfaceStore.
 * 不改 IPC 协议, 不引入新事件路径 — 工具结果天然走主消息流.
 */

import path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { loadPptxDeliveryGate } from '../pptxEdition.js';
import {
  blockedPayload,
  describeOfficeVerdict,
  inspectOfficeForDelivery,
  officeFormatForSurfaceKind,
} from '../delivery/officeDeliveryGate.js';
import {
  SURFACE_MARKER,
  type Surface,
  type SurfaceKind,
  type SurfaceSource,
  type SurfaceMarkerPayload,
} from './surfaceTypes.js';

interface OpenSurfaceArgs {
  kind: SurfaceKind;
  source: SurfaceSource;
  title?: string;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
}

/** 把 file 源相对路径钉成 agent 当前 workspace 绝对路径, 并带回 workspaceRoot 供 metadata.
 *  否则 renderer 会用 UI 壳工程路径去拼 (常与 setWorkspace / session cwd 不一致) → ENOENT 白屏. */
function resolveFileSource(source: SurfaceSource): {
  source: SurfaceSource;
  workspaceRoot?: string;
} {
  if (source.type !== 'file' || typeof source.path !== 'string' || !source.path.trim()) {
    return { source };
  }
  const workspaceRoot =
    getWorkspaceRootFromContext()
    ?? process.env.NEOX_WORKDIR
    ?? process.cwd();
  const abs = path.isAbsolute(source.path)
    ? path.resolve(source.path)
    : path.resolve(workspaceRoot, source.path);
  return {
    source: { ...source, path: abs },
    workspaceRoot,
  };
}

function genId(): string {
  return `sfc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function inferTitle(args: OpenSurfaceArgs): string {
  if (args.title) return args.title;
  if (args.source.type === 'file') {
    const p = args.source.path.replace(/\\/g, '/');
    const seg = p.split('/').filter(Boolean).pop();
    return seg || args.source.path;
  }
  if (args.source.type === 'url') {
    try { return new URL(args.source.url).host || args.source.url; }
    catch { return args.source.url; }
  }
  return `${args.kind} surface`;
}

export const openSurfaceTool: Tool = {
  name: 'open_surface',
  description: `Show artifact in user's right panel (Surface canvas). Returns surface_id.

kind:
- doc / diagram (mermaid) / image / html / svg / pdf / sheet / docx / pptx — visual artifacts (file or inline)
  · pptx: PowerPoint (.pptx / .ppt / .pps). Local LibreOffice converts to PDF first (auto-download on first use).
    ⚠️ DELIVERY GATE: opening a pptx that Neox generated automatically runs the layout self-check. If it has must-fix issues (text overflow / overlap / out-of-bounds / undersized fonts), the surface is REFUSED and you get the issue list back — redo those pages (deck_add_slide on the same index replaces the page in place), deck_export again, call again. There is no bypass. Decks you did not generate (user-supplied files) are never blocked.
  · sheet / docx: same delivery gate (work O-22) — a file Neox wrote in this session is checked for structural
    breakage first: error values (#REF! / #VALUE! / #DIV/0! ...) and blank workbooks in xlsx, blank pages /
    empty documents in docx, missing images, and broken links (hyperlink or external-link targets that do not
    exist). Must-fix issues REFUSE the surface and return the issue list — fix them and call again. Files you
    did not write are never blocked, and when the check cannot run you are told so explicitly (never claim a
    file was verified).
- code — source files in Monaco read-only viewer (ts/py/go/rust/json/yaml/toml/...). Auto syntax per extension.
- web — URL or dev server (embedded browser)
- diff — unified diff string (source.content), metadata: {path, before_label?, after_label?}
- plan / todo — long-task plan (markdown) / checklist (JSON {items}). Use edit_plan / update_todos to mutate.
- services — master-detail running services panel (source: inline empty, pinned recommended)
Do NOT use kind terminal or chart (removed). Shell output → execute_shell / services; charts → kind:diagram (mermaid).

source: {type:'file', path} watches file (auto-refreshes) | {type:'inline', content} | {type:'url', url}

BIG CONTENT RULE: for anything long (a multi-hundred-line plan / REQUIREMENTS / design doc), write it to a real FILE first (write_file) and open it with source:{type:'file', path} — the file is the canonical copy, it stays out of your context, the surface auto-refreshes when you edit the file, and you can readfile it any turn. Do NOT paste large markdown inline (it balloons context every turn). Reserve source:{type:'inline'} for short/throwaway content.
Use pinned:true if user must keep seeing it. Don't spam on every file write — only meaningful end products.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true, // 只是触发 UI 显示, 不动文件系统
  aliases: ['surface_open', 'openSurface'],

  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['doc', 'diagram', 'image', 'html', 'svg', 'web', 'pdf', 'code', 'diff', 'plan', 'todo', 'services', 'sheet', 'docx', 'pptx'],
        description: 'Viewer kind to use. (terminal/chart unsupported — use services/execute_shell or diagram)',
      },
      source: {
        type: 'object',
        description: 'Content source. One of: { type:"file", path:"..." } | { type:"inline", content:"..." } | { type:"url", url:"..." }',
      },
      title: {
        type: 'string',
        description: 'Optional tab title. Auto-inferred from file basename / url host if omitted.',
      },
      pinned: {
        type: 'boolean',
        description: 'Pin this surface — new surfaces will not replace it. Default false.',
      },
      metadata: {
        type: 'object',
        description: 'Optional kind-specific metadata (e.g. dev server pid for web, alt text for image).',
      },
    },
    required: ['kind', 'source'],
  },

  async function(args: OpenSurfaceArgs): Promise<string> {
    if (!args?.kind) {
      return JSON.stringify({ error: 'kind is required' });
    }
    if (!args?.source || typeof args.source !== 'object') {
      return JSON.stringify({ error: 'source is required (object with type+path/content/url)' });
    }

    /* 诚实闸门: desktop 无 terminal/chart viewer — 禁开空页, 把模型导到已实现能力. */
    const kindStr = String(args.kind);
    if (kindStr === 'terminal') {
      return JSON.stringify({
        error: 'kind "terminal" is not supported as a Surface viewer.',
        next:
          'For shell output use execute_shell (timeline shows the terminal). '
          + 'For long-running process logs use open_surface({kind:"services", ...}).',
      });
    }
    if (kindStr === 'chart') {
      return JSON.stringify({
        error: 'kind "chart" is not supported as a Surface viewer.',
        next:
          'Use open_surface({kind:"diagram", source:{type:"inline", content:"<mermaid>"}}) '
          + 'or write a .md/.html artifact and open kind:doc / kind:html.',
      });
    }

    if (kindStr === 'todo' && args.source.type !== 'inline') {
      return JSON.stringify({
        error: `kind "todo" only accepts source:{type:"inline"} — got type:"${String(args.source.type)}". No surface was opened.`,
        next:
          'Just call update_todos({items:[...]}) directly — it creates the checklist surface for you, '
          + 'no open_surface needed. Only pass source:{type:"inline", content:"{\\"items\\":[...]}"} '
          + 'if you really want to open it by hand.',
      });
    }

    /** pptx 闸门的自检结论 —— 随 tool 结果回给模型 (不进 surface 状态)。 */
    let pptxSelfCheck: Record<string, unknown> | null = null;

    const resolved = resolveFileSource(args.source);
    const resolvedArgs: OpenSurfaceArgs = { ...args, source: resolved.source };

    if (resolvedArgs.kind === 'pptx' && resolvedArgs.source.type === 'file' && loadPptxDeliveryGate) {
      const { inspectPptxForDelivery, describeVerdict, blockedPptxIssues } = await loadPptxDeliveryGate();
      const verdict = await inspectPptxForDelivery(resolvedArgs.source.path);
      if (verdict.status === 'blocked') {
        /* work:H-19 — issues 压成一行一条 (带页号), 整个返回守 1.5K, 免得模型漏掉 mustFix。
         * 压缩函数走 pptxEdition 接缝 (共享代码不许直接 import 商业目录)。
         * payload 已经按最终序列化长度装好预算, 这里直接回, 不再拼文案。 */
        const compact = blockedPptxIssues(verdict.report);
        return JSON.stringify({
          ...compact.payload,
          ...(compact.dropped > 0 ? { issuesShown: compact.shown, issuesDropped: compact.dropped } : {}),
        });
      }
      pptxSelfCheck = describeVerdict(verdict);
    }

    let officeSelfCheck: Record<string, unknown> | null = null;
    const officeFormat = officeFormatForSurfaceKind(resolvedArgs.kind);
    if (officeFormat && resolvedArgs.source.type === 'file') {
      const verdict = await inspectOfficeForDelivery(officeFormat, resolvedArgs.source.path);
      if (verdict.status === 'blocked') return JSON.stringify(blockedPayload(verdict));
      officeSelfCheck = describeOfficeVerdict(verdict);
    }

    const now = Date.now();
    const surface: Surface = {
      id: genId(),
      kind: resolvedArgs.kind,
      source: resolvedArgs.source,
      title: inferTitle(resolvedArgs),
      pinned: resolvedArgs.pinned === true,
      metadata: {
        ...(resolvedArgs.metadata ?? {}),
        ...(resolved.workspaceRoot ? { workspacePath: resolved.workspaceRoot } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };

    /* Web surface 物理打开: 通知 BrowserSession, 订阅者 (桌面宿主下是 runtime 自己的 hostedChrome) 负责起
     * Chrome + 建 tab + 打 window.name 烙印. 无订阅者时 (CLI / embedded 模式) 静默 no-op,
     * renderer 老流程 (建 BrowserView 时烙印) 继续走. */
    if (resolvedArgs.kind === 'web' && resolvedArgs.source?.type === 'url') {
      try {
        const { getBrowserSession } = await import('../../runtime/browser/browserSession.js');
        getBrowserSession().notifyWebSurfaceOpen(surface.id, resolvedArgs.source.url);
      } catch { /* 静默 — 通知失败不阻塞 marker 返回 */ }
    }

    const payload: SurfaceMarkerPayload = {
      [SURFACE_MARKER]: true,
      action: 'open',
      surface,
    };
    /* selfCheck 挂 payload 顶层给模型看; renderer 只认 SURFACE_MARKER + surface, 多一个键不影响 ingest。 */
    const selfCheck = { ...(pptxSelfCheck ?? {}), ...(officeSelfCheck ?? {}) };
    return JSON.stringify(Object.keys(selfCheck).length ? { ...payload, ...selfCheck } : payload);
  },
};
