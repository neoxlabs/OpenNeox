#!/usr/bin/env tsx
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzeAnthropicCachePayload,
  formatAnthropicCachePayloadAnalysis,
} from '../packages/kernel/src/utils/anthropicCachePayloadAnalysis.js';

interface Args {
  target?: string;
  json: boolean;
  write: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, write: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--write') {
      args.write = true;
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (!args.target) {
      args.target = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return args;
}

function defaultDumpDir(): string {
  return path.join(os.homedir(), '.neox', 'logs', 'llm-requests');
}

function isPayloadFile(file: string): boolean {
  const base = path.basename(file);
  return base.startsWith('payload-anthropic-')
    && base.endsWith('.json')
    && !base.endsWith('.cache-analysis.json');
}

function findLatestPayload(dir: string): string {
  if (!fs.existsSync(dir)) {
    throw new Error(`Dump directory does not exist: ${dir}`);
  }

  const candidates = fs.readdirSync(dir)
    .filter(isPayloadFile)
    .map(file => path.join(dir, file))
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`No payload-anthropic-*.json files found in ${dir}`);
  }

  return candidates[0].file;
}

function resolveTarget(target?: string): string {
  if (!target) return findLatestPayload(defaultDumpDir());

  const resolved = path.resolve(target);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return findLatestPayload(resolved);
  return resolved;
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/analyze-anthropic-cache-payload.ts [payload.json|dump-dir] [--json] [--write]
  npm run analyze:anthropic-cache-payload -- [payload.json|dump-dir] [--json] [--write]

Default target:
  latest payload-anthropic-*.json under ~/.neox/logs/llm-requests

Options:
  --json   print full analysis JSON
  --write  write .cache-analysis.json and .cache-analysis.log next to the payload`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const target = resolveTarget(args.target);
  const payload = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
  const analysis = analyzeAnthropicCachePayload(payload);
  const lines = formatAnthropicCachePayloadAnalysis(analysis);

  if (args.json) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    console.log(`[LLM_PAYLOAD_CACHE] payload=${target}`);
    for (const line of lines) {
      console.log(`[LLM_PAYLOAD_CACHE] ${line}`);
    }
  }

  if (args.write) {
    const analysisFile = target.replace(/\.json$/, '.cache-analysis.json');
    const logFile = target.replace(/\.json$/, '.cache-analysis.log');
    fs.writeFileSync(analysisFile, JSON.stringify(analysis, null, 2), 'utf8');
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');
    console.error(`[LLM_PAYLOAD_CACHE] wrote ${analysisFile}`);
    console.error(`[LLM_PAYLOAD_CACHE] wrote ${logFile}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[LLM_PAYLOAD_CACHE] ERROR ${message}`);
  process.exitCode = 1;
}
