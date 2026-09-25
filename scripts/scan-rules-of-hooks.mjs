/**
 * 用 TypeScript AST 扫描桌面 UI 里违反 Hooks 规则的写法 (会触发 React 报错 #310)。
 *
 * 条件调用 hook 会让每次渲染的 hook 顺序不一致, 组件状态随之错位。正则匹配噪声过大,
 * 因此按语法树判定三种形态:
 *   1. 组件 / 自定义 hook 中, 提前 return 之后仍调用 useXxx
 *   2. 普通函数中调用 useXxx
 *   3. if / 三元 / && / 循环 / switch 内部调用 useXxx
 *
 * 用法: node scripts/scan-rules-of-hooks.mjs
 *
 * 放在 scripts/ 而非渲染层目录: 它是构建期工具, 需要 node:fs / path / url,
 * 而渲染层运行在浏览器中, 由 check:boundaries 保证不引入这些模块。
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* scripts/ → apps/desktop/src/ui (被扫的根) */
export const UI_ROOT = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'apps', 'desktop', 'src', 'ui',
);

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    /* renderer/__harness__ 是本地离线渲染台, 不进发行包: 里面的假 store 会故意在普通函数
     * 里调 hook 来喂组件。扫描它只会反映本机有哪些台子, 与发布产物无关, 因此整目录跳过。 */
    if (name === '__harness__') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith('.d.ts') && !name.includes('.test.') && !name.includes('.spec.')) {
      out.push(p);
    }
  }
  return out;
}

function isHookName(name) {
  return name === 'use' || /^use[A-Z]/.test(name);
}

function calleeHookName(expr) {
  if (ts.isIdentifier(expr)) return isHookName(expr.text) ? expr.text : null;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return isHookName(expr.name.text) ? expr.name.text : null;
  }
  return null;
}

function functionDisplayName(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  let p = fn.parent;
  while (p) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isMethodDeclaration(p) && p.name && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isExportAssignment(p)) return 'default';
    if (
      ts.isCallExpression(p) ||
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isSatisfiesExpression?.(p) ||
      ts.isNonNullExpression(p)
    ) {
      p = p.parent;
      continue;
    }
    break;
  }
  return null;
}

function isComponentOrHookName(name) {
  if (!name) return false;
  if (name === 'default') return true;
  if (/^use[A-Z]/.test(name)) return true;
  if (/^[A-Z]/.test(name)) return true;
  return false;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

function collectHookCalls(node, out) {
  if (isFunctionLike(node)) return;
  if (ts.isCallExpression(node)) {
    const h = calleeHookName(node.expression);
    if (h) out.push({ name: h, node });
  }
  ts.forEachChild(node, (c) => collectHookCalls(c, out));
}

function statementHasReturn(stmt) {
  if (ts.isReturnStatement(stmt)) return true;
  if (ts.isBlock(stmt)) return stmt.statements.some(statementHasReturn);
  if (ts.isIfStatement(stmt)) {
    return statementHasReturn(stmt.thenStatement) || (stmt.elseStatement ? statementHasReturn(stmt.elseStatement) : false);
  }
  if (ts.isTryStatement(stmt)) {
    return (
      statementHasReturn(stmt.tryBlock) ||
      (stmt.catchClause ? statementHasReturn(stmt.catchClause.block) : false) ||
      (stmt.finallyBlock ? statementHasReturn(stmt.finallyBlock) : false)
    );
  }
  if (ts.isSwitchStatement(stmt)) {
    return stmt.caseBlock.clauses.some((c) => c.statements.some(statementHasReturn));
  }
  return false;
}

function collectConditionalHookHits(node, out) {
  if (isFunctionLike(node)) return;

  if (ts.isIfStatement(node)) {
    const hooks = [];
    collectHookCalls(node.thenStatement, hooks);
    if (node.elseStatement) collectHookCalls(node.elseStatement, hooks);
    for (const h of hooks) out.push({ kind: 'conditional-if', ...h });
  } else if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    const hooks = [];
    collectHookCalls(node, hooks);
    for (const h of hooks) out.push({ kind: 'loop', ...h });
  } else if (ts.isConditionalExpression(node)) {
    const hooks = [];
    collectHookCalls(node.whenTrue, hooks);
    collectHookCalls(node.whenFalse, hooks);
    for (const h of hooks) out.push({ kind: 'ternary', ...h });
  } else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    const hooks = [];
    collectHookCalls(node.right, hooks);
    for (const h of hooks) out.push({ kind: 'short-circuit', ...h });
  } else if (ts.isSwitchStatement(node)) {
    for (const clause of node.caseBlock.clauses) {
      const hooks = [];
      for (const s of clause.statements) collectHookCalls(s, hooks);
      for (const h of hooks) out.push({ kind: 'switch', ...h });
    }
  }

  ts.forEachChild(node, (c) => collectConditionalHookHits(c, out));
}

function loc(sf, node) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, col: character + 1 };
}

export function analyzeSource(file, src) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const hits = [];

  function visit(node) {
    if (isFunctionLike(node) && node.body) {
      const name = functionDisplayName(node);
      const owner = name ?? '(anonymous)';
      const isLegalHost = isComponentOrHookName(name) || (name === null && ts.isFunctionDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));

      const hooksHere = [];
      if (ts.isBlock(node.body)) {
        for (const stmt of node.body.statements) collectHookCalls(stmt, hooksHere);
      } else {
        collectHookCalls(node.body, hooksHere);
      }

      if (hooksHere.length && !isLegalHost) {
        for (const h of hooksHere) {
          hits.push({ kind: 'in-other-fn', owner, hook: h.name, ...loc(sf, h.node) });
        }
      }

      if (isLegalHost && ts.isBlock(node.body)) {
        let seenReturn = false;
        for (const stmt of node.body.statements) {
          const stmtHooks = [];
          collectHookCalls(stmt, stmtHooks);
          if (seenReturn && stmtHooks.length) {
            for (const h of stmtHooks) {
              hits.push({ kind: 'after-return', owner, hook: h.name, ...loc(sf, h.node) });
            }
          }
          if (statementHasReturn(stmt)) seenReturn = true;
        }

        const cond = [];
        for (const stmt of node.body.statements) collectConditionalHookHits(stmt, cond);
        for (const h of cond) {
          hits.push({ kind: h.kind, owner, hook: h.name, ...loc(sf, h.node) });
        }
      } else if (isLegalHost && node.body && !ts.isBlock(node.body)) {
        const cond = [];
        collectConditionalHookHits(node.body, cond);
        for (const h of cond) {
          hits.push({ kind: h.kind, owner, hook: h.name, ...loc(sf, h.node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return hits;
}

export function scanDesktopUi(root = UI_ROOT) {
  const files = walkFiles(root);
  const all = [];
  for (const f of files) {
    for (const h of analyzeSource(f, readFileSync(f, 'utf8'))) {
      all.push({ file: relative(root, f), ...h });
    }
  }
  return { files: files.length, hits: all };
}

function printReport({ files, hits }) {
  const groups = new Map();
  for (const h of hits) {
    if (!groups.has(h.kind)) groups.set(h.kind, []);
    groups.get(h.kind).push(h);
  }
  console.log(`scanned ${files} files, ${hits.length} hits\n`);
  for (const [kind, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`=== ${kind}: ${list.length} ===`);
    for (const h of list) {
      console.log(`  ${h.file}:${h.line}  ${h.hook}() in ${h.owner}()`);
    }
    console.log('');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) printReport(scanDesktopUi());
