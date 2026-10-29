import { visit } from 'unist-util-visit';

export function remarkSoftBreaks() {
  return (tree: unknown) => {
    visit(tree as never, 'text', (node: { value?: string }, index: number | undefined, parent: { children?: unknown[] } | undefined) => {
      if (!parent || index === undefined || typeof node.value !== 'string') return;
      if (!node.value.includes('\n')) return;
      const parts = node.value.split('\n');
      const replacement: unknown[] = [];
      parts.forEach((part, i) => {
        if (i > 0) replacement.push({ type: 'break' });
        if (part) replacement.push({ type: 'text', value: part });
      });
      parent.children?.splice(index, 1, ...replacement);
      /* 返回新的游标位置, 免得 visit 重新走进刚插入的 text 节点 (会无限递归) */
      return index + replacement.length;
    });
  };
}
