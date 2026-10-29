import type { SearchFileMatch, SearchReadHint } from './contentSearchOutput.js';

export type SearchMetadataMatch = {
  file: string;
  line: number;
  column?: number;
  preview: string;
  queryId: string;
};

type BuildSearchContentResultsArgs = {
  matchStore: Map<string, Map<number, { line: string; queryIds: Set<string>; column?: number }>>;
  fileQueryHits: Map<string, Set<string>>;
  requiredQueryIds: Set<string>;
  notMatchers: RegExp[];
  maxMatches: number;
  countOnly: boolean;
  suggestedNumLines: number;
  formatDisplayPath: (absPath: string) => string;
  throwIfAborted: () => void;
  yieldToEventLoop: () => Promise<void>;
  yieldEvery: number;
};

export async function buildSearchContentResults({
  matchStore,
  fileQueryHits,
  requiredQueryIds,
  notMatchers,
  maxMatches,
  countOnly,
  suggestedNumLines,
  formatDisplayPath,
  throwIfAborted,
  yieldToEventLoop,
  yieldEvery,
}: BuildSearchContentResultsArgs): Promise<{
  results: SearchFileMatch[];
  totalMatches: number;
  filesWithMatches: number;
  readHints: SearchReadHint[];
  metadataMatches: SearchMetadataMatch[];
}> {
  const results: SearchFileMatch[] = [];
  let totalMatches = 0;
  let filesWithMatches = 0;
  const readHints: SearchReadHint[] = [];
  const metadataMatches: SearchMetadataMatch[] = [];

  let resultEntryCount = 0;
  for (const [filePath, lineMap] of matchStore.entries()) {
    throwIfAborted();
    if (totalMatches >= maxMatches && !countOnly) break;
    resultEntryCount++;
    if (resultEntryCount % yieldEvery === 0) {
      await yieldToEventLoop();
    }
    const queryHits = fileQueryHits.get(filePath) || new Set<string>();
    let hasAllRequired = true;
    requiredQueryIds.forEach(id => {
      if (!queryHits.has(id)) {
        hasAllRequired = false;
      }
    });
    if (!hasAllRequired) continue;

    const matchedLineNums = Array.from(lineMap.keys()).sort((a, b) => a - b);
    const filteredLineNums = matchedLineNums.filter(lineNum => {
      const entry = lineMap.get(lineNum);
      if (!entry) return false;
      if (entry.queryIds.size === 0) return false;
      return !notMatchers.some(regex => regex.test(entry.line));
    });

    if (filteredLineNums.length === 0) continue;
    filesWithMatches++;
    totalMatches += filteredLineNums.length;

    const relPath = formatDisplayPath(filePath);
    readHints.push({
      file: relPath,
      anchor_lines: filteredLineNums.slice(0, 20),
      num_lines: suggestedNumLines,
    });

    if (countOnly) {
      results.push({
        file: filePath,
        matches: [],
        matchCount: filteredLineNums.length,
      });
      continue;
    }

    throwIfAborted();
    const fileMatches: SearchFileMatch['matches'] = [];
    const allLineNums = Array.from(lineMap.keys()).sort((a, b) => a - b);

    allLineNums.forEach(lineNum => {
      const entry = lineMap.get(lineNum);
      if (!entry) return;

      const isMatch = filteredLineNums.includes(lineNum);
      fileMatches.push({
        lineNum,
        line: entry.line,
        isMatch,
      });

      if (isMatch && metadataMatches.length < maxMatches) {
        for (const queryId of entry.queryIds) {
          metadataMatches.push({
            file: relPath,
            line: lineNum,
            column: entry.column,
            preview: entry.line,
            queryId,
          });
          if (metadataMatches.length >= maxMatches) break;
        }
      }
    });

    results.push({
      file: filePath,
      matches: fileMatches,
      matchCount: filteredLineNums.length,
    });
  }

  return {
    results,
    totalMatches,
    filesWithMatches,
    readHints,
    metadataMatches,
  };
}
