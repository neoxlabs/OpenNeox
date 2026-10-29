/// 失败卡 (发送失败 / 模型不可用) 的截图.
///   flutter test --update-goldens test/harness/error_card_shot_test.dart
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/widgets/error_view.dart';
import 'package:neox_app/shared/theme/app_theme.dart';

import 'render_shot.dart';

void main() {
  setUpAll(() async {
    stubNativePlugins();
    await loadAppFonts();
  });

  for (final dark in [false, true]) {
    testWidgets('失败卡 · ${dark ? "深色" : "浅色"}', (t) async {
      await shoot(
        t,
        name: 'error-card-${dark ? "dark" : "light"}',
        theme: dark ? AppTheme.dark : AppTheme.light,
        size: ShotSize.phoneNarrow,
        settleAnimations: false,
        child: Scaffold(
          body: SafeArea(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('你好！有什么可以帮你的？'),
                ),
                ErrorEnvelopeCard(
                  raw: '❌ 附件没传上去，请重发\n\n💡 Suggestion: 截图.png: upload not found or not finished (up-mg1x2)',
                  onRetry: () {},
                  alwaysOfferRetry: true,
                ),
                ErrorEnvelopeCard(
                  raw: '❌ 该模型已停用，请选择其他模型',
                  onRetry: () {},
                  onPickModel: () {},
                  alwaysOfferRetry: true,
                  alwaysOfferModelSwitch: true,
                ),
              ],
            ),
          ),
        ),
      );
    });
  }
}
