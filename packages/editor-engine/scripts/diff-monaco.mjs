import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMonacoPatch, MONACO_VERSION, PATCH_FILENAME } from './monaco-patch.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, '..');

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node scripts/diff-monaco.mjs [options]

Options:
  --upstream DIR  Extracted monaco-editor ${MONACO_VERSION} directory
  --custom DIR    Customized monaco-editor directory
  --output FILE   Unified patch output
  --files DIR     Binary replacement files directory
`);
  process.exit(0);
}

const upstreamRoot = path.resolve(readOption(args, '--upstream', path.join(packageRoot, 'node_modules/monaco-editor')));
const customRoot = path.resolve(readOption(args, '--custom', path.join(packageRoot, 'out/monaco-editor')));
const patchPath = path.resolve(
  readOption(args, '--output', path.join(packageRoot, 'patches', PATCH_FILENAME)),
);
const filesRoot = path.resolve(
  readOption(args, '--files', path.join(path.dirname(patchPath), 'files')),
);

if (!fs.existsSync(upstreamRoot)) throw new Error(`Upstream Monaco directory not found: ${upstreamRoot}`);
if (!fs.existsSync(customRoot)) throw new Error(`Customized Monaco directory not found: ${customRoot}`);

const result = generateMonacoPatch({ upstreamRoot, customRoot, patchPath, filesRoot });
console.log(JSON.stringify({ upstreamRoot, customRoot, patchPath, filesRoot, ...result }, null, 2));
