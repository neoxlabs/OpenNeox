/**
 * create_slides — agent 一次调用生成整套 pptx (不用写 .mjs 脚本 + node run).
 *
 * 心智:
 *   agent 传结构化 JSON (slides 数组), 每 slide 用模板 (template + slots) 或手工形状 (shapes).
 *   工具内部调 @neoxlabs/pptx-renderer 的 builder + exporter, 直接写 .pptx 到 workspace.
 *   返回文件绝对路径 → agent 可以立刻 open_surface({kind:'pptx', ...}) 让用户看到.
 *
 * 这是 Codex `.mjs + node run` 的简化路径, 适合场景明确、结构规整的 PPT (旅游/产品/汇报).
 * 需要自定义算法排版时 agent 仍可以自己写 mjs (import @neoxlabs/pptx-renderer/node) 再跑.
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  Presentation, exportPptx, TEMPLATE_BUILDERS,
  fromJson, type JsonPresentation,
} from '@neoxlabs/pptx-renderer';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';

interface CreateSlidesArgs {
  /** 输出 pptx 相对/绝对路径. 相对时相对当前 workspace. 默认 'presentation.pptx'. */
  outputPath?: string;
  /** slide 尺寸 (CSS px). 默认 { width: 1280, height: 720 } (16:9). */
  slideSize?: { width: number; height: number };
  /** 主题 (可选). */
  theme?: { colors?: Record<string, string>; majorFont?: string; minorFont?: string };
  /**
   * slides 数组. 每项要么用模板 (template + slots) 要么直接给 shapes (完全手动).
   *   模板列表: cover-hero / title-body / bullet-list / two-column / image-gallery /
   *            timeline / kpi-cards / data-table / quote-page / section-divider / chart-focus
   */
  slides: Array<
    | { template: string; slots: Record<string, unknown> }
    | { shapes: unknown[]; background?: string }
  >;
}

/**
 * 供工具运行时读的模板 metadata 列表 (agent prompt 引用). 单独 export 是因为 tool.description
 * 里放全套 metadata 太长. Agent 需要先调 list_slide_templates() 拿元数据再决定用哪个.
 */
export const SLIDE_TEMPLATE_IDS = Object.keys(TEMPLATE_BUILDERS);

export const createSlidesTool: Tool = {
  name: 'create_slides',
  description: `Quick .pptx builder for TINY decks only: **hard limit 5 slides, and total text across all slots must stay minimal**.

⚠️ For any real deck (6+ slides, or slides with paragraph-length Chinese/English content): DO NOT use this tool. Long JSON arguments reliably get corrupted mid-generation (unrecoverable JSON_PARSE_ERROR). Use deck_begin → deck_add_slide (one call per page) → deck_export instead: the declarative compose engine (24 templates, precise text measurement, zero-overlap layout), a live preview in the user's right panel, and an automatic layout self-check on export. Everything runs inside Neox — nothing for the user to install. The pptx-deck-writer skill documents the flow.

Two authoring styles per slide:
- **template**: pick from ${SLIDE_TEMPLATE_IDS.join(' / ')} — pass \`{template, slots}\` (see list_slide_templates for schemas).
- **shapes**: pure manual — \`{shapes: [...]}\`, each { kind: 'text'|'image'|'rect'|'roundRect'|'ellipse', position: {left,top,width,height} } in CSS px (slide 1280x720). fontSize is in pt, NOT px.

Returns: absolute path to the generated .pptx. Follow up with open_surface({kind:'pptx', source:{type:'file', path:...}}).

Image inputs: prefer { uri: 'https://...' } for public images, or { dataUrl: 'data:image/png;base64,...' } for inline.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe', /* 写文件 */
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      outputPath: {
        type: 'string',
        description: 'Where to save the .pptx. Absolute or workspace-relative. Default "presentation.pptx".',
      },
      slideSize: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
        },
        description:
          'CSS px. ONLY {width:1280, height:720} is supported — the page templates are laid out '
          + 'against that canvas. Any other size is rejected rather than silently mis-rendered. Omit it.',
      },
      theme: {
        type: 'object',
        description: 'Optional theme overrides { colors: {dk1, lt1, accent1, ...}, majorFont, minorFont }.',
      },
      slides: {
        type: 'array',
        description: 'Slides in order. Each item is {template, slots} OR {shapes, background?}.',
        items: { type: 'object' },
      },
    },
    required: ['slides'],
  },

  async function(args: CreateSlidesArgs): Promise<string> {
    /* 同 deck_begin: 模板全部按 1280×720 排版, 换尺寸是静默画坏而不是自动适配。
     * 两个入口都要拦, 只拦一个等于没拦。 */
    if (args.slideSize
      && (args.slideSize.width !== 1280 || args.slideSize.height !== 720)) {
      return JSON.stringify({
        error: `slideSize 目前只支持 1280×720 (16:9), 收到 ${args.slideSize.width}×${args.slideSize.height}。`
          + ' 页面模板都是按这个画布排的 —— 换尺寸会让内容错位, 不会自动适配。去掉 slideSize 参数即可。',
      });
    }
    if (!args?.slides || !Array.isArray(args.slides) || args.slides.length === 0) {
      return JSON.stringify({ error: 'slides array is required and non-empty' });
    }

    if (args.slides.length > 5) {
      return JSON.stringify({
        error: `create_slides 上限 5 页 (收到 ${args.slides.length} 页). ` +
          `大 deck 用 deck_begin 规划大纲 → deck_add_slide 逐页生成 → deck_export 导出 ` +
          `(compose 声明式引擎 · 精准测量 · 零重叠 · 导出时自动排版自检). 流程见 pptx-deck-writer skill.`,
      });
    }

    const rawWorkspace = getWorkspaceRootFromContext();
    if (!rawWorkspace) {
      return JSON.stringify({
        error: 'workspaceContext 未绑定 (runner 每回合应通过 AsyncLocalStorage 注入). '
          + '这是 tool runtime 问题不是 args 问题, 报给用户让他们检查会话 workspace.',
      });
    }
    const workspace = rawWorkspace.replace(/\/+$/, '');

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const datePrefix = `${yyyy}-${mm}-${dd}`;

    let outRel = args.outputPath;
    if (!outRel) {
      outRel = `${datePrefix}-slides/pres.pptx`;
    } else if (!path.isAbsolute(outRel)) {
      /* 相对路径: 如果没有子目录, 强制包一层日期子目录, 避免污染 workspace 根 */
      const normalized = outRel.replace(/^\.?\/+/, '');
      const hasSubdir = normalized.includes('/') || normalized.includes(path.sep);
      if (!hasSubdir) {
        /* 裸文件名 → 用文件名 (去扩展名) 做 slug */
        const base = normalized.replace(/\.pptx?$/i, '');
        const slug = base.trim().slice(0, 40); /* 限长 40, 目录名友好 */
        outRel = `${datePrefix}-${slug}/${normalized}`;
      }
    }
    const outAbs = path.isAbsolute(outRel) ? outRel : path.join(workspace, outRel);
    /* 保证 .pptx 扩展名 */
    const finalPath = outAbs.endsWith('.pptx') ? outAbs : outAbs + '.pptx';

    /* 2. 构建 Presentation */
    const ppt = Presentation.create({
      slideSize: args.slideSize ?? { width: 1280, height: 720 },
    });
    if (args.theme) ppt.setTheme(args.theme);

    const imgErrors = await prefetchUriImages(args.slides);
    if (imgErrors.length > 0) {
      return JSON.stringify({
        error: `image URL prefetch failed (${imgErrors.length} 张). 修 URL 或删掉 image slot 再重试:\n`
          + imgErrors.map((e, i) => `  ${i + 1}. ${e.reason} — ${e.url}`).join('\n'),
      });
    }

    /* 3. 逐 slide 处理 */
    for (let i = 0; i < args.slides.length; i++) {
      const spec = args.slides[i] as any;
      try {
        if (spec.template) {
          const builder = TEMPLATE_BUILDERS[spec.template];
          if (!builder) {
            return JSON.stringify({
              error: `unknown template "${spec.template}" at slides[${i}]. Valid: ${SLIDE_TEMPLATE_IDS.join(', ')}`,
            });
          }
          builder(ppt, spec.slots ?? {});
        } else if (spec.shapes) {
          /* 手工 shapes: 走业务 JSON schema 编译一整张 slide */
          const jsonPres: JsonPresentation = {
            schemaVersion: 1,
            slides: [{
              shapes: spec.shapes,
              background: spec.background ? { type: 'solid', color: spec.background } : undefined,
            } as any],
          };
          const modelSlide = fromJson(jsonPres).slides[0];
          ppt.model.slides.push(modelSlide!);
        } else {
          return JSON.stringify({
            error: `slides[${i}] must have either template+slots or shapes`,
          });
        }
      } catch (err: any) {
        return JSON.stringify({
          error: `build slides[${i}] failed: ${err?.message ?? String(err)}`,
        });
      }
    }

    /* 4. 导出 pptx */
    try {
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      const file = await exportPptx(ppt);
      await file.save(finalPath);
    } catch (err: any) {
      return JSON.stringify({
        error: `export pptx failed: ${err?.message ?? String(err)}`,
      });
    }

    /* 存盘后 stat 一下 · 拿不到就是文件没落地, 让 tool 报错不做假成功. */
    const size = (await fs.stat(finalPath)).size;

    /* 排版自检由 open_surface 的交付闸门进程内跑 (pptxDeliveryGate), 这里不再教 agent 去调脚本 */
    return JSON.stringify({
      success: true,
      path: finalPath,
      slideCount: ppt.slides.length,
      sizeBytes: size,
      hint: `pptx generated. Follow up with open_surface({kind:'pptx', source:{type:'file', path:'${finalPath}'}}) to preview it. `
        + 'open_surface re-runs the layout self-check on it and REFUSES to display a deck with must-fix issues '
        + '(you get the issue list instead) — so fix them first rather than hoping they slip through.',
    });
  },
};

async function prefetchUriImages(
  slides: any[],
): Promise<Array<{ url: string; reason: string }>> {
  const fetches: Promise<void>[] = [];
  const cache = new Map<string, { blob: ArrayBuffer; contentType: string }>();
  const errors: Array<{ url: string; reason: string }> = [];
  const URI_KEYS = ['uri', 'url', 'imageUrl', 'image_url', 'src', 'href', 'path', 'file'];
  const RANDOM_URL_PATTERNS: RegExp[] = [
    /^https?:\/\/source\.unsplash\.com\//i,
    /^https?:\/\/(?:www\.)?unsplash\.com\/(?:photos\/)?random/i,
    /^https?:\/\/loremflickr\.com\//i,
    /^https?:\/\/picsum\.photos/i,
    /^https?:\/\/lorempixel\.com\//i,
    /^https?:\/\/placeimg\.com\//i,
    /^https?:\/\/via\.placeholder\.com\//i,
    /^https?:\/\/(?:www\.)?google\.com\/search/i,
    /^https?:\/\/(?:www\.)?bing\.com\/search/i,
    /^https?:\/\/(?:www\.)?baidu\.com\/s\?/i,
    /random-photo|randomize|\/random\?/i,
  ];

  const contentTypeFromExt = (p: string): string => {
    const ext = (p.split('.').pop() || '').toLowerCase();
    return ext === 'png' ? 'image/png'
      : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : ext === 'bmp' ? 'image/bmp'
      : ext === 'svg' ? 'image/svg+xml'
      : ext === 'tiff' || ext === 'tif' ? 'image/tiff'
      : 'application/octet-stream';
  };

  const isHttp = (s: string): boolean => /^https?:\/\//i.test(s);
  const isDataUrl = (s: string): boolean => /^data:/i.test(s);
  const isLocalPath = (s: string): boolean => s.startsWith('/') || /^file:\/\//i.test(s) || /^[A-Za-z]:[\\/]/.test(s);
  const isAnySrc = (s: string): boolean => isHttp(s) || isDataUrl(s) || isLocalPath(s);

  const fetchHttp = async (url: string): Promise<{ blob: ArrayBuffer; contentType: string }> => {
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 2000 - 1000));
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Neox/1.0' } });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentType = res.headers.get('content-type') || contentTypeFromExt(url);
        const blob = await res.arrayBuffer();
        if (blob.byteLength < 1024 || blob.byteLength > 20 * 1024 * 1024) {
          throw new Error(`size out of range: ${blob.byteLength}B`);
        }
        return { blob, contentType };
      } catch (err: any) {
        lastErr = err;
        const msg = err?.message || String(err);
        if (/HTTP 4\d\d|size out of range/.test(msg)) break;
      }
    }
    throw lastErr ?? new Error('unknown fetch error');
  };

  const readLocal = async (rawPath: string): Promise<{ blob: ArrayBuffer; contentType: string }> => {
    let p = rawPath;
    if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7).replace(/^\/(?=[A-Za-z]:)/, ''));
    const bytes = await fs.readFile(p);
    if (bytes.byteLength < 512 || bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error(`size out of range: ${bytes.byteLength}B`);
    }
    return {
      blob: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      contentType: contentTypeFromExt(p),
    };
  };

  const walk = (obj: any): void => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    /* 探测第一个 src 字段 (任意 URI_KEYS 命中且值是可识别 src) */
    let uriKey: string | null = null;
    let src = '';
    for (const k of URI_KEYS) {
      if (typeof obj[k] === 'string' && isAnySrc(obj[k])) {
        uriKey = k;
        src = obj[k];
        break;
      }
    }
    if (uriKey && isDataUrl(src)) {
      /* 已是 data URL, 保持原样, 也不递归下去 (data 里没图字段) */
      return;
    }
    if (uriKey && isHttp(src) && RANDOM_URL_PATTERNS.some((re) => re.test(src))) {
      errors.push({ url: src, reason: 'non-deterministic URL (random/search endpoint · 每次返回随机图与主题无关)' });
      return;
    }
    if (obj.generate === true && typeof obj.prompt === 'string' && obj.prompt.trim() && !uriKey) {
      fetches.push((async () => {
        try {
          const svc = (await import('../../services/imageGenService.js')).getImageGenService();
          const result = await svc.generate({
            model: obj.model || 'gpt-image-2',
            prompt: obj.prompt,
            size: obj.size || '1024x1024',
            quality: obj.quality || 'high',
            responseFormat: 'b64_json',
            n: 1,
          });
          const item = result.data?.[0];
          if (!item?.b64Json) {
            errors.push({ url: `[generate] ${obj.prompt}`, reason: 'image gen returned no b64_json' });
            return;
          }
          const bin = Buffer.from(item.b64Json, 'base64');
          const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
          delete obj.generate;
          delete obj.prompt;
          obj.blob = buf;
          obj.contentType = 'image/png';
        } catch (err: any) {
          errors.push({ url: `[generate] ${obj.prompt}`, reason: `image gen failed: ${err?.message || String(err)}` });
        }
      })());
      return;
    }
    if (uriKey) {
      fetches.push((async () => {
        try {
          if (!cache.has(src)) {
            const got = isHttp(src) ? await fetchHttp(src) : await readLocal(src);
            cache.set(src, got);
          }
          const cached = cache.get(src)!;
          delete obj[uriKey!];
          obj.blob = cached.blob;
          obj.contentType = cached.contentType;
        } catch (err: any) {
          errors.push({ url: src, reason: err?.message || String(err) });
        }
      })());
      return;
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };

  walk(slides);
  await Promise.all(fetches);
  return errors;
}

/**
 * list_slide_templates — 辅助工具, 返回所有可用模板的元数据.
 * Agent 先调这个查 useWhen/avoidWhen/slots 决定用哪个模板, 再调 create_slides.
 */
export const listSlideTemplatesTool: Tool = {
  name: 'list_slide_templates',
  description: `List all available slide templates with metadata (useWhen / avoidWhen / slot schema / typography budget). Call this BEFORE create_slides to pick the right templates.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {},
  },

  async function(_args: Record<string, unknown>): Promise<string> {
    const { ALL_TEMPLATE_METAS } = await import('@neoxlabs/pptx-renderer');
    const { TEMPLATES } = await import('./deckTools.js');
    const guidance = new Map(
      (ALL_TEMPLATE_METAS as unknown as Array<Record<string, unknown>>)
        .map((m) => [String(m.id), m] as const),
    );
    const templates = Object.entries(TEMPLATES).map(([id, def]) => {
      const g = guidance.get(id) ?? {};
      return {
        id,
        category: g.category,
        useWhen: g.useWhen,
        avoidWhen: g.avoidWhen,
        required: def.required,
        slots: def.slots,
      };
    });
    return JSON.stringify({ count: templates.length, engine: 'compose', templates });
  },
};
