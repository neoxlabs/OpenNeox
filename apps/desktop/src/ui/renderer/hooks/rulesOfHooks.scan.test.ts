import { describe, it, expect } from 'vitest';
import { analyzeSource, scanDesktopUi } from '../../../../../../scripts/scan-rules-of-hooks.mjs';

function formatHits(hits: Array<{ file?: string; kind: string; owner: string; hook: string; line: number }>): string {
  if (hits.length === 0) return '';
  return hits.map((h) => `  ${h.file ?? ''}:${h.line}  ${h.kind}  ${h.hook}() in ${h.owner}()`).join('\n');
}

describe('scanner 能抓住 #310 原型', () => {
  it('hook 在 if (!open) return 之后', () => {
    const hits = analyzeSource('Bad.tsx', `
      import { useState } from 'react';
      export const TourOverlay = ({ open }: { open: boolean }) => {
        if (!open) return null;
        const [x, setX] = useState(0);
        return <div>{x}</div>;
      };
    `);
    expect(hits.filter((h) => h.kind === 'after-return').map((h) => h.hook)).toEqual(['useState']);
  });

  it('hook 塞进普通函数 (AccountOverviewTab / reasonLabel 那类)', () => {
    const hits = analyzeSource('Bad.tsx', `
      import { useState } from 'react';
      function reasonLabel(kind: string) {
        const [loading, setLoading] = useState(false);
        return loading ? kind : kind;
      }
      export const Tab = () => <div>{reasonLabel('x')}</div>;
    `);
    expect(hits.filter((h) => h.kind === 'in-other-fn').map((h) => h.owner)).toEqual(['reasonLabel']);
  });

  it('合法: hook 在 early return 之前', () => {
    const hits = analyzeSource('Good.tsx', `
      import { useState } from 'react';
      export const Dialog = ({ open }: { open: boolean }) => {
        const [x] = useState(0);
        if (!open) return null;
        return <div>{x}</div>;
      };
    `);
    expect(hits).toEqual([]);
  });
});

describe('apps/desktop/src/ui 没有 #310 类 hook 违规', () => {
  it('AST 全量扫描为零命中', () => {
    const { files, hits } = scanDesktopUi();
    expect(files).toBeGreaterThan(200);
    expect(hits, `这些 hook 位置会在 Windows 上炸 React #310:\n${formatHits(hits)}`).toEqual([]);
  }, 60_000);
});
