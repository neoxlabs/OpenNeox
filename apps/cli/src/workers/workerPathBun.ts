/** Bun-only worker path adapter. The file import attribute bundles the CLI
 * worker entry and returns its runtime path. Callers load this module only
 * behind a Bun runtime guard; Node uses the core worker adapter. */
// @ts-expect-error — bun 特有 import attribute type:'file', TS/tsc 不认, 运行时只 bun 加载
import workerFilePath from './runtimeWorkerEntry.ts' with { type: 'file' };

export default workerFilePath as string;
