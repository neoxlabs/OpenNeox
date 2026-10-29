/// display_prefs.dart — 设置 → 外观 里除了主题之外的三样 (陶土稿 v5): 字号 / 首页插画 / 动效.
///
/// 字号五档 (小 → 大), 乘在系统字号上; 首页插画关掉后问候页只剩字和输入框;
/// 动效关掉 = 整个 App 按「减少动画」走 (MediaQuery.disableAnimations)。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'theme_mode_provider.dart' show sharedPreferencesProvider;

/// 五档字号的倍数; 默认第二档 (1.0)
const kTextScaleSteps = [0.92, 1.0, 1.08, 1.16, 1.26];

class DisplayPrefs {
  const DisplayPrefs({this.textStep = 1, this.homeArt = true, this.motion = true});

  final int textStep;
  final bool homeArt;
  final bool motion;

  double get textScale => kTextScaleSteps[textStep.clamp(0, kTextScaleSteps.length - 1)];

  DisplayPrefs copyWith({int? textStep, bool? homeArt, bool? motion}) =>
      DisplayPrefs(textStep: textStep ?? this.textStep, homeArt: homeArt ?? this.homeArt, motion: motion ?? this.motion);
}

const _kStep = 'display_text_step';
const _kArt = 'display_home_art';
const _kMotion = 'display_motion';

class DisplayPrefsController extends StateNotifier<DisplayPrefs> {
  DisplayPrefsController(this._prefs)
      : super(DisplayPrefs(
          textStep: _prefs.getInt(_kStep) ?? 1,
          homeArt: _prefs.getBool(_kArt) ?? true,
          motion: _prefs.getBool(_kMotion) ?? true,
        ));

  final SharedPreferences _prefs;

  void setTextStep(int v) {
    state = state.copyWith(textStep: v);
    _prefs.setInt(_kStep, v);
  }

  void setHomeArt(bool v) {
    state = state.copyWith(homeArt: v);
    _prefs.setBool(_kArt, v);
  }

  void setMotion(bool v) {
    state = state.copyWith(motion: v);
    _prefs.setBool(_kMotion, v);
  }
}

final displayPrefsProvider = StateNotifierProvider<DisplayPrefsController, DisplayPrefs>(
  (ref) => DisplayPrefsController(ref.watch(sharedPreferencesProvider)),
);
