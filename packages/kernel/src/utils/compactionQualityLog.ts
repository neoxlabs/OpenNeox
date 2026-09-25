import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '../platform/neoxHome.js';

const COMPACTION_QUALITY_LOG_VERSION = 1;

function isCompactionQualityLogEnabled(): boolean {
  return process.env.NEOX_COMPACTION_DEBUG === '1'
    || process.env.NEOX_DUMP_COMPACTION === '1';
}

export function dumpCompactionQualityIfEnabled(record: Record<string, unknown>): string | undefined {
  if (!isCompactionQualityLogEnabled()) return undefined;

  try {
    const dir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'compaction-quality');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `compaction-quality-${day}.jsonl`);
    const payload = {
      version: COMPACTION_QUALITY_LOG_VERSION,
      timestamp: new Date().toISOString(),
      ...record,
    };

    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    // eslint-disable-next-line no-console
    console.error(`[COMPACTION_QUALITY] ${file}`);
    return file;
  } catch {
    return undefined;
  }
}
