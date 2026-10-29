/// theme_mode_provider.dart — 主题模式切换 (light / dark / system) + 持久化.
///
/// 用 SharedPreferences 落 'theme_mode' key, 重启 app 后保留.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:neox_app/core/i18n/tr.dart';

const String _kThemeModeKey = 'theme_mode';

class ThemeModeController extends StateNotifier<ThemeMode> {
  ThemeModeController(this._prefs) : super(_load(_prefs));

  final SharedPreferences _prefs;

  static ThemeMode _load(SharedPreferences prefs) {
    switch (prefs.getString(_kThemeModeKey)) {
      case 'light':
        return ThemeMode.light;
      case 'dark':
        return ThemeMode.dark;
      default:
        return ThemeMode.system;
    }
  }

  Future<void> setMode(ThemeMode mode) async {
    state = mode;
    await _prefs.setString(_kThemeModeKey, _encode(mode));
  }

  static String _encode(ThemeMode m) {
    switch (m) {
      case ThemeMode.light:
        return 'light';
      case ThemeMode.dark:
        return 'dark';
      case ThemeMode.system:
        return 'system';
    }
  }
}

/// 必须在 main 里 ProviderScope.overrides 注入 (SharedPreferences async load 完后).
final sharedPreferencesProvider = Provider<SharedPreferences>((ref) {
  throw UnimplementedError(
    tr('sharedPreferencesProvider 没初始化 — main.dart 应该 override'),
  );
});

final themeModeProvider =
    StateNotifierProvider<ThemeModeController, ThemeMode>((ref) {
  return ThemeModeController(ref.watch(sharedPreferencesProvider));
});
