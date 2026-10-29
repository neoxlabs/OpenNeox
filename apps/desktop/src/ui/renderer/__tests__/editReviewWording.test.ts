import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

/** 静态闸一律先去注释 —— 注释里引用的旧文案会制造假红/假绿 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const bar = stripComments(read('../modules/agent-timeline/TurnSummaryBar.tsx'));
const summaryView = stripComments(read('../modules/agent-timeline/cells/TurnSummaryView.tsx'));
const diffCard = stripComments(read('../modules/agent-timeline/cells/EditDiffCard.tsx'));
const composer = stripComments(read('../modules/agent-timeline/TimelineComposer.tsx'));
const revertFile = stripComments(read('../modules/agent-timeline/cells/revertFileChange.ts'));
const codeSurface = stripComments(read('../modules/surface/viewers/CodeSurfaceViewer.tsx'));
const i18n = stripComments(read('../i18n/index.ts'));

describe('已写入的改动 vs 待执行的请求 —— 两套词不许串', () => {
  it('改动审阅**不许**用 Allow / Deny —— 文件已经写下去了, 那两个词会让人以为 agent 卡着等批准', () => {
    expect(bar).not.toMatch(/'Allow'/);
    expect(bar).not.toMatch(/'Deny'/);
  });

  it('改动审阅用 接受 / Accept 和 回滚 / Revert', () => {
    expect(bar).toMatch(/'接受' : 'Accept'/);
    expect(bar).toMatch(/'回退' : 'Revert'/);
  });

  it('工具权限审批**仍然**是 允许 / 拒绝 —— 那才是真的待执行请求', () => {
    expect(composer).toMatch(/'允许' : 'Allow'/);
    expect(composer).toMatch(/'拒绝' : 'Deny'/);
  });
});

describe('用词统一', () => {
  it('agent 改动审阅这一族只用「回退」, 不许再出现「回滚」', () => {
    for (const [name, src] of [['bar', bar], ['summaryView', summaryView], ['diffCard', diffCard], ['revertFileChange', revertFile]] as const) {
      expect(src, `${name} 里出现了「回滚」`).not.toMatch(/回滚/);
    }
  });

  it('权威词典 (i18n editFile) 与 UI 用同一个词', () => {
    const anchor = i18n.indexOf("reverted: '已回退'");
    expect(anchor, 'i18n 里找不到 editFile 中文词典块').toBeGreaterThan(-1);
    const ns = i18n.slice(anchor - 200, anchor + 400);
    expect(ns).toMatch(/revert: '回退'/);
    expect(ns).not.toMatch(/回滚/);
  });

  it('编辑器里逐 hunk 的回退也是同一个词', () => {
    expect(codeSurface).toMatch(/回退此区段/);
  });

  it('名词是「本轮改动」/「Agent edits」, 不再有「待审改动」/「Pending edits」', () => {
    expect(bar).toMatch(/'本轮改动' : 'Agent edits'/);
    expect(bar).not.toMatch(/'Pending edits'/);
  });

  /* 双语文案改一半在中文界面上完全看不出来 —— 08-27 那批"15 条错误提示是纯中文"同族 */
  it('这几处的中英文必须成对出现, 不许只改一半', () => {
    const pairs = bar.match(/isZh \? '[^']*' : '[^']*'/g) ?? [];
    expect(pairs.length).toBeGreaterThan(3);
    for (const pair of pairs) {
      const [, zh, en] = pair.match(/isZh \? '([^']*)' : '([^']*)'/) ?? [];
      if (/[一-龥]/.test(zh)) {
        expect(en, `英文半边还是中文: ${pair}`).not.toMatch(/[一-龥]/);
      }
    }
  });
});
