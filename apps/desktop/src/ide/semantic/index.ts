
export { SemanticService } from './SemanticService.js';
export type {
  SemanticBootstrapPlan,
  SemanticServiceOptions,
  SemanticFileSystemPort,
} from './SemanticService.js';

export { SymbolStore } from './symbolStore/SymbolStore.js';
export type {
  SqliteDatabase,
  SqliteStatement,
  SymbolInput,
  IdentifierUsageInput,
  IdentifierUsage,
} from './symbolStore/SymbolStore.js';
export {
  CURRENT_SCHEMA_VERSION,
  INITIAL_SCHEMA_SQL,
  MIGRATIONS,
} from './symbolStore/schema.js';
export type { SchemaMigration } from './symbolStore/schema.js';

export { FileIndex, basenameOf } from './fileIndex/FileIndex.js';
export type { FileEntry } from './fileIndex/FileIndex.js';

export {
  fuzzyMatch,
  fuzzyFilter,
  NO_MATCH,
} from './fuzzy/FuzzyMatcher.js';
export type { FuzzyResult, FuzzyMatchOptions } from './fuzzy/FuzzyMatcher.js';

export { languageFromPath, isContainerKind } from './parsers/Parser.js';
export type {
  LanguageParser,
  ParseInput,
  ParseResult,
} from './parsers/Parser.js';
export { TypeScriptParser } from './parsers/TypeScriptParser.js';

export {
  SEMANTIC_TOPIC,
  SEMANTIC_SERVICE,
} from './types.js';
export type {
  SymbolKind,
  Position,
  Range,
  FileLocation,
  SymbolInfo,
  FileInfo,
  ReferenceInfo,
  CompletionItem,
  Definition,
  PaletteItem,
  IndexingState,
  IndexingProgress,
  SemanticEvents,
} from './types.js';
