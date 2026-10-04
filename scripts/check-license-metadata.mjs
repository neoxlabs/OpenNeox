import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const thirdPartyExceptions = new Map([
  ['apps/cli/vendor/ink/package.json', 'MIT'],
  ['packages/editor-engine/out/monaco-editor/package.json', 'MIT'],
]);

const compositeProjectPackages = new Map([
  ['packages/editor-engine/package.json', 'Apache-2.0 AND MIT'],
]);

const expectedProjectLicense = 'Apache-2.0';

function readPackage(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Missing package metadata: ${relativePath}`);
  }

  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${relativePath}: ${error.message}`);
  }

}

for (const [relativePath, expectedLicense] of thirdPartyExceptions) {
  /* A tree that does not ship the owning package (the CLI-only public tree has no
   * editor-engine) has nothing to check; when the package is present, its vendored
   * metadata must exist. */
  const owner = relativePath.split('/').slice(0, 2).join('/');
  if (!fs.existsSync(path.join(repositoryRoot, owner))) continue;
  const metadata = readPackage(relativePath);
  if (metadata.license !== expectedLicense) {
    throw new Error(
      `${relativePath} must retain ${expectedLicense}; found ${JSON.stringify(metadata.license)}`,
    );
  }
}

const projectPackageFiles = [];
function collectPackageFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectPackageFiles(absolutePath);
    } else if (entry.isFile() && entry.name === 'package.json') {
      projectPackageFiles.push(absolutePath);
    }
  }
}

for (const directory of ['apps', 'packages']) {
  collectPackageFiles(path.join(repositoryRoot, directory));
}

for (const absolutePath of projectPackageFiles) {
  const relativePath = path.relative(repositoryRoot, absolutePath);
  if (thirdPartyExceptions.has(relativePath)) continue;
  const metadata = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  const expectedLicense = compositeProjectPackages.get(relativePath) ?? expectedProjectLicense;
  if (metadata.license !== expectedLicense) {
    throw new Error(
      `${relativePath} must use ${expectedLicense}; found ${JSON.stringify(metadata.license)}`,
    );
  }
}

console.log(
  `License metadata check passed for ${projectPackageFiles.length} project packages and 2 third-party exceptions.`,
);
