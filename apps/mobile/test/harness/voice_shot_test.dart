/// 语音设置 + 云端识别二级页的截图.
///   flutter test --update-goldens test/harness/voice_shot_test.dart
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:neox_app/features/settings/cloud_asr_page.dart';
import 'package:neox_app/shared/theme/app_theme.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import 'render_shot.dart';

void main() {
  late SharedPreferences prefs;

  setUpAll(() async {
    stubNativePlugins();
    await loadAppFonts();
    /* 在用阿里云百炼, 另外 OpenAI 存过一份 —— 列表里两种状态都能看到 */
    SharedPreferences.setMockInitialValues({
      'voice.engine': 'cloud',
      'voice.cloud.provider': 'aliyun',
      'voice.cloud.aliyun.base': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'voice.cloud.aliyun.model': 'qwen3-asr-flash',
      'voice.cloud.openai.model': 'gpt-4o-mini-transcribe',
    });
    prefs = await SharedPreferences.getInstance();
  });

  for (final dark in [false, true]) {
    testWidgets('云端识别 · ${dark ? "深色" : "浅色"}', (t) async {
      await shoot(
        t,
        name: 'cloud-asr-${dark ? "dark" : "light"}',
        child: const CloudAsrPage(),
        theme: dark ? AppTheme.dark : AppTheme.light,
        size: ShotSize.phoneNarrow,
        settleAnimations: false,
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      );
    });
  }
}
