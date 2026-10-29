/// streaming_typewriter_frozen_test.dart — 停止后打字机立即停帧 (chat:C9-08).
///
/// 两层里的**呈现层**: 状态层丢掉残留增量之后, 已经缓冲在 `text` 里的字还会被
/// 逐帧吐出来一小截。`frozen: true` 一到, 下一个重建就要停住:
///   · 已吐出的字保持原样 (不后退, 也不继续长);
///   · 光标不再闪 (它的语义是"还在写")。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/features/timeline/widgets/streaming_typewriter.dart';

/// 取当前屏幕上那段正在写的正文 (纯 Text, 含行内光标)。
String shownText(WidgetTester tester) {
  final texts = tester.widgetList<Text>(find.byType(Text)).toList();
  expect(texts, isNotEmpty, reason: '正文应当已经渲染');
  return texts.last.textSpan?.toPlainText() ?? texts.last.data ?? '';
}

Widget host(String text, {bool frozen = false}) => MaterialApp(
      home: Scaffold(
        body: StreamingTypewriter(text: text, frozen: frozen),
      ),
    );

void main() {
  // 60 个字、没有空行 —— 整段都在"正在写"的尾巴里, 走打字机路径。
  final long = List.filled(60, '字').join();

  testWidgets('冻结后不再吐字, 已显示的部分停在原处', (tester) async {
    await tester.pumpWidget(host(long));
    await tester.pump(const Duration(milliseconds: 32));
    final before = shownText(tester);
    expect(before.replaceAll('▍', '').length, lessThan(long.length),
        reason: '打字机应当还没吐完');

    /* 点停止 → 状态层把 frozen 推下来 */
    await tester.pumpWidget(host(long, frozen: true));
    await tester.pump();
    final frozen = shownText(tester);
    expect(frozen.contains('▍'), isFalse);

    /* 再等一段时间 (足够把剩下的字吐完), 画面不许再长。
     * 冻结那一帧允许跟帧多吐一次 —— ticker 的帧回调先于 build 跑, 这是 ≤16ms 的
     * 一帧误差, 不是"还在打字"。 */
    await tester.pump(const Duration(milliseconds: 500));
    expect(shownText(tester), frozen);
    expect(frozen.replaceAll('▍', '').length, lessThan(long.length),
        reason: '冻结只是停住, 不能一口气跳到全文');
  });

  testWidgets('冻结时光标不再出现', (tester) async {
    await tester.pumpWidget(host(long, frozen: true));
    await tester.pump();
    expect(shownText(tester).contains('▍'), isFalse);
  });

  testWidgets('构建时就冻结: 不播打字动画, 直接显示全文', (tester) async {
    await tester.pumpWidget(host(long, frozen: true));
    expect(shownText(tester), long);
  });

  testWidgets('解冻后继续吐字 (下一轮不会卡住)', (tester) async {
    await tester.pumpWidget(host(long));
    await tester.pump(const Duration(milliseconds: 32));
    await tester.pumpWidget(host(long, frozen: true));
    await tester.pump();
    final frozen = shownText(tester).replaceAll('▍', '').length;

    await tester.pumpWidget(host(long));
    await tester.pump(const Duration(milliseconds: 32));
    final after = shownText(tester).replaceAll('▍', '').length;
    expect(after, greaterThan(frozen));
  });
}
