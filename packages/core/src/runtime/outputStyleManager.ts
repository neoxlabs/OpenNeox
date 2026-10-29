
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';

export type BuiltinOutputStyle = 'standard' | 'concise' | 'detailed' | 'code_only';

export interface OutputStyleInfo {
  /** 内置档是 id 本身; 自定义是 `custom:<名字>` */
  id: string;
  name: string;
  description: string;
  builtin: boolean;
}

const BUILTIN: Record<BuiltinOutputStyle, { name: string; description: string; prompt: string }> = {
  standard: {
    name: 'Standard',
    description: 'Balanced: the result, key reasoning, and what changed.',
    prompt: '',
  },
  concise: {
    name: 'Concise',
    description: 'Shortest useful answer. Result first, no recap.',
    prompt: `## Reply style: concise
- Lead with the result or the answer. No preamble, no closing recap of what you already said.
- Report outcomes and decisions, not each step you took. One sentence beats three.
- Keep full detail for errors, failing output, security warnings and anything the user must act on.
- When the user explicitly asks for an explanation or detail, give it in full.`,
  },
  detailed: {
    name: 'Detailed',
    description: 'Explains the why, trade-offs and alternatives.',
    prompt: `## Reply style: detailed
- Explain why, not only what: the reasoning behind each decision and each change.
- When there are real alternatives, name them and the trade-off that decided it.
- Add the background a reader needs to follow along, assuming they want to understand, not just get a result.
- Still lead with the conclusion, then the explanation.`,
  },
  code_only: {
    name: 'Code only',
    description: 'Code and file paths, almost no prose.',
    prompt: `## Reply style: code only
- Replies are code blocks and file paths. Prose only where the code cannot speak for itself (one line at most).
- Several files: one block per file with its path as the header.
- Tool use is unaffected — this only shapes what you write to the user. Errors and questions to the user stay in plain words.`,
  },
};

export const BUILTIN_OUTPUT_STYLES: BuiltinOutputStyle[] = ['standard', 'concise', 'detailed', 'code_only'];

const CUSTOM_PREFIX = 'custom:';
const SAFE_NAME = /^[\w\-一-鿿 ]{1,64}$/;

function customDirs(workDir?: string): string[] {
  /* 项目在前: 同名时项目优先 */
  return [workDir ? join(workDir, '.neox', 'output-styles') : '', neoxHome('output-styles')].filter(Boolean);
}

/** frontmatter (--- … ---) 拆成字段 + 正文 */
function parseStyleFile(text: string): { name?: string; description?: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: text.trim() };
  const field = (k: string) => m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');
  return { name: field('name'), description: field('description'), body: m[2].trim() };
}

function readCustom(name: string, workDir?: string): { name?: string; description?: string; body: string } | null {
  if (!SAFE_NAME.test(name)) return null;
  for (const dir of customDirs(workDir)) {
    const file = join(dir, `${name}.md`);
    try {
      if (existsSync(file)) return parseStyleFile(readFileSync(file, 'utf8'));
    } catch { /* 读不了就看下一个目录 */ }
  }
  return null;
}

export function isBuiltinOutputStyle(id: string): id is BuiltinOutputStyle {
  return (BUILTIN_OUTPUT_STYLES as string[]).includes(id);
}

/** 内置 + 自定义, 给「+」菜单弹窗 / CLI 列表用 */
export function listOutputStyles(workDir?: string): OutputStyleInfo[] {
  const out: OutputStyleInfo[] = BUILTIN_OUTPUT_STYLES.map((id) => ({
    id, name: BUILTIN[id].name, description: BUILTIN[id].description, builtin: true,
  }));
  const seen = new Set<string>();
  for (const dir of customDirs(workDir)) {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const name = f.slice(0, -3);
      if (seen.has(name) || !SAFE_NAME.test(name)) continue;
      seen.add(name);
      const parsed = readCustom(name, workDir);
      if (!parsed?.body) continue;
      out.push({ id: `${CUSTOM_PREFIX}${name}`, name: parsed.name || name, description: parsed.description || '', builtin: false });
    }
  }
  return out;
}

/**
 * 这一档要追加进系统提示的那段。standard / 没配 / 自定义文件找不到 → 空串 (= 不追加)。
 * 找不到的自定义风格不报错: 文件被删了就退回标准, 别让一次对话因此发不出去。
 */
export function outputStylePrompt(id: string | undefined, workDir?: string): string {
  if (!id || id === 'standard') return '';
  if (isBuiltinOutputStyle(id)) return BUILTIN[id].prompt;
  if (id.startsWith(CUSTOM_PREFIX)) {
    const body = readCustom(id.slice(CUSTOM_PREFIX.length), workDir)?.body;
    return body ? `## Reply style: ${id.slice(CUSTOM_PREFIX.length)}\n${body}` : '';
  }
  return '';
}
