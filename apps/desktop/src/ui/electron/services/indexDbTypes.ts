
export interface IndexChunkSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature?: string;
  containerName?: string;
}

/** 一个待写入的 chunk —— 主线程算好交给 worker, worker 只管落库 */
export interface IndexPendingChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  terms: Array<{ term: string; tf: number }>;
  relatedSymbols: IndexChunkSymbol[];
}

export interface IndexSearchResult {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  relatedSymbols?: IndexChunkSymbol[];
}

export interface IndexStatus {
  fileCount: number;
  chunkCount: number;
  lastBuilt: number | null;
}

/** worker 支持的操作。参数/返回值一一对应 IndexDbClient 上的同名方法。 */
export type IndexDbOp =
  | { op: 'open'; dbPath: string }
  | { op: 'close' }
  | { op: 'listIndexedFiles' }
  | { op: 'getFileHashes'; relPaths: string[] }
  | { op: 'deleteFiles'; relPaths: string[] }
  | { op: 'insertChunks'; batch: IndexPendingChunk[] }
  | { op: 'setMeta'; key: string; value: string }
  | { op: 'search'; query: string; topK: number }
  | { op: 'status' }
  | { op: 'clear' };

export interface IndexDbRequest {
  id: number;
  payload: IndexDbOp;
}

export type IndexDbResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
