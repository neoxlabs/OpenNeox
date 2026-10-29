/// streaming_typewriter_test.dart — 打字机的吐字节奏和头尾切分.
///
/// 2026-09-18 用户: 「stream 打字机的优化 丝滑问题」。
///
/// 这两件事都是纯函数, 所以能确定地测 (不测"看着顺不顺" —— 那个只能看截图/真机):
///   · revealTarget: 永不后退、落后越多追越快、但不会一口气全吐完;
///   · splitStreamingText: 只有"写完的段落"才交给 markdown 解析。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/widgets/streaming_typewriter.dart';

void main() {
  group('revealTarget', () {
    test('已经追平就不动', () {
      expect(revealTarget(100, 100), 100);
      /* 文本变短 (换了一轮 / 服务端截断) → 只能显示到现有长度, 不可能显示
       * 不存在的字符。"不后退"说的是**同一段文本**里已显示的部分不回退,
       * 换文本那件事由 widget 层判定并重置。 */
      expect(revealTarget(100, 80), 80);
    });

    test('小落后也要动 —— 否则最后几个字会卡在那不出来', () {
      expect(revealTarget(0, 1), 1);
      expect(revealTarget(10, 12), 12);
      expect(revealTarget(10, 14), greaterThan(10));
    });

    test('落后越多吐得越快, 但一帧不吐完', () {
      final small = revealTarget(0, 24) - 0;
      final big = revealTarget(0, 120) - 0;
      expect(big, greaterThan(small), reason: '积压多就该加速追');
      expect(revealTarget(0, 120), lessThan(120), reason: '一帧全吐完就又变成"啪"一下');
    });

    test('积压过大时跳着追 —— 不能模型说完了屏幕还在慢慢打', () {
      /* 5000 字的积压: 按每帧 backlog/12 也要几十帧, 那时候早说完了 */
      final next = revealTarget(0, 5000);
      expect(next, greaterThan(4000));
      expect(next, lessThan(5000), reason: '仍留一小截, 否则"还在打字"这个信号没了');
    });

    test('永远不越过总长', () {
      for (final total in [1, 2, 5, 13, 100]) {
        var shown = 0;
        for (var i = 0; i < 200 && shown < total; i++) {
          shown = revealTarget(shown, total);
          expect(shown, lessThanOrEqualTo(total));
        }
        expect(shown, total, reason: '必须能收敛到全部显示');
      }
    });
  });

  group('splitStreamingText', () {
    test('没有空行时全是尾巴 (第一段还没写完)', () {
      final r = splitStreamingText('正在写第一段, 还没换行');
      expect(r.head, isEmpty);
      expect(r.tail, '正在写第一段, 还没换行');
    });

    test('最后一个空行之前算写完了', () {
      final r = splitStreamingText('第一段\n\n第二段\n\n正在写第三段');
      expect(r.head, '第一段\n\n第二段');
      expect(r.tail, '正在写第三段');
    });

    test('刚打完一个空行: 尾巴为空, 已完成部分包含上一段', () {
      final r = splitStreamingText('第一段\n\n');
      expect(r.head, '第一段');
      expect(r.tail, isEmpty);
    });

    test('拼回去 = 原文 (中间那个空行由布局补, 不能丢字)', () {
      const src = '一\n\n二\n\n三';
      final r = splitStreamingText(src);
      expect('${r.head}\n\n${r.tail}', src);
    });
  });
}
