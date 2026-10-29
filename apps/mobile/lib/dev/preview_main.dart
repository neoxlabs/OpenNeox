/// preview_main.dart — 时间线 / 输入框离线预览 (仅开发用, 不进正式入口).
///
///   flutter run -t lib/dev/preview_main.dart
///
/// 真实会话要登录 + 配对电脑才看得到工具行; 这里用假数据直接渲染真组件,
/// 改样式时不用凑条件。正式包的入口是 lib/main.dart, 不 import 这个文件。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shared/theme/theme_mode_provider.dart';

import '../features/home/widgets/stage_input.dart';
import '../features/timeline/state/timeline_state.dart';
import '../features/timeline/widgets/message_row.dart';
import '../features/timeline/widgets/process_row.dart';
import '../features/timeline/widgets/tool_group_row.dart';
import '../shared/theme/app_theme.dart';
import 'package:neox_app/core/i18n/tr.dart';

TimelineEntry _e(
  String kind,
  String id, {
  bool pending = false,
  String? toolName,
  Map<String, dynamic>? args,
  String? text,
}) =>
    TimelineEntry(
      id: id,
      kind: kind,
      sequence: 0,
      timestamp: DateTime.now().millisecondsSinceEpoch,
      pending: pending,
      toolSuccess: true,
      toolName: toolName,
      args: args,
      text: text,
      thinking: kind == 'agent_thinking' ? text : null,
    );

List<TimelineEntry> previewEntries() => [
      _e('user_message', 'u1', text: tr('把 auto 模式下 high 级别的确认去掉, 补测试')),
      _e('tool', 't1', toolName: 'edit_file', args: {
        'file_path': r'e:\code\ltoa\frontend\apps\web-antd\src\toolRiskEvaluator.ts',
        'old_string': 'a',
        'new_string': 'a\nb\nc',
      }),
      TimelineEntry(
        id: 't2', kind: 'tool', sequence: 0, timestamp: DateTime.now().millisecondsSinceEpoch,
        toolSuccess: true, toolName: 'execute_shell',
        args: {'command': 'npx vitest run packages/kernel', 'description': 'Run kernel tests'},
        output: ' ✓ toolRiskEvaluator.test.ts (12 tests)\n Test Files  1 passed (1)\n      Tests  12 passed (12)',
      ),
      _e('tool', 't2b', toolName: 'execute_shell', args: {
        'command': 'npx vitest run packages/kernel',
        'description': 'Run kernel tests',
      }),
      _e('tool', 't3', toolName: 'execute_shell', args: {
        'command': 'npx tsc --noEmit',
        'description': 'Typecheck',
      }),
      _e('agent_text', 'a1',
          text: tr('`opts` is the `AgenticModeToolsOptions` (has `permissionManager` and `sessionId`). '
              'Fixing the variable name. 详见 [PermissionManager.ts](https://github.com/MK-CO/neox) 。')),
      _e('tool', 't4', toolName: 'read_file', args: {'file_path': 'src/a.ts'}),
      _e('tool', 't5', toolName: 'read_file', args: {'file_path': 'src/b.ts'}),
      _e('tool', 't6', toolName: 'grep', args: {'pattern': 'autoMode'}),
      _e('agent_text', 'a2', text: tr('> 这个测试对应的是旧规则 (auto 模式下 high 级别需要确认)。我将改成新规则。')),
      _e('tool', 't7', toolName: 'execute_shell', pending: true, args: {
        'command': 'git status --short',
        'description': 'List changed files for commit',
      }),
    ];

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  /* 长模型名, 用来看窄屏下 chip 截断 (真机 X200 mini 上 deepseek-v4.1-flash 撑出屏幕) */
  await prefs.setString('neox_default_model', 'deepseek-v4.1-flash');
  /* 不装发行版 (editionProvider 默认 = 开源版): 预览只看组件长相, 用不着登录态。
   * 原来这里覆盖了一份空登录凭证, 效果就是"未登录" —— 跟现在一样。 */
  runApp(ProviderScope(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(prefs),
    ],
    child: const _PreviewApp(),
  ));
}

class _PreviewApp extends StatelessWidget {
  const _PreviewApp();

  @override
  Widget build(BuildContext context) {
    /* 编码模式 (跟桌面一样一段话 / 一行工具交替) —— 跑着的这一轮 */
    final items = buildTurnItems(previewEntries(), running: true, mode: TimelineMode.code);
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      home: Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  children: [
                    for (final it in items)
                      switch (it) {
                        ToolGroupRenderItem() => ToolGroupRow(group: it),
                        SingleRenderItem(:final entry) => MessageRow.fromEntry(entry),
                        ProcessRenderItem() => ProcessRow(process: it, mode: TimelineMode.code),
                        FilesFooterRenderItem() => const SizedBox.shrink(),
                      },
                  ],
                ),
              ),
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 8, 16, 8),
                child: StageInput(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
