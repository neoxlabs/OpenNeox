/// 聊天模式下的输入框 + [+] 菜单 (2026-09-23)
///   flutter test --update-goldens test/harness/chat_mode_shot_test.dart
///
/// 「聊天」(Agent/聊天开关, 管电脑会话带不带工具) 跟首页的「对话」模式 (2026-09-24,
/// 整个跑在手机上) 是两件事: 前三张固定在工作模式下拍开关, 后两张拍对话模式。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/home/widgets/stage_input.dart';
import 'package:neox_app/shared/theme/app_theme.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart' show sharedPreferencesProvider;
import 'package:shared_preferences/shared_preferences.dart';

import 'render_shot.dart';

void main() {
  setUpAll(() async {
    stubNativePlugins();
    await loadAppFonts();
  });

  for (final chat in [true, false]) {
    testWidgets('输入框 · ${chat ? "聊天" : "Agent"}', (t) async {
      SharedPreferences.setMockInitialValues({
        'neox_chat_mode_default': chat,
        'neox_home_mode': 'work',
      });
      final prefs = await SharedPreferences.getInstance();
      await shoot(
        t,
        name: 'composer-${chat ? "chat" : "agent"}',
        theme: AppTheme.light,
        size: ShotSize.strip,
        settleAnimations: false,
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
        child: const Scaffold(
          body: Align(alignment: Alignment.bottomCenter, child: StageInput()),
        ),
      );
      /* StageInput 里的 ws / 草稿探测会排定时器; 截图完卸掉再跑完, 否则测试结束时报 pending timer */
      await t.pumpWidget(const SizedBox.shrink());
      await t.pump(const Duration(seconds: 2));
    });
  }

  testWidgets('[+] 菜单 · 聊天', (t) async {
    SharedPreferences.setMockInitialValues({
      'neox_chat_mode_default': true,
      'neox_home_mode': 'work',
    });
    final prefs = await SharedPreferences.getInstance();
    await shoot(
      t,
      name: 'plus-menu-base',
      theme: AppTheme.light,
      size: ShotSize.phone,
      settleAnimations: false,
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      child: const Scaffold(
        body: Align(alignment: Alignment.bottomCenter, child: StageInput()),
      ),
    );
    /* 点 [+]: 输入框控制条上那颗加号 (tooltip 「更多」) */
    await t.tap(find.byIcon(Icons.add_rounded).first);
    for (var i = 0; i < 20; i++) {
      await t.pump(const Duration(milliseconds: 50));
    }
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('shots/plus-menu-chat.png'));
    await t.pumpWidget(const SizedBox.shrink());
    await t.pump(const Duration(seconds: 2));
  });

  /* 首页「对话」模式: 输入框只有模型 chip, [+] 菜单里没有电脑那一套
   * (Agent/聊天、运行位置、项目、审批) 也没有「文件」附件 */
  testWidgets('对话模式 · 输入框 + [+] 菜单', (t) async {
    SharedPreferences.setMockInitialValues({'neox_home_mode': 'chat'});
    final prefs = await SharedPreferences.getInstance();
    await shoot(
      t,
      name: 'composer-home-chat',
      theme: AppTheme.light,
      size: ShotSize.phone,
      settleAnimations: false,
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      child: const Scaffold(
        body: Align(alignment: Alignment.bottomCenter, child: StageInput()),
      ),
    );
    await t.tap(find.byIcon(Icons.add_rounded).first);
    for (var i = 0; i < 20; i++) {
      await t.pump(const Duration(milliseconds: 50));
    }
    expect(find.text('运行位置'), findsNothing);
    expect(find.text('审批模式'), findsNothing);
    expect(find.text('项目'), findsNothing);
    /* 「文件」在 2026-10 起对话也能发附件了, 不再只是电脑那一套;
       模型不在 + 菜单里, 它一直在输入框上的 chip 上 */
    expect(find.text('文件'), findsOneWidget);
    expect(find.text('选择模型'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('shots/plus-menu-home-chat.png'));
    await t.pumpWidget(const SizedBox.shrink());
    await t.pump(const Duration(seconds: 2));
  });
}
