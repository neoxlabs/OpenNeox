/**
 * Knowledge documents — 资料文件引用清单 (manifest)
 *
 * 知识库页面导入的原始文档 (PDF/Word/MD/...) **只登记路径引用, 不拷贝内容**
 * (空间成本 ≈ 0, 文件永远最新; 拷贝语义留给以后的云盘)。
 *
 * 落盘位置 = knowledge 目录下的 documents.json:
 *   ~/.neox[/users/<uid>]/knowledge/documents.json — default / scratch 集合
 *   {workspace}/.neox/knowledge/documents.json — project 集合
 *
 * agent 侧: KnowledgeRegistry 加载 manifest → 文档出现在 L0 索引 (文件名+原路径),
 * agent 用 readfile / pdf / word 工具直接读原文件; 消化成卡片是可选升级 (/kb add)。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type KnowledgeDocCollection = 'default' | 'project' | 'scratch';

export interface KnowledgeDocumentEntry {
  id: string;
  /** 文件名 (含扩展名) */
  name: string;
  /** 原文件绝对路径 — 唯一的内容真源 */
  path: string;
  /** 登记时的 size/mtime — 用于失效/变更检测 */
  size: number;
  mtimeMs: number;
  collection: KnowledgeDocCollection;
  importedAt: number;
  /** 解析缓存 id (sha256) — 导入时经 documentParseClient 解析出的 markdown,
   *  存 ~/.neox/documents/<fileId>.md。docx/xlsx 等本地无解析器的格式靠它
   *  获得内容检索 + read_document 文本读取; 可缺 (纯路径引用)。 */
  fileId?: string;
}

/** manifest 条目 + 实时 stat 结果 */
export interface KnowledgeDocumentStatus extends KnowledgeDocumentEntry {
  /** 原文件已不存在 (被移动/删除) */
  missing: boolean;
  /** 原文件比登记时新 (内容可能已变) */
  modified: boolean;
}

const MANIFEST_NAME = 'documents.json';

interface ManifestShape {
  version: 1;
  documents: KnowledgeDocumentEntry[];
}

export function manifestPathFor(knowledgeDir: string): string {
  return path.join(knowledgeDir, MANIFEST_NAME);
}

export function loadDocumentManifest(knowledgeDir: string): KnowledgeDocumentEntry[] {
  try {
    const raw = fs.readFileSync(manifestPathFor(knowledgeDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ManifestShape>;
    if (!Array.isArray(parsed.documents)) return [];
    return parsed.documents.filter(isValidEntry);
  } catch {
    return [];
  }
}

export function saveDocumentManifest(knowledgeDir: string, documents: KnowledgeDocumentEntry[]): void {
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const shape: ManifestShape = { version: 1, documents };
  fs.writeFileSync(manifestPathFor(knowledgeDir), JSON.stringify(shape, null, 2), 'utf-8');
}

/** manifest 条目 + 实时 stat → 失效/变更状态 */
export function statDocuments(entries: KnowledgeDocumentEntry[]): KnowledgeDocumentStatus[] {
  return entries.map((entry) => {
    try {
      const stat = fs.statSync(entry.path);
      return {
        ...entry,
        missing: false,
        modified: Math.abs(stat.mtimeMs - entry.mtimeMs) > 1 || stat.size !== entry.size,
      };
    } catch {
      return { ...entry, missing: true, modified: false };
    }
  });
}

function isValidEntry(e: unknown): e is KnowledgeDocumentEntry {
  if (!e || typeof e !== 'object') return false;
  const entry = e as Partial<KnowledgeDocumentEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.path === 'string' &&
    path.isAbsolute(entry.path)
  );
}
