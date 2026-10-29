/// 过程行结构测试 —— 2026-10-18 用户真机反馈:
///   (1) 「3 步 · 10 秒 ›」是贴内容宽的胶囊, 紧跟着又一行「用了 1 个工具 · 想了 1 秒 ›」说同一件事;
///       要整宽一行、低对比、左侧细图标, 一段过程只出一行汇总, 不嵌套第二行。
///   (2) 「想了 N 秒」点了展不开, 看不到思考内容; 点开要能看到每一步 + 思考原文。
///   (4) 失败卡里糊原始 JSON; 要一句人话。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/process_row.dart';
import 'package:neox_app/features/timeline/widgets/tool_group_row.dart';
import 'package:neox_app/shared/theme/app_theme.dart';

TimelineEntry _e(
  int seq,
  String kind, {
  String? text,
  String? thinking,
  String? tool,
  Map<String, dynamic>? args,
  String? output,
  bool ok = true,
}) =>
    TimelineEntry(
      id: '$kind-$seq',
      kind: kind,
      sequence: seq,
      timestamp: 1000 + seq * 1000,
      text: text,
      thinking: thinking,
      toolName: tool,
      args: args,
      output: output,
      toolSuccess: ok,
    );

const _thinkText = '先看看分组怎么做的, 再决定过程行放在哪一层。';

List<TimelineEntry> _entries() => [
      _e(2, 'agent_thinking', text: _thinkText, thinking: _thinkText),
      _e(3, 'tool', tool: 'read_file', args: {'path': 'tool_group_row.dart'}),
      _e(4, 'tool', tool: 'execute_shell', args: {'command': 'flutter test'}, output: 'All tests passed!'),
      _e(5, 'tool',
          tool: 'browser_run',
          args: {'steps': 'navigate'},
          output: '{"type":"contextual","status":"error","tool":"browser_run",'
              '"summary":"没找到可用的浏览器窗口"}',
          ok: false),
    ];

Future<void> _pump(WidgetTester t, {TimelineMode mode = TimelineMode.code}) async {
  await t.pumpWidget(MaterialApp(
    theme: AppTheme.light,
    home: Scaffold(
      body: SingleChildScrollView(
        child: ProcessRow(
          process: ProcessRenderItem(_entries(), running: false, isLatestTurn: true),
          mode: mode,
        ),
      ),
    ),
  ));
  await t.pumpAndSettle();
}

void main() {
  testWidgets('收起时只有一行汇总, 不是胶囊', (t) async {
    await _pump(t);
    expect(find.textContaining('步'), findsOneWidget);
    /* 胶囊 = Material + StadiumBorder; 整宽行不该有 */
    final stadium = t.widgetList<Material>(find.byType(Material)).where((m) => m.shape is StadiumBorder);
    expect(stadium, isEmpty, reason: '过程行头不该是胶囊');
    /* 汇总只有一行, 没有第二条「用了 1 个工具 · 想了 1 秒」 */
    expect(find.textContaining('用了 1 个工具'), findsNothing);
    expect(find.textContaining('读了 1 个文件'), findsNothing);
  });

  testWidgets('点一下展开: 每一步 + 思考原文都在, 且没有第二层可折叠行', (t) async {
    await _pump(t);
    await t.tap(find.byIcon(Icons.chevron_right_rounded));
    await t.pumpAndSettle();

    /* 思考原文 */
    expect(find.text(_thinkText), findsOneWidget);
    /* 每一步一行: 工具名 + 目标 + 一句话结果 */
    expect(find.textContaining('读文件'), findsWidgets);
    expect(find.textContaining('tool_group_row.dart'), findsOneWidget);
    expect(find.textContaining('flutter test'), findsOneWidget);
    /* 失败一步给人话, 不给原始 JSON */
    expect(find.textContaining('没找到可用的浏览器窗口'), findsOneWidget);
    expect(find.textContaining('{"type":"contextual"'), findsNothing);
    /* 不再嵌套第二层汇总行 (用户说的那行重复的「用了 1 个工具 · 想了 1 秒 ›」) */
    expect(find.textContaining('用了 1 个工具'), findsNothing);
    expect(find.textContaining('读了 1 个文件'), findsNothing);
  });

  testWidgets('再点一下收起', (t) async {
    await _pump(t);
    await t.tap(find.byIcon(Icons.chevron_right_rounded));
    await t.pumpAndSettle();
    expect(find.text(_thinkText), findsOneWidget);
    await t.tap(find.byIcon(Icons.chevron_right_rounded));
    await t.pumpAndSettle();
    expect(find.text(_thinkText), findsNothing);
  });

  testWidgets('工作 / 对话模式同样不再嵌套第二行', (t) async {
    await _pump(t, mode: TimelineMode.chat);
    await t.tap(find.byIcon(Icons.chevron_right_rounded));
    await t.pumpAndSettle();
    expect(find.text(_thinkText), findsOneWidget);
    expect(find.textContaining('读了 1 个文件'), findsNothing);
  });
}
