/// Timeline 排版截图 —— 用户拿同类产品对比过"字体 大小 对比 等很清晰, 我们的差远了".
///   flutter test --update-goldens test/harness/timeline_shot_test.dart
///
/// 不渲整个 TimelineMessageList (它要喂 drift + 一堆 provider), 而是渲**真的消息行**:
/// 排版全在 MessageRow / MarkdownView 里, 那才是用户在看的东西。
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/widgets/message_row.dart';
import 'package:neox_app/shared/theme/app_theme.dart';

import 'render_shot.dart';

SessionEvent _ev(int seq, String kind, Map<String, dynamic> payload) =>
    SessionEvent(
      sessionId: 's1',
      seq: seq,
      ts: DateTime.now().millisecondsSinceEpoch,
      kind: kind,
      payload: jsonEncode(payload),
    );

/// 一段有代表性的回答: 行内代码、列表、引用、粗体 —— 用户对比图里出现的都在.
const _answer = '''
`opts` 是 `AgenticModeToolsOptions`（带 `permissionManager` 和 `sessionId`）。改的是变量名。

还有 **3 个测试文件**钉着旧规则（auto 下 high 要确认）。逐个看，改成新规则：

- `permission_gate_test.dart` — 改成 auto 下放行
- `scope_inherit_test.dart` — 补一条子作用域继承
- `manual_mode_test.dart` — 保持 high 需确认

> 这个测试对应的是旧规则。我将改成新规则：auto 模式下 high 直接放行、critical 仍需确认。
''';

void main() {
  setUpAll(loadAppFonts);

  for (final dark in [false, true]) {
    testWidgets('Timeline 排版 · ${dark ? "深色" : "浅色"}', (t) async {
      await shoot(
        t,
        name: 'timeline-${dark ? "dark" : "light"}',
        theme: dark ? AppTheme.dark : AppTheme.light,
        size: ShotSize.phoneNarrow,
        child: Scaffold(
          body: SafeArea(
            child: ListView(
              children: [
                MessageRow(
                  item: TimelineItem.single(
                    _ev(1, 'user_message', {
                      'text': 'workorder 是哪个页面？给我说下，我都不知道',
                    }),
                  ),
                ),
                MessageRow(
                  item: TimelineItem.single(
                    _ev(2, 'agent_text', {'text': _answer}),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    });
  }
}
