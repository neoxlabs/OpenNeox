import { visit, SKIP } from 'unist-util-visit';

/**
 * rehype plugin: status emoji (check marks, crosses, empty boxes; see MARKS) become
 * <span class="md-mark md-mark--done|fail|todo">, drawn by markdown-message.css
 * in the theme's colours instead of the platform's glossy emoji. Code, keyboard
 * and math text keep the characters as written.
 */

export type StatusMarkKind = 'done' | 'fail' | 'todo';

const MARKS: Record<string, StatusMarkKind> = {
  '✅': 'done', '☑': 'done', '✔': 'done',
  '❌': 'fail', '❎': 'fail', '✖': 'fail',
  '⬜': 'todo', '☐': 'todo', '\u{1F532}': 'todo', '◻': 'todo',
};

const LABELS: Record<StatusMarkKind, string> = { done: 'done', fail: 'failed', todo: 'to do' };

/** One mark, optionally followed by the emoji variation selector. */
const MARK_RE = /(✅|☑|✔|❌|❎|✖|⬜|☐|\u{1F532}|◻)️?/gu;

const SKIP_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'script', 'style', 'math', 'svg']);

function isSkipped(node: any): boolean {
  if (node?.type !== 'element') return false;
  if (SKIP_TAGS.has(node.tagName)) return true;
  const cls = node.properties?.className;
  const list: string[] = Array.isArray(cls) ? cls : typeof cls === 'string' ? cls.split(/\s+/) : [];
  return list.some((c) => c === 'katex' || c.startsWith('math'));
}

function markNode(kind: StatusMarkKind) {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['md-mark', `md-mark--${kind}`], role: 'img', ariaLabel: LABELS[kind] },
    children: [],
  };
}

/** Splits a text value into text and mark nodes; null when there is nothing to replace. */
export function splitStatusMarks(value: string): any[] | null {
  MARK_RE.lastIndex = 0;
  if (!MARK_RE.test(value)) return null;
  MARK_RE.lastIndex = 0;
  const out: any[] = [];
  let last = 0;
  for (const match of value.matchAll(MARK_RE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ type: 'text', value: value.slice(last, at) });
    out.push(markNode(MARKS[match[1]]));
    last = at + match[0].length;
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

export function rehypeStatusMarks() {
  return (tree: any) => {
    visit(tree, (node: any, index, parent: any) => {
      if (isSkipped(node)) return SKIP;
      if (node.type !== 'text' || !parent || index === undefined) return;
      const parts = splitStatusMarks(node.value);
      if (!parts) return;
      parent.children.splice(index, 1, ...parts);
      return [SKIP, index + parts.length];
    });
  };
}
