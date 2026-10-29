
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { isBuiltinStyle, registerStyleSpec } from '@neoxlabs/pptx-compose';
import { extractStyleFromPptx } from './importStyle.js';
import { saveImportedStyle } from './styleLibrary.js';

const MAX_BYTES = 200 * 1024 * 1024;

function resolvePath(p: string): string {
  const workspace = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
  return path.isAbsolute(p) ? p : path.join(workspace, p);
}

export const importStyleTool: Tool = {
  name: 'import_style',
  description: `Extract the visual style from a .pptx the user already has, and register it as a reusable styleId.

Use this when the user says "按我们公司上次那版做 / 用上次那份的风格 / 照这个模板的配色" and gives (or has) an existing deck:
1. import_style({ file_path: "公司模板.pptx" }) → returns { styleId, extracted }
2. deck_begin({ title, outline, styleId: <that id> }) → every page is built in that style

What is extracted: paper/ink/accent colors (theme color scheme + the colors actually used on slides), fonts (major/minor latin+east), motif (chevron / ribbon / capsule / line / none), corner radii, type scale and page margins.
Limits (honest): master-slide logos and layout placeholders are NOT imported (that is a separate item); if the source deck is not 16:9 the style is still usable but the generated deck stays 16:9. Fonts without local metrics are substituted and reported in notes — the substitution is used for both measurement and export so layout stays consistent.
The style is saved in the workspace under .neox/pptx-styles/ and survives across sessions.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },

  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '.pptx path (absolute or workspace-relative) to extract the style from' },
      style_id: {
        type: 'string',
        description: 'Optional styleId to use (lowercase letters/digits/hyphens). Default: generated as imported-<name>-<hash>, stable for the same deck.',
      },
      name: { type: 'string', description: 'Optional display name, e.g. "XX 公司模板". Default: source file name.' },
      suited_for: { type: 'string', description: 'Optional one-line note on when this style fits.' },
    },
    required: ['file_path'],
  },

  async function(args: {
    file_path?: string;
    style_id?: string;
    name?: string;
    suited_for?: string;
  }): Promise<string> {
    const workspace = getWorkspaceRootFromContext();
    if (!workspace) {
      return JSON.stringify({
        error: 'workspaceContext 未绑定 (runner 每回合应通过 AsyncLocalStorage 注入). 这是 runtime 问题, 不是参数问题.',
      });
    }
    if (!args?.file_path || typeof args.file_path !== 'string') {
      return JSON.stringify({ error: 'file_path 必填 (.pptx 路径)' });
    }

    const abs = resolvePath(args.file_path);
    if (!fs.existsSync(abs)) return JSON.stringify({ error: `文件不存在: ${abs}` });
    if (!/\.pptx$/i.test(abs)) {
      return JSON.stringify({
        error: `只支持 .pptx (收到 ${path.extname(abs) || '无扩展名'})。.ppt 请先在 PowerPoint/WPS 里另存为 .pptx。`,
      });
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return JSON.stringify({ error: `不是文件: ${abs}` });
    if (stat.size > MAX_BYTES) return JSON.stringify({ error: `文件太大 (${Math.round(stat.size / 1024 / 1024)} MB), 上限 200 MB` });
    if (stat.size < 1024) return JSON.stringify({ error: `文件只有 ${stat.size} 字节, 不像一份完整的 .pptx` });

    const wantedId = args.style_id?.trim();
    if (wantedId && isBuiltinStyle(wantedId)) {
      return JSON.stringify({
        error: `style_id "${wantedId}" 是内置风格, 不能覆盖。换一个名字, 或省略 style_id 让工具自动生成。`,
      });
    }

    try {
      const bytes = new Uint8Array(fs.readFileSync(abs));
      const { spec, report } = await extractStyleFromPptx(bytes, {
        styleId: wantedId,
        displayName: args.name,
        suitedFor: args.suited_for,
        sourceName: path.basename(abs),
      });

      registerStyleSpec(spec);
      const savedTo = await saveImportedStyle(workspace, spec, { path: abs });

      return JSON.stringify({
        ok: true,
        styleId: spec.id,
        displayName: spec.displayName,
        savedTo,
        source: report.source,
        extracted: {
          colorSource: report.colorSource,
          colors: report.colors,
          fonts: {
            displayLatin: report.fonts.displayLatin,
            displayEast: report.fonts.displayEast,
            textLatin: report.fonts.textLatin,
            textEast: report.fonts.textEast,
            numeric: report.fonts.numeric,
          },
          fontSubstitutions: report.fonts.substitutions,
          motif: report.motif,
          radius: report.radius,
          type: report.type.value,
          grid: report.grid,
        },
        ...(report.notes.length ? { notes: report.notes } : {}),
        next: `deck_begin({ title, outline, styleId: "${spec.id}" }) —— 每一页都会按这份稿子的配色/字体/形态生成。`,
      });
    } catch (e) {
      return JSON.stringify({
        error: `抽不出风格: ${e instanceof Error ? e.message : String(e)}`,
        hint: '确认这份 .pptx 能在 PowerPoint/WPS 里正常打开; 加密文件或 .ppt 老格式不支持。',
      });
    }
  },
};
