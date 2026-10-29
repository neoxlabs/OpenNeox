import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyPatch, createTwoFilesPatch, parsePatch } = require('diff');

export const MONACO_VERSION = '0.55.1';
export const MONACO_TARBALL_SHA1 = 'e74c6fe5a6bf985b817d2de3eb88d56afc494a1b';
export const MONACO_TARBALL_INTEGRITY =
  'sha512-jz4x+TJNFHwHtwuV9vA9rMujcZRb0CEilTEwG2rRSpe/A7Jdkuj8xPKttCgOh+v/lkHy7HsZ64oj+q3xoAFl9A==';
export const PATCH_FILENAME = `monaco-editor-${MONACO_VERSION}.patch`;

const PATCHED_PATHS = ['esm', 'monaco.d.ts'];

function normalizeRelative(relativePath) {
  return relativePath.split(path.sep).join('/');
}

export function listFiles(root) {
  const files = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(normalizeRelative(path.relative(root, absolute)));
      }
    }
  }

  if (fs.existsSync(root)) visit(root);
  return files.sort();
}

export function isPatchPath(relativePath) {
  return PATCHED_PATHS.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function readTextOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  if (isBinary(buffer)) return null;
  return buffer.toString('utf8');
}

function patchName(name) {
  return name === '/dev/null' ? name : name.replace(/\t.*$/, '');
}

function safePatchPath(name) {
  const clean = patchName(name).replace(/^a\//, '').replace(/^b\//, '');
  if (clean === '/dev/null') return clean;
  if (!isPatchPath(clean) || path.posix.normalize(clean) !== clean || clean.startsWith('../')) {
    throw new Error(`Refusing patch path outside Monaco inputs: ${name}`);
  }
  return clean;
}

function patchForFile(relativePath, upstreamText, customText) {
  const oldName = upstreamText === null ? '/dev/null' : relativePath;
  const newName = customText === null ? '/dev/null' : relativePath;
  return createTwoFilesPatch(
    oldName,
    newName,
    upstreamText ?? '',
    customText ?? '',
    'upstream',
    'custom',
  );
}

export function generateMonacoPatch({ upstreamRoot, customRoot, patchPath, filesRoot }) {
  const upstreamFiles = new Set(listFiles(upstreamRoot).filter(isPatchPath));
  const customFiles = new Set(listFiles(customRoot).filter(isPatchPath));
  const allFiles = [...new Set([...upstreamFiles, ...customFiles])].sort();
  const patches = [];
  const binaryFiles = [];
  const binaryDeletes = [];

  if (filesRoot) {
    fs.rmSync(filesRoot, { recursive: true, force: true });
  }

  for (const relativePath of allFiles) {
    const upstreamPath = path.join(upstreamRoot, relativePath);
    const customPath = path.join(customRoot, relativePath);
    const upstreamBuffer = fs.existsSync(upstreamPath) ? fs.readFileSync(upstreamPath) : null;
    const customBuffer = fs.existsSync(customPath) ? fs.readFileSync(customPath) : null;
    const upstreamBinary = upstreamBuffer !== null && isBinary(upstreamBuffer);
    const customBinary = customBuffer !== null && isBinary(customBuffer);

    if (upstreamBinary || customBinary) {
      if (customBuffer !== null) {
        const destination = path.join(filesRoot, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, customBuffer);
        binaryFiles.push(relativePath);
      } else {
        binaryDeletes.push(relativePath);
      }
      continue;
    }

    const upstreamText = readTextOrNull(upstreamPath);
    const customText = readTextOrNull(customPath);
    if (upstreamText !== customText) {
      patches.push(patchForFile(relativePath, upstreamText, customText));
    }
  }

  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, patches.join('\n'));

  const deletionsPath = path.join(path.dirname(filesRoot), 'binary-deletions.json');
  if (binaryDeletes.length > 0) {
    fs.writeFileSync(deletionsPath, `${JSON.stringify(binaryDeletes, null, 2)}\n`);
  } else {
    fs.rmSync(deletionsPath, { force: true });
  }

  return {
    patchFiles: patches.length,
    binaryFiles: binaryFiles.length,
    binaryDeletes: binaryDeletes.length,
    patchBytes: fs.statSync(patchPath).size,
  };
}

export function applyMonacoPatch({ outputRoot, patchPath, filesRoot }) {
  const patchText = fs.readFileSync(patchPath, 'utf8');
  for (const patch of parsePatch(patchText)) {
    const oldPath = safePatchPath(patch.oldFileName);
    const newPath = safePatchPath(patch.newFileName);
    if (oldPath === '/dev/null' && newPath === '/dev/null') {
      throw new Error('Patch entry has no source or destination');
    }

    const sourcePath = oldPath === '/dev/null' ? null : path.join(outputRoot, oldPath);
    const source = sourcePath && fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
    const result = applyPatch(source, patch);
    if (result === false) {
      throw new Error(`Could not apply Monaco patch entry ${patch.newFileName}`);
    }

    if (newPath === '/dev/null') {
      if (sourcePath) fs.rmSync(sourcePath, { force: true });
      continue;
    }

    const destination = path.join(outputRoot, newPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, result);
  }

  if (filesRoot && fs.existsSync(filesRoot)) {
    for (const relativePath of listFiles(filesRoot)) {
      const source = path.join(filesRoot, relativePath);
      const destination = path.join(outputRoot, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }

  const deletionsPath = path.join(path.dirname(filesRoot), 'binary-deletions.json');
  if (fs.existsSync(deletionsPath)) {
    for (const relativePath of JSON.parse(fs.readFileSync(deletionsPath, 'utf8'))) {
      if (!isPatchPath(relativePath)) throw new Error(`Invalid binary deletion path: ${relativePath}`);
      fs.rmSync(path.join(outputRoot, relativePath), { force: true });
    }
  }
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
