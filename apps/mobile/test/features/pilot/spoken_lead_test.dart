import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/pilot/spoken_lead.dart';

void main() {
  test('结论一段 + 空行 + 文件清单 → 只念第一段, (fyi) 不念', () {
    expect(spokenLead('做完了,已正式报给你(fyi)。\n\nshift-test4/ 下三个文件:md2csv.py。'), '做完了,已正式报给你。');
  });
  test('最多两句; 第二句太长就只念第一句', () {
    expect(spokenLead('第一句。第二句！第三句。'), '第一句。第二句！');
    final long = '核过了,23 项测试全过。${'我又用一段真实文本端到端跑了一遍大小写和标点都正确归并' * 3}。';
    expect(spokenLead(long), '核过了,23 项测试全过。');
  });
  test('边写边念: 一句够长就开念, 太短的等第二句, 调工具时有多少念多少', () {
    expect(closedLead('我是研究员'), isNull);
    expect(closedLead('好的。'), isNull);
    expect(closedLead('好的。我去'), isNull);
    expect(closedLead('我是研究员, 你的私人助理。你派'), '我是研究员, 你的私人助理。');
    expect(closedLead('好的。我查一下。'), '好的。我查一下。');
    expect(closedLead('我查一下', force: true), '我查一下');
  });
  test('路径念文件名, 链接念「链接」', () {
    expect(speakable('放在 shift-test4/README.md 里了'), '放在 README.md 里了');
    expect(speakable('看 https://example.com/a 就行'), '看 链接 就行');
  });
}
