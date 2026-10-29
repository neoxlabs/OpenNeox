/// 输入框上方的审批小板 + 追问入口 + 追问抽屉 (陶土稿 v5) 的截图.
///   flutter test --update-goldens test/harness/approval_dock_shot_test.dart
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/stream_buffer_provider.dart';
import 'package:neox_app/features/home/state/session_location_provider.dart';
import 'package:neox_app/features/home/widgets/inline_approval_strip.dart';
import 'package:neox_app/features/timeline/widgets/ask_user_card.dart';
import 'package:neox_app/shared/theme/app_theme.dart';

import 'render_shot.dart';

const _sid = 's1';

const _approvals = [
  PendingApproval(
    requestId: 'r1',
    toolName: 'shell',
    args: {'command': 'rm -rf build && npm run build'},
    reason: '',
    allowRemember: true,
  ),
  PendingApproval(requestId: 'r2', toolName: 'edit_file', args: {'path': 'src/a.ts'}, reason: '', allowRemember: true),
];

const _ask = PendingAskUser(
  requestId: 'q1',
  questions: [
    PendingAskUserQuestion(
      question: '登录页用哪种验证码？',
      multiSelect: false,
      options: [
        PendingAskUserOption(label: '短信验证码', description: '要接短信服务商'),
        PendingAskUserOption(label: '图形验证码'),
        PendingAskUserOption(label: '先不加'),
      ],
    ),
  ],
);

void main() {
  setUpAll(() async {
    stubNativePlugins();
    await loadAppFonts();
  });

  for (final dark in [false, true]) {
    testWidgets('审批小板 · ${dark ? "深色" : "浅色"}', (t) async {
      await shoot(
        t,
        name: 'approval-dock-${dark ? "dark" : "light"}',
        theme: dark ? AppTheme.dark : AppTheme.light,
        size: ShotSize.phoneNarrow,
        settleAnimations: false,
        overrides: [
          sessionPendingApprovalsProvider(_sid).overrideWithValue(_approvals),
          sessionPendingAskUsersProvider(_sid).overrideWithValue(const [_ask]),
          sessionLocationProvider(_sid).overrideWith(
            (ref) => Stream.value(const SessionLocation(kind: SessionLocationKind.desktop, deviceName: 'Mac', workspaceName: 'ordersys')),
          ),
        ],
        child: const Scaffold(
          body: SafeArea(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.end,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AskUserStack(sessionId: _sid),
                ApprovalDock(sessionId: _sid),
                SizedBox(height: 80),
              ],
            ),
          ),
        ),
      );
    });

    testWidgets('追问抽屉 · ${dark ? "深色" : "浅色"}', (t) async {
      await shoot(
        t,
        name: 'ask-user-sheet-${dark ? "dark" : "light"}',
        theme: dark ? AppTheme.dark : AppTheme.light,
        size: ShotSize.phoneNarrow,
        settleAnimations: false,
        overrides: [
          sessionPendingAskUsersProvider(_sid).overrideWithValue(const [_ask]),
        ],
        child: const Scaffold(
          body: SafeArea(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [AskUserCard(sessionId: _sid, askUser: _ask)],
            ),
          ),
        ),
      );
    });
  }
}
