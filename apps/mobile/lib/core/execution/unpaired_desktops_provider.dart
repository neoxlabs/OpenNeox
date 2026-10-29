/// unpaired_desktops_provider.dart — 用户主动「解除配对」的拒绝名单。
///
/// 没有它的话, auto_pair 的 syncDesktops 会把同账号电脑立刻 upsert 回来,
/// 解除配对对登录用户就是假动作。扫码重新配对同一台时会从名单移除。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;

const _kUnpairedDesktops = 'neox_unpaired_desktop_ids';

class UnpairedDesktopsController extends StateNotifier<Set<String>> {
  UnpairedDesktopsController(this._prefs) : super(_load(_prefs));

  final SharedPreferences _prefs;

  static Set<String> _load(SharedPreferences prefs) {
    final raw = prefs.getStringList(_kUnpairedDesktops) ?? const <String>[];
    return Set<String>.unmodifiable(
      raw.map((e) => e.trim()).where((e) => e.isNotEmpty),
    );
  }

  void _persist(Set<String> next) {
    state = Set<String>.unmodifiable(next);
    _prefs.setStringList(_kUnpairedDesktops, next.toList(growable: false));
  }

  bool contains(String deviceId) => state.contains(deviceId);

  void reject(String deviceId) {
    final id = deviceId.trim();
    if (id.isEmpty || state.contains(id)) return;
    _persist({...state, id});
  }

  /// 用户重新扫码 / 主动信任时放开。
  void allow(String deviceId) {
    final id = deviceId.trim();
    if (id.isEmpty || !state.contains(id)) return;
    final next = {...state}..remove(id);
    _persist(next);
  }
}

final unpairedDesktopsProvider =
    StateNotifierProvider<UnpairedDesktopsController, Set<String>>(
  (ref) => UnpairedDesktopsController(ref.watch(sharedPreferencesProvider)),
);
