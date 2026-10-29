import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseFilesWritten } from '../tools/shell/shellFileChanges.js';

export async function forEachShellWrittenFile(
  output: string,
  workDir: string,
  emit: (absPath: string, content: string) => Promise<void>,
): Promise<void> {
  for (const rel of parseFilesWritten(output)) {
    const abs = path.resolve(workDir, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile() || st.size > 200_000) continue;
    const content = await fs.readFile(abs, 'utf-8').catch(() => null);
    if (content === null || content.includes('\0')) continue;
    await emit(abs, content);
  }
}

export function writeFileTargets(args: Record<string, any> | undefined | null): Array<{ file_path: string; content: string }> {
  if (!args) return [];
  if (Array.isArray(args.files)) {
    return args.files
      .filter((f: any) => f && typeof f.file_path === 'string' && typeof f.content === 'string')
      .map((f: any) => ({ file_path: f.file_path, content: f.content }));
  }
  const single = args.file_path || args.filePath || args.path;
  return typeof single === 'string' && typeof args.content === 'string' && args.content
    ? [{ file_path: single, content: args.content }]
    : [];
}
