import { parentPort } from 'worker_threads';
import glob from 'fast-glob';
import { TypeScriptParser } from '../../../ide/semantic/parsers/TypeScriptParser.js';
/* 分词只有一份 —— 索引侧和搜索侧不一致会让搜索静默返回 0 结果, 见该文件头注释 */
import { tokenize } from '../services/indexTokenize.js';
import type {
  EmbeddingPreprocessTask,
  IndexingChunkSymbol,
  IndexingCpuTask,
  SemanticParseTask,
  WorkerRequest,
  WorkspaceAuditScanTask,
} from '../services/indexingCpuTypes.js';

const parser = new TypeScriptParser();


function chunkFile(content: string): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = content.split('\n');
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && chars < 1600) chars += lines[end++].length + 1;
    const text = lines.slice(start, end).join('\n');
    if (text.trim()) chunks.push({ startLine: start + 1, endLine: end, text });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - 3);
  }
  return chunks;
}

function computeTerms(text: string): Array<{ term: string; tf: number }> {
  const freq: Record<string, number> = Object.create(null);
  const tokens = tokenize(text);
  for (const token of tokens) freq[token] = (freq[token] ?? 0) + 1;
  const total = tokens.length || 1;
  return Object.entries(freq)
    .map(([term, count]) => ({ term, tf: count / total }))
    .filter((entry) => entry.term.length > 0 && Number.isFinite(entry.tf) && entry.tf > 0);
}

function selectChunkSymbols(symbols: IndexingChunkSymbol[], startLine: number, endLine: number): IndexingChunkSymbol[] {
  return symbols.filter((symbol) => symbol.startLine <= endLine && symbol.endLine >= startLine)
    .sort((left, right) => (right.endLine - right.startLine) - (left.endLine - left.startLine))
    .slice(0, 4);
}

async function runSemantic(task: SemanticParseTask) {
  await parser.init();
  return parser.parse(task.payload);
}

async function runEmbedding(task: EmbeddingPreprocessTask) {
  return {
    chunks: chunkFile(task.payload.content).map((chunk) => ({
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      terms: computeTerms(chunk.text),
      relatedSymbols: selectChunkSymbols(task.payload.relatedSymbols, chunk.startLine, chunk.endLine),
    })),
  };
}

async function runWorkspaceAudit(task: WorkspaceAuditScanTask) {
  const files = (await glob('**/*', {
    cwd: task.payload.workspaceRoot,
    ignore: task.payload.ignore,
    dot: true,
    onlyFiles: true,
    suppressErrors: true,
    stats: true,
    followSymbolicLinks: false,
  })) as Array<{ path: string; stats: { size: number; mtimeMs: number } }>;
  return {
    files: files.map((entry) => ({
      relPath: entry.path.replace(/\\/g, '/').replace(/^\.\//, ''),
      size: entry.stats.size,
      mtime: entry.stats.mtimeMs,
    })),
  };
}

async function runTask(task: IndexingCpuTask) {
  switch (task.kind) {
    case 'semantic-parse':
      return runSemantic(task);
    case 'embedding-preprocess':
      return runEmbedding(task);
    case 'workspace-audit':
      return runWorkspaceAudit(task);
    default:
      throw new Error(`unsupported indexing task: ${(task as { kind?: string }).kind ?? 'unknown'}`);
  }
}

parentPort?.on('message', async (message: WorkerRequest) => {
  try {
    const result = await runTask(message.task);
    parentPort?.postMessage({ jobId: message.jobId, ok: true, result });
  } catch (error) {
    parentPort?.postMessage({
      jobId: message.jobId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
