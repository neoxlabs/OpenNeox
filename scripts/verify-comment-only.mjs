#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function normalizeOutput(output) {
  return output.split(/\r?\n/u).filter((line) => line.trim() !== '').join('\n');
}

export function transpile(source, fileName) {
  return normalizeOutput(ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      removeComments: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
    },
  }).outputText);
}

function modifiedTypeScriptFiles(base) {
  return git('diff', '--name-only', base, '--', '*.ts', '*.tsx', '*.css', '*.html')
    .split('\n')
    .filter(Boolean);
}

/* css / html 没有编译产物可比, 但它们的注释形态是固定的: 把注释整段抠掉、
 * 再把空白压平, 剩下的就是"代码本身"。改注释不该让这份结果有任何变化。 */
export function stripNonSource(source, fileName) {
  const withoutComments = fileName.endsWith('.html')
    ? source.replace(/<!--[\s\S]*?-->/gu, ' ').replace(/\/\*[\s\S]*?\*\//gu, ' ')
    : source.replace(/\/\*[\s\S]*?\*\//gu, ' ');
  return withoutComments.replace(/\s+/gu, ' ').trim();
}

export async function verifyFiles(base, files = modifiedTypeScriptFiles(base), cwd = process.cwd()) {
  const failures = [];
  for (const file of files) {
    const ext = extname(file);
    if (!['.ts', '.tsx', '.css', '.html'].includes(ext)) continue;
    let baseline;
    try {
      baseline = git('show', `${base}:${file}`);
    } catch {
      failures.push({ file, reason: `cannot read ${base}:${file}` });
      continue;
    }
    let current;
    try {
      current = await readFile(`${cwd}/${file}`, 'utf8');
    } catch {
      failures.push({ file, reason: 'cannot read working-tree file' });
      continue;
    }
    const compile = ext === '.css' || ext === '.html' ? stripNonSource : transpile;
    const before = compile(baseline, file);
    const after = compile(current, file);
    if (before !== after) failures.push({ file, reason: 'code changed, not just comments' });
  }
  return failures;
}

export async function main(argv = process.argv.slice(2)) {
  const base = argv[0]?.startsWith('--') || !argv[0] ? 'HEAD' : argv[0];
  const files = argv.filter((arg) => !arg.startsWith('--') && arg !== base);
  const failures = await verifyFiles(base, files.length ? files : undefined);
  if (failures.length === 0) {
    process.stdout.write('Comment-only verification passed.\n');
    return 0;
  }
  for (const failure of failures) process.stderr.write(`${failure.file}: ${failure.reason}\n`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
