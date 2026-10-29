/// 加载聊天记录的品牌圆环动画 —— 截一个周期里的几帧看"扫光 + 转 + 呼吸"。
///   flutter test --update-goldens test/harness/mark_loader_shot_test.dart
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/shared/theme/app_theme.dart';
import 'package:neox_app/shared/widgets/neox_mark_loader.dart';

import 'render_shot.dart';

void main() {
  setUpAll(loadAppFonts);

  for (final dark in [false, true]) {
    testWidgets('圆环加载 · ${dark ? "深色" : "浅色"}', (t) async {
      t.view.physicalSize = ShotSize.phoneNarrow * 3;
      t.view.devicePixelRatio = 3;
      addTearDown(t.view.reset);
      await t.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const Scaffold(
              body: Center(child: NeoxMarkLoader(label: '正在同步消息…')),
            ),
          ),
        ),
      );
      await t.runAsync(() async {
        for (final e in t.widgetList<Image>(find.byType(Image))) {
          await precacheImage(e.image, t.element(find.byType(MaterialApp)));
        }
      });
      /* 2.4s 一个周期: 取 0 / 0.6 / 1.2 / 1.8s 四帧 */
      for (var f = 0; f < 4; f++) {
        await t.pump(Duration(milliseconds: f == 0 ? 0 : 600));
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(
            'shots/mark-loader-${dark ? "dark" : "light"}-$f.png',
          ),
        );
      }
    });
  }
}
