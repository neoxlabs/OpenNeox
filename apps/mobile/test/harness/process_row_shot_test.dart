/// 过程行截图 —— 2026-10-18 用户真机反馈 (编码会话「执行中」页):
///   (1) 「3 步 · 10 秒 ›」是贴着内容宽的胶囊, 紧跟着又一行「用了 1 个工具 · 想了 1 秒 ›」,
///       两行说同一件事; 要整宽一行、低对比文字、左侧细图标, 一段过程只出一行汇总。
///   (2) 点了展不开, 看不到思考原文 —— 展开要是「每一步 + 思考原文」。
///   (4) 失败卡里直接糊原始 JSON —— 要一句人话。
///
/// 用法: flutter test --update-goldens test/harness/process_row_shot_test.dart
/// 产物: test/harness/shots/process-*.png (不进仓, 给人看)
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/process_row.dart';
import 'package:neox_app/features/timeline/widgets/tool_group_row.dart';
import 'package:neox_app/shared/theme/app_theme.dart';

import 'render_shot.dart';

TimelineEntry _e(
  int seq,
  String kind, {
  String? text,
  String? thinking,
  String? tool,
  Map<String, dynamic>? args,
  String? output,
  bool ok = true,
  bool pending = false,
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
      pending: pending,
    );

/// 编码会话里一段真实形状的过程: 想过 → 读文件 → 跑测试 → 一次失败 (browser_run 的 contextual 信封)
List<TimelineEntry> _entries() => [
      _e(2, 'agent_thinking',
          text: '先看看 timeline_message_list 怎么分组, 再决定过程行放在哪一层; '
              '如果每个连续段都出一行, 一屏会有五六行重复的「用了 1 个工具」。'),
      _e(3, 'tool', tool: 'read_file', args: {'path': 'apps/mobile/lib/features/timeline/widgets/tool_group_row.dart'}),
      _e(4, 'tool',
          tool: 'execute_shell',
          args: {'command': 'cd /workspace && flutter test test/process_row_test.dart'},
          output: '00:03 +6: All tests passed!\nRan 6 tests in 0.9s\n\nOK'),
      _e(5, 'tool',
          tool: 'browser_run',
          args: {'steps': 'navigate + screenshot'},
          output: '{"type":"contextual","status":"error","tool":"browser_run",'
              '"summary":"没找到可用的浏览器窗口","content":"{\\"ok\\":false,\\"error\\":\\"No browser surface\\"}"}',
          ok: false),
    ];

void main() {
  setUpAll(() => loadAppFonts(neoxRounded: true));

  for (final dark in [false, true]) {
    final tone = dark ? 'dark' : 'light';
    final theme = dark ? AppTheme.dark : AppTheme.light;

    testWidgets('过程行 · 收起 · $tone', (t) async {
      await shoot(
        t,
        name: 'process-code-collapsed-$tone',
        theme: theme,
        size: ShotSize.strip,
        child: Scaffold(
          body: SafeArea(
            child: ListView(
              padding: const EdgeInsets.symmetric(vertical: 12),
              children: [
                ProcessRow(
                  process: ProcessRenderItem(_entries(), running: false, isLatestTurn: true),
                  mode: TimelineMode.code,
                ),
              ],
            ),
          ),
        ),
      );
    });

    testWidgets('过程行 · 展开 · $tone', (t) async {
      await shoot(
        t,
        name: 'process-code-expanded-$tone',
        theme: theme,
        size: ShotSize.phoneNarrow,
        capture: false,
        child: Scaffold(
          body: SafeArea(
            child: ListView(
              padding: const EdgeInsets.symmetric(vertical: 12),
              children: [
                ProcessRow(
                  process: ProcessRenderItem(_entries(), running: false, isLatestTurn: true),
                  mode: TimelineMode.code,
                ),
              ],
            ),
          ),
        ),
      );
      /* 点过程行 = 展开: 每一步 (工具名 + 一句话结果) 和思考原文都要出来 */
      await t.tap(find.textContaining('步'));
      await t.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('shots/process-code-expanded-$tone.png'));
    });
  }
}
