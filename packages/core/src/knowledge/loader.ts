/**
 * Knowledge loader — 解析知识卡 Markdown (frontmatter + 正文)
 *
 * 容错优先: title/description 缺失按文件名/正文首行兜底, 绝不因格式不完美拒载
 * (对齐设计 §1.2 — 对不完美格式鲁棒)。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KnowledgeCard, KnowledgeCardMeta, KnowledgeOrigin, KnowledgeTrust } from './types.js';

/* 单卡正文注入/索引用的软上限 — 超长卡不截断存储, 只影响 L2 注入时的截断 */
export const MAX_CARD_BODY_CHARS = 4000;

// ============================================================================
// Frontmatter 解析 (与 skills/loader.ts 同风格的简易 YAML — 标量/内联数组/破折号列表)
// ============================================================================

export function parseCardFrontmatter(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  /* 带 UTF-8 BOM (Windows 记事本) 的卡原来整个 frontmatter 认不出: 标题退成文件名, 描述
   * 退成 "--", frontmatter 原文进了正文, always/trust/paths 全部失效。先去 BOM、归一化换行。 */
  const BOM = String.fromCharCode(0xfeff);
  const normalized = (content.startsWith(BOM) ? content.slice(1) : content).replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, unknown> = {};
  let currentKey = '';

  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const trimmed = line.trim();

    /* 破折号列表项 — 归属最近的 key */
    if (trimmed.startsWith('- ')) {
      const value = stripQuotes(trimmed.slice(2).trim());
      if (currentKey) {
        if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
        (meta[currentKey] as string[]).push(value);
      }
      continue;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex <= 0) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    currentKey = key;

    if (value === '') {
      /* 后续破折号列表 */
      meta[key] = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => stripQuotes(v.trim()))
        .filter(Boolean);
    } else {
      meta[key] = stripQuotes(value);
    }
  }

  return { meta, body: match[2] };
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

// ============================================================================
// 卡片加载
// ============================================================================

function toStringArray(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const arr = raw.map((v) => String(v).trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const arr = raw.split(',').map((v) => v.trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}

/** 正文首个非空行做 description 兜底 (去 markdown 标记, 截 120 字) */
function deriveDescription(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim().replace(/^#+\s*/, '').replace(/^[>*-]\s*/, '').trim();
    if (t) return t.length > 120 ? `${t.slice(0, 120)}…` : t;
  }
  return '(无描述)';
}

export function loadCardFile(
  filePath: string,
  rootDir: string,
  origin: KnowledgeOrigin,
  workDir?: string,
): KnowledgeCard | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  const { meta: rawMeta, body } = parseCardFrontmatter(raw);
  const trimmedBody = body.trim();
  const relFromRoot = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const id = relFromRoot.replace(/\.md$/i, '');

  const trustRaw = rawMeta.trust;
  const trust: KnowledgeTrust | undefined =
    trustRaw === 'draft' || trustRaw === 'verified' ? trustRaw : undefined;

  const meta: KnowledgeCardMeta = {
    title:
      (typeof rawMeta.title === 'string' && rawMeta.title.trim()) ||
      path.basename(filePath, path.extname(filePath)),
    description:
      (typeof rawMeta.description === 'string' && rawMeta.description.trim()) ||
      deriveDescription(trimmedBody),
    source: typeof rawMeta.source === 'string' && rawMeta.source.trim() ? rawMeta.source.trim() : undefined,
    paths: toStringArray(rawMeta.paths),
    keywords: toStringArray(rawMeta.keywords),
    trust,
    always: rawMeta.always === true || rawMeta.always === 'true' || undefined,
    updated: typeof rawMeta.updated === 'string' && rawMeta.updated.trim() ? rawMeta.updated.trim() : undefined,
  };

  /* workspace 卡给 workDir 相对路径 (LLM readfile 直接可用), 其余用绝对路径 */
  const displayPath =
    origin === 'workspace' && workDir
      ? path.relative(workDir, filePath).replace(/\\/g, '/')
      : filePath;

  return { id, filePath, displayPath, origin, meta, body: trimmedBody };
}

/**
 * 递归扫描目录下所有知识卡。
 * 跳过: `_` 前缀的文件/目录 (草稿区)、非 .md、隐藏目录。
 */
export function loadCardsFromDir(
  rootDir: string,
  origin: KnowledgeOrigin,
  workDir?: string,
): KnowledgeCard[] {
  const cards: KnowledgeCard[] = [];
  if (!fs.existsSync(rootDir)) return cards;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const card = loadCardFile(full, rootDir, origin, workDir);
        if (card) cards.push(card);
      }
    }
  };

  walk(rootDir);
  return cards;
}
