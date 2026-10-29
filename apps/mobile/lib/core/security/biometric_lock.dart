/// biometric_lock.dart — 应用锁 (指纹 / Face ID / 设备 PIN 二次门).
///
/// 行为:
///   - 设置里给一个开关 `biometricLockEnabled` — 默认 OFF
///   - 开启后:
///       1. cold start: app 启动后第一次显示主壳前要验证
///       2. 后台 > [_kAutoLockSeconds] 秒再回前台: 重新验证
///       3. 登录页 / 注册页 不锁 (本身就是 auth UI)
///   - 验证用 local_auth: 指纹优先, 没注册降级到设备 PIN / 图案
///
/// 跟登录的区别:
///   - 登录: 拿账号密码 → 后台颁 token. 失败踢回登录页.
///   - 应用锁: 已登录前提下额外加一层本地手段, 离手机被偷直接打开还要再过一遍生物.
///     不联网, server 不知道.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../shared/theme/theme_mode_provider.dart' show sharedPreferencesProvider;
import 'package:neox_app/core/i18n/tr.dart';

/// 后台多久自动锁 — 60s (用户切到微信看消息再回来, 不要每次都问指纹).
const int _kAutoLockSeconds = 60;

const _kPrefBiometricEnabled = 'neox_biometric_lock_enabled';

class BiometricLockState {
  const BiometricLockState({
    required this.enabled,
    required this.unlocked,
    required this.available,
  });

  /// 用户开了应用锁
  final bool enabled;

  /// 当前 session 是否已通过验证 (开机或后台超时后 false, 验证一次 true)
  final bool unlocked;

  /// 设备是否支持生物识别 — 不支持就别给用户看 toggle
  final bool available;

  /// 是否需要在主壳前展示生物验证页
  bool get shouldGate => enabled && available && !unlocked;

  BiometricLockState copyWith({
    bool? enabled,
    bool? unlocked,
    bool? available,
  }) =>
      BiometricLockState(
        enabled: enabled ?? this.enabled,
        unlocked: unlocked ?? this.unlocked,
        available: available ?? this.available,
      );

  static const initial = BiometricLockState(
    enabled: false,
    unlocked: true,
    available: false,
  );
}

class BiometricLockController extends StateNotifier<BiometricLockState> {
  BiometricLockController(this._prefs)
      : super(BiometricLockState.initial.copyWith(
          enabled: _prefs.getBool(_kPrefBiometricEnabled) ?? false,
          /* unlocked 初始 = !enabled, 开了锁就要先验, 没开就直接通行 */
          unlocked: !(_prefs.getBool(_kPrefBiometricEnabled) ?? false),
        )) {
    _probeAvailable();
  }

  final SharedPreferences _prefs;
  final LocalAuthentication _auth = LocalAuthentication();
  DateTime? _lastBackgroundAt;

  Future<void> _probeAvailable() async {
    try {
      final supported = await _auth.isDeviceSupported();
      final canCheck = await _auth.canCheckBiometrics;
      final ok = supported || canCheck;
      if (mounted) state = state.copyWith(available: ok);
    } catch (e) {
      if (kDebugMode) debugPrint('[biometric] probe failed: $e');
    }
  }

  Future<void> setEnabled(bool enabled) async {
    if (enabled) {
      /* 开启前必须先通过一次验证, 防"误开启把自己锁外面" */
      final ok = await _authenticate(reason: tr('验证后开启应用锁'));
      if (!ok) return;
    }
    await _prefs.setBool(_kPrefBiometricEnabled, enabled);
    if (mounted) {
      state = state.copyWith(enabled: enabled, unlocked: true);
    }
  }

  /// 用户从生物 dialog 点了通过 → 标记 unlocked.
  Future<bool> unlock() async {
    if (!state.enabled || !state.available) {
      if (mounted) state = state.copyWith(unlocked: true);
      return true;
    }
    final ok = await _authenticate(reason: tr('解锁 Neox'));
    if (ok && mounted) state = state.copyWith(unlocked: true);
    return ok;
  }

  /// App 切到后台 — 记录时间.
  void onPaused() {
    _lastBackgroundAt = DateTime.now();
  }

  /// App 回到前台 — 若超时且开了锁就重新 lock.
  void onResumed() {
    if (!state.enabled || !state.available) return;
    final last = _lastBackgroundAt;
    _lastBackgroundAt = null;
    if (last == null) return;
    final elapsed = DateTime.now().difference(last).inSeconds;
    if (elapsed >= _kAutoLockSeconds && state.unlocked) {
      if (mounted) state = state.copyWith(unlocked: false);
    }
  }

  Future<bool> _authenticate({required String reason}) async {
    try {
      return await _auth.authenticate(
        localizedReason: reason,
        options: const AuthenticationOptions(
          stickyAuth: true,
          biometricOnly: false, // 没指纹时降级到设备 PIN / 图案
          useErrorDialogs: true,
        ),
      );
    } catch (e) {
      if (kDebugMode) debugPrint('[biometric] auth failed: $e');
      return false;
    }
  }
}

final biometricLockProvider =
    StateNotifierProvider<BiometricLockController, BiometricLockState>(
  (ref) => BiometricLockController(ref.read(sharedPreferencesProvider)),
);
