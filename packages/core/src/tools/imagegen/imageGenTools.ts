/**
 * Image Generation Tools — agent 路径的 generate_image / edit_image.
 *
 * 心智 (对齐 create_slides + ttsService 双源):
 *   · agent 描述图片, 工具调 ImageGenService → NeoxCloud 网关或 BYOK 上游.
 *   · 结果 (b64 or URL) 落盘到 workspace/generated-images/<date>-<slug>/,
 *     返回绝对路径 + revised_prompt.
 *   · 后续 agent 可 open_surface 或在 timeline 上直接嵌显 (imageBlock).
 *
 * 图片模式的直连通道不走这里 — renderer IPC 直调 ImageGenService.generate,
 * 见 desktop/services/imageDirectClient.ts.
 */

import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import fs from 'node:fs/promises';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { getImageGenService, type ImageGenerationRequest } from '../../services/imageGenService.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

interface GenerateImageArgs {
  /** 主提示词. 中文/英文都行, 越具体越好 (主体+风格+构图+光影). */
  prompt: string;
  /** model id. 默认 'gpt-image-1'. 可选: 'grok-image', 'doubao-seedream-4' 等. */
  model?: string;
  /** 出图张数. 默认 1. 大部分 provider 支持 1-4. */
  n?: number;
  /** 尺寸. 默认 '1024x1024'. 竖版用 1024x1536, 横版 1536x1024. */
  size?: string;
  /** 质量. 默认 'high'. gpt-image-1: low/medium/high. dall-e-3: standard/hd. */
  quality?: string;
  /** 输出路径 (相对/绝对). 默认 'YYYY-MM-DD-images/<slug>.png'. */
  outputPath?: string;
}

interface EditImageArgs {
  /** 源图: 绝对路径 · data URL · 公网 URL. */
  source: string;
  /** 修改描述 (英文更精准). */
  prompt: string;
  /** 蒙版 (可选, PNG, alpha 通道=编辑区). */
  mask?: string;
  model?: string;
  n?: number;
  size?: string;
  outputPath?: string;
}

// ============================================================================
// generate_image
// ============================================================================


type ImageCatalog = {
  line: string;
  paramDesc: string;
  /** null = 这个账号**此刻一个出图模型都没有** —— 不许瞎编一个默认值出来, 见下方注释。 */
  defaultModel: string | null;
};

let modelCatalogSnapshot: ImageCatalog | null = null;

function computeCatalog(): ImageCatalog {
  let cloud: string[] = [];
  let byok: string[] = [];
  try {
    const cat = getImageGenService().listAvailableImageModels();
    cloud = cat.cloud; byok = cat.byok;
  } catch { /* 服务没就绪就当拿不到 */ }

  const all = [...cloud, ...byok.filter((m) => !cloud.includes(m))];
  const defaultModel: string | null = cloud[0] ?? byok[0] ?? null;

  /* 拿不到清单时 (未登录 / 老 server 不返 modality / 没配 BYOK) **一个都不列**,
   * 只说"不传 model 走默认"。报错的选项比没有选项更伤 —— 之前硬编码的
   * grok-image / doubao-seedream-4 在订阅通道里根本不存在, agent 照着报给了用户。 */
  if (all.length === 0) {
    return {
      line: 'UNAVAILABLE right now: this account has no image model. '
        + 'With your own API keys, configure a provider with the image (or image-edit) capability in Settings → Providers. '
        + 'On a NeoxCloud subscription, switch to a subscription model. Until then this tool cannot run — say so instead of calling it.',
      paramDesc: 'Model id. No image model is configured on this account. Do not guess ids.',
      defaultModel,
    };
  }
  const parts: string[] = [];
  if (cloud.length) parts.push(`subscription: ${cloud.join(', ')}`);
  if (byok.length) parts.push(`your own keys: ${byok.join(', ')}`);
  return {
    line: `Model choice: default \`${defaultModel}\`. Available right now — ${parts.join(' · ')}. `
      + 'These are the ONLY valid ids; anything else fails with "no gateway channel available".',
    paramDesc: `Model id. Default ${defaultModel}. Valid: ${all.join(', ')}.`,
    defaultModel,
  };
}

function catalog(): ImageCatalog {
  if (!modelCatalogSnapshot) modelCatalogSnapshot = computeCatalog();
  return modelCatalogSnapshot;
}

/**
 * 重新取一次可用模型快照 —— **只在新会话开始时调**。
 * 会话中途调 = system 段变了 = prompt 缓存作废。
 */
export function refreshImageModelCatalog(): void {
  modelCatalogSnapshot = computeCatalog();
}


function resolveImageModel(toolName: string, requested?: string): { model: string } | { blocked: string } {
  const model = requested?.trim() || catalog().defaultModel;
  if (model) return { model };
  return {
    blocked: JSON.stringify(createContextualResult(
      toolName,
      'error',
      'No image model available on this account',
      'Image generation/editing needs a model this account can actually use:\n'
      + '· Own API keys (BYOK): configure a provider with the image / image-edit capability in Settings → Providers, '
      + 'then pass that model id — nothing is enabled by default.\n'
      + '· NeoxCloud subscription: switch to a subscription model first.\n'
      + 'Tell the user this instead of retrying — no model id will work until one of the two is done.',
      { error: 'no_image_model_configured', precondition: true },
    )),
  };
}

export const generateImageTool: Tool = {
  name: 'generate_image',
  get description() {
    return `Generate images from a text prompt via NeoxCloud (or BYOK). Returns absolute local file paths written to the current workspace under a dated \`generated-images/\` subdirectory.

Use for: illustration, hero images, mood boards, product mockups, marketing visuals, storyboarding. NOT for chart/diagram data — use dataviz code for those.

Prompt guidance: write a compact structured description — subject, style, composition, lighting, mood, quality tag. English yields more reliable results than colloquial Chinese; you may internally translate a Chinese user request before calling.

${catalog().line}

Cost: NeoxCloud charges per image based on size×quality. Users see the deduction in their credit balance; agent behavior should still avoid gratuitous batches — default n=1 unless the user asked for variants.`;
  },  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },

  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What to draw. Concrete, structured, EN or ZH. Include subject + style + composition + lighting.',
      },
      model: {
        type: 'string',
        get description() { return catalog().paramDesc; },
      },
      n: {
        type: 'number',
        description: 'How many images. Default 1. Cap 4 for cost safety.',
      },
      size: {
        type: 'string',
        description: 'Image dimensions. 1024x1024 (square, default) · 1024x1536 (portrait) · 1536x1024 (landscape).',
      },
      quality: {
        type: 'string',
        description: 'Quality tier. gpt-image-1: low/medium/high. Higher = slower + more credits.',
      },
      outputPath: {
        type: 'string',
        description: 'Where to save. Absolute or workspace-relative. Default: YYYY-MM-DD-images/<slug>.png. Multi-image (n>1) auto-suffixes -1, -2, ...',
      },
    },
    required: ['prompt'],
  },

  async function(args: GenerateImageArgs): Promise<string> {
    if (!args?.prompt || typeof args.prompt !== 'string' || !args.prompt.trim()) {
      return JSON.stringify({ error: 'prompt required and must be non-empty string' });
    }
    if (args.n !== undefined && (args.n < 1 || args.n > 4)) {
      return JSON.stringify({ error: 'n must be between 1 and 4' });
    }

    const rawWorkspace = getWorkspaceRootFromContext();
    if (!rawWorkspace) {
      return JSON.stringify({
        error: 'workspaceContext 未绑定 - runner 每回合应通过 AsyncLocalStorage 注入.',
      });
    }
    const workspace = rawWorkspace.replace(/\/+$/, '');

    /* 模型来源: 用户显式传的 > 账号真正可用的第一个。两者都没有 = 这个账号没这个能力,
     * 就地停手, 别拿编出来的默认值去撞上游 (见 resolveImageModel)。 */
    const picked = resolveImageModel('generate_image', args.model);
    if ('blocked' in picked) return picked.blocked;

    const req: ImageGenerationRequest = {
      model: picked.model,
      prompt: args.prompt,
      n: args.n ?? 1,
      size: (args.size as any) || '1024x1024',
      quality: (args.quality as any) || 'high',
      responseFormat: 'b64_json',
    };

    const cacheKey = createHash('sha256')
      .update(JSON.stringify([req.model, req.prompt, req.size, req.quality, req.n]))
      .digest('hex').slice(0, 32);
    const cacheDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'image-cache');
    const cacheFileFor = (i: number) => path.join(cacheDir, `${cacheKey}${i === 0 ? '' : `-${i + 1}`}.png`);

    let cachedBufs: Buffer[] | null = null;
    try {
      const bufs: Buffer[] = [];
      for (let i = 0; i < (req.n ?? 1); i++) bufs.push(await fs.readFile(cacheFileFor(i)));
      cachedBufs = bufs;
    } catch { cachedBufs = null; }

    let result;
    if (cachedBufs) {
      result = { data: cachedBufs.map((buf) => ({ b64Json: buf.toString('base64') })), mode: 'cache' } as any;
    } else try {
      result = await getImageGenService().generate(req);
    } catch (err: any) {
      return JSON.stringify({
        error: `image generation failed: ${err?.message ?? String(err)}`,
      });
    }
    if (!result.data || result.data.length === 0) {
      return JSON.stringify({ error: 'provider returned no images' });
    }

    /* 落盘. 路径策略跟 create_slides 一致: 裸文件名 → 强制包 YYYY-MM-DD-<slug>/ 子目录. */
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const datePrefix = `${yyyy}-${mm}-${dd}`;

    let outRel = args.outputPath;
    const promptSlug = args.prompt
      .replace(/[^\w一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image';
    if (!outRel) {
      outRel = `${datePrefix}-images/${promptSlug}.png`;
    } else if (!path.isAbsolute(outRel)) {
      const normalized = outRel.replace(/^\.?\/+/, '');
      const hasSubdir = normalized.includes('/') || normalized.includes(path.sep);
      if (!hasSubdir) {
        outRel = `${datePrefix}-images/${normalized}`;
      }
    }
    const outAbs = path.isAbsolute(outRel) ? outRel : path.join(workspace, outRel);
    const outDir = path.dirname(outAbs);
    const outBase = outAbs.replace(/\.[^.]+$/, '');
    const outExt = outAbs.match(/\.[^.]+$/)?.[0] || '.png';

    await fs.mkdir(outDir, { recursive: true });

    /* 生成成功后写缓存 (命中缓存时不用重写)。写失败不影响主流程 —— 缓存是优化,
     * 不是正确性依赖, 磁盘满/只读时应该照常出图。 */
    if (!cachedBufs) {
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        for (let i = 0; i < result.data.length; i++) {
          const it = result.data[i]!;
          if (it.b64Json) await fs.writeFile(cacheFileFor(i), Buffer.from(it.b64Json, 'base64'));
        }
      } catch { /* 缓存写不进去就算了 */ }
    }

    const savedPaths: string[] = [];
    for (let i = 0; i < result.data.length; i++) {
      const item = result.data[i]!;
      const filename = result.data.length === 1 ? outAbs : `${outBase}-${i + 1}${outExt}`;
      if (item.b64Json) {
        await fs.writeFile(filename, Buffer.from(item.b64Json, 'base64'));
      } else if (item.url) {
        /* URL 返回时下载. 大部分 provider URL 有效期短 (10min~1h), 必须立刻拉. */
        const resp = await fetch(item.url);
        if (!resp.ok) {
          return JSON.stringify({ error: `download image url failed: ${resp.status} ${item.url}` });
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        await fs.writeFile(filename, buf);
      } else {
        return JSON.stringify({ error: `image[${i}] has neither b64_json nor url` });
      }
      savedPaths.push(filename);
    }

    return JSON.stringify({
      success: true,
      paths: savedPaths,
      count: savedPaths.length,
      model: result.model,
      mode: result.mode,
      revisedPrompt: result.data[0]?.revisedPrompt,
      latencyMs: result.usage?.latencyMs,
      creditsSpent: result.usage?.creditsSpent,
      hint: savedPaths.length === 1
        ? `Image saved. To preview: open_surface({kind:'image', source:{type:'file', path:'${savedPaths[0]}'}}). To iterate: edit_image({source:'${savedPaths[0]}', prompt:'...'}).`
        : `${savedPaths.length} images saved. Preview each via open_surface({kind:'image', source:{type:'file', path:...}}).`,
    });
  },
};

// ============================================================================
// edit_image
// ============================================================================

export const editImageTool: Tool = {
  name: 'edit_image',
  get description() {
    return `Edit an existing image with a text prompt (图生图 / inpaint). Reuses NeoxCloud provider chain. Requires a source image (local absolute path, data URL, or public URL).

Common uses: change color/style of a region, add/remove elements, replace background, apply a new artistic style, generate variants keeping composition.

Prompt guidance: describe ONLY what changes — the model preserves the rest. E.g. "make the sky sunset orange" not "a person under a sunset orange sky".

Mask (optional): PNG where alpha channel = edit area (transparent = edit, opaque = keep). Without mask, model edits the whole image guided by prompt.

Cost: same per-image billing as generate_image, typically 1.2-1.5x due to source token overhead.`;
  },  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },

  parameters: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Source image: absolute local path, data:image/... URL, or https:// URL. Required.',
      },
      prompt: {
        type: 'string',
        description: 'Describe the edit. Focus on what changes, not the full scene.',
      },
      mask: {
        type: 'string',
        description: 'Optional PNG mask (data URL or absolute path). alpha=edit region.',
      },
      model: {
        type: 'string',
        description: 'Model id. Default gpt-image-1 (best edit support).',
      },
      n: {
        type: 'number',
        description: 'Variants. Default 1. Cap 4.',
      },
      size: {
        type: 'string',
        description: 'Output size. Default matches source when possible.',
      },
      outputPath: {
        type: 'string',
        description: 'Where to save. Default sibling of source with -edited suffix.',
      },
    },
    required: ['source', 'prompt'],
  },

  async function(args: EditImageArgs): Promise<string> {
    if (!args?.source || !args?.prompt) {
      return JSON.stringify({ error: 'source and prompt required' });
    }

    const rawWorkspace = getWorkspaceRootFromContext();
    if (!rawWorkspace) {
      return JSON.stringify({ error: 'workspaceContext 未绑定' });
    }
    const workspace = rawWorkspace.replace(/\/+$/, '');

    /* 源图规范化: 本地路径 → 读盘转 dataURL. HTTP / data 保留原样. */
    let sourceInline = args.source;
    if (path.isAbsolute(args.source)) {
      const buf = await fs.readFile(args.source);
      const ext = args.source.split('.').pop()?.toLowerCase() || 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp' : 'image/png';
      sourceInline = `data:${mime};base64,${buf.toString('base64')}`;
    }
    let maskInline = args.mask;
    if (maskInline && path.isAbsolute(maskInline)) {
      const buf = await fs.readFile(maskInline);
      maskInline = `data:image/png;base64,${buf.toString('base64')}`;
    }

    const picked = resolveImageModel('edit_image', args.model);
    if ('blocked' in picked) return picked.blocked;

    const req: ImageGenerationRequest = {
      model: picked.model,
      prompt: args.prompt,
      n: args.n ?? 1,
      size: (args.size as any),
      responseFormat: 'b64_json',
      image: sourceInline,
      mask: maskInline,
    };

    let result;
    try {
      result = await getImageGenService().edit(req);
    } catch (err: any) {
      return JSON.stringify({
        error: `image edit failed: ${err?.message ?? String(err)}`,
      });
    }
    if (!result.data || result.data.length === 0) {
      return JSON.stringify({ error: 'provider returned no images' });
    }

    /* 输出路径: 默认 sibling with -edited suffix. */
    let outAbs: string;
    if (args.outputPath) {
      outAbs = path.isAbsolute(args.outputPath) ? args.outputPath : path.join(workspace, args.outputPath);
    } else if (path.isAbsolute(args.source)) {
      const parsed = path.parse(args.source);
      outAbs = path.join(parsed.dir, `${parsed.name}-edited${parsed.ext || '.png'}`);
    } else {
      const today = new Date();
      const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      outAbs = path.join(workspace, `${stamp}-images`, `edited-${Date.now()}.png`);
    }
    const outDir = path.dirname(outAbs);
    const outBase = outAbs.replace(/\.[^.]+$/, '');
    const outExt = outAbs.match(/\.[^.]+$/)?.[0] || '.png';
    await fs.mkdir(outDir, { recursive: true });
    /* edit_image 不做缓存: 输入含源图 (每次可能不同), 缓存键不好定, 而且改图本来
     * 就是一次性动作, 命中率接近 0。 */
    const savedPaths: string[] = [];
    for (let i = 0; i < result.data.length; i++) {
      const item = result.data[i]!;
      const filename = result.data.length === 1 ? outAbs : `${outBase}-${i + 1}${outExt}`;
      if (item.b64Json) {
        await fs.writeFile(filename, Buffer.from(item.b64Json, 'base64'));
      } else if (item.url) {
        const resp = await fetch(item.url);
        if (!resp.ok) {
          return JSON.stringify({ error: `download url failed: ${resp.status}` });
        }
        await fs.writeFile(filename, Buffer.from(await resp.arrayBuffer()));
      } else {
        return JSON.stringify({ error: `image[${i}] has neither b64_json nor url` });
      }
      savedPaths.push(filename);
    }

    return JSON.stringify({
      success: true,
      paths: savedPaths,
      count: savedPaths.length,
      model: result.model,
      mode: result.mode,
      latencyMs: result.usage?.latencyMs,
      hint: savedPaths.length === 1
        ? `Edited image saved. Preview: open_surface({kind:'image', source:{type:'file', path:'${savedPaths[0]}'}}).`
        : `${savedPaths.length} variants saved.`,
    });
  },
};

export const IMAGE_GEN_TOOLS = [generateImageTool, editImageTool];
