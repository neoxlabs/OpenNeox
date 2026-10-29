
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_STYLE_SPEC,
  getStyleSpec,
  registerStyleSpec,
  type StyleSpec,
} from '@neoxlabs/pptx-compose';

export const STYLE_LIBRARY_DIR = path.join('.neox', 'pptx-styles');

/** 跟 importStyle 的校验一致: 小写字母/数字/连字符, 防路径穿越 */
const STYLE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const MOTIFS = new Set(['chevron', 'ribbon', 'capsule', 'line', 'none']);
const FONT_ROLES = ['displayLatin', 'displayEast', 'textLatin', 'textEast', 'numeric'] as const;

export function styleFilePath(workspace: string, styleId: string): string | null {
  if (!STYLE_ID_RE.test(styleId)) return null;
  return path.join(workspace, STYLE_LIBRARY_DIR, `${styleId}.json`);
}

/** 落盘一份导入风格。返回写到的绝对路径。 */
export async function saveImportedStyle(
  workspace: string,
  spec: StyleSpec,
  source?: { path?: string; importedAt?: string },
): Promise<string> {
  const file = styleFilePath(workspace, spec.id);
  if (!file) throw new Error(`非法的 styleId: ${spec.id}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = {
    version: 1,
    spec,
    source: { ...source, importedAt: source?.importedAt ?? new Date().toISOString() },
  };
  await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * 读盘上的导入风格并注册进运行时表。
 * 文件不存在 / JSON 损坏 / 字段不合法 → null (调用方回"未知 styleId", 不抛)。
 */
export async function loadImportedStyle(workspace: string, styleId: string): Promise<StyleSpec | null> {
  const file = styleFilePath(workspace, styleId);
  if (!file) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const spec = validateSpec((raw as { spec?: unknown })?.spec ?? raw);
  if (!spec) return null;
  registerStyleSpec(spec);
  return spec;
}

/** 内置优先, 其次 workspace 里导入过的。deck_begin 的 styleId 解析走这里。 */
export async function resolveStyleSpec(workspace: string, styleId: string): Promise<StyleSpec | undefined> {
  const builtin = getStyleSpec(styleId);
  if (builtin) return builtin;
  return (await loadImportedStyle(workspace, styleId)) ?? undefined;
}

/** workspace 里已导入的 styleId (错误提示里列出来, 模型才知道自己有哪些可选) */
export async function listImportedStyleIds(workspace: string): Promise<string[]> {
  try {
    const names = await fs.readdir(path.join(workspace, STYLE_LIBRARY_DIR));
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((id) => STYLE_ID_RE.test(id))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 结构校验 —— 盘上的 JSON 可能被手改坏, 也可能来自旧版本。
 * 只校验渲染管线真正会读的字段, 缺的可选字段用默认值补齐。
 */
export function validateSpec(value: unknown): StyleSpec | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === 'string' ? v.id : '';
  if (!STYLE_ID_RE.test(id)) return null;

  const theme = v.theme as Record<string, unknown> | undefined;
  if (!theme || typeof theme !== 'object') return null;
  const colors = ['paper', 'ink', 'muted', 'subtle', 'accent', 'accentSoft', 'accentDeep', 'onInk', 'surface'];
  for (const key of colors) {
    if (typeof theme[key] !== 'string' || !HEX_RE.test(theme[key] as string)) return null;
  }
  const fontsIn = theme.fonts as Record<string, unknown> | undefined;
  if (!fontsIn || typeof fontsIn !== 'object') return null;
  const fonts: Record<string, string> = {};
  for (const role of FONT_ROLES) {
    const fam = fontsIn[role];
    if (typeof fam !== 'string' || !fam.trim()) return null;
    fonts[role] = fam;
  }

  const motif = typeof v.motif === 'string' && MOTIFS.has(v.motif) ? v.motif : 'none';
  const base = DEFAULT_STYLE_SPEC;

  return {
    id,
    displayName: typeof v.displayName === 'string' && v.displayName.trim() ? v.displayName : id,
    suitedFor: typeof v.suitedFor === 'string' ? v.suitedFor : '',
    theme: {
      id: typeof theme.id === 'string' ? theme.id : `${id}-theme`,
      name: typeof theme.name === 'string' ? theme.name : id,
      paper: theme.paper as string,
      ink: theme.ink as string,
      muted: theme.muted as string,
      subtle: theme.subtle as string,
      accent: theme.accent as string,
      accentSoft: theme.accentSoft as string,
      accentDeep: theme.accentDeep as string,
      onInk: theme.onInk as string,
      surface: theme.surface as string,
      fonts: {
        displayLatin: fonts.displayLatin!,
        displayEast: fonts.displayEast!,
        textLatin: fonts.textLatin!,
        textEast: fonts.textEast!,
        numeric: fonts.numeric!,
      },
    },
    motif: motif as StyleSpec['motif'],
    radius: (v.radius && typeof v.radius === 'object' ? v.radius : base.radius) as StyleSpec['radius'],
    type: (v.type && typeof v.type === 'object' ? v.type : base.type) as StyleSpec['type'],
    grid: (v.grid && typeof v.grid === 'object' ? v.grid : base.grid) as StyleSpec['grid'],
    imagery: (v.imagery && typeof v.imagery === 'object' ? v.imagery : base.imagery) as StyleSpec['imagery'],
    motion: (v.motion && typeof v.motion === 'object' ? v.motion : base.motion) as StyleSpec['motion'],
    ...(v.ornament === 'guilloche' ? { ornament: 'guilloche' as const } : {}),
  };
}
