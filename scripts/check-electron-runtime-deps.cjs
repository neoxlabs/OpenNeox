const fs = require('fs');
const path = require('path');
const { builtinModules, createRequire } = require('module');

const root = process.cwd();
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const ts = requireFromRoot('typescript');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tsconfigPath = path.join(root, 'tsconfig.electron.json');
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'electron']);
const declaredRuntime = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
]);
const sourceImports = new Map();
const distImports = new Map();

function getPackageName(specifier) {
  if (!specifier) return null;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:') || specifier.startsWith('data:')) return null;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  return builtins.has(name) ? null : name;
}

function remember(map, packageName, filePath) {
  if (!map.has(packageName)) map.set(packageName, new Set());
  map.get(packageName).add(path.relative(root, filePath));
}

function checkSpecifier(map, specifier, filePath) {
  const packageName = getPackageName(specifier);
  if (packageName) remember(map, packageName, filePath);
}

function visitImports(sourceFile, map, filePath) {
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) {
        checkSpecifier(map, node.moduleSpecifier.text, filePath);
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) {
        checkSpecifier(map, node.moduleSpecifier.text, filePath);
      }
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg)) {
        checkSpecifier(map, arg.text, filePath);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      checkSpecifier(map, node.arguments[0].text, filePath);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function scanSourceImports() {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, undefined, tsconfigPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }

  for (const fileName of parsed.fileNames) {
    const sourceText = fs.readFileSync(fileName, 'utf8');
    const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    visitImports(sourceFile, sourceImports, fileName);
  }
}

function scanBuiltDist() {
  const distRoot = path.join(root, 'dist', 'ui-electron');
  if (!fs.existsSync(distRoot)) return;

  const walk = (dirPath) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !fullPath.endsWith('.js')) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const sourceFile = ts.createSourceFile(fullPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      visitImports(sourceFile, distImports, fullPath);
    }
  };

  walk(distRoot);
}

function formatEntries(map) {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageName, files]) => `- ${packageName}: ${[...files].slice(0, 4).join(', ')}`)
    .join('\n');
}

scanSourceImports();
scanBuiltDist();

const missingSource = new Map([...sourceImports.entries()].filter(([packageName]) => !declaredRuntime.has(packageName)));
const missingDist = new Map([...distImports.entries()].filter(([packageName]) => !declaredRuntime.has(packageName)));

if (missingSource.size || missingDist.size) {
  console.error('Missing Electron runtime dependencies in package.json');
  if (missingSource.size) {
    console.error('\nSource imports:');
    console.error(formatEntries(missingSource));
  }
  if (missingDist.size) {
    console.error('\nBuilt dist imports:');
    console.error(formatEntries(missingDist));
  }
  process.exit(1);
}

console.log(`Electron runtime dependency check passed (${sourceImports.size} source packages, ${distImports.size} built packages).`);
