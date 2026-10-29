/// image_size_shot_test.dart — chat:C4-07 方/横/竖 的界面截图.
///
/// 跑法 (生成/更新 PNG):
///   flutter test --run-skipped --tags shot --update-goldens test/harness/image_size_shot_test.dart
/// 产物: test/harness/shots/image-size-*.png (不进仓, 给人看的)
@Tags(['shot'])
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/widgets/direct_image_card.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/shared/theme/app_theme.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;
import 'package:shared_preferences/shared_preferences.dart';

import 'render_shot.dart';

void main() {
  setUpAll(() async {
    stubNativePlugins();
    await loadAppFonts();
  });

  /* 出图等待卡: 竖图占位 + 取消按钮 (chat:C4-05 + C4-07) */
  testWidgets('出图中 · 竖图占位 + 取消', (t) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final prefs = await SharedPreferences.getInstance();
    await shoot(
      t,
      name: 'image-size-pending-portrait',
      theme: AppTheme.light,
      size: ShotSize.phone,
      settleAnimations: false,
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      child: Scaffold(
        body: Center(
          child: DirectImageCard(
            entry: TimelineEntry(
              id: 'e1',
              kind: 'direct_image',
              sequence: 1,
              timestamp: DateTime.now().millisecondsSinceEpoch,
              pending: true,
              args: const {
                'status': 'pending',
                'turn_id': 't1',
                'size': '1024x1536',
                'prompt': '竖版海报',
              },
            ),
          ),
        ),
      ),
    );
  });
}
