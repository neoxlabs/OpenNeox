import type { IdentifierUsageInput, SymbolInput } from '../../../ide/semantic/symbolStore/SymbolStore.js';

export interface IndexingChunkSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature?: string;
  containerName?: string;
}

export interface IndexingEmbeddingChunk {
  startLine: number;
  endLine: number;
  text: string;
  terms: Array<{ term: string; tf: number }>;
  relatedSymbols: IndexingChunkSymbol[];
}

export interface SemanticParseTask {
  kind: 'semantic-parse';
  payload: {
    path: string;
    content: string;
    language: string;
  };
}

export interface EmbeddingPreprocessTask {
  kind: 'embedding-preprocess';
  payload: {
    content: string;
    relatedSymbols: IndexingChunkSymbol[];
  };
}

export interface WorkspaceAuditScanTask {
  kind: 'workspace-audit';
  payload: {
    workspaceRoot: string;
    ignore: string[];
  };
}

export type IndexingCpuTask = SemanticParseTask | EmbeddingPreprocessTask | WorkspaceAuditScanTask;

export interface SemanticParseResult {
  symbols: SymbolInput[];
  usages: IdentifierUsageInput[];
  hasErrors: boolean;
}

export interface EmbeddingPreprocessResult {
  chunks: IndexingEmbeddingChunk[];
}

export interface WorkspaceAuditScanFile {
  relPath: string;
  size: number;
  mtime: number;
}

export interface WorkspaceAuditScanResult {
  files: WorkspaceAuditScanFile[];
}

export type IndexingCpuResult = SemanticParseResult | EmbeddingPreprocessResult | WorkspaceAuditScanResult;

export interface WorkerRequest {
  jobId: number;
  task: IndexingCpuTask;
}

export interface WorkerSuccessMessage {
  jobId: number;
  ok: true;
  result: IndexingCpuResult;
}

export interface WorkerErrorMessage {
  jobId: number;
  ok: false;
  error: string;
}

export type WorkerResponse = WorkerSuccessMessage | WorkerErrorMessage;
