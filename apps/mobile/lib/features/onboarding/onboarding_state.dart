/// onboarding_state.dart — 首启引导看过没有.
///
/// 一次性脚手架: 看完就永久不再出现。存 SharedPreferences 而不是数据库 ——
/// 它必须在**第一帧之前**就能同步读到 (main() 已经预加载 prefs), 否则用户会先
/// 看见半秒主页再被引导页盖住, 那一下闪烁比没有引导还糟。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;

const String _kSeenKey = 'neox_onboarding_seen_v1';

class OnboardingSeenController extends StateNotifier<bool> {
  OnboardingSeenController(this._prefs)
      : super(_prefs.getBool(_kSeenKey) ?? false);

  final SharedPreferences _prefs;

  void markSeen() {
    if (state) return;
    state = true;
    _prefs.setBool(_kSeenKey, true);
  }

  /// 调试用 —— 设置里没有入口, 只给开发期重看引导.
  void reset() {
    state = false;
    _prefs.remove(_kSeenKey);
  }
}

/// true = 已经看过, 不再显示.
///
/// key 带 `_v1`: 将来引导内容大改时换成 v2 就能对老用户再放一次, 而不用
/// 想办法迁移一个布尔值。
final onboardingSeenProvider =
    StateNotifierProvider<OnboardingSeenController, bool>(
  (ref) => OnboardingSeenController(ref.watch(sharedPreferencesProvider)),
);
