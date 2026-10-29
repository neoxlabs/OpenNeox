/// theme_variant_provider.dart — 主题变体切换 (claude / desktop) + 持久化.
///
/// 默认 claude (暖白 + 衬线 + 珊瑚), 用户可在设置里切到 desktop (Indigo, 跟桌面端一致).
/// 用 SharedPreferences 落 'theme_variant' key, 重启 app 后保留.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'theme_mode_provider.dart' show sharedPreferencesProvider;
import 'package:neox_app/core/i18n/tr.dart';

const String _kThemeVariantKey = 'theme_variant';

/// 主题气质变体.
///   - claude: 暖白 + 衬线宋体 + 珊瑚强调 + 黑胶囊 (默认, Anthropic 风)
///   - desktop: 与 Neox Desktop 一致的 Indigo 风格 (Material 3 调色板)
enum ThemeVariant {
  claude,
  desktop;

  String get id => switch (this) {
        ThemeVariant.claude => 'claude',
        ThemeVariant.desktop => 'desktop',
      };

  static ThemeVariant fromId(String? id) => switch (id) {
        'desktop' => ThemeVariant.desktop,
        _ => ThemeVariant.claude,
      };

  String get displayName => switch (this) {
        ThemeVariant.claude => tr('暖白衬线'),
        ThemeVariant.desktop => tr('桌面同款'),
      };

  String get description => switch (this) {
        ThemeVariant.claude => tr('温润暖白基调，衬线大标题，珊瑚色点缀'),
        ThemeVariant.desktop => tr('与 Neox Desktop 一致的 Indigo 调色'),
      };
}

class ThemeVariantController extends StateNotifier<ThemeVariant> {
  ThemeVariantController(this._prefs) : super(_load(_prefs));

  final SharedPreferences _prefs;

  static ThemeVariant _load(SharedPreferences prefs) {
    return ThemeVariant.fromId(prefs.getString(_kThemeVariantKey));
  }

  Future<void> setVariant(ThemeVariant variant) async {
    state = variant;
    await _prefs.setString(_kThemeVariantKey, variant.id);
  }
}

final themeVariantProvider =
    StateNotifierProvider<ThemeVariantController, ThemeVariant>((ref) {
  return ThemeVariantController(ref.watch(sharedPreferencesProvider));
});
