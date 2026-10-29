/// 开新会话那一屏的截图 —— 「选电脑上的项目」入口.
///   flutter test --update-goldens test/harness/new_session_shot_test.dart
///
/// 渲的是 [PickProjectPillView] (纯展示的那一半): 带 wsClientProvider 的外层
/// 在 flutter_test 里会真的去连电脑, 起不来。连上/没连上两种样子各一张。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/home/widgets/mode_dashboards.dart';
import 'package:neox_app/shared/theme/app_theme.dart';
import 'package:neox_app/shared/theme/neox_tokens.dart';

import 'render_shot.dart';

void main() {
  setUpAll(() async {
    stubNativePlugins();
    await loadAppFonts();
  });

  for (final dark in [false, true]) {
    testWidgets('选项目入口 · ${dark ? "深色" : "浅色"}', (t) async {
      await shoot(
        t,
        name: 'new-session-project-${dark ? "dark" : "light"}',
        theme: dark ? AppTheme.dark : AppTheme.light,
        size: ShotSize.phoneNarrow,
        /* 一颗就够: 药丸不按连接状态变样 (那会跟插画下面的图注重复说同一件事) */
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: NeoxSpace.xl),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              PickProjectPillView(onTap: () {}),
            ],
          ),
        ),
      );
    });
  }
}
