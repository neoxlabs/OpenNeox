
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CSS_PATH = path.resolve(__dirname, '../agent-timeline.css');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');

/** 权威块的锚点注释 —— 它必须在文件末尾附近 */
const ANCHOR = '本轮改动 — 扁平列表';

const CHROME = /^\s*(border|border-radius|border-color|border-top|background|box-shadow|backdrop-filter|-webkit-backdrop-filter)\b/;

/* 只拦「画出**可见**外壳」的声明。
 * 基础规则和几条主题重置本来就写着 border:0 / transparent / none —— 那是扁平设计
 * 的一部分, 不是违规。第一版判据没区分这个, 把它们也报成了违规 (自查后收紧)。 */
const INVISIBLE = /:\s*(0|0px|none|transparent|initial|unset|inherit|revert)\s*$/;

/** 判"可见"之前要先把 !important 摘掉 —— 否则 `background: transparent !important`
 *  会被当成可见外壳 (第一版就是这么误报的)。 */
const bare = (d: string) => d.replace(/\s*!important\s*$/, '').trim();

interface Rule { sel: string; body: string; at: number }

function rules(): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]*)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) out.push({ sel: m[1], body: m[2], at: m.index });
  return out;
}

/** 选择器里有没有一支是冲着「盒子本身」去的 */
function targetsBox(sel: string): boolean {
  if (sel.includes('edit-diff-card')) return false;
  return sel.split(',')
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith('/*'))
    .some((x) => x.endsWith('.atl-turn-summary'));
}

describe('本轮改动 — 外壳单一权威', () => {
  /* 用 lastIndexOf —— 上面那几波被清空的规则里, 注释写着"已移交文件末尾的
   * 「本轮改动 — 扁平列表」权威块", 也含这串字。indexOf 会锚到那句注释上,
   * 于是整条闸都在错的位置量 (第一版就是这么错的)。 */
  const anchorAt = CSS.lastIndexOf(ANCHOR);

  test('权威块还在', () => {
    expect(anchorAt, `找不到锚点注释「${ANCHOR}」—— 权威块被删了?`).toBeGreaterThan(-1);
  });

  test('权威块之前不许再有人给这个盒子画外壳', () => {
    const offenders = rules()
      .filter((r) => r.at < anchorAt && targetsBox(r.sel))
      .filter((r) => r.body.split(';').some((d) => CHROME.test(d) && !INVISIBLE.test(bare(d))))
      .map((r) => `第 ${CSS.slice(0, r.at).split('\n').length} 行: ${r.sel.trim().replace(/\s+/g, ' ').slice(0, 60)}`);
    expect(
      offenders,
      `这些规则又开始给「本轮改动」的盒子加外壳了 —— 外观只在文件末尾的权威块里改:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  test('权威块本身把外壳设成"不画"', () => {
    /* 只看权威块里**冲着盒子本身**的那一条规则。
     * 第一版是在 anchor 之后 2500 字符的窗口里 grep, 而紧跟其后的 diffstat 块里也有
     * 一条 `border: 0 !important` —— 于是把盒子那条改成红色边框, 闸照样绿。
     * 变异验证时发现的假闸, 已收紧。 */
    /* 锚点注释被算进了紧随其后那条规则的"选择器前缀"里, 所以不能用 r.at > anchorAt
     * 去找它 (那样恰好把它排除掉)。按前缀里含不含锚点来认。 */
    const boxRule = rules().find((r) => r.sel.includes(ANCHOR) && targetsBox(r.sel));
    expect(boxRule, '权威块里找不到冲着盒子本身的规则').toBeTruthy();
    expect(boxRule!.body).toMatch(/border:\s*0\s*!important/);
    expect(boxRule!.body).toMatch(/background:\s*transparent\s*!important/);
  });
});
