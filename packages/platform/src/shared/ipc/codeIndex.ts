export interface IndexStats {
  hasIndex: boolean;
  fileCount: number;
  symbolCount: number;
  lastUpdated: string | null;
  size: number;
}

export interface IndexBuildProgress {
  current: number;
  total: number;
  file: string;
}

export interface IndexBuildResult {
  success: boolean;
  filesIndexed: number;
  symbolsFound: number;
  timeMs: number;
  errors: Array<{ file: string; error: string }>;
}

export type IndexSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'method'
  | 'variable'
  | 'type'
  | 'enum'
  | 'constant';

export interface IndexSymbolInfo {
  name: string;
  kind: IndexSymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  parent?: string;
}

export interface IndexSymbolSearchResult {
  symbol: IndexSymbolInfo;
  file: string;
  score: number;
}
