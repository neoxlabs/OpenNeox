import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CARDS = fs.readFileSync(path.join(__dirname, '..', 'neox-cards.css'), 'utf8');
const MD = fs.readFileSync(
  path.join(__dirname, '..', '..', 'styles', 'editor-core', 'text-ui', 'markdown-message.css'),
  'utf8',
);

interface Rule { selector: string; body: string }
function rulesOf(css: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}
/** 找第一条选择器里出现 needle 的规则 */
function ruleWith(css: string, needle: string): Rule | undefined {
  return rulesOf(css).find((r) => r.selector.includes(needle));
}

describe('宽块不跟浮卡并排', () => {
  it('自检: 两份 CSS 都读到了', () => {
    expect(MD).toContain('.md-table-wrapper');
    expect(CARDS).toContain('.ncard-wrap');
  });

  it('表格 clear 掉浮动 —— 否则整张表被压窄, 浮卡下面全是空的', () => {
    const r = ruleWith(MD, '.md-table-wrapper');
    expect(r, '.md-table-wrapper 规则不见了').toBeDefined();
    expect(r!.body, '表格又会被浮卡挤扁').toMatch(/clear:\s*both/);
  });

  it('代码块同理 —— 压窄之后每行都要横向滚', () => {
    const r = ruleWith(MD, '.md-code-block');
    expect(r, '.md-code-block 规则不见了').toBeDefined();
    expect(r!.body, '代码块又会被浮卡挤扁').toMatch(/clear:\s*both/);
  });
});

describe('总结卡按内容决定浮不浮', () => {
  it('带章节/文件明细的卡通栏, 不进 236px 浮槽', () => {
    const r = rulesOf(CARDS).find(
      (x) => x.selector.includes(':has(.nrpt__secs)') && x.body.includes('float'),
    );
    expect(r, '按内容通栏那条规则不见了 —— 带明细的卡会被塞回 236px 浮槽').toBeDefined();
    expect(r!.body, '必须脱离浮槽').toMatch(/float:\s*none/);
    expect(r!.body, '必须拿到整栏宽').toMatch(/width:\s*100%/);
  });

  it('通栏之后章节标题要露出来 —— 只剩「6 ›」等于把信息删了', () => {
    const r = rulesOf(CARDS).find(
      (x) => x.selector.includes(':has(.nrpt__secs)') && x.selector.includes('.nrpt__sec-t'),
    );
    expect(r, '标题恢复可见那条规则不见了').toBeDefined();
    expect(r!.body, '标题还是被 clip 成 sr-only').toMatch(/clip-path:\s*none/);
    expect(r!.body).toMatch(/position:\s*static/);
  });

  it('只有一行状态的小回执仍然浮着 —— 它本来就该让文字绕', () => {
    /* 反向守卫: 别为了修上面那条把浮槽整条删了, 那就退回"每张卡都通栏"的老样子 */
    const r = rulesOf(CARDS).find(
      (x) => x.selector.includes(':has(.ncard--summary)') && x.body.includes('float'),
    );
    expect(r, '浮槽规则被删了 —— 小回执不再让文字绕').toBeDefined();
    expect(r!.body).toMatch(/float:\s*right/);
  });
});
