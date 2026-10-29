import { describe, expect, it } from 'vitest';
import { speakableText, spokenLeadOf } from '../spokenLead';

describe('spokenLeadOf', () => {
  it('实录: 结论一段 + 空行 + 文件清单 → 只念第一段', () => {
    const t = '做完了,已正式报给你(fyi)。\n\nshift-test4/ 下三个文件:md2csv.py、test_md2csv.py(33 项全过)、README.md。';
    const r = spokenLeadOf(t);
    expect(r.lead).toBe('做完了,已正式报给你(fyi)。');
    expect(r.closed).toBe(true);
  });
  it('最多两句', () => {
    expect(spokenLeadOf('第一句。第二句！第三句。').lead).toBe('第一句。第二句！');
    expect(spokenLeadOf('一。二。三。四。', 3).lead).toBe('一。二。三。');
  });
  it('实录: 第二句是一长串参数 → 只念第一句, 不截在列举中间', () => {
    const t = '云端那版我核过了,是干净的:shift-test5 下 wordcount.py 和 test_wordcount.py 都在,23 项测试全过。'
      + '我又用一段真实文本端到端跑了一遍——大小写和标点都正确归并(the 4 次、python3 各 2 次),--top、--sort、--min 也都对,还顺手补了空输入的处理。';
    expect(spokenLeadOf(t).lead).toBe('云端那版我核过了,是干净的:shift-test5 下 wordcount.py 和 test_wordcount.py 都在,23 项测试全过。');
  });
  it('遇到列表 / 代码就停', () => {
    expect(spokenLeadOf('结果如下\n- 第一项\n- 第二项').lead).toBe('结果如下');
    expect(spokenLeadOf('改好了 ```ts\nconst a = 1\n```').lead).toBe('改好了 ');
  });
  it('还在流、没到切点: 整段先放行', () => {
    const r = spokenLeadOf('我先看看');
    expect(r).toEqual({ lead: '我先看看', closed: false });
  });
  it('一句话写成一大段: 到上限按逗号断', () => {
    const long = `${'这个功能需要先改登录接口再改前端页面然后跑测试'.repeat(3)}，${'最后还要部署到测试环境验证一遍才算完成'.repeat(8)}`;
    const r = spokenLeadOf(long);
    expect(r.closed).toBe(true);
    expect(r.lead.length).toBeLessThanOrEqual(160);
  });
  it('流式: 每个前缀放行的都是全文放行的那一截的前缀或延伸 (退回只会退到句末)', () => {
    const full = '好的,我来做。先写脚本再写测试。\n\n细节: 一二三';
    let prev = '';
    for (let i = 1; i <= full.length; i++) {
      const { lead } = spokenLeadOf(full.slice(0, i));
      expect(lead.startsWith(prev) || prev.startsWith(lead)).toBe(true);
      prev = lead;
    }
    expect(prev).toBe('好的,我来做。先写脚本再写测试。');
  });
});

describe('speakableText', () => {
  it('路径念文件名, 目录念目录名, 链接念「链接」, 去掉 (fyi)', () => {
    expect(speakableText('放在 shift-test4/README.md 里了')).toBe('放在 README.md 里了');
    expect(speakableText('都在 shift-test4/ 下')).toBe('都在 shift-test4 下');
    expect(speakableText('看 https://example.com/a?b=1 就行')).toBe('看 链接 就行');
    expect(speakableText('已正式报给你(fyi)。')).toBe('已正式报给你。');
  });
  it('分数 / 日期不动', () => {
    expect(speakableText('完成了 3/5')).toBe('完成了 3/5');
  });
});
