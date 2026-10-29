/// 引导页截图 (三页) —— 改之前先看一眼, 改完再看一眼.
///   flutter test --update-goldens test/harness/onboarding_shot_test.dart
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/onboarding/onboarding_page.dart';
import 'package:neox_app/shared/theme/app_theme.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'render_shot.dart';

void main() {
  late SharedPreferences prefs;

  setUpAll(() async {
    stubNativePlugins();
    await loadAppFonts();
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
  });

  for (var page = 0; page < 3; page++) {
    testWidgets('引导页 $page · 浅色 · 窄屏', (t) async {
      await shoot(t,
        name: 'onboarding-$page-light-narrow',
        child: OnboardingPage(onDone: () {}, initialPage: page),
        theme: AppTheme.light,
        size: ShotSize.phoneNarrow,
        settleAnimations: false,
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)]);
    });

    testWidgets('引导页 $page · 深色', (t) async {
      await shoot(t,
        name: 'onboarding-$page-dark',
        child: OnboardingPage(onDone: () {}, initialPage: page),
        theme: AppTheme.dark,
        size: ShotSize.phone,
        settleAnimations: false,
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)]);
    });
  }
}
