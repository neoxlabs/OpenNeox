/// answer_version_ui_test.dart — 旧版回答的展开与切回入口 (chat:C1-06).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/edition/edition.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/message_row.dart';

void main() {
  TimelineEntry entry({List<String>? versions, int? anchor = 7}) => TimelineEntry(
        id: 'text-9',
        kind: 'agent_text',
        sequence: 9,
        timestamp: 2000,
        text: '这是新版的回答',
      )
        ..answerVersions = versions
        ..answerAnchorSeq = anchor;

  Future<void> pump(
    WidgetTester tester, {
    required TimelineEntry e,
    void Function(int anchorSeq, int index)? onSelectVersion,
  }) {
    return tester.pumpWidget(
      ProviderScope(
        overrides: [editionProvider.overrideWithValue(const OpenEdition())],
        child: MaterialApp(
          home: Scaffold(
            body: MessageRow.fromEntry(
              e,
              showActions: true,
              onSelectVersion: onSelectVersion,
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('没有旧版本时不出「旧版回答」入口', (tester) async {
    await pump(tester, e: entry());
    expect(find.byIcon(Icons.history_rounded), findsNothing);
  });

  testWidgets('有旧版本 → 展开看到旧答案, 点「切回这一版」回调带对下标', (tester) async {
    var picked = -1;
    var anchor = -1;
    await pump(
      tester,
      e: entry(versions: ['旧版回答甲', '旧版回答乙'], anchor: 42),
      onSelectVersion: (a, i) {
        anchor = a;
        picked = i;
      },
    );

    expect(find.byIcon(Icons.history_rounded), findsOneWidget);
    await tester.tap(find.byIcon(Icons.history_rounded));
    await tester.pumpAndSettle();

    /* 最新的一条旧版排在最上面 */
    expect(find.text('旧版回答乙'), findsOneWidget);
    expect(find.text('旧版回答甲'), findsOneWidget);
    expect(find.text('旧版 2'), findsOneWidget);
    expect(find.text('旧版 1'), findsOneWidget);

    await tester.tap(find.text('切回这一版').first);
    await tester.pumpAndSettle();

    expect(anchor, 42);
    expect(picked, 1);
  });
}
