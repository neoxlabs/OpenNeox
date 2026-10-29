/// message_actions_test.dart — 正文底下的动作行只在**对话最后一条**出现.
///
/// 2026-09-22 用户: 「每一次对话最后都有一行, 这个没必要; 中间的……不需要;
/// 最后一个结束后的 message, 是需要这个分享按钮的」。
///
/// 原来 `AgentMessage` 每条非流式正文都常驻这一行 —— 一轮里跑八步工具就有八段
/// 正文, 每段底下都挂复制/分享/举报, 正文被按钮切得七零八落。现在由
/// `timeline_message_list` 只给最后一项传 showActions=true。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/edition/edition.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/message_row.dart';

/// 有举报收件方的发行版 (商业版就是这样) —— 举报按钮只在这种发行版里出现。
class _ReportingEdition extends NeoxEdition {
  const _ReportingEdition();

  @override
  String get id => 'test-reporting';

  @override
  ContentReporter? get contentReporter =>
      (context, ref, {required String text}) async {};
}

void main() {
  TimelineEntry entry() => TimelineEntry(
        id: 'text-1',
        kind: 'agent_text',
        sequence: 1,
        timestamp: 1000,
        text: '这是 agent 写的一段正文',
      );

  Future<void> pump(
    WidgetTester tester, {
    required bool showActions,
    NeoxEdition edition = const _ReportingEdition(),
  }) {
    return tester.pumpWidget(
      ProviderScope(
        overrides: [editionProvider.overrideWithValue(edition)],
        child: MaterialApp(
          home: Scaffold(
            body: MessageRow.fromEntry(entry(), showActions: showActions),
          ),
        ),
      ),
    );
  }

  testWidgets('最后一条 — 复制 / 分享 / 举报都在', (tester) async {
    await pump(tester, showActions: true);
    expect(find.byIcon(Icons.copy_rounded), findsOneWidget);
    expect(find.byIcon(Icons.ios_share), findsOneWidget);
    expect(find.byIcon(Icons.flag_outlined), findsOneWidget);
  });

  testWidgets('没有举报收件方的发行版 — 只有复制 / 分享', (tester) async {
    await pump(tester, showActions: true, edition: const OpenEdition());
    expect(find.byIcon(Icons.copy_rounded), findsOneWidget);
    expect(find.byIcon(Icons.ios_share), findsOneWidget);
    expect(find.byIcon(Icons.flag_outlined), findsNothing);
  });

  testWidgets('中间那条 — 一个都不挂, 正文照常渲染', (tester) async {
    await pump(tester, showActions: false);
    expect(find.text('这是 agent 写的一段正文'), findsOneWidget);
    expect(find.byIcon(Icons.copy_rounded), findsNothing);
    expect(find.byIcon(Icons.ios_share), findsNothing);
    expect(find.byIcon(Icons.flag_outlined), findsNothing);
  });
}
