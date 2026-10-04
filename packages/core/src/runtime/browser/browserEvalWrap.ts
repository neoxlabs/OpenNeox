/** Wrap model JavaScript for evaluation in the page context. Compilation
 * distinguishes expressions from statement blocks without executing code in
 * the host; statement blocks can return their final expression value. */

/** 只编译不执行 —— 这是这里唯一允许对模型代码做的事 */
function compiles(body: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function('x', body);
    return true;
  } catch {
    return false;
  }
}

/** 顶层有没有 return (粗判: 有 `return` 这个词就算; 误判的代价只是少做一次自动 return) */
const hasReturn = (s: string): boolean => /\breturn\b/.test(s);

/**
 * 语句块的"最后一条语句"改成 `return (…)`。
 * 切分只看最后一个顶层 `;` / 换行 —— 不做完整解析; 改出来的编译不过就放弃。
 */
function autoReturnLast(body: string): string | null {
  const trimmed = body.trim().replace(/;\s*$/, '');
  const cut = Math.max(trimmed.lastIndexOf(';'), trimmed.lastIndexOf('\n'));
  const head = cut >= 0 ? trimmed.slice(0, cut + 1) : '';
  const last = cut >= 0 ? trimmed.slice(cut + 1).trim() : trimmed;
  if (!last || /^(const|let|var|if|for|while|switch|try|function|class|return|throw)\b/.test(last)) return null;
  const candidate = `${head} return (${last});`;
  return compiles(candidate) ? candidate : null;
}

export interface WrappedEval {
  /** 交给 page.evaluate 的字符串 —— 一定是**表达式** (IIFE) */
  code: string;
  /** 它是怎么被认出来的, 结果为空时用来解释 */
  form: 'iife' | 'function' | 'expression' | 'statements' | 'statements+autoreturn';
}

export function wrapEvalSource(source: string, argLit = ''): WrappedEval {
  const src = source.trim();
  const isIife = /^\s*[(!]/.test(src) && /\)\s*$/.test(src) && /\)\s*\(/.test(src);
  const isFuncLiteral = /^\s*(async\s*)?(\(\s*[\w$,\s]*\)|[\w$]+)\s*=>/.test(src) || /^\s*(async\s+)?function\b/.test(src);
  if (isIife) return { code: src, form: 'iife' };
  if (isFuncLiteral) return { code: `(${src})(${argLit})`, form: 'function' };

  /* 表达式优先: 能 `return (src)` 就是表达式。await 在 async 体里也合法, 所以统一用 async 包 ——
   * page.evaluate 会等返回的 Promise, 表达式本身是 Promise (fetch(...).then(...)) 也一样等到值。 */
  if (compiles(`return (${src});`)) {
    return { code: `(async (x) => (${src}))(${argLit})`, form: 'expression' };
  }
  if (!hasReturn(src)) {
    const rewritten = autoReturnLast(src);
    if (rewritten) return { code: `(async (x) => { ${rewritten} })(${argLit})`, form: 'statements+autoreturn' };
  }
  return { code: `(async (x) => { ${src} })(${argLit})`, form: 'statements' };
}

/**
 * 结果是 undefined 时给模型的一句话。空结果本身不是错, 但**不解释**的空结果会让它再猜一轮。
 */
export function explainEmptyResult(form: WrappedEval['form']): string {
  switch (form) {
    case 'statements':
      return '代码跑完了但没有返回值: 多条语句时要用 return 把结果送回来 (或者把要看的值写成最后一条表达式)。';
    case 'function':
      return '函数跑完了但没有返回值: 函数体里要 return 才拿得到结果。';
    default:
      return '表达式求出来是 undefined (比如 querySelector 没找到、可选链断了)。';
  }
}
