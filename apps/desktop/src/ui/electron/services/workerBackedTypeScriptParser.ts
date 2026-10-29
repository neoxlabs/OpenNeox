import type { LanguageParser, ParseInput, ParseResult } from '../../../ide/semantic/parsers/Parser.js';
import { getIndexingCpuPool } from './indexingCpuPool.js';

export class WorkerBackedTypeScriptParser implements LanguageParser {
  readonly languages = [
    'typescript',
    'typescriptreact',
    'javascript',
    'javascriptreact',
  ] as const;

  get maxConcurrency(): number {
    return getIndexingCpuPool().getConcurrency();
  }

  async init(): Promise<void> {
    return Promise.resolve();
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const result = await getIndexingCpuPool().run({
      kind: 'semantic-parse',
      payload: {
        path: input.path,
        content: input.content,
        language: input.language,
      },
    });
    return result as ParseResult;
  }
}
