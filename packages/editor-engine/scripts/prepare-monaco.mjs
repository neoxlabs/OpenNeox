import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  applyMonacoPatch,
  MONACO_TARBALL_INTEGRITY,
  MONACO_TARBALL_SHA1,
  MONACO_VERSION,
  PATCH_FILENAME,
  sha256File,
} from './monaco-patch.mjs';

const require = createRequire(import.meta.url);
const tar = require('tar');
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, '..');
const outputRoot = path.resolve(
  process.env.NEOX_MONACO_OUTPUT ?? path.join(packageRoot, 'out', 'monaco-editor'),
);
const patchRoot = path.join(packageRoot, 'patches');
const patchPath = path.join(patchRoot, PATCH_FILENAME);
const filesRoot = path.join(patchRoot, 'files');
const markerPath = path.join(outputRoot, '.neox-patched');

// The patch deletes upstream files (e.g. unused basic-languages) but a unified
// diff cannot express directory removal, so prune the directories it empties.
function removeEmptyDirectories(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  }
  if (directory !== outputRoot && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

const marker = readMarker();
if (marker?.version === MONACO_VERSION) {
  console.log(`Monaco ${MONACO_VERSION} is already prepared at ${outputRoot}`);
  process.exit(0);
}

if (!fs.existsSync(patchPath)) {
  throw new Error(`Monaco patch is missing: ${patchPath}. Run scripts/diff-monaco.mjs first.`);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openneox-monaco-'));
try {
  const packResult = JSON.parse(
    /* Windows 上 npm 是 npm.cmd, execFileSync('npm') 直接 ENOENT, 干净检出的 npm ci 在 postinstall 挂掉;
     * .cmd 只能经 shell 起 (参数里没有空格和用户输入, shell 拼接安全) */
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', `monaco-editor@${MONACO_VERSION}`, '--json', '--pack-destination', temporaryRoot],
      { cwd: packageRoot, encoding: 'utf8', shell: process.platform === 'win32' },
    ),
  );
  const metadata = Array.isArray(packResult) ? packResult[0] : packResult;
  if (!metadata || metadata.version !== MONACO_VERSION || !metadata.filename) {
    throw new Error(`npm pack returned unexpected Monaco metadata: ${JSON.stringify(metadata)}`);
  }

  const tarballPath = path.join(temporaryRoot, metadata.filename);
  const tarball = fs.readFileSync(tarballPath);
  const sha1 = crypto.createHash('sha1').update(tarball).digest('hex');
  const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
  if (sha1 !== MONACO_TARBALL_SHA1 || integrity !== MONACO_TARBALL_INTEGRITY) {
    throw new Error(`Monaco tarball checksum mismatch: sha1=${sha1}, integrity=${integrity}`);
  }

  const extractedRoot = path.join(temporaryRoot, 'package');
  fs.mkdirSync(extractedRoot);
  tar.x({
    file: tarballPath,
    cwd: extractedRoot,
    strip: 1,
    strict: true,
    sync: true,
    filter: (entryPath) => {
      const relative = entryPath.replace(/^package\//, '');
      return (
        relative === 'esm' ||
        relative.startsWith('esm/') ||
        relative === 'monaco.d.ts' ||
        relative === 'LICENSE' ||
        relative === 'ThirdPartyNotices.txt' ||
        relative === 'package.json'
      );
    },
  });

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const relative of ['esm', 'monaco.d.ts', 'LICENSE', 'ThirdPartyNotices.txt', 'package.json']) {
    const source = path.join(extractedRoot, relative);
    const destination = path.join(outputRoot, relative);
    if (fs.statSync(source).isDirectory()) {
      fs.cpSync(source, destination, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }

  applyMonacoPatch({ outputRoot, patchPath, filesRoot });
  removeEmptyDirectories(outputRoot);
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        version: MONACO_VERSION,
        patch: PATCH_FILENAME,
        patchSha256: sha256File(patchPath),
        tarballSha1: sha1,
        tarballIntegrity: integrity,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Prepared Monaco ${MONACO_VERSION} at ${outputRoot}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
