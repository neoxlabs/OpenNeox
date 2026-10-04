import path from 'path';
import {
  getModuleContext,
  matchRules,
  type ProjectMemoryV2Result,
} from '../projectMemoryV2.js';

export interface SimpleLivingMemoryOptions {
  workDir: string;
  query: string;
  projectMemory: ProjectMemoryV2Result | null;
  actionLog?: any;
  maxChars?: number;
}

function trimText(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function extractCandidatePaths(query: string): string[] {
  const matches = query.match(/[A-Za-z0-9_./\\-]+(?:\.[A-Za-z0-9_-]+)?/g) || [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of matches) {
    const value = raw.trim();
    if (!value || value.length < 3) continue;
    if (!/[/.\\-]/.test(value)) continue;
    if (/^(https?:|npm|node|vite|react)$/i.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= 6) break;
  }

  return result;
}

function extractKeywords(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_\u4e00-\u9fa5]+/)
        .map(item => item.trim())
        .filter(item => item.length >= 2),
    ),
  ).slice(0, 8);
}

function scoreKeyAgainstKeywords(key: string, keywords: string[]): number {
  const lower = key.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) score += keyword.length >= 4 ? 3 : 1;
  }
  return score;
}

function appendSection(sections: string[], title: string, content: string | null | undefined): void {
  const trimmed = content?.trim();
  if (!trimmed) return;
  sections.push(`## ${title}\n${trimmed}`);
}

export async function buildSimpleLivingMemoryContext(
  options: SimpleLivingMemoryOptions,
): Promise<string> {
  const { workDir, query, projectMemory, actionLog } = options;
  const maxChars = options.maxChars ?? 2400;
  const sections: string[] = [];
  const moduleSnippets = new Map<string, string>();
  const ruleSnippets = new Map<string, string>();
  const keywords = extractKeywords(query);

  if (projectMemory?.project) {
    appendSection(sections, '项目知识', trimText(projectMemory.project, 700));
  }

  const candidatePaths = extractCandidatePaths(query);
  for (const candidate of candidatePaths) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(workDir, candidate);
    const contextPath = path.extname(absolute) ? path.dirname(absolute) : absolute;
    const moduleContent = getModuleContext(projectMemory?.modules || new Map(), contextPath, workDir);
    if (moduleContent) {
      const moduleKey = path.relative(workDir, contextPath).replace(/\\/g, '/');
      moduleSnippets.set(moduleKey || candidate, trimText(moduleContent, 500));
    }

    const relativePath = path.relative(workDir, absolute).replace(/\\/g, '/');
    for (const rule of matchRules(projectMemory?.rules || new Map(), relativePath)) {
      ruleSnippets.set(rule.sourcePath, trimText(rule.content, 400));
    }
  }

  if (projectMemory && moduleSnippets.size === 0 && keywords.length > 0) {
    const rankedModules = Array.from(projectMemory.modules.entries())
      .map(([key, content]) => ({ key, content, score: scoreKeyAgainstKeywords(key, keywords) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    for (const item of rankedModules) {
      moduleSnippets.set(item.key, trimText(item.content, 500));
    }
  }

  if (projectMemory && ruleSnippets.size === 0 && keywords.length > 0) {
    const rankedRules = Array.from(projectMemory.rules.values())
      .map(rule => ({
        rule,
        score: scoreKeyAgainstKeywords(path.basename(rule.sourcePath, '.md'), keywords),
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    for (const item of rankedRules) {
      ruleSnippets.set(item.rule.sourcePath, trimText(item.rule.content, 400));
    }
  }

  if (moduleSnippets.size > 0) {
    const moduleLines = Array.from(moduleSnippets.entries())
      .slice(0, 2)
      .map(([key, content]) => `### ${key}\n${content}`)
      .join('\n\n');
    appendSection(sections, '相关模块', moduleLines);
  }

  if (ruleSnippets.size > 0) {
    const ruleLines = Array.from(ruleSnippets.entries())
      .slice(0, 2)
      .map(([sourcePath, content]) => `### ${path.basename(sourcePath, '.md')}\n${content}`)
      .join('\n\n');
    appendSection(sections, '相关规则', ruleLines);
  }

  if (actionLog) {
    try {
      const recall = await actionLog.getContextSummary({
        query: query.slice(0, 200),
        maxSessionItems: 4,
        maxMemoryItems: 4,
        maxChars: Math.min(1200, Math.max(400, Math.floor(maxChars / 2))),
        language: 'zh',
      });
      if (recall) appendSection(sections, '历史记忆', trimText(recall, 1200));
    } catch {
      // ignore memory recall failures
    }
  }

  if (sections.length === 0) return '';
  return trimText(sections.join('\n\n'), maxChars);
}
