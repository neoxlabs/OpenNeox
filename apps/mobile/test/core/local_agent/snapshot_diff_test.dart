/// pilot:D-04 增量快照 —— 读屏只回与上次不同的控件.
///
/// 验收: 同一屏重读第二次返回 ≤20% 内容; 且编号不许错位 (点错按钮比多传 token 贵得多).
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/tools/snapshot_diff.dart';

/// 造一屏控件: 每行跟原生 snapshot 的格式一样 `[3] 按钮 「下单」`
String screen(int n, {Map<int, String> changed = const {}}) => List.generate(
      n,
      (i) => changed[i + 1] ?? '[${i + 1}] 按钮 「控件 ${i + 1}」',
    ).join('\n');

void main() {
  group('SnapshotDiff', () {
    late SnapshotDiff diff;

    setUp(() => diff = SnapshotDiff());

    test('第一次给整屏, 第二次同屏只回变了的控件 (≤20%)', () {
      final first = screen(50);
      final a = diff.apply(appKey: 'com.sankuai.meituan', elements: first);
      expect(a.incremental, isFalse);
      expect(a.text, first);
      expect(a.total, 50);

      final second = screen(50, changed: {7: '[7] 按钮 「提交订单」'});
      final b = diff.apply(appKey: 'com.sankuai.meituan', elements: second);
      expect(b.incremental, isTrue);
      expect(b.changed, 1);
      expect(b.collapsed, 49);
      expect(b.text, contains('[7] 按钮 「提交订单」'));
      expect(b.text, contains('[1-6] 同上'));
      expect(b.text, contains('[8-50] 同上'));
      expect(b.text.length * 100, lessThanOrEqualTo(second.length * 20));
    });

    test('一个控件都没变: 只剩折叠行', () {
      final s = screen(40);
      diff.apply(appKey: 'me.ele', elements: s);
      final b = diff.apply(appKey: 'me.ele', elements: s);
      expect(b.incremental, isTrue);
      expect(b.changed, 0);
      expect(b.text, '[1-40] 同上');
    });

    test('只有一个控件时也折成一行', () {
      diff.apply(appKey: 'a', elements: '[1] 按钮 「确定」');
      final b = diff.apply(appKey: 'a', elements: '[1] 按钮 「确定」');
      expect(b.text, '[1] 同上');
    });

    test('换了 App 不折叠 (上一个 App 的编号不能拿来用)', () {
      diff.apply(appKey: 'com.tencent.mm', elements: screen(10));
      final b = diff.apply(appKey: 'me.ele', elements: screen(10));
      expect(b.incremental, isFalse);
      expect(b.text, screen(10));
    });

    test('控件增删让编号整体位移: 只折叠编号与内容都一样的, 不留错编号', () {
      diff.apply(appKey: 'a', elements: screen(8));
      /* 第 3 位插进来一个弹窗 → 原来的「控件 3」变成 [4] */
      final second = [
        '[1] 按钮 「控件 1」',
        '[2] 按钮 「控件 2」',
        '[3] 按钮 「同意」',
        '[4] 按钮 「控件 3」',
        '[5] 按钮 「控件 4」',
        '[6] 按钮 「控件 5」',
        '[7] 按钮 「控件 6」',
        '[8] 按钮 「控件 7」',
        '[9] 按钮 「控件 8」',
      ].join('\n');
      final b = diff.apply(appKey: 'a', elements: second);
      expect(b.text, contains('[1-2] 同上')); // 这两条编号和内容都没变
      expect(b.text, contains('[4] 按钮 「控件 3」')); // 位移过的必须整行重发
      /* 只有前两条能折叠: 后面每条编号都和上次对不上 */
      expect(RegExp(r'同上$', multiLine: true).allMatches(b.text).length, 1);
      expect(b.text, isNot(contains('[3-4] 同上')));
      expect(b.text, isNot(contains('[4-9] 同上')));
    });

    test('控件字里带换行算同一个控件, 不冒出幻影编号', () {
      final first = '[1] 文字 「第一行\n第二行」\n[2] 按钮 「确定」';
      final second = '[1] 文字 「第一行\n改过了」\n[2] 按钮 「确定」';
      diff.apply(appKey: 'a', elements: first);
      final b = diff.apply(appKey: 'a', elements: second);
      expect(b.total, 2);
      expect(b.text, '[1] 文字 「第一行\n改过了」\n[2] 同上');
    });

    test('full=true 强制整屏 (上下文里没有上一屏时)', () {
      final s = screen(20);
      diff.apply(appKey: 'a', elements: s);
      final b = diff.apply(appKey: 'a', elements: s, full: true);
      expect(b.incremental, isFalse);
      expect(b.text, s);
      /* 拿了整屏之后, 新基线是这一屏, 下一次照样能增量 */
      final c = diff.apply(appKey: 'a', elements: screen(20, changed: {3: '[3] 按钮 「变了」'}));
      expect(c.incremental, isTrue);
    });

    test('认不出编号时给整屏 (格式变了宁可不省)', () {
      final b = diff.apply(appKey: 'a', elements: '这个界面读不出控件\n用 screenshot 看图');
      expect(b.incremental, isFalse);
      expect(b.text, '这个界面读不出控件\n用 screenshot 看图');
    });

    test('隔了两分钟没读屏就整屏重发 (新任务上下文里没有上一屏)', () {
      var now = DateTime(2026, 10, 18, 9);
      final d = SnapshotDiff(clock: () => now);
      d.apply(appKey: 'a', elements: screen(10));

      now = now.add(const Duration(minutes: 1));
      expect(d.apply(appKey: 'a', elements: screen(10)).incremental, isTrue);

      now = now.add(const Duration(minutes: 3));
      final b = d.apply(appKey: 'a', elements: screen(10));
      expect(b.incremental, isFalse);
      expect(b.text, screen(10));
    });

    test('reset 之后重新整屏 (翻页 / 出错后)', () {
      diff.apply(appKey: 'a', elements: screen(5));
      diff.reset();
      expect(diff.last, isNull);
      final b = diff.apply(appKey: 'a', elements: screen(5));
      expect(b.incremental, isFalse);
    });

    test('控件少了会说一声, 不假装没发生', () {
      diff.apply(appKey: 'a', elements: screen(6));
      final b = diff.apply(appKey: 'a', elements: screen(3));
      expect(b.text, contains('[1-3] 同上'));
      expect(b.text, contains('上次还有 3 个控件'));
    });
  });
}
