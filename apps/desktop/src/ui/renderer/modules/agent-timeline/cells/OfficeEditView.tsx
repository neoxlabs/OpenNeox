import React from 'react';
import type { StepContent } from '../types';
import { useI18n } from '../../../hooks/useI18n';
import '../toolCards/tool-cards.css';

type Office = Extract<StepContent, { type: 'office' }>;

function split(addr: string): { col: string; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(addr);
  return m ? { col: m[1]!, row: Number(m[2]) } : null;
}
function colNum(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function numCol(n: number): string {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/* 卡底右侧「打开」(设计稿第 2 页): 交给系统默认 app (WPS / Word / Excel / Numbers) */
const OpenAct: React.FC<{ file?: string; isZh: boolean }> = ({ file, isZh }) => (file ? (
  <button
    type="button"
    className="nx-tc__act"
    onClick={(e) => { e.stopPropagation(); void (window as any).neox?.surfaceOpenExternal?.(file)?.catch?.(() => undefined); }}
  >
    {isZh ? '打开' : 'Open'}
  </button>
) : null);

/* 卡头的文件图标: 表格 = 绿格子, 文档 = 蓝纸 (跟成品卡的陶土缩略图同色系, 线条版) */
const SheetGlyph: React.FC = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="#e4f2e9" stroke="#3fa36b" strokeWidth="1.2" />
    <path d="M1.8 5.8h12.4M1.8 10.2h12.4M6.2 5.8v8.4" stroke="#3fa36b" strokeWidth="1.1" />
  </svg>
);
const DocGlyph: React.FC = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M3.5 1.5h6l3 3v10h-9z" fill="#e6edff" stroke="#4f84ff" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M5.6 7.6h4.8M5.6 10h4.8M5.6 12.2h3" stroke="#4f84ff" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

const baseName = (f?: string) => (f ? (f.split(/[\\/]/).pop() ?? f) : '');
const isNum = (v?: string) => v !== undefined && v.trim() !== '' && /^-?[\d,]*\.?\d+%?$/.test(v.trim());
const toNum = (v: string) => Number(v.replace(/[,%]/g, ''));

export const OfficeEditView: React.FC<{ content: Office }> = ({ content }) => {
  const { isZh } = useI18n();
  if (content.kind === 'doc') {
    return (
      <div className="nx-office is-doc">
        <div className="nx-office__head">
          <DocGlyph />
          <span className="nx-office__name">{baseName(content.file) || (isZh ? '文档' : 'Document')}</span>
          {typeof content.paragraph === 'number' && (
            <span className="nx-office__tab">{isZh ? `第 ${content.paragraph + 1} 段` : `¶ ${content.paragraph + 1}`}</span>
          )}
          <span className="nx-office__sum">{content.before ? (isZh ? '改写' : 'Rewritten') : (isZh ? '新增' : 'Added')}</span>
          <OpenAct file={content.file} isZh={isZh} />
        </div>
        <div className="nx-office__doc">
          {content.before && <del>{content.before}</del>}
          <ins>{content.after}</ins>
        </div>
      </div>
    );
  }
  const pts = content.cells.map((c) => ({ ...c, p: split(c.addr) })).filter((c) => c.p);
  if (pts.length === 0) return null;
  const cols = pts.map((c) => colNum(c.p!.col));
  const rows = pts.map((c) => c.p!.row);
  const cMax = Math.max(...cols), rMax = Math.max(...rows);
  const c0 = Math.min(...cols), c1 = Math.min(cMax, c0 + 7);
  const r0 = Math.min(...rows), r1 = Math.min(rMax, r0 + 11);
  const map = new Map(pts.map((c) => [c.addr, c.value]));
  const colList = Array.from({ length: c1 - c0 + 1 }, (_, i) => numCol(c0 + i));
  const rowList = Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i);
  /* 第一行全是字、下面有数 → 当表头画 (加粗、垫底色) */
  const firstIsHeader = rowList.length > 1
    && colList.every((c) => !isNum(map.get(`${c}${r0}`)))
    && colList.some((c) => rowList.slice(1).some((r) => isNum(map.get(`${c}${r}`))));
  /* 数据条: 一列里有两个以上的数, 按这一列最大值画一道浅绿的底条 (Excel 数据条那种) */
  const colMax = new Map<string, number>();
  for (const c of colList) {
    const nums = rowList.map((r) => map.get(`${c}${r}`)).filter(isNum).map((v) => Math.abs(toNum(v!)));
    if (nums.length >= 2 && Math.max(...nums) > 0) colMax.set(c, Math.max(...nums));
  }
  const changed = (c: string, r: number) => map.has(`${c}${r}`);
  const ci = (c: string) => colList.indexOf(c);
  const extraRows = rMax - r1, extraCols = cMax - c1;
  const range = `${numCol(c0)}${r0}:${numCol(cMax)}${rMax}`;
  return (
    <div className="nx-office is-sheet">
      <div className="nx-office__head">
        <SheetGlyph />
        <span className="nx-office__name">{baseName(content.file) || (isZh ? '表格' : 'Sheet')}</span>
        {content.sheet && <span className="nx-office__tab">{content.sheet}</span>}
        <span className="nx-office__sum">
          <code>{pts.length > 1 ? range : pts[0]!.addr}</code>
          {isZh ? ` · 改了 ${pts.length} 格` : ` · ${pts.length} cells`}
        </span>
        <OpenAct file={content.file} isZh={isZh} />
      </div>
      <div className="nx-office__scroll">
        <table className="nx-sheet">
          <thead><tr><th className="nx-sheet__corner" />{colList.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rowList.map((r, ri) => (
              <tr key={r} className={firstIsHeader && ri === 0 ? 'is-header' : undefined}>
                <th>{r}</th>
                {colList.map((c) => {
                  const v = map.get(`${c}${r}`);
                  const on = v !== undefined;
                  const num = isNum(v);
                  const max = colMax.get(c);
                  const cls = [
                    on ? 'is-ch' : '',
                    num ? 'is-num' : '',
                    v?.startsWith('=') ? 'is-fx' : '',
                    /* 改过的那片只描外圈: 四个方向上邻格没改才画那条边 */
                    on && (ri === 0 || !changed(c, r - 1)) ? 'e-t' : '',
                    on && (r === r1 || !changed(c, r + 1)) ? 'e-b' : '',
                    on && (ci(c) === 0 || !changed(colList[ci(c) - 1]!, r)) ? 'e-l' : '',
                    on && (ci(c) === colList.length - 1 || !changed(colList[ci(c) + 1]!, r)) ? 'e-r' : '',
                  ].filter(Boolean).join(' ');
                  const bar = num && max && !(firstIsHeader && ri === 0) ? Math.round(Math.abs(toNum(v!)) / max * 100) : 0;
                  return (
                    <td key={c} className={cls || undefined} style={bar ? ({ '--bar': `${bar}%` } as React.CSSProperties) : undefined}>
                      {v ?? ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(extraRows > 0 || extraCols > 0) && (
        <div className="nx-office__more">
          {isZh
            ? `还有${extraRows > 0 ? ` ${extraRows} 行` : ''}${extraRows > 0 && extraCols > 0 ? '、' : ''}${extraCols > 0 ? ` ${extraCols} 列` : ''}没画出来`
            : `${extraRows > 0 ? `${extraRows} more rows` : ''}${extraRows > 0 && extraCols > 0 ? ', ' : ''}${extraCols > 0 ? `${extraCols} more columns` : ''} not shown`}
        </div>
      )}
    </div>
  );
};
