/// 引导页分层舞台的动画分帧 —— 每个场景截 4 个时刻, 看各件进场的先后和终态拼得对不对.
///   flutter test --update-goldens test/harness/onboarding_stage_shot_test.dart
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/onboarding/onboarding_stage.dart';
import 'package:neox_app/shared/theme/app_theme.dart';

import 'render_shot.dart';

void main() {
  setUpAll(loadAppFonts);

  for (final kind in OnboardingStageKind.values) {
    testWidgets('舞台 ${kind.name}', (t) async {
      t.view.physicalSize = const Size(360, 360) * 3;
      t.view.devicePixelRatio = 3;
      addTearDown(t.view.reset);
      await t.pumpWidget(MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 300,
              height: 300,
              /* 再套一层 Center: 页面里舞台拿到的是松约束 (Stack 里), 这里 SizedBox 给的是紧约束,
               * 不松开的话 AspectRatio 被压成正方形, 截出来跟真机对不上 */
              child: Center(child: OnboardingStage(kind: kind, active: true)),
            ),
          ),
        ),
      ));
      await t.runAsync(() async {
        for (final e in t.widgetList<Image>(find.byType(Image))) {
          await precacheImage(e.image, t.element(find.byType(MaterialApp)));
        }
      });
      var elapsed = 0;
      for (final ms in [350, 700, 1100, 2400]) {
        await t.pump(Duration(milliseconds: ms - elapsed));
        elapsed = ms;
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile('shots/stage-${kind.name}-$ms.png'),
        );
      }
    });
  }
}
